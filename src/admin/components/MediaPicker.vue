<script>
/* 记住每种用途上次所在的文件夹（所有 MediaPicker 实例共享） */
const lastDir = { image: null, video: null, any: null }
</script>

<script setup>
import { ref, computed, watch } from 'vue'
import AModal from './AModal.vue'
import ABtn from './ABtn.vue'
import AIcon from './AIcon.vue'
import Thumb from './Thumb.vue'
import { listMedia } from '../api'
import { useUploader } from '../composables/useUploader'
import { toast, toastError } from './toast'
import { fmtSize } from '../utils/format'

/*
 * 素材库选择器：浏览服务器 media/ 目录，点文件即选中。
 *   <MediaPicker v-model:open="show" accept="image" start-dir="covers" @select="f => form.coverUrl = f.url" />
 * accept：image | video | any（不匹配的文件置灰不可选）。可以直接上传到当前文件夹，上传完自动选中。
 * 连续点文件夹时只认最后一次（之前的请求取消）；上传中关掉对话框 = 取消上传。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  accept: { type: String, default: 'any', validator: v => ['image', 'video', 'any'].includes(v) },
  /** 第一次打开时进入的文件夹（如 covers）；之后记住上次所在的文件夹 */
  startDir: { type: String, default: '' }
})
const emit = defineEmits(['update:open', 'select'])

const dir = ref('')
const entries = ref([])
const loading = ref(false)
const error = ref('')
const uploadName = ref('')
const fileEl = ref(null)
const up = useUploader()
let ctrl = null
let seq = 0

const crumbs = computed(() => {
  const parts = dir.value ? dir.value.split('/') : []
  return [{ name: 'media', path: '' }, ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join('/') }))]
})
const acceptAttr = computed(() => (props.accept === 'image' ? 'image/*' : props.accept === 'video' ? 'video/*,.m3u8,.mkv,.mov,.ts' : ''))
const usable = e => e.type === 'dir' || props.accept === 'any' || e.type === props.accept

async function load(d = dir.value, { fallback = true } = {}) {
  // 新的请求取消上一个；万一旧请求还是先回来了，也按序号丢掉（只认最后一次点击）
  ctrl?.abort()
  ctrl = new AbortController()
  const my = ++seq
  loading.value = true
  error.value = ''
  try {
    const res = await listMedia(d, { signal: ctrl.signal })
    if (my !== seq) return
    dir.value = res?.dir ?? d
    entries.value = res?.entries || []
    lastDir[props.accept] = dir.value
  } catch (e) {
    if (my !== seq || e?.name === 'AbortError') return
    // 上次的文件夹被删了：退回根目录
    if (fallback && d) return load('', { fallback: false })
    error.value = e.message || '加载失败'
  } finally {
    if (my === seq) loading.value = false
  }
}

watch(() => props.open, v => {
  if (!v) {
    // 关掉对话框：没完成的列表请求和上传都取消（上传完再「选中」已经没有意义）
    ctrl?.abort()
    ctrl = null
    seq++
    loading.value = false
    up.cancel()
    return
  }
  const start = lastDir[props.accept] ?? props.startDir ?? ''
  load(start)
}, { immediate: true })

function enter(e) {
  if (e.type === 'dir') return load(e.path)
  if (!usable(e)) return
  emit('select', { path: e.path, url: e.url, entry: e })
  emit('update:open', false)
}

async function onFiles(ev) {
  const file = ev.target.files?.[0]
  ev.target.value = ''
  if (!file) return
  uploadName.value = file.name
  try {
    const target = (dir.value ? dir.value + '/' : '') + file.name
    const res = await up.upload(target, file, { key: 'file' })
    if (!props.open) return
    toast('已上传：' + res.path, { type: 'ok' })
    emit('select', { path: res.path, url: res.url, entry: null })
    emit('update:open', false)
  } catch (e) {
    if (up.isCancel(e)) { if (!up.disposed) toast('已取消上传') }
    else { toastError(e, '上传失败'); load() }
  }
}

