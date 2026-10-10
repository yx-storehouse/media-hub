<script setup>
import { ref, computed, watch } from 'vue'
import AIcon from './AIcon.vue'
import { resolveUrl, mediaVersions } from '../api'

/*
 * 缩略图：<Thumb :src="row.coverUrl" :width="96" />；头像用 round + ratio 1。
 * 懒加载；地址为空或加载失败（如内网访问不到外网图床）时显示灰色占位，不会出现破图。
 * 只加载 http(s)://、站内 /… 地址（以及本地预览用的 blob:）；导入进来的 ftp://、file://、C:\… 之类直接显示占位，
 * 不去请求（否则浏览器控制台会报 ERR_UNKNOWN_URL_SCHEME）。
 */
const props = defineProps({
  src: { type: String, default: '' },
  ratio: { type: Number, default: 16 / 10 },
  width: { type: [Number, String], default: '100%' },
  round: { type: Boolean, default: false },
  alt: { type: String, default: '' },
  /** 占位图标 */
  icon: { type: String, default: 'image' },
  fit: { type: String, default: 'cover' }
})

const failed = ref(false)
const loaded = ref(false)

const LOADABLE = /^(https?:)?\/\/|^\/(?!\/)|^blob:/i
const url = computed(() => {
  const src = String(props.src || '').trim()
  if (!src || !LOADABLE.test(src)) return ''
  // 同一地址的文件被覆盖过（重新截取的封面）：加个版本号，不用浏览器内存里的旧图
  const v = mediaVersions[src]
  const u = resolveUrl(src)
  return v ? u + (u.includes('?') ? '&' : '?') + 'v=' + v : u
})
watch(url, () => { failed.value = false; loaded.value = false })
const w = computed(() => (typeof props.width === 'number' ? props.width + 'px' : props.width))
const iconSize = computed(() => {
  const n = typeof props.width === 'number' ? props.width : 96
  return Math.max(12, Math.min(26, Math.round(n / 4)))
})
</script>

<template>
  <div class="thumb" :class="{ round, loaded }" :style="{ width: w, aspectRatio: String(ratio) }">
    <img
      v-if="url && !failed"
      :src="url"
      :alt="alt"
      :style="{ objectFit: fit }"
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      @load="loaded = true"
      @error="failed = true"
    >
    <span v-if="!url || failed || !loaded" class="ph" aria-hidden="true">
      <AIcon :name="icon" :size="iconSize" :stroke="1.4" />
    </span>
  </div>
</template>

<style scoped>
.thumb { position: relative; flex: none; overflow: hidden; border-radius: 6px; background: #1a1a1a; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .04); }
.thumb.round { border-radius: 50%; }
.thumb img { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; transition: opacity .15s; }
.thumb.loaded img { opacity: 1; }
.ph { position: absolute; inset: 0; display: grid; place-items: center; color: #4a4a4a; }
</style>
