/*
 * 管理后台的全部 SQL（列表 / 筛选 / 增删改 / 批量 / 首页分区 / 统计）。
 *
 * 与 db/index.mjs 分开放：那边是给前台 App 的只读查询，这里是后台的读写。
 * 约定：
 *   - 排序列一律走白名单映射，用户输入永远只作为 ? 参数，不拼进 SQL
 *   - IN 列表用 json_each(?) 传一个 JSON 数组，不受占位符个数限制
 *   - 返回给接口的行已经是 camelCase 的 Admin* 结构（不含十几 KB 的 *_fallback 占位图）
 */
import { db, tx, parseTags } from './index.mjs'
import { urlKey, urlSpellings } from '../lib/urls.mjs'

export { tx }

/* 语句缓存：导入时同一条 SQL 要跑上万次，不必每次重新 prepare */
const cache = new Map()
const st = sql => {
  let s = cache.get(sql)
  if (!s) { s = db.prepare(sql); cache.set(sql, s) }
  return s
}
const all = (sql, ...a) => st(sql).all(...a)
const get = (sql, ...a) => st(sql).get(...a)
const run = (sql, ...a) => st(sql).run(...a)
const now = () => Math.floor(Date.now() / 1000)
const json = arr => JSON.stringify(arr)
const IN = '(SELECT value FROM json_each(?))'

/*
 * 后台要用的索引，老库启动时补建（表还不存在就跳过）：
 *   playback_url / cover_url   导入按播放地址查重、素材「被 N 个视频使用」、扫描「已导入」、统计缺封面 / 缺播放地址
 *   creators.name              导入按名称找创作者
 *   published_at / created_at  列表默认排序（几万条视频时不用临时排序全表）
 *   duration_sec = 0（部分索引） 统计 / 筛选「缺时长」
 * 视频行里的 cover_fallback 在多数列之前，种子数据的占位图有 7 KB 多，扫表要顺着溢出页读，
 * 所以统计和排序尽量走这些小索引，不碰表本身。
 */
if (db.prepare("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'videos'").get()) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_playback ON videos(playback_url)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_cover ON videos(cover_url)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_pubtime ON videos(published_at DESC, id DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC, id DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_nodur ON videos(id) WHERE duration_sec = 0')
  db.exec('CREATE INDEX IF NOT EXISTS idx_creators_name ON creators(name)')
  /*
   * 早期版本时长没有上限：超过 2^53 的整数一读就抛 RangeError（列表、导出、App 详情页整页 500，后台也删不掉），
   * 超过 int64 的存成了小数、显示成乱码。启动时把这类读不出来的时长清零（变成「缺时长」，可在后台重填）。
   * 只碰这几种坏值；正常的行一行都不改。
   */
  try {
    const n = db.prepare(`UPDATE videos SET duration_sec = 0
                          WHERE typeof(duration_sec) != 'integer' OR duration_sec > 9007199254740991 OR duration_sec < 0`).run().changes
    if (n) console.warn(`已把 ${n} 条视频的异常时长清零（之前导入时写进了过大的值）`)
  } catch (e) {
    console.warn('检查异常时长失败', e.message)
  }
}

/** LIKE 参数：转义 % _ \，配合 ESCAPE '\' */
const likeArg = s => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%'
const LIKE = "LIKE ? ESCAPE '\\'"

/* ---------------- 通用写入（列名白名单） ---------------- */

const COLUMNS = {
  videos: ['public_id', 'title', 'description', 'creator_id', 'topic_id', 'duration_sec', 'cover_url', 'cover_fallback',
    'playback_url', 'region', 'category_key', 'quality', 'tags', 'status', 'published_at', 'created_at'],
  posts: ['creator_id', 'text', 'media_kind', 'video_id', 'tags', 'thumb_count', 'more_count', 'read_count', 'is_hot',
    'status', 'published_at', 'created_at'],
  topics: ['slug', 'name', 'description', 'kind', 'is_featured', 'sort_order', 'card_size', 'plays_count', 'status', 'created_at'],
  creators: ['handle', 'name', 'avatar_url', 'avatar_fallback', 'is_verified', 'is_official', 'bio', 'status', 'created_at'],
  search_keywords: ['word', 'is_hot', 'is_banned', 'weight', 'sort_order', 'updated_at'],
  home_sections: ['topic_id', 'title', 'subtitle', 'is_featured', 'card_size', 'sort_order', 'status', 'updated_at']
}

function checkCols(table, cols) {
  const allowed = COLUMNS[table]
  const keys = Object.keys(cols)
  for (const k of keys) if (!allowed.includes(k)) throw new Error(`未知列 ${table}.${k}`)
  return keys
}

export function insertRow(table, cols) {
  const keys = checkCols(table, cols)
  const sql = `INSERT INTO ${table}(${keys.join(', ')}) VALUES(${keys.map(() => '?').join(', ')})`
  return Number(run(sql, ...keys.map(k => cols[k])).lastInsertRowid)
}

