import { isNavigationFailure, NavigationFailureType } from 'vue-router'
import { reducedMotion, SPRINGS, springAt, springLinear, cssDuration, cssEasing, Z } from '@/utils/motion'
import { overrideNextTransition, pageMotion } from './pageTransition'

/*
 * 共享元素过渡（hero）：点视频卡片，封面从卡片「飞」进播放页的播放器；返回时再从播放器缩回原来那张卡片。
 * 播放页里点「相似推荐」，缩略图飞进上面的播放器（同一页，没有页面切换）。
 *
 *   VideoCard 的 click：           heroTap(e, coverEl, video, router, to)      // 点下去就起飞（先飞向播放器应在的位置）
 *   播放页 setup：                 const inbound = claimHero(route.params.id)  // 不是飞进来的为 null
 *   播放页 onMounted：             inbound.land(playerEl, () => { …露出播放器… })
 *   播放页 onBeforeRouteLeave：    armHeroBack(router, to, inbound.origin, () => ({ el, video, showsVideo, dim, cover }), 当前视频 id)
 *   RelatedVideo 的 click：        heroRelated(e, coverEl, video, router, to)
 *   播放页 onBeforeRouteUpdate：   claimRelatedHero(to.params.id)?.land(() => { …露出播放器… })
 *
 * 页面切换的动效名由 pageTransition.js 的 overrideNextTransition('pg-hero' | 'pg-hero-back') 指定（样式在 motion.css），
 * 跳转完成后看 pageMotion.name 确认真的用上了才飞；卡片上要有 data-vid（VideoCard 已经带上），返回时靠它找回卡片。
 *
 * 做法（参见 motion.css 开头的原则）
 *  - 飞行的是一个浮层（#app 里的绝对定位元素，层级 Z.hero = 45：盖过转场中的页面和底部导航，在弹层、提示条之下），
 *    里面放和卡片一模一样的封面（加载好的照片，或者生成的占位图）。卡片自己的封面和播放器在飞行期间藏起来，
 *    落地那一刻再露出来、浮层淡出：画面上始终只有一份，不会一闪、不会重影。
 *  - 只动 transform / opacity：外层按「当前框 / 基准框」做不等比缩放（框从 16:10 变成 16:9），
 *    里面的图片再反向缩放回等比、始终 cover 铺满框，看起来就是一张图在平滑地变大、移动、裁切。
 *    弹簧曲线按时间采样成关键帧（线性插值），整段交给合成线程跑：新页面挂载、接口回来时主线程忙也不掉帧，
 *    而且不依赖 CSS linear()，老浏览器上也是同一根真弹簧。圆角、被列表边缘裁掉的部分在主线程上跟着变（只重绘这一小块）。
 *  - 起点读一次位置（点按 / 离开那一刻），之后不再每帧读布局。
 *  - 随时可以打断：飞行中再点、再返回，从浮层此刻的位置和速度接着飞向新目标（弹簧带初速度），不会跳。
 *  - 不拖慢播放：播放页照常挂载、照常立刻开始加载和缓冲，播放器只是在飞行的 0.36 秒里看不见；
 *    落地露出来的那一刻才开播（VideoPlayer 的 hold），不会先听到声音、开头那一段也不会在看不见的时候播掉。
 *  - 这些情况不飞，走普通的页面切换：减少动态效果、全屏 / 小窗播放中、卡片几乎被挡住、浏览器自己做了滑动（iOS 边缘右滑）、
 *    返回时已经不是同一个视频（「下一个」换过）、屏幕转过 / 窗口大小变了、看不到原来那张卡片。
 */

const SPRING = SPRINGS.smooth          // 大面积的面：几乎不过冲，停稳约 358ms
const SAMPLES = 30                     // 弹簧采样成多少段关键帧
const MAX_V = 4                        // 打断后接着飞时的初速度上限（每秒走完全程的倍数）
const CLAIM_MS = 1200                  // 点了卡片以后，播放页这么久还没接手就作废
const READY_MS = 150                   // 浮层里的图片最多等这么久解码，之后照飞
const WATCHDOG_MS = 3000               // 浮层最长寿命
const DOUBLE_MS = 350                  // 点卡片以后这么久之内、在同一个地方的第二下当作连点，不算
const DOUBLE_PX = 24

const lerp = (a, b, p) => a + (b - a) * p

/*
 * 动效令牌只读一次：读 CSS 变量要算样式，页面刚换上（返回起飞、落地）的那一刻读会逼浏览器当场把样式算一遍。
 * 第一次用到是在点卡片的时候（样式是干净的）。用 hero 时一定没开「减少动态效果」，不用管令牌变成 1ms 的情况。
 */
let T = null
function tok() {
  if (!T) {
    T = {
      d1: cssDuration('--dur-1', 120), d2: cssDuration('--dur-2', 200), d3: cssDuration('--dur-3', 280),
      out: cssEasing('--ease-out'), inOut: cssEasing('--ease-in-out', 'cubic-bezier(.65, 0, .35, 1)')
    }
  }
  return T
}

/* 弹簧停稳要多久（毫秒）：静止起步的那根最常用，只算一次 */
let restMs = 0
function settleMs(v0) {
  if (!v0 && restMs) return restMs
  const ms = Math.max(160, springLinear({ ...SPRING, velocity: v0 }).duration)
  if (!v0) restMs = ms
  return ms
}

/* ---------- 位置：全部用 #app 里的坐标（桌面上 #app 是居中的 480 宽一栏） ---------- */

const appEl = () => document.getElementById('app') || document.body
function appBox() {
  const r = appEl().getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}
const toApp = (r, app) => ({ x: r.left - app.x, y: r.top - app.y, w: r.width, h: r.height })

