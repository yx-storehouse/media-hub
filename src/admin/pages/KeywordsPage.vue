<script setup>
import { ref } from 'vue'
import { listKeywords, getKeyword, createKeyword, updateKeyword, deleteKeyword, batchKeywords } from '../api'
import { useListPage } from '../composables/useListPage'
import { useEditor } from '../composables/useEditor'
import { useBatch } from '../composables/useBatch'
import { useExport } from '../composables/useExport'
import { confirmDialog } from '../components/confirm'
import { toast, toastError } from '../components/toast'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
import AIcon from '../components/AIcon.vue'
import SearchBox from '../components/SearchBox.vue'
import DataTable from '../components/DataTable.vue'
import APager from '../components/APager.vue'
import BatchBar from '../components/BatchBar.vue'
import ADrawer from '../components/ADrawer.vue'
import EmptyState from '../components/EmptyState.vue'
import FormField from '../components/FormField.vue'
import TextInput from '../components/TextInput.vue'
import NumberInput from '../components/NumberInput.vue'
import SwitchInput from '../components/SwitchInput.vue'
import { fmtDate, fmtShortDate, fmtNum } from '../utils/format'

defineOptions({ name: 'KeywordsPage' })

/*
 * 搜索热词 —— 列表页的参考实现，其他列表页（视频、帖子、专题、创作者）照这个结构写：
 *   ① useListPage：筛选 / 分页 / 排序都同步在地址栏
 *   ② columns + DataTable（勾选、排序、单元格插槽、操作列）+ APager
 *   ③ useEditor + ADrawer：新建 / 编辑抽屉，?edit=<id> 深链，脏检查，字段错误
 *   ④ useBatch + BatchBar：批量操作
 *   ⑤ useExport：按当前筛选导出 CSV；「导入」跳到批量导入页并预选类型
 *   ⑥ 行内开关：乐观更新，失败回滚
 */

/* ① 列表 */
const { query, rows, total, loading, loaded, error, selected, reload, sortModel, hasFilters, resetFilters, clearSelection, params, whenLoaded, patchRow } =
  useListPage(listKeywords, { defaults: { q: '', sort: 'weight', order: 'desc' } })

/*
 * ② 表格列（sortable 的列点表头排序；firstOrder 决定第一次点是升序还是降序）。
 * 第一列一律是浅色、可排序的 ID；日期用 fmtShortDate（完整时间放 title）。
 * 列宽合计要能放进 1280×800 的内容区（约 1010px），别让关键列被吸在右侧的操作列盖住。
 */
const columns = [
  { key: 'id', label: 'ID', width: 64, sortable: true, class: 'dim' },
  { key: 'word', label: '热词', minWidth: 180, sortable: true, firstOrder: 'asc' },
  { key: 'isHot', label: '火焰标', width: 76, align: 'center' },
  { key: 'isBanned', label: '屏蔽', width: 64, align: 'center' },
  { key: 'weight', label: '权重', width: 84, align: 'right', sortable: true },
  { key: 'sortOrder', label: '排序', width: 76, align: 'right', sortable: true, firstOrder: 'asc' },
  { key: 'searchCount', label: '搜索次数', width: 92, align: 'right' },
  { key: 'updatedAt', label: '更新时间', width: 112 }
]

/* ③ 编辑抽屉 */
const drawer = ref(null)
const editor = useEditor({
  blank: () => ({ word: '', isHot: false, isBanned: false, weight: 0, sortOrder: null }),
  fromRow: r => ({ word: r.word, isHot: !!r.isHot, isBanned: !!r.isBanned, weight: r.weight ?? 0, sortOrder: r.sortOrder ?? 0 }),
  findRow: id => rows.value.find(r => r.id === id),
  fetchRow: getKeyword,
  whenReady: whenLoaded,
  create: createKeyword,
  update: updateKeyword,
  toBody: f => ({ ...f, word: f.word.trim() }),
  // 本地先挡住明显的错误；唯一性等由服务端校验，错误会显示在对应字段下
  validate: f => {
    const w = f.word.trim()
    if (!w) return { word: '请输入热词' }
    if ([...w].length > 20) return { word: '热词最多 20 个字' }
    return null
  },
  onSaved: () => reload()
})

