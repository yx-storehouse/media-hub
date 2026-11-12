<script>
/*
 * 返回恢复：主页不常驻（不在 KeepAlive 里），点进视频 / 帖子再按返回时，用离开前存下的状态
 * （已加载的列表、标签页、排序、滚动位置）原样放回，不用从头加载、也不会回到顶部。
 * 只在「返回到这条历史记录」时恢复（history.state.forward 有值）；重新点进来是全新的一页。
 */
const snapshots = new Map()
const SNAPSHOT_TTL = 10 * 60 * 1000
const SNAPSHOT_MAX = 6
</script>

<script setup>
import { ref, shallowRef, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router'
import { getCreator, getCreatorVideos, getCreatorAlbums, getCreatorPosts, getCreatorMedia, getAlbum, toggleFollow } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import Icon from '@/components/Icon.vue'
import VideoCard from '@/components/VideoCard.vue'
import ImageViewer from '@/components/ImageViewer.vue'
import PostCard from '@/components/community/PostCard.vue'
import PostSkeleton from '@/components/community/PostSkeleton.vue'
import CreatorHeader from '@/components/creator/CreatorHeader.vue'
import MediaGrid from '@/components/creator/MediaGrid.vue'
import AlbumGrid from '@/components/creator/AlbumGrid.vue'
import UnfollowSheet from '@/components/creator/UnfollowSheet.vue'
import ContentSwap from '@/components/home/ContentSwap'
import { createFeed, PAGE } from '@/components/creator/feed'
import { haptic } from '@/utils/motion'
import { cameBack, useSlider, cover, vRise, fadeIn, scrollBehavior } from '@/components/home/motion'
import { isDesktop } from '@/composables/useDesktop'

/*
 * 创作者主页（#/creator/:id?tab=videos|images|posts|media）：头图 + 头像 + 关注 + 数据行，下面是吸顶的「视频 / 图片 / 帖子 / 媒体」标签。
 * 视频：最新 / 最热 + 两列卡片；图片：管理员在后台上传的图集（一个图集一格，三列竖格，AlbumGrid），点一格全屏看这个图集；
 * 帖子：社区卡片列表；媒体：他发过的所有图（视频封面 + 帖子的图 + 图集的每一张）拼成的三列照片墙，
 * 点帖子的图全屏看大图（左右滑看这一墙已加载的帖子图片），点图集的图看那个图集（从这一张开始），点视频进播放页。
 * 四个列表都是滚到底自动加载下一页。在内容上横着划一下（触屏）换到相邻的标签，键盘在标签上按 ← → 也能换。
 * 标签记在地址栏（replace，不多一条历史），刷新 / 返回还是同一个标签；没指定时按「视频 → 图片 → 帖子 → 媒体」取第一个有内容的。
 *
 * 桌面布局（≥ 1024px）：没有压在头图上的顶栏（返回键在 CreatorHeader 的横幅里），标签栏直接吸在页面顶上；
 * 视频是公共的自动列数网格，帖子是靠左对齐的一栏（和标签同一条左边线），图片和媒体是更密的照片墙（AlbumGrid 竖格、MediaGrid 方格，同一个规格）。
 * 只在加载失败时显示顶栏（给个返回键）。
 */
defineOptions({ name: 'CreatorView' })

const TABS = [{ key: 'videos', label: '视频' }, { key: 'images', label: '图片' }, { key: 'posts', label: '帖子' }, { key: 'media', label: '媒体' }]
const SORTS = ['最新', '最热']
/* 顶栏（返回键那一行）高度；标签栏吸顶在它下面。和样式里的 48px 保持一致；桌面布局没有这一栏，标签栏吸在最顶上 */
const TOP_BAR = 48
const topBar = () => (isDesktop.value ? 0 : TOP_BAR)
/* 头图高度，滚过它（减去顶栏）顶栏变成实底并显示名字。和 CreatorHeader 的 150px 一致 */
const BANNER = 150
/* 离底部还有这么多像素就取下一页 */
const PRELOAD = 800

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const back = useBack()
/* 按返回回到这一页：恢复出来的头部和列表不播入场 */
cameBack()

const scroller = ref(null)
const header = ref(null)
const creator = shallowRef(null)
/* 加载失败：message 给用户看；retry 只在可能是网络问题时显示（创作者不存在重试也没用） */
const failed = ref(null)
const following = ref(false)
const followers = ref(0)
const tab = ref('videos')
const sort = ref(0)
/* 每换一次排序 +1：重建网格，新列表淡入 */
const sortKey = ref(0)
const collapsed = ref(false)
/* 取消关注前的确认 */
const unfollowAsk = ref(false)
/* 看大图：{ images, index, origin, caption, albumId }（「媒体」的图片、「图片」的图集，用法见下面「看大图」一节） */
const viewer = shallowRef(null)

let currentId = null
const videos = createFeed(page => getCreatorVideos(currentId, sort.value, page))
const albums = createFeed(page => getCreatorAlbums(currentId, page))
const posts = createFeed(page => getCreatorPosts(currentId, page))
const media = createFeed(page => getCreatorMedia(currentId, page))
const feeds = { videos, images: albums, posts, media }
const feed = computed(() => feeds[tab.value])

const queryTab = v => (TABS.some(t => t.key === v) ? v : null)
/* 头部给的计数（列表还没取时标签上先显示它） */
const HEADER_COUNT = { videos: 'videoCount', images: 'albumCount', posts: 'postCount', media: 'mediaCount' }
const headerCount = (c, key) => c?.[HEADER_COUNT[key]] ?? 0
/* 标签上的数字：列表取过就用列表的 total（更新），否则用头部的计数 */
const count = key => feeds[key].total ?? headerCount(creator.value, key)

/*
 * 点 / 划到一个还没取过的标签（第一页这时才开始取）：这一栏的骨架先不露面，满 0.25 秒还没回来才淡入
 * （本地接口几十毫秒就回来，直接从空白换成内容，不先闪一下骨架；样式见 .cr-late）。
 * 进页面时头部和当前标签一起在加载，骨架照常马上出现（这时整页都是骨架，不是「闪一下」）。
 * 第一页回来（或失败）就清掉：之后换排序的骨架由 ContentSwap 自己等 0.25 秒，不能再叠一次
 */
const late = reactive({ videos: false, images: false, posts: false, media: false })
for (const [k, f] of Object.entries(feeds)) watch(() => f.total !== null || f.error, settled => { if (settled) late[k] = false })

/* ---------- 加载 ---------- */

let loadSeq = 0
let lastTop = 0
const savedTop = { videos: 0, images: 0, posts: 0, media: 0 }

function resetView() {
  creator.value = null
  failed.value = null
  following.value = false
  followers.value = 0
  sort.value = 0
  viewer.value = null
  albumSeq++
  albumCache.clear()
  goneAlbums.clear()
  for (const f of Object.values(feeds)) f.reset()
  for (const k of Object.keys(late)) late[k] = false
  collapsed.value = false
  lastTop = 0
  for (const k of Object.keys(savedTop)) savedTop[k] = 0
  if (scroller.value) scroller.value.scrollTop = 0
}

/*
 * qTab：地址栏里指定的标签（没指定就是 undefined）。总是由调用方传：在同一页里换创作者时（onBeforeRouteUpdate）
 * route 还是旧地址，要用新地址的；新地址没写标签时也不能沿用旧地址的
 */
async function load(id, qTab) {
  const token = ++loadSeq
  currentId = id
  resetView()
  const want = queryTab(qTab)
  tab.value = want || 'videos'
  feed.value.more() // 和头部同时请求
  try {
    const c = await getCreator(id)
    if (token !== loadSeq) return
    applyHeader(c)
    // 没指定标签：按「视频 → 图片 → 帖子 → 媒体」取第一个有内容的（都没有就停在视频）
    if (!want) tab.value = TABS.find(t => headerCount(c, t.key) > 0)?.key || 'videos'
    await nextTick()
    checkMore()
  } catch (e) {
    if (token !== loadSeq) return
    for (const f of Object.values(feeds)) f.reset()
    const missing = e?.status >= 400 && e?.status < 500 && e?.status !== 401
    failed.value = missing
      ? { message: (e.status === 400 && e.message) || '创作者不存在', retry: false }
      : { message: e?.message || '加载失败，请检查网络', retry: true }
  }
}

function applyHeader(c) {
  creator.value = c
  following.value = !!c.following
  followers.value = c.followers ?? 0
}

/* 头部数据（是否关注、粉丝数）在别处可能变了：静默刷新一次，失败就保持原样；同时发起的几次合并成一个请求 */
let headerReq = null
function refreshHeader() {
  const c = creator.value
  if (!c) return Promise.resolve()
  if (!headerReq) {
    headerReq = getCreator(c.id)
      .then(d => { if (creator.value?.id === c.id && !followBusy) applyHeader(d) })
      .catch(() => { /* 保持原样 */ })
      .finally(() => { headerReq = null })
  }
  return headerReq
}

/* ---------- 滚动：顶栏变实底、滚到底加载下一页 ---------- */

function onScroll() {
  const el = scroller.value
  if (!el) return
  lastTop = el.scrollTop
  collapsed.value = el.scrollTop > BANNER - TOP_BAR
  checkMore()
  // 头图视差 / 回弹放大：每帧最多改一次
  if (!parallaxRaf) parallaxRaf = requestAnimationFrame(applyParallax)
}
let parallaxRaf = 0
function applyParallax() {
  parallaxRaf = 0
  header.value?.parallax?.(scroller.value?.scrollTop ?? 0)
}
onBeforeUnmount(() => cancelAnimationFrame(parallaxRaf))
/* 窗口跨过桌面布局的宽度（1024px）：头图按新布局重新放一次（桌面没有视差，留下的位移、透明度要清掉） */
watch(isDesktop, () => nextTick(applyParallax))

function checkMore() {
  const el = scroller.value
  const f = feed.value
  if (!el || !creator.value || f.loading || f.done || f.error) return
  if (f.total === null || el.scrollHeight - el.scrollTop - el.clientHeight < PRELOAD) f.more()
}

/* 一页回来后内容可能还不满一屏：接着检查 */
watch(() => feed.value.loading, busy => { if (!busy) nextTick(checkMore) })

/* 标签栏吸顶时的滚动位置 */
const stickTop = () => Math.max(0, (header.value?.$el?.offsetHeight ?? 0) - topBar())

/* 标签下的指示条（跟着文字宽度）、排序胶囊的白底：选中项变了滑过去 */
const tabRow = ref(null)
const tabBar = ref(null)
useSlider(tabRow, tabBar, cover('.cr-tab.on .lb', 2), { key: () => tab.value, deps: () => [creator.value, ...TABS.map(t => count(t.key))] })
const sortRow = ref(null)
const sortBar = ref(null)
useSlider(sortRow, sortBar, cover('.chip.on'), { key: () => sort.value })

/* 切标签：新的一栏从切换的方向淡入一点 */
const panes = {}
function showPane(key) {
  const dir = TABS.findIndex(t => t.key === key) > TABS.findIndex(t => t.key === tab.value) ? 1 : -1
  nextTick(() => fadeIn(panes[key], { x: dir * 12 }))
}

/* ---------- 标签 / 排序 ---------- */

function selectTab(key) {
  const el = scroller.value
  if (!el || !creator.value) return
  const stick = stickTop()
  if (key === tab.value) {
    // 再点一次当前标签：回到列表开头
    if (el.scrollTop > stick) el.scrollTo({ top: stick, behavior: scrollBehavior() })
    return
  }
  savedTop[tab.value] = el.scrollTop
  const stuck = el.scrollTop >= stick - 1
  // 这一栏还没取过：骨架晚 0.25 秒再出来（见 late）
  if (feeds[key].total === null && !feeds[key].error) late[key] = true
  showPane(key)
  tab.value = key
  router.replace({ query: { ...route.query, tab: key } })
  nextTick(() => {
    // 标签栏已经吸顶：回到这个标签上次看到的位置（至少吸顶）；头部还露着就保持不动
    if (stuck) el.scrollTop = Math.max(stick, savedTop[key])
    onScroll()
  })
}

/* 方向键在标签之间切换（首尾相接；只有选中的标签能 Tab 进入） */
function onTabKey(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const i = TABS.findIndex(t => t.key === tab.value)
  const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].key
  selectTab(next)
  nextTick(() => document.getElementById(`cr-tab-${next}`)?.focus())
}

