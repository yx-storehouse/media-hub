<script setup>
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import { listAlbums, getAlbum, createAlbum, updateAlbum, deleteAlbum, batchAlbums } from '../api'
import { useListPage } from '../composables/useListPage'
import { useEditor } from '../composables/useEditor'
import { useBatch } from '../composables/useBatch'
import { useExport } from '../composables/useExport'
import { useMeta } from '../composables/useMeta'
import { confirmDialog } from '../components/confirm'
import { toast, toastError } from '../components/toast'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
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
import FormField from '../components/FormField.vue'
import TextInput from '../components/TextInput.vue'
import TextArea from '../components/TextArea.vue'
import TagsInput from '../components/TagsInput.vue'
import DateTimeInput from '../components/DateTimeInput.vue'
import AlbumImages from './albums/AlbumImages.vue'
import { fmtDate, fmtShortDate, fmtNum } from '../utils/format'
import { imageSize } from '../utils/image'

defineOptions({ name: 'AlbumsPage' })

/*
 * 图片（图集）：前台创作者主页「图片」里的内容，结构照 KeywordsPage。
 * 一个图集 = 标题（单张图可以不写）+ 简介 + 标签 + 创作者 + 1~100 张有顺序的图（第一张是封面）+ 上架 / 下架。
 * 图片的增删、排序、上传、读宽高都在 albums/AlbumImages.vue 里；删除图集只删记录，素材文件不动。
 */

/* ① 列表（creatorId 和创作者页「查看图集」的链接一致） */
const { query, rows, total, loading, loaded, error, selected, reload, sortModel, hasFilters, resetFilters, clearSelection, params, whenLoaded } =
  useListPage(listAlbums, { defaults: { q: '', status: '', creatorId: '', sort: 'publishedAt', order: 'desc' } })

const { meta, creatorOptions, albumStatusOptions } = useMeta()

/* ② 表格列：合计要放得进 1280×800 的内容区（约 1010px），排序只靠表头 */
const columns = [
  { key: 'id', label: 'ID', width: 64, sortable: true, class: 'dim' },
  { key: 'cover', label: '封面', width: 68 },
  { key: 'title', label: '标题', minWidth: 200, sortable: true, firstOrder: 'asc' },
  { key: 'creatorName', label: '创作者', width: 108 },
  { key: 'imageCount', label: '图片数', width: 80, align: 'right', sortable: true },
  { key: 'status', label: '状态', width: 76 },
  { key: 'publishedAt', label: '发布时间', width: 104, sortable: true },
  { key: 'updatedAt', label: '更新时间', width: 104, sortable: true }
]
const titleOf = r => r.title || ''

/* 简介：和服务端一样去掉行尾空白和首尾空白再比较 / 提交（只改了空白不算改动） */
const DESC_MAX = 5000
const tidy = v => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '').trim()
const IMAGES_MAX = 100

/* ③ 编辑抽屉 */
const drawer = ref(null)
const imagesRef = ref(null)
const editor = useEditor({
  blank: () => ({ title: '', creatorId: null, images: [], description: '', tags: [], status: 1, publishedAt: null }),
  fromRow: r => ({
    title: r.title || '',
    creatorId: r.creatorId ?? null,
    images: (r.images || []).map(i => ({ url: i.url, width: i.width || 0, height: i.height || 0 })),
    description: r.description || '',
    tags: [...(r.tags || [])],
    status: r.status ?? 1,
    publishedAt: r.publishedAt ?? null
  }),
  findRow: id => rows.value.find(r => r.id === id),
  fetchRow: getAlbum,
  whenReady: whenLoaded,
  create: createAlbum,
  update: updateAlbum,
  toBody: f => ({ ...f, title: f.title.trim(), description: tidy(f.description) }),
  validate: f => {
    const e = {}
    if (!f.creatorId) e.creatorId = '请选择创作者'
    if ([...f.title.trim()].length > 200) e.title = '标题最多 200 个字'
    if (!f.images.length) e.images = '至少要有一张图片'
    else if (f.images.length > IMAGES_MAX) e.images = `最多 ${IMAGES_MAX} 张图片`
    if ([...tidy(f.description)].length > DESC_MAX) e.description = `简介最多 ${fmtNum(DESC_MAX)} 个字`
    if (f.tags.length > 20) e.tags = '标签最多 20 个'
    return e
  },
  onSaved: () => reload()
})

