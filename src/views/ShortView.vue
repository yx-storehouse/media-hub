<script setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { getShorts, getVideo, getCreator, toggleVideoLike, toggleVideoFav, toggleVideoDislike, toggleFollow, addHistory, isDemoId } from '@/api'
import { errorText } from '@/api/http'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { useVideoStore } from '@/stores/videos'
import { toast, toastError } from '@/composables/useToast'
import { useTabRetap } from '@/composables/useTabRetap'
import { useReconnect } from '@/composables/useReconnect'
import { isDesktop } from '@/composables/useDesktop'
import { scrollBehavior } from '@/utils/motion'
import Icon from '@/components/Icon.vue'
import BottomSheet from '@/components/BottomSheet.vue'
import LoadState from '@/components/common/LoadState.vue'
import ShortItem, { audibleVolume, volumeZero } from '@/components/short/ShortItem.vue'
import { spaceToPlayer, useMouseFocusGuard } from '@/components/video/mouseFocus'

defineOptions({ name: 'ShortView' })

/*
 * 顶上（桌面是画框左上角）只有「推荐」一个频道：以前旁边的「专题」点了只提示「即将上线」，已经去掉；
 * 「推荐」现在只是说明这是推荐流的标签（不是按钮），换一批照旧是再点一次「短视频」/ 下拉 / 桌面的「换一批」
 */
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
/*
 * 视频文件打不开（NAS 文件共享抖一下、网络切换）：不当成「没有片源」，显示「视频暂时无法播放 · 点击重试」；
 * 屏幕上这一条过 RETRY_MS 自己再试一次，重新成为当前条、点它、网络恢复（online）时也重试。
 * 连着失败 MAX_FAILS 次才退回只看封面（和没有片源的一样，PREVIEW_SEC 后自动划走）
 */
const RETRY_MS = 3000
const MAX_FAILS = 2
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
const videoStore = useVideoStore()
const pageEl = useTemplateRef('page')
const feedEl = useTemplateRef('feed')

/** 每条额外带一个流内唯一的 feedKey：推荐翻过一整轮后同一个视频还会再出现 */
const clips = shallowRef([])
/** playback per clip, same order as `clips`: { t: seconds, playing, len: seconds（真实视频读到文件时长后替换；没有文件时是预览时长） } */
const players = ref([])
/** clip on screen; decides which clips are rendered and which real videos preload (the playback logic uses `current`) */
const active = ref(0)
/** 第一页还没回来 / 第一页很慢 / 第一页失败（出错的那个错误，交给 LoadState）/ 正在刷新 */
const loading = ref(true)
const slow = ref(false)
const failed = shallowRef(null)
const refreshing = ref(false)
/** 下一页的状态，显示在最后一条下面的那一格：'' 平常 / 'loading' / 'failed' / 'end'；失败时的错误在 moreError */
const moreState = ref('')
const moreError = shallowRef(null)

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
/** 有视频文件、并且没有连着打不开 MAX_FAILS 次（那样就退回只看封面） */
const playableClip = clip => !!clip?.src && (clip.fails || 0) < MAX_FAILS
/** 没有视频文件（或者打不开）：只给一个很短的预览计时，让自动连播能往下走 */
const clipLen = clip => (playableClip(clip) ? clip.len || 0 : Math.min(clip.len || PREVIEW_SEC, PREVIEW_SEC))
const newPlayer = clip => ({ t: 0, playing: false, len: clipLen(clip) })
const newSeed = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

const curClip = computed(() => clips.value[active.value] || null)

/*
 * 第一批视频回来、第一次挂上时只渲染屏幕上这一条，前后几条等这一条画出来以后（两帧）再挂，而且一帧只多挂一圈
 * （先前后各一条、下一帧再各一条；第一批时前面没有，就是先挂下一条）：第一次进短视频页时一下挂五条，
 * 排版、画模糊的底图要卡一下（4 倍降速时一百多毫秒）。挂满以后一直是前后各 RENDER_AROUND 条
 */
const around = ref(0)
let aroundRaf = 0
function widenAfterPaint() {
  if (around.value === RENDER_AROUND || aroundRaf) return
  const step = () => {
    around.value++
    aroundRaf = around.value < RENDER_AROUND ? requestAnimationFrame(step) : 0
  }
  aroundRaf = requestAnimationFrame(() => { aroundRaf = requestAnimationFrame(step) })
}

