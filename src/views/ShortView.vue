<script setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { getShorts, getVideo, getCreator, toggleVideoLike, toggleVideoFav, toggleVideoDislike, toggleFollow, addHistory, isDemoId } from '@/api'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import { useTabRetap } from '@/composables/useTabRetap'
import { isDesktop } from '@/composables/useDesktop'
import { scrollBehavior } from '@/utils/motion'
import Icon from '@/components/Icon.vue'
import BottomSheet from '@/components/BottomSheet.vue'
import ShortItem from '@/components/short/ShortItem.vue'

defineOptions({ name: 'ShortView' })

/* 「专题」还没上线：点它只提示，不切换（内容一直是推荐） */
const FEEDS = ['推荐', '专题']
const SPEEDS = ['0.5x', '0.75x', '1.0x', '1.25x', '1.5x', '2.0x']
const TICK_MS = 100
/** 每页条数；滑到离末尾还剩 PRELOAD_AHEAD 条时加载下一页 */
const PAGE_SIZE = 10
const PRELOAD_AHEAD = 3
/** 只渲染当前这条前后各 RENDER_AROUND 条，其余只留一个等高的空位：流可以一直刷下去 */
const RENDER_AROUND = 2
/** 最近刷到过的视频 id（最新的在前，最多 SEEN_MAX 个）：打开 / 刷新时交给推荐，让它们排到后面 */
const SEEN_KEY = 'reel:short:seen'
const SEEN_MAX = 100
/** 没有视频文件的条目只显示封面：这么多秒后自动连播到下一条 */
const PREVIEW_SEC = 15
/** 真实视频实际播满这么多秒才记一次观看（进观看历史、计播放数） */
const WATCH_MIN = 3
/** 第一页这么久还没回来：提示网络慢，给重试（请求本身 12 秒超时，超时后显示加载失败 + 重试） */
const SLOW_MS = 6000
/** 在第一条往下拉这么多（手指移动的像素）松手就刷新 */
const PULL_TRIGGER = 80
/** 点「不喜欢」后停一下再翻到下一条：先让人看到图标变化和提示 */
const DISLIKE_NEXT_MS = 600
/** 桌面：← / → 一次跳几秒 */
const KEY_SEEK = 5
/** 桌面：播放设置里列出来的键盘快捷键（处理在 onDeskKey） */
const KEYS = [
  { keys: ['↑', 'K'], label: '上一个' },
  { keys: ['↓', 'J'], label: '下一个' },
  { keys: ['空格'], label: '播放 / 暂停' },
  { keys: ['←', '→'], label: `后退 / 前进 ${KEY_SEEK} 秒` },
  { keys: ['M'], label: '静音 / 恢复声音' },
  { keys: ['F'], label: '全屏' },
  { keys: ['双击画面'], label: '点赞', mouse: true }
]

const store = useAppStore()
const auth = useAuthStore()
const pageEl = useTemplateRef('page')
const feedEl = useTemplateRef('feed')

/** 每条额外带一个流内唯一的 feedKey：推荐翻过一整轮后同一个视频还会再出现 */
const clips = shallowRef([])
/** playback per clip, same order as `clips`: { t: seconds, playing, len: seconds（真实视频读到文件时长后替换；没有文件时是预览时长） } */
const players = ref([])
/** clip on screen; decides which clips are rendered and which real videos preload (the playback logic uses `current`) */
const active = ref(0)
/** 第一页还没回来 / 第一页很慢 / 第一页失败 / 正在刷新 */
const loading = ref(true)
const slow = ref(false)
const failed = ref(false)
const refreshing = ref(false)
/** 下一页的状态，显示在最后一条下面的那一格：'' 平常 / 'loading' / 'failed' / 'end' */
const moreState = ref('')
/** 停在最后那一格上（和下面的 atTail 一样，桌面的「下一个」按钮要读，所以单独留一份响应式的） */
const onTail = ref(false)

const settingsOpen = ref(false)

/* playback bookkeeping that the template never reads */
let current = 0 // index of the clip that fills the screen; only this one advances
let atTail = false // 停在最后那一格（加载中 / 加载失败）上：没有哪条在播
let advancingTo = -1 // clip the feed is smooth-scrolling to after the current one ended (-1: none)
let boosted = -1 // clip held at 2x by a long press on the screen edge (-1: none)
let visible = false // page is the active KeepAlive child
let timer = 0
let io = null
let ro = null

/*
 * 推荐流：seed 决定顺序（同一个 seed 翻页稳定，换 seed 就重新洗牌），exclude 是打开 / 刷新时
 * 读到的「不喜欢」+「最近刷到过」，翻页时原样带上（服务端缓存过期重排时结果一致）。
 * generation 每次重新加载 +1：旧 seed 的请求晚回来时直接丢掉。
 */
let seed = ''
let exclude = []
let nextOffset = 0
let hasMore = true
let loadingMore = null
let generation = 0
let keySeq = 0
let slowTimer = 0

/*
 * 每条记下取到它时是以谁的身份（令牌换成一个编号，不留令牌本身）。
 * 和现在对不上的（登录前取的）赞 / 藏 / 不喜欢是旧的：滑到附近时按新身份重新取一次。
 * 直接按令牌算，登录一完成就对得上，不用等 watch。
 */
const tokenIds = new Map()
function authEpoch() {
  const t = auth.token || ''
  if (!tokenIds.has(t)) tokenIds.set(t, tokenIds.size)
  return tokenIds.get(t)
}

const isRealId = id => Number.isSafeInteger(id) && id > 0
const dislikeKey = id => `dislike:short:${id}`
/** 没有视频文件：只给一个很短的预览计时，让自动连播能往下走 */
const clipLen = clip => (clip.src ? clip.len || 0 : Math.min(clip.len || PREVIEW_SEC, PREVIEW_SEC))
const newPlayer = clip => ({ t: 0, playing: false, len: clipLen(clip) })
const newSeed = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

const curClip = computed(() => clips.value[active.value] || null)

/* ---------- 最近刷到过（localStorage，读写失败就当没有） ---------- */

let seen = null
function readSeen() {
  try {
    const list = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')
    return Array.isArray(list) ? list.filter(id => Number.isSafeInteger(id)).slice(0, SEEN_MAX) : []
  } catch {
    return []
  }
}
function markSeen(id) {
  if (!Number.isSafeInteger(id)) return
  seen ??= readSeen()
  if (seen[0] === id) return
  seen = [id, ...seen.filter(x => x !== id)].slice(0, SEEN_MAX)
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)) } catch { /* 隐私模式等：不记也能用 */ }
}
/** 交给推荐往后排的 id：本机记的「不喜欢」（最新的在前）+ 最近刷到过 */
const readExclude = () => [...new Set([...store.dislikedIds().reverse(), ...readSeen()])].slice(0, SEEN_MAX)

/**
 * 新一页接到 base 后面：和前一条是同一个视频的跳过（一轮翻完的接缝处），本机点过「不喜欢」的不再出现；
 * 每条给一个 feedKey，记下取到它时的登录状态
 */
function withKeys(list, base, epoch) {
  const out = []
  // 不用 base.at(-1)：Array.prototype.at 要 Safari 15.4 / Chrome 92，iOS 14–15.3 和老安卓 WebView 上会抛错，整个短视频页空掉
  let prev = base.length ? base[base.length - 1].id : undefined
  for (const c of list) {
    if (c.id === prev || store.has(dislikeKey(c.id))) continue
    out.push({ ...c, disliked: !!c.disliked, feedKey: ++keySeq, epoch })
    prev = c.id
  }
  return out
}

/**
 * 换一个 seed 重新拉第一页：打开页面、再点一次「短视频」Tab、下拉刷新、失败后重试。
 * 成功才替换列表（刷新失败时原来的还在），返回是否成功。
 */
