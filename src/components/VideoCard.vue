<script setup>
import { computed } from 'vue'
import Cover from './Cover.vue'

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
  <RouterLink :to="target" class="vc" :class="{ big }">
    <Cover class="cv" v-bind="video.cover">
      <!-- extra overlays (e.g. the code badge on recent searches) -->
      <slot name="badge" />
      <span class="dur">{{ video.dur }}</span>
    </Cover>
    <div class="tt">{{ video.title }}</div>
  </RouterLink>
</template>
