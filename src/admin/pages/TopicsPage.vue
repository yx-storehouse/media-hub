<script setup>
import { ref, computed, watch } from 'vue'
import { onBeforeRouteUpdate } from 'vue-router'
import { listTopics, getTopic, createTopic, updateTopic, deleteTopic, batchTopics, reorderTopics } from '../api'
import { useListPage } from '../composables/useListPage'
import { useEditor } from '../composables/useEditor'
import { useBatch } from '../composables/useBatch'
import { useExport } from '../composables/useExport'
import { useMeta } from '../composables/useMeta'
import { useReorder } from '../composables/useReorder'
import { useLeaveGuard } from '../composables/useLeaveGuard'
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
import StatusBadge from '../components/StatusBadge.vue'
import FormField from '../components/FormField.vue'
import TextInput from '../components/TextInput.vue'
import TextArea from '../components/TextArea.vue'
import NumberInput from '../components/NumberInput.vue'
import SwitchInput from '../components/SwitchInput.vue'
import UrlListInput from '../components/UrlListInput.vue'
import TopicHeroPreview from './topics/TopicHeroPreview.vue'
import { fmtDate, fmtNum, fmtCount } from '../utils/format'

defineOptions({ name: 'TopicsPage' })

/*
 * 专题：列表结构同 KeywordsPage，另外有：
 *   - 调整顺序（useReorder）：按「排序」升序查看且没有筛选时，可以拖动把手或用 ↑ / ↓ 调整，点「保存排序」才提交；
 *     只调了当前页时，会和其他页的顺序合并后整体保存（sort_order 全部重排成 0,1,2…）
 *   - 删除前用行里的 sectionCount / totalVideos 提醒：引用它的首页分区会被一起删掉，视频变成「无专题」
 *   - 编辑器里的头图预览和前台专题页一样（4 张竖图并排）
 * 前台怎么用专题：专题页（头图 + 视频）对所有已发布专题都有；「片库分类」类型的专题还会出现在前台「片库」里。
 * 首页「推荐」的板块在「首页推荐」页单独设置，这里的「大卡 / 首屏数量」前台目前不读。
 */

const { topicKindOptions, statusOptions, labelOf, refreshMeta } = useMeta()

/* ① 列表（专题不多，默认每页 50，调整顺序时大多一页就够） */
const { query, rows, total, loading, loaded, error, selected, reload, sortModel, hasFilters, resetFilters, clearSelection, params, whenLoaded } =
  useListPage(listTopics, { defaults: { q: '', kind: '', status: '', sort: 'sortOrder', order: 'asc', pageSize: 50 } })

/* 见过的行（批量删除时统计跨页勾选的分区数 / 视频数） */
const seen = new Map()
watch(rows, list => { for (const r of list) seen.set(r.id, r) }, { immediate: true })

/* ---------------- 调整顺序 ---------------- */

const canReorder = computed(() => query.sort === 'sortOrder' && (query.order || 'asc') === 'asc' && !hasFilters.value)
/* 列表刷新后行变了（删了、换页了）：调整到一半的顺序作废 */
const reorder = useReorder(() => rows.value, { onReset: had => { if (had) toast('列表已变化，未保存的排序已还原') } })
const savingOrder = ref(false)
watch(canReorder, v => { if (!v) reorder.reset() })

/** 所有专题按当前顺序的 id（接口每页最多 200 条，专题多时分几次取） */
async function allTopicIds() {
  const ids = []
  for (let page = 1; page < 100; page++) {
    const res = await listTopics({ sort: 'sortOrder', order: 'asc', page, pageSize: 200 })
    const list = res?.list || []
    ids.push(...list.map(t => t.id))
    if (!list.length || ids.length >= (res?.total || 0)) break
  }
  return ids
}

async function saveOrder() {
  if (!reorder.dirty || savingOrder.value) return
  savingOrder.value = true
  try {
    const pageIds = reorder.keys()
    const set = new Set(pageIds)
    // 当前页的新顺序放回它在全部专题里的位置，其他页不动
    const rest = (await allTopicIds()).filter(id => !set.has(id))
    const offset = (query.page - 1) * query.pageSize
    rest.splice(Math.min(offset, rest.length), 0, ...pageIds)
    await reorderTopics(rest)
    await reload()
    reorder.reset()
    refreshMeta()
    toast('排序已保存', { type: 'ok' })
  } catch (e) {
    toastError(e, '保存排序失败')
  } finally {
    savingOrder.value = false
  }
}