/*
 * 前后两条的预载：冷启动（打开短视频、换一批）时屏幕上这条和下一条同时整段下载会抢带宽，慢网下首帧要晚 0.8 秒左右。
 * 所以这时前后两条先不下载（preload="none"，有封面图垫着；只取元数据也会先下好几百 KB），等屏幕上这条自己缓冲出一截
 * （ShortItem 报 ahead）再整段预载（warm）：缓冲了 1.5 秒先预载下一条（1，上滑最常见：慢网下刚看几秒就划走，
 * 下一条也已经下了一截、马上能播），缓冲够了（3 秒以上 / 整段下完）前后两条都预载（2）。之后一直开着：
 * 上滑到的那条早就预载好了、一下就开播，它的前后两条接着预载（连着快速上滑也不用每条都等）。
 * 例外：屏幕上这条播着播着快接不上了（ShortItem 报 0：网速只比码率快一点点）就先停掉预载，等它缓冲回来再开。
 * 屏幕上这条没有视频文件（只看封面）时不用等。
 */
const warm = ref(0)
const warmFor = i => !playableClip(curClip.value) || warm.value >= (i > active.value ? 1 : 2)
function onAhead(i, lvl) {
  if (i !== active.value) return
  if (lvl === 0) warm.value = 0
  else if (lvl > warm.value) warm.value = Math.min(2, lvl)
}

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
  } catch (e) {
    if (gen === generation && !clips.value.length) failed.value = e || true
    return false
  } finally {
    if (gen === generation) {
      loading.value = false
      slow.value = false
      clearTimeout(slowTimer)
    }
  }
  if (gen !== generation) return false
  // 第一次（原来是空的）：滚动位置本来就在最上面，不用再滚（滚动要量尺寸，会逼浏览器当场把刚挂上的几条排版一遍，卡一下）
  const wasEmpty = !clips.value.length
  leaveView()
  seed = page.seed || s
  exclude = ex
  nextOffset = PAGE_SIZE
  hasMore = page.hasMore !== false
  loadingMore = null
  moreState.value = hasMore ? '' : 'end'
  failed.value = null
  const list = withKeys(page.list || [], [], ep)
  clips.value = list
  players.value = list.map(newPlayer)
  current = 0
  atTail = false
  navTo = -1
  warm.value = 0
  active.value = 0
  advancingTo = -1
  boosted = -1
  // 换上新的一批时第一条一挂上就是「在播」：不然在 IntersectionObserver 回调（下一帧）之前有一帧是暂停态，
  // 中间的播放键整套闪出来再淡掉。之后观察者那次 play(0) 什么也不改，记观看、记刷到过照常由它来做；
  // 自动播放被拦下时 ShortItem 照常报 state=false，播放键照常淡入
  if (visible) play(0)
  await nextTick()
  widenAfterPaint()
  if (visible) {
    if (!wasEmpty) scrollToClip(0)
    observe()
  }
  return true
}

function retry() {
  failed.value = null
  loading.value = true
  return load()
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
    .catch(e => {
      if (gen !== generation) return
      moreError.value = e
      moreState.value = 'failed'
    })
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

/*
 * 网络恢复：第一页还在慢慢等的重新加载（第一页失败的由出错页的 LoadState 自己重试），翻页失败或者快到末尾的接着加载，
 * 屏幕上和前后打不开的视频文件重新加载
 */
function onOnline() {
  if (!visible) return
  if (!clips.value.length) {
    if (slow.value && !failed.value) retry()
    return
  }
  if (moreState.value === 'failed' || atTail || current >= clips.value.length - PRELOAD_AHEAD) loadMore()
  for (let i = Math.max(0, active.value - 1); i <= Math.min(clips.value.length - 1, active.value + 1); i++) retryClip(i)
}
/* 翻页失败：服务器重启、网关 502 不会有 online 事件，出错期间（页面看得见时）隔一会儿自己再试（composables/useReconnect.js） */
useReconnect(() => loadMore(), () => moreState.value === 'failed')

/* ---------- 观看记录：真实视频播满 WATCH_MIN 秒记一次（登录后、只记数字 id），离开时补记看到第几秒 ---------- */

/** 屏幕上这一条的观看：{ key, id, played: 实际播放的秒数, sec: 播到第几秒 } */
let viewing = null
/** 已经记过观看的 feedKey：来回滑不重复计播放数 */
const counted = new Set()

function startView(i) {
  const c = clips.value[i]
  if (viewing && viewing.key === c?.feedKey) return
  leaveView()
  viewing = playableClip(c) && isRealId(c.id) ? { key: c.feedKey, id: c.id, played: 0, sec: 0 } : null
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
    noteStore(clip.id)
  } catch (e) {
    patchVideo(clip.id, before)   // 回滚
    store.set(dislikeKey(clip.id), localBefore)
    // 登录过期（登录框已经弹出来）、取消的请求不提示；其余用统一的说法（演示内容照样是「演示内容，无法操作」）
    toastError(e)
  } finally {
    pending.delete(pk)
  }
}

