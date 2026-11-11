<script>
import { ref as moduleRef } from 'vue'
/*
 * 桌面上调的音量（0–1）：和播放页的播放器记在同一个地方（reel:volume），所有短视频共用一份。
 * 只有桌面布局有音量条，手机上不写、也不改 <video>.volume（音量交给系统按键）。
 */
const VOL_KEY = 'reel:volume'
function readVol() {
  try {
    const v = parseFloat(localStorage.getItem(VOL_KEY))
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
  } catch {
    return 1
  }
}
const deskVol = moduleRef(readVol())
/* 拖音量条时稍等一下再写（停下来才写一次）；页面收起时还没写的马上写掉 */
let volSave = 0
function flushVol() {
  clearTimeout(volSave)
  volSave = 0
  try { localStorage.setItem(VOL_KEY, String(deskVol.value)) } catch { /* 存不了就只在这次打开里有效 */ }
}
/**
 * 桌面：要恢复声音时音量是 0（拉到了最底）就回到一半，不然取消了静音还是听不见。
 * 控制栏的喇叭、快捷键 M、「点击恢复声音」都走这里（短视频页在桌面布局时调用）
 */
export function audibleVolume() {
  if (deskVol.value > 0) return
  deskVol.value = 0.5
  flushVol()
}
/** 桌面：音量拉到了 0（没静音也听不见） */
export const volumeZero = () => deskVol.value === 0
</script>

<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { share } from '@/composables/useShare'
import { setResume } from '@/components/video/resume'
import { rememberVideo } from '@/components/video/preview'
import { cssDuration, haptic } from '@/utils/motion'
import { isDesktop } from '@/composables/useDesktop'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import ActBurst from '@/components/video/ActBurst.vue'
import RollNum from '@/components/video/RollNum.vue'

/*
 * One full-screen clip of the short-video feed.
 * Playback (time / playing) is owned by the feed; this component renders it and reports intents:
 *   toggle   tap on the clip (single tap, after the double-tap window) or the play button
 *   dbllike  双击屏幕：点赞（已赞不变），在手指位置冒一个大拇指
 *   seek     new position in seconds (±10 s buttons; progress bar: tap, or drag and release)
 *   boost    true / false：按住左右两侧边缘 2 倍速播放，松手恢复（只对有视频文件的生效）
 *   unmute   "点击恢复声音" pill
 *   settings 设置 action
 *   like / dislike / fav  右侧按钮（状态由父组件维护）
 *   follow   头像下的「+」：关注作者（following 由父组件维护；只管关注，取消关注去主页）
 *
 * clip.src 有值（后台给视频配了素材文件）时用原生 <video> 播放，并把实际情况报给父组件：
 *   time     播放到第几秒（timeupdate）
 *   duration 文件的真实时长（读到有限值才报）
 *   state    原生播放 / 暂停（播完、被浏览器拦下自动播放时，父组件据此更新按钮）
 *   ended    播完（循环播放时 <video loop> 自己从头来，不会触发）
 *   failed   文件打不开：父组件把这条退回封面预览
 * clip.src 为空时如实显示：清晰的封面 +「暂无视频源 · 看详情」，父组件只用一个很短的计时让自动连播往下走。
 *
 * 桌面布局（≥ 1024px，参照抖音网页版的推荐流）：这一条是铺满页面的一个大画框（圆角，尺寸由 ShortView 的 --sv-* 给），
 * 底边是单独一条常驻的深色控制栏（进度线压在它的上沿；播放 / 时间 / 连播 / 倍速 / 音量 / 小窗 / 全屏），上面整块是画面区：
 * 画面居中、不裁切（contain），空出来的地方是模糊压暗的封面；画面区里左上角是父组件放进来的「推荐 / 专题 · 换一批」（slot top），
 * 左下角作者 · 发布时间、标题、话题，右边一列按钮。另外几个事件：
 *   fullscreen / pip  控制栏上的全屏、小窗（父组件处理：全屏的是整个短视频页）
 *   mute              控制栏上的喇叭、音量条：要静音（true）/ 恢复声音（false）
 * 鼠标双击按系统的双击间隔认（见 onTap），进度条上悬停显示那个位置的时间。
 * 父组件用键盘快捷键时通过 defineExpose 的 userToggle / seekBy 操作屏幕上这一条（和点按钮一样带动效）。
 */
const props = defineProps({
  /** Short: { id, tags, title, len, cover, src, likes, favs, liked, faved, creator: { id, name, handle, avatar } | null } */
  clip: { type: Object, required: true },
  liked: Boolean,
  faved: Boolean,
  disliked: Boolean,
  /** 当前点赞 / 收藏数（父组件维护，含本地已点的那一次） */
  likes: { type: Number, default: 0 },
  favs: { type: Number, default: 0 },
  /** playback position in seconds */
  time: { type: Number, default: 0 },
  /** 时长（秒）：父组件给的（读到文件真实时长后会替换；没有文件时是预览计时的长度） */
  len: { type: Number, default: 0 },
  playing: Boolean,
  /** 就是屏幕上这一条（单击的延迟回调、标题展开、小窗都只对它有效） */
  current: Boolean,
  /** load the background photo immediately (clips on or next to the screen) */
  eager: Boolean,
  /** 在当前这条附近：真实视频提前加载，离得远的不加载 */
  near: Boolean,
  /** 是否已关注作者：true / false；null = 还不知道（登录后正在取），这时不显示「+」 */
  following: { type: Boolean, default: null },
  /** 桌面控制栏用：短视频页正在全屏、浏览器能不能全屏 / 小窗（父组件判断） */
  fs: Boolean,
  canFs: Boolean,
  canPip: Boolean
})
const emit = defineEmits(['toggle', 'dbllike', 'seek', 'boost', 'unmute', 'settings', 'like', 'dislike', 'fav', 'follow', 'time', 'duration', 'state', 'ended', 'failed', 'fullscreen', 'pip', 'mute'])

const store = useAppStore()
const router = useRouter()

/** 长按快进：按住多久生效、手指移动超过多少就不算长按、两侧边缘各占宽度的比例、倍速 */
const PRESS_MS = 350
const PRESS_SLOP = 10
const EDGE = 0.22
const BOOST_RATE = 2
/** 单击要等这么久确认没有第二下（双击点赞）；两下离得多近算双击；按住多久再松手就不算点击 */
const TAP_MS = 250
const DOUBLE_SLOP = 40
const HOLD_MS = 500
/** 进度条上按方向键一次跳几秒 */
const KEY_STEP = 5
/** 时长到这么多秒的视频显示「看完整版」 */
const FULL_MIN = 60

/* ---------- 真实视频 ---------- */

const videoEl = useTemplateRef('video')
const hasVideo = computed(() => !!props.clip.src)
const length = computed(() => props.len || props.clip.len || 0)
/** 按住边缘时临时 2 倍速，不改播放设置里的倍速 */
const boosting = ref(false)
const rate = computed(() => (boosting.value ? BOOST_RATE : parseFloat(store.playback.speed) || 1))

/** 让 <video> 跟上父组件的 playing */
async function sync() {
  const v = videoEl.value
  if (!v) return
  if (!props.playing) {
    if (!v.paused) v.pause()
    return
  }
  if (v.ended) v.currentTime = 0
  v.playbackRate = rate.value
  try {
    const p = v.play()
    // 要播了但手里的数据还不够播：开始等（够了会发 playing，见 onReady）
    if (v.readyState < HAVE_FUTURE_DATA) onStall()
    await p
  } catch (e) {
    // 文件打不开由 onError 处理（父组件会退回封面预览）；元素已被换掉时这个结果也没用了，都不再上报
    if (v.error || v !== videoEl.value) return
    // 浏览器不让有声自动播放：先静音播（store.sound 不变，用户在页面上点一下就自动恢复声音）
    if (e?.name === 'NotAllowedError' && !v.muted) {
      store.muted = true
      v.muted = true
      try {
        await v.play()
        return
      } catch { /* 静音也被拦下：保持暂停，等用户点播放 */ }
    }
    // 被 pause() 打断（AbortError）说明父组件已经要它停了，其余情况告诉父组件没播起来
    if (e?.name !== 'AbortError' && props.playing && v.paused) emit('state', false)
  }
}
watch(() => props.playing, on => {
  if (!on) endPress(true)   // 播完 / 被暂停时还按着：结束快进
  // 是用户点出来的切换：中间的播放键带一下动画（自动播放、翻页、播完都不带）
  if (performance.now() - toggledAt < TOGGLE_FX_MS) ctlFx.value = on ? 'out' : 'in'
  toggledAt = -Infinity
  sync()
})
watch(hasVideo, on => { if (on) sync() }, { flush: 'post' })
watch(rate, r => { if (videoEl.value) videoEl.value.playbackRate = r })
onMounted(sync)

/*
 * ---------- 缓冲转圈：要播却卡住了（开播时数据还不够、网慢播到了还没下载的地方、拖到还没下载的位置）----------
 * 和播放页播放器的转圈同一个样子、同一个规矩：卡住满 STALL_MS 还没好才淡入，一下就好的（翻页、开播、拖完进度）什么也看不到。
 * 只管屏幕上这一条、并且是在播的时候；暂停、划走、播完、出错立刻收起。等多久由计时器管（不用 CSS 的 animation-delay：
 * 「减少动态效果」时那个延迟会被清零，每次开播都会闪一下转圈）。
 * 冷启动（这一条还一帧都没解出来就要播：首次打开短视频、划到一条完全没预载的）要多等一会儿：COLD_MS。解码器起步加上
 * 页面刚挂上时主线程忙，慢一点的手机首次打开要 0.3～0.45 秒才真的播起来，这段时间封面一直在，不用再叠一个转圈。
 * 转圈一旦出来，因为数据到了而收起时至少留满 MIN_SHOW_MS：数据刚好在转圈出来后几十毫秒到的话，不会刚开始淡入就没了、只闪一两帧。
 */
const HAVE_CURRENT_DATA = 2
const HAVE_FUTURE_DATA = 3
const STALL_MS = 250
const COLD_MS = 600
const MIN_SHOW_MS = 300
const buffering = ref(false)
let stallTimer = 0
let hideTimer = 0
/** 转圈出来的时刻（performance.now()） */
let shownAt = 0
/** 卡住时播到第几秒（-1 = 没卡住）：之后真的往前播了就算好了（有的浏览器缓冲好以后不一定再发 playing） */
let stallAt = -1
function onStall() {
  const v = videoEl.value
  if (!v || !props.current || !props.playing || v.paused || stallAt >= 0) return
  stallAt = v.currentTime
  clearTimeout(stallTimer)
  // 转圈还在（刚好了、还没到最短时长又卡住）：接着转，不收
  if (buffering.value) {
    clearTimeout(hideTimer)
    return
  }
  const cold = v.readyState < HAVE_CURRENT_DATA && v.currentTime === 0
  stallTimer = setTimeout(() => {
    if (stallAt < 0) return
    buffering.value = true
    shownAt = performance.now()
  }, cold ? COLD_MS : STALL_MS)
}
/** 'stalled'（下载停住了一阵）：手里的数据确实不够接着播才算卡住 */
function onStalled(e) {
  if (e.target.readyState < HAVE_FUTURE_DATA) onStall()
}
/** 立刻收起：暂停、划走、播完、出错、页面收起 */
function onBuffered() {
  clearTimeout(stallTimer)
  clearTimeout(hideTimer)
  stallAt = -1
  buffering.value = false
}
/** 数据够了、接着播了（playing / canplay / 真的往前播了）：转圈已经出来的话留满 MIN_SHOW_MS 再收 */
function onReady() {
  if (!buffering.value) return onBuffered()
  clearTimeout(stallTimer)
  stallAt = -1
  const left = MIN_SHOW_MS - (performance.now() - shownAt)
  if (left <= 0) return onBuffered()
  clearTimeout(hideTimer)
  hideTimer = setTimeout(onBuffered, left)
}
/** canplay：数据够了；还在播的话马上就会接着走（或者已经发了 playing） */
function onCanPlay(e) {
  if (e.target.readyState >= HAVE_FUTURE_DATA) onReady()
}
/* 不播了、或者不是屏幕上这一条了：收起 */
watch(() => props.playing && props.current, on => { if (!on) onBuffered() })

