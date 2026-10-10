<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
import AIcon from '../components/AIcon.vue'
import Thumb from '../components/Thumb.vue'
import SearchBox from '../components/SearchBox.vue'
import SelectInput from '../components/SelectInput.vue'
import DataTable from '../components/DataTable.vue'
import APager from '../components/APager.vue'
import EmptyState from '../components/EmptyState.vue'
import { confirmDialog } from '../components/confirm'
import { toast, toastError } from '../components/toast'
import { openLayers } from '../components/layers'
import { useLeaveGuard } from '../composables/useLeaveGuard'
import { listMedia, deleteMedia } from '../api'
import { fmtSize, fmtDate, fmtShortDate, fmtNum } from '../utils/format'
import { createUploadQueue } from './media/uploadQueue'
import { copyText, filesFromDrop, baseOf, ACCEPT_ATTR } from './media/files'
import MediaGrid from './media/MediaGrid.vue'
import UploadPanel from './media/UploadPanel.vue'
import MediaPreview from './media/MediaPreview.vue'
import NewFolderModal from './media/NewFolderModal.vue'
import ScanImport from './media/ScanImport.vue'

defineOptions({ name: 'MediaPage' })

/*
 * 素材文件：浏览服务器的 media/ 目录（当前文件夹在地址栏 ?dir=，可以后退 / 刷新 / 分享）、
 * 上传（多选 / 拖到页面任意位置，含整个文件夹；同时传 3 个）、新建文件夹、预览、复制地址、删除，
 * 以及「扫描导入视频」：把文件夹里的视频文件批量建成视频记录。
 * 文件夹里的条目一次全部取回（服务端不分页），这里在前端筛选、排序，并每页最多渲染 100 个。
 */
const route = useRoute()
const router = useRouter()

/* ---------------- 当前文件夹 ---------------- */

const cleanDir = v => String(Array.isArray(v) ? v[0] : v || '').split('/').filter(s => s && s !== '.' && s !== '..').join('/')
const dir = computed(() => cleanDir(route.query.dir))
const crumbs = computed(() => {
  const parts = dir.value ? dir.value.split('/') : []
  return [{ name: 'media', path: '' }, ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join('/') }))]
})
const goDir = path => {
  if (path === dir.value) return load()
  router.push({ query: { ...route.query, dir: path || undefined } })
}

