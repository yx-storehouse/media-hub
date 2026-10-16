/*
 * 动效小工具：和 src/styles/motion.css 配套。
 *
 *   import { reducedMotion, haptic, spring } from '@/utils/motion'
 *   if (!reducedMotion()) el.animate(frames, spring('snappy'))   // { duration, easing }：弹簧的时长 + 曲线
 *   haptic()        // 点赞等「确认」类操作的轻微震动（只有支持的安卓设备会震）
 *
 * 弹簧怎么选（和 CSS 的 --spring-* 是同一组曲线，说明见 motion.css 开头）：
 *   snappy  手指碰到的 UI 反馈：按压回弹、开关、指示条、小位移
 *   smooth  大面积的面：弹层、提示条、面板，几乎不过冲
 *   bouncy  小的「庆祝」元素：点赞、选中的图标、角标，看得出回弹
 */

const mq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null

/** 系统是否开了「减少动态效果」（实时读取，用户中途改设置也能跟上） */
export const reducedMotion = () => !!mq?.matches

/** 轻微震动反馈；不支持、或开了减少动态效果时什么都不做 */
export function haptic(ms = 8) {
  if (reducedMotion()) return
  try { navigator.vibrate?.(ms) } catch { /* 部分浏览器在没有用户手势时会抛错，忽略 */ }
}

/**
 * CSS 时长值 → 毫秒：'120ms' → 120，'.12s' → 120，没单位按毫秒算；读不出来用 fallback。
 * 打包时 CSS 压缩会把 120ms 改写成 .12s（开发时读到的是 120ms），读 CSS 时长变量一律经过它。
 */
export function parseMs(v, fallback) {
  const s = String(v ?? '').trim()
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return fallback
  if (/ms$/i.test(s)) return n
  if (/s$/i.test(s)) return n * 1000
  return n
}

/** 读 CSS 里的时长变量（毫秒），给 JS 动画（element.animate）用，保证和样式一致 */
export function cssDuration(name = '--dur-3', fallback = 280) {
  if (reducedMotion()) return 1
  return parseMs(getComputedStyle(document.documentElement).getPropertyValue(name), fallback)
}

/** 读 CSS 里的缓动变量，给 element.animate 的 easing 用 */
export function cssEasing(name = '--ease-out', fallback = 'cubic-bezier(.22, 1, .36, 1)') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/*
 * ---------- 层级（和 motion.css 的 --z-* 一致，JS 里放浮层时用） ----------
 * 页面本身不设层级；转场时盖在上面的那一页是 pageTop，共享元素飞过去的那一层是 hero。
 */
export const Z = Object.freeze({
  tabbar: 30,      // 底部导航
  pageTop: 40,     // 转场时盖在上面的页面（压过底部导航）
  hero: 45,        // 共享元素过渡的浮层（盖过转场中的页面，在全屏播放、弹层之下）
  fullscreen: 50,  // 播放器的页面内「伪全屏」
  mask: 60,        // 弹层遮罩
  sheet: 61,       // 底部弹层
  viewer: 70,      // 看大图
  toast: 80        // 提示条
})

/* ---------- 弹簧 ---------- */

/*
 * 阻尼弹簧（质量 mass、刚度 stiffness、阻尼 damping），从 0 走到 1，初速度 velocity（每秒走完全程的多少倍，
 * 往终点为正）。阻尼比 ζ = damping / (2·√(stiffness·mass))：小于 1 会过冲再回来，等于 1 刚好不过冲。
 * eps：和终点的差小于它（并且之后一直小于它）就算停稳，曲线就截到这里。
 *
 * fallback / fallbackMs：浏览器不支持 CSS linear()（iOS 17.2、Chrome 113 以前）时用的 cubic-bezier 和时长，
 * 是对同一条弹簧曲线拟合出来的（只能有一个过冲的峰，弹不出第二下）。
 */
export const SPRINGS = Object.freeze({
  snappy: { stiffness: 700, damping: 38, mass: 1, eps: 0.002, fallback: 'cubic-bezier(.29, .32, .11, 1.26)', fallbackMs: 270 },
  smooth: { stiffness: 400, damping: 38, mass: 1, eps: 0.002, fallback: 'cubic-bezier(.23, .15, .18, 1.02)', fallbackMs: 320 },
  bouncy: { stiffness: 600, damping: 26, mass: 1, eps: 0.004, fallback: 'cubic-bezier(.45, 1.2, .01, 1.19)', fallbackMs: 360 }
})

/** 弹簧在 t 秒时的进度 */
export function springAt({ stiffness: k, damping: c, mass: m = 1, velocity: v0 = 0 }) {
  const w0 = Math.sqrt(k / m)
  const z = c / (2 * Math.sqrt(k * m))
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z)
    const b = (z * w0 - v0) / wd
    return t => 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + b * Math.sin(wd * t))
  }
  if (z === 1) return t => 1 - Math.exp(-w0 * t) * (1 + (w0 - v0) * t)
  const wh = w0 * Math.sqrt(z * z - 1)
  const r1 = -z * w0 + wh
  const r2 = -z * w0 - wh
  const c1 = (v0 + r2) / (r1 - r2)
  return t => 1 + c1 * Math.exp(r1 * t) + (-1 - c1) * Math.exp(r2 * t)
}

