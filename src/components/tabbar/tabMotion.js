import { SPRINGS, reducedMotion, supportsLinear, parseMs } from '@/utils/motion'

/*
 * 底部导航的动效引擎（TabBar.vue 用）。
 *
 * 原则
 *  - DOM 上的 class（.on）和 --i 永远是「静止状态」的唯一来源；动画只是盖在上面的 Web Animations，
 *    默认不留 fill，放完自然露出 class 决定的样子。所以首帧、从子页面回来、减少动态效果都直接是对的，
 *    被打断、被取消也一定停在正确状态。例外只有两个「按住」状态：图标按下去的 .88（写在行内）和光点朝手指探身
 *    （fill: forwards），都会被下一段运动接走。
 *  - 一个元素同时只有一个动画（transform 和 opacity 写在同一组关键帧里），新动画开始前先取消旧的。
 *  - 被打断时不读排版、不读计算样式：每段运动都是解析式（弹簧 / 补间）或积分表，用 animation.currentTime
 *    算出屏幕上这一帧的值和速度，带着速度接着走。
 *  - 弹簧全部来自 utils/motion.js 的 SPRINGS（和 CSS 的 --spring-* 同一组），时长、曲线、按压缩放取自 motion.css 的令牌：
 *      按下      --press-scale-sm（.88），--dur-1 + --ease-out（和其它小图标按钮 m-press-sm 一样）
 *      松手选中  bouncy：冲到 1.017 再落定；实心图标从中心长出来 snappy；光点 smooth（和 Tab 内容滑入 pg-tab 同一根）
 *      划走取消  snappy，几乎不过冲，安静地回去
 *  - 渐进增强：支持 CSS linear() 的引擎（Chrome 113+、iOS 17.2+）把「只有一根弹簧在动」写成两个关键帧 + 现算的 linear()；
 *    其余情况（几个分量一起动，或 iOS 14–17.1、Chrome 87–112）按 60Hz 采样成关键帧，是同一条运动。
 *  - 只动 transform / opacity；不加 will-change（WAAPI 动画期间浏览器自己提层，放完撤掉）。
 *  - 光点的位置全部用「格」的百分比（一格宽的元素，translateX(n·100%) 就是 n 格）：320 / 390、转屏、分屏都不用量尺寸，
 *    飞到一半改了宽度也照样落在对的格子上。
 */

const N_TABS = 6
const HZ = 60          // 不支持 linear() 时，弹簧按 60Hz 采样成关键帧（帧间线性插值，120Hz 屏也平滑）
const EPS = 0.004      // 缩放 / 透明度停下的阈值：22px 的图标上不到 0.1px
const DIM_TO = 0.7     // 切换的一瞬其余几格轻轻暗到这里（400ms 内亮回来）
const HOP_V = 185      // 再点一次的起跳速度（px/s，向上）：bouncy 下最高约 4px
const BLOOM = 25       // 再点一次光点「呼吸」的速度冲量：放大到约 1.54 倍再落回
const LEAN = 0.08      // 按住别的 Tab 时光点前沿朝那边伸出 0.08 格（390 宽约 5px），后沿不动
const FILL_KNOT = 0.6  // 实心图标的分量 p 到 .6 时已经完全不透明（关键帧在这里多放一个拐点）

/* ---- 弹簧参数（质量 1 的 k 刚度 / c 阻尼）---- */
const kc = p => ({ k: p.stiffness / (p.mass || 1), c: p.damping / (p.mass || 1) })
const SP = {
  snappy: kc(SPRINGS.snappy), // 手指碰到的反馈：实心长出来、描边撑回、划走取消、光点探身收回
  smooth: kc(SPRINGS.smooth), // 光点滑过去：不过冲（长跳 5 格时 snappy 会冲过头 12px）
  bouncy: kc(SPRINGS.bouncy)  // 选中的图标弹起、再点一次的轻跳 / 呼吸：看得出回弹一下
}