/*
 * ---------- 和别的页面同步赞 / 收藏（stores/videos.js）----------
 * 从「看完整版」进播放页点了赞 / 收藏再返回：这一条马上显示最新的（以前要等下一轮核对，期间是旧的、想取消要多点一次）。
 * 屏幕上这条和前后各两条里，store 里有比这一条上次核对更新的记录（at）就按它改；自己点完也记一笔（storeAt 跟着更新，不会再改回去）。
 */
function noteStore(id) {
  const c = clips.value.find(x => x.id === id)
  if (!c) return
  videoStore.note(id, { liked: !!c.liked, faved: !!c.faved, disliked: !!c.disliked, likeCount: likesOf(c), favCount: favsOf(c) })
  const s = videoStore.latest(id)
  if (s) patchVideo(id, { storeAt: s.at })
}
function applyStore() {
  const n = clips.value.length
  if (!n) return
  for (let i = Math.max(0, active.value - 2); i <= Math.min(n - 1, active.value + 2); i++) {
    const c = clips.value[i]
    const s = videoStore.latest(c.id)
    if (!s || s.at <= (c.storeAt || 0)) continue
    const upd = { storeAt: s.at }
    if (typeof s.liked === 'boolean') upd.liked = s.liked
    if (typeof s.faved === 'boolean') upd.faved = s.faved
    if (typeof s.disliked === 'boolean') upd.disliked = s.disliked || store.has(dislikeKey(c.id))
    if (typeof s.likeCount === 'number') upd.likes = s.likeCount
    if (typeof s.favCount === 'number') upd.favs = s.favCount
    patchVideo(c.id, upd)
  }
}
watch(() => videoStore.version, () => { if (visible) applyStore() })

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
    toastError(e, '关注失败，请稍后重试')
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
  // 视频文件打不开的：点画面 / 播放键就是重试
  if (retryClip(i)) return
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

/*
 * ---------- 视频文件打不开（见上面 RETRY_MS / MAX_FAILS）----------
 * 片源（src）一直留着，不改成「暂无视频源」：clip.fails 记连着失败了几次，clip.attempt 每重试一次 +1（ShortItem 用它重新建 <video>）。
 * 打不开一次：这条显示「视频暂时无法播放 · 点击重试」，屏幕上这条过一会儿自己再试；连着两次：退回只看封面（预览计时到了自动划走）。
 * 重新加载出来了（ShortItem 报 recovered）就清零。
 */
let retryTimer = 0
function onFailed(i) {
  const clip = clips.value[i]
  if (!clip?.src) return
  const fails = (clip.fails || 0) + 1
  patchVideo(clip.id, { fails })
  const p = players.value[i]
  if (!p) return
  p.playing = false
  if (i !== current || atTail) return
  if (viewing?.key === clip.feedKey) viewing = null
  if (fails >= MAX_FAILS) {
    // 退回只看封面：和没有片源的一样走预览计时（自动连播到了就划走）
    p.len = clipLen({ ...clip, fails })
    p.t = 0
    toast('视频暂时无法播放，先看看封面吧')
    play(i)
    return
  }
  clearTimeout(retryTimer)
  const key = clip.feedKey
  retryTimer = setTimeout(() => {
    if (visible && !atTail && clips.value[current]?.feedKey === key) retryClip(current)
  }, RETRY_MS)
}
/** 重试第 i 条打不开的视频文件（没失败过的什么也不做）；返回有没有重试 */
function retryClip(i) {
  const clip = clips.value[i]
  if (!clip?.src || !clip.fails) return false
  if (i === current) clearTimeout(retryTimer)
  // 已经退回封面的（失败满了）再给一次机会：这次再打不开又退回封面
  patchVideo(clip.id, { fails: Math.min(clip.fails, MAX_FAILS - 1), attempt: (clip.attempt || 0) + 1 })
  const p = players.value[i]
  p.len = clip.len || 0
  p.t = 0
  if (i === current && !atTail) {
    play(i)
    startView(i)
  }
  return true
}
/* 重新加载出来了：失败次数清零（之后再出错又从头算） */
function onRecovered(i) {
  const clip = clips.value[i]
  if (clip?.fails) patchVideo(clip.id, { fails: 0 })
}