/** 小窗只跟着屏幕上这一条：滑走了就收起，免得小窗里停着上一条 */
function exitPip() {
  const v = videoEl.value
  if (!v) return
  if (document.pictureInPictureElement === v) document.exitPictureInPicture().catch(() => {})
  else if (v.webkitPresentationMode === 'picture-in-picture') v.webkitSetPresentationMode?.('inline')
}
watch(() => props.current, on => {
  if (on) return
  clearTimeout(tapTimer)
  tapTimer = 0
  titleOpen.value = false
  followTapped = false
  exitPip()
  closeSpeed()
})

/*
 * 页面被 KeepAlive 收起时父组件会先暂停全部；这里再兜一层，保证不会在后台继续出声。
 * 还没播完的动效一并撤掉：收起时动画被打断，再挂回来时浏览器会从头重播一遍。
 */
onDeactivated(() => {
  endPress()
  clearTimeout(tapTimer)
  tapTimer = 0
  // 收起前在播的这条：收起期间不露暂停态的播放键（KeepAlive 在同一个任务里调完所有收起钩子，这时 playing 还是暂停前的值）
  ctlHold.value = props.playing
  videoEl.value?.pause()
  onBuffered()
  clearFx()
  quiet.value = true
  // 桌面控制栏：收起倍速菜单，没写掉的音量马上写
  closeSpeed()
  volDrag.value = false
  if (volSave) flushVol()
})
/*
 * 收起时父组件把每条都暂停了，回来又接着播：这一来一回不该让播放键淡入淡出一遍。
 * 收起时先关掉过渡（.quiet），回来两帧以后再打开。
 * 收起时正在播的那条（.held）：页面滑走 / 切走的整个过程里播放键一直藏着，不会在离开的画面上一下冒出来；
 * 用户自己暂停的那条照旧带着播放键滑走。
 */
const quiet = ref(false)
const ctlHold = ref(false)
let quietRaf = 0
onActivated(() => {
  cancelAnimationFrame(quietRaf)
  quietRaf = requestAnimationFrame(() => {
    quietRaf = requestAnimationFrame(() => {
      quiet.value = false
      ctlHold.value = false
    })
  })
  // 播放页上可能调过音量（记在同一个 reel:volume 里）：回来时按最新的
  if (isDesktop.value) deskVol.value = readVol()
})
/* 卸载时释放地址，否则离开后还可能在后台下载 */
onBeforeUnmount(() => {
  endPress()
  clearTimeout(tapTimer)
  clearTimeout(followTimer)
  clearTimeout(stallTimer)
  clearTimeout(hideTimer)
  closeSpeed()
  cancelAnimationFrame(quietRaf)
  ro?.disconnect()
  const v = videoEl.value
  if (!v) return
  exitPip()
  v.pause()
  v.removeAttribute('src')
  v.load()
})

function onMeta(e) {
  const d = e.target.duration
  // MediaRecorder 录的 webm 开头读不到时长（Infinity），这时继续用后台记的时长
  if (Number.isFinite(d) && d > 0) emit('duration', d)
  e.target.playbackRate = rate.value
  if (isDesktop.value) e.target.volume = deskVol.value
}
function onTime(e) {
  const v = e.target
  // 卡住以后又往前播了：缓冲好了
  if (stallAt >= 0 && !v.paused && v.currentTime > stallAt + 0.05 && v.readyState >= HAVE_FUTURE_DATA) onReady()
  emit('time', v.currentTime)
}
/*
 * 原生播放 / 暂停报给父组件。元素被移出文档时（文件打不开退回封面、页面被 KeepAlive 收起、卸载）
 * 浏览器会自动补发一次 pause，那不是用户或播放进度造成的，不能拿来改父组件的状态。
 */
const onPlayState = e => {
  if (e.type === 'pause') onBuffered()
  if (e.target.isConnected && e.target === videoEl.value) emit('state', e.type === 'play')
}
function onEnded() {
  onBuffered()
  emit('ended')
}
function onError() {
  onBuffered()
  emit('state', false)
  emit('failed')
}

/** 跳到第 t 秒：真实视频直接设 currentTime，父组件同步记下进度 */
function seekTo(t) {
  t = Math.min(length.value, Math.max(0, t))
  const v = videoEl.value
  if (v && Number.isFinite(t)) v.currentTime = t
  emit('seek', t)
}

/* ---------- 没有视频文件：封面清晰显示（加载出来后底图才虚化当背景） ---------- */

const posterOk = ref(false)
watch(() => props.clip.cover?.src, () => { posterOk.value = false })

/* ---------- 进度条：点一下跳过去；按住拖动时只预览，松手才跳 ---------- */

/** id：正在拖的指针（null = 没在拖）；t：预览到的秒数；moved：真的横着拖过（显示大号时间） */
const drag = reactive({ id: null, t: 0, x: 0, y: 0, moved: false })
const dragging = computed(() => drag.id !== null)
const scrubbing = computed(() => dragging.value && drag.moved)
const shownTime = computed(() => (dragging.value ? drag.t : props.time))
/** 进度百分比（0–100）：填充条和圆点都用 transform 移动，播放中不触发重新排版 */
const pct = computed(() => (length.value ? Math.min(100, (shownTime.value / length.value) * 100) : 0))

const timeAt = (e, el) => {
  const rect = el.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * length.value
}

function scrubStart(e) {
  if (!e.isPrimary || e.button !== 0 || !length.value) return
  e.stopPropagation()
  try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 指针已经抬起 */ }
  Object.assign(drag, { id: e.pointerId, t: timeAt(e, e.currentTarget), x: e.clientX, y: e.clientY, moved: false })
}
function scrubMove(e) {
  scrubHover(e)
  if (e.pointerId !== drag.id) return
  e.stopPropagation()
  drag.t = timeAt(e, e.currentTarget)
  // 以横向为主才算拖进度；从进度条上往上滑（马上会变成翻页）时大号时间不闪一下
  const dx = Math.abs(e.clientX - drag.x)
  if (!drag.moved && dx > 3 && dx >= Math.abs(e.clientY - drag.y)) drag.moved = true
}
function scrubEnd(e) {
  if (e.pointerId !== drag.id) return
  e.stopPropagation()
  const t = timeAt(e, e.currentTarget)
  drag.id = null
  seekTo(t)
}
/* 被系统打断（来电、手势被接管）：放弃这次拖动，不跳 */
function scrubCancel(e) {
  if (e.pointerId === drag.id) drag.id = null
}

/*
 * 桌面：鼠标停在进度条上时，指针上方显示那个位置的时间（拖动时中间有大号时间，这个让开），
 * 线上浅一点的一截标出指着的位置（p，0–100）。进度条横贯整个画框，两头就是画框的边（圆角、超出的被切掉）：
 * 时间标签的中心离两头至少 TIP_HALF（「00:00」的标签 49px 宽，一半 24.5，再往里留 5px 多），整个标签都在画框里
 */
const hover = reactive({ on: false, x: 0, t: 0, p: 0 })
const TIP_HALF = 30
function scrubHover(e) {
  if (e.pointerType !== 'mouse' || !isDesktop.value) return
  const rect = e.currentTarget.getBoundingClientRect()
  const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left))
  hover.p = rect.width ? (x / rect.width) * 100 : 0
  hover.t = (hover.p / 100) * length.value
  hover.x = Math.min(Math.max(x, TIP_HALF), Math.max(TIP_HALF, rect.width - TIP_HALF))
  hover.on = true
}
function scrubLeave() {
  if (hover.on) hover.on = false
}
function scrubKey(e) {
  // 桌面：↑ / ↓ 留给短视频页翻上一条 / 下一条（鼠标点过进度条后焦点留在这里，按 ↓ 也不会变成后退 5 秒）
  if (isDesktop.value && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return
  const step = { ArrowLeft: -KEY_STEP, ArrowDown: -KEY_STEP, ArrowRight: KEY_STEP, ArrowUp: KEY_STEP }[e.key]
  if (step) seekTo(props.time + step)
  else if (e.key === 'Home') seekTo(0)
  else if (e.key === 'End') seekTo(length.value)
  else return
  // 方向键不再让外面的短视频流翻页
  e.preventDefault()
  e.stopPropagation()
}

/* ---------- 点屏幕：单击播放 / 暂停，双击点赞；长按左右两侧边缘 2 倍速，长按哪里松手都不暂停 ---------- */

/** 当前这次边缘按压：{ id, x, y, timer }，不在边缘按下时为 null */
let press = null
/** 快进结束后浏览器可能补发一次 click，不能当成「点一下暂停」 */
let swallowClick = false
/** 这次按下的时间（任何位置）：按住超过 HOLD_MS 再松手补发的 click 一律忽略 */
let downAt = 0
/** 上一次点击（判断双击）和还没执行的单击 */
let lastTap = null
let tapTimer = 0
/** 这次按下的是鼠标还是手指（鼠标双击另有规则，见 onTap） */
let downType = ''
/** 鼠标双击最长认多久（系统的双击间隔，Windows 默认 500ms；浏览器在 click 的 detail 里告诉我们是不是双击） */
const MOUSE_DBL_MS = 600

function pressStart(e) {
  if (!e.isPrimary || e.button !== 0) return
  downAt = e.timeStamp
  downType = e.pointerType || ''
  swallowClick = false
  endPress()
  if (!hasVideo.value) return   // 封面预览没有可快进的内容
  const rect = e.currentTarget.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  if (x > EDGE && x < 1 - EDGE) return
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(startBoost, PRESS_MS) }
  // 鼠标移出元素再松开也要收到 pointerup（触摸本来就会）
  if (e.pointerType === 'mouse') try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
}
function pressMove(e) {
  if (!press || e.pointerId !== press.id || boosting.value) return
  // 手指在动：是在滑动翻页，不算长按
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > PRESS_SLOP) endPress()
}
function pressUp(e) {
  if (!press || e.pointerId !== press.id) return
  endPress(true)
}
/* 开始滚动（浏览器接管手势）、来电等：直接结束 */
function pressCancel(e) {
  if (press && e.pointerId === press.id) endPress()
}
function startBoost() {
  if (!press || !props.playing) return
  boosting.value = true
  emit('boost', true)
}
/** 结束这次按压；swallow：快进过的话吞掉随后的那次 click */
function endPress(swallow = false) {
  if (press) clearTimeout(press.timer)
  press = null
  if (!boosting.value) return
  if (swallow) swallowClick = true
  boosting.value = false
  emit('boost', false)
}
function onTap(e) {
  if (swallowClick) {
    swallowClick = false
    return
  }
  // 桌面：这一下是用来收起倍速菜单的（见 onDocDown），不当成播放 / 暂停
  if (e.timeStamp - menuEatAt < HOLD_MS) {
    menuEatAt = -Infinity
    return
  }
  // 长按（任何位置）后松手：不是点击
  if (downAt && e.timeStamp - downAt > HOLD_MS) return
  const rect = e.currentTarget.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const prev = lastTap
  const tap = { at: e.timeStamp, x, y, fired: false }
  lastTap = tap
  /*
   * 鼠标双击：系统的双击间隔可能比 TAP_MS 长，浏览器认作双击的（detail ≥ 2）也算。
   * 两下之间超过 TAP_MS 时第一下的单击已经切换过播放了：再切回来，双击前后播放状态不变
   */
  const gap = prev ? e.timeStamp - prev.at : Infinity
  const mouseDbl = downType === 'mouse' && e.detail >= 2 && gap < MOUSE_DBL_MS
  if (prev && (gap < TAP_MS || mouseDbl) && Math.hypot(x - prev.x, y - prev.y) < DOUBLE_SLOP) {
    // 双击（连点时每一下都算）：撤销还没执行的单击，点赞
    clearTimeout(tapTimer)
    tapTimer = 0
    if (prev.fired && props.current) userToggle()
    burst(x, y)
    emit('dbllike')
    return
  }
  clearTimeout(tapTimer)
  tapTimer = setTimeout(() => {
    tapTimer = 0
    tap.fired = true
    if (props.current) userToggle()
  }, TAP_MS)
}
/* 快进时手指上下动也不翻页 */
function holdScroll(e) {
  if (boosting.value && e.cancelable) e.preventDefault()
}