/* ---- 三次贝塞尔（和 CSS 同一条曲线，算打断时的当前值用）---- */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = t => ((ax * t + bx) * t + cx) * t
  const sy = t => ((ay * t + by) * t + cy) * t
  const dx = t => (3 * ax * t + 2 * bx) * t + cx
  return x => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x
      if (Math.abs(e) < 1e-6) return sy(t)
      const d = dx(t)
      if (Math.abs(d) < 1e-6) break
      t -= e / d
    }
    let lo = 0, hi = 1
    t = x
    for (let i = 0; i < 30; i++) {
      const v = sx(t)
      if (Math.abs(v - x) < 1e-6) break
      if (v < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return sy(t)
  }
}

/*
 * ---- 动效令牌：第一次真正要动的时候读一次 CSS 变量（不在每次点按时读样式）----
 * 减少动态效果时不读（那时时长都是 1ms，读了就被缓存住）；系统设置变了就作废重读（resetTokens）。
 */
let TOK = null
function tok() {
  if (TOK) return TOK
  const cs = getComputedStyle(document.documentElement)
  // 时长按单位换算（打包后的 CSS 里 120ms 会被压成 .12s）
  const ms = (n, d) => { const v = parseMs(cs.getPropertyValue(n), d); return v > 1 ? v : d }
  const num = (n, d) => { const v = parseFloat(cs.getPropertyValue(n)); return Number.isFinite(v) ? v : d }
  const bz = (n, d) => {
    const m = /cubic-bezier\(([^)]+)\)/.exec(cs.getPropertyValue(n))
    const v = m ? m[1].split(',').map(Number) : null
    return v && v.length === 4 && v.every(Number.isFinite) ? v : d
  }
  const out = bz('--ease-out', [0.22, 1, 0.36, 1])
  const inout = bz('--ease-in-out', [0.65, 0, 0.35, 1])
  const t = {
    d1: ms('--dur-1', 120), d2: ms('--dur-2', 200), d3: ms('--dur-3', 280),
    pressSm: num('--press-scale-sm', 0.88),
    curve: { out, inout },
    ease: { out: bezier(...out), inout: bezier(...inout) }
  }
  if (!reducedMotion()) TOK = t
  return t
}
export function resetTokens() { TOK = null }
const css = k => `cubic-bezier(${tok().curve[k].join(', ')})`

/* ---- 运动：[值, 速度] 关于秒的函数；T 是时长（秒），to 是终值 ---- */
function hold(x) { const f = () => [x, 0]; f.T = 0; f.to = x; return f }

/** 阻尼弹簧的解析解（质量 1），从 st = [x0, v0] 走到 to；包络 |A|e^(-ζω₀t) 小于 eps 就算停 */
function spring(p, st, to, eps = EPS) {
  const [x0, v0] = st
  const w0 = Math.sqrt(p.k), z = Math.min(1, p.c / (2 * w0)), A = x0 - to
  let f
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z), B = (v0 + z * w0 * A) / wd
    f = t => {
      const e = Math.exp(-z * w0 * t), co = Math.cos(wd * t), si = Math.sin(wd * t)
      return [to + e * (A * co + B * si), e * ((B * wd - z * w0 * A) * co - (A * wd + z * w0 * B) * si)]
    }
  } else {
    const B = v0 + w0 * A
    f = t => { const e = Math.exp(-w0 * t); return [to + (A + B * t) * e, (B - w0 * (A + B * t)) * e] }
  }
  let T = 0
  if (Math.abs(A) > eps || Math.abs(v0) > eps * 10) {
    if (z < 1) {
      const wd = w0 * Math.sqrt(1 - z * z), B = (v0 + z * w0 * A) / wd
      T = Math.log(Math.hypot(A, B) / eps) / (z * w0)
    } else {
      for (let t = 0.004; t < 1.5; t += 0.004) { const [x, v] = f(t); if (Math.abs(x - to) > eps || Math.abs(v) > eps * 10) T = t + 0.004 }
    }
    T = Math.max(0.016, Math.min(1.5, T))
  }
  f.T = T
  f.to = to
  return f
}