/*
 * 触屏：在标签下面的内容上横着划一下，换到左 / 右相邻的标签（和点标签一样：新的一栏从划过来的方向滑进来，到头了不绕回去）。
 * 不跟手、只认「划完」：够远（60px）、明显是横着的（横向至少是竖向的两倍）、不慢（0.7 秒内）、这期间页面没有竖着滚；
 * 从屏幕左右边缘起手的不算（留给系统的返回手势），头部、标签栏上划的不算。竖着滚动永远优先，不会误触。
 */
const SWIPE_EDGE = 24
let swipe = null
function onSwipeStart(e) {
  swipe = null
  const t = e.touches[0]
  if (e.touches.length !== 1 || !t || !creator.value) return
  if (t.clientX < SWIPE_EDGE || t.clientX > window.innerWidth - SWIPE_EDGE) return
  if (!(e.target instanceof Element) || !e.target.closest('.cr-pane')) return
  swipe = { x: t.clientX, y: t.clientY, at: performance.now(), top: scroller.value?.scrollTop ?? 0 }
}
function onSwipeEnd(e) {
  const s = swipe
  swipe = null
  const t = e.changedTouches[0]
  if (!s || !t || e.touches.length) return
  const dx = t.clientX - s.x
  const dy = t.clientY - s.y
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2 || performance.now() - s.at > 700) return
  if (Math.abs((scroller.value?.scrollTop ?? 0) - s.top) > 4) return
  const next = TABS[TABS.findIndex(x => x.key === tab.value) + (dx < 0 ? 1 : -1)]
  if (next) selectTab(next.key)
}
const onSwipeCancel = () => { swipe = null }