/*
 * 双击时在手指位置冒出的大拇指（和右侧点赞按钮同一个图标）：回弹放大、随机歪一点，停一下再上浮淡出，
 * 动画结束自己移除；连着双击会叠出好几个。
 */
const bursts = ref([])
let burstSeq = 0
function burst(x, y) {
  bursts.value = [...bursts.value.slice(-5), { id: ++burstSeq, x, y, r: Math.round(Math.random() * 30 - 15) }]
  haptic()
  // 右侧的赞按钮也跟着弹一下（状态真的从没赞变成赞了才弹，见 watchAct）；震动上面已经给过
  markTap('like', true)
}
const dropBurst = id => { bursts.value = bursts.value.filter(b => b.id !== id) }

/* ---------- 点画面 / 播放键切换播放：中间的播放键带一下动画 ---------- */

/** 'in'：刚暂停，播放键从大到小落到位 / 'out'：刚继续播，播放键放大淡出；动画播完清空 */
const ctlFx = ref('')
/** 用户这一下切换的时间：之后 playing 真的变了才算是用户点出来的 */
let toggledAt = -Infinity
const TOGGLE_FX_MS = 400
function userToggle() {
  toggledAt = performance.now()
  emit('toggle')
}

/* ---------- ±10 秒：按钮上的箭头转一下，同一侧冒出一道向外的箭头 ---------- */

/** { dir: -1 | 1, sec: 跳了几秒, key }：key 递增让连点时从头再播 */
const seekFx = ref(null)
let seekFxSeq = 0
function seekBy(delta) {
  seekFx.value = { dir: Math.sign(delta), sec: Math.abs(delta), key: ++seekFxSeq }
  seekTo(props.time + delta)
}

/* ---------- 作者 / 话题 / 标题 / 看完整版 ---------- */

const creator = computed(() => props.clip.creator || null)
function openCreator() {
  if (creator.value?.id == null) return
  router.push(`/creator/${encodeURIComponent(creator.value.id)}`)
}

const tags = computed(() => (props.clip.tags || []).map(t => String(t).replace(/^#/, '')).filter(Boolean))
const searchTag = t => router.push({ path: '/search', query: { q: t } })

/** 进播放页；看过一会儿的话从这里接着播（封面、标题先记下，播放页加载时就能显示） */
function openDetail() {
  if (hasVideo.value) setResume(props.clip.id, props.time, length.value)
  rememberVideo(props.clip)
  router.push(`/video/${encodeURIComponent(props.clip.id)}`)
}
const showFull = computed(() => hasVideo.value && length.value >= FULL_MIN)

/* 标题超过两行才可以点开看全文（再点收起）；没被截断时点标题和点画面一样 */
const titleEl = useTemplateRef('titleEl')
const titleOpen = ref(false)
const titleClamped = ref(false)
function measureTitle() {
  const el = titleEl.value
  if (!el || titleOpen.value) return
  titleClamped.value = el.scrollHeight > el.clientHeight + 1
}
let ro = null
onMounted(() => {
  measureTitle()
  if ('ResizeObserver' in window && titleEl.value) {
    ro = new ResizeObserver(() => measureTitle())
    ro.observe(titleEl.value)
  }
})
watch(() => props.clip.title, () => nextTick(measureTitle))
function toggleTitle() {
  if (!titleClamped.value) return
  titleOpen.value = !titleOpen.value
  if (!titleOpen.value) nextTick(measureTitle)
}

/** 分享这一条自己的播放页地址（不是短视频页：对方打开看到的是同一条） */
const shareUrl = () => new URL(router.resolve(`/video/${encodeURIComponent(props.clip.id)}`).href, location.href).href

const pad = n => String(n).padStart(2, '0')
const mmss = sec => {
  const s = Math.floor(sec)
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

/* ---------- 右侧按钮的动效 ---------- */

/*
 * 按下去立刻缩一下（CSS :active）；状态真的变了才弹：点亮是回弹 + 赞 / 收藏冒一圈小点，熄掉是轻轻一缩。
 * 赞 / 藏 / 不喜欢的状态由父组件决定（没登录会先弹登录框、请求中连点不算），所以先记下「刚点过」，
 * 等 liked / faved / disliked 真的变了再动；登录后补做、换身份同步这些不是这一下点出来的，不动。
 * 分享 / 设置没有状态，点了就弹一下。
 *
 * fx[id] = { kind: 'on' | 'off' | 'tap', key }：key 递增会重新挂上图标，连点时动画从头播；
 * 播完（animationend）就清掉，页面被 KeepAlive 收起再回来也不会重播。
 */
const fx = reactive({})
/** 冒小点的那一圈（ActBurst）：值是 key，0 = 没有 */
const rings = reactive({})
/** 刚点过的按钮：{ at, quiet }，quiet = 震动已经给过了（双击点赞） */
const tapped = {}
const TAP_FX_MS = 600

function playFx(id, kind) {
  fx[id] = { kind, key: (fx[id]?.key || 0) + 1 }
}
function markTap(id, quiet = false) {
  tapped[id] = { at: performance.now(), quiet }
}
/** 状态从父组件回来时才动：只认刚点过的那一下 */
function watchAct(id, get, burstOn) {
  watch(get, on => {
    const t = tapped[id]
    if (!t || performance.now() - t.at > TAP_FX_MS) return
    tapped[id] = null
    playFx(id, on ? 'on' : 'off')
    if (!on || !burstOn) return
    rings[id] = (rings[id] || 0) + 1
    if (!t.quiet) haptic()
  })
}
watchAct('like', () => props.liked, true)
watchAct('fav', () => props.faved, true)
watchAct('dislike', () => props.disliked, false)

const fxClass = id => (fx[id] ? `fx-${fx[id].kind}` : null)
function endFx(e) {
  // 只认图标自己的动画结束（冒小点的那一圈在旁边，各管各的）
  if (e.target === e.currentTarget) fx[e.currentTarget.dataset.fx] = null
}
/** 小点圈播完撤掉：每个按钮一个固定的函数（同上，不在模板里写内联函数） */
const ringDone = { like: () => { rings.like = 0 }, fav: () => { rings.fav = 0 } }
function clearFx() {
  for (const k of Object.keys(fx)) fx[k] = null
  for (const k of Object.keys(rings)) rings[k] = 0
  bursts.value = []
  ctlFx.value = ''
  seekFx.value = null
}

/* 互动都交给父组件（赞和不喜欢的互斥也由它处理）；这里只记下「刚点过」，好让图标跟着状态动 */
function like() { markTap('like'); emit('like') }
function dislike() { markTap('dislike'); emit('dislike') }
function fav() { markTap('fav'); emit('fav') }
function tapPlain(id, run) {
  playFx(id, 'tap')
  run()
}

/* ---------- 头像下的「+」：点了变成「✓」，停一下再收起（只在知道没关注时出现） ---------- */

const followFx = ref(false)
let followTapped = false
let followTimer = 0
const showFollow = computed(() => !!creator.value && (props.following === false || followFx.value))
function follow() {
  followTapped = true
  emit('follow')
}
watch(() => props.following, (on, before) => {
  if (on !== true || before !== false || !followTapped) return
  followTapped = false
  haptic()
  followFx.value = true
  clearTimeout(followTimer)
  // 「+」转成「✓」画完以后再停一小会儿，然后收起（减少动态效果时立刻收起）
  followTimer = setTimeout(() => { followFx.value = false }, cssDuration('--dur-4', 380) * 2)
})

/* 倍速不是 1.0x 时「设置」直接显示当前倍速，免得忘了自己调过 */
const speedLabel = computed(() => (store.playback.speed === '1.0x' ? '设置' : store.playback.speed))

/* `on` is only set for toggles (it also drives aria-pressed); `aria` names the count-only buttons */
const actions = computed(() => [
    { id: 'like', icon: 'thumbUp', label: props.likes, roll: true, aria: `点赞 ${props.likes}`, on: props.liked, run: like },
    { id: 'dislike', icon: 'thumbDown', label: '不喜欢', on: props.disliked, run: dislike },
    { id: 'fav', icon: 'heart', label: props.favs, roll: true, aria: `收藏 ${props.favs}`, on: props.faved, run: fav },
    { id: 'share', icon: 'shareNodes', label: '分享', run: () => tapPlain('share', () => share({ title: props.clip.title, url: shareUrl() })) },
    { id: 'settings', icon: 'gear', label: speedLabel.value, roll: true, aria: `播放设置，当前 ${store.playback.speed} 倍速`, run: () => tapPlain('settings', () => emit('settings')) }
])

/* ---------- 桌面（≥ 1024px）：作者旁边的发布时间 ---------- */

/** 发布时间：刚刚 / N分钟前 / N小时前 / N天前，再早的是「M月D日」（不是今年的带年份）；没有时间就不显示 */
const ago = computed(() => {
  const ts = props.clip.publishedAt
  if (!isDesktop.value || !Number.isFinite(ts) || ts <= 0) return ''
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}天前`
  const d = new Date(ts * 1000)
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`
})

/* ---------- 桌面：连播 / 倍速 ---------- */

/** 倍速菜单从上到下：快的在上面（和抖音一样） */
const MENU_SPEEDS = ['2.0x', '1.5x', '1.25x', '1.0x', '0.75x', '0.5x']
const speedOpen = ref(false)
const speedEl = useTemplateRef('speedEl')
const speedBtn = useTemplateRef('speedBtn')
const menuEl = useTemplateRef('menuEl')
/** 点菜单外面的画面收起菜单的那一下（pointerdown 的时间）：随后的 click 不当成播放 / 暂停 */
let menuEatAt = -Infinity

function toggleAutoNext() {
  store.playback.autoNext = !store.playback.autoNext
}
/* 键盘按下按钮产生的 click 没有点击次数（detail 为 0）：这时焦点直接进菜单（选中的那一项） */
function toggleSpeed(e) {
  if (speedOpen.value) return closeSpeed(e?.detail === 0)
  speedOpen.value = true
  document.addEventListener('pointerdown', onDocDown, true)
  document.addEventListener('keydown', onDocKey)
  if (e?.detail === 0) nextTick(() => menuEl.value?.querySelector('[aria-checked="true"]')?.focus())
}
function closeSpeed(refocus = false) {
  if (!speedOpen.value) return
  speedOpen.value = false
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onDocKey)
  if (refocus) speedBtn.value?.focus()
}
function onDocDown(e) {
  if (speedEl.value?.contains(e.target)) return
  if (e.target.classList?.contains('sv-click')) menuEatAt = e.timeStamp
  closeSpeed()
}
/*
 * Esc 收起菜单，焦点在哪都算（鼠标点开的菜单，焦点不在菜单里）；焦点原来在菜单里（键盘打开的）就回到「倍速」按钮。
 * 别的弹层先处理过的 Esc（defaultPrevented）不管
 */
function onDocKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  e.preventDefault()
  closeSpeed(!!speedEl.value?.contains(document.activeElement))
}
function pickSpeed(s, e) {
  store.playback.speed = s
  closeSpeed(e?.detail === 0)
}
/* 鼠标移到喇叭上要调音量：倍速菜单先收起（两个弹出来的不叠在一起）；键盘走到喇叭上也一样 */
function onVolEnter(e) {
  if (e.pointerType === 'mouse') closeSpeed()
}
/* 菜单里：↑ ↓ 在几项之间移动（按键不再交给短视频页翻页）；Esc 见 onDocKey */
function onMenuKey(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  e.preventDefault()
  const items = [...(menuEl.value?.querySelectorAll('button') || [])]
  const i = items.indexOf(document.activeElement)
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
  next?.focus()
}
const speedText = computed(() => (store.playback.speed === '1.0x' ? '倍速' : store.playback.speed))

/* ---------- 桌面：音量（鼠标移到喇叭上，上面弹出竖着的音量条；和播放页同一个音量） ---------- */

const volEl = useTemplateRef('volEl')
const volDrag = ref(false)
/** 听不到声音：静音了，或者音量拉到了 0 */
const silent = computed(() => store.muted || (isDesktop.value && deskVol.value === 0))
const volPct = computed(() => (store.muted ? 0 : Math.round(deskVol.value * 100)))

function setVolume(v) {
  v = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100
  deskVol.value = v
  // 往上调就是要声音：静音着的顺便打开
  if (v > 0 && store.muted) emit('mute', false)
  clearTimeout(volSave)
  volSave = setTimeout(flushVol, 300)
}
/* 桌面才改 <video>.volume；拉窄到手机布局时还原成 1（手机上音量交给系统按键） */
watch([deskVol, isDesktop], ([v, desk]) => {
  if (videoEl.value) videoEl.value.volume = desk ? v : 1
})
/* 拉窄到手机布局：桌面的倍速菜单、音量拖动都收掉 */
watch(isDesktop, desk => {
  if (desk) return
  closeSpeed()
  volDrag.value = false
})
function toggleMute() {
  if (silent.value) {
    // 音量拉到 0 以后取消静音：回到一半音量（不然点了喇叭还是没声音）
    if (deskVol.value === 0) setVolume(0.5)
    if (store.muted) emit('mute', false)
  } else emit('mute', true)
}
/* 竖着的音量条：从下往上是 0–100%（按在条的上下两头外面也算，夹到 0 / 1） */
function volAt(e) {
  const r = volEl.value.getBoundingClientRect()
  return (r.bottom - e.clientY) / Math.max(1, r.height)
}
function startVol(e) {
  if (!e.isPrimary || e.button !== 0) return
  volDrag.value = true
  try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 指针已经抬起 */ }
  setVolume(volAt(e))
}
function moveVol(e) {
  if (volDrag.value) setVolume(volAt(e))
}
function endVol() {
  volDrag.value = false
}
/*
 * 聚焦在音量条上时方向键调音量（这时 ↑ ↓ 不翻页，和别的竖着的滑块一样）。
 * 静音着（包括浏览器不让自动有声播放的时候）：往上是恢复声音，从记着的音量接着来（记着的是 0 就从一格开始）；
 * 往下什么也不做，不把记着的音量（播放页也用）改成 0
 */
