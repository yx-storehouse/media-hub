/*
 * 导入 / 导出字段定义（GET /api/admin/schema）：整个后台只请求一次。
 *
 *   const { schema, ready, loadSchema, fieldsOf, labelOf } = useSchema()
 *   await loadSchema()               // 需要立刻用时 await 一下（已加载过直接返回缓存）
 *   fieldsOf('videos')               // → Field[]
 *   labelOf('videos', 'playbackUrl') // → '播放地址'（导出 CSV 的表头）
 */
import { shallowRef, ref, computed } from 'vue'
import { getSchema } from '../api'

const schema = shallowRef(null)
const error = ref('')
let pending = null

export function loadSchema() {
  if (schema.value) return Promise.resolve(schema.value)
  if (pending) return pending
  pending = getSchema()
    .then(s => { schema.value = s; error.value = ''; return s })
    .catch(e => { error.value = e.message || '加载失败'; throw e })
    .finally(() => { pending = null })
  return pending
}

const fieldsOf = type => schema.value?.[type]?.fields || []
const labelOf = (type, key) => fieldsOf(type).find(f => f.key === key)?.label || key

export function useSchema() {
  if (!schema.value && !pending && !error.value) loadSchema().catch(() => {})
  return {
    schema,
    ready: computed(() => !!schema.value),
    schemaError: error,
    loadSchema,
    fieldsOf,
    labelOf
  }
}
