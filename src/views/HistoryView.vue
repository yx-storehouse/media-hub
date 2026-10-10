<script setup>
import { ref, shallowRef, onMounted } from 'vue'
import { getHistory } from '@/api'
import { useAuthStore } from '@/stores/auth'
import BackHeader from '@/components/BackHeader.vue'
import VideoCard from '@/components/VideoCard.vue'

defineOptions({ name: 'HistoryView' })

const auth = useAuthStore()
const videos = shallowRef([])
const failed = ref(false)

async function load() {
  if (!auth.loggedIn) { videos.value = []; failed.value = false; return }
  try {
    videos.value = await getHistory()
    failed.value = false
  } catch {
    failed.value = true
  }
}

onMounted(load)
</script>

<template>
  <div class="page history">
    <BackHeader title="观看历史" />
    <div v-if="!auth.loggedIn" class="empty">
      登录后可以在这里看到观看记录
      <button class="retry" @click="auth.loginOpen = true">去登录</button>
    </div>
    <div v-else-if="failed" class="empty">
      加载失败，请稍后重试
      <button class="retry" @click="load()">重试</button>
    </div>
    <div v-else class="scroll">
      <div class="grid g16">
        <VideoCard v-for="v in videos" :key="v.id" :video="v" />
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
.grid { padding-top: 14px; }
</style>