/* 长按边缘快进：真实视频由 ShortItem 改 playbackRate；这里只记着，快进时不触发下拉刷新 */
const onBoost = (i, on) => { boosted = on ? i : boosted === i ? -1 : boosted }

/* 封面预览的计时（不跟倍速走：它不是视频，只是决定多久后翻到下一条） */
function tick() {
  const p = players.value[current]
  const clip = clips.value[current]
  if (atTail || !p || !p.playing || playableClip(clip)) return
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
      if (navTo === current) navTo = -1
      active.value = current
      advancingTo = -1
      clearTimeout(retryTimer)
      // 之前打不开的（预载时出错、划走前失败的）：重新成为当前条时重新加载
      if (!retryClip(current)) play(current)
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
/* 屏幕上这条能真的播放（有文件、现在没有打不开）：才有全屏 / 小窗 */
const curHasFile = computed(() => playableClip(curClip.value) && !curClip.value.fails)

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
 * ---------- 桌面布局（≥ 1024px）：滚轮 / 触控板、键盘翻页（和抖音网页版一样，没有上 / 下按钮） ----------
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
  // 画框里的东西（左上角的频道、文字、按钮、控制栏）都在这一条自己里面，跟着整个画框一起滑
  scrollToClip(to, scrollBehavior())
}

/*
 * 滚轮 / 触控板：一次手势只翻一条，不会一下滚过好几条。
 *  - 滚轮一格一个事件：连着转的几格（间隔不到 WHEEL_GAP）算同一次手势；
 *  - 触控板一次轻扫是一串先变大（手指在加速）再越来越小（松手后的惯性）的事件：整串算一次；
 *    惯性还没停又扫了一下，事件会重新变大，算新的一次：这串真的减弱过（最大的那个够 WHEEL_MIN，后来有不到它一半的），
 *    又出现比减弱后最小的那个（floor）大 4 倍以上、并且够 WHEEL_MIN 的。加速途中的小抖动（开头那几个小的、
 *    比前一个略小的）不算减弱，慢慢加速的一次轻扫不会被当成两次；
 *  - 反方向滚：马上算新的一次。
 * 页面上能自己滚的地方（展开的长标题）还能滚时交给它；Ctrl + 滚轮是浏览器缩放，不管。
 */
const WHEEL_MIN = 24
const WHEEL_GAP = 200
const WHEEL_SURGE_AFTER = 300
const wheel = { sum: 0, last: -1e9, used: false, dir: 0, at: 0, peak: 0, floor: Infinity }

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
    // 还在变大：记下最大的；明显减弱下来的（不到最大的一半）才记进最小值
    if (abs > wheel.peak) wheel.peak = abs
    else if (wheel.peak >= WHEEL_MIN && abs < wheel.peak / 2) wheel.floor = Math.min(wheel.floor, abs)
    return
  }
  wheel.sum += dy
  if (Math.abs(wheel.sum) < WHEEL_MIN) return
  wheel.used = true
  wheel.dir = Math.sign(wheel.sum)
  wheel.at = now
  wheel.peak = abs
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

/* 屏幕上这一条的 ShortItem（键盘快捷键通过它操作，和用鼠标点一样带动效）：feedKey → 组件 */
const items = new Map()
function setItem(key, inst) {
  if (inst) items.set(key, inst)
  else items.delete(key)
}
const curItem = () => (atTail ? null : items.get(clips.value[current]?.feedKey) || null)

const isTyping = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/*
 * 桌面：鼠标点过的按钮、拖过的进度条 / 音量条不留焦点（和 Safari 一样），页面外面（顶栏的 ☰、「登录」）用鼠标点过的按钮
 * 空格时把焦点还回去：之后按空格还是播放 / 暂停，不是再按一下那个按钮（连播被关掉、赞被取消、静音又被打开、导航又展开）。
 * 和播放页共用一套（components/video/mouseFocus.js）；只管这个页面里的（播放设置、登录框挂在页面外面）。
 */
const focusGuard = useMouseFocusGuard(pageEl)