export function updateRow(table, id, cols) {
  const keys = checkCols(table, cols)
  if (!keys.length) return 0
  const sql = `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`
  return run(sql, ...keys.map(k => cols[k]), id).changes
}

/** 批量把某一列设成同一个值（列名同样走白名单） */
export function setColumn(table, ids, col, value) {
  checkCols(table, { [col]: value })
  return run(`UPDATE ${table} SET ${col} = ? WHERE id IN ${IN}`, value, json(ids)).changes
}

const DELETABLE = ['videos', 'posts', 'topics', 'creators', 'search_keywords', 'home_sections']
export function deleteRows(table, ids) {
  if (!DELETABLE.includes(table)) throw new Error('不允许删除 ' + table)
  return run(`DELETE FROM ${table} WHERE id IN ${IN}`, json(ids)).changes
}

/** 只保留库里确实存在的 id（批量操作前用） */
export function existingIds(table, ids) {
  if (!DELETABLE.includes(table)) throw new Error('未知表 ' + table)
  return all(`SELECT id FROM ${table} WHERE id IN ${IN}`, json(ids)).map(r => r.id)
}

/** 排序：apiKey → 列；未知 key 用默认值 */
function orderBy(map, sort, order, def) {
  const key = Object.hasOwn(map, sort) ? sort : def.key
  const col = map[key]
  const dir = order === 'asc' || order === 'desc' ? order : (def.order?.[key] || 'desc')
  return `${col} ${dir.toUpperCase()}`
}

/* ---------------- 元数据 ---------------- */

export const metaTopics = () => all('SELECT id, name, slug, kind, status FROM topics ORDER BY sort_order, id')
export const metaCreators = () => all('SELECT id, name, handle, status FROM creators ORDER BY name LIMIT 5000')
export const categories = () => all(`SELECT key, label FROM client_tabs WHERE nav = 'home' AND key NOT IN ('latest', 'recommend')
                                     ORDER BY sort_order, id`)
export const regions = () => all('SELECT code, label FROM regions ORDER BY sort_order, id')

/* ---------------- 统计 ---------------- */

/**
 * 每个数字一条只走索引的小查询（不扫表本身：视频行带着大块占位图，扫表很慢）。
 * service 层再缓存几秒，后台有写操作时清掉。
 */
export function stats() {
  const byStatus = new Map(all('SELECT status, COUNT(*) n FROM videos GROUP BY status').map(r => [r.status, r.n]))
  const total = [...byStatus.values()].reduce((a, b) => a + b, 0)
  const missing = col => get(`SELECT COUNT(*) c FROM videos WHERE ${col} IS NULL OR ${col} = ''`).c
  const p = get('SELECT COUNT(*) total, COALESCE(SUM(status = 1), 0) published, COALESCE(SUM(is_hot = 1), 0) hot FROM posts')
  const count = t => get(`SELECT COUNT(*) c FROM ${t}`).c
  return {
    videos: {
      total, published: byStatus.get(1) || 0, draft: byStatus.get(0) || 0, offline: byStatus.get(2) || 0,
      missingPlayback: missing('playback_url'), missingCover: missing('cover_url'),
      missingDuration: get('SELECT COUNT(*) c FROM videos WHERE duration_sec = 0').c,
      short: count('short_clips')
    },
    posts: { total: p.total, published: p.published, hot: p.hot },
    topics: { total: count('topics') },
    creators: { total: count('creators') },
    sections: { total: count('home_sections') },
    keywords: { total: count('search_keywords') },
    users: { total: count('users'), admins: get("SELECT COUNT(*) c FROM users WHERE role = 'admin'").c },
    recentVideos: all(`${VIDEO_SELECT} ORDER BY v.created_at DESC, v.id DESC LIMIT 8`).map(toAdminVideo),
    recentPosts: withPostMedia(all(`${POST_SELECT} ORDER BY p.created_at DESC, p.id DESC LIMIT 5`)).map(toAdminPost)
  }
}

/* ---------------- 视频 ---------------- */

const VIDEO_SELECT = `
  SELECT v.id, v.public_id, v.title, v.description, v.topic_id, t.name AS topic_name, t.slug AS topic_slug,
         v.creator_id, c.name AS creator_name, c.handle AS creator_handle,
         v.category_key, v.region, v.quality, v.tags, v.duration_sec, v.cover_url, v.playback_url,
         (s.video_id IS NOT NULL) AS is_short, v.play_count, v.like_count, v.fav_count,
         v.status, v.published_at, v.created_at
  FROM videos v
  LEFT JOIN topics t ON t.id = v.topic_id
  LEFT JOIN creators c ON c.id = v.creator_id
  LEFT JOIN short_clips s ON s.video_id = v.id`

