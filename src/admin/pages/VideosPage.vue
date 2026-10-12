<script setup>
import { ref, reactive, computed, nextTick } from 'vue'
import { listVideos, getVideo, createVideo, updateVideo, deleteVideo, batchVideos } from '../api'
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
import VideoForm from './videos/VideoForm.vue'
import VideoPreview from './videos/VideoPreview.vue'
import ProbeRunner from './videos/ProbeRunner.vue'
import { durationError } from './videos/duration'
import { fmtDate, fmtShortDate, fmtDuration, fmtCount, fmtNum, parseDuration } from '../utils/format'

defineOptions({ name: 'VideosPage' })

/*
 * 视频管理：结构照 KeywordsPage（列表 → 编辑抽屉 → 批量 → 导出），另外有：
 *   - 预览（点封面：直接播放 + 跳前台播放页）
 *   - 批量改专题 / 分类 / 地区 / 清晰度 / 创作者、加删标签（components/BatchValueModal）
 *   - 批量「提取时长和封面」（ProbeRunner，在浏览器里逐个读视频）
 */

/* ① 列表（筛选键和概览页、专题页、创作者页的跳转链接一致：topicId / creatorId / missing / short / sort） */
const { query, rows, total, loading, loaded, error, selected, reload, sortModel, hasFilters, resetFilters, clearSelection, params, whenLoaded } =
  useListPage(listVideos, {
    defaults: { q: '', status: '', topicId: '', creatorId: '', category: '', region: '', missing: '', short: '', sort: 'publishedAt', order: 'desc' }
  })

const { topicOptions, creatorOptions, categoryOptions, regionOptions, qualityOptions, statusOptions, labelOf } = useMeta()

/* 筛选项：「无专题 / 无创作者 / 未分类」也能筛（接口认 none） */
const topicFilter = computed(() => [{ value: 'none', label: '（无专题）' }, ...topicOptions.value])
const creatorFilter = computed(() => [{ value: 'none', label: '（无创作者）' }, ...creatorOptions.value])
const categoryFilter = computed(() => [...categoryOptions.value, { value: 'none', label: '（未分类）' }])
const regionFilter = computed(() => [...regionOptions.value, { value: 'none', label: '（未设置）' }])
const missingOptions = [
  { value: 'playback', label: '缺播放地址' },
  { value: 'cover', label: '缺封面' },
  { value: 'duration', label: '缺时长' }
]
const shortOptions = [{ value: '1', label: '仅短视频' }, { value: '0', label: '非短视频' }]

/*
 * 不常用的三个筛选（地区 / 缺失项 / 短视频）：宽屏（≥1400px）直接排在一行里；
 * 窄一点时收进「更多筛选」，免得筛选栏折成两行挤掉表格。已经选了值的始终显示。
 */
const moreOpen = ref(false)
const isSet = k => query[k] !== '' && query[k] != null
const moreSet = computed(() => ['region', 'missing', 'short'].filter(isSet).length)

/* ② 表格列：合计要放得进 1280×800 的内容区（约 1010px），排序只靠表头 */
const columns = [
  { key: 'id', label: 'ID', width: 64, sortable: true, class: 'dim' },
  { key: 'coverUrl', label: '封面', width: 88 },
  { key: 'title', label: '标题', minWidth: 200 },
  { key: 'topicName', label: '专题 / 分类', width: 120 },
  { key: 'durationSec', label: '时长', width: 80, align: 'right', sortable: true },
  { key: 'playCount', label: '播放', width: 68, align: 'right', sortable: true },
  { key: 'status', label: '状态', width: 112 },
  { key: 'publishedAt', label: '发布时间', width: 104, sortable: true }
]

