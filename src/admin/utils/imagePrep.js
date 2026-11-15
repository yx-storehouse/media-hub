/*
 * 上传图片前在浏览器里处理（useUploader 自动调用，页面不用管）：
 *   - 大图缩小后按原格式重新编码（JPEG / WebP 质量 0.9）：手机原图 4032×3024、3–5 MB 变成 2048×1536、几百 KB，
 *     App 里点开大图也够清楚。尺寸规则见下面 mainScale（长图不按长边缩）；
 *   - 另外生成一张小图（JPEG，质量 0.82，尺寸规则见 thumbScale），和原图放在同一个文件夹，叫「<原图完整文件名>.thumb.jpg」：
 *     服务端看到有这个文件就在网格、头图里下发它（thumb 字段，见 server/lib/thumbs.mjs），只有全屏看大图才用原图；
 *   - 方向：先按 EXIF 转正再画（<img> 解码时浏览器已经按 EXIF 转好了），重新编码的图不带 EXIF，像素本身就是正的；
 *     没缩小的原图原样上传（EXIF 还在，浏览器照样转正）；
 *   - 不处理：GIF、动图（APNG / 动态 WebP / AVIF 序列）、浏览器解码不了的、长边 ≤ 480 的小图（原图就够小，不要小图）、
 *     名字本身就是 *.thumb.jpg 的。处理出错一律按原图上传，不影响上传本身。
 *
 * 长图（攻略截图、长条拼图、扫描件、全景）：以前按长边缩到 2048，1080×8000 的截图被缩成 276×2048、小图只有 65×480，
 * 字看不清、原图也找不回来。现在：
 *   原图：长边限到 2048，但缩完短边不能小于 1080（原图短边本来就不到 1080 的不缩）——手机看大图按屏宽铺满
 *     （390 × 3 倍屏 ≈ 1170 设备像素），短边就是字的清晰度。普通照片（4:3、3:2、16:9）照旧缩到长边 2048；
 *     只为保短边、又缩不到 0.8 倍的（1170 / 1290 宽的 iPhone 长截图）原样上传：省不了多少，重新编码反而让字发虚。
 *     例：1080×8000、1170×20000 原样；1440×9000 → 1080×6750；3000×9000 → 1080×3240；全景 12000×3000 → 4320×1080。
 *   小图：网格、头图都是 cover 裁切，看的是短边——长边 480，但短边至少 360（4:3 照旧 480×360，16:9 是 640×360）；
 *     长图按短边 360 会很长，再限总像素 ≤ 360×1920（约 69 万）：1080×8000 → 305×2263，全景 12000×3000 → 1440×360。
 *   手动测：后台素材页上传一张 1080×8000 的长截图（带 28px 文字），存下来的应是原图（1080×8000）+ 305×2263 的小图。
 *
 *   const prep = await prepareImage(file)   // → { blob, width, height, resized, thumb: Blob | null } | null（不是要处理的图）
 *   thumbPathOf('images/a b.png') → 'images/a b.png.thumb.jpg'
 */
export const MAX_EDGE = 2048
/** 原图缩完短边不小于它（长图按短边保清晰度） */
export const MIN_SHORT = 1080
/** 只为保短边而缩、缩放比例大于它时不缩（原样上传） */
const MIN_SHRINK = 0.8
export const THUMB_EDGE = 480
/** 小图短边不小于它（cover 裁切的格子看短边） */
export const THUMB_SHORT = 360
/** 小图总像素上限（长图的小图不会长得离谱） */
export const THUMB_MAX_PIXELS = 360 * 1920
export const THUMB_SUFFIX = '.thumb.jpg'

const RESIZABLE = { 'image/jpeg': 0.9, 'image/png': undefined, 'image/webp': 0.9 }
const EXT_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' }

const extOf = name => (/\.([^./]+)$/.exec(String(name || '').toLowerCase()) || [])[1] || ''
export const isThumbPath = path => String(path || '').toLowerCase().endsWith(THUMB_SUFFIX)
/**
 * 原图路径 → 小图路径：完整文件名 + .thumb.jpg（a.jpg → a.jpg.thumb.jpg），和服务端 admin/media.mjs、lib/thumbs.mjs 的规则一样；
 * 名字带着原图的扩展名，同一个文件夹里的 a.jpg 和 a.png 各有各的小图
 */
export const thumbPathOf = path => String(path) + THUMB_SUFFIX

/** 这个文件要不要处理（按类型 / 扩展名粗筛，动图在 prepareImage 里再看文件头） */
export function isPreparable(file, path = file?.name) {
  if (!file || typeof document === 'undefined' || isThumbPath(path)) return false
  const type = EXT_TYPE[extOf(path)] || file.type
  return ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(type)
}

/* ---------------- 动图检测：只读文件头（最多 256 KB） ---------------- */

const ascii = (u8, at, n) => String.fromCharCode(...u8.subarray(at, at + n))
function indexOf(u8, str, from = 0, to = u8.length) {
  const c0 = str.charCodeAt(0)
  outer: for (let i = from; i <= Math.min(to, u8.length) - str.length; i++) {
    if (u8[i] !== c0) continue
    for (let k = 1; k < str.length; k++) if (u8[i + k] !== str.charCodeAt(k)) continue outer
    return i
  }
  return -1
}
async function isAnimated(file, type) {
  let u8
  try { u8 = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()) } catch { return false }
  if (type === 'image/png') {
    // APNG：IDAT 之前有 acTL
    const idat = indexOf(u8, 'IDAT')
    const actl = indexOf(u8, 'acTL', 0, idat < 0 ? u8.length : idat)
    return actl >= 0
  }
  if (type === 'image/webp') {
    // VP8X 扩展头里的动画标记，或者有 ANIM 块
    if (ascii(u8, 12, 4) === 'VP8X' && (u8[20] & 0x02)) return true
    return indexOf(u8, 'ANIM', 12, 4096) >= 0
  }
  if (type === 'image/avif') return indexOf(u8, 'avis', 0, 64) >= 0
  return false
}