/*
 * 元素现在真正看得见的那一块：一路往上和会裁切的祖先（滚动容器、overflow: hidden）求交，再和 #app 求交。
 * 返回四边被裁掉多少（屏幕像素，[上, 右, 下, 左]）；完全看不见返回 null。
 */
function clipOf(el, rect) {
  let top = rect.top
  let right = rect.left + rect.width
  let bottom = rect.top + rect.height
  let left = rect.left
  const app = appEl()
  for (let p = el.parentElement, n = 0; p && n < 16; p = p.parentElement, n++) {
    const cs = getComputedStyle(p)
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || p === app) {
      const r = p.getBoundingClientRect()
      top = Math.max(top, r.top)
      right = Math.min(right, r.right)
      bottom = Math.min(bottom, r.bottom)
      left = Math.max(left, r.left)
    }
    if (p === app) break
  }
  if (right - left < 1 || bottom - top < 1) return null
  const c = [top - rect.top, rect.left + rect.width - right, rect.top + rect.height - bottom, left - rect.left].map(v => Math.max(0, v))
  return c.map(v => (v < 0.5 ? 0 : v))
}
const clipped = c => c.some(v => v > 0)

let clipOk = null
/* 被裁掉一部分的卡片要用 clip-path 跟着变；不支持的浏览器上这种卡片就不飞 */
const supportsClip = () => {
  if (clipOk === null) {
    try { clipOk = !!CSS.supports?.('clip-path', 'inset(1px 2px 3px 4px)') } catch { clipOk = false }
  }
  return clipOk
}

/** 卡片 / 播放器此刻的状态：{ x, y, w, h（#app 坐标）, r 圆角, c 被裁掉的四边 } */
function stateOf(el, app = appBox()) {
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const c = clipOf(el, rect)
  if (!c) return null
  // 圆角按看到的大小算（按压回弹中的卡片是缩小了一点的）
  const scale = el.offsetWidth ? rect.width / el.offsetWidth : 1
  const r = (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) * scale
  return { ...toApp(rect, app), r, c }
}

const mix = (a, b, p) => ({
  x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p),
  r: lerp(a.r, b.r, p), c: a.c.map((v, i) => lerp(v, b.c[i], p))
})
const near = (a, b, tol = 1) => ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) <= tol) && a.c.every((v, i) => Math.abs(v - b.c[i]) <= tol)

/* ---------- 卡片封面藏起来（飞行期间；按视频 id，KeepAlive 页面回来、子页面重新挂上的卡片都能第一帧就藏好） ---------- */

let hideStyle = null
function hideCards(vid) {
  if (!hideStyle) {
    hideStyle = document.createElement('style')
    hideStyle.dataset.hero = ''
    document.head.appendChild(hideStyle)
  }
  hideStyle.textContent = vid == null ? '' : `.vc[data-vid="${String(vid).replace(/["\\]/g, '\\$&')}"] > .cv { opacity: 0 !important; }`
}

/* ---------- 浮层 ---------- */

