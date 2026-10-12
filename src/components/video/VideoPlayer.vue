<script>
/*
 * 「下一个」时如果正在全屏，新的播放器挂上后接着全屏（旧播放器卸载时浏览器会退出全屏）。
 * 只认 10 秒内的标记，免得过一会儿打开别的视频时莫名其妙进了全屏。
 */
let carryFullscreenAt = 0
</script>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useAppStore } from '@/stores/app'
import { toast } from '@/composables/useToast'
import { useBackDismiss } from '@/composables/useBackDismiss'
import { formatClock } from '@/utils/format'
import Icon from '@/components/Icon.vue'
import Cover from '@/components/Cover.vue'
import BottomSheet from '@/components/BottomSheet.vue'

/*
 * 播放页的播放器。
 * - video.src 有地址：用原生 <video> 播放（内网素材文件放好、数据库填了 playback_url 就会走这条）。
 * - video.src 为空：如实显示封面和「暂无视频源」，不假装在播（没有进度条、播放键、全屏这些控件），
 *   也不算播放、不记观看记录；「看相似推荐」让播放页滚到相似推荐。
 * - 播完：显示「重播 / 下一个」；开着自动连播时 5 秒倒计时后自动播下一个（可取消）。
 * - 手机横过来、正在播放时自动全屏，竖回去退出；浏览器不支持元素全屏时用页面内的「伪全屏」铺满屏幕。
 * 倍速、循环、自动连播是全局播放偏好（stores/app.js 的 playback，记在本机），与短视频页共用；
 * 倍速不是 1.0x 时控制栏上直接显示。started / progress 事件都带上自己的视频 id，父组件换视频时不会记错。
 */
const props = defineProps({
  /** VideoDetail：{ id, src, cover, len, quality } */
  video: { type: Object, required: true },
  autoplay: { type: Boolean, default: true },
  /** 从第几秒开始（断点续播） */
  start: { type: Number, default: 0 },
  /** 播完后的下一个：{ video: { id, title, cover }, hint }，没有为 null */
  next: { type: Object, default: null }
})
const emit = defineEmits({
  back: null,
  /** (id) 第一次真正开始播放（只有有片源的视频才会有） */
  started: null,
  /**
   * ({ id, sec, len, reason }) 看到第几秒：
   * reason 'tick' 播放中每隔几秒一次，'hide' 切到后台 / 关闭页面，'leave' 播放器卸载
   */
  progress: null,
  /** ({ auto }) 播下一个：auto 为 true 是倒计时到了 */
  next: null,
  /** 没有片源时点了「看相似推荐」 */
  related: null
})

const SPEEDS = ['0.5x', '0.75x', '1.0x', '1.25x', '1.5x', '2.0x']
const QUALITY = { sd: '标清', hd: '高清', fhd: '超清' }
/** 播完后自动播下一个前的倒计时（秒） */
const AUTO_NEXT_SEC = 5
/** 播放中每隔这么多秒往本机记一次进度 */
const TICK_SEC = 5

const store = useAppStore()
const box = ref(null)
const el = ref(null)
const seekEl = ref(null)

const hasSource = computed(() => !!props.video.src)
const playing = ref(false)
const duration = ref(props.video.len || 0)
const current = ref(Math.min(props.start, duration.value || props.start))
const muted = ref(false)
const waiting = ref(false)
const failed = ref(false)
/** 真全屏（Fullscreen API）/ 伪全屏（CSS 铺满屏幕，iOS 等不支持元素全屏时用） */
const fullscreen = ref(false)
const pseudoFs = ref(false)
const isFs = computed(() => fullscreen.value || pseudoFs.value)
const uiVisible = ref(true)
const sheetOpen = ref(false)
/** 播完了：显示「重播 / 下一个」 */
const ended = ref(false)
/** 自动播下一个的倒计时（秒），0 = 没在倒计时 */
const countdown = ref(0)
/** 「已从 x:xx 继续播放」提示 */
const resumeTip = ref(0)
const rate = computed(() => parseFloat(store.playback.speed) || 1)
const loop = computed(() => store.playback.loop)
/** 倍速不是 1.0x 时显示在设置按钮旁边，免得忘了自己调过 */
const rateLabel = computed(() => (store.playback.speed !== '1.0x' ? store.playback.speed : ''))
const qualityLabel = computed(() => QUALITY[props.video.quality] || '')
const progress = computed(() => (duration.value ? `${(current.value / duration.value) * 100}%` : '0%'))
const canPip = typeof document !== 'undefined' && (!!document.pictureInPictureEnabled ||
  (typeof HTMLVideoElement !== 'undefined' && 'webkitSetPresentationMode' in HTMLVideoElement.prototype))

