<script>
/*
 * 这次打开 App 以来已经「依次升上来」过的相似推荐（视频 id:第几批）：
 * 返回到同一个视频、或者同一批再显示一次时不再重播入场动画。
 */
const shownRelated = new Set()
</script>

<script setup>
import { ref, shallowRef, computed, watch, nextTick, reactive, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate, onBeforeRouteLeave } from 'vue-router'
import {
  getVideo, getRelatedVideos, getCreator, toggleVideoLike, toggleVideoDislike, toggleVideoFav, toggleFollow, addHistory, isDemoId
} from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import { share } from '@/composables/useShare'
import { formatCount, formatDate } from '@/utils/format'
import { cssDuration, cssEasing, haptic, reducedMotion, scrollBehavior } from '@/utils/motion'
import Icon from '@/components/Icon.vue'
import Cover from '@/components/Cover.vue'
import VideoPlayer from '@/components/video/VideoPlayer.vue'
import RelatedVideo from '@/components/video/RelatedVideo.vue'
import ActBurst from '@/components/video/ActBurst.vue'
import RollNum from '@/components/video/RollNum.vue'
import { pickResume, setResume } from '@/components/video/resume'
import { peekVideo, rememberVideo } from '@/components/video/preview'
import { parseList, nextInList } from '@/components/video/playlist'
import { claimHero, claimRelatedHero, armHeroBack } from '@/components/motion/hero'

/*
 * 播放页：播放器 → 标题、数据、作者（关注）、简介、热门榜 / 所属专题、标签 → 相似推荐，底部赞 / 不喜欢 / 收藏 / 分享。
 * - 续播：本机和服务端记录里取更新的一份（resume.js）；播放中、切后台、离开时都记进度。
 * - 播完的「下一个」：地址里带了列表（专题「播放全部」，见 playlist.js）就是列表的下一条，否则是相似推荐的第一条；
 *   跳过去替换当前记录，连着看几个以后，返回键仍然回到进来之前的页面。
 * - 在本页登录 / 退出后重新取一次自己的赞 / 收藏 / 关注状态；没登录时点的操作，登录后补做。
 * - 本页里换视频（相似推荐、下一个、自动连播）：新视频的详情回来之前旧内容先留着（播放器立刻停、旧内容的操作不再生效），
 *   回来时一次换成新内容，不会先闪一下骨架屏、底部操作栏也不会消失又出现（见 load 的 keepMs）。
 */
defineOptions({ name: 'VideoView' })

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const back = useBack()

const video = shallowRef(null)
const related = shallowRef([])
/* 加载中先显示列表里带过来的封面和标题（preview.js） */
const preview = shallowRef(peekVideo(route.params.id))
/* 加载失败：message 给用户看；retry 只在可能是网络问题时显示（视频不存在重试也没用） */
const failed = ref(null)
const scroller = ref(null)
const relatedEl = ref(null)
/* 换一批：batch 递增；relatedKey 让新的一批重新挂上，riseRelated 决定这一批要不要依次升上来 */
const batch = ref(0)
const relatedKey = ref(0)
const riseRelated = ref(false)
/** 新的一批相似推荐到了：同一个视频的同一批这次打开 App 里只升上来一次 */
function showRelated(id, b) {
  const key = `${id}:${b}`
  riseRelated.value = !shownRelated.has(key)
  shownRelated.add(key)
  relatedKey.value++
}
const spinning = ref(false)
const tagsOpen = ref(false)
const descOpen = ref(false)
/** 从第几秒开始播（每次加载算一次） */
const startSec = ref(0)
/** 列表（专题「播放全部」）里的下一条：{ video, query } */
const listNext = shallowRef(null)
/** 作者的详细信息（认证、粉丝数）和是否已关注：视频详情里只有名字和头像，另取一次 */
const creatorInfo = shallowRef(null)
const following = ref(false)

