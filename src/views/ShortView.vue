<script setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, shallowRef, useTemplateRef } from 'vue'
import { getShorts, toggleVideoLike, toggleVideoFav } from '@/api'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import Icon from '@/components/Icon.vue'
import BottomSheet from '@/components/BottomSheet.vue'
import ShortItem from '@/components/short/ShortItem.vue'

defineOptions({ name: 'ShortView' })

const FEEDS = ['推荐', '专题']
const SPEEDS = ['0.5x', '0.75x', '1.0x', '1.25x', '1.5x', '2.0x']
const TICK_MS = 100
/** 每页条数；滑到离末尾还剩 PRELOAD_AHEAD 条时加载下一页 */
const PAGE_SIZE = 10
const PRELOAD_AHEAD = 3

const store = useAppStore()
const auth = useAuthStore()
const feedEl = useTemplateRef('feed')

const clips = shallowRef([])
/** playback per clip, same order as `clips`: { t: seconds, playing, len: seconds（真实视频读到文件时长后替换） } */
const players = ref([])
/** clip on screen; only used to decide which real videos preload (the playback logic uses `current`) */
const active = ref(0)

const feedTab = ref(0)
const settingsOpen = ref(false)
const rate = computed(() => parseFloat(store.playback.speed) || 1)

/* playback bookkeeping that the template never reads */
let current = 0 // index of the clip that fills the screen; only this one advances
let advancingTo = -1 // clip the feed is smooth-scrolling to after the current one ended (-1: none)
let visible = false // page is the active KeepAlive child
let timer = 0
let io = null

/* 翻页：nextOffset 是下一页从接口的第几条开始（去重后的 clips 可能比它少） */
let nextOffset = 0
let reachedEnd = false
let loadingMore = null

const newPlayer = clip => ({ t: 0, playing: false, len: clip.len || 0 })

async function load() {
  const list = await getShorts({ limit: PAGE_SIZE, offset: 0 })
  clips.value = list
  players.value = list.map(newPlayer)
  nextOffset = list.length
  reachedEnd = list.length < PAGE_SIZE
  current = 0
  active.value = 0
  await nextTick()
  if (visible) observe()
}

/** 加载下一页并接到末尾；同一时间只有一个请求，失败了等下次靠近末尾再试 */
function loadMore() {
  if (reachedEnd || !clips.value.length) return Promise.resolve()
  loadingMore ??= (async () => {
    try {
      const list = await getShorts({ limit: PAGE_SIZE, offset: nextOffset })
      nextOffset += list.length
      reachedEnd = list.length < PAGE_SIZE
      // 翻页期间后台调整了顺序可能导致重复，按 id 去掉
      const seen = new Set(clips.value.map(c => c.id))
      const fresh = list.filter(c => !seen.has(c.id))
      if (!fresh.length) return
      clips.value = [...clips.value, ...fresh]
      players.value.push(...fresh.map(newPlayer))
      await nextTick()
      if (visible) observe(false)
    } catch { /* 网络问题：下次滑到附近再试 */ } finally {
      loadingMore = null
    }
  })()
  return loadingMore
}

/* ---------- 互动：状态在这里维护，子组件只负责显示 ---------- */

/** 正在请求中的互动，避免连点导致计数错乱 */
const pending = reactive(new Set())

/** clips 是 shallowRef：改内部属性不会触发更新，所以整体替换那一条 */
function patchClip(i, obj) {
  clips.value = clips.value.map((c, j) => (j === i ? { ...c, ...obj } : c))
}

/**
 * 点赞 / 收藏：乐观更新 → 请求 → 失败回滚。
 * like 与 fav 的字段名在新旧数据里略有差异，这里统一成 likes / favs。
 */
