/*
 * 本地演示数据：mock 模式，以及开发时 auto 模式下某次列表读取连不上接口时使用（见 src/api/index.js）。
 *
 * 这里保持「同步返回 Promise」的老行为，结构和新接口一致，
 * 所以页面代码不用判断自己拿到的是接口数据还是演示数据。
 * 全部内容由种子随机数生成，刷新页面不会变。
 *
 * 所有 id 都是 'demo:' 开头的字符串（demoId），和接口的数字 id 永远撞不上：
 * 带演示 id 的读取由 index.js 直接转到这里，写操作（点赞、收藏、关注…）根本不会发出去。
 */
import { rng } from '@/mock/random'
import { cover, avatar, brandAvatar, docThumb } from '@/mock/art'
import * as D from '@/mock/data'
import { ApiError } from './http'

const ok = value => Promise.resolve(value)

/** 演示 id：'demo:' + 原来的键；rawId 反过来去掉前缀（也接受没有前缀的老 id） */
const demoId = key => 'demo:' + key
const rawId = id => String(id).replace(/^demo:/, '')

/** 生成第 i 条视频；同 seedBase + i 必然得到同一条内容 */
function makeVideo(seedBase, i, dark = false) {
  const seed = `${seedBase}:${i}`, r = rng(seed)
  const len = 300 + Math.floor(r() * 2400)
  return {
    id: demoId(seed),
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

/** 由 id 还原出列表里的同一条视频：演示视频的 id 是 demo:「种子前缀:序号」，如 demo:rec0:3 */
function videoById(id) {
  const s = rawId(id), k = s.lastIndexOf(':')
  const i = k > 0 ? Number(s.slice(k + 1)) : NaN
  // 不是「前缀:序号」的 id：用整个 id 当种子，id 仍然是演示 id
  if (!Number.isInteger(i) || i < 0) return { ...makeVideo('id:' + s, 0), id: demoId(s) }
  const base = s.slice(0, k)
  const v = makeVideo(base, i, base.startsWith('late'))
  // 搜索结果的标题带着关键词前缀（见 searchVideos），这里补回去
  return base.startsWith('sr:') ? { ...v, title: `${base.slice(3)} · ${v.title}` } : v
}

/* ---------------- 首页 ---------------- */

export const getHomeTabs = () => ok([
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
  id: demoId(i),
  topicId: demoId(i),
  title,
  subtitle: '',
  featured: i === 0,
  size: i === 0 ? 5 : 4,
  seed: 'rec' + i,
  batches: 4
})))

export const getVideos = (seed, size = 4) => ok(makeVideos(size, String(seed)))

