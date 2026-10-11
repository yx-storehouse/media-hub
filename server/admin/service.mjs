/*
 * 管理后台业务层：校验 → 写库 → 返回 Admin* 结构。
 *
 * 接口（JSON 请求体）和批量导入共用同一套校验：导入只是先把「专题名称 / 创作者账号」这类引用
 * 解析成 id、把导入列名换成接口字段名，然后走和「新建 / 编辑」完全一样的 create* / update*。
 * 所以脚本、curl、后台页面导入的数据，校验规则一致。
 */
import { createHash } from 'node:crypto'
import * as A from '../db/admin.mjs'
import { db, parseTags } from '../db/index.mjs'
import { InputError } from '../lib/errors.mjs'
import { avatar } from '../lib/art.mjs'
import { liteCover, liteDoc } from '../lib/lite-art.mjs'
import { urlKey, urlSpellings } from '../lib/urls.mjs'
import * as F from './fields.mjs'
import { mediaStats } from './media.mjs'

const now = () => Math.floor(Date.now() / 1000)
const fail = (message, field) => { throw new InputError(message, field) }
const { tx } = A

/* ---------------- 通用小工具 ---------------- */

function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('请求体必须是 JSON 对象')
  return body
}

/** 路由里的 :id 已经是数字；这里统一挡掉 0 和超大值 */
function requireId(id) {
  if (!Number.isSafeInteger(id) || id <= 0) fail('ID 不正确')
  return id
}

/** 查询参数 → 分页 / 排序 */
function paging(q, maxSize = 200) {
  const int = (v, min, max, def) => {
    const n = Number(v)
    return Number.isInteger(n) && n >= min ? Math.min(n, max) : def
  }
  const page = int(q.page, 1, 1e6, 1)
  const pageSize = int(q.pageSize, 1, maxSize, 20)
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize, sort: q.sort, order: q.order }
}

/* 筛选参数：不合法的值当作「不筛」，不报错（地址栏里手改了也不至于整页报错） */
const qText = v => {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, 100) : undefined
}
const qEnum = (v, allowed) => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return allowed.includes(n) && /^\d+$/.test(String(v)) ? n : undefined
}
const qId = (v, allowNone = true) => {
  if (v === undefined || v === null || v === '') return undefined
  if (allowNone && v === 'none') return 'none'
  return /^\d+$/.test(String(v)) ? Number(v) : undefined
}
const qKey = v => {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, 64) : undefined
}
const qOneOf = (v, list) => (list.includes(v) ? v : undefined)

const FILTERS = {
  videos: q => ({
    q: qText(q.q), status: qEnum(q.status, [0, 1, 2]), topicId: qId(q.topicId), creatorId: qId(q.creatorId),
    category: qKey(q.category), region: qKey(q.region), missing: qOneOf(q.missing, ['playback', 'cover', 'duration']),
    short: qEnum(q.short, [0, 1])
  }),
  posts: q => ({
    q: qText(q.q), status: qEnum(q.status, [0, 1, 2]), creatorId: qId(q.creatorId, false),
    mediaKind: qEnum(q.mediaKind, [0, 1, 2]), isHot: qEnum(q.isHot, [0, 1])
  }),
  topics: q => ({ q: qText(q.q), kind: qEnum(q.kind, [0, 1, 2]), status: qEnum(q.status, [0, 1, 2]) }),
  creators: q => ({ q: qText(q.q), status: qEnum(q.status, [0, 1]), verified: qEnum(q.verified, [0, 1]) }),
  keywords: q => ({ q: qText(q.q), isHot: qEnum(q.isHot, [0, 1]), isBanned: qEnum(q.isBanned, [0, 1]) })
}

/* 分类 / 地区几乎不变，缓存几秒，导入上万行时不用每行查一次 */
let lookupCache = null
function lookups() {
  if (!lookupCache || Date.now() - lookupCache.at > 5000) {
    lookupCache = { at: Date.now(), categories: A.categories(), regions: A.regions() }
  }
  return lookupCache
}

/**
 * 按字段表把请求体收集成数据库列。
 *   spec[key] = { col, label, parse(v, key), required?: 提示, nullable?: bool, blank?: 空值时写入的值 }
 *   - 键不存在 / undefined：不改（新建时用默认值）
 *   - null 或空串：nullable → NULL；有 blank → 写 blank；新建时 → 用默认值；编辑时 → 报「不能为空」
 */
function collect(body, spec, { create }) {
  const cols = {}
  for (const [key, s] of Object.entries(spec)) {
    if (!Object.hasOwn(body, key) || body[key] === undefined) continue
    const v = body[key]
    if (v === null || (typeof v === 'string' && v.trim() === '')) {
      if (s.required) fail(s.required, key)
      if (s.nullable) cols[s.col] = null
      else if (s.blank !== undefined) cols[s.col] = s.blank
      else if (!create) fail(`${s.label}不能为空`, key)
      continue
    }
    cols[s.col] = s.parse(v, key)
  }
  if (create) {
    for (const [key, s] of Object.entries(spec)) if (s.required && !(s.col in cols)) fail(s.required, key)
  }
  return cols
}

/** 只保留和库里不同的列：原样保存 / 导出再导入时不做无谓的写入（也不触发全文索引重建） */
function changedOnly(row, cols) {
  const out = {}
  for (const [k, v] of Object.entries(cols)) if (row[k] !== v) out[k] = v
  return out
}

/** 可选的布尔字段（不在列里的，如 isShort）：undefined = 不改 */
function optBool(body, key, label) {
  const v = body[key]
  if (v === undefined) return undefined
  if (v === null || v === '') return false
  return F.toBool(v, key, label)
}

/* ---------------- 共用的字段解析 ---------------- */

const pText = (label, max, required = false) => (v, k) => F.toText(v, k, label, { max, required })
const pInt = (label, opts) => (v, k) => F.toInt(v, k, label, opts)
const pBool = label => (v, k) => (F.toBool(v, k, label) ? 1 : 0)
const pUrl = label => (v, k) => F.toUrl(v, k, label)
const pTime = label => (v, k) => F.toTimestamp(v, k, label)
const pStatus = (v, k) => F.toEnum(v, k, '状态', F.STATUS_WORDS, ['已发布', '草稿', '已下架'])

function pTopicRef(v, k) {
  const id = F.toInt(v, k, '专题', { min: 1 })
  if (!A.topicRow(id)) fail('专题不存在', k)
  return id
}
function pCreatorRef(v, k) {
  const id = F.toInt(v, k, '创作者', { min: 1 })
  if (!A.creatorRow(id)) fail('创作者不存在', k)
  return id
}
function pVideoRef(v, k) {
  const id = F.toInt(v, k, '关联视频', { min: 1 })
  if (!A.videoExists(id)) fail('关联视频不存在', k)
  return id
}
/** 分类：key 或名称都认 */
function pCategory(v, k) {
  const s = String(F.scalar(v, k, '分类')).trim().toLowerCase()
  const c = lookups().categories.find(x => x.key.toLowerCase() === s || x.label.toLowerCase() === s)
  if (!c) fail(`分类「${String(v).trim()}」不存在，可选：${lookups().categories.map(x => x.label).join(' / ')}`, k)
  return c.key
}
function pRegion(v, k) {
  const s = String(F.scalar(v, k, '地区')).trim().toLowerCase()
  const r = lookups().regions.find(x => x.code.toLowerCase() === s || x.label.toLowerCase() === s)
  if (!r) fail(`地区「${String(v).trim()}」不存在，可选：${lookups().regions.map(x => x.label).join(' / ')}`, k)
  return r.code
}
const pQuality = (v, k) => F.toEnum(v, k, '清晰度', F.QUALITY_WORDS, ['标清', '高清', '超清'])