export function toAdminVideo(r) {
  if (!r) return null
  return {
    id: r.id, publicId: r.public_id, title: r.title, description: r.description,
    topicId: r.topic_id, topicName: r.topic_name ?? null,
    creatorId: r.creator_id, creatorName: r.creator_name ?? null, creatorHandle: r.creator_handle ?? null,
    categoryKey: r.category_key, region: r.region, quality: r.quality, tags: parseTags(r.tags),
    durationSec: r.duration_sec, coverUrl: r.cover_url, playbackUrl: r.playback_url, isShort: !!r.is_short,
    playCount: r.play_count, likeCount: r.like_count, favCount: r.fav_count,
    status: r.status, publishedAt: r.published_at, createdAt: r.created_at
  }
}

const VIDEO_SORT = {
  id: 'v.id', title: 'v.title', publishedAt: 'v.published_at', createdAt: 'v.created_at', playCount: 'v.play_count',
  likeCount: 'v.like_count', favCount: 'v.fav_count', durationSec: 'v.duration_sec'
}

/** f 已由 service 校验成正确类型；undefined = 不筛 */
function videoWhere(f) {
  const w = [], a = []
  if (f.q) {
    const like = likeArg(f.q)
    let c = `v.title ${LIKE} OR v.public_id ${LIKE} OR v.tags ${LIKE}`
    a.push(like, like, like)
    if (/^\d+$/.test(f.q)) { c += ' OR v.id = ?'; a.push(Number(f.q)) }
    w.push(`(${c})`)
  }
  if (f.status !== undefined) { w.push('v.status = ?'); a.push(f.status) }
  if (f.topicId === 'none') w.push('v.topic_id IS NULL')
  else if (f.topicId !== undefined) { w.push('v.topic_id = ?'); a.push(f.topicId) }
  if (f.creatorId === 'none') w.push('v.creator_id IS NULL')
  else if (f.creatorId !== undefined) { w.push('v.creator_id = ?'); a.push(f.creatorId) }
  if (f.category === 'none') w.push('v.category_key IS NULL')
  else if (f.category !== undefined) { w.push('v.category_key = ?'); a.push(f.category) }
  if (f.region === 'none') w.push('v.region IS NULL')
  else if (f.region !== undefined) { w.push('v.region = ?'); a.push(f.region) }
  if (f.missing === 'playback') w.push("(v.playback_url IS NULL OR v.playback_url = '')")
  else if (f.missing === 'cover') w.push("(v.cover_url IS NULL OR v.cover_url = '')")
  else if (f.missing === 'duration') w.push('v.duration_sec = 0')
  if (f.short === 1) w.push('EXISTS (SELECT 1 FROM short_clips sc WHERE sc.video_id = v.id)')
  else if (f.short === 0) w.push('NOT EXISTS (SELECT 1 FROM short_clips sc WHERE sc.video_id = v.id)')
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a }
}