async function load() {
  const gen = ++generation
  const s = newSeed()
  const ex = readExclude()
  const ep = authEpoch()
  clearTimeout(slowTimer)
  slow.value = false
  if (!clips.value.length) slowTimer = setTimeout(() => { if (gen === generation && loading.value) slow.value = true }, SLOW_MS)
  let page
  try {
    page = await getShorts({ seed: s, limit: PAGE_SIZE, offset: 0, exclude: ex })
  } catch {
    if (gen === generation && !clips.value.length) failed.value = true
    return false
  } finally {
    if (gen === generation) {
      loading.value = false
      slow.value = false
      clearTimeout(slowTimer)
    }
  }
  if (gen !== generation) return false
  leaveView()
  seed = page.seed || s
  exclude = ex
  nextOffset = PAGE_SIZE
  hasMore = page.hasMore !== false
  loadingMore = null
  moreState.value = hasMore ? '' : 'end'
  failed.value = false
  const list = withKeys(page.list || [], [], ep)
  clips.value = list
  players.value = list.map(newPlayer)
  current = 0
  atTail = false
  onTail.value = false
  navTo = -1
  active.value = 0
  advancingTo = -1
  boosted = -1
  // 换上新的一批时第一条一挂上就是「在播」：不然在 IntersectionObserver 回调（下一帧）之前有一帧是暂停态，
  // 中间的播放键整套闪出来再淡掉。之后观察者那次 play(0) 什么也不改，记观看、记刷到过照常由它来做；
  // 自动播放被拦下时 ShortItem 照常报 state=false，播放键照常淡入
  if (visible) play(0)
  await nextTick()
  if (visible) {
    scrollToClip(0)
    observe()
  }
  return true
}

function retry() {
  failed.value = false
  loading.value = true
  load()
}

/**
 * 加载下一页并接到末尾；同一时间只有一个请求。
 * 失败时最后那一格显示「网络不给力，点击重试」；滑到那一格、网络恢复（online）时会自动再试。
 */
function loadMore() {
  if (!hasMore || !clips.value.length) return Promise.resolve()
  if (loadingMore) return loadingMore
  const gen = generation
  const ep = authEpoch()
  moreState.value = 'loading'
  const p = (async () => {
    // 这一页的视频刚好都被下架了（或都点过不喜欢）就接着翻，最多连翻 3 页
    for (let tries = 0; tries < 3; tries++) {
      const page = await getShorts({ seed, limit: PAGE_SIZE, offset: nextOffset, exclude })
      if (gen !== generation) return
      // 开发时这一页连不上、退回了演示数据：不接到真实的流后面，按翻页失败处理（最后一格给重试）
      if (!isDemoId(clips.value[0]?.id) && (page.list || []).some(c => isDemoId(c.id))) throw new Error('demo page')
      nextOffset += PAGE_SIZE
      hasMore = page.hasMore !== false
      const fresh = withKeys(page.list || [], clips.value, ep)
      if (!fresh.length) {
        if (!hasMore) break
        continue
      }
      const first = clips.value.length
      clips.value = [...clips.value, ...fresh]
      players.value.push(...fresh.map(newPlayer))
      moreState.value = hasMore ? '' : 'end'
      await nextTick()
      // 停在最后那一格上等着的：直接换成新来的第一条
      if (visible && atTail) scrollToClip(first)
      if (visible) observe(false)
      return
    }
    if (gen === generation) moreState.value = hasMore ? '' : 'end'
  })()
    .catch(() => { if (gen === generation) moreState.value = 'failed' })
    .finally(() => { if (loadingMore === p) loadingMore = null })
  loadingMore = p
  return p
}

/*
 * 再点一次「短视频」Tab / 在第一条下拉：换一批推荐、回到第一条（和抖音一样）。
 * via：'tap' 点 Tab（刷新提示晚一点再淡入，局域网里一下就回来了，不闪一下）/ 'pull' 下拉（提示本来就跟着手指在）
 */
const refreshVia = ref('')
async function refresh(via = 'tap') {
  if (!visible || refreshing.value) return
  if (!clips.value.length) return retry()
  refreshVia.value = via
  refreshing.value = true
  const ok = await load()
  refreshing.value = false
  if (!ok && visible) toast('刷新失败，请稍后重试')
}
useTabRetap('short', () => refresh('tap'))

/* 网络恢复：第一页失败的重新加载，翻页失败或者快到末尾的接着加载 */
function onOnline() {
  if (!visible) return
  if (!clips.value.length) {
    if (failed.value || slow.value) retry()
    return
  }
  if (moreState.value === 'failed' || atTail || current >= clips.value.length - PRELOAD_AHEAD) loadMore()
}

/* ---------- 观看记录：真实视频播满 WATCH_MIN 秒记一次（登录后、只记数字 id），离开时补记看到第几秒 ---------- */

/** 屏幕上这一条的观看：{ key, id, played: 实际播放的秒数, sec: 播到第几秒 } */
let viewing = null
/** 已经记过观看的 feedKey：来回滑不重复计播放数 */
const counted = new Set()

function startView(i) {
  const c = clips.value[i]
  if (viewing && viewing.key === c?.feedKey) return
  leaveView()
  viewing = c?.src && isRealId(c.id) ? { key: c.feedKey, id: c.id, played: 0, sec: 0 } : null
}
/** 离开这一条（滑走、切到别的页、刷新）：看过的补记进度，不再计播放数 */
function leaveView() {
  const v = viewing
  viewing = null
  if (v) saveProgress(v)
}
function saveProgress(v, keepalive = false) {
  if (counted.has(v.key) && auth.loggedIn && v.sec > WATCH_MIN) {
    addHistory(v.id, Math.floor(v.sec), { progressOnly: true, keepalive }).catch(() => {})
  }
}
/* 切到后台 / 关掉页面前先把进度记一次（这一条还在看，不结束）；keepalive：页面关掉后浏览器也会发完 */
function onHidden() {
  if (document.visibilityState === 'hidden' && viewing) saveProgress(viewing, true)
}

/* ---------- 互动：状态在这里维护，子组件只负责显示 ---------- */

const TOGGLE = { like: toggleVideoLike, dislike: toggleVideoDislike, fav: toggleVideoFav }
const FIELD = { like: 'liked', dislike: 'disliked', fav: 'faved' }
const likesOf = c => c.likes ?? c.like ?? 0
const favsOf = c => c.favs ?? c.fav ?? 0

/** 正在请求中的互动（视频 id:种类），避免连点导致计数错乱 */
const pending = reactive(new Set())

/**
 * clips 是 shallowRef：改内部属性不会触发更新，所以整体替换。
 * 同一个视频在流里可能出现不止一次（翻过一整轮），按 id 一起改；列表已经刷新掉的就什么也不做。
 */
function patchVideo(id, obj) {
  if (!clips.value.some(c => c.id === id)) return
  clips.value = clips.value.map(c => (c.id === id ? { ...c, ...obj } : c))
}

/**
 * 赞 / 藏 / 不喜欢：乐观更新 → 一次请求（服务端保证赞和不喜欢互斥）→ 以返回为准 / 失败回滚。
 * want：想要的最终状态（双击点赞传 true，已经赞过就不动）；不传就是切换。
 * 未登录时：不喜欢只记在本机；赞 / 藏弹登录框，登录后补做。
 * 登录后的「不喜欢」以服务端为准（推荐流不再给），不记在本机；本机记过的在熄掉时一并清掉。
 */
async function interact(i, kind, want) {
  const clip = clips.value[i]
  if (!clip) return
  const pk = `${clip.id}:${kind}`
  if (pending.has(pk)) return
  const field = FIELD[kind]
  const next = want ?? !clip[field]
  if (next === !!clip[field]) return

  // 演示内容不发写请求：「不喜欢」照样只记在本机，赞 / 藏由接口层直接报「演示内容，无法操作」
  if (kind === 'dislike' && (!auth.loggedIn || isDemoId(clip.id))) return dislikeLocally(clip, next)
  if (!auth.loggedIn) {
    // 登录后补做这一下（没登录就关掉登录框则作废）；登录框在全屏里看不见，先退出全屏
    const id = clip.id
    exitFullscreen()
    auth.requireLogin({ then: () => completeAfterLogin(id, kind, next) })
    return
  }

  const before = { liked: !!clip.liked, faved: !!clip.faved, disliked: !!clip.disliked, likes: likesOf(clip), favs: favsOf(clip) }
  const localBefore = store.has(dislikeKey(clip.id))
  const upd = { [field]: next }
  if (kind === 'like') upd.likes = Math.max(0, before.likes + (next ? 1 : -1))
  if (kind === 'fav') upd.favs = Math.max(0, before.favs + (next ? 1 : -1))
  // 赞和不喜欢互斥：点亮一个时另一个熄掉
  if (kind === 'like' && next && before.disliked) upd.disliked = false
  if (kind === 'dislike' && next && before.liked) Object.assign(upd, { liked: false, likes: Math.max(0, before.likes - 1) })
  patchVideo(clip.id, upd)
  if (upd.disliked === false) store.set(dislikeKey(clip.id), false)
  if (kind === 'dislike') afterDislike(clip.id, next)

  pending.add(pk)
  try {
    const res = await TOGGLE[kind](clip.id, { on: next })
    // 服务端返回了最新状态就以它为准（多端操作、重复点击时不会和服务端对不上）
    const sync = {}
    if (typeof res?.liked === 'boolean') sync.liked = res.liked
    if (typeof res?.disliked === 'boolean') sync.disliked = res.disliked
    if (typeof res?.likeCount === 'number') sync.likes = res.likeCount
    if (typeof res?.favCount === 'number') sync.favs = res.favCount
    if (kind === 'fav' && typeof res?.active === 'boolean') sync.faved = res.active
    if (Object.keys(sync).length) patchVideo(clip.id, sync)
    if (sync.disliked === false) store.set(dislikeKey(clip.id), false)
  } catch (e) {
    patchVideo(clip.id, before)   // 回滚
    store.set(dislikeKey(clip.id), localBefore)
    toast(e?.code === 'demo' ? e.message : '操作失败，请稍后重试')
  } finally {
    pending.delete(pk)
  }
}