/* ③ 编辑抽屉 */
const durText = s => (s ? fmtDuration(s) : '')
const drawer = ref(null)
const editor = useEditor({
  blank: () => ({
    title: '', publicId: '', description: '', topicId: null, creatorId: null, categoryKey: null, region: null,
    quality: 'hd', tags: [], playbackUrl: null, coverUrl: null, durationText: '', status: 1, publishedAt: null, isShort: false
  }),
  fromRow: r => ({
    title: r.title || '', publicId: r.publicId || '', description: r.description || '',
    topicId: r.topicId ?? null, creatorId: r.creatorId ?? null, categoryKey: r.categoryKey ?? null, region: r.region ?? null,
    quality: r.quality || 'hd', tags: [...(r.tags || [])], playbackUrl: r.playbackUrl ?? null, coverUrl: r.coverUrl ?? null,
    durationText: durText(r.durationSec), status: r.status ?? 1, publishedAt: r.publishedAt ?? null, isShort: !!r.isShort
  }),
  findRow: id => rows.value.find(r => r.id === id),
  fetchRow: getVideo,
  whenReady: whenLoaded,
  create: createVideo,
  update: updateVideo,
  // 服务端报的 durationSec 错误显示在时长输入框下，改了时长文本就清掉
  fieldAlias: { durationSec: 'durationText' },
  // 时长文本 → 秒（空 = 0，接口里 0 表示未知）
  toBody: f => {
    const { durationText, ...b } = f
    return { ...b, title: b.title.trim(), publicId: b.publicId.trim(), durationSec: parseDuration(durationText) ?? 0 }
  },
  validate: f => {
    const e = {}
    const title = f.title.trim()
    if (!title) e.title = '标题不能为空'
    const pid = f.publicId.trim()
    if (/\s/.test(pid)) e.publicId = '编号不能包含空格'
    else if (!pid && !editor.isNew) e.publicId = '编号不能为空（只有新建时可以留空自动生成）'
    const durErr = durationError(f.durationText)
    if (durErr) e.durationSec = durErr
    return e
  },
  onSaved: () => reload()
})

const DELETE_NOTE = '会同时从首页推荐、短视频流和观看记录里移除，删除后不可恢复。'
async function removeOne(row, { fromDrawer = false } = {}) {
  const ok = await confirmDialog({ title: '删除视频', message: `确定删除「${row.title}」？\n${DELETE_NOTE}`, confirmText: '删除', danger: true })
  if (!ok) return
  try {
    await deleteVideo(row.id)
    toast('已删除', { type: 'ok' })
    selected.value = selected.value.filter(id => id !== row.id)
    if (fromDrawer) editor.close()
    reload()
  } catch (e) {
    toastError(e, '删除失败')
  }
}

/* 预览（点封面） */
const previewOpen = ref(false)
const previewRow = ref(null)
function openPreview(row) {
  previewRow.value = row
  previewOpen.value = true
}
async function editFromPreview(row) {
  previewOpen.value = false
  await nextTick()
  editor.openEdit(row)
}

/* ④ 批量操作 */
const batch = useBatch(batchVideos, { selected, reload, clearSelection })
const runStatus = (action, done) => batch.run(action, undefined, { done })
const batchDelete = () => batch.run('delete', undefined, {
  confirm: { title: '批量删除视频', message: `确定删除选中的 ${selected.value.length} 个视频？\n${DELETE_NOTE}`, confirmText: '删除', danger: true },
  done: '已删除'
})
/* 前台短视频流从全部已上架视频里推荐，加入短视频的会大幅加权、优先出现 */
const SHORT_TIP = '加入后在前台「短视频」流里优先推荐'

/* 改专题 / 分类 / 地区 / 清晰度 / 创作者、加删标签：先弹小对话框选值 */
const BATCH_VALUE = {
  setTopic: () => ({ title: '批量改专题', label: '专题', options: topicOptions.value, searchable: true, nullLabel: '（清空：不属于任何专题）', done: '已修改专题' }),
  setCategory: () => ({ title: '批量改分类', label: '分类', options: categoryOptions.value, nullLabel: '（清空：不分类）', done: '已修改分类' }),
  setRegion: () => ({ title: '批量改地区', label: '地区', options: regionOptions.value, nullLabel: '（清空：不设置）', hint: '不设置地区的视频在前台「最新」里归入「其他」', done: '已修改地区' }),
  setQuality: () => ({ title: '批量改清晰度', label: '清晰度', options: qualityOptions.value, done: '已修改清晰度' }),
  setCreator: () => ({ title: '批量改创作者', label: '创作者', options: creatorOptions.value, searchable: true, nullLabel: '（清空：不指定创作者）', done: '已修改创作者' }),
  addTags: () => ({ title: '批量加标签', label: '要添加的标签', mode: 'tags', hint: '已有的标签不会重复；每个视频最多 20 个标签', done: '已加标签' }),
  removeTags: () => ({ title: '批量删标签', label: '要删除的标签', mode: 'tags', hint: '只删除这些标签，其他标签保留', done: '已删标签' })
}
const bv = reactive({ open: false, action: '', title: '', label: '', mode: 'select', options: [], searchable: false, nullLabel: '', hint: '', done: '' })
function openBatchValue(action) {
  Object.assign(bv, { mode: 'select', options: [], searchable: false, nullLabel: '', hint: '' }, BATCH_VALUE[action](), { action, open: true })
}
async function submitBatchValue(value) {
  const n = await batch.run(bv.action, value, { done: bv.done })
  if (n !== null) bv.open = false
}

