<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import AIcon from './AIcon.vue'
import EmptyState from './EmptyState.vue'

/*
 * 数据表格。
 *   <DataTable :columns="columns" :rows="rows" :loading="loading" :error="error"
 *              selectable v-model:selected="selected" v-model:sort="sortModel"
 *              @retry="reload" @row-click="…">
 *     <template #cell-title="{ row, value }">…</template>
 *     <template #actions="{ row }">…</template>
 *   </DataTable>
 *
 * columns：[{ key, label, width?, minWidth?, align?, sortable?, sortKey?, class? }]
 *   sortKey 是接口的排序字段名（默认等于 key）；width 可写数字（px）或字符串。
 * sort：{ key, order }，点表头切换：同一列 desc ⇄ asc，换列从 desc 开始（列上 firstOrder: 'asc' 可改）。
 * 勾选：表头复选框只管当前页（半选态）；按住 Shift 点行复选框可连选。
 * 表头吸顶、横向滚动都在表格自己的容器里；加载中保留旧数据并盖一层半透明遮罩，不闪烁。
 * 列宽：width 同时是最小宽度（骨架行内容是空的，不这样的话首次加载完列会跳）；actionsWidth 要不小于操作列按钮的实际宽度。
 */
const props = defineProps({
  columns: { type: Array, required: true },
  rows: { type: Array, default: () => [] },
  rowKey: { type: String, default: 'id' },
  loading: { type: Boolean, default: false },
  selectable: { type: Boolean, default: false },
  selected: { type: Array, default: () => [] },
  sort: { type: Object, default: null },
  emptyText: { type: String, default: '暂无数据' },
  /** 加载失败的提示；有值且没有数据时显示「重试」 */
  error: { type: String, default: '' },
  /** 操作列标题与宽度 */
  actionsLabel: { type: String, default: '操作' },
  actionsWidth: { type: [Number, String], default: 120 },
  /** 行的额外 class：(row) => string | object */
  rowClass: { type: Function, default: null }
})
const emit = defineEmits(['update:selected', 'update:sort', 'row-click', 'retry'])

const wrap = ref(null)
const keyOf = row => row[props.rowKey]
const selSet = computed(() => new Set(props.selected))
const pageKeys = computed(() => props.rows.map(keyOf))
const pageSelCount = computed(() => pageKeys.value.filter(k => selSet.value.has(k)).length)
const allOnPage = computed(() => pageKeys.value.length > 0 && pageSelCount.value === pageKeys.value.length)
const someOnPage = computed(() => pageSelCount.value > 0 && !allOnPage.value)

const headCheck = ref(null)
watch([someOnPage, headCheck], () => { if (headCheck.value) headCheck.value.indeterminate = someOnPage.value }, { immediate: true, flush: 'post' })

function toggleAll() {
  const keys = pageKeys.value
  if (allOnPage.value) emit('update:selected', props.selected.filter(k => !keys.includes(k)))
  else emit('update:selected', [...props.selected, ...keys.filter(k => !selSet.value.has(k))])
}

let lastIndex = -1
function toggleRow(row, index, e) {
  const k = keyOf(row)
  const on = !selSet.value.has(k)
  // Shift 连选：把上一次点的行到这一行之间都设成同一状态
  if (e?.shiftKey && lastIndex >= 0 && lastIndex !== index) {
    const [a, b] = lastIndex < index ? [lastIndex, index] : [index, lastIndex]
    const range = props.rows.slice(a, b + 1).map(keyOf)
    const next = new Set(props.selected)
    for (const rk of range) on ? next.add(rk) : next.delete(rk)
    emit('update:selected', [...next])
  } else {
    emit('update:selected', on ? [...props.selected, k] : props.selected.filter(x => x !== k))
  }
  lastIndex = index
}
watch(() => pageKeys.value.join(','), () => { lastIndex = -1 })