function onVolKey(e) {
  const step = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05 }[e.key]
  let v = null
  if (step != null) {
    if (!store.muted) v = deskVol.value + step
    else if (step > 0) v = Math.max(deskVol.value, step)
  } else if (e.key === 'Home') v = 0
  else if (e.key === 'End') v = 1
  else return
  e.preventDefault()
  e.stopPropagation()
  if (v != null) setVolume(v)
}

/*
 * 桌面的键盘快捷键（父组件管按键，操作屏幕上这一条）：空格 = 点一下播放键，← / → = 跳几秒，
 * 和用鼠标点一样带播放键 / 箭头的动效
 */
defineExpose({ userToggle, seekBy })
</script>

<template>
  <section
    class="sv"
    :class="{ playing, cur: current, quiet, held: ctlHold, real: hasVideo, still: !hasVideo, 'poster-ok': posterOk, scrubbing, boosting, 'title-open': titleOpen }"
    @contextmenu.prevent
  >
    <Cover class="sv-bg" v-bind="clip.cover" :eager="eager" />
    <!-- 有素材文件：真实播放（横屏视频上下留边，露出底下模糊的封面） -->
    <video
      v-if="hasVideo"
      ref="video"
      class="sv-video"
      :src="clip.src"
      :poster="clip.cover?.src || undefined"
      :preload="near ? 'auto' : 'none'"
      :muted="store.muted"
      :loop="store.playback.loop"
      playsinline
      webkit-playsinline
      @loadedmetadata="onMeta"
      @durationchange="onMeta"
      @timeupdate="onTime"
      @play="onPlayState"
      @pause="onPlayState"
      @ended="onEnded"
      @error="onError"
      @waiting="onStall"
      @stalled="onStalled"
      @playing="onReady"
      @canplay="onCanPlay"
      @emptied="onBuffered"
    />
    <!-- 没有素材文件：完整、清晰地显示封面（不再假装在播放） -->
    <Cover v-else-if="clip.cover?.src" class="sv-poster" :src="clip.cover.src" :eager="eager" @load="posterOk = true" />
    <!-- 单击播放 / 暂停，双击点赞；按住左右两侧边缘 2 倍速 -->
    <div
      class="sv-click"
      @click="onTap"
      @pointerdown="pressStart"
      @pointermove="pressMove"
      @pointerup="pressUp"
      @pointercancel="pressCancel"
      @touchmove="holdScroll"
    />
    <!-- 卡住了：中间转圈（满 0.25 秒才淡入），不接手指 -->
    <div v-if="buffering" class="sv-buf" aria-hidden="true" />
    <!-- 外层上浮淡出（停一下再走），里层回弹放大 + 随机歪一点；外层的动画播完才移除 -->
    <i
      v-for="b in bursts"
      :key="b.id"
      class="sv-burst"
      :style="{ left: `${b.x}px`, top: `${b.y}px`, '--r': `${b.r}deg` }"
      aria-hidden="true"
      @animationend.self="dropBurst(b.id)"
    ><i class="sb-in"><Icon name="thumbUp" /></i></i>

    <!-- 长按快进：从顶部弹下来，两个箭头轮流亮（像在往前流），松手很快收起 -->
    <Transition name="boost">
      <div v-show="boosting" class="sv-boost" role="status">
        <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 6 6 6-6 6" /><path d="m12.5 6 6 6-6 6" /></svg>2X 快进中
      </div>
    </Transition>
    <Transition name="scrub">
      <div v-show="scrubbing" class="sv-scrub" aria-hidden="true"><b>{{ mmss(drag.t) }}</b> / {{ mmss(length) }}</div>
    </Transition>

    <!-- ±10 秒：在按钮那一侧冒一道向外的箭头 -->
    <i
      v-if="seekFx"
      :key="seekFx.key"
      class="sv-seekfx"
      :class="seekFx.dir < 0 ? 'l' : 'r'"
      aria-hidden="true"
      @animationend.self="seekFx = null"
    >
      <svg class="ic" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /><path d="m3 6 6 6-6 6" /></svg>
      <span>{{ seekFx.dir < 0 ? '-' : '+' }}{{ seekFx.sec }}秒</span>
    </i>

    <!-- 桌面：画框左上角，父组件放进来的「推荐 / 专题 · 换一批」（跟着这一条一起滑动） -->
    <div v-if="isDesktop && $slots.top" class="sv-dtop"><slot name="top" /></div>

    <div class="sv-ctl" :class="ctlFx && `fx-${ctlFx}`">
      <button v-if="hasVideo" class="sk back" :class="{ spin: seekFx?.dir < 0 }" type="button" aria-label="后退10秒" @click="seekBy(-10)">
        <Icon :key="seekFx?.dir < 0 ? seekFx.key : 0" name="replay" />
      </button>
      <!-- 桌面：控制栏上有同一个播放 / 暂停键，正中这个不进 Tab 顺序（鼠标照样能点） -->
      <button
        class="pb"
        type="button"
        :tabindex="isDesktop ? -1 : undefined"
        :aria-label="playing ? '暂停' : '播放'"
        @click="userToggle"
        @animationend.self="ctlFx = ''"
      >
        <Icon name="play" />
      </button>
      <button v-if="hasVideo" class="sk fwd" :class="{ spin: seekFx?.dir > 0 }" type="button" aria-label="前进10秒" @click="seekBy(10)">
        <Icon :key="seekFx?.dir > 0 ? seekFx.key : 0" name="forward" />
      </button>
    </div>

    <!-- 左下角一列：恢复声音 / 暂无视频源、作者、话题、标题、看完整版（按内容高度往上排） -->
    <div class="sv-meta">
      <template v-if="hasVideo">
        <button v-show="store.muted" class="sv-unmute" type="button" @click="emit('unmute')">
          <Icon name="mute" />点击恢复声音
        </button>
      </template>
      <button v-else class="sv-chip sv-nosrc" type="button" @click="openDetail">
        暂无视频源 · 看详情<Icon name="chevR" />
      </button>
      <!-- 桌面：作者 · 发布时间 一行，标题排在它下面、话题再下面 -->
      <div v-if="isDesktop && (creator || ago)" class="sv-who">
        <button v-if="creator" class="sv-name" type="button" @click="openCreator">@{{ creator.name }}</button>
        <span v-if="ago" class="sv-ago">{{ creator ? '· ' : '' }}{{ ago }}</span>
      </div>
      <button v-else-if="creator" class="sv-name" type="button" @click="openCreator">@{{ creator.name }}</button>
      <!-- 手机：话题在标题上面；桌面在标题下面（见下面那一份）。DOM 顺序跟着画出来的顺序走，Tab 也是从上往下 -->
      <div v-if="tags.length && !isDesktop" class="sv-tags">
        <button v-for="t in tags" :key="t" type="button" @click="searchTag(t)">#{{ t }}</button>
      </div>
      <div
        ref="titleEl"
        class="sv-title"
        :class="{ more: titleClamped || titleOpen }"
        :role="titleClamped || titleOpen ? 'button' : undefined"
        :tabindex="titleClamped || titleOpen ? 0 : undefined"
        :aria-expanded="titleClamped || titleOpen ? titleOpen : undefined"
        @click="toggleTitle"
        @keydown.enter.space.prevent="toggleTitle"
      >
        {{ clip.title }}
      </div>
      <div v-if="tags.length && isDesktop" class="sv-tags">
        <button v-for="t in tags" :key="t" type="button" @click="searchTag(t)">#{{ t }}</button>
      </div>
      <button v-if="showFull" class="sv-chip sv-full" type="button" @click="openDetail">看完整版<Icon name="chevR" /></button>
    </div>

    <!-- 桌面：这条进度线压在控制栏的上沿（画面和控制栏的分界线上） -->
    <div v-if="hasVideo" class="sv-prog" :class="{ drag: dragging }">
      <span>{{ mmss(shownTime) }}</span>
      <div
        class="track"
        role="slider"
        tabindex="0"
        aria-label="播放进度"
        :aria-valuemin="0"
        :aria-valuemax="Math.floor(length)"
        :aria-valuenow="Math.floor(shownTime)"
        :aria-valuetext="`${mmss(shownTime)} / ${mmss(length)}`"
        @pointerdown="scrubStart"
        @pointermove="scrubMove"
        @pointerup="scrubEnd"
        @pointercancel="scrubCancel"
        @lostpointercapture="scrubCancel"
        @pointerleave="scrubLeave"
        @keydown="scrubKey"
      >
        <!-- 线（拖动时用 scaleY 变粗）和圆点（按住时回弹长出来）分开：圆点不跟着线一起被压扁 -->
        <div class="bar">
          <!-- 桌面：鼠标指着的位置（浅色的一截） -->
          <b v-if="isDesktop" class="hov" :class="{ on: hover.on }" :style="{ transform: `translateX(${hover.p - 100}%)` }" />
          <i :style="{ transform: `translateX(${pct - 100}%)` }" />
        </div>
        <span class="knob" :style="{ transform: `translateX(${pct}%)` }"><b /></span>
        <!-- 桌面：鼠标悬停处的时间 -->
        <span
          v-if="isDesktop"
          class="tip"
          :class="{ on: hover.on && !dragging }"
          :style="{ transform: `translateX(${hover.x}px)` }"
          aria-hidden="true"
        ><b>{{ mmss(hover.t) }}</b></span>
      </div>
      <span>{{ mmss(length) }}</span>
    </div>
    <!-- 封面预览：只有一条细线表示多久后自动翻到下一条，不显示时间、不能拖 -->
    <div v-else class="sv-prog sv-wait" aria-hidden="true">
      <div class="bar"><i :style="{ transform: `translateX(${pct - 100}%)` }" /></div>
    </div>

    <div class="sv-side">
      <div v-if="creator" class="sv-au">
        <button class="sv-author" type="button" :aria-label="`${creator.name} 的主页`" @click="openCreator">
          <Cover class="av" v-bind="creator.avatar" />
        </button>
        <!-- 「+」：点了以后横线竖线转走、对勾一笔画出来，停一下整个收起 -->
        <Transition name="fl">
          <button
            v-if="showFollow"
            class="sv-follow"
            :class="{ done: following }"
            type="button"
            :aria-label="following ? `已关注 ${creator.name}` : `关注 ${creator.name}`"
            :aria-pressed="!!following"
            @click="follow"
          >
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path class="fl-p" d="M12 6.5v11M6.5 12h11" />
              <path class="fl-c" pathLength="1" d="m6.6 12.4 3.7 3.7 7.1-7.4" />
            </svg>
          </button>
        </Transition>
      </div>
      <button
        v-for="a in actions"
        :key="a.id"
        class="sv-act"
        :class="{ on: a.on }"
        type="button"
        :aria-label="a.aria"
        :aria-pressed="a.on"
        @click="a.run"
      >
        <!-- 图标上的监听用同一个函数（按 data-fx 认按钮）：v-for 里写内联函数会让图标随每次进度更新一起重渲染 -->
        <span class="ico">
          <Icon :key="fx[a.id]?.key || 0" :name="a.icon" :class="fxClass(a.id)" :data-fx="a.id" @animationend="endFx" />
          <ActBurst v-if="rings[a.id]" :key="rings[a.id]" @done="ringDone[a.id]" />
        </span>
        <!-- 会变的（赞 / 收藏数、倍速）才翻动；「不喜欢」「分享」是固定文字，不多挂一层组件 -->
        <RollNum v-if="a.roll" :value="a.label" :n="typeof a.label === 'number' ? a.label : null" />
        <span v-else>{{ a.label }}</span>
      </button>
    </div>

    <!--
      桌面：画框底边单独一条常驻的深色控制栏（抖音网页版那样，不压在画面上、不自动收起）；进度条是上面的 .sv-prog，压在它的上沿。
      左边播放 / 暂停、时间，右边连播、倍速、音量、小窗、全屏。没有片源的条目只有播放 / 暂停（控制封面预览的计时）和连播
    -->
    <div v-if="isDesktop" class="sv-bar">
      <button class="b-btn" type="button" :aria-label="playing ? '暂停' : '播放'" :title="playing ? '暂停（空格）' : '播放（空格）'" @click="userToggle">
        <Icon :name="playing ? 'pause' : 'play'" />
      </button>
      <span v-if="hasVideo" class="b-time">{{ mmss(shownTime) }}<i>/</i>{{ mmss(length) }}</span>
      <span class="b-sp" />
      <button
        class="b-auto"
        :class="{ on: store.playback.autoNext }"
        type="button"
        role="switch"
        :aria-checked="store.playback.autoNext"
        title="自动连播：播完自动播下一个"
        @click="toggleAutoNext"
      >
        <i class="b-sw" aria-hidden="true" />连播
      </button>
      <div v-if="hasVideo" ref="speedEl" class="b-speed">
        <button
          ref="speedBtn"
          class="b-btn b-txt"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="speedOpen"
          :aria-label="`倍速，当前 ${store.playback.speed}`"
          @click="toggleSpeed"
        >
          {{ speedText }}
        </button>
        <Transition name="b-menu">
          <div v-if="speedOpen" ref="menuEl" class="b-menu" role="menu" aria-label="倍速" @keydown="onMenuKey">
            <button
              v-for="s in MENU_SPEEDS"
              :key="s"
              type="button"
              role="menuitemradio"
              :aria-checked="store.playback.speed === s"
              :class="{ on: store.playback.speed === s }"
              @click="pickSpeed(s, $event)"
            >
              {{ s }}
            </button>
          </div>
        </Transition>
      </div>
      <template v-if="hasVideo">
        <!-- 音量：鼠标移到喇叭上，上面弹出竖着的音量条（键盘聚焦、正在拖时也在） -->
        <div class="b-volw" :class="{ on: volDrag }" @pointerenter="onVolEnter" @focusin="closeSpeed()">
          <button
            class="b-btn"
            type="button"
            data-sound
            :aria-label="silent ? '恢复声音' : '静音'"
            :title="silent ? '恢复声音（M）' : '静音（M）'"
            @click="toggleMute"
          >
            <Icon :name="silent ? 'mute' : 'vol'" />
          </button>
          <div
            class="b-vpop"
            role="slider"
            tabindex="0"
            aria-label="音量"
            aria-orientation="vertical"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="volPct"
            :aria-valuetext="store.muted ? '静音' : `${volPct}%`"
            @pointerdown="startVol"
            @pointermove="moveVol"
            @pointerup="endVol"
            @pointercancel="endVol"
            @lostpointercapture="endVol"
            @keydown="onVolKey"
          >
            <span class="vn">{{ volPct }}</span>
            <div ref="volEl" class="vt">
              <i :style="{ transform: `scaleY(${volPct / 100})` }" />
              <span class="vk" :style="{ transform: `translateY(${-volPct}%)` }"><b /></span>
            </div>
          </div>
        </div>
        <button v-if="canPip" class="b-btn" type="button" aria-label="小窗播放" title="小窗播放" @click="emit('pip')">
          <Icon name="pip" />
        </button>
      </template>
      <button
        v-if="fs || (hasVideo && canFs)"
        class="b-btn"
        type="button"
        :aria-label="fs ? '退出全屏' : '全屏'"
        :title="fs ? '退出全屏（F）' : '全屏（F）'"
        @click="emit('fullscreen')"
      >
        <Icon :name="fs ? 'fullscreenExit' : 'fullscreen'" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.sv {
  position: relative;
  height: 100%;
  overflow: hidden;
  background: #000;
  filter: var(--media); /* photo filter token, see tokens.css */
  /* 长按快进时不选中文字、不弹系统菜单 */
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
/* top + bottom shade so the overlays stay readable */
.sv::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(180deg, rgba(0, 0, 0, .42) 0%, rgba(0, 0, 0, 0) 22%, rgba(0, 0, 0, 0) 55%, rgba(0, 0, 0, .62) 100%);
  pointer-events: none;
}

