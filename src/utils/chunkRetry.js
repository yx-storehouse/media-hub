/*
 * 页面代码（懒加载的 JS / CSS 块）下载失败后的恢复。用户端（router/index.js）和管理后台都能用：不依赖 Vue。
 *
 * 为什么要专门处理：断网几秒、NAS / 容器重启、换 Wi-Fi 时正好在下载页面代码，import() 就会失败。
 * Chrome 下次 import 同一个地址会重新下载；Safari 内核（iPhone Safari、iOS App 的 WKWebView）会把失败记住，
 * 同一个页面里再 import 这个地址直接失败、不再发请求——不处理的话，这次打开里点什么都没反应。
 * 所以：等联网 → 原地址再试一次 → 换一个带参数的新地址再试（隔 1 / 2 / 4 / 8 秒，服务器重启也等得过来）；
 * 文件已经不在了（发了新版本，旧页面里的文件名过期）就整页重新加载一次（30 秒内只重载一次，不会死循环）。
 * 注意：Safari 内核里失败的地址连整页刷新都救不回来（同一个进程里一直记着），所以预取只用 fetch 下载进 HTTP 缓存，
 * 下载成功了才 import（见 router/index.js 的 prefetchRoutes），不让预取失败留下记录。
 *
 *   import { isChunkError, whenOnline, probe, importFresh, ensureStyles, reloadOnce } from '@/utils/chunkRetry'
 */

/** 是不是「页面代码下载失败」（各家浏览器的说法不一样） */
const CHUNK_RE = /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|Failed to load module script|dynamically imported module/i
export const isChunkError = e => !!e && CHUNK_RE.test(String((e && e.message) || e))

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

/**
 * 看一眼这个文件现在能不能下载：'ok' 能 / 'missing' 服务器说没有（404，多半是发了新版本）/ 'offline' 连不上。
 * 不走缓存、不记进模块表，失败了也不留下记录。
 */
export async function probe(file) {
  try {
    const r = await fetch(bust(abs(file)), { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
    if (r.ok) return 'ok'
    return r.status === 404 || r.status === 410 ? 'missing' : 'offline'
  } catch {
    return 'offline'
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

const abs = f => new URL(f, document.baseURI).href
const bust = url => url + (url.includes('?') ? '&' : '?') + 'r=' + Date.now().toString(36)

/** 用一个新地址（带 ?r=）加载模块：绕开 Safari 内核记住的失败结果。它静态依赖的块照常共用已加载的那一份 */
export function importFresh(file) {
  return import(/* @vite-ignore */ bust(abs(file)))
}

/*
 * 这个 <link> 的样式表真的加载上了：Chrome 加载失败时 sheet 是 null；Safari 内核加载失败也给一个 sheet，
 * 读它的规则会报跨域错误（我们的样式表都是同源的，加载成功时读得到），所以还要看里面有没有规则
 */
function loadedSheet(l) {
  try {
    return !!l.sheet && l.sheet.cssRules.length > 0
  } catch {
    return false
  }
}

/*
 * 确保这些样式表已经加载上：已经有加载成功的同一个文件就不管；之前失败的那个 <link> 换成带新参数的地址重新加载。
 * （Vite 的预加载辅助函数对每个 CSS 只试一次，失败后再 import 页面也不会再去加载它，页面会没有样式。）
 */
export function ensureStyles(files) {
  const css = (files || []).filter(f => /\.css(\?|$)/.test(f)).map(abs)
  return Promise.all(css.map(url => {
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

/**
 * 整页重新加载一次（新的页面有新的模块表，失败记录都清掉了）。key 区分用途；30 秒内已经重载过就不再重载，返回 false。
 * beforeReload：重载前要做的事（比如把地址换成用户要去的那一页）。
 */
export function reloadOnce(key = 'reel:chunk-reload', beforeReload = null, windowMs = 30000) {
  let last = 0
  try { last = Number(sessionStorage.getItem(key)) || 0 } catch { /* 隐私模式：当作没重载过 */ }
  if (Date.now() - last < windowMs) return false
  try { sessionStorage.setItem(key, String(Date.now())) } catch { /* 忽略 */ }
  try { beforeReload?.() } catch { /* 忽略 */ }
  window.location.reload()
  return true
}
