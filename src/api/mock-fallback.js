/*
 * 本地兜底数据：接口连不上时使用（见 src/api/index.js 的 auto 模式）。
 *
 * 这里保持「同步返回 Promise」的老行为，结构和新接口一致，
 * 所以页面代码不用判断自己拿到的是接口数据还是兜底数据。
 * 全部内容由种子随机数生成，刷新页面不会变。
 */
import { rng } from '@/mock/random'
import { cover, avatar, brandAvatar, docThumb } from '@/mock/art'
import * as D from '@/mock/data'

const ok = value => Promise.resolve(value)

/** 生成第 i 条视频；同 seedBase + i 必然得到同一条内容 */
function makeVideo(seedBase, i, dark = false) {
  const seed = `${seedBase}:${i}`, r = rng(seed)
  const len = 300 + Math.floor(r() * 2400)
  return {
    id: seed,
    code: 'VID-' + (1000 + i),
    title: D.TITLES[Math.floor(r() * D.TITLES.length)],
    dur: '00:' + String(5 + Math.floor(r() * 34)).padStart(2, '0') + ':' + String(Math.floor(r() * 60)).padStart(2, '0'),
    len,
    cover: cover(seed, { dark }),
    likes: 100 + Math.floor(r() * 900),
    liked: false,
    faved: false,
    publishedAt: Math.floor(Date.now() / 1000) - Math.floor(r() * 7 * 86400)
  }
}

/** 生成 n 条视频；同 seed 必然得到同一批内容 */
function makeVideos(n, seedBase, dark = false) {
  return Array.from({ length: n }, (_, i) => makeVideo(seedBase, i, dark))
}

const TAG_POOL = ['治愈', '旅行', '城市', '夜景', '美食', '纪录片', '动漫', '悬疑', '慢生活', '延时摄影', '手作', '音乐', '自然', '露营', '街拍']

/** 播放页要的附加字段：标签、播放 / 收藏数（同一 id 每次都一样） */
function withDetail(v) {
  const r = rng('detail:' + v.id)
  const tags = []
  while (tags.length < 3 + Math.floor(r() * 4)) {
    const t = TAG_POOL[Math.floor(r() * TAG_POOL.length)]
    if (!tags.includes(t)) tags.push(t)
  }
  return { ...v, tags, playCount: 800 + Math.floor(r() * 9000), likeCount: v.likes, favCount: 40 + Math.floor(r() * 400) }
}

/** 由 id 还原出列表里的同一条视频：mock 的 id 是「种子前缀:序号」，如 rec0:3 */
function videoById(id) {
  const s = String(id), k = s.lastIndexOf(':')
  const i = k > 0 ? Number(s.slice(k + 1)) : NaN
  // 不是「前缀:序号」的 id（比如接口的数字 id）：用整个 id 当种子，id 原样返回
  if (!Number.isInteger(i) || i < 0) return { ...makeVideo('id:' + s, 0), id: s }
  const base = s.slice(0, k)
  const v = makeVideo(base, i, base.startsWith('late'))
  // 搜索结果的标题带着关键词前缀（见 searchVideos），这里补回去
  return base.startsWith('sr:') ? { ...v, title: `${base.slice(3)} · ${v.title}` } : v
}

/* ---------------- 首页 ---------------- */

export const getHomeTabs = () => ok(D.HOME_TABS ?? [
  { key: 'latest', label: '最新' }, { key: 'recommend', label: '推荐' }, { key: 'ai', label: 'AI短剧', hot: true },
  { key: 'cn', label: '国产' }, { key: 'jk', label: '日韩' }, { key: 'anime', label: '动漫' },
  { key: 'show', label: '综艺' }, { key: 'doc', label: '纪录片' }
])

export const getMainTabs = () => ok([
  { key: 'home', label: '首页', icon: 'tHome' }, { key: 'short', label: '短视频', icon: 'tShort' },
  { key: 'live', label: '直播', icon: 'tLive' }, { key: 'community', label: '社区', icon: 'tCommunity' },
  { key: 'nearby', label: '同城', icon: 'tNearby' }, { key: 'me', label: '我的', icon: 'tMe' }
])