/* 伪全屏和弹层一样跟随返回键：按返回先退出伪全屏 */
useBackDismiss(pseudoFs)

/* ---------- 播放 / 暂停 ---------- */

let started = false

function markStarted() {
  if (started) return
  started = true
  emit('started', props.video.id)
}

async function play() {
  const v = el.value
  if (!hasSource.value || !v) return
  clearEnd()
  if (duration.value && current.value >= duration.value) seekTo(0)
  // 上次加载失败：重新拉一次源（再失败会再次触发 onError 提示）
  if (v.error) {
    failed.value = false
    v.load()
  }
  v.playbackRate = rate.value
  try {
    await v.play()
    markStarted()
  } catch (e) {
    // 浏览器不允许有声自动播放：退成静音播放，并告诉用户怎么开声音
    if (e && e.name === 'NotAllowedError' && !v.muted) {
      muted.value = true
      v.muted = true
      try {
        await v.play()
        markStarted()
        toast('已静音播放，点右下角喇叭开启声音')
      } catch { /* 仍然被拦截：保持暂停，等用户点播放 */ }
    }
  }
}

const pause = () => el.value?.pause()
const toggle = () => (playing.value ? pause() : play())

function seekTo(t) {
  t = Math.max(0, Math.min(duration.value || 0, t))
  current.value = t
  if (el.value) el.value.currentTime = t
}

/* ---------- 播完：重播 / 下一个 ---------- */

let cdTimer = 0
/** 用户点了「取消」：这次播完不再自动播 */
let cdCancelled = false

function onEnded() {
  if (loop.value) {
    seekTo(0)
    play()
    return
  }
  playing.value = false
  uiVisible.value = true
  ended.value = true
  cdCancelled = false
  maybeCountdown()
}
function maybeCountdown() {
  if (!ended.value || countdown.value || cdCancelled || !props.next || !store.playback.autoNext) return
  countdown.value = AUTO_NEXT_SEC
  cdTimer = setInterval(() => {
    // 切到后台、开着设置面板时先停住，回来接着数
    if (document.hidden || sheetOpen.value) return
    if (--countdown.value <= 0) goNext(true)
  }, 1000)
}
function stopCountdown() {
  clearInterval(cdTimer)
  cdTimer = 0
  countdown.value = 0
}
function cancelCountdown() {
  cdCancelled = true
  stopCountdown()
}
function clearEnd() {
  stopCountdown()
  ended.value = false
}
function replay() {
  clearEnd()
  seekTo(0)
  play()
}
function goNext(auto = false) {
  stopCountdown()
  if (!props.next) return
  if (isFs.value) carryFullscreenAt = Date.now()
  emit('next', { auto })
}
/* 相似推荐比视频晚到，或者用户换了一批：播完的画面上跟着更新，必要时开始倒计时 */
watch(() => props.next, maybeCountdown)

/* ---------- 原生 <video> 事件（从事件对象取元素：卸载过程中模板 ref 可能已经清空） ---------- */