/* 换排序：旧列表留着等新的（ContentSwap），快的直接换成新列表，慢了（250ms）才淡入骨架 */
function changeSort(i) {
  if (sort.value === i) return
  sort.value = i
  sortKey.value++
  videos.reset()
  const el = scroller.value
  const stick = stickTop()
  if (el && el.scrollTop > stick) el.scrollTop = stick
  videos.more()
}

/* ---------- 看大图：「媒体」里的图片、「图片」里的图集 ---------- */

/*
 * viewer：{ images: 查看器里的图, index: 打开时第几张, origin: i => 第 i 张对应的格子（大图从它放大出来、关掉时缩回去）,
 *           caption: 底部的说明（图集标题）, albumId: 看的是哪个图集（帖子的图为 null） }
 * 「媒体」里点帖子的图：这一墙已加载的帖子图片一起看（左右滑），和以前一样；视频格、图集的图不进来。
 * 点图集（「图片」的一格、或「媒体」里图集的一张）：看这个图集的全部图，从点的那张开始，底部是图集标题。
 * 为了点下去马上就打开，先用手上有的图（封面 / 墙上已经有的那几张）开，其余是占位，取回图集（getAlbum）后换成整组；
 * 取过的图集记在这一页里，再点直接就是整组。
 */
const mediaGrid = ref(null)
const albumGrid = ref(null)

function openImage(item) {
  if (item.albumId != null) return openAlbumAt(item)
  const items = media.list.filter(m => m.kind === 'image' && m.albumId == null)
  const index = items.findIndex(m => m.id === item.id)
  if (index < 0) return
  viewer.value = {
    images: items.map(m => m.cover || {}),
    index,
    // 大图从点的那一格放大出来、关掉时缩回当前这张对应的格子
    origin: i => (items[i] && mediaGrid.value?.tile(items[i].id)) || null,
    caption: '',
    albumId: null
  }
}

/* 取过的图集详情：图集 id → Album（换创作者时清空） */
const albumCache = new Map()
/* 还没取回来的那几张：没有地址的占位（查看器里是一块暗色的底，卡住满 0.25 秒中间出转圈） */
const PENDING = Object.freeze({ src: null, fallback: null, pending: true })
/* 取不回来了（失败 / 已下架）：还是暗色的底，不再转圈 */
const MISSING = Object.freeze({ src: null, fallback: null })
let albumSeq = 0

/*
 * 取图集时服务器说它已经没有了（400：下架 / 删掉）：图集 id → 提示语。看大图关掉时把它从「图片」和「媒体」里撤掉
 * （开着的时候不动，免得下面的格子跟着挪）；取回来时查看器已经关了的，下次点到它只提示、当场撤掉，不再打开一个过期的封面
 */
const goneAlbums = new Map()

