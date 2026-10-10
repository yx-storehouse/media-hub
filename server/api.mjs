/*
 * 接口层：函数名与前端 src/api/index.js 一一对应。
 *
 * 每个函数都返回 Promise，结构也和前端一致，所以前端只改一个文件名就能切过来：
 *   src/api/index.js   ->   改 import 指向 server/api.mjs 暴露的 HTTP 地址
 * 详见 server/README.md 的「接入前端」一节。
 */
import * as q from './db/index.mjs'
import {
  hashPassword, verifyPassword, checkPasswordStrength, publicUser,
  createSession, deleteSession, deleteUserSessions
} from './auth.mjs'
import { avatar } from './lib/art.mjs'
import { InputError } from './lib/errors.mjs'

/** 新用户的默认头像（首字圆盘，与前端 mock 一致） */
const avatarFor = name => avatar(name, name)

/*
 * 所有「跟人有关」的接口都接收一个 userId：
 *   null = 未登录：只返回公开数据，点赞 / 收藏这类写操作会抛「未登录」
 * 身份统一由 server/index.mjs 从会话令牌解析后传进来，这里不再有固定游客账号。
 */

/**
 * 用户输入类错误：路由层收到它就返回 400，并把 message 原样展示给用户。
 * 其余异常（SQL 出错、代码 bug）一律 500 —— 不再靠关键词去猜。
 * 定义在 lib/errors.mjs（可带 field），这里再导出，api.InputError 用法不变。
 */
export { InputError }

/** 抛一个用户能看懂的错误 */
function inputError(message) {
  throw new InputError(message)
}

/** 写操作必须先登录 */
function requireUser(userId) {
  if (!userId) inputError('请先登录')
  return userId
}

/* ---------------- 首页 ---------------- */

export const getHomeTabs = () => Promise.resolve(q.homeTabs())
export const getMainTabs = () => Promise.resolve(q.mainTabs())

/**
 * 首页「推荐」分区；seed 保留给前端换一批用，服务端用 batch 计数代替。
 * topicId：「全部 / 看更多」要去的专题，没关联或专题已下架时为 null（前端隐藏这两个入口）。
 * 一条已上架视频都没有的分区不下发，免得前台出现只有标题和按钮的空板块。
 */
export function getRecommendSections() {
  const sections = q.recommendSections()
    .map(s => ({
      id: s.id,
      topicId: s.live_topic_id ?? null,
      title: s.title,
      subtitle: s.subtitle,
      featured: !!s.featured,
      size: s.size,
      seed: 'rec' + s.id,
      batches: q.sectionBatches(s.id)
    }))
    .filter(s => s.batches > 0)
  return Promise.resolve(sections)
}

/** 分区某个批次的视频：batch 传给下一次「换一批」 */
export function getVideos(sectionId, size = 4, batch = 0, userId = null) {
  return Promise.resolve(q.attachVideoState(q.sectionVideos(sectionId, size, batch), userId))
}

export const getLatestFilters = () => Promise.resolve(q.latestFilters())
export const getLatestVideos = (opts = {}, userId = null) => Promise.resolve(q.attachVideoState(q.latestVideos(opts), userId))
export const getCategoryFilters = tab => Promise.resolve(q.categoryFilters(tab))
export const getCategoryVideos = (tab, opts = {}, userId = null) => Promise.resolve(q.attachVideoState(q.categoryVideos(tab, opts), userId))

/* ---------------- 搜索 ---------------- */

export const getHotWords = (page = 0) => Promise.resolve(q.hotWords(page))
export const getCreators = (limit = 5) => Promise.resolve(q.creators(limit).map(c => ({
  id: c.id,
  handle: c.handle,
  name: c.name,
  verified: !!c.verified,
  followers: c.follower_count,
  avatar: { src: c.avatar_url, fallback: c.avatar_fallback }
})))
export const getRecentSearches = (userId = null, { limit = 5, offset = 0 } = {}) =>
  Promise.resolve(userId ? q.searchHistory(userId, { limit, offset }) : [])
