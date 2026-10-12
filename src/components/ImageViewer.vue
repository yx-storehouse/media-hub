<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useBackDismiss } from '@/composables/useBackDismiss'
import Icon from '@/components/Icon.vue'

/*
 * 全屏看大图（帖子配图、社区卡片缩略图）：
 *   左右滑切换，双指缩放、双击放大 / 还原，放大后单指拖动查看；单击、上下滑、返回键 / 返回手势、Esc 关闭。
 *   顶部显示「2 / 6」。键盘左右方向键切换，桌面上 Ctrl + 滚轮（触控板双指）缩放。
 *
 *   <ImageViewer v-if="viewer" :images="viewer.images" :index="viewer.index" @close="viewer = null" />
 *
 * 父组件用 v-if 挂载 / 卸载；返回键关闭时发 close，由父组件卸载它（卸载时退掉弹层的历史记录）。
 */
const props = defineProps({
  /** Cover[]：{ src, fallback } */
  images: { type: Array, required: true },
  /** 打开时显示第几张 */
  index: { type: Number, default: 0 }
})
const emit = defineEmits(['close'])

const MAX_SCALE = 4
const DOUBLE_SCALE = 2.5
/* 两次点按间隔不超过这个（毫秒）、距离不超过 TAP_SLOP 算双击；单击要等这么久确认不是双击 */
const DOUBLE_MS = 260
const TAP_SLOP = 30
/* 手指移动超过这个距离才算拖动（之前算点按）；按住超过 LONG_MS 松开不算点按（不关闭） */
const MOVE_SLOP = 8
const LONG_MS = 600

const shown = ref(true)
useBackDismiss(shown)
watch(shown, v => { if (!v) emit('close') })
const close = () => { shown.value = false }

const count = computed(() => props.images.length)
const cur = ref(Math.min(Math.max(0, props.index), Math.max(0, count.value - 1)))
/* 只渲染当前和左右各一张：长图集不会一次加载所有大图 */
const near = i => Math.abs(i - cur.value) <= 1
const failed = ref({})
/* 每张图的原始宽高比（加载完读出），算放大后能拖多远 */
const ratios = shallowRef({})

const root = ref(null)
const stage = ref(null)
const size = { w: 0, h: 0 }
function measure() {
  const el = stage.value
  if (el) { size.w = el.clientWidth; size.h = el.clientHeight }
}

/* 当前这张的缩放和位移（相对图片中心，像素）；换图时还原 */
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
/* 左右切换时整排的拖动距离、下滑关闭时当前这张的位移 */
const dragX = ref(0)
const dragY = ref(0)
/* 拖动 / 缩放过程中跟手，不要过渡动画；松手后带动画回到位 */
const dragging = ref(false)

watch(cur, () => {
  scale.value = 1
  tx.value = ty.value = 0
})

function onImgLoad(i, e) {
  const { naturalWidth: w, naturalHeight: h } = e.target
  if (w && h) ratios.value = { ...ratios.value, [i]: w / h }
}

/* 图片按 contain 摆进舞台后的显示尺寸（还没读到宽高 / 占位图按 4:3 算） */
function fitted() {
  const ar = ratios.value[cur.value] || 4 / 3
  const w = Math.min(size.w, size.h * ar)
  return { w, h: w / ar }
}
/* 放大后最多拖到图片边缘贴着屏幕边，不露出黑边 */
function clamp(s, x, y) {
  const f = fitted()
  const mx = Math.max(0, (f.w * s - size.w) / 2)
  const my = Math.max(0, (f.h * s - size.h) / 2)
  return [Math.min(mx, Math.max(-mx, x)), Math.min(my, Math.max(-my, y))]
}
function setZoom(s, x, y) {
  s = Math.min(MAX_SCALE, Math.max(1, s))
  const [cx, cy] = clamp(s, x, y)
  scale.value = s
  tx.value = cx
  ty.value = cy
}
/* 以舞台上的某一点为中心缩放到 s（这一点下面的内容保持不动） */
function zoomAt(s, px, py, from = { s: scale.value, x: tx.value, y: ty.value }) {
  const k = s / from.s
  return [s, px - (px - from.x) * k, py - (py - from.y) * k]
}

const imgStyle = computed(() => ({ transform: `translate3d(${tx.value}px, ${ty.value + dragY.value}px, 0) scale(${scale.value})` }))
const trackStyle = computed(() => ({ transform: `translate3d(calc(${-cur.value} * (100% + 16px) + ${dragX.value}px), 0, 0)` }))
/* 下滑关闭时背景跟着变淡 */
const bgAlpha = computed(() => 1 - Math.min(Math.abs(dragY.value) / 420, 0.75))