function dropGone() {
  if (!goneAlbums.size) return
  const gone = new Set(goneAlbums.keys())
  goneAlbums.clear()
  const isGone = id => id != null && gone.has(String(id))
  const listed = albums.list.filter(a => isGone(a.id))
  const pics = media.list.filter(m => isGone(m.albumId))
  if (!listed.length && !pics.length) return
  // 「媒体」里这几个图集一共有几张（墙上可能还没翻到全部）：「图片」里有它就用那边的张数，否则按墙上看到的最后一张算
  let picCount = 0
  for (const id of gone) {
    const a = listed.find(x => String(x.id) === id)
    const mine = pics.filter(m => String(m.albumId) === id)
    picCount += Math.max(a?.count || 0, mine.length, ...mine.map(m => m.albumIndex + 1))
  }
  if (listed.length) {
    albums.list = albums.list.filter(a => !isGone(a.id))
    if (albums.total !== null) albums.total = Math.max(albums.list.length, albums.total - listed.length)
  }
  if (pics.length) media.list = media.list.filter(m => !isGone(m.albumId))
  if (media.total !== null && picCount) media.total = Math.max(media.list.length, media.total - picCount)
  // 头部的计数（数据行、还没取过的标签上的数字）和头图（可能有它的封面）按服务器现在的重新取一次
  refreshHeader()
}

/* 点到已经知道没有了的图集：只提示，顺手撤掉 */
function goneTap(id) {
  const msg = goneAlbums.get(String(id))
  if (msg == null) return false
  toast(msg)
  dropGone()
  return true
}

function closeViewer() {
  viewer.value = null
  dropGone()
}

/* 「图片」里点一格：从封面开始看这个图集，大图从这一格放大出来、关掉时（不管翻到第几张）缩回这一格 */
function openAlbum(a) {
  if (goneTap(a.id)) return
  const known = albumCache.get(String(a.id))
  const images = known ? known.images : [a.cover, ...Array.from({ length: Math.max(0, a.count - 1) }, () => PENDING)]
  showAlbum(a.id, images, 0, () => albumGrid.value?.tile(a.id) || null, known ? known.title : a.title)
}

/* 「媒体」里点图集的一张：从这一张开始看这个图集，起飞 / 缩回都对着墙上同一张图的那一格 */
function openAlbumAt(item) {
  const id = item.albumId
  if (goneTap(id)) return
  const tileOf = i => {
    const m = media.list.find(x => x.albumId === id && x.albumIndex === i)
    return (m && mediaGrid.value?.tile(m.id)) || null
  }
  const known = albumCache.get(String(id))
  let images = known?.images
  if (!images) {
    // 墙上已经有的这个图集的图按位置放好（同一图集的图在墙上是挨着的，一般整组都在）；
    // 张数：「图片」里取过这个图集就用那边的，否则按墙上看到的最后一张算，取回来再补齐
    const mine = media.list.filter(m => m.albumId === id)
    const listed = albums.list.find(a => String(a.id) === String(id))
    const n = Math.max(listed?.count || 0, item.albumIndex + 1, ...mine.map(m => m.albumIndex + 1))
    images = Array.from({ length: n }, () => PENDING)
    for (const m of mine) images[m.albumIndex] = m.cover || PENDING
  }
  showAlbum(id, images, item.albumIndex, tileOf, known ? known.title : item.title || '')
}

function showAlbum(id, images, index, origin, caption) {
  const token = ++albumSeq
  viewer.value = { images, index, origin, caption, albumId: id }
  if (albumCache.has(String(id))) return
  getAlbum(id).then(a => {
    if (a.images.length) albumCache.set(String(id), a)
    const v = viewer.value
    if (token !== albumSeq || v?.albumId !== id || !a.images.length) return
    viewer.value = { ...v, images: a.images, caption: a.title }
  }).catch(e => {
    // 400 = 服务器说这个图集没有了（不是网络问题）：记下来，查看器关掉时从页面上撤掉
    const gone = e?.status === 400
    const msg = gone && e.message ? e.message : '图集加载失败，请检查网络'
    if (gone) goneAlbums.set(String(id), msg)
    const v = viewer.value
    if (token !== albumSeq || v?.albumId !== id) return
    // 图集刚下架 / 删掉，或者网络不好：后面没取到的占位撤掉（只留手上有的图），夹在中间的停止转圈，提示一下。
    // 没有了的图集关掉时不缩回格子（那一格马上要撤掉），原地淡出
    const imgs = v.images.map(m => (m === PENDING ? MISSING : m))
    while (imgs.length > 1 && !imgs[imgs.length - 1]?.src) imgs.pop()
    viewer.value = { ...v, images: imgs, origin: gone ? null : v.origin }
    toast(msg)
  })
}

/* ---------- 关注：乐观更新 → 一次请求（带明确的 on）→ 以返回为准，失败回滚并提示 ---------- */

let followBusy = false
function onFollow() {
  const c = creator.value
  if (!c || followBusy) return
  if (!auth.requireLogin({ then: followAfterLogin })) return // 未登录：弹登录框，登录后自动关注
  if (following.value) unfollowAsk.value = true // 取消关注先确认
  else {
    haptic()
    setFollow(true)
  }
}

/* 登录后补做关注：先按新账号取一次头部（是否已关注、粉丝数），已经关注过就不再重复 */
async function followAfterLogin() {
  await refreshHeader()
  if (following.value) toast('已关注')
  else setFollow(true)
}

/* 从确认面板取消关注：面板收起约 200ms，提示等它让开再出来（按钮和粉丝数照常立刻变） */
let toastAt = 0
function unfollowFromSheet() {
  toastAt = performance.now() + 180
  setFollow(false)
}
/* 提示：刚从确认面板点的，等面板收起再出来 */
function say(msg) {
  const wait = toastAt - performance.now()
  toastAt = 0
  if (wait > 0) setTimeout(() => toast(msg), wait)
  else toast(msg)
}