async function interact(i, kind) {
  const clip = clips.value[i]
  if (!clip || pending.has(`${i}:${kind}`)) return
  if (!auth.requireLogin(location.hash.slice(1))) return   // 未登录：弹登录框
  const isLike = kind === 'like'
  const onField = isLike ? 'liked' : 'faved'
  const countField = isLike ? (clip.likes != null ? 'likes' : 'like') : (clip.favs != null ? 'favs' : 'fav')
  const next = !clip[onField]
  const before = clip[countField] ?? 0

  pending.add(`${i}:${kind}`)
  patchClip(i, { [onField]: next, [countField]: before + (next ? 1 : -1) })
  try {
    if (isLike) await toggleVideoLike(clip.id, { on: next })
    else await toggleVideoFav(clip.id, { on: next })
  } catch {
    patchClip(i, { [onField]: !next, [countField]: before })   // 回滚
    toast('操作失败，请稍后重试')
  } finally {
    pending.delete(`${i}:${kind}`)
  }
}

const onLike = i => interact(i, 'like')
const onFav = i => interact(i, 'fav')

/** 「不喜欢」只记在本地；如果之前点过赞，顺手取消掉 */
function onDislike(i) {
  const clip = clips.value[i]
  if (!clip) return
  if (clip.liked) onLike(i)
  store.toggle(`dislike:short:${clip.id}`)
  patchClip(i, {})   // 触发一次更新，让图标状态刷新
}

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
  if (!p.playing && p.t >= p.len) p.t = 0
  p.playing = !p.playing
}

function seek(i, t) {
  const p = players.value[i]
  p.t = Math.min(p.len, Math.max(0, t))
}

/* ---------- 真实视频（clip.src）上报的状态；模拟的那些由 tick() 推进 ---------- */

const onTime = (i, t) => { players.value[i].t = t }
const onDuration = (i, d) => { players.value[i].len = d }
/* 原生播放 / 暂停（播完、自动播放被拦）：只同步状态，不再反过来驱动 */
const onState = (i, playing) => { players.value[i].playing = playing }
/* 文件打不开：这条退回封面 + 模拟进度 */
function onFailed(i) {
  const clip = clips.value[i]
  patchClip(i, { src: null })
  players.value[i].len = clip.len || 0
  if (i === current) {
    toast('视频加载失败，已切换为预览')
    play(i)
  }
}

function tick() {
  const p = players.value[current]
  const clip = clips.value[current]
  if (!p || !p.playing || clip?.src) return
  p.t = Math.min(p.len, p.t + (TICK_MS / 1000) * rate.value)
  if (p.t >= p.len) finish(current)
}

/** 当前这条播完：循环就从头来，否则停下，开着自动连播时滑到下一条（到末尾先等下一页） */
async function finish(i) {
  const p = players.value[i]
  if (!p) return
  if (store.playback.loop) {
    p.t = 0
    return
  }
  p.playing = false
  if (!store.playback.autoNext || i !== current) return
  if (i >= clips.value.length - 1) await loadMore()
  // the observer starts the next clip once it snaps into view
  if (i === current && visible && i < clips.value.length - 1) {
    advancingTo = i + 1
    scrollToClip(advancingTo, 'smooth')
  }
}

function scrollToClip(i, behavior = 'auto') {
  const feed = feedEl.value
  if (feed) feed.scrollTo({ top: i * feed.clientHeight, behavior })
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
      current = Number(e.target.dataset.index)
      active.value = current
      advancingTo = -1
      play(current)
      if (current >= clips.value.length - PRELOAD_AHEAD) loadMore()
    }
  }, { root: feed, threshold: 0.6 })
  if (reset) io.disconnect()
  for (const el of feed.children) io.observe(el)   // observe() on an element already observed is a no-op
}

/* ---------- lifecycle (kept alive between tab switches) ---------- */

function stop() {
  visible = false
  clearInterval(timer)
  timer = 0
  io?.disconnect()
  pauseAll()
}

onMounted(load)