export const getRecommendSections = () => ok(D.SECTION_TITLES.slice(0, 6).map((title, i) => ({
  id: i,
  topicId: i,
  title,
  subtitle: '',
  featured: i === 0,
  size: i === 0 ? 5 : 4,
  seed: 'rec' + i,
  batches: 4
})))

export const getVideos = (seed, size = 4) => ok(makeVideos(size, String(seed)))

export const getLatestFilters = () => ok({
  dates: D.LATEST_DATE_COUNTS.map((count, i) => {
    const d = new Date()
    d.setDate(d.getDate() - i)
    return { label: i === 0 ? '今天' : i === 1 ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`, count }
  }),
  regions: D.LATEST_REGIONS.map(([label, count]) => ({ label, count }))
})

export const getLatestVideos = ({ date = 0, region = 0 } = {}) => ok(makeVideos(14, `late${date}_${region}_0`, true))

export const getCategoryFilters = () => ok(D.CATEGORY_FILTERS.slice())
export const getCategoryVideos = (tab, { filter = 0 } = {}) => ok(makeVideos(14, `tab_${tab}${filter}`))

/* ---------------- 搜索 ---------------- */

export const getHotWords = (page = 0) => ok(Array.from({ length: 8 }, (_, i) => {
  const [word, hot] = D.HOT_POOL[(page * 8 + i) % D.HOT_POOL.length]
  return { word, hot: !!hot }
}))

export const getCreators = () => ok(D.CREATORS.slice(0, 5).map(name => ({
  id: null, name, handle: name, verified: false, avatar: avatar(name)
})))

const RECENT = makeVideos(9, 'recent')
export const getRecentSearches = (page = 0) =>
  ok(Array.from({ length: 5 }, (_, i) => RECENT[(page * 5 + i) % RECENT.length]))

export const searchVideos = q => {
  const list = makeVideos(10, 'sr:' + q).map(v => ({ ...v, title: `${q} · ${v.title}` }))
  return ok({ total: list.length * 12 + 7, list })
}

/* ---------------- 专题 ---------------- */

/* 专题头图：场景按专题错开一位（与 server/db/seed.mjs 的 heroKinds 一致），片库卡片取第一张 */
const HERO_KINDS = [0, 2, 1, 5, 4, 3]
const heroCovers = id => [0, 1, 2, 3].map(k =>
  cover(`hero${id}${k}`, { kind: HERO_KINDS[(id + k) % HERO_KINDS.length], vignette: false, w: 300, h: 600 }))

export const getTopic = id => {
  id = Number(id) || 0
  return ok({
    id,
    slug: D.TOPIC_NAMES[id] ?? 'featured',
    name: D.TOPIC_NAMES[id] ?? D.TOPIC_NAMES[0],
    plays: '8.1k',
    favs: 2,
    total: 45,
    covers: heroCovers(id),
    sorts: D.TOPIC_SORTS.slice()
  })
}

export const getTopicVideos = (id, sort = 0, seed = 0) => ok({
  total: 45,
  list: makeVideos(14, `topic${Number(id) || 0}:${sort}:${seed}`)
})

/* 片库卡片用专题的第一张头图（与接口一致） */
export const getLibrary = () => ok(D.LIBRARY_CATEGORIES.map((name, i) => {
  const id = D.TOPIC_NAMES.indexOf(name)
  return { id, name, count: 120 + i * 37, cover: heroCovers(id)[0] }
}))

/* ---------------- 短视频 ---------------- */

/* ---------------- 播放页 ---------------- */

export const getVideo = id => {
  const v = withDetail(videoById(id))
  const r = rng('rank:' + id)
  return ok({ ...v, disliked: false, src: null, region: D.LATEST_REGIONS[Math.floor(r() * 3)][0], quality: 'hd', description: '', rank: r() < 0.5 ? 1 + Math.floor(r() * 20) : null })
}

export const getRelatedVideos = (id, batch = 0, limit = 6) => ok(makeVideos(limit, `rel_${id}_${batch}`).map(withDetail))

/* 演示数据只有一页；src 为空 = 没有素材文件，短视频页用封面 + 模拟进度 */
export const getShorts = ({ offset = 0 } = {}) => ok(offset > 0 ? [] : D.SHORTS.map((s, i) => ({
  id: i,
  tags: s.tags,
  title: s.title,
  like: s.like,
  likes: s.like,
  liked: false,
  fav: s.fav,
  faved: false,
  len: s.len,
  src: null,
  cover: cover('short' + i, { vignette: false, w: 720, h: 1280 })
})))

/* ---------------- 社区 ---------------- */

const postAvatar = a => {
  if (a === 'brand:ai') return brandAvatar('ai')
  if (a === 'brand:md') return brandAvatar('md')
  return avatar(a[0], a[1])
}

/* 文档帖只有文档页缩略图；视频 / 图文帖是 16:9 主图 + 三张配图（演示数据没有关联视频，videoId 为 null） */
const POSTS = D.POSTS.map((p, i) => ({
  ...p,
  id: i + 1,
  time: p.time,
  faved: false,
  videoId: null,
  avatar: postAvatar(p.avatar),
  media: p.kind === 'doc'
    ? { main: null, thumbs: [0, 1, 2].map(k => docThumb('doc' + k, k === 2)) }
    : {
        main: cover('post' + i, { vignette: false, w: 800, h: 450 }),
        thumbs: [0, 1, 2].map(k => cover(`post${i}t${k}`, { kind: (i + k + 1) % 6, w: 360, h: 320 }))
      }
}))

export const getCommunityTabs = () => ok(D.COMMUNITY_TABS.slice())
export const getPosts = (tab = 0) => {
  const list = POSTS.slice()
  if (tab % 2) list.reverse()
  return ok(list)
}

/* 兜底模式下的互动只改内存，刷新即失效（真实数据在接口那边） */
export const togglePostFav = (id, on) => ok({ active: !!on })
export const toggleVideoFav = (id, on) => ok({ active: !!on })
export const toggleVideoLike = (id, on) => ok({ active: !!on })
export const toggleVideoDislike = (id, on) => ok({ active: !!on })
export const toggleTopicFav = (id, on) => ok({ active: !!on })

/* ---------------- 直播 / 同城 ---------------- */

export const getLiveTabs = () => ok(D.LIVE_TABS.slice())
export const getLives = ({ tab = 0 } = {}) => {
  const items = D.LIVES.concat(D.LIVES.slice().reverse())
  return ok(items.map(([title, sub, w], i) => ({
    id: i,
    title,
    sub,
    live: i % 4 !== 3,
    viewers: (w * (1 + (i % 3) * 0.3)).toFixed(1) + 'w',
    cover: cover('live' + i, { kind: [0, 1, 3, 5, 4, 2][i % 6], w: 480, h: 640 })
  })))
}

export const getNearbyFilters = () => ok(D.NEARBY_FILTERS.map(label => ({ label, category: null })))
export const getNearby = () => {
  const items = D.NEARBY.concat(D.NEARBY.slice().reverse())
  return ok(items.map(([title, tags, distance, price], i) => ({
    id: i,
    title,
    tags,
    distance,
    price,
    cover: cover('nb' + i, { kind: [3, 5, 0, 4, 1, 2][i % 6], w: 400, h: 400 })
  })))
}

/* ---------------- 我的 ---------------- */

export const getProfile = () => ok({
  id: 1,
  name: '游客_10086',
  uid: '10086',
  loggedIn: false,
  avatar: avatar('游', 'guest'),
  stats: [
    { label: '观看历史', value: 128, to: '/history' },
    { label: '我的收藏', value: 36 },
    { label: '离线缓存', value: 12 },
    { label: '我的关注', value: 5 }
  ]
})

export const getHistory = () => ok(makeVideos(14, 'hist'))

export default {
  getHomeTabs, getMainTabs, getRecommendSections, getVideos, getLatestFilters, getLatestVideos,
  getCategoryFilters, getCategoryVideos, getHotWords, getCreators, getRecentSearches, searchVideos,
  getTopic, getTopicVideos, getLibrary, getVideo, getRelatedVideos, getShorts, getCommunityTabs, getPosts,
  togglePostFav, toggleVideoFav, toggleVideoLike, toggleVideoDislike, toggleTopicFav,
  getLiveTabs, getLives, getNearbyFilters, getNearby, getProfile, getHistory
}
