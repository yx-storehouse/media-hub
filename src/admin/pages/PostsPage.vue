<script setup>
import { ref, reactive, computed } from 'vue'
import { listPosts, getPost, createPost, updatePost, deletePost, batchPosts } from '../api'
import { useListPage } from '../composables/useListPage'
import { useEditor } from '../composables/useEditor'
import { useBatch } from '../composables/useBatch'
import { useExport } from '../composables/useExport'
import { useMeta } from '../composables/useMeta'
import { confirmDialog } from '../components/confirm'
import { toast, toastError } from '../components/toast'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
import AIcon from '../components/AIcon.vue'
import SearchBox from '../components/SearchBox.vue'
import SelectInput from '../components/SelectInput.vue'
import DataTable from '../components/DataTable.vue'
import APager from '../components/APager.vue'
import BatchBar from '../components/BatchBar.vue'
import ADrawer from '../components/ADrawer.vue'
import EmptyState from '../components/EmptyState.vue'
import Thumb from '../components/Thumb.vue'
import StatusBadge from '../components/StatusBadge.vue'
import BatchValueModal from '../components/BatchValueModal.vue'
import PostForm from './posts/PostForm.vue'
import { fmtDate, fmtShortDate, fmtCount, fmtNum } from '../utils/format'

defineOptions({ name: 'PostsPage' })

/*
 * 帖子（前台「社区」里的内容）：结构照 KeywordsPage。
 * 编辑抽屉右侧有前台卡片样式的实时预览；列表「状态」旁边的火焰图标可以直接点，切换「热门」。
 */

/* ① 列表（creatorId 和创作者页「查看帖子」的链接一致） */
const { query, rows, total, loading, loaded, error, selected, reload, sortModel, hasFilters, resetFilters, clearSelection, params, whenLoaded, patchRow } =
  useListPage(listPosts, { defaults: { q: '', status: '', creatorId: '', mediaKind: '', isHot: '', sort: 'publishedAt', order: 'desc' } })

const { creatorOptions, statusOptions, postKindOptions, labelOf } = useMeta()
const hotOptions = [{ value: '1', label: '热门' }, { value: '0', label: '非热门' }]

/*
 * ② 表格列：合计要放得进 1280×800 的内容区（约 1010px），排序只靠表头。
 * 关联视频放在正文下面一行（标题长，放在弹性列里）；「热门」开关放在状态旁边。
 */
const columns = [
  { key: 'id', label: 'ID', width: 64, sortable: true, class: 'dim' },
  { key: 'mainImage', label: '主图', width: 72 },
  { key: 'text', label: '正文', minWidth: 200 },
  { key: 'creatorName', label: '发布者', width: 100 },
  { key: 'mediaKind', label: '类型', width: 56 },
  { key: 'readCount', label: '阅读', width: 64, align: 'right', sortable: true },
  { key: 'favCount', label: '收藏', width: 64, align: 'right', sortable: true },
  { key: 'status', label: '状态 / 热门', width: 120 },
  { key: 'publishedAt', label: '发布时间', width: 104, sortable: true }
]
const thumbOf = r => r.mainImage || r.images?.[0] || ''

/* ③ 编辑抽屉 */
const drawer = ref(null)
const editor = useEditor({
  blank: () => ({
    creatorId: null, text: '', mediaKind: 1, videoId: null, tags: [], mainImage: null, images: [],
    moreCount: 0, readCount: 0, isHot: false, status: 1, publishedAt: null
  }),
  fromRow: r => ({
    creatorId: r.creatorId ?? null, text: r.text || '', mediaKind: r.mediaKind ?? 1, videoId: r.videoId ?? null,
    tags: [...(r.tags || [])], mainImage: r.mainImage ?? null, images: [...(r.images || [])],
    moreCount: r.moreCount ?? 0, readCount: r.readCount ?? 0, isHot: !!r.isHot, status: r.status ?? 1, publishedAt: r.publishedAt ?? null
  }),
  findRow: id => rows.value.find(r => r.id === id),
  fetchRow: getPost,
  whenReady: whenLoaded,
  create: createPost,
  update: updatePost,
  toBody: f => ({ ...f, text: f.text.trim() }),
  validate: f => {
    const e = {}
    if (!f.creatorId) e.creatorId = '请选择发布者'
    if (!f.text.trim()) e.text = '正文不能为空'
    else if ([...f.text.trim()].length > 5000) e.text = '正文最多 5000 个字'
    if (f.images.length > 9) e.images = '配图最多 9 张'
    return e
  },
  onSaved: () => reload()
})

