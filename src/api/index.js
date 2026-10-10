/*
 * 数据接口层。
 *
 * 默认走 server/ 提供的 HTTP 接口（先跑 `node server/index.mjs`，见 server/README.md）。
 * 如果接口服务连不上（网络失败、超时、5xx、或者回话的根本不是接口服务），读取类请求会自动
 * 退回本地 mock 数据 —— 这样单看前端、断网、或者接口还没起来时，页面依然是满的，只提示一次。
 * 接口正常给出的业务错误（4xx：视频不存在、未登录…）照常抛给页面；写操作（点赞、收藏、
 * 观看记录）从不退回 mock，失败就报错，页面会回滚并提示。
 *
 * 想强制只用某一种：
 *   .env.local 里写 VITE_API_MODE=http   # 只用接口，失败就报错
 *   .env.local 里写 VITE_API_MODE=mock   # 只用本地假数据
 * 默认（不写）= auto：优先接口，连不上时读取退回 mock。
 *
 * 形状说明（HTTP 与 mock 两种实现都遵守）：
 *   Cover  { src: string|null, fallback?: string }   <Cover v-bind="cover">
 *   Video  { id, code, title, dur, len, cover, likes, liked, faved, ... }
 *   Post   { id, name, handle, verified, time, avatar, text, tags, kind: 'image'|'video'|'doc', dur, more, videoId, media: { main, thumbs } }
 * 页面里的列表都用 shallowRef 存放（整体替换，不做原地修改）。
 */
import { get, post, del } from './http'

/* ---------------- 运行模式 ---------------- */

const MODE = import.meta.env.VITE_API_MODE || 'auto'   // http | mock | auto
let useHttp = MODE !== 'mock'
let notifiedFallback = false

/**
 * 只有「接口服务连不上」才算不可用：网络失败、超时，或代理/服务端 5xx。
 * 4xx（视频不存在、参数不对、未登录…）是接口正常给出的答复，照常抛给页面处理，
 * 不能因此把整个应用切到演示数据。
 */
const isUnavailable = e => ['network', 'timeout', 'bad_response'].includes(e.code) || e.status >= 500

/** auto 模式下接口不可用时退回 mock，并只提示一次 */
async function call(path, { query, method = 'GET', body, mock } = {}) {
  const isWrite = method !== 'GET'
  // 已切到演示数据后，读取直接走 mock；写操作除非明确是 mock 模式，否则仍然打真实接口
  if (!useHttp && !(isWrite && MODE !== 'mock')) return mock()
  try {
    return await (isWrite ? post(path, body, { query }) : get(path, query))
  } catch (e) {
    // 写操作失败绝不假装成功，也不因此把整个应用切到演示数据
    if (MODE === 'http' || !mock || isWrite || !isUnavailable(e)) throw e
    if (useHttp) {
      useHttp = false
      console.warn('[api] 接口不可用，已切换到本地模拟数据：', e.message)
      if (!notifiedFallback) {
        notifiedFallback = true
        // 延迟到下一帧，避免在渲染过程中触发全局提示
        setTimeout(() => import('@/composables/useToast').then(m => m.toast('接口未连接，当前展示演示数据')), 0)
      }
    }
    return mock()
  }
}

/* ---------------- 本地假数据（接口不可用时使用） ---------------- */

const mockApi = () => import('./mock-fallback').then(m => m.default)

/* ---------------- 首页 ---------------- */

export const getHomeTabs = () => call('/api/home/tabs', { mock: () => mockApi().then(m => m.getHomeTabs()) })
export const getMainTabs = () => call('/api/main/tabs', { mock: () => mockApi().then(m => m.getMainTabs()) })
export const getRecommendSections = () => call('/api/home/recommend', { mock: () => mockApi().then(m => m.getRecommendSections()) })

/** 「换一批」：HTTP 用 batch 序号，mock 用 seed 字符串 */
export const getVideos = (sectionId, size = 4, batch = 0, seed = null) =>
  call(`/api/home/section/${sectionId}/videos`, {
    query: { size, batch },
    mock: () => mockApi().then(m => m.getVideos(seed ?? sectionId, size))
  })

export const getLatestFilters = () => call('/api/home/latest/filters', { mock: () => mockApi().then(m => m.getLatestFilters()) })
export const getLatestVideos = (opts = {}) =>
  call('/api/home/latest/videos', { query: { date: opts.date ?? 0, region: opts.region ?? 0, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getLatestVideos(opts)) })

export const getCategoryFilters = tab => call(`/api/category/${tab}/filters`, { mock: () => mockApi().then(m => m.getCategoryFilters()) })
export const getCategoryVideos = (tab, opts = {}) =>
  call(`/api/category/${tab}/videos`, { query: { filter: opts.filter ?? 0, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getCategoryVideos(tab, opts)) })

/* ---------------- 搜索 ---------------- */

export const getHotWords = (page = 0) => call('/api/search/hot', { query: { page }, mock: () => mockApi().then(m => m.getHotWords(page)) })
export const getCreators = (limit = 5) => call('/api/search/creators', { query: { limit }, mock: () => mockApi().then(m => m.getCreators()) })
export const getRecentSearches = (page = 0, limit = 5) =>
  call('/api/search/recent', { query: { limit, offset: page * limit }, mock: () => mockApi().then(m => m.getRecentSearches(page)) })

/** 视频搜索；HTTP 与 mock 都返回 { total, list } */
export const searchVideos = (q, opts = {}) =>
  call('/api/search', { query: { q, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.searchVideos(q)) })