/*
 * 底图：有视频文件时只当模糊背景；没有文件时，封面图片加载出来就虚化当背景、上面完整显示封面，
 * 图片加载不出来（离线、被拦）时直接清晰显示生成的占位图。不再用平移动画假装在播放。
 */
/* 整屏的底图不做 filter 过渡（大面积模糊逐帧重算很费）：直接切换，上面的封面图自己会淡入 */
.sv-bg { position: absolute; inset: 0; }
.sv.real .sv-bg,
.sv.still.poster-ok .sv-bg { inset: -10%; filter: blur(18px) brightness(.55); }
.sv-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: transparent; }
.sv-poster { position: absolute; inset: 0; background-color: transparent; }
.sv-poster :deep(img) { object-fit: contain; }

.sv-click { position: absolute; inset: 0; z-index: 2; touch-action: manipulation; }

/*
 * 双击点赞：里层在手指位置回弹放大（随机歪一点），停一下，外层再上浮、略放大、淡出。
 * 外层的动画最后结束，播完由 animationend 移除（减少动态效果时一闪而过，赞按钮本身照样点亮）。
 */
.sv-burst {
  position: absolute;
  z-index: 3;
  width: 88px;
  height: 88px;
  margin: -44px 0 0 -44px;
  color: var(--accent);
  pointer-events: none;
  animation: burst-float var(--dur-4) var(--ease-in) calc(var(--dur-3) + var(--dur-2)) forwards;
}
.sb-in {
  display: block;
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 2px 10px rgba(0, 0, 0, .35));
  transform: rotate(var(--r));
  animation: burst-pop var(--dur-3) var(--ease-out) backwards;
}
.sv-burst svg { width: 100%; height: 100%; fill: currentColor; stroke-width: 1.2; }
@keyframes burst-pop {
  0% { opacity: 0; transform: rotate(var(--r)) scale(.3); }
  55% { opacity: 1; transform: rotate(var(--r)) scale(1.18); }
  100% { opacity: 1; transform: rotate(var(--r)) scale(1); }
}
@keyframes burst-float {
  to { opacity: 0; transform: translateY(-96px) scale(1.25); }
}

/*
 * 缓冲转圈：和播放页播放器的转圈（VideoPlayer .spinner）一样大、一样的样子，放在中间播放键的位置。
 * 等多久在脚本里（STALL_MS），挂上时只管淡入；拖进度条时让开（中间是大号时间）
 */
.sv-buf {
  position: absolute;
  left: 50%;
  top: 52.5%;
  z-index: 3;
  width: 34px;
  height: 34px;
  margin: -17px 0 0 -17px;
  border: 3px solid rgba(255, 255, 255, .25);
  border-top-color: #fff;
  border-radius: 50%;
  /* 一圈很淡的阴影：画面很亮（浅色视频、亮的封面）时也看得清；不偏移，跟着转也看不出来 */
  filter: drop-shadow(0 0 3px rgba(0, 0, 0, .45));
  pointer-events: none;
  animation: rot .8s linear infinite, sv-buf-in var(--dur-2) var(--ease-out);
}
@keyframes sv-buf-in { from { opacity: 0; } }
.sv.scrubbing .sv-buf { opacity: 0; }