/* ---------------- 元数据 / 统计 / 字段 ---------------- */

export function meta() {
  return {
    topics: A.metaTopics(),
    creators: A.metaCreators(),
    categories: A.categories(),
    regions: A.regions(),
    qualities: F.QUALITIES,
    statuses: F.STATUSES,
    postKinds: F.POST_KINDS,
    topicKinds: F.TOPIC_KINDS,
    creatorStatuses: F.CREATOR_STATUSES,
    mediaBase: '/media/'
  }
}

/*
 * 概览统计缓存 5 秒：几万条视频时每次都重算会拖慢 App；后台任何写操作后由路由层调 invalidateStats() 清掉，
 * 所以管理员自己改完马上能看到新数字。缓存的是 Promise，同时进来的请求共用一次计算。
 */
const STATS_TTL = 5000
let statsCache = null
export function stats() {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL) return statsCache.value
  const value = (async () => ({ ...A.stats(), media: await mediaStats() }))()
  const entry = statsCache = { at: Date.now(), value }
  value.catch(() => { if (statsCache === entry) statsCache = null })
  return value
}
export function invalidateStats() {
  statsCache = null
}

export const schema = () => F.buildSchema(lookups())

/* ---------------- 视频 ---------------- */

const VIDEO_SPEC = {
  publicId: {
    col: 'public_id', label: '编号',
    parse: (v, k) => {
      const s = F.toText(v, k, '编号', { max: 64 })
      if (/\s/.test(s)) fail('编号不能包含空格', k)
      return s
    }
  },
  title: { col: 'title', label: '标题', required: '标题不能为空', parse: pText('标题', 200, true) },
  description: { col: 'description', label: '简介', blank: '', parse: pText('简介', 5000) },
  topicId: { col: 'topic_id', label: '专题', nullable: true, parse: pTopicRef },
  creatorId: { col: 'creator_id', label: '创作者', nullable: true, parse: pCreatorRef },
  categoryKey: { col: 'category_key', label: '分类', nullable: true, parse: pCategory },
  region: { col: 'region', label: '地区', nullable: true, parse: pRegion },
  quality: { col: 'quality', label: '清晰度', blank: 'hd', parse: pQuality },
  tags: { col: 'tags', label: '标签', blank: '[]', parse: (v, k) => JSON.stringify(F.toTags(v, k, { hash: true })) },
  durationSec: { col: 'duration_sec', label: '时长', blank: 0, parse: (v, k) => F.toDuration(v, k) },
  coverUrl: { col: 'cover_url', label: '封面地址', nullable: true, parse: pUrl('封面地址') },
  playbackUrl: { col: 'playback_url', label: '播放地址', nullable: true, parse: pUrl('播放地址') },
  status: { col: 'status', label: '状态', parse: pStatus },
  publishedAt: { col: 'published_at', label: '发布时间', parse: pTime('发布时间') }
}

/** VID-<n>：n = 现有最大数字编号 + 1（至少 1001），跳过已占用的；导入时在 ctx 里续号，不用每行查最大值 */
function nextPublicId(ctx) {
  let n = ctx?.vidNext ?? Math.max(A.maxVidNumber() + 1, 1001)
  while (A.publicIdTaken('VID-' + n)) n++
  if (ctx) ctx.vidNext = n + 1
  return 'VID-' + n
}

function createVideo(body, ctx = {}) {
  requireObject(body)
  const cols = collect(body, VIDEO_SPEC, { create: true })
  const isShort = optBool(body, 'isShort', '短视频')
  return tx(() => {
    if (cols.public_id) {
      if (A.publicIdTaken(cols.public_id)) fail('编号已存在', 'publicId')
    } else cols.public_id = nextPublicId(ctx)
    const t = now()
    cols.status ??= ctx.defaultStatus ?? 1
    cols.published_at ??= t
    cols.created_at = t
    // 轻量占位图（≤ 1.5 KB）：批量导入几万条时不至于让库膨胀、行溢出
    cols.cover_fallback = liteCover('vid-' + cols.public_id)
    const id = A.insertRow('videos', cols)
    if (isShort) A.setShort(id, true)
    if (!ctx.deferRecount) A.recountTopics()
    return id
  })
}

function updateVideo(id, body, ctx = {}) {
  requireObject(body)
  const row = A.videoRow(requireId(id))
  if (!row) fail('视频不存在')
  const cols = collect(body, VIDEO_SPEC, { create: false })
  const isShort = optBool(body, 'isShort', '短视频')
  tx(() => {
    if ('public_id' in cols && cols.public_id !== row.public_id && A.publicIdTaken(cols.public_id, id)) fail('编号已存在', 'publicId')
    A.updateRow('videos', id, changedOnly(row, cols))
    if (isShort !== undefined) A.setShort(id, isShort)
    if (!ctx.deferRecount && ('status' in cols || 'topic_id' in cols)) A.recountTopics()
  })
  return id
}

function deleteVideo(id) {
  if (!A.videoExists(requireId(id))) fail('视频不存在')
  tx(() => {
    A.deleteRows('videos', [id])
    A.recountTopics()
  })
  return { ok: true }
}

/* ---------------- 帖子 ---------------- */

const POST_SPEC = {
  creatorId: { col: 'creator_id', label: '发布者', required: '请选择发布者', parse: pCreatorRef },
  text: { col: 'text', label: '标题', required: '标题不能为空', parse: pText('标题', 5000, true) },
  content: { col: 'content', label: '详情正文', blank: '', parse: (v, k) => F.toLongText(v, k, '详情正文', { max: F.POST_CONTENT_MAX }) },
  mediaKind: { col: 'media_kind', label: '类型', blank: 1, parse: (v, k) => F.toEnum(v, k, '类型', F.POST_KIND_WORDS, ['视频', '图文', '文档']) },
  videoId: { col: 'video_id', label: '关联视频', nullable: true, parse: pVideoRef },
  tags: { col: 'tags', label: '标签', blank: '[]', parse: (v, k) => JSON.stringify(F.toTags(v, k, { hash: false })) },
  moreCount: { col: 'more_count', label: '折叠数', blank: 0, parse: pInt('折叠数', { min: 0 }) },
  readCount: { col: 'read_count', label: '阅读数', blank: 0, parse: pInt('阅读数', { min: 0 }) },
  isHot: { col: 'is_hot', label: '热门', blank: 0, parse: pBool('热门') },
  status: { col: 'status', label: '状态', parse: pStatus },
  publishedAt: { col: 'published_at', label: '发布时间', parse: pTime('发布时间') }
}

/** 主图 / 配图：undefined = 不改；null / 空 = 清空 */
function postMediaInput(body) {
  const main = body.mainImage === undefined ? undefined
    : (body.mainImage === null || String(body.mainImage).trim() === '' ? null : F.toUrl(body.mainImage, 'mainImage', '主图'))
  const images = body.images === undefined ? undefined
    : (body.images === null ? [] : F.toUrls(body.images, 'images', { label: '配图', max: 9 }))
  return { main, images }
}