/** 补间：ms 毫秒、CSS 令牌里的曲线（'out' | 'inout'），可带延迟 */
function tween(st, to, ms, curve = 'out', delay = 0) {
  const x0 = st[0], d = ms / 1000, dl = delay / 1000, e = tok().ease[curve]
  const f = t => {
    if (t <= dl) return [x0, 0]
    const p = Math.min(1, (t - dl) / d)
    if (p >= 1) return [to, 0]
    const y = e(p), p2 = Math.min(1, p + 0.002)
    return [x0 + (to - x0) * y, (e(p2) - y) / ((p2 - p) * d) * (to - x0)]
  }
  f.T = Math.abs(to - x0) < 1e-4 ? 0 : dl + d
  f.to = to
  f.tw = { x0, ms, delay, curve }
  return f
}

/** 先到 low 再回到 1（切换时其余 Tab 轻轻暗一下）：inMs 用 --ease-out，outMs 用 --ease-in-out */
function dip(st, low, inMs, outMs) {
  const x0 = st[0], a = inMs / 1000, b = outMs / 1000, E = tok().ease
  const f = t => {
    if (t < a) return [x0 + (low - x0) * E.out(t / a), 0]
    const p = Math.min(1, (t - a) / b)
    return [low + (1 - low) * E.inout(p), 0]
  }
  f.T = a + b
  f.to = 1
  f.kf = { x0, low, inMs, outMs }
  return f
}

/** 先用 ms 毫秒缩到 low，再用弹簧 p 弹回 to（键盘回车时补一个「按一下」：没有手指按下的过程） */
function pulse(st, low, ms, p, to) {
  const a = ms / 1000, x0 = st[0], s = spring(p, [low, 0], to), E = tok().ease
  const f = t => (t < a ? [x0 + (low - x0) * E.out(t / a), 0] : s(t - a))
  f.T = a + s.T
  f.to = to
  return f
}

/** 已经走了 dt 秒的运动，从现在接着走 */
const shift = (f, dt) => {
  if (dt <= 0 || !f.T) return f
  const g = t => f(t + dt)
  g.T = Math.max(0, f.T - dt)
  g.to = f.to
  return g
}

/** 一条运动 f → linear() 曲线（进度 = (值 - from) / (to - from)，等间隔取点；超出 0–1 的部分就是回弹） */
function linearOf(f, from, to, T) {
  const N = Math.max(8, Math.min(40, Math.ceil(T * HZ)))
  const pts = []
  for (let i = 0; i < N; i++) pts.push(+((f(T * i / N)[0] - from) / (to - from)).toFixed(4))
  pts.push(1)
  return `linear(${pts.join(', ')})`
}

const fmt = (x, d = 4) => +x.toFixed(d)
const clamp01 = x => Math.max(0, Math.min(1, x))

/**
 * 一个元素上的一段运动：几个分量（比如缩放 s、位移 y）各自是弹簧 / 补间 / 静止，compose 把分量合成要写的属性。
 * knots：某个分量在这些值上 compose 是折线的拐点（实心图标的透明度在 p = .6 就到 1），两个关键帧的写法要在拐点处多放一个关键帧。
 */
