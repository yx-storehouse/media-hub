/*
 * 数据库连接与查询封装。
 *
 * 全站只有这一个地方直接碰 SQL；server/api.mjs 里每个接口函数都对应下面一个查询方法，
 * 方法名与前端 src/api/index.js 的函数一一对应，返回值也保持同样结构。
 */
import { DatabaseSync } from 'node:sqlite'
import { cover as coverArt } from '../lib/art.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || join(here, 'reel.db')

export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA journal_mode = WAL')

const all = (sql, ...args) => db.prepare(sql).all(...args)
const get = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

/**
 * 在一个事务里执行 fn，出错整体回滚。
 * 已经处在事务里时（如管理后台批量导入的外层事务）改用 SAVEPOINT，只回滚这一段。
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
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/* 相似推荐用的覆盖索引；老库启动时补建（新库由 schema.sql 建，建库前表还不存在就跳过） */
if (get("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'videos'")) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_related ON videos(status, topic_id, category_key, play_count DESC)')
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
    publishedAt: r.published_at
  }
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
  const ids = list.map(v => v.id)
  const marks = (table, field) => {
    const ph = ids.map(() => '?').join(',')
    const rows = all(`SELECT video_id FROM ${table} WHERE user_id = ? AND video_id IN (${ph})`, userId, ...ids)
    return new Set(rows.map(r => r.video_id))
  }
  const liked = marks('video_likes', 'liked')
  const faved = marks('video_favs', 'faved')
  for (const v of list) {
    v.liked = liked.has(v.id)
    v.faved = faved.has(v.id)
  }
  return list
}