export function listVideos(f, { sort, order, limit, offset }) {
  const { where, args } = videoWhere(f)
  const total = get(`SELECT COUNT(*) c FROM videos v ${where}`, ...args).c
  const ob = orderBy(VIDEO_SORT, sort, order, { key: 'publishedAt' })
  const list = all(`${VIDEO_SELECT} ${where} ORDER BY ${ob}, v.id ${ob.endsWith('ASC') ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
    ...args, limit, offset).map(toAdminVideo)
  return { total, list }
}

/** 导出：原始行（带 topic_slug，service 负责转成导入格式） */
export function exportVideos(f, { sort, order, limit }) {
  const { where, args } = videoWhere(f)
  const ob = orderBy(VIDEO_SORT, sort, order, { key: 'publishedAt' })
  return all(`${VIDEO_SELECT} ${where} ORDER BY ${ob}, v.id DESC LIMIT ?`, ...args, limit)
}

export const getVideo = id => toAdminVideo(get(`${VIDEO_SELECT} WHERE v.id = ?`, id))
/** 编辑时比对用的原始列（不含 cover_fallback 等用不到的大字段） */
export const videoRow = id => get(`SELECT id, public_id, title, description, topic_id, creator_id, category_key, region, quality, tags,
                                          duration_sec, cover_url, playback_url, status, published_at
                                   FROM videos WHERE id = ?`, id)
export const videoExists = id => !!get('SELECT 1 x FROM videos WHERE id = ?', id)
export const videoIdByPublicId = pid => get('SELECT id FROM videos WHERE public_id = ?', pid)?.id ?? null
export const publicIdTaken = (pid, exceptId = 0) => !!get('SELECT 1 x FROM videos WHERE public_id = ? AND id != ?', pid, exceptId)

/** VID-<n> 里最大的 n（只认纯数字后缀） */
export const maxVidNumber = () => get(`SELECT MAX(CAST(SUBSTR(public_id, 5) AS INTEGER)) n FROM videos
                                       WHERE public_id GLOB 'VID-[0-9]*' AND SUBSTR(public_id, 5) NOT GLOB '*[^0-9]*'`).n || 0

/** 短视频流：加入排在最后；移出直接删 */
export function setShort(videoId, on) {
  if (on) {
    return run(`INSERT OR IGNORE INTO short_clips(video_id, sort_order, added_at)
                VALUES(?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM short_clips), ?)`, videoId, now()).changes
  }
  return run('DELETE FROM short_clips WHERE video_id = ?', videoId).changes
}

export const videoTags = ids => all(`SELECT id, tags FROM videos WHERE id IN ${IN}`, json(ids))
export const setVideoTags = (id, tags) => run('UPDATE videos SET tags = ? WHERE id = ?', json(tags), id).changes
export const videoDuration = id => get('SELECT duration_sec FROM videos WHERE id = ?', id)?.duration_sec ?? null

/** 专题视频数 = 该专题下已发布视频数；后台任何可能影响它的写操作之后统一重算一次 */
export const recountTopics = () =>
  run('UPDATE topics SET video_count = (SELECT COUNT(*) FROM videos v WHERE v.topic_id = topics.id AND v.status = 1)')

/** 首页分区选视频 / 弹窗用的简版视频 */
export function videoBriefs(ids) {
  const rows = all(`SELECT v.id, v.public_id, v.title, v.cover_url, v.status, v.duration_sec, t.name AS topic_name
                    FROM videos v LEFT JOIN topics t ON t.id = v.topic_id WHERE v.id IN ${IN}`, json(ids))
  return new Map(rows.map(r => [r.id, toBrief(r)]))
}
const toBrief = r => ({
  id: r.id, publicId: r.public_id, title: r.title, coverUrl: r.cover_url, status: r.status,
  durationSec: r.duration_sec, topicName: r.topic_name ?? null
})

/* ---------------- 帖子 ---------------- */

const POST_SELECT = `
  SELECT p.id, p.creator_id, c.name AS creator_name, c.handle AS creator_handle, p.text, p.media_kind,
         p.video_id, v.title AS video_title, v.public_id AS video_public_id, p.tags, p.more_count, p.read_count,
         p.fav_count, p.is_hot, p.status, p.published_at, p.created_at
  FROM posts p
  LEFT JOIN creators c ON c.id = p.creator_id
  LEFT JOIN videos v ON v.id = p.video_id`

/** 给一批帖子行挂上主图 / 配图（一次查询） */
function withPostMedia(rows) {
  if (!rows.length) return rows
  const media = all(`SELECT post_id, role, url FROM post_media WHERE post_id IN ${IN} AND url IS NOT NULL
                     ORDER BY post_id, role, sort_order, id`, json(rows.map(r => r.id)))
  const byPost = new Map()
  for (const m of media) {
    let e = byPost.get(m.post_id)
    if (!e) byPost.set(m.post_id, (e = { main: null, images: [] }))
    if (m.role === 0) { if (e.main == null) e.main = m.url } else e.images.push(m.url)
  }
  for (const r of rows) {
    const e = byPost.get(r.id)
    r.main_image = e?.main ?? null
    r.images = e?.images ?? []
  }
  return rows
}

export function toAdminPost(r) {
  if (!r) return null
  return {
    id: r.id, creatorId: r.creator_id, creatorName: r.creator_name ?? null, creatorHandle: r.creator_handle ?? null,
    text: r.text, mediaKind: r.media_kind, videoId: r.video_id, videoTitle: r.video_title ?? null,
    videoPublicId: r.video_public_id ?? null, tags: parseTags(r.tags), mainImage: r.main_image ?? null,
    images: r.images ?? [], moreCount: r.more_count, readCount: r.read_count, favCount: r.fav_count,
    isHot: !!r.is_hot, status: r.status, publishedAt: r.published_at, createdAt: r.created_at
  }
}

const POST_SORT = { id: 'p.id', publishedAt: 'p.published_at', readCount: 'p.read_count', favCount: 'p.fav_count' }

function postWhere(f) {
  const w = [], a = []
  if (f.q) {
    const like = likeArg(f.q)
    let c = `p.text ${LIKE} OR p.tags ${LIKE}`
    a.push(like, like)
    if (/^\d+$/.test(f.q)) { c += ' OR p.id = ?'; a.push(Number(f.q)) }
    w.push(`(${c})`)
  }
  if (f.status !== undefined) { w.push('p.status = ?'); a.push(f.status) }
  if (f.creatorId !== undefined) { w.push('p.creator_id = ?'); a.push(f.creatorId) }
  if (f.mediaKind !== undefined) { w.push('p.media_kind = ?'); a.push(f.mediaKind) }
  if (f.isHot !== undefined) { w.push('p.is_hot = ?'); a.push(f.isHot) }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a }
}

export function listPosts(f, { sort, order, limit, offset }) {
  const { where, args } = postWhere(f)
  const total = get(`SELECT COUNT(*) c FROM posts p ${where}`, ...args).c
  const ob = orderBy(POST_SORT, sort, order, { key: 'publishedAt' })
  const rows = all(`${POST_SELECT} ${where} ORDER BY ${ob}, p.id ${ob.endsWith('ASC') ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
    ...args, limit, offset)
  return { total, list: withPostMedia(rows).map(toAdminPost) }
}

