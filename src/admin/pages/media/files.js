/*
 * 素材文件页的小工具：允许的扩展名、复制到剪贴板、拖放（含文件夹）取文件。
 */

/* 和服务端 server/admin/media.mjs 的白名单一致：其他类型上传会被拒绝 */
export const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'm3u8', 'ts']
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']
export const EXTRA_EXTS = ['vtt', 'srt']
/* 安卓安装包：上传到 app/reel.apk，「我的」页在安卓浏览器里显示「下载安卓 App」（见 src/utils/shell.js） */
export const DOWNLOAD_EXTS = ['apk']
export const ALLOWED_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS, ...EXTRA_EXTS, ...DOWNLOAD_EXTS]
export const ACCEPT_ATTR = ALLOWED_EXTS.map(e => '.' + e).join(',')

export const extOf = name => (/\.([^./]+)$/.exec(String(name || '').toLowerCase()) || [])[1] || ''
export const baseOf = name => String(name || '').replace(/\.[^./]+$/, '')
export const isAllowed = name => ALLOWED_EXTS.includes(extOf(name))

/**
 * 复制文字。navigator.clipboard 只在 https / localhost 可用；内网 http 地址退回 execCommand('copy')。
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* 权限被拒等：走下面的兼容写法 */ }
  }
  const active = document.activeElement
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  ta.remove()
  // 复制用的临时输入框抢走了焦点：还给原来的按钮
  if (active && typeof active.focus === 'function') active.focus({ preventScroll: true })
  return ok
}

/**
 * 从拖放事件里取出文件；拖进来的是文件夹时递归展开（保留相对路径，最多 8 层、2000 个文件）。
 * 必须在 drop 事件里同步调用（事件结束后 dataTransfer 就读不到了），返回的 Promise 可以之后再等。
 * @returns {Promise<Array<{ file: File, rel: string }>>}  rel = 相对拖入位置的路径（含文件名）；超出上限时数组带 truncated = true
 */
export function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer?.items || [])].filter(i => i.kind === 'file')
  const entries = items.map(i => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null))
  // 浏览器不支持目录接口：只能拿到平铺的文件
  if (!entries.length || entries.some(e => !e)) {
    const files = [...(dataTransfer?.files || [])]
    return Promise.resolve(files.map(f => ({ file: f, rel: f.name })))
  }
  return collect(entries)
}

const MAX_FILES = 2000
const MAX_DEPTH = 8

export async function collect(entries) {
  const out = []
  const walk = async (entry, prefix, depth) => {
    if (out.length >= MAX_FILES) { out.truncated = true; return }
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject)).catch(() => null)
      if (file) out.push({ file, rel: prefix + entry.name })
      return
    }
    if (!entry.isDirectory || depth >= MAX_DEPTH) return
    const reader = entry.createReader()
    // readEntries 每次最多返回一部分，要反复读到空为止
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)).catch(() => [])
      if (!batch.length) break
      for (const child of batch) await walk(child, prefix + entry.name + '/', depth + 1)
    }
  }
  for (const e of entries) await walk(e, '', 0)
  return out
}