/** 排序没保存时，换筛选 / 排序方式 / 离开页面都先确认 */
const DISCARD = { title: '放弃排序？', message: '调整后的顺序还没有保存，确定放弃？', confirmText: '放弃' }
async function discardOrder() {
  if (!reorder.dirty) return true
  const ok = await confirmDialog({ ...DISCARD, danger: true })
  if (ok) reorder.reset()
  return ok
}
const searchKey = ref(0)
async function setFilter(key, value) {
  if (await discardOrder()) query[key] = value
  else if (key === 'q') searchKey.value++ // 取消了：搜索框里打的字也还原
}
const sortProxy = computed({
  get: () => sortModel.value,
  set: async v => { if (await discardOrder()) sortModel.value = v }
})
/* 去别的页面 / 刷新 / 关标签页 */
useLeaveGuard(() => reorder.dirty, DISCARD)
/* 同一页里地址栏的列表参数变了（比如点侧边栏「专题」回到默认列表）也算放弃；只开关编辑抽屉（?edit=）不算 */
const LIST_KEYS = ['q', 'kind', 'status', 'sort', 'order', 'page', 'pageSize']
onBeforeRouteUpdate((to, from) => {
  if (!reorder.dirty) return true
  return LIST_KEYS.some(k => String(to.query[k] ?? '') !== String(from.query[k] ?? '')) ? discardOrder() : true
})
const rowClass = row => reorder.drag.itemClass(reorder.indexOf(row))

/* ② 表格列：合计要放得进 1280×800 的内容区（约 1010px）；视频数可以点，跳到这个专题的视频 */
const columns = computed(() => [
  { key: 'id', label: 'ID', width: 64, sortable: true, class: 'dim' },
  ...(canReorder.value ? [{ key: 'drag', label: '', width: 100 }] : []),
  { key: 'name', label: '名称', minWidth: 180, sortable: true, firstOrder: 'asc' },
  { key: 'kind', label: '类型', width: 84 },
  { key: 'videoCount', label: '视频数', width: 88, align: 'right', sortable: true },
  { key: 'sectionCount', label: '首页分区', width: 72, align: 'right' },
  { key: 'playsCount', label: '播放 / 收藏', width: 96, align: 'right' },
  { key: 'status', label: '状态', width: 88 },
  { key: 'sortOrder', label: '排序', width: 72, align: 'right', sortable: true, firstOrder: 'asc' }
])

/* ③ 编辑抽屉 */
const drawer = ref(null)
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
const editor = useEditor({
  blank: () => ({ name: '', slug: '', kind: 0, description: '', covers: [], sortOrder: null, isFeatured: false, cardSize: 4, playsCount: 0, status: 1 }),
  fromRow: r => ({
    name: r.name, slug: r.slug || '', kind: r.kind ?? 0, description: r.description || '', covers: [...(r.covers || [])],
    sortOrder: r.sortOrder ?? 0, isFeatured: !!r.isFeatured, cardSize: r.cardSize ?? 4, playsCount: r.playsCount ?? 0, status: r.status ?? 1
  }),
  findRow: id => rows.value.find(r => r.id === id),
  fetchRow: getTopic,
  whenReady: whenLoaded,
  create: createTopic,
  update: updateTopic,
  toBody: f => ({ ...f, name: f.name.trim(), slug: f.slug.trim().toLowerCase(), description: f.description.trim() }),
  validate: f => {
    const name = f.name.trim()
    const slug = f.slug.trim().toLowerCase()
    if (!name) return { name: '请输入名称' }
    if ([...name].length > 40) return { name: '名称最多 40 个字' }
    if (slug && !SLUG_RE.test(slug)) return { slug: '只能用小写字母、数字和 -，以字母或数字开头，最多 48 位' }
    if (!slug && !editor.isNew) return { slug: '标识不能为空（只有新建时可以留空自动生成）' }
    if (f.cardSize == null) return { cardSize: '请填写首屏数量（1-20）' }
    if (f.sortOrder == null && !editor.isNew) return { sortOrder: '请填写排序' }
    return null
  },
  onSaved: () => { refreshMeta(); return reload() }
})

