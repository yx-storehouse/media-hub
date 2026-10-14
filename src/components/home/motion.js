import { watch, onMounted, onActivated, onBeforeUnmount } from 'vue'
import { reducedMotion } from '@/utils/motion'

/*
 * 内容页（首页、社区、帖子、创作者、搜索、专题、我的）共用的动效小工具，时长 / 缓动都取 src/styles/motion.css 的令牌。
 *
 * 一次性的动画都用 Web Animations（element.animate）：不留 class、不改样式，所以
 *   - 页面被 KeepAlive 收起再回来不会重播（CSS animation 在元素重新挂回文档时会从头再播一遍）；
 *   - 按返回回到一页时，用 cameBack() 让这一刻恢复出来的内容不播入场；
 *   - 系统开了「减少动态效果」时直接不动。
 * 入场只动 transform / opacity，不拦点击；动画期间照样可以点、可以滑。
 */

/* ---------- 返回到这一页：恢复出来的内容不播入场 ---------- */

let quiet = 0

/**
 * 在页面 setup 里调：这一页是不是按返回回来的（history.state.forward 有值，和各页的「返回恢复」同一个判断）。
 * 是的话，这一刻同步挂上的内容（恢复的列表、帖子卡片）都不播入场；之后新取到的内容照常播。
 * 返回值给页面自己用（比如之后才取回的热门词也不播）。
 */
export function cameBack() {
  const back = !!window.history.state?.forward
  if (back) {
    quiet++
    setTimeout(() => { quiet-- })
  }
  return back
}

/** 现在能不能播入场动画 */
export const canEnter = () => !quiet && !reducedMotion()

/* ---------- 动效令牌（读一次缓存起来） ---------- */

/*
 * 读 CSS 变量要 getComputedStyle：页面刚插入一批新元素、样式还没算时，每读一次都会逼浏览器当场把样式算一遍。
 * 动画都是在挂载 / 点按的那一刻排的，正是样式最「脏」的时候，所以令牌只在第一次用到时读一次。
 * 「减少动态效果」时 motion.css 把令牌收成 1ms，这时读到的不缓存（用的地方本来也直接不动）。
 */
const TOKENS = {
  '--dur-1': 120, '--dur-2': 200, '--dur-3': 280, '--dur-4': 380, '--stagger': 40, '--rise': 10,
  '--ease-out': 'cubic-bezier(.22, 1, .36, 1)',
  '--ease-in': 'cubic-bezier(.55, 0, 1, .45)',
  '--ease-in-out': 'cubic-bezier(.65, 0, .35, 1)',
  '--ease-spring': 'cubic-bezier(.34, 1.56, .64, 1)'
}
let cached = null
function tokens() {
  if (cached) return cached
  const cs = getComputedStyle(document.documentElement)
  const t = {}
  for (const [name, fallback] of Object.entries(TOKENS)) {
    const v = cs.getPropertyValue(name).trim()
    if (typeof fallback === 'number') {
      const n = parseFloat(v)
      t[name] = Number.isFinite(n) ? n : fallback
    } else t[name] = v || fallback
  }
  if (!reducedMotion()) cached = t
  return t
}
/** 时长令牌（毫秒），给 element.animate 用；减少动态效果时是 1 */
export const dur = name => (reducedMotion() ? 1 : tokens()[name])
/** 缓动令牌 */
export const ease = name => tokens()[name]

/* ---------- 入场：错峰从下往上浮现 ---------- */

/* 一次最多动这么多个：列表刚出来时一屏大概就是这些，后面的在屏幕外，直接出现（高的卡片传更小的 max） */
const RISE_MAX = 10

/**
 * 一组元素错峰淡入、从下往上浮一点（--rise）。只动前 max（默认 10）个；错峰只排前 8 个，后面的和第 8 个一起。
 * 不读元素位置（不强制排版），新内容挂上的这一刻就把动画排好，第一帧就是起始状态，不会闪一下。
 *   rise(grid.children)
 *   rise([el], { scale: .96 })      // 再带一点缩放（瓷砖、头图）
 *   rise(els, { y: 0 })             // 只淡入
 * 返回创建的动画（可能为空数组）。
 */