/* 生成的占位图（SVG data URL）自己的宽高比，读 viewBox；读不出来按 16:10 */
function fallbackAspect(bg) {
  try {
    const m = /viewBox=["']?\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(decodeURIComponent(bg || ''))
    if (m && +m[1] > 0 && +m[2] > 0) return +m[1] / +m[2]
  } catch { /* 不是合法的 URI 编码 */ }
  return 1.6
}

/*
 * 一层图片：cover 铺满框（封面）或 contain 完整放进框（视频画面）。
 * base：外层基准框里这张图的大小和位置（外层不缩放时的样子），飞行中只改 transform。
 */
function fit(kind, aspect, w, h) {
  const wide = w / h < aspect
  const cover = kind === 'cover'
  // cover：框比图「窄」时按高度铺满；contain 反过来
  const byH = cover ? wide : !wide
  const iw = byH ? h * aspect : w
  return { w: iw, h: iw / aspect }
}

class Flight {
  /**
   * @param {object} from  起点状态（stateOf）
   * @param {object} media { src, fallback, aspect, frame?: HTMLCanvasElement, frameAspect }
   */
  constructor(from, media) {
    this.state = from
    this.seg = null        // 正在飞的这一段：{ from, to, f, D, v0 }
    this.anims = []
    this.token = 0
    this.vid = null
    this.dir = 'in'        // in：卡片 → 播放器；out：播放器 → 卡片
    this.done = false

    const root = document.createElement('div')
    root.setAttribute('aria-hidden', 'true')
    root.dataset.hero = ''
    root.style.cssText = `position:absolute;left:0;top:0;z-index:${Z.hero};overflow:hidden;pointer-events:none;`
      + 'transform-origin:0 0;background:#161616;will-change:transform;contain:layout style;'
    this.el = root

    // 封面：占位图在下、照片在上（和 Cover.vue 一样）
    const cover = document.createElement('div')
    cover.style.cssText = 'position:absolute;left:0;top:0;transform-origin:50% 50%;will-change:transform;'
      + `background-color:#161616;background-position:center;background-size:cover;background-repeat:no-repeat;filter:var(--media);`
    if (media.fallback) cover.style.backgroundImage = media.fallback
    this.ready = Promise.resolve()
    if (media.src) {
      const img = document.createElement('img')
      img.alt = ''
      img.decoding = 'sync'
      img.draggable = false
      img.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;width:100%;height:100%;object-fit:cover;'
      img.src = media.src
      cover.appendChild(img)
      // 卡片上已经显示着的图，内存里就有，一般立刻就好；保险起见等它解码完再露出来（最多等 READY_MS）
      if (!img.complete && img.decode) {
        this.ready = Promise.race([img.decode().catch(() => {}), new Promise(r => setTimeout(r, READY_MS))])
      }
    }
    this.layers = [{ el: cover, kind: 'cover', aspect: media.aspect || 1.6 }]
    root.appendChild(cover)

    // 播放器上压着的暗层（没有片源时的遮罩、加载中的占位）：起飞时一样暗，飞行前半段淡掉，落到卡片上是原样的封面
    if (media.dim > 0) {
      const dim = document.createElement('div')
      dim.style.cssText = `position:absolute;left:0;top:0;right:0;bottom:0;background:#000;opacity:${media.dim};will-change:opacity;`
      root.appendChild(dim)
      this.dimEl = dim
      this.dim = media.dim
    }

    // 视频此刻的画面（返回时）：黑底 + contain，飞行前半段淡出，露出下面的封面，落地时和卡片一模一样
    if (media.frame) {
      const back = document.createElement('div')
      back.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;background:#000;will-change:opacity;'
      const cv = media.frame
      cv.style.cssText = 'position:absolute;left:0;top:0;transform-origin:50% 50%;will-change:transform;filter:var(--media);'
      back.appendChild(cv)
      root.appendChild(back)
      this.frameEl = back
      this.layers.push({ el: cv, kind: 'contain', aspect: media.frameAspect || 16 / 9 })
    }

    this.place(from)
    appEl().appendChild(root)
    // 保险：不管中间出了什么岔子，浮层最多留这么久，到点一定拿掉、卡片封面一定露出来
    this.watchdog = setTimeout(() => {
      if (flight === this) endFlight(true)
      else if (!this.done) this.dispose()
    }, WATCHDOG_MS)
  }

  /** 把基准框定成 B，并让浮层静止在状态 s（行内样式） */
  place(s, B = { w: s.w, h: s.h }) {
    this.B = B
    const st = this.el.style
    st.width = `${B.w}px`
    st.height = `${B.h}px`
    for (const l of this.layers) {
      const base = fit(l.kind, l.aspect, B.w, B.h)
      l.base = base
      Object.assign(l.el.style, { width: `${base.w}px`, height: `${base.h}px`, left: `${(B.w - base.w) / 2}px`, top: `${(B.h - base.h) / 2}px` })
    }
    const f = this.frame(s)
    st.transform = f.outer
    st.borderRadius = f.radius
    st.clipPath = f.clip || ''
    this.layers.forEach((l, i) => { l.el.style.transform = f.layers[i] })
    this.state = s
  }

  /** 状态 s 对应的各层样式 */
  frame(s) {
    const { B } = this
    const sx = s.w / B.w
    const sy = s.h / B.h
    const outer = `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0) scale(${sx.toFixed(5)}, ${sy.toFixed(5)})`
    // 外层不等比缩放：圆角、裁切都要换算回缩放前的坐标，看起来才是正圆角、裁在对的地方
    const rx = (s.r / sx).toFixed(2)
    const ry = (s.r / sy).toFixed(2)
    const radius = `${rx}px ${rx}px ${rx}px ${rx}px / ${ry}px ${ry}px ${ry}px ${ry}px`
    const clip = clipped(s.c) ? `inset(${(s.c[0] / sy).toFixed(2)}px ${(s.c[1] / sx).toFixed(2)}px ${(s.c[2] / sy).toFixed(2)}px ${(s.c[3] / sx).toFixed(2)}px)` : null
    const layers = this.layers.map(l => {
      const want = fit(l.kind, l.aspect, s.w, s.h) // 屏幕上这一层应有的大小
      return `scale(${(want.w / sx / l.base.w).toFixed(5)}, ${(want.h / sy / l.base.h).toFixed(5)})`
    })
    return { outer, radius, clip, layers }
  }

  /** 此刻的状态和速度（按正在飞的那一段解析出来，不读布局） */
  now() {
    const g = this.seg
    if (!g) return { s: this.state, v: null }
    const a = this.anims[0]
    let t = typeof a?.currentTime === 'number' ? a.currentTime : 0
    t = Math.max(0, Math.min(g.D, t))
    if (t >= g.D) return { s: g.to, v: null }
    const p = g.f(t / 1000)
    const dp = (g.f((t + 1) / 1000) - g.f(Math.max(0, t - 1) / 1000)) / (t >= 1 ? 2 : 1) * 1000
    return { s: mix(g.from, g.to, p), v: { dp, from: g.from, to: g.to } }
  }

  /** 从此刻的位置（带着此刻的速度）飞到 to；落地调 onLand */
  fly(to, onLand) {
    const { s: from, v } = this.now()
    // 新的一段的初速度：把此刻的运动投影到新的方向上（掉头时为负：先顺着惯性走一点再回来）
    let v0 = 0
    if (v) {
      const d = ['x', 'y', 'w', 'h'].map(k => to[k] - from[k])
      const m = ['x', 'y', 'w', 'h'].map(k => v.dp * (v.to[k] - v.from[k]))
      const dd = d.reduce((sum, x) => sum + x * x, 0)
      if (dd > 1) v0 = Math.max(-MAX_V, Math.min(MAX_V, d.reduce((sum, x, i) => sum + x * m[i], 0) / dd))
    }
    const params = { ...SPRING, velocity: v0 }
    const f = springAt(params)
    const D = settleMs(v0)

    this.stop()
    // 基准框取两头里大的那个（缩小总比放大清晰）
    const B = from.w * from.h >= to.w * to.h ? { w: from.w, h: from.h } : { w: to.w, h: to.h }
    this.place(to, B)             // 行内样式先放到终点：动画结束、被取消时都停在对的位置
    this.seg = { from, to, f, D }

    const frames = []
    for (let i = 0; i <= SAMPLES; i++) frames.push(this.frame(mix(from, to, i === SAMPLES ? 1 : f((i / SAMPLES) * D / 1000))))
    const opt = { duration: D, easing: 'linear', fill: 'backwards' }
    const offset = i => i / SAMPLES
    this.anims = [
      this.el.animate(frames.map((k, i) => ({ transform: k.outer, offset: offset(i) })), opt),
      ...this.layers.map((l, j) => l.el.animate(frames.map((k, i) => ({ transform: k.layers[j], offset: offset(i) })), opt))
    ]
    // 圆角、裁切单独一段（不能合成，放在一起会把整段变换也拖回主线程）
    const rad = this.radiusTrack(from, to, f, D)
    if (rad) this.anims.push(rad)
    if (frames.some(k => k.clip)) this.anims.push(this.el.animate(frames.map((k, i) => ({ clipPath: k.clip || 'inset(0px 0px 0px 0px)', offset: offset(i) })), opt))

    const token = ++this.token
    this.anims[0].onfinish = () => {
      if (token !== this.token) return
      this.stop()
      this.state = to
      onLand?.()
    }
  }

  /*
   * 圆角（不能合成，每一帧都要主线程重绘）：只在看得出来的那一段跟着变。
   * 卡片的 8px 圆角只在框还小的时候看得见：放大（卡片 → 播放器）时在前 45% 里收成直角，
   * 缩回（播放器 → 卡片）时在最后 45% 里长出来；两头圆角都不为 0（卡片之间改飞）才整段跟着变。
   * 圆角要换算回缩放前的坐标（外层不等比缩放），所以照样按弹簧的位置逐帧采样。
   */
  radiusTrack(from, to, f, D) {
    if (!from.r && !to.r) return null
    const win = !from.r || !to.r ? 0.45 : 1
    const startAt = !to.r || win === 1 ? 0 : 1 - win     // 圆角变成 0：开头那段；从 0 长出来：最后那段
    const n = 12
    const frames = []
    for (let i = 0; i <= n; i++) {
      const q = i / n                                    // 这一段里的进度
      const t = (startAt + win * q) * D
      const p = t >= D ? 1 : f(t / 1000)
      const s = mix(from, to, p)
      s.r = lerp(from.r, to.r, q)
      frames.push({ borderRadius: this.frame(s).radius, offset: q })
    }
    return this.el.animate(frames, { duration: win * D, delay: startAt * D, easing: 'linear', fill: 'backwards' })
  }

  /** 视频画面那一层、暗层淡出（返回时，飞行的前半段） */
  fadeFrame(D) {
    const opt = { duration: D * 0.55, delay: D * 0.08, easing: tok().inOut, fill: 'both' }
    this.frameEl?.animate([{ opacity: 1 }, { opacity: 0 }], opt)
    this.dimEl?.animate([{ opacity: this.dim }, { opacity: 0 }], opt)
  }

  stop() {
    this.token++
    for (const a of this.anims) a.cancel()
    this.anims = []
    this.seg = null
  }

  /** 淡出后移除（落地以后、或者半路作废） */
  fadeOut(ms = tok().d2) {
    if (this.done) return
    this.done = true
    const { s } = this.now()
    // 停在此刻的位置淡出（作废时不再继续飞）
    if (this.seg) {
      this.stop()
      this.place(s, this.B)
    }
    const el = this.el
    fading.add(el)
    const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: tok().out, fill: 'forwards' })
    a.onfinish = a.oncancel = () => {
      fading.delete(el)
      el.remove()
    }
    clearTimeout(this.watchdog)
  }

  dispose() {
    this.done = true
    clearTimeout(this.watchdog)
    this.stop()
    this.el.remove()
  }
}

