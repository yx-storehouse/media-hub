<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useAppStore } from '@/stores/app'
import { toast, toastState } from '@/composables/useToast'
import { formatClock } from '@/utils/format'
import Icon from '@/components/Icon.vue'
import Cover from '@/components/Cover.vue'
import BottomSheet from '@/components/BottomSheet.vue'

/*
 * 播放页的播放器。
 * - video.src 有地址：用原生 <video> 播放（内网素材文件放好、数据库填了 playback_url 就会走这条）。
 * - video.src 为空：显示封面，用计时器模拟进度，控件照常可用（演示数据阶段）。
 * 倍速、循环是全局播放偏好（stores/app.js 的 playback），与短视频页共用。
 * started / leave 事件都带上自己的视频 id，父组件换视频时不会记错。
 */
const props = defineProps({
  /** VideoDetail：{ id, src, cover, len, quality } */
  video: { type: Object, required: true },
  autoplay: { type: Boolean, default: true },
  /** 从第几秒开始（断点续播） */
  start: { type: Number, default: 0 }
})
const emit = defineEmits({
  back: null,
  /** (id) 第一次真正开始播放 */
  started: null,
  /** ({ id, sec, len }) 播放器卸载：看到第几秒 */
  leave: null
})

const SPEEDS = ['0.5x', '0.75x', '1.0x', '1.25x', '1.5x', '2.0x']
const QUALITY = { sd: '标清', hd: '高清', fhd: '超清' }

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
const fullscreen = ref(false)
const uiVisible = ref(true)
const sheetOpen = ref(false)
const rate = computed(() => parseFloat(store.playback.speed) || 1)
const loop = computed(() => store.playback.loop)
const qualityLabel = computed(() => QUALITY[props.video.quality] || '')
const progress = computed(() => (duration.value ? `${(current.value / duration.value) * 100}%` : '0%'))

/* ---------- 播放 / 暂停 ---------- */

let clock = 0
let started = false

function startClock() {
  clearInterval(clock)
  clock = setInterval(() => {
    current.value = Math.min(duration.value, current.value + 0.25 * rate.value)
    if (current.value >= duration.value) onEnded()
  }, 250)
}
function stopClock() {
  clearInterval(clock)
  clock = 0
}

function markStarted() {
  if (started) return
  started = true
  emit('started', props.video.id)
}

async function play() {
  if (duration.value && current.value >= duration.value) seekTo(0)
  if (!hasSource.value) {
    playing.value = true
    startClock()
    markStarted()
    return
  }
  const v = el.value
  if (!v) return
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

function pause() {
  if (hasSource.value) el.value?.pause()
  else {
    playing.value = false
    stopClock()
  }
}

const toggle = () => (playing.value ? pause() : play())

function seekTo(t) {
  t = Math.max(0, Math.min(duration.value || 0, t))
  current.value = t
  if (hasSource.value && el.value) el.value.currentTime = t
}

function onEnded() {
  if (loop.value) {
    seekTo(0)
    play()
    return
  }
  pause()
  playing.value = false
  uiVisible.value = true
}

/* ---------- 原生 <video> 事件（从事件对象取元素：卸载过程中模板 ref 可能已经清空） ---------- */

let startApplied = false
function onMeta(e) {
  const d = e.target.duration
  if (Number.isFinite(d) && d > 0) duration.value = d
  if (!startApplied && props.start > 0 && e.type === 'loadedmetadata') {
    startApplied = true
    e.target.currentTime = Math.min(props.start, duration.value)
  }
}
const onTime = e => { if (!dragging) current.value = e.target.currentTime }
function onError() {
  waiting.value = false
  playing.value = false
  failed.value = true
  toast('视频加载失败，请检查素材地址')
}

watch(rate, r => { if (el.value) el.value.playbackRate = r })

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
  if (uiVisible.value && playing.value) {
    clearTimeout(hideTimer)
    uiVisible.value = false
  } else showUi()
}
function onFocusIn(e) {
  if (e.target.matches(':focus-visible')) showUi()
}

/* ---------- 进度条：拖动 + 键盘 ---------- */

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
  // 全屏时底部弹层不在全屏元素里看不到，直接轮换倍速（按钮上显示当前倍速）
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
function toggleMute() {
  muted.value = !muted.value
  if (el.value) el.value.muted = muted.value
}

/* ---------- 小窗 / 全屏 ---------- */

