// 由 src/mock/art.js 同步而来：只做两处改动——去掉 @/mock/random 别名、追加 CommonJS 导出。
// 服务端与前端共用同一套随机数与占位图生成逻辑，保证两边数据完全一致。
/*
 * Mock artwork.
 *
 * Every image in the app is described by a `Cover`:  { src: string | null, fallback: string }
 *   src       real photo URL (picsum.photos, seeded so the same item always gets the same picture)
 *   fallback  CSS `url(...)` of a generated SVG scene, shown underneath until / unless the photo loads
 *
 * The fallback SVG is built lazily the first time it is read, so lists that are never rendered cost nothing.
 * When a real backend is plugged in, the API only needs to return `{ src: 'https://…' }`.
 */
import { hash, rng, pick } from './random.mjs'

/* saturation is scaled down so the generated fallbacks stay muted like real photos */
const hsl = (h, s, l, a) => `hsl(${(Math.round(h) % 360 + 360) % 360} ${Math.round(s * 0.6)}% ${Math.round(l)}%${a != null ? ' / ' + a : ''})`
const WARM = [8, 18, 26, 34, 42, 336, 348, 354, 205]
const svgUrl = svg => "url('data:image/svg+xml;utf8," + encodeURIComponent(svg).replace(/'/g, '%27') + "')"

function ridge(r, base, amp, n, smooth) {
  const pts = []
  for (let i = 0; i <= n; i++) pts.push([160 * i / n, base - r() * amp])
  let d = `M0 100L0 ${pts[0][1].toFixed(1)}`
  if (smooth) {
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], cx = (x0 + x1) / 2
      d += `C${cx.toFixed(1)} ${y0.toFixed(1)} ${cx.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`
    }
  } else {
    for (let i = 1; i < pts.length; i++) d += `L${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`
  }
  return d + 'L160 100Z'
}