/*
 * 连点挡一下：pg-hero 的新页面从第一帧起就整页盖在上面（只是还几乎透明），手指在卡片上连点两下，
 * 第二下会落在看不见的新页面上（比如正好是一条相似推荐），莫名其妙又跳走。点下去之后 DOUBLE_MS 之内、
 * 落在同一个地方（DOUBLE_PX 以内）的点击直接吞掉；别的地方照常能点（比如返回键）。键盘触发的点击不管。
 */
let guardOff = null
function guardDoubleTap(e) {
  guardOff?.()
  if (!e || e.detail === 0) return
  const x = e.clientX
  const y = e.clientY
  const t0 = performance.now()
  const onClick = ev => {
    if (performance.now() - t0 > DOUBLE_MS) return off()
    if (Math.abs(ev.clientX - x) <= DOUBLE_PX && Math.abs(ev.clientY - y) <= DOUBLE_PX) {
      ev.preventDefault()
      ev.stopPropagation()
    }
  }
  const timer = setTimeout(() => off(), DOUBLE_MS)
  const off = () => {
    clearTimeout(timer)
    window.removeEventListener('click', onClick, true)
    if (guardOff === off) guardOff = null
  }
  window.addEventListener('click', onClick, true)
  guardOff = off
}

/* ---------- 一次只有一个浮层 ---------- */

/* 落地后正在淡出的浮层：同一个位置马上又要起飞时（刚落地就返回）直接拿掉，免得留一个残影 */
const fading = new Set()
const clearFading = () => {
  for (const el of fading) el.remove()
  fading.clear()
}

let flight = null       // 正在飞（或等着接手）的浮层
let pendingIn = null    // 点了卡片、等播放页接手：{ flight, vid, origin, timer }
let pendingBack = null  // 播放页离开前登记的返回：{ vid, origin, source }
let pendingRel = null   // 播放页里点了相似推荐、等播放页接手（同上）
let launching = null    // 最近一次点卡片 / 缩略图的起飞（浮层可能还没建好）

/* 飞行结束（落地或作废）：藏起来的卡片封面 / 缩略图露出来 */
function reveal(f) {
  hideCards(null)
  f?.unhide?.()
  if (f) f.unhide = null
}

