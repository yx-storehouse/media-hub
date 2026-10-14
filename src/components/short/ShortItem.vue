<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { share } from '@/composables/useShare'
import { setResume } from '@/components/video/resume'
import { rememberVideo } from '@/components/video/preview'
import { cssDuration, haptic } from '@/utils/motion'
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
  following: { type: Boolean, default: null }
})
const emit = defineEmits(['toggle', 'dbllike', 'seek', 'boost', 'unmute', 'settings', 'like', 'dislike', 'fav', 'follow', 'time', 'duration', 'state', 'ended', 'failed'])

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
    await v.play()
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
})

/*
 * 页面被 KeepAlive 收起时父组件会先暂停全部；这里再兜一层，保证不会在后台继续出声。
 * 还没播完的动效一并撤掉：收起时动画被打断，再挂回来时浏览器会从头重播一遍。
 */
onDeactivated(() => {
  endPress()
  clearTimeout(tapTimer)
  tapTimer = 0
  videoEl.value?.pause()
  clearFx()
  quiet.value = true
})
/*
 * 收起时父组件把每条都暂停了，回来又接着播：这一来一回不该让播放键淡入淡出一遍。
 * 收起时先关掉过渡（.quiet），回来两帧以后再打开。
 */
const quiet = ref(false)
let quietRaf = 0
onActivated(() => {
  cancelAnimationFrame(quietRaf)
  quietRaf = requestAnimationFrame(() => {
    quietRaf = requestAnimationFrame(() => { quiet.value = false })
  })
})
/* 卸载时释放地址，否则离开后还可能在后台下载 */
onBeforeUnmount(() => {
  endPress()
  clearTimeout(tapTimer)
  clearTimeout(followTimer)
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
}
const onTime = e => emit('time', e.target.currentTime)
/*
 * 原生播放 / 暂停报给父组件。元素被移出文档时（文件打不开退回封面、页面被 KeepAlive 收起、卸载）
 * 浏览器会自动补发一次 pause，那不是用户或播放进度造成的，不能拿来改父组件的状态。
 */
const onPlayState = e => {
  if (e.target.isConnected && e.target === videoEl.value) emit('state', e.type === 'play')
}
function onError() {
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
function scrubKey(e) {
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

function pressStart(e) {
  if (!e.isPrimary || e.button !== 0) return
  downAt = e.timeStamp
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
  // 长按（任何位置）后松手：不是点击
  if (downAt && e.timeStamp - downAt > HOLD_MS) return
  const rect = e.currentTarget.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const prev = lastTap
  lastTap = { at: e.timeStamp, x, y }
  if (prev && e.timeStamp - prev.at < TAP_MS && Math.hypot(x - prev.x, y - prev.y) < DOUBLE_SLOP) {
    // 双击（连点时每一下都算）：撤销还没执行的单击，点赞
    clearTimeout(tapTimer)
    tapTimer = 0
    burst(x, y)
    emit('dbllike')
    return
  }
  clearTimeout(tapTimer)
  tapTimer = setTimeout(() => {
    tapTimer = 0
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

/** { dir: -1 | 1, key }：key 递增让连点时从头再播 */
const seekFx = ref(null)
let seekFxSeq = 0
function seekBy(delta) {
  seekFx.value = { dir: Math.sign(delta), key: ++seekFxSeq }
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
</script>

<template>
  <section
    class="sv"
    :class="{ playing, cur: current, quiet, real: hasVideo, still: !hasVideo, 'poster-ok': posterOk, scrubbing, boosting, 'title-open': titleOpen }"
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
      @ended="emit('ended')"
      @error="onError"
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
      <span>{{ seekFx.dir < 0 ? '-' : '+' }}10秒</span>
    </i>

    <div class="sv-ctl" :class="ctlFx && `fx-${ctlFx}`">
      <button v-if="hasVideo" class="sk back" :class="{ spin: seekFx?.dir < 0 }" type="button" aria-label="后退10秒" @click="seekBy(-10)">
        <Icon :key="seekFx?.dir < 0 ? seekFx.key : 0" name="replay" />
      </button>
      <button class="pb" type="button" :aria-label="playing ? '暂停' : '播放'" @click="userToggle" @animationend.self="ctlFx = ''"><Icon name="play" /></button>
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
      <button v-if="creator" class="sv-name" type="button" @click="openCreator">@{{ creator.name }}</button>
      <div v-if="tags.length" class="sv-tags">
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
      <button v-if="showFull" class="sv-chip sv-full" type="button" @click="openDetail">看完整版<Icon name="chevR" /></button>
    </div>

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
        @keydown="scrubKey"
      >
        <!-- 线（拖动时用 scaleY 变粗）和圆点（按住时回弹长出来）分开：圆点不跟着线一起被压扁 -->
        <div class="bar"><i :style="{ transform: `translateX(${pct - 100}%)` }" /></div>
        <span class="knob" :style="{ transform: `translateX(${pct}%)` }"><b /></span>
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
.sv.playing .sv-ctl.fx-out { transition: opacity var(--dur-3) var(--ease-in); }
@keyframes pb-in { from { transform: scale(1.35); } }
@keyframes pb-out { 30% { transform: scale(1.12); } to { transform: scale(1.5); } }
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

/* 减少动态效果：时长已经由 motion.css 统一收敛；循环的箭头直接停住，免得只闪一下 */
@media (prefers-reduced-motion: reduce) {
  .sv-boost .chev path { animation: none; }
}
</style>
