<script setup>
import { ref, watch } from 'vue'

/*
 * Image with a generated fallback underneath.
 * Usage: <Cover class="cv" v-bind="video.cover"><span class="dur">…</span></Cover>
 * - lazy loads the photo (native loading="lazy", async decode) and fades it in
 * - if the photo fails (offline / blocked) the fallback art simply stays visible
 * - size, radius etc. come from the class the parent puts on it
 */
const props = defineProps({
  src: { type: String, default: null },
  fallback: { type: String, default: null },
  /** load immediately (above-the-fold hero images) */
  eager: Boolean
})

const loaded = ref(false)
const failed = ref(false)
watch(() => props.src, () => {
  loaded.value = false
  failed.value = false
})
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
      :class="{ on: loaded }"
      @load="loaded = true"
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
  transition: opacity .25s ease;
  user-select: none;
}
.cover > img.on { opacity: 1; }
</style>