const iconOf = e => (e.type === 'dir' ? 'folder' : e.type === 'video' ? 'video' : e.type === 'image' ? 'image' : 'file')
const acceptLabel = computed(() => ({ image: '图片', video: '视频', any: '文件' })[props.accept])
</script>

<template>
  <AModal :open="open" :title="`从素材库选择${acceptLabel}`" :width="760" flush @update:open="v => emit('update:open', v)">
    <div class="mp">
      <div class="bar">
        <nav class="crumbs" aria-label="当前文件夹">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <AIcon v-if="i" name="chevron-right" :size="12" class="sep" />
            <button type="button" class="crumb" :class="{ cur: i === crumbs.length - 1 }" @click="load(c.path)">{{ c.name }}</button>
          </template>
        </nav>
        <ABtn size="sm" variant="ghost" icon="refresh" aria-label="刷新" title="刷新" @click="load()" />
        <ABtn size="sm" icon="upload" :loading="up.busy" @click="fileEl?.click()">上传到此文件夹</ABtn>
        <input ref="fileEl" type="file" class="sr-only" :accept="acceptAttr" tabindex="-1" @change="onFiles">
      </div>

      <div v-if="up.busy" class="up">
        <span class="ellipsis">正在上传 {{ uploadName }}</span>
        <div class="progress grow"><i :style="{ width: (up.percent || 0) + '%' }" /></div>
        <span class="num">{{ up.percent || 0 }}%</span>
        <button type="button" class="link small" @click="up.cancel()">取消</button>
      </div>

      <div class="body">
        <div v-if="loading && !entries.length" class="state"><span class="spinner lg" /></div>
        <div v-else-if="error" class="state">
          <AIcon name="warning" :size="22" />
          <p>{{ error }}</p>
          <ABtn size="sm" icon="refresh" @click="load()">重试</ABtn>
        </div>
        <div v-else-if="!entries.length" class="state">
          <AIcon name="folder" :size="22" />
          <p>这个文件夹是空的，可以点右上角上传</p>
        </div>
        <ul v-else class="grid" :class="{ busy: loading }">
          <li v-for="e in entries" :key="e.path">
            <button
              type="button"
              class="item"
              :class="{ off: !usable(e) }"
              :disabled="!usable(e)"
              :title="e.name"
              @click="enter(e)"
            >
              <Thumb v-if="e.type === 'image'" :src="e.url" :ratio="4 / 3" width="100%" />
              <span v-else class="ph" :class="e.type"><AIcon :name="iconOf(e)" :size="26" :stroke="1.3" /></span>
              <span class="name ellipsis">{{ e.name }}</span>
              <span class="meta">{{ e.type === 'dir' ? '文件夹' : fmtSize(e.size) }}<template v-if="e.usedBy"> · 已用 {{ e.usedBy }}</template></span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </AModal>
</template>

<style scoped>
.mp { display: flex; flex-direction: column; height: min(560px, calc(100vh - 160px)); }
.bar { display: flex; flex: none; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.crumbs { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 2px; min-width: 0; }
.crumb { height: 26px; padding: 0 6px; border-radius: 5px; color: var(--t2); }
.crumb:hover { background: var(--hover); color: var(--t1); }
.crumb.cur { color: var(--t1); font-weight: 600; }
.sep { color: var(--t3); }
.up { display: flex; flex: none; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--line); color: var(--t2); font-size: 12px; }
.up .ellipsis { max-width: 260px; }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 10px; transition: opacity .15s; }
.grid.busy { opacity: .5; }
.item { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 6px; border-radius: 8px; text-align: left; }
.item:hover:not(:disabled) { background: var(--hover); }
.item.off { opacity: .35; }
.ph { display: grid; place-items: center; width: 100%; aspect-ratio: 4 / 3; border-radius: 6px; background: #1a1a1a; color: var(--t3); }
.ph.dir { color: var(--t2); background: #171717; box-shadow: inset 0 0 0 1px var(--line); }
.ph.video { color: var(--t2); }
.name { display: block; color: var(--t1); font-size: 12.5px; }
.meta { color: var(--t3); font-size: 11.5px; }
</style>