export function attachPostState(list, userId) {
  if (!userId || !list.length) return list
  const ids = list.map(p => p.id)
  const ph = ids.map(() => '?').join(',')
  const rows = all(`SELECT post_id FROM post_favs WHERE user_id = ? AND post_id IN (${ph})`, userId, ...ids)
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

/** 「最新」页的日期与地区筛选（计数实时统计，不写死） */
export function latestFilters(now = Math.floor(Date.now() / 1000)) {
  const dates = []
  for (let i = 0; i < 7; i++) {
    const start = localDayStart(now, i)
    const end = localDayStart(now, i - 1)
    const count = get(`SELECT COUNT(*) c FROM videos WHERE status=1 AND published_at >= ? AND published_at < ?`, start, end).c
    const d = new Date(start * 1000)
    dates.push({ label: i === 0 ? '今天' : i === 1 ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`, count })
  }
  const regions = all('SELECT code, label FROM regions ORDER BY sort_order').map(r => {
    const [where, args] = regionWhere(r.code)
    return { ...r, count: get(`SELECT COUNT(*) c FROM videos v WHERE v.status = 1 AND ${where}`, ...args).c }
  })
  return { dates, regions }
}

/** 「最新」页某天 + 某地区的视频（date：0 = 今天，按服务器本地日期分天） */
export function latestVideos({ date = 0, region = 0, limit = 20, offset = 0 } = {}, now = Math.floor(Date.now() / 1000)) {
  const start = localDayStart(now, date)
  const end = localDayStart(now, date - 1)
  const regionCode = get('SELECT code FROM regions ORDER BY sort_order LIMIT 1 OFFSET ?', region)?.code
  const [where, args] = regionCode ? regionWhere(regionCode) : ['1', []]
  return all(`SELECT * FROM v_videos v WHERE v.published_at >= ? AND v.published_at < ? AND ${where}
              ORDER BY v.published_at DESC LIMIT ? OFFSET ?`, start, end, ...args, limit, offset).map(toVideo)
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

/** 热门搜索词（换一批 = 换一页） */
export const hotWords = (page = 0, size = 8) =>
  all(`SELECT word, is_hot AS hot FROM search_keywords WHERE is_banned = 0
       ORDER BY weight DESC, sort_order LIMIT ? OFFSET ?`, size, page * size)

/** 热门创作者 */
export const creators = (limit = 5) =>
  all(`SELECT id, handle, name, avatar_url, avatar_fallback, is_verified AS verified, follower_count
       FROM creators WHERE status = 1 ORDER BY is_official DESC, follower_count DESC LIMIT ?`, limit)

/** 某用户的近期搜索（带视频卡片） */
export const searchHistory = (userId, { limit = 5, offset = 0 } = {}) =>
  all(`SELECT * FROM v_search_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    userId, limit, offset).map(toVideo)

export const searchHistoryCount = userId =>
  get('SELECT COUNT(*) c FROM search_history WHERE user_id = ?', userId).c

export function addSearchHistory(userId, keyword, videoId = null) {
  const now = Math.floor(Date.now() / 1000)
  run('DELETE FROM search_history WHERE user_id = ? AND keyword = ?', userId, keyword)
  run('INSERT INTO search_history(user_id, keyword, video_id, created_at) VALUES(?,?,?,?)', userId, keyword, videoId, now)
  run(`DELETE FROM search_history WHERE user_id = ? AND id NOT IN
       (SELECT id FROM search_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50)`, userId, userId)
}

/**
 * 视频搜索。中文用 FTS5 trigram 分词（支持子串匹配），
 * 但 trigram 至少要 3 个字，1~2 个字的短词退回 LIKE。
 */
export function searchVideos(q, { limit = 20, offset = 0 } = {}) {
  const kw = String(q || '').trim()
  if (!kw) return { total: 0, list: [] }
  if ([...kw].length >= 3) {
    const phrase = '"' + kw.replace(/"/g, '""') + '"'
    const total = get(`SELECT COUNT(*) c FROM videos_fts f JOIN videos v ON v.id = f.rowid
                       WHERE videos_fts MATCH ? AND v.status = 1`, phrase).c
    const list = all(`SELECT v.* FROM videos_fts f JOIN v_videos v ON v.id = f.rowid
                      WHERE videos_fts MATCH ? ORDER BY f.rank LIMIT ? OFFSET ?`, phrase, limit, offset).map(toVideo)
    return { total, list }
  }
  const like = `%${kw}%`
  const total = get('SELECT COUNT(*) c FROM videos WHERE status = 1 AND (title LIKE ? OR tags LIKE ?)', like, like).c
  const list = all('SELECT * FROM v_videos WHERE title LIKE ? OR tags LIKE ? ORDER BY published_at DESC LIMIT ? OFFSET ?',
    like, like, limit, offset).map(toVideo)
  return { total, list }
}

/** 社区搜索（帖子） */
export function searchPosts(q, { limit = 20, offset = 0 } = {}) {
  const kw = String(q || '').trim()
  if (!kw) return []
  const rows = [...kw].length >= 3
    ? all(`SELECT ${POST_COLS} FROM posts_fts f JOIN v_posts p ON p.id = f.rowid ${POST_VIDEO}
           WHERE posts_fts MATCH ? ORDER BY f.rank LIMIT ? OFFSET ?`,
        '"' + kw.replace(/"/g, '""') + '"', limit, offset)
    : all(`SELECT ${POST_COLS} FROM v_posts p ${POST_VIDEO} WHERE p.text LIKE ? OR p.tags LIKE ? LIMIT ? OFFSET ?`,
        `%${kw}%`, `%${kw}%`, limit, offset)
  return rows.map(toPost)
}

/* ---------------- 专题 ---------------- */

export const topic = id => get('SELECT * FROM v_topics WHERE id = ?', id)
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
  const topics = all('SELECT id, name, video_count AS count FROM v_topics WHERE kind = 2 ORDER BY sort_order, id')
  const first = new Map()
  for (const c of all('SELECT topic_id, url, fallback FROM v_topic_covers WHERE url IS NOT NULL OR fallback IS NOT NULL ORDER BY topic_id, sort_order')) {
    if (!first.has(c.topic_id)) first.set(c.topic_id, c)
  }
  return topics.map(t => {
    const art = coverArt('cat' + t.id, { kind: t.id % 6 })
    const c = first.get(t.id)
    const cover = c ? { src: c.url || null, fallback: c.fallback || art.fallback } : { src: art.src, fallback: art.fallback }
    return { id: t.id, name: t.name, count: t.count, cover }
  })
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

/**
 * 相似推荐：同专题优先，其次同分类，再按播放量排序。
 * batch 是「换一批」的序号；翻到末尾后从头接上，保证每批都是满的。
 */
export function relatedVideos(id, { batch = 0, limit = 6 } = {}) {
  const self = get('SELECT topic_id, category_key FROM videos WHERE id = ?', id)
  if (!self) return []
  // 只在基表上按 idx_videos_related 挑出 id，再取整行；空的专题 / 分类不参与匹配
  const where = 'status = 1 AND id != ? AND (topic_id = ? OR category_key = ?)'
  const args = [id, self.topic_id, self.category_key]
  const total = get(`SELECT COUNT(*) c FROM videos WHERE ${where}`, ...args).c
  if (!total) return []
  const page = (offset, n) => {
    const ids = all(
      `SELECT id FROM videos WHERE ${where} ORDER BY (topic_id = ?) DESC, play_count DESC, id LIMIT ? OFFSET ?`,
      ...args, self.topic_id, n, offset
    ).map(r => r.id)
    if (!ids.length) return []
    const rows = all(`SELECT * FROM v_videos WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    const byId = new Map(rows.map(r => [r.id, r]))
    return ids.map(i => byId.get(i)).filter(Boolean).map(toVideo)
  }
  const n = Math.min(limit, total)
  const offset = (batch * n) % total
  const list = page(offset, n)
  if (list.length < n) list.push(...page(0, n - list.length))
  return list
}

/* ---------------- 短视频 ---------------- */

/**
 * 短视频流，按 sort_order 排（管理后台新加的排在最后），前端滑到末尾时用 offset 翻页。
 * src：有素材文件（playback_url）时前端直接播放，没有就用封面 + 模拟进度。
 */
export function shorts({ limit = 20, offset = 0 } = {}) {
  limit = Math.min(Math.max(1, Number(limit) || 20), 100)
  offset = Math.max(0, Number(offset) || 0)
  return all(`SELECT s.sort_order, v.* FROM short_clips s JOIN v_videos v ON v.id = s.video_id
              ORDER BY s.sort_order, s.video_id LIMIT ? OFFSET ?`, limit, offset)
    .map(r => ({ ...toVideo(r), src: r.playback_url || null, like: r.like_count, fav: r.fav_count }))
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
  else if (tab === 2 && userId) {                                               // 关注
    where = 'WHERE p.creator_id IN (SELECT creator_id FROM user_follows WHERE user_id = ?)'
    args = [userId]
  } else if (tab === 3 && userId) {                                             // 收藏
    where = 'WHERE p.id IN (SELECT post_id FROM post_favs WHERE user_id = ?)'
    args = [userId]
  }
  const rows = all(`SELECT ${POST_COLS} FROM v_posts p ${POST_VIDEO} ${where} ORDER BY p.published_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset)
  return rows.map(r => ({ ...toPost(r), media: postMedia(r.id) }))
}

export function postMedia(postId) {
  const rows = all('SELECT * FROM v_post_media WHERE post_id = ? ORDER BY role, sort_order', postId)
  const main = rows.find(r => r.role === 0)
  return {
    main: main ? toCover(main.url, main.fallback) : null,
    thumbs: rows.filter(r => r.role === 1).map(r => toCover(r.url, r.fallback)),
    durationSec: main?.duration_sec ?? null
  }
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
 *   next：社区「最新」顺序（published_at DESC, id DESC）里的下一篇，也就是更早发布的那一篇
 */
export function postDetail(id, userId = null) {
  const r = get(`SELECT ${POST_COLS}, pp.content FROM v_posts p JOIN posts pp ON pp.id = p.id ${POST_VIDEO}
                 WHERE p.id = ?`, id)
  if (!r) return null
  const kind = POST_KINDS[r.media_kind] || 'image'
  const v = r.video_live ? get('SELECT id, title, cover_src, cover_fallback, len FROM v_videos WHERE id = ?', r.video_id) : null
  const video = v ? { id: v.id, title: v.title, cover: toCover(v.cover_src, v.cover_fallback), dur: clock(v.len), len: v.len } : null
  const media = postMedia(r.id)
  const thumbs = media.thumbs.filter(Boolean)
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

/** 「下一篇」：走 idx_posts_pub(status, published_at DESC)；缩略图取主图，没有就取第一张配图 */
function nextPost(r) {
  const n = get(`SELECT id, text FROM posts
                 WHERE status = 1 AND (published_at < ? OR (published_at = ? AND id < ?))
                 ORDER BY published_at DESC, id DESC LIMIT 1`, r.published_at, r.published_at, r.id)
  if (!n) return null
  const m = get(`SELECT url, fallback FROM post_media WHERE post_id = ? AND (url IS NOT NULL OR fallback IS NOT NULL)
                 ORDER BY role, sort_order, id LIMIT 1`, n.id)
  return { id: n.id, title: n.text, thumb: m ? toCover(m.url, m.fallback) : null }
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

export const watchHistory = (userId, { limit = 20, offset = 0 } = {}) =>
  all('SELECT * FROM v_watch_history WHERE user_id = ? ORDER BY watched_at DESC LIMIT ? OFFSET ?', userId, limit, offset).map(toVideo)

export const videoExists = videoId => !!get('SELECT 1 x FROM videos WHERE id = ?', videoId)

/** countPlay=false 时只更新观看进度，不计播放数（播放页离开时的进度上报用） */
export function addWatchHistory(userId, videoId, progressSec = 0, { countPlay = true } = {}) {
  const now = Math.floor(Date.now() / 1000)
  if (!videoExists(videoId)) throw new Error(`视频不存在: ${videoId}`)
  run(`INSERT INTO watch_history(user_id, video_id, progress_sec, watched_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id, video_id) DO UPDATE SET progress_sec = excluded.progress_sec, watched_at = excluded.watched_at`,
    userId, videoId, progressSec, now)
  if (countPlay) run('UPDATE videos SET play_count = play_count + 1 WHERE id = ?', videoId)
  return { added: true, videoId, progressSec }
}

export const searchUsers = q => all('SELECT id, uid, nickname AS name FROM v_users WHERE nickname LIKE ? OR uid = ? LIMIT 20', `%${q}%`, q)