const tags = computed(() => (video.value?.tags || []).map(t => String(t).replace(/^#/, '')))
const creator = computed(() => (video.value?.creator?.id != null ? video.value.creator : null))
const description = computed(() => String(video.value?.description || '').trim())
/* 所属专题：只认路由能打开的 id（数字，或演示数据的 demo:数字） */
const topicTo = computed(() => {
  const v = video.value
  return v?.topicName && /^(\d+|demo:\d+)$/.test(String(v.topicId ?? '')) ? `/topic/${encodeURIComponent(v.topicId)}` : null
})

/** 播完后的下一个（给播放器显示）：{ video, query, hint } */
const nextItem = computed(() => {
  const cur = video.value
  if (!cur) return null
  if (listNext.value) return { video: listNext.value.video, query: listNext.value.query, hint: '专题下一条' }
  const r = related.value.find(v => String(v.id) !== String(cur.id))
  return r ? { video: r, query: null, hint: '相似推荐' } : null
})

/* ---------- 加载 ---------- */

/*
 * 本页里换视频、新内容还没回来的这一会儿：旧内容还显示着，但播放器已经停了，赞 / 收藏 / 关注 / 分享 / 换一批 / 标签
 * 都不生效（旧播放器不接手指，返回键除外）。新内容回来、等够 keepMs、或者飞过来的缩略图落地时结束。
 */
const switching = ref(false)
let keepTimer = 0

/** 换成 id 这个视频：收起展开、清掉列表的下一条；换的是另一个视频时撤掉旧内容（播放器停下、操作栏撤掉），加载期间显示占位 */
function resetFor(id) {
  tagsOpen.value = false
  descOpen.value = false
  batch.value = 0
  listNext.value = null
  if (String(video.value?.id) !== String(id)) {
    video.value = null
    related.value = []
    creatorInfo.value = null
    following.value = false
    preview.value = peekVideo(id)
  }
}
/** 留着旧内容等新视频的这一段结束：撤掉旧的、换成 id 的占位（新内容到了时紧接着就填上，同一次渲染） */
function endSwitch(id) {
  clearTimeout(keepTimer)
  if (!switching.value) return
  switching.value = false
  resetFor(id)
}

let loadSeq = 0
/**
 * keepMs：本页里换视频时旧内容最多留多久（0 = 不留，立刻显示占位）。本地接口一般几十毫秒就回来，
 * 留着旧内容就不会在中间闪一下骨架屏；真的慢，到点照常显示占位和骨架。
 */
async function load(id, query = route.query, { keepMs = 0 } = {}) {
  const token = ++loadSeq
  failed.value = null
  clearTimeout(keepTimer)
  if (keepMs > 0 && video.value && String(video.value.id) !== String(id)) {
    switching.value = true
    playerRef.value?.pause?.()
    keepTimer = setTimeout(() => { if (token === loadSeq) endSwitch(id) }, keepMs)
  } else {
    switching.value = false
    resetFor(id)
  }
  try {
    // 相似推荐取不到不影响看视频
    const [v, list] = await Promise.all([getVideo(id), getRelatedVideos(id, { batch: 0 }).catch(() => [])])
    if (token !== loadSeq) return
    // 留着的旧内容在这一次渲染里直接换成新的：中间没有骨架屏那一帧
    endSwitch(id)
    startSec.value = pickResume(v)
    video.value = v
    related.value = list
    showRelated(v.id, 0)
    if (scroller.value) scroller.value.scrollTop = 0
    loadCreator(v)
    loadListNext(parseList(query), v.id)
    await nextTick()
    measure()
  } catch (e) {
    if (token !== loadSeq) return
    // 失败时不能留着旧视频（旧播放器、操作栏还在）：撤掉，显示失败
    endSwitch(id)
    const missing = e?.status >= 400 && e?.status < 500 && e?.status !== 401
    failed.value = missing
      ? { message: '视频不存在或已下架', retry: false }
      // 断网、超时的提示本身就是给用户看的；其他（服务器出错、返回格式不对）不把技术细节露出来
      : { message: ['network', 'timeout'].includes(e?.code) ? e.message : '加载失败，请稍后重试', retry: true }
  }
}

async function loadCreator(v) {
  const c = v.creator
  if (!c || c.id == null) return
  try {
    const d = await getCreator(c.id)
    if (video.value?.creator?.id !== c.id) return
    creatorInfo.value = { verified: !!d.verified, followers: d.followers ?? null }
    following.value = !!d.following
  } catch { /* 取不到就只显示名字和头像 */ }
}

async function loadListNext(list, id) {
  if (!list) return
  try {
    const n = await nextInList(list)
    if (String(video.value?.id) !== String(id)) return
    listNext.value = n && String(n.video.id) !== String(id) ? n : null
  } catch { /* 取不到就播相似推荐 */ }
}

async function shuffle() {
  const id = video.value?.id
  if (id == null || switching.value) return
  const b = ++batch.value
  spinning.value = true
  try {
    const list = await getRelatedVideos(id, { batch: b })
    if (b !== batch.value || id !== video.value?.id) return
    related.value = list
    showRelated(id, b)
  } catch {
    toast('加载失败，请稍后重试')
  }
}

load(route.params.id)
onBeforeRouteUpdate(to => {
  if (to.params.id === route.params.id) return
  // 封面还在往播放器飞就换了视频：浮层原地淡出
  inbound?.abort()
  // 点相似推荐过来的：缩略图正飞向播放器，新视频的播放器先藏着，落地时露出来
  const hop = claimRelatedHero(to.params.id)
  if (hop) {
    heroHold.value = true
    hop.land(() => {
      // 落地时新内容还没回来：撤掉旧的、露出新视频的占位，不会把旧视频的播放器露出来（已经又换了别的视频就不管）
      if (String(route.params.id) === String(to.params.id)) endSwitch(to.params.id)
      heroHold.value = false
    })
  }
  // 旧内容留着等新的：缩略图在飞就留到落地（400ms 是兜底），没飞（下一个、自动连播）留 250ms，和缓冲转圈同一个规矩
  load(to.params.id, to.query, { keepMs: hop ? 400 : 250 })
})

/* ---------- 共享元素过渡：从列表卡片飞进来、返回时缩回去（components/motion/hero.js） ---------- */

const root = ref(null)
const playerRef = ref(null)
/* 这一页是从卡片飞进来的：飞行期间播放器先藏着（照常挂载、加载、缓冲），落地时露出来并从头开播（:hold） */
const inbound = claimHero(route.params.id)
const heroHold = ref(!!inbound)
/* 从哪张卡片来的：返回到那一页、还是同一个视频时，播放器缩回那张卡片 */
const heroOrigin = inbound?.origin || null
onMounted(() => {
  inbound?.land(root.value?.firstElementChild, () => { heroHold.value = false })
})
/* 起飞那一刻的播放器：有画面就带上此刻的画面；还在加载就是占位的封面 */
function heroSource() {
  const p = playerRef.value?.heroSource?.()
  if (p?.el) return { ...p, cover: video.value?.cover || preview.value?.cover }
  const el = root.value?.firstElementChild
  // 加载中的占位：封面上压着 .ph-cv::after 的 rgba(0,0,0,.35)
  return el ? { el, cover: preview.value?.cover, dim: preview.value?.cover ? 0.35 : 0 } : null
}
onBeforeRouteLeave(to => {
  // 正在换视频（旧内容还留着）：按地址里的新视频算，和以前换视频时一样不缩回卡片
  armHeroBack(router, to, heroOrigin, heroSource, switching.value ? route.params.id : (video.value?.id ?? route.params.id))
})

/* ---------- 播完：下一个（替换当前记录） ---------- */

function playNext() {
  const n = nextItem.value
  if (!n) return
  rememberVideo(n.video)
  router.replace({ path: `/video/${encodeURIComponent(n.video.id)}`, query: n.query || {} })
}

/* 没有片源时「看相似推荐」：滚到相似推荐 */
function scrollToRelated() {
  const s = scroller.value
  const r = relatedEl.value
  if (!s || !r) return
  if (!related.value.length) toast('暂时没有相似推荐')
  const top = r.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop
  s.scrollTo({ top, behavior: scrollBehavior() })
}

/* ---------- 观看记录 / 续播进度（服务端只记登录用户；本机都记） ---------- */

/* 直接打开播放页（刷新、书签）时，视频可能在登录状态校验完之前就开播了：等校验完再决定记不记 */
const authReady = () => (auth.ready ? Promise.resolve() : new Promise(resolve => {
  const stop = watch(() => auth.ready, ok => {
    if (!ok) return
    stop()
    resolve()
  })
}))

/* 播放器自己报 id：换视频时旧播放器卸载那一刻 video.value 已经是新视频了 */
async function onStarted(id) {
  await authReady()
  if (auth.loggedIn && !isDemoId(id)) addHistory(id, 0).catch(() => {})
}
let lastReport = ''
function onProgress({ id, sec, len, reason }) {
  setResume(id, sec, len)
  if (reason === 'tick' || !auth.loggedIn || isDemoId(id) || sec <= 3) return
  const s = Math.floor(sec)
  // 切后台紧接着关页面会报两次同一个位置，只发一次
  const key = `${id}:${s}`
  if (key === lastReport) return
  lastReport = key
  addHistory(id, s, { progressOnly: true, keepalive: reason === 'hide' }).catch(() => {})
}

/* ---------- 登录状态变了：重新取自己的赞 / 收藏 / 关注状态（未登录时接口给的都是 false） ---------- */

const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))
/* 登录后「补做操作」和这里会同时要状态：同一个视频、同一个登录只请求一次 */
const inflight = new Map()
function syncState() {
  const v = video.value
  if (!v) return Promise.resolve()
  const key = `${v.id}|${session.value}`
  if (inflight.has(key)) return inflight.get(key)
  const p = Promise.allSettled([
    getVideo(v.id).then(d => {
      if (String(video.value?.id) !== String(v.id)) return
      video.value = { ...video.value, liked: !!d.liked, disliked: !!d.disliked, faved: !!d.faved, likeCount: d.likeCount, favCount: d.favCount }
    }),
    loadCreator(v)
  ]).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}
watch(session, (now, before) => {
  if (before !== null) syncState() // 启动时的首次校验不算
})

/* ---------- 赞 / 不喜欢 / 收藏：乐观更新 → 一次请求（服务端保证赞和不喜欢互斥）→ 以返回为准 / 失败回滚 ---------- */

const TOGGLE = { like: toggleVideoLike, dislike: toggleVideoDislike, fav: toggleVideoFav }
const FIELD = { like: 'liked', dislike: 'disliked', fav: 'faved' }
const COUNT = { like: 'likeCount', fav: 'favCount' }
const pending = new Set()

function patch(kind, on, into) {
  into[FIELD[kind]] = on
  if (COUNT[kind]) into[COUNT[kind]] = Math.max(0, (into[COUNT[kind]] ?? 0) + (on ? 1 : -1))
}

async function interact(kind) {
  const v = video.value
  if (!v || pending.size || switching.value) return
  // 未登录：弹登录框，登录后补做这一下
  if (!auth.requireLogin({ then: () => afterLogin(kind, v.id) })) return

  const next = !v[FIELD[kind]]
  // 赞和不喜欢互斥：点亮一个时，另一个若亮着就一起熄掉
  const other = next && kind === 'like' && v.disliked ? 'dislike' : next && kind === 'dislike' && v.liked ? 'like' : null
  const updated = { ...v }
  patch(kind, next, updated)
  if (other) patch(other, false, updated)
  video.value = updated

  pending.add(kind)
  try {
    const res = await TOGGLE[kind](v.id, { on: next })
    // 服务端返回了最新状态就以它为准（多端操作、重复点击时不会和服务端对不上）
    if (res && video.value?.id === v.id) {
      const sync = {}
      if (typeof res.liked === 'boolean') sync.liked = res.liked
      if (typeof res.disliked === 'boolean') sync.disliked = res.disliked
      if (typeof res.likeCount === 'number') sync.likeCount = res.likeCount
      if (kind === 'fav' && typeof res.active === 'boolean') sync.faved = res.active
      if (Object.keys(sync).length) video.value = { ...video.value, ...sync }
    }
    if (kind === 'fav') toast(next ? '已收藏' : '已取消收藏')
  } catch (e) {
    if (video.value?.id === v.id) video.value = { ...video.value, ...pick(v) } // 回滚
    toast(e?.code === 'demo' ? e.message : '操作失败，请稍后重试')
  } finally {
    pending.delete(kind)
  }
}
const pick = v => ({ liked: v.liked, disliked: v.disliked, faved: v.faved, likeCount: v.likeCount, favCount: v.favCount })

/* 登录后补做：先拿到自己真实的状态，已经是点亮的就不再点（否则会把原本的赞 / 收藏取消掉） */
async function afterLogin(kind, id) {
  await syncState()
  const v = video.value
  if (!v || String(v.id) !== String(id)) return
  if (v[FIELD[kind]]) {
    if (kind === 'fav') toast('已收藏')
    return
  }
  interact(kind)
}

/* ---------- 底部操作栏的动效（和短视频右侧按钮同一套） ---------- */

/*
 * 按下立刻缩一下（CSS :active）；状态真的变了才弹：点亮是回弹 + 赞 / 收藏冒一圈小点并轻震，熄掉是轻轻一缩。
 * 没登录会先弹登录框、请求中连点不算，所以先记下「刚点过」，等状态真的变了再动；登录后补做的那一下不动。
 * fx[kind] = { kind: 'on' | 'off' | 'tap', key }：key 递增会重新挂上图标，连点时从头播。
 */
const fx = reactive({})
const rings = reactive({})
const tappedAt = {}
const TAP_FX_MS = 600
function playFx(id, kind) {
  fx[id] = { kind, key: (fx[id]?.key || 0) + 1 }
}
function tapAct(kind) {
  if (switching.value) return
  tappedAt[kind] = performance.now()
  interact(kind)
}
function tapShare() {
  if (switching.value) return
  playFx('share', 'tap')
  share({ title: video.value?.title })
}
for (const kind of ['like', 'fav', 'dislike']) {
  watch(() => !!video.value?.[FIELD[kind]], on => {
    if (performance.now() - (tappedAt[kind] ?? -Infinity) > TAP_FX_MS) return
    tappedAt[kind] = -Infinity
    playFx(kind, on ? 'on' : 'off')
    if (on && kind !== 'dislike') {
      rings[kind] = (rings[kind] || 0) + 1
      haptic()
    }
  })
}
const fxClass = id => (fx[id] ? `fx-${fx[id].kind}` : null)
function endFx(id, e) {
  if (e.target === e.currentTarget) fx[id] = null
}

/* ---------- 关注作者 ---------- */

/** 点了关注 / 取消关注：按钮回弹一下（动画播完清掉） */
const followPop = ref(false)
let followBusy = false
async function onFollow() {
  const c = creator.value
  if (!c || followBusy || switching.value) return
  if (!auth.requireLogin({ then: () => afterLoginFollow(c.id) })) return
  const next = !following.value
  following.value = next
  followPop.value = true
  if (next) haptic()
  followBusy = true
  try {
    const res = await toggleFollow(c.id, { on: next })
    const on = typeof res?.active === 'boolean' ? res.active : next
    if (creator.value?.id === c.id) {
      following.value = on
      if (typeof res?.followers === 'number' && creatorInfo.value) creatorInfo.value = { ...creatorInfo.value, followers: res.followers }
    }
    toast(on ? '已关注' : '已取消关注')
  } catch (e) {
    if (creator.value?.id === c.id) following.value = !next
    toast(e?.code === 'demo' ? e.message : '操作失败，请稍后重试')
  } finally {
    followBusy = false
  }
}
async function afterLoginFollow(id) {
  await syncState()
  if (creator.value?.id !== id) return
  if (following.value) toast('已关注')
  else onFollow()
}

const searchTag = t => { if (!switching.value) router.push({ path: '/search', query: { q: t } }) }

/* ---------- 「展开」只在放不下时出现（标签一行、简介三行） ---------- */

const tagList = ref(null)
const canExpand = ref(false)
const descEl = ref(null)
const canExpandDesc = ref(false)
function measure() {
  const t = tagList.value
  if (t && !tagsOpen.value) canExpand.value = t.scrollWidth > t.clientWidth + 1
  const d = descEl.value
  if (d && !descOpen.value) canExpandDesc.value = d.scrollHeight > d.clientHeight + 1
}
let ro = null
onMounted(() => {
  if ('ResizeObserver' in window) {
    ro = new ResizeObserver(() => measure())
    if (scroller.value) ro.observe(scroller.value)
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  clearTimeout(keepTimer)
})

/*
 * 展开 / 收起（标签、简介）：先量好切换前后的高度，再在这一小块上做一次高度过渡，
 * 下面的内容跟着平滑移动，不是一下子跳过去。减少动态效果时直接切换。
 */
const tagsEl = ref(null)
async function animateHeight(el, change) {
  if (!el || !el.animate || reducedMotion()) {
    change()
    return
  }
  // 上一次还没播完就又点：从当前看到的高度接着过渡
  const from = el.getBoundingClientRect().height
  el._heightAnim?.cancel()
  change()
  await nextTick()
  const to = el.getBoundingClientRect().height
  if (Math.abs(to - from) < 1) return
  el.style.overflow = 'hidden'
  const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: cssDuration('--dur-3'), easing: cssEasing('--ease-out') })
  el._heightAnim = a
  a.onfinish = a.oncancel = () => {
    if (el._heightAnim !== a) return
    el._heightAnim = null
    el.style.overflow = ''
  }
}
const toggleTags = () => animateHeight(tagsEl.value, () => { tagsOpen.value = !tagsOpen.value })
const toggleDesc = () => animateHeight(descEl.value, () => { descOpen.value = !descOpen.value })

