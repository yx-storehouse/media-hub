<script setup>
import { ref, watch, provide } from 'vue'
import ABtn from './ABtn.vue'
import AIcon from './AIcon.vue'
import Thumb from './Thumb.vue'
import MediaPicker from './MediaPicker.vue'
import { useUploader } from '../composables/useUploader'
import { toast, toastError } from './toast'
import { FIELD_KEY } from './formField'

/*
 * 多个图片地址（帖子配图、专题头图）：每行一个地址，带缩略图、上移 / 下移、删除、上传、素材库。
 *   <UrlListInput v-model="form.images" :max="9" />
 * v-model 是字符串数组（空行不会写进去）。
 * 上传中的行被移除、或整个组件卸载（关抽屉）时，那一行的上传会被取消。
 */
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  max: { type: Number, default: 9 },
  kind: { type: String, default: 'image' },
  uploadDir: { type: String, default: 'images' },
  addText: { type: String, default: '添加一张' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

/* 行内的输入框各自生成 id，不继承外层 FormField 的（否则会出现重复 id） */
provide(FIELD_KEY, null)

let seq = 0
const mk = url => ({ k: ++seq, url: url || '', progress: null })
const items = ref((props.modelValue || []).map(mk))
const fileEl = ref(null)
const pickerOpen = ref(false)
const up = useUploader()
let target = null // 正在上传 / 选择的那一行

const clean = () => items.value.map(i => i.url.trim()).filter(Boolean)
/* 外部整体替换了值（打开另一条记录）：重建行 */
watch(() => props.modelValue, v => {
  if (JSON.stringify(v || []) !== JSON.stringify(clean())) items.value = (v || []).map(mk)
})
const sync = () => emit('update:modelValue', clean())

function add() {
  if (items.value.length >= props.max) return
  items.value.push(mk(''))
}
function remove(i) {
  const [it] = items.value.splice(i, 1)
  if (it) up.cancel(it.k) // 这一行还在上传：取消
  sync()
}
function move(i, d) {
  const j = i + d
  if (j < 0 || j >= items.value.length) return
  const arr = items.value
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  sync()
}
function onInput(it, v) { it.url = v; sync() }

function upload(it) { target = it; fileEl.value?.click() }
function pick(it) { target = it; pickerOpen.value = true }
function onPicked(f) { if (target) { target.url = f.url; sync() } }

async function onFiles(ev) {
  const files = [...(ev.target.files || [])]
  ev.target.value = ''
  if (!files.length || !target) return
  // 选了多个文件：第一个放到当前行，其余依次新增行（不超过上限）
  const rows = [target]
  for (let n = 1; n < files.length && items.value.length < props.max; n++) {
    items.value.push(mk(''))
    rows.push(items.value[items.value.length - 1]) // 取响应式的那一份，进度条才会刷新
  }
  if (files.length > rows.length) toast(`最多 ${props.max} 张，多出的 ${files.length - rows.length} 个文件没有上传`)
  for (const it of rows) it.progress = 0
  for (let n = 0; n < rows.length; n++) {
    const it = rows[n]
    if (up.disposed) break
    if (!items.value.includes(it)) continue // 等待中的行已被移除
    try {
      const res = await up.upload(`${props.uploadDir}/${files[n].name}`, files[n], { key: it.k, onProgress: p => { it.progress = p.percent } })
      if (items.value.includes(it)) { it.url = res.url; sync() }
    } catch (e) {
      if (!up.isCancel(e)) toastError(e, '上传失败')
    } finally {
      it.progress = null
    }
  }
}
</script>

<template>
  <div class="ul">
    <div v-for="(it, i) in items" :key="it.k" class="row-item">
      <span class="idx num">{{ i + 1 }}</span>
      <Thumb :src="it.url" :width="64" :ratio="16 / 10" />
      <div class="grow col-in">
        <input
          class="a-input mono"
          type="text"
          :value="it.url"
          :placeholder="'图片地址 ' + (i + 1)"
          :aria-label="'图片地址 ' + (i + 1)"
          :disabled="disabled"
          spellcheck="false"
          @input="onInput(it, $event.target.value)"
        >
        <div v-if="it.progress !== null" class="progress"><i :style="{ width: it.progress + '%' }" /></div>
      </div>
      <div class="ops">
        <ABtn size="sm" variant="ghost" icon="upload" title="上传" aria-label="上传" :disabled="disabled || it.progress !== null" @click="upload(it)" />
        <ABtn size="sm" variant="ghost" icon="folder" title="从素材库选择" aria-label="从素材库选择" :disabled="disabled" @click="pick(it)" />
        <ABtn size="sm" variant="ghost" icon="arrow-up" title="上移" aria-label="上移" :disabled="disabled || i === 0" @click="move(i, -1)" />
        <ABtn size="sm" variant="ghost" icon="arrow-down" title="下移" aria-label="下移" :disabled="disabled || i === items.length - 1" @click="move(i, 1)" />
        <ABtn size="sm" variant="ghost" icon="x" title="移除" aria-label="移除" :disabled="disabled" @click="remove(i)" />
      </div>
    </div>
    <button v-if="!disabled" type="button" class="add" :disabled="items.length >= max" @click="add">
      <AIcon name="plus" :size="14" />
      {{ items.length >= max ? `最多 ${max} 张` : addText }}
      <span class="dim">（{{ clean().length }}/{{ max }}）</span>
    </button>
    <input ref="fileEl" type="file" class="sr-only" accept="image/*" multiple tabindex="-1" @change="onFiles">
    <MediaPicker v-model:open="pickerOpen" :accept="kind === 'video' ? 'video' : 'image'" :start-dir="uploadDir" @select="onPicked" />
  </div>
</template>

<style scoped>
.ul { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.row-item { display: flex; align-items: center; gap: 8px; min-width: 0; }
.idx { width: 16px; color: var(--t3); font-size: 12px; text-align: right; }
.col-in { display: flex; flex-direction: column; gap: 4px; }
.ops { display: flex; flex: none; gap: 0; }
.add { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; border: 1px dashed var(--line-2); border-radius: 6px; color: var(--t2); }
.add:hover:not(:disabled) { border-color: #555; color: var(--t1); }
.add:disabled { opacity: .5; }
.mono { font-family: var(--mono); font-size: 12.5px; }
</style>