/** 未登录（或演示内容）的「不喜欢」：记在本机，刷新推荐时带给服务端往后排，本机也不再显示 */
function dislikeLocally(clip, on) {
  store.set(dislikeKey(clip.id), on)
  patchVideo(clip.id, { disliked: on })
  afterDislike(clip.id, on)
}

/** 点了「不喜欢」：提示，停一下翻到下一条；取消的话只提示 */
function afterDislike(id, on) {
  if (!on) {
    toast('已取消不喜欢')
    return
  }
  toast('将减少此类推荐')
  setTimeout(() => {
    if (visible && !atTail && clips.value[current]?.id === id) goNext(current)
  }, DISLIKE_NEXT_MS)
}

/* ---------- 登录 / 退出后：已经加载的这些按新身份刷新赞 / 藏 / 不喜欢，补做登录前点的那一下 ---------- */

/** 正在按新身份取状态的视频：id → Promise（同一条同时只取一次，补做的操作可以等它） */
const syncing = new Map()

function syncState(c) {
  if (!c) return Promise.resolve()
  const ep = authEpoch()
  if (c.epoch === ep) return Promise.resolve()
  if (syncing.has(c.id)) return syncing.get(c.id)
  if (!isRealId(c.id)) {
    patchVideo(c.id, { epoch: ep })
    return Promise.resolve()
  }
  const p = getVideo(c.id)
    .then(v => {
      if (ep !== authEpoch()) return
      const disliked = !!v.disliked || store.has(dislikeKey(c.id))
      patchVideo(c.id, {
        liked: !!v.liked && !disliked,
        faved: !!v.faved,
        disliked,
        ...(typeof v.likeCount === 'number' ? { likes: v.likeCount } : {}),
        ...(typeof v.favCount === 'number' ? { favs: v.favCount } : {}),
        epoch: ep
      })
    })
    .catch(() => { /* 取不到就先保持原样，下次滑到附近再试 */ })
    .finally(() => syncing.delete(c.id))
  syncing.set(c.id, p)
  return p
}

/** 屏幕上这条和前后几条按新身份刷新（再往后的滑到附近时再取） */
function syncNear() {
  if (!auth.loggedIn || !clips.value.length) return
  const from = Math.max(0, active.value - 1)
  const to = Math.min(clips.value.length - 1, active.value + 2)
  for (let i = from; i <= to; i++) syncState(clips.value[i])
  // 关注状态只取屏幕上这条和下一条的作者（同一位作者只取一次）
  checkFollow(clips.value[active.value]?.creator?.id)
  checkFollow(clips.value[active.value + 1]?.creator?.id)
}

/* ---------- 关注作者：头像下的「+」（只管关注；取消关注去主页） ---------- */

/*
 * 作者 id → 是否已关注（按当前登录身份）。没登录时谁都是「没关注」，不用取；
 * 登录后滑到附近才取一次（取到之前不显示「+」，免得已关注的作者闪一下）。
 * 每次回到这个页面都重新核对一遍（可能在主页、播放页里取消过），核对完之前先显示原来的。
 */
const follows = reactive(new Map())
/** 这一轮已经核对过的作者；followRound 在每次回到页面、换身份时 +1 */
const followChecked = new Map()
const followLoading = new Map()
let followRound = 0
const followBusy = new Set()

function followOf(clip) {
  const id = clip.creator?.id
  if (id == null) return null
  if (!auth.loggedIn) return false
  return follows.has(id) ? follows.get(id) : null
}

/** 取一位作者在当前身份下的关注状态（force：这一轮核对过也再取，登录后补做关注时用） */
function checkFollow(id, force = false) {
  if (id == null || !auth.loggedIn || !isRealId(id)) return Promise.resolve()
  if (followLoading.has(id)) return followLoading.get(id)
  if (!force && followChecked.get(id) === followRound) return Promise.resolve()
  const round = followRound
  const ep = authEpoch()
  const p = getCreator(id)
    .then(d => {
      if (ep !== authEpoch()) return
      // 正在关注中（请求还没回来）的以本地为准
      if (!followBusy.has(id)) follows.set(id, !!d.following)
      followChecked.set(id, round)
    })
    .catch(() => { /* 取不到就不显示「+」，下次滑到附近再试 */ })
    .finally(() => { if (followLoading.get(id) === p) followLoading.delete(id) })
  followLoading.set(id, p)
  return p
}

async function onFollow(i) {
  const id = clips.value[i]?.creator?.id
  if (id == null) return
  if (!auth.loggedIn) {
    // 登录框在全屏里看不见，先退出全屏；登录后先取回这位作者的状态，已经关注了就不再点
    exitFullscreen()
    auth.requireLogin({ then: () => followAfterLogin(id) })
    return
  }
  if (followBusy.has(id) || follows.get(id) === true) return
  follows.set(id, true)
  followBusy.add(id)
  try {
    const res = await toggleFollow(id, { on: true })
    if (typeof res?.active === 'boolean') follows.set(id, res.active)
  } catch (e) {
    follows.set(id, false)
    toast(e?.code === 'demo' ? e.message : '关注失败，请稍后重试')
  } finally {
    followBusy.delete(id)
  }
}
async function followAfterLogin(id) {
  await checkFollow(id, true)
  if (follows.get(id) !== false) return
  const i = clips.value.findIndex(c => c.creator?.id === id)
  if (i >= 0) onFollow(i)
}

/** 登录前点的赞 / 藏：先取回这条在新身份下的状态，再补做（已经是想要的状态就不动） */
async function completeAfterLogin(id, kind, on) {
  await syncState(clips.value.find(x => x.id === id))
  const i = clips.value.findIndex(x => x.id === id)
  if (i >= 0) interact(i, kind, on)
}

watch(() => auth.token, tok => {
  // 换了身份：关注状态全部作废（没登录时都显示「+」，登录后滑到附近重新取）
  follows.clear()
  followLoading.clear()
  followRound++
  if (!tok) {
    // 退出登录：上一个人的赞 / 藏不再显示（未登录时大家都是没点过）
    const ep = authEpoch()
    clips.value = clips.value.map(c => ({ ...c, liked: false, faved: false, disliked: store.has(dislikeKey(c.id)), epoch: ep }))
    return
  }
  syncNear()
})

const onLike = i => interact(i, 'like')
const onFav = i => interact(i, 'fav')
const onDislike = i => interact(i, 'dislike')
const onDoubleLike = i => interact(i, 'like', true)

/* ---------- playback ---------- */

function play(i) {
  players.value.forEach((p, j) => {
    p.playing = j === i
  })
  const p = players.value[i]
  if (p && p.t >= p.len) p.t = 0
}

function pauseAll() {
  players.value.forEach(p => { p.playing = false })
}

function toggle(i) {
  const p = players.value[i]
  if (!p || i !== current || atTail) return
  // 这一下点屏幕是用来恢复声音的（见 restoreSound）：正在播就接着播，不暂停
  if (p.playing && performance.now() - soundTapAt < SOUND_TAP_MS) return
  if (!p.playing && p.t >= p.len) p.t = 0
  p.playing = !p.playing
}

function seek(i, t) {
  const p = players.value[i]
  p.t = Math.min(p.len, Math.max(0, t))
}

/* ---------- 真实视频（clip.src）上报的状态；封面预览由 tick() 推进 ---------- */

