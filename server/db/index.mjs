/*
 * 数据库连接与查询封装。
 *
 * 全站只有这一个地方直接碰 SQL；server/api.mjs 里每个接口函数都对应下面一个查询方法，
 * 方法名与前端 src/api/index.js 的函数一一对应，返回值也保持同样结构。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { cover as coverArt } from '../lib/art.mjs'
import { inlineSvg, storeArt, moveInlineArt } from '../lib/art-store.mjs'
import { thumbOf } from '../lib/thumbs.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || join(here, 'reel.db')

/*
 * 别的进程（容器里跑 create-admin.mjs、开着事务的 sqlite3 命令行）拿着写锁时，写操作最多等这么久再报「忙」
 * （路由层回 503「服务器忙，请稍后再试」，不是 500）；DB_BUSY_TIMEOUT_MS 可改。
 * 开始接请求以后这个等待是异步的（见下面的 whenWritable / retryBusy），等的时候别的请求（包括读）照常处理。
 */
export const BUSY_TIMEOUT_MS = Math.min(Math.max(Math.floor(Number(process.env.DB_BUSY_TIMEOUT_MS)) || 2000, 0), 30000)
/*
 * 启动阶段（建表、补索引、挪占位图）还没开始接请求，用 SQLite 自己的 busy_timeout 同步等就行，多等一会儿也不卡谁；
 * 部署时 create-admin.mjs 正好在写，启动也不会因此失败。单独跑的脚本（seed.mjs 等）引这个模块时也一直是这个设置。
 */
const STARTUP_BUSY_MS = Math.max(BUSY_TIMEOUT_MS, 10000)

export const db = new DatabaseSync(DB_PATH)
db.exec(`PRAGMA busy_timeout = ${STARTUP_BUSY_MS}`)
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA journal_mode = WAL')
/*
 * WAL 模式下 synchronous=NORMAL 不会损坏数据库（断电时最多丢最后几笔已提交的写入），
 * 每次写入不再在事件循环上等磁盘落盘（NAS 机械盘一次落盘 5–20 ms，期间所有请求都卡住）。
 * journal_size_limit：检查点之后把 WAL 文件截到 16 MB 以内（以前批量删除后会一直停在几十 MB）。
 * cache_size：页缓存 32 MB（默认只有 2 MB，几万条视频的索引放不下）。
 */
db.exec('PRAGMA synchronous = NORMAL')
db.exec('PRAGMA journal_size_limit = 16777216')
db.exec('PRAGMA cache_size = -32000')

/*
 * 语句缓存：同一条 SQL 只编译一次（每次重新编译比执行本身还慢几倍）。
 * SQL 都是代码里写死的或白名单拼的，条数有限；IN 列表一律用 json_each(?) 传，不随个数变。封顶防意外。
 */
const STMT_CACHE_MAX = 500
const stmts = new Map()
function st(sql) {
  let s = stmts.get(sql)
  if (!s) {
    s = db.prepare(sql)
    if (stmts.size >= STMT_CACHE_MAX) stmts.delete(stmts.keys().next().value)
    stmts.set(sql, s)
  }
  return s
}
const all = (sql, ...args) => st(sql).all(...args)
const get = (sql, ...args) => st(sql).get(...args)
const run = (sql, ...args) => st(sql).run(...args)
/** IN 列表的参数：一个 JSON 数组，配合 IN (SELECT value FROM json_each(?)) */
const IDS = '(SELECT value FROM json_each(?))'
/*
 * 按一串 id 从视图里取行：json_each 必须在外层（CROSS JOIN 固定连接顺序），逐个按主键查。
 * 写成 WHERE id IN (…) 的话，视图里的 status = 1 会让 SQLite（库里没有统计信息）改走 status 索引、把全部已发布的行过一遍。
 */
const VIDEOS_BY_IDS = 'SELECT v.* FROM json_each(?) j CROSS JOIN v_videos v ON v.id = j.value'
const jsonIds = ids => JSON.stringify(ids)

/** 是不是「数据库被别的连接锁住」（SQLITE_BUSY / SQLITE_LOCKED 及其扩展码） */
export const isBusyError = e => e?.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(Number(e.errcode) & 0xff)

/*
 * 等写锁不卡事件循环。
 *
 * SQLite 的 busy_timeout 是在调用里同步睡眠重试：等的这段时间整个服务停住，读请求也一个都处理不了；
 * 别的进程长时间拿着写锁、App 又不停在写（播放记录每隔几秒一条）时，服务几乎一直是停的。
 * 所以开始接请求以后（startServing）把它设成 0：拿不到写锁马上报「忙」，改由这里用 setTimeout 隔一会儿探一次
 * （BEGIN IMMEDIATE 后马上 ROLLBACK，几微秒，不写任何东西），放开了再写，最多等 BUSY_TIMEOUT_MS。
 *   - 路由层：写请求（POST / PATCH / PUT / DELETE）进处理函数之前先 whenWritable()，等不到回 503。
 *     处理函数都是同步写库的，探到能写以后马上就写，中间插不进别的进程；万一插进来了，照旧回 503。
 *   - 中途会让出事件循环的批量操作（分块删除、改名后改引用、导入）每次写库前用 retryBusy / txWait 自己等。
 *   - GET 里顺带的写（续会话、记搜索词）拿不到锁就跳过，不让读请求因此失败。
 */
const LOCK_POLL_MS = [2, 5, 10, 20, 40, 80, 100]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 开始接请求：SQLite 自己不再同步等锁（见上面），server/index.mjs 开始监听前调用 */
export function startServing() {
  db.exec('PRAGMA busy_timeout = 0')
}

/** 现在能不能写（别的进程没拿着写锁）；已经在事务里时当然能写 */
function writable() {
  if (db.isTransaction) return true
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (e) {
    if (isBusyError(e)) return false
    throw e
  }
  db.exec('ROLLBACK')
  return true
}

/* 有写请求在等锁时记一行日志（10 秒内只记一次），方便事后知道那几秒为什么慢 */
let lockWaitLoggedAt = 0
function noteLockWait() {
  const t = Date.now()
  if (t - lockWaitLoggedAt < 10_000) return
  lockWaitLoggedAt = t
  console.warn(`[数据库正忙] 别的进程拿着写锁，写操作异步排队等它放开（最多 ${BUSY_TIMEOUT_MS} ms），读请求不受影响`)
}

/**
 * 等到能写为止（异步，等的时候别的请求照常处理），最多等 budget 毫秒；拿到返回 true，超时返回 false。
 * 探到能写以后要在同一段同步代码里接着写，中间不能再 await，否则锁可能又被别的进程拿走。
 */
export async function whenWritable(budget = BUSY_TIMEOUT_MS) {
  if (writable()) return true
  noteLockWait()
  const deadline = Date.now() + budget
  for (let i = 0; ; i++) {
    const left = deadline - Date.now()
    if (left <= 0) return false
    await sleep(Math.min(LOCK_POLL_MS[Math.min(i, LOCK_POLL_MS.length - 1)], left))
    if (writable()) return true
  }
}

/**
 * 执行同步的 fn；fn 因为拿不到写锁报「忙」时异步等锁放开（whenWritable）再整个重来，总共最多等 budget 毫秒，超时把「忙」抛出去。
 * fn 必须出错时自己回滚干净（tx 就是这样；BEGIN IMMEDIATE 报忙时什么都还没写），也不能有库以外的副作用。
 */
export async function retryBusy(fn, budget = BUSY_TIMEOUT_MS) {
  const deadline = Date.now() + budget
  for (let i = 0; ; i++) {
    try {
      return fn()
    } catch (e) {
      if (!isBusyError(e) || db.isTransaction) throw e
      const left = deadline - Date.now()
      if (left <= 0) throw e
      // 先歇一小会儿：探锁说能写、fn 却还是报忙（锁刚好又被抢走）时不会原地空转
      await sleep(Math.min(LOCK_POLL_MS[Math.min(i, LOCK_POLL_MS.length - 1)], left))
      if (!(await whenWritable(deadline - Date.now()))) throw e
    }
  }
}

/** tx 的异步版：拿不到写锁时异步等（见 retryBusy）。给中途会让出事件循环的批量操作用 */
export const txWait = (fn, budget) => retryBusy(() => tx(fn), budget)

/** 顺带的写（续会话、记搜索词）：拿不到写锁就跳过（返回 undefined），不让整个请求失败；别的错误照常抛 */
export function bestEffortWrite(fn) {
  try {
    return fn()
  } catch (e) {
    if (!isBusyError(e)) throw e
  }
}

/**
 * 在一个事务里执行 fn，出错整体回滚。
 * 已经处在事务里时（如管理后台批量导入的外层事务）改用 SAVEPOINT，只回滚这一段。
 * 用 BEGIN IMMEDIATE：一开始就拿写锁（拿不到马上报「忙」，什么都还没做，可以整个重来）。普通的 BEGIN 先读后写，
 * 等到要写时如果别人刚提交过，SQLite 直接报「忙」、不会等（读到的快照已经旧了），而且前面的读已经做了。
 */
