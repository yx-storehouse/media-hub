import { reducedMotion, cssDuration, cssEasing, spring } from '@/utils/motion'

/*
 * 按压反馈：手指一按下就缩一点，松手用弹簧弹回（和 iOS / 抖音的卡片、按钮一样）。
 * 整个 App 只有一组委托在 document 上的监听（main.js 里 installPress()），列表再长也不给每张卡片挂监听。
 *
 *   class="m-press"      卡片、按钮：缩到 --press-scale（.96），松手 snappy 弹簧（几乎看不出过冲，只是落定得很「实」）
 *   class="m-press-sm"   小图标按钮：缩到 --press-scale-sm（.88），松手 bouncy 弹簧，看得出轻轻弹一下
 *   class="m-hold"       不缩放，只在按住时加 .m-pressed，由组件自己写样式（底部导航让图标缩一下）
 *   class="m-off"        临时关掉（比如卡片里正在拖动的东西）
 *   v-press              卡片的键盘支持 + m-press（v-press.sm → m-press-sm，v-press.plain 不加缩放）
 *
 * 公共样式里的按钮（common.css 的 .btn-soft .pill .chip .opt .retry .ct-search，返回键 .sh-back）
 * 不用改模板，自动带上。按住期间元素上都有 .m-pressed，可以配合写变暗之类的样式。
 *
 * 细节
 *  - pointerdown 立刻开始缩放；开始滚动（pointercancel / scroll）、手指移开超过 10px 时立刻弹回，不和滚动抢；
 *  - 很快的一点也会完整地缩一下再弹回（缩放用 Web Animations 跑，不占用元素自己的 transition）；
 *  - 弹回途中又按下：从当前看到的大小接着缩，不会先跳回原样再缩（不抖）；
 *  - 不拦截、不延迟点击：跳转和操作照常立刻发生；
 *  - 元素本来有 transform 的会保留（缩放叠在它后面）；disabled / aria-disabled 的不动；
 *  - 「减少动态效果」时不缩放，只加 .m-pressed。
 */

const CARD = '.m-press, .btn-soft, .pill, .chip, .opt, .retry, .ct-search'
const SMALL = '.m-press-sm, .sh-back'
const ANY = `${SMALL}, ${CARD}, .m-hold`
const SLOP = 10 // px：手指移动超过这么多就不算按着了

let T = null
/** 动效令牌只读一次（读 CSS 变量会触发样式计算，不要每次按下都读） */
function tokens() {
  if (T) return T
  const cs = getComputedStyle(document.documentElement)
  const num = (name, fallback) => {
    const v = parseFloat(cs.getPropertyValue(name))
    return Number.isFinite(v) ? v : fallback
  }
  T = {
    card: num('--press-scale', 0.96),
    small: num('--press-scale-sm', 0.88),
    d1: cssDuration('--dur-1', 120),
    out: cssEasing('--ease-out')
  }
  return T
}

const held = new Map()          // 按住中的元素 → { anim, pre, scale, small, x, y, id }
const releasing = new WeakMap() // 正在弹回 / 等着弹回的元素 → { anim, scaleNow() 现在看到的缩放 }

/* 动画此刻缓动后的进度（弹簧过冲时会大于 1）：再按下时用它算出现在看到的缩放 */
const progress = a => {
  const c = a.effect?.getComputedTiming?.()
  return c && typeof c.progress === 'number' ? c.progress : 1
}

function press(el, e) {
  if (held.has(el)) return
  // 上一次的弹回还没放完就又按下：记下它现在弹到的大小，从这里接着缩；先停掉它，读到的才是元素自己的 transform
  const prev = releasing.get(el)
  const from = prev ? prev.scaleNow() : 1
  prev?.anim.cancel()
  releasing.delete(el)
  el.classList.add('m-pressed')
  const h = { anim: null, pre: '', from, scale: 1, small: false, x: e.clientX, y: e.clientY, id: e.pointerId, t0: performance.now() }
  const small = el.matches(SMALL)
  if ((small || el.matches(CARD)) && el.animate && !reducedMotion()) {
    const t = tokens()
    // 入场动画还在跑时读到的是动画中途的值，不能当成元素自己的 transform
    const base = el.getAnimations?.().length ? 'none' : getComputedStyle(el).transform
    h.pre = base && base !== 'none' ? base + ' ' : ''
    h.small = small
    h.scale = small ? t.small : t.card
    h.anim = el.animate(
      [{ transform: `${h.pre}scale(${from})` }, { transform: `${h.pre}scale(${h.scale})` }],
      { duration: t.d1, easing: t.out, fill: 'forwards' }
    )
  }
  held.set(el, h)
  if (held.size === 1) document.addEventListener('pointermove', onMove, { capture: true, passive: true })
}