/* 提取时长和封面 */
const probeOpen = ref(false)
const probeIds = ref([])
function openProbe() {
  probeIds.value = [...selected.value]
  probeOpen.value = true
}
const rowById = id => rows.value.find(r => r.id === id) || null
function onProbeFinished({ ok, fail, skip }) {
  toast(`提取完成：成功 ${ok}，失败 ${fail}，跳过 ${skip}`, { type: fail ? 'error' : 'ok' })
  reload()
}

/* ⑤ 导出 */
const exporter = useExport('videos', params)

const catRegion = r => [r.categoryKey ? labelOf('categories', r.categoryKey) : '', r.region ? labelOf('regions', r.region) : ''].filter(Boolean).join(' · ')
</script>

<template>
  <div class="list-page">
    <PageHeader title="视频" :subtitle="loaded ? `共 ${fmtNum(total)} 个` : ''">
      <template #actions>
        <ABtn icon="import" :to="{ path: '/import', query: { type: 'videos' } }">导入</ABtn>
        <ABtn icon="download" :loading="exporter.busy" @click="exporter.run()">导出</ABtn>
        <ABtn variant="primary" icon="plus" @click="editor.openNew()">新建视频</ABtn>
      </template>
    </PageHeader>

    <div class="filters" :class="{ 'more-open': moreOpen }">
      <SearchBox v-model="query.q" placeholder="搜索标题 / 编号 / 标签 / ID" :width="220" />
      <label class="sr-only" for="vf-status">状态</label>
      <SelectInput id="vf-status" v-model="query.status" class="f-sel" :options="statusOptions" clearable placeholder="全部状态" />
      <label class="sr-only" for="vf-topic">专题</label>
      <SelectInput id="vf-topic" v-model="query.topicId" class="f-sel" :options="topicFilter" searchable clearable placeholder="全部专题" :pop-width="220" />
      <label class="sr-only" for="vf-cat">分类</label>
      <SelectInput id="vf-cat" v-model="query.category" class="f-sel" :options="categoryFilter" clearable placeholder="全部分类" />
      <label class="sr-only" for="vf-creator">创作者</label>
      <SelectInput id="vf-creator" v-model="query.creatorId" class="f-sel" :options="creatorFilter" searchable clearable placeholder="全部创作者" :pop-width="240" />
      <span class="f-more" :class="{ on: isSet('region') }">
        <label class="sr-only" for="vf-region">地区</label>
        <SelectInput id="vf-region" v-model="query.region" class="f-sel" :options="regionFilter" clearable placeholder="全部地区" />
      </span>
      <span class="f-more" :class="{ on: isSet('missing') }">
        <label class="sr-only" for="vf-missing">缺失</label>
        <SelectInput id="vf-missing" v-model="query.missing" class="f-sel" :options="missingOptions" clearable placeholder="缺失项" />
      </span>
      <span class="f-more" :class="{ on: isSet('short') }">
        <label class="sr-only" for="vf-short">短视频</label>
        <SelectInput id="vf-short" v-model="query.short" class="f-sel" :options="shortOptions" clearable placeholder="短视频" />
      </span>
      <ABtn
        class="more-btn"
        variant="ghost"
        icon="filter"
        :aria-expanded="moreOpen ? 'true' : 'false'"
        title="地区 / 缺失项 / 短视频"
        @click="moreOpen = !moreOpen"
      >{{ moreOpen ? '收起筛选' : '更多筛选' }}<span v-if="moreSet && !moreOpen" class="more-n num">{{ moreSet }}</span></ABtn>
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
        <template #cell-coverUrl="{ row }">
          <button type="button" class="cover" title="预览" :aria-label="`预览「${row.title}」`" @click="openPreview(row)">
            <Thumb :src="row.coverUrl || ''" :width="64" icon="video" />
            <span class="cover-play" aria-hidden="true"><AIcon name="play" :size="14" /></span>
          </button>
        </template>
        <template #cell-title="{ row }">
          <div class="ttl">
            <button type="button" class="title-link clamp-2" @click="editor.openEdit(row)">{{ row.title }}</button>
            <p class="sub small">
              <span class="mono">{{ row.publicId }}</span>
              <span v-if="!row.playbackUrl" class="url-miss" title="没有播放地址：前台无法播放"><AIcon name="warning" :size="12" />无播放地址</span>
              <span v-if="row.tags?.length" class="tags ellipsis" :title="row.tags.join(' ')">{{ row.tags.join(' ') }}</span>
            </p>
          </div>
        </template>
        <template #cell-topicName="{ row }">
          <div class="cls">
            <span v-if="row.topicName" class="ellipsis" :title="row.topicName">{{ row.topicName }}</span>
            <span v-else class="dim">无专题</span>
            <span v-if="catRegion(row)" class="muted small ellipsis">{{ catRegion(row) }}</span>
          </div>
        </template>
        <template #cell-durationSec="{ value }"><span :class="value ? '' : 'dim'">{{ fmtDuration(value) }}</span></template>
        <template #cell-playCount="{ value }"><span :title="fmtNum(value)">{{ fmtCount(value) }}</span></template>
        <template #cell-status="{ row }">
          <span class="st">
            <StatusBadge :status="row.status" />
            <span v-if="row.isShort" class="chip outline short" title="在前台短视频流里">短</span>
          </span>
        </template>
        <template #cell-publishedAt="{ value }"><span class="muted nowrap" :title="fmtDate(value)">{{ fmtShortDate(value) }}</span></template>

        <template #actions="{ row }">
          <ABtn size="sm" variant="ghost" icon="edit" @click="editor.openEdit(row)">编辑</ABtn>
          <ABtn size="sm" variant="ghost" icon="trash" title="删除" :aria-label="`删除「${row.title}」`" @click="removeOne(row)" />
        </template>

        <template #empty>
          <EmptyState v-if="hasFilters" icon="search" title="没有匹配的视频" text="换个关键词或筛选条件试试">
            <ABtn @click="resetFilters">清除筛选</ABtn>
          </EmptyState>
          <EmptyState v-else icon="video" title="还没有视频" text="可以从 Excel / CSV 批量导入，也可以把视频文件放进素材文件夹后扫描导入">
            <ABtn variant="primary" icon="import" :to="{ path: '/import', query: { type: 'videos' } }">批量导入</ABtn>
            <ABtn icon="folder" to="/media">从素材文件夹导入</ABtn>
            <ABtn icon="plus" @click="editor.openNew()">新建视频</ABtn>
          </EmptyState>
        </template>
      </DataTable>

      <APager v-model:page="query.page" v-model:page-size="query.pageSize" :total="total" :disabled="loading" />
    </div>

    <BatchBar :count="selected.length" :busy="batch.busy" @clear="clearSelection">
      <ABtn size="sm" icon="eye" :disabled="batch.busy" @click="runStatus('publish', '已上架')">上架</ABtn>
      <ABtn size="sm" icon="eye-off" :disabled="batch.busy" @click="runStatus('unpublish', '已下架')">下架</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="runStatus('draft', '已设为草稿')">设为草稿</ABtn>
      <span class="sep" aria-hidden="true" />
      <ABtn size="sm" :disabled="batch.busy" @click="openBatchValue('setTopic')">改专题…</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="openBatchValue('setCategory')">改分类…</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="openBatchValue('setRegion')">改地区…</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="openBatchValue('setQuality')">改清晰度…</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="openBatchValue('setCreator')">改创作者…</ABtn>
      <ABtn size="sm" icon="hash" :disabled="batch.busy" @click="openBatchValue('addTags')">加标签…</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="openBatchValue('removeTags')">删标签…</ABtn>
      <span class="sep" aria-hidden="true" />
      <ABtn size="sm" icon="film" :title="SHORT_TIP" :disabled="batch.busy" @click="batch.run('addShort', undefined, { done: '已加入短视频（前台短视频流优先推荐）' })">加入短视频</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="batch.run('removeShort', undefined, { done: '已移出短视频' })">移出短视频</ABtn>
      <ABtn size="sm" icon="scan" :disabled="batch.busy" @click="openProbe">提取时长和封面</ABtn>
      <span class="sep" aria-hidden="true" />
      <ABtn size="sm" variant="danger" icon="trash" :disabled="batch.busy" @click="batchDelete">删除</ABtn>
    </BatchBar>

    <ADrawer
      ref="drawer"
      v-model:open="editor.open"
      :title="editor.isNew ? '新建视频' : '编辑视频'"
      :width="640"
      :dirty="editor.dirty"
      :busy="editor.saving"
      :loading="editor.loadingRow"
      @save="editor.submit()"
    >
      <VideoForm :editor="editor" />
      <template #footer>
        <ABtn v-if="!editor.isNew && editor.row" variant="danger" icon="trash" :disabled="editor.saving" @click="removeOne(editor.row, { fromDrawer: true })">删除</ABtn>
        <ABtn :disabled="editor.saving" @click="drawer?.requestClose()">取消</ABtn>
        <ABtn variant="primary" :loading="editor.saving" @click="editor.submit()">{{ editor.isNew ? '创建' : '保存' }}</ABtn>
      </template>
    </ADrawer>

    <VideoPreview v-model:open="previewOpen" :video="previewRow" @edit="editFromPreview" />

    <BatchValueModal
      v-model:open="bv.open"
      :title="bv.title"
      :label="bv.label"
      :mode="bv.mode"
      :options="bv.options"
      :searchable="bv.searchable"
      :null-label="bv.nullLabel"
      :hint="bv.hint"
      hash
      :count="selected.length"
      unit="个视频"
      :busy="batch.busy"
      @submit="submitBatchValue"
    />

    <ProbeRunner v-model:open="probeOpen" :ids="probeIds" :get-row="rowById" @finished="onProbeFinished" />
  </div>