/* 长按快进的提示：顶部居中，在「推荐 / 专题」下面 */
.sv-boost {
  position: absolute;
  left: 50%;
  top: 62px;
  z-index: 6;
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
  white-space: nowrap;
  transform: translateX(-50%);
  pointer-events: none;
}
.sv-boost svg { width: 15px; height: 15px; stroke-width: 2.6; }
/* 两个箭头轮流亮起，像在往前流；减少动态效果时停在全亮 */
.sv-boost .chev path { animation: chev calc(var(--dur-4) * 2) var(--ease-in-out) infinite; }
.sv-boost .chev path + path { animation-delay: calc(var(--dur-4) / 2); }
@keyframes chev {
  0%, 100% { opacity: .3; }
  45% { opacity: 1; }
}
/* 从顶部回弹着落下；松手时更快地往上收 */
.boost-enter-active { transition: transform var(--dur-3) var(--ease-spring), opacity var(--dur-2) var(--ease-out); }
.boost-leave-active { transition: transform var(--dur-1) var(--ease-in), opacity var(--dur-1) var(--ease-in); }
.boost-enter-from { opacity: 0; transform: translate(-50%, -14px) scale(.9); }
.boost-leave-to { opacity: 0; transform: translate(-50%, -8px) scale(.96); }

/* 拖进度条时屏幕中间的大号时间 */
.sv-scrub {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  z-index: 6;
  color: rgba(255, 255, 255, .72);
  font-size: 26px;
  font-weight: 600;
  line-height: 36px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 2px 10px rgba(0, 0, 0, .5);
  transform: translateY(-50%);
  pointer-events: none;
}
.sv-scrub b { color: #fff; font-weight: 700; }
/* 开始拖：从略小淡入放大到位；松手：很快淡掉 */
.scrub-enter-active { transition: transform var(--dur-2) var(--ease-out), opacity var(--dur-2) var(--ease-out); }
.scrub-leave-active { transition: transform var(--dur-1) var(--ease-in), opacity var(--dur-1) var(--ease-in); }
.scrub-enter-from,
.scrub-leave-to { opacity: 0; transform: translateY(-50%) scale(.88); }

/* ±10 秒：按钮那一侧的半屏位置冒出「››  +10秒」，箭头往外推一下再淡出 */
.sv-seekfx {
  position: absolute;
  top: 52.5%;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 72px;
  margin: -30px 0 0 -36px;
  color: #fff;
  font-size: 12px;
  font-style: normal;
  font-weight: 600;
  text-shadow: 0 1px 4px rgba(0, 0, 0, .45);
  pointer-events: none;
  animation: seekfx var(--dur-4) var(--ease-out) forwards;
}
.sv-seekfx.l { left: 16%; }
.sv-seekfx.r { left: 84%; }
.sv-seekfx svg { width: 30px; height: 30px; stroke-width: 2.4; filter: drop-shadow(0 1px 4px rgba(0, 0, 0, .4)); animation: seekfx-arrow var(--dur-4) var(--ease-out); }
/* 后退：箭头朝左（镜像），同样往外推 */
.sv-seekfx.l svg { transform: scaleX(-1); animation-name: seekfx-arrow-l; }
@keyframes seekfx {
  0% { opacity: 0; transform: scale(.8); }
  30% { opacity: 1; transform: scale(1); }
  70% { opacity: 1; }
  100% { opacity: 0; transform: scale(1); }
}
@keyframes seekfx-arrow { from { transform: translateX(-8px); } }
@keyframes seekfx-arrow-l { from { transform: scaleX(-1) translateX(-8px); } }

/* centre controls: only visible (and tappable) while paused */
.sv-ctl {
  position: absolute;
  left: 0;
  right: 0;
  top: 52.5%;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 36px;
  transform: translateY(-50%);
  transition: opacity var(--dur-2) var(--ease-out);
  pointer-events: none;
}
.sv.playing .sv-ctl { opacity: 0; }
/*
 * 不在屏幕中间的那几条（还没开始播 / 刚被划走暂停的）不露播放键：滑动途中上下两条都是干净的画面，
 * 不会一条带着播放键滑进来再淡掉、另一条滑走时又亮起一个（换条时 current 和 playing 是同一次更新里变的）
 */
.sv:not(.cur) .sv-ctl { opacity: 0; }
.sv-ctl .pb {
  display: grid;
  place-items: center;
  width: 55px;
  height: 55px;
  border-radius: 50%;
  background: rgba(60, 60, 60, .52);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  transition: transform var(--dur-2) var(--ease-spring);
  pointer-events: auto;
}
.sv-ctl .pb svg { width: 25px; height: 25px; margin-left: 3px; color: #fff; }
.sv-ctl .sk {
  width: 28px;
  height: 28px;
  color: #fff;
  filter: drop-shadow(0 1px 4px rgba(0, 0, 0, .4));
  transition: transform var(--dur-2) var(--ease-spring);
  pointer-events: auto;
}
.sv-ctl .sk svg { width: 100%; height: 100%; }
.sv.playing .sv-ctl > * { pointer-events: none; }
/* 按下立刻缩一下，松开回弹 */
.sv-ctl .pb:active,
.sv-ctl .sk:active { transform: scale(var(--press-scale-sm)); transition-duration: var(--dur-1); transition-timing-function: var(--ease-out); }
/*
 * 用户点出来的切换（自动播放、翻页不带）：
 * 暂停 → 播放键从大到小轻轻落到位，±10 秒从中间往两边让开；继续播 → 播放键先鼓一下再放大淡出。
 */
.sv-ctl.fx-in .pb { animation: pb-in var(--dur-3) var(--ease-out); }
.sv-ctl.fx-in .sk { animation: sk-in var(--dur-3) var(--ease-out); }
.sv-ctl.fx-in .sk.fwd { --sx: -16px; }
.sv-ctl.fx-out .pb { animation: pb-out var(--dur-3) var(--ease-out); }
/*
 * 离场比进场快（约 2/3）：一点下去播放键就让开，不会在已经开始播的画面上鼓着一个大灰圈。
 * 这次离场就是点按的反馈，透明度用 ease-out（下一帧就开始变淡；ease-in 前半段几乎不动，像没点到），和播放页的大播放键一样
 */
.sv.playing .sv-ctl.fx-out { transition: opacity var(--dur-1) var(--ease-out); }
@keyframes pb-in { from { transform: scale(1.35); } }
@keyframes pb-out { 30% { transform: scale(1.1); } to { transform: scale(1.3); } }
@keyframes sk-in { from { transform: translateX(var(--sx, 16px)) scale(.7); } }
/* 点 ±10 秒：箭头顺着方向转一下 */
.sv-ctl .sk.spin svg { animation: sk-spin var(--dur-3) var(--ease-out); }
.sv-ctl .sk.back.spin svg { animation-name: sk-spin-back; }
@keyframes sk-spin { 40% { transform: rotate(40deg) scale(1.08); } }
@keyframes sk-spin-back { 40% { transform: rotate(-40deg) scale(1.08); } }

/* 只有里面的按钮、话题、可展开的标题接收点击，其余空白处点下去还是播放 / 暂停 */
.sv-meta { position: absolute; left: 12px; right: 68px; bottom: 50px; z-index: 4; pointer-events: none; }
/*
 * 换到这一条：左下角的文字整块轻轻升上来；不在屏幕中间的那几条先藏着，滑走时很快淡掉。
 * 只动 .sv-meta 这一层（一个合成层），不逐行错开：换条时主线程本来就忙，逐行动画在低端机上会多出一截卡顿。
 * 第一次打开、换一批、KeepAlive 切回来时 current 没变，不会重播。
 */
.sv:not(.cur) .sv-meta { opacity: 0; transform: translateY(var(--rise)); transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in); }
.sv.cur .sv-meta { transition: opacity var(--dur-3) var(--ease-out), transform var(--dur-3) var(--ease-out); }
.sv-unmute,
.sv-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  width: max-content;
  max-width: 100%;
  height: 30px;
  margin-bottom: 14px;
  padding: 0 13px 0 12px;
  border-radius: 10px;
  background: rgba(22, 22, 22, .84);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: auto;
}
.sv-unmute svg { width: 14px; height: 14px; }
.sv-chip { gap: 2px; padding-right: 8px; }
.sv-chip svg { width: 14px; height: 14px; stroke-width: 2.4; opacity: .8; }
.sv-full { height: 28px; margin: 10px 0 0; background: rgba(255, 255, 255, .16); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.sv-name {
  display: block;
  max-width: 100%;
  margin-bottom: 6px;
  overflow: hidden;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  line-height: 21px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 6px rgba(0, 0, 0, .4);
  pointer-events: auto;
}
.sv-tags {
  display: flex;
  gap: 3px;
  margin: -4px 0 2px -6px;
  overflow: hidden;
  white-space: nowrap;
}
/* 话题字小，按钮上下左右多留一点可点区域 */
.sv-tags button {
  flex: none;
  padding: 4px 6px;
  color: rgba(255, 255, 255, .72);
  font-size: 12px;
  line-height: 18px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, .4);
  pointer-events: auto;
}
.sv-title {
  display: -webkit-box;
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 19.6px;
  text-shadow: 0 1px 6px rgba(0, 0, 0, .4);
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.sv-title.more { cursor: pointer; pointer-events: auto; }
.sv-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
/* 展开全文：最多占到屏幕四成，再长就在框里滚 */
.sv.title-open .sv-title { display: block; max-height: 40vh; overflow-y: auto; overscroll-behavior: contain; }
.sv.title-open::before { background: linear-gradient(180deg, rgba(0, 0, 0, .42) 0%, rgba(0, 0, 0, 0) 22%, rgba(0, 0, 0, .25) 45%, rgba(0, 0, 0, .78) 100%); }

/* 进度条：细线 + 28px 高的透明触控区；拖动时变粗、出现圆点 */
.sv-prog {
  position: absolute;
  left: 11px;
  right: 61px;
  bottom: 14px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 28px;
  color: rgba(255, 255, 255, .88);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.sv-prog .track {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  height: 28px;
  cursor: pointer;
  /*
   * 横着拖是拖进度（开始横拖后这一下就不会再翻页）；从进度条上开始的上下滑照常翻页，
   * 浏览器接管滚动时发 pointercancel，这次不跳进度。用 none 的话从底部往上滑会变成拖进度
   */
  touch-action: pan-y;
}
.sv-prog .track:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
/* 线本身 3px：拖动时用 scaleY 变成 6px（只动 transform，不重新排版）；已播部分是整条白线往左挪出去的那一截 */
.sv-prog .bar {
  position: relative;
  flex: 1;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(255, 255, 255, .4);
  transition: transform var(--dur-2) var(--ease-out);
}
.sv-prog .bar i { position: absolute; inset: 0; border-radius: 2px; background: #fff; }
/* 圆点：外层和线一样宽，按进度平移；里面的圆点按住时回弹着长出来 */
.sv-prog .knob { position: absolute; inset: 0; pointer-events: none; }
.sv-prog .knob b {
  position: absolute;
  left: 0;
  top: 50%;
  width: 13px;
  height: 13px;
  margin: -6.5px 0 0 -6.5px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 6px rgba(0, 0, 0, .35);
  transform: scale(0);
  transition: transform var(--dur-1) var(--ease-in);
}
.sv-prog.drag .bar { transform: scaleY(2); }
.sv-prog.drag .knob b,
.sv-prog .track:focus-visible .knob b { transform: scale(1); transition: transform var(--dur-2) var(--ease-spring); }
/* 封面预览的计时线：更细、更淡，点击穿透到画面 */
.sv-wait { pointer-events: none; }
.sv-wait .bar { height: 2px; background: rgba(255, 255, 255, .22); }
.sv-wait .bar i { background: rgba(255, 255, 255, .6); }

/* 拖进度条时把其他浮层让开，只留进度和中间的时间 */
.sv-side,
.sv.scrubbing .sv-meta { transition: opacity var(--dur-1) var(--ease-out); }
.sv.scrubbing .sv-meta,
.sv.scrubbing .sv-side,
.sv.scrubbing .sv-ctl { opacity: 0; }

.sv-side {
  position: absolute;
  right: 0;
  bottom: 18px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  width: 54px;
}
/* 头像下沿压着「+」：多留 4px，不和下面的赞按钮挤在一起 */
.sv-au { position: relative; margin-bottom: 4px; }
.sv-author { display: block; width: 44px; height: 44px; border-radius: 50%; transition: transform var(--dur-2) var(--ease-spring); }
.sv-author:active { transform: scale(var(--press-scale)); transition: transform var(--dur-1) var(--ease-out); }
.sv-author .av { width: 100%; height: 100%; border: 1.5px solid #fff; border-radius: 50%; }

/* 头像下的「+」：白底黑字的小圆，压在头像下沿 */
.sv-follow {
  position: absolute;
  left: 50%;
  bottom: -9px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-left: -10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .3);
  color: var(--on-accent);
  transition: transform var(--dur-2) var(--ease-spring);
}
/* 只有 20px：可点区域往左右下多扩一些（往上少扩，免得压住头像本身） */
.sv-follow::after { content: ''; position: absolute; inset: -4px -10px -8px; }
.sv-follow:active { transform: scale(var(--press-scale-sm)); transition: transform var(--dur-1) var(--ease-out); }
.sv-follow svg { width: 14px; height: 14px; stroke-width: 2.8; overflow: visible; }
.fl-p { transform-origin: 12px 12px; transition: transform var(--dur-2) var(--ease-in-out), opacity var(--dur-2) var(--ease-in-out); }
.fl-c { stroke-dasharray: 1; stroke-dashoffset: 1; transition: stroke-dashoffset var(--dur-2) var(--ease-in); }
/* 点了：横竖两笔转 90° 缩走，对勾稍后一笔画出来 */
.sv-follow.done .fl-p { opacity: 0; transform: rotate(90deg) scale(.3); }
.sv-follow.done .fl-c { stroke-dashoffset: 0; transition: stroke-dashoffset var(--dur-3) var(--ease-out) var(--dur-1); }
/* 出现：回弹着冒出来；收起：缩没 */
.fl-enter-active { transition: transform var(--dur-2) var(--ease-spring), opacity var(--dur-2) var(--ease-out); }
.fl-leave-active { transition: transform var(--dur-2) var(--ease-in), opacity var(--dur-2) var(--ease-in); }
.fl-enter-from,
.fl-leave-to { opacity: 0; transform: scale(.2); }

/* 按钮占满整列宽（54px），比图标本身好点得多 */
.sv-act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  width: 100%;
  color: #fff;
  font-size: 12px;
  line-height: 17px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, .45);
}
/* 图标外面包一层：按压缩放在外层，状态动画在图标上，两者叠加互不打断 */
.sv-act .ico { position: relative; display: block; width: 27px; height: 27px; transition: transform var(--dur-2) var(--ease-spring); }
.sv-act:active .ico { transform: scale(var(--press-scale-sm)); transition: transform var(--dur-1) var(--ease-out); }
/* 填充用 fill-opacity 过渡（fill 从 none 到颜色没法渐变） */
.sv-act svg { width: 27px; height: 27px; fill: currentColor; fill-opacity: 0; stroke-width: 2.2; transition: fill-opacity var(--dur-1) var(--ease-out); }
.sv-act.on { color: var(--accent); }
.sv-act.on svg { fill-opacity: 1; }
/* 点亮：先缩一下再回弹放大；熄掉：轻轻一缩；分享 / 设置：小弹一下 */
.sv-act svg.fx-on { animation: act-on var(--dur-3) var(--ease-out); }
.sv-act svg.fx-off { animation: act-off var(--dur-2) var(--ease-out); }
.sv-act svg.fx-tap { animation: act-tap var(--dur-3) var(--ease-spring); }
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

/*
 * 手机横过来（高度很矮）：右侧一列收紧、去掉头像（左下角的名字照样进主页），
 * 标题只留一行，整列都在顶栏下面，不再被切掉、不压在静音键上。
 */
@media (orientation: landscape) and (max-height: 500px) {
  .sv-side { bottom: 8px; gap: 4px; }
  .sv-au { display: none; }
  .sv-act { gap: 1px; font-size: 11px; line-height: 14px; }
  .sv-act .ico,
  .sv-act svg { width: 23px; height: 23px; }
  .sv-meta { bottom: 38px; }
  .sv-unmute,
  .sv-chip { height: 28px; margin-bottom: 8px; }
  .sv-full { margin-top: 6px; }
  .sv-name { margin-bottom: 2px; font-size: 14px; }
  .sv-title { -webkit-line-clamp: 1; }
  .sv.title-open .sv-title { max-height: 30vh; }
  .sv-prog { bottom: 6px; }
  .sv-boost { top: 54px; }
}

/* 页面被 KeepAlive 收起 / 刚切回来的两帧里：暂停→继续这一来一回直接到位，不播过渡 */
.sv.quiet,
.sv.quiet * { transition: none !important; }
/* 被 KeepAlive 收起时正在播的那条：父组件暂停了它，但离开的画面上不闪出暂停态的播放键 */
.sv.quiet.held .sv-ctl { opacity: 0 !important; }

/* 减少动态效果：时长已经由 motion.css 统一收敛；循环的箭头、缓冲转圈直接停住，免得只闪一下 */
@media (prefers-reduced-motion: reduce) {
  .sv-boost .chev path,
  .sv-buf { animation: none; }
}

/*
 * ---- 桌面布局（≥ 1024px，参照抖音网页版的推荐流）：每一条是铺满页面的一个圆角大画框 ----
 * 画框的位置、大小由 ShortView 给（.sv-slot 四周留 --sv-gap，圆角 --sv-r，全屏时都是 0），每一条一样大，翻页时整个画框上下滑。
 * 画框分上下两块：底下 --sv-bar 高的一条是常驻的深色控制栏（进度线压在它的上沿），上面整块是画面区。
 * 画面区里画面 contain 居中、不裁切，空出来的地方是模糊压暗的封面（一张图加 filter，不是第二个视频）；
 * 左上角的频道、左下角的文字、右边一列按钮对齐同一组内边距 --sv-in，左下角文字和右边一列的底边都在 --sv-lift（控制栏上面一点）。
 * 这几段放在样式的最后：和上面「手机横过来」那段同名的规则以这里为准。
 */
@media (min-width: 1024px) {
  /* 下面用的简写（ShortView 没给时用默认值）：控制栏高、内边距、文字和右边一列的底边 */
  .sv {
    --bh: var(--sv-bar, 48px);
    --in: var(--sv-in, 20px);
    --lift: var(--sv-lift, 74px);
    border-radius: var(--sv-r, 14px);
    isolation: isolate;
  }
  /* 画面区上下两头各压暗一点：左上角的频道、左下角的文字在亮的画面上也看得清 */
  .sv::before { bottom: var(--bh); background: linear-gradient(180deg, rgba(0, 0, 0, .34) 0, rgba(0, 0, 0, 0) 150px, rgba(0, 0, 0, 0) calc(100% - 240px), rgba(0, 0, 0, .42) 100%); }
  .sv.title-open::before { background: linear-gradient(180deg, rgba(0, 0, 0, .34) 0, rgba(0, 0, 0, 0) 150px, rgba(0, 0, 0, .25) 45%, rgba(0, 0, 0, .78) 100%); }
  /*
   * 底图只铺画面区。当背景时（有视频文件、或封面加载出来了）比画面区大一圈再模糊，模糊的边缘被画框和控制栏挡住；
   * 竖屏视频两边、横屏视频上下空出来的地方就是它。
   * 上面一截再用遮罩压暗一点（往下渐渐变回原样，从外扩的 64px 算起）：和底边那层压暗差不多深，
   * 横屏视频上下空出来的两条深浅一样；只压暗底图，画面本身不受影响
   */
  .sv-bg { bottom: var(--bh); }
  .sv.real .sv-bg,
  .sv.still.poster-ok .sv-bg {
    inset: -64px -64px calc(var(--bh) - 64px);
    filter: blur(40px) brightness(.64);
    -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, .66) 64px, #000 304px);
    mask-image: linear-gradient(180deg, rgba(0, 0, 0, .66) 64px, #000 304px);
  }
  /* <video> 是替换元素：高度要明写（height: auto 时 bottom 不起作用） */
  .sv-video { height: calc(100% - var(--bh)); }
  .sv-poster,
  .sv-click { bottom: var(--bh); }
  .sv-click { cursor: pointer; }

  /* 左上角：父组件放进来的「推荐 / 专题 · 换一批」 */
  .sv-dtop { position: absolute; left: var(--in); top: calc(var(--in) - 6px); z-index: 5; display: flex; align-items: center; }

  /* 画面区的正中（暂停时的播放键、缓冲转圈、跳几秒的箭头、拖进度时的大号时间）；±10 秒在桌面上用 ← → 和进度条，不显示 */
  .sv-ctl,
  .sv-buf,
  .sv-seekfx,
  .sv-scrub { top: calc((100% - var(--bh)) / 2); }
  .sv-ctl .sk { display: none; }
  .sv-ctl .pb { width: 68px; height: 68px; }
  .sv-ctl .pb svg { width: 30px; height: 30px; margin-left: 4px; }
  .sv-buf { width: 44px; height: 44px; margin: -22px 0 0 -22px; }
  .sv-boost { top: calc(var(--in) + 50px); }

  /* 左下角：作者 · 发布时间、标题（两行，点开看全文）、话题、看完整版；不超过画框的一半多一点，不压到右边一列 */
  .sv-meta {
    left: var(--in);
    right: auto;
    bottom: var(--lift);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: min(56%, 720px, calc(100% - 2 * var(--in) - 104px));
  }
  .sv-unmute,
  .sv-chip { height: 32px; padding: 0 14px 0 12px; border-radius: 16px; font-size: 13px; }
  .sv-chip { padding-right: 10px; }
  .sv-unmute,
  .sv-nosrc { order: 0; margin-bottom: 14px; }
  .sv-unmute svg { width: 15px; height: 15px; }
  .sv-who { order: 1; display: flex; align-items: baseline; gap: 8px; max-width: 100%; margin-bottom: 6px; }
  .sv-name { flex: 0 1 auto; min-width: 0; margin: 0; font-size: 18px; line-height: 25px; }
  .sv-ago { flex: none; color: rgba(255, 255, 255, .72); font-size: 13px; line-height: 18px; white-space: nowrap; text-shadow: 0 1px 4px rgba(0, 0, 0, .4); }
  .sv-title { order: 2; max-width: 100%; font-size: 15px; line-height: 22px; }
  /*
   * 话题一行超出就截掉（overflow: hidden）：四周留 4px 内边距（外边距相应往回收，位置不变），
   * 键盘焦点的框（外扩 2px、2px 粗）整圈都在里面，不被切成一条竖线
   */
  .sv-tags { order: 3; max-width: calc(100% + 4px); margin: 2px 0 -4px -9px; padding: 4px; gap: 4px; }
  .sv-tags button { padding: 2px 5px; border-radius: 6px; color: rgba(255, 255, 255, .8); font-size: 14px; line-height: 20px; }
  .sv-full { order: 4; height: 30px; margin: 12px 0 0; }
  .sv.title-open .sv-title { max-height: 36vh; }

  /*
   * 右边一列（画面区里贴着右边，底边和左下角的文字齐平）：头像 + 关注、赞、不喜欢、收藏、分享、设置。
   * 列宽就是头像宽：头像右边正好在内边距 --sv-in 上，图标居中在它下面
   */
  .sv-side { right: var(--in); bottom: var(--lift); width: 48px; gap: 10px; }
  .sv-au { margin-bottom: 8px; }
  .sv-author { width: 48px; height: 48px; }
  .sv-act { gap: 1px; font-size: 13px; font-weight: 500; line-height: 18px; text-shadow: 0 1px 4px rgba(0, 0, 0, .5); }
  .sv-act .ico {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    transition: transform var(--dur-2) var(--ease-spring), background-color var(--dur-2) var(--ease-out);
  }
  .sv-act svg { width: 33px; height: 33px; stroke-width: 1.8; filter: drop-shadow(0 1px 3px rgba(0, 0, 0, .35)); }

  /*
   * 进度条：控制栏上沿横贯整个画框的一条细线（和抖音一样从左边一直到右边），可点的范围是线上下各 8px。
   * 鼠标移上去变粗、出圆点和那一点的时间，按住拖动跳过去。封面预览的计时线（.sv-wait）也在这个位置，只是更淡、不能拖
   */
  .sv-prog { left: 0; right: 0; bottom: calc(var(--bh) - 8px); z-index: 6; gap: 0; height: 16px; font-size: 12px; }
  .sv-prog > span { display: none; }
  .sv-prog .track { height: 16px; }
  .sv-prog .bar { height: 2px; border-radius: 0; background: rgba(255, 255, 255, .22); }
  .sv-prog .bar i { border-radius: 0; }
  .sv-prog .bar .hov { position: absolute; inset: 0; background: rgba(255, 255, 255, .3); opacity: 0; transition: opacity var(--dur-1) var(--ease-out); }
  .sv-prog .bar .hov.on { opacity: 1; }
  .sv-prog .tip {
    position: absolute;
    left: 0;
    bottom: 50%;
    margin-bottom: 6px;
    opacity: 0;
    transition: opacity var(--dur-1) var(--ease-out);
    pointer-events: none;
  }
  .sv-prog .tip.on { opacity: 1; }
  .sv-prog .tip b {
    display: block;
    padding: 0 8px;
    border-radius: 6px;
    background: rgba(18, 18, 18, .9);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    line-height: 20px;
    font-variant-numeric: tabular-nums;
    transform: translateX(-50%);
  }
  .sv-wait .bar { height: 2px; background: rgba(255, 255, 255, .14); }
  .sv-wait .bar i { background: rgba(255, 255, 255, .5); }

  /*
   * 控制栏：画框最底下单独一条（深色实底，不压在画面上，一直在）。图标按钮 36px（图标 22px），
   * 两头让出按钮的内边距，让看得见的图标边（播放三角、全屏的角）落在内边距 --sv-in 上：左边让 13px，右边让 10px
   */
  .sv-bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 4px;
    height: var(--bh);
    padding: 0 calc(var(--in) - 10px) 0 calc(var(--in) - 13px);
    background: #000;
    color: #fff;
    /* 倍速菜单、音量条从按钮上沿往上弹多高：越过进度条的可点范围再留 8px，不压在进度线上 */
    --b-pop: calc((var(--bh) - 36px) / 2 + 16px);
  }
  .b-btn {
    position: relative;
    display: grid;
    place-items: center;
    min-width: 36px;
    height: 36px;
    border-radius: 8px;
    color: #fff;
  }
  .b-btn svg { width: 22px; height: 22px; transition: transform var(--dur-2) var(--ease-spring); }
  .b-btn:active svg { transform: scale(var(--press-scale-sm)); transition-duration: var(--dur-1); transition-timing-function: var(--ease-out); }
  .b-time { margin-left: 6px; color: rgba(255, 255, 255, .92); font-size: 13px; line-height: 18px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .b-time i { margin: 0 5px; color: rgba(255, 255, 255, .45); font-style: normal; }
  .b-sp { flex: 1; }
  .b-txt { padding: 0 9px; font-size: 14px; font-weight: 600; }

  /* 连播：小开关 + 文字（开着是白底黑点） */
  .b-auto { display: flex; align-items: center; gap: 7px; height: 36px; padding: 0 9px; border-radius: 8px; color: #fff; font-size: 14px; font-weight: 600; }
  .b-sw { position: relative; flex: none; width: 28px; height: 16px; border-radius: 8px; background: rgba(255, 255, 255, .26); transition: background-color var(--dur-2) var(--ease-out); }
  .b-sw::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    transition: transform var(--dur-spring-snappy) var(--spring-snappy), background-color var(--dur-2) var(--ease-out);
  }
  .b-auto.on .b-sw { background: var(--accent); }
  .b-auto.on .b-sw::after { background: var(--on-accent); transform: translateX(12px); }

  /* 倍速：点开从按钮上方弹出一列（快的在上面），当前的那一项亮着 */
  .b-speed { position: relative; }
  .b-menu {
    position: absolute;
    left: 50%;
    bottom: calc(100% + var(--b-pop));
    display: flex;
    flex-direction: column;
    width: 88px;
    margin-left: -44px;
    padding: 6px;
    border-radius: 12px;
    background: rgba(24, 24, 24, .96);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .08), 0 12px 32px rgba(0, 0, 0, .5);
    transform-origin: 50% 100%;
  }
  .b-menu button { height: 34px; border-radius: 8px; color: var(--t2); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .b-menu button.on { background: rgba(255, 255, 255, .1); color: #fff; }
  .b-menu-enter-active { transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-spring-snappy) var(--spring-snappy); }
  .b-menu-leave-active { transition: opacity var(--dur-1) var(--ease-in), transform var(--dur-1) var(--ease-in); }
  .b-menu-enter-from { opacity: 0; transform: translate3d(0, 6px, 0) scale(.96); }
  .b-menu-leave-to { opacity: 0; transform: scale(.98); }

  /* 音量：喇叭上方竖着的一条（上面是百分比），鼠标移到喇叭上出现，移开稍等一下再收（往上挪的路上不会闪没） */
  .b-volw { position: relative; }
  .b-vpop {
    position: absolute;
    left: 50%;
    bottom: calc(100% + var(--b-pop));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    width: 40px;
    margin-left: -20px;
    padding: 10px 0 16px;
    border-radius: 12px;
    background: rgba(24, 24, 24, .96);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .08), 0 12px 32px rgba(0, 0, 0, .5);
    cursor: pointer;
    touch-action: none;
    opacity: 0;
    transform: translate3d(0, 6px, 0);
    pointer-events: none;
    transition: opacity var(--dur-2) var(--ease-in) var(--dur-2), transform var(--dur-2) var(--ease-in) var(--dur-2);
  }
  /* 喇叭和音量条之间的空隙也算在里面（鼠标往上挪的路上不会断） */
  .b-vpop::after { content: ''; position: absolute; left: 0; right: 0; top: 100%; height: var(--b-pop); }
  .b-volw.on .b-vpop { opacity: 1; transform: none; pointer-events: auto; transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out); }
  .vn { color: #fff; font-size: 12px; font-weight: 600; line-height: 16px; font-variant-numeric: tabular-nums; }
  .vt { position: relative; width: 4px; height: 84px; border-radius: 2px; background: rgba(255, 255, 255, .28); }
  .vt i { position: absolute; inset: 0; border-radius: 2px; background: #fff; transform-origin: 50% 100%; }
  .vk { position: absolute; inset: 0; pointer-events: none; }
  .vk b { position: absolute; left: 50%; bottom: 0; width: 12px; height: 12px; margin: 0 0 -6px -6px; border-radius: 50%; background: #fff; box-shadow: 0 0 4px rgba(0, 0, 0, .4); }
}
/* 窗口比较矮（右边一列放不下）：收小一号 */
@media (min-width: 1024px) and (max-height: 700px) {
  .sv-side { gap: 6px; }
  .sv-author { width: 42px; height: 42px; }
  .sv-act .ico { width: 40px; height: 40px; }
  .sv-act svg { width: 29px; height: 29px; }
}
/* 很高的窗口（画框 1100px 以上，如 2560×1440）：框里的字、按钮都大一号，不让手机尺寸的小字飘在大画框里 */
@media (min-width: 1024px) and (min-height: 1200px) {
  .sv-unmute,
  .sv-chip { height: 36px; padding: 0 16px 0 14px; border-radius: 18px; font-size: 14px; }
  .sv-chip { padding-right: 12px; }
  .sv-unmute svg { width: 17px; height: 17px; }
  .sv-full { height: 34px; }
  .sv-name { font-size: 21px; line-height: 29px; }
  .sv-ago { font-size: 15px; line-height: 20px; }
  .sv-title { font-size: 17px; line-height: 26px; }
  .sv-tags button { font-size: 16px; line-height: 22px; }
  .sv-ctl .pb { width: 80px; height: 80px; }
  .sv-ctl .pb svg { width: 34px; height: 34px; }
  .sv-side { width: 56px; gap: 14px; }
  .sv-author { width: 56px; height: 56px; }
  .sv-act { font-size: 14px; line-height: 20px; }
  .sv-act .ico { width: 52px; height: 52px; }
  .sv-act svg { width: 38px; height: 38px; }
  .sv-bar { --b-pop: calc((var(--bh) - 40px) / 2 + 16px); }
  .b-btn { min-width: 40px; height: 40px; }
  .b-btn svg { width: 24px; height: 24px; }
  .b-time,
  .b-txt,
  .b-auto { font-size: 15px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .sv-act:hover .ico { background: rgba(255, 255, 255, .12); }
  .sv-author { transition: transform var(--dur-2) var(--ease-spring); }
  .sv-author:hover { transform: scale(1.04); }
  .sv-name:hover { text-decoration: underline; text-underline-offset: 3px; }
  .sv-tags button { transition: color var(--dur-2) var(--ease-out); }
  .sv-tags button:hover { color: #fff; }
  .sv-unmute,
  .sv-chip { transition: background-color var(--dur-2) var(--ease-out); }
  .sv-unmute:hover,
  .sv-nosrc:hover { background: rgba(48, 48, 48, .9); }
  .sv-full:hover { background: rgba(255, 255, 255, .26); }
  .sv-ctl .pb:hover { background: rgba(84, 84, 84, .6); }
  /* 鼠标移到进度条上：线变粗（和拖动时一样粗）、露出圆点 */
  .sv-prog .track:hover .bar { transform: scaleY(2); }
  .sv-prog .track:hover .knob b { transform: scale(1); transition: transform var(--dur-2) var(--ease-spring); }
  .b-btn,
  .b-auto { transition: background-color var(--dur-2) var(--ease-out); }
  .b-btn:hover,
  .b-auto:hover { background: rgba(255, 255, 255, .1); }
  .b-menu button { transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out); }
  .b-menu button:not(.on):hover { background: rgba(255, 255, 255, .08); color: #fff; }
  .b-volw:hover .b-vpop { opacity: 1; transform: none; pointer-events: auto; transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out); }
}
/* 只有触屏的大屏（平板横过来）：没有悬停，音量条出不来，整个不要（音量用系统按键，喇叭照样能点） */
@media (min-width: 1024px) and (hover: none) {
  .b-vpop { display: none; }
}
/* :focus-visible 单独写（老 Safari 不认，会让同一条规则里的其他选择器一起失效） */
@media (min-width: 1024px) {
  .b-vpop:focus-visible { opacity: 1; transform: none; pointer-events: auto; outline: 2px solid var(--accent); outline-offset: 2px; transition: none; }
  /* 进度条从画框左边一直到右边：焦点框往里画，不被画框两边切掉 */
  .sv-prog .track:focus-visible { outline-offset: -2px; border-radius: 0; }
}
</style>
