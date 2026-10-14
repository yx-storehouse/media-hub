<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useBackDismiss } from '@/composables/useBackDismiss'
import { reducedMotion } from '@/utils/motion'
import { dur, ease } from '@/components/home/motion'
import Icon from '@/components/Icon.vue'
import RollNum from '@/components/video/RollNum.vue'

/*
 * 全屏看大图（帖子配图、社区卡片缩略图）：
 *   左右滑切换，双指缩放、双击放大 / 还原，放大后单指拖动查看；单击、上下滑、返回键 / 返回手势、Esc 关闭。
 *   顶部显示「2 / 6」。键盘左右方向键切换，桌面上 Ctrl + 滚轮（触控板双指）缩放。
 *
 *   <ImageViewer v-if="viewer" :images="viewer.images" :index="viewer.index" :origin="i => 缩略图元素" @close="viewer = null" />
 *
 * 父组件用 v-if 挂载 / 卸载；返回键关闭时发 close，由父组件卸载它（卸载时退掉弹层的历史记录）。
 *
 * 动效：传了 origin 时，大图从点的那张缩略图原位放大出来（缩略图是裁成方块 / 16:9 的，放大时裁切跟着展开），
 * 关掉时缩回当前这张对应的缩略图（翻到了别的图就回到别的图；没有缩略图、或者放大着看细节时淡出）。
 * 往下拖时图片跟着手指走、慢慢变小，背景跟着变淡，松手不够远就弹回去。
 * 关闭的动画由一个临时的「替身」播（挂在 #app 上，不接收点击），组件本身立刻卸载：返回键、焦点、
 * 下面的页面马上就恢复正常，不用等动画。
 */
const props = defineProps({
  /** Cover[]：{ src, fallback } */
  images: { type: Array, required: true },
  /** 打开时显示第几张 */
  index: { type: Number, default: 0 },
  /** (i) => 第 i 张图在页面上的缩略图元素（没有就返回 null） */
  origin: { type: Function, default: null }
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
/* 跳到别的页面（不是在这里关掉）：不播缩回去的动画；缩回去的途中换了页面，替身立刻撤掉 */
const router = useRouter()
let leaving = false
onBeforeRouteLeave(() => { leaving = true })
watch(shown, v => {
  if (v) return
  zoomOut()
  emit('close')
})
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
const bg = ref(null)
const top = ref(null)
/* 每张图的外框（按下标存，不依赖 v-for ref 数组的顺序） */
const slides = []
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

watch(cur, i => {
  scale.value = 1
  tx.value = ty.value = 0
  hideThumb(i)
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

/* 往下拖时图片跟着变小（最多缩到 0.7），背景跟着变淡 */
const dragScale = computed(() => 1 - Math.min(Math.abs(dragY.value) / 1000, 0.3))
const imgStyle = computed(() => ({ transform: `translate3d(${tx.value}px, ${ty.value + dragY.value}px, 0) scale(${scale.value * dragScale.value})` }))
const trackStyle = computed(() => ({ transform: `translate3d(calc(${-cur.value} * (100% + 16px) + ${dragX.value}px), 0, 0)` }))
const bgAlpha = computed(() => 1 - Math.min(Math.abs(dragY.value) / 420, 0.75))

function go(i) {
  if (i < 0 || i >= count.value || i === cur.value) return
  cur.value = i
}

/* ---------- 打开 / 关闭的动画 ---------- */

/* 缩略图：当前这张的在大图开着时藏起来（大图就是从它那里飞出来的），往下拖时能看到它空出来的位置 */
let hiddenThumb = null
function thumbOf(i) {
  const el = props.origin?.(i)
  return el instanceof Element && el.isConnected ? el : null
}
function hideThumb(i) {
  showThumb()
  const el = thumbOf(i)
  if (!el || reducedMotion()) return
  el.style.opacity = '0'
  hiddenThumb = el
}
function showThumb() {
  if (hiddenThumb) hiddenThumb.style.opacity = ''
  hiddenThumb = null
}

/* 缩略图在屏幕里（至少露出一点）才飞过去 */
function visibleRect(el) {
  const r = el?.getBoundingClientRect()
  if (!r || !r.width || !r.height) return null
  if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return null
  return r
}
/* 图片宽高比：读过了用读到的；还没读到就看缩略图里的那张（同一张图，通常已经在缓存里了） */
function ratioOf(i, thumb) {
  if (ratios.value[i]) return ratios.value[i]
  const img = thumb?.querySelector('img')
  if (img && img.complete && img.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight
  return 4 / 3
}
/* box 里按 contain 摆放、比例为 ar 的内容占的矩形（屏幕坐标） */
function contentRect(box, ar) {
  const w = Math.min(box.width, box.height * ar)
  const h = w / ar
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h }
}
const radiusOf = el => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0

/*
 * 「整张图」和「缩略图」两个状态的关键帧（transform-origin: 0 0）：
 * box 是做动画的元素的矩形，c 是图片内容在它里面的矩形，t 是缩略图的矩形（都是屏幕坐标）。
 * 缩略图状态：内容放大 / 缩小到正好盖住缩略图（cover），再用 clip-path 裁成缩略图的大小和圆角。
 */
function flyFrames(box, c, t, r) {
  const k = Math.max(t.width / c.width, t.height / c.height)
  const cw = t.width / k
  const ch = t.height / k
  const l = c.left - box.left + (c.width - cw) / 2
  const tp = c.top - box.top + (c.height - ch) / 2
  const thumb = { transform: `translate(${t.left - box.left - k * l}px, ${t.top - box.top - k * tp}px) scale(${k})` }
  const full = { transform: 'translate(0px, 0px) scale(1)' }
  // 缩略图和原图比例一样（帖子详情的配图）时不用裁，只动 transform，整个动画都在合成线程上跑
  if (Math.abs(t.width / t.height - c.width / c.height) > 0.02) {
    const inset = (x, y, w, h, rad) => `inset(${y}px ${box.width - x - w}px ${box.height - y - h}px ${x}px round ${rad}px)`
    thumb.clipPath = inset(l, tp, cw, ch, r / k)
    full.clipPath = inset(c.left - box.left, c.top - box.top, c.width, c.height, 0)
  }
  return { thumb, full }
}

/*
 * 大图能画出来了再起飞：新的 <img> 即使图在缓存里也要先解码，加载失败时要先换成占位图；
 * 不等的话第一帧缩略图已经藏起来、大图还没出来，那个位置会空一下（加载失败时还会闪出替代文字）。
 * 最多等 WAIT_MS，图片慢的时候照样马上起飞，不让人觉得点了没反应。
 */
const WAIT_MS = 100
async function imageReady(i) {
  const img = slides[i]?.querySelector('.iv-img')
  if (img) {
    // 先等加载有结果（成功 / 失败的事件在组件自己的 @load / @error 之后才轮到这里），成功了再等解码。
    // 失败时 complete 会先变成 true、error 事件稍后才到：那时还得接着等事件（占位图由它换上）
    const settled = (img.complete && img.naturalWidth) || failed.value[i]
      ? Promise.resolve()
      : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true })
        img.addEventListener('error', resolve, { once: true })
      })
    const painted = settled.then(() => (img.naturalWidth && img.decode ? img.decode() : null)).catch(() => {})
    await Promise.race([painted, new Promise(resolve => setTimeout(resolve, WAIT_MS))])
  }
  // 加载失败：@error 已经把这张标成失败，等换成占位图的这次渲染做完
  await nextTick()
}