async function removeOne(row, { fromDrawer = false } = {}) {
  const head = [...(row.text || '')].slice(0, 30).join('')
  const ok = await confirmDialog({ title: '删除帖子', message: `确定删除这条帖子？\n「${head}${[...(row.text || '')].length > 30 ? '…' : ''}」\n删除后不可恢复。`, confirmText: '删除', danger: true })
  if (!ok) return
  try {
    await deletePost(row.id)
    toast('已删除', { type: 'ok' })
    selected.value = selected.value.filter(id => id !== row.id)
    if (fromDrawer) editor.close()
    reload()
  } catch (e) {
    toastError(e, '删除失败')
  }
}

/* ④ 批量操作 */
const batch = useBatch(batchPosts, { selected, reload, clearSelection })
const batchDelete = () => batch.run('delete', undefined, {
  confirm: { title: '批量删除帖子', message: `确定删除选中的 ${selected.value.length} 条帖子？\n删除后不可恢复。`, confirmText: '删除', danger: true },
  done: '已删除'
})
const BATCH_VALUE = {
  setCreator: () => ({ title: '批量改发布者', label: '发布者', options: creatorOptions.value, searchable: true, done: '已修改发布者' }),
  addTags: () => ({ title: '批量加标签', label: '要添加的标签', mode: 'tags', hint: '不带 #；已有的标签不会重复，每条最多 20 个', done: '已加标签' }),
  removeTags: () => ({ title: '批量删标签', label: '要删除的标签', mode: 'tags', hint: '只删除这些标签，其他标签保留', done: '已删标签' })
}
const bv = reactive({ open: false, action: '', title: '', label: '', mode: 'select', options: [], searchable: false, hint: '', done: '' })
function openBatchValue(action) {
  Object.assign(bv, { mode: 'select', options: [], searchable: false, hint: '' }, BATCH_VALUE[action](), { action, open: true })
}
async function submitBatchValue(value) {
  const n = await batch.run(bv.action, value, { done: bv.done })
  if (n !== null) bv.open = false
}

/* ⑤ 导出 */
const exporter = useExport('posts', params)

/* ⑥ 行内切换「热门」：先改界面，失败再改回来 */
const pending = ref(new Set())
async function toggleHot(row) {
  if (pending.value.has(row.id)) return
  const value = !row.isHot
  pending.value = new Set(pending.value).add(row.id)
  patchRow(row.id, { isHot: value })
  try {
    const saved = await updatePost(row.id, { isHot: value })
    if (saved && typeof saved === 'object') patchRow(row.id, saved)
  } catch (e) {
    patchRow(row.id, { isHot: !value })
    toastError(e, '修改失败')
  } finally {
    const s = new Set(pending.value)
    s.delete(row.id)
    pending.value = s
  }
}

const kindLabel = v => labelOf('postKinds', v)
const subtitle = computed(() => (loaded.value ? `共 ${fmtNum(total.value)} 条` : ''))
</script>

