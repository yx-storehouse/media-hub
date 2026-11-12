/*
 * 在浏览器里读图片的宽高（像素，按 EXIF 方向转正后的显示尺寸）。图集保存前给每张图补上 naturalWidth / naturalHeight，
 * 前台按真实比例排版；服务端只会给站内 /media/ 的图读文件头，外链图片只能靠这里。
 *
 *   await imageSize('/media/images/a.jpg', { timeout: 15000, signal })   // → { width, height } | null
 *   await imageSize(file)                                                // File / Blob：本地读，不用等上传完
 *
 * 读不到（加载失败、超时、取消、地址不是 http(s):// 或 /…）一律返回 null，不抛错：调用方按「尺寸未知（0）」处理。
 * 同一个地址读到过就记住（最多几百条），重复添加同一张图不再请求。
 */
import { resolveUrl } from '../api'

const LOADABLE = /^(https?:)?\/\/|^\/(?!\/)|^blob:/i
const cache = new Map()
const CACHE_MAX = 500

export function imageSize(src, { timeout = 15000, signal } = {}) {
  const isBlob = typeof Blob !== 'undefined' && src instanceof Blob
  const key = isBlob ? '' : String(src || '').trim()
  if (key && cache.has(key)) return Promise.resolve({ ...cache.get(key) })
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(null)
    const url = isBlob ? URL.createObjectURL(src) : LOADABLE.test(key) ? resolveUrl(key) : ''
    if (!url) return resolve(null)
    const img = new Image()
    img.decoding = 'async'
    img.referrerPolicy = 'no-referrer'
    let timer = 0
    const done = size => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      img.onload = img.onerror = null
      // 超时 / 取消时停止下载
      if (!size) img.removeAttribute('src')
      if (isBlob) URL.revokeObjectURL(url)
      if (size && key) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
        cache.set(key, size)
      }
      resolve(size ? { ...size } : null)
    }
    const onAbort = () => done(null)
    img.onload = () => done(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null)
    img.onerror = () => done(null)
    timer = setTimeout(() => done(null), timeout)
    signal?.addEventListener('abort', onAbort, { once: true })
    img.src = url
  })
}

/** 记下一个已知的尺寸（比如上传前从本地文件读到的），之后按地址读时直接用 */
export function rememberImageSize(src, size) {
  const key = String(src || '').trim()
  if (!key || !size?.width || !size?.height) return
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { width: size.width, height: size.height })
}