async function removeOne(row, { fromDrawer = false } = {}) {
  const ok = await confirmDialog({ title: '删除热词', message: `确定删除「${row.word}」？\n删除后不可恢复。`, confirmText: '删除', danger: true })
  if (!ok) return
  try {
    await deleteKeyword(row.id)
    toast('已删除', { type: 'ok' })
    selected.value = selected.value.filter(id => id !== row.id)
    if (fromDrawer) editor.close()
    reload()
  } catch (e) {
    toastError(e, '删除失败')
  }
}

/* ④ 批量操作 */
const batch = useBatch(batchKeywords, { selected, reload, clearSelection })
const batchDelete = () => batch.run('delete', undefined, {
  confirm: { title: '批量删除', message: `确定删除选中的 ${selected.value.length} 个热词？\n删除后不可恢复。`, confirmText: '删除', danger: true },
  done: '已删除'
})

/* ⑤ 导出（当前筛选条件下的全部，不分页） */
const exporter = useExport('keywords', params)

/* ⑥ 行内开关：先改界面，失败再改回来 */
const pending = ref(new Set())
async function toggleFlag(row, key, value) {
  if (pending.value.has(row.id)) return
  pending.value = new Set(pending.value).add(row.id)
  patchRow(row.id, { [key]: value })
  try {
    const saved = await updateKeyword(row.id, { [key]: value })
    if (saved && typeof saved === 'object') patchRow(row.id, saved)
  } catch (e) {
    patchRow(row.id, { [key]: !value })
    toastError(e, '修改失败')
  } finally {
    const s = new Set(pending.value)
    s.delete(row.id)
    pending.value = s
  }
}
</script>