export function rise(list, { y = null, scale = 1, delay = 0, dur: d = '--dur-3', max = RISE_MAX } = {}) {
  if (!list || !canEnter()) return []
  const els = [...list].filter(el => el instanceof Element).slice(0, max)
  if (!els.length) return []
  const dy = y ?? tokens()['--rise']
  const step = dur('--stagger')
  const duration = dur(d)
  const easing = ease('--ease-out')
  const from = { opacity: 0, transform: `translate3d(0, ${dy}px, 0)${scale !== 1 ? ` scale(${scale})` : ''}` }
  const to = { opacity: 1, transform: 'none' }
  return els.map((el, i) => el.animate([from, to], { duration, easing, delay: delay + Math.min(i, 7) * step, fill: 'backwards' }))
}

/**
 * v-rise：元素第一次挂上时，子元素错峰浮现一次（.self：只动自己）。值为 false 时不动；
 * 值是对象时当作 rise() 的参数。挂上以后不会再播（KeepAlive 收起再回来也不会）。
 *   <div v-rise class="grid">…</div>
 *   <div v-rise.self="!calm" class="empty">…</div>
 */
export const vRise = {
  mounted(el, { value, modifiers }) {
    if (value === false) return
    rise(modifiers.self ? [el] : el.children, value && typeof value === 'object' ? value : {})
  }
}

/** 淡入（x 不为 0 时再从那一侧滑进来一点）：切标签时新显示的一栏、换分类时新的分类页用 */
export function fadeIn(el, { dur: d = '--dur-2', x = 0 } = {}) {
  if (!el || reducedMotion()) return null
  const from = x ? { opacity: 0, transform: `translate3d(${x}px, 0, 0)` } : { opacity: 0 }
  const to = x ? { opacity: 1, transform: 'none' } : { opacity: 1 }
  return el.animate([from, to], { duration: dur(d), easing: ease('--ease-out') })
}

/**
 * 一组元素错峰淡出（清空、整体移除前；间隔取 --stagger 的一半，离场比进场快）：动画停在最后一帧（fill: forwards），
 * 真正的移除失败要放回来时，对返回的动画逐个 cancel() 就恢复原样。
 */
export function leave(list, { y = 0, scale = 0.92, gap = dur('--stagger') / 2 } = {}) {
  if (!list || reducedMotion()) return []
  const els = [...list].filter(el => el instanceof Element)
  const duration = dur('--dur-2')
  const easing = ease('--ease-in')
  const to = { opacity: 0, transform: `translate3d(0, ${y}px, 0) scale(${scale})` }
  return els.map((el, i) => el.animate([{ opacity: 1, transform: 'none' }, to], { duration, easing, delay: Math.min(i, 7) * gap, fill: 'forwards' }))
}

/* ---------- 点亮 / 熄掉的小图标（和短视频右侧按钮同一套） ---------- */

/** 点亮：先缩一下再回弹放大；熄掉：轻轻一缩。el 是图标本身（外层留给按压缩放） */
export function pop(el, on = true) {
  if (!el || reducedMotion()) return
  const frames = on
    ? [{ transform: 'scale(.6)' }, { transform: 'scale(1.22)', offset: 0.5 }, { transform: 'scale(1)' }]
    : [{ transform: 'scale(1)' }, { transform: 'scale(.82)', offset: 0.5 }, { transform: 'scale(1)' }]
  el.animate(frames, { duration: dur(on ? '--dur-3' : '--dur-2'), easing: ease('--ease-out') })
}

/* ---------- 跟着选中项滑动的块：标签指示条、筛选胶囊的高亮底 ---------- */

/* 元素相对容器内容左边的位置：沿 offsetParent 链加到容器为止（容器要有定位），不受页面过渡的 transform 影响 */
function offsetIn(box, el) {
  let x = 0
  for (let n = el; n && n !== box; n = n.offsetParent) x += n.offsetLeft
  return { x, w: el.offsetWidth }
}