async function togglePip() {
  const v = el.value
  if (!v || !document.pictureInPictureEnabled) return toast('当前视频不支持小窗播放')
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture()
    else await v.requestPictureInPicture()
  } catch {
    toast('小窗播放启动失败')
  }
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null
}
async function toggleFullscreen() {
  if (fsElement()) {
    ;(document.exitFullscreen || document.webkitExitFullscreen)?.call(document)
    return
  }
  const target = box.value
  if (target.requestFullscreen) {
    try {
      await target.requestFullscreen()
      // 手机上顺便转成横屏；不支持就算了
      await screen.orientation?.lock?.('landscape').catch(() => {})
    } catch {
      toast('当前环境不支持全屏')
    }
  } else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen()
  else if (el.value?.webkitEnterFullscreen) el.value.webkitEnterFullscreen() // iOS Safari 只支持 <video> 自己全屏
  else toast('当前环境不支持全屏')
}
function onFullscreenChange() {
  fullscreen.value = fsElement() === box.value
  if (!fullscreen.value) screen.orientation?.unlock?.()
}

/* 切到后台时暂停模拟进度（原生视频由浏览器自己处理） */
function onVisibility() {
  if (document.hidden && !hasSource.value && playing.value) pause()
}

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)
  document.addEventListener('visibilitychange', onVisibility)
  if (props.autoplay) play()
})

onBeforeUnmount(() => {
  emit('leave', { id: props.video.id, sec: current.value, len: duration.value })
  stopClock()
  clearTimeout(hideTimer)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
  document.removeEventListener('visibilitychange', onVisibility)
  if (fsElement() === box.value) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)
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
    :class="{ 'ui-on': uiVisible || !playing, fs: fullscreen }"
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
      @play="playing = true"
      @pause="playing = false"
      @ended="onEnded"
      @waiting="waiting = true"
      @playing="waiting = false"
      @error="onError"
    />
    <Cover v-else class="media" v-bind="video.cover" eager />

    <div class="shade" />

    <div class="top">
      <button type="button" class="back" aria-label="返回" @click.stop="emit('back')"><Icon name="chevL" /></button>
      <span v-if="qualityLabel" class="badge">{{ qualityLabel }}</span>
    </div>

    <button v-show="!playing" type="button" class="big-play" :aria-label="failed ? '重新加载' : '播放'" @click.stop="play">
      <Icon :name="failed ? 'refresh' : 'play'" :class="{ retry: failed }" />
    </button>
    <div v-if="waiting && playing" class="spinner" aria-hidden="true" />

    <!-- 全局提示在全屏元素之外看不见，全屏时在播放器里再显示一份 -->
    <div v-if="fullscreen && toastState.visible" class="fs-toast" role="status">{{ toastState.text }}</div>

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
        <button type="button" :aria-label="fullscreen ? `倍速 ${store.playback.speed}，点击切换` : '播放设置'" @click="openSettings">
          <span v-if="fullscreen" class="rate">{{ store.playback.speed }}</span>
          <Icon v-else name="cog" />
        </button>
        <button type="button" class="loop" :class="{ on: loop }" :aria-pressed="loop" aria-label="循环播放" @click="toggleLoop"><Icon name="loop" /></button>
        <button type="button" :aria-label="muted ? '打开声音' : '静音'" @click="toggleMute"><Icon :name="muted ? 'mute' : 'vol'" /></button>
        <button type="button" aria-label="小窗播放" @click="togglePip"><Icon name="pip" /></button>
        <button type="button" :aria-label="fullscreen ? '退出全屏' : '全屏'" @click="toggleFullscreen"><Icon :name="fullscreen ? 'fullscreenExit' : 'fullscreen'" /></button>
      </div>
    </div>

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

.top { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; justify-content: space-between; padding: 6px 12px 0 6px; }
.back { display: grid; place-items: center; width: 40px; height: 40px; color: #fff; }
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

.fs-toast {
  position: absolute;
  left: 50%;
  bottom: 70px;
  max-width: 70%;
  padding: 8px 16px;
  border-radius: 10px;
  background: rgba(38, 38, 38, .94);
  color: #fff;
  font-size: 13px;
  text-align: center;
  transform: translateX(-50%);
  pointer-events: none;
}

.mini { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(255, 255, 255, .2); transition: opacity .25s; }
.mini i { position: absolute; left: 0; top: 0; bottom: 0; background: #fff; }
.ui-on .mini { opacity: 0; }

.bar { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 6px 2px; }
.seek { position: relative; display: flex; align-items: center; height: 18px; margin: 0 10px; border-radius: 4px; cursor: pointer; touch-action: none; }
.seek:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.seek[aria-disabled] { cursor: default; }
.track { position: relative; flex: 1; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .3); }
.track i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: #fff; }
.knob { position: absolute; top: 50%; width: 11px; height: 11px; margin: -5.5px 0 0 -5.5px; border-radius: 50%; background: #fff; box-shadow: 0 0 4px rgba(0, 0, 0, .4); }
.ctl { display: flex; align-items: center; height: 38px; }
.ctl button { display: grid; place-items: center; width: 38px; height: 38px; color: #fff; }
.ctl svg { width: 21px; height: 21px; stroke-width: 2; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .4)); }
.ctl .loop:not(.on) { opacity: .5; }
.rate { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.time { margin-left: 2px; color: #fff; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sp { flex: 1; }
.speeds { margin-bottom: 12px; }
</style>