/* 打开：从缩略图放大出来，背景和顶栏同时淡入；没有缩略图就整张轻轻放大淡入。手指一碰就直接到位 */
let opening = []
let touched = false // 等大图的时候手指已经碰过了：不再起飞，直接到位
let waiting = false // 还在等大图（查看器还没显示出来）
async function zoomIn() {
  const i = cur.value
  if (reducedMotion()) return hideThumb(i)
  // 等的这一下整个查看器先不显示（不然黑底会先盖上来），缩略图也还留在原处
  const view = root.value
  if (view) view.style.opacity = '0'
  waiting = true
  await imageReady(i)
  waiting = false
  if (view) view.style.opacity = ''
  if (!shown.value || cur.value !== i) return
  hideThumb(i)
  if (touched) return
  const duration = dur('--dur-3')
  const easing = ease('--ease-out')
  const fade = [{ opacity: 0 }, { opacity: 1 }]
  opening = [bg.value, top.value].filter(Boolean).map(el => el.animate(fade, { duration, easing }))
  const slide = slides[i]
  if (!slide) return
  const thumb = thumbOf(i)
  const t = visibleRect(thumb)
  if (!t) {
    opening.push(slide.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration, easing }))
    return
  }
  const s = slide.getBoundingClientRect()
  const f = flyFrames(s, contentRect(s, ratioOf(i, thumb)), t, radiusOf(thumb))
  opening.push(slide.animate([f.thumb, f.full], { duration, easing }))
}
function settleOpen() {
  opening.forEach(a => a.finish())
  opening = []
}

/*
 * 关闭：在 #app 上放一个替身（背景 + 当前这张图的拷贝，位置、大小和现在看到的一样，包括往下拖的位移），
 * 由它缩回缩略图并淡掉背景；组件本身马上卸载。放大着看细节、没有缩略图、缩略图不在屏幕里时，替身原地淡出。
 */
