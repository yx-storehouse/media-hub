/*
 * 「导出」按钮：按当前筛选条件导出全部（不分页）为 CSV，表头用字段中文名（和导入模板一致，
 * 改完可以直接拖回「批量导入」更新）。文件名：<类型名>-YYYYMMDD-HHmm.csv
 *
 *   const exporter = useExport('keywords', () => params())
 *   <ABtn icon="download" :loading="exporter.busy" @click="exporter.run()">导出</ABtn>
 */
import { reactive } from 'vue'
import { exportRows } from '../api'
import { loadSchema } from './useSchema'
import { toCSV } from '../utils/csv'
import { downloadCSV } from '../utils/download'
import { fileStamp } from '../utils/format'
import { toast, toastError } from '../components/toast'

const TYPE_LABEL = { videos: '视频', posts: '帖子', topics: '专题', creators: '创作者', keywords: '搜索热词' }

/** 导出一次，返回导出的行数 */
export async function exportToCSV(type, query = {}) {
  const [data, schema] = await Promise.all([exportRows(type, query), loadSchema().catch(() => null)])
  const fields = data?.fields || []
  const defs = schema?.[type]?.fields || []
  const headers = fields.map(k => defs.find(f => f.key === k)?.label || k)
  const rows = (data?.rows || []).map(r => fields.map(k => r[k]))
  const label = schema?.[type]?.label || TYPE_LABEL[type] || type
  downloadCSV(`${label}-${fileStamp()}.csv`, toCSV(headers, rows))
  return rows.length
}

export function useExport(type, getQuery = () => ({})) {
  const state = reactive({
    busy: false,
    async run() {
      if (state.busy) return
      state.busy = true
      try {
        const n = await exportToCSV(type, getQuery())
        toast(n ? `已导出 ${n} 条` : '没有可导出的数据（已生成只有表头的文件）', { type: n ? 'ok' : 'info' })
      } catch (e) {
        toastError(e, '导出失败')
      } finally {
        state.busy = false
      }
    }
  })
  return state
}