/*
 * 弹簧曲线 → CSS linear()：先按 1ms 取点，再用 Ramer–Douglas–Peucker 只留下拐弯处的点（误差不超过 0.1%），
 * 一条曲线二三十个点。返回 { duration（毫秒，停稳的时间）, easing: 'linear(…)' }。
 */
export function springLinear(params, eps = params.eps ?? 0.002) {
  const f = springAt(params)
  const MAX = 3000
  const ys = []
  let last = 0
  for (let ms = 0; ms <= MAX; ms++) {
    const y = f(ms / 1000)
    ys.push(y)
    if (Math.abs(1 - y) >= eps) last = ms
  }
  const n = Math.min(MAX, last + 1)
  const pts = ys.slice(0, n + 1)
  pts[n] = 1
  // RDP：保留首尾，递归找离连线最远的点
  const keep = new Uint8Array(n + 1)
  keep[0] = keep[n] = 1
  const stack = [[0, n]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let worst = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const lin = pts[a] + (pts[b] - pts[a]) * (i - a) / (b - a)
      const d = Math.abs(pts[i] - lin)
      if (d > worst) { worst = d; at = i }
    }
    if (worst > 0.001) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  const out = []
  for (let i = 0; i <= n; i++) {
    if (!keep[i]) continue
    const y = i === 0 ? '0' : i === n ? '1' : String(+pts[i].toFixed(4))
    out.push(i === 0 || i === n ? y : `${y} ${+(i / n * 100).toFixed(2)}%`)
  }
  return { duration: n, easing: `linear(${out.join(', ')})` }
}

let linearOk = null
/** 浏览器支不支持 CSS 的 linear() 缓动（只查一次） */
export function supportsLinear() {
  if (linearOk === null) {
    try { linearOk = typeof CSS !== 'undefined' && !!CSS.supports?.('transition-timing-function', 'linear(0, 1)') } catch { linearOk = false }
  }
  return linearOk
}

const cache = new Map()
function named(name) {
  let s = cache.get(name)
  if (s) return s
  const p = SPRINGS[name] || SPRINGS.snappy
  s = supportsLinear() ? springLinear(p) : { duration: p.fallbackMs, easing: p.fallback }
  cache.set(name, s)
  return s
}

/** 弹簧曲线（给 element.animate / 行内 transition 用）：支持 linear() 时是真弹簧，否则是拟合的 cubic-bezier */
export const springEasing = name => named(name).easing

/** 和 springEasing(name) 配对的时长（毫秒）；减少动态效果时是 1 */
export const springDuration = name => (reducedMotion() ? 1 : named(name).duration)

/** el.animate(frames, spring('snappy')) / spring('bouncy', { delay: 40 })：时长和曲线一起给 */
export function spring(name = 'snappy', extra = {}) {
  return { duration: springDuration(name), easing: springEasing(name), ...extra }
}

/**
 * 带初速度的弹簧（松手接着手指的速度走）：velocity 是每秒走完全程的多少倍，往终点为正、背离终点为负。
 *   // 弹层松手弹回：还差 dy 像素，手指正以 v 像素/毫秒往下（背离原位）走
 *   const { duration, easing } = springFrom('smooth', -v * 1000 / dy)
 * 不支持 linear() 时用一条起始斜率和速度对上的 cubic-bezier（时长取这种弹簧的兜底时长）。
 */
export function springFrom(name, velocity = 0) {
  const p = SPRINGS[name] || SPRINGS.smooth
  const v = Math.max(-40, Math.min(40, Number(velocity) || 0))
  if (reducedMotion()) return { duration: 1, easing: 'linear' }
  if (Math.abs(v) < 0.05) return { duration: springDuration(name), easing: springEasing(name) }
  if (supportsLinear()) return springLinear({ ...p, velocity: v })
  // cubic-bezier 的起始斜率是 y1 / x1；时长 D 内走完全程，速度 v（每秒）对应斜率 v·D/1000
  const D = p.fallbackMs
  const x1 = 0.25
  const y1 = Math.max(-1, Math.min(2, x1 * v * D / 1000))
  return { duration: D, easing: `cubic-bezier(${x1}, ${+y1.toFixed(3)}, .25, 1)` }
}

/**
 * 左右摇一摇（输错密码、操作不成立）：一段很快衰减的振荡，像被弹簧拉回原位，约 0.45 秒。只动 translateX，
 * 元素上不要同时有 transform 的过渡。返回动画；减少动态效果时不动（返回 null），错误信息照常显示。
 */
export function shake(el, amp = 10) {
  if (!el?.animate || reducedMotion()) return null
  const D = 450
  const N = 24
  const z = 0.22                 // 阻尼比：来回三下左右就停
  const w = 2 * Math.PI * 4.4    // 每秒约 4.4 个来回
  const wd = w * Math.sqrt(1 - z * z)
  const frames = []
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * D / 1000
    const x = i === N ? 0 : amp * Math.exp(-z * w * t) * Math.sin(wd * t)
    frames.push({ transform: `translate3d(${x.toFixed(2)}px, 0, 0)` })
  }
  return el.animate(frames, { duration: D, easing: 'linear' })
}

/** 生成 motion.css 里 @supports (linear) 那一段（改了 SPRINGS 的参数后用，见 motion.css 开头） */
export function springCss() {
  return Object.entries(SPRINGS).map(([name, p]) => {
    const s = springLinear(p)
    return `    --spring-${name}: ${s.easing};\n    --dur-spring-${name}: ${s.duration}ms;`
  }).join('\n')
}