export function searchVideos(keyword, opts = {}, userId = null) {
  const { total, list } = q.searchVideos(keyword, opts)
  return Promise.resolve({ total, list: q.attachVideoState(list, userId) })
}
export function searchPosts(keyword, opts = {}, userId = null) {
  const list = q.searchPosts(keyword, opts)
  for (const p of list) p.time = q.relativeTime(p.publishedAt)
  return Promise.resolve(q.attachPostState(list, userId))
}

/** 搜索并记录历史（前端点「搜索」时调这个）；只有登录用户才记 */
export function doSearch(keyword, opts = {}, userId = null) {
  const result = q.searchVideos(keyword, opts)
  if (userId && result.list.length) q.addSearchHistory(userId, keyword, result.list[0].id)
  return Promise.resolve(result)
}

/* ---------------- 专题 ---------------- */

/* 专题不存在或已下架是正常的业务答复（400），不能当成服务端故障（500），否则前端会整体切到演示数据 */
export function getTopic(id) {
  const t = q.topic(id)
  if (!t) inputError('专题不存在或已下架')
  return Promise.resolve({
    id: t.id,
    slug: t.slug,
    name: t.name,
    plays: t.plays_count >= 10000 ? (t.plays_count / 10000).toFixed(1) + 'w' : String(t.plays_count),
    favs: t.fav_count,
    total: t.video_count,
    covers: q.topicCovers(id).map(c => ({ src: c.url, fallback: c.fallback })),
    sorts: q.topicSorts()
  })
}

export function getTopicVideos(id, sort = 0, opts = {}, userId = null) {
  if (!q.topic(id)) inputError('专题不存在或已下架')
  const { total, list } = q.topicVideos(id, sort, opts)
  return Promise.resolve({ total, list: q.attachVideoState(list, userId) })
}
export const getLibrary = () => Promise.resolve(q.library())

/* ---------------- 播放页 ---------------- */

export function getVideo(id, userId = null) {
  const v = q.videoDetail(id)
  if (!v) inputError('视频不存在或已下架')
  q.attachVideoState([v], userId)
  if (userId) v.disliked = q.isVideoDisliked(userId, id)
  return Promise.resolve(v)
}

export const getRelatedVideos = (id, opts = {}, userId = null) =>
  Promise.resolve(q.attachVideoState(q.relatedVideos(id, opts), userId))

/* ---------------- 短视频 ---------------- */

/**
 * 短视频流。
 * 前端短视频页读的是 likes / favs（旧字段名），列表页读的是 likeCount / favCount，
 * 这里两个都给，避免调用方各写一套兼容逻辑。
 */
export const getShorts = (opts = {}, userId = null) =>
  Promise.resolve(q.attachVideoState(q.shorts(opts), userId)
    .map(v => ({ ...v, likes: v.likeCount, favs: v.favCount })))

/* ---------------- 社区 ---------------- */

export const getCommunityTabs = () => Promise.resolve(q.communityTabs())
export function getPosts(tab = 0, opts = {}, userId = null) {
  const list = q.posts(tab, { ...opts, userId })
  for (const p of list) p.time = q.relativeTime(p.publishedAt)   // 前端展示「44分钟前」
  return Promise.resolve(q.attachPostState(list, userId))
}

/* 互动：必须登录，未登录时 requireUser 会抛出「未登录」 */
/* on：true / false = 设为该状态；undefined = 切换（兼容旧调用） */
export const togglePostFav = (postId, userId, on) => Promise.resolve(q.togglePostFav(requireUser(userId), postId, on))
export const toggleVideoFav = (videoId, userId, on) => Promise.resolve(q.toggleVideoFav(requireUser(userId), videoId, on))
export const toggleVideoLike = (videoId, userId, on) => Promise.resolve(q.toggleVideoLike(requireUser(userId), videoId, on))
export const toggleVideoDislike = (videoId, userId, on) => Promise.resolve(q.toggleVideoDislike(requireUser(userId), videoId, on))
export const toggleTopicFav = (topicId, userId, on) => Promise.resolve(q.toggleTopicFav(requireUser(userId), topicId, on))
export const toggleFollow = (creatorId, userId, on) => Promise.resolve(q.toggleFollow(requireUser(userId), creatorId, on))