async function setFollow(next) {
  const c = creator.value
  if (!c || followBusy) return
  const before = { following: following.value, followers: followers.value }
  if (next === before.following) return
  following.value = next
  followers.value = Math.max(0, before.followers + (next ? 1 : -1))
  followBusy = true
  try {
    const res = await toggleFollow(c.id, { on: next })
    if (creator.value?.id !== c.id) return
    const on = typeof res?.active === 'boolean' ? res.active : next
    following.value = on
    if (typeof res?.followers === 'number') followers.value = res.followers
    else if (on !== next) followers.value = before.followers
    say(on ? '已关注' : '已取消关注')
  } catch (e) {
    if (creator.value?.id === c.id) {
      following.value = before.following
      followers.value = before.followers
    }
    say((e?.status === 400 || e?.code === 'demo') && e.message ? e.message : '操作失败，请稍后重试')
  } finally {
    followBusy = false
  }
}

/* 「帖子」里已显示的几页按当前账号重新取一遍、原地替换（收藏状态跟着账号走，顺序和位置不变） */
async function refetchPosts() {
  const id = currentId
  const n = posts.list.length
  if (!n) return
  try {
    const pages = []
    for (let offset = 0; offset < n; offset += PAGE) pages.push(getCreatorPosts(id, { limit: PAGE, offset }))
    const byId = new Map((await Promise.all(pages)).flatMap(r => r?.list || []).map(p => [String(p.id), p]))
    if (currentId === id) posts.list = posts.list.map(p => byId.get(String(p.id)) || p)
  } catch { /* 取不到就算了：未登录时卡片本来就不显示收藏状态 */ }
}

/* 在本页登录 / 退出后，重新取一次「是否关注」和帖子的收藏状态（未登录时接口给的都是 false） */
const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))
watch(session, (now, before) => {
  if (before === null) return // 启动时的首次校验不算
  refreshHeader()
  refetchPosts()
})

/* ---------- 返回恢复 ---------- */

const snapKey = `${window.history.state?.position ?? ''}:${route.params.id}`

function saveSnapshot() {
  if (!creator.value || failed.value) return
  snapshots.delete(snapKey)
  snapshots.set(snapKey, {
    at: Date.now(),
    id: currentId,
    creator: creator.value,
    following: following.value,
    followers: followers.value,
    tab: tab.value,
    sort: sort.value,
    top: lastTop,
    savedTop: { ...savedTop },
    videos: videos.snapshot(),
    albums: albums.snapshot(),
    posts: posts.snapshot(),
    media: media.snapshot()
  })
  while (snapshots.size > SNAPSHOT_MAX) snapshots.delete(snapshots.keys().next().value)
}

function restoreSnapshot(id) {
  const s = window.history.state?.forward ? snapshots.get(snapKey) : null
  snapshots.delete(snapKey)
  if (!s || String(s.id) !== String(id) || Date.now() - s.at > SNAPSHOT_TTL) return false
  currentId = id
  applyHeader(s.creator)
  following.value = s.following
  followers.value = s.followers
  tab.value = s.tab
  sort.value = s.sort
  videos.restore(s.videos)
  albums.restore(s.albums)
  posts.restore(s.posts)
  media.restore(s.media)
  Object.assign(savedTop, s.savedTop)
  lastTop = s.top
  return true
}

const restored = restoreSnapshot(route.params.id)
if (!restored) load(route.params.id, route.query.tab)

onMounted(() => {
  if (!restored) return
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = lastTop
    onScroll()
  })
  refreshHeader()
})
onBeforeUnmount(saveSnapshot)

onBeforeRouteUpdate(to => {
  if (to.params.id !== route.params.id) return load(to.params.id, to.query.tab)
  // 地址栏里的标签被外部改了（比如别处的链接）：跟着切
  const t = queryTab(to.query.tab)
  if (t && t !== tab.value && creator.value) selectTab(t)
})
</script>

