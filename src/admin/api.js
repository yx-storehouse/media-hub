/*
 * 管理后台接口：每个 /api/admin/* 接口对应一个函数（形状见 server/README.md「管理后台接口」）。
 *
 * 约定：
 *   列表   listX(query, { signal }) → { total, page, pageSize, list }
 *   导出   exportX(query) / exportRows(type, query) → { fields, rows, total, truncated, limit }（导入格式的字符串值；
 *          最多 limit 行（默认 5 万），超出时 truncated = true、total = 符合筛选的总数）
 *   增删改 getX(id) / createX(body) / updateX(id, partialBody) / deleteX(id)
 *   批量   batchX(ids, action, value) → { affected }
 *   导入   importRows(type, rows, options, dryRun) → { total, created, updated, unchanged, skipped, failed, results, autoCreated }
 *          （「更新已有」时和库里一样的行算 unchanged，不写库；updated 的行带 changed: [字段 key]）
 * 出错一律抛 ApiError（message 是给人看的中文，field 是出错字段），页面里 toastError(e) 即可。
 */
import { reactive } from 'vue'
import { get, post, patch, put, del, ApiError, MSG } from '@/api/http'
import { session, handleUnauthorized } from './auth'

const A = '/api/admin'
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')
/** 导入 / 导出可能要处理几万行，给足时间 */
const LONG = { timeout: 180000 }

/** 导出不分页：去掉 page / pageSize，其余筛选条件原样带上 */
const withoutPaging = (query = {}) => {
  const { page, pageSize, ...rest } = query
  return rest
}

/* ---------------- 元数据 / 概览 / 导入字段 ---------------- */

export const getMeta = () => get(`${A}/meta`)
export const getStats = () => get(`${A}/stats`)
export const getSchema = () => get(`${A}/schema`)

/* ---------------- 通用：导出 / 导入 ---------------- */

/** type: videos | posts | topics | creators | keywords | albums */
export const exportRows = (type, query) => get(`${A}/${type}/export`, withoutPaging(query), LONG)
export const importRows = (type, rows, options = {}, dryRun = false) =>
  post(`${A}/${type}/import`, { rows, options, dryRun }, LONG)

/* 各类内容的增删改查形状完全一样，用一个工厂生成，下面再逐个具名导出（方便搜索和自动补全） */
function resource(type) {
  return {
    list: (query, { signal } = {}) => get(`${A}/${type}`, query, { signal }),
    export: query => exportRows(type, query),
    get: id => get(`${A}/${type}/${encodeURIComponent(id)}`),
    create: body => post(`${A}/${type}`, body),
    update: (id, body) => patch(`${A}/${type}/${encodeURIComponent(id)}`, body),
    remove: id => del(`${A}/${type}/${encodeURIComponent(id)}`),
    batch: (ids, action, value) => post(`${A}/${type}/batch`, value === undefined ? { ids, action } : { ids, action, value }, LONG)
  }
}

/* ---------------- 视频 ---------------- */
const videos = resource('videos')
export const listVideos = videos.list
export const exportVideos = videos.export
export const getVideo = videos.get
export const createVideo = videos.create
export const updateVideo = videos.update
export const deleteVideo = videos.remove
export const batchVideos = videos.batch

/* ---------------- 帖子 ---------------- */
const posts = resource('posts')
export const listPosts = posts.list
export const exportPosts = posts.export
export const getPost = posts.get
export const createPost = posts.create
export const updatePost = posts.update
export const deletePost = posts.remove
export const batchPosts = posts.batch

/* ---------------- 专题 ---------------- */
const topics = resource('topics')
export const listTopics = topics.list
export const exportTopics = topics.export
export const getTopic = topics.get
export const createTopic = topics.create
export const updateTopic = topics.update
/** 删除专题会连带删掉引用它的首页分区，返回 { ok, deletedSections, detachedVideos } */
export const deleteTopic = topics.remove
export const batchTopics = topics.batch
/** 按给定顺序重排（sort_order = 下标） */
export const reorderTopics = ids => put(`${A}/topics/order`, { ids })

/* ---------------- 创作者 ---------------- */
const creators = resource('creators')
export const listCreators = creators.list
export const exportCreators = creators.export
export const getCreator = creators.get
export const createCreator = creators.create
export const updateCreator = creators.update
/** 删除创作者会连带删掉其帖子和图集，返回 { ok, deletedPosts, deletedAlbums, detachedVideos } */
export const deleteCreator = creators.remove
export const batchCreators = creators.batch

