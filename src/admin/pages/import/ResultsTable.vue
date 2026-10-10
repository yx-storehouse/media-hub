<script setup>
import { ref, computed, watch } from 'vue'
import DataTable from '../../components/DataTable.vue'
import APager from '../../components/APager.vue'
import { useSchema } from '../../composables/useSchema'
import { fmtNum } from '../../utils/format'
import { useImportStore } from './store'
import { STATUS_TEXT, STATUS_CHIP } from './types'
import { reasonOf, fieldColumn } from './report'

/*
 * 预检 / 导入结果表：按状态筛选，每页 100 行（几万行的结果也只渲染当前页）。
 * 关键列（标题、名称、热词…）从源数据里按行号取回来；新增 / 更新的 ID 可以点开对应列表的编辑抽屉。
 */
const props = defineProps({
  /** store.state.preview 或 store.state.run */
  run: { type: Object, required: true },
  /** 预检：ID 列只对「更新 / 跳过」有意义（新增的 ID 预检后会回滚） */
  dry: { type: Boolean, default: false }
})

const store = useImportStore()
const { fieldsOf } = useSchema()
const fields = computed(() => fieldsOf(store.state.type))

const filter = ref('all')
const page = ref(1)
const pageSize = ref(100)
watch(filter, () => { page.value = 1 })
watch(() => props.run, () => { page.value = 1; filter.value = 'all' })

const counts = computed(() => ({
  all: props.run.created + props.run.updated + props.run.skipped + props.run.failed,
  created: props.run.created,
  updated: props.run.updated,
  skipped: props.run.skipped,
  error: props.run.failed
}))
const tabs = computed(() => [
  { key: 'all', label: '全部' },
  { key: 'created', label: props.dry ? '新增' : '已新增' },
  { key: 'updated', label: props.dry ? '更新' : '已更新' },
  { key: 'skipped', label: '跳过' },
  { key: 'error', label: '错误' }
])

/* results 是 markRaw 数组，追加时 version + 1：这里显式依赖 version。
   「全部」也要返回新数组：同一个数组引用会被 computed 当成「没变」，分页那层就不会刷新 */
const filtered = computed(() => {
  const v = props.run.version
  const all = props.run.results
  if (v < 0) return []
  return filter.value === 'all' ? all.slice() : all.filter(r => r.status === filter.value)
})

const keyCols = computed(() => store.info.value.keyCols.filter(k => store.colOf(k) >= 0).slice(0, 2))
const labelOf = k => fields.value.find(f => f.key === k)?.label || k

const columns = computed(() => [
  { key: 'row', label: '行号', width: 72, align: 'right', class: 'dim' },
  { key: 'status', label: '结果', width: 80 },
  ...keyCols.value.map((k, i) => ({ key: 'k' + i, label: labelOf(k), minWidth: i ? 160 : 220 })),
  { key: 'message', label: '说明', minWidth: 260 },
  { key: 'id', label: 'ID', width: 90, align: 'right' }
])

const pageRows = computed(() => {
  const t = store.table.value
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value).map(r => {
    const i = store.rowIndexOf(r.row)
    const o = { ...r, reason: reasonOf(store, r, fields.value), col: r.status === 'error' ? fieldColumn(store, r.field, fields.value) : '' }
    keyCols.value.forEach((k, n) => { o['k' + n] = i == null || !t ? '' : t.rows[i][store.colOf(k)] })
    return o
  })
})

const listPath = computed(() => store.info.value.list.path)
/* 预检里「新增」的 ID 是回滚前临时分配的，不显示 */
const showId = r => r.id && !(props.dry && r.status === 'created')
</script>

<template>
  <div class="rt">
    <div class="rt-bar">
      <div class="seg" role="group" aria-label="按结果筛选">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          class="seg-btn"
          :class="{ on: filter === t.key, err: t.key === 'error' && counts.error }"
          :aria-pressed="filter === t.key ? 'true' : 'false'"
          @click="filter = t.key"
        >
          {{ t.label }} <span class="num">{{ fmtNum(counts[t.key]) }}</span>
        </button>
      </div>
      <span class="grow" />
      <slot name="actions" />
    </div>

    <div class="rt-table">
      <DataTable :columns="columns" :rows="pageRows" row-key="row" :empty-text="filter === 'all' ? '还没有结果' : '没有这类结果'">
        <template #cell-status="{ row }">
          <span class="chip" :class="STATUS_CHIP[row.status]">{{ STATUS_TEXT[row.status] || row.status }}</span>
        </template>
        <template #cell-k0="{ value }"><span class="k0 clamp-2" :title="value">{{ value || '—' }}</span></template>
        <template #cell-k1="{ value }"><span class="k1 ellipsis" :title="value">{{ value || '—' }}</span></template>
        <template #cell-message="{ row }">
          <span class="msg" :class="{ 'danger-text': row.status === 'error' }">
            <span v-if="row.col" class="chip outline col">{{ row.col }}</span>
            {{ row.message || (row.status === 'created' ? (dry ? '将新增' : '已新增') : row.status === 'updated' ? (dry ? '将更新' : '已更新') : '—') }}
          </span>
        </template>
        <template #cell-id="{ row }">
          <RouterLink v-if="showId(row)" class="link num" :to="{ path: listPath, query: { edit: row.id } }" :title="`打开 ID ${row.id}`">{{ row.id }}</RouterLink>
          <span v-else class="dim">—</span>
        </template>
      </DataTable>
    </div>

    <APager v-if="filtered.length > 50" v-model:page="page" v-model:page-size="pageSize" :total="filtered.length" :page-sizes="[50, 100, 200]" />
  </div>
</template>

<style scoped>
.rt { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.rt-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.seg { display: inline-flex; flex-wrap: wrap; padding: 2px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--panel-2); }
.seg-btn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 5px; color: var(--t2); font-size: 12.5px; white-space: nowrap; }
.seg-btn:hover { color: var(--t1); }
.seg-btn.on { background: var(--hover); color: var(--t1); font-weight: 600; box-shadow: inset 0 0 0 1px var(--line-2); }
.seg-btn .num { color: var(--t3); font-weight: 500; }
.seg-btn.on .num { color: var(--t2); }
.seg-btn.err .num { color: var(--danger); }
/* 表格自己滚动，页面不会被几百行撑得很长 */
.rt-table { display: flex; flex-direction: column; max-height: min(62vh, 640px); min-height: 0; }
.k0 { max-width: 420px; }
.k1 { display: block; max-width: 260px; color: var(--t2); font-size: 12px; }
.msg { line-height: 1.5; }
.col { margin-right: 4px; color: var(--t2); }
</style>