function onTime(i, t) {
  const p = players.value[i]
  const d = t - p.t
  p.t = t
  const v = viewing
  if (!v || v.key !== clips.value[i]?.feedKey) return
  v.sec = t
  // 只累计正常往前播的时间（拖进度、循环回到开头不算）
  if (d > 0 && d < 1.5) v.played += d
  if (!counted.has(v.key) && v.played >= WATCH_MIN && auth.loggedIn) {
    counted.add(v.key)
    addHistory(v.id, 0).catch(() => {})
  }
}
const onDuration = (i, d) => { players.value[i].len = d }
/* 原生播放 / 暂停（播完、自动播放被拦）：只同步状态，不再反过来驱动 */
const onState = (i, playing) => { players.value[i].playing = playing }
/* 文件打不开：这条退回封面预览 */
function onFailed(i) {
  const clip = clips.value[i]
  patchVideo(clip.id, { src: null })
  const p = players.value[i]
  p.len = clipLen({ ...clip, src: null })
  p.t = 0
  if (i === current) {
    if (viewing?.key === clip.feedKey) viewing = null
    toast('视频加载失败，先看看封面吧')
    play(i)
  }
}

/* 长按边缘快进：真实视频由 ShortItem 改 playbackRate；这里只记着，快进时不触发下拉刷新 */
const onBoost = (i, on) => { boosted = on ? i : boosted === i ? -1 : boosted }

/* 封面预览的计时（不跟倍速走：它不是视频，只是决定多久后翻到下一条） */
function tick() {
  const p = players.value[current]
  const clip = clips.value[current]
  if (atTail || !p || !p.playing || clip?.src) return
  p.t = Math.min(p.len, p.t + TICK_MS / 1000)
  if (p.t >= p.len) finish(current)
}

/** 当前这条播完：循环就从头来，否则停下，开着自动连播时滑到下一条 */
function finish(i) {
  const p = players.value[i]
  if (!p) return
  if (store.playback.loop) {
    p.t = 0
    return
  }
  p.playing = false
  if (store.playback.autoNext && i === current) goNext(i)
}

/** 翻到下一条（到末尾先等下一页；下一页失败就停在最后那一格，显示重试） */
async function goNext(i) {
  if (i >= clips.value.length - 1) await loadMore()
  // the observer starts the next clip once it snaps into view
  if (i !== current || atTail || !visible) return
  advancingTo = i < clips.value.length - 1 ? i + 1 : -1
  scrollToClip(i + 1, 'smooth')
}

/*
 * iOS 14 的 Safari 不认 scroll-snap-stop: always（Safari 15 才有）：用力一甩，惯性会越过好几格才吸住。
 * 只在这种浏览器上兜底（支持的浏览器不挂监听）：一次手势最多翻一格，滚过头就把 overflow 关一下掐断惯性、
 * 停在下一格（正好是吸附点，打开 overflow 后不会再动）。只管手指按着和松手后 1 秒（惯性越界都发生在这段里），
 * 之后别的原因引起的滚动（换一批后列表变短等）不受影响。
 */
const SNAP_STOP = (() => { try { return CSS.supports('scroll-snap-stop', 'always') } catch { return false } })()
let flickFrom = -1 // 这次手势开始时停在哪一格；-1 = 不限制
let flickUntil = 0 // 松手后限制到什么时候（performance.now()）
let flickEl = null // 挂了监听的那个滚动容器（卸载时 feedEl 已经是 null）
function onFlickStart() {
  const f = feedEl.value
  if (f?.clientHeight) flickFrom = Math.round(f.scrollTop / f.clientHeight)
  flickUntil = Infinity
}
const onFlickEnd = () => { flickUntil = performance.now() + 1000 }
function onFlickScroll() {
  const f = feedEl.value
  if (!f || flickFrom < 0) return
  if (performance.now() > flickUntil) {
    flickFrom = -1
    return
  }
  const h = f.clientHeight
  const y = f.scrollTop
  const lo = Math.max(0, flickFrom - 1) * h
  const hi = (flickFrom + 1) * h
  if (y >= lo && y <= hi) return
  flickFrom = -1
  f.style.overflowY = 'hidden'
  f.scrollTop = y > hi ? hi : lo
  requestAnimationFrame(() => { f.style.overflowY = '' })
}

function scrollToClip(i, behavior = 'auto') {
  // 程序自己滚（自动连播、恢复位置、转屏）不受上面「一次最多一格」的限制
  flickFrom = -1
  const feed = feedEl.value
  if (feed) feed.scrollTo({ top: i * feed.clientHeight, behavior })
}

/* 停到最后那一格：暂停正在播的，加载下一页（失败过的这时再试一次） */
function enterTail() {
  if (atTail) return
  atTail = true
  onTail.value = true
  if (navTo === clips.value.length) navTo = -1
  leaveView()
  pauseAll()
  if (moreState.value !== 'loading') loadMore()
}

/*
 * whichever clip is at least 60% on screen becomes current and autoplays (from the start if it had finished);
 * nearing the end of the feed loads the next page.
 * reset=false (after a page was appended) only adds the new clips: re-observing everything would replay
 * the initial callbacks and could restart the clip that is scrolling away.
 */
function observe(reset = true) {
  const feed = feedEl.value
  if (!feed || !clips.value.length) return
  io ??= new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting || e.intersectionRatio < 0.6) continue
      if ('tail' in e.target.dataset) {
        enterTail()
        continue
      }
      current = Number(e.target.dataset.index)
      atTail = false
      onTail.value = false
      if (navTo === current) navTo = -1
      active.value = current
      advancingTo = -1
      play(current)
      startView(current)
      markSeen(clips.value[current]?.id)
      syncNear()
      if (current >= clips.value.length - PRELOAD_AHEAD) loadMore()
    }
  }, { root: feed, threshold: 0.6 })
  if (reset) io.disconnect()
  // observe() on an element already observed is a no-op
  for (const el of feed.querySelectorAll(':scope > .sv-slot')) io.observe(el)
}

/* 高度变了（转屏、进出全屏）：停在原来那一条上，不要卡在两条中间 */
let feedH = 0
function onResize() {
  const h = feedEl.value?.clientHeight || 0
  if (!h || h === feedH) return
  feedH = h
  if (visible && clips.value.length) scrollToClip(atTail ? clips.value.length : current)
}

/* ---------- 下拉刷新：停在第一条时往下拉，超过 PULL_TRIGGER 松手就换一批 ---------- */

/*
 * 只读触摸、不拦默认行为：停在第一条时往下拉本来就滚不动，翻页的吸附不受任何影响。
 * 从进度条上开始的、横着拖的、长按快进中的都不算。
 */
const pull = reactive({ on: false, y: 0 })
let pullFrom = null
const pullReady = computed(() => pull.y >= PULL_TRIGGER)
const pullShift = computed(() => Math.min(pull.y * 0.5, 64))

function pullStart(e) {
  pullFrom = null
  const feed = feedEl.value
  if (e.touches.length !== 1 || !feed || feed.scrollTop > 1 || current !== 0 || atTail) return
  // 进度条上是拖进度；展开的标题自己能上下滚
  if (refreshing.value || loading.value || boosted >= 0 || e.target.closest?.('.track, .title-open .sv-title')) return
  pullFrom = { x: e.touches[0].clientX, y: e.touches[0].clientY }
}
function pullMove(e) {
  if (!pullFrom) return
  const t = e.touches[0]
  const dy = t.clientY - pullFrom.y
  const dx = t.clientX - pullFrom.x
  if (!pull.on) {
    // 往上（翻页）或者横着：不是下拉
    if (dy < -4 || Math.abs(dx) > Math.abs(dy)) {
      pullFrom = null
      return
    }
    if (dy < 10 || feedEl.value.scrollTop > 1 || boosted >= 0) return
    pull.on = true
  }
  pull.y = Math.max(0, dy)
}
function pullEnd() {
  const go = pull.on && pullReady.value
  pullFrom = null
  pull.on = false
  pull.y = 0
  if (go) refresh('pull')
}

/* ---------- 声音：用户要过声音（store.sound），被浏览器临时静音的话，在页面上点一下就恢复 ---------- */

/** 上一次「点屏幕恢复了声音」的时间：随后那次单击不再暂停 */
let soundTapAt = -Infinity
const SOUND_TAP_MS = 800

function restoreSound(e) {
  if (!store.sound || !store.muted || !visible) return
  // 点的就是静音 / 恢复声音按钮：交给按钮自己处理
  if (e.target.closest?.('[data-sound]')) return
  // 桌面上按 M 就是在切静音：交给快捷键自己处理（不然这里先恢复了声音，快捷键又把它静音回去）
  if (e.type === 'keydown' && isDesktop.value && (e.key === 'm' || e.key === 'M')) return
  // 浏览器认可的用户操作之后才能有声播放；不支持这个判断的浏览器只认真正的点击
  const ua = navigator.userActivation
  if (ua ? !ua.hasBeenActive : e.type !== 'click') return
  store.muted = false
  // 静音播放中点了一下画面：这一下只恢复声音（和「点击恢复声音」一样），不当成暂停
  if (e.target.classList?.contains('sv-click')) soundTapAt = performance.now()
}

