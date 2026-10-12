/*
 * 数据接口层。
 *
 * 走 server/ 提供的 HTTP 接口（先跑 `node server/index.mjs`，见 server/README.md）。三种模式（VITE_API_MODE）：
 *   http   只用接口，失败就报错。打包上线（.env.production、Dockerfile）固定用它：线上永远不出现演示数据
 *   auto   开发时的默认：每次读取都先请求接口，只有这一次请求「连不上」（网络失败、超时、5xx、回话的不是
 *          接口服务）时，这一次退回本地演示数据并提示；之后的请求照样先打接口，一成功（或浏览器报 online）
 *          就算恢复。不会一次失败就整个切到演示数据
 *   mock   只用本地演示数据，完全不发请求
 * 接口正常给出的业务错误（4xx：视频不存在、未登录…）照常抛给页面；写操作（点赞、收藏、观看记录）
 * 从不退回演示数据，失败就报错，页面会回滚并提示。「我的」相关的读取（个人信息、历史、收藏、关注、
 * 搜索记录）也不退回演示数据：连不上就报错，页面显示「加载失败 + 重试」。
 *
 * 演示数据的 id 都是 'demo:' 开头的字符串（isDemoId），不会和接口的数字 id 撞上：
 * 带演示 id 的读取直接取演示数据，带演示 id 的写操作根本不发请求，直接报「演示内容，无法操作」。
 * 只有列表类读取会退回演示数据；带真实 id 的读取（某个视频、帖子…）连不上就报错。
 *
 * 形状说明（HTTP 与 mock 两种实现都遵守）：
 *   Cover  { src: string|null, fallback?: string }   <Cover v-bind="cover">
 *   Video  { id, code, title, dur, len, cover, likes, liked, faved, ... }
 *   Post   { id, creatorId, name, handle, verified, time, avatar, text, tags, kind: 'image'|'video'|'doc', dur, more, videoId, media: { main, thumbs } }
 *   PostDetail { id, title, content, kind, author: { id, name, handle, verified, avatar }, following, tags, images: Cover[],
 *                video: { id, title, cover, dur, len } | null, read, fav, faved, publishedAt, time, next: { id, title, thumb } | null }
 * 页面里的列表都用 shallowRef 存放（整体替换，不做原地修改）。
 */
import { request, get, post, del, ApiError } from './http'

/* ---------------- 运行模式 ---------------- */

const MODE = import.meta.env.VITE_API_MODE || 'auto'   // http | mock | auto

/** 演示数据的 id：'demo:' 开头的字符串（接口的 id 都是数字） */
export const isDemoId = id => typeof id === 'string' && id.startsWith('demo:')

/**
 * auto 模式的连接状态：offline 表示最近一次读取连不上、用了演示数据。
 * 只用来调短超时和决定提示，不会让之后的请求跳过接口。
 */
let offline = false
/* 断开期间读取的超时：连不上时别让每个页面都干等 12 秒 */
const OFFLINE_TIMEOUT = 5000

const notify = text => {
  // 延迟到下一帧，避免在渲染过程中触发全局提示
  setTimeout(() => import('@/composables/useToast').then(m => m.toast(text)), 0)
}

function setOffline(next, reason) {
  if (next === offline) return
  offline = next
  if (next) {
    console.warn('[api] 接口不可用，这次请求先用演示数据：', reason)
    notify('接口未连接，当前展示演示数据')
  } else {
    notify('已重新连接')
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('reel:api', { detail: { offline: next } }))
}

/* 浏览器报告网络恢复：清掉断开状态（下一次请求照常打接口，超时恢复正常） */
if (MODE === 'auto' && typeof window !== 'undefined') window.addEventListener('online', () => setOffline(false))

/**
 * 只有「接口服务连不上」才算不可用：网络失败、超时，或代理/服务端 5xx。
 * 4xx（视频不存在、参数不对、未登录…）是接口正常给出的答复，照常抛给页面处理。
 */
const isUnavailable = e => ['network', 'timeout', 'bad_response'].includes(e.code) || e.status >= 500

const demoWriteError = () => new ApiError('演示内容，无法操作', { code: 'demo' })

/**
 * 发一个请求。
 *   mock      演示数据（mock 模式、带演示 id 的读取、auto 模式下这一次连不上时用）
 *   ids       路径里用到的 id：有演示 id 时读取直接取演示数据，写操作不发请求直接报错
 *   personal  「我的」相关的读取：auto 模式下连不上也不退回演示数据（演示数据冒充个人数据会误导人）
 *   keepalive 页面关闭 / 切后台时的上报：浏览器在页面卸载后也会把请求发完
 */
