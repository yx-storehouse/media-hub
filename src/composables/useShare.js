import { toast } from './useToast'

const COPIED = '链接已复制，快去分享给好友吧'

/**
 * 老办法复制：隐藏的 textarea + execCommand。
 * 内网用 http://IP 访问时不是「安全上下文」，navigator.clipboard 不存在，只能靠它。
 * 必须在点击事件的同一个调用栈里执行（iOS 尤其严格），所以放在任何 await 之前。
 */
function legacyCopy(text) {
  const t = document.createElement('textarea')
  t.value = text
  t.setAttribute('readonly', '')
  t.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px' // 16px 防止 iOS 聚焦时放大页面
  document.body.appendChild(t)
  t.select()
  t.setSelectionRange(0, text.length)
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  t.remove()
  return ok
}

/** 都复制不了时把链接直接给用户看，手动复制 */
const showUrl = url => toast(`无法自动复制，请手动复制：${url}`, 5000)

/**
 * Share a link: the system share sheet where available (phones, Capacitor), otherwise copy it.
 * Pass the canonical content URL once a backend provides one; the current page URL is the fallback.
 */
export async function share({ title = document.title, url = location.href } = {}) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url })
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('分享失败，请稍后重试')
    }
    return
  }
  if (!window.isSecureContext || !navigator.clipboard) {
    if (legacyCopy(url)) toast(COPIED)
    else showUrl(url)
    return
  }
  try {
    await navigator.clipboard.writeText(url)
    toast(COPIED)
  } catch {
    if (legacyCopy(url)) toast(COPIED)
    else showUrl(url)
  }
}