/** 结束当前的浮层：卡片封面露出来，浮层淡出（instant：直接拿掉） */
function endFlight(instant = false) {
  if (!flight) return
  const f = flight
  flight = null
  reveal(f)
  f.onAbort?.()
  if (instant) f.dispose()
  else f.fadeOut(tok().d1)
}

const fullscreenNow = () => !!(document.fullscreenElement || document.webkitFullscreenElement || document.pictureInPictureElement)

let installed = false
function install(router) {
  if (installed) return
  installed = true
  // 在 pageTransition 的 afterEach 之后注册（App.vue 先调 usePageTransition）：这里读到的 pageMotion 已经是这一次的
  router.afterEach((to, from, failure) => {
    if (pendingIn) {
      const p = pendingIn
      if (failure) {
        // 被更新的一次跳转顶掉（比如连点两下）：动效名被这次失败用掉了，给接下来那次重新指定；其余失败直接作废
        if (isNavigationFailure(failure, NavigationFailureType.cancelled) && overrideNextTransition('pg-hero')) return
        dropLaunch(p, true)
        return
      }
      if (pageMotion.name !== 'pg-hero' || to.name !== 'video' || String(to.params.id) !== p.vid) dropLaunch(p, false)
      return
    }
    if (pendingBack) {
      const b = pendingBack
      pendingBack = null
      // 就在这里起飞，不能等下一帧：离开的组件在离场动画一开始就卸载（模板 ref 清空、播放器停掉并清空 <video>），
      // 只有 DOM 留着放离场动画。这一刻播放页还原样在，量位置、截视频画面、盖上浮层都得现在做
      if (!failure && pageMotion.name === 'pg-hero-back') {
        if (launching && !launching.flight) launching.dead = true   // 播放页还没接到飞进来的浮层就返回
        launchBack(b)
      } else if (!failure && flight) endFlight()
      return
    }
    if (pendingRel) {
      const p = pendingRel
      if (failure && isNavigationFailure(failure, NavigationFailureType.cancelled)) return
      // 没跳成，或者播放页没接手（id 对不上）：飞回缩略图 / 原地淡出
      dropLaunch(p, !!failure)
      return
    }
    // 别的跳转（飞行中点了别处）：浮层原地淡出；浮层自己的那次跳转（相似推荐，播放页已经接手）不算
    if (!failure && flight && flight.dir === 'in' && flight.navTo !== to.fullPath) endFlight()
  })
}

/* ---------- 进：卡片 → 播放器 ---------- */

/* 播放页的播放器大概在哪：页面顶部（让出安全区）、整栏宽、16:9 */
function playerGuess(coverEl, app) {
  const page = coverEl.closest('.page')
  const top = page ? parseFloat(getComputedStyle(page).paddingTop) || 0 : 0
  return { x: 0, y: top, w: app.w, h: app.w * 9 / 16, r: 0, c: [0, 0, 0, 0] }
}

function arrive(f) {
  f.inbound.arrived = true
  tryLand(f)
}
function tryLand(f) {
  const ib = f.inbound
  if (!ib || !ib.arrived || !ib.claim || flight !== f || f.done) return
  const wait = ib.claim.readyAt - performance.now()
  if (wait > 4) {
    clearTimeout(ib.landTimer)
    ib.landTimer = setTimeout(() => tryLand(f), wait)
    return
  }
  flight = null
  f.inbound = null
  if (launching === ib) launching = null
  // 落地：卡片封面恢复（旧页已经被盖住）、播放器露出来，浮层淡出（内容一样，只看得到控制栏淡入）
  reveal(f)
  f.onAbort = null
  ib.claim.onLand?.()
  f.fadeOut()
}
/* 跳转没成（被拦下、重复、播放页一直没接手）：飞回卡片，落地后卡片封面露出来 */
function backToCard(f, state) {
  if (!f || flight !== f || f.done) return
  f.inbound = null
  f.onAbort = null
  f.dir = 'out'
  f.fly(state, () => {
    if (flight !== f) return
    flight = null
    reveal(f)
    f.dispose()
  })
}

/*
 * 一次起飞（点卡片 / 点相似推荐）：
 *   { vid, from 起点, target 播放器的位置（先估计、挂上后核对）, arrived, claim 播放页接手（{ onLand, readyAt }）,
 *     flight 浮层（下一帧才建好）, dead 作废, claimed, navTo, hide() 藏起卡片封面 / 缩略图, timer }
 * 点下去的那一刻只做便宜的事：判断能不能飞、量一次卡片、指定页面动效。浮层的创建和起飞放到下一帧开头（requestAnimationFrame）：
 * 那时路由已经把播放页挂上、视频详情的请求已经发出去，这几毫秒的准备不会挡在请求前面；浮层照样出现在点下去之后的第一帧里。
 */
function dropLaunch(p, flyBack) {
  p.dead = true
  clearTimeout(p.timer)
  if (pendingIn === p) pendingIn = null
  if (pendingRel === p) pendingRel = null
  if (launching === p) launching = null
  const f = p.flight
  if (!f || flight !== f) {
    // 浮层还没建好（或者已经不归它管）：播放器直接露出来
    p.claim?.onLand?.()
    return
  }
  if (flyBack) backToCard(f, p.from)
  else endFlight()
}