</template>

<style scoped>
.f-sel { width: 112px; }
.f-more { display: contents; }
.filters .more-btn { display: none; }
.more-n { min-width: 16px; height: 16px; margin-left: 4px; padding: 0 4px; border-radius: 8px; background: var(--accent); color: var(--on-accent); font-size: 10.5px; font-weight: 600; line-height: 16px; text-align: center; }
/* 筛选栏一行放不下 7 个下拉时：地区 / 缺失项 / 短视频收进「更多筛选」（已选了值的照常显示） */
@media (max-width: 1399px) {
  .filters:not(.more-open) .f-more:not(.on) { display: none; }
  .filters .more-btn { display: inline-flex; }
}

.cover { position: relative; display: block; border-radius: 6px; }
.cover-play { position: absolute; inset: 0; display: grid; place-items: center; border-radius: 6px; background: rgba(0, 0, 0, .45); color: #fff; opacity: 0; transition: opacity .12s; }
.cover:hover .cover-play, .cover:focus-visible .cover-play { opacity: 1; }
.ttl { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ttl .title-link { line-height: 1.45; word-break: break-all; }
.sub { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--t3); }
/* width:0 + min-width:100%：不参与表格列宽的计算（标签很长时不把列撑宽），但仍占满单元格 */
.sub { width: 0; min-width: 100%; }
.sub .mono { flex: none; font-size: 11.5px; }
.url-miss { display: inline-flex; flex: none; align-items: center; gap: 3px; color: var(--warn); white-space: nowrap; }
.tags { min-width: 0; }
/* 专题 / 分类：两行，名字太长时截断（列宽减去内边距） */
.cls { display: flex; flex-direction: column; max-width: 96px; line-height: 1.45; }
.st { display: inline-flex; align-items: center; gap: 4px; }
.short { height: 18px; padding: 0 5px; }
.sep { width: 1px; height: 18px; margin: 0 2px; background: var(--line-2); }
</style>