/** 选中项正下方、固定宽 w 的指示条 */
export const under = (sel, w) => box => {
  const el = box.querySelector(sel)
  if (!el) return null
  const r = offsetIn(box, el)
  return { x: r.x + r.w / 2 - w / 2, w }
}

/** 和选中项一样宽（左右再各放 pad）的块：胶囊底、跟着文字宽度的指示条 */
export const cover = (sel, pad = 0) => box => {
  const el = box.querySelector(sel)
  if (!el) return null
  const r = offsetIn(box, el)
  return { x: r.x - pad, w: r.w + pad * 2 }
}

/**
 * 滑块（bar）放在容器（box）里、绝对定位在 left: 0（transform-origin: 0 0），位置和宽度由这里放。
 * 选中项变了：从旧位置滑过去，途中先拉长再收拢（前沿先到、后沿跟上，像被拽过去）；滑到一半再点，从当前看到的位置接着滑。
 * 布局变了（数字变宽、转屏）直接贴过去；KeepAlive 收起再回来直接放好，不重播。
 *
 *   const box = ref(null), bar = ref(null)
 *   useSlider(box, bar, under('.tab.on', 27), { key: () => tab.value })
 *
 * opts.key：选中项（变了就滑）；opts.deps：会改变布局的数据（变了就重新贴位置，不动画）；
 * opts.dur：时长令牌。容器加上 data-slider 属性后，样式里可以去掉选中项自己的底色（交给滑块）。
 *
 * 量位置要读排版：点按的那一刻新内容刚挂上、排版还没算，当场读会逼浏览器多排一遍，几个滑块轮流读写还会来回排。
 * 所以都攒到下一帧开头（requestAnimationFrame，在这一帧画出来之前）一起做：先把所有滑块要量的量完，再统一写样式。
 * 尺寸变化（ResizeObserver，排版刚算完）直接贴过去。
 */
const pending = new Map() // 待同步的滑块 → 这次要不要动画
let frame = 0
function schedule(slider, animate) {
  pending.set(slider, pending.get(slider) || animate)
  if (!frame) frame = requestAnimationFrame(flushSliders)
}
function flushSliders() {
  frame = 0
  const jobs = [...pending]
  pending.clear()
  for (const write of jobs.map(([slider, animate]) => slider.read(animate, true))) write?.()
}