/* ---------------- 专题 ---------------- */

export const getTopic = id => call(`/api/topic/${id}`, { mock: () => mockApi().then(m => m.getTopic(id)) })
export const getTopicVideos = (id, sort = 0, opts = {}) =>
  call(`/api/topic/${id}/videos`, { query: { sort, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getTopicVideos(id, sort)) })
export const getLibrary = () => call('/api/library', { mock: () => mockApi().then(m => m.getLibrary()) })

/* ---------------- 播放页 ---------------- */

/**
 * 视频详情：Video + { src, tags, playCount, likeCount, favCount, liked, faved, disliked, rank, region, quality, publishedAt }
 * rank：热榜名次，不在热榜（前 20）时为 null。
 * src 为空（还没有素材文件）时，播放器用封面 + 模拟进度代替。
 */
export const getVideo = id =>
  call(`/api/videos/${encodeURIComponent(id)}`, { mock: () => mockApi().then(m => m.getVideo(id)) })

/** 相似推荐；batch 递增即「换一批」 */
export const getRelatedVideos = (id, { batch = 0, limit = 6 } = {}) =>
  call(`/api/videos/${encodeURIComponent(id)}/related`, {
    query: { batch, limit },
    mock: () => mockApi().then(m => m.getRelatedVideos(id, batch, limit))
  })

/* ---------------- 短视频 ---------------- */

/**
 * 短视频流，按后台排好的顺序分页（offset 递增 = 往下翻）。
 * 每条是 Video + { src, likes, favs }：src 有值时播放真实文件，为空时用封面 + 模拟进度。
 */
export const getShorts = ({ limit = 10, offset = 0 } = {}) =>
  call('/api/shorts', { query: { limit, offset }, mock: () => mockApi().then(m => m.getShorts({ limit, offset })) })

/* ---------------- 社区 ---------------- */

export const getCommunityTabs = () => call('/api/community/tabs', { mock: () => mockApi().then(m => m.getCommunityTabs()) })
export const getPosts = (tab = 0, opts = {}) =>
  call('/api/community/posts', { query: { tab, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getPosts(tab)) })

/* 互动写入：body { on } 是想要的最终状态（服务端按它设置，重复点击结果不变），返回 { active, ... } */
export const togglePostFav = (postId, { on }) =>
  call(`/api/community/posts/${postId}/fav`, { method: 'POST', body: { on }, mock: () => mockApi().then(m => m.togglePostFav(postId, on)) })
export const toggleVideoFav = (videoId, { on }) =>
  call(`/api/videos/${videoId}/fav`, { method: 'POST', body: { on }, mock: () => mockApi().then(m => m.toggleVideoFav(videoId, on)) })
/** 赞 / 不喜欢由服务端保证互斥，返回 { active, liked, disliked, likeCount } */
export const toggleVideoLike = (videoId, { on }) =>
  call(`/api/videos/${videoId}/like`, { method: 'POST', body: { on }, mock: () => mockApi().then(m => m.toggleVideoLike(videoId, on)) })
export const toggleVideoDislike = (videoId, { on }) =>
  call(`/api/videos/${videoId}/dislike`, { method: 'POST', body: { on }, mock: () => mockApi().then(m => m.toggleVideoDislike(videoId, on)) })
export const toggleTopicFav = (topicId, { on }) =>
  call(`/api/topics/${topicId}/fav`, { method: 'POST', body: { on }, mock: () => mockApi().then(m => m.toggleTopicFav(topicId, on)) })

/* ---------------- 直播 / 同城 ---------------- */

export const getLiveTabs = () => call('/api/live/tabs', { mock: () => mockApi().then(m => m.getLiveTabs()) })
export const getLives = (opts = {}) =>
  call('/api/live', { query: { tab: opts.tab ?? 0, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getLives(opts)) })

export const getNearbyFilters = () => call('/api/nearby/filters', { mock: () => mockApi().then(m => m.getNearbyFilters()) })
export const getNearby = (opts = {}) =>
  call('/api/nearby', { query: { filter: opts.filter ?? 0, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getNearby(opts)) })

/* ---------------- 我的 ---------------- */

export const getProfile = () => call('/api/me', { mock: () => mockApi().then(m => m.getProfile()) })
export const getHistory = (opts = {}) =>
  call('/api/me/history', { query: { limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getHistory()) })
/** 记观看：开始播放时调一次（计播放数）；离开时带 progressOnly 只更新进度 */
export const addHistory = (videoId, progressSec = 0, { progressOnly = false } = {}) =>
  call('/api/me/history', { method: 'POST', body: { videoId, progressSec, progressOnly }, mock: () => Promise.resolve({ added: false }) })

/* ---------------- 账号管理（仅管理员，见 views/AdminUsersView.vue） ---------------- */

export const listUsers = () => get('/api/admin/users')
export const createUser = body => post('/api/admin/users', body)
export const resetUserPassword = (id, newPassword) => post(`/api/admin/users/${id}/password`, { newPassword })
export const setUserStatus = (id, status) => post(`/api/admin/users/${id}/status`, { status })
export const setUserRole = (id, role) => post(`/api/admin/users/${id}/role`, { role })
export const deleteUser = id => del(`/api/admin/users/${id}`)

/** 供设置页 / 调试用：当前是否在用真实接口 */
export const apiStatus = () => ({ mode: MODE, usingHttp: useHttp })