onActivated(() => {
  visible = true
  clearInterval(timer)
  timer = setInterval(tick, TICK_MS)
  if (!clips.value.length) return // first activation: load() starts the observer once the feed is rendered
  // left in the middle of an auto-advance: land on the clip it was heading to, not the finished one
  if (advancingTo >= 0) current = advancingTo
  advancingTo = -1
  scrollToClip(current) // keep the same clip on screen in case the scroll offset was lost while detached
  play(current)
  observe()
})

onDeactivated(stop)

onUnmounted(() => {
  stop()
  io = null
})

/* ---------- top bar + settings ---------- */

function selectFeed(i) {
  feedTab.value = i
  if (FEEDS[i] === '专题') toast('专题内容即将上线')
}

function setMuted(muted) {
  store.muted = muted
  toast(muted ? '已静音' : '已恢复声音')
}

function setSpeed(speed) {
  store.playback.speed = speed
  toast(`已切换为 ${speed} 倍速`)
  settingsOpen.value = false
}
</script>

<template>
  <div class="page sv-page">
    <div class="sv-top">
      <div class="l">
        <button type="button" aria-label="全屏" @click="toast('全屏播放即将上线')"><Icon name="expand" /></button>
        <button type="button" aria-label="小窗播放" @click="toast('小窗播放即将上线')"><Icon name="pip" /></button>
      </div>
      <div class="tt2" role="tablist">
        <button
          v-for="(name, i) in FEEDS"
          :key="name"
          class="sv-tab"
          :class="{ on: feedTab === i }"
          type="button"
          role="tab"
          :aria-selected="feedTab === i"
          @click="selectFeed(i)"
        >
          {{ name }}
        </button>
      </div>
      <div class="r">
        <button type="button" :aria-label="store.muted ? '恢复声音' : '静音'" @click="setMuted(!store.muted)">
          <Icon :name="store.muted ? 'mute' : 'vol'" />
        </button>
      </div>
    </div>

    <div ref="feed" class="scroll sv-feed">
      <ShortItem
        v-for="(clip, i) in clips"
        :key="clip.id"
        :data-index="i"
        :clip="clip"
        :liked="!!clip.liked"
        :faved="!!clip.faved"
        :likes="clip.likes ?? clip.like ?? 0"
        :favs="clip.favs ?? clip.fav ?? 0"
        :time="players[i].t"
        :len="players[i].len"
        :playing="players[i].playing"
        :eager="i === 0"
        :near="Math.abs(i - active) <= 1"
        @toggle="toggle(i)"
        @seek="t => seek(i, t)"
        @time="t => onTime(i, t)"
        @duration="d => onDuration(i, d)"
        @state="on => onState(i, on)"
        @ended="finish(i)"
        @failed="onFailed(i)"
        @unmute="setMuted(false)"
        @like="onLike(i)"
        @dislike="onDislike(i)"
        @fav="onFav(i)"
        @settings="settingsOpen = true"
      />
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
    </BottomSheet>
  </div>
</template>

<style scoped>
.sv-page { background: #000; }

/* one clip per screen (scrolling itself comes from the global .scroll) */
.sv-feed {
  position: relative;
  scroll-snap-type: y mandatory;
  background: #000;
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
.sv-top .l { position: absolute; left: 8px; top: 9px; display: flex; gap: 16px; color: #fff; }
.sv-top .l svg { width: 17px; height: 17px; stroke-width: 2.2; opacity: .92; }
.sv-top .r { position: absolute; right: 12px; top: 9px; color: #fff; }
.sv-top .r svg { width: 17px; height: 17px; opacity: .92; }
/* the icons are 17px: padding + equal negative margin grows the tap area without moving anything */
.sv-top .l button,
.sv-top .r button { display: flex; }
.sv-top .l button { padding: 8px; margin: -8px; }
.sv-top .r button { padding: 12px; margin: -12px; }
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

.speeds { margin-bottom: 12px; }
</style>