/** 整体重写帖子的媒体行（主图 role 0，配图 role 1），占位图用帖子 id 做种子 */
function writePostMedia(postId, mediaKind, videoId, main, images) {
  const rows = []
  if (main) {
    rows.push({
      role: 0, mediaType: mediaKind === 1 ? 1 : 0, url: main, sortOrder: 0,
      fallback: liteCover(`post-${postId}-main`, { w: 800, h: 450 }),
      durationSec: videoId ? A.videoDuration(videoId) : null
    })
  }
  images.forEach((url, k) => rows.push({
    role: 1, mediaType: mediaKind === 2 ? 2 : 0, url, sortOrder: k,
    fallback: mediaKind === 2 ? liteDoc(`post-${postId}-${k}`) : liteCover(`post-${postId}-${k}`, { w: 360, h: 320 })
  }))
  A.replacePostMedia(postId, rows, images.length)
}

function createPost(body, ctx = {}) {
  requireObject(body)
  const cols = collect(body, POST_SPEC, { create: true })
  const { main, images } = postMediaInput(body)
  return tx(() => {
    const t = now()
    cols.media_kind ??= 1
    cols.status ??= ctx.defaultStatus ?? 1
    cols.published_at ??= t
    cols.created_at = t
    cols.thumb_count = images?.length ?? 0
    const id = A.insertRow('posts', cols)
    if (main !== undefined || images !== undefined) writePostMedia(id, cols.media_kind, cols.video_id ?? null, main ?? null, images ?? [])
    return id
  })
}

function updatePost(id, body) {
  requireObject(body)
  const row = A.postRow(requireId(id))
  if (!row) fail('帖子不存在')
  const cols = collect(body, POST_SPEC, { create: false })
  const { main, images } = postMediaInput(body)
  tx(() => {
    A.updateRow('posts', id, changedOnly(row, cols))
    const kind = cols.media_kind ?? row.media_kind
    const videoId = 'video_id' in cols ? cols.video_id : row.video_id
    // 关联视频真的换了才同步主图时长：原样保存 / 导出再导入不改 post_media
    const videoChanged = 'video_id' in cols && cols.video_id !== row.video_id
    if (main !== undefined || images !== undefined) {
      const cur = A.getPost(id)
      const nextMain = main !== undefined ? main : cur.mainImage
      const nextImages = images !== undefined ? images : cur.images
      // 内容没变就不重写：避免「原样保存 / 导出再导入」把原有的占位缩略图冲掉
      const same = nextMain === cur.mainImage && nextImages.length === cur.images.length &&
        nextImages.every((u, i) => u === cur.images[i]) && kind === row.media_kind
      if (!same) writePostMedia(id, kind, videoId, nextMain, nextImages)
      else if (videoChanged) A.syncPostMainDuration(id, videoId ? A.videoDuration(videoId) : null)
    } else if (videoChanged) {
      A.syncPostMainDuration(id, videoId ? A.videoDuration(videoId) : null)
    }
  })
  return id
}

function deletePost(id) {
  if (!A.postRow(requireId(id))) fail('帖子不存在')
  A.deleteRows('posts', [id])
  return { ok: true }
}

/* ---------------- 专题 ---------------- */

const TOPIC_SPEC = {
  name: { col: 'name', label: '名称', required: '名称不能为空', parse: pText('名称', 40, true) },
  slug: {
    col: 'slug', label: '标识',
    parse: (v, k) => {
      const s = String(v).trim().toLowerCase()
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(s)) fail('标识只能用小写字母、数字和 -，以字母或数字开头，最多 48 位', k)
      return s
    }
  },
  description: { col: 'description', label: '简介', blank: '', parse: pText('简介', 500) },
  kind: { col: 'kind', label: '类型', blank: 0, parse: (v, k) => F.toEnum(v, k, '类型', F.TOPIC_KIND_WORDS, ['普通', '首页分区', '片库分类']) },
  sortOrder: { col: 'sort_order', label: '排序', parse: pInt('排序', { min: -1e9, max: 1e9 }) },
  isFeatured: { col: 'is_featured', label: '大卡', blank: 0, parse: pBool('大卡') },
  cardSize: { col: 'card_size', label: '首屏数量', blank: 4, parse: pInt('首屏数量', { min: 1, max: 20 }) },
  playsCount: { col: 'plays_count', label: '播放数', blank: 0, parse: pInt('播放数', { min: 0 }) },
  status: { col: 'status', label: '状态', parse: pStatus }
}

/** 头图固定 4 格：先放填写的地址，不足的用生成的占位图补齐，专题页 hero 永远是满的 */
function writeTopicCovers(topicId, urls) {
  const rows = []
  for (let k = 0; k < 4; k++) {
    rows.push({
      url: urls[k] ?? null,
      fallback: liteCover(`hero-${topicId}-${k}`, { w: 300, h: 600 })
    })
  }
  A.replaceTopicCovers(topicId, rows)
}

const coversInput = body => (body.covers === undefined ? undefined
  : body.covers === null ? [] : F.toUrls(body.covers, 'covers', { label: '头图', max: 4 }))

/** 不重复的临时值：先占位插入拿到 id，再改成 topic-<id> / c<id> */
const tempKey = prefix => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

function createTopic(body, ctx = {}) {
  requireObject(body)
  const cols = collect(body, TOPIC_SPEC, { create: true })
  const covers = coversInput(body)
  return tx(() => {
    if (cols.slug && A.slugTaken(cols.slug)) fail('标识已存在', 'slug')
    const autoSlug = !cols.slug
    if (autoSlug) cols.slug = tempKey('tmp-')
    cols.sort_order ??= A.nextTopicSort()
    cols.status ??= ctx.defaultStatus ?? 1
    cols.created_at = now()
    const id = A.insertRow('topics', cols)
    if (autoSlug) {
      let slug = 'topic-' + id
      for (let n = 2; A.slugTaken(slug, id); n++) slug = `topic-${id}-${n}`
      A.updateRow('topics', id, { slug })
    }
    writeTopicCovers(id, covers ?? [])
    return id
  })
}

function updateTopic(id, body, ctx = {}) {
  requireObject(body)
  const row = A.topicRow(requireId(id))
  if (!row) fail('专题不存在')
  const cols = collect(body, TOPIC_SPEC, { create: false })
  const covers = coversInput(body)
  tx(() => {
    if ('slug' in cols && cols.slug !== row.slug && A.slugTaken(cols.slug, id)) fail('标识已存在', 'slug')
    A.updateRow('topics', id, changedOnly(row, cols))
    if (covers !== undefined) {
      const cur = A.topicCoverRows(id)
      const curUrls = cur.map(c => c.url).filter(Boolean)
      const same = cur.length === 4 && curUrls.length === covers.length && covers.every((u, i) => u === cur[i].url)
      if (!same) writeTopicCovers(id, covers)
    }
    if (!ctx.deferRecount && 'status' in cols) A.recountTopics()
  })
  return id
}

function deleteTopic(id) {
  if (!A.topicRow(requireId(id))) fail('专题不存在')
  return tx(() => {
    const impact = A.topicDeleteImpact(id)
    A.deleteRows('topics', [id])
    A.recountTopics()
    return { ok: true, deletedSections: impact.sections, detachedVideos: impact.videos }
  })
}

