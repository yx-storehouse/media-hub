import { reactive, computed } from 'vue'

/*
 * 全局轻提示：toast('已保存', { type: 'ok' })
 *   type: 'info' | 'ok' | 'error'；duration 毫秒（error 默认停留更久）
 * 由 App.vue 里挂一次的 <ToastHost /> 渲染，右下角堆叠，最多同时 5 条。
 */
export const toasts = reactive([])
let seq = 0

/*
 * 贴在窗口底部的固定条（批量操作条）实际占用的高度（从窗口底边算起，px）。
 * BatchBar 用 ResizeObserver 量出来登记在这里；提示条整体叠到最高的那条上面，换行变成两排也不会挡住按钮。
 */
const insets = reactive(new Map())
export const bottomInset = computed(() => {
  let max = 0
  for (const v of insets.values()) max = Math.max(max, v)
  return max
})
/** key 任意（每个固定条一个）；px <= 0 表示不再占用 */
export function setBottomInset(key, px) {
  if (px > 0) insets.set(key, Math.ceil(px))
  else insets.delete(key)
}

export function toast(message, { type = 'info', duration } = {}) {
  const id = ++seq
  const ms = duration ?? (type === 'error' ? 5000 : 2600)
  toasts.push({ id, message: String(message ?? ''), type })
  while (toasts.length > 5) toasts.shift()
  if (ms > 0) setTimeout(() => dismissToast(id), ms)
  return id
}

export function dismissToast(id) {
  const i = toasts.findIndex(t => t.id === id)
  if (i >= 0) toasts.splice(i, 1)
}

/** 接口报错统一提示；被取消的请求（切换筛选、关页面）不打扰用户 */
export function toastError(e, fallback = '操作失败') {
  if (!e || e.name === 'AbortError') return
  toast(e.message || fallback, { type: 'error' })
}