const sortKeyOf = c => c.sortKey || c.key
function sortState(c) {
  if (!c.sortable || !props.sort) return null
  return props.sort.key === sortKeyOf(c) ? props.sort.order || 'desc' : null
}
function clickSort(c) {
  if (!c.sortable) return
  const key = sortKeyOf(c)
  const cur = sortState(c)
  const order = cur ? (cur === 'desc' ? 'asc' : 'desc') : c.firstOrder || 'desc'
  emit('update:sort', { key, order })
}
const ariaSort = c => {
  const s = sortState(c)
  return s === 'asc' ? 'ascending' : s === 'desc' ? 'descending' : c.sortable ? 'none' : undefined
}

const px = v => (v == null ? undefined : typeof v === 'number' ? v + 'px' : v)
const colStyle = c => ({ width: px(c.width), minWidth: px(c.minWidth ?? c.width) })
const valueOf = (row, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), row)
const show = v => (v === null || v === undefined || v === '' ? '—' : v)

/* 骨架行的条宽：每格固定一个看起来随机的宽度（和真实单元格一样一列一格，加载完列宽不跳） */
const skW = (n, i) => 35 + ((n * 37 + i * 23) % 50) + '%'

/* 翻页 / 换筛选后（行的 id 变了）回到表格顶部；只是改了某一行的内容（行内开关）不动 */
watch(() => pageKeys.value.join(','), () => { if (wrap.value) nextTick(() => { wrap.value.scrollTop = 0 }) })

function onRowClick(row, e) {
  // 点到按钮、链接、输入框时不当作点行
  if (e.target.closest('button, a, input, label, select, textarea, [role="switch"]')) return
  emit('row-click', row, e)
}
</script>