/* 和接口一致：地区第一项是「全部」，每个地区带 7 天的 counts，日期上的数字 = 全部地区之和 */
const LATEST_COUNTS = D.LATEST_REGIONS.map(([code], k) => {
  const r = rng('latest:' + code)
  return Array.from({ length: 7 }, () => 2 + Math.floor(r() * (8 - k * 2)))
})
export const getLatestFilters = ({ date = 0 } = {}) => {
  const day = Math.min(Math.max(Number(date) || 0, 0), 6)
  const all = Array.from({ length: 7 }, (_, d) => LATEST_COUNTS.reduce((sum, c) => sum + c[d], 0))
  const regions = [
    { code: 'all', label: '全部', counts: all },
    ...D.LATEST_REGIONS.map(([code, label], k) => ({ code, label, counts: LATEST_COUNTS[k] }))
  ]
  return ok({
    dates: all.map((count, i) => {
      const d = new Date()
      d.setDate(d.getDate() - i)
      return { label: i === 0 ? '今天' : i === 1 ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`, count }
    }),
    regions: regions.map(r => ({ ...r, counts: r.counts.slice(), count: r.counts[day] }))
  })
}

export const getLatestVideos = ({ date = 0, region = 0 } = {}) => ok(makeVideos(14, `late${date}_${region}_0`, true))

/* 分类筛选项和接口同结构 { label, sort_key } */
export const getCategoryFilters = () => ok(D.CATEGORY_FILTERS.map(([label, sort_key]) => ({ label, sort_key })))
export const getCategoryVideos = (tab, { filter = 0 } = {}) => ok(makeVideos(14, `tab_${tab}${filter}`))

/* ---------------- 搜索 ---------------- */

export const getHotWords = (page = 0) => ok(Array.from({ length: 8 }, (_, i) => {
  const [word, hot] = D.HOT_POOL[(page * 8 + i) % D.HOT_POOL.length]
  return { word, hot: !!hot }
}))

/* 热门创作者的 id 是 demo:c1、demo:c2…（演示数据没有创作者表），点进去是 getCreator 生成的主页 */
const MOCK_CREATORS = D.CREATORS.map((name, i) => ({
  id: demoId('c' + (i + 1)), name, handle: 'creator' + (i + 1), verified: i % 3 === 0, avatar: avatar(name)
}))
export const getCreators = () => ok(MOCK_CREATORS.slice(0, 5).map(c => ({ ...c })))

const RECENT = makeVideos(9, 'recent')
export const getRecentSearches = (page = 0) =>
  ok(Array.from({ length: 5 }, (_, i) => RECENT[(page * 5 + i) % RECENT.length]))

export const searchVideos = q => {
  const list = makeVideos(10, 'sr:' + q).map(v => ({ ...v, title: `${q} · ${v.title}` }))
  return ok({ total: list.length * 12 + 7, list })
}

/* 帖子搜索：在演示帖子的标题和话题里找 */
export const searchPosts = (q, { limit = 20, offset = 0 } = {}) => {
  const kw = String(q || '').trim().toLowerCase()
  const hit = kw ? POSTS.filter(p => p.text.toLowerCase().includes(kw) || p.tags.some(t => t.toLowerCase().includes(kw))) : []
  return ok({ total: hit.length, list: slice(hit, { limit, offset }) })
}

/* ---------------- 专题 ---------------- */

/* 专题头图：场景按专题错开一位（与 server/db/seed.mjs 的 heroKinds 一致），片库卡片取第一张 */
const HERO_KINDS = [0, 2, 1, 5, 4, 3]
const heroCovers = id => [0, 1, 2, 3].map(k =>
  cover(`hero${id}${k}`, { kind: HERO_KINDS[(id + k) % HERO_KINDS.length], vignette: false, w: 300, h: 600 }))

export const getTopic = topicId => {
  const id = Number(rawId(topicId)) || 0
  return ok({
    id: demoId(id),
    slug: D.TOPIC_NAMES[id] ?? 'featured',
    name: D.TOPIC_NAMES[id] ?? D.TOPIC_NAMES[0],
    plays: '8.1k',
    playCount: 8100,
    favs: 2,
    faved: false,
    total: 45,
    covers: heroCovers(id),
    sorts: D.TOPIC_SORTS.slice()
  })
}

export const getTopicVideos = (id, sort = 0, seed = 0) => ok({
  total: 45,
  list: makeVideos(14, `topic${Number(rawId(id)) || 0}:${sort}:${seed}`)
})

/* 片库卡片用专题的第一张头图（与接口一致） */
export const getLibrary = () => ok(D.LIBRARY_CATEGORIES.map((name, i) => {
  const id = D.TOPIC_NAMES.indexOf(name)
  return { id: demoId(id), name, count: 120 + i * 37, cover: heroCovers(id)[0] }
}))

/* ---------------- 播放页 ---------------- */

/* region 是地区 code（和接口一致）；演示数据没有观看记录，progressSec 恒为 0 */
export const getVideo = id => {
  const v = withDetail(videoById(id))
  const r = rng('rank:' + id)
  return ok({
    ...v, disliked: false, src: null, region: D.LATEST_REGIONS[Math.floor(r() * 3)][0], quality: 'hd', description: '',
    rank: r() < 0.5 ? 1 + Math.floor(r() * 20) : null, progressSec: 0, watchedAt: null
  })
}

export const getRelatedVideos = (id, batch = 0, limit = 6) => ok(makeVideos(limit, `rel_${id}_${batch}`).map(withDetail))

/*
 * 短视频推荐流的演示版：5 条精选（D.SHORTS）+ 35 条生成的，按 seed 洗牌（精选的大多排在前面），
 * exclude 里的排到后面；翻过整个池子用派生 seed（seed:r1…）再洗一轮，永远翻不到底。
 * src 为空 = 没有素材文件，短视频页用封面 + 模拟进度；作者用热门创作者（c1、c2…），点头像进 getCreator 的主页。
 */
const SHORT_POOL = [
  ...D.SHORTS.map(s => ({ ...s, curated: true })),
  ...Array.from({ length: 35 }, (_, k) => {
    const r = rng('shortx' + k)
    const tags = []
    while (tags.length < 2 + Math.floor(r() * 3)) {
      const t = '#' + TAG_POOL[Math.floor(r() * TAG_POOL.length)]
      if (!tags.includes(t)) tags.push(t)
    }
    return { tags, title: D.TITLES[Math.floor(r() * D.TITLES.length)], like: 20 + Math.floor(r() * 600), fav: 10 + Math.floor(r() * 400), len: 15 + Math.floor(r() * 75), curated: false }
  })
].map((s, i) => ({
  id: demoId('s' + i),
  tags: s.tags,
  title: s.title,
  like: s.like,
  likes: s.like,
  liked: false,
  fav: s.fav,
  favs: s.fav,
  faved: false,
  len: s.len,
  src: null,
  curated: s.curated,
  creator: (({ id, name, handle, avatar }) => ({ id, name, handle, avatar }))(MOCK_CREATORS[i % MOCK_CREATORS.length]),
  cover: cover('short' + i, { vignette: false, w: 720, h: 1280 })
}))

/** 第 round 轮的顺序：精选加 1，随机 0~1.6，exclude（只在第 0 轮）减 3 */
function shortRound(seed, round, exclude) {
  const r = rng(`${seed}:r${round}`)
  const ex = round === 0 ? new Set(exclude.map(String)) : null
  return SHORT_POOL
    .map(s => ({ s, k: (s.curated ? 1 : 0) + r() * 1.6 - (ex?.has(String(s.id)) ? 3 : 0) }))
    .sort((a, b) => b.k - a.k)
    .map(x => x.s)
}

export const getShorts = ({ seed, limit = 10, offset = 0, exclude = [] } = {}) => {
  seed = seed || Math.random().toString(36).slice(2, 10)
  limit = Math.min(Math.max(1, Math.floor(limit) || 10), 50)
  offset = Math.max(0, Math.floor(offset) || 0)
  const n = SHORT_POOL.length, rounds = new Map(), list = []
  for (let p = offset; p < offset + limit; p++) {
    const round = Math.floor(p / n)
    if (!rounds.has(round)) rounds.set(round, shortRound(seed, round, exclude))
    const { curated, ...item } = rounds.get(round)[p % n]
    list.push({ ...item, creator: { ...item.creator } })
  }
  return ok({ seed, list, hasMore: true })
}

/* ---------------- 社区 ---------------- */

const postAvatar = a => {
  if (a === 'brand:ai') return brandAvatar('ai')
  if (a === 'brand:md') return brandAvatar('md')
  return avatar(a[0], a[1])
}

/*
 * 文档帖只有文档页缩略图；视频 / 图文帖是 16:9 主图 + 三张配图。
 * 视频帖关联一条演示视频（id 是「前缀:序号」，播放页能还原出来），详情页里主图就是它的封面。
 */
const POSTS = D.POSTS.map((p, i) => ({
  ...p,
  id: demoId('p' + (i + 1)),
  // 演示数据的作者用 demo:账号 当 id（与帖子详情的 author.id 一致），点头像进 getCreator 的主页
  creatorId: demoId(p.handle),
  time: p.time,
  faved: false,
  videoId: p.kind === 'video' ? demoId(`post${i}v:0`) : null,
  avatar: postAvatar(p.avatar),
  media: p.kind === 'doc'
    ? { main: null, thumbs: [0, 1, 2].map(k => docThumb('doc' + k, k === 2)) }
    : {
        main: cover('post' + i, { vignette: false, w: 800, h: 450 }),
        thumbs: [0, 1, 2].map(k => cover(`post${i}t${k}`, { kind: (i + k + 1) % 6, w: 360, h: 320 }))
      }
}))

export const getCommunityTabs = () => ok(D.COMMUNITY_TABS.slice())
/* 0 最新 / 1 热门（倒过来）/ 2 关注、3 收藏：只给演示数据里关注 / 收藏过的（没有就是空的，和接口一致） */
export const getPosts = (tab = 0) => {
  if (tab === 2) return ok(POSTS.filter(p => followed.has(p.creatorId)))
  if (tab === 3) return ok(POSTS.filter(p => p.faved))
  const list = POSTS.slice()
  if (tab === 1) list.reverse()
  return ok(list)
}

/* 详情页：演示数据没有创作者表，作者 id 用账号；关注只记在内存里 */
const followed = new Set()
const postIndex = id => POSTS.findIndex(p => p.id === demoId(rawId(id)))
const notFound = () => Promise.reject(new ApiError('帖子不存在或已下架', { status: 400, code: 1 }))
const durSec = dur => String(dur || '').split(':').reduce((s, x) => s * 60 + (Number(x) || 0), 0)
/** 秒 → 「01:15」「1:02:05」（和接口的写法一致） */
const clock = sec => {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const p = n => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h ? `${h}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`
}
/** 去掉空的和重复的图（按 src，没有 src 按占位图） */
const distinctCovers = list => {
  const seen = new Set()
  return list.filter(c => {
    const key = c && (c.src || c.fallback)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const getPost = id => {
  const i = postIndex(id)
  if (i < 0) return notFound()
  const p = POSTS[i], n = POSTS[i + 1]
  // 详情页的图是全宽大图：同一张图取两倍尺寸（同一个种子 = 同一张照片）
  const thumbs = p.kind === 'doc' ? p.media.thumbs : [0, 1, 2].map(k => cover(`post${i}t${k}`, { kind: (i + k + 1) % 6, w: 720, h: 640 }))
  // 视频块拼图：[帖子主图, 关联视频自己的封面]（和接口一样，同一张只留一张）
  const video = p.videoId
    ? { id: p.videoId, title: p.text, cover: p.media.main, dur: p.dur, len: durSec(p.dur), frames: distinctCovers([p.media.main, videoById(p.videoId).cover]) }
    : null
  return ok({
    id: p.id,
    title: p.text,
    content: D.POST_CONTENT[i] || '',
    kind: p.kind,
    author: { id: p.creatorId, name: p.name, handle: p.handle, verified: p.verified, avatar: p.avatar },
    following: followed.has(p.creatorId),
    tags: p.tags.slice(),
    images: video && p.media.main ? thumbs : [p.media.main, ...thumbs].filter(Boolean),
    video,
    read: p.read,
    fav: p.fav,
    faved: p.faved,
    publishedAt: Math.floor(Date.now() / 1000) - (i + 1) * 1800,
    time: p.time,
    next: n ? { id: n.id, title: n.text, thumb: n.media.main || n.media.thumbs[0] || null } : null
  })
}

/* 兜底模式下的互动只改内存，刷新即失效（真实数据在接口那边） */
export const viewPost = id => {
  const p = POSTS[postIndex(id)]
  if (!p) return notFound()
  p.read++
  return ok({ read: p.read })
}
export const toggleFollow = (id, on) => {
  if (on) followed.add(demoId(rawId(id)))
  else followed.delete(demoId(rawId(id)))
  const c = mockCreator(id)
  return ok(c ? { active: !!on, followers: mockFollowers(c) } : { active: !!on })
}

/* ---------------- 创作者主页 ---------------- */

/*
 * 演示数据没有创作者表：社区帖子的作者 id 是 demo:账号，热门创作者是 demo:c1…demo:c8，
 * demo:数字 生成一个占位创作者；其余 id 当作不存在。数量、粉丝数都由 id 决定，刷新不变。
 */
const MOCK_BIOS = ['记录日常，分享喜欢的内容', '每周更新，欢迎关注', '']
function mockCreator(id) {
  const s = rawId(id), key = demoId(s)
  const p = POSTS.find(x => x.creatorId === key)
  const base = p ? { id: key, name: p.name, handle: p.handle, verified: p.verified, avatar: p.avatar }
    : MOCK_CREATORS.find(x => x.id === key)
      || (/^\d+$/.test(s) ? { id: key, name: '创作者' + s, handle: 'user' + s, verified: false, avatar: avatar('创', 'cr' + s) } : null)
  if (!base) return null
  const r = rng('creator:' + s)
  const posts = POSTS.filter(x => x.creatorId === key)
  return {
    ...base,
    bio: MOCK_BIOS[Math.floor(r() * MOCK_BIOS.length)],
    baseFollowers: 120 + Math.floor(r() * 30000),
    videoCount: Math.floor(r() * 37),
    posts,
    ageSec: posts.length ? 0 : 3600 + Math.floor(r() * 5 * 86400)
  }
}
const mockFollowers = c => c.baseFollowers + (followed.has(c.id) ? 1 : 0)
const noCreator = () => Promise.reject(new ApiError('创作者不存在', { status: 400, code: 1 }))
const slice = (list, { limit = 20, offset = 0 } = {}) => list.slice(Math.max(0, offset), Math.max(0, offset) + limit)

/** 同一创作者的视频列表；最热 = 按播放数倒序（播放数与播放页一致） */
function mockCreatorVideos(c, sort) {
  const list = makeVideos(c.videoCount, 'cr' + c.id).map(withDetail)
  return sort === 1 ? list.slice().sort((a, b) => b.playCount - a.playCount) : list
}

/*
 * 「媒体」照片墙：视频封面 + 帖子的主图和配图（文档帖的文档页不算），按发布时间倒序。
 * 帖子的发布时间和详情页一样（第 i 篇是 (i + 1) 个半小时前）。
 */
function mockCreatorMedia(c) {
  const now = Math.floor(Date.now() / 1000)
  const videos = mockCreatorVideos(c, 0).map(v => ({
    id: 'v' + v.id, kind: 'video', cover: v.cover, title: v.title, postId: null, videoId: v.id, dur: clock(v.len), publishedAt: v.publishedAt
  }))
  const images = c.posts.flatMap(p => {
    const at = now - (POSTS.indexOf(p) + 1) * 1800
    const pics = [p.media.main, ...(p.kind === 'doc' ? [] : p.media.thumbs)].filter(Boolean)
    return pics.map((pic, k) => ({ id: `i${p.id}:${k}`, kind: 'image', cover: pic, title: p.text, postId: p.id, videoId: null, dur: null, publishedAt: at }))
  })
  // 稳定排序：同一时间保持视频在前、帖子里的图按顺序
  return [...videos, ...images].sort((a, b) => b.publishedAt - a.publishedAt)
}

export const getCreator = id => {
  const c = mockCreator(id)
  if (!c) return noCreator()
  const now = Math.floor(Date.now() / 1000)
  const has = c.videoCount + c.posts.length > 0
  const lastActiveAt = has ? now - (c.posts.length ? 1800 : c.ageSec) : null
  const covers = mockCreatorVideos(c, 0).slice(0, 3).map(v => v.cover)
  return ok({
    id: c.id,
    name: c.name,
    handle: c.handle,
    avatar: c.avatar,
    verified: c.verified,
    official: false,
    bio: c.bio,
    followers: mockFollowers(c),
    videoCount: c.videoCount,
    postCount: c.posts.length,
    mediaCount: mockCreatorMedia(c).length,
    lastActiveAt,
    lastActive: !has ? '' : c.posts.length ? c.posts[0].time : c.ageSec < 86400 ? Math.floor(c.ageSec / 3600) + '小时前' : Math.floor(c.ageSec / 86400) + '天前',
    following: followed.has(c.id),
    banner: [...c.posts.map(p => p.media.main || p.media.thumbs[0]).filter(Boolean), ...covers].slice(0, 3)
  })
}

export const getCreatorVideos = (id, sort = 0, opts = {}) => {
  const c = mockCreator(id)
  if (!c) return noCreator()
  return ok({ total: c.videoCount, list: slice(mockCreatorVideos(c, Number(sort) === 1 ? 1 : 0), opts) })
}

export const getCreatorPosts = (id, opts = {}) => {
  const c = mockCreator(id)
  if (!c) return noCreator()
  return ok({ total: c.posts.length, list: slice(c.posts, opts) })
}

export const getCreatorMedia = (id, opts = {}) => {
  const c = mockCreator(id)
  if (!c) return noCreator()
  const all = mockCreatorMedia(c)
  return ok({ total: all.length, list: slice(all, opts) })
}
export const togglePostFav = (id, on) => {
  const p = POSTS[postIndex(id)]
  if (p && p.faved !== !!on) {
    p.faved = !!on
    p.fav = Math.max(0, p.fav + (on ? 1 : -1))
  }
  return ok({ active: !!on })
}
export const toggleVideoFav = (id, on) => ok({ active: !!on })
export const toggleVideoLike = (id, on) => ok({ active: !!on })
export const toggleVideoDislike = (id, on) => ok({ active: !!on })
export const toggleTopicFav = (id, on) => ok({ active: !!on })

/* ---------------- 直播 / 同城 ---------------- */

export const getLiveTabs = () => ok(D.LIVE_TABS.slice())
export const getLives = ({ tab = 0 } = {}) => {
  const items = D.LIVES.concat(D.LIVES.slice().reverse())
  return ok(items.map(([title, sub, w], i) => ({
    id: demoId('l' + i),
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
    id: demoId('n' + i),
    title,
    tags,
    distance,
    price,
    cover: cover('nb' + i, { kind: [3, 5, 0, 4, 1, 2][i % 6], w: 400, h: 400 })
  })))
}

/* ---------------- 我的 ---------------- */

/* 只在 mock 模式下用（auto 模式下个人信息不退回演示数据）；结构和接口一致，计数都是 0 */
export const getProfile = () => ok({
  id: demoId('u1'),
  name: '演示用户',
  uid: 'demo',
  avatar: avatar('演', 'guest'),
  stats: [
    { key: 'history', label: '观看历史', value: 0, to: '/history' },
    { key: 'favs', label: '我的收藏', value: 0, to: '/favorites' },
    { key: 'follows', label: '我的关注', value: 0, to: '/follows' }
  ],
  counts: { history: 0, favVideos: 0, favPosts: 0, favTopics: 0, follows: 0 }
})

export default {
  getHomeTabs, getMainTabs, getRecommendSections, getVideos, getLatestFilters, getLatestVideos,
  getCategoryFilters, getCategoryVideos, getHotWords, getCreators, getRecentSearches, searchVideos, searchPosts,
  getTopic, getTopicVideos, getLibrary, getVideo, getRelatedVideos, getShorts, getCommunityTabs, getPosts,
  getPost, viewPost, toggleFollow, togglePostFav, toggleVideoFav, toggleVideoLike, toggleVideoDislike, toggleTopicFav,
  getCreator, getCreatorVideos, getCreatorPosts, getCreatorMedia,
  getLiveTabs, getLives, getNearbyFilters, getNearby, getProfile
}