function go(i) {
  if (i < 0 || i >= count.value || i === cur.value) return
  cur.value = i
}

/* ---------- 手势（Pointer Events：触屏、鼠标、触控笔同一套） ---------- */

const pointers = new Map()
let mode = null         // null 还没判定 / 'swipe' 左右切换 / 'pan' 放大后拖动 / 'down' 上下滑关闭 / 'pinch' 双指缩放
let start = null        // 单指起点 { x, y, t }
let base = null         // 手势开始时的 { s, x, y }
let pinch = null        // 双指起点 { d, mx, my }
let lastTap = null
let tapTimer = 0

/* 舞台坐标：相对舞台中心 */
function local(p) {
  const r = stage.value.getBoundingClientRect()
  return { x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 }
}
const twoPoints = () => [...pointers.values()].slice(0, 2)

function beginPinch() {
  const [a, b] = twoPoints()
  const m = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: m.x, my: m.y }
  base = { s: scale.value, x: tx.value, y: ty.value }
  mode = 'pinch'
  dragX.value = dragY.value = 0
}
/* 双指松开一只后接着用剩下那只拖动 */
function beginPan(p) {
  start = { x: p.x, y: p.y, t: Date.now() }
  base = { s: scale.value, x: tx.value, y: ty.value }
  mode = 'pan'
}

function onDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  measure()
  try { stage.value.setPointerCapture(e.pointerId) } catch { /* 已经松开了 */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  clearTimeout(tapTimer)
  dragging.value = true
  if (pointers.size === 1) {
    start = { x: e.clientX, y: e.clientY, t: Date.now() }
    base = { s: scale.value, x: tx.value, y: ty.value }
    mode = null
  } else if (pointers.size === 2) {
    lastTap = null
    beginPinch()
  }
}

function onMove(e) {
  const p = pointers.get(e.pointerId)
  if (!p) return
  p.x = e.clientX
  p.y = e.clientY
  if (mode === 'pinch') {
    if (pointers.size < 2) return
    const [a, b] = twoPoints()
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    const m = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    // 缩小到 1 倍以下时给一点阻力，松手弹回
    let s = base.s * (d / pinch.d)
    if (s < 1) s = 1 - (1 - s) / 3
    s = Math.min(MAX_SCALE * 1.15, s)
    const k = s / base.s
    scale.value = s
    tx.value = m.x - (pinch.mx - base.x) * k
    ty.value = m.y - (pinch.my - base.y) * k
    return
  }
  if (pointers.size !== 1 || !start) return
  const dx = e.clientX - start.x
  const dy = e.clientY - start.y
  if (!mode) {
    if (Math.hypot(dx, dy) < MOVE_SLOP) return
    lastTap = null
    if (scale.value > 1.01) mode = 'pan'
    else mode = Math.abs(dy) > Math.abs(dx) ? 'down' : 'swipe'
  }
  if (mode === 'swipe') {
    // 第一张往右、最后一张往左拉时有阻力
    const edge = (cur.value === 0 && dx > 0) || (cur.value === count.value - 1 && dx < 0)
    dragX.value = edge ? dx / 3 : dx
  } else if (mode === 'pan') {
    const [x, y] = clamp(scale.value, base.x + dx, base.y + dy)
    tx.value = x
    ty.value = y
  } else if (mode === 'down') {
    dragY.value = dy
  }
}

function onUp(e) {
  if (!pointers.has(e.pointerId)) return
  pointers.delete(e.pointerId)
  if (mode === 'pinch') {
    if (pointers.size === 1) {
      beginPan([...pointers.values()][0])
      return
    }
    if (pointers.size) return
  }
  if (pointers.size) return
  dragging.value = false
  const dt = Math.max(1, Date.now() - (start?.t || 0))
  const dx = e.clientX - (start?.x ?? e.clientX)
  const dy = e.clientY - (start?.y ?? e.clientY)
  if (mode === 'pinch' || mode === 'pan') {
    setZoom(scale.value, tx.value, ty.value)
    if (scale.value <= 1.01) setZoom(1, 0, 0)
  } else if (mode === 'swipe') {
    const v = dx / dt
    const far = Math.abs(dx) > size.w * 0.18 || Math.abs(v) > 0.45
    if (far && dx < 0) go(cur.value + 1)
    else if (far && dx > 0) go(cur.value - 1)
    dragX.value = 0
  } else if (mode === 'down') {
    if (Math.abs(dy) > 110 || Math.abs(dy / dt) > 0.7) return close()
    dragY.value = 0
  } else if (e.type === 'pointerup' && dt < LONG_MS) {
    onTap(e)
  }
  mode = null
}