/* ---------- 全屏 / 小窗（只对有视频文件的条目显示按钮） ---------- */

const fullscreen = ref(false)
const canFullscreen = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) ||
  (typeof HTMLVideoElement !== 'undefined' && 'webkitEnterFullscreen' in HTMLVideoElement.prototype)
const canPip = !!document.pictureInPictureEnabled ||
  (typeof HTMLVideoElement !== 'undefined' && 'webkitSetPresentationMode' in HTMLVideoElement.prototype)
const curHasFile = computed(() => !!curClip.value?.src)

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null
const curVideo = () => feedEl.value?.querySelector(`.sv-slot[data-index="${current}"] video`) || null

function exitFullscreen() {
  if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {})
}
/* 整个短视频页进全屏：上下滑照样翻页；横版视频顺便转成横屏 */
async function toggleFullscreen() {
  if (fsElement()) return exitFullscreen()
  const page = pageEl.value
  const v = curVideo()
  if (page?.requestFullscreen || page?.webkitRequestFullscreen) {
    try {
      await (page.requestFullscreen ? page.requestFullscreen() : page.webkitRequestFullscreen())
      if (v && v.videoWidth > v.videoHeight) await screen.orientation?.lock?.('landscape').catch(() => {})
    } catch {
      toast('当前环境不支持全屏')
    }
  } else if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen()   // iPhone 只支持 <video> 自己全屏
  else toast('当前环境不支持全屏')
}
function onFullscreenChange() {
  fullscreen.value = !!pageEl.value && fsElement() === pageEl.value
  if (!fullscreen.value) try { screen.orientation?.unlock?.() } catch { /* 不支持就算了 */ }
}

async function togglePip() {
  const v = curVideo()
  if (!v) return
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture()
    else if (document.pictureInPictureEnabled && v.requestPictureInPicture) await v.requestPictureInPicture()
    else if (v.webkitSupportsPresentationMode?.('picture-in-picture')) {
      v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture')
    } else toast('当前视频不支持小窗播放')
  } catch {
    toast('小窗播放启动失败')
  }
}

/*
 * ---------- 桌面布局（≥ 1024px）：滚轮 / 触控板、键盘、右侧的上 / 下按钮翻页 ----------
 * 手机上是手指上下滑（吸附滚动），这些都不挂 / 不生效。
 */

/**
 * 桌面翻页正要去的那一格（平滑滚动途中又翻了一下：从这里往后数，不会因为还没滚到而少翻）；
 * 滚到了（观察者认出这一条）就清掉，万一被打断，NAV_HOLD 之后也不再算
 */
let navTo = -1
let navAt = 0
const NAV_HOLD = 900

/** 往下（1）/ 往上（-1）翻一条；最后一格（加载中 / 失败 / 没有更多）的下标是 clips.length */
function step(dir) {
  const n = clips.value.length
  if (!visible || !n) return
  const here = navTo >= 0 && performance.now() - navAt < NAV_HOLD ? navTo : atTail ? n : current
  const to = Math.min(n, Math.max(0, here + dir))
  if (to === here) return
  navTo = to
  navAt = performance.now()
  const behavior = scrollBehavior()
  if (behavior === 'smooth') holdTop(to)
  scrollToClip(to, behavior)
}

/*
 * 卡片顶上那一条（全屏 / 小窗、推荐 / 专题、换一批 / 声音）固定在页面上，不跟着卡片走：平滑翻页的途中卡片从它下面滚过去，
 * 它会压在上一条的文字、进度条和两张卡片之间的空隙上。翻页途中先淡出（stepping），滚到要去的那一格再淡入。
 * 到没到看滚动位置（观察者在这一格露出 60% 时就认了，那时还在滚）；被打断（拖动、改窗口大小）的话 STEP_MAX 之后照样回来
 */
const stepping = ref(false)
const STEP_MAX = 1200
let stepTop = 0
let stepTimer = 0
let stepFeed = null
function holdTop(to) {
  const f = feedEl.value
  const el = f?.querySelector(to < clips.value.length ? `.sv-slot[data-index="${to}"]` : '.sv-tail')
  if (!el) return
  stepTop = el.offsetTop
  if (stepFeed !== f) {
    stepFeed?.removeEventListener('scroll', onStepScroll)
    stepFeed = f
    f.addEventListener('scroll', onStepScroll, { passive: true })
  }
  stepping.value = true
  clearTimeout(stepTimer)
  stepTimer = setTimeout(endStep, STEP_MAX)
}
function onStepScroll() {
  if (stepFeed && Math.abs(stepFeed.scrollTop - stepTop) < 2) endStep()
}
function endStep() {
  clearTimeout(stepTimer)
  stepFeed?.removeEventListener('scroll', onStepScroll)
  stepFeed = null
  stepping.value = false
}

/*
 * 滚轮 / 触控板：一次手势只翻一条，不会一下滚过好几条。
 *  - 滚轮一格一个事件：连着转的几格（间隔不到 WHEEL_GAP）算同一次手势；
 *  - 触控板一次轻扫是一串越来越小的事件（松手后的惯性）：整串算一次；惯性还没停又扫了一下，
 *    事件会重新变大（比翻页后最小的那个大 4 倍以上、并且够 WHEEL_MIN），算新的一次；
 *  - 反方向滚：马上算新的一次。
 * 页面上能自己滚的地方（展开的长标题）还能滚时交给它；Ctrl + 滚轮是浏览器缩放，不管。
 */
const WHEEL_MIN = 24
const WHEEL_GAP = 200
const WHEEL_SURGE_AFTER = 300
const wheel = { sum: 0, last: -1e9, used: false, dir: 0, at: 0, floor: Infinity }

function scrollsInside(target, dy) {
  for (let el = target; el && el !== feedEl.value && el !== pageEl.value; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue
    const oy = getComputedStyle(el).overflowY
    if (oy !== 'auto' && oy !== 'scroll') continue
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true
  }
  return false
}

function onWheel(e) {
  if (!isDesktop.value || !visible || e.ctrlKey) return
  let dy = e.deltaY
  if (e.deltaMode === 1) dy *= 40
  else if (e.deltaMode === 2) dy *= feedEl.value?.clientHeight || 800
  if (!dy || Math.abs(dy) < Math.abs(e.deltaX)) return
  if (scrollsInside(e.target, dy)) return
  e.preventDefault()
  const now = performance.now()
  const abs = Math.abs(dy)
  const fresh = now - wheel.last > WHEEL_GAP ||
    (wheel.used && Math.sign(dy) !== wheel.dir) ||
    (wheel.used && now - wheel.at > WHEEL_SURGE_AFTER && abs >= WHEEL_MIN && abs > wheel.floor * 4)
  wheel.last = now
  if (fresh) {
    wheel.sum = 0
    wheel.used = false
  }
  if (wheel.used) {
    wheel.floor = Math.min(wheel.floor, abs)
    return
  }
  wheel.sum += dy
  if (Math.abs(wheel.sum) < WHEEL_MIN) return
  wheel.used = true
  wheel.dir = Math.sign(wheel.sum)
  wheel.at = now
  wheel.floor = Infinity
  step(wheel.dir)
}

/* 只在桌面布局时挂滚轮监听（要能 preventDefault，所以不是 passive；手机上不挂，不影响滚动性能） */
let wheelOn = null
function bindWheel(on) {
  const el = on ? pageEl.value : null
  if (wheelOn === el) return
  wheelOn?.removeEventListener('wheel', onWheel)
  wheelOn = el
  el?.addEventListener('wheel', onWheel, { passive: false })
}
watch(isDesktop, bindWheel)
/* 窗口拉窄到手机布局：翻页途中淡出的顶上那一条马上回来（手机上它一直在） */
watch(isDesktop, d => { if (!d) endStep() })

/* 屏幕上这一条的 ShortItem（键盘快捷键通过它操作，和用鼠标点一样带动效）：feedKey → 组件 */
const items = new Map()
function setItem(key, inst) {
  if (inst) items.set(key, inst)
  else items.delete(key)
}
const curItem = () => (atTail ? null : items.get(clips.value[current]?.feedKey) || null)

const isTyping = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
/* 键盘聚焦（Tab 过来）的按钮：空格照常按下它；鼠标点过留着焦点的按钮（比如刚点了赞），空格还是播放 / 暂停 */
function keyboardButton(t) {
  if (!t?.closest?.('button, [role="button"], [role="switch"], [role="tab"], [role="menuitem"]')) return false
  try { return t.matches(':focus-visible') } catch { return true }
}