async function call(path, { query, method = 'GET', body, mock, ids = [], personal = false, keepalive = false } = {}) {
  const isWrite = method !== 'GET'
  if (ids.some(isDemoId)) {
    if (isWrite) throw demoWriteError()
    if (mock) return mock()
  }
  if (MODE === 'mock') {
    if (mock) return mock()
    throw new ApiError('演示模式不支持这个操作', { code: 'demo' })
  }
  // 只有列表类读取会退回演示数据：带真实 id 的读取（某个视频、帖子、创作者…）连不上就报错，
  // 不拿一条假内容冒充这个 id，页面上的按钮也就不会对着真实 id 写入
  const useMock = MODE === 'auto' && !isWrite && !personal && !!mock && ids.length === 0
  try {
    const data = await request(path, {
      method,
      query,
      body: isWrite ? body : undefined,
      keepalive,
      ...(useMock && offline ? { timeout: OFFLINE_TIMEOUT } : {})
    })
    if (MODE === 'auto') setOffline(false)
    return data
  } catch (e) {
    const unavailable = isUnavailable(e)
    // 接口正常答复了（4xx）也说明连得上
    if (MODE === 'auto' && !unavailable && e.name !== 'AbortError') setOffline(false)
    // 写操作失败绝不假装成功；只有 auto 模式下、这一次读取连不上时才用演示数据
    if (!useMock || !unavailable) throw e
    setOffline(true, e.message)
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
  call(`/api/home/section/${encodeURIComponent(sectionId)}/videos`, {
    query: { size, batch },
    ids: [sectionId],
    mock: () => mockApi().then(m => m.getVideos(seed ?? sectionId, size))
  })

/**
 * 「最新」的日期 + 地区：{ dates: [{ label, count }], regions: [{ code, label, count, counts }] }
 * regions[0] 是「全部」（默认选它）；regions[i].counts[d] 是这个地区第 d 天的条数，count = counts[date]。
 */
export const getLatestFilters = ({ date = 0 } = {}) =>
  call('/api/home/latest/filters', { query: { date }, mock: () => mockApi().then(m => m.getLatestFilters({ date })) })
/** region：getLatestFilters().regions 的下标，0 = 全部 */
export const getLatestVideos = (opts = {}) =>
  call('/api/home/latest/videos', { query: { date: opts.date ?? 0, region: opts.region ?? 0, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getLatestVideos(opts)) })

export const getCategoryFilters = tab => call(`/api/category/${tab}/filters`, { mock: () => mockApi().then(m => m.getCategoryFilters()) })
export const getCategoryVideos = (tab, opts = {}) =>
  call(`/api/category/${tab}/videos`, { query: { filter: opts.filter ?? 0, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getCategoryVideos(tab, opts)) })

/* ---------------- 搜索 ---------------- */

export const getHotWords = (page = 0) => call('/api/search/hot', { query: { page }, mock: () => mockApi().then(m => m.getHotWords(page)) })
export const getCreators = (limit = 5) => call('/api/search/creators', { query: { limit }, mock: () => mockApi().then(m => m.getCreators()) })
/** 旧版近期搜索（每次搜索第一条结果的视频卡片），已弃用：改用 getSearchHistory 的关键词 */
export const getRecentSearches = (page = 0, limit = 5) =>
  call('/api/search/recent', { query: { limit, offset: page * limit }, mock: () => mockApi().then(m => m.getRecentSearches(page)) })

/** 视频搜索 → { total, list }；登录时服务端顺便记下搜索词（第一页、没结果也记） */
export const searchVideos = (q, opts = {}) =>
  call('/api/search', { query: { q, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.searchVideos(q, opts)) })

/** 帖子搜索（标题 + 话题标签）→ { total, list: Post[] }，Post 与社区列表同结构；同样会记搜索词 */
export const searchPosts = (q, opts = {}) =>
  call('/api/search/posts', { query: { q, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.searchPosts(q, opts)) })

/**
 * 近期搜索的关键词（要登录；未登录时页面自己存 localStorage）→ { list: [{ keyword, searchedAt }] }，新的在前、已去重。
 * 不退回演示数据。
 */
export const getSearchHistory = ({ limit = 10 } = {}) =>
  call('/api/search/history', { query: { limit }, personal: true, mock: () => Promise.resolve({ list: [] }) })
/** 清空近期搜索；传 keyword 只删这一个词 → { removed } */
export const clearSearchHistory = (keyword = null) =>
  call('/api/search/history', { method: 'DELETE', query: { keyword }, mock: () => Promise.resolve({ removed: 0 }) })

/* ---------------- 专题 ---------------- */

/**
 * 专题：{ id, slug, name, plays, playCount, favs, faved, total, covers, sorts }
 * plays / playCount 取后台填的播放数和专题内视频播放数之和的较大值，favs 含专题内视频的收藏；faved 是当前用户收藏过没有。
 */
export const getTopic = id => call(`/api/topic/${encodeURIComponent(id)}`, { ids: [id], mock: () => mockApi().then(m => m.getTopic(id)) })
export const getTopicVideos = (id, sort = 0, opts = {}) =>
  call(`/api/topic/${encodeURIComponent(id)}/videos`, { query: { sort, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, ids: [id], mock: () => mockApi().then(m => m.getTopicVideos(id, sort)) })
export const getLibrary = () => call('/api/library', { mock: () => mockApi().then(m => m.getLibrary()) })

/* ---------------- 播放页 ---------------- */

/**
 * 视频详情：Video + { src, tags, playCount, likeCount, favCount, liked, faved, disliked, rank, region, quality, publishedAt,
 *                     progressSec, watchedAt }
 * rank：热榜名次，不在热榜（前 20）时为 null。
 * src 为空（还没有素材文件）时，播放器只显示封面和「暂无视频源」，不计播放。
 * creator { id, name, handle, avatar }、description、topicId / topicName：播放页的作者行、简介和所属专题。
 * progressSec / watchedAt：登录用户上次看到的秒数和时间（没看过 / 未登录为 0 / null），App 重开也能续播。
 */
export const getVideo = id =>
  call(`/api/videos/${encodeURIComponent(id)}`, { ids: [id], mock: () => mockApi().then(m => m.getVideo(id)) })

/** 相似推荐；batch 递增即「换一批」 */
export const getRelatedVideos = (id, { batch = 0, limit = 6 } = {}) =>
  call(`/api/videos/${encodeURIComponent(id)}/related`, {
    query: { batch, limit },
    ids: [id],
    mock: () => mockApi().then(m => m.getRelatedVideos(id, batch, limit))
  })

/* ---------------- 短视频 ---------------- */

/**
 * 短视频推荐流 → { seed, list, hasMore }。
 * seed：同一个 seed 顺序固定（翻页稳定），换一个就重新洗牌；不传时服务端随机生成并在结果里带回。
 * offset 递增 = 往下翻，翻过整个视频池也一直有内容（hasMore 恒为 true）。
 * exclude：最近刷到过的视频 id（最多 100 个），这些会排到后面，每次打开都不一样。
 * 每条是 Video + { src, likes, favs, creator }：src 有值时播放真实文件，为空时用封面 + 模拟进度。
 */
export const getShorts = ({ seed, limit = 10, offset = 0, exclude = [] } = {}) =>
  call('/api/shorts', {
    query: { seed, limit, offset, exclude: exclude.slice(0, 100).join(',') },
    mock: () => mockApi().then(m => m.getShorts({ seed, limit, offset, exclude }))
  })

/* ---------------- 社区 ---------------- */

export const getCommunityTabs = () => call('/api/community/tabs', { mock: () => mockApi().then(m => m.getCommunityTabs()) })
/** tab：0 最新 / 1 热门 / 2 关注 / 3 收藏；2、3 是个人内容，没登录时接口返回空列表（页面按登录状态给提示） */
export const getPosts = (tab = 0, opts = {}) =>
  call('/api/community/posts', {
    query: { tab, limit: opts.limit ?? 20, offset: opts.offset ?? 0 },
    personal: Number(tab) === 2 || Number(tab) === 3,
    mock: () => mockApi().then(m => m.getPosts(Number(tab) || 0))
  })

/**
 * 帖子详情（#/post/:id）：PostDetail。title 就是列表里的 text，content 是正文（纯文本，保留换行）。
 * 视频帖关联了已上架的视频时，主图当视频封面（video.cover），images 只放配图；否则 images = [主图, ...配图]。
 * next：社区「最新」顺序里的下一篇（更早发布的），没有时为 null。
 * 帖子不存在或已下架时接口回 400「帖子不存在或已下架」。
 */
export const getPost = id =>
  call(`/api/community/posts/${encodeURIComponent(id)}`, { ids: [id], mock: () => mockApi().then(m => m.getPost(id)) })

/**
 * 记一次阅读（每次打开详情页调一次），返回 { read } 最新阅读数。
 * 只是计数：调用方不用等它；失败（含接口不可用、演示内容）直接吞掉、返回 null，不提示，也不会退回 mock。
 */
export const viewPost = id =>
  call(`/api/community/posts/${encodeURIComponent(id)}/view`, { method: 'POST', ids: [id], mock: () => mockApi().then(m => m.viewPost(id)) })
    .catch(() => null)

/*
 * 互动写入：body { on } 是想要的最终状态（服务端按它设置，重复点击结果不变），返回 { active, ... }。
 * 演示内容（isDemoId）不发请求，直接报「演示内容，无法操作」，页面照常回滚并提示。
 */
const toggle = (path, id, on, mock) =>
  call(path, { method: 'POST', body: { on }, ids: [id], mock })
export const togglePostFav = (postId, { on }) =>
  toggle(`/api/community/posts/${encodeURIComponent(postId)}/fav`, postId, on, () => mockApi().then(m => m.togglePostFav(postId, on)))
export const toggleVideoFav = (videoId, { on }) =>
  toggle(`/api/videos/${encodeURIComponent(videoId)}/fav`, videoId, on, () => mockApi().then(m => m.toggleVideoFav(videoId, on)))
/** 赞 / 不喜欢由服务端保证互斥，返回 { active, liked, disliked, likeCount } */
export const toggleVideoLike = (videoId, { on }) =>
  toggle(`/api/videos/${encodeURIComponent(videoId)}/like`, videoId, on, () => mockApi().then(m => m.toggleVideoLike(videoId, on)))
/** 不喜欢：登录用户点过的视频，短视频推荐流不再给（同一创作者的也会少推一些） */
export const toggleVideoDislike = (videoId, { on }) =>
  toggle(`/api/videos/${encodeURIComponent(videoId)}/dislike`, videoId, on, () => mockApi().then(m => m.toggleVideoDislike(videoId, on)))
export const toggleTopicFav = (topicId, { on }) =>
  toggle(`/api/topics/${encodeURIComponent(topicId)}/fav`, topicId, on, () => mockApi().then(m => m.toggleTopicFav(topicId, on)))
/** 关注 / 取消关注创作者，返回 { active, followers }（followers 是最新粉丝数，演示数据可能没有） */
export const toggleFollow = (creatorId, { on }) =>
  toggle(`/api/creators/${encodeURIComponent(creatorId)}/follow`, creatorId, on, () => mockApi().then(m => m.toggleFollow(creatorId, on)))

/* ---------------- 创作者主页（#/creator/:id） ---------------- */

/**
 * 主页头部：{ id, name, handle, avatar, verified, official, bio, followers, videoCount, postCount,
 *            lastActiveAt, lastActive, following, banner: Cover[] }
 * 视频数 / 帖子数只算已发布的；banner 是最近作品的图（最多 3 张，可能为空）。
 * 创作者不存在或已停用时接口回 400「创作者不存在」。
 */
export const getCreator = id =>
  call(`/api/creators/${encodeURIComponent(id)}`, { ids: [id], mock: () => mockApi().then(m => m.getCreator(id)) })

/** 主页「视频」：sort 0 最新 / 1 最热，返回 { total, list: Video[] } */
export const getCreatorVideos = (id, sort = 0, opts = {}) =>
  call(`/api/creators/${encodeURIComponent(id)}/videos`, {
    query: { sort, limit: opts.limit ?? 20, offset: opts.offset ?? 0 },
    ids: [id],
    mock: () => mockApi().then(m => m.getCreatorVideos(id, sort, opts))
  })

/** 主页「帖子」：返回 { total, list: Post[] }，Post 与社区列表同结构 */
export const getCreatorPosts = (id, opts = {}) =>
  call(`/api/creators/${encodeURIComponent(id)}/posts`, {
    query: { limit: opts.limit ?? 20, offset: opts.offset ?? 0 },
    ids: [id],
    mock: () => mockApi().then(m => m.getCreatorPosts(id, opts))
  })

/* ---------------- 直播 / 同城 ---------------- */

export const getLiveTabs = () => call('/api/live/tabs', { mock: () => mockApi().then(m => m.getLiveTabs()) })
export const getLives = (opts = {}) =>
  call('/api/live', { query: { tab: opts.tab ?? 0, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getLives(opts)) })

export const getNearbyFilters = () => call('/api/nearby/filters', { mock: () => mockApi().then(m => m.getNearbyFilters()) })
export const getNearby = (opts = {}) =>
  call('/api/nearby', { query: { filter: opts.filter ?? 0, limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, mock: () => mockApi().then(m => m.getNearby(opts)) })

/* ---------------- 我的 ---------------- */

/*
 * 下面都是个人数据：不退回演示数据（连不上就报错，页面显示「加载失败 + 重试」）；
 * mock 模式下返回空。除 getProfile 外都要登录（未登录 401，会弹登录框），只在登录后调用。
 */
const emptyPage = () => Promise.resolve({ total: 0, list: [] })

/**
 * 个人信息（未登录为 null）：{ id, name, uid, avatar, stats, counts }
 *   stats：[{ key: 'history' | 'favs' | 'follows', label, value, to }]，to 是点进去的页面
 *   counts：{ history, favVideos, favPosts, favTopics, follows }，实时统计，和下面各列表的 total 一致
 */
export const getProfile = () => call('/api/me', { personal: true, mock: () => mockApi().then(m => m.getProfile()) })

/** 观看历史一页 → { total, list }，每条 Video + { progressSec, watchedAt }（len 是总秒数，进度 = progressSec / len） */
export const getHistory = (opts = {}) =>
  call('/api/me/history', { query: { limit: opts.limit ?? 20, offset: opts.offset ?? 0 }, personal: true, mock: emptyPage })
/** 删一条观看记录 → { removed, total }（total 是剩下的条数） */
export const removeHistory = videoId =>
  call(`/api/me/history/${encodeURIComponent(videoId)}`, { method: 'DELETE', ids: [videoId], mock: () => Promise.resolve({ removed: 0, total: 0 }) })
/** 清空观看历史 → { removed, total: 0 } */
export const clearHistory = () =>
  call('/api/me/history', { method: 'DELETE', mock: () => Promise.resolve({ removed: 0, total: 0 }) })

/**
 * 记观看：开始播放时调一次（计播放数；进度传 0 时不会覆盖上次看到的位置）；离开时带 progressOnly 只更新进度。
 * keepalive：页面隐藏 / 关闭时上报用，浏览器在页面卸载后也会把请求发完。演示内容不发请求。
 */
export const addHistory = (videoId, progressSec = 0, { progressOnly = false, keepalive = false } = {}) =>
  call('/api/me/history', { method: 'POST', body: { videoId, progressSec, progressOnly }, ids: [videoId], keepalive, mock: () => Promise.resolve({ added: false }) })

/**
 * 我的收藏 → { total, list }，最近收藏的在前：
 *   'video'  Video + favedAt
 *   'post'   Post（和社区列表同结构）+ favedAt
 *   'topic'  { id, name, count, cover, favedAt }（和片库卡片同结构）
 * 取消收藏用 toggleVideoFav / togglePostFav / toggleTopicFav（{ on: false }）。
 */
export const getMyFavs = (type = 'video', { limit = 20, offset = 0 } = {}) =>
  call('/api/me/favs', { query: { type, limit, offset }, personal: true, mock: emptyPage })

/** 我的关注 → { total, list: [{ id, name, handle, avatar, verified, bio, followers, followedAt, following }] }；取消用 toggleFollow */
export const getMyFollows = ({ limit = 20, offset = 0 } = {}) =>
  call('/api/me/follows', { query: { limit, offset }, personal: true, mock: emptyPage })

/* ---------------- 账号管理（仅管理员，见 views/AdminUsersView.vue） ---------------- */

export const listUsers = () => get('/api/admin/users')
export const createUser = body => post('/api/admin/users', body)
export const resetUserPassword = (id, newPassword) => post(`/api/admin/users/${id}/password`, { newPassword })
export const setUserStatus = (id, status) => post(`/api/admin/users/${id}/status`, { status })
export const setUserRole = (id, role) => post(`/api/admin/users/${id}/role`, { role })
export const deleteUser = id => del(`/api/admin/users/${id}`)

/**
 * 供设置页 / 调试用：mode 是运行模式；offline 为 true 表示 auto 模式下最近一次读取连不上、用了演示数据
 * （状态变化时 window 上会发 'reel:api' 事件，detail: { offline }）
 */
export const apiStatus = () => ({ mode: MODE, usingHttp: MODE !== 'mock' && !offline, offline })