/* ---------------- 创作者 ---------------- */

const HANDLE_RE = /^[A-Za-z0-9_.-]{2,32}$/
const CREATOR_SPEC = {
  handle: {
    col: 'handle', label: '账号',
    parse: (v, k) => {
      const s = String(v).trim().replace(/^[@＠]+/, '')
      if (!HANDLE_RE.test(s)) fail('账号需为 2-32 位字母、数字或 _ . -', k)
      return s
    }
  },
  name: { col: 'name', label: '名称', required: '名称不能为空', parse: pText('名称', 30, true) },
  avatarUrl: { col: 'avatar_url', label: '头像', nullable: true, parse: pUrl('头像') },
  bio: { col: 'bio', label: '简介', blank: '', parse: pText('简介', 200) },
  isVerified: { col: 'is_verified', label: '认证', blank: 0, parse: pBool('认证') },
  isOfficial: { col: 'is_official', label: '官方', blank: 0, parse: pBool('官方') },
  status: { col: 'status', label: '状态', parse: (v, k) => F.toEnum(v, k, '状态', F.CREATOR_STATUS_WORDS, ['正常', '停用']) }
}

function createCreator(body) {
  requireObject(body)
  const cols = collect(body, CREATOR_SPEC, { create: true })
  return tx(() => {
    if (cols.handle && A.handleTaken(cols.handle)) fail('账号已存在', 'handle')
    const autoHandle = !cols.handle
    if (autoHandle) cols.handle = tempKey('tmp-')
    cols.status ??= 1
    cols.created_at = now()
    const id = A.insertRow('creators', cols)
    if (autoHandle) {
      let handle = 'c' + id
      for (let n = 2; A.handleTaken(handle, id); n++) handle = `c${id}-${n}`
      cols.handle = handle
      A.updateRow('creators', id, { handle })
    }
    A.setCreatorAvatarFallback(id, avatar(cols.name, cols.handle).fallback)
    return id
  })
}

function updateCreator(id, body) {
  requireObject(body)
  const row = A.creatorRow(requireId(id))
  if (!row) fail('创作者不存在')
  const cols = collect(body, CREATOR_SPEC, { create: false })
  tx(() => {
    if ('handle' in cols && cols.handle !== row.handle && A.handleTaken(cols.handle, id)) fail('账号已存在', 'handle')
    // 首字头像跟着名字走
    if ('name' in cols && cols.name !== row.name) cols.avatar_fallback = avatar(cols.name, cols.handle ?? row.handle).fallback
    A.updateRow('creators', id, changedOnly(row, cols))
  })
  return id
}

function deleteCreator(id) {
  if (!A.creatorRow(requireId(id))) fail('创作者不存在')
  return tx(() => {
    const impact = A.creatorsDeleteImpact([id])
    A.deleteRows('creators', [id])
    return { ok: true, deletedPosts: impact.posts, detachedVideos: impact.videos }
  })
}

/* ---------------- 搜索热词 ---------------- */

const KEYWORD_SPEC = {
  word: { col: 'word', label: '热词', required: '热词不能为空', parse: pText('热词', 20, true) },
  isHot: { col: 'is_hot', label: '火焰标', blank: 0, parse: pBool('火焰标') },
  isBanned: { col: 'is_banned', label: '屏蔽', blank: 0, parse: pBool('屏蔽') },
  weight: { col: 'weight', label: '权重', blank: 0, parse: pInt('权重', { min: -1e9, max: 1e9 }) },
  sortOrder: { col: 'sort_order', label: '排序', blank: 0, parse: pInt('排序', { min: -1e9, max: 1e9 }) }
}

function createKeyword(body) {
  requireObject(body)
  const cols = collect(body, KEYWORD_SPEC, { create: true })
  if (A.keywordIdByWord(cols.word)) fail('热词已存在', 'word')
  cols.sort_order ??= A.nextKeywordSort()
  cols.updated_at = now()
  return A.insertRow('search_keywords', cols)
}

function updateKeyword(id, body) {
  requireObject(body)
  const row = A.keywordRow(requireId(id))
  if (!row) fail('热词不存在')
  const cols = collect(body, KEYWORD_SPEC, { create: false })
  if ('word' in cols) {
    const other = A.keywordIdByWord(cols.word)
    if (other && other !== id) fail('热词已存在', 'word')
  }
  // 值都没变就不动 updated_at（导出再原样导入不算修改）
  if (Object.keys(cols).some(k => cols[k] !== row[k])) {
    cols.updated_at = now()
    A.updateRow('search_keywords', id, cols)
  }
  return id
}

function deleteKeyword(id) {
  if (!A.getKeyword(requireId(id))) fail('热词不存在')
  A.deleteRows('search_keywords', [id])
  return { ok: true }
}

/* ---------------- 按类型分派（路由用） ---------------- */

const TYPES = {
  videos: { list: A.listVideos, get: A.getVideo, create: createVideo, update: updateVideo, remove: deleteVideo, notFound: '视频不存在' },
  posts: { list: A.listPosts, get: A.getPost, create: createPost, update: updatePost, remove: deletePost, notFound: '帖子不存在' },
  topics: { list: A.listTopics, get: A.getTopic, create: createTopic, update: updateTopic, remove: deleteTopic, notFound: '专题不存在' },
  creators: { list: A.listCreators, get: A.getCreator, create: createCreator, update: updateCreator, remove: deleteCreator, notFound: '创作者不存在' },
  keywords: { list: A.listKeywords, get: A.getKeyword, create: createKeyword, update: updateKeyword, remove: deleteKeyword, notFound: '热词不存在' }
}

const typeOf = type => TYPES[type] || fail('未知的数据类型：' + type)

export function list(type, q = {}) {
  const t = typeOf(type)
  const p = paging(q)
  const { total, list } = t.list(FILTERS[type](q), p)
  return { total, page: p.page, pageSize: p.pageSize, list }
}

export function getOne(type, id) {
  const t = typeOf(type)
  const row = t.get(requireId(id))
  if (!row) fail(t.notFound)
  return row
}

export function create(type, body) {
  const t = typeOf(type)
  return t.get(t.create(body || {}))
}

export function update(type, id, body) {
  const t = typeOf(type)
  return t.get(t.update(id, body || {}))
}

export function remove(type, id) {
  return typeOf(type).remove(id)
}

/* ---------------- 批量操作 ---------------- */

/** 单个 ID：只认数字或纯数字字符串（[5]、true 这类 Number() 能转出数字的不算），其余返回 NaN */
const idNum = x => (typeof x === 'number' || (typeof x === 'string' && /^\s*\d+\s*$/.test(x)) ? Number(x) : NaN)

function parseIds(v, max = 5000) {
  if (!Array.isArray(v) || !v.length) fail('请先选择要操作的数据', 'ids')
  if (v.length > max) fail(`一次最多操作 ${max} 条`, 'ids')
  const ids = [...new Set(v.map(idNum))]
  if (!ids.every(n => Number.isSafeInteger(n) && n > 0)) fail('ids 只能是正整数', 'ids')
  return ids
}

