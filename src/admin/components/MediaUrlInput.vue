<script setup>
import { ref, computed } from 'vue'
import ABtn from './ABtn.vue'
import Thumb from './Thumb.vue'
import TextInput from './TextInput.vue'
import MediaPicker from './MediaPicker.vue'
import { resolveUrl } from '../api'
import { useUploader } from '../composables/useUploader'
import { toast, toastError } from './toast'

/*
 * 图片 / 视频地址输入：
 *   <MediaUrlInput v-model="form.coverUrl" kind="image" />
 *   <MediaUrlInput v-model="form.playbackUrl" kind="video" @uploaded="onVideoUploaded" />
 * 可以直接填地址（http(s):// 或 /media/…），也可以「上传」本地文件（带进度）或从「素材库」挑一个。
 * 清空时值为 null。上传的文件放在 uploadDir（默认图片 covers/、视频 videos/），重名自动改名不覆盖。
 * 上传可以「取消」；组件卸载（关抽屉 / 对话框）时没传完的会自动取消，不会在后台继续传、留下没人用的文件。
 */
const props = defineProps({
  modelValue: { type: String, default: null },
  kind: { type: String, default: 'image', validator: v => ['image', 'video'].includes(v) },
  uploadDir: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'uploaded'])

const dir = computed(() => props.uploadDir || (props.kind === 'video' ? 'videos' : 'covers'))
const fileEl = ref(null)
const pickerOpen = ref(false)
const preview = ref(false)
const up = useUploader()

const ph = computed(() => props.placeholder || (props.kind === 'video' ? 'https://… 或 /media/videos/xxx.mp4' : 'https://… 或 /media/covers/xxx.jpg'))
const accept = computed(() => (props.kind === 'video' ? 'video/*,.m3u8,.mkv,.mov,.ts' : 'image/*'))

const set = v => {
  const s = String(v ?? '').trim()
  emit('update:modelValue', s || null)
}

async function onFile(ev) {
  const file = ev.target.files?.[0]
  ev.target.value = ''
  if (!file) return
  try {
    // 同一个框再选一个文件：上一个没传完的先取消（key 相同）
    const res = await up.upload(`${dir.value}/${file.name}`, file, { key: 'file' })
    set(res.url)
    toast('已上传：' + res.path, { type: 'ok' })
    emit('uploaded', { ...res, file })
  } catch (e) {
    if (up.isCancel(e)) { if (!up.disposed) toast('已取消上传') }
    else toastError(e, '上传失败')
  }
}
</script>

<template>
  <div class="mu">
    <div class="line">
      <Thumb v-if="kind === 'image'" :src="modelValue || ''" :width="56" :ratio="16 / 10" class="pv" />
      <TextInput
        class="grow"
        mono
        :model-value="modelValue || ''"
        :placeholder="ph"
        :disabled="disabled"
        @update:model-value="set"
      />
      <ABtn icon="upload" :disabled="disabled" :loading="up.busy" title="上传本地文件" @click="fileEl?.click()">上传</ABtn>
      <ABtn icon="folder" :disabled="disabled" title="从素材库选择" @click="pickerOpen = true">素材库</ABtn>
      <ABtn v-if="kind === 'video'" :icon="preview ? 'eye-off' : 'play'" :disabled="!modelValue" @click="preview = !preview">预览</ABtn>
      <input ref="fileEl" type="file" class="sr-only" :accept="accept" tabindex="-1" @change="onFile">
    </div>
    <div v-if="up.busy" class="up">
      <div class="progress grow"><i :style="{ width: (up.percent || 0) + '%' }" /></div>
      <span class="num">{{ up.percent || 0 }}%</span>
      <button type="button" class="link small" @click="up.cancel()">取消</button>
    </div>
    <video
      v-if="kind === 'video' && preview && modelValue"
      :key="modelValue"
      class="vid"
      :src="resolveUrl(modelValue)"
      controls
      preload="metadata"
      playsinline
    />
    <MediaPicker v-model:open="pickerOpen" :accept="kind" :start-dir="dir" @select="f => set(f.url)" />
  </div>
</template>

<style scoped>
.mu { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pv { flex: none; }
.up { display: flex; align-items: center; gap: 10px; color: var(--t2); font-size: 12px; }
.vid { width: 100%; max-height: 260px; border-radius: 6px; background: #000; }
@media (max-width: 640px) {
  .line { flex-wrap: wrap; }
}
</style>