/*
 * 键盘：↑ / K 上一个，↓ / J 下一个，空格 播放 / 暂停，← / → 后退 / 前进 KEY_SEEK 秒，M 静音，F 全屏。
 * 在输入框里打字、开着弹层（播放设置、登录框等）时不管；按住不放只算一下（← / → 除外，可以一直跳）。
 */
function onDeskKey(e) {
  if (!isDesktop.value || !visible || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
  if (isTyping(e.target) || document.querySelector('[aria-modal="true"]')) return
  // 焦点在顶栏的下拉菜单（头像菜单）、搜索建议里：按键归它们（和 VideoPlayer 一样）
  if (e.target instanceof Element && e.target.closest('[role="menu"], [role="listbox"]')) return
  const k = e.key
  const once = !e.repeat
  if (k === 'ArrowDown' || k === 'j' || k === 'J' || k === 'PageDown') {
    if (once) step(1)
  } else if (k === 'ArrowUp' || k === 'k' || k === 'K' || k === 'PageUp') {
    if (once) step(-1)
  } else if (k === ' ' || k === 'Spacebar') {
    if (keyboardButton(e.target)) return
    if (once) togglePlay()
  } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    if (clips.value[current]?.src) curItem()?.seekBy(k === 'ArrowLeft' ? -KEY_SEEK : KEY_SEEK)
  } else if (k === 'm' || k === 'M') {
    if (once) setMuted(!store.muted)
  } else if (k === 'f' || k === 'F') {
    if (once && canFullscreen && (fullscreen.value || curHasFile.value)) toggleFullscreen()
  } else return
  e.preventDefault()
  // 按键也是用户操作：被浏览器临时静音的，顺便恢复声音（M 自己就是切静音，不在这里恢复）
  if (k !== 'm' && k !== 'M') restoreSound(e)
}

function togglePlay() {
  const it = curItem()
  if (it) it.userToggle()
  else toggle(current)
}

/* ---------- lifecycle (kept alive between tab switches) ---------- */

function stop() {
  visible = false
  boosted = -1
  navTo = -1
  endStep()
  clearInterval(timer)
  timer = 0
  io?.disconnect()
  leaveView()
  pauseAll()
  pullEnd()
  exitFullscreen()
  window.removeEventListener('online', onOnline)
  document.removeEventListener('visibilitychange', onHidden)
  document.removeEventListener('keydown', onDeskKey)
}

onMounted(() => {
  load()
  bindWheel(isDesktop.value)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)
  if ('ResizeObserver' in window && feedEl.value) {
    ro = new ResizeObserver(onResize)
    ro.observe(feedEl.value)
  }
  if (!SNAP_STOP && feedEl.value) {
    flickEl = feedEl.value
    flickEl.addEventListener('touchstart', onFlickStart, { passive: true })
    flickEl.addEventListener('scroll', onFlickScroll, { passive: true })
    flickEl.addEventListener('touchend', onFlickEnd, { passive: true })
    flickEl.addEventListener('touchcancel', onFlickEnd, { passive: true })
  }
})

onActivated(() => {
  visible = true
  // 关注状态可能在别的页面改过：这一轮重新核对（下面 syncNear 取屏幕上这条的作者）
  followRound++
  clearInterval(timer)
  timer = setInterval(tick, TICK_MS)
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onHidden)
  document.addEventListener('keydown', onDeskKey)
  if (!clips.value.length) {
    // first activation: load() starts the observer once the feed is rendered; a failed first page retries here
    if (failed.value) retry()
    return
  }
  if (atTail) {
    scrollToClip(clips.value.length)
    observe()
    return
  }
  // left in the middle of an auto-advance: land on the clip it was heading to, not the finished one
  if (advancingTo >= 0) current = advancingTo
  advancingTo = -1
  scrollToClip(current) // keep the same clip on screen in case the scroll offset was lost while detached
  play(current)
  startView(current)
  observe()
  syncNear()
})

onDeactivated(stop)

onUnmounted(() => {
  stop()
  bindWheel(false)
  clearTimeout(slowTimer)
  ro?.disconnect()
  flickEl?.removeEventListener('touchstart', onFlickStart)
  flickEl?.removeEventListener('scroll', onFlickScroll)
  flickEl?.removeEventListener('touchend', onFlickEnd)
  flickEl?.removeEventListener('touchcancel', onFlickEnd)
  io = null
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
})

/* ---------- top bar + settings ---------- */

function selectFeed(i) {
  if (FEEDS[i] === '专题') toast('专题内容即将上线')
}

/** 用户自己点的静音 / 恢复声音：记下来，下次打开照这个来 */
function setMuted(muted) {
  store.muted = muted
  store.sound = !muted
  toast(muted ? '已静音' : '已恢复声音')
}

/* 设置面板挂在页面外面，全屏时看不见：先退出全屏再打开 */
function openSettings() {
  exitFullscreen()
  settingsOpen.value = true
}

function setSpeed(speed) {
  store.playback.speed = speed
  toast(`已切换为 ${speed} 倍速`)
  settingsOpen.value = false
}
</script>