<template>
  <div class="dt-wrap" :class="{ busy: loading && rows.length }">
    <div ref="wrap" class="dt-scroll">
      <table class="dt">
        <colgroup>
          <col v-if="selectable" style="width: 40px">
          <col v-for="c in columns" :key="c.key" :style="{ width: px(c.width) }">
          <col v-if="$slots.actions" :style="{ width: px(actionsWidth) }">
        </colgroup>
        <thead>
          <tr>
            <th v-if="selectable" class="sel">
              <input
                ref="headCheck"
                type="checkbox"
                :checked="allOnPage"
                :disabled="!rows.length"
                aria-label="选择本页全部"
                @change="toggleAll"
              >
            </th>
            <th
              v-for="c in columns"
              :key="c.key"
              :class="[c.class, `al-${c.align || 'left'}`, { sortable: c.sortable, sorted: !!sortState(c) }]"
              :style="colStyle(c)"
              :aria-sort="ariaSort(c)"
              scope="col"
            >
              <button v-if="c.sortable" type="button" class="th-btn" @click="clickSort(c)">
                <span>{{ c.label }}</span>
                <AIcon v-if="sortState(c) === 'asc'" name="arrow-up" :size="12" :stroke="2" />
                <AIcon v-else-if="sortState(c) === 'desc'" name="arrow-down" :size="12" :stroke="2" />
                <AIcon v-else class="sort-hint" name="sort" :size="12" :stroke="2" />
              </button>
              <span v-else>{{ c.label }}</span>
            </th>
            <th v-if="$slots.actions" class="act al-right" scope="col" :style="{ width: px(actionsWidth), minWidth: px(actionsWidth) }">{{ actionsLabel }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in rows"
            :key="keyOf(row)"
            :class="[rowClass ? rowClass(row) : null, { on: selSet.has(keyOf(row)) }]"
            @click="onRowClick(row, $event)"
          >
            <td v-if="selectable" class="sel">
              <input
                type="checkbox"
                :checked="selSet.has(keyOf(row))"
                :aria-label="`选择第 ${i + 1} 行`"
                @click="toggleRow(row, i, $event)"
              >
            </td>
            <td v-for="c in columns" :key="c.key" :class="[c.class, `al-${c.align || 'left'}`]">
              <slot :name="`cell-${c.key}`" :row="row" :value="valueOf(row, c.key)">{{ show(valueOf(row, c.key)) }}</slot>
            </td>
            <td v-if="$slots.actions" class="act al-right">
              <div class="act-in"><slot name="actions" :row="row" /></div>
            </td>
          </tr>
          <!-- 首次加载：骨架行（每列一格，列宽和加载完一致） -->
          <template v-if="loading && !rows.length">
            <tr v-for="n in 6" :key="'sk' + n" class="sk" aria-hidden="true">
              <td v-if="selectable" class="sel"><i class="bar box" /></td>
              <td v-for="(c, i) in columns" :key="c.key" :class="[c.class, `al-${c.align || 'left'}`]">
                <i class="bar" :style="{ width: skW(n, i) }" />
              </td>
              <td v-if="$slots.actions" class="act al-right"><i class="bar act-bar" /></td>
            </tr>
          </template>
        </tbody>
      </table>

      <div v-if="!loading && !rows.length" class="dt-empty">
        <EmptyState v-if="error" variant="error" :text="error" @retry="emit('retry')" />
        <slot v-else name="empty">
          <EmptyState :title="emptyText" />
        </slot>
      </div>
    </div>

    <div v-if="loading && rows.length" class="dt-mask" role="status" aria-label="加载中">
      <span class="spinner lg" />
    </div>
  </div>
</template>

<style scoped>
/* 行少时表格只有内容那么高（分页紧跟在下面）；行多时占满剩余高度、表格内部滚动 */
.dt-wrap { position: relative; display: flex; flex: 0 1 auto; flex-direction: column; min-height: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
.dt-scroll { flex: 1; min-height: 0; overflow: auto; border-radius: var(--radius); }
.dt { width: 100%; table-layout: auto; font-variant-numeric: tabular-nums; }

th, td { padding: 0 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
th {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 38px;
  background: #151515;
  color: var(--t2);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  box-shadow: inset 0 -1px 0 var(--line);
}
td { height: 46px; padding-top: 7px; padding-bottom: 7px; color: var(--t1); }
/* 列上的 class: 'dim'（如 ID 列）要压过上面的正文色 */
td.dim { color: var(--t3); }
tbody tr { transition: background .1s; }
tbody tr:hover td { background: #171717; }
tbody tr.on td { background: #1c1c1c; }
tbody tr.on td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
tbody tr:last-child td { border-bottom-color: transparent; }

.al-center { text-align: center; }
.al-right { text-align: right; }
.al-right .th-btn { flex-direction: row-reverse; }
.al-center .th-btn { justify-content: center; }

.sel { width: 40px; min-width: 40px; padding: 0 0 0 14px; text-align: left; }
th.sel { z-index: 3; }

.th-btn { display: inline-flex; align-items: center; gap: 4px; height: 26px; margin: 0 -6px; padding: 0 6px; border-radius: 5px; color: inherit; font-weight: inherit; white-space: nowrap; }
.th-btn:hover { background: var(--hover); color: var(--t1); }
.sorted .th-btn { color: var(--t1); }
.sort-hint { opacity: 0; transition: opacity .12s; }
.th-btn:hover .sort-hint, .th-btn:focus-visible .sort-hint { opacity: .6; }

/* 操作列吸在右侧，横向滚动时始终可见 */
.act { position: sticky; right: 0; z-index: 1; background: var(--panel); white-space: nowrap; box-shadow: inset 1px 0 0 var(--line); }
th.act { z-index: 3; background: #151515; box-shadow: inset 1px 0 0 var(--line), inset 0 -1px 0 var(--line); }
.act-in { display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; }

.sk td { height: 46px; }
.bar { display: block; height: 10px; border-radius: 5px; background: linear-gradient(90deg, #1c1c1c, #262626, #1c1c1c); background-size: 200% 100%; animation: sk 1.2s linear infinite; }
.al-right .bar { margin-left: auto; }
.al-center .bar { margin: 0 auto; }
.bar.box { width: 15px; height: 15px; border-radius: 3px; }
.bar.act-bar { width: 60%; margin-left: auto; }
@keyframes sk { to { background-position: -200% 0; } }

.dt-empty { color: var(--t2); }

.dt-mask { position: absolute; inset: 39px 0 0; z-index: 4; display: grid; place-items: center; border-radius: 0 0 var(--radius) var(--radius); background: rgba(11, 11, 11, .45); }
</style>