const entries = shallowRef([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
let seq = 0

async function load({ quiet = false } = {}) {
  const my = ++seq
  if (!quiet) loading.value = true
  error.value = ''
  try {
    const res = await listMedia(dir.value)
    if (my !== seq) return
    entries.value = res?.entries || []
    loaded.value = true
  } catch (e) {
    if (my !== seq) return
    error.value = e.message || '加载失败'
    entries.value = []
  } finally {
    if (my === seq) loading.value = false
  }
}

/* ---------------- 视图 / 筛选 / 排序 / 分页（都在前端） ---------------- */

const VIEW_KEY = 'reel.admin.media.view'
const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid' } catch { return 'grid' } }
const view = ref(readView())
watch(view, v => { try { localStorage.setItem(VIEW_KEY, v) } catch { /* 不记也能用 */ } })

const q = ref('')
const kind = ref(null)
const sortModel = ref({ key: 'name', order: 'asc' })
const page = ref(1)
const pageSize = ref(100)
watch([q, kind, sortModel], () => { page.value = 1 })

/* 换文件夹：清掉筛选，重新加载 */
watch(dir, () => {
  q.value = ''
  kind.value = null
  page.value = 1
  load()
})
onMounted(load)

const KIND_OPTIONS = [
  { value: 'dir', label: '文件夹' },
  { value: 'video', label: '视频' },
  { value: 'image', label: '图片' },
  { value: 'other', label: '其他文件' }
]
const SORT_OPTIONS = [
  { value: 'name:asc', label: '名称 A→Z' },
  { value: 'name:desc', label: '名称 Z→A' },
  { value: 'mtime:desc', label: '最近修改' },
  { value: 'mtime:asc', label: '最早修改' },
  { value: 'size:desc', label: '最大' },
  { value: 'size:asc', label: '最小' },
  { value: 'usedBy:desc', label: '使用最多' }
]
const sortValue = computed({
  get: () => `${sortModel.value.key}:${sortModel.value.order}`,
  set: v => { const [key, order] = String(v || 'name:asc').split(':'); sortModel.value = { key, order } }
})
const hasFilters = computed(() => !!q.value || !!kind.value)
const resetFilters = () => { q.value = ''; kind.value = null }

const filtered = computed(() => {
  const t = q.value.trim().toLowerCase()
  let list = entries.value
  if (t) list = list.filter(e => e.name.toLowerCase().includes(t))
  if (kind.value) list = list.filter(e => e.type === kind.value)
  const { key, order } = sortModel.value
  const dirSign = order === 'desc' ? -1 : 1
  const cmp = key === 'name'
    ? (a, b) => a.name.localeCompare(b.name, 'zh')
    : (a, b) => (a[key] || 0) - (b[key] || 0) || a.name.localeCompare(b.name, 'zh')
  // 文件夹始终排在前面
  return [...list].sort((a, b) => ((a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : cmp(a, b) * dirSign))
})
const pageEntries = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))

const counts = computed(() => {
  let dirs = 0
  let files = 0
  let bytes = 0
  for (const e of entries.value) {
    if (e.type === 'dir') dirs++
    else { files++; bytes += e.size }
  }
  return { dirs, files, bytes }
})
/* 加载失败时不显示「0 个文件夹 · 0 个文件」这种假的统计 */
const subtitle = computed(() => (loaded.value && !error.value ? `${counts.value.dirs} 个文件夹 · ${fmtNum(counts.value.files)} 个文件 · ${fmtSize(counts.value.bytes)}` : ''))

/* 视频的封面：同一文件夹里同名的图片（a.mp4 ↔ a.jpg） */
const posters = computed(() => {
  const m = new Map()
  for (const e of entries.value) if (e.type === 'image') {
    const k = baseOf(e.name).toLowerCase()
    if (!m.has(k)) m.set(k, e.url)
  }
  return m
})
const posterOf = e => (e.type === 'video' ? posters.value.get(baseOf(e.name).toLowerCase()) || '' : '')

/* ---------------- 打开 / 预览 / 复制 / 删除 ---------------- */

const preview = ref({ open: false, entry: null })
const previewList = computed(() => filtered.value.filter(e => e.type !== 'dir'))

function openEntry(e) {
  if (e.type === 'dir') return goDir(e.path)
  preview.value = { open: true, entry: e }
}

async function copy(e) {
  const ok = await copyText(e.url)
  if (ok) toast('已复制地址：' + e.url, { type: 'ok' })
  else toast('复制失败，请手动复制：' + e.url, { type: 'error', duration: 8000 })
}

const deleting = ref(new Set())
async function remove(e) {
  if (deleting.value.has(e.path)) return
  const isDir = e.type === 'dir'
  const ok = await confirmDialog({
    title: isDir ? '删除文件夹' : '删除文件',
    message: isDir
      ? `确定删除文件夹「${e.name}」？\n只能删除空文件夹。`
      : `确定删除「${e.name}」？\n删除后不可恢复。${e.usedBy ? `\n它正被 ${e.usedBy} 个视频使用。` : ''}`,
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  deleting.value = new Set(deleting.value).add(e.path)
  try {
    try {
      await deleteMedia(e.path, false)
    } catch (err) {
      // 被视频引用：服务端拒绝（field = usedBy），再确认一次才强制删除
      if (err?.field !== 'usedBy') throw err
      const force = await confirmDialog({
        title: '文件正在使用',
        message: `${err.message}。\n强制删除后，这些视频的播放地址或封面会失效（前台显示不出来），需要另外修改。\n仍要删除吗？`,
        confirmText: '仍然删除',
        danger: true
      })
      if (!force) return
      await deleteMedia(e.path, true)
    }
    toast('已删除：' + e.name, { type: 'ok' })
    if (preview.value.entry?.path === e.path) preview.value = { open: false, entry: null }
    load({ quiet: true })
  } catch (err) {
    toastError(err, '删除失败')
  } finally {
    const s = new Set(deleting.value)
    s.delete(e.path)
    deleting.value = s
  }
}

/* ---------------- 上传 ---------------- */

let refreshTimer = 0
const queue = createUploadQueue({
  concurrency: 3,
  // 传完的文件在当前文件夹（或它的子文件夹）里：刷新列表（合并成一次）
  onDone: item => {
    const p = item.result?.path || item.path
    const cur = dir.value
    if (!cur || p === cur || p.startsWith(cur + '/')) {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => load({ quiet: true }), 400)
    }
  }
})
const showQueue = computed(() => queue.items.length > 0)

const fileEl = ref(null)
function onPick(ev) {
  const files = [...(ev.target.files || [])]
  ev.target.value = ''
  enqueue(files.map(f => ({ file: f, rel: f.name })))
}
function enqueue(list, { truncated = false } = {}) {
  if (!list.length) { toast('没有可以上传的文件（文件夹是空的或读取不到）'); return }
  const n = queue.add(list, dir.value)
  toast(`${fmtNum(n)} 个文件加入上传队列（传到「${where.value}」）${truncated ? '；文件太多，只取了前 2000 个' : ''}`)
}
const where = computed(() => 'media' + (dir.value ? '/' + dir.value : ''))

/* 拖放：整个窗口都是放置区；有弹窗打开时不接（但也不让浏览器把文件直接打开） */
const dragging = ref(false)
let dragTimer = 0
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
function onWinDragOver(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  if (openLayers.value > 0) { e.dataTransfer.dropEffect = 'none'; return }
  e.dataTransfer.dropEffect = 'copy'
  dragging.value = true
  // dragover 拖动期间不断触发；停了 200ms 没再触发 = 拖出窗口了
  clearTimeout(dragTimer)
  dragTimer = setTimeout(() => { dragging.value = false }, 200)
}
function onWinDrop(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragging.value = false
  if (openLayers.value > 0) return
  filesFromDrop(e.dataTransfer).then(list => enqueue(list, { truncated: !!list.truncated })).catch(err => toastError(err, '读取拖入的文件失败'))
}
onMounted(() => {
  window.addEventListener('dragover', onWinDragOver)
  window.addEventListener('drop', onWinDrop)
})

/* 还有文件在传时离开 / 刷新页面：先确认；确认离开后页面卸载，没传完的上传随之取消（useUploader + 下面的 cancelAll） */
useLeaveGuard(() => queue.stats.value.running > 0, {
  title: '还有文件在上传',
  message: '还有文件没传完，离开页面会取消它们。确定离开？',
  confirmText: '离开'
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', onWinDragOver)
  window.removeEventListener('drop', onWinDrop)
  clearTimeout(refreshTimer)
  clearTimeout(dragTimer)
  queue.cancelAll()
})

/* ---------------- 新建文件夹 / 扫描导入 ---------------- */

const folderOpen = ref(false)
const scanOpen = ref(false)
const onFolderCreated = () => load({ quiet: true })

/* ---------------- 列表视图 ---------------- */

const columns = [
  { key: 'name', label: '名称', minWidth: 260, sortable: true, firstOrder: 'asc' },
  { key: 'type', label: '类型', width: 80 },
  { key: 'size', label: '大小', width: 100, align: 'right', sortable: true },
  { key: 'mtime', label: '修改时间', width: 120, sortable: true },
  { key: 'usedBy', label: '使用情况', width: 140, sortable: true }
]
const TYPE_TEXT = { dir: '文件夹', video: '视频', image: '图片', other: '文件' }
const iconOf = e => (e.type === 'dir' ? 'folder' : e.type === 'video' ? 'film' : e.type === 'image' ? 'image' : 'file')
const onRowClick = row => { if (row.type === 'dir') goDir(row.path) }
</script>

<template>
  <div class="media-page">
    <PageHeader title="素材文件" :subtitle="subtitle">
      <template #actions>
        <ABtn icon="folder-plus" @click="folderOpen = true">新建文件夹</ABtn>
        <ABtn icon="scan" @click="scanOpen = true">扫描导入视频</ABtn>
        <ABtn variant="primary" icon="upload" @click="fileEl?.click()">上传文件</ABtn>
        <input ref="fileEl" type="file" multiple class="sr-only" :accept="ACCEPT_ATTR" tabindex="-1" aria-label="选择要上传的文件" @change="onPick">
      </template>
    </PageHeader>

    <div class="filters toolbar">
      <nav class="crumbs" aria-label="当前文件夹">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <AIcon v-if="i" name="chevron-right" :size="12" class="sep" />
          <button
            type="button"
            class="crumb"
            :class="{ cur: i === crumbs.length - 1 }"
            :aria-current="i === crumbs.length - 1 ? 'location' : undefined"
            @click="goDir(c.path)"
          >
            <AIcon v-if="!i" name="folder" :size="14" />{{ c.name }}
          </button>
        </template>
      </nav>
      <span class="grow" />
      <SearchBox v-model="q" placeholder="按名称筛选" :width="180" :delay="150" />
      <SelectInput v-model="kind" :options="KIND_OPTIONS" clearable placeholder="全部类型" aria-label="文件类型" size="sm" class="w-type" />
      <!-- 网格视图没有表头可点，只能用这个下拉排序；列表视图点表头排序 -->
      <SelectInput v-if="view === 'grid'" v-model="sortValue" :options="SORT_OPTIONS" aria-label="排序" size="sm" class="w-sort" :pop-width="140" />
      <button v-if="hasFilters" type="button" class="reset" @click="resetFilters">清除筛选</button>
      <div class="views" role="group" aria-label="显示方式">
        <button type="button" class="vbtn" :class="{ on: view === 'grid' }" :aria-pressed="view === 'grid' ? 'true' : 'false'" title="网格" aria-label="网格视图" @click="view = 'grid'"><AIcon name="grid" :size="15" /></button>
        <button type="button" class="vbtn" :class="{ on: view === 'list' }" :aria-pressed="view === 'list' ? 'true' : 'false'" title="列表" aria-label="列表视图" @click="view = 'list'"><AIcon name="list" :size="15" /></button>
      </div>
      <ABtn variant="ghost" icon="refresh" aria-label="刷新" title="刷新" :loading="loading && loaded" @click="load()" />
    </div>

    <div v-if="showQueue" class="queue-wrap">
      <UploadPanel :queue="queue" />
    </div>

    <div class="mp-body" :class="{ busy: loading && loaded }">
      <div v-if="loading && !loaded" class="state"><span class="spinner lg" /></div>
      <!-- 加载失败 / 空：和列表页一样放在卡片里 -->
      <div v-else-if="error" class="card state-card">
        <EmptyState variant="error" :text="error" :retrying="loading" @retry="load()">
          <ABtn v-if="dir" size="sm" variant="ghost" @click="goDir('')">回到 media 根目录</ABtn>
        </EmptyState>
      </div>
      <div v-else-if="!filtered.length" class="card state-card">
        <EmptyState v-if="hasFilters" icon="search" title="没有匹配的文件" text="换个关键字或类型试试">
          <ABtn @click="resetFilters">清除筛选</ABtn>
        </EmptyState>
        <EmptyState v-else icon="folder" title="这个文件夹是空的" :text="`把视频、图片拖到页面上就能上传到「${where}」\n视频支持 mp4 / webm / mov / mkv / m3u8，图片支持 jpg / png / webp / gif`">
          <ABtn variant="primary" icon="upload" @click="fileEl?.click()">上传文件</ABtn>
          <ABtn icon="folder-plus" @click="folderOpen = true">新建文件夹</ABtn>
        </EmptyState>
      </div>

      <MediaGrid
        v-else-if="view === 'grid'"
        :entries="pageEntries"
        :poster-of="posterOf"
        @open="openEntry"
        @copy="copy"
        @preview="openEntry"
        @delete="remove"
      />

      <div v-else class="list-wrap">
        <DataTable v-model:sort="sortModel" :columns="columns" :rows="pageEntries" row-key="path" :actions-width="150" :row-class="r => (r.type === 'dir' ? 'is-dir' : '')" @row-click="onRowClick">
          <template #cell-name="{ row }">
            <span class="nm">
              <Thumb v-if="row.type === 'image' || posterOf(row)" :src="row.type === 'image' ? row.url : posterOf(row)" :width="44" :ratio="4 / 3" :icon="iconOf(row)" />
              <span v-else class="nm-ico" :class="row.type"><AIcon :name="iconOf(row)" :size="18" /></span>
              <button type="button" class="title-link ellipsis" :title="row.name" @click="openEntry(row)">{{ row.name }}</button>
            </span>
          </template>
          <template #cell-type="{ row }"><span class="muted">{{ TYPE_TEXT[row.type] }}</span></template>
          <template #cell-size="{ row }"><span class="muted num">{{ row.type === 'dir' ? '—' : fmtSize(row.size) }}</span></template>
          <template #cell-mtime="{ row }"><span class="muted" :title="fmtDate(row.mtime)">{{ fmtShortDate(row.mtime) }}</span></template>
          <template #cell-usedBy="{ row }">
            <span v-if="row.type === 'dir'" class="dim">—</span>
            <span v-else :class="row.usedBy ? '' : 'dim'">{{ row.usedBy ? `被 ${row.usedBy} 个视频使用` : '未被使用' }}</span>
          </template>
          <template #actions="{ row }">
            <template v-if="row.type !== 'dir'">
              <ABtn size="sm" variant="ghost" icon="copy" title="复制地址" :aria-label="`复制「${row.name}」的地址`" @click="copy(row)" />
              <ABtn size="sm" variant="ghost" icon="eye" title="预览" :aria-label="`预览「${row.name}」`" @click="openEntry(row)" />
            </template>
            <ABtn size="sm" variant="ghost" icon="trash" title="删除" :aria-label="`删除「${row.name}」`" :disabled="deleting.has(row.path)" @click="remove(row)" />
          </template>
        </DataTable>
      </div>

      <APager v-if="filtered.length > pageSize || page > 1" v-model:page="page" v-model:page-size="pageSize" :total="filtered.length" :page-sizes="[50, 100, 200]" />
    </div>

    <!-- 拖放提示：盖住整个窗口，不挡事件 -->
    <Transition name="fade">
      <div v-if="dragging" class="drop-hint" aria-hidden="true">
        <div class="drop-box">
          <AIcon name="upload" :size="34" :stroke="1.4" />
          <b>松开鼠标，上传到「{{ where }}」</b>
          <span>可以一次拖入多个文件或整个文件夹</span>
        </div>
      </div>
    </Transition>

    <MediaPreview
      v-model:open="preview.open"
      v-model:entry="preview.entry"
      :list="previewList"
      @copy="copy"
      @delete="remove"
    />
    <NewFolderModal v-model:open="folderOpen" :dir="dir" @created="onFolderCreated" />
    <ScanImport v-model:open="scanOpen" :dir="dir" @imported="load({ quiet: true })" />
  </div>
</template>

<style scoped>
.media-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
/* 筛选栏用全站的 .filters（32px 高的控件、「清除筛选」链接），这里只补面包屑和视图切换 */
.toolbar { flex: none; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; min-width: 0; }
.crumb { display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 7px; border-radius: 6px; color: var(--t2); font-size: 13px; }
.crumb:hover { background: var(--hover); color: var(--t1); }
.crumb.cur { color: var(--t1); font-weight: 600; }
.sep { color: var(--t3); }
.w-type { width: 120px; }
.w-sort { width: 120px; }
.views { display: inline-flex; padding: 2px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--panel-2); }
.vbtn { display: grid; place-items: center; width: 30px; height: 26px; border-radius: 5px; color: var(--t2); }
.vbtn:hover { color: var(--t1); }
.vbtn.on { background: var(--hover); color: var(--t1); box-shadow: inset 0 0 0 1px var(--line-2); }

.queue-wrap { flex: none; padding: 0 24px 12px; }
.mp-body { display: flex; flex: 1; flex-direction: column; gap: 4px; min-height: 0; padding: 0 24px 24px; overflow-y: auto; transition: opacity .15s; }
.mp-body.busy { opacity: .6; }
.list-wrap { display: flex; flex-direction: column; min-height: 0; }
.nm { display: inline-flex; align-items: center; gap: 10px; max-width: 100%; }
.nm-ico { display: grid; flex: none; place-items: center; width: 44px; height: 33px; border-radius: 6px; background: #1a1a1a; color: var(--t3); }
.nm-ico.dir { color: var(--t2); }
.nm .title-link { min-width: 0; max-width: 420px; }
.list-wrap :deep(tr.is-dir) { cursor: pointer; }

.drop-hint { position: fixed; inset: 0; z-index: 900; display: grid; place-items: center; padding: 24px; background: rgba(0, 0, 0, .55); pointer-events: none; }
.drop-box { display: flex; flex-direction: column; align-items: center; gap: 10px; width: min(520px, 100%); padding: 40px 24px; border: 2px dashed rgba(255, 255, 255, .6); border-radius: 14px; background: rgba(18, 18, 18, .92); color: var(--t1); text-align: center; }
.drop-box b { font-size: 15px; }
.drop-box span { color: var(--t2); font-size: 12.5px; }
.fade-enter-active, .fade-leave-active { transition: opacity .12s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.state-card { flex: none; }
</style>
