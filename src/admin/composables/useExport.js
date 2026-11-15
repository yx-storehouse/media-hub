/*
 * 「导出」按钮：按当前筛选条件导出全部（不分页）为 CSV，表头用字段中文名（和导入模板一致，
 * 改完可以直接拖回「批量导入」更新）。文件名：<类型名>-YYYYMMDD-HHmm.csv
 * 服务端一次最多导出 5 万行（ADMIN_EXPORT_MAX）：超出时 truncated = true、total 是符合筛选的总数，提示要加筛选分批导出。
 *
 *   const exporter = useExport('keywords', () => params())
 *   <ABtn icon="download" :loading="exporter.busy" @click="exporter.run()">导出</ABtn>
 */
import { reactive } from 'vue'
import { exportRows } from '../api'
import { loadSchema } from './useSchema'
import { toCSV } from '../utils/csv'
import { downloadCSV } from '../utils/download'
import { fileStamp, fmtNum } from '../utils/format'
import { toast, toastError } from '../components/toast'

const TYPE_LABEL = { videos: '视频', posts: '帖子', topics: '专题', creators: '创作者', keywords: '搜索热词', albums: '图集' }

/** 导出一次，返回 { count: 导出的行数, total: 符合筛选的总数, truncated: 是否被截断 } */
export async function exportToCSV(type, query = {}) {
  const [data, schema] = await Promise.all([exportRows(type, query), loadSchema().catch(() => null)])
  const fields = data?.fields || []
  const defs = schema?.[type]?.fields || []
  const headers = fields.map(k => defs.find(f => f.key === k)?.label || k)
  const rows = (data?.rows || []).map(r => fields.map(k => r[k]))
  const label = schema?.[type]?.label || TYPE_LABEL[type] || type
  downloadCSV(`${label}-${fileStamp()}.csv`, toCSV(headers, rows))
  const truncated = !!data?.truncated
  return { count: rows.length, total: truncated ? Number(data.total) || rows.length : rows.length, truncated }
}

export function useExport(type, getQuery = () => ({})) {
  const state = reactive({
    busy: false,
    async run() {
      if (state.busy) return
      state.busy = true
      try {
        const { count: n, total, truncated } = await exportToCSV(type, getQuery())
        if (truncated) {
          // 后面的行既看不到也不会被「导出 → 改 → 更新已有」处理：提示停久一点
          toast(`只导出了前 ${fmtNum(n)} 条（共 ${fmtNum(total)} 条），请加筛选分批导出`, { type: 'info', duration: 10000 })
        } else {
          toast(n ? `已导出 ${fmtNum(n)} 条` : '没有可导出的数据（已生成只有表头的文件）', { type: n ? 'ok' : 'info' })
        }
      } catch (e) {
        toastError(e, '导出失败')
      } finally {
        state.busy = false
      }
    }
  })
  return state
}