class Channel {
  constructor(el, compose, init, knots = {}) {
    this.el = el
    this.compose = compose
    this.props = Object.keys(compose(init))
    this.knots = knots
    this.m = {}
    for (const n in init) this.m[n] = hold(init[n])
    this.anim = null
  }
  /** 当前这段运动走了多久（秒）：用 WAAPI 自己的时钟，正好是屏幕上这一帧 */
  elapsed() {
    const ct = this.anim ? this.anim.currentTime : null
    return ct == null ? 0 : ct / 1000
  }
  value(n) { return this.m[n](this.elapsed()) }
  /** 是不是正在动（按住的下沉停在 .88 不算） */
  busy() { return !!this.anim && this.anim.playState === 'running' }
  inline(v) {
    const o = v ? this.compose(v) : null
    for (const k of this.props) this.el.style[k] = o ? o[k] : ''
  }
  /** 只有分量 n 从 x0 走到 x1：沿途的关键帧（两端 + 拐点），offset 是进度 */
  path(fin, n, x0, x1) {
    const qs = [0, 1]
    for (const k of this.knots[n] || []) { const q = (k - x0) / (x1 - x0); if (q > 0.001 && q < 0.999) qs.push(q) }
    qs.sort((a, b) => a - b)
    return qs.map(q => ({ offset: q, ...this.compose({ ...fin, [n]: x0 + (x1 - x0) * q }) }))
  }
  /**
   * plan：{ 分量: 当前状态 [值, 速度] → 新运动 }；没写的分量接着原来的运动走。
   * keep：放完停在终值（按住的下沉不是静止状态，写在行内）；其余的终值就是 class 决定的静止状态，行内不写。
   */
  go(plan, { keep = false } = {}) {
    const t = this.elapsed()
    const next = {}
    for (const n in this.m) next[n] = plan[n] ? plan[n](this.m[n](t)) : shift(this.m[n], t)
    this.m = next
    this.anim?.cancel()
    this.anim = null
    const fin = {}
    for (const n in next) fin[n] = next[n].to
    this.inline(keep ? fin : null)
    const T = Math.max(0, ...Object.values(next).map(f => f.T))
    if (!T) {
      for (const n in next) this.m[n] = hold(fin[n])
      return null
    }
    const moving = Object.keys(next).filter(n => next[n].T > 0)
    const one = moving.length === 1 ? moving[0] : null
    const f1 = one && next[one]
    const x0 = one && f1(0)[0]
    let frames, opts
    if (f1 && f1.tw) {
      // 只有一个补间在动：两端（+ 拐点）的关键帧 + 原生 cubic-bezier；延迟期间用 backwards 停在起点
      frames = this.path(fin, one, f1.tw.x0, fin[one])
      opts = { duration: f1.tw.ms, delay: f1.tw.delay, easing: css(f1.tw.curve), fill: 'backwards' }
    } else if (f1 && f1.kf) {
      // 先暗下去再亮回来：三个关键帧，每段自己的曲线
      const { x0: a, low, inMs, outMs } = f1.kf
      frames = [
        { offset: 0, ...this.compose({ ...fin, [one]: a }), easing: css('out') },
        { offset: inMs / (inMs + outMs), ...this.compose({ ...fin, [one]: low }), easing: css('inout') },
        { offset: 1, ...this.compose(fin) }
      ]
      opts = { duration: inMs + outMs, easing: 'linear' }
    } else if (f1 && supportsLinear() && Math.abs(fin[one] - x0) > 0.02) {
      // 只有一根弹簧在动：两端（+ 拐点）的关键帧 + 现算的 linear()
      frames = this.path(fin, one, x0, fin[one])
      opts = { duration: T * 1000, easing: linearOf(f1, x0, fin[one], T) }
    } else {
      // 几个分量一起动（再点一次：缩放 + 上跳），或引擎不支持 linear()：按 60Hz 采样成关键帧
      const N = Math.max(2, Math.ceil(T * HZ))
      frames = []
      for (let i = 0; i <= N; i++) {
        const tt = T * i / N, v = {}
        for (const k in next) v[k] = i === N ? fin[k] : next[k](tt)[0]
        frames.push({ offset: i / N, ...this.compose(v) })
      }
      opts = { duration: T * 1000, easing: 'linear' }
    }
    const anim = this.el.animate(frames, opts)
    this.anim = anim
    anim.onfinish = () => {
      if (this.anim !== anim) return
      if (!keep) this.anim = null
      for (const n in this.m) this.m[n] = hold(this.m[n].to)
    }
    return anim
  }
  /** 不动画，直接回到 class 决定的静止状态 */
  snap(values) {
    this.anim?.cancel()
    this.anim = null
    for (const n in values) this.m[n] = hold(values[n])
    this.inline(null)
  }
}