export function useSlider(box, bar, measure, { key, deps, dur: d = '--dur-2', stretch = true } = {}) {
  let at = null
  let anim = null
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => slider.read(false, false)?.()) : null

  /* 读：量出目标位置（和滑到一半时现在的位置），返回写样式的函数；不用动时返回 null */
  function read(animate, observe) {
    const b = box.value
    const el = bar.value
    if (!b || !el || !b.isConnected || !b.clientWidth) return null
    if (observe && ro) {
      // 容器和每一项的尺寸变了都要跟上（前面的项变宽，选中项的位置也跟着变）
      ro.disconnect()
      ro.observe(b)
      for (const c of b.children) if (c !== el) ro.observe(c)
    }
    const t = measure(b)
    if (!t || !t.w) {
      return () => {
        anim?.cancel()
        anim = null
        at = null
        el.style.opacity = '0'
      }
    }
    if (at && Math.abs(t.x - at.x) < 0.5 && Math.abs(t.w - at.w) < 0.5) return null
    let from = animate ? at : null
    // 还在滑：从当前看到的位置（含拉长）接着滑到新位置
    if (anim) {
      const m = new DOMMatrix(getComputedStyle(el).transform)
      from = { x: m.m41, w: at.w * m.a }
    }
    return () => write(b, el, t, from)
  }

  function write(b, el, t, from) {
    anim?.cancel()
    anim = null
    if (!('slider' in b.dataset)) b.dataset.slider = ''
    el.style.width = `${t.w}px`
    el.style.transform = `translate3d(${t.x}px, 0, 0)`
    el.style.opacity = '1'
    at = t
    if (!from || reducedMotion()) return
    const frames = [{ transform: `translate3d(${from.x}px, 0, 0) scaleX(${from.w / t.w})` }]
    if (stretch && Math.abs(t.x - from.x) > 1) {
      // 中途：前沿走了 60% 的路、后沿落后同样多（中点不变）；跨好几个标签时拉长有上限（约 1.5 个滑块宽），
      // 不会变成一长条扫过去
      const dist = Math.abs(t.x + t.w / 2 - (from.x + from.w / 2))
      const w = (from.w + t.w) / 2 + Math.min(dist * 0.6, Math.max(from.w, t.w) * 1.5)
      const mid = (from.x + from.w / 2 + t.x + t.w / 2) / 2
      frames.push({ offset: 0.5, transform: `translate3d(${mid - w / 2}px, 0, 0) scaleX(${w / t.w})` })
    }
    frames.push({ transform: `translate3d(${t.x}px, 0, 0)` })
    const a = el.animate(frames, { duration: dur(d), easing: ease('--ease-in-out') })
    a.onfinish = () => { if (anim === a) anim = null }
    anim = a
  }

  const slider = { read }
  const sync = (animate = false) => schedule(slider, animate)
  if (key) watch(key, () => sync(true), { flush: 'post' })
  if (deps) watch(deps, () => sync(false), { flush: 'post' })
  watch([box, bar], () => sync(false), { flush: 'post' })
  onMounted(() => sync(false))
  onActivated(() => sync(false))
  onBeforeUnmount(() => {
    pending.delete(slider)
    ro?.disconnect()
    anim?.cancel()
  })
  return { sync }
}

/* ---------- 数字 ---------- */

/** CSS 的 cubic-bezier(...) 令牌变成 JS 函数（逐帧算数字时和 CSS 用同一条曲线） */
export function easing(name = '--ease-out') {
  const m = ease(name).match(/cubic-bezier\(([^)]+)\)/)
  const [x1, y1, x2, y2] = m ? m[1].split(',').map(Number) : [0.22, 1, 0.36, 1]
  const bez = (a, b2, t) => 3 * a * (1 - t) * (1 - t) * t + 3 * b2 * (1 - t) * t * t + t * t * t
  return x => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    // 二分求 t，使 bez(x1, x2, t) = x
    let lo = 0
    let hi = 1
    let t = x
    for (let i = 0; i < 20; i++) {
      const v = bez(x1, x2, t)
      if (Math.abs(v - x) < 1e-4) break
      if (v < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return bez(y1, y2, t)
  }
}

/** 数字从 from 数到 to（textContent），减少动态效果时直接显示 */
export function countUp(el, to, { from = 0, dur: d = '--dur-4' } = {}) {
  if (!el) return
  cancelAnimationFrame(el._countRaf)
  if (reducedMotion() || to === from) {
    el.textContent = String(to)
    return
  }
  const ms = dur(d)
  const curve = easing('--ease-out')
  const t0 = performance.now()
  const step = now => {
    const p = Math.min(1, (now - t0) / ms)
    el.textContent = String(Math.round(from + (to - from) * curve(p)))
    if (p < 1) el._countRaf = requestAnimationFrame(step)
  }
  el.textContent = String(from)
  el._countRaf = requestAnimationFrame(step)
}

/* ---------- 列表项离场 ---------- */

/**
 * 离场前把元素钉在原位（配合 *-leave-active 的 position: absolute），后面的项才能平滑补位。
 * 用在 flex-wrap / grid 里（块级列表直接 position: absolute; left: 0; right: 0 就行）；容器要有定位。
 *   <TransitionGroup name="m-chip" @before-leave="pin">
 */
export function pin(el) {
  const { offsetLeft: x, offsetTop: y, offsetWidth: w, offsetHeight: h } = el
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  el.style.width = `${w}px`
  el.style.height = `${h}px`
}