let savepointSeq = 0
export function tx(fn) {
  if (db.isTransaction) {
    const sp = 'tx_sp' + (++savepointSeq)
    db.exec(`SAVEPOINT ${sp}`)
    try {
      const out = fn()
      db.exec(`RELEASE ${sp}`)
      return out
    } catch (e) {
      db.exec(`ROLLBACK TO ${sp}`)
      db.exec(`RELEASE ${sp}`)
      throw e
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/*
 * 前台查询要用的索引；老库启动时补建（新库由 schema.sql 建，定义两边一致；建库前表还不存在就跳过）。
 * 全是 CREATE INDEX IF NOT EXISTS：已有的直接跳过，不碰数据。第一次在几万条视频的大库上补建要几秒（见 README「启动时的自动补建」）。
 * 都是「等值列在前、排序列在后」，让 SQLite 不用统计信息（库里没跑过 ANALYZE）也能选对索引，不再扫全部已发布视频。
 */
const tableExists = name => !!get("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = ?", name)
const INDEXES = [
  // 播放页相似推荐；带上 playback_url 的那个是覆盖索引：有片源的排前面也不用回表
  ['videos', 'idx_videos_related ON videos(status, topic_id, category_key, play_count DESC)'],
  ['videos', 'idx_videos_related_src ON videos(status, topic_id, category_key, play_count DESC, playback_url)'],
  // 专题页按播放 / 收藏排序；播放索引顺带覆盖专题头部的播放数、收藏数之和
  ['videos', 'idx_videos_topic_play ON videos(status, topic_id, play_count DESC, fav_count)'],
  ['videos', 'idx_videos_topic_fav ON videos(status, topic_id, fav_count DESC)'],
  // 「最新」的 7 天 × 地区计数（覆盖索引，不回表）
  ['videos', 'idx_videos_pub_region ON videos(status, published_at DESC, region)'],
  // 一两个字的搜索（LIKE）、热门搜索词「有没有结果」：按发布时间倒序的覆盖索引，计数和列表都不回表
  ['videos', 'idx_videos_search ON videos(status, published_at DESC, title, tags)'],
  ['posts', 'idx_posts_search ON posts(status, published_at DESC, text, tags)'],
  // 创作者主页：计数、按最新 / 最热翻页（创作者 id 在前，只看他自己的视频 / 帖子）
  ['videos', 'idx_videos_creator_pub ON videos(creator_id, status, published_at DESC)'],
  ['videos', 'idx_videos_creator_play ON videos(creator_id, status, play_count DESC)'],
  ['posts', 'idx_posts_creator_pub ON posts(creator_id, status, published_at DESC)'],
  // 按封面地址找视频（「媒体」照片墙去掉和视频封面重复的帖子图；后台查重也用它，定义与 db/admin.mjs 一致）
  ['videos', 'idx_videos_cover ON videos(cover_url)'],
  // 「我的」：收藏 / 关注列表按时间倒序翻页，不再把一个人的全部收藏临时排序
  ['video_favs', 'idx_video_favs_user ON video_favs(user_id, created_at DESC, video_id DESC)'],
  ['post_favs', 'idx_post_favs_user ON post_favs(user_id, created_at DESC, post_id DESC)'],
  ['topic_favs', 'idx_topic_favs_user ON topic_favs(user_id, created_at DESC, topic_id DESC)'],
  ['user_follows', 'idx_user_follows_user ON user_follows(user_id, created_at DESC, creator_id DESC)'],
  // 外键子列：删视频 / 帖子 / 用户 / 评论时级联删除、置空要按这些列找行，没有索引就每删一条扫一遍整表
  ['watch_history', 'idx_watch_history_video ON watch_history(video_id)'],
  ['video_dislikes', 'idx_video_dislikes_video ON video_dislikes(video_id)'],
  ['search_history', 'idx_search_history_video ON search_history(video_id)'],
  ['posts', 'idx_posts_video ON posts(video_id)'],
  ['series_episodes', 'idx_episodes_video ON series_episodes(video_id)'],
  ['video_uploads', 'idx_uploads_video ON video_uploads(video_id)'],
  ['comments', 'idx_comments_user ON comments(user_id)'],
  ['comments', 'idx_comments_parent ON comments(parent_id)'],
  ['comments_likes', 'idx_comments_likes_comment ON comments_likes(comment_id)'],
  ['post_media_blobs', 'idx_post_media_blobs_post ON post_media_blobs(post_id)'],
  ['danmaku', 'idx_danmaku_user ON danmaku(user_id)'],
  // 删专题时把视频的 topic_id 置空（现有的专题索引都是 status 打头，按 topic_id 单独找不到）
  ['videos', 'idx_videos_topic ON videos(topic_id)'],
  // 后台视频列表按播放 / 点赞 / 收藏 / 标题 / 时长排序（同值按 id，翻页稳定），不再全表临时排序
  ['videos', 'idx_videos_admin_play ON videos(play_count DESC, id DESC)'],
  ['videos', 'idx_videos_admin_like ON videos(like_count DESC, id DESC)'],
  ['videos', 'idx_videos_admin_fav ON videos(fav_count DESC, id DESC)'],
  ['videos', 'idx_videos_admin_title ON videos(title, id)'],
  ['videos', 'idx_videos_admin_dur ON videos(duration_sec, id)']
]
/*
 * 先把行里内联的 SVG 占位图挪进 art_blobs（见 lib/art-store.mjs），再建索引：
 * 种子数据的占位图 2–21 KB 一张，挪走以后视频行不再溢出，建索引、扫表都快得多。
 */
moveInlineArt(db, {
  log: (n, ms) => console.log(`已把 ${n} 张内联的占位图挪进 art_blobs（列表接口改成下发 /api/art/… 短地址）` +
    (ms != null ? `，并整理了一次数据库（${ms} ms）` : ''))
})
for (const [table, def] of INDEXES) {
  if (tableExists(table)) db.exec(`CREATE INDEX IF NOT EXISTS ${def}`)
}

/* 帖子详情正文 posts.content：老库没有这一列，启动时补上（新库由 schema.sql 建） */
if (get("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'posts'") &&
    !all('PRAGMA table_info(posts)').some(c => c.name === 'content')) {
  db.exec("ALTER TABLE posts ADD COLUMN content TEXT NOT NULL DEFAULT ''")
  console.log('已为 posts 表补上 content 列（帖子详情正文）')
}

/* 帖子改标题 / 标签后全文索引要跟着变；老库没有这个触发器，启动时补建（与 views.sql 一致） */
if (get("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'posts_fts'")) {
  db.exec(`CREATE TRIGGER IF NOT EXISTS posts_fts_update AFTER UPDATE OF text, tags ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    INSERT INTO posts_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END`)
}

/*
 * 「我的」页计数改成实时统计：老库的 v_users 还读 user_stats 里没人维护的列（收藏 / 关注恒为 0），
 * 启动时按 views.sql 里的定义重建（定义只写在 views.sql 一处）
 */
if (get("SELECT 1 x FROM sqlite_master WHERE type = 'view' AND name = 'v_users' AND sql NOT LIKE '%fav_video_count%'")) {
  const def = readFileSync(join(here, 'views.sql'), 'utf8').match(/DROP VIEW IF EXISTS v_users;[\s\S]*?WHERE u\.status = 1;/)
  if (def) {
    db.exec(def[0])
    console.log('已更新 v_users 视图（「我的」页计数改为实时统计）')
  }
}

/*
 * 图集（albums / album_images）：老库没有这两张表，启动时按 schema.sql 里「图集」那一段补建（定义只写在 schema.sql 一处）。
 * 全是 CREATE … IF NOT EXISTS，不碰已有的表和数据；建库前（还没有 creators 表）跳过。
 */
if (get("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'creators'")) {
  const missing = !get("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'album_images'")
  const def = readFileSync(join(here, 'schema.sql'), 'utf8').match(/CREATE TABLE IF NOT EXISTS albums \([\s\S]*?-- 图集结束/)
  if (def) {
    db.exec(def[0])
    if (missing) console.log('已补建图集表 albums / album_images（创作者主页「图片」）')
  } else if (missing) {
    console.warn('schema.sql 里找不到图集表的定义，没有补建 albums / album_images')
  }
}

/* ---------------- 行 → 前端结构 ---------------- */

/** 数据库行 → 前端 Cover { src, fallback } */
const toCover = (src, fallback) => (src || fallback ? { src, fallback } : null)

/** 数据库行 → 前端 Video（字段名与 src/api/index.js 的 typedef 一致） */
export function toVideo(r) {
  if (!r) return null
  return {
    id: r.id,
    code: r.code,
    // 下面两个字段由 attachVideoState() 按当前用户回填
    liked: false,
    faved: false,
    title: r.title,
    dur: r.dur,
    len: r.len,
    cover: toCover(r.cover_src, r.cover_fallback),
    topicId: r.topic_id,
    topicName: r.topic_name,
    creator: r.creator_id ? { id: r.creator_id, name: r.creator_name, handle: r.creator_handle, avatar: toCover(r.creator_avatar_url, r.creator_avatar_fallback) } : null,
    playCount: r.play_count,
    likeCount: r.like_count,
    favCount: r.fav_count,
    tags: parseTags(r.tags),
    publishedAt: r.published_at,
    // 有没有片源（播放地址）：播放页的「下一个」/ 自动连播据此跳过只有封面的视频
    hasSrc: !!r.playback_url
  }
}

/** 图片 Cover 再带上小图地址 thumb（网格、头图横幅用，原图留给全屏看大图）；没有图片地址时 thumb 为 null */
const withThumb = c => (c ? { ...c, thumb: thumbOf(c.src) } : c)

/**
 * 按给定 id 的顺序取 v_videos 的整行（已下架 / 删除的跳过）。
 * 列表先在索引上只挑出这一页的 id，再回来取整行：排序、跳页不用把整行（含长文本）一起拖着走。
 */
function videoRowsByIds(ids) {
  if (!ids.length) return []
  const byId = new Map(all(VIDEOS_BY_IDS, jsonIds(ids)).map(r => [r.id, r]))
  return ids.map(id => byId.get(id)).filter(Boolean)
}

export function parseTags(v) {
  if (!v) return []
  try { const t = JSON.parse(v); return Array.isArray(t) ? t : [] } catch { return [] }
}

/**
 * 回填「当前用户是否点过赞 / 收藏过」。
 * 列表接口统一在最后调一次，避免每条内容单独查一次。
 */
export function attachVideoState(list, userId) {
  if (!userId || !list.length) return list
  const ids = jsonIds(list.map(v => v.id))
  const marks = table => new Set(all(`SELECT video_id FROM ${table} WHERE user_id = ? AND video_id IN ${IDS}`, userId, ids).map(r => r.video_id))
  const liked = marks('video_likes')
  const faved = marks('video_favs')
  for (const v of list) {
    v.liked = liked.has(v.id)
    v.faved = faved.has(v.id)
  }
  return list
}

export function attachPostState(list, userId) {
  if (!userId || !list.length) return list
  const rows = all(`SELECT post_id FROM post_favs WHERE user_id = ? AND post_id IN ${IDS}`, userId, jsonIds(list.map(p => p.id)))
  const faved = new Set(rows.map(r => r.post_id))
  for (const p of list) p.faved = faved.has(p.id)
  return list
}

/** 「44分钟前」这类相对时间，展示层用 */
export function relativeTime(ts, now = Math.floor(Date.now() / 1000)) {
  if (!ts) return ''
  const d = now - ts
  if (d < 60) return '刚刚'
  if (d < 3600) return Math.floor(d / 60) + '分钟前'
  if (d < 86400) return Math.floor(d / 3600) + '小时前'
  if (d < 86400 * 7) return Math.floor(d / 86400) + '天前'
  const dt = new Date(ts * 1000)
  return `${dt.getMonth() + 1}月${dt.getDate()}日`
}

/* ---------------- 首页 ---------------- */

/** 首页顶部分类 Tab（首页 / 首页各分类页共用） */
export const homeTabs = () => all(`SELECT key, label, show_flame AS hot FROM client_tabs WHERE nav='home' AND status=1 ORDER BY sort_order`)
export const mainTabs = () => all(`SELECT key, label, icon FROM client_tabs WHERE nav='main' AND status=1 ORDER BY sort_order`)

/**
 * 首页「推荐」分区列表。
 * live_topic_id：关联专题仍然上架时才有值（下架 / 删除的专题为 NULL），前端据此决定显示不显示「全部 / 看更多」。
 */
export const recommendSections = () => all(`SELECT s.*, t.id AS live_topic_id FROM v_home_sections s
                                            LEFT JOIN v_topics t ON t.id = s.topic_id
                                            ORDER BY s.sort_order`)

/*
 * 分区的「批」只算至少有一条已上架视频的批次：全是草稿 / 下架视频的批在前台是空白的，不能算进去。
 * 前端按 0..batches-1 请求，所以第 n 批 = 第 n 个非空批次（库里的 batch_no 可能不连续）。
 */
const LIVE_BATCHES = `SELECT DISTINCT i.batch_no AS b FROM home_section_items i
                      JOIN videos v ON v.id = i.video_id AND v.status = 1
                      WHERE i.section_id = ? ORDER BY i.batch_no`

/** 某个分区第 batch 个（非空）批次的视频；batch 为 0 时取第一批 */
export function sectionVideos(sectionId, size = 4, batch = 0) {
  const b = get(`${LIVE_BATCHES} LIMIT 1 OFFSET ?`, sectionId, Math.max(0, batch))?.b
  if (b == null) return []
  return all(`SELECT * FROM v_home_section_items
              WHERE section_id = ? AND batch_no = ?
              ORDER BY item_rank LIMIT ?`, sectionId, b, size).map(toVideo)
}

export const sectionBatches = sectionId => get(`SELECT COUNT(*) c FROM (${LIVE_BATCHES})`, sectionId).c

/**
 * 服务器本地时区里「daysAgo 天前」那一天的 0 点（秒）。
 * 与管理后台解析发布时间（fields.mjs，按本地时间）一致；用 Date 的年月日构造，夏令时那天也不会错位。
 */
export function localDayStart(now, daysAgo = 0) {
  const d = new Date(now * 1000)
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime() / 1000)
}

/*
 * 地区筛选：code 为 'other'（其他）的地区同时收下没填地区、或地区不在 regions 表里的视频，
 * 否则这些视频在「最新」里哪个地区都点不出来。返回 [SQL 片段, 参数]。
 */
const OTHER_REGION = 'other'
function regionWhere(code) {
  if (code === OTHER_REGION) return ['(v.region IS NULL OR v.region = ? OR v.region NOT IN (SELECT code FROM regions))', [code]]
  return ['v.region = ?', [code]]
}

/* 「最新」页的地区第一项是「全部」（默认选中），之后是 regions 表里的地区 */
const LATEST_DAYS = 7
const ALL_REGION = { code: 'all', label: '全部' }

/*
 * 7 天 × 地区的计数：走覆盖索引 idx_videos_pub_region(status, published_at, region)，不回表。
 * 分天的边界用参数传（语句本身不随日期变，可以一直用缓存里编译好的那条）。
 */
const LATEST_BUCKETS_SQL = `SELECT CASE ${Array.from({ length: LATEST_DAYS }, (_, i) => `WHEN published_at >= ? THEN ${i}`).join(' ')} END AS d,
                                   region, COUNT(*) c
                            FROM videos WHERE status = 1 AND published_at >= ? AND published_at < ? GROUP BY d, region`

/**
 * 最近一次上新的时间（秒）：已发布、发布时间不晚于明天 0 点（和「今天」一栏同一个上限）的视频里最新的一条；一条都没有为 null。
 * 7 天里一条都没有时，App 据此提示「最近一次上新是 x 月 x 日」，并用 date=recent 列出最近上新的视频。
 */
const latestPublishedAt = (end) => get('SELECT MAX(published_at) t FROM videos WHERE status = 1 AND published_at < ?', end)?.t ?? null

/**
 * 「最新」页的日期与地区筛选（计数实时统计，不写死）。
 *   dates[d].count          第 d 天（0 = 今天）全部地区的视频数
 *   regions[i].counts[d]    第 i 个地区第 d 天的视频数；regions[0] 是「全部」，所以 regions[0].counts[d] === dates[d].count
 *   regions[i].count        = counts[date]（date 是当前选中的日期，默认今天），选中的日期和地区上的数字对得上
 *   latestAt                最近一次上新的时间（见 latestPublishedAt）
 * 一条 GROUP BY 查完 7 天 × 各地区，不按地区逐个 COUNT。
 */
export function latestFilters({ date = 0 } = {}, now = Math.floor(Date.now() / 1000)) {
  const day = Math.min(Math.max(Math.floor(Number(date)) || 0, 0), LATEST_DAYS - 1)
  const starts = Array.from({ length: LATEST_DAYS + 1 }, (_, i) => localDayStart(now, i - 1))   // starts[0] = 明天 0 点
  const regions = [ALL_REGION, ...all('SELECT code, label FROM regions ORDER BY sort_order')]
    .map(r => ({ code: r.code, label: r.label, counts: new Array(LATEST_DAYS).fill(0) }))
  const byCode = new Map(regions.slice(1).map(r => [r.code, r]))
  const other = byCode.get(OTHER_REGION)
  const rows = all(LATEST_BUCKETS_SQL, ...starts.slice(1), starts[LATEST_DAYS], starts[0])
  for (const r of rows) {
    if (r.d == null) continue
    regions[0].counts[r.d] += r.c
    // 没填地区、或地区不在 regions 表里的算「其他」（与 regionWhere 一致）
    const target = (r.region !== OTHER_REGION && byCode.get(r.region)) || other
    if (target) target.counts[r.d] += r.c
  }
  const dates = regions[0].counts.map((count, i) => {
    const d = new Date(starts[i + 1] * 1000)
    return { label: i === 0 ? '今天' : i === 1 ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`, count }
  })
  return { dates, regions: regions.map(r => ({ ...r, count: r.counts[day] })), latestAt: latestPublishedAt(starts[0]) }
}

/**
 * 「最新」的 date 参数：0～6 是「几天前」（再大也照样按天算，封顶 10 年）；'recent' = 不限日期的最近上新。
 * 非法值按 0（今天）。
 */
export const LATEST_RECENT = 'recent'
export function latestDateOf(raw) {
  if (String(raw ?? '').trim().toLowerCase() === LATEST_RECENT) return LATEST_RECENT
  const d = Math.floor(Number(raw))
  return d > 0 ? Math.min(d, 3650) : 0
}

/**
 * 「最新」里的地区参数 → 地区 code（null = 全部）。
 * 数字是 latestFilters().regions 的下标（0 = 全部），也可以直接传 code（all / cn / jk / other）；认不出的按全部。
 */
function latestRegionCode(region) {
  const s = String(region ?? '').trim()
  if (!s || s === ALL_REGION.code) return null
  if (/^\d+$/.test(s)) {
    const i = Number(s)
    return i > 0 ? get('SELECT code FROM regions ORDER BY sort_order LIMIT 1 OFFSET ?', i - 1)?.code ?? null : null
  }
  return get('SELECT code FROM regions WHERE code = ?', s)?.code ?? null
}

/**
 * 「最新」页某天 + 某地区的视频（date：0 = 今天，按服务器本地日期分天；region 见 latestRegionCode）。
 * date = 'recent'：不限日期，最近上新的在前（7 天里一条都没有时 App 用它兜底），上限同样是明天 0 点。
 */
export function latestVideos({ date = 0, region = 0, limit = 20, offset = 0 } = {}, now = Math.floor(Date.now() / 1000)) {
  const day = latestDateOf(date)
  const recent = day === LATEST_RECENT
  const range = recent ? [localDayStart(now, -1)] : [localDayStart(now, day), localDayStart(now, day - 1)]
  const regionCode = latestRegionCode(region)
  const [where, args] = regionCode ? regionWhere(regionCode) : ['1', []]
  const ids = all(`SELECT v.id FROM videos v
                   WHERE v.status = 1 AND ${recent ? '' : 'v.published_at >= ? AND '}v.published_at < ? AND ${where}
                   ORDER BY v.published_at DESC, v.id DESC LIMIT ? OFFSET ?`, ...range, ...args, limit, offset).map(r => r.id)
  return videoRowsByIds(ids).map(toVideo)
}

/** 分类页筛选项 + 某分类的视频（sortKey 来自 category_filters.sort_key，已白名单校验） */
export const categoryFilters = tab => all('SELECT label, sort_key FROM category_filters WHERE tab = ? ORDER BY sort_order', tab)

const SORTABLE = { default: 'published_at', play_count: 'play_count', published_at: 'published_at', like_count: 'like_count' }
export function categoryVideos(tab, { filter = 0, limit = 20, offset = 0 } = {}) {
  const f = get('SELECT * FROM category_filters WHERE tab = ? ORDER BY sort_order LIMIT 1 OFFSET ?', tab, filter)
  const order = SORTABLE[f?.sort_key] || 'published_at'
  return all(`SELECT * FROM v_videos WHERE category_key = ? ORDER BY ${order} DESC LIMIT ? OFFSET ?`, tab, limit, offset).map(toVideo)
}

/* ---------------- 搜索 ---------------- */

/**
 * 热门搜索词（换一批 = 往后挪一批）。
 * 只列搜得到东西的词：已发布的视频或帖子至少命中一条（和搜索用同一套匹配），点进去不会是 0 条结果；屏蔽的词不列。
 * 每批 size 个，翻到末尾接回开头，所以每批都是满的；能显示的词不到 size 个时全部返回。
 *
 * 性能：每个词只查「有没有」（EXISTS，命中第一条就停；搜不到的词走覆盖索引，几万条视频约几毫秒），
 * 筛好的词表在内存里记 HOT_TTL_MS；后台任何写操作（改热词、上下架视频…）之后 invalidateCaches() 立刻作废，所以后台改了马上生效。
 * 重新筛的时候每干 HOT_SLICE_MS 就让出一次事件循环，几百个词也不会把别的请求堵住；同时来的请求共用同一次计算。
 */
const HOT_TTL_MS = 60_000
const HOT_SLICE_MS = 8
let hotCache = null        // { at, gen, words }
let hotPending = null      // 正在算的那一次 { gen, promise }
let cacheGen = 0           // invalidateCaches() 每调一次加一：算到一半被作废的结果不写回缓存

function visibleHotWords() {
  if (hotCache && hotCache.gen === cacheGen && Date.now() - hotCache.at < HOT_TTL_MS) return Promise.resolve(hotCache.words)
  if (hotPending?.gen === cacheGen) return hotPending.promise
  const gen = cacheGen
  const promise = (async () => {
    const words = all(`SELECT word, is_hot AS hot FROM search_keywords WHERE is_banned = 0
                       ORDER BY weight DESC, sort_order`)
    const out = []
    let slice = performance.now()
    for (const w of words) {
      if (hasSearchHits(w.word)) out.push(w)
      if (performance.now() - slice > HOT_SLICE_MS) {
        await new Promise(r => setImmediate(r))
        slice = performance.now()
      }
    }
    if (gen === cacheGen) hotCache = { at: Date.now(), gen, words: out }
    return out
  })().finally(() => { if (hotPending?.promise === promise) hotPending = null })
  hotPending = { gen, promise }
  return promise
}

export async function hotWords(page = 0, size = 8) {
  const words = await visibleHotWords()
  if (words.length <= size) return words.map(w => ({ ...w }))
  const start = (Math.min(Math.max(0, Math.floor(Number(page)) || 0), 1e9) * size) % words.length
  return Array.from({ length: size }, (_, i) => ({ ...words[(start + i) % words.length] }))
}

/** 热门创作者 */
export const creators = (limit = 5) =>
  all(`SELECT id, handle, name, avatar_url, avatar_fallback, is_verified AS verified, follower_count
       FROM creators WHERE status = 1 ORDER BY is_official DESC, follower_count DESC LIMIT ?`, limit)

/**
 * 旧版「近期搜索」：每次搜索第一条结果的视频卡片（已弃用，App 改用 searchKeywords 的关键词列表后删除）。
 * 没有结果的搜索不带视频，这里跳过。
 */
export const searchHistory = (userId, { limit = 5, offset = 0 } = {}) =>
  all(`SELECT v.* FROM search_history h JOIN v_videos v ON v.id = h.video_id
       WHERE h.user_id = ? ORDER BY h.created_at DESC, h.id DESC LIMIT ? OFFSET ?`,
    userId, limit, offset).map(toVideo)

export const searchHistoryCount = userId =>
  get('SELECT COUNT(*) c FROM search_history WHERE user_id = ?', userId).c

/* 每人最多留这么多条搜索记录；关键词最长存这么多字 */
const SEARCH_HISTORY_MAX = 50
const SEARCH_KEYWORD_MAX = 100

/** 记一次搜索（同一个词只留最新一条）；没有结果的搜索也记，videoId 为 null */
export function addSearchHistory(userId, keyword, videoId = null) {
  const kw = [...String(keyword || '').trim()].slice(0, SEARCH_KEYWORD_MAX).join('')
  if (!kw) return
  const now = Math.floor(Date.now() / 1000)
  tx(() => {
    run('DELETE FROM search_history WHERE user_id = ? AND keyword = ?', userId, kw)
    run('INSERT INTO search_history(user_id, keyword, video_id, created_at) VALUES(?,?,?,?)', userId, kw, videoId, now)
    run(`DELETE FROM search_history WHERE user_id = ? AND id NOT IN
         (SELECT id FROM search_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${SEARCH_HISTORY_MAX})`, userId, userId)
  })
}

/** 近期搜索的关键词：新的在前，同一个词只有一条（写入时已去重） */
export const searchKeywords = (userId, { limit = 10 } = {}) =>
  all(`SELECT keyword, created_at AS searchedAt FROM search_history WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`, userId, limit)

/** 删一个关键词（keyword 为空 = 清空全部），返回删掉的条数 */
export function removeSearchHistory(userId, keyword = null) {
  const kw = String(keyword ?? '').trim()
  return Number(kw
    ? run('DELETE FROM search_history WHERE user_id = ? AND keyword = ?', userId, kw).changes
    : run('DELETE FROM search_history WHERE user_id = ?', userId).changes)
}

/* 搜索的匹配方式：3 个字以上走 FTS5 trigram（短语），1~2 个字退回 LIKE */
const useFts = kw => [...kw].length >= 3
const ftsPhrase = kw => '"' + kw.replace(/"/g, '""') + '"'

/*
 * 1～2 个字的 LIKE 匹配：WHERE 只碰 status、title、tags（帖子是 text、tags），正好被覆盖索引
 * idx_videos_search(status, published_at DESC, title, tags) / idx_posts_search 盖住 —— 计数、「有没有」、按时间倒序取一页
 * 都只扫索引、不回表（以前逐行回表，连行里的占位图一起读，几万条要两三百毫秒）。
 */
const VIDEO_LIKE = 'status = 1 AND (title LIKE ? OR tags LIKE ?)'
const POST_LIKE = 'status = 1 AND (text LIKE ? OR tags LIKE ?)'
const likeArgs = kw => [`%${kw}%`, `%${kw}%`]

/** 已发布视频里命中的条数（和 searchVideos 的 total 一致） */
const videoHits = kw => (useFts(kw)
  ? get(`SELECT COUNT(*) c FROM videos_fts f JOIN videos v ON v.id = f.rowid
         WHERE videos_fts MATCH ? AND v.status = 1`, ftsPhrase(kw)).c
  : get(`SELECT COUNT(*) c FROM videos WHERE ${VIDEO_LIKE}`, ...likeArgs(kw)).c)

/** 已发布帖子里命中的条数（和 searchPosts 的 total 一致） */
const postHits = kw => (useFts(kw)
  ? get(`SELECT COUNT(*) c FROM posts_fts f JOIN posts p ON p.id = f.rowid AND p.status = 1
         WHERE posts_fts MATCH ?`, ftsPhrase(kw)).c
  : get(`SELECT COUNT(*) c FROM posts WHERE ${POST_LIKE}`, ...likeArgs(kw)).c)

/** 这个词能不能搜到东西（视频或帖子至少一条）：只问「有没有」，命中第一条就停，不数总数 */
function hasSearchHits(word) {
  const kw = String(word || '').trim()
  if (!kw) return false
  if (useFts(kw)) {
    return !!get(`SELECT 1 x FROM videos_fts f JOIN videos v ON v.id = f.rowid WHERE videos_fts MATCH ? AND v.status = 1 LIMIT 1`, ftsPhrase(kw)) ||
      !!get(`SELECT 1 x FROM posts_fts f JOIN posts p ON p.id = f.rowid AND p.status = 1 WHERE posts_fts MATCH ? LIMIT 1`, ftsPhrase(kw))
  }
  return !!get(`SELECT 1 x FROM videos WHERE ${VIDEO_LIKE} LIMIT 1`, ...likeArgs(kw)) ||
    !!get(`SELECT 1 x FROM posts WHERE ${POST_LIKE} LIMIT 1`, ...likeArgs(kw))
}

/**
 * 视频搜索。中文用 FTS5 trigram 分词（支持子串匹配），
 * 但 trigram 至少要 3 个字，1~2 个字的短词退回 LIKE。
 */
export function searchVideos(q, { limit = 20, offset = 0 } = {}) {
  const kw = String(q || '').trim()
  if (!kw) return { total: 0, list: [] }
  const total = videoHits(kw)
  if (useFts(kw)) {
    const list = all(`SELECT v.* FROM videos_fts f JOIN v_videos v ON v.id = f.rowid
                      WHERE videos_fts MATCH ? ORDER BY f.rank LIMIT ? OFFSET ?`, ftsPhrase(kw), limit, offset).map(toVideo)
    return { total, list }
  }
  // 先在覆盖索引上按发布时间倒序挑出这一页的 id（搜不到 / 命中很少时也只是把索引扫一遍），再回 v_videos 取整行
  const ids = all(`SELECT id FROM videos WHERE ${VIDEO_LIKE} ORDER BY published_at DESC LIMIT ? OFFSET ?`,
    ...likeArgs(kw), limit, offset).map(r => r.id)
  return { total, list: videoRowsByIds(ids).map(toVideo) }
}

/**
 * 社区搜索（帖子）：搜标题（posts.text）和话题标签，只算已发布的。
 * 3 个字以上走 FTS5 trigram（按相关度，同分新的在前），1~2 个字退回 LIKE（新的在前）。
 * 返回 { total, list }，每条和社区列表一样带 media。
 */
export function searchPosts(q, { limit = 20, offset = 0 } = {}) {
  const kw = String(q || '').trim()
  if (!kw) return { total: 0, list: [] }
  const total = postHits(kw)
  let rows
  if (useFts(kw)) {
    rows = all(`SELECT ${POST_COLS} FROM posts_fts f JOIN v_posts p ON p.id = f.rowid ${POST_VIDEO}
                WHERE posts_fts MATCH ? ORDER BY f.rank, p.published_at DESC, p.id DESC LIMIT ? OFFSET ?`, ftsPhrase(kw), limit, offset)
  } else {
    rows = all(`SELECT ${POST_COLS} FROM v_posts p ${POST_VIDEO} WHERE p.text LIKE ? OR p.tags LIKE ?
                ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?`, ...likeArgs(kw), limit, offset)
  }
  return { total, list: withPostMedia(rows.map(toPost)) }
}

/* ---------------- 专题 ---------------- */

export const topic = id => get('SELECT * FROM v_topics WHERE id = ?', id)

/** 专题内已上架视频的播放数、收藏数之和（专题页「x次播放 · y收藏」不再停在后台手填的 0） */
export const topicVideoTotals = id =>
  get('SELECT COALESCE(SUM(play_count), 0) plays, COALESCE(SUM(fav_count), 0) favs FROM videos WHERE status = 1 AND topic_id = ?', id)

export const isTopicFaved = (userId, topicId) =>
  !!get('SELECT 1 x FROM topic_favs WHERE user_id = ? AND topic_id = ?', userId, topicId)
export const topicCovers = id => all('SELECT url, fallback FROM v_topic_covers WHERE topic_id = ? ORDER BY sort_order', id)
export const topicSorts = () => ['默认', '播放最多', '收藏最多', '最新上架', '最近更新']

/** 专题页的视频列表（按 topic.video_count 展示「视频 (45)」） */
export function topicVideos(id, sort = 0, { limit = 20, offset = 0 } = {}) {
  const order = ['published_at', 'play_count', 'fav_count', 'published_at', 'published_at'][sort] || 'published_at'
  const total = get('SELECT COUNT(*) c FROM videos WHERE status = 1 AND topic_id = ?', id).c
  const list = all(`SELECT * FROM v_videos WHERE topic_id = ? ORDER BY ${order} DESC LIMIT ? OFFSET ?`, id, limit, offset).map(toVideo)
  return { total, list }
}

/**
 * 片库：专题列表（含视频数）。
 * 卡片图用专题的第一张头图（管理后台上传的）；没有头图时用按专题 id 生成的图，
 * 这样增删专题不会让别的卡片换图。头图没有占位图时也补上生成图，图片打不开时不至于一片黑。
 */
export function library() {
  return topicCards(all('SELECT id, name, video_count AS count FROM v_topics WHERE kind = 2 ORDER BY sort_order, id'))
}

/** 专题卡片 { id, name, count, cover }（片库、我的收藏共用）；行里的其他字段原样带上 */
function topicCards(topics) {
  if (!topics.length) return []
  const first = new Map()
  for (const c of all(`SELECT topic_id, url, fallback FROM v_topic_covers
                       WHERE topic_id IN ${IDS} AND (url IS NOT NULL OR fallback IS NOT NULL)
                       ORDER BY topic_id, sort_order`, jsonIds(topics.map(t => t.id)))) {
    if (!first.has(c.topic_id)) first.set(c.topic_id, c)
  }
  return topics.map(t => {
    const c = first.get(t.id)
    const cover = c?.fallback ? { src: c.url || null, fallback: c.fallback }
      : c ? { src: c.url || null, fallback: topicArt(t.id).fallback }
        : topicArt(t.id)
    return { ...t, cover }
  })
}

/*
 * 没有头图的专题按 id 生成的卡片图：SVG 存进 art_blobs，下发短地址（见 lib/art-store.mjs）。
 * 每个专题只生成、存一次（记在内存里）；存不进去（只读库等）就退回内联的 SVG，至少能显示。
 */
const topicArtMemo = new Map()
function topicArt(id) {
  let hit = topicArtMemo.get(id)
  if (!hit) {
    const art = coverArt('cat' + id, { kind: id % 6 })
    let fallback = art.fallback
    try { fallback = storeArt(db, inlineSvg(fallback)) } catch (e) { console.warn('专题卡片图没能存进 art_blobs：', e.message) }
    hit = { src: art.src, fallback }
    if (topicArtMemo.size > 5000) topicArtMemo.clear()
    topicArtMemo.set(id, hit)
  }
  return { ...hit }
}
export const topicHero = id => all('SELECT url, fallback FROM v_topic_covers WHERE topic_id = ? ORDER BY sort_order', id)

/* ---------------- 播放页 ---------------- */

/** 只有播放量前 HOT_RANK_LIMIT 名才算上热榜，播放页据此显示「热门榜 No.N」 */
const HOT_RANK_LIMIT = 20

/** 播放页：单个视频，比列表多了播放地址、地区、清晰度、简介和热榜名次（不在热榜为 null） */
export function videoDetail(id) {
  const r = get('SELECT * FROM v_videos WHERE id = ?', id)
  if (!r) return null
  // 名次 = 播放量比它高的视频数 + 1（走 videos(status, play_count) 索引）
  const n = get('SELECT COUNT(*) + 1 AS n FROM videos WHERE status = 1 AND play_count > ?', r.play_count).n
  const rank = n <= HOT_RANK_LIMIT ? n : null
  return {
    ...toVideo(r),
    disliked: false,          // 由 api.getVideo() 按当前用户回填
    src: r.playback_url || null,
    region: r.region,
    quality: r.quality,
    description: r.description,
    rank
  }
}

export const isVideoDisliked = (userId, videoId) =>
  !!get('SELECT 1 FROM video_dislikes WHERE user_id = ? AND video_id = ?', userId, videoId)

/** 某用户上次看到哪：{ progressSec, watchedAt }，没看过为 { 0, null }（播放页据此续播，App 重开也在） */
export function watchProgress(userId, videoId) {
  const r = get('SELECT progress_sec, watched_at FROM watch_history WHERE user_id = ? AND video_id = ?', userId, videoId)
  return { progressSec: r ? Math.max(0, Math.floor(r.progress_sec || 0)) : 0, watchedAt: r?.watched_at ?? null }
}

/**
 * 相似推荐：有片源（播放地址）的在前，其次同专题、同分类，再按播放量排序。
 * 有片源的排前面是为了播放页的「下一个」/ 自动连播：每条带 hasSrc，App 取第一条能播的，不会连到只有封面的视频上。
 * batch 是「换一批」的序号；翻到末尾后从头接上，保证每批都是满的。
 */
export function relatedVideos(id, { batch = 0, limit = 6 } = {}) {
  const self = get('SELECT topic_id, category_key FROM videos WHERE id = ?', id)
  if (!self) return []
  // 只在基表上挑出 id，再取整行；空的专题 / 分类不参与匹配
  const where = 'status = 1 AND id != ? AND (topic_id = ? OR category_key = ?)'
  const args = [id, self.topic_id, self.category_key]
  const total = get(`SELECT COUNT(*) c FROM videos WHERE ${where}`, ...args).c
  if (!total) return []
  const page = (offset, n) => {
    const ids = all(
      `SELECT id FROM videos WHERE ${where}
       ORDER BY (playback_url IS NOT NULL AND playback_url != '') DESC, (topic_id = ?) DESC, play_count DESC, id LIMIT ? OFFSET ?`,
      ...args, self.topic_id, n, offset
    ).map(r => r.id)
    return videoRowsByIds(ids).map(toVideo)
  }
  const n = Math.min(limit, total)
  const offset = (batch * n) % total
  const list = page(offset, n)
  if (list.length < n) list.push(...page(0, n - list.length))
  return list
}

/* ---------------- 短视频 ---------------- */

/*
 * 短视频推荐流（GET /api/shorts?seed=&offset=&limit=&exclude=）。
 *
 * 候选是全部已上架视频；后台「加入短视频」的（short_clips）、有视频文件的、时长短的分档加权：
 * 有文件的精选在最前，接着是精选 / 有文件的短片，再是有文件的长视频，没有文件的长视频垫底
 * （没有文件的只能看封面，短视频页给它一个很短的模拟时长）。
 * 每条打分：
 *   热度       log(播放数)，按全池最大值归一
 *   新鲜度     按发布时间，半衰期 14 天
 *   短视频     后台加入短视频的加一大截
 *   有文件     有播放地址的加一大截
 *   时长       5 分钟以内加分，10 分钟以内加一点
 *   互动率     (赞 + 藏) / 播放，封顶
 *   随机扰动   hash(seed, id)：同一个 seed 顺序固定（翻页稳定），换一个 seed 顺序就变
 *   − 登录用户近期看过的（3 天内重罚、30 天内轻罚）
 *   − exclude：客户端最近刷到过的 id（未登录也能每次打开都不一样）
 *   − 登录用户点过「不喜欢」的（罚到最后，而且出页时直接跳过），同一创作者的其他视频小幅降分
 * 排好后再去一遍同质：同一创作者 / 同一专题尽量不挨着（后面几条里分差不大的换上来）。
 *
 * 整个排序按 (用户, seed) 只算一次、放进内存缓存（LRU，5 分钟没人翻就丢），翻页只是切片。
 * 翻过整个候选池后用派生 seed（seed:r1、seed:r2…）再排一轮接着给，前端永远刷不到底；
 * 新一轮的开头会避开上一轮末尾的几条，接缝处不会连着出现同一条。
 */
/*
 * 权重。热度 + 新鲜度 + 互动率 + 随机扰动合起来在 0 ~ 3.2 之间，下面几档加权都比它大，所以基本是分档排：
 *   精选 + 有文件 ≈ 6.5+  >  精选 / 有文件的短片 ≈ 3.5~4+  >  有文件的长视频 3+  >  没文件的短片 1+  >  其余
 * 看过 / 刷到过的罚分要跟得上这几档，否则刚看过的精选还会排在没看过的前面。
 */
const FEED_W = {
  pop: 1,          // 热度
  fresh: 0.6,      // 新鲜度
  curated: 3.5,    // 后台加入的短视频
  playable: 3,     // 有视频文件（没有的只能看封面）
  short: 1,        // 5 分钟以内
  medium: 0.4,     // 10 分钟以内
  engage: 0.4,     // 互动率
  noise: 1.2,      // 随机扰动
  seen3d: 5,       // 3 天内看过
  seen30d: 1.2,    // 30 天内看过
  exclude: 5,      // 客户端最近刷到过
  disliked: 10,    // 点过「不喜欢」
  dislikedBy: 0.4, // 同一创作者每有一条被「不喜欢」
  dislikedByMax: 1.2
}
const FEED_SHORT_SEC = 300
const FEED_MEDIUM_SEC = 600
const FEED_HALF_LIFE_DAYS = 14
const FEED_ENGAGE_CAP = 0.2     // 互动率到 20% 就算满分
const FEED_DIVERSE_GAP = 0.35   // 去同质：只在分差不超过这么多的候选里换
const FEED_DIVERSE_LOOK = 8     // 去同质：最多往后看几条
const FEED_SEAM = 10            // 新一轮开头避开上一轮末尾的条数
const FEED_TTL_MS = 5 * 60_000
const FEED_CACHE_MAX = 64
const FEED_EXCLUDE_MAX = 100
const DAY_SEC = 86400

/** FNV-1a：字符串 → 32 位整数 */
function hash32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** (seed, id) → [0, 1) 的固定随机数（murmur3 fmix32） */
function noise01(seedHash, id) {
  let h = (seedHash ^ Math.imul(id | 0, 0x9e3779b1)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/*
 * 候选池：全部已上架视频打分要用的几列，放在类型化数组里常驻内存（按 id 升序）。
 * 每条和 seed 无关的那部分分数（热度、新鲜度、互动率、精选、有文件、时长）建池时就算好（base），
 * 换一个新 seed 只要再加上随机扰动、减去这个人的罚分、整体排一次序 —— 不再每次都读一遍 videos 全表、逐行打分。
 * 池子最多用 POOL_TTL_MS（播放数、点赞这些慢慢变的数字晚一分钟生效没关系）；后台任何写操作（上下架、加入短视频、删除…）
 * 之后 invalidateCaches() 立刻作废，新打开的 App（新 seed）马上看得到。
 */
const POOL_TTL_MS = 60_000
let shortPoolCache = null

function shortPool() {
  if (shortPoolCache && shortPoolCache.gen === cacheGen && Date.now() - shortPoolCache.at < POOL_TTL_MS) return shortPoolCache
  const gen = cacheGen
  const now = Math.floor(Date.now() / 1000)
  const rows = all(`SELECT id, topic_id, creator_id, play_count, like_count, fav_count, published_at, duration_sec,
                           (playback_url IS NOT NULL AND playback_url != '') AS playable
                    FROM videos WHERE +status = 1 ORDER BY id`)   // +status：按主键顺序扫表，不走 status 索引再整体排序
  const n = rows.length
  const curated = new Set(all('SELECT video_id FROM short_clips').map(r => r.video_id))
  let maxPlay = 0
  for (const r of rows) if (r.play_count > maxPlay) maxPlay = r.play_count
  const logMax = Math.log1p(maxPlay) || 1
  const P = {
    at: Date.now(), gen, n,
    ids: new Int32Array(n),
    creator: new Int32Array(n),   // 0 = 没有创作者 / 专题（id 都从 1 起）
    topic: new Int32Array(n),
    base: new Float64Array(n),
    pos: new Map()                // 视频 id → 下标
  }
  for (let i = 0; i < n; i++) {
    const r = rows[i]
    const plays = Math.max(0, r.play_count || 0)
    const ageDays = Math.max(0, now - (r.published_at || 0)) / DAY_SEC
    let s = FEED_W.pop * Math.log1p(plays) / logMax
      + FEED_W.fresh * Math.pow(0.5, ageDays / FEED_HALF_LIFE_DAYS)
      + FEED_W.engage * Math.min(1, Math.max(0, (r.like_count || 0) + (r.fav_count || 0)) / (plays + 20) / FEED_ENGAGE_CAP)
    if (curated.has(r.id)) s += FEED_W.curated
    if (r.playable) s += FEED_W.playable
    const len = r.duration_sec || 0
    if (len > 0 && len <= FEED_SHORT_SEC) s += FEED_W.short
    else if (len > 0 && len <= FEED_MEDIUM_SEC) s += FEED_W.medium
    P.ids[i] = r.id
    P.creator[i] = r.creator_id ?? 0
    P.topic[i] = r.topic_id ?? 0
    P.base[i] = s
    P.pos.set(r.id, i)
  }
  shortPoolCache = P
  return P
}

/* 排序键：分数（高的在前）量化到 1e-6 和下标打包进一个 double，交给 Float64Array 的原生数值排序（比带比较函数的排序快一个数量级）。
 * 同分时下标小的在前 = id 小的在前（池子按 id 升序），和原来「分数降序、id 升序」的规则一致。下标要放得下：池子不超过 2^21 条。 */
const KEY_SPAN = 2 ** 21

/** 给整个候选池按 seed 排一次序，返回视频 id（Int32Array）；exclude 是 Set 或 null */
function rankShortFeed(seed, userId, exclude) {
  const P = shortPool()
  const n = P.n
  if (!n) return new Int32Array(0)
  const now = Math.floor(Date.now() / 1000)
  const seedHash = hash32(String(seed))
  const score = new Float64Array(n)
  for (let i = 0; i < n; i++) score[i] = P.base[i] + FEED_W.noise * noise01(seedHash, P.ids[i])

  if (userId) {
    for (const r of all('SELECT video_id, watched_at FROM watch_history WHERE user_id = ? AND watched_at >= ?', userId, now - 30 * DAY_SEC)) {
      const i = P.pos.get(r.video_id)
      if (i !== undefined) score[i] -= now - r.watched_at <= 3 * DAY_SEC ? FEED_W.seen3d : FEED_W.seen30d
    }
    const disliked = new Set()
    const dislikedBy = new Map()     // 创作者 id → 被这个用户「不喜欢」的条数
    for (const r of all('SELECT d.video_id, v.creator_id FROM video_dislikes d JOIN videos v ON v.id = d.video_id WHERE d.user_id = ?', userId)) {
      disliked.add(r.video_id)
      if (r.creator_id != null) dislikedBy.set(r.creator_id, (dislikedBy.get(r.creator_id) || 0) + 1)
    }
    for (const id of disliked) {
      const i = P.pos.get(id)
      if (i !== undefined) score[i] -= FEED_W.disliked
    }
    if (dislikedBy.size) {
      for (let i = 0; i < n; i++) {
        const c = P.creator[i]
        if (c && dislikedBy.has(c) && !disliked.has(P.ids[i])) score[i] -= Math.min(FEED_W.dislikedByMax, FEED_W.dislikedBy * dislikedBy.get(c))
      }
    }
  }
  if (exclude) {
    for (const id of exclude) {
      const i = P.pos.get(id)
      if (i !== undefined) score[i] -= FEED_W.exclude
    }
  }

  const order = new Int32Array(n)
  if (n < KEY_SPAN) {
    const keys = new Float64Array(n)
    for (let i = 0; i < n; i++) keys[i] = Math.round(-score[i] * 1e6) * KEY_SPAN + i
    keys.sort()
    for (let k = 0; k < n; k++) order[k] = keys[k] - Math.floor(keys[k] / KEY_SPAN) * KEY_SPAN
  } else {
    for (let i = 0; i < n; i++) order[i] = i
    order.sort((a, b) => score[b] - score[a] || a - b)
  }

  // 去同质：排在最前的候选和上一条同创作者 / 同专题时，往后几条里找分差不大、又不撞的顶上
  const clash = (a, b) => (P.creator[a] !== 0 && P.creator[a] === P.creator[b]) || (P.topic[a] !== 0 && P.topic[a] === P.topic[b])
  const out = new Int32Array(n)
  const used = new Uint8Array(n)
  let head = 0, prev = -1
  for (let k = 0; k < n; k++) {
    while (used[head]) head++
    let pick = head
    if (prev >= 0 && clash(order[head], prev)) {
      const top = score[order[head]]
      for (let j = head + 1, looked = 0; j < n && looked < FEED_DIVERSE_LOOK; j++) {
        if (used[j]) continue
        looked++
        if (top - score[order[j]] > FEED_DIVERSE_GAP) break
        if (!clash(order[j], prev)) { pick = j; break }
      }
    }
    used[pick] = 1
    prev = order[pick]
    out[k] = P.ids[prev]
  }
  return out
}

/* 排好的顺序：key = 用户|轮次|seed → { ids, at }；Map 的插入顺序就是 LRU 顺序 */
const feedCache = new Map()

function feedCached(key) {
  const hit = feedCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > FEED_TTL_MS) {
    feedCache.delete(key)
    return null
  }
  // 命中：挪到最后并顺延过期时间，还在往下翻的会话不会中途换顺序
  feedCache.delete(key)
  hit.at = Date.now()
  feedCache.set(key, hit)
  return hit.ids
}

/** 第 round 轮（0 起）的完整顺序；exclude 只影响第 0 轮 */
function feedRound(seed, userId, round, exclude) {
  const key = `${userId || 0}|${round}|${seed}`
  const cached = feedCached(key)
  if (cached) return cached
  let ids
  if (round === 0) {
    ids = rankShortFeed(seed, userId, exclude)
  } else {
    ids = rankShortFeed(`${seed}:r${round}`, userId, null)
    // 接缝：上一轮末尾的 k 条挪出这一轮的前 k 条。调整只动开头 2k 条（k ≤ 总数 / 4），
    // 不影响末尾，所以上一轮用缓存的成品还是重新排的原始顺序，末尾都一样，结果是确定的
    const k = Math.min(FEED_SEAM, Math.floor(ids.length / 4))
    if (k > 0) {
      const prev = round === 1
        ? feedRound(seed, userId, 0, exclude)
        : feedCached(`${userId || 0}|${round - 1}|${seed}`) || rankShortFeed(`${seed}:r${round - 1}`, userId, null)
      const tail = new Set(prev.subarray(Math.max(0, prev.length - k)))
      const headIds = Array.from(ids.subarray(0, 2 * k))
      ids.set([...headIds.filter(id => !tail.has(id)), ...headIds.filter(id => tail.has(id))], 0)
    }
  }
  feedCache.set(key, { ids, at: Date.now() })
  while (feedCache.size > FEED_CACHE_MAX) feedCache.delete(feedCache.keys().next().value)
  return ids
}

/** exclude 参数：逗号分隔（或数组）的视频 id，最多 100 个，非法的忽略 */
function parseExclude(v) {
  const out = new Set()
  for (const x of Array.isArray(v) ? v : String(v ?? '').split(',')) {
    if (out.size >= FEED_EXCLUDE_MAX) break
    const id = Number(x)
    if (Number.isSafeInteger(id) && id > 0) out.add(id)
  }
  return out
}

/**
 * 短视频推荐流的一页：{ seed, list, hasMore }。
 * seed 不传就随机生成一个并返回（前端翻页时带回来）；limit 1~50（默认 10）；offset 超过候选池照样有内容。
 * 每条是 Video + { src, like, fav }：src 有素材文件时前端直接播放，没有就用封面 + 模拟进度。
 * 这一页里已下架 / 删除的视频直接跳过（列表可能比 limit 短），前端按 offset + limit 翻下一页。
 */
export function shortFeed({ seed, offset = 0, limit = 10, exclude = null, userId = null } = {}) {
  seed = typeof seed === 'string' && seed.trim() ? seed.trim().slice(0, 64) : Math.random().toString(36).slice(2, 10)
  limit = Math.min(Math.max(1, Math.floor(Number(limit)) || 10), 50)
  offset = Math.min(Math.max(0, Math.floor(Number(offset)) || 0), 1e7)
  const ex = parseExclude(exclude)
  const first = feedRound(seed, userId, 0, ex)
  const n = first.length
  if (!n) return { seed, list: [], hasMore: false }
  const ids = []
  for (let p = offset; p < offset + limit; p++) {
    const round = Math.floor(p / n)
    const ranking = round === 0 ? first : feedRound(seed, userId, round, ex)
    if (p - round * n < ranking.length) ids.push(ranking[p - round * n])
  }
  const uniq = [...new Set(ids)]
  const rows = uniq.length ? all(VIDEOS_BY_IDS, jsonIds(uniq)) : []
  const byId = new Map(rows.map(r => [r.id, r]))
  // 点过「不喜欢」的直接跳过：排序缓存着的这一轮里它还在原位，刚点完不喜欢往下翻也不会再刷到
  if (userId && uniq.length) {
    for (const r of all(`SELECT video_id FROM video_dislikes WHERE user_id = ? AND video_id IN ${IDS}`, userId, jsonIds(uniq))) {
      byId.delete(r.video_id)
    }
  }
  const list = ids.map(id => byId.get(id)).filter(Boolean)
    .map(r => ({ ...toVideo(r), src: r.playback_url || null, like: r.like_count, fav: r.fav_count }))
  return { seed, list, hasMore: true }
}

/* ---------------- 社区 ---------------- */

/** posts.media_kind → 前端 Post.kind：0 图文 / 1 视频 / 2 文档 */
const POST_KINDS = { 0: 'image', 1: 'video', 2: 'doc' }

/*
 * 帖子查询统一从这里取：关联视频只认已上架的（下架 / 草稿的视频点进去是「不存在」页），
 * video_live 为 1 时 toPost 才带 videoId 和时长。
 */
const POST_VIDEO = 'LEFT JOIN videos pv ON pv.id = p.video_id AND pv.status = 1'
const POST_COLS = 'p.*, pv.id IS NOT NULL AS video_live'

export function toPost(r) {
  if (!r) return null
  const live = r.video_id != null && r.video_live !== 0
  return {
    id: r.id,
    // 发布者 id：卡片上的头像 / 名字点进创作者主页（创作者已删除时为 null）
    creatorId: r.creator_id ?? null,
    name: r.author_name,
    handle: r.author_handle,
    verified: !!r.author_verified,
    avatar: toCover(r.avatar_src, r.avatar_fallback),
    text: r.text,
    tags: parseTags(r.tags),
    kind: POST_KINDS[r.media_kind] || 'image',
    // 时长来自关联视频；没关联视频时 v_posts 会算出 00:00，不能当真
    dur: (live && r.dur) || null,
    more: r.more,
    read: r.read,
    fav: r.fav,
    commentCount: r.comment_count,
    videoId: live ? r.video_id : null,
    publishedAt: r.published_at,
    // 由 attachPostState() 回填
    faved: false
  }
}

export function posts(tab = 0, { userId = null, limit = 20, offset = 0 } = {}) {
  let where = '', args = []
  if (tab === 1) where = 'WHERE p.is_hot = 1'                                    // 热门
  else if (tab === 2 || tab === 3) {
    // 关注 / 收藏是「我的」内容：没登录时是空列表，不能退成全部帖子
    if (!userId) return []
    where = tab === 2
      ? 'WHERE p.creator_id IN (SELECT creator_id FROM user_follows WHERE user_id = ?)'   // 关注
      : 'WHERE p.id IN (SELECT post_id FROM post_favs WHERE user_id = ?)'                // 收藏
    args = [userId]
  }
  const rows = all(`SELECT ${POST_COLS} FROM v_posts p ${POST_VIDEO} ${where} ORDER BY p.published_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset)
  return withPostMedia(rows.map(toPost))
}

/** 一个帖子的媒体行 → { main, thumbs, durationSec }；图片 Cover 带小图地址 thumb */
function mediaOf(rows) {
  const main = rows.find(r => r.role === 0)
  return {
    main: main ? withThumb(toCover(main.url, main.fallback)) : null,
    thumbs: rows.filter(r => r.role === 1).map(r => withThumb(toCover(r.url, r.fallback))),
    durationSec: main?.duration_sec ?? null
  }
}

export const postMedia = postId => mediaOf(all('SELECT * FROM v_post_media WHERE post_id = ? ORDER BY role, sort_order', postId))

/** 给一页帖子补上 media：一条查询取完这一页所有帖子的图（以前每个帖子单独查一次） */
function withPostMedia(list) {
  if (!list.length) return list
  const byPost = new Map()
  for (const r of all(`SELECT m.* FROM json_each(?) j CROSS JOIN v_post_media m ON m.post_id = j.value
                       ORDER BY m.post_id, m.role, m.sort_order`, jsonIds(list.map(p => p.id)))) {
    let a = byPost.get(r.post_id)
    if (!a) byPost.set(r.post_id, (a = []))
    a.push(r)
  }
  for (const p of list) p.media = mediaOf(byPost.get(p.id) || [])
  return list
}

/** 秒 → 详情页视频块上的时长：不到 1 小时 mm:ss，否则 h:mm:ss */
export function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const p = n => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h ? `${h}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`
}

/**
 * 帖子详情（只认已发布的帖子，v_posts 已过滤），不存在返回 null。
 *   title = posts.text（社区卡片上的那一句），content = 详情正文
 *   图片：视频帖 + 关联视频已上架 + 有主图 → 主图当视频封面，images 只放配图；
 *         其余情况 images = [主图, ...配图]，视频封面用视频自己的封面
 *   video.frames：视频块左右拼图用的 1～2 张图 = [帖子主图（有的话）, 视频自己的封面]，同一张只留一张；
 *         只有 1 张时 App 照旧显示一整张封面（video.cover）
 *   next：社区「最新」顺序（published_at DESC, id DESC）里的下一篇，也就是更早发布的那一篇
 */
export function postDetail(id, userId = null) {
  const r = get(`SELECT ${POST_COLS}, pp.content FROM v_posts p JOIN posts pp ON pp.id = p.id ${POST_VIDEO}
                 WHERE p.id = ?`, id)
  if (!r) return null
  const kind = POST_KINDS[r.media_kind] || 'image'
  const v = r.video_live ? get('SELECT id, title, cover_src, cover_fallback, len FROM v_videos WHERE id = ?', r.video_id) : null
  const video = v ? { id: v.id, title: v.title, cover: toCover(v.cover_src, v.cover_fallback), dur: clock(v.len), len: v.len, frames: [] } : null
  const media = postMedia(r.id)
  const thumbs = media.thumbs.filter(Boolean)
  // 视频块的拼图：帖子主图（有的话）+ 视频自己的封面，同一张图（src 相同）只留一张 → 1～2 张
  if (video) video.frames = distinctCovers([media.main, video.cover])
  let images
  if (kind === 'video' && video && media.main) {
    video.cover = media.main
    images = thumbs
  } else {
    images = media.main ? [media.main, ...thumbs] : thumbs
  }
  const has = (sql, ...a) => !!(userId && get(sql, userId, ...a))
  return {
    id: r.id,
    title: r.text,
    content: r.content || '',
    kind,
    author: {
      id: r.creator_id ?? null,
      name: r.author_name ?? '',
      handle: r.author_handle ?? '',
      verified: !!r.author_verified,
      avatar: toCover(r.avatar_src, r.avatar_fallback)
    },
    following: r.creator_id != null && has('SELECT 1 x FROM user_follows WHERE user_id = ? AND creator_id = ?', r.creator_id),
    tags: parseTags(r.tags).map(t => String(t).replace(/^[#＃]+/, '')).filter(Boolean),
    images,
    video,
    read: r.read,
    fav: r.fav,
    faved: has('SELECT 1 x FROM post_favs WHERE user_id = ? AND post_id = ?', r.id),
    publishedAt: r.published_at,
    time: relativeTime(r.published_at),
    next: nextPost(r)
  }
}

/** 去掉空的和重复的图（按 src 比；只有占位图的按占位图比），保持原来的顺序 */
function distinctCovers(list) {
  const seen = new Set()
  return list.filter(c => {
    const key = c && (c.src || c.fallback)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 「下一篇」：走 idx_posts_pub(status, published_at DESC)；缩略图取主图，没有就取第一张配图 */
function nextPost(r) {
  const n = get(`SELECT id, text FROM posts
                 WHERE status = 1 AND (published_at < ? OR (published_at = ? AND id < ?))
                 ORDER BY published_at DESC, id DESC LIMIT 1`, r.published_at, r.published_at, r.id)
  if (!n) return null
  const m = get(`SELECT url, fallback FROM post_media WHERE post_id = ? AND (url IS NOT NULL OR fallback IS NOT NULL)
                 ORDER BY role, sort_order, id LIMIT 1`, n.id)
  return { id: n.id, title: n.text, thumb: m ? withThumb(toCover(m.url, m.fallback)) : null }
}

/** 阅读数 +1（只算已发布的帖子），返回新的阅读数；帖子不存在 / 未发布返回 null */
export function addPostView(id) {
  return get('UPDATE posts SET read_count = read_count + 1 WHERE id = ? AND status = 1 RETURNING read_count', id)?.read_count ?? null
}

export const communityTabs = () => ['最新', '热门', '关注', '收藏']
/* on 为 true / false 时设为该状态（重复请求结果不变），不传则切换 */
export const togglePostFav = (userId, postId, on) => toggleRow('post_favs', 'post_id', userId, postId, on)
export const toggleVideoFav = (userId, videoId, on) => toggleRow('video_favs', 'video_id', userId, videoId, on)
export const toggleVideoLike = (userId, videoId, on) => reaction('video_likes', 'video_dislikes', userId, videoId, on)
export const toggleVideoDislike = (userId, videoId, on) => reaction('video_dislikes', 'video_likes', userId, videoId, on)
export const toggleTopicFav = (userId, topicId, on) => toggleRow('topic_favs', 'topic_id', userId, topicId, on)
export const toggleFollow = (userId, creatorId, on) => toggleRow('user_follows', 'creator_id', userId, creatorId, on)

/** 赞 / 不喜欢互斥：点亮一个时在同一事务里清掉另一个，返回两者的最新状态 */
function reaction(table, opposite, userId, videoId, on) {
  return tx(() => {
    const r = toggleRow(table, 'video_id', userId, videoId, on)
    if (r.active) run(`DELETE FROM ${opposite} WHERE user_id = ? AND video_id = ?`, userId, videoId)
    const has = t => !!get(`SELECT 1 x FROM ${t} WHERE user_id = ? AND video_id = ?`, userId, videoId)
    const likeCount = get('SELECT like_count FROM videos WHERE id = ?', videoId)?.like_count ?? 0
    return { ...r, liked: has('video_likes'), disliked: has('video_dislikes'), likeCount }
  })
}

/** 通用点赞/收藏开关：存在则删除，不存在则插入；返回最新状态 */
function toggleRow(table, idColumn, userId, targetId, on) {
  const now = Math.floor(Date.now() / 1000)
  const has = !!get(`SELECT 1 x FROM ${table} WHERE user_id = ? AND ${idColumn} = ?`, userId, targetId)
  const next = typeof on === 'boolean' ? on : !has
  if (next === has) return { active: has }
  if (next) run(`INSERT INTO ${table}(user_id, ${idColumn}, created_at) VALUES(?,?,?)`, userId, targetId, now)
  else run(`DELETE FROM ${table} WHERE user_id = ? AND ${idColumn} = ?`, userId, targetId)
  return { active: next }
}

/* ---------------- 创作者主页 ---------------- */

/** 正常状态（没停用、没删除）的创作者 */
export const creatorActive = id => !!get('SELECT 1 x FROM creators WHERE id = ? AND status = 1', id)
export const creatorFollowers = id => get('SELECT follower_count FROM creators WHERE id = ?', id)?.follower_count ?? null
export const isFollowing = (userId, creatorId) => !!get('SELECT 1 x FROM user_follows WHERE user_id = ? AND creator_id = ?', userId, creatorId)

/**
 * 创作者主页头部；不存在或已停用返回 null。
 * 视频数 / 图集数 / 帖子数 / 最后更新时间只算已发布（上架）的内容（走 idx_videos_creator / idx_albums_creator / idx_posts_creator）。
 */
export function creatorProfile(id, userId = null) {
  const c = get('SELECT * FROM creators WHERE id = ? AND status = 1', id)
  if (!c) return null
  const v = get('SELECT COUNT(*) n, MAX(published_at) t FROM videos WHERE creator_id = ? AND status = 1', id)
  const a = get(`SELECT COUNT(*) n, MAX(a.published_at) t FROM albums a WHERE a.creator_id = ? AND ${ALBUM_LIVE}`, id)
  const p = get('SELECT COUNT(*) n, MAX(published_at) t FROM posts WHERE creator_id = ? AND status = 1', id)
  const lastActiveAt = Math.max(v.t ?? 0, a.t ?? 0, p.t ?? 0) || null
  return {
    id: c.id,
    name: c.name,
    handle: c.handle,
    avatar: toCover(c.avatar_url, c.avatar_fallback),
    verified: !!c.is_verified,
    official: !!c.is_official,
    bio: c.bio || '',
    followers: c.follower_count,
    videoCount: v.n,
    // 「图片」标签的条数（已上架、至少有一张图的图集），和 creatorAlbums().total 同一个口径
    albumCount: a.n,
    postCount: p.n,
    // 「媒体」标签的条数，和 creatorMedia().total 同一个口径
    mediaCount: creatorMediaCount(id),
    lastActiveAt,
    lastActive: relativeTime(lastActiveAt),
    following: !!userId && isFollowing(userId, id),
    banner: creatorBanner(id)
  }
}

/*
 * 主页头图：最近的作品图，新的在前，最多 3 张。
 * 视频取封面；帖子取主图，没有主图的图文 / 视频帖取第一张配图（文档帖的配图是文档页，不要）；图集取封面（第一张图）。
 * 三边各先按发布时间取 3 条再合并，创作者作品很多时也不用整表排序。
 */
const BANNER_SIZE = 3
function creatorBanner(id) {
  return all(`SELECT src, fallback FROM (
                SELECT * FROM (SELECT cover_url AS src, cover_fallback AS fallback, published_at AS t, 0 AS k, id AS i FROM videos
                               WHERE creator_id = ? AND status = 1 AND (cover_url IS NOT NULL OR cover_fallback IS NOT NULL)
                               ORDER BY published_at DESC, id DESC LIMIT ${BANNER_SIZE})
                UNION ALL
                SELECT * FROM (SELECT m.url AS src, m.fallback AS fallback, p.published_at AS t, 1 AS k, p.id AS i FROM posts p
                               JOIN post_media m ON m.id = (SELECT id FROM post_media
                                                            WHERE post_id = p.id AND (url IS NOT NULL OR fallback IS NOT NULL)
                                                              AND (role = 0 OR p.media_kind != 2)
                                                            ORDER BY role, sort_order, id LIMIT 1)
                               WHERE p.creator_id = ? AND p.status = 1
                               ORDER BY p.published_at DESC, p.id DESC LIMIT ${BANNER_SIZE})
                UNION ALL
                SELECT * FROM (SELECT ai.url AS src, NULL AS fallback, a.published_at AS t, 2 AS k, a.id AS i FROM albums a
                               JOIN album_images ai ON ai.id = (SELECT id FROM album_images WHERE album_id = a.id ORDER BY sort, id LIMIT 1)
                               WHERE a.creator_id = ? AND a.status = 1
                               ORDER BY a.published_at DESC, a.id DESC LIMIT ${BANNER_SIZE})
              ) ORDER BY t DESC, k, i DESC LIMIT ${BANNER_SIZE}`, id, id, id).map(r => withThumb(toCover(r.src, r.fallback)))
}

/** 主页「视频」：sort 0 最新（发布时间）/ 1 最热（播放量）；同值再按 id 定序，翻页不重复也不遗漏 */
const CREATOR_VIDEO_ORDER = ['published_at DESC, id DESC', 'play_count DESC, published_at DESC, id DESC']
export function creatorVideos(id, sort = 0, { limit = 20, offset = 0 } = {}) {
  const total = get('SELECT COUNT(*) c FROM videos WHERE creator_id = ? AND status = 1', id).c
  const list = all(`SELECT * FROM v_videos WHERE creator_id = ? ORDER BY ${CREATOR_VIDEO_ORDER[sort] || CREATOR_VIDEO_ORDER[0]} LIMIT ? OFFSET ?`,
    id, limit, offset).map(toVideo)
  return { total, list }
}

/** 主页「帖子」：和社区列表同一结构，按发布时间倒序 */
export function creatorPosts(id, { limit = 20, offset = 0 } = {}) {
  const total = get('SELECT COUNT(*) c FROM posts WHERE creator_id = ? AND status = 1', id).c
  const rows = all(`SELECT ${POST_COLS} FROM v_posts p ${POST_VIDEO} WHERE p.creator_id = ?
                    ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?`, id, limit, offset)
  return { total, list: withPostMedia(rows.map(toPost)) }
}

/*
 * 主页「媒体」：他发过的所有图拼成的照片墙 —— 已发布视频的封面 + 已发布帖子的图（主图和配图）+ 已上架图集的每一张图。
 *   - 帖子的图只要真有图片地址的（只有生成占位图的不算）；文档帖的配图是文档页（media_type 2），不要；
 *   - 和他某条已发布视频的封面是同一张的帖子图不再单独出现（视频帖常拿视频封面当主图，墙上已经有那条视频了）；
 *   - 图集的图全部都算（后台单独上传的，不和视频封面去重）；
 *   - 草稿 / 下架的视频、帖子、图集都不算。
 * 三个参数都是创作者 id（视频、帖子、图集各一个）。
 * 去重的 NOT EXISTS 按封面地址查（idx_videos_cover），creator_id / status 前面的一元 + 让它们不参与选索引：
 * 否则 SQLite 会改走创作者索引，作品几千条的创作者每张帖子图都要把他的视频扫一遍（计数从 0.2 秒变成几十秒）。
 * 列：k 0 视频 / 1 帖子图 / 2 图集的图，owner 视频、帖子或图集的 id，role 0 主图 / 1 配图（图集为 0），
 *     so 配图顺序 / 图在图集里的下标（0 起，按 sort、id 数），mid post_media.id / album_images.id。
 */
const MEDIA_VIDEOS = 'FROM videos v WHERE v.creator_id = ? AND v.status = 1'
const MEDIA_POSTS = `FROM posts p JOIN post_media m ON m.post_id = p.id
   WHERE p.creator_id = ? AND p.status = 1
     AND m.url IS NOT NULL AND m.media_type != 2 AND (m.role = 0 OR p.media_kind != 2)
     AND NOT EXISTS (SELECT 1 FROM videos cv WHERE cv.cover_url = m.url AND +cv.creator_id = p.creator_id AND +cv.status = 1)`
const MEDIA_ALBUMS = 'FROM albums a JOIN album_images ai ON ai.album_id = a.id WHERE a.creator_id = ? AND a.status = 1'
const CREATOR_MEDIA = `
  SELECT 0 AS k, v.id AS owner, NULL AS mid, v.title AS title, v.cover_url AS src, v.cover_fallback AS fallback,
         v.duration_sec AS len, v.published_at AS t, 0 AS role, 0 AS so
    ${MEDIA_VIDEOS}
  UNION ALL
  SELECT 1, p.id, m.id, p.text, m.url, m.fallback, NULL, p.published_at, m.role, m.sort_order
    ${MEDIA_POSTS}
  UNION ALL
  SELECT 2, a.id, ai.id, a.title, ai.url, NULL, NULL, a.published_at, 0,
         ROW_NUMBER() OVER (PARTITION BY ai.album_id ORDER BY ai.sort, ai.id) - 1
    ${MEDIA_ALBUMS}`
/*
 * 照片墙的格数（主页头部的 mediaCount 和 /media 的 total）：三边分别计数再相加，和 CREATOR_MEDIA 的行数一样，
 * 但不用把几千条作品的整行（标题、封面…）先拼出来再数 —— 视频那边只数覆盖索引 idx_videos_creator_pub。
 */
const creatorMediaCount = id =>
  get(`SELECT (SELECT COUNT(*) ${MEDIA_VIDEOS}) + (SELECT COUNT(*) ${MEDIA_POSTS}) + (SELECT COUNT(*) ${MEDIA_ALBUMS}) AS c`, id, id, id).c

/*
 * 顺序：发布时间倒序；同一时间视频在前、帖子的图其次、图集的图最后，再按视频 / 帖子 / 图集 id 倒序；
 * 同一帖子里主图在前、配图按顺序，同一图集按图的顺序。这是全序（最后落到 post_media.id / album_images.id），翻页不重复也不遗漏。
 * 每格都带 postId / videoId / albumId / albumIndex（不是这一类的为 null），App 据此决定点开后去哪。
 */
export function creatorMedia(id, { limit = 20, offset = 0 } = {}) {
  const total = creatorMediaCount(id)
  const rows = all(`SELECT * FROM (${CREATOR_MEDIA}) ORDER BY t DESC, k, owner DESC, role, so, mid LIMIT ? OFFSET ?`, id, id, id, limit, offset)
  const cell = (r, kind, extra) => ({
    id: '', kind, cover: withThumb(toCover(r.src, r.fallback)), title: r.title,
    postId: null, videoId: null, albumId: null, albumIndex: null, dur: null, publishedAt: r.t, ...extra
  })
  return {
    total,
    list: rows.map(r => r.k === 0
      ? cell(r, 'video', { id: 'v' + r.owner, videoId: r.owner, dur: r.len > 0 ? clock(r.len) : null })
      : r.k === 1
        ? cell(r, 'image', { id: 'i' + r.mid, postId: r.owner })
        : cell(r, 'image', { id: 'a' + r.mid, albumId: r.owner, albumIndex: r.so }))
  }
}

/* ---------------- 图集（创作者主页「图片」、图集详情） ---------------- */

/** 前台能看到的图集：已上架，并且至少有一张图（创作者是否正常由调用方把关） */
const ALBUM_LIVE = 'a.status = 1 AND EXISTS (SELECT 1 FROM album_images ai WHERE ai.album_id = a.id)'

/** 图集里的一张图 → { url, width, height, thumb }（宽高 0 = 不知道，App 按默认比例占位；thumb 是网格用的小图地址） */
const toAlbumImage = r => ({ url: r.url, width: r.width || 0, height: r.height || 0, thumb: thumbOf(r.url) })

/**
 * 主页「图片」：已上架的图集，新的在前（同一时间 id 大的在前，翻页不重复也不遗漏）。
 * 每条 { id, title, cover: { url, width, height }, count, publishedAt, time }，cover 是第一张图，count 是图的张数。
 */
export function creatorAlbums(id, { limit = 20, offset = 0 } = {}) {
  const total = get(`SELECT COUNT(*) c FROM albums a WHERE a.creator_id = ? AND ${ALBUM_LIVE}`, id).c
  const rows = all(`SELECT a.id, a.title, a.published_at, ci.url, ci.width, ci.height,
                           (SELECT COUNT(*) FROM album_images n WHERE n.album_id = a.id) AS n
                    FROM albums a
                    JOIN album_images ci ON ci.id = (SELECT id FROM album_images WHERE album_id = a.id ORDER BY sort, id LIMIT 1)
                    WHERE a.creator_id = ? AND a.status = 1
                    ORDER BY a.published_at DESC, a.id DESC LIMIT ? OFFSET ?`, id, limit, offset)
  return {
    total,
    list: rows.map(r => ({
      id: r.id, title: r.title, cover: toAlbumImage(r), count: r.n, publishedAt: r.published_at, time: relativeTime(r.published_at)
    }))
  }
}

/**
 * 图集详情：只认已上架、至少有一张图、创作者正常的图集，否则返回 null。
 * creator 和帖子详情的 author 同结构；following 是当前用户有没有关注他（未登录 false）。
 */
export function albumDetail(id, userId = null) {
  const r = get(`SELECT a.*, c.name AS creator_name, c.handle AS creator_handle, c.is_verified AS creator_verified,
                        c.avatar_url AS creator_avatar_url, c.avatar_fallback AS creator_avatar_fallback
                 FROM albums a JOIN creators c ON c.id = a.creator_id AND c.status = 1
                 WHERE a.id = ? AND a.status = 1`, id)
  if (!r) return null
  const images = all('SELECT url, width, height FROM album_images WHERE album_id = ? ORDER BY sort, id', id).map(toAlbumImage)
  if (!images.length) return null
  return {
    id: r.id,
    title: r.title,
    description: r.description || '',
    tags: parseTags(r.tags).map(t => String(t).replace(/^[#＃]+/, '')).filter(Boolean),
    creator: {
      id: r.creator_id,
      name: r.creator_name,
      handle: r.creator_handle,
      verified: !!r.creator_verified,
      avatar: toCover(r.creator_avatar_url, r.creator_avatar_fallback)
    },
    following: !!userId && isFollowing(userId, r.creator_id),
    images,
    count: images.length,
    publishedAt: r.published_at,
    time: relativeTime(r.published_at)
  }
}

/* ---------------- 直播 / 同城 ---------------- */

export const liveTabs = () => ['推荐', '附近', '才艺', '聊天', '户外']
export const lives = ({ tab = 0, limit = 20, offset = 0 } = {}) => {
  const label = liveTabs()[tab]
  // 直播 tab 1(附近)/2(才艺)/3(聊天)/4(户外) 按 category 过滤；0(推荐) 取全部
  const rows = tab > 1
    ? all('SELECT * FROM v_lives WHERE category = ? ORDER BY viewers DESC LIMIT ? OFFSET ?', label, limit, offset)
    : all('SELECT * FROM v_lives ORDER BY viewers DESC LIMIT ? OFFSET ?', limit, offset)
  return rows.map(r => ({
    id: r.id, title: r.title, sub: r.sub, viewers: r.viewers_text,
    live: r.status === 1, cover: toCover(r.cover_url, r.cover_fallback),
    creator: { id: r.creator_id, name: r.creator_name, handle: r.creator_handle }
  }))
}

export const nearbyFilters = () => all('SELECT label, category, sort_key FROM nearby_filters ORDER BY sort_order')
export const nearby = ({ filter = 0, city = null, limit = 20, offset = 0 } = {}) => {
  const f = get('SELECT * FROM nearby_filters ORDER BY sort_order LIMIT 1 OFFSET ?', filter)
  const where = ['WHERE status = 1'], args = []
  if (city) { where.push('city = ?'); args.push(city) }
  if (f?.category) { where.push('category = ?'); args.push(f.category) }
  const order = f?.sort_key === 'published_at' ? 'created_at' : 'distance_km'
  const rows = all(`SELECT * FROM v_places ${where.join(' AND ')} ORDER BY ${order} ASC LIMIT ? OFFSET ?`, ...args, limit, offset)
  return rows.map(r => ({
    id: r.id, title: r.name, tags: all('SELECT tag FROM v_place_tags WHERE place_id = ? ORDER BY sort_order', r.id).map(t => t.tag),
    distance: r.distance, price: r.price, cover: toCover(r.cover_url, r.cover_fallback),
    category: r.category, rating: r.rating
  }))
}

/* ---------------- 用户侧 ---------------- */

export const userProfile = userId => get('SELECT * FROM v_users WHERE id = ?', userId)

/* ---------------- 鉴权相关（原始行，含口令哈希，只在服务端用） ---------------- */

/** 按登录名取用户，含 password_hash（不要直接返回给前端） */
export const userByUid = uid => get('SELECT * FROM users WHERE uid = ?', uid)

export const userById = id => get('SELECT * FROM users WHERE id = ?', id)

export const createUser = ({ uid, nickname, passwordHash = null, role = 'user', avatar }) => {
  const t = Math.floor(Date.now() / 1000)
  const id = Number(run(`INSERT INTO users(uid, nickname, password_hash, role, avatar_url, avatar_fallback, created_at)
                         VALUES(?,?,?,?,?,?,?)`,
    uid, nickname, passwordHash, role, avatar?.src ?? null, avatar?.fallback ?? null, t).lastInsertRowid)
  run('INSERT INTO user_stats(user_id, updated_at) VALUES(?,?)', id, t)
  return id
}

export const setUserPassword = (id, passwordHash) =>
  run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, id)

export const setUserStatus = (id, status) =>
  run('UPDATE users SET status = ? WHERE id = ?', status, id)

export const setUserRole = (id, role) =>
  run('UPDATE users SET role = ? WHERE id = ?', role, id)

export const listUsers = () => all(`SELECT id, uid, nickname, role, status, last_login_at, created_at
                                    FROM users ORDER BY role = 'admin' DESC, id`)

export const countAdmins = () => get("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND status = 1").c

/* ---------------- 我的：观看历史 / 收藏 / 关注（只算已上架的内容，总数和 v_users 的计数一致） ---------------- */

/** 观看历史一页：Video + { progressSec, watchedAt }，最近看的在前 → { total, list } */
export function watchHistory(userId, { limit = 20, offset = 0 } = {}) {
  const total = get('SELECT COUNT(*) c FROM watch_history h JOIN videos v ON v.id = h.video_id AND v.status = 1 WHERE h.user_id = ?', userId).c
  const list = all('SELECT * FROM v_watch_history WHERE user_id = ? ORDER BY watched_at DESC, id DESC LIMIT ? OFFSET ?', userId, limit, offset)
    .map(r => ({ ...toVideo(r), progressSec: Math.max(0, Math.floor(r.progress_sec || 0)), watchedAt: r.watched_at }))
  return { total, list }
}

/** 删一条观看记录（videoId 为 null = 清空），返回删掉的条数 */
export function removeWatchHistory(userId, videoId = null) {
  return Number(videoId == null
    ? run('DELETE FROM watch_history WHERE user_id = ?', userId).changes
    : run('DELETE FROM watch_history WHERE user_id = ? AND video_id = ?', userId, videoId).changes)
}

/** 我收藏的视频：Video + favedAt，最近收藏的在前 */
export function favVideos(userId, { limit = 20, offset = 0 } = {}) {
  const total = get('SELECT COUNT(*) c FROM video_favs f JOIN videos v ON v.id = f.video_id AND v.status = 1 WHERE f.user_id = ?', userId).c
  const list = all(`SELECT v.*, f.created_at AS faved_at FROM video_favs f JOIN v_videos v ON v.id = f.video_id
                    WHERE f.user_id = ? ORDER BY f.created_at DESC, f.video_id DESC LIMIT ? OFFSET ?`, userId, limit, offset)
    .map(r => ({ ...toVideo(r), favedAt: r.faved_at }))
  return { total, list }
}

/** 我收藏的帖子：和社区列表同结构（带 media）+ favedAt */
export function favPosts(userId, { limit = 20, offset = 0 } = {}) {
  const total = get('SELECT COUNT(*) c FROM post_favs f JOIN posts p ON p.id = f.post_id AND p.status = 1 WHERE f.user_id = ?', userId).c
  const rows = all(`SELECT ${POST_COLS}, f.created_at AS faved_at FROM post_favs f JOIN v_posts p ON p.id = f.post_id ${POST_VIDEO}
                    WHERE f.user_id = ? ORDER BY f.created_at DESC, f.post_id DESC LIMIT ? OFFSET ?`, userId, limit, offset)
  const list = withPostMedia(rows.map(toPost))
  rows.forEach((r, i) => { list[i].favedAt = r.faved_at })
  return { total, list }
}

/** 我收藏的专题：片库卡片 { id, name, count, cover } + favedAt */
export function favTopics(userId, { limit = 20, offset = 0 } = {}) {
  const total = get('SELECT COUNT(*) c FROM topic_favs f JOIN topics t ON t.id = f.topic_id AND t.status = 1 WHERE f.user_id = ?', userId).c
  const rows = all(`SELECT t.id, t.name, t.video_count AS count, f.created_at AS favedAt FROM topic_favs f JOIN v_topics t ON t.id = f.topic_id
                    WHERE f.user_id = ? ORDER BY f.created_at DESC, f.topic_id DESC LIMIT ? OFFSET ?`, userId, limit, offset)
  return { total, list: topicCards(rows) }
}

/** 我关注的创作者（只算正常状态的），最近关注的在前 */
export function followedCreators(userId, { limit = 20, offset = 0 } = {}) {
  const total = get('SELECT COUNT(*) c FROM user_follows f JOIN creators c ON c.id = f.creator_id AND c.status = 1 WHERE f.user_id = ?', userId).c
  const list = all(`SELECT c.*, f.created_at AS followed_at FROM user_follows f JOIN creators c ON c.id = f.creator_id AND c.status = 1
                    WHERE f.user_id = ? ORDER BY f.created_at DESC, f.creator_id DESC LIMIT ? OFFSET ?`, userId, limit, offset)
    .map(c => ({
      id: c.id,
      name: c.name,
      handle: c.handle,
      avatar: toCover(c.avatar_url, c.avatar_fallback),
      verified: !!c.is_verified,
      bio: c.bio || '',
      followers: c.follower_count,
      followedAt: c.followed_at,
      following: true
    }))
  return { total, list }
}

export const videoExists = videoId => !!get('SELECT 1 x FROM videos WHERE id = ?', videoId)

/**
 * 记观看。countPlay=false 时只更新观看进度，不计播放数（播放页离开 / 切后台时的进度上报用）。
 * 开始播放时的那次上报（countPlay 且进度为 0）不覆盖已存的进度：否则重新打开视频、还没来得及上报就被杀掉，
 * 上次看到的位置就丢了。
 */
export function addWatchHistory(userId, videoId, progressSec = 0, { countPlay = true } = {}) {
  const now = Math.floor(Date.now() / 1000)
  if (!videoExists(videoId)) throw new Error(`视频不存在: ${videoId}`)
  const sec = Math.max(0, Math.floor(Number(progressSec) || 0))
  const keep = countPlay && sec === 0
  run(`INSERT INTO watch_history(user_id, video_id, progress_sec, watched_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id, video_id) DO UPDATE SET ${keep ? '' : 'progress_sec = excluded.progress_sec, '}watched_at = excluded.watched_at`,
    userId, videoId, sec, now)
  if (countPlay) run('UPDATE videos SET play_count = play_count + 1 WHERE id = ?', videoId)
  return { added: true, videoId, progressSec: sec }
}

export const searchUsers = q => all('SELECT id, uid, nickname AS name FROM v_users WHERE nickname LIKE ? OR uid = ? LIMIT 20', `%${q}%`, q)

/**
 * 内存里的短缓存（热门搜索词、短视频候选池）立刻作废。
 * server/index.mjs 在每个后台写操作之后调一次：上下架、改热词、加入短视频……前台马上看得到。
 */
export function invalidateCaches() {
  cacheGen++
  hotCache = null
  shortPoolCache = null
}

/** 占位图原文（GET /api/art/<hash>.svg）；没有这张图返回 null */
export const artSvg = hash => get('SELECT svg FROM art_blobs WHERE hash = ?', hash)?.svg ?? null