/* ---------------- 搜索热词 ---------------- */
const keywords = resource('keywords')
export const listKeywords = keywords.list
export const exportKeywords = keywords.export
/** 深链 ?edit=<id> 时先从当前列表里找，找不到再用单条查询兜底 */
export const getKeyword = keywords.get
export const createKeyword = keywords.create
export const updateKeyword = keywords.update
export const deleteKeyword = keywords.remove
export const batchKeywords = keywords.batch

/* ---------------- 图集（创作者主页「图片」） ---------------- */
const albums = resource('albums')
/** → { total, page, pageSize, list: AdminAlbum[] }（每行带 images: [{ url, width, height }]，第一张是封面） */
export const listAlbums = albums.list
export const exportAlbums = albums.export
export const getAlbum = albums.get
/** body: { creatorId, images: [{ url, width, height }], title?, description?, tags?, status?, publishedAt? } */
export const createAlbum = albums.create
/** images 是完整的新顺序（整体替换）；不传 = 不改图片 */
export const updateAlbum = albums.update
/** 只删记录，素材文件不动 */
export const deleteAlbum = albums.remove
/** action: publish | unpublish | delete | setCreator（value = 创作者 id） | addTags | removeTags */
export const batchAlbums = albums.batch

/* ---------------- 首页推荐分区 ---------------- */
/** → { list: AdminSection[] }（全部，按 sortOrder） */
export const listSections = () => get(`${A}/sections`)
export const createSection = body => post(`${A}/sections`, body)
export const updateSection = (id, body) => patch(`${A}/sections/${id}`, body)
export const deleteSection = id => del(`${A}/sections/${id}`)
export const reorderSections = ids => put(`${A}/sections/order`, { ids })
/** → { batches: VideoBrief[][] } */
export const getSectionItems = id => get(`${A}/sections/${id}/items`)
/** batches: 视频 id 的二维数组（每批一组），整体替换 */
export const saveSectionItems = (id, batches) => put(`${A}/sections/${id}/items`, { batches })
/** source: 'topic' | 'hot' | 'latest'；batches 批数；size 每批数量 */
export const rebuildSection = (id, { source, batches, size } = {}) => post(`${A}/sections/${id}/rebuild`, { source, batches, size })

/* ---------------- 账号（接口沿用原有的，字段是下划线风格） ---------------- */
/** → [{ id, uid, nickname, role, status, last_login_at, created_at }]（普通数组） */
export const listUsers = () => get(`${A}/users`)
export const createUser = body => post(`${A}/users`, body)
export const resetUserPassword = (id, newPassword) => post(`${A}/users/${id}/password`, { newPassword })
export const setUserStatus = (id, status) => post(`${A}/users/${id}/status`, { status })
export const setUserRole = (id, role) => post(`${A}/users/${id}/role`, { role })
export const deleteUser = id => del(`${A}/users/${id}`)

/* ---------------- 素材文件 ---------------- */
/**
 * → { dir, parent, entries: [{ name, path, type, size, mtime, url, usedBy, usedByAlbums, items?, thumb?, isThumb? }] }
 * usedBy 只数视频，usedByAlbums 只数图集；文件夹带 items（里面能看到的项数）；图片带 thumb（小图地址或 null）；
 * 原图已经不在的小图（<原图文件名>.thumb.jpg）带 isThumb: true（有原图的小图不单独列出）
 */
export const listMedia = (dir = '', { signal } = {}) => get(`${A}/media`, { dir }, { signal })
/** 已经存在时 400（field: path） */
export const createFolder = path => post(`${A}/media/folder`, { path })
/** 被视频 / 图集引用的文件需要 force=true 才能删 */
export const deleteMedia = (path, force = false) => del(`${A}/media`, { query: { path, force: force ? 1 : 0 } })
/**
 * 批量删除（1～1000 项）→ { deleted: [path], failed: [{ path, message }] }。
 * 没带 force 时只要有一个文件正被使用，整批不删，400（field: usedBy，message 列出是哪几个）
 */
