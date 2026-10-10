/*
 * 批量导入：结果的文字说明、错误报告 / 导入结果 CSV。
 */
import { toCSV } from '../../utils/csv'
import { downloadCSV } from '../../utils/download'
import { fileStamp } from '../../utils/format'
import { loadSchema } from '../../composables/useSchema'
import { STATUS_TEXT, templateRow } from './types'

/** 出错字段 → 源文件里的列名（没对应的字段用字段中文名） */
export function fieldColumn(store, fieldKey, fields) {
  if (!fieldKey) return ''
  const c = store.colOf(fieldKey)
  if (c >= 0) return store.table.value.headers[c]
  return fields.find(f => f.key === fieldKey)?.label || fieldKey
}

/** 一行结果的说明：错误带上列名，方便在原表里找 */
export function reasonOf(store, r, fields) {
  const msg = r.message || (r.status === 'error' ? '导入失败' : '')
  const col = r.status === 'error' && r.field ? fieldColumn(store, r.field, fields) : ''
  return col ? `【${col}】${msg}` : msg
}

async function fieldsOf(type) {
  const schema = await loadSchema().catch(() => null)
  return schema?.[type]?.fields || []
}

/** 错误报告：原始行 + 「错误原因」+「原行号」。改好后可以直接拖回来重新导入（多出的两列不会被对应） */
export async function downloadErrorReport(store, run) {
  const t = store.table.value
  const fields = await fieldsOf(store.state.type)
  const errs = run.results.filter(r => r.status === 'error')
  const headers = [...t.headers, '错误原因', '原行号']
  const rows = errs.map(r => {
    const i = store.rowIndexOf(r.row)
    const src = i == null ? t.headers.map(() => '') : t.rows[i]
    return [...src, reasonOf(store, r, fields), r.row]
  })
  downloadCSV(`${store.info.value.label}导入错误-${fileStamp()}.csv`, toCSV(headers, rows))
  return rows.length
}

/** 导入结果：每行的结果、新 ID、关键列和说明 */
export async function downloadResults(store, run) {
  const t = store.table.value
  const fields = await fieldsOf(store.state.type)
  const keys = store.info.value.keyCols.filter(k => store.colOf(k) >= 0)
  const label = k => fields.find(f => f.key === k)?.label || k
  const headers = ['行号', '结果', 'ID', ...keys.map(label), '说明']
  const rows = run.results.map(r => {
    const i = store.rowIndexOf(r.row)
    const cells = keys.map(k => (i == null ? '' : t.rows[i][store.colOf(k)]))
    return [r.row, STATUS_TEXT[r.status] || r.status, r.id ?? '', ...cells, reasonOf(store, r, fields)]
  })
  downloadCSV(`${store.info.value.label}导入结果-${fileStamp()}.csv`, toCSV(headers, rows))
  return rows.length
}

/** 模板：表头 = 字段中文名，第二行是示例行（不会和真实数据撞上，导入时自动跳过；见 types.js） */
export function downloadTemplate(type, label, fields) {
  const headers = fields.map(f => f.label)
  downloadCSV(`${label}导入模板.csv`, toCSV(headers, [templateRow(type, fields)]))
}
