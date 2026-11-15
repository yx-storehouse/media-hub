import { reactive } from 'vue'
import { errorText, MSG } from '@/api/http'

/** Global toast state, rendered once by <AppToast /> in App.vue. */
export const toastState = reactive({ text: '', visible: false })

let timer = 0

/** Show a short message at the bottom of the screen. */
export function toast(text, duration = 1600) {
  toastState.text = text
  toastState.visible = true
  clearTimeout(timer)
  timer = setTimeout(() => { toastState.visible = false }, duration)
}

/**
 * 操作（点赞、收藏、关注、删除……）失败时的提示，用统一的说法（api/http.js 的 errorText）：
 *   catch (e) { rollback(); toastError(e) }              // 不认识的错误说「操作失败，请稍后重试」
 *   catch (e) { toastError(e, '收藏失败，请稍后重试') }    // 换一句兜底的话
 * 不提示的：取消的请求（AbortError）；登录已过期（登录框已经弹出来并说明了，重新登录后操作会自动补做）。
 */
export function toastError(e, fallback = MSG.action) {
  if (!e || e.name === 'AbortError' || e.code === 'unauthorized') return
  const text = errorText(e, fallback)
  if (text) toast(text, 2200)
}
