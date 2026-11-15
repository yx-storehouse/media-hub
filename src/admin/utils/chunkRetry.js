/*
 * 管理后台的页面文件（懒加载的 JS / CSS 块）下载失败后的恢复：router.js 的 lazy() 和 main.js 的 router.onError 用。
 *
 * 和移动端的 src/utils/chunkRetry.js 做的是同一件事，但后台不能引用它：那个文件两个入口都用，打包时会被分进移动端的
 * kit 块，后台为了它要多下载 common / kit / pinia / data 好几百 KB（后台和移动端互不引用，见 src/admin/README.md）。
 * 后台只在桌面浏览器里用，用不着移动端那套 Safari 内核的换地址重试，这里只留后台要的几样：
 *   isChunkError(e)       是不是「页面文件下载失败」（各家浏览器的说法、Vite 的「Unable to preload CSS」）
 *   whenOnline(maxMs)     断网就等联网（最多 maxMs），返回是否在线
 *   probe(file)           这个文件现在能不能下载：'ok' / 'missing'（404，多半是发了新版本）/ 'offline'
 *   ensureStyles(urls)    没加载上的样式表换个带参数的地址重新加载
 *   reloadOnce(key, fn)   整页重新加载一次（30 秒内只重载一次，不会死循环）
 *   sleep(ms)
 */

const CHUNK_RE = /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|Failed to load module script|dynamically imported module/i
export const isChunkError = e => !!e && CHUNK_RE.test(String((e && e.message) || e))

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 现在断网就等联网（最多 maxMs），联网后再稍等一下让网络稳定；返回是否在线 */
export function whenOnline(maxMs = 60000, settleMs = 400) {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve(true)
  return new Promise(resolve => {
    const done = ok => {
      clearTimeout(timer)
      window.removeEventListener('online', onOnline)
      if (ok) setTimeout(() => resolve(true), settleMs)
      else resolve(false)
    }
    const onOnline = () => done(true)
    const timer = setTimeout(() => done(navigator.onLine !== false), maxMs)
    window.addEventListener('online', onOnline)
  })
}

const abs = f => new URL(f, document.baseURI).href
const bust = url => url + (url.includes('?') ? '&' : '?') + 'r=' + Date.now().toString(36)

/** 看一眼这个文件现在能不能下载（不走缓存） */
export async function probe(file) {
  try {
    const r = await fetch(bust(abs(file)), { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
    if (r.ok) return 'ok'
    return r.status === 404 || r.status === 410 ? 'missing' : 'offline'
  } catch {
    return 'offline'
  }
}

/* 这个 <link> 的样式表真的加载上了（同源样式表读得到规则） */
function loadedSheet(l) {
  try {
    return !!l.sheet && l.sheet.cssRules.length > 0
  } catch {
    return false
  }
}

/** 确保这些样式表已经加载上：之前失败的 <link> 换成带新参数的地址重新加载（Vite 对每个 CSS 只试一次） */
export function ensureStyles(urls) {
  return Promise.all((urls || []).map(abs).map(url => {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')].filter(l => l.href === url || l.href.startsWith(url + '?'))
    if (links.some(loadedSheet)) return null
    for (const l of links) l.remove()
    return new Promise((resolve, reject) => {
      const l = document.createElement('link')
      l.rel = 'stylesheet'
      l.crossOrigin = ''
      l.href = bust(url)
      l.addEventListener('load', resolve)
      l.addEventListener('error', () => reject(new Error('Unable to preload CSS for ' + url)))
      document.head.appendChild(l)
    })
  }))
}

/** 整页重新加载一次；key 区分用途，30 秒内已经重载过就不再重载，返回 false。beforeReload：重载前要做的事（换地址） */
export function reloadOnce(key, beforeReload = null, windowMs = 30000) {
  let last = 0
  try { last = Number(sessionStorage.getItem(key)) || 0 } catch { /* 隐私模式：当作没重载过 */ }
  if (Date.now() - last < windowMs) return false
  try { sessionStorage.setItem(key, String(Date.now())) } catch { /* 忽略 */ }
  try { beforeReload?.() } catch { /* 忽略 */ }
  window.location.reload()
  return true
}
