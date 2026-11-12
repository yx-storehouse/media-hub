<script setup>
import { ref, reactive, computed, watch, provide, markRaw, onBeforeUnmount } from 'vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import TextArea from '../../components/TextArea.vue'
import MediaPicker from '../../components/MediaPicker.vue'
import { FIELD_KEY } from '../../components/formField'
import { toast } from '../../components/toast'
import { useUploader } from '../../composables/useUploader'
import { useDragSort } from '../../composables/useReorder'
import { resolveUrl, mediaVersions } from '../../api'
import { imageSize, rememberImageSize } from '../../utils/image'
import { urlProblem, urlKey, uploadName, UPLOAD_ACCEPT } from './rules'

/*
 * 图集的图片列表（AlbumsPage 抽屉里）：
 *   <AlbumImages ref="imagesRef" v-model="form.images" :max="100" upload-dir="images/albums" :disabled="editor.saving" />
 * v-model 是按顺序的 [{ url, width, height }]，第一张是封面；只包含已经有地址的图（上传中 / 失败的不在里面）。
 *
 * 添加：选多个文件或拖进来（传到 media/<uploadDir>/，同时传 3 个，带进度、可取消）、
 *       从素材库选、粘贴地址（每行一个，或用 | 隔开）。
 *       服务端不收的东西先在这里挡下 / 改好（规则在 ./rules.js）：不支持的格式和空文件直接跳过，文件名改成服务端收的写法，
 *       粘贴的地址按服务端的规则检查。上传失败时格子上写服务端给的原因；网络断了 / 服务端出错可以「重试」，
 *       其他（比如文件太大）重试也没用，按钮换成「移除」。
 * 调整：拖动缩略图排序；每张图上有「设为封面」（移到第一张）、前移 / 后移、移除。
 * 宽高：新加的图在浏览器里读 naturalWidth / naturalHeight（上传的图直接读本地文件）；保存前页面调 settle() 等它们读完。
 *       已保存、尺寸未知（0）的图不自动读（打开就变成「有修改」），下面给一个「读取尺寸」的按钮。
 * ref 上：settle({ timeout }) → { uploading, failed, retryable, unknown }；readSizes()；uploading / failed（上传中 / 失败的张数）。
 */
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  max: { type: Number, default: 100 },
  uploadDir: { type: String, default: 'images/albums' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

/* 粘贴框各自生成 id，不继承外层 FormField 的 */
provide(FIELD_KEY, null)

let seq = 0
/** state: ok（有地址）| up（上传中 / 排队）| fail（上传失败） */
const mk = (img, extra = {}) => reactive({
  k: ++seq,
  url: img?.url || '',
  width: img?.width > 0 && img?.height > 0 ? img.width : 0,
  height: img?.width > 0 && img?.height > 0 ? img.height : 0,
  state: 'ok',
  progress: 0,
  error: '',
  retryable: true,
  file: null,
  name: '',
  preview: '',
  probing: false,
  broken: false,
  ...extra
})

const items = ref((props.modelValue || []).map(img => mk(img)))
const clean = () => items.value.filter(it => it.state === 'ok' && it.url).map(it => ({ url: it.url, width: it.width, height: it.height }))
const sync = () => emit('update:modelValue', clean())

/* 外部整体换了值（打开了另一条记录）：重建，没传完的上传取消 */
watch(() => props.modelValue, v => {
  if (JSON.stringify(v || []) === JSON.stringify(clean())) return
  up.cancel()
  dropPreviews(items.value)
  items.value = (v || []).map(img => mk(img))
})

const count = computed(() => items.value.length)
const full = computed(() => items.value.length >= props.max)
const uploading = computed(() => items.value.filter(it => it.state === 'up').length)
const failed = computed(() => items.value.filter(it => it.state === 'fail').length)
const retryable = computed(() => items.value.filter(it => it.state === 'fail' && it.retryable).length)
const unknown = computed(() => items.value.filter(it => it.state === 'ok' && !(it.width && it.height) && !it.probing).length)
const probingAny = computed(() => items.value.some(it => it.probing))

const srcOf = it => {
  if (it.preview) return it.preview
  const u = resolveUrl(it.url)
  const v = mediaVersions[it.url]
  return v ? u + (u.includes('?') ? '&' : '?') + 'v=' + v : u
}
const sizeText = it => (it.width && it.height ? `${it.width}×${it.height}` : it.probing ? '读取尺寸中…' : '尺寸未知')

function dropPreviews(list) {
  for (const it of list) if (it.preview) { URL.revokeObjectURL(it.preview); it.preview = '' }
}

/* ---------------- 读尺寸：同时最多 4 个 ---------------- */

const ctrl = new AbortController()
const probeQ = []
let probeActive = 0
function probe(it) {
  if (it.width && it.height) return
  it.probing = true
  probeQ.push(it)
  pumpProbe()
}
function pumpProbe() {
  while (probeActive < 4 && probeQ.length) {
    const it = probeQ.shift()
    if (!items.value.includes(it) || ctrl.signal.aborted) { it.probing = false; continue }
    probeActive++
    imageSize(it.url, { signal: ctrl.signal }).then(size => {
      it.probing = false
      if (!items.value.includes(it)) return
      if (!size) { it.broken = true; return }
      it.broken = false
      if (it.width && it.height) return
      it.width = size.width
      it.height = size.height
      if (it.state === 'ok') sync()
    }).finally(() => { probeActive--; pumpProbe() })
  }
}
/** 给尺寸未知的图都读一次（会产生修改，需要保存） */
function readSizes() {
  const list = items.value.filter(it => it.state === 'ok' && !(it.width && it.height) && !it.probing)
  for (const it of list) { it.broken = false; probe(it) }
  return list.length
}

/* ---------------- 添加：地址 ---------------- */

/* 和服务端一样按 urlKey 判断同一张（/media/a b.jpg 和 /media/a%20b.jpg 是同一张，服务端保存时会合并） */
const has = url => {
  const k = urlKey(url)
  return items.value.some(it => it.url && urlKey(it.url) === k)
}

/** 加一批地址（已经在列表里的跳过），返回加了几张 */
function addUrls(urls) {
  let added = 0
  let dup = 0
  let over = 0
  for (const u of urls) {
    if (has(u)) { dup++; continue }
    if (items.value.length >= props.max) { over++; continue }
    const it = mk({ url: u })
    items.value.push(it)
    probe(it)
    added++
  }
  if (added) sync()
  const notes = [dup && `${dup} 张已经在列表里`, over && `超过 ${props.max} 张的 ${over} 张没有添加`].filter(Boolean)
  if (notes.length) toast(notes.join('，'))
  return added
}

const pasteOpen = ref(false)
const pasteText = ref('')
const pasteError = ref('')
function openPaste() { pasteOpen.value = true; pasteError.value = '' }
function applyPaste() {
  const parts = pasteText.value.split(/[|｜\r\n]+/).map(s => s.trim()).filter(Boolean)
  if (!parts.length) { pasteError.value = '请先粘贴图片地址'; return }
  // 和服务端同样的规则检查，不合格的不加进列表（不然要到保存时才报错，也看不出是哪张）
  const good = []
  const bad = []
  const why = new Map() // 原因 → 行数
  for (const s of parts) {
    const p = urlProblem(s)
    if (!p) { good.push(s); continue }
    bad.push(s)
    why.set(p, (why.get(p) || 0) + 1)
  }
  const n = addUrls(good)
  if (bad.length) {
    // 不合格的留在框里，改了再加
    pasteText.value = bad.join('\n')
    pasteError.value = [...why].map(([p, k]) => `${k} 行${p}`).join('；') + '，已留在框里'
  } else {
    pasteText.value = ''
    pasteError.value = ''
    pasteOpen.value = false
  }
  if (n) toast(`已添加 ${n} 张`, { type: 'ok' })
}

const pickerOpen = ref(false)
const onPicked = f => { if (f?.url && addUrls([f.url])) toast('已添加：' + f.path, { type: 'ok' }) }

/* ---------------- 添加：上传（同时传 3 个） ---------------- */

const up = useUploader()
const fileEl = ref(null)

function addFiles(files) {
  // 服务端不收的格式（bmp / heic / svg …）、空文件：上传了也只会失败，直接跳过。
  // 文件名改成服务端收的写法（见 rules.js）；剪贴板里的图片名字都一样，重名由服务端自动改名
  const named = files.map(f => ({ f, name: uploadName(f) }))
  const imgs = named.filter(x => x.name && x.f.size > 0)
  const notImage = named.filter(x => !x.name).length
  const empty = named.filter(x => x.name && !(x.f.size > 0)).length
  const space = Math.max(0, props.max - items.value.length)
  const take = imgs.slice(0, space)
  const notes = [
    notImage && `${notImage} 个不是支持的图片格式（jpg / png / webp / gif / avif），已跳过`,
    empty && `${empty} 个是空文件，已跳过`,
    imgs.length > take.length && `最多 ${props.max} 张，多出的 ${imgs.length - take.length} 个没有上传`
  ].filter(Boolean)
  if (notes.length) toast(notes.join('；'), { type: take.length ? 'info' : 'error' })
  for (const { f, name } of take) {
    const it = mk(null, { state: 'up', file: markRaw(f), name, preview: URL.createObjectURL(f) })
    items.value.push(it)
    // 本地文件直接读尺寸，不用等上传完
    it.probing = true
    imageSize(f, { signal: ctrl.signal }).then(size => {
      it.probing = false
      if (!size || !items.value.includes(it)) return
      it.width = size.width
      it.height = size.height
      if (it.url) rememberImageSize(it.url, size)
      if (it.state === 'ok') sync()
    })
    queueUpload(it)
  }
}

const upQ = []
let upActive = 0
function queueUpload(it) {
  it.state = 'up'
  it.progress = 0
  it.error = ''
  upQ.push(it)
  pumpUpload()
}
function pumpUpload() {
  while (upActive < 3 && upQ.length) {
    const it = upQ.shift()
    if (!items.value.includes(it) || it.state !== 'up' || up.disposed) continue
    upActive++
    up.upload(`${props.uploadDir}/${it.name}`, it.file, { key: it.k, onProgress: p => { it.progress = p.percent } })
      .then(res => {
        if (!items.value.includes(it)) return
        it.url = res.url
        it.state = 'ok'
        if (it.width && it.height) rememberImageSize(res.url, it)
        sync()
      })
      .catch(e => {
        // 取消 = 用户移除了这张（或关掉了抽屉），什么都不用做
        if (up.isCancel(e) || !items.value.includes(it)) return
        it.state = 'fail'
        it.error = e?.message || '上传失败'
        it.retryable = canRetry(e)
      })
      .finally(() => { upActive--; pumpUpload() })
  }
}
/* 断网、超时、服务端出错（5xx / 408 / 429）重试可能会好；其他 4xx（文件太大等）原样再传一次还是一样 */
const canRetry = e => !(e?.status >= 400 && e.status < 500) || e.status === 408 || e.status === 429
const retry = it => { if (!props.disabled && it.retryable) queueUpload(it) }

function onPick(ev) {
  const files = [...(ev.target.files || [])]
  ev.target.value = ''
  if (files.length) addFiles(files)
}

/* 从系统拖进来的文件：整个区域都是放置区 */
const fileOver = ref(false)
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
function onZoneOver(e) {
  if (!hasFiles(e) || props.disabled) return
  e.preventDefault()
  e.dataTransfer.dropEffect = full.value ? 'none' : 'copy'
  fileOver.value = true
}
function onZoneLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) fileOver.value = false
  drag.leave(e)
}
function onZoneDrop(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  fileOver.value = false
  if (props.disabled) return
  const files = [...(e.dataTransfer.files || [])]
  if (!files.length) { toast('没有读到文件（文件夹请到「素材文件」里上传）', { type: 'error' }); return }
  addFiles(files)
}