let startApplied = false
function onMeta(e) {
  const d = e.target.duration
  if (Number.isFinite(d) && d > 0) duration.value = d
  if (!startApplied && props.start > 0 && e.type === 'loadedmetadata') {
    startApplied = true
    const at = Math.min(props.start, duration.value)
    e.target.currentTime = at
    showResumeTip(at)
  }
}
let lastTick = 0
function onTime(e) {
  if (dragging) return
  current.value = e.target.currentTime
  if (playing.value && Math.abs(current.value - lastTick) >= TICK_SEC) {
    lastTick = current.value
    report('tick')
  }
}
function onPlay() {
  playing.value = true
  clearEnd()
}
function onError(e) {
  waiting.value = false
  playing.value = false
  failed.value = true
  // 给用户看的只说结果；具体原因（地址、错误码）写到控制台，方便管理员排查
  const err = e.target.error
  console.warn('[player] 视频加载失败', props.video.src, err ? `code=${err.code} ${err.message || ''}` : '')
  toast('视频暂时无法播放，请稍后再试')
}

watch(rate, r => { if (el.value) el.value.playbackRate = r })

/* ---------- 续播提示 ---------- */

let tipTimer = 0
function showResumeTip(sec) {
  if (sec < 1) return
  resumeTip.value = sec
  clearTimeout(tipTimer)
  tipTimer = setTimeout(() => { resumeTip.value = 0 }, 5000)
}
function restart() {
  resumeTip.value = 0
  seekTo(0)
  if (!playing.value) play()
}

/* ---------- 进度上报（父组件记本机 / 服务端） ---------- */

function report(reason) {
  // 没真正播起来（没片源、自动播放被拦着没点）就不记：免得没看过的视频跑进观看记录
  if (!hasSource.value || !started) return
  emit('progress', { id: props.video.id, sec: current.value, len: duration.value, reason })
}

/* ---------- 控制栏自动隐藏 ---------- */

let hideTimer = 0
/* 键盘焦点在播放器里时不自动收起，否则 Tab 过去的按钮是看不见的 */
const keyboardInside = () => !!box.value?.querySelector(':focus-visible')
function showUi() {
  uiVisible.value = true
  clearTimeout(hideTimer)
  if (playing.value) hideTimer = setTimeout(() => { if (!keyboardInside()) uiVisible.value = false }, 3000)
}
watch(playing, showUi)
/* 点画面：控制栏显示时收起，隐藏时唤出（播放 / 暂停用中间和左下角的按钮） */
function onSurfaceTap() {
  if (!hasSource.value) return
  if (uiVisible.value && playing.value) {
    clearTimeout(hideTimer)
    uiVisible.value = false
  } else showUi()
}
function onFocusIn(e) {
  if (e.target.matches(':focus-visible')) showUi()
}

/* ---------- 进度条：拖动 + 键盘（可点区域比看到的线高，见 .seek::before） ---------- */

let dragging = false
function ratioAt(e) {
  const r = seekEl.value.getBoundingClientRect()
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
}
function startSeek(e) {
  if (!duration.value) return
  dragging = true
  seekEl.value.setPointerCapture(e.pointerId)
  current.value = ratioAt(e) * duration.value
  clearTimeout(hideTimer)
}
function moveSeek(e) {
  if (dragging) current.value = ratioAt(e) * duration.value
}
function endSeek(e) {
  if (!dragging) return
  dragging = false
  seekTo(ratioAt(e) * duration.value)
  showUi()
}
function onSeekKey(e) {
  const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 30, PageDown: -30 }[e.key]
  let t
  if (step != null) t = current.value + step
  else if (e.key === 'Home') t = 0
  else if (e.key === 'End') t = duration.value
  else return
  e.preventDefault()
  seekTo(t)
  showUi()
}

/* ---------- 设置 / 循环 / 静音 ---------- */