<template>
  <div class="list-page">
    <PageHeader title="帖子" :subtitle="subtitle">
      <template #actions>
        <ABtn icon="import" :to="{ path: '/import', query: { type: 'posts' } }">导入</ABtn>
        <ABtn icon="download" :loading="exporter.busy" @click="exporter.run()">导出</ABtn>
        <ABtn variant="primary" icon="plus" @click="editor.openNew()">新建帖子</ABtn>
      </template>
    </PageHeader>

    <div class="filters">
      <SearchBox v-model="query.q" placeholder="搜索正文 / 标签 / ID" :width="230" />
      <label class="sr-only" for="pf-status">状态</label>
      <SelectInput id="pf-status" v-model="query.status" class="f-sel" :options="statusOptions" clearable placeholder="全部状态" />
      <label class="sr-only" for="pf-creator">发布者</label>
      <SelectInput id="pf-creator" v-model="query.creatorId" class="f-sel wide" :options="creatorOptions" searchable clearable placeholder="全部发布者" :pop-width="240" />
      <label class="sr-only" for="pf-kind">类型</label>
      <SelectInput id="pf-kind" v-model="query.mediaKind" class="f-sel" :options="postKindOptions" clearable placeholder="全部类型" />
      <label class="sr-only" for="pf-hot">热门</label>
      <SelectInput id="pf-hot" v-model="query.isHot" class="f-sel" :options="hotOptions" clearable placeholder="是否热门" />
      <button v-if="hasFilters" type="button" class="reset" @click="resetFilters">清除筛选</button>
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
        <template #cell-id="{ value }"><span class="dim num">{{ value }}</span></template>
        <template #cell-mainImage="{ row }">
          <Thumb :src="thumbOf(row)" :width="48" :icon="row.mediaKind === 2 ? 'file' : 'image'" />
        </template>
        <template #cell-text="{ row }">
          <div class="ttl">
            <button type="button" class="title-link txt clamp-2" :title="row.text" @click="editor.openEdit(row)">{{ row.text }}</button>
            <p v-if="row.videoId || row.tags?.length" class="sub small">
              <RouterLink v-if="row.videoId" class="vlink" :to="{ path: '/videos', query: { edit: row.videoId } }" :title="`编辑关联视频：${row.videoTitle}（${row.videoPublicId}）`">
                <AIcon name="video" :size="12" /><span class="ellipsis">{{ row.videoTitle }}</span>
              </RouterLink>
              <span v-if="row.tags?.length" class="tags ellipsis">
                <span v-for="t in row.tags" :key="t">#{{ t }}</span>
              </span>
            </p>
          </div>
        </template>
        <template #cell-creatorName="{ row }">
          <div v-if="row.creatorName" class="who">
            <span class="ellipsis" :title="row.creatorName">{{ row.creatorName }}</span>
            <span class="dim small ellipsis">@{{ row.creatorHandle }}</span>
          </div>
          <span v-else class="dim">—</span>
        </template>
        <template #cell-mediaKind="{ value }"><span class="muted">{{ kindLabel(value) }}</span></template>
        <template #cell-readCount="{ value }"><span :title="fmtNum(value)">{{ fmtCount(value) }}</span></template>
        <template #cell-favCount="{ value }"><span class="muted" :title="fmtNum(value)">{{ fmtCount(value) }}</span></template>
        <template #cell-status="{ row }">
          <span class="st">
            <StatusBadge :status="row.status" />
            <button
              type="button"
              class="hot"
              :class="{ on: row.isHot }"
              :disabled="pending.has(row.id)"
              :aria-pressed="row.isHot ? 'true' : 'false'"
              :aria-label="row.isHot ? '热门（点击取消）' : '设为热门'"
              :title="row.isHot ? '热门：点击取消' : '点击设为热门'"
              @click="toggleHot(row)"
            >
              <AIcon name="fire" :size="16" />
            </button>
          </span>
        </template>
        <template #cell-publishedAt="{ value }"><span class="muted nowrap" :title="fmtDate(value)">{{ fmtShortDate(value) }}</span></template>

        <template #actions="{ row }">
          <ABtn size="sm" variant="ghost" icon="edit" @click="editor.openEdit(row)">编辑</ABtn>
          <ABtn size="sm" variant="ghost" icon="trash" title="删除" aria-label="删除这条帖子" @click="removeOne(row)" />
        </template>

        <template #empty>
          <EmptyState v-if="hasFilters" icon="search" title="没有匹配的帖子" text="换个关键词或筛选条件试试">
            <ABtn @click="resetFilters">清除筛选</ABtn>
          </EmptyState>
          <EmptyState v-else icon="post" title="还没有帖子" text="帖子会显示在前台的「社区」里">
            <ABtn variant="primary" icon="plus" @click="editor.openNew()">新建帖子</ABtn>
            <ABtn icon="import" :to="{ path: '/import', query: { type: 'posts' } }">批量导入</ABtn>
          </EmptyState>
        </template>
      </DataTable>

      <APager v-model:page="query.page" v-model:page-size="query.pageSize" :total="total" :disabled="loading" />
    </div>

    <BatchBar :count="selected.length" :busy="batch.busy" @clear="clearSelection">
      <ABtn size="sm" icon="eye" :disabled="batch.busy" @click="batch.run('publish', undefined, { done: '已上架' })">上架</ABtn>
      <ABtn size="sm" icon="eye-off" :disabled="batch.busy" @click="batch.run('unpublish', undefined, { done: '已下架' })">下架</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="batch.run('draft', undefined, { done: '已设为草稿' })">设为草稿</ABtn>
      <span class="sep" aria-hidden="true" />
      <ABtn size="sm" icon="fire" :disabled="batch.busy" @click="batch.run('setHot', undefined, { done: '已设为热门' })">设为热门</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="batch.run('unsetHot', undefined, { done: '已取消热门' })">取消热门</ABtn>
      <span class="sep" aria-hidden="true" />
      <ABtn size="sm" icon="user" :disabled="batch.busy" @click="openBatchValue('setCreator')">改发布者…</ABtn>
      <ABtn size="sm" icon="hash" :disabled="batch.busy" @click="openBatchValue('addTags')">加标签…</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="openBatchValue('removeTags')">删标签…</ABtn>
      <span class="sep" aria-hidden="true" />
      <ABtn size="sm" variant="danger" icon="trash" :disabled="batch.busy" @click="batchDelete">删除</ABtn>
    </BatchBar>

    <ADrawer
      ref="drawer"
      v-model:open="editor.open"
      :title="editor.isNew ? '新建帖子' : '编辑帖子'"
      :width="940"
      :dirty="editor.dirty"
      :busy="editor.saving"
      :loading="editor.loadingRow"
      @save="editor.submit()"
    >
      <PostForm :editor="editor" />
      <template #footer>
        <ABtn v-if="!editor.isNew && editor.row" variant="danger" icon="trash" :disabled="editor.saving" @click="removeOne(editor.row, { fromDrawer: true })">删除</ABtn>
        <ABtn :disabled="editor.saving" @click="drawer?.requestClose()">取消</ABtn>
        <ABtn variant="primary" :loading="editor.saving" @click="editor.submit()">{{ editor.isNew ? '创建' : '保存' }}</ABtn>
      </template>
    </ADrawer>

    <BatchValueModal
      v-model:open="bv.open"
      :title="bv.title"
      :label="bv.label"
      :mode="bv.mode"
      :options="bv.options"
      :searchable="bv.searchable"
      :hint="bv.hint"
      :count="selected.length"
      unit="条帖子"
      :busy="batch.busy"
      @submit="submitBatchValue"
    />
  </div>