/* 下一帧开头：建浮层（或者接着用正在缩回这张卡片的那个）、藏卡片封面、起飞 */
function launch(p, coverEl, reuse) {
  if (p.dead) return
  let f = reuse && !reuse.done && flight === reuse ? reuse : null
  if (!f) {
    if (flight) endFlight()
    // 再量一次：按压回弹的这一会儿卡片又长回去一点，从它此刻真正的样子起飞
    const s = (coverEl.isConnected && stateOf(coverEl)) || p.from
    p.from = s
    const img = coverEl.querySelector(':scope > img.on')
    const ok = img && img.naturalWidth > 0
    f = new Flight(s, {
      src: ok ? img.currentSrc || img.src : null,
      fallback: coverEl.style.backgroundImage || '',
      aspect: ok ? img.naturalWidth / img.naturalHeight : fallbackAspect(coverEl.style.backgroundImage)
    })
    // 卡片按下时变暗了一点（:active）：浮层从同样的亮度开始，飞起来时恢复
    const o = parseFloat(getComputedStyle(coverEl.closest('a') || coverEl).opacity)
    if (o < 0.99) f.layers[0].el.animate([{ opacity: o }, { opacity: 1 }], { duration: tok().d2, easing: tok().out })
    // 图片解码好了，浮层才露出来、卡片的封面同时藏起来（同一帧，看不出换过）
    f.el.style.visibility = 'hidden'
  }
  f.vid = p.vid
  f.dir = 'in'
  f.navTo = p.navTo
  f.inbound = p
  f.onAbort = () => p.claim?.onLand?.()
  p.flight = f
  flight = f
  f.ready.then(() => {
    if (flight !== f || f.done || f.dir !== 'in' || f.inbound !== p) return
    f.el.style.visibility = ''
    p.hide()
    f.fly(p.target, () => arrive(f))
  })
}

/* 点卡片 / 缩略图时共同的检查：返回 { vid, dest, app, s }，不能飞返回 null */
function precheck(e, coverEl, video, router, to) {
  if (!e?.defaultPrevented || !coverEl || video?.id == null || reducedMotion() || fullscreenNow()) return null
  const vid = String(video.id)
  let dest = null
  try { dest = router.resolve(to) } catch { return null }
  if (dest.name !== 'video' || String(dest.params.id) !== vid) return null
  const app = appBox()
  const s = stateOf(coverEl, app)
  if (!s) return null
  // 几乎被挡住（只露出一小条）的卡片不飞；被裁掉一部分的要能用 clip-path 跟着变
  const visible = (s.w - s.c[1] - s.c[3]) * (s.h - s.c[0] - s.c[2]) / (s.w * s.h)
  if (visible < 0.35 || (clipped(s.c) && !supportsClip())) return null
  install(router)
  tok()
  return { vid, dest, app, s }
}

/**
 * VideoCard 的 click（RouterLink 自己的跳转处理已经先跑过：真的跳了才会 preventDefault）。
 * 先飞向播放器「应该在」的位置；播放页挂上后核对一次，有出入就接着当前的速度改飞过去。
 * 落地（露出播放器、浮层淡出）要等两件事：飞到了，并且新页面已经淡入得差不多了（否则露出来的播放器是半透明的）。
 * @param {MouseEvent} e
 * @param {HTMLElement} coverEl 卡片的封面（.cv）
 * @param {{ id }} video
 * @param {import('vue-router').Router} router
 * @param {string} to 卡片链接的地址（只有去这个视频的播放页才飞）
 */
export function heroTap(e, coverEl, video, router, to) {
  const c = precheck(e, coverEl, video, router, to)
  if (!c || !overrideNextTransition('pg-hero')) return
  const { vid, app, s } = c
  // 本次点击处理完之后才挂上（setTimeout 0），不会吞掉这一下自己
  setTimeout(() => guardDoubleTap(e))
  // 正在缩回这张卡片（刚返回又点进去）：接着用这个浮层，从它此刻的位置掉头飞回去
  const reuse = flight && flight.vid === vid && flight.dir === 'out' && !flight.done ? flight : null
  if (reuse) reuse.dir = 'in'
  if (pendingIn) dropLaunch(pendingIn, false)
  const p = {
    vid, from: s, target: playerGuess(coverEl, app), arrived: false, claim: null, flight: null, dead: false,
    origin: { path: router.currentRoute.value.fullPath, state: s, winW: window.innerWidth, winH: window.innerHeight },
    hide: () => hideCards(vid)
  }
  p.timer = setTimeout(() => { if (!p.claimed) dropLaunch(p, true) }, CLAIM_MS)
  pendingIn = p
  launching = p
  requestAnimationFrame(() => launch(p, coverEl, reuse))
}

/*
 * 播放器停稳后的位置：页面刚挂上就读会逼浏览器当场排版，所以等这一帧画完、由 IntersectionObserver 带回来。
 * 页面正在 pg-hero 入场（往上浮几像素）：播放器和所在页面在同一帧量，两者之差就是去掉上浮位移后的位置
 * （页面本身 inset: 0 贴着 #app）。不能一个用观察那一帧的、一个回调里再读：CPU 忙时两者差一两帧，
 * 上浮已经走了一截，算出来的终点偏下一两像素，浮层会多改飞一次、落地时留一道细边。
 */
function whenPlaced(playerEl, cb) {
  const page = playerEl.closest('.page')
  const done = (r, pr) => {
    const o = pr ? { x: pr.left, y: pr.top } : appBox()
    cb({ x: r.left - o.x, y: r.top - o.y, w: r.width, h: r.height, r: 0, c: [0, 0, 0, 0] })
  }
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver(entries => {
      io.disconnect()
      let r = null
      let pr = null
      for (const e of entries) {
        if (e.target === playerEl) r = e.boundingClientRect
        else if (e.target === page) pr = e.boundingClientRect
      }
      if (r) done(r, pr)
      else done(playerEl.getBoundingClientRect(), page && page.getBoundingClientRect())
    })
    io.observe(playerEl)
    if (page) io.observe(page)
  } else requestAnimationFrame(() => done(playerEl.getBoundingClientRect(), page && page.getBoundingClientRect()))
}