/* iOS Safari 只有挂了 touchstart 监听的区域才会出现 :active 按压效果 */
const noop = () => {}
</script>

<template>
  <div ref="root" class="page video" :class="{ 'hero-hold': heroHold, switching }" @touchstart.passive="noop">
    <VideoPlayer
      v-if="video"
      ref="playerRef"
      :key="video.id"
      :video="video"
      :start="startSec"
      :next="nextItem"
      :hold="heroHold"
      @back="back"
      @started="onStarted"
      @progress="onProgress"
      @next="playNext"
      @related="scrollToRelated"
    />
    <!-- 加载中 / 失败时的占位：有列表带过来的封面就先显示；保留返回键，用户随时能离开 -->
    <div v-else class="player-ph" :aria-busy="!failed">
      <Cover v-if="preview?.cover && !failed" class="ph-cv" v-bind="preview.cover" eager />
      <div v-if="!failed" class="ph-spin" aria-hidden="true" />
      <button type="button" class="ph-back hit-44" aria-label="返回" @click="back"><Icon name="chevL" /></button>
    </div>

    <div ref="scroller" class="scroll">
      <div v-if="failed" class="empty">
        {{ failed.message }}
        <button v-if="failed.retry" type="button" class="retry" @click="load(route.params.id)">重试</button>
      </div>

      <template v-else-if="video">
        <section class="info">
          <h1 class="v-title">{{ video.title }}</h1>
          <div class="v-meta">
            <span>发行: {{ formatDate(video.publishedAt) }}</span>
            <span>播放: {{ formatCount(video.playCount) }}次</span>
            <span>收藏: {{ formatCount(video.favCount) }}次</span>
          </div>

          <!-- 作者：头像 + 名字进主页，右边关注 -->
          <div v-if="creator" class="au">
            <RouterLink class="au-link" :to="`/creator/${encodeURIComponent(creator.id)}`">
              <Cover class="au-av" v-bind="creator.avatar || {}" />
              <div class="au-who">
                <div class="au-nm">
                  <span>{{ creator.name || '未命名创作者' }}</span>
                  <Icon v-if="creatorInfo?.verified" name="verified" class="vf" />
                </div>
                <div class="au-sub">
                  <template v-if="creatorInfo?.followers != null">{{ formatCount(creatorInfo.followers) }} 粉丝</template>
                  <template v-else-if="creator.handle">@{{ creator.handle }}</template>
                </div>
              </div>
            </RouterLink>
            <button
              type="button"
              class="au-follow"
              :class="{ on: following, pop: followPop }"
              :aria-pressed="following"
              @click="onFollow"
              @animationend.self="followPop = false"
            >
              <template v-if="following">已关注</template>
              <template v-else><Icon name="plus" />关注</template>
            </button>
          </div>

          <!-- 简介：超过三行可以展开 -->
          <div v-if="description" class="desc" :class="{ open: descOpen }">
            <p ref="descEl" class="desc-t">{{ description }}</p>
            <button v-if="canExpandDesc || descOpen" type="button" class="more" :aria-expanded="descOpen" @click="toggleDesc">
              {{ descOpen ? '收起' : '展开' }}<Icon name="chevD" />
            </button>
          </div>

          <!-- 热门榜名次（目前没有榜单页，只是标识）、所属专题 -->
          <div v-if="video.rank || topicTo" class="v-chips">
            <span v-if="video.rank" class="rank"><Icon name="flame" class="fl" />热门榜 No.{{ video.rank }}</span>
            <RouterLink v-if="topicTo" class="topic" :to="topicTo">
              <span class="lb">专题</span><span class="nm">{{ video.topicName }}</span><Icon name="chevR" />
            </RouterLink>
          </div>

          <div v-if="tags.length" ref="tagsEl" class="v-tags" :class="{ open: tagsOpen }">
            <span class="lb">标签:</span>
            <div ref="tagList" class="list">
              <button v-for="t in tags" :key="t" type="button" class="tag" @click="searchTag(t)">{{ t }}</button>
            </div>
            <button v-if="canExpand || tagsOpen" type="button" class="more" :aria-expanded="tagsOpen" @click="toggleTags">
              {{ tagsOpen ? '收起' : '展开' }}<Icon name="chevD" />
            </button>
          </div>
        </section>

        <section ref="relatedEl" class="related">
          <div class="r-hd">
            <h2 class="r-t">相似推荐</h2>
            <button type="button" class="r-more" :class="{ spin: spinning }" @click="shuffle" @animationend="spinning = false">
              <Icon name="refresh" />换一批
            </button>
          </div>
          <!-- 每一批第一次出现时一条条错开升上来（最多错开前 8 条），返回再看同一批不重播 -->
          <div :key="relatedKey" class="r-list" :class="{ rise: riseRelated }">
            <RelatedVideo v-for="(v, i) in related" :key="v.id" :video="v" :style="{ '--i': Math.min(i, 7) }" />
            <div v-if="!related.length" class="r-empty">暂时没有相似推荐</div>
          </div>
        </section>
        <div class="pad-b" />
      </template>

      <!-- 加载中：信息区骨架（有列表带过来的标题就先显示标题） -->
      <div v-else class="info" aria-hidden="true">
        <h1 v-if="preview?.title" class="v-title">{{ preview.title }}</h1>
        <div v-else class="sk sk-t" />
        <div class="sk sk-m" />
        <div class="au">
          <div class="au-av sk" />
          <div class="au-who">
            <div class="sk sk-l" style="width: 96px" />
            <div class="sk sk-s" style="width: 64px" />
          </div>
        </div>
        <div class="sk sk-m" style="width: 70%" />
        <div v-for="i in 3" :key="i" class="sk-row">
          <div class="sk sk-cv" />
          <div class="sk-col">
            <div class="sk sk-l" />
            <div class="sk sk-s" style="width: 50%" />
          </div>
        </div>
      </div>
    </div>

    <!-- 按视频 id 重新挂上：换视频时数字直接换成新视频的，不会像点了赞那样翻过去 -->
    <nav v-if="video" :key="video.id" class="acts" aria-label="视频操作">
      <button type="button" :class="{ on: video.liked }" :aria-pressed="!!video.liked" :aria-label="`点赞 ${video.likeCount ?? 0}`" @click="tapAct('like')">
        <span class="ico">
          <Icon :key="fx.like?.key || 0" name="thumbUp" :class="fxClass('like')" @animationend="endFx('like', $event)" />
          <ActBurst v-if="rings.like" :key="rings.like" @done="rings.like = 0" />
        </span>
        <RollNum :value="formatCount(video.likeCount)" :n="video.likeCount ?? 0" />
      </button>
      <button type="button" :class="{ on: video.disliked }" :aria-pressed="!!video.disliked" @click="tapAct('dislike')">
        <span class="ico"><Icon :key="fx.dislike?.key || 0" name="thumbDown" :class="fxClass('dislike')" @animationend="endFx('dislike', $event)" /></span>
        <span>不喜欢</span>
      </button>
      <button type="button" :class="{ on: video.faved }" :aria-pressed="!!video.faved" :aria-label="`收藏 ${video.favCount ?? 0}`" @click="tapAct('fav')">
        <span class="ico">
          <Icon :key="fx.fav?.key || 0" name="heart" :class="fxClass('fav')" @animationend="endFx('fav', $event)" />
          <ActBurst v-if="rings.fav" :key="rings.fav" @done="rings.fav = 0" />
        </span>
        <RollNum :value="formatCount(video.favCount)" :n="video.favCount ?? 0" />
      </button>
      <button type="button" @click="tapShare">
        <span class="ico"><Icon :key="fx.share?.key || 0" name="shareNodes" :class="fxClass('share')" @animationend="endFx('share', $event)" /></span>
        <span>分享</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.page.video { background: var(--bg); }