</template>

<style scoped>
.f-sel { width: 128px; }
.f-sel.wide { width: 160px; }

.ttl { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.txt { line-height: 1.5; font-weight: 400; word-break: break-all; }
.sub { display: flex; align-items: center; gap: 10px; color: var(--t3); }
/* width:0 + min-width:100%：不参与表格列宽的计算（长标签、长标题不把列撑宽），但仍占满单元格 */
.sub { width: 0; min-width: 100%; }
.tags { flex: 1 1 0; min-width: 0; }
.tags span + span { margin-left: 6px; }
.vlink { display: inline-flex; flex: 0 1 auto; align-items: center; gap: 4px; min-width: 0; max-width: 60%; color: var(--t2); }
.vlink:hover .ellipsis { text-decoration: underline; text-underline-offset: 3px; }
.vlink svg { flex: none; }
/* 单元格里的长名字用 max-width 截断（列宽减去内边距），不把列撑宽 */
.who { display: flex; flex-direction: column; max-width: 76px; line-height: 1.4; }
.st { display: inline-flex; align-items: center; gap: 2px; }
.hot { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; color: #3d3d3d; }
.hot:hover:not(:disabled) { background: var(--hover); color: var(--t2); }
.hot.on { color: var(--warn); }
.hot:disabled { opacity: .5; }
.sep { width: 1px; height: 18px; margin: 0 2px; background: var(--line-2); }
</style>