<template>
  <div
    ref="page"
    class="page sv-page"
    :class="{ fs: fullscreen }"
    @pointerup.capture="restoreSound"
    @touchend.capture.passive="restoreSound"
    @click.capture="restoreSound"
    @keydown.capture="restoreSound"
  >
    <div class="sv-top" :class="{ off: stepping }">
      <div class="l">
        <!-- 只有能真正播放的条目才有全屏 / 小窗；全屏时一直留着退出键 -->
        <button
          v-if="canFullscreen && (fullscreen || curHasFile)"
          type="button"
          :aria-label="fullscreen ? '退出全屏' : '全屏'"
          :title="isDesktop ? (fullscreen ? '退出全屏（F）' : '全屏（F）') : undefined"
          @click="toggleFullscreen"
        >
          <Icon :name="fullscreen ? 'fullscreenExit' : 'expand'" />
        </button>
        <button
          v-if="canPip && curHasFile"
          type="button"
          aria-label="小窗播放"
          :title="isDesktop ? '小窗播放' : undefined"
          @click="togglePip"
        >
          <Icon name="pip" />
        </button>
      </div>
      <div class="tt2" role="tablist">
        <button
          v-for="(name, i) in FEEDS"
          :key="name"
          class="sv-tab"
          :class="{ on: i === 0 }"
          type="button"
          role="tab"
          :aria-selected="i === 0"
          @click="selectFeed(i)"
        >
          {{ name }}
        </button>
      </div>
      <div class="r">
        <!-- 桌面：手机上的「下拉刷新」换成这个按钮（再点一次左侧的「短视频」也一样） -->
        <button v-if="isDesktop" type="button" aria-label="换一批" title="换一批" @click="refresh('tap')">
          <Icon name="refresh" />
        </button>
        <button
          type="button"
          data-sound
          :aria-label="store.muted ? '恢复声音' : '静音'"
          :title="isDesktop ? (store.muted ? '恢复声音（M）' : '静音（M）') : undefined"
          @click="setMuted(!store.muted)"
        >
          <Icon :name="store.muted ? 'mute' : 'vol'" />
        </button>
      </div>
    </div>

    <!-- 桌面：页面右边的上一个 / 下一个（手机上是手指上下滑） -->
    <div v-if="isDesktop && clips.length" class="sv-nav">
      <button type="button" aria-label="上一个" title="上一个（↑ / K）" :disabled="active === 0 && !onTail" @click="step(-1)">
        <Icon name="chevU" />
      </button>
      <button type="button" aria-label="下一个" title="下一个（↓ / J）" :disabled="onTail" @click="step(1)">
        <Icon name="chevD" />
      </button>
    </div>

    <!--
      下拉刷新 / 再点一次「短视频」Tab 的提示。点 Tab 刷新时晚 .25 秒才淡入（.late，CSS 动画的延迟）：
      很快就刷新完的什么也不出现。不用 <Transition>：进场在延迟里被打断时会先以不透明的样子闪一帧
    -->
    <div
      v-show="refreshing || pull.on"
      class="sv-refresh"
      :class="{ spin: refreshing, late: refreshing && refreshVia === 'tap' }"
      role="status"
      :style="pull.on ? { transform: `translate(-50%, ${pullShift}px)` } : undefined"
    >
      <Icon name="refresh" :style="pull.on ? { transform: `rotate(${pull.y * 3}deg)` } : undefined" />
      {{ refreshing ? '正在刷新' : pullReady ? '松手刷新' : '下拉刷新' }}
    </div>

    <div
      ref="feed"
      class="scroll sv-feed"
      @touchstart.passive="pullStart"
      @touchmove.passive="pullMove"
      @touchend.passive="pullEnd"
      @touchcancel.passive="pullEnd"
    >
      <!-- 每条一个整屏的格子；只有当前这条附近的才真正渲染，其余是空格子（滚动位置不受影响） -->
      <div v-for="(clip, i) in clips" :key="clip.feedKey" class="sv-slot" :data-index="i">
        <!-- 桌面：只有屏幕上这一条能用 Tab 聚焦 / 点（上下两条露出来的一截不接操作，Tab 也不会跳到屏幕外的那几条去） -->
        <ShortItem
          v-if="Math.abs(i - active) <= RENDER_AROUND"
          :ref="inst => setItem(clip.feedKey, inst)"
          :inert="isDesktop && i !== active ? true : undefined"
          :clip="clip"
          :liked="!!clip.liked"
          :faved="!!clip.faved"
          :disliked="!!clip.disliked"
          :likes="clip.likes ?? clip.like ?? 0"
          :favs="clip.favs ?? clip.fav ?? 0"
          :time="players[i].t"
          :len="players[i].len"
          :playing="players[i].playing"
          :current="i === active"
          :eager="Math.abs(i - active) <= 1"
          :near="Math.abs(i - active) <= 1"
          :following="followOf(clip)"
          @toggle="toggle(i)"
          @dbllike="onDoubleLike(i)"
          @seek="t => seek(i, t)"
          @boost="on => onBoost(i, on)"
          @time="t => onTime(i, t)"
          @duration="d => onDuration(i, d)"
          @state="on => onState(i, on)"
          @ended="finish(i)"
          @failed="onFailed(i)"
          @unmute="setMuted(false)"
          @like="onLike(i)"
          @dislike="onDislike(i)"
          @fav="onFav(i)"
          @follow="onFollow(i)"
          @settings="openSettings"
        />
      </div>
      <!-- 最后一格：下一页还没到时转圈，失败时给重试（滑到这里会自动再试一次） -->
      <div v-if="clips.length" class="sv-slot sv-tail" data-tail>
        <div v-if="moreState === 'failed'" class="sv-tail-in">
          网络不给力，下一页没加载出来
          <button class="retry" type="button" @click="loadMore">点击重试</button>
        </div>
        <div v-else-if="moreState === 'end'" class="sv-tail-in">暂时没有更多了</div>
        <div v-else class="sv-tail-in" role="status"><Icon name="refresh" class="sv-spin" />正在加载</div>
      </div>

      <!-- 第一页还没回来：占位骨架；很久没回来给重试 -->
      <div v-if="loading && !clips.length" class="sv-skel" role="status" aria-label="正在加载">
        <div class="sk-side"><i v-for="n in 5" :key="n" /></div>
        <div class="sk-meta"><i /><i /><i /></div>
        <div class="sk-c">
          <template v-if="slow">
            网络有点慢，还在加载
            <button class="retry" type="button" @click="retry">重试</button>
          </template>
          <Icon v-else name="refresh" class="sv-spin" />
        </div>
      </div>
      <div v-else-if="failed" class="empty sv-empty">
        加载失败，请检查网络后重试
        <button class="retry" type="button" @click="retry">重试</button>
      </div>
      <div v-else-if="!loading && !clips.length" class="empty sv-empty">还没有视频</div>
    </div>

    <BottomSheet v-model:open="settingsOpen" title="播放设置">
      <div class="opts speeds">
        <button
          v-for="s in SPEEDS"
          :key="s"
          class="opt"
          :class="{ on: store.playback.speed === s }"
          :aria-pressed="store.playback.speed === s"
          type="button"
          @click="setSpeed(s)"
        >
          {{ s }}
        </button>
      </div>
      <div class="row2">
        <span>自动连播</span>
        <button
          class="sw"
          :class="{ on: store.playback.autoNext }"
          type="button"
          role="switch"
          aria-label="自动连播"
          :aria-checked="store.playback.autoNext"
          @click="store.playback.autoNext = !store.playback.autoNext"
        />
      </div>
      <div class="row2">
        <span>循环播放</span>
        <button
          class="sw"
          :class="{ on: store.playback.loop }"
          type="button"
          role="switch"
          aria-label="循环播放"
          :aria-checked="store.playback.loop"
          @click="store.playback.loop = !store.playback.loop"
        />
      </div>
      <!-- 桌面：键盘快捷键一览 -->
      <div v-if="isDesktop" class="sv-keys">
        <h5>键盘快捷键</h5>
        <dl>
          <div v-for="k in KEYS" :key="k.label">
            <dt v-if="k.mouse" class="mouse">{{ k.keys[0] }}</dt>
            <dt v-else><kbd v-for="c in k.keys" :key="c">{{ c }}</kbd></dt>
            <dd>{{ k.label }}</dd>
          </div>
        </dl>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.sv-page { background: #000; }

/* one clip per screen (scrolling itself comes from the global .scroll) */
.sv-feed {
  position: relative;
  scroll-snap-type: y mandatory;
  /* 新一页插在最后那一格前面时，不要为了「保持可见内容不动」去改滚动位置 */
  overflow-anchor: none;
  background: #000;
}
.sv-slot {
  height: 100%;
  scroll-snap-align: start;
  scroll-snap-stop: always;
}
.sv-empty { position: absolute; left: 0; right: 0; top: 30%; padding: 0; }

/* 最后一格：加载下一页 / 失败重试 */
.sv-tail { display: grid; place-items: center; background: #050505; }
.sv-tail-in {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--t2);
  font-size: 13px;
  text-align: center;
}
.sv-tail .retry,
.sk-c .retry { height: 30px; margin-top: 4px; padding: 0 18px; border-radius: 15px; background: var(--chip); color: var(--t1); font-size: 13px; }
.sv-spin { width: 22px; height: 22px; color: rgba(255, 255, 255, .6); stroke-width: 2.2; animation: rot .8s linear infinite; }

/* 第一页的占位骨架：和真实的一条同样的布局（右侧一列按钮、左下角文字） */
.sv-skel { position: absolute; inset: 0; background: linear-gradient(180deg, #121212, #0b0b0b 60%, #050505); }
/* 和其他页面的骨架同一种呼吸（1.2 秒，最暗到 .5） */
.sv-skel i { display: block; background: #1d1d1d; animation: sk 1.2s ease-in-out infinite; }
@keyframes sk { 50% { opacity: .5; } }
.sk-side { position: absolute; right: 9px; bottom: 26px; display: flex; flex-direction: column; gap: 26px; }
.sk-side i { width: 36px; height: 36px; border-radius: 50%; }
.sk-meta { position: absolute; left: 12px; bottom: 56px; display: flex; flex-direction: column; gap: 10px; width: 62%; }
.sk-meta i { height: 14px; border-radius: 7px; }
.sk-meta i:first-child { width: 40%; height: 16px; }
.sk-meta i:nth-child(2) { width: 70%; }
.sk-c {
  position: absolute;
  left: 0;
  right: 0;
  top: 45%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: var(--t2);
  font-size: 13px;
  transform: translateY(-50%);
}

/* 下拉刷新 / 再点一次「短视频」Tab：顶部的刷新提示 */
.sv-refresh {
  position: absolute;
  left: 50%;
  top: calc(var(--safe-t) + 62px);
  z-index: 7;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px 0 11px;
  border-radius: 15px;
  background: rgba(22, 22, 22, .72);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transform: translateX(-50%);
  pointer-events: none;
}
.sv-refresh svg { width: 15px; height: 15px; stroke-width: 2.4; }
.sv-refresh.spin svg { animation: rot .8s linear infinite; }
/* 点 Tab 刷新：等 .25 秒还没刷新完才从上面轻轻落下来（延迟期间停在起始帧，看不见） */
.sv-refresh.late { animation: svr-in var(--dur-2) var(--ease-out) .25s backwards; }
@keyframes svr-in { from { opacity: 0; transform: translate(-50%, -8px); } }
@media (prefers-reduced-motion: reduce) {
  .sv-refresh.spin svg,
  .sv-spin { animation: none; }
}

/* overlay above the feed: only its controls take taps */
.sv-top {
  position: absolute;
  left: 0;
  right: 0;
  top: var(--safe-t);
  z-index: 6;
  height: 56px;
  pointer-events: none;
}
.sv-top .l,
.sv-top .r,
.sv-tab { pointer-events: auto; }
/* 左上角全屏 / 小窗、右上角声音：图标 17px，按钮本身 44×44（从屏幕边缘算起），可点区域不再偏小 */
.sv-top .l { position: absolute; left: 0; top: 0; display: flex; color: #fff; }
.sv-top .l svg { width: 17px; height: 17px; stroke-width: 2.2; opacity: .92; }
.sv-top .r { position: absolute; right: 0; top: 0; color: #fff; }
.sv-top .r svg { width: 17px; height: 17px; opacity: .92; }
.sv-top .l button,
.sv-top .r button { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; }
.sv-top .tt2 { position: absolute; left: 0; right: 0; top: 15px; display: flex; justify-content: center; gap: 30px; }

.sv-tab {
  position: relative;
  color: rgba(255, 255, 255, .7);
  font-size: 16px;
  font-weight: 600;
  line-height: 34px;
  text-shadow: 0 1px 6px rgba(0, 0, 0, .35);
}
.sv-tab.on { color: #fff; }
.sv-tab.on::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -1px;
  width: 16px;
  height: 3px;
  margin-left: -8px;
  border-radius: 2px;
  background: var(--accent);
}

/* 全屏：铺满整个屏幕（底部导航不在全屏元素里，自然就没了） */
.sv-page.fs { bottom: 0; padding-top: 0; }

.speeds { margin-bottom: 12px; }

/*
 * ---- 桌面布局（≥ 1024px）----
 * 还是一格一条的吸附滚动、铺满页面，但每一条画成页面正中的一张 9:16 卡片（上下各留 --sv-gap、圆角 --sv-r），
 * 右侧一列按钮在卡片外面（ShortItem），「推荐 / 专题」和全屏 / 小窗 / 换一批 / 声音浮在卡片顶上，
 * 页面最右边是上一个 / 下一个。全屏时卡片顶天立地（没有留白和圆角），其余不变。
 *
 * 卡片宽度按高度算（9:16）：页面高度 = 窗口高度 − 顶栏 − 安全区，不依赖 aspect-ratio（Chrome 87 没有）；
 * --sv-cw 里的 100% 在用到它的地方才换算（卡片、顶上那一条、骨架都是按页面宽度算的，结果一样），
 * 窗口很窄很高时卡片宽度封顶，两边给右侧按钮和上 / 下按钮留出位置（画面在卡片里 contain，不变形）。
 */
@media (min-width: 1024px) {
  .sv-page {
    --sv-gap: 16px;
    --sv-r: 12px;
    --sv-vh: 100vh;
    --sv-top: calc(var(--desk-top) + var(--safe-t));
    --sv-cw: min(calc((var(--sv-vh) - var(--sv-top) - 2 * var(--sv-gap)) * 9 / 16), calc(100% - 360px));
    background: var(--bg);
  }
  .sv-page.fs { --sv-gap: 0px; --sv-r: 0px; --sv-top: 0px; --sv-side-b: 20px; }
  /* 无尽的流用不着滚动条（也免得它占掉宽度、卡片偏左）：滚轮、键盘、右边的按钮翻页 */
  .sv-feed { background: var(--bg); scrollbar-width: none; }
  .sv-feed::-webkit-scrollbar { display: none; }
  .sv-slot { padding: var(--sv-gap) 0; }

  /* 卡片顶上的一条：左边全屏 / 小窗，中间「推荐 / 专题」，右边换一批 / 声音（和卡片一样宽、一样居中） */
  .sv-top { top: calc(var(--safe-t) + var(--sv-gap)); width: var(--sv-cw); margin: 0 auto; }
  .sv-top .l { left: 8px; top: 8px; gap: 2px; }
  .sv-top .r { right: 8px; top: 8px; display: flex; gap: 2px; }
  .sv-top .l button,
  .sv-top .r button { width: 36px; height: 36px; border-radius: 50%; transition: background-color var(--dur-2) var(--ease-out); }
  .sv-top .l svg,
  .sv-top .r svg { width: 18px; height: 18px; }
  .sv-top .tt2 { top: 9px; gap: 28px; }
  /* 平滑翻页途中（stepping）很快淡出、滚到位再淡入：不压在滚过去的卡片的文字和卡片间的空隙上；淡出时不接点击 */
  .sv-top { transition: opacity var(--dur-2) var(--ease-out); }
  .sv-top.off { opacity: 0; transition-duration: var(--dur-1); }
  .sv-top.off .l,
  .sv-top.off .r,
  .sv-top.off .sv-tab { pointer-events: none; }

  .sv-refresh { top: calc(var(--safe-t) + var(--sv-gap) + 62px); }

  /* 页面右边：上一个 / 下一个 */
  .sv-nav {
    position: absolute;
    right: var(--desk-pad);
    top: 50%;
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 12px;
    transform: translateY(-50%);
  }
  .sv-nav button {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #1f1f1f;
    color: var(--t1);
    transition: background-color var(--dur-2) var(--ease-out), opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-spring);
  }
  .sv-nav svg { width: 22px; height: 22px; stroke-width: 2.2; }
  .sv-nav button:active:not(:disabled) { transform: scale(var(--press-scale-sm)); transition-duration: var(--dur-1); transition-timing-function: var(--ease-out); }
  .sv-nav button:disabled { opacity: .3; cursor: default; }

  /* 最后一格、第一页的骨架：也是正中的一张卡片 */
  .sv-tail { background: var(--bg); }
  .sv-tail-in { justify-content: center; width: var(--sv-cw); height: 100%; border-radius: var(--sv-r); background: var(--panel); font-size: 14px; }
  .sv-skel {
    top: var(--sv-gap);
    bottom: var(--sv-gap);
    width: var(--sv-cw);
    margin: 0 auto;
    border-radius: var(--sv-r);
    background: linear-gradient(180deg, #161616, #101010);
  }
  /* 右侧一列的位置和真的一样：卡片外面右边、底边对齐（圆 48px，下面一行字） */
  .sk-side { right: auto; left: calc(100% + 20px); bottom: 22px; gap: 36px; }
  .sk-side i { width: 48px; height: 48px; }
  .sk-meta { left: 16px; bottom: 60px; width: 70%; }
  .sv-empty { font-size: 14px; }

  /* 播放设置里的键盘快捷键 */
  .sv-keys { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
  .sv-keys h5 { margin-bottom: 10px; color: var(--t2); font-size: 13px; font-weight: 500; line-height: 18px; }
  .sv-keys dl { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; }
  .sv-keys dl > div { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .sv-keys dt { display: flex; flex: none; gap: 4px; }
  .sv-keys dt.mouse { color: var(--t3); font-size: 12px; line-height: 22px; }
  .sv-keys kbd {
    min-width: 24px;
    height: 22px;
    padding: 0 6px;
    border: 1px solid #333;
    border-radius: 5px;
    background: #1a1a1a;
    color: var(--t3);
    font: 600 12px/20px var(--font);
    text-align: center;
  }
  .sv-keys dd { overflow: hidden; color: var(--t2); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
}
@supports (height: 100dvh) {
  @media (min-width: 1024px) {
    .sv-page { --sv-vh: 100dvh; }
  }
}
/* 很高的窗口（卡片 1100px 以上）：卡片顶上的按钮、上 / 下按钮、骨架都大一号（和 ShortItem 里同一档） */
@media (min-width: 1024px) and (min-height: 1200px) {
  .sv-top .l { left: 10px; top: 10px; }
  .sv-top .r { right: 10px; top: 10px; }
  .sv-top .l button,
  .sv-top .r button { width: 40px; height: 40px; }
  .sv-top .l svg,
  .sv-top .r svg { width: 20px; height: 20px; }
  .sv-top .tt2 { top: 13px; gap: 32px; }
  .sv-tab { font-size: 17px; }
  .sv-nav { gap: 14px; }
  .sv-nav button { width: 56px; height: 56px; }
  .sv-nav svg { width: 26px; height: 26px; }
  .sk-side { left: calc(100% + 24px); bottom: 26px; gap: 44px; }
  .sk-side i { width: 56px; height: 56px; }
  .sk-meta { left: 20px; bottom: 76px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .sv-top .l button:hover,
  .sv-top .r button:hover { background: rgba(255, 255, 255, .14); }
  .sv-tab { transition: color var(--dur-2) var(--ease-out); }
  .sv-tab:not(.on):hover { color: rgba(255, 255, 255, .92); }
  .sv-nav button:not(:disabled):hover { background: #2c2c2c; }
  .sv-tail .retry,
  .sk-c .retry { transition: background-color var(--dur-2) var(--ease-out); }
  .sv-tail .retry:hover,
  .sk-c .retry:hover { background: #262626; }
}
</style>
