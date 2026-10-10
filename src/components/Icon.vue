<script setup>
import { computed } from 'vue'
import { icons } from '@/icons'

const props = defineProps({
  /** key in src/icons/index.js (unknown names warn in development and render nothing) */
  name: { type: String, required: true, validator: n => n in icons }
})

const def = computed(() => icons[props.name])
</script>

<template>
  <!-- the <svg> is the component root, so parent scoped styles like `.btn svg {}` apply to it -->
  <svg v-if="def" :class="{ ic: def.stroke }" :viewBox="def.box || '0 0 24 24'" aria-hidden="true" focusable="false" v-html="def.body" />
</template>