/* ---------------- 直播 / 同城 ---------------- */

export const getLiveTabs = () => Promise.resolve(q.liveTabs())
export const getLives = opts => Promise.resolve(q.lives(opts))
export const getNearbyFilters = () => Promise.resolve(q.nearbyFilters())
export const getNearby = opts => Promise.resolve(q.nearby(opts))

/* ---------------- 我的 ---------------- */

export function getProfile(userId = null) {
  if (!userId) return Promise.resolve(null)   // 未登录：前端据此显示登录入口
  const u = q.userProfile(userId)
  if (!u) return Promise.resolve(null)
  return Promise.resolve({
    id: u.id,
    name: u.name,
    uid: u.uid,
    avatar: { src: u.avatar_url, fallback: u.avatar_fallback },
    stats: [
      { label: '观看历史', value: u.history_count, to: '/history' },
      { label: '我的收藏', value: u.fav_count },
      { label: '离线缓存', value: u.download_count },
      { label: '我的关注', value: u.follow_count }
    ]
  })
}

export const getHistory = (opts = {}, userId = null) =>
  Promise.resolve(userId ? q.attachVideoState(q.watchHistory(userId, opts), userId) : [])
export function addHistory(videoId, progressSec = 0, userId = null, { countPlay = true } = {}) {
  if (!userId) return Promise.resolve({ added: false, reason: 'not-logged-in' })
  if (!q.videoExists(videoId)) inputError('视频不存在或已下架')
  return Promise.resolve(q.addWatchHistory(userId, videoId, progressSec, { countPlay }))
}

/* ---------------- 鉴权 ---------------- */

/** 登录：校验口令 → 建会话 → 返回 { token, expiresAt, user } */
export function login({ uid, password, device = null }) {
  const user = q.userByUid(String(uid || '').trim())
  // 账号不存在与口令错误给同样的提示，避免被用来探测账号
  if (!user) inputError('账号或密码错误')
  if (user.status !== 1) inputError('账号已被停用，请联系管理员')
  if (!user.password_hash) inputError('该账号还没有设置密码，请联系管理员')
  if (!verifyPassword(password || '', user.password_hash)) inputError('账号或密码错误')
  const { token, expiresAt } = createSession(q.db, user.id, device)
  return { token, expiresAt, user: publicUser(user) }
}

/** 退出登录：只失效当前设备的会话 */
export function logout(token) {
  deleteSession(q.db, token)
  return { ok: true }
}

/** 当前登录用户（未登录返回 null） */
export function me(userId) {
  if (!userId) return null
  const u = q.userById(userId)
  return u ? publicUser(u) : null
}

/** 改自己的密码；其他设备的会话会被踢下线，当前设备保留 */
export function changePassword(userId, { oldPassword, newPassword, keepToken = null }) {
  const u = q.userById(userId)
  if (!u) inputError('用户不存在')
  if (u.password_hash && !verifyPassword(oldPassword || '', u.password_hash)) inputError('原密码不正确')
  const bad = checkPasswordStrength(newPassword)
  if (bad) inputError(bad)
  q.setUserPassword(userId, hashPassword(newPassword))
  deleteUserSessions(q.db, userId, keepToken)
  return { ok: true }
}

/** 改自己的昵称 / 头像 */
export function updateProfile(userId, { nickname, avatar: av } = {}) {
  const u = q.userById(userId)
  if (!u) inputError('用户不存在')
  if (nickname != null) {
    const name = String(nickname).trim()
    if (!name) inputError('昵称不能为空')
    if ([...name].length > 20) inputError('昵称最多 20 个字')
    q.db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(name, userId)
  }
  if (av) {
    q.db.prepare('UPDATE users SET avatar_url = ?, avatar_fallback = ? WHERE id = ?')
      .run(av.src ?? null, av.fallback ?? null, userId)
  }
  return publicUser(q.userById(userId))
}