function openSettings() {
  // 真全屏时底部弹层不在全屏元素里看不到，直接轮换倍速（按钮上显示当前倍速）
  if (fullscreen.value) {
    const next = SPEEDS[(SPEEDS.indexOf(store.playback.speed) + 1) % SPEEDS.length]
    setSpeed(next)
    return
  }
  sheetOpen.value = true
}
function setSpeed(s) {
  store.playback.speed = s
  toast(`已切换为 ${s} 倍速`)
  sheetOpen.value = false
}
function toggleLoop() {
  store.playback.loop = !store.playback.loop
  toast(store.playback.loop ? '已开启循环播放' : '已关闭循环播放')
}
function toggleAutoNext() {
  store.playback.autoNext = !store.playback.autoNext
  if (store.playback.autoNext) {
    cdCancelled = false
    maybeCountdown()
  } else stopCountdown()
}
function toggleMute() {
  muted.value = !muted.value
  if (el.value) el.value.muted = muted.value
}

/* ---------- 小窗 ---------- */

async function togglePip() {
  const v = el.value
  if (!v) return
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture()
    else if (document.pictureInPictureEnabled && v.requestPictureInPicture) await v.requestPictureInPicture()
    else if (v.webkitSetPresentationMode) {
      v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture')
    } else toast('当前视频不支持小窗播放')
  } catch {
    toast('小窗播放启动失败')
  }
}

/* ---------- 全屏 ---------- */

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null
const isLandscape = () => {
  const type = screen.orientation?.type
  if (type) return type.startsWith('landscape')
  if (typeof window.orientation === 'number') return Math.abs(window.orientation) === 90
  return window.matchMedia('(orientation: landscape)').matches
}

/* 横屏视频全屏时把屏幕转成横的；竖的视频、不支持锁定（iOS、桌面）就算了 */
function lockLandscape() {
  const v = el.value
  if (v && v.videoWidth && v.videoWidth < v.videoHeight) return
  screen.orientation?.lock?.('landscape').catch(() => {})
}

/**
 * 进入全屏。必须同步调用 requestFullscreen：转屏事件和点击给的「允许全屏」只在当下有效。
 * lock：按钮进入时锁成横屏；转屏进入时不锁，否则竖回来时检测不到，没法自动退出。
 * native：用户点了按钮时，iOS 可以退而用 <video> 自己的全屏。
 * 都不行（或者被浏览器拒绝）就用伪全屏。
 */
function enterFullscreen({ lock = false, native = false } = {}) {
  const target = box.value
  if (!target) return
  const req = target.requestFullscreen || target.webkitRequestFullscreen
  if (req) {
    let p
    try {
      p = req.call(target)
    } catch (e) {
      p = Promise.reject(e)
    }
    Promise.resolve(p).then(() => { if (lock) lockLandscape() }, () => { pseudoFs.value = true })
    return
  }
  if (native && el.value?.webkitEnterFullscreen) {
    try {
      el.value.webkitEnterFullscreen() // iOS Safari 只支持 <video> 自己全屏
      return
    } catch { /* 退成伪全屏 */ }
  }
  pseudoFs.value = true
}
function exitFullscreen() {
  if (fsElement() === box.value) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)
  pseudoFs.value = false
}
function toggleFullscreen() {
  if (isFs.value) exitFullscreen()
  else enterFullscreen({ lock: true, native: true })
}
function onFullscreenChange() {
  fullscreen.value = fsElement() === box.value
  if (!fullscreen.value) screen.orientation?.unlock?.()
}

/* 手机横过来、正在播放（有片源）：自动全屏；竖回去：退出全屏 */
function onOrientation() {
  if (isLandscape()) {
    if (hasSource.value && playing.value && !isFs.value && !document.hidden && !sheetOpen.value) enterFullscreen()
  } else if (isFs.value) exitFullscreen()
}

/* ---------- 切后台 / 关页面：上报进度 ---------- */

function onVisibility() {
  if (document.hidden) report('hide')
}
const onPageHide = () => report('hide')