const isNullish = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/** 批量加 / 删标签；超过 20 个的部分不再加（单条视频标签上限） */
function batchTags(ids, value, { hash, read, write, add }) {
  const tags = F.toTags(value, 'value', { hash })
  if (!tags.length) fail('请填写标签', 'value')
  let affected = 0
  for (const r of read(ids)) {
    const cur = parseTags(r.tags)
    const next = add
      ? [...cur, ...tags.filter(t => !cur.includes(t))].slice(0, Math.max(cur.length, 20))
      : cur.filter(t => !tags.includes(t))
    if (next.length !== cur.length || next.some((t, i) => t !== cur[i])) affected += write(r.id, next)
  }
  return affected
}

/* 用 Map 查动作名：普通对象的 action in / [action] 会命中 toString、__proto__ 这类继承来的键 */
const STATUS_ACTIONS = new Map([['publish', 1], ['unpublish', 2], ['draft', 0]])
const CREATOR_ACTIONS = new Map([['enable', ['status', 1]], ['disable', ['status', 0]], ['verify', ['is_verified', 1]], ['unverify', ['is_verified', 0]]])
const KEYWORD_ACTIONS = new Map([['hot', ['is_hot', 1]], ['unhot', ['is_hot', 0]], ['ban', ['is_banned', 1]], ['unban', ['is_banned', 0]]])

export function batch(type, body) {
  typeOf(type)
  requireObject(body)
  const ids = parseIds(body.ids)
  const { action, value } = body
  if (typeof action !== 'string') fail('缺少 action', 'action')
  const unsupported = () => fail(`不支持的批量操作：${action}`, 'action')

  return tx(() => {
    switch (type) {
      case 'videos': {
        let affected
        if (STATUS_ACTIONS.has(action)) affected = A.setColumn('videos', ids, 'status', STATUS_ACTIONS.get(action))
        else if (action === 'delete') affected = A.deleteRows('videos', ids)
        else if (action === 'setTopic') affected = A.setColumn('videos', ids, 'topic_id', isNullish(value) ? null : pTopicRef(value, 'value'))
        else if (action === 'setCreator') affected = A.setColumn('videos', ids, 'creator_id', isNullish(value) ? null : pCreatorRef(value, 'value'))
        else if (action === 'setCategory') affected = A.setColumn('videos', ids, 'category_key', isNullish(value) ? null : pCategory(value, 'value'))
        else if (action === 'setRegion') affected = A.setColumn('videos', ids, 'region', isNullish(value) ? null : pRegion(value, 'value'))
        else if (action === 'setQuality') {
          if (isNullish(value)) fail('请选择清晰度', 'value')
          affected = A.setColumn('videos', ids, 'quality', pQuality(value, 'value'))
        } else if (action === 'addTags' || action === 'removeTags') {
          affected = batchTags(ids, value, { hash: true, read: A.videoTags, write: A.setVideoTags, add: action === 'addTags' })
        } else if (action === 'addShort' || action === 'removeShort') {
          affected = 0
          for (const id of A.existingIds('videos', ids)) affected += A.setShort(id, action === 'addShort')
        } else unsupported()
        if (['delete', 'setTopic'].includes(action) || STATUS_ACTIONS.has(action)) A.recountTopics()
        return { affected }
      }
      case 'posts': {
        let affected
        if (STATUS_ACTIONS.has(action)) affected = A.setColumn('posts', ids, 'status', STATUS_ACTIONS.get(action))
        else if (action === 'delete') affected = A.deleteRows('posts', ids)
        else if (action === 'setHot' || action === 'unsetHot') affected = A.setColumn('posts', ids, 'is_hot', action === 'setHot' ? 1 : 0)
        else if (action === 'setCreator') {
          if (isNullish(value)) fail('请选择发布者', 'value')
          affected = A.setColumn('posts', ids, 'creator_id', pCreatorRef(value, 'value'))
        } else if (action === 'addTags' || action === 'removeTags') {
          affected = batchTags(ids, value, { hash: false, read: A.postTags, write: A.setPostTags, add: action === 'addTags' })
        } else unsupported()
        return { affected }
      }
      case 'topics': {
        if (STATUS_ACTIONS.has(action)) {
          const affected = A.setColumn('topics', ids, 'status', STATUS_ACTIONS.get(action))
          return { affected }
        }
        if (action === 'delete') {
          const impact = A.topicsDeleteImpact(ids)
          const affected = A.deleteRows('topics', ids)
          A.recountTopics()
          return { affected, deletedSections: impact.sections, detachedVideos: impact.videos }
        }
        return unsupported()
      }
      case 'creators': {
        const set = CREATOR_ACTIONS.get(action)
        if (set) return { affected: A.setColumn('creators', ids, set[0], set[1]) }
        if (action === 'delete') {
          const impact = A.creatorsDeleteImpact(ids)
          const affected = A.deleteRows('creators', ids)
          return { affected, deletedPosts: impact.posts, detachedVideos: impact.videos }
        }
        return unsupported()
      }
      case 'keywords': {
        if (action === 'delete') return { affected: A.deleteRows('search_keywords', ids) }
        const set = KEYWORD_ACTIONS.get(action)
        if (!set) return unsupported()
        const affected = A.setColumn('search_keywords', ids, set[0], set[1])
        A.touchKeywords(ids)
        return { affected }
      }
    }
    return unsupported()
  })
}

/** PUT /topics/order：按给定顺序把 sort_order 设成 0,1,2… */
export function reorderTopics(body) {
  requireObject(body)
  const ids = parseIds(body.ids)
  return { affected: tx(() => A.reorderTopics(ids)) }
}

/* ---------------- 首页推荐分区 ---------------- */

const SECTION_STATUS_WORDS = new Map([['1', 1], ['启用', 1], ['显示', 1], ['true', 1], ['0', 0], ['停用', 0], ['隐藏', 0], ['false', 0]])
const SECTION_SPEC = {
  title: { col: 'title', label: '标题', required: '标题不能为空', parse: pText('标题', 30, true) },
  subtitle: { col: 'subtitle', label: '副标题', blank: '', parse: pText('副标题', 60) },
  topicId: { col: 'topic_id', label: '关联专题', nullable: true, parse: pTopicRef },
  isFeatured: { col: 'is_featured', label: '大卡', blank: 0, parse: pBool('大卡') },
  cardSize: { col: 'card_size', label: '首屏数量', blank: 4, parse: pInt('首屏数量', { min: 1, max: 20 }) },
  sortOrder: { col: 'sort_order', label: '排序', parse: pInt('排序', { min: -1e9, max: 1e9 }) },
  status: {
    col: 'status', label: '状态',
    parse: (v, k) => (typeof v === 'boolean' ? (v ? 1 : 0) : F.toEnum(v, k, '状态', SECTION_STATUS_WORDS, ['启用', '停用']))
  }
}

export const listSections = () => ({ list: A.listSections() })

export function createSection(body) {
  requireObject(body)
  const cols = collect(body, SECTION_SPEC, { create: true })
  const id = tx(() => {
    cols.sort_order ??= A.nextSectionSort()
    cols.status ??= 1
    cols.updated_at = now()
    const id = A.insertRow('home_sections', cols)
    if (cols.is_featured) A.clearFeaturedSections(id)
    return id
  })
  return A.getSection(id)
}

export function updateSection(id, body) {
  requireObject(body)
  if (!A.sectionRow(requireId(id))) fail('分区不存在')
  const cols = collect(body, SECTION_SPEC, { create: false })
  tx(() => {
    cols.updated_at = now()
    A.updateRow('home_sections', id, cols)
    if (cols.is_featured) A.clearFeaturedSections(id)
  })
  return A.getSection(id)
}

