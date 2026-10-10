/*
 * 轻量占位图：管理后台新建的视频 / 帖子 / 专题用（seed 数据仍用 art.mjs 的风景图，不受影响）。
 *
 * art.mjs 的风景图每张约 7.5 KB，导入 2 万条视频就多出 ~150 MB，而且一行放不下、要溢出到额外的数据库页，
 * 列表 / 统计扫表时都得顺着溢出页读。这里每张 ≤ 1.5 KB：渐变底色 + 柔光 + 山丘或光斑，
 * 配色由 seed 决定，同一个 seed 永远生成同一张。返回值和 art.mjs 的 fallback 一样是 CSS 的 url('data:…')。
 */
import { rng, pick } from './random.mjs'

const svgUrl = svg => "url('data:image/svg+xml;utf8," + encodeURIComponent(svg).replace(/'/g, '%27') + "')"

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
  let defs, body
  if (r() < 0.6) {
    // 黄昏：上暗下亮的天空 + 太阳柔光 + 两道山丘
    const sun = hex(h3 + 10, 90, 86)
    const sx = n1(W * (0.2 + r() * 0.6)), sy = n1(H * (0.42 + r() * 0.16))
    const hill = (base, amp) => {
      const y0 = n1(H * (base + (r() - 0.5) * amp)), y1 = n1(H * (base + (r() - 0.5) * amp))
      return `M0 ${y0}Q${n1(W * (0.2 + r() * 0.6))} ${n1(H * (base - amp * (0.4 + r() * 1.2)))} ${W} ${y1}V${H}H0Z`
    }
    defs = `<linearGradient id="g" x2="0" y2="1"><stop stop-color="${hex(h1, 30 + r() * 15, 14 + r() * 6)}"/>` +
      `<stop offset=".6" stop-color="${hex(h2, 35 + r() * 15, 32 + r() * 8)}"/><stop offset="1" stop-color="${hex(h3, 50 + r() * 15, 56 + r() * 8)}"/></linearGradient>` +
      `<radialGradient id="s"><stop stop-color="${sun}" stop-opacity=".9"/><stop offset=".3" stop-color="${sun}" stop-opacity=".35"/><stop offset="1" stop-color="${sun}" stop-opacity="0"/></radialGradient>`
    body = `<rect width="${W}" height="${H}" fill="url(#g)"/><circle cx="${sx}" cy="${sy}" r="${n1(Math.min(W, H) * 0.45)}" fill="url(#s)"/>` +
      `<path d="${hill(0.72, 0.2)}" fill="${hex(h1, 25, 16)}" opacity=".85"/><path d="${hill(0.86, 0.12)}" fill="${hex(h1, 25, 8)}"/>`
  } else {
    // 光斑：对角渐变 + 两团柔和的彩色光
    const blob = (id, h) => `<radialGradient id="${id}"><stop stop-color="${hex(h, 70, 62)}" stop-opacity=".85"/><stop offset="1" stop-color="${hex(h, 70, 62)}" stop-opacity="0"/></radialGradient>`
    const circle = id => `<circle cx="${n1(r() * W)}" cy="${n1(r() * H)}" r="${n1(Math.max(W, H) * (0.3 + r() * 0.25))}" fill="url(#${id})"/>`
    defs = `<linearGradient id="g" x2="1" y2="1"><stop stop-color="${hex(h1, 40, 12 + r() * 6)}"/><stop offset="1" stop-color="${hex(h2, 40, 26 + r() * 8)}"/></linearGradient>` +
      blob('a', h1 + 40) + blob('b', h1 + 150)
    body = `<rect width="${W}" height="${H}" fill="url(#g)"/>${circle('a')}${circle('b')}`
  }
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><defs>${defs}</defs>${body}</svg>`)
}

/** 文档帖的缩略图：白纸 + 几行字（所有行合成一条 path） */
export function liteDoc(seed) {
  const r = rng(seed)
  let d = ''
  for (let i = 0; i < 18; i++) d += `M8 ${n1(14 + i * 5.2)}h${Math.round(i % 6 === 5 ? 30 + r() * 15 : 60 + r() * 30)}v1.6H8z`
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 118" preserveAspectRatio="xMidYMid slice"><rect width="100" height="118" fill="#fff"/><path d="${d}" fill="#444" opacity=".7"/></svg>`)
}