/* 各层怎么由分量合成 */
const C_PRESS = v => ({ transform: `translate3d(0, ${fmt(v.y, 3)}px, 0) scale(${fmt(v.s)})` })  // 图标外层：按压 + 轻跳
const C_LINE = v => ({ transform: `scale(${fmt(v.s)})`, opacity: String(fmt(clamp01(v.o))) })   // 描边图标
const C_FILL = v => ({ transform: `scale(${fmt(0.45 + 0.55 * v.p)})`, opacity: String(fmt(clamp01(v.p / FILL_KNOT))) }) // 实心图标
const C_OP = v => ({ opacity: String(fmt(clamp01(v.o))) })                                       // 文字、整格
const LABEL_OFF = 0.53 // 白字 .53 叠在 #0a0a0a 上正好是 --t2（#8c8c8c）

/*
 * ---- 光点：中心一根弹簧 + 跟着速度走的拉伸（数值积分，1ms 一个点）----
 * 状态（单位：格）：x 位置、v 速度、s 拉伸、b 端点放大、bv。三块都只用 transform：
 *   .d-a / .d-b  胶囊的左右两端（4px 发光的点），translateX(端点 · 100%) scale(b)
 *   .d-c         中间的桥，translateX(左端 · 100%) scaleX(右端 − 左端)
 */
