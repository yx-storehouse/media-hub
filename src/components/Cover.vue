<script setup>
import { computed, ref, watch } from 'vue'

/*
 * Image with a generated fallback underneath.
 * Usage: <Cover class="cv" v-bind="video.cover"><span class="dur">…</span></Cover>
 * - lazy loads the photo (native loading="lazy", async decode)
 * - 加载好后从占位图上淡入（同时由略微模糊变清晰）；缓存里的图几乎立刻就好，直接显示，不做淡入——
 *   返回上一页、换一批里重复的封面不会一闪一闪地重播（KeepAlive 切回来本来就不动）
 * - if the photo fails (offline / blocked) the fallback art simply stays visible
 * - size, radius etc. come from the class the parent puts on it
 * - emits `load` with the native event once the photo is in (e.g. to read its natural size)
 * - 照片完全显示出来以后（淡入结束）不再画下面的占位图：照片是不透明的、铺满整格，占位图（SVG / 渐变）
 *   还画在下面只是白白多一层栅格化（长列表滚动时每一格都要画两遍）
 * - thumb：接口给的小图（长边约 480、短边至少 360，没有时为 null）。格子很小的地方（照片墙、帖子卡片的缩略图、「下一篇」）
 *   加 grid 用它；看大图（ImageViewer）照旧用 src
 */
const props = defineProps({
  src: { type: String, default: null },
  fallback: { type: String, default: null },
  /** 小图地址（接口的 thumb），grid 时优先用它 */
  thumb: { type: String, default: null },
  /** 小格子：有 thumb 就加载 thumb（省流量、省解码内存），没有就照旧用 src */
  grid: Boolean,
  /** load immediately (above-the-fold hero images) */
  eager: Boolean
})
const emit = defineEmits(['load'])

/* 这么快就加载好（毫秒）的当作缓存里的图 */
const INSTANT = 80
/* 淡入的时长（--dur-3 是 280ms）再多留一点：淡入结束之后才撤掉占位图，淡入途中照常透出来 */
const SETTLE = 320

const url = computed(() => (props.grid && props.thumb ? props.thumb : props.src))

const loaded = ref(false)
const instant = ref(false)
const failed = ref(false)
/* 照片已经完全盖住占位图：不再画占位图 */
const covered = ref(false)
let startedAt = performance.now()
let settleTimer = 0
watch(url, () => {
  loaded.value = false
  instant.value = false
  failed.value = false
  covered.value = false
  clearTimeout(settleTimer)
  startedAt = performance.now()
})

function onLoad(e) {
  instant.value = performance.now() - startedAt < INSTANT
  loaded.value = true
  clearTimeout(settleTimer)
  if (instant.value) covered.value = true
  else settleTimer = setTimeout(() => { if (loaded.value && !failed.value) covered.value = true }, SETTLE)
  emit('load', e)
}

const bg = computed(() => (props.fallback && !covered.value ? { backgroundImage: props.fallback } : undefined))
</script>

<template>
  <div class="cover" :style="bg">
    <img
      v-if="url && !failed"
      :src="url"
      alt=""
      :loading="eager ? 'eager' : 'lazy'"
      decoding="async"
      draggable="false"
      :class="{ on: loaded, now: instant }"
      @load="onLoad"
      @error="failed = true"
    >
    <slot />
  </div>
</template>

<style>
.cover {
  position: relative;
  overflow: hidden;
  background-color: #161616;
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
}
.cover > img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  filter: blur(6px);
  transition: opacity var(--dur-3) var(--ease-out), filter var(--dur-3) var(--ease-out);
  user-select: none;
}
.cover > img.on { opacity: 1; filter: none; }
.cover > img.now { transition: none; }
</style>