/* ---------------- 调整顺序 / 移除 ---------------- */

function move(from, to) {
  const arr = items.value
  if (props.disabled || from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return
  const [it] = arr.splice(from, 1)
  arr.splice(to, 0, it)
  sync()
}
const drag = useDragSort({ axis: 'x', onMove: move })
const setCover = i => move(i, 0)

function remove(i) {
  if (props.disabled) return
  const [it] = items.value.splice(i, 1)
  if (!it) return
  if (it.state === 'up') up.cancel(it.k)
  dropPreviews([it])
  if (it.state === 'ok') sync()
}

/* 缩略图自己加载失败也算「加载失败」（比如内网访问不到的外链） */
const onImgError = it => { if (!it.preview) it.broken = true }
const onImgLoad = (it, e) => {
  it.broken = false
  // 新加的图还在读尺寸：缩略图先加载完就直接用它的
  const img = e.target
  if (it.probing && !it.preview && img.naturalWidth && img.naturalHeight && !(it.width && it.height)) {
    it.width = img.naturalWidth
    it.height = img.naturalHeight
    it.probing = false
    rememberImageSize(it.url, it)
    if (it.state === 'ok') sync()
  }
}

/* ---------------- 给页面用：保存前等尺寸读完 ---------------- */

/** 等正在读的尺寸读完（最多 timeout 毫秒），返回还在上传 / 上传失败 / 尺寸未知的张数 */
function settle({ timeout = 8000 } = {}) {
  const summary = () => ({ uploading: uploading.value, failed: failed.value, retryable: retryable.value, unknown: unknown.value })
  if (!probingAny.value) return Promise.resolve(summary())
  return new Promise(resolve => {
    let timer = 0
    const stop = watch(probingAny, busy => {
      if (busy) return
      stop()
      clearTimeout(timer)
      resolve(summary())
    })
    timer = setTimeout(() => { stop(); resolve(summary()) }, timeout)
  })
}
defineExpose({ settle, readSizes, uploading, failed })

onBeforeUnmount(() => {
  ctrl.abort()
  dropPreviews(items.value)
})
</script>

<template>
  <div
    class="ai"
    :class="{ over: fileOver, disabled }"
    @dragover="onZoneOver"
    @dragleave="onZoneLeave"
    @drop="onZoneDrop"
  >
    <!-- 还没有图：整块是放置区 -->
    <button v-if="!count" type="button" class="drop" :disabled="disabled" @click="fileEl?.click()">
      <AIcon name="upload" :size="24" :stroke="1.4" />
      <b>把图片拖到这里，或点击选择文件</b>
      <span>可以一次选多张；第一张是封面。支持 jpg / png / webp / gif / avif</span>
    </button>

    <ol v-else class="grid" aria-label="图片（第一张是封面）">
      <li
        v-for="(it, i) in items"
        :key="it.k"
        class="tile"
        :class="['is-' + it.state, { broken: it.broken && it.state === 'ok', cover: i === 0 }, drag.itemClass(i)]"
        :data-drag-index="i"
        :draggable="!disabled"
        :title="it.state === 'ok' ? `${it.url}\n${sizeText(it)}` : it.state === 'fail' ? `${it.name}\n上传失败：${it.error}` : it.name"
        @dragstart="drag.start(i, $event)"
        @dragend="drag.end"
        @dragover="drag.over($event, i)"
        @drop="drag.drop"
      >
        <img
          v-if="srcOf(it)"
          class="img"
          :src="srcOf(it)"
          alt=""
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          draggable="false"
          @load="onImgLoad(it, $event)"
          @error="onImgError(it)"
        >
        <span v-if="it.broken && it.state === 'ok'" class="ph">
          <AIcon name="image" :size="20" :stroke="1.4" />
          <span>加载失败</span>
        </span>

        <span class="no num">{{ i === 0 ? '封面' : i + 1 }}</span>

        <!-- 上传中 / 失败：常驻在底部；传好的图：悬停 / 键盘聚焦时底部出现尺寸和前移 / 后移 -->
        <div v-if="it.state === 'up'" class="up">
          <div class="progress"><i :style="{ width: it.progress + '%' }" /></div>
          <span class="num">{{ it.progress }}%</span>
        </div>
        <!-- 失败：直接写服务端给的原因；重试没用的（4xx）按钮换成「移除」 -->
        <div v-else-if="it.state === 'fail'" class="fail">
          <span class="fail-t">{{ it.error || '上传失败' }}</span>
          <button v-if="it.retryable" type="button" class="fail-b" :disabled="disabled" :aria-label="`重新上传第 ${i + 1} 张`" @click="retry(it)">重试</button>
          <button v-else type="button" class="fail-b" :disabled="disabled" :aria-label="`移除第 ${i + 1} 张`" @click="remove(i)">移除</button>
        </div>
        <div v-else class="foot">
          <span class="size num" :class="{ unknown: !(it.width && it.height) }">{{ sizeText(it) }}</span>
          <button type="button" class="tb" :disabled="disabled || i === 0" title="前移" :aria-label="`第 ${i + 1} 张前移`" @click="move(i, i - 1)"><AIcon name="chevron-left" :size="14" /></button>
          <button type="button" class="tb" :disabled="disabled || i === count - 1" title="后移" :aria-label="`第 ${i + 1} 张后移`" @click="move(i, i + 1)"><AIcon name="chevron-right" :size="14" /></button>
        </div>

        <div class="tools">
          <button
            v-if="i > 0 && it.state === 'ok'"
            type="button"
            class="tb"
            :disabled="disabled"
            title="设为封面（移到第一张）"
            :aria-label="`把第 ${i + 1} 张设为封面`"
            @click="setCover(i)"
          ><AIcon name="star" :size="13" /></button>
          <button
            type="button"
            class="tb x"
            :disabled="disabled"
            :title="it.state === 'up' ? '取消上传' : '移除'"
            :aria-label="it.state === 'up' ? `取消上传第 ${i + 1} 张` : `移除第 ${i + 1} 张`"
            @click="remove(i)"
          ><AIcon name="x" :size="13" /></button>
        </div>
      </li>
      <li v-if="!full && !disabled" class="add">
        <button type="button" class="add-b" @click="fileEl?.click()">
          <AIcon name="plus" :size="18" />
          <span>上传图片</span>
        </button>
      </li>
    </ol>

    <div class="bar">
      <ABtn size="sm" icon="folder" :disabled="disabled || full" @click="pickerOpen = true">从素材库选择</ABtn>
      <ABtn size="sm" icon="link" :disabled="disabled || full" :aria-expanded="pasteOpen ? 'true' : 'false'" @click="pasteOpen ? (pasteOpen = false) : openPaste()">粘贴地址</ABtn>
      <span class="grow" />
      <span class="sum small">
        <template v-if="count">共 {{ count }} 张<template v-if="uploading"> · {{ uploading }} 张上传中</template><template v-if="failed"> · <span class="danger-text">{{ failed }} 张失败</span></template></template>
        <template v-else>最多 {{ max }} 张</template>
      </span>
    </div>

    <p v-if="unknown" class="note small">
      {{ unknown }} 张图片没有尺寸信息，前台会按默认比例显示。
      <button type="button" class="link" :disabled="disabled" @click="readSizes">读取尺寸</button>
    </p>

    <div v-if="pasteOpen" class="paste">
      <TextArea
        v-model="pasteText"
        :rows="3"
        :max-rows="8"
        aria-label="图片地址，每行一个"
        placeholder="每行一个地址（也可以用 | 隔开），例如&#10;https://example.com/a.jpg&#10;/media/images/albums/b.jpg"
      />
      <p v-if="pasteError" class="paste-err small" role="alert">{{ pasteError }}</p>
      <div class="paste-ops">
        <ABtn size="sm" variant="primary" :disabled="disabled" @click="applyPaste">添加</ABtn>
        <ABtn size="sm" variant="ghost" @click="pasteOpen = false">收起</ABtn>
      </div>
    </div>

    <input ref="fileEl" type="file" class="sr-only" :accept="UPLOAD_ACCEPT" multiple tabindex="-1" aria-label="选择图片文件" @change="onPick">
    <MediaPicker v-model:open="pickerOpen" accept="image" :start-dir="uploadDir" @select="onPicked" />
  </div>
</template>

<style scoped>
.ai { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); transition: border-color .12s, background .12s; }
.ai.over { border-color: var(--t2); border-style: dashed; background: #1c1c1c; }

.drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-height: 148px; padding: 20px; border: 1px dashed var(--line-2); border-radius: 7px; color: var(--t2); text-align: center; }
.drop b { color: var(--t1); font-weight: 600; }
.drop span { color: var(--t3); font-size: 12px; }
.drop:hover:not(:disabled) { border-color: #555; background: #1c1c1c; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; }
.tile { position: relative; aspect-ratio: 1; overflow: hidden; border-radius: 7px; background: #1f1f1f; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05); cursor: grab; }
.ai.disabled .tile { cursor: default; }
.tile.cover { box-shadow: 0 0 0 2px var(--accent); }
.tile.broken { box-shadow: inset 0 0 0 1px rgba(255, 107, 107, .5); }
.tile.cover.broken { box-shadow: 0 0 0 2px var(--accent), inset 0 0 0 1px rgba(255, 107, 107, .5); }
.tile.is-fail { box-shadow: inset 0 0 0 1px rgba(255, 107, 107, .6); }
.tile.dragging { opacity: .35; }
/* 落点：在这张前面 / 后面插一条竖线 */
.tile.drop-before::before, .tile.drop-after::after { content: ''; position: absolute; top: 0; bottom: 0; z-index: 3; width: 3px; border-radius: 2px; background: var(--accent); }
.tile.drop-before::before { left: 0; }
.tile.drop-after::after { right: 0; }

.img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.tile.broken .img { display: none; }
.tile.is-up .img, .tile.is-fail .img { opacity: .45; }
.ph { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #6a6a6a; font-size: 11.5px; }
.ph span { color: var(--danger); }

.no { position: absolute; top: 5px; left: 5px; z-index: 1; min-width: 20px; height: 18px; padding: 0 5px; border-radius: 9px; background: rgba(0, 0, 0, .66); color: var(--t1); font-size: 11px; line-height: 18px; text-align: center; }
.tile.cover .no { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.foot { position: absolute; right: 0; bottom: 0; left: 0; z-index: 2; display: flex; align-items: center; gap: 2px; padding: 14px 4px 4px 6px; background: linear-gradient(transparent, rgba(0, 0, 0, .75)); opacity: 0; transition: opacity .12s; }
.size { flex: 1; min-width: 0; overflow: hidden; color: #d6d6d6; font-size: 10.5px; white-space: nowrap; text-overflow: ellipsis; }
.size.unknown { color: var(--warn); }

.tools { position: absolute; top: 4px; right: 4px; z-index: 2; display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
.tile:hover .tools, .tile:focus-within .tools, .tile:hover .foot, .tile:focus-within .foot { opacity: 1; }
/* 拖动中不显示按钮（拖动的影子和落点都更干净） */
.tile.dragging .tools, .tile.dragging .foot { opacity: 0; }
.tb { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 5px; background: rgba(0, 0, 0, .72); color: var(--t1); }
.tb:hover:not(:disabled) { background: #000; }
.tb.x:hover:not(:disabled) { color: var(--danger); }
.tb:disabled { opacity: .35; }

.up { position: absolute; right: 8px; bottom: 8px; left: 8px; z-index: 1; display: flex; align-items: center; gap: 6px; color: var(--t1); font-size: 11px; }
.up .progress { flex: 1; }
/* 原因最多三行（完整的在格子的悬停提示里），按钮靠右在最下面；底下压暗一点让红字看得清 */
.fail { position: absolute; right: 0; bottom: 0; left: 0; z-index: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 16px 6px 6px; background: linear-gradient(transparent, rgba(0, 0, 0, .82) 40%); }
.fail-t { display: -webkit-box; max-width: 100%; overflow: hidden; color: var(--danger); font-size: 11px; line-height: 1.35; word-break: break-all; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.fail-b { flex: none; align-self: flex-end; height: 22px; padding: 0 8px; border-radius: 5px; background: rgba(0, 0, 0, .72); color: var(--t1); font-size: 11.5px; }
.fail-b:hover:not(:disabled) { background: #000; }

.add { aspect-ratio: 1; }
.add-b { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; width: 100%; height: 100%; border: 1px dashed var(--line-2); border-radius: 7px; color: var(--t2); font-size: 12px; }
.add-b:hover { border-color: #555; color: var(--t1); }

.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sum { color: var(--t3); }
.note { color: var(--t3); }
.note .link { margin-left: 4px; color: var(--t2); }
.paste { display: flex; flex-direction: column; gap: 6px; }
.paste-err { color: var(--danger); }
.paste-ops { display: flex; gap: 6px; }
</style>
