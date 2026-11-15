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

/** 被多少条记录用到（视频按播放地址 / 封面 / 字幕算，图集按里面的图片算） */
export const usedCount = e => (e?.usedBy || 0) + (e?.usedByAlbums || 0)
/** 使用情况：「被 2 个视频、1 个图集使用」/「未被使用」 */
export function usageText(e) {
  const parts = [e?.usedBy ? `${e.usedBy} 个视频` : '', e?.usedByAlbums ? `${e.usedByAlbums} 个图集` : ''].filter(Boolean)
  return parts.length ? `被 ${parts.join('、')}使用` : '未被使用'
}

/* 改名 / 移动后服务端顺手改了地址的各类数据（refs 的键 → 说法） */
const REF_TEXT = { videos: '个视频', albums: '个图集', posts: '条帖子', topics: '个专题', creators: '个创作者头像', users: '个账号头像', episodes: '个剧集' }
/** refs → 「3 个视频、1 个图集」（都是 0 返回 ''） */
export function refsText(refs) {
  return Object.entries(refs || {}).filter(([k, n]) => n > 0 && REF_TEXT[k]).map(([k, n]) => n + ' ' + REF_TEXT[k]).join('、')
}

/** 素材文件名的本地检查（和服务端 server/admin/media.mjs 的 cleanRel 一样的说法）；name 是一段名字，不含 / */
export function nameProblem(name) {
  const s = String(name || '')
  if (!s.trim()) return '请输入名称'
  if (s === '.' || s === '..') return '名称不能是 . 或 ..（不能用它们跳到别的文件夹）'
  if (s.includes('..')) return '名称不能包含 ..'
  if (/[\\:*?"<>|]/.test(s)) return '名称不能包含 \\ : * ? " < > | 这些字符'
  if (/[\u0000-\u001f\u007f]/.test(s)) return '名称包含非法字符'
  if (/^[. ]|[. ]$/.test(s)) return '名称不能以点或空格开头 / 结尾'
  if (new TextEncoder().encode(s).length > 200) return '名称过长（最多 200 字节）'
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) return `「${s}」是系统保留名称`
  return ''
}

/** 以 .thumb.jpg 结尾的是小图（App 网格用）：和原图同名同文件夹，跟着原图走 */
export const THUMB_SUFFIX = '.thumb.jpg'
export const isThumbName = name => String(name || '').toLowerCase().endsWith(THUMB_SUFFIX) && String(name).length > THUMB_SUFFIX.length

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