/* 按下的动画此刻的缩放 */
const pressedNow = h => h.from + (h.scale - h.from) * progress(h.anim)

/* 从 fromScale 弹回原样：卡片 snappy、小图标 bouncy（和 CSS 的 --spring-* 同一组弹簧）；被打断时一律 snappy */
function springBack(el, h, fromScale, name) {
  const b = el.animate(
    [{ transform: `${h.pre}scale(${fromScale})` }, { transform: `${h.pre}scale(1)` }],
    spring(name)
  )
  b.onfinish = () => { b.cancel(); if (releasing.get(el)?.anim === b) releasing.delete(el) }
  releasing.set(el, { anim: b, scaleNow: () => fromScale + (1 - fromScale) * progress(b) })
}

/** cancel：滚动、移开、被系统打断——从当前大小立刻弹回；否则（正常点按）等按下的动画放完再弹回，保证看得见 */
function release(el, cancel) {
  const h = held.get(el)
  if (!h) return
  held.delete(el)
  if (!held.size) document.removeEventListener('pointermove', onMove, true)
  const a = h.anim
  if (!a) {
    // 只有 .m-pressed（m-hold、或减少动态效果）：同样至少留够按下的时长，样式的过渡才看得出来
    const left = cancel ? 0 : tokens().d1 - (performance.now() - h.t0)
    if (left > 0) setTimeout(() => { if (!held.has(el)) el.classList.remove('m-pressed') }, left)
    else el.classList.remove('m-pressed')
    return
  }
  if (cancel) {
    el.classList.remove('m-pressed')
    const now = pressedNow(h)
    a.cancel()
    springBack(el, h, now, 'snappy')
    return
  }
  const back = () => {
    el.classList.remove('m-pressed')
    a.cancel()
    springBack(el, h, h.scale, h.small ? 'bouncy' : 'snappy')
  }
  if (a.playState === 'finished') back()
  else {
    a.onfinish = back
    // 等的时候又按下了：press() 会先停掉它（之后不会再触发 back）
    releasing.set(el, { anim: a, scaleNow: () => pressedNow(h) })
  }
}

const releaseAll = cancel => { for (const el of [...held.keys()]) release(el, cancel) }

function onDown(e) {
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
  const el = e.target instanceof Element ? e.target.closest(ANY) : null
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('m-off')) return
  press(el, e)
}
function onUp(e) {
  for (const [el, h] of [...held]) if (h.id === e.pointerId) release(el, false)
}
function onMove(e) {
  for (const [el, h] of [...held]) {
    if (h.id === e.pointerId && Math.abs(e.clientX - h.x) + Math.abs(e.clientY - h.y) > SLOP) release(el, true)
  }
}

let installed = false
/** main.js 启动时调一次 */
export function installPress() {
  if (installed || typeof document === 'undefined') return
  installed = true
  const cap = { capture: true, passive: true }
  document.addEventListener('pointerdown', onDown, cap)
  document.addEventListener('pointerup', onUp, cap)
  document.addEventListener('pointercancel', () => releaseAll(true), cap)
  // 任何地方开始滚动（滚动事件不冒泡，捕获阶段能收到所有滚动容器的）
  document.addEventListener('scroll', () => held.size && releaseAll(true), cap)
  document.addEventListener('contextmenu', () => releaseAll(true), cap)
  document.addEventListener('dragstart', () => releaseAll(true), cap)
  document.addEventListener('visibilitychange', () => releaseAll(true))
  window.addEventListener('blur', () => releaseAll(true))
  // iOS Safari 只有挂了 touchstart 监听才会应用 :active 样式：挂一个空的，各处已有的 :active 按压效果在 iPhone 上也生效
  document.addEventListener('touchstart', () => {}, cap)
}

/**
 * 小图标「被选中」时的轻弹（底部导航的图标、点赞后的图标等）：从按下的大小用 bouncy 弹簧弹回原样。
 * 只动 transform；元素上不要同时有 transform 的 transition（会盖住这段动画），需要的话包一层。
 * 返回动画（减少动态效果时为 null）。
 */
export function springIcon(el) {
  if (!el || !el.animate || reducedMotion()) return null
  return el.animate([{ transform: `scale(${tokens().small})` }, { transform: 'scale(1)' }], spring('bouncy'))
}
