<script setup>
import { ref, shallowRef } from 'vue'
import { getCategoryFilters, getCategoryVideos } from '@/api'
import VideoCard from '@/components/VideoCard.vue'
import { useKeepScroll } from '@/composables/useKeepScroll'

/* Plain category tabs (AI短剧 / 国产 / 日韩 / 动漫 / 综艺 / 纪录片): filter chips + grid. */
const props = defineProps({
  /** home tab id, e.g. 'ai' */
  tab: { type: String, required: true }
})

/* 筛选项由接口给出：[{ label, sort_key }] */
const filters = shallowRef([])
const active = ref(0)
const videos = shallowRef([])
/* bumps whenever a list arrives: re-keys the grid so every new list fades in */
const batch = ref(0)

const scroller = ref(null)
useKeepScroll(scroller)

const failed = ref(false)

async function loadVideos() {
  const filter = active.value
  const list = await getCategoryVideos(props.tab, { filter })
  if (filter !== active.value) return   // 用户已经切到别的筛选，丢弃这次结果
  videos.value = list
  batch.value++
}

/** 首次进入和重试都走这里：先拿筛选项，再拿视频 */
async function load() {
  try {
    filters.value = await getCategoryFilters(props.tab)
    await loadVideos()
    failed.value = false
  } catch {
    failed.value = true
  }
}

function select(i) {
  if (i === active.value) return
  active.value = i
  loadVideos().catch(() => { failed.value = true })
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
      <div class="chips">
        <button
          v-for="(f, i) in filters"
          :key="f.label"
          class="chip"
          :class="{ on: i === active }"
          :aria-pressed="i === active"
          @click="select(i)"
        >
          {{ f.label }}
        </button>
      </div>
      <div :key="batch" v-fade-in class="grid g16">
        <VideoCard v-for="v in videos" :key="v.id" :video="v" />
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>