export function exportPosts(f, { sort, order, limit }) {
  const { where, args } = postWhere(f)
  const ob = orderBy(POST_SORT, sort, order, { key: 'publishedAt' })
  return withPostMedia(all(`${POST_SELECT} ${where} ORDER BY ${ob}, p.id DESC LIMIT ?`, ...args, limit))
}

export const getPost = id => {
  const r = get(`${POST_SELECT} WHERE p.id = ?`, id)
  return r ? toAdminPost(withPostMedia([r])[0]) : null
}
export const postRow = id => get('SELECT * FROM posts WHERE id = ?', id)
export const postTags = ids => all(`SELECT id, tags FROM posts WHERE id IN ${IN}`, json(ids))
export const setPostTags = (id, tags) => run('UPDATE posts SET tags = ? WHERE id = ?', json(tags), id).changes

/** 整体替换帖子的媒体行，并同步 thumb_count */
export function replacePostMedia(postId, rows, thumbCount) {
  run('DELETE FROM post_media WHERE post_id = ?', postId)
  for (const m of rows) {
    run(`INSERT INTO post_media(post_id, media_type, role, url, fallback, duration_sec, sort_order) VALUES(?,?,?,?,?,?,?)`,
      postId, m.mediaType, m.role, m.url, m.fallback, m.durationSec ?? null, m.sortOrder)
  }
  run('UPDATE posts SET thumb_count = ? WHERE id = ?', thumbCount, postId)
}

/** 关联视频变了：主图上的时长跟着变 */
export const syncPostMainDuration = (postId, durationSec) =>
  run('UPDATE post_media SET duration_sec = ? WHERE post_id = ? AND role = 0', durationSec, postId)

/* ---------------- 专题 ---------------- */

const TOPIC_SELECT = `
  SELECT t.id, t.slug, t.name, t.description, t.kind, t.is_featured, t.sort_order, t.card_size, t.plays_count,
         t.fav_count, t.video_count, t.status, t.created_at,
         (SELECT COUNT(*) FROM home_sections h WHERE h.topic_id = t.id) AS section_count
  FROM topics t`

/** 挂上「全部视频数」和头图（各一次查询） */
function withTopicExtras(rows) {
  if (!rows.length) return rows
  const ids = json(rows.map(r => r.id))
  const totals = new Map(all(`SELECT topic_id, COUNT(*) n FROM videos WHERE topic_id IN ${IN} GROUP BY topic_id`, ids)
    .map(r => [r.topic_id, r.n]))
  const covers = new Map()
  for (const c of all(`SELECT topic_id, url FROM topic_covers WHERE topic_id IN ${IN} AND url IS NOT NULL
                       ORDER BY topic_id, sort_order, id`, ids)) {
    if (!covers.has(c.topic_id)) covers.set(c.topic_id, [])
    covers.get(c.topic_id).push(c.url)
  }
  for (const r of rows) {
    r.total_videos = totals.get(r.id) || 0
    r.covers = covers.get(r.id) || []
  }
  return rows
}

export function toAdminTopic(r) {
  if (!r) return null
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description, kind: r.kind, isFeatured: !!r.is_featured,
    sortOrder: r.sort_order, cardSize: r.card_size, playsCount: r.plays_count, favCount: r.fav_count,
    videoCount: r.video_count, totalVideos: r.total_videos ?? 0, sectionCount: r.section_count ?? 0,
    status: r.status, covers: r.covers ?? [], createdAt: r.created_at
  }
}

const TOPIC_SORT = { sortOrder: 't.sort_order', id: 't.id', name: 't.name', videoCount: 't.video_count' }
const TOPIC_SORT_DEF = { key: 'sortOrder', order: { sortOrder: 'asc', name: 'asc' } }

function topicWhere(f) {
  const w = [], a = []
  if (f.q) {
    const like = likeArg(f.q)
    let c = `t.name ${LIKE} OR t.slug ${LIKE}`
    a.push(like, like)
    if (/^\d+$/.test(f.q)) { c += ' OR t.id = ?'; a.push(Number(f.q)) }
    w.push(`(${c})`)
  }
  if (f.kind !== undefined) { w.push('t.kind = ?'); a.push(f.kind) }
  if (f.status !== undefined) { w.push('t.status = ?'); a.push(f.status) }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a }
}

export function listTopics(f, { sort, order, limit, offset }) {
  const { where, args } = topicWhere(f)
  const total = get(`SELECT COUNT(*) c FROM topics t ${where}`, ...args).c
  const ob = orderBy(TOPIC_SORT, sort, order, TOPIC_SORT_DEF)
  const rows = all(`${TOPIC_SELECT} ${where} ORDER BY ${ob}, t.id ASC LIMIT ? OFFSET ?`, ...args, limit, offset)
  return { total, list: withTopicExtras(rows).map(toAdminTopic) }
}

