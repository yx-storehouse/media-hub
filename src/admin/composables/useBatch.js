/*
 * 批量操作：确认 → 请求 → 提示「已处理 N 项」→ 刷新列表、清空勾选。执行期间 busy=true（按钮要禁用）。
 *
 *   const batch = useBatch(batchKeywords, { selected, reload, clearSelection })
 *   batch.run('hot', undefined, { done: '已设为火焰标' })
 *   batch.run('delete', undefined, { confirm: { title: '删除热词', message: `确定删除选中的 ${n} 个热词？`, danger: true }, done: '已删除' })
 */
import { reactive } from 'vue'
import { confirmDialog } from '../components/confirm'
import { toast, toastError } from '../components/toast'

export function useBatch(batchFn, { selected, reload, clearSelection }) {
  const state = reactive({
    busy: false,
    action: '',
    /**
     * @param {string} action  接口里的批量动作名
     * @param {any} [value]    动作参数（改专题时是 topicId，加标签时是数组…）
     * @param {{ confirm?: object, done?: string, keepSelection?: boolean }} [opts]
     * @returns {Promise<number|null>} 受影响行数；取消或失败返回 null
     */
    async run(action, value, { confirm = null, done = '操作完成', keepSelection = false } = {}) {
      const ids = [...(selected.value || [])]
      if (!ids.length || state.busy) return null
      if (confirm && !(await confirmDialog(confirm))) return null
      state.busy = true
      state.action = action
      try {
        const res = await batchFn(ids, action, value)
        const n = res?.affected ?? ids.length
        toast(`${done}（${n} 项）`, { type: 'ok' })
        if (!keepSelection) clearSelection()
        await reload()
        return n
      } catch (e) {
        toastError(e, '批量操作失败')
        return null
      } finally {
        state.busy = false
        state.action = ''
      }
    }
  })
  return state
}