const orientationTarget = typeof screen !== 'undefined' && screen.orientation?.addEventListener ? screen.orientation : null

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  if (orientationTarget) orientationTarget.addEventListener('change', onOrientation)
  else window.addEventListener('orientationchange', onOrientation)
  const carry = Date.now() - carryFullscreenAt < 10000
  carryFullscreenAt = 0
  if (!hasSource.value) return
  if (carry) enterFullscreen()
  if (props.autoplay) play()
})

onBeforeUnmount(() => {
  report('leave')
  stopCountdown()
  clearTimeout(hideTimer)
  clearTimeout(tipTimer)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pagehide', onPageHide)
  if (orientationTarget) orientationTarget.removeEventListener('change', onOrientation)
  else window.removeEventListener('orientationchange', onOrientation)
  if (fsElement() === box.value) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)
    screen.orientation?.unlock?.()
  }
  // 真正停掉原生视频：退出小窗、暂停、释放地址，否则离开页面后还会在后台播放 / 下载
  const v = el.value
  if (v) {
    if (document.pictureInPictureElement === v) document.exitPictureInPicture().catch(() => {})
    v.pause()
    v.removeAttribute('src')
    v.load()
  }
})
</script>

<template>
  <div
    ref="box"
    class="player"
    :class="{ 'ui-on': uiVisible || !playing, fs: isFs, pseudo: pseudoFs, nosrc: !hasSource, ended }"
    @click="onSurfaceTap"
    @focusin="onFocusIn"
  >
    <video
      v-if="hasSource"
      ref="el"
      class="media"
      :src="video.src"
      :poster="video.cover?.src || undefined"
      playsinline
      webkit-playsinline
      preload="metadata"
      :muted="muted"
      :loop="loop"
      @loadedmetadata="onMeta"
      @durationchange="onMeta"
      @timeupdate="onTime"
      @loadeddata="failed = false"
      @play="onPlay"
      @pause="playing = false"
      @ended="onEnded"
      @waiting="waiting = true"
      @playing="waiting = false"
      @error="onError"
    />
    <Cover v-else class="media poster" v-bind="video.cover" eager />

    <div class="shade" />

    <div class="top">
      <button type="button" class="back hit-44" aria-label="返回" @click.stop="emit('back')"><Icon name="chevL" /></button>
      <span v-if="qualityLabel && hasSource" class="badge">{{ qualityLabel }}</span>
    </div>

    <!-- 没有片源：如实说明，不显示播放控件 -->
    <div v-if="!hasSource" class="nosrc-msg" role="status">
      <b>暂无视频源</b>
      <span>这个视频还没有上传片源<template v-if="video.len > 0"> · 时长 {{ formatClock(video.len) }}</template></span>
      <button type="button" class="ns-btn" @click.stop="emit('related')">看相似推荐</button>
    </div>

    <template v-else>
      <button v-show="!playing && !ended" type="button" class="big-play" :aria-label="failed ? '重新加载' : '播放'" @click.stop="play">
        <Icon :name="failed ? 'refresh' : 'play'" :class="{ retry: failed }" />
      </button>
      <span v-if="failed && !playing" class="fail-tip" role="status">视频暂时无法播放，点击重试</span>
      <div v-if="waiting && playing" class="spinner" aria-hidden="true" />

      <!-- 续播提示：从上次的位置接着播，可以一键从头 -->
      <div v-if="resumeTip && !ended" class="resume" role="status" @click.stop>
        <span>已从 {{ formatClock(resumeTip) }} 继续播放</span>
        <button type="button" @click="restart">从头播放</button>
      </div>

      <!-- 播完：重播 / 下一个（自动连播时倒计时，可取消） -->
      <div v-if="ended" class="end" @click.stop>
        <template v-if="next">
          <div class="end-hd" role="status">
            <template v-if="countdown">{{ countdown }} 秒后播放下一个</template>
            <template v-else>下一个</template>
            <span v-if="next.hint" class="hint">· {{ next.hint }}</span>
          </div>
          <button type="button" class="end-next" :aria-label="`播放下一个：${next.video.title}`" @click="goNext(false)">
            <Cover class="end-cv" v-bind="next.video.cover || {}" />
            <span class="end-tt">{{ next.video.title }}</span>
          </button>
          <div class="end-btns">
            <button type="button" @click="replay"><Icon name="refresh" />重播</button>
            <button v-if="countdown" type="button" @click="cancelCountdown">取消</button>
            <button v-else type="button" class="pri" @click="goNext(false)"><Icon name="play" />播放下一个</button>
          </div>
        </template>
        <button v-else type="button" class="end-replay" @click="replay"><Icon name="refresh" /><span>重播</span></button>
      </div>

      <!-- 控制栏隐藏时，底部留一条细进度线 -->
      <div class="mini" aria-hidden="true"><i :style="{ width: progress }" /></div>

      <div class="bar" @click.stop>
        <div
          ref="seekEl"
          class="seek"
          role="slider"
          tabindex="0"
          aria-label="播放进度"
          aria-valuemin="0"
          :aria-valuemax="Math.round(duration)"
          :aria-valuenow="Math.round(current)"
          :aria-valuetext="`${formatClock(current)} / ${formatClock(duration)}`"
          :aria-disabled="!duration || undefined"
          @pointerdown="startSeek"
          @pointermove="moveSeek"
          @pointerup="endSeek"
          @pointercancel="endSeek"
          @keydown="onSeekKey"
        >
          <div class="track"><i :style="{ width: progress }" /></div>
          <b class="knob" :style="{ left: progress }" />
        </div>
        <div class="ctl">
          <button type="button" :aria-label="playing ? '暂停' : '播放'" @click="toggle"><Icon :name="playing ? 'pause' : 'play'" /></button>
          <span class="time">{{ formatClock(current) }} / {{ formatClock(duration) }}</span>
          <span class="sp" />
          <button
            type="button"
            class="set"
            :aria-label="fullscreen ? `倍速 ${store.playback.speed}，点击切换` : rateLabel ? `播放设置，当前 ${rateLabel} 倍速` : '播放设置'"
            @click="openSettings"
          >
            <Icon v-if="!fullscreen" name="cog" />
            <span v-if="fullscreen || rateLabel" class="rate">{{ fullscreen ? store.playback.speed : rateLabel }}</span>
          </button>
          <!-- 竖屏时循环在「播放设置」里；全屏时设置面板打不开，放到控制栏上 -->
          <button v-if="isFs" type="button" class="loop" :class="{ on: loop }" :aria-pressed="loop" aria-label="循环播放" @click="toggleLoop"><Icon name="loop" /></button>
          <button type="button" :aria-label="muted ? '打开声音' : '静音'" @click="toggleMute"><Icon :name="muted ? 'mute' : 'vol'" /></button>
          <button v-if="canPip" type="button" aria-label="小窗播放" @click="togglePip"><Icon name="pip" /></button>
          <button type="button" :aria-label="isFs ? '退出全屏' : '全屏'" @click="toggleFullscreen"><Icon :name="isFs ? 'fullscreenExit' : 'fullscreen'" /></button>
        </div>
      </div>
    </template>

    <BottomSheet v-model:open="sheetOpen" title="播放设置">
      <div class="opts speeds">
        <button
          v-for="s in SPEEDS"
          :key="s"
          type="button"
          class="opt"
          :class="{ on: store.playback.speed === s }"
          :aria-pressed="store.playback.speed === s"
          @click="setSpeed(s)"
        >
          {{ s }}
        </button>
      </div>
      <div class="row2">
        <span>循环播放</span>
        <button type="button" class="sw" :class="{ on: loop }" role="switch" :aria-checked="loop" aria-label="循环播放" @click="toggleLoop" />
      </div>
      <div class="row2">
        <span>自动连播<small>播完 5 秒后播放下一个</small></span>
        <button
          type="button"
          class="sw"
          :class="{ on: store.playback.autoNext }"
          role="switch"
          :aria-checked="store.playback.autoNext"
          aria-label="自动连播"
          @click="toggleAutoNext"
        />
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.player {
  position: relative;
  flex: none;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: #000;
  user-select: none;
  -webkit-user-select: none;
}
.player.fs { width: 100vw; height: 100vh; aspect-ratio: auto; }
/* 伪全屏：铺满整个屏幕（跳出 480 宽的应用栏），在页面之上、底部弹层和提示之下 */
.player.pseudo { position: fixed; inset: 0; z-index: 50; width: auto; height: auto; }
.media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; filter: var(--media); }