let flying = false
function zoomOut() {
  settleOpen()
  const i = cur.value
  const slide = slides[i]
  const media = slide?.querySelector('.iv-img, .iv-fb')
  const app = root.value?.parentElement
  // 还没显示出来就关了（等大图的那一下里）：没有可以缩回去的画面
  if (leaving || waiting || reducedMotion() || !media || !app) return showThumb()
  const thumb = thumbOf(i)
  const s = slide.getBoundingClientRect()
  const base = contentRect(s, ratioOf(i, thumb))
  const k0 = scale.value * dragScale.value
  const w = base.width * k0
  const h = base.height * k0
  const box = {
    left: base.left + base.width / 2 + tx.value - w / 2,
    top: base.top + base.height / 2 + ty.value + dragY.value - h / 2,
    width: w,
    height: h
  }
  const a = app.getBoundingClientRect()

  const ghost = document.createElement('div')
  ghost.className = 'iv-ghost'
  ghost.setAttribute('aria-hidden', 'true')
  const shade = document.createElement('div')
  shade.className = 'iv-ghost-bg'
  shade.style.opacity = String(bgAlpha.value)
  const img = media.cloneNode(true)
  img.className = 'iv-ghost-img'
  img.removeAttribute('alt')
  Object.assign(img.style, {
    left: `${box.left - a.left}px`,
    top: `${box.top - a.top}px`,
    width: `${w}px`,
    height: `${h}px`,
    transform: ''
  })
  ghost.append(shade, img)
  app.append(ghost)

  const t = k0 <= 1.01 ? visibleRect(thumb) : null
  const duration = dur(t ? '--dur-3' : '--dur-2')
  const easing = ease(t ? '--ease-out' : '--ease-in')
  shade.animate([{ opacity: bgAlpha.value }, { opacity: 0 }], { duration, easing, fill: 'forwards' })
  let anim
  if (t) {
    const f = flyFrames(box, box, t, radiusOf(thumb))
    anim = img.animate([f.full, f.thumb], { duration, easing, fill: 'forwards' })
  } else {
    showThumb()
    anim = img.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing, fill: 'forwards' })
  }
  flying = true
  const stopOnNav = router.afterEach(() => anim.finish())
  const done = () => {
    flying = false
    stopOnNav()
    ghost.remove()
    showThumb()
  }
  anim.onfinish = done
  anim.oncancel = done
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
  touched = true
  settleOpen()
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
    // 关闭时替身从松手的位置接着缩回去（dragY 留着给它量位置）
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
  zoomIn()
  root.value?.focus({ preventScroll: true })
  stage.value?.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => {
  clearTimeout(tapTimer)
  window.removeEventListener('resize', measure)
  if (!flying) showThumb()
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
      @keydown="onKey"
    >
      <!-- 黑色背景单独一层：打开时淡入、往下拖时跟着变淡（只改透明度） -->
      <div ref="bg" class="iv-bg" :style="{ opacity: bgAlpha }" />
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
            :ref="el => { slides[i] = el }"
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

      <div ref="top" class="iv-top" :class="{ off: dragY }">
        <button type="button" class="iv-close m-hold" aria-label="关闭" @click="close"><Icon name="close" /></button>
        <span v-if="count > 1" class="iv-count" aria-live="polite"><RollNum :value="String(cur + 1)" :n="cur" /> / {{ count }}</span>
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
}
.iv-bg { position: absolute; inset: 0; background: #000; }
.iv-stage { position: absolute; inset: 0; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; }
.iv-track { display: flex; gap: 16px; height: 100%; will-change: transform; }
.iv-track.anim { transition: transform var(--dur-3) var(--ease-out); }
/* transform-origin 0 0：打开时从缩略图放大的关键帧按左上角算 */
.iv-slide { position: relative; display: grid; flex: 0 0 100%; place-items: center; height: 100%; overflow: hidden; transform-origin: 0 0; }
.iv-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  transform-origin: 50% 50%;
  -webkit-user-drag: none;
  pointer-events: none;
}
.iv-fb { width: 100%; aspect-ratio: 4 / 3; background-color: #161616; background-position: center; background-size: cover; }
.iv-img.anim, .iv-fb.anim { transition: transform var(--dur-3) var(--ease-out); }

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
  transition: opacity var(--dur-2) var(--ease-out);
}
/* 往下拖的时候顶栏让开 */
.iv-top.off { opacity: 0; transition-duration: var(--dur-1); }
.iv-top > * { pointer-events: auto; }
.iv-close {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #fff;
}
.iv-close svg { width: 22px; height: 22px; padding: 7px; box-sizing: content-box; border-radius: 50%; background: rgba(0, 0, 0, .42); stroke-width: 2.4; transition: transform var(--dur-2) var(--ease-spring); }
.iv-close.m-pressed svg { transform: scale(var(--press-scale-sm)); transition: transform var(--dur-1) var(--ease-out); }
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
  white-space: nowrap;
  pointer-events: none;
}

/* 关闭时的替身：盖在页面上、不接收点击，动画播完自己移除 */
.iv-ghost { position: absolute; inset: 0; z-index: 70; overflow: hidden; pointer-events: none; }
.iv-ghost-bg { position: absolute; inset: 0; background: #000; }
.iv-ghost-img { position: absolute; display: block; max-width: none; object-fit: fill; transform-origin: 0 0; background-color: #161616; background-position: center; background-size: cover; }
</style>
