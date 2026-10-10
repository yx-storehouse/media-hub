/*
 * 有未保存的修改时拦住离开：
 *   ① 点侧边栏 / 链接去别的页面 → 先弹 confirmDialog「放弃修改？」，选「离开」才走；
 *   ② 刷新、关标签页 → 浏览器自己的「确定离开？」提示（beforeunload，只在 dirty 时挂上）。
 *
 *   const { bypass } = useLeaveGuard(dirty)                    // dirty：ref / computed / getter 都行
 *   useLeaveGuard(() => orderDirty.value, { message: '调整后的顺序还没有保存，确定离开？' })
 *   保存成功后马上要跳转（这时 dirty 可能还没来得及变回 false）：bypass(); router.push(…)
 *
 * 选项：title（默认「放弃修改？」）、message、confirmText（默认「离开」）。
 * 在路由页面或它的子组件的 setup 里调用（组件卸载时自动解除）；同一路由内只改查询参数不会触发 ①。
 */
import { watch, toValue, onBeforeUnmount } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { confirmDialog } from '../components/confirm'

export function useLeaveGuard(isDirty, { title = '放弃修改？', message = '有未保存的修改，确定离开这个页面？', confirmText = '离开' } = {}) {
  const dirty = () => !!toValue(isDirty)
  // bypass() 之后的下一次离开不再确认；之后又有了新的修改就恢复拦截
  let skip = false

  onBeforeRouteLeave(() => {
    if (skip) { skip = false; return true }
    if (!dirty()) return true
    return confirmDialog({ title, message, confirmText, danger: true })
  })

  const onUnload = e => {
    if (skip || !dirty()) return
    e.preventDefault()
    e.returnValue = ''
  }
  const listen = on => (on ? window.addEventListener('beforeunload', onUnload) : window.removeEventListener('beforeunload', onUnload))
  watch(dirty, v => { if (v) skip = false; listen(v) }, { immediate: true })
  onBeforeUnmount(() => listen(false))

  return {
    /** 下一次离开（或刷新）不再确认，用于保存后程序跳转 */
    bypass() { skip = true }
  }
}