/* 上下渐暗，只在控制栏显示时出现 */
.shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, .5) 0%, rgba(0, 0, 0, 0) 30%, rgba(0, 0, 0, 0) 60%, rgba(0, 0, 0, .65) 100%);
  opacity: 0;
  transition: opacity .25s;
  pointer-events: none;
}
.top, .bar { opacity: 0; pointer-events: none; transition: opacity .25s; }
.ui-on .shade, .ui-on .top, .ui-on .bar { opacity: 1; }
.ui-on .top, .ui-on .bar { pointer-events: auto; }
/* 播完时由结束画面接管，控制栏收起 */
.ended .bar, .ended .mini { display: none; }

.top { position: absolute; left: 0; right: 0; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; padding: 6px 12px 0 6px; }
.back { position: relative; display: grid; place-items: center; width: 40px; height: 40px; color: #fff; }
.back svg { width: 24px; height: 24px; stroke-width: 2.6; filter: drop-shadow(0 1px 3px rgba(0, 0, 0, .5)); }
.badge {
  height: 24px;
  padding: 0 11px;
  border: 1px solid rgba(255, 255, 255, .32);
  border-radius: 12px;
  background: rgba(0, 0, 0, .32);
  color: #fff;
  font-size: 12px;
  line-height: 22px;
}

/* 全屏时避开刘海 / 圆角 */
.fs .top { padding-right: max(12px, env(safe-area-inset-right)); padding-left: max(6px, env(safe-area-inset-left)); padding-top: max(6px, env(safe-area-inset-top)); }
.fs .bar { padding: 0 max(6px, env(safe-area-inset-right)) max(2px, env(safe-area-inset-bottom)) max(6px, env(safe-area-inset-left)); }

/* ---------- 没有片源 ---------- */
.nosrc .shade { opacity: 1; background: rgba(0, 0, 0, .52); }
.nosrc-msg {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 40px 24px 0;
  color: #fff;
  text-align: center;
  pointer-events: none;
}
.nosrc-msg b { font-size: 16px; font-weight: 700; line-height: 22px; text-shadow: 0 1px 4px rgba(0, 0, 0, .6); }
.nosrc-msg span { color: rgba(255, 255, 255, .78); font-size: 12px; line-height: 17px; text-shadow: 0 1px 3px rgba(0, 0, 0, .6); }
.ns-btn {
  position: relative;
  height: 32px;
  margin-top: 6px;
  padding: 0 16px;
  border-radius: 16px;
  background: rgba(255, 255, 255, .92);
  color: #0a0a0a;
  font-size: 13px;
  font-weight: 600;
  pointer-events: auto;
}
.ns-btn::after { content: ''; position: absolute; inset: -6px -4px; }

.big-play {
  position: absolute;
  left: 50%;
  top: 50%;
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  margin: -27px 0 0 -27px;
  border-radius: 50%;
  background: rgba(30, 30, 30, .55);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #fff;
}
.big-play svg { width: 24px; height: 24px; margin-left: 3px; }
.big-play svg.retry { margin-left: 0; stroke-width: 2.4; }
.fail-tip {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(50% + 34px);
  color: rgba(255, 255, 255, .85);
  font-size: 12px;
  text-align: center;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .6);
  pointer-events: none;
}