<template>
  <div class="page creator" :class="{ 'cr-failed': failed }">
    <!-- 顶栏：返回键压在头图上；滚过头图后变成实底并显示名字 -->
    <!-- data-iv-cover：变成实底时，看大图缩回被它盖住一截的格子只缩回露出来的那块（标签栏同理） -->
    <div class="cr-top" :class="{ solid: collapsed || failed }" :data-iv-cover="collapsed || failed ? '' : null">
      <button type="button" class="cr-back hit-44 m-press-sm" aria-label="返回" @click="back"><Icon name="chevL" /></button>
      <span class="cr-tt" :aria-hidden="!collapsed">{{ creator?.name }}</span>
    </div>

    <div
      ref="scroller"
      class="scroll"
      @scroll.passive="onScroll"
      @touchstart.passive="onSwipeStart"
      @touchend.passive="onSwipeEnd"
      @touchcancel.passive="onSwipeCancel"
    >
      <div v-if="failed" class="empty cr-fail">
        {{ failed.message }}
        <button v-if="failed.retry" type="button" class="retry" @click="load(route.params.id, route.query.tab)">重试</button>
        <button v-else type="button" class="retry" @click="back">返回</button>
      </div>

      <template v-else>
        <CreatorHeader ref="header" :creator="creator" :following="following" :followers="followers" :calm="restored" @follow="onFollow" />

        <div ref="tabRow" class="cr-tabs" role="tablist" aria-label="主页内容" data-iv-cover>
          <span ref="tabBar" class="m-bar cr-bar" aria-hidden="true" />
          <button
            v-for="t in TABS"
            :id="`cr-tab-${t.key}`"
            :key="t.key"
            type="button"
            role="tab"
            class="cr-tab"
            :class="{ on: tab === t.key }"
            :aria-selected="tab === t.key"
            :aria-controls="`cr-pane-${t.key}`"
            :tabindex="tab === t.key ? 0 : -1"
            @click="selectTab(t.key)"
            @keydown="onTabKey"
          >
            <span class="lb">{{ t.label }}<span v-if="creator" class="n">{{ count(t.key) }}</span></span>
          </button>
        </div>

        <!-- 视频 -->
        <section
          v-show="tab === 'videos'"
          id="cr-pane-videos"
          :ref="el => { panes.videos = el }"
          class="cr-pane"
          role="tabpanel"
          aria-labelledby="cr-tab-videos"
        >
          <div v-if="creator && (count('videos') > 0 || sort !== 0)" ref="sortRow" class="chips">
            <span ref="sortBar" class="m-bar cr-sort-bar" aria-hidden="true" />
            <button
              v-for="(s, i) in SORTS"
              :key="s"
              type="button"
              class="chip m-off"
              :class="{ on: sort === i }"
              :aria-pressed="sort === i"
              @click="changeSort(i)"
            >
              <span class="lb">{{ s }}</span>
            </button>
          </div>
          <!-- 桌面布局：主页还在加载时给排序胶囊那一行也占好位置（两颗胶囊骨架，就是字透明的 .chip，尺寸跟着公共的胶囊走），数据回来时网格不往下跳 -->
          <div v-else-if="!creator && isDesktop" class="chips cr-sk-chips" aria-hidden="true">
            <span v-for="s in SORTS" :key="s" class="chip sk">{{ s }}</span>
          </div>
          <!-- 骨架原地淡出，新列表错峰浮现；换排序时旧列表留着等新的，快的直接换成新列表，慢了（250ms）才淡入骨架 -->
          <ContentSwap :pending="videos.total === null && !videos.error" :hold="!!creator">
            <div v-if="videos.total === null && !videos.error" class="grid g11 cr-sk" :class="{ pt: !creator, 'cr-late': late.videos }" aria-hidden="true">
              <div v-for="i in (isDesktop ? 12 : 6)" :key="i" class="vc"><div class="cv sk" /><div class="sk sk-tt" /></div>
            </div>
            <div v-else-if="videos.total === null" class="empty">
              加载失败，请检查网络
              <button type="button" class="retry" @click="videos.more()">重试</button>
            </div>
            <div v-else-if="!videos.list.length" v-rise.self class="empty">还没有发布视频</div>
            <div v-else :key="`list${sortKey}`">
              <div v-rise class="grid g11">
                <VideoCard v-for="v in videos.list" :key="v.id" :video="v" :by="false" />
              </div>
              <div class="cr-foot">
                <span v-if="videos.loading">加载中…</span>
                <button v-else-if="videos.error" type="button" class="cr-more" @click="videos.more()">加载失败，点击重试</button>
                <span v-else-if="videos.done">没有更多了</span>
              </div>
            </div>
          </ContentSwap>
        </section>

        <!-- 图片：图集（后台上传的）一个一格，三列竖格；点一格全屏看这个图集 -->
        <section
          v-show="tab === 'images'"
          id="cr-pane-images"
          :ref="el => { panes.images = el }"
          class="cr-pane cr-images"
          role="tabpanel"
          aria-labelledby="cr-tab-images"
        >
          <ContentSwap :pending="albums.total === null && !albums.error" :hold="!!creator">
            <div v-if="albums.total === null && !albums.error" class="cr-ag-sk" :class="{ 'cr-late': late.images }" aria-hidden="true">
              <div v-for="i in 12" :key="i" class="sk" />
            </div>
            <div v-else-if="albums.total === null" class="empty">
              加载失败，请检查网络
              <button type="button" class="retry" @click="albums.more()">重试</button>
            </div>
            <div v-else-if="!albums.list.length" v-rise.self class="empty">还没有图片</div>
            <div v-else>
              <!-- 和「媒体」的照片墙一样一格一格浮现（只缩放、不上下错位：格子之间只有 2px） -->
              <AlbumGrid ref="albumGrid" v-rise="{ y: 0, scale: .94, max: 12 }" :items="albums.list" @open="openAlbum" />
              <div class="cr-foot">
                <span v-if="albums.loading">加载中…</span>
                <button v-else-if="albums.error" type="button" class="cr-more" @click="albums.more()">加载失败，点击重试</button>
                <span v-else-if="albums.done">没有更多了</span>
              </div>
            </div>
          </ContentSwap>
        </section>

        <!-- 帖子：卡片和社区列表同一个组件；作者就是本页的创作者，头像 / 名字不再链接 -->
        <section
          v-show="tab === 'posts'"
          id="cr-pane-posts"
          :ref="el => { panes.posts = el }"
          class="cr-pane"
          role="tabpanel"
          aria-labelledby="cr-tab-posts"
        >
          <ContentSwap :pending="posts.total === null && !posts.error" :hold="!!creator">
            <PostSkeleton v-if="posts.total === null && !posts.error" class="cr-posts" :class="{ 'cr-late': late.posts }" :count="2" />
            <div v-else-if="posts.total === null" class="empty">
              加载失败，请检查网络
              <button type="button" class="retry" @click="posts.more()">重试</button>
            </div>
            <div v-else-if="!posts.list.length" v-rise.self class="empty">还没有发布帖子</div>
            <!-- cr-posts：桌面布局里帖子是一栏（最宽 --desk-col），左边和标签、网格对齐；手机上没有样式 -->
            <div v-else class="cr-posts">
              <PostCard v-for="p in posts.list" :key="p.id" :post="p" :author-link="false" />
              <div class="cr-foot">
                <span v-if="posts.loading">加载中…</span>
                <button v-else-if="posts.error" type="button" class="cr-more" @click="posts.more()">加载失败，点击重试</button>
                <span v-else-if="posts.done">没有更多了</span>
              </div>
            </div>
          </ContentSwap>
        </section>

        <!-- 媒体：三列照片墙（视频封面 + 帖子的图 + 图集的图），点图片看大图、点视频进播放页 -->
        <section
          v-show="tab === 'media'"
          id="cr-pane-media"
          :ref="el => { panes.media = el }"
          class="cr-pane cr-media"
          role="tabpanel"
          aria-labelledby="cr-tab-media"
        >
          <ContentSwap :pending="media.total === null && !media.error" :hold="!!creator">
            <div v-if="media.total === null && !media.error" class="cr-mg-sk" :class="{ 'cr-late': late.media }" aria-hidden="true">
              <div v-for="i in 12" :key="i" class="sk" />
            </div>
            <div v-else-if="media.total === null" class="empty">
              加载失败，请检查网络
              <button type="button" class="retry" @click="media.more()">重试</button>
            </div>
            <div v-else-if="!media.list.length" v-rise.self class="empty">还没有发布图片</div>
            <div v-else>
              <!-- 照片墙一格一格浮现（只缩放、不上下错位：格子之间只有 2px，错位会叠到下一行上） -->
              <MediaGrid ref="mediaGrid" v-rise="{ y: 0, scale: .94, max: 12 }" :items="media.list" @open="openImage" />
              <div class="cr-foot">
                <span v-if="media.loading">加载中…</span>
                <button v-else-if="media.error" type="button" class="cr-more" @click="media.more()">加载失败，点击重试</button>
                <span v-else-if="media.done">没有更多了</span>
              </div>
            </div>
          </ContentSwap>
        </section>
      </template>
      <div class="pad-b" />
    </div>

    <UnfollowSheet v-model:open="unfollowAsk" :name="creator?.name || ''" @confirm="unfollowFromSheet" />
    <!-- 看大图：从点的那一格放大出来，关掉时缩回当前这张对应的格子；看图集时底部是图集标题 -->
    <ImageViewer
      v-if="viewer"
      :images="viewer.images"
      :index="viewer.index"
      :origin="viewer.origin"
      :caption="viewer.caption"
      @close="closeViewer"
    />
  </div>