/*
 * 保存：先等新加的图读完宽高（最多几秒）；还有图在上传 / 上传失败时不保存，提示到「图片」下面。
 * 等的期间换了一条或关掉了抽屉：不再提交。
 */
const preparing = ref(false)
async function save() {
  if (editor.saving || preparing.value || !editor.open) return
  const session = `${editor.isNew}:${editor.id}`
  preparing.value = true
  let s = null
  try {
    s = await imagesRef.value?.settle()
  } finally {
    preparing.value = false
  }
  if (!editor.open || session !== `${editor.isNew}:${editor.id}`) return
  if (s?.uploading) {
    editor.showFieldError('images', `还有 ${s.uploading} 张图片正在上传，传完再保存`)
    toast(`还有 ${s.uploading} 张图片正在上传，传完再保存`, { type: 'error' })
    return
  }
  if (s?.failed) {
    // 原因写在每张图上；重试没用的（文件太大等）只有「移除」
    editor.showFieldError('images', `有 ${s.failed} 张图片上传失败：${s.retryable ? '点「重试」或移除' : '移除'}后再保存`)
    toast(`有 ${s.failed} 张图片上传失败`, { type: 'error' })
    return
  }
  await editor.submit()
}

/* 「还在上传 / 上传失败」的提示：上传都结束了、失败的都重试或移除了就去掉（不用等图片列表变化） */
watch(() => [imagesRef.value?.uploading || 0, imagesRef.value?.failed || 0], ([up, failed]) => {
  const msg = editor.errors.images || ''
  if ((/正在上传/.test(msg) && !up) || (/上传失败/.test(msg) && !failed)) {
    const { images: _, ...rest } = editor.errors
    editor.errors = rest
  }
})

