<script setup>
import { computed } from 'vue'
import Cover from './Cover.vue'
// 点进播放页时先记下封面和标题，播放页加载期间先显示它们（见 components/video/preview.js）
import { rememberVideo } from './video/preview'

const props = defineProps({
  /** Video: { id, title, dur, cover } */
  video: { type: Object, required: true },
  /** full-width featured card */
  big: Boolean,
  /** link target; defaults to the video's play page */
  to: { type: String, default: null }
})

const target = computed(() => props.to || `/video/${encodeURIComponent(props.video.id)}`)
</script>

<template>
  <RouterLink :to="target" class="vc" :class="{ big }" @click="rememberVideo(video)">
    <Cover class="cv" v-bind="video.cover">
      <!-- extra overlays (e.g. the code badge on recent searches) -->
      <slot name="badge" />
      <span class="dur">{{ video.dur }}</span>
    </Cover>
    <div class="tt">{{ video.title }}</div>
  </RouterLink>
</template>