/* ---------------- 解码 / 缩放 / 编码 ---------------- */

function decode(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      const done = () => { URL.revokeObjectURL(url); resolve(img) }
      // 等真正解码完再画（大图第一次 drawImage 不会卡在解码上）
      if (typeof img.decode === 'function') img.decode().then(done, done)
      else done()
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')) }
    img.src = url
  })
}

function canvasOf(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * 缩放到 w×h：一次缩太多倍（4032 → 480）直接画会有锯齿，先每次减半、最后一步画到目标尺寸。
 * background：画到不透明格式（JPEG）时先铺的底色（透明 PNG 的小图不会变成黑底）。
 */
function scale(src, sw, sh, w, h, background) {
  let cur = src
  let cw = sw
  let ch = sh
  while (cw / 2 >= w * 1.15 && ch / 2 >= h * 1.15) {
    const nw = Math.round(cw / 2)
    const nh = Math.round(ch / 2)
    const c = canvasOf(nw, nh)
    const g = c.getContext('2d')
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    g.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh)
    cur = c
    cw = nw
    ch = nh
  }
  const out = canvasOf(w, h)
  const g = out.getContext('2d')
  if (background) { g.fillStyle = background; g.fillRect(0, 0, w, h) }
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(cur, 0, 0, cw, ch, 0, 0, w, h)
  return out
}

/** canvas → Blob；浏览器不支持这种格式时（老 Safari 的 WebP 会悄悄变成 PNG）返回 null */
function encode(canvas, type, quality) {
  return new Promise(resolve => {
    try {
      canvas.toBlob(b => resolve(b && b.type === type ? b : null), type, quality)
    } catch {
      resolve(null)
    }
  })
}

/** 按比例 k 缩放后的整数尺寸（至少 1 像素） */
const sized = (w, h, k) => [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]

/**
 * 原图的缩放比例（1 = 不缩）：长边限到 maxEdge，但缩完短边不小于 MIN_SHORT；只为保短边、缩不到 MIN_SHRINK 倍的不缩
 * （见文件头「长图」）。maxEdge = Infinity（给旧图补小图时）永远是 1。
 */
export function mainScale(w, h, maxEdge = MAX_EDGE) {
  const byEdge = maxEdge / Math.max(w, h)
  if (byEdge >= 1) return 1
  const byShort = MIN_SHORT / Math.min(w, h)
  if (byShort <= byEdge) return byEdge // 普通照片：长边到 2048 后短边还够
  return byShort > MIN_SHRINK ? 1 : byShort // 长图 / 全景：按短边保 1080
}

/**
 * 小图的缩放比例（≥ 1 = 不要小图）：长边 thumbEdge，但短边至少 THUMB_SHORT，总像素不超过 THUMB_MAX_PIXELS。
 * 长边本来就 ≤ thumbEdge 的不要小图。
 */
export function thumbScale(w, h, thumbEdge = THUMB_EDGE) {
  if (Math.max(w, h) <= thumbEdge) return 1
  const k = Math.max(thumbEdge / Math.max(w, h), THUMB_SHORT / Math.min(w, h))
  return Math.min(1, k, Math.sqrt(THUMB_MAX_PIXELS / (w * h)))
}

/** 小图的底色：和 App 里图片格子的底色一样 */
const THUMB_BG = '#141414'

/*
 * 一次只处理一张：一张 12MP 的照片解码后约 48 MB，上传队列同时传 3 个时不要同时解码 3 张
 */
let lane = Promise.resolve()

/**
 * @param {File|Blob} file
 * @param {{ path?: string, maxEdge?: number, thumbEdge?: number }} [opts]
 * @returns {Promise<null | { blob: Blob, width: number, height: number, resized: boolean, thumb: Blob | null }>}
 *   null：不是要处理的图（GIF、动图、解码不了…），按原文件上传
 */
export function prepareImage(file, opts = {}) {
  if (!isPreparable(file, opts.path ?? file?.name)) return Promise.resolve(null)
  const run = lane.then(() => prepare(file, opts))
  lane = run.catch(() => null)
  return run
}

async function prepare(file, { path = file?.name, maxEdge = MAX_EDGE, thumbEdge = THUMB_EDGE } = {}) {
  const type = EXT_TYPE[extOf(path)] || file.type
  try {
    if (await isAnimated(file, type)) return null
    const img = await decode(file)
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) return null
    let blob = file
    let width = w
    let height = h
    let resized = false
    const k = mainScale(w, h, maxEdge)
    if (k < 1 && type in RESIZABLE) {
      const [nw, nh] = sized(w, h, k)
      const c = scale(img, w, h, nw, nh, type === 'image/jpeg' ? '#000' : null)
      const b = await encode(c, type, RESIZABLE[type])
      // 编码不了（浏览器不支持、画布太大）就传原图
      if (b) { blob = b; width = nw; height = nh; resized = true }
      c.width = c.height = 0
    }
    let thumb = null
    const tk = thumbScale(w, h, thumbEdge)
    if (tk < 1) {
      const [tw, th] = sized(w, h, tk)
      const c = scale(img, w, h, tw, th, THUMB_BG)
      thumb = await encode(c, 'image/jpeg', 0.82)
      c.width = c.height = 0
    }
    return { blob, width, height, resized, thumb }
  } catch {
    return null
  }
}