export const deleteMediaMany = (paths, force = false) => post(`${A}/media/delete`, force ? { paths, force: true } : { paths }, LONG)
/** 改名（name 只是新名字，不能带 /）→ { from, to, url, type, refs }；库里引用它的地址一起改 */
export const renameMedia = (path, name) => post(`${A}/media/rename`, { path, name })
/** 移到另一个已有文件夹（to = '' 是根目录）→ { moved: [{ from, to, url, type }], failed: [{ path, message }], refs } */
export const moveMedia = (paths, to) => post(`${A}/media/move`, { paths, to }, LONG)
/** → { files: [{ path, url, name, title, size, mtime, coverUrl, imported, videoId }] } */
export const scanMedia = (dir = '', recursive = true) => post(`${A}/media/scan`, { dir, recursive }, { timeout: 60000 })

/**
 * 上传一个文件到素材目录（用 XHR 才拿得到上传进度）。
 * @param {string} path  相对 media/ 的路径，如 'covers/a.jpg'
 * @param {File|Blob} file
 * @param {{ overwrite?: boolean, onProgress?: (p: { loaded, total, percent }) => void, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ path, url, size }>}  失败抛 ApiError；取消抛 AbortError
 * 登录过期（401）：和其他接口一样弹「登录已过期」对话框，重新登录后用新令牌从头再传一次（只重传一次）。
 */
export async function uploadFile(path, file, opts = {}) {
  const token = session.token
  try {
    return await sendFile(path, file, token, opts)
  } catch (e) {
    if (e?.code !== 'unauthorized' || !token || opts.signal?.aborted) throw e
    const next = await waitOrAbort(Promise.resolve(handleUnauthorized(token, { wait: true })), opts.signal)
    if (!next || next === token) throw e
    return sendFile(path, file, next, opts)
  }
}

/* 等重新登录的时候上传被取消了：不再等 */
function waitOrAbort(p, signal) {
  if (!signal) return p
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('已取消', 'AbortError'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function sendFile(path, file, token, { overwrite = false, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('已取消', 'AbortError'))
    const xhr = new XMLHttpRequest()
    const qs = new URLSearchParams({ path, overwrite: overwrite ? '1' : '0' })
    xhr.open('PUT', `${BASE}${A}/media/upload?${qs}`)
    if (token) xhr.setRequestHeader('authorization', 'Bearer ' + token)
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')

    const onAbort = () => xhr.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => signal?.removeEventListener('abort', onAbort)

    xhr.upload.onprogress = e => {
      const total = e.lengthComputable ? e.total : file.size
      onProgress?.({ loaded: e.loaded, total, percent: total ? Math.min(100, Math.round((e.loaded / total) * 100)) : 0 })
    }
    xhr.onload = () => {
      done()
      if (xhr.status === 401) {
        return reject(new ApiError(token ? MSG.login : '请先登录', { status: 401, code: 'unauthorized' }))
      }
      let json = null
      try { json = JSON.parse(xhr.responseText) } catch { /* 下面统一报错 */ }
      if (xhr.status >= 200 && xhr.status < 300 && json?.code === 0) {
        // 覆盖了同名文件：地址没变但内容变了，记一下让页面上的缩略图重新加载
        if (overwrite && json.data?.url) mediaVersions[json.data.url] = Date.now()
        return resolve(json.data)
      }
      // 5xx / 网关页面：统一说法（和 http.js 一样）；4xx 用接口的说明
      const msg = xhr.status >= 500 ? MSG.server : json?.message || (xhr.status === 413 ? '文件太大，超过服务器允许的上限' : `上传失败（HTTP ${xhr.status}）`)
      reject(new ApiError(msg, { status: xhr.status, code: json?.code ?? 'bad_response', field: json?.field }))
    }
    xhr.onerror = () => { done(); reject(new ApiError('网络连接失败，上传中断', { code: 'network' })) }
    xhr.onabort = () => { done(); reject(new DOMException('已取消', 'AbortError')) }
    xhr.send(file)
  })
}

/* ---------------- 地址工具 ---------------- */

/**
 * 本次打开后台以来被覆盖上传过的文件：地址 → 时间戳。
 * 浏览器对同一地址的图片会直接用内存里的旧图，Thumb 据此给预览地址加 ?v=…（存进数据库的地址不变）。
 */
export const mediaVersions = reactive({})

/**
 * 预览用的地址：站内路径（/media/…）在接口与前端不同域部署时补上接口域名；外链原样返回。
 * 存进数据库的仍然是原始值，这里只影响后台里的 <img> / <video>。
 */
export function resolveUrl(url) {
  if (!url) return ''
  if (BASE && url.startsWith('/') && !url.startsWith('//')) return BASE + url
  return url
}