/* ---------------- 账号管理（仅管理员） ---------------- */

function requireAdmin(userId) {
  const u = userId ? q.userById(userId) : null
  if (!u || u.role !== 'admin') inputError('需要管理员权限')
  return u
}

export function listUsers(userId) {
  requireAdmin(userId)
  return q.listUsers()
}

/** 管理员建号：初始口令由管理员设定 */
export function createUser(userId, { uid, nickname, password, role = 'user' } = {}) {
  requireAdmin(userId)
  const name = String(uid || '').trim()
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(name)) inputError('登录名需为 3-32 位字母、数字或 _ . -')
  if (q.userByUid(name)) inputError('登录名已存在')
  const bad = checkPasswordStrength(password)
  if (bad) inputError(bad)
  if (role !== 'user' && role !== 'admin') inputError('角色只能是 user 或 admin')
  const id = q.createUser({
    uid: name,
    nickname: String(nickname || name).trim(),
    passwordHash: hashPassword(password),
    role,
    avatar: avatarFor(nickname || name)
  })
  return publicUser(q.userById(id))
}

/** 管理员重置口令（用于忘记密码） */
export function resetPassword(actorId, targetId, newPassword) {
  requireAdmin(actorId)
  const bad = checkPasswordStrength(newPassword)
  if (bad) inputError(bad)
  if (!q.userById(targetId)) inputError('用户不存在')
  q.setUserPassword(targetId, hashPassword(newPassword))
  deleteUserSessions(q.db, targetId)
  return { ok: true }
}

/** 管理员停用 / 启用账号；停用会立刻踢掉该账号的所有会话 */
export function setUserStatus(actorId, targetId, status) {
  const actor = requireAdmin(actorId)
  const target = q.userById(targetId)
  if (!target) inputError('用户不存在')
  if (target.id === actor.id && !status) inputError('不能停用自己')
  if (!status && target.role === 'admin' && q.countAdmins() <= 1) inputError('至少要保留一个可用的管理员')
  q.setUserStatus(targetId, status ? 1 : 0)
  if (!status) deleteUserSessions(q.db, targetId)
  return { ok: true }
}

export function setUserRole(actorId, targetId, role) {
  const actor = requireAdmin(actorId)
  if (role !== 'user' && role !== 'admin') inputError('角色只能是 user 或 admin')
  const target = q.userById(targetId)
  if (!target) inputError('用户不存在')
  if (target.id === actor.id && role !== 'admin') inputError('不能取消自己的管理员权限')
  if (target.role === 'admin' && role !== 'admin' && q.countAdmins() <= 1) inputError('至少要保留一个管理员')
  q.setUserRole(targetId, role)
  return { ok: true }
}

/** 管理员删除账号 */
export function deleteUser(actorId, targetId) {
  const actor = requireAdmin(actorId)
  const target = q.userById(targetId)
  if (!target) inputError('用户不存在')
  if (target.id === actor.id) inputError('不能删除自己')
  if (target.role === 'admin' && q.countAdmins() <= 1) inputError('至少要保留一个管理员')
  q.db.prepare('DELETE FROM users WHERE id = ?').run(targetId)
  return { ok: true }
}

/** 库里一个用户都没有时，用这个建第一个管理员 */
export function bootstrapAdmin({ uid, password, nickname = '管理员' }) {
  if (q.userByUid(uid)) inputError('登录名已存在')
  const bad = checkPasswordStrength(password)
  if (bad) inputError(bad)
  const id = q.createUser({
    uid, nickname, passwordHash: hashPassword(password), role: 'admin', avatar: avatarFor(nickname)
  })
  return publicUser(q.userById(id))
}

export { q as queries }
