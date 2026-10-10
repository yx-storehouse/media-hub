import { reactive } from 'vue'

/*
 * 确认框（代替浏览器自带的 confirm）：
 *   if (!(await confirmDialog({ title: '删除热词', message: '确定删除？\n不可恢复', danger: true }))) return
 * message 里的换行会原样显示。由 App.vue 里挂一次的 <ConfirmHost /> 渲染。
 */
export const confirmState = reactive({
  open: false,
  title: '',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false
})
let resolver = null

export function confirmDialog({ title = '请确认', message = '', confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  // 已经有一个确认框开着：旧的按「取消」处理
  if (resolver) settleConfirm(false)
  Object.assign(confirmState, { open: true, title, message, confirmText, cancelText, danger })
  return new Promise(resolve => { resolver = resolve })
}

export function settleConfirm(ok) {
  confirmState.open = false
  const r = resolver
  resolver = null
  r?.(!!ok)
}
