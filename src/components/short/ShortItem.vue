<script setup>
import { computed, onBeforeUnmount, onDeactivated, onMounted, reactive, useTemplateRef, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { share } from '@/composables/useShare'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

/*
 * One full-screen clip of the short-video feed.
 * Playback (time / playing) is owned by the feed; this component renders it and reports intents:
 *   toggle   tap on the clip or the play button
 *   seek     new position in seconds (±10 s buttons, progress bar)
 *   unmute   "点击恢复声音" pill
 *   settings 设置 action
 *
 * clip.src 有值（后台给短视频配了素材文件）时用原生 <video> 播放，并把实际情况报给父组件：
 *   time     播放到第几秒（timeupdate）
 *   duration 文件的真实时长（读到有限值才报）
 *   state    原生播放 / 暂停（播完、被浏览器拦下自动播放时，父组件据此更新按钮）
 *   ended    播完（循环播放时 <video loop> 自己从头来，不会触发）
 *   failed   文件打不开：父组件把这条退回封面 + 模拟进度
 * clip.src 为空时保持原来的做法：封面慢慢平移，进度由父组件的计时器推进。
 */
const props = defineProps({
  /** Short: { id, tags, title, len, cover, src, likes, favs, liked, faved } */
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
  /** load the background photo immediately (first clip on screen) */
  eager: Boolean,
  /** 在当前这条附近：真实视频提前加载，离得远的不加载 */
  near: Boolean
})
const emit = defineEmits(['toggle', 'seek', 'unmute', 'settings', 'like', 'dislike', 'fav', 'time', 'duration', 'state', 'ended', 'failed'])

const store = useAppStore()

/* ---------- 真实视频 ---------- */

const videoEl = useTemplateRef('video')
const hasVideo = computed(() => !!props.clip.src)
const length = computed(() => props.len || props.clip.len || 0)
const rate = computed(() => parseFloat(store.playback.speed) || 1)

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
watch(() => props.playing, sync)
watch(hasVideo, on => { if (on) sync() }, { flush: 'post' })
watch(rate, r => { if (videoEl.value) videoEl.value.playbackRate = r })
onMounted(sync)
/* 页面被 KeepAlive 收起时父组件会先暂停全部；这里再兜一层，保证不会在后台继续出声 */
onDeactivated(() => videoEl.value?.pause())
/* 卸载时释放地址，否则离开后还可能在后台下载 */
onBeforeUnmount(() => {
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
const progress = computed(() => `${length.value ? Math.min(100, (props.time / length.value) * 100) : 0}%`)

function seekBy(delta) {
  seekTo(props.time + delta)
}

function seekBar(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  seekTo(((e.clientX - rect.left) / rect.width) * length.value)
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
  <section class="sv" :class="{ playing, real: hasVideo }">
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
    <div class="sv-click" @click="emit('toggle')" />

    <div class="sv-ctl">
      <button class="sk" type="button" aria-label="后退10秒" @click="seekBy(-10)"><Icon name="replay" /></button>
      <button class="pb" type="button" :aria-label="playing ? '暂停' : '播放'" @click="emit('toggle')"><Icon name="play" /></button>
      <button class="sk" type="button" aria-label="前进10秒" @click="seekBy(10)"><Icon name="forward" /></button>
    </div>

    <button v-show="store.muted" class="sv-unmute" type="button" @click="emit('unmute')">
      <Icon name="mute" />点击恢复声音
    </button>

    <div class="sv-meta">
      <div class="sv-tags"><span v-for="tag in clip.tags" :key="tag">{{ tag }}</span></div>
      <div class="sv-title">{{ clip.title }}</div>
    </div>

    <div class="sv-prog">
      <span>{{ mmss(time) }}</span>
      <div class="bar" @click="seekBar"><i :style="{ width: progress }" /></div>
      <span>{{ mmss(length) }}</span>
    </div>

    <div class="sv-side">
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
  scroll-snap-align: start;
  scroll-snap-stop: always;
  user-select: none;
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

.sv-unmute {
  position: absolute;
  left: 12px;
  bottom: 135px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 13px 0 12px;
  border-radius: 10px;
  background: rgba(22, 22, 22, .84);
  color: #fff;
  font-size: 12px;
}
.sv-unmute svg { width: 14px; height: 14px; }

.sv-meta { position: absolute; left: 12px; right: 68px; bottom: 50px; z-index: 4; pointer-events: none; }
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

.sv-prog {
  position: absolute;
  left: 11px;
  right: 61px;
  bottom: 18px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 20px;
  color: rgba(255, 255, 255, .88);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.sv-prog .bar { position: relative; flex: 1; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .4); cursor: pointer; }
.sv-prog .bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: #fff; }
/* taller hit area than the 3px track */
.sv-prog .bar::before { content: ''; position: absolute; left: 0; right: 0; top: -9px; bottom: -9px; }

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
</style>