/* 表单提示：只写前台真的会用到的效果 */
const KIND_LIBRARY = 2
const kindHint = '「片库分类」会出现在前台「片库」里；首页的板块在「首页推荐」里设置'
const coversHint = computed(() => '最多 4 张竖图（建议 300×600），按顺序从左到右；没填的格子前台用生成的占位图' +
  (editor.form.kind === KIND_LIBRARY ? '。第 1 张也用作「片库」里的卡片封面' : ''))
/* 下架一个被首页分区引用的专题：分区本身照常显示，只是前台不再有「全部 / 看更多」入口 */
const statusHint = computed(() => {
  const r = editor.row
  if (editor.isNew || !r?.sectionCount || r.status !== 1 || editor.form.status === 1) return ''
  return `有 ${r.sectionCount} 个首页分区关联了这个专题：不发布后，前台这些分区不再显示「全部 / 看更多」`
})

const impactLines = (sections, videos) => [
  sections ? `· 引用它的 ${sections} 个首页分区会被一起删除` : '',
  videos ? `· ${videos} 个视频会变成「无专题」（视频本身不删）` : ''
].filter(Boolean).join('\n')

async function removeOne(row, { fromDrawer = false } = {}) {
  const impact = impactLines(row.sectionCount, row.totalVideos)
  const ok = await confirmDialog({
    title: '删除专题',
    message: `确定删除专题「${row.name}」？\n${impact ? impact + '\n' : ''}删除后不可恢复。`,
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  try {
    const res = await deleteTopic(row.id)
    const extra = [res?.deletedSections ? `删除了 ${res.deletedSections} 个首页分区` : '', res?.detachedVideos ? `${res.detachedVideos} 个视频已变为无专题` : ''].filter(Boolean).join('，')
    toast(extra ? `已删除（${extra}）` : '已删除', { type: 'ok' })
    selected.value = selected.value.filter(id => id !== row.id)
    if (fromDrawer) editor.close()
    refreshMeta()
    reload()
  } catch (e) {
    toastError(e, '删除失败')
  }
}

/* ④ 批量操作 */
let lastBatch = null
const batch = useBatch((ids, action, value) => batchTopics(ids, action, value).then(res => { lastBatch = res; return res }), {
  selected,
  reload: async () => { refreshMeta(); await reload() },
  clearSelection
})
async function batchDelete() {
  const ids = selected.value
  let sections = 0
  let videos = 0
  for (const id of ids) { sections += seen.get(id)?.sectionCount || 0; videos += seen.get(id)?.totalVideos || 0 }
  const impact = impactLines(sections, videos)
  lastBatch = null
  await batch.run('delete', undefined, {
    confirm: { title: '批量删除专题', message: `确定删除选中的 ${ids.length} 个专题？\n${impact ? impact + '\n' : ''}删除后不可恢复。`, confirmText: '删除', danger: true },
    done: '已删除'
  })
  if (lastBatch?.deletedSections) toast(`同时删除了 ${lastBatch.deletedSections} 个首页分区`)
}

/* ⑤ 导出 */
const exporter = useExport('topics', params)

const kindLabel = v => labelOf('topicKinds', v)
const appLink = id => `./index.html#/topic/${id}`
const reorderTip = computed(() => (canReorder.value ? '拖动把手或用 ↑ ↓ 调整顺序，前台按这个顺序排列' : '按「排序」升序查看、且不筛选时可以拖动调整顺序'))
</script>

<template>
  <div class="list-page">
    <PageHeader title="专题" :subtitle="loaded ? `共 ${fmtNum(total)} 个` : ''">
      <template #actions>
        <ABtn icon="import" :to="{ path: '/import', query: { type: 'topics' } }">导入</ABtn>
        <ABtn icon="download" :loading="exporter.busy" @click="exporter.run()">导出</ABtn>
        <ABtn variant="primary" icon="plus" @click="editor.openNew()">新建专题</ABtn>
      </template>
    </PageHeader>

    <div class="filters">
      <SearchBox :key="searchKey" :model-value="query.q" placeholder="搜索名称 / 标识 / ID" @update:model-value="v => setFilter('q', v)" />
      <label class="sr-only" for="tf-kind">类型</label>
      <SelectInput id="tf-kind" class="f-sel" :model-value="query.kind" :options="topicKindOptions" placeholder="全部类型" clearable @update:model-value="v => setFilter('kind', v)" />
      <label class="sr-only" for="tf-status">状态</label>
      <SelectInput id="tf-status" class="f-sel" :model-value="query.status" :options="statusOptions" placeholder="全部状态" clearable @update:model-value="v => setFilter('status', v)" />
      <button v-if="hasFilters" type="button" class="reset" @click="resetFilters">清除筛选</button>
      <span class="grow" />
      <span class="dim small tip">{{ reorderTip }}</span>
    </div>

    <div v-if="reorder.dirty" class="order-bar" role="status">
      <AIcon name="sort" :size="15" />
      <span>顺序已调整，保存后前台生效</span>
      <span class="grow" />
      <ABtn size="sm" :disabled="savingOrder" @click="reorder.reset()">撤销</ABtn>
      <ABtn size="sm" variant="primary" icon="save" :loading="savingOrder" @click="saveOrder">保存排序</ABtn>
    </div>

    <div class="table-area topics-table" @dragover="reorder.drag.over" @dragleave="reorder.drag.leave" @drop="reorder.drag.drop">
      <DataTable
        v-model:selected="selected"
        v-model:sort="sortProxy"
        :columns="columns"
        :rows="reorder.list"
        :loading="loading"
        :error="error"
        selectable
        :actions-width="124"
        :row-class="rowClass"
        @retry="reload"
      >
        <template #cell-id="{ value }"><span class="dim num">{{ value }}</span></template>
        <template #cell-drag="{ row }">
          <span class="drag">
            <span
              class="grip"
              draggable="true"
              title="拖动调整顺序"
              aria-hidden="true"
              @dragstart="reorder.drag.start(reorder.indexOf(row), $event)"
              @dragend="reorder.drag.end"
            ><AIcon name="grip" :size="16" /></span>
            <ABtn size="sm" variant="ghost" icon="arrow-up" :aria-label="`「${row.name}」上移`" title="上移" :disabled="savingOrder || reorder.indexOf(row) === 0" @click="reorder.moveBy(row, -1)" />
            <ABtn size="sm" variant="ghost" icon="arrow-down" :aria-label="`「${row.name}」下移`" title="下移" :disabled="savingOrder || reorder.indexOf(row) === reorder.list.length - 1" @click="reorder.moveBy(row, 1)" />
          </span>
        </template>
        <template #cell-name="{ row }">
          <div class="name">
            <span class="nm">
              <button type="button" class="title-link" @click="editor.openEdit(row)">{{ row.name }}</button>
              <span v-if="row.isFeatured" class="chip outline" title="大卡（前台目前不使用）">大卡</span>
            </span>
            <span class="dim small mono">{{ row.slug }}</span>
          </div>
        </template>
        <template #cell-kind="{ value }">
          <span class="chip" :class="{ outline: value === 0 }">{{ kindLabel(value) }}</span>
        </template>
        <template #cell-videoCount="{ row }">
          <RouterLink class="num cnt-link" :to="{ path: '/videos', query: { topicId: row.id } }" :title="`已发布 ${row.videoCount} / 全部 ${row.totalVideos}，点击查看这些视频`" :aria-label="`查看「${row.name}」的视频（已发布 ${row.videoCount} / 全部 ${row.totalVideos}）`">{{ fmtNum(row.videoCount) }}<span class="dim"> / {{ fmtNum(row.totalVideos) }}</span></RouterLink>
        </template>
        <template #cell-sectionCount="{ value }"><span :class="value ? '' : 'dim'">{{ value }}</span></template>
        <template #cell-playsCount="{ row }">
          <span class="muted" :title="`播放 ${fmtNum(row.playsCount)} · 收藏 ${fmtNum(row.favCount)}`">{{ fmtCount(row.playsCount) }}<span class="dim"> / {{ fmtCount(row.favCount) }}</span></span>
        </template>
        <template #cell-status="{ value }"><StatusBadge :status="value" /></template>
        <template #cell-sortOrder="{ value }"><span class="muted num">{{ value }}</span></template>

        <template #actions="{ row }">
          <ABtn size="sm" variant="ghost" icon="edit" @click="editor.openEdit(row)">编辑</ABtn>
          <ABtn size="sm" variant="ghost" icon="trash" title="删除" :aria-label="`删除「${row.name}」`" @click="removeOne(row)" />
        </template>

        <template #empty>
          <EmptyState v-if="hasFilters" icon="search" title="没有匹配的专题" text="换个关键词或筛选条件试试">
            <ABtn @click="resetFilters">清除筛选</ABtn>
          </EmptyState>
          <EmptyState v-else icon="topic" title="还没有专题" text="专题用来给视频归类；「片库分类」类型的专题会出现在前台「片库」里">
            <ABtn variant="primary" icon="plus" @click="editor.openNew()">新建专题</ABtn>
            <ABtn icon="import" :to="{ path: '/import', query: { type: 'topics' } }">批量导入</ABtn>
          </EmptyState>
        </template>
      </DataTable>

      <APager v-model:page="query.page" v-model:page-size="query.pageSize" :total="total" :disabled="loading || reorder.dirty" />
    </div>

    <BatchBar :count="selected.length" :busy="batch.busy" @clear="clearSelection">
      <ABtn size="sm" icon="eye" :disabled="batch.busy" @click="batch.run('publish', undefined, { done: '已上架' })">上架</ABtn>
      <ABtn size="sm" icon="eye-off" :disabled="batch.busy" @click="batch.run('unpublish', undefined, { done: '已下架' })">下架</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="batch.run('draft', undefined, { done: '已设为草稿' })">设为草稿</ABtn>
      <ABtn size="sm" variant="danger" icon="trash" :disabled="batch.busy" @click="batchDelete">删除</ABtn>
    </BatchBar>

    <ADrawer
      ref="drawer"
      v-model:open="editor.open"
      :title="editor.isNew ? '新建专题' : '编辑专题'"
      :width="640"
      :dirty="editor.dirty"
      :busy="editor.saving"
      :loading="editor.loadingRow"
      @save="editor.submit()"
    >
      <div class="form-grid">
        <FormField label="名称" field="name" required :error="editor.errors.name">
          <TextInput v-model="editor.form.name" :maxlength="40" show-count placeholder="例如：治愈日常" />
        </FormField>
        <FormField label="标识" field="slug" :error="editor.errors.slug" hint="小写字母数字和 -，留空自动生成">
          <TextInput v-model="editor.form.slug" mono :maxlength="48" :placeholder="editor.isNew ? '留空自动生成' : ''" />
        </FormField>
        <FormField label="类型" field="kind" :error="editor.errors.kind" :hint="kindHint">
          <SelectInput v-model="editor.form.kind" :options="topicKindOptions" />
        </FormField>
        <FormField label="状态" field="status" :error="editor.errors.status" :hint="statusHint">
          <SelectInput v-model="editor.form.status" :options="statusOptions" />
        </FormField>
        <FormField class="full" label="简介" field="description" :error="editor.errors.description">
          <TextArea v-model="editor.form.description" :rows="2" :maxlength="500" show-count placeholder="一句话介绍这个专题（可选）" />
        </FormField>
      </div>

      <h4 class="form-section">头图</h4>
      <div class="covers">
        <TopicHeroPreview
          :covers="editor.form.covers"
          :name="editor.form.name"
          :plays-count="editor.form.playsCount || 0"
          :fav-count="editor.row?.favCount || 0"
        />
        <FormField label="头图地址" field="covers" :error="editor.errors.covers" :hint="coversHint">
          <UrlListInput v-model="editor.form.covers" :max="4" upload-dir="covers" add-text="添加头图" />
        </FormField>
      </div>

      <h4 class="form-section">展示</h4>
      <div class="form-grid">
        <FormField label="排序" field="sortOrder" :error="editor.errors.sortOrder" hint="越小越靠前（片库、下拉框都按这个顺序）">
          <NumberInput v-model="editor.form.sortOrder" :placeholder="editor.isNew ? '留空排到最后' : ''" />
        </FormField>
        <FormField label="播放数" field="playsCount" :error="editor.errors.playsCount" hint="显示在专题页头图上">
          <NumberInput v-model="editor.form.playsCount" :min="0" placeholder="0" />
        </FormField>
        <FormField label="首屏数量" field="cardSize" :error="editor.errors.cardSize" hint="前台目前不使用；首页板块一屏几个视频在「首页推荐」里设置">
          <NumberInput v-model="editor.form.cardSize" :min="1" :max="20" suffix="个" />
        </FormField>
        <FormField inline label="大卡" field="isFeatured" :error="editor.errors.isFeatured" hint="前台目前不使用；首页的大卡分区在「首页推荐」里设置">
          <SwitchInput v-model="editor.form.isFeatured" />
        </FormField>
      </div>

      <template v-if="!editor.isNew && editor.row">
        <h4 class="form-section">其他信息</h4>
        <dl class="kv">
          <div><dt>ID</dt><dd>{{ editor.row.id }}</dd></div>
          <div><dt>视频（已发布 / 全部）</dt><dd>{{ fmtNum(editor.row.videoCount) }} / {{ fmtNum(editor.row.totalVideos) }}</dd></div>
          <div><dt>首页分区</dt><dd>{{ editor.row.sectionCount }}</dd></div>
          <div><dt>收藏</dt><dd>{{ fmtNum(editor.row.favCount) }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ fmtDate(editor.row.createdAt) }}</dd></div>
        </dl>
        <div class="links">
          <ABtn size="sm" icon="video" :to="{ path: '/videos', query: { topicId: editor.row.id } }">查看视频</ABtn>
          <ABtn size="sm" icon="external" :href="appLink(editor.row.id)" target="_blank" rel="noopener">在前台查看</ABtn>
        </div>
      </template>

      <template #footer>
        <ABtn v-if="!editor.isNew && editor.row" variant="danger" icon="trash" :disabled="editor.saving" @click="removeOne(editor.row, { fromDrawer: true })">删除</ABtn>
        <ABtn :disabled="editor.saving" @click="drawer?.requestClose()">取消</ABtn>
        <ABtn variant="primary" :loading="editor.saving" @click="editor.submit()">{{ editor.isNew ? '创建' : '保存' }}</ABtn>
      </template>
    </ADrawer>
  </div>
</template>

<style scoped>
.f-sel { width: 130px; }
.tip { white-space: nowrap; }
.name { display: flex; flex-direction: column; min-width: 0; }
.nm { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.drag { display: inline-flex; align-items: center; gap: 0; }
.grip { display: grid; place-items: center; width: 22px; height: 26px; border-radius: 5px; color: var(--t3); cursor: grab; }
.grip:hover { background: var(--hover); color: var(--t1); }
.grip:active { cursor: grabbing; }
.cnt-link { color: var(--t1); }
.cnt-link:hover { text-decoration: underline; text-underline-offset: 3px; }

.order-bar { display: flex; flex: none; align-items: center; gap: 8px; margin: 0 24px 10px; padding: 8px 10px 8px 14px; border: 1px solid rgba(227, 179, 65, .35); border-radius: var(--radius); background: rgba(227, 179, 65, .07); color: var(--warn); }
.order-bar > span:not(.grow) { color: var(--t1); }

/* 拖动时的落点提示（行在 DataTable 里，要穿透 scoped） */
.topics-table :deep(tr.dragging td) { opacity: .45; }
.topics-table :deep(tr.drop-before td) { box-shadow: inset 0 2px 0 var(--accent); }
.topics-table :deep(tr.drop-after td) { box-shadow: inset 0 -2px 0 var(--accent); }

.covers { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
@media (max-width: 1100px) {
  .tip { display: none; }
}
</style>