const DOT = { g: 0.03, smax: 0.5, vdz: 1.2, up: 0.026, down: 0.012, lead: 0.78 }
class Dot {
  constructor(box) {
    this.a = box.querySelector('.d-a')
    this.b = box.querySelector('.d-b')
    this.c = box.querySelector('.d-c')
    this.tr = null
    this.anims = []
    this.rest = 0
    this.leaning = false
  }
  /** 屏幕上这一帧的状态（从积分表里按动画的 currentTime 插值） */
  state() {
    const tr = this.tr
    if (!tr || !this.anims.length) return { x: this.rest, v: 0, s: 0, b: 1, bv: 0 }
    const ct = this.anims[0].currentTime
    const t = Math.min(tr.n - 1, Math.max(0, ct == null ? 0 : ct))
    const i = Math.floor(t), f = t - i, j = Math.min(tr.n - 1, i + 1), D = tr.d
    const g = k => D[i * 5 + k] + (D[j * 5 + k] - D[i * 5 + k]) * f
    return { x: g(0), v: g(1), s: g(2), b: g(3), bv: g(4) }
  }
  /** 是不是正在飞（探身停住不算） */
  flying() { return !this.leaning && this.anims.length > 0 && this.anims[0].playState === 'running' }
  static integrate(st, target, kick, P) {
    let { x, v, s, b, bv } = st
    bv += kick
    const out = []
    const dt = 0.00025
    const bk = SP.bouncy.k, bc = SP.bouncy.c
    for (let ms = 0; ms < 1500; ms++) {
      out.push(x, v, s, b, bv)
      if (Math.abs(x - target) < 1e-3 && Math.abs(v) < 2e-2 && Math.abs(s) < 1e-3 && Math.abs(b - 1) < 2e-3 && Math.abs(bv) < 2e-2) break
      for (let k = 0; k < 4; k++) {
        v += (P.k * (target - x) - P.c * v) * dt
        x += v * dt
        // 拉伸跟速度走：死区 1.2 格/秒（落地干脆不拖尾），长出来慢一点（26ms 低通），收回去快（12ms）
        const sp = Math.max(0, Math.abs(v) - DOT.vdz) * Math.sign(v)
        const want = Math.max(-DOT.smax, Math.min(DOT.smax, DOT.g * sp))
        s += (want - s) * dt / (Math.abs(want) > Math.abs(s) ? DOT.up : DOT.down)
        bv += (bk * (1 - b) - bc * bv) * dt
        b += bv * dt
      }
    }
    out.push(target, 0, 0, 1, 0)
    return { d: Float64Array.from(out), n: out.length / 5 }
  }
  /** 拉伸 s（格）→ 胶囊左右两端（格）：前沿占 78%，后沿 22%（前面先走、后面被拽着跟上） */
  static ends(x, s) {
    const L = Math.abs(s), dir = s >= 0 ? 1 : -1
    const front = x + dir * DOT.lead * L, rear = x - dir * (1 - DOT.lead) * L
    return [Math.min(front, rear), Math.max(front, rear)]
  }
  stop() { for (const a of this.anims) a.cancel(); this.anims = [] }
  snap(i) {
    this.stop()
    this.tr = null
    this.rest = i
    this.leaning = false
  }
  /** 积分表 → 三块的关键帧（hold：放完停住，探身用） */
  play(tr, { bloom = false, hold: keep = false } = {}) {
    this.tr = tr
    const total = tr.n - 1 // 毫秒
    const D = tr.d
    const at = t => {
      const i = Math.min(tr.n - 1, Math.floor(t)), f = t - i, j = Math.min(tr.n - 1, i + 1)
      const g = q => D[i * 5 + q] + (D[j * 5 + q] - D[i * 5 + q]) * f
      const [l, r] = Dot.ends(g(0), g(2))
      return { l, r, b: g(3) }
    }
    const o = { duration: Math.max(1, total), easing: 'linear', fill: keep ? 'forwards' : 'none' }
    const N = Math.max(2, Math.ceil(total / (1000 / HZ)))
    const s0 = at(0), s1 = at(total)
    const pc = x => `${fmt(x * 100, 3)}%`
    // 端点只是平移（没有呼吸、不停住）且支持 linear()：两个关键帧 + linear()；桥（平移 + 伸缩两个分量）总是采样
    const lin = !keep && !bloom && supportsLinear() && Math.abs(s1.l - s0.l) > 0.02 && Math.abs(s1.r - s0.r) > 0.02
    const fa = [], fb = [], fc = []
    for (let k = 0; k <= N; k++) {
      const s = at(total * k / N), off = k / N
      if (!lin) {
        fa.push({ offset: off, transform: `translateX(${pc(s.l)}) scale(${fmt(s.b)})` })
        fb.push({ offset: off, transform: `translateX(${pc(s.r)}) scale(${fmt(s.b)})` })
      }
      fc.push({ offset: off, transform: `translateX(${pc(s.l)}) scaleX(${fmt(Math.max(0.001, s.r - s.l))})` })
    }
    this.stop()
    if (lin) {
      const curve = side => {
        const from = s0[side], to = s1[side], pts = []
        for (let k = 0; k < N; k++) pts.push(+((at(total * k / N)[side] - from) / (to - from)).toFixed(4))
        pts.push(1)
        return `linear(${pts.join(', ')})`
      }
      this.anims = [
        this.a.animate([{ transform: `translateX(${pc(s0.l)})` }, { transform: `translateX(${pc(s1.l)})` }], { ...o, easing: curve('l') }),
        this.b.animate([{ transform: `translateX(${pc(s0.r)})` }, { transform: `translateX(${pc(s1.r)})` }], { ...o, easing: curve('r') }),
        this.c.animate(fc, o)
      ]
    } else {
      this.anims = [this.a.animate(fa, o), this.b.animate(fb, o), this.c.animate(fc, o)]
    }
    if (!keep) {
      const first = this.anims[0]
      first.onfinish = () => { if (this.anims[0] === first) { this.anims = []; this.tr = null } }
    }
  }
  /** 飞到 target（从屏幕上这一帧的位置、速度、拉伸接着走）；bloom：再点一次的呼吸 */
  to(target, { bloom = 0, p = SP.smooth } = {}) {
    const tr = Dot.integrate(this.state(), target, bloom, p)
    this.rest = target
    this.leaning = false
    this.play(tr, { bloom: !!bloom })
  }
  /** 按住别的 Tab：后沿停在选中的那格，前沿朝 j 伸出 LEAN 格（--dur-1 + --ease-out），停住等松手 */
  lean(j, sel) {
    if (j === sel || this.flying()) return
    const dir = Math.sign(j - sel)
    const st = this.state()
    const x1 = sel + dir * LEAN * (1 - DOT.lead), s1 = LEAN * dir
    const T = Math.max(1, Math.round(tok().d1)), e = tok().ease.out, out = []
    for (let ms = 0; ms <= T; ms++) {
      const y = e(ms / T), y2 = e(Math.min(1, (ms + 1) / T))
      out.push(st.x + (x1 - st.x) * y, (x1 - st.x) * (y2 - y) * 1000, st.s + (s1 - st.s) * y, 1, 0)
    }
    out.push(x1, 0, s1, 1, 0)
    this.rest = sel
    this.play({ d: Float64Array.from(out), n: out.length / 5 }, { hold: true })
    this.leaning = true
  }
  /** 划走取消：探身收回（snappy） */
  leanBack(sel) {
    if (!this.leaning) return
    this.to(sel, { p: SP.snappy })
  }
}