/*
 * 不认 inert 的老引擎（Chrome / 安卓 WebView 87–101、Safari 14.5–15.4）：桌面上 :inert 管不住屏幕外的那几条，
 * Tab 会走进上一条 / 下一条的按钮，画框跟着滚过去、换成播放那一条。这里兜底（认 inert 的引擎不挂监听）：
 * 焦点落进不是当前这条的格子时，浏览器为了露出它已经把画框滚过去了，先滚回当前这条（同一个任务里，观察者还没看到），
 * 再把焦点送到该去的地方——从画框前面 Tab 进来的送到当前这条的第一个按钮（Shift+Tab 进来的送到最后一个）；
 * 从当前这条往后 / 往前 Tab 出去的送到画框后面 / 前面的第一个能聚焦的元素。
 * 不能把别的格子 visibility: hidden：当前条要滑进 60% 才算换条，翻页途中所有引擎都会看到空白。
 */
const HAS_INERT = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const tabbables = (root = document) => [...root.querySelectorAll(TABBABLE)].filter(el => el.getClientRects().length && !el.closest('[inert]'))
function onFeedFocusIn(e) {
  if (HAS_INERT || !isDesktop.value) return
  const feed = feedEl.value
  const slot = e.target instanceof Element ? e.target.closest('.sv-slot[data-index]') : null
  if (!feed || !slot || Number(slot.dataset.index) === active.value) return
  const curSlot = feed.querySelector(`.sv-slot[data-index="${active.value}"]`)
  const from = e.relatedTarget instanceof Element ? e.relatedTarget : null
  // 往后走（Tab）还是往前（Shift+Tab）：落点在来处的后面就是往后
  const forward = !from || !!(from.compareDocumentPosition(e.target) & Node.DOCUMENT_POSITION_FOLLOWING)
  scrollToClip(atTail ? clips.value.length : current)
  let to = null
  if (from && curSlot?.contains(from)) {
    // 从当前这条走出去：画框后面（前面）第一个能聚焦的；后面没有了就绕回页面最前面（和浏览器走到头一样从头来）
    const all = tabbables()
    const outside = all.filter(el => !feed.contains(el))
    to = forward
      ? outside.find(el => feed.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || outside[0]
      : [...outside].reverse().find(el => feed.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) || outside[outside.length - 1]
  } else if (curSlot) {
    const mine = tabbables(curSlot)
    to = forward ? mine[0] : mine[mine.length - 1]
  }
  if (to) to.focus({ preventScroll: true })
  else e.target.blur()
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
    // 键盘走过来的按钮：空格按它；鼠标点过的 ☰ 等：焦点还回去（松开空格时不会再按它一下），这一下照样是播放 / 暂停
    if (!spaceToPlayer(e.target)) return
    if (once) togglePlay()
  } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    if (playableClip(clips.value[current])) curItem()?.seekBy(k === 'ArrowLeft' ? -KEY_SEEK : KEY_SEEK)
  } else if (k === 'm' || k === 'M') {
    // 和控制栏上的喇叭一样：听不到声音（静音了，或者音量拉到了 0）就恢复声音，否则静音
    if (once) setMuted(!(store.muted || volumeZero()))
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
  clearInterval(timer)
  timer = 0
  io?.disconnect()
  leaveView()
  pauseAll()
  pullEnd()
  exitFullscreen()
  clearTimeout(retryTimer)
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
  // first activation: load() starts the observer once the feed is rendered; a failed first page is retried by its LoadState
  if (!clips.value.length) return
  if (atTail) {
    scrollToClip(clips.value.length)
    observe()
    return
  }
  // left in the middle of an auto-advance: land on the clip it was heading to, not the finished one
  if (advancingTo >= 0) current = advancingTo
  advancingTo = -1
  scrollToClip(current) // keep the same clip on screen in case the scroll offset was lost while detached
  // 在别的页面赞 / 收藏过（看完整版）：先按 stores/videos.js 里的最新状态改好，再核对
  applyStore()
  if (!retryClip(current)) play(current)
  startView(current)
  observe()
  syncNear()
})

onDeactivated(stop)