/* 封面正从列表飞过来：播放器（或加载中的占位）先藏着，落地时由浮层原样接上 */
.video.hero-hold > .player, .video.hero-hold > .player-ph { opacity: 0; }
/* 换视频、旧内容还留着的那一会儿：旧播放器（重播、下一个、控制栏）和底部操作栏不接手指，返回键照常能点 */
.video.switching > .acts, .video.switching > .player, .video.switching > .player :deep(*) { pointer-events: none; }
.video.switching > .player.ui-on :deep(.back) { pointer-events: auto; }

.player-ph { position: relative; flex: none; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; background: #000; }
.ph-cv { position: absolute; inset: 0; filter: var(--media); }
.ph-cv::after { content: ''; position: absolute; inset: 0; background: rgba(0, 0, 0, .35); }
/* 和播放器的缓冲转圈（.spinner）一样大、一样等 0.25 秒还在加载才淡入：接口很快回来时不闪，换成播放器时大小不跳 */
.ph-spin {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 34px;
  height: 34px;
  margin: -17px 0 0 -17px;
  border: 3px solid rgba(255, 255, 255, .25);
  border-top-color: #fff;
  border-radius: 50%;
  animation: rot .8s linear infinite, ph-spin-in var(--dur-2) var(--ease-out) .25s backwards;
}
@keyframes ph-spin-in { from { opacity: 0; } }
.ph-back { position: absolute; left: 6px; top: 6px; display: grid; place-items: center; width: 40px; height: 40px; color: #fff; }
.ph-back svg { width: 24px; height: 24px; stroke-width: 2.6; filter: drop-shadow(0 1px 3px rgba(0, 0, 0, .5)); }

/* ---------- 标题 / 数据 / 标签 ---------- */
.info { padding: 14px 14px 0; }
.v-title { font-size: 17px; font-weight: 700; line-height: 25px; word-break: break-all; }
.v-meta { display: grid; grid-template-columns: repeat(3, 1fr); column-gap: 8px; margin-top: 8px; color: var(--t2); font-size: 13px; line-height: 20px; }
.v-meta span { white-space: nowrap; }

/* ---------- 作者 ---------- */
.au { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.au-link { display: flex; flex: 1; align-items: center; gap: 10px; min-width: 0; }
.au-av { flex: none; width: 38px; height: 38px; border-radius: 50%; filter: var(--media); }
.au-who { display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 3px; min-width: 0; }
.au-nm { display: flex; align-items: center; gap: 4px; min-width: 0; }
.au-nm span { overflow: hidden; font-size: 15px; font-weight: 600; line-height: 20px; white-space: nowrap; text-overflow: ellipsis; }
.au-nm .vf { width: 14px; height: 14px; }
.au-sub { overflow: hidden; color: var(--t2); font-size: 12px; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.au-follow {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  gap: 3px;
  height: 30px;
  padding: 0 14px 0 11px;
  border-radius: 15px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 700;
}
.au-follow::after { content: ''; position: absolute; inset: -7px -4px; }
.au-follow svg { width: 13px; height: 13px; stroke-width: 3; }
.au-follow.on { padding: 0 13px; background: var(--chip); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1); color: var(--t2); font-weight: 500; }
.au-follow { transition: transform var(--dur-2) var(--ease-spring); }
.au-follow:active { transform: scale(var(--press-scale)); transition: transform var(--dur-1) var(--ease-out); }
/* 关注 / 取消关注：先缩一下再回弹到位，盖住文字和底色的切换 */
.au-follow.pop { animation: follow-pop var(--dur-3) var(--ease-out); }
@keyframes follow-pop {
  0% { transform: scale(.86); }
  55% { transform: scale(1.06); }
  100% { transform: scale(1); }
}

/* ---------- 简介 ---------- */
.desc { margin-top: 10px; }
.desc-t {
  display: -webkit-box;
  overflow: hidden;
  color: var(--t3);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: break-word;
  word-break: break-word;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
/* 收起时分段并成一段（空行不占折叠的行数），展开后按原样分段 */
.desc.open .desc-t { display: block; white-space: pre-line; -webkit-line-clamp: unset; }
.desc .more { margin-top: 2px; }

/* ---------- 热门榜 / 所属专题 ---------- */
.v-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.rank, .topic {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
  height: 28px;
  padding: 0 11px;
  border: 1px solid #2a2a2a;
  border-radius: 14px;
  background: linear-gradient(90deg, #191919, #111);
  font-size: 13px;
}
.rank { color: var(--t1); font-weight: 700; }
.rank .fl { width: 12px; height: 14px; }
.topic { position: relative; color: var(--t1); }
.topic::after { content: ''; position: absolute; inset: -8px -2px; }
.topic .lb { flex: none; color: var(--t2); }
.topic .nm { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.topic svg { width: 12px; height: 12px; margin-right: -3px; color: var(--t2); stroke-width: 2.6; }
.topic:active { background: #1c1c1c; }

.v-tags { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.v-tags .lb { flex: none; color: var(--t2); font-size: 13px; }
.v-tags .list { display: flex; flex: 1; gap: 7px; min-width: 0; overflow: hidden; }
.v-tags.open { align-items: flex-start; }
.v-tags.open .lb { line-height: 24px; }
.v-tags.open .list { flex-wrap: wrap; }
.tag { flex: none; height: 24px; padding: 0 11px; border-radius: 12px; background: var(--chip); color: #b5b5b5; font-size: 12px; }
.tag:active { background: #222; }
.more { display: flex; flex: none; align-items: center; gap: 2px; height: 24px; color: var(--t1); font-size: 13px; font-weight: 500; }
.more svg { width: 13px; height: 13px; stroke-width: 2.6; transition: transform var(--dur-3) var(--ease-in-out); }
.v-tags.open .more svg, .desc.open .more svg { transform: rotate(180deg); }

/* ---------- 相似推荐 ---------- */
.related { margin-top: 16px; padding: 4px 0 6px; border-radius: 14px 14px 0 0; background: var(--panel); }
.r-hd { display: flex; align-items: center; justify-content: space-between; height: 48px; padding: 0 14px 0 12px; }
.r-t { display: flex; align-items: center; gap: 6px; font-size: 16px; font-weight: 600; }
.r-t::before { content: ''; width: 3px; height: 16px; border-radius: 2px; background: var(--accent); }
.r-more { position: relative; display: flex; align-items: center; gap: 4px; color: var(--t1); font-size: 13px; }
.r-more svg { width: 13px; height: 13px; }
.r-more::after { content: ''; position: absolute; inset: -12px -10px; }
.r-list { display: flex; flex-direction: column; gap: 14px; }
/* 一条条错开升上来（--i 由模板给，最多错开前 8 条）；不挡点击 */
.r-list.rise > * { animation: m-rise var(--dur-3) var(--ease-out) backwards; animation-delay: calc(var(--i, 0) * var(--stagger)); }
.r-empty { padding: 18px 0 24px; color: var(--t2); font-size: 13px; text-align: center; }

/* ---------- 底部操作栏 ---------- */
.acts {
  display: grid;
  flex: none;
  grid-template-columns: repeat(4, 1fr);
  height: calc(56px + var(--safe-b));
  padding-bottom: var(--safe-b);
  border-top: 1px solid var(--line);
  background: var(--bg);
}
.acts button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: var(--t2); font-size: 11px; font-variant-numeric: tabular-nums; transition: color var(--dur-1) var(--ease-out); }
/* 图标外面包一层：按压缩放在外层，状态动画在图标上，两者叠加互不打断 */
.acts .ico { position: relative; display: block; width: 23px; height: 23px; transition: transform var(--dur-2) var(--ease-spring); }
.acts button:active .ico { transform: scale(var(--press-scale-sm)); transition: transform var(--dur-1) var(--ease-out); }
/* 填充用 fill-opacity 过渡（fill 从 none 到颜色没法渐变） */
.acts svg { width: 23px; height: 23px; fill: currentColor; fill-opacity: 0; stroke-width: 1.8; transition: fill-opacity var(--dur-1) var(--ease-out); }
.acts .on { color: var(--t1); }
.acts .on svg { fill-opacity: 1; }
/* 点亮：先缩一下再回弹放大；熄掉：轻轻一缩；分享：小弹一下 */
.acts svg.fx-on { animation: act-on var(--dur-3) var(--ease-out); }
.acts svg.fx-off { animation: act-off var(--dur-2) var(--ease-out); }
.acts svg.fx-tap { animation: act-tap var(--dur-3) var(--ease-spring); }
@keyframes act-on {
  0% { transform: scale(.6); }
  50% { transform: scale(1.22); }
  100% { transform: scale(1); }
}
@keyframes act-off {
  50% { transform: scale(.82); }
}
@keyframes act-tap {
  from { transform: scale(.82); }
}

/* ---------- 骨架 ---------- */
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.au-av.sk { border-radius: 50%; }
.sk-t { height: 22px; width: 82%; }
.sk-m { height: 14px; margin-top: 12px; }
.sk-l { height: 15px; }
.sk-s { height: 12px; }
.sk-row { display: flex; gap: 11px; margin-top: 18px; }
.sk-cv { flex: none; width: 142px; aspect-ratio: 16 / 10; border-radius: 7px; }
.sk-col { display: flex; flex: 1; flex-direction: column; gap: 8px; padding-top: 2px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk, .ph-spin { animation: none; }
}
</style>