/**
 * 播放页 setup 里调：这一页是不是从卡片飞进来的（这次跳转的首次渲染、视频 id 对得上）。
 * 是的话返回 { origin, land(playerEl, onLand), abort() }，否则 null。
 * origin 留着，返回时用来判断能不能缩回去（armHeroBack）。
 */
export function claimHero(id) {
  const p = pendingIn
  if (!p || p.dead || String(id) !== p.vid || pageMotion.name !== 'pg-hero' || !pageMotion.rendering) return null
  pendingIn = null
  p.claimed = true
  clearTimeout(p.timer)
  return {
    origin: { ...p.origin, vid: p.vid },
    /** 播放器挂上以后调：核对一次它停稳后的位置（有出入就改飞过去）；落地时 onLand（露出播放器），浮层淡出 */
    land(playerEl, onLand) {
      if (p.dead || !playerEl) {
        onLand?.()
        return
      }
      // 新页面淡入（--dur-3）到八成再落地
      p.claim = { onLand, readyAt: performance.now() + tok().d3 * 0.8 }
      whenPlaced(playerEl, to => {
        if (p.dead || !(to.w > 0) || near(to, p.target, 0.5)) {
          if (p.flight) tryLand(p.flight)
          return
        }
        p.target = to
        p.arrived = false
        const f = p.flight
        // 浮层已经在飞：接着当前的速度改飞过去；还没建好的，起飞时直接飞向新位置
        if (f) f.ready.then(() => { if (flight === f && !f.done && f.dir === 'in' && f.inbound === p) f.fly(to, () => arrive(f)) })
      })
      if (p.flight) tryLand(p.flight)
    },
    /** 半路换了视频（「下一个」）：浮层原地淡出，播放器露出来 */
    abort() {
      if (!p.dead) dropLaunch(p, false)
    }
  }
}

/* ---------- 播放页里点相似推荐：缩略图飞进上面的播放器（同一个页面，没有页面切换） ---------- */

/**
 * RelatedVideo 的 click。播放页还是这一个（只是换了视频），播放器一直在页面顶部：
 * 缩略图从列表里升起来、放大到播放器的位置，新视频的播放器在它落地时露出来；旧视频的画面在点下去时就让开。
 * @returns {boolean} 起飞了没有
 */
export function heroRelated(e, coverEl, video, router, to) {
  const cur = router.currentRoute.value
  if (cur.name !== 'video' || String(cur.params.id) === String(video?.id)) return false
  const playerEl = coverEl?.closest('.page')?.firstElementChild
  if (!playerEl || document.querySelector('.player.pseudo')) return false
  const c = precheck(e, coverEl, video, router, to)
  if (!c) return false
  const { vid, dest, app, s } = c
  const pr = playerEl.getBoundingClientRect()
  if (!pr.width) return false
  setTimeout(() => guardDoubleTap(e))
  if (pendingRel) dropLaunch(pendingRel, false)
  const p = {
    vid, from: s, target: { ...toApp(pr, app), r: 0, c: [0, 0, 0, 0] }, arrived: false, claim: null, flight: null, dead: false,
    navTo: dest.fullPath,
    // 缩略图自己藏起来（列表换成新视频的相似推荐以后它本来也就没了），落地 / 作废时恢复
    hide: () => {
      coverEl.style.visibility = 'hidden'
      if (p.flight) p.flight.unhide = () => { coverEl.style.visibility = '' }
    }
  }
  p.timer = setTimeout(() => { if (!p.claimed) dropLaunch(p, true) }, CLAIM_MS)
  pendingRel = p
  launching = p
  requestAnimationFrame(() => launch(p, coverEl, null))
  return true
}

/**
 * 播放页 onBeforeRouteUpdate 里调（换成 id 这个视频之前）：是不是点相似推荐飞过来的。
 * 是的话返回 { land(onLand) }：播放器先藏着，浮层落地时调 onLand 露出来。
 */
export function claimRelatedHero(id) {
  const p = pendingRel
  if (!p || p.dead || String(id) !== p.vid) return null
  pendingRel = null
  p.claimed = true
  clearTimeout(p.timer)
  return {
    land(onLand) {
      if (p.dead) {
        onLand?.()
        return
      }
      // 页面本来就在，不用等淡入
      p.claim = { onLand, readyAt: 0 }
      if (p.flight) tryLand(p.flight)
    }
  }
}

/* ---------- 回：播放器 → 卡片 ---------- */

/**
 * 播放页 onBeforeRouteLeave 里调：要回到飞进来的那一页、还是同一个视频、窗口没变过，就指定 pg-hero-back。
 * 真正起飞在这次跳转完成的那一刻（afterEach，旧页面还在、新页面还没换上），浏览器自己滑过之类的情况就不飞。
 * @param {import('vue-router').Router} router
 * @param {import('vue-router').RouteLocationNormalized} to
 * @param {object} origin claimHero 给的 origin
 * @param {() => ({ el: HTMLElement, video?: HTMLVideoElement, showsVideo?: boolean, dim?: number, cover?: { src, fallback } } | null)} source
 *        起飞那一刻的播放器：外框、<video>、此刻画面上是不是视频（而不是封面）、封面上压着多暗的遮罩（0–1）、封面
 * @param {string} vid 播放页此刻显示的视频 id
 */
export function armHeroBack(router, to, origin, source, vid) {
  pendingBack = null
  if (!origin || to.fullPath !== origin.path || String(vid) !== origin.vid || reducedMotion() || fullscreenNow()) return false
  // 转过屏、窗口变了（只读 window 的尺寸，不读排版：离开的这一刻页面可能还有没排完的改动）
  if (Math.abs(window.innerWidth - origin.winW) > 1 || Math.abs(window.innerHeight - origin.winH) > 120) return false
  if (document.querySelector('.player.pseudo')) return false
  install(router)
  if (!overrideNextTransition('pg-hero-back')) return false
  pendingBack = { vid: origin.vid, origin, source }
  return true
}