export function deleteSection(id) {
  if (!A.sectionRow(requireId(id))) fail('分区不存在')
  A.deleteRows('home_sections', [id])
  return { ok: true }
}

export function reorderSections(body) {
  requireObject(body)
  const ids = parseIds(body.ids)
  return { affected: tx(() => A.reorderSections(ids)) }
}

export function getSectionItems(id) {
  if (!A.sectionRow(requireId(id))) fail('分区不存在')
  return { batches: A.sectionItems(id) }
}

const MAX_BATCHES = 20, MAX_PER_BATCH = 60

/** 整体替换分区内容：批次内去重，空批次去掉（App 按批次号连续翻页） */
export function saveSectionItems(id, body) {
  requireObject(body)
  if (!A.sectionRow(requireId(id))) fail('分区不存在')
  const { batches } = body
  if (!Array.isArray(batches)) fail('batches 必须是二维数组', 'batches')
  if (batches.length > MAX_BATCHES) fail(`最多 ${MAX_BATCHES} 批`, 'batches')
  const clean = []
  for (const [i, b] of batches.entries()) {
    if (!Array.isArray(b)) fail(`第 ${i + 1} 批不是数组`, 'batches')
    const ids = [...new Set(b.map(idNum))]
    if (!ids.every(n => Number.isSafeInteger(n) && n > 0)) fail(`第 ${i + 1} 批里有不正确的视频 ID`, 'batches')
    if (ids.length > MAX_PER_BATCH) fail(`每批最多 ${MAX_PER_BATCH} 个视频（第 ${i + 1} 批有 ${ids.length} 个）`, 'batches')
    if (ids.length) clean.push(ids)
  }
  const all = [...new Set(clean.flat())]
  const known = new Set(A.existingIds('videos', all))
  const missing = all.filter(v => !known.has(v))
  if (missing.length) fail(`以下视频不存在：${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`, 'batches')
  tx(() => A.replaceSectionItems(id, clean))
  return { batches: A.sectionItems(id) }
}

/**
 * 自动生成：从候选池里按「换一批」的规则轮转取视频（与 seed 一致）
 *   第 n 批取 pool[(n*size + k) % pool.length]，k < size
 */
export function rebuildSection(id, body) {
  requireObject(body)
  const sec = A.sectionRow(requireId(id))
  if (!sec) fail('分区不存在')
  const source = body.source
  if (!['topic', 'hot', 'latest'].includes(source)) fail('来源只能是 topic / hot / latest', 'source')
  const batches = body.batches === undefined ? 4 : F.toInt(body.batches, 'batches', '批数', { min: 1, max: MAX_BATCHES })
  const size = body.size === undefined || body.size === null || body.size === ''
    ? sec.card_size
    : F.toInt(body.size, 'size', '每批数量', { min: 1, max: MAX_PER_BATCH })
  if (source === 'topic' && !sec.topic_id) fail('这个分区没有关联专题，不能按专题生成', 'source')
  const pool = A.sectionPool(source, sec.topic_id)
  if (!pool.length) fail(source === 'topic' ? '关联专题下还没有已发布的视频' : '还没有已发布的视频', 'source')
  const out = []
  for (let n = 0; n < batches; n++) {
    const b = []
    for (let k = 0; k < size; k++) {
      const vid = pool[(n * size + k) % pool.length]
      if (!b.includes(vid)) b.push(vid)
    }
    out.push(b)
  }
  tx(() => A.replaceSectionItems(id, out))
  return { batches: A.sectionItems(id) }
}

/* ---------------- 批量导入 ---------------- */

const MAX_IMPORT_ROWS = 20000
const KEY_LABELS = { id: 'ID', publicId: '编号', playbackUrl: '播放地址', slug: '标识', name: '名称', handle: '账号', word: '热词' }

/** 引用单元格：只收字符串 / 数字（['2'] 这类数组不能 String() 成 '2' 再去匹配） */
const refCell = (cell, field, label) => String(F.scalar(cell, field, label)).trim()

/**
 * 引用解析：专题（id → 名称（精确） → 标识（不区分大小写）），按名称找不到时按需自动创建。
 * 名称排在标识前面：英文名称的专题（如 Anime）不会被另一个专题的标识 anime 抢走。
 * 导出时 exportRows 的 topicRef 按同样的顺序挑写法，保证导出 → 再导入还是同一个专题。
 */
function resolveTopic(cell, ctx) {
  const s = refCell(cell, 'topicId', '专题')
  if (/^\d+$/.test(s) && A.topicRow(Number(s))) return Number(s)
  const id = A.topicIdByName(s) ?? A.topicIdBySlug(s.toLowerCase())
  if (id) return id
  if (/^\d+$/.test(s) || !ctx.autoCreate) fail(`专题「${s}」不存在`, 'topicId')
  try {
    const newId = createTopic({ name: s }, { defaultStatus: 1 })
    ctx.pending.topics.push(s)
    return newId
  } catch (e) {
    if (e instanceof InputError) fail(`自动创建专题「${s}」失败：${e.message}`, 'topicId')
    throw e
  }
}

/** 引用解析：创作者（@账号 只按账号；否则 id → 账号 → 名称），找不到时按需自动创建 */
function resolveCreator(cell, ctx, field = 'creatorId') {
  const s = refCell(cell, field, '创作者')
  const at = /^[@＠]/.test(s)
  const bare = s.replace(/^[@＠]+/, '').trim()
  if (!bare) fail('创作者不能为空', field)
  if (!at && /^\d+$/.test(bare) && A.creatorRow(Number(bare))) return Number(bare)
  const id = A.creatorIdByHandle(bare) ?? (at ? null : A.creatorIdByName(bare))
  if (id) return id
  if ((!at && /^\d+$/.test(bare)) || !ctx.autoCreate) fail(`创作者「${s}」不存在`, field)
  try {
    const newId = createCreator({ name: bare, handle: HANDLE_RE.test(bare) ? bare : '' })
    ctx.pending.creators.push(bare)
    return newId
  } catch (e) {
    if (e instanceof InputError) fail(`自动创建创作者「${s}」失败：${e.message}`, field)
    throw e
  }
}

/** 引用解析：视频（id → 编号） */
function resolveVideo(cell) {
  const s = refCell(cell, 'videoId', '关联视频')
  if (/^\d+$/.test(s) && A.videoRow(Number(s))) return Number(s)
  const id = A.videoIdByPublicId(s)
  if (!id) fail(`视频「${s}」不存在`, 'videoId')
  return id
}

/**
 * 按查重顺序找已有数据：返回 { id, by } 或 null；显式填了 ID 却不存在 → 报错。
 * 视频只用「第一个非空的键」（ID → 编号 → 播放地址）：填了编号但库里没有，就是新视频，
 * 不再退到播放地址去匹配 —— 否则几条共用同一个占位视频文件的新视频会互相覆盖编号和标题。
 * 播放地址按「同一个文件」比较：/media/a b.mp4 和 /media/a%20b.mp4 算重复（和扫描导入的「已导入」一致）。
 */