/** Scenic SVG (viewBox 160x100 => 16:10). kind: 0 dusk mountains, 1 night, 2 sea, 3 soft blobs, 4 pine forest, 5 skyline */
function sceneSVG(seed, o = {}) {
  const r = rng(seed), kind = o.kind != null ? o.kind : Math.floor(r() * 6)
  const dim = o.dark ? 0.55 : 1
  const h1 = pick(r, WARM) + (r() - 0.5) * 14, h2 = (h1 + 18 + r() * 28) % 360
  const g = (id, a, b) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`
  let defs = '', body = ''
  if (kind === 0 || kind === 2) {
    defs += g('s', hsl(h1, 55, 22 * dim + 8), hsl(h2, 85, 62 * dim + 6))
    body += '<rect width="160" height="100" fill="url(#s)"/>'
    const sx = 30 + r() * 100, sy = 34 + r() * 14
    defs += `<radialGradient id="sun"><stop offset="0" stop-color="${hsl(h2 + 20, 100, 90)}"/><stop offset=".35" stop-color="${hsl(h2 + 15, 100, 75, .55)}"/><stop offset="1" stop-color="${hsl(h2, 100, 70, 0)}"/></radialGradient>`
    body += `<circle cx="${sx}" cy="${sy}" r="30" fill="url(#sun)"/><circle cx="${sx}" cy="${sy}" r="6.5" fill="${hsl(h2 + 20, 100, 92)}"/>`
    if (kind === 0) {
      for (let i = 0; i < 3; i++) body += `<path d="${ridge(r, 78 - i * 6 + 14, 22 + i * 4, 7 + i, false)}" fill="${hsl(h1, 40 - i * 6, (28 - i * 8) * dim + 4)}" opacity="0.95"/>`
    } else {
      for (let i = 0; i < 5; i++) {
        const y = 58 + i * 9
        let d = `M0 ${y}`
        for (let x = 0; x <= 160; x += 8) d += `L${x} ${(y + Math.sin(x / 9 + i * 1.7 + r()) * 1.8).toFixed(1)}`
        d += 'L160 100L0 100Z'
        body += `<path d="${d}" fill="${hsl(h1 + i * 4, 55, (34 - i * 5) * dim + 6)}" opacity="${0.55 + i * 0.1}"/>`
      }
    }
  } else if (kind === 1) {
    defs += g('s', hsl(h1, 60, 6 + 6 * dim), hsl(h1 + 20, 55, 16 + 14 * dim))
    body += '<rect width="160" height="100" fill="url(#s)"/>'
    for (let i = 0; i < 46; i++) body += `<circle cx="${(r() * 160).toFixed(1)}" cy="${(r() * 62).toFixed(1)}" r="${(r() * 0.7 + 0.2).toFixed(2)}" fill="#fff" opacity="${(0.3 + r() * 0.7).toFixed(2)}"/>`
    const mx = 24 + r() * 112
    body += `<circle cx="${mx}" cy="24" r="14" fill="${hsl(h1, 80, 85, .12)}"/><circle cx="${mx}" cy="24" r="6" fill="${hsl(50, 60, 92)}"/>`
    body += `<path d="${ridge(r, 86, 20, 6, true)}" fill="${hsl(h1, 40, 10 + 4 * dim)}"/><path d="${ridge(r, 94, 14, 8, true)}" fill="${hsl(h1, 40, 5 + 2 * dim)}"/>`
  } else if (kind === 3) {
    defs += g('s', hsl(h1, 60, 14 * dim + 6), hsl(h2, 60, 26 * dim + 8))
    body += '<rect width="160" height="100" fill="url(#s)"/>'
    for (let i = 0; i < 4; i++) {
      const id = 'b' + i
      defs += `<radialGradient id="${id}"><stop offset="0" stop-color="${hsl(h1 + i * 50, 90, 62 * dim + 10, .9)}"/><stop offset="1" stop-color="${hsl(h1 + i * 50, 90, 60, 0)}"/></radialGradient>`
      body += `<circle cx="${(r() * 160).toFixed(0)}" cy="${(r() * 100).toFixed(0)}" r="${(30 + r() * 38).toFixed(0)}" fill="url(#${id})"/>`
    }
  } else if (kind === 4) {
    defs += g('s', hsl(h1, 45, 34 * dim + 8), hsl(h2, 60, 70 * dim + 10))
    body += `<rect width="160" height="100" fill="url(#s)"/><circle cx="${30 + r() * 100}" cy="30" r="9" fill="${hsl(h2, 90, 92, .85)}"/>`
    for (let L = 0; L < 3; L++) {
      const base = 70 + L * 10, col = hsl(h1 + 100, 40 - L * 5, (26 - L * 8) * dim + 4)
      for (let x = -4; x < 168; x += 7 + r() * 6) {
        const hgt = 22 + r() * 18 - L * 3, w = 5 + r() * 3
        body += `<path d="M${x} ${base}L${x + w} ${base - hgt}L${x + w * 2} ${base}Z" fill="${col}"/>`
      }
      body += `<rect x="0" y="${base - 1}" width="160" height="${101 - base}" fill="${col}"/>`
    }
  } else {
    defs += g('s', hsl(h1, 55, 14 * dim + 6), hsl(h2, 80, 52 * dim + 10))
    body += '<rect width="160" height="100" fill="url(#s)"/>'
    let x = -4
    while (x < 160) {
      const w = 8 + r() * 14, hgt = 22 + r() * 46, col = hsl(h1, 35, 8 + r() * 6 * dim)
      body += `<rect x="${x}" y="${100 - hgt}" width="${w}" height="${hgt}" fill="${col}"/>`
      for (let wy = 100 - hgt + 4; wy < 96; wy += 5) {
        for (let wx = x + 2; wx < x + w - 2; wx += 4) if (r() > 0.58) body += `<rect x="${wx.toFixed(1)}" y="${wy}" width="1.8" height="2.4" fill="${hsl(46, 100, 70, (0.5 + r() * 0.5).toFixed(2))}"/>`
      }
      x += w + r() * 2
    }
  }
  if (o.vignette !== false) body += '<rect width="160" height="100" fill="url(#vg)"/>'
  defs += `<radialGradient id="vg" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${o.dark ? 0.5 : 0.28}"/></radialGradient>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice"><defs>${defs}</defs>${body}</svg>`
}

/* mock photo host; when switching to a real image CDN also update the preconnect hints in index.html */
const photoUrl = (seed, w, h) => `https://picsum.photos/seed/rl${hash(seed)}/${w}/${h}`

/** Build a Cover whose `fallback` is generated on first access. */
function lazyCover(src, build) {
  let fb
  return {
    src,
    get fallback() {
      return fb || (fb = svgUrl(build()))
    }
  }
}

/**
 * Scenic cover.
 * @param {string} seed  stable id of the item (decides both the photo and the fallback art)
 * @param {{kind?:number, dark?:boolean, vignette?:boolean, w?:number, h?:number, photo?:boolean}} [o]
 */
export function cover(seed, o = {}) {
  return lazyCover(o.photo === false ? null : photoUrl(seed, o.w || 640, o.h || 400), () => sceneSVG(seed, o))
}

/** Round avatar: photo + gradient disc with the first character as fallback. */
export function avatar(name, seed) {
  const key = seed != null ? seed : name
  return lazyCover(photoUrl('av' + key, 200, 200), () => {
    const r = rng(key), h = r() * 360, h2 = (h + 50 + r() * 60) % 360
    const ch = String(name).trim().slice(0, 1)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hsl(h, 70, 62)}"/><stop offset="1" stop-color="${hsl(h2, 75, 38)}"/></linearGradient></defs><rect width="100" height="100" fill="url(#a)"/><circle cx="76" cy="22" r="26" fill="#fff" opacity=".12"/><text x="50" y="66" text-anchor="middle" font-size="46" font-weight="700" fill="#fff" font-family="PingFang SC,Microsoft YaHei,sans-serif">${ch}</text></svg>`
  })
}

/** Brand avatars for the two official community accounts (no photo). */
export function brandAvatar(kind) {
  return lazyCover(null, () => (kind === 'ai'
    ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#262626"/><g fill="#d9d9d9"><circle cx="40" cy="40" r="9"/><circle cx="60" cy="40" r="9"/><rect x="26" y="52" width="48" height="3" rx="1.5"/></g><text x="50" y="72" text-anchor="middle" font-size="12" fill="#d9d9d9" font-family="serif" font-weight="700">AI剧场</text></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#000"/><text x="50" y="44" text-anchor="middle" font-size="20" font-weight="800" fill="#fff" font-family="PingFang SC,Microsoft YaHei,sans-serif">每日</text><rect x="22" y="52" width="56" height="26" fill="#fff"/><text x="50" y="72" text-anchor="middle" font-size="20" font-weight="800" fill="#111" font-family="PingFang SC,Microsoft YaHei,sans-serif">大赛</text></svg>'))
}

/** Page-of-text thumbnail used by text posts. */
export function docThumb(seed, dark) {
  return lazyCover(null, () => {
    const r = rng(seed)
    let lines = ''
    for (let i = 0; i < 26; i++) {
      const w = 60 + r() * 30
      lines += `<rect x="8" y="${14 + i * 5.2}" width="${i % 7 === 6 ? w * 0.5 : w}" height="1.6" rx=".8" fill="${dark ? '#bbb' : '#444'}" opacity=".7"/>`
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 118" preserveAspectRatio="xMidYMid slice"><rect width="100" height="118" fill="${dark ? '#59595c' : '#fff'}"/>${lines}</svg>`
  })
}