/* 视频此刻的画面画到一张 canvas 上（同源、跨域都能显示；画不了就算了） */
function grabFrame(video, rect) {
  try {
    if (!video || video.readyState < 2 || !video.videoWidth) return null
    const aspect = video.videoWidth / video.videoHeight
    const box = fit('contain', aspect, rect.w, rect.h)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(Math.min(video.videoWidth, box.w * dpr)))
    cv.height = Math.max(1, Math.round(cv.width / aspect))
    cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height)
    return { frame: cv, frameAspect: aspect }
  } catch {
    return null
  }
}

/*
 * 返回起飞。afterEach 这一刻（同一个任务里接着就要换上新页面、恢复滚动位置，是整个返回最忙的一帧）只做必须现在做的：
 * 量一次播放器、截下此刻的画面、把浮层静止地盖在播放器上。弹簧关键帧的计算和动画放到下一帧（和页面淡出的 CSS 过渡
 * 同一帧开始）；真正的卡片位置用 IntersectionObserver 在新页面排版完以后带回来（不额外逼浏览器排版），
 * 和返回前记下的位置一样就照原计划飞，有出入就改飞过去，找不到就原地淡出。
 */
function launchBack(b) {
  const target = b.origin.state
  const app = appBox()
  let f = null
  let fresh = false
  if (flight && flight.vid === b.vid && !flight.done) {
    // 还没飞到播放器就返回：就用这个浮层，从此刻的位置掉头
    f = flight
    if (f.inbound) {
      clearTimeout(f.inbound.landTimer)
      f.inbound.dead = true
      if (launching === f.inbound) launching = null
    }
    f.inbound = null
    f.onAbort = null
  } else {
    endFlight(true)
    clearFading()
    const src = b.source?.()
    const el = src?.el
    const rect = el?.getBoundingClientRect()
    if (!rect || !rect.width) return
    // 播放器本身没有圆角（伪全屏之类的情况根本不飞），不用再读样式
    const from = { ...toApp(rect, app), r: 0, c: [0, 0, 0, 0] }
    const cover = src.cover || {}
    // 播放器上显示着的封面图（加载好了才用，否则用占位图，和卡片一致）
    const want = cover.src ? new URL(cover.src, location.href).href : null
    const shown = want && [...el.querySelectorAll('img')].find(i => i.complete && i.naturalWidth > 0 && i.src === want)
    const grab = src.showsVideo ? grabFrame(src.video, from) : null
    f = new Flight(from, {
      src: shown ? cover.src : null,
      fallback: cover.fallback || '',
      aspect: shown ? shown.naturalWidth / shown.naturalHeight : fallbackAspect(cover.fallback),
      dim: grab ? 0 : src.dim || 0,
      ...(grab || {})
    })
    f.vid = b.vid
    fresh = true
    // 播放器藏起来（离开的这一页本来就在淡出）：画面上只剩浮层这一份
    el.style.opacity = '0'
  }
  f.dir = 'out'
  flight = f
  hideCards(b.vid)

  const alive = () => flight === f && !f.done && f.dir === 'out'
  const land = () => {
    if (flight !== f) return
    flight = null
    reveal(f)
    f.fadeOut()
  }
  // 飞向哪儿：先按返回前记下的卡片位置；新页面排好以后量到的真位置（measured，null 是找不到）回来得早就直接飞它
  let measured
  let started = false
  const go = to => {
    if (!alive()) return
    if (to === null) {
      flight = null
      reveal(f)
      f.fadeOut(tok().d2)
      return
    }
    started = true
    f.fly(to, land)
    if (fresh) {
      fresh = false
      f.fadeFrame(f.seg?.D || 360)
    }
  }
  if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => go(measured === undefined ? target : measured)))
  else go(target) // 掉头：本来就在动，马上接着飞

  // 新页面换上（这一帧画出来）以后量真正的卡片
  requestAnimationFrame(() => {
    if (!alive()) return
    const sel = `.vc[data-vid="${b.vid.replace(/["\\]/g, '\\$&')}"] > .cv`
    const cards = [...document.querySelectorAll(sel)]
    if (!cards.length) return go(null)
    whenMeasured(cards, rects => {
      if (!alive()) return
      const now = appBox()
      let best = null
      let bestD = Infinity
      rects.forEach((r, i) => {
        if (!r.width || !r.height) return
        const s = { ...toApp(r, now), r: target.r, c: target.c }
        const d = Math.hypot(s.x - target.x, s.y - target.y)
        if (d < bestD) { best = { s, el: cards[i], r }; bestD = d }
      })
      let to = null
      if (best) {
        // 和记下的位置一样：裁切、圆角也一样，不用再一层层读样式；不一样（滚动位置变了）才重新算
        to = near(best.s, target) ? target : stateOf(best.el, now)
        if (to && clipped(to.c) && !supportsClip()) to = null
      }
      if (!started) {
        measured = to
        return
      }
      if (to === null) return go(null)
      if (to !== target) go(to)
    })
  })
}

/* 一组元素排版后的位置（IntersectionObserver 在这一帧排完版以后带回来，不额外逼浏览器排版） */
function whenMeasured(els, cb) {
  if (typeof IntersectionObserver !== 'function') {
    cb(els.map(el => el.getBoundingClientRect()))
    return
  }
  const io = new IntersectionObserver(entries => {
    io.disconnect()
    const byEl = new Map(entries.map(e => [e.target, e.boundingClientRect]))
    cb(els.map(el => byEl.get(el) || { width: 0, height: 0 }))
  })
  for (const el of els) io.observe(el)
}