function findExisting(type, cells) {
  if (cells.id !== undefined) {
    const id = F.toInt(cells.id, 'id', 'ID', { min: 1 })
    const exists = { videos: A.videoRow, posts: A.postRow, topics: A.topicRow, creators: A.creatorRow }[type]?.(id)
    if (!exists) fail('ID 不存在', 'id')
    return { id, by: 'id' }
  }
  const tryKey = (by, id) => (id ? { id, by } : null)
  const str = (v, key) => String(F.scalar(v, key, KEY_LABELS[key] || key)).trim()
  switch (type) {
    case 'videos':
      if (cells.publicId !== undefined) return tryKey('publicId', A.videoIdByPublicId(str(cells.publicId, 'publicId')))
      if (cells.playbackUrl !== undefined) return tryKey('playbackUrl', A.videoIdByPlayback(str(cells.playbackUrl, 'playbackUrl')))
      return null
    case 'topics':
      return (cells.slug !== undefined && tryKey('slug', A.topicIdBySlug(str(cells.slug, 'slug').toLowerCase()))) ||
        (cells.name !== undefined && tryKey('name', A.topicIdByName(str(cells.name, 'name')))) || null
    case 'creators':
      return (cells.handle !== undefined && tryKey('handle', A.creatorIdByHandle(str(cells.handle, 'handle').replace(/^[@＠]+/, '')))) || null
    case 'keywords':
      return (cells.word !== undefined && tryKey('word', A.keywordIdByWord(str(cells.word, 'word')))) || null
  }
  return null
}

/** 导入列 → 接口请求体（引用解析成 id，列名换成接口字段名） */
function toBody(type, cells, ctx) {
  const body = {}
  for (const [k, v] of Object.entries(cells)) if (k !== 'id') body[k] = v
  const rename = (from, to, fn = x => x) => {
    if (from in body) { body[to] = fn(body[from]); delete body[from] }
  }
  if (type === 'videos') {
    rename('topic', 'topicId', v => resolveTopic(v, ctx))
    rename('creator', 'creatorId', v => resolveCreator(v, ctx))
    rename('category', 'categoryKey')
    rename('duration', 'durationSec')
  } else if (type === 'posts') {
    rename('creator', 'creatorId', v => resolveCreator(v, ctx))
    rename('kind', 'mediaKind')
    rename('video', 'videoId', v => resolveVideo(v))
  }
  return body
}

function importOne(type, raw, ctx, onDuplicate) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('这一行的数据格式不对（应为对象）')
  const cells = {}
  for (const key of F.fieldKeys(type)) {
    const v = F.cleanCell(raw[key])
    if (!F.isBlank(v)) cells[key] = v
  }
  if (!Object.keys(cells).length) return { status: 'skipped', message: '空行' }
  const t = TYPES[type]
  const match = findExisting(type, cells)
  if (match) {
    const by = KEY_LABELS[match.by] || match.by
    if (onDuplicate === 'skip') return { status: 'skipped', id: match.id, message: `已存在（按${by}匹配到 ID ${match.id}），已跳过` }
    if (onDuplicate === 'error') fail(`数据已存在（按${by}匹配到 ID ${match.id}）`, match.by)
    t.update(match.id, toBody(type, cells, ctx), ctx)
    // 写明按哪个键匹配到的：预检里就能看出「按播放地址匹配」这类可能不是本意的更新
    return { status: 'updated', id: match.id, message: `按${by}匹配到 ID ${match.id}，已更新` }
  }
  const id = t.create(toBody(type, cells, ctx), ctx)
  return { status: 'created', id }
}

let loggedImportErrors = 0

/*
 * 导入幂等（重发保护）：前端分块导入时每块带 options.importId + options.chunk。
 * 网络断了、超时后重发同一块，直接返回第一次的结果（加 replayed: true），不再碰数据库 —— 不会重复建数据。
 * 只缓存真导入（dryRun 不缓存）；键 = 管理员 id + 类型 + importId + chunk；
 * 进程内存 LRU：最多 500 条、1 小时过期，另按结果总行数封顶，避免几十万行结果占住内存。
 */
const REPLAY_MAX = 500
const REPLAY_TTL = 3600_000
const REPLAY_MAX_ROWS = 300_000
const replayCache = new Map()   // key → { at, rows, value }；Map 按插入顺序 = 最久没用的在前
let replayRows = 0

function replayDrop(key) {
  const e = replayCache.get(key)
  if (e) { replayRows -= e.rows; replayCache.delete(key) }
}
function replayGet(key) {
  const e = replayCache.get(key)
  if (!e) return null
  if (Date.now() - e.at > REPLAY_TTL) { replayDrop(key); return null }
  replayCache.delete(key)
  replayCache.set(key, e)         // 挪到末尾：最近用过
  return e.value
}
function replayPut(key, value) {
  const rows = value.results.length
  replayDrop(key)
  if (rows > REPLAY_MAX_ROWS) return
  replayCache.set(key, { at: Date.now(), rows, value })
  replayRows += rows
  const t = Date.now()
  for (const [k, e] of replayCache) {
    const over = replayCache.size > REPLAY_MAX || replayRows > REPLAY_MAX_ROWS
    if (over || t - e.at > REPLAY_TTL) replayDrop(k)
  }
}

/** options.importId / chunk → 缓存键；两个都有才缓存，填了但格式不对报错（多半是前端 bug，别悄悄当成没填） */
function replayKey(type, o, userId) {
  const has = v => v !== undefined && v !== null && v !== ''
  if (has(o.importId) && (typeof o.importId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.importId))) {
    fail('importId 只能是 1-64 位字母、数字、_ 或 -', 'importId')
  }
  const chunk = typeof o.chunk === 'string' && /^\d+$/.test(o.chunk) ? Number(o.chunk) : o.chunk
  if (has(o.chunk) && !(Number.isSafeInteger(chunk) && chunk >= 0)) fail('chunk 只能是不小于 0 的整数', 'chunk')
  if (!has(o.importId) || !has(o.chunk)) return null
  return `${userId ?? 0}|${type}|${o.importId}|${chunk}`
}

/**
 * 批量导入。整个请求一个事务，每行一个 SAVEPOINT：坏行回滚、报错，不影响其他行。
 * dryRun = 全部照做一遍，最后整体回滚 —— 预检结果（含文件内重复、自动创建）和真导入完全一致。
 *
 * 整个请求是同步执行的（同一个连接上不能让别的请求插进事务里），期间 App 的请求要排队：
 * 几万条视频的库里一千行约 0.2 秒、两万行约 5 秒。所以单次上限虽是 2 万行，脚本 / 前端都应分块
 * （后台页面预检每块 5000 行、真导入每块 1000 行），配合 importId + chunk 可安全重发。
 * @param {{ userId?: number }} [who] 当前管理员（重发缓存按人区分）
 */
