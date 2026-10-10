<script setup>
import Icon from './Icon.vue'
import { useBack } from '@/composables/useBack'

/* Header for simple sub pages: back arrow + title. */
defineProps({ title: { type: String, default: '' } })
const back = useBack()
</script>

<template>
  <div class="sub-hd">
    <button class="sh-back" aria-label="返回" @click="back"><Icon name="chevL" /></button>
    <slot>{{ title }}</slot>
  </div>
</template>

<style>
.sub-hd {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 14px 0 12px;
  border-bottom: 1px solid var(--line);
  font-size: 16px;
  font-weight: 600;
}
.sub-hd .sh-back { margin: 0; }
</style>