onUnmounted(() => {
  stop()
  cancelAnimationFrame(aroundRaf)
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

/**
 * 用户自己点的静音 / 恢复声音：记下来，下次打开照这个来。
 * quiet：桌面控制栏上的喇叭、音量条（图标自己就是反馈，不再弹提示）
 */
function setMuted(muted, quiet = false) {
  store.muted = muted
  store.sound = !muted
  // 桌面：音量拉到了 0 的话回到一半（不然提示「已恢复声音」还是听不见；手机上音量交给系统按键，不管）
  if (!muted && isDesktop.value) audibleVolume()
  if (!quiet) toast(muted ? '已静音' : '已恢复声音')
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
    @pointerdown.capture="focusGuard.onPointerDown"
    @focusin="focusGuard.onFocusIn"
  >
    <!-- 手机：顶上一条（全屏 / 小窗、「推荐」、声音）；桌面上这些都在每一条画框里（左上角的「推荐 · 换一批」、底边的控制栏） -->
    <div class="sv-top">
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
      <div class="tt2"><span class="sv-tab on">推荐</span></div>
      <div class="r">
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
      @focusin="onFeedFocusIn"
      @touchstart.passive="pullStart"
      @touchmove.passive="pullMove"
      @touchend.passive="pullEnd"
      @touchcancel.passive="pullEnd"
    >
      <!-- 每条一个整屏的格子；只有当前这条附近的才真正渲染，其余是空格子（滚动位置不受影响） -->
      <div v-for="(clip, i) in clips" :key="clip.feedKey" class="sv-slot" :data-index="i">
        <!-- 桌面：只有屏幕上这一条能用 Tab 聚焦 / 点（上下两条露出来的一截不接操作，Tab 也不会跳到屏幕外的那几条去） -->
        <ShortItem
          v-if="Math.abs(i - active) <= around"
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
          :warm="warmFor(i)"
          :fails="clip.fails || 0"
          :attempt="clip.attempt || 0"
          :following="followOf(clip)"
          :fs="fullscreen"
          :can-fs="canFullscreen"
          :can-pip="canPip"
          @toggle="toggle(i)"
          @dbllike="onDoubleLike(i)"
          @seek="t => seek(i, t)"
          @boost="on => onBoost(i, on)"
          @time="t => onTime(i, t)"
          @duration="d => onDuration(i, d)"
          @state="on => onState(i, on)"
          @ended="finish(i)"
          @failed="onFailed(i)"
          @retry="retryClip(i)"
          @recovered="onRecovered(i)"
          @ahead="lvl => onAhead(i, lvl)"
          @unmute="setMuted(false)"
          @like="onLike(i)"
          @dislike="onDislike(i)"
          @fav="onFav(i)"
          @follow="onFollow(i)"
          @settings="openSettings"
          @fullscreen="toggleFullscreen"
          @pip="togglePip"
          @mute="m => setMuted(m, true)"
        >
          <!--
            桌面：画框左上角的「推荐 / 专题 · 换一批」（手机上是页面顶上那一条和下拉刷新；ShortItem 只在桌面布局时渲染它）。
            这里不写 v-if：带条件的插槽会被编译成「动态插槽」，父组件每次更新（播放进度）都会让每一条跟着重渲染
          -->
          <template #top>
            <div class="sv-feeds"><span class="sv-tab on">推荐</span></div>
            <i class="sv-dsep" aria-hidden="true" />
            <button class="sv-rf" type="button" title="换一批（再点一次左侧的「短视频」也一样）" @click="refresh('tap')">
              <Icon name="refresh" />换一批
            </button>
          </template>
        </ShortItem>
      </div>
      <!-- 最后一格：下一页还没到时转圈，失败时给重试（滑到这里会自动再试一次） -->
      <div v-if="clips.length" class="sv-slot sv-tail" data-tail>
        <div v-if="moreState === 'failed'" class="sv-tail-in" role="alert">
          {{ errorText(moreError) }}
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
      <!-- 第一页失败：统一的说法；连不上 / 服务器出错时联网、过一会儿会自己重试（LoadState） -->
      <LoadState v-else-if="failed" class="sv-empty" :error="failed" :retry="retry" />
      <div v-else-if="!loading && !clips.length" class="empty sv-empty">还没有视频</div>
    </div>

    <!--
      桌面：还没有内容（第一页的骨架、没有视频、加载失败）时，画框左上角照样是「推荐 / 专题 · 换一批」，
      位置和每一条里的那一份（上面的 #top 插槽）一样：数据回来时不跳；没有视频时这里的「换一批」就是刷新
    -->
    <div v-if="isDesktop && !clips.length" class="sv-ftop">
      <div class="sv-feeds"><span class="sv-tab on">推荐</span></div>
      <i class="sv-dsep" aria-hidden="true" />
      <button class="sv-rf" type="button" title="换一批（再点一次左侧的「短视频」也一样）" @click="refresh('tap')">
        <Icon name="refresh" />换一批
      </button>
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
      <!-- 和播放页的「播放设置」同一个顺序（自动连播在前）；整行都能点（开关本身的点击也冒泡到这一行） -->
      <div class="row2 sw-row" @click="store.playback.autoNext = !store.playback.autoNext">
        <span>自动连播</span>
        <button class="sw" :class="{ on: store.playback.autoNext }" type="button" role="switch" aria-label="自动连播" :aria-checked="store.playback.autoNext" />
      </div>
      <div class="row2 sw-row" @click="store.playback.loop = !store.playback.loop">
        <span>循环播放</span>
        <button class="sw" :class="{ on: store.playback.loop }" type="button" role="switch" aria-label="循环播放" :aria-checked="store.playback.loop" />
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
.sk-c .retry { position: relative; height: 30px; margin-top: 4px; padding: 0 18px; border-radius: 15px; background: var(--chip); color: var(--t1); font-size: 13px; }
/* 能点的范围上下撑到 44px（和出错页的「重试」一样） */
.sv-tail .retry::after,
.sk-c .retry::after { content: ''; position: absolute; top: -7px; right: -4px; bottom: -7px; left: -4px; }
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
.sv-top .r { pointer-events: auto; }
/* 左上角全屏 / 小窗、右上角声音：图标 17px，按钮本身 44×44（从屏幕边缘算起），可点区域不再偏小 */
.sv-top .l { position: absolute; left: 0; top: 0; display: flex; color: #fff; }
.sv-top .l svg { width: 17px; height: 17px; stroke-width: 2.2; opacity: .92; }
.sv-top .r { position: absolute; right: 0; top: 0; color: #fff; }
.sv-top .r svg { width: 17px; height: 17px; opacity: .92; }
.sv-top .l button,
.sv-top .r button { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; }
.sv-top .tt2 { position: absolute; left: 0; right: 0; top: 15px; display: flex; justify-content: center; gap: 30px; }

/* 「推荐」：说明这是推荐流的标签（不是按钮，点下去落到下面的画面上） */
.sv-tab {
  position: relative;
  display: block;
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
.sw-row { cursor: pointer; }

/*
 * ---- 桌面布局（≥ 1024px，参照抖音网页版的推荐流）----
 * 还是一格一条的吸附滚动，每一条画成一个铺满页面的圆角大画框：顶栏下面、左侧导航右边、窗口右边和底边都只留 --sv-gap，
 * 不限最宽，右边也不留按钮的位置（屏幕都给画面）。每条一样大，翻页（滚轮 / 触控板、↑ ↓ / J K）时整个画框上下滑。
 * 画框里的东西都在 ShortItem 里：最底下一条常驻的控制栏（--sv-bar 高），上面是画面区；左上角的频道、左下角的文字、
 * 右边一列对齐同一组内边距 --sv-in，文字和右边一列的底边在 --sv-lift（控制栏上面一点）。
 * 全屏时画框铺满屏幕：没有留白和圆角，里面的排法不变。
 */
@media (min-width: 1024px) {
  .sv-page {
    --sv-gap: 12px;
    --sv-r: 14px;
    --sv-in: 20px;
    --sv-bar: 48px;
    /* 比进度条上悬停时间的那一行（控制栏上沿往上 6–26px）高：鼠标在进度条两头时，时间标签不压住右边一列最下面的字、话题和「看完整版」 */
    --sv-lift: calc(var(--sv-bar) + 26px);
    background: var(--bg);
  }
  .sv-page.fs { --sv-gap: 0px; --sv-r: 0px; }
  /* 无尽的流用不着滚动条（也免得它占掉宽度）：滚轮、触控板、键盘翻页 */
  .sv-feed { background: var(--bg); scrollbar-width: none; }
  .sv-feed::-webkit-scrollbar { display: none; }
  .sv-slot { padding: var(--sv-gap); }

  /* 手机的顶上一条：桌面上这些都在画框里 */
  .sv-top { display: none; }

  /* 画框左上角（ShortItem 的 .sv-dtop 里）：推荐 / 专题 · 换一批 */
  .sv-feeds { display: flex; gap: 22px; }
  .sv-feeds .sv-tab { line-height: 32px; }
  .sv-dsep { width: 1px; height: 14px; margin: 0 8px 0 18px; background: rgba(255, 255, 255, .3); }
  .sv-rf {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 32px;
    padding: 0 10px;
    border-radius: 16px;
    color: rgba(255, 255, 255, .78);
    font-size: 14px;
    font-weight: 500;
    text-shadow: 0 1px 6px rgba(0, 0, 0, .35);
  }
  .sv-rf svg { width: 15px; height: 15px; stroke-width: 2.3; }

  /* 换一批的提示：画框上沿往下（和「2X 快进中」同一行）；画框左右留白一样，水平正中就是页面正中 */
  .sv-refresh { top: calc(var(--safe-t) + var(--sv-gap) + var(--sv-in) + 50px); }

  /* 最后一格、第一页的骨架、空状态：也是同一个画框 */
  .sv-tail { background: var(--bg); }
  .sv-tail-in { justify-content: center; width: 100%; height: 100%; border-radius: var(--sv-r); background: var(--panel); font-size: 14px; }
  .sv-skel { inset: var(--sv-gap); overflow: hidden; border-radius: var(--sv-r); background: linear-gradient(180deg, #161616, #101010); }
  /* 底边一条和真的一样的控制栏位置：数据回来时画面区不变大小 */
  .sv-skel::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: var(--sv-bar); background: #000; }
  /*
   * 右边一列、左下角文字的位置和真的一样（数据回来时不跳）：头像，下面五个按钮，每个是图标 + 一行字。
   * 圆点在图标那一格（44px）的正中，圆点下面一小截横条在字的位置；头像用 ::before 画（手机的骨架没有头像，不多加元素）
   */
  .sk-side { right: var(--sv-in); bottom: var(--sv-lift); align-items: center; gap: 10px; width: 48px; }
  .sk-side::before { content: ''; flex: none; width: 48px; height: 48px; margin-bottom: 8px; border-radius: 50%; background: #1d1d1d; animation: sk 1.2s ease-in-out infinite; }
  .sk-side i { position: relative; width: 36px; height: 36px; margin: 4px 4px 23px; }
  .sk-side i::after { content: ''; position: absolute; left: 50%; top: calc(100% + 10px); width: 24px; height: 8px; margin-left: -12px; border-radius: 4px; background: inherit; }
  /* 三条：作者、标题、话题那三行的位置 */
  .sk-meta { left: var(--sv-in); bottom: var(--sv-lift); gap: 14px; width: min(40%, 440px); padding-bottom: 5px; }
  /* 中间的转圈 / 「网络有点慢」：画面区正中（和缓冲转圈、暂停时的播放键同一个位置） */
  .sk-c { top: calc((100% - var(--sv-bar)) / 2); }
  .sv-empty {
    inset: var(--sv-gap);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0;
    border-radius: var(--sv-r);
    background: var(--panel);
    font-size: 14px;
  }
  /* 出错页是 LoadState（子组件）：按钮要用 :deep 才选得到 */
  .sv-empty :deep(.retry) { height: 30px; margin: 4px 0 0; padding: 0 18px; border-radius: 15px; font-size: 13px; }
  /* 还没有内容时左上角的「推荐 / 专题 · 换一批」：和每一条画框里的那一份同一个位置（画框左上角往里 --sv-in） */
  .sv-ftop { position: absolute; left: calc(var(--sv-gap) + var(--sv-in)); top: calc(var(--sv-gap) + var(--sv-in) - 6px); z-index: 6; display: flex; align-items: center; }

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
/* 很高的窗口（画框 1100px 以上，如 2560×1440）：内边距、控制栏、频道都大一号（和 ShortItem 里同一档） */
@media (min-width: 1024px) and (min-height: 1200px) {
  .sv-page { --sv-in: 24px; --sv-bar: 56px; --sv-lift: calc(var(--sv-bar) + 30px); }
  .sv-feeds .sv-tab { font-size: 18px; line-height: 36px; }
  .sv-rf { height: 36px; font-size: 15px; }
  .sv-rf svg { width: 17px; height: 17px; }
  .sk-side { gap: 14px; width: 56px; }
  .sk-side::before { width: 56px; height: 56px; }
  .sk-side i { width: 44px; height: 44px; margin-bottom: 25px; }
  .sk-side i::after { top: calc(100% + 11px); }
}
/* 窗口比较矮（和 ShortItem 里同一档，右边一列收小一号） */
@media (min-width: 1024px) and (max-height: 700px) {
  .sk-side { gap: 6px; }
  .sk-side::before { width: 42px; height: 42px; }
  .sk-side i { width: 32px; height: 32px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .sv-rf { transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out); }
  .sv-rf:hover { background: rgba(255, 255, 255, .12); color: #fff; }
  .sv-tail .retry,
  .sk-c .retry,
  .sv-empty :deep(.retry) { transition: background-color var(--dur-2) var(--ease-out); }
  .sv-tail .retry:hover,
  .sk-c .retry:hover,
  .sv-empty :deep(.retry:hover) { background: #262626; color: var(--t1); }
}
</style>