export function importRows(type, body, who = {}) {
  if (!F.IMPORT_TYPES.includes(type)) fail('未知的导入类型：' + type)
  requireObject(body)
  const { rows } = body
  if (!Array.isArray(rows)) fail('rows 必须是数组', 'rows')
  if (rows.length > MAX_IMPORT_ROWS) fail(`一次最多导入 ${MAX_IMPORT_ROWS} 行，请分批导入`, 'rows')
  const o = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : {}
  const onDuplicate = o.onDuplicate ?? 'skip'
  if (!['skip', 'update', 'error'].includes(onDuplicate)) fail('onDuplicate 只能是 skip / update / error', 'onDuplicate')
  const ds = o.defaultStatus
  const defaultStatus = ds === undefined || ds === null ? 1
    : typeof ds === 'number' || (typeof ds === 'string' && /^\d$/.test(ds.trim())) ? Number(ds) : NaN
  if (![0, 1, 2].includes(defaultStatus)) fail('defaultStatus 只能是 0 / 1 / 2', 'defaultStatus')
  // 脚本 / curl 可能把布尔写成字符串；尤其 dryRun 认错了会把「预检」当成真导入
  const flag = (v, def) => (v === undefined || v === null ? def : v === true || v === 1 || v === 'true' || v === '1')
  const dryRun = flag(body.dryRun, false)
  const key = replayKey(type, o, who.userId)
  if (key && !dryRun) {
    const prev = replayGet(key)
    if (prev) return { ...prev, replayed: true }
  }

  const ctx = {
    autoCreate: flag(o.autoCreate, true),
    // 创作者没有「草稿」，默认状态只作用于视频 / 帖子 / 专题
    defaultStatus: type === 'creators' ? 1 : defaultStatus,
    deferRecount: true,
    pending: null
  }
  const out = {
    total: rows.length, created: 0, updated: 0, skipped: 0, failed: 0,
    results: [], autoCreated: { topics: [], creators: [] }
  }
  const counter = { created: 'created', updated: 'updated', skipped: 'skipped', error: 'failed' }

  if (db.isTransaction) throw new Error('导入时不应已处在事务中')
  db.exec('BEGIN')
  try {
    rows.forEach((raw, i) => {
      const rowNo = Number.isSafeInteger(Number(raw?._row)) && Number(raw._row) > 0 ? Number(raw._row) : i + 1
      ctx.pending = { topics: [], creators: [] }
      let r
      try {
        r = tx(() => importOne(type, raw, ctx, onDuplicate))
        out.autoCreated.topics.push(...ctx.pending.topics)
        out.autoCreated.creators.push(...ctx.pending.creators)
      } catch (e) {
        if (e instanceof InputError) {
          r = { status: 'error', message: e.message }
          if (e.field) r.field = F.apiToImportKey(type, e.field)
        } else {
          if (loggedImportErrors++ < 20) console.error(`[import ${type} 第 ${rowNo} 行]`, e)
          r = { status: 'error', message: '服务器内部错误' }
        }
      }
      out[counter[r.status]]++
      out.results.push({ row: rowNo, ...r })
    })
    A.recountTopics()
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  }
  if (key && !dryRun) replayPut(key, out)
  return out
}

/* ---------------- 导出 ---------------- */

const MAX_EXPORT = 50000
const digits = s => /^\d+$/.test(String(s))
/** 纯数字账号再导入时会被当成 id，导出时加 @ */
const creatorRef = handle => (handle ? (digits(handle) ? '@' + handle : handle) : '')

/**
 * 专题的导出写法：名称 → 标识 → ID，取第一个「按导入的解析规则（resolveTopic：ID → 名称 → 标识）读回来还是它」的。
 * 例：名称重复、纯数字名称、或名称和别的专题撞了 → 用标识；标识也读不回来（纯数字等）→ 用 ID。
 * 在内存里按全部专题模拟一遍，不用每行查库。
 */
function topicRefWriter() {
  const all = A.topicRefRows()                 // 按 id 升序：同名时和 topicIdByName 一样取 id 最小的
  const ids = new Set(all.map(t => t.id))
  const byName = new Map(), bySlug = new Map()
  for (const t of all) {
    if (!byName.has(t.name)) byName.set(t.name, t.id)
    if (t.slug && !bySlug.has(t.slug)) bySlug.set(t.slug, t.id)
  }
  const resolve = cell => {
    const s = String(F.cleanCell(cell) ?? '').trim()
    if (!s) return null
    if (digits(s) && ids.has(Number(s))) return Number(s)
    return byName.get(s) ?? bySlug.get(s.toLowerCase()) ?? null
  }
  return r => {
    if (!r.topic_id) return ''
    for (const cand of [r.topic_name, r.topic_slug]) if (cand && resolve(cand) === r.topic_id) return cand
    return String(r.topic_id)
  }
}

/**
 * 导出成「可直接再导入」的字符串：专题 → 名称（读不回同一个专题时用标识 / ID）、创作者 → 账号、
 * 时长 hh:mm:ss、状态 → 中文、时间 → 本地「YYYY-MM-DD HH:mm:ss」、布尔 → 是 / 否、多个地址用换行
 */
export function exportRows(type, q = {}) {
  typeOf(type)
  const f = FILTERS[type](q)
  const opts = { sort: q.sort, order: q.order, limit: MAX_EXPORT }
  const str = v => (v === null || v === undefined ? '' : String(v))
  let rows
  if (type === 'videos') {
    const topicRef = topicRefWriter()
    rows = A.exportVideos(f, opts).map(r => ({
      id: str(r.id), publicId: str(r.public_id), title: str(r.title), description: str(r.description),
      topic: topicRef(r), creator: creatorRef(r.creator_handle), category: str(r.category_key), region: str(r.region),
      quality: str(r.quality), tags: parseTags(r.tags).join(','), duration: F.fmtDuration(r.duration_sec),
      coverUrl: str(r.cover_url), playbackUrl: str(r.playback_url), status: F.statusLabel(r.status),
      publishedAt: F.fmtTimestamp(r.published_at), isShort: F.fmtBool(r.is_short)
    }))
  } else if (type === 'posts') {
    rows = A.exportPosts(f, opts).map(r => ({
      id: str(r.id), creator: creatorRef(r.creator_handle), text: str(r.text), content: str(r.content), kind: F.postKindLabel(r.media_kind),
      video: r.video_id ? (digits(r.video_public_id) || !r.video_public_id ? String(r.video_id) : r.video_public_id) : '',
      tags: parseTags(r.tags).join(','), mainImage: str(r.main_image), images: (r.images || []).join('\n'),
      moreCount: str(r.more_count), readCount: str(r.read_count), isHot: F.fmtBool(r.is_hot),
      status: F.statusLabel(r.status), publishedAt: F.fmtTimestamp(r.published_at)
    }))
  } else if (type === 'topics') {
    rows = A.exportTopics(f, opts).map(r => ({
      id: str(r.id), name: str(r.name), slug: str(r.slug), description: str(r.description), kind: F.topicKindLabel(r.kind),
      sortOrder: str(r.sort_order), isFeatured: F.fmtBool(r.is_featured), cardSize: str(r.card_size),
      playsCount: str(r.plays_count), status: F.statusLabel(r.status), covers: (r.covers || []).join('\n')
    }))
  } else if (type === 'creators') {
    rows = A.exportCreators(f, opts).map(r => ({
      id: str(r.id), handle: str(r.handle), name: str(r.name), avatarUrl: str(r.avatar_url), bio: str(r.bio),
      isVerified: F.fmtBool(r.is_verified), isOfficial: F.fmtBool(r.is_official), status: F.creatorStatusLabel(r.status)
    }))
  } else {
    rows = A.exportKeywords(f, opts).map(r => ({
      word: str(r.word), isHot: F.fmtBool(r.is_hot), isBanned: F.fmtBool(r.is_banned),
      weight: str(r.weight), sortOrder: str(r.sort_order)
    }))
  }
  return { fields: F.fieldKeys(type), rows }
}
