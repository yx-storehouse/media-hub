/*
 * 图集图片编辑器（AlbumImages.vue）里和服务端保持一致的规则：服务端肯定不收的东西，在浏览器里先挡下来 / 先改好，
 * 不要等到保存时报一句不知道是哪张的错，或者上传失败、点重试也永远传不上去。
 *
 *   urlProblem(s)    图片地址不合格的原因（'' = 可以）；和 server/admin/fields.mjs 的 toUrl + 图集的「一格多个地址」检查一致（只会更严，不会更松）
 *   urlKey(url)      判断是不是同一张图（编码 / 未编码、?v= 算同一个），和 server/lib/urls.mjs 一致
 *   uploadName(file) 上传用的文件名；服务端不收的格式返回 ''。规则和 server/admin/media.mjs 的 cleanRel(strict) + 扩展名白名单一致：
 *                    非法字符换成 _、连续的点合成一个、去掉首尾的点和空格、Windows 保留名前面加 _、
 *                    超过 200 字节从名字末尾截短（保留扩展名）、没有扩展名（剪贴板里的图）按文件类型补上
 *   UPLOAD_ACCEPT    文件选择框的 accept：只列服务端收的格式
 *
 * 纯函数，不依赖页面。
 */
import { IMAGE_EXTS, extOf } from '../media/files'

/* ---------------- 地址 ---------------- */

const URL_MAX = 2000
/* 一格里用空格 / 逗号夹着第二个地址（服务端 fields.mjs 的 SECOND_URL）：多张要用 | 或换行隔开 */
const SECOND_URL = /[\s,，;；、](?:https?:\/\/|\/media\/)/i
/* 服务端拒绝的空白：换行、制表符等控制字符和几种特殊空白（普通空格允许，未编码的 /media/我的 图.jpg） */
const BAD_SPACE = /[\u0000-\u001f\u007f\u0085\u00a0\u2028\u2029\u3000]/

/** 原因接在「N 行」后面读得通（粘贴框里按原因分组提示） */
export function urlProblem(v) {
  const s = String(v ?? '').trim()
  if (!s) return '是空的'
  if (s.length > URL_MAX) return `超过 ${URL_MAX} 个字符`
  if (BAD_SPACE.test(s)) return '含有制表符或特殊空白字符'
  // 和服务端一样：http(s):// 后面要有域名；站内路径以一个 / 开头（// 开头是省略了协议的外链，服务端不收）
  const ok = /^https?:\/\/[^/?#\s]+/i.test(s) || (s.startsWith('/') && !s.startsWith('//'))
  if (!ok) {
    if (/^https?:\/\//i.test(s)) return '缺少域名（http:// 后面要接域名）'
    if (s.startsWith('//')) return '以 // 开头，要写完整（前面加上 https:）'
    return '不是图片地址（要以 http://、https:// 或 / 开头）'
  }
  if (SECOND_URL.test(s)) return '里有多个地址（多张请用 | 或换行隔开）'
  return ''
}

/*
 * 判断「同一张图」用的键，和服务端 server/lib/urls.mjs 的 urlKey 一致：路径逐段解码（编码 / 未编码的写法算同一个），
 * 站内 /media/ 地址再去掉 ?v= 这类查询串。服务端保存时按它去重，编辑器里也按它判断「已经在列表里」，两边张数才对得上。
 */
const decodeSeg = s => { try { return decodeURIComponent(s) } catch { return s } }
export function urlKey(url) {
  const s = String(url ?? '').trim()
  const cut = s.search(/[?#]/)
  const path = cut < 0 ? s : s.slice(0, cut)
  const decoded = path.split('/').map(decodeSeg).join('/')
  return decoded.startsWith('/media/') ? decoded : decoded + (cut < 0 ? '' : s.slice(cut))
}

/* ---------------- 上传文件名 ---------------- */

/* 服务端收的图片类型 → 扩展名（文件没有扩展名、或扩展名服务端不认时按类型补） */
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/apng': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif'
}
/* jpg 的别名（Windows 另存的 .jfif 等）：直接换成 .jpg，不叠成 a.jfif.jpg */
const JPEG_ALIASES = ['jfif', 'jpe', 'pjpeg', 'pjp']
const NAME_MAX_BYTES = 200
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i

export const UPLOAD_ACCEPT = [...IMAGE_EXTS.map(e => '.' + e), ...Object.keys(MIME_EXT)].join(',')

const enc = new TextEncoder()
const byteLen = s => enc.encode(s).length
const trimDots = s => s.replace(/^[. ]+|[. ]+$/g, '')

/**
 * @param {File|{ name: string, type?: string }} file
 * @returns {string}  服务端肯定收的文件名；不是服务端收的图片格式时返回 ''
 */
export function uploadName(file, now = Date.now()) {
  const name = String(file?.name || '').trim()
  const lower = extOf(name)
  let ext = IMAGE_EXTS.includes(lower) ? name.slice(name.length - lower.length) : ''
  let base = ext ? name.slice(0, -(ext.length + 1)) : name
  if (!ext) {
    const mapped = MIME_EXT[String(file?.type || '').toLowerCase()]
    if (!mapped) return ''
    if (JPEG_ALIASES.includes(lower)) base = name.slice(0, -(lower.length + 1))
    ext = mapped
  }
  base = trimDots(base.replace(/[<>:"|?*\\/\u0000-\u001f\u007f]/g, '_').replace(/\.{2,}/g, '.'))
  if (!base) base = `image-${now}`
  if (RESERVED.test(`${base}.${ext}`)) base = '_' + base
  // 按字符（不拆 emoji）从末尾截短到整个名字不超过 200 字节
  if (byteLen(`${base}.${ext}`) > NAME_MAX_BYTES) {
    const chars = Array.from(base)
    const room = NAME_MAX_BYTES - byteLen('.' + ext)
    let used = 0
    let n = 0
    while (n < chars.length && used + byteLen(chars[n]) <= room) used += byteLen(chars[n++])
    base = trimDots(chars.slice(0, n).join('')) || `image-${now}`
  }
  return `${base}.${ext}`
}