/* 点按：双击放大 / 还原；单击稍等确认不是双击再关闭 */
function onTap(e) {
  const now = Date.now()
  if (lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < TAP_SLOP) {
    lastTap = null
    clearTimeout(tapTimer)
    if (scale.value > 1.01) setZoom(1, 0, 0)
    else {
      const p = local({ x: e.clientX, y: e.clientY })
      setZoom(...zoomAt(DOUBLE_SCALE, p.x, p.y))
    }
    return
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY }
  clearTimeout(tapTimer)
  tapTimer = setTimeout(close, DOUBLE_MS)
}

/* 桌面：Ctrl + 滚轮 / 触控板双指缩放 */
function onWheel(e) {
  if (!e.ctrlKey) return
  e.preventDefault()
  measure()
  const p = local({ x: e.clientX, y: e.clientY })
  setZoom(...zoomAt(scale.value * Math.exp(-e.deltaY * 0.01), p.x, p.y))
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close() }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(cur.value - 1) }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(cur.value + 1) }
}

/* 打开时焦点移进来，关掉后还给原来的按钮 */
let returnFocus = null
onMounted(async () => {
  returnFocus = document.activeElement
  await nextTick()
  measure()
  root.value?.focus({ preventScroll: true })
  stage.value?.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => {
  clearTimeout(tapTimer)
  window.removeEventListener('resize', measure)
  if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="#app">
    <div
      ref="root"
      class="iv"
      role="dialog"
      aria-modal="true"
      aria-label="查看图片"
      tabindex="-1"
      :style="{ backgroundColor: `rgba(0, 0, 0, ${bgAlpha})` }"
      @keydown="onKey"
    >
      <div
        ref="stage"
        class="iv-stage"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
        <div class="iv-track" :class="{ anim: !dragging }" :style="trackStyle">
          <div
            v-for="(img, i) in images"
            :key="i"
            class="iv-slide"
            :aria-hidden="i !== cur"
          >
            <template v-if="near(i)">
              <img
                v-if="img && img.src && !failed[i]"
                class="iv-img"
                :class="{ anim: !dragging }"
                :src="img.src"
                :alt="`第 ${i + 1} 张图`"
                draggable="false"
                :style="i === cur ? imgStyle : undefined"
                @load="onImgLoad(i, $event)"
                @error="failed = { ...failed, [i]: true }"
              >
              <!-- 没有图片地址 / 加载失败：显示占位图 -->
              <div
                v-else
                class="iv-fb"
                :class="{ anim: !dragging }"
                :style="[{ backgroundImage: img?.fallback || undefined }, i === cur ? imgStyle : {}]"
              />
            </template>
          </div>
        </div>
      </div>

      <div class="iv-top" :style="{ opacity: dragY ? 0 : 1 }">
        <button type="button" class="iv-close" aria-label="关闭" @click="close"><Icon name="close" /></button>
        <span v-if="count > 1" class="iv-count" aria-live="polite">{{ cur + 1 }} / {{ count }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style>
.iv {
  position: absolute;
  inset: 0;
  z-index: 70;
  overflow: hidden;
  outline: 0;
  animation: iv-in .18s ease-out;
}
@keyframes iv-in { from { opacity: 0; } }
.iv-stage { position: absolute; inset: 0; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; }
.iv-track { display: flex; gap: 16px; height: 100%; will-change: transform; }
.iv-track.anim { transition: transform .28s cubic-bezier(.2, .8, .2, 1); }
.iv-slide { position: relative; display: grid; flex: 0 0 100%; place-items: center; height: 100%; overflow: hidden; }
.iv-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  transform-origin: 50% 50%;
  -webkit-user-drag: none;
  pointer-events: none;
}
.iv-fb { width: 100%; aspect-ratio: 4 / 3; background-color: #161616; background-position: center; background-size: cover; }
.iv-img.anim, .iv-fb.anim { transition: transform .24s cubic-bezier(.2, .8, .2, 1); }

.iv-top {
  position: absolute;
  top: var(--safe-t);
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  height: 52px;
  padding: 0 8px;
  pointer-events: none;
  transition: opacity .15s;
}
.iv-top > * { pointer-events: auto; }
.iv-close {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #fff;
}
.iv-close svg { width: 22px; height: 22px; padding: 7px; box-sizing: content-box; border-radius: 50%; background: rgba(0, 0, 0, .42); stroke-width: 2.4; }
.iv-count {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 11px;
  border-radius: 12px;
  background: rgba(0, 0, 0, .42);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .iv { animation: none; }
  .iv-track.anim, .iv-img.anim, .iv-fb.anim { transition: none; }
}
</style>
