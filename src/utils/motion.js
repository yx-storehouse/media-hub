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

/**
 * 程序里的平滑滚动：el.scrollTo({ top, behavior: scrollBehavior() })。减少动态效果时直接跳到位
 * （scrollTo 里显式写 'smooth' 会压过 CSS 的 scroll-behavior: auto）
 */
export const scrollBehavior = () => (reducedMotion() ? 'auto' : 'smooth')

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
 * 是对同一条弹簧曲线（按真实时间）拟合出来的，和 motion.css 开头 :root 里的兜底一字不差（拟合标准和误差见那里）。
 */
export const SPRINGS = Object.freeze({
  snappy: { stiffness: 700, damping: 38, mass: 1, eps: 0.002, fallback: 'cubic-bezier(.31, .36, .16, 1.21)', fallbackMs: 246 },
  smooth: { stiffness: 400, damping: 38, mass: 1, eps: 0.002, fallback: 'cubic-bezier(.23, .15, .19, 1)', fallbackMs: 314 },
  bouncy: { stiffness: 600, damping: 26, mass: 1, eps: 0.004, fallback: 'cubic-bezier(.5, 1.77, .1, .92)', fallbackMs: 382 }
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
 * 不支持 linear() 时，现场给这条带初速度的弹簧拟合一条 cubic-bezier（见 bezierFit），时长按停稳时间等比例缩放。
 */
export function springFrom(name, velocity = 0) {
  const p = SPRINGS[name] || SPRINGS.smooth
  const v = Math.max(-40, Math.min(40, Number(velocity) || 0))
  if (reducedMotion()) return { duration: 1, easing: 'linear' }
  if (Math.abs(v) < 0.05) return { duration: springDuration(name), easing: springEasing(name) }
  if (supportsLinear()) return springLinear({ ...p, velocity: v })
  return springFromFallback(name in SPRINGS ? name : 'smooth', p, v)
}

/*
 * ---- springFrom 的兜底：给带初速度的弹簧现场拟合 cubic-bezier ----
 * 旧做法（固定 x1 = x2 = .25、只按速度改 y1）在松手的头 100ms 里和弹簧差 10%–30%：甩出去的弹层先「顿」一下才走，
 * 往下拉着松手时又多冲出去一截才回来。
 * 做法：时长 D = 这条弹簧停稳的时间 × (兜底时长 / 静止起步时的停稳时间)（和命名弹簧的兜底同一个比例）；
 * 在 0..D 上取 23 个点，x1 / x2 固定时 y1 / y2 是线性最小二乘（2×2 方程），x1 / x2 先粗网格再四轮细化。
 * 弹簧本身不过冲时 y2 卡在 1 以内（不凭空多出一个过冲）。速度 ±10 以内位置误差 RMS ≤ 1.1%、最大 ≤ 2.7%
 * （旧做法 RMS 最高 15%、最大 30%）；按速度（保留两位小数）缓存。只在松手那一下算一次：CPU 降速 4 倍时第一次约 4ms
 * （还没被 JIT 编译），之后 1ms 左右，和支持 linear() 时现算 springLinear 差不多。
 */
const fromCache = new Map()
function springFromFallback(name, p, v) {
  const key = `${name}|${v.toFixed(2)}`
  let s = fromCache.get(key)
  if (s) return s
  const f = springAt({ ...p, velocity: v })
  const T = settleMs({ ...p, velocity: v })
  let T0 = fromCache.get(name)
  if (!T0) fromCache.set(name, T0 = settleMs(p))
  const D = Math.max(60, Math.round(T * p.fallbackMs / T0))
  let peak = 0
  for (let ms = 0; ms < T; ms += 2) peak = Math.max(peak, f(ms / 1000))
  const b = bezierFit(x => f(x * D / 1000), peak <= 1.002)
  s = { duration: D, easing: `cubic-bezier(${+b.x1.toFixed(3)}, ${+b.y1.toFixed(3)}, ${+b.x2.toFixed(3)}, ${+b.y2.toFixed(3)})` }
  if (fromCache.size > 64) { fromCache.clear(); fromCache.set(name, T0) }
  fromCache.set(key, s)
  return s
}

/*
 * 停稳时间（毫秒），和 springLinear 同一个判据（之后一直离终点不到 eps）。欠阻尼时包络 √(1+b²)·e^(−ζω₀t)
 * 小于 eps 以后肯定已经停稳，只扫到那里（三四百次，不用扫满 3 秒）。
 */
function settleMs(q) {
  const g = springAt(q)
  const m = q.mass || 1
  const w0 = Math.sqrt(q.stiffness / m)
  const z = q.damping / (2 * Math.sqrt(q.stiffness * m))
  let max = 3000
  if (z < 1) {
    const b = (z * w0 - (q.velocity || 0)) / (w0 * Math.sqrt(1 - z * z))
    max = Math.min(max, Math.ceil(Math.log(Math.hypot(1, b) / q.eps) / (z * w0) * 1000) + 1)
  }
  let last = 0
  for (let ms = 0; ms <= max; ms++) if (Math.abs(1 - g(ms / 1000)) >= q.eps) last = ms
  return last + 1
}

/**
 * 给 0→1 的曲线 y = target(x)（x、y 都是 0..1 的进度）找最接近的 cubic-bezier(x1, y1, x2, y2)。
 * noOver：y2 不超过 1（目标曲线不过冲时用）。返回 { x1, y1, x2, y2 }。
 */
function bezierFit(target, noOver) {
  const N = 24
  const xs = []
  const ys = []
  for (let i = 1; i < N; i++) { xs.push(i / N); ys.push(target(i / N)) }
  // 解 x(s) = x：牛顿法，不收敛时二分
  const param = (cx, bx, ax, x) => {
    let s = x
    for (let k = 0; k < 8; k++) {
      const e = ((ax * s + bx) * s + cx) * s - x
      const d = (3 * ax * s + 2 * bx) * s + cx
      if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break
      s -= e / d
    }
    if (!(s >= 0 && s <= 1)) {
      let lo = 0, hi = 1
      for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (((ax * mid + bx) * mid + cx) * mid < x) lo = mid; else hi = mid }
      s = (lo + hi) / 2
    }
    return s
  }
  // y(s) = 3(1-s)²s·y1 + 3(1-s)s²·y2 + s³：x1 / x2 定了以后对 y1 / y2 是线性的
  const fit = (x1, x2) => {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
    let aa = 0, ab = 0, bb = 0, ar = 0, br = 0, rr = 0
    for (let i = 0; i < xs.length; i++) {
      const s = param(cx, bx, ax, xs[i]), u = 1 - s
      const a = 3 * u * u * s, b = 3 * u * s * s, r = ys[i] - s * s * s
      aa += a * a; ab += a * b; bb += b * b; ar += a * r; br += b * r; rr += r * r
    }
    const det = aa * bb - ab * ab
    let y1 = det ? (ar * bb - br * ab) / det : 0
    let y2 = det ? (aa * br - ab * ar) / det : 1
    if (noOver && y2 > 1) { y2 = 1; y1 = aa ? (ar - ab) / aa : 0 }
    y1 = Math.max(-3, Math.min(4, y1))
    y2 = Math.max(-1, Math.min(3, y2))
    // 残差平方和 |A·y − r|²，用上面的累加量直接算
    const e = y1 * y1 * aa + 2 * y1 * y2 * ab + y2 * y2 * bb - 2 * (y1 * ar + y2 * br) + rr
    return { x1, y1, x2, y2, e }
  }
  let best = null
  for (let x1 = 0.06; x1 < 0.62; x1 += 0.1) {
    for (let x2 = 0; x2 < 0.62; x2 += 0.1) { const r = fit(x1, x2); if (!best || r.e < best.e) best = r }
  }
  for (const step of [0.05, 0.025, 0.0125, 0.006]) {
    const c = best
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        if (i || j) {
          const r = fit(Math.min(1, Math.max(0.01, c.x1 + i * step)), Math.min(1, Math.max(0, c.x2 + j * step)))
          if (r.e < best.e) best = r
        }
      }
    }
  }
  return best
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