<template>
  <div class="list-page">
    <PageHeader title="搜索热词" :subtitle="loaded ? `共 ${fmtNum(total)} 个` : ''">
      <template #actions>
        <ABtn icon="import" :to="{ path: '/import', query: { type: 'keywords' } }">导入</ABtn>
        <ABtn icon="download" :loading="exporter.busy" @click="exporter.run()">导出</ABtn>
        <ABtn variant="primary" icon="plus" @click="editor.openNew()">新建热词</ABtn>
      </template>
    </PageHeader>

    <div class="filters">
      <SearchBox v-model="query.q" placeholder="搜索热词" />
      <button v-if="hasFilters" type="button" class="reset" @click="resetFilters">清除筛选</button>
      <span class="grow" />
      <span class="dim small tip">权重越大越靠前；屏蔽的词不会出现在前台「热门搜索」</span>
    </div>

    <div class="table-area">
      <DataTable
        v-model:selected="selected"
        v-model:sort="sortModel"
        :columns="columns"
        :rows="rows"
        :loading="loading"
        :error="error"
        selectable
        :actions-width="124"
        @retry="reload"
      >
        <template #cell-word="{ row }">
          <span class="word">
            <button type="button" class="title-link" @click="editor.openEdit(row)">{{ row.word }}</button>
            <AIcon v-if="row.isHot" class="fire" name="fire" :size="14" />
            <span v-if="row.isBanned" class="chip danger">已屏蔽</span>
          </span>
        </template>
        <template #cell-isHot="{ row }">
          <SwitchInput
            size="sm"
            :model-value="!!row.isHot"
            :disabled="pending.has(row.id)"
            :aria-label="`「${row.word}」火焰标`"
            @update:model-value="v => toggleFlag(row, 'isHot', v)"
          />
        </template>
        <template #cell-isBanned="{ row }">
          <SwitchInput
            size="sm"
            :model-value="!!row.isBanned"
            :disabled="pending.has(row.id)"
            :aria-label="`屏蔽「${row.word}」`"
            @update:model-value="v => toggleFlag(row, 'isBanned', v)"
          />
        </template>
        <template #cell-weight="{ value }">{{ fmtNum(value) }}</template>
        <template #cell-searchCount="{ value }"><span class="muted">{{ fmtNum(value) }}</span></template>
        <template #cell-updatedAt="{ value }"><span class="muted nowrap" :title="fmtDate(value)">{{ fmtShortDate(value) }}</span></template>

        <template #actions="{ row }">
          <ABtn size="sm" variant="ghost" icon="edit" @click="editor.openEdit(row)">编辑</ABtn>
          <ABtn size="sm" variant="ghost" icon="trash" title="删除" :aria-label="`删除「${row.word}」`" @click="removeOne(row)" />
        </template>

        <template #empty>
          <EmptyState v-if="hasFilters" icon="search" title="没有匹配的热词" text="换个关键词试试">
            <ABtn @click="resetFilters">清除筛选</ABtn>
          </EmptyState>
          <EmptyState v-else icon="search" title="还没有搜索热词" text="热词会显示在前台搜索页的「热门搜索」里">
            <ABtn variant="primary" icon="plus" @click="editor.openNew()">新建热词</ABtn>
            <ABtn icon="import" :to="{ path: '/import', query: { type: 'keywords' } }">批量导入</ABtn>
          </EmptyState>
        </template>
      </DataTable>

      <APager v-model:page="query.page" v-model:page-size="query.pageSize" :total="total" :disabled="loading" />
    </div>

    <BatchBar :count="selected.length" :busy="batch.busy" @clear="clearSelection">
      <ABtn size="sm" icon="fire" :disabled="batch.busy" @click="batch.run('hot', undefined, { done: '已加火焰标' })">加火焰标</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="batch.run('unhot', undefined, { done: '已去掉火焰标' })">去掉火焰标</ABtn>
      <ABtn size="sm" icon="eye-off" :disabled="batch.busy" @click="batch.run('ban', undefined, { done: '已屏蔽' })">屏蔽</ABtn>
      <ABtn size="sm" icon="eye" :disabled="batch.busy" @click="batch.run('unban', undefined, { done: '已取消屏蔽' })">取消屏蔽</ABtn>
      <ABtn size="sm" variant="danger" icon="trash" :disabled="batch.busy" @click="batchDelete">删除</ABtn>
    </BatchBar>

    <ADrawer
      ref="drawer"
      v-model:open="editor.open"
      :title="editor.isNew ? '新建热词' : '编辑热词'"
      :width="480"
      :dirty="editor.dirty"
      :busy="editor.saving"
      :loading="editor.loadingRow"
      @save="editor.submit()"
    >
      <div class="form-grid">
        <FormField class="full" label="热词" field="word" required :error="editor.errors.word" hint="最多 20 个字，不能和已有热词重复">
          <TextInput v-model="editor.form.word" :maxlength="20" show-count placeholder="例如：日落" @enter="editor.submit()" />
        </FormField>
        <FormField label="权重" field="weight" :error="editor.errors.weight" hint="越大越靠前">
          <NumberInput v-model="editor.form.weight" placeholder="0" />
        </FormField>
        <FormField label="排序" field="sortOrder" :error="editor.errors.sortOrder" hint="权重相同时从小到大">
          <NumberInput v-model="editor.form.sortOrder" placeholder="留空自动" />
        </FormField>
        <FormField class="full" inline label="火焰标" field="isHot" :error="editor.errors.isHot" hint="在热词后面显示小火焰">
          <SwitchInput v-model="editor.form.isHot" />
        </FormField>
        <FormField class="full" inline label="屏蔽" field="isBanned" :error="editor.errors.isBanned" hint="屏蔽后不会出现在前台的热门搜索里">
          <SwitchInput v-model="editor.form.isBanned" />
        </FormField>
      </div>

      <template v-if="!editor.isNew && editor.row">
        <h4 class="form-section">其他信息</h4>
        <dl class="kv">
          <div><dt>ID</dt><dd>{{ editor.row.id }}</dd></div>
          <div><dt>搜索次数</dt><dd>{{ fmtNum(editor.row.searchCount) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ fmtDate(editor.row.updatedAt) }}</dd></div>
        </dl>
      </template>

      <template #footer>
        <ABtn v-if="!editor.isNew && editor.row" variant="danger" icon="trash" :disabled="editor.saving" @click="removeOne(editor.row, { fromDrawer: true })">删除</ABtn>
        <ABtn @click="drawer?.requestClose()">取消</ABtn>
        <ABtn variant="primary" :loading="editor.saving" @click="editor.submit()">{{ editor.isNew ? '创建' : '保存' }}</ABtn>
      </template>
    </ADrawer>
  </div>
</template>

<style scoped>
.word { display: inline-flex; align-items: center; gap: 6px; }
.fire { color: var(--warn); }
.tip { white-space: nowrap; }
@media (max-width: 1100px) {
  .tip { display: none; }
}
</style>