export function exportTopics(f, { sort, order, limit }) {
  const { where, args } = topicWhere(f)
  const ob = orderBy(TOPIC_SORT, sort, order, TOPIC_SORT_DEF)
  return withTopicExtras(all(`${TOPIC_SELECT} ${where} ORDER BY ${ob}, t.id ASC LIMIT ?`, ...args, limit))
}

export const getTopic = id => {
  const r = get(`${TOPIC_SELECT} WHERE t.id = ?`, id)
  return r ? toAdminTopic(withTopicExtras([r])[0]) : null
}
export const topicRow = id => get('SELECT * FROM topics WHERE id = ?', id)
export const topicIdBySlug = slug => get('SELECT id FROM topics WHERE slug = ?', slug)?.id ?? null
export const topicIdByName = name => get('SELECT id FROM topics WHERE name = ? ORDER BY id LIMIT 1', name)?.id ?? null
export const slugTaken = (slug, exceptId = 0) => !!get('SELECT 1 x FROM topics WHERE slug = ? AND id != ?', slug, exceptId)
export const nextTopicSort = () => get('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM topics').n
/** 全部专题的 id / 名称 / 标识（导出时据此选一个再导入能对回同一个专题的写法） */
export const topicRefRows = () => all('SELECT id, name, slug FROM topics ORDER BY id')
export const topicCoverRows = id => all('SELECT url, fallback FROM topic_covers WHERE topic_id = ? ORDER BY sort_order, id', id)

export function replaceTopicCovers(topicId, rows) {
  run('DELETE FROM topic_covers WHERE topic_id = ?', topicId)
  rows.forEach((c, k) => run('INSERT INTO topic_covers(topic_id, url, fallback, sort_order) VALUES(?,?,?,?)', topicId, c.url, c.fallback, k))
}

/** 删专题前统计：它的首页分区会被级联删掉，视频变成「无专题」 */
export const topicDeleteImpact = id => ({
  sections: get('SELECT COUNT(*) c FROM home_sections WHERE topic_id = ?', id).c,
  videos: get('SELECT COUNT(*) c FROM videos WHERE topic_id = ?', id).c
})
export const topicsDeleteImpact = ids => ({
  sections: get(`SELECT COUNT(*) c FROM home_sections WHERE topic_id IN ${IN}`, json(ids)).c,
  videos: get(`SELECT COUNT(*) c FROM videos WHERE topic_id IN ${IN}`, json(ids)).c
})

export function reorderTopics(ids) {
  let n = 0
  ids.forEach((id, i) => { n += run('UPDATE topics SET sort_order = ? WHERE id = ?', i, id).changes })
  return n
}

/* ---------------- 创作者 ---------------- */

const CREATOR_SELECT = `
  SELECT c.id, c.handle, c.name, c.avatar_url, c.bio, c.is_verified, c.is_official, c.follower_count, c.status, c.created_at,
         (SELECT COUNT(*) FROM videos v WHERE v.creator_id = c.id) AS video_count,
         (SELECT COUNT(*) FROM posts p WHERE p.creator_id = c.id) AS post_count
  FROM creators c`

export function toAdminCreator(r) {
  if (!r) return null
  return {
    id: r.id, handle: r.handle, name: r.name, avatarUrl: r.avatar_url, bio: r.bio, isVerified: !!r.is_verified,
    isOfficial: !!r.is_official, followerCount: r.follower_count, status: r.status,
    videoCount: r.video_count, postCount: r.post_count, createdAt: r.created_at
  }
}

const CREATOR_SORT = { id: 'c.id', name: 'c.name', followerCount: 'c.follower_count', videoCount: 'video_count' }
const CREATOR_SORT_DEF = { key: 'id', order: { name: 'asc' } }

function creatorWhere(f) {
  const w = [], a = []
  if (f.q) {
    const like = likeArg(String(f.q).replace(/^@/, ''))
    let c = `c.name ${LIKE} OR c.handle ${LIKE}`
    a.push(like, like)
    if (/^\d+$/.test(f.q)) { c += ' OR c.id = ?'; a.push(Number(f.q)) }
    w.push(`(${c})`)
  }
  if (f.status !== undefined) { w.push('c.status = ?'); a.push(f.status) }
  if (f.verified !== undefined) { w.push('c.is_verified = ?'); a.push(f.verified) }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a }
}

