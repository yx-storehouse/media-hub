<script setup>
import { ref, watch } from 'vue'

/*
 * Image with a generated fallback underneath.
 * Usage: <Cover class="cv" v-bind="video.cover"><span class="dur">…</span></Cover>
 * - lazy loads the photo (native loading="lazy", async decode)
 * - 加载好后从占位图上淡入（同时由略微模糊变清晰）；缓存里的图几乎立刻就好，直接显示，不做淡入——
 *   返回上一页、换一批里重复的封面不会一闪一闪地重播（KeepAlive 切回来本来就不动）
 * - if the photo fails (offline / blocked) the fallback art simply stays visible
 * - size, radius etc. come from the class the parent puts on it
 * - emits `load` with the native event once the photo is in (e.g. to read its natural size)
 */
const props = defineProps({
  src: { type: String, default: null },
  fallback: { type: String, default: null },
  /** load immediately (above-the-fold hero images) */
  eager: Boolean
})
const emit = defineEmits(['load'])

/* 这么快就加载好（毫秒）的当作缓存里的图 */
const INSTANT = 80

const loaded = ref(false)
const instant = ref(false)
const failed = ref(false)
let startedAt = performance.now()
watch(() => props.src, () => {
  loaded.value = false
  instant.value = false
  failed.value = false
  startedAt = performance.now()
})

function onLoad(e) {
  instant.value = performance.now() - startedAt < INSTANT
  loaded.value = true
  emit('load', e)
}
</script>

<template>
  <div class="cover" :style="fallback ? { backgroundImage: fallback } : undefined">
    <img
      v-if="src && !failed"
      :src="src"
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
