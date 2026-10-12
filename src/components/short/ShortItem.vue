<script setup>
import { computed, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { share } from '@/composables/useShare'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

/*
 * One full-screen clip of the short-video feed.
 * Playback (time / playing) is owned by the feed; this component renders it and reports intents:
 *   toggle   tap on the clip or the play button
 *   seek     new position in seconds (±10 s buttons; progress bar: tap, or drag and release)
 *   boost    true / false：按住左右两侧边缘 2 倍速播放，松手恢复（模拟进度由父组件按 2 倍推进）
 *   unmute   "点击恢复声音" pill
 *   settings 设置 action
 *
 * clip.src 有值（后台给视频配了素材文件）时用原生 <video> 播放，并把实际情况报给父组件：
 *   time     播放到第几秒（timeupdate）
 *   duration 文件的真实时长（读到有限值才报）
 *   state    原生播放 / 暂停（播完、被浏览器拦下自动播放时，父组件据此更新按钮）
 *   ended    播完（循环播放时 <video loop> 自己从头来，不会触发）
 *   failed   文件打不开：父组件把这条退回封面 + 模拟进度
 * clip.src 为空时保持原来的做法：封面慢慢平移，进度由父组件的计时器推进。
 */
const props = defineProps({
  /** Short: { id, tags, title, len, cover, src, likes, favs, liked, faved, creator: { id, name, handle, avatar } | null } */
  clip: { type: Object, required: true },
  liked: Boolean,
  faved: Boolean,
  /** 当前点赞 / 收藏数（父组件维护，含本地已点的那一次） */
  likes: { type: Number, default: 0 },
  favs: { type: Number, default: 0 },
  /** playback position in seconds */
  time: { type: Number, default: 0 },
  /** 时长（秒）：父组件给的（读到文件真实时长后会替换），缺省用 clip.len */
  len: { type: Number, default: 0 },
  playing: Boolean,
  /** load the background photo immediately (clips on or next to the screen) */
  eager: Boolean,
  /** 在当前这条附近：真实视频提前加载，离得远的不加载 */
  near: Boolean
})
const emit = defineEmits(['toggle', 'seek', 'boost', 'unmute', 'settings', 'like', 'dislike', 'fav', 'time', 'duration', 'state', 'ended', 'failed'])

const store = useAppStore()
const router = useRouter()

/** 长按快进：按住多久生效、手指移动超过多少就不算长按、两侧边缘各占宽度的比例、倍速 */
const PRESS_MS = 350
const PRESS_SLOP = 10
const EDGE = 0.22
const BOOST_RATE = 2
/** 进度条上按方向键一次跳几秒 */
const KEY_STEP = 5

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
    // 文件打不开由 onError 处理（父组件会退回模拟播放）；元素已被换掉时这个结果也没用了，都不再上报
    if (v.error || v !== videoEl.value) return
    // 浏览器不让有声自动播放：退成静音再播，左下角会出现「点击恢复声音」
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
  sync()
})
watch(hasVideo, on => { if (on) sync() }, { flush: 'post' })
watch(rate, r => { if (videoEl.value) videoEl.value.playbackRate = r })
onMounted(sync)
/* 页面被 KeepAlive 收起时父组件会先暂停全部；这里再兜一层，保证不会在后台继续出声 */
onDeactivated(() => {
  endPress()
  videoEl.value?.pause()
})
/* 卸载时释放地址，否则离开后还可能在后台下载 */
onBeforeUnmount(() => {
  endPress()
  const v = videoEl.value
  if (!v) return
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
 * 原生播放 / 暂停报给父组件。元素被移出文档时（文件打不开退回模拟播放、页面被 KeepAlive 收起、卸载）
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

/* ---------- 进度条：点一下跳过去；按住拖动时只预览，松手才跳 ---------- */

/** id：正在拖的指针（null = 没在拖）；t：预览到的秒数；moved：真的横着拖过（显示大号时间） */
const drag = reactive({ id: null, t: 0, x: 0, y: 0, moved: false })
const dragging = computed(() => drag.id !== null)
const scrubbing = computed(() => dragging.value && drag.moved)
const shownTime = computed(() => (dragging.value ? drag.t : props.time))
const progress = computed(() => `${length.value ? Math.min(100, (shownTime.value / length.value) * 100) : 0}%`)

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

/* ---------- 长按左右两侧边缘：按住 2 倍速，松手恢复；点一下照旧是播放 / 暂停 ---------- */

/** 当前这次按压：{ id, x, y, timer }，不在边缘按下时为 null */
let press = null
/** 快进结束后浏览器可能补发一次 click，不能当成「点一下暂停」 */
let swallowClick = false

function pressStart(e) {
  if (!e.isPrimary || e.button !== 0) return
  swallowClick = false
  endPress()
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
function onTap() {
  if (swallowClick) {
    swallowClick = false
    return
  }
  emit('toggle')
}
/* 快进时手指上下动也不翻页 */
function holdScroll(e) {
  if (boosting.value && e.cancelable) e.preventDefault()
}

/* ---------- 作者：头像 / 名字进创作者主页 ---------- */

const creator = computed(() => props.clip.creator || null)
function openCreator() {
  if (creator.value?.id == null) return
  router.push(`/creator/${encodeURIComponent(creator.value.id)}`)
}

/*
 * 互动状态由父组件（ShortView）持有并传下来，这里只负责显示和上报意图：
 *   liked / faved      来自后端互动表
 *   disliked           纯本地开关
 *   likes / favs       当前计数
 */
const flag = kind => `${kind}:short:${props.clip.id}`
const disliked = computed(() => store.has(flag('dislike')))

const pad = n => String(n).padStart(2, '0')
const mmss = sec => {
  const s = Math.floor(sec)
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

function seekBy(delta) {
  seekTo(props.time + delta)
}

/*
 * A tapped action's icon plays the shared `pop` keyframes once. Each action pops independently;
 * bumping its icon key remounts the <svg>, which restarts the animation on rapid repeated taps.
 * The class is dropped on animationend so a kept-alive page does not replay it when re-attached.
 */
const popKeys = reactive({})
const popping = reactive(new Set())
function pop(id) {
  popKeys[id] = (popKeys[id] || 0) + 1
  popping.add(id)
}

/* 互动都交给父组件去落库；这里只让图标动一下 */
function like() { pop('like'); emit('like') }
function dislike() {
  pop('dislike')
  if (!disliked.value && props.liked) emit('like')   // 点「不喜欢」时顺手取消点赞
  emit('dislike')
}
function fav() { pop('fav'); emit('fav') }

/* `on` is only set for toggles (it also drives aria-pressed); `aria` names the count-only buttons */
const actions = computed(() => [
    { id: 'like', icon: 'thumbUp', label: props.likes, aria: `点赞 ${props.likes}`, on: props.liked, run: like },
    { id: 'dislike', icon: 'thumbDown', label: '不喜欢', on: disliked.value, run: dislike },
    { id: 'fav', icon: 'heart', label: props.favs, aria: `收藏 ${props.favs}`, on: props.faved, run: fav },
    { id: 'share', icon: 'shareNodes', label: '分享', run: () => share({ title: props.clip.title }) },
    { id: 'settings', icon: 'gear', label: '设置', run: () => emit('settings') }
])

</script>

<template>
  <section class="sv" :class="{ playing, real: hasVideo, scrubbing, boosting }" @contextmenu.prevent>
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
      disablepictureinpicture
      @loadedmetadata="onMeta"
      @durationchange="onMeta"
      @timeupdate="onTime"
      @play="onPlayState"
      @pause="onPlayState"
      @ended="emit('ended')"
      @error="onError"
    />
    <!-- 点一下播放 / 暂停；按住左右两侧边缘 2 倍速 -->
    <div
      class="sv-click"
      @click="onTap"
      @pointerdown="pressStart"
      @pointermove="pressMove"
      @pointerup="pressUp"
      @pointercancel="pressCancel"
      @touchmove="holdScroll"
    />

    <div v-show="boosting" class="sv-boost" role="status"><Icon name="ffwd" />2X 快进中</div>
    <div v-show="scrubbing" class="sv-scrub" aria-hidden="true"><b>{{ mmss(drag.t) }}</b> / {{ mmss(length) }}</div>

    <div class="sv-ctl">
      <button class="sk" type="button" aria-label="后退10秒" @click="seekBy(-10)"><Icon name="replay" /></button>
      <button class="pb" type="button" :aria-label="playing ? '暂停' : '播放'" @click="emit('toggle')"><Icon name="play" /></button>
      <button class="sk" type="button" aria-label="前进10秒" @click="seekBy(10)"><Icon name="forward" /></button>
    </div>

    <!-- 左下角一列：恢复声音、作者、标签、标题（按内容高度往上排，标题两行时也不会叠在一起） -->
    <div class="sv-meta">
      <button v-show="store.muted" class="sv-unmute" type="button" @click="emit('unmute')">
        <Icon name="mute" />点击恢复声音
      </button>
      <button v-if="creator" class="sv-name" type="button" @click="openCreator">@{{ creator.name }}</button>
      <div class="sv-tags"><span v-for="tag in clip.tags" :key="tag">{{ tag }}</span></div>
      <div class="sv-title">{{ clip.title }}</div>
    </div>

    <div class="sv-prog" :class="{ drag: dragging }">
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
        <div class="bar"><i :style="{ width: progress }" /><b :style="{ left: progress }" /></div>
      </div>
      <span>{{ mmss(length) }}</span>
    </div>

    <div class="sv-side">
      <button v-if="creator" class="sv-author" type="button" :aria-label="`${creator.name} 的主页`" @click="openCreator">
        <Cover class="av" v-bind="creator.avatar" />
      </button>
      <button
        v-for="a in actions"
        :key="a.id"
        class="sv-act"
        :class="{ on: a.on, pop: popping.has(a.id) }"
        type="button"
        :aria-label="a.aria"
        :aria-pressed="a.on"
        @click="a.run"
        @animationend="popping.delete(a.id)"
      >
        <Icon :key="popKeys[a.id] || 0" :name="a.icon" />
        <span>{{ a.label }}</span>
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
}

/* slow Ken Burns pan stands in for the video; it only moves while playing */
.sv-bg {
  position: absolute;
  inset: -6%;
  filter: blur(1.5px);
  animation: kb 16s ease-in-out infinite alternate;
  animation-play-state: paused;
}
.sv.playing .sv-bg { animation-play-state: running; }
/* 真实视频：封面只当模糊底图，不再平移 */
.sv.real .sv-bg { inset: -10%; filter: blur(18px) brightness(.55); animation: none; }
.sv-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: transparent; }
@keyframes kb {
  from { transform: scale(1.05) translate(0, 0); }
  to { transform: scale(1.22) translate(-2.5%, -2%); }
}

.sv-click { position: absolute; inset: 0; z-index: 2; }

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
.sv-boost svg { width: 15px; height: 15px; stroke-width: 2.6; animation: ff .8s ease-in-out infinite; }
@keyframes ff {
  0%, 100% { opacity: .45; transform: translateX(-1px); }
  50% { opacity: 1; transform: translateX(1px); }
}

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
  transition: opacity .2s;
  pointer-events: none;
}
.sv.playing .sv-ctl { opacity: 0; }
.sv-ctl .pb {
  display: grid;
  place-items: center;
  width: 55px;
  height: 55px;
  border-radius: 50%;
  background: rgba(60, 60, 60, .52);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  pointer-events: auto;
}
.sv-ctl .pb svg { width: 25px; height: 25px; margin-left: 3px; color: #fff; }
.sv-ctl .sk {
  width: 28px;
  height: 28px;
  color: #fff;
  filter: drop-shadow(0 1px 4px rgba(0, 0, 0, .4));
  pointer-events: auto;
}
.sv-ctl .sk svg { width: 100%; height: 100%; }
.sv.playing .sv-ctl > * { pointer-events: none; }

.sv-meta { position: absolute; left: 12px; right: 68px; bottom: 50px; z-index: 4; pointer-events: none; }
.sv-unmute {
  display: flex;
  align-items: center;
  gap: 8px;
  width: max-content;
  height: 30px;
  margin-bottom: 14px;
  padding: 0 13px 0 12px;
  border-radius: 10px;
  background: rgba(22, 22, 22, .84);
  color: #fff;
  font-size: 12px;
  pointer-events: auto;
}
.sv-unmute svg { width: 14px; height: 14px; }
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
  gap: 9px;
  margin-bottom: 6px;
  overflow: hidden;
  color: rgba(255, 255, 255, .72);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
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
.sv-prog .bar {
  position: relative;
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, .4);
  transition: height .15s;
}
.sv-prog .bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: #fff; }
.sv-prog .bar b {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  margin: -6.5px 0 0 -6.5px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 6px rgba(0, 0, 0, .35);
  transform: scale(0);
  transition: transform .15s;
}
.sv-prog.drag .bar { height: 6px; border-radius: 3px; }
.sv-prog.drag .bar b,
.sv-prog .track:focus-visible .bar b { transform: scale(1); }

/* 拖进度条时把其他浮层让开，只留进度和中间的时间 */
.sv-meta,
.sv-side,
.sv-ctl { transition: opacity .15s; }
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
.sv-author { display: block; width: 44px; height: 44px; border-radius: 50%; }
.sv-author .av { width: 100%; height: 100%; border: 1.5px solid #fff; border-radius: 50%; }
.sv-act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  color: #fff;
  font-size: 12px;
  line-height: 17px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, .45);
}
.sv-act svg { width: 27px; height: 27px; stroke-width: 2.2; }
.sv-act.on { color: var(--accent); }
.sv-act.on svg { fill: currentColor; }
.sv-act.pop svg { animation: pop .35s ease; }

@media (prefers-reduced-motion: reduce) {
  .sv-boost svg { animation: none; }
}
</style>
