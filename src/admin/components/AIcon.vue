<script setup>
import { computed } from 'vue'
import { icons } from './icons'

/*
 * 描边图标：<AIcon name="video" :size="16" />
 * 图标清单见 ./icons.js；颜色跟随文字（currentColor）。
 */
const props = defineProps({
  name: { type: String, required: true, validator: n => n in icons },
  size: { type: [Number, String], default: 16 },
  stroke: { type: [Number, String], default: 1.6 }
})

const body = computed(() => icons[props.name] || '')
</script>

<template>
  <!-- svg 是根节点：父组件的 scoped 样式（如 .btn svg {}）能直接作用到它 -->
  <svg
    class="a-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="body"
  />
</template>
