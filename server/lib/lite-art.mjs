/*
 * 轻量占位图：管理后台新建的视频 / 帖子 / 专题用（种子数据的风景图见 art.mjs，库里存的是 art-store.mjs 的短地址）。
 *
 * 返回值是 CSS background-image 的值（和 Cover.fallback 同一种东西），纯 CSS 渐变，200～400 字节，没有 SVG：
 * 列表追加一页时浏览器不用再为每张卡片解析一个 SVG 文档，导入几万条也不会让库变大、行溢出。
 * 画面和以前的 SVG 版一样（同一个 seed 取同样的随机数，颜色、太阳 / 光斑的位置都不变）：
 *   黄昏：上暗下亮的天空 + 太阳柔光 + 两道山丘（椭圆）；光斑：对角渐变 + 两团柔和的彩色光。
 * 配色由 seed 决定，同一个 seed 永远生成同一张。
 */
import { rng, pick } from './random.mjs'

/** HSL → #rrggbb（比 hsl() 写法短） */
function hex(h, s, l) {
  h = ((h % 360) + 360) % 360
  s = Math.max(0, Math.min(100, s)) / 100
  l = Math.max(0, Math.min(100, l)) / 100
  const a = s * Math.min(l, 1 - l)
  const f = n => {
    const k = (n + h / 30) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
}

/* 和 art.mjs 一样偏暖、偏灰的色相，再加几种冷色，饱和度压低，看起来像真实照片的色调 */
const HUES = [8, 18, 26, 34, 42, 336, 348, 354, 205, 190, 215, 235, 265, 160]
const n1 = x => Math.round(x * 10) / 10
/** 画布坐标 → 百分比（保留一位小数） */
const pct = (v, total) => n1(v / total * 100) + '%'

/**
 * 一道山丘：原来是 M0 y0 Q cx cy W y1 的二次曲线，这里用底边中心在曲线最高点下方的椭圆近似，
 * 横向半径取能让椭圆在左右两边的高度接近 y0 / y1 的值。
 */
function hillLayer(W, H, y0, y1, cx, cy, color, alpha = '') {
  const px = (2 * cx + W) / 4                // t = 0.5 处的横坐标、纵坐标（曲线大致的顶点）
  const py = Math.min(y0, y1, (y0 + 2 * cy + y1) / 4)
  const ry = Math.max(1, H - py)
  const fit = (dx, y) => {
    const k = Math.min(0.97, Math.max(0, (H - y) / ry))
    return dx / Math.sqrt(1 - k * k)
  }
  const rx = Math.min(3 * W, Math.max(0.5 * W, (fit(px, y0) + fit(W - px, y1)) / 2))
  return `radial-gradient(${pct(rx, W)} ${pct(ry, H)} at ${pct(px, W)} 100%,${color}${alpha} 98%,${color}00 100%)`
}

/**
 * 封面占位图。
 * @param {string} seed  稳定的种子（如 'vid-VID-1001'）
 * @param {{ w?: number, h?: number }} [o]  目标宽高，只用来定画布比例（默认 16:10）
 */
export function liteCover(seed, o = {}) {
  const r = rng(seed)
  const W = 160
  const H = Math.max(60, Math.min(400, Math.round(W * (o.h || 100) / (o.w || 160))))
  const h1 = pick(r, HUES) + (r() - 0.5) * 16
  const h2 = h1 + 8 + r() * 24
  const h3 = h2 + 6 + r() * 18
  if (r() < 0.6) {
    // 黄昏：上暗下亮的天空 + 太阳柔光 + 两道山丘（随机数的取用顺序和原来的 SVG 版一致）
    const sun = hex(h3 + 10, 90, 86)
    const sx = n1(W * (0.2 + r() * 0.6)), sy = n1(H * (0.42 + r() * 0.16))
    const sky = [hex(h1, 30 + r() * 15, 14 + r() * 6), hex(h2, 35 + r() * 15, 32 + r() * 8), hex(h3, 50 + r() * 15, 56 + r() * 8)]
    const hill = (base, amp, color, alpha) => {
      const y0 = n1(H * (base + (r() - 0.5) * amp)), y1 = n1(H * (base + (r() - 0.5) * amp))
      const cx = n1(W * (0.2 + r() * 0.6)), cy = n1(H * (base - amp * (0.4 + r() * 1.2)))
      return hillLayer(W, H, y0, y1, cx, cy, color, alpha)
    }
    const far = hill(0.72, 0.2, hex(h1, 25, 16), 'd9')
    const near = hill(0.86, 0.12, hex(h1, 25, 8))
    const rad = Math.min(W, H) * 0.45
    const glow = `radial-gradient(${pct(rad, W)} ${pct(rad, H)} at ${pct(sx, W)} ${pct(sy, H)},${sun}e6,${sun}59 30%,${sun}00)`
    // 写在前面的层盖在上面：近处的山 → 远处的山 → 太阳 → 天空
    return `${near},${far},${glow},linear-gradient(${sky[0]},${sky[1]} 60%,${sky[2]})`
  }
  // 光斑：对角渐变 + 两团柔和的彩色光
  const base = [hex(h1, 40, 12 + r() * 6), hex(h2, 40, 26 + r() * 8)]
  const blob = h => {
    const c = hex(h, 70, 62)
    const x = r() * W, y = r() * H, rad = Math.max(W, H) * (0.3 + r() * 0.25)
    return `radial-gradient(${pct(rad, W)} ${pct(rad, H)} at ${pct(x, W)} ${pct(y, H)},${c}d9,${c}00)`
  }
  const a = blob(h1 + 40)
  const b = blob(h1 + 150)
  return `${b},${a},linear-gradient(to bottom right,${base[0]},${base[1]})`
}

/** 文档帖的缩略图：白纸 + 一行行字（灰色横线），页边留白 */
export function liteDoc(seed) {
  const r = rng(seed)
  // 每行宽度随种子略有不同：取平均宽度定右边距（和原来一样，每 6 行有一行短的）
  let total = 0
  for (let i = 0; i < 18; i++) total += i % 6 === 5 ? 30 + r() * 15 : 60 + r() * 30
  const right = Math.round(8 + total / 18)
  return 'linear-gradient(#fff 11.8%,#fff0 11.8% 89%,#fff 89%),' +
    `linear-gradient(90deg,#fff 8%,#fff0 8% ${right}%,#fff ${right}%),` +
    'repeating-linear-gradient(#fff 0 3.1%,#7c7c7c 3.1% 4.4%)'
}