/**
 * 给导航栏建动效：nav 是 <nav class="tabbar">，里面 6 个 .tb-i 和 .tb-dot。sel 是现在选中的序号。
 * 返回的方法都会自己判断「减少动态效果」（实时读）：那时不建任何关键帧，只回到 class 决定的静止状态。
 */
export function createTabMotion(nav, sel) {
  const items = [...nav.querySelectorAll('.tb-i')]
  const ch = items.map((it, j) => {
    const on = j === sel
    return {
      press: new Channel(it.querySelector('.tb-ic'), C_PRESS, { s: 1, y: 0 }),
      line: new Channel(it.querySelector('.tb-o'), C_LINE, { s: 1, o: on ? 0 : 1 }),
      fill: new Channel(it.querySelector('.tb-f'), C_FILL, { p: on ? 1 : 0 }, { p: [FILL_KNOT] }),
      label: new Channel(it.querySelector('.tb-l'), C_OP, { o: on ? 1 : LABEL_OFF }),
      item: new Channel(it, C_OP, { o: 1 })
    }
  })
  const dot = new Dot(nav.querySelector('.tb-dot'))
  dot.rest = sel
  let cur = sel

  /** 全部回到静止状态（减少动态效果、系统设置变了） */
  function snapAll(i = cur) {
    cur = i
    ch.forEach((c, j) => {
      const on = j === i
      c.press.snap({ s: 1, y: 0 })
      c.line.snap({ s: 1, o: on ? 0 : 1 })
      c.fill.snap({ p: on ? 1 : 0 })
      c.label.snap({ o: on ? 1 : LABEL_OFF })
      c.item.snap({ o: 1 })
    })
    dot.snap(i)
  }

  function rise(i, kind) {
    const p = ch[i].press, t = tok()
    if (kind === 'cancel') return p.go({ s: st => spring(SP.snappy, st, 1) })
    if (kind === 'key') return p.go({ s: st => pulse(st, t.pressSm, t.d1 / 2, SP.bouncy, 1) })
    p.go({ s: st => spring(SP.bouncy, st, 1) })
  }
  function glyph(i, on) {
    const c = ch[i], t = tok()
    if (on) {
      // 实心从中心长出来（.45 → 1，p 到 .6 时已不透明）盖住描边；描边稍后（30ms）才淡掉，不留双层轮廓
      c.fill.go({ p: st => spring(SP.snappy, st, 1) })
      c.line.go({ o: st => tween(st, 0, t.d1, 'out', 30), s: st => spring(SP.snappy, st, 1) })
    } else {
      // 实心缩回中心、淡掉；描边从 .9 轻轻撑回原样（本来就看得见时从当前大小接着走）
      const shown = c.line.value('o')[0] > 0.05
      c.fill.go({ p: st => tween(st, 0, t.d2, 'out') })
      c.line.go({ o: st => tween(st, 1, t.d1, 'out'), s: st => spring(SP.snappy, shown ? st : [0.9, 0], 1) })
    }
  }
  function label(i, on) {
    ch[i].label.go({ o: st => tween(st, on ? 1 : LABEL_OFF, tok().d2, 'out') })
  }

  return {
    /** 按下：图标立刻沉到 --press-scale-sm；光点朝这格探一下身（光点没在飞、这格不是选中的那格时） */
    down(i) {
      if (reducedMotion()) return
      const t = tok()
      ch[i].press.go({ s: st => tween(st, t.pressSm, t.d1, 'out') }, { keep: true })
      dot.lean(i, cur)
    },
    /** 划走 / 被系统打断：安静地弹回，光点收回 */
    cancel(i) {
      if (reducedMotion()) return snapAll()
      rise(i, 'cancel')
      dot.leanBack(cur)
    },
    /**
     * 选中第 i 个（旧的是 old）。how：'pointer' 手指 / 鼠标，'key' 键盘回车（图标补一个「按一下」），
     * 'route' 路由自己变了（安卓返回键回到首页、守卫改道：图标不弹，只换选中）。
     */
    select(i, old, how) {
      cur = i
      if (reducedMotion()) return snapAll(i)
      const t = tok()
      if (how === 'pointer') rise(i, 'release')
      else if (how === 'key') rise(i, 'key')
      if (old !== i && old >= 0) {
        glyph(i, true)
        glyph(old, false)
        label(i, true)
        label(old, false)
      }
      dot.to(i)
      // 其余几格轻轻暗一下再亮回来；新旧两格如果还暗着（连点时），快速亮回来
      ch.forEach((c, j) => {
        if (j !== i && j !== old) c.item.go({ o: st => dip(st, DIM_TO, t.d1, t.d3) })
        else if (c.item.value('o')[0] < 0.999) c.item.go({ o: st => tween(st, 1, t.d1, 'out') })
      })
    },
    /** 再点当前 Tab：图标从当前大小弹回、同时轻跳约 4px；光点呼吸一次 */
    retap(i) {
      if (reducedMotion()) return snapAll()
      ch[i].press.go({
        s: st => spring(SP.bouncy, st, 1),
        y: st => spring(SP.bouncy, [st[0], st[1] - HOP_V], 0, 0.05)
      })
      dot.to(cur, { bloom: BLOOM })
    },
    snapAll,
    /** 空闲时先把积分、弹簧、linear() 都算一遍（JIT 预热），第一次点的时候不卡；不建任何动画 */
    warm() {
      if (reducedMotion()) return
      tok()
      for (let k = 0; k < 2; k++) Dot.integrate({ x: 0, v: 0, s: 0, b: 1, bv: 0 }, N_TABS - 1, 0, SP.smooth)
      const a = spring(SP.bouncy, [tok().pressSm, 0], 1)
      const b = spring(SP.snappy, [0, 0], 1)
      if (supportsLinear()) { linearOf(a, tok().pressSm, 1, a.T); linearOf(b, 0, 1, b.T) }
    },
    /** 测试 / 调试用：还在跑的动画个数 */
    running() {
      let n = dot.anims.filter(a => a.playState === 'running').length
      for (const c of ch) for (const k in c) if (c[k].busy()) n++
      return n
    }
  }
}
