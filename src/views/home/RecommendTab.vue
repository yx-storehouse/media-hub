<script setup>
import { ref, shallowRef } from 'vue'
import { getRecommendSections } from '@/api'
import RecommendSection from '@/components/home/RecommendSection.vue'
import { useKeepScroll } from '@/composables/useKeepScroll'

const sections = shallowRef([])
const failed = ref(false)
const scroller = ref(null)
useKeepScroll(scroller)

async function load() {
  try {
    sections.value = await getRecommendSections()
    failed.value = false
  } catch {
    failed.value = true
  }
}

load()
</script>

<template>
  <div>
    <div v-if="failed" class="empty">
      加载失败，请稍后重试
      <button class="retry" @click="load()">重试</button>
    </div>
    <div v-else ref="scroller" class="scroll">
      <RecommendSection v-for="s in sections" :key="s.id" :section="s" />
      <div class="pad-b" />
    </div>
  </div>
</template>