const label = r => (r.title ? `「${[...r.title].slice(0, 30).join('')}${[...r.title].length > 30 ? '…' : ''}」` : `这个图集（${r.imageCount} 张图片）`)
async function removeOne(row, { fromDrawer = false } = {}) {
  const ok = await confirmDialog({
    title: '删除图集',
    message: `确定删除${label(row)}？\n只删除图集记录，素材文件不会被删除。\n删除后不可恢复。`,
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  try {
    await deleteAlbum(row.id)
    toast('已删除', { type: 'ok' })
    selected.value = selected.value.filter(id => id !== row.id)
    if (fromDrawer) editor.close()
    reload()
  } catch (e) {
    toastError(e, '删除失败')
  }
}

/* ④ 批量操作 */
const batch = useBatch(batchAlbums, { selected, reload, clearSelection })
const batchDelete = () => batch.run('delete', undefined, {
  confirm: { title: '批量删除图集', message: `确定删除选中的 ${selected.value.length} 个图集？\n只删除图集记录，素材文件不会被删除。\n删除后不可恢复。`, confirmText: '删除', danger: true },
  done: '已删除'
})
const BATCH_VALUE = {
  setCreator: () => ({ title: '批量改创作者', label: '创作者', options: creatorOptions.value, searchable: true, done: '已修改创作者' }),
  addTags: () => ({ title: '批量加标签', label: '要添加的标签', mode: 'tags', hint: '不带 #；已有的标签不会重复，每个图集最多 20 个', done: '已加标签' }),
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

/*
 * 批量「读取尺寸」：外链图片导入进来没有宽高（服务端只能读站内 /media/ 的文件头），前台只能按默认比例排；
 * 这里在浏览器里把选中图集里尺寸未知的图读一遍，读到了就保存。一个图集一个图集来，离开页面就停。
 */
const sizing = reactive({ running: false, done: 0, total: 0 })
let sizingCtrl = null
onBeforeUnmount(() => sizingCtrl?.abort())
async function readSizes() {
  const ids = [...selected.value]
  if (!ids.length || sizing.running || batch.busy) return
  sizingCtrl = new AbortController()
  const { signal } = sizingCtrl
  Object.assign(sizing, { running: true, done: 0, total: ids.length })
  let saved = 0
  let complete = 0
  let unread = 0
  let failed = 0
  try {
    for (const id of ids) {
      if (signal.aborted) return
      try {
        const a = await getAlbum(id)
        const missing = a.images.filter(i => !(i.width && i.height))
        if (!missing.length) { complete++; continue }
        const found = new Map()
        // 一个图集里同时读 4 张
        for (let n = 0; n < missing.length; n += 4) {
          const part = missing.slice(n, n + 4)
          const sizes = await Promise.all(part.map(i => imageSize(i.url, { signal })))
          part.forEach((i, k) => { if (sizes[k]) found.set(i.url, sizes[k]) })
        }
        if (signal.aborted) return
        unread += missing.length - found.size
        if (!found.size) continue
        await updateAlbum(id, { images: a.images.map(i => (found.has(i.url) ? { url: i.url, ...found.get(i.url) } : i)) })
        saved++
      } catch (e) {
        failed++
        if (failed === 1) toastError(e, '读取尺寸失败')
      } finally {
        sizing.done++
      }
    }
    const parts = [
      saved ? `${saved} 个图集已补上尺寸` : '',
      complete ? `${complete} 个本来就完整` : '',
      unread ? `${unread} 张图片读不到（打不开）` : '',
      failed ? `${failed} 个图集出错` : ''
    ].filter(Boolean)
    toast(parts.join('，') || '没有需要读取的图片', { type: failed || unread ? 'info' : 'ok', duration: 6000 })
    if (saved) reload()
  } finally {
    sizing.running = false
  }
}

/* ⑤ 导出 */
const exporter = useExport('albums', params)

/* 新建时如果正按创作者筛选，就预选这个创作者 */
const openNew = () => editor.openNew(query.creatorId ? { creatorId: Number(query.creatorId) } : null)

/* 在前台查看：移动端创作者主页的「图片」（下架的图集、停用的创作者前台看不到） */
const creatorOf = id => meta.value.creators.find(c => c.id === id) || null
const appLink = creatorId => `./index.html#/creator/${creatorId}?tab=images`
const appBlocked = computed(() => {
  const r = editor.row
  if (!r) return ''
  if (r.status !== 1) return '已下架的图集在前台不显示'
  const c = creatorOf(r.creatorId)
  if (c && c.status !== 1) return '创作者已停用，前台不显示'
  return ''
})

const subtitle = computed(() => (loaded.value ? `共 ${fmtNum(total.value)} 个图集` : ''))
</script>

<template>
  <div class="list-page">
    <PageHeader title="图片" :subtitle="subtitle">
      <template #actions>
        <ABtn icon="import" :to="{ path: '/import', query: { type: 'albums' } }">导入</ABtn>
        <ABtn icon="download" :loading="exporter.busy" @click="exporter.run()">导出</ABtn>
        <ABtn variant="primary" icon="plus" @click="openNew">新建图集</ABtn>
      </template>
    </PageHeader>

    <div class="filters">
      <SearchBox v-model="query.q" placeholder="搜索标题 / 简介 / 标签 / ID" :width="250" />
      <label class="sr-only" for="af-status">状态</label>
      <SelectInput id="af-status" v-model="query.status" class="f-sel" :options="albumStatusOptions" clearable placeholder="全部状态" />
      <label class="sr-only" for="af-creator">创作者</label>
      <SelectInput id="af-creator" v-model="query.creatorId" class="f-sel wide" :options="creatorOptions" searchable clearable placeholder="全部创作者" :pop-width="240" />
      <button v-if="hasFilters" type="button" class="reset" @click="resetFilters">清除筛选</button>
      <span class="grow" />
      <span class="dim small tip">前台创作者主页的「图片」里只显示上架的图集</span>
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
        <template #cell-cover="{ row }">
          <Thumb :src="row.cover?.url || ''" :width="44" :ratio="1" />
        </template>
        <template #cell-title="{ row }">
          <div class="ttl">
            <button type="button" class="title-link ellipsis" :class="{ untitled: !row.title }" :title="titleOf(row) || '无标题'" @click="editor.openEdit(row)">{{ titleOf(row) || '无标题' }}</button>
            <p v-if="row.tags?.length || row.description" class="sub small ellipsis">
              <span v-for="t in row.tags" :key="t" class="tag">#{{ t }}</span>
              <span v-if="row.description" class="desc">{{ row.description }}</span>
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
        <template #cell-imageCount="{ value }"><span class="num">{{ fmtNum(value) }}</span></template>
        <template #cell-status="{ value }"><StatusBadge kind="album" :status="value" /></template>
        <template #cell-publishedAt="{ value }"><span class="muted nowrap" :title="fmtDate(value)">{{ fmtShortDate(value) }}</span></template>
        <template #cell-updatedAt="{ value }"><span class="muted nowrap" :title="fmtDate(value)">{{ fmtShortDate(value) }}</span></template>

        <template #actions="{ row }">
          <ABtn size="sm" variant="ghost" icon="edit" @click="editor.openEdit(row)">编辑</ABtn>
          <ABtn size="sm" variant="ghost" icon="trash" title="删除" aria-label="删除这个图集" @click="removeOne(row)" />
        </template>

        <template #empty>
          <EmptyState v-if="hasFilters" icon="search" title="没有匹配的图集" text="换个关键词或筛选条件试试">
            <ABtn @click="resetFilters">清除筛选</ABtn>
          </EmptyState>
          <EmptyState v-else icon="image" title="还没有图集" text="图集显示在前台创作者主页的「图片」里；一张照片就是只有一张图的图集">
            <ABtn variant="primary" icon="plus" @click="openNew">新建图集</ABtn>
            <ABtn icon="import" :to="{ path: '/import', query: { type: 'albums' } }">批量导入</ABtn>
          </EmptyState>
        </template>
      </DataTable>

      <APager v-model:page="query.page" v-model:page-size="query.pageSize" :total="total" :disabled="loading" />
    </div>

    <BatchBar :count="selected.length" :busy="batch.busy || sizing.running" @clear="clearSelection">
      <ABtn size="sm" icon="eye" :disabled="batch.busy || sizing.running" @click="batch.run('publish', undefined, { done: '已上架' })">上架</ABtn>
      <ABtn size="sm" icon="eye-off" :disabled="batch.busy || sizing.running" @click="batch.run('unpublish', undefined, { done: '已下架' })">下架</ABtn>
      <span class="sep" aria-hidden="true" />
      <ABtn size="sm" icon="user" :disabled="batch.busy || sizing.running" @click="openBatchValue('setCreator')">改创作者…</ABtn>
      <ABtn size="sm" icon="hash" :disabled="batch.busy || sizing.running" @click="openBatchValue('addTags')">加标签…</ABtn>
      <ABtn size="sm" :disabled="batch.busy || sizing.running" @click="openBatchValue('removeTags')">删标签…</ABtn>
      <ABtn
        size="sm"
        icon="image"
        :loading="sizing.running"
        :disabled="batch.busy || sizing.running"
        title="外链图片导入后没有宽高：在浏览器里读出来并保存，前台按真实比例显示"
        @click="readSizes"
      >{{ sizing.running ? `读取尺寸 ${sizing.done} / ${sizing.total}` : '读取尺寸' }}</ABtn>
      <span class="sep" aria-hidden="true" />
      <ABtn size="sm" variant="danger" icon="trash" :disabled="batch.busy || sizing.running" @click="batchDelete">删除</ABtn>
    </BatchBar>

    <ADrawer
      ref="drawer"
      v-model:open="editor.open"
      :title="editor.isNew ? '新建图集' : '编辑图集'"
      :width="820"
      :dirty="editor.dirty"
      :busy="editor.saving"
      :loading="editor.loadingRow"
      @save="save"
    >
      <div class="form-grid">
        <FormField class="full" label="标题" field="title" :error="editor.errors.title" hint="单张图片可以不写标题">
          <TextInput v-model="editor.form.title" :maxlength="200" show-count placeholder="例如：雨后的老街" />
        </FormField>
        <FormField class="full" label="创作者" field="creatorId" required :error="editor.errors.creatorId">
          <SelectInput v-model="editor.form.creatorId" :options="creatorOptions" searchable placeholder="选择创作者" />
        </FormField>
        <FormField
          class="full"
          label="图片"
          field="images"
          required
          :error="editor.errors.images"
          :hint="`第一张是封面；拖动缩略图调整顺序；最多 ${IMAGES_MAX} 张。上传的文件放在素材文件的 images/albums 里`"
        >
          <AlbumImages ref="imagesRef" v-model="editor.form.images" :max="IMAGES_MAX" upload-dir="images/albums" :disabled="editor.saving" />
        </FormField>
        <FormField class="full" label="简介" field="description" :error="editor.errors.description" hint="显示在图集详情里，支持换行">
          <TextArea v-model="editor.form.description" :rows="3" :max-rows="12" :maxlength="DESC_MAX" show-count placeholder="可选" />
        </FormField>
        <FormField class="full" label="标签" field="tags" :error="editor.errors.tags" hint="不带 #，最多 20 个">
          <TagsInput v-model="editor.form.tags" />
        </FormField>
        <FormField label="状态" field="status" :error="editor.errors.status" hint="下架后前台不显示">
          <SelectInput v-model="editor.form.status" :options="albumStatusOptions" />
        </FormField>
        <FormField label="发布时间" field="publishedAt" :error="editor.errors.publishedAt" :hint="editor.isNew ? '留空 = 保存的时间；前台按它从新到旧排' : '前台按它从新到旧排'">
          <DateTimeInput v-model="editor.form.publishedAt" :clearable="editor.isNew" />
        </FormField>
      </div>

      <template v-if="!editor.isNew && editor.row">
        <h4 class="form-section">其他信息</h4>
        <dl class="kv">
          <div><dt>ID</dt><dd>{{ editor.row.id }}</dd></div>
          <div><dt>图片</dt><dd>{{ fmtNum(editor.row.imageCount) }} 张</dd></div>
          <div><dt>创建时间</dt><dd>{{ fmtDate(editor.row.createdAt) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ fmtDate(editor.row.updatedAt) }}</dd></div>
        </dl>
        <div class="links">
          <ABtn size="sm" icon="creator" :to="{ path: '/creators', query: { edit: editor.row.creatorId } }">编辑创作者</ABtn>
          <ABtn size="sm" icon="image" :to="{ path: '/albums', query: { creatorId: editor.row.creatorId } }">他的全部图集</ABtn>
          <ABtn
            size="sm"
            icon="external"
            :href="appLink(editor.row.creatorId)"
            target="_blank"
            rel="noopener"
            :disabled="!!appBlocked"
            :title="appBlocked || '打开移动端创作者主页的「图片」'"
          >
            在前台查看
          </ABtn>
        </div>
      </template>

      <template #footer>
        <ABtn v-if="!editor.isNew && editor.row" variant="danger" icon="trash" :disabled="editor.saving || preparing" @click="removeOne(editor.row, { fromDrawer: true })">删除</ABtn>
        <ABtn :disabled="editor.saving" @click="drawer?.requestClose()">取消</ABtn>
        <ABtn variant="primary" :loading="editor.saving || preparing" @click="save">{{ editor.isNew ? '创建' : '保存' }}</ABtn>
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
      unit="个图集"
      :busy="batch.busy"
      @submit="submitBatchValue"
    />
  </div>
</template>

<style scoped>
.f-sel { width: 128px; }
.f-sel.wide { width: 170px; }
.tip { white-space: nowrap; }
@media (max-width: 1180px) {
  .tip { display: none; }
}

.ttl { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
/* width:0 + min-width:100%：不参与表格列宽的计算（长标题、长简介不把列撑宽），但仍占满单元格 */
.ttl > * { width: 0; min-width: 100%; }
.untitled { color: var(--t3); font-weight: 400; }
.sub { color: var(--t3); }
.tag + .tag { margin-left: 6px; }
.tag + .desc { margin-left: 10px; }
.desc { color: #5c5c5c; }
/* 单元格里的长名字用 max-width 截断（列宽减去内边距），不把列撑宽 */
.who { display: flex; flex-direction: column; max-width: 84px; line-height: 1.4; }
.sep { width: 1px; height: 18px; margin: 0 2px; background: var(--line-2); }
.links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
</style>