.spinner {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 34px;
  height: 34px;
  margin: -17px 0 0 -17px;
  border: 3px solid rgba(255, 255, 255, .25);
  border-top-color: #fff;
  border-radius: 50%;
  animation: rot .8s linear infinite;
}

/* ---------- 续播提示 ---------- */
.resume {
  position: absolute;
  left: 10px;
  bottom: 62px;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 4px 0 12px;
  border-radius: 15px;
  background: rgba(20, 20, 20, .82);
  color: #fff;
  font-size: 12px;
  animation: fi .25s ease;
}
.resume button { position: relative; height: 24px; padding: 0 10px; border-radius: 12px; background: rgba(255, 255, 255, .16); font-weight: 600; }
.resume button::after { content: ''; position: absolute; inset: -6px -4px; }
.player:not(.ui-on) .resume { bottom: 12px; }

/* ---------- 结束画面 ---------- */
.end {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 16px 8px;
  background: rgba(0, 0, 0, .74);
  color: #fff;
}
.end-hd { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.end-hd .hint { margin-left: 4px; color: rgba(255, 255, 255, .6); font-weight: 400; }
.end-next {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(100%, 300px);
  padding: 5px;
  border-radius: 9px;
  background: rgba(255, 255, 255, .1);
  text-align: left;
}
.end-cv { flex: none; width: 80px; aspect-ratio: 16 / 9; border-radius: 6px; filter: var(--media); }
.end-tt {
  display: -webkit-box;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 18px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.end-btns { display: flex; gap: 10px; margin-top: 2px; }
.end-btns button {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 14px;
  border-radius: 16px;
  background: rgba(255, 255, 255, .14);
  font-size: 13px;
  font-weight: 600;
}
.end-btns button.pri { background: #fff; color: #0a0a0a; }
.end-btns svg { width: 15px; height: 15px; stroke-width: 2.4; }
.end-replay { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.end-replay svg { box-sizing: content-box; width: 24px; height: 24px; padding: 13px; border-radius: 50%; background: rgba(255, 255, 255, .14); stroke-width: 2.2; }
.fs .end-cv { width: 128px; }
.fs .end-next { width: min(100%, 420px); }
.fs .end-tt { font-size: 15px; line-height: 21px; }

.mini { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(255, 255, 255, .2); transition: opacity .25s; }
.mini i { position: absolute; left: 0; top: 0; bottom: 0; background: #fff; }
.ui-on .mini { opacity: 0; }

.bar { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 6px 2px; }
.seek { position: relative; display: flex; align-items: center; height: 18px; margin: 0 10px; border-radius: 4px; cursor: pointer; touch-action: none; }
/* 线条只有 3px，手指按的区域放大到 32px 高（往上多一些，不压住下面的按钮） */
.seek::before { content: ''; position: absolute; left: -10px; right: -10px; top: -10px; bottom: -4px; }
.seek:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.seek[aria-disabled] { cursor: default; }
.track { position: relative; flex: 1; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .3); }
.track i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: #fff; }
.knob { position: absolute; top: 50%; width: 11px; height: 11px; margin: -5.5px 0 0 -5.5px; border-radius: 50%; background: #fff; box-shadow: 0 0 4px rgba(0, 0, 0, .4); }
.ctl { display: flex; align-items: center; height: 38px; }
.ctl button { display: grid; place-items: center; width: 38px; height: 38px; color: #fff; }
.ctl svg { width: 21px; height: 21px; stroke-width: 2; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .4)); }
.ctl .set { display: flex; gap: 3px; justify-content: center; width: auto; min-width: 38px; padding: 0 7px; }
.ctl .loop:not(.on) { opacity: .5; }
.rate { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px rgba(0, 0, 0, .5); }
.time { margin-left: 2px; color: #fff; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sp { flex: 1; }
.speeds { margin-bottom: 12px; }
.row2 small { display: block; margin-top: 2px; color: var(--t2); font-size: 12px; }
</style>