export function listCreators(f, { sort, order, limit, offset }) {
  const { where, args } = creatorWhere(f)
  const total = get(`SELECT COUNT(*) c FROM creators c ${where}`, ...args).c
  const ob = orderBy(CREATOR_SORT, sort, order, CREATOR_SORT_DEF)
  const list = all(`${CREATOR_SELECT} ${where} ORDER BY ${ob}, c.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset).map(toAdminCreator)
  return { total, list }
}

export function exportCreators(f, { sort, order, limit }) {
  const { where, args } = creatorWhere(f)
  const ob = orderBy(CREATOR_SORT, sort, order, CREATOR_SORT_DEF)
  return all(`${CREATOR_SELECT} ${where} ORDER BY ${ob}, c.id DESC LIMIT ?`, ...args, limit)
}

export const getCreator = id => toAdminCreator(get(`${CREATOR_SELECT} WHERE c.id = ?`, id))
export const creatorRow = id => get('SELECT * FROM creators WHERE id = ?', id)
export const creatorIdByHandle = handle => get('SELECT id FROM creators WHERE handle = ?', handle)?.id ?? null
export const creatorIdByName = name => get('SELECT id FROM creators WHERE name = ? ORDER BY id LIMIT 1', name)?.id ?? null
export const handleTaken = (handle, exceptId = 0) => !!get('SELECT 1 x FROM creators WHERE handle = ? AND id != ?', handle, exceptId)
export const setCreatorAvatarFallback = (id, fallback) => run('UPDATE creators SET avatar_fallback = ? WHERE id = ?', fallback, id)

/** 删创作者前统计：帖子级联删除，视频变成「无创作者」 */
export const creatorsDeleteImpact = ids => ({
  posts: get(`SELECT COUNT(*) c FROM posts WHERE creator_id IN ${IN}`, json(ids)).c,
  videos: get(`SELECT COUNT(*) c FROM videos WHERE creator_id IN ${IN}`, json(ids)).c
})

/* ---------------- 首页推荐分区 ---------------- */

const SECTION_SELECT = `
  SELECT s.id, s.title, s.subtitle, s.topic_id, t.name AS topic_name, s.is_featured, s.card_size, s.sort_order, s.status,
         s.updated_at,
         (SELECT COUNT(DISTINCT i.batch_no) FROM home_section_items i WHERE i.section_id = s.id) AS batch_count,
         (SELECT COUNT(*) FROM home_section_items i WHERE i.section_id = s.id) AS item_count
  FROM home_sections s
  LEFT JOIN topics t ON t.id = s.topic_id`

export function toAdminSection(r) {
  if (!r) return null
  return {
    id: r.id, title: r.title, subtitle: r.subtitle, topicId: r.topic_id, topicName: r.topic_name ?? null,
    isFeatured: !!r.is_featured, cardSize: r.card_size, sortOrder: r.sort_order, status: r.status,
    batchCount: r.batch_count, itemCount: r.item_count, updatedAt: r.updated_at
  }
}

export const listSections = () => all(`${SECTION_SELECT} ORDER BY s.sort_order, s.id`).map(toAdminSection)
export const getSection = id => toAdminSection(get(`${SECTION_SELECT} WHERE s.id = ?`, id))
export const sectionRow = id => get('SELECT * FROM home_sections WHERE id = ?', id)
export const nextSectionSort = () => get('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM home_sections').n
/** 首页只允许一个全宽大卡分区 */
export const clearFeaturedSections = exceptId => run('UPDATE home_sections SET is_featured = 0 WHERE id != ? AND is_featured = 1', exceptId)
export const touchSection = id => run('UPDATE home_sections SET updated_at = ? WHERE id = ?', now(), id)

export function reorderSections(ids) {
  let n = 0
  ids.forEach((id, i) => { n += run('UPDATE home_sections SET sort_order = ?, updated_at = ? WHERE id = ?', i, now(), id).changes })
  return n
}

/** 分区内容：按批次分组（批次号 = 数组下标），草稿 / 下架的也返回，前端标出来 */
export function sectionItems(sectionId) {
  const rows = all(`SELECT i.batch_no, v.id, v.public_id, v.title, v.cover_url, v.status, v.duration_sec, t.name AS topic_name
                    FROM home_section_items i
                    JOIN videos v ON v.id = i.video_id
                    LEFT JOIN topics t ON t.id = v.topic_id
                    WHERE i.section_id = ?
                    ORDER BY i.batch_no, i.sort_order, i.id`, sectionId)
  const batches = []
  for (const r of rows) {
    while (batches.length <= r.batch_no) batches.push([])
    batches[r.batch_no].push(toBrief(r))
  }
  return batches
}

/** 整体替换分区内容；batches 已去重、已校验 */
export function replaceSectionItems(sectionId, batches) {
  run('DELETE FROM home_section_items WHERE section_id = ?', sectionId)
  batches.forEach((ids, b) => ids.forEach((vid, k) =>
    run('INSERT INTO home_section_items(section_id, video_id, sort_order, batch_key, batch_no) VALUES(?,?,?,?,?)',
      sectionId, vid, k, 'b' + b, b)))
  touchSection(sectionId)
}

/** 自动生成用的候选池：只取已发布视频，最多 2000 条 */
export function sectionPool(source, topicId) {
  if (source === 'topic') {
    return all('SELECT id FROM videos WHERE status = 1 AND topic_id = ? ORDER BY play_count DESC, id DESC LIMIT 2000', topicId).map(r => r.id)
  }
  const ob = source === 'latest' ? 'published_at DESC, id DESC' : 'play_count DESC, id DESC'
  return all(`SELECT id FROM videos WHERE status = 1 ORDER BY ${ob} LIMIT 2000`).map(r => r.id)
}

/* ---------------- 搜索热词 ---------------- */

const KEYWORD_SELECT = 'SELECT id, word, is_hot, is_banned, weight, sort_order, search_count, updated_at FROM search_keywords k'

export function toAdminKeyword(r) {
  if (!r) return null
  return {
    id: r.id, word: r.word, isHot: !!r.is_hot, isBanned: !!r.is_banned, weight: r.weight,
    sortOrder: r.sort_order, searchCount: r.search_count, updatedAt: r.updated_at
  }
}

const KEYWORD_SORT = { weight: 'k.weight', sortOrder: 'k.sort_order', id: 'k.id', word: 'k.word' }
const KEYWORD_SORT_DEF = { key: 'weight', order: { sortOrder: 'asc', word: 'asc' } }

function keywordWhere(f) {
  const w = [], a = []
  if (f.q) { w.push(`k.word ${LIKE}`); a.push(likeArg(f.q)) }
  if (f.isHot !== undefined) { w.push('k.is_hot = ?'); a.push(f.isHot) }
  if (f.isBanned !== undefined) { w.push('k.is_banned = ?'); a.push(f.isBanned) }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a }
}

export function listKeywords(f, { sort, order, limit, offset }) {
  const { where, args } = keywordWhere(f)
  const total = get(`SELECT COUNT(*) c FROM search_keywords k ${where}`, ...args).c
  const ob = orderBy(KEYWORD_SORT, sort, order, KEYWORD_SORT_DEF)
  const list = all(`${KEYWORD_SELECT} ${where} ORDER BY ${ob}, k.sort_order ASC, k.id ASC LIMIT ? OFFSET ?`, ...args, limit, offset)
    .map(toAdminKeyword)
  return { total, list }
}

export function exportKeywords(f, { sort, order, limit }) {
  const { where, args } = keywordWhere(f)
  const ob = orderBy(KEYWORD_SORT, sort, order, KEYWORD_SORT_DEF)
  return all(`${KEYWORD_SELECT} ${where} ORDER BY ${ob}, k.sort_order ASC, k.id ASC LIMIT ?`, ...args, limit)
}

export const getKeyword = id => toAdminKeyword(get(`${KEYWORD_SELECT} WHERE k.id = ?`, id))
export const keywordRow = id => get('SELECT * FROM search_keywords WHERE id = ?', id)
export const keywordIdByWord = word => get('SELECT id FROM search_keywords WHERE word = ?', word)?.id ?? null
export const nextKeywordSort = () => get('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM search_keywords').n
export const touchKeywords = ids => run(`UPDATE search_keywords SET updated_at = ? WHERE id IN ${IN}`, now(), json(ids))

/* ---------------- 按地址找视频（导入查重 / 扫描已导入 / 素材引用数） ---------------- */

/**
 * 播放地址（或封面）以这些写法之一开头的视频：{ id, url, col: 'playback'|'cover' }，按 id 升序。
 * 「开头」= 范围 [写法, 写法 + '@')：恰好相等，或后面跟着 ? # 空格 . 等字符（含 ?v= 缓存参数）。
 * 结果是超集，调用方再用 lib/urls.mjs 的 urlKey() 精确比对。每个写法一次索引范围查找，不扫表。
 */
export function videosByUrlSpellings(spellings, { playback = true, cover = false } = {}) {
  if (!spellings.length) return []
  // CROSS JOIN 固定 json_each 在外层：每个写法走一次索引范围查找（普通 JOIN 会被排成扫全表）
  const part = (col, tag) => `SELECT v.id, v.${col} AS url, '${tag}' AS col FROM json_each(?) j
                              CROSS JOIN videos v ON v.${col} >= j.value AND v.${col} < j.value || '@'`
  const sql = [], args = []
  if (playback) { sql.push(part('playback_url', 'playback')); args.push(json(spellings)) }
  if (cover) { sql.push(part('cover_url', 'cover')); args.push(json(spellings)) }
  if (!sql.length) return []
  return all(`${sql.join(' UNION ALL ')} ORDER BY 1`, ...args)
}

/**
 * 导入按播放地址查重：和 url 指向同一个文件的视频（编码 / 未编码、站内地址带 ?v= 都算同一个），取 id 最小的。
 * 外部地址的查询串保留比较（见 lib/urls.mjs）。
 */
export function videoIdByPlayback(url) {
  const key = urlKey(url)
  if (!key) return null
  return videosByUrlSpellings(urlSpellings(url)).find(v => urlKey(v.url) === key)?.id ?? null
}