</template>

<style scoped>
/* ---- 顶栏 ---- */
.cr-top {
  position: absolute;
  top: var(--safe-t);
  left: 0;
  right: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 14px 0 12px;
  /* 透明时不挡住下面的滚动（拖头图也能滚）；变成实底后挡住，免得点穿到下面的卡片 */
  pointer-events: none;
  transition: background-color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}
.cr-top > * { pointer-events: auto; }
.cr-top.solid { background: var(--bg); box-shadow: 0 1px 0 var(--line); pointer-events: auto; }
.cr-back {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(0, 0, 0, .42);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #fff;
  transition: background-color var(--dur-2) var(--ease-out);
}
.cr-back svg { width: 18px; height: 18px; stroke-width: 2.8; }
.cr-top.solid .cr-back { background: transparent; }
/* 顶栏变实底时名字从下面浮上来，变回透明时淡出 */
.cr-tt {
  min-width: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
  opacity: 0;
  transform: translate3d(0, 8px, 0);
  transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in);
}
.cr-top.solid .cr-tt { opacity: 1; transform: none; transition: opacity var(--dur-3) var(--ease-out), transform var(--dur-3) var(--ease-out); }

.cr-fail { padding-top: 120px; }

/* ---- 吸顶标签栏 ---- */
.cr-tabs { position: sticky; top: 48px; z-index: 4; display: flex; height: 46px; border-bottom: 1px solid var(--line); background: var(--bg); }
.cr-tab { display: flex; flex: 1; justify-content: center; color: var(--t2); font-size: 16px; font-weight: 500; transition: color var(--dur-2) var(--ease-out); }
.cr-tab .lb { position: relative; display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.cr-tab .n { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
.cr-tab.on { color: var(--t1); font-weight: 700; }
/* 指示条（useSlider）：和文字一样宽，换标签时滑过去 */
.cr-bar { bottom: 0; height: 3px; border-radius: 2px; background: var(--accent); }
/* 排序胶囊的白底（useSlider）：压在灰底上面、文字下面 */
.cr-pane .chips { position: relative; z-index: 0; }
.cr-sort-bar { top: 12px; z-index: 1; height: 27.5px; border-radius: 14px; background: var(--accent); }
.cr-pane .chip { transition: color var(--dur-2) var(--ease-in-out), background-color var(--dur-2) var(--ease-in-out); }
.cr-pane [data-slider] > .chip.on { background: transparent; }
.cr-pane .chip .lb { position: relative; z-index: 2; transition: opacity var(--dur-1) var(--ease-out); }
/* 胶囊不缩放（m-off）：缩放会让文字跑到白底下面去，按下时只把字调暗 */
.cr-pane .chip:active .lb { opacity: .6; }
.cr-tab:focus-visible { outline-offset: -4px; }

/* 内容不满一屏时也能让标签栏吸顶（切标签时不跳回头部） */
.cr-pane { min-height: calc(100% - 94px); }
.cr-pane > .m-swap:first-child .grid { padding-top: 14px; }

.cr-foot { display: grid; place-items: center; height: 52px; color: var(--t2); font-size: 13px; }
.cr-more { height: 32px; padding: 0 14px; color: var(--t1); font-size: 13px; }

/* ---- 图片 / 媒体：照片墙左右贴边（不留页边距），和标签栏之间留 2px 缝；图片是 3:4 竖格，媒体是方格 ---- */
.cr-images, .cr-media { padding-top: 2px; }
.cr-ag-sk, .cr-mg-sk { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px; }
.cr-ag-sk > .sk { padding-top: 133.3333%; border-radius: 0; }
.cr-mg-sk > .sk { padding-top: 100%; border-radius: 0; }

/* ---- 骨架 ---- */
.cr-sk.pt { padding-top: 14px; }
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.cv.sk { border-radius: 8px; }
.sk-tt { width: 70%; height: 12px; margin-top: 8px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}

/*
 * 点 / 划到还没取过的标签（late，见脚本）：骨架的每一块先藏着，满 0.25 秒还没换成内容才淡入。
 * 动画挂在骨架的每一块上、不挂在骨架本身：骨架本身的透明度归 ContentSwap（换成内容时它淡出），两边不打架。
 * 帖子骨架是子组件，用 :deep 选到它的每一张。骨架格自己的闪烁（.sk）等淡入完再开始，接得上、不跳一下
 */
.cr-late > :deep(*) { animation: cr-late var(--dur-2) var(--ease-out) .25s backwards; }
.cr-late > .sk { animation: cr-late var(--dur-2) var(--ease-out) .25s backwards, sk 1.2s ease-in-out calc(.25s + var(--dur-2)) infinite; }
@keyframes cr-late { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  /* 减少动态效果：一样等 0.25 秒，到点直接出现、不淡入（全局把动画延迟清零了，这里要压回来） */
  .cr-late > :deep(*) { animation: cr-late 1ms linear .25s backwards !important; }
}

/*
 * ---- 桌面布局（≥ 1024px）----
 * 页面顶栏不显示（返回键在头图横幅里），只有加载失败时显示一行返回键；标签栏吸在页面最顶上、靠左排，
 * 和头部、网格的内容左边缘对齐（同 BackHeader 的算法：至少 --desk-pad，宽屏时跟着居中的 --desk-max 内容走）。
 */
@media (min-width: 1024px) {
  .cr-top { display: none; }
  .cr-failed .cr-top {
    display: flex;
    top: 0;
    height: 64px;
    padding: 0 max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad)));
    box-shadow: none;
  }
  .cr-failed .cr-back { width: 36px; height: 36px; margin-left: -8px; background: transparent; }
  .cr-failed .cr-back svg { width: 22px; height: 22px; }
  .cr-fail { padding-top: 160px; }

  /*
   * 底边细线只画在内容宽度里（和头部、网格一样宽）：通栏的线在宽屏上会伸出内容很远。
   * 用内容区里的一条 1px 背景图画（背景色照常铺满整行，吸顶时盖住滚过去的卡片）。
   * 48px 高、文字间距 32px、选中 600：和搜索结果、收藏的标签栏同一个规格
   */
  .cr-tabs {
    top: 0;
    gap: 32px;
    height: 48px;
    padding: 0 max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad)));
    border-bottom: 0;
    background: linear-gradient(var(--line), var(--line)) 0 100% / 100% 1px no-repeat content-box, var(--bg);
  }
  /* 左右 8px 内边距再用负外边距收回：文字位置不变，键盘焦点框不贴着字 */
  .cr-tab { flex: none; margin: 0 -8px; padding: 0 8px; }
  .cr-tab.on { font-weight: 600; }
  .cr-tab .lb { gap: 6px; }
  .cr-tab .n { font-size: 13px; }
  .cr-tab:focus-visible { outline-offset: -4px; }

  /* 排序胶囊：和网格同宽、左边对齐；白底滑块的 top 跟着上边距走 */
  .cr-pane .chips { max-width: var(--desk-max); margin: 0 auto; padding: 20px var(--desk-pad) 20px; gap: 10px; }
  .cr-sort-bar { top: 20px; }
  /* 胶囊骨架：字透明的真胶囊，宽高和「最新 / 最热」一样，这一行和真的排序行一样高；不接鼠标（没有悬停变色） */
  .cr-sk-chips > .chip { border-radius: 999px; box-shadow: none; color: transparent; pointer-events: none; }
  .cr-pane { min-height: calc(100% - 48px); }
  .cr-pane > .m-swap:first-child .grid { padding-top: 24px; }
  /* 首次加载的网格骨架上面已经有胶囊骨架那一行（同真的排序行），不再空 24px */
  .cr-sk.pt { padding-top: 0; }
  /* 骨架卡片的标题条：占的高度和真卡片的两行标题 + 信息行一样（10 + 40 + 22px） */
  .sk-tt { height: 14px; margin: 13px 0 45px; }
  /* 帖子一栏（最宽 --desk-col，卡片样式在 PostCard 里）：和上面的标签、头像同一条左边线（整页都是靠左排的，居中的一栏在这里反而对不齐） */
  .cr-posts {
    max-width: var(--desk-col);
    margin-left: max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad)));
    padding-top: 24px;
  }

  /* 图片 / 媒体的骨架：和 AlbumGrid / MediaGrid 的桌面规格一样（180px 起自动排列数、缝 6px、和网格同宽） */
  .cr-images, .cr-media { padding-top: 24px; }
  .cr-ag-sk, .cr-mg-sk {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 6px;
    max-width: var(--desk-max);
    margin: 0 auto;
    padding: 0 var(--desk-pad);
  }
  .cr-ag-sk > .sk, .cr-mg-sk > .sk { border-radius: 8px; }

  .cr-foot { height: 72px; font-size: 14px; }
  .cr-more { font-size: 14px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .cr-tab:not(.on):hover { color: var(--t3); }
  .cr-more { border-radius: 16px; transition: background-color var(--dur-2) var(--ease-out); }
  .cr-more:hover { background: var(--chip); }
  .cr-failed .cr-back { transition: background-color var(--dur-2) var(--ease-out); }
  .cr-failed .cr-back:hover { background: var(--chip); }
}
</style>
