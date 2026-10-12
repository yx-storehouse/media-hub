<script setup>
import { ref, shallowRef, computed, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import { getVideos } from '@/api'
import { toast } from '@/composables/useToast'
import Icon from '@/components/Icon.vue'
import VideoCard from '@/components/VideoCard.vue'
import SkeletonGrid from './SkeletonGrid.vue'

/* One block of the 推荐 tab: title, card grid, 换一批 / 看更多. */
const props = defineProps({
  /** { id, topicId, title, featured, size, seed, batches } from getRecommendSections() */
  section: { type: Object, required: true }
})

const router = useRouter()
/* 「全部 / 看更多」去分区关联的专题（不是分区自己的 id）；没关联或专题已下架时接口给 null，两个入口都不显示 */
const topicPath = computed(() => (props.section.topicId != null ? `/topic/${props.section.topicId}` : null))

/* 换一批：向后端要下一个批次；批次数由接口给出，循环回到第一批 */
const batchNo = ref(0)
/* null = 第一批还没回来（显示同样大小的骨架，卡片到了不把页面往下推） */
const videos = shallowRef(null)
const failed = ref(false)
/* bumps whenever a list arrives: re-keys the grid so a new batch replays the fade */
const batch = ref(0)
/* the next grid fades in (换一批 only, not the first load) */
const fading = ref(false)
/* one-shot spin, cleared on animationend so it doesn't replay when the tab is shown again */
const spinning = ref(false)

async function load(fade = false) {
  const requested = batchNo.value
  failed.value = false
  try {
    const list = await getVideos(props.section.id, props.section.size, requested, props.section.seed)
    if (requested !== batchNo.value) return // a newer batch was asked for meanwhile
    videos.value = list
    batch.value++
    fading.value = fade
  } catch {
    if (requested !== batchNo.value) return
    if (videos.value) {
      // 换一批失败：留着这一批，下次还从这一批往后换
      batchNo.value = prevBatch(requested)
      toast('换一批失败，请稍后重试')
    } else {
      failed.value = true
    }
  }
}

const nextBatch = n => {
  // 批次数由接口给；没有就退化成一直往后取
  const total = props.section.batches || 0
  return total ? (n + 1) % total : n + 1
}
const prevBatch = n => {
  const total = props.section.batches || 0
  return total ? (n - 1 + total) % total : Math.max(0, n - 1)
}

function shuffle() {
  spinning.value = true
  batchNo.value = nextBatch(batchNo.value)
  load(true)
}

/* hidden mid-spin: animationend never fires on detached DOM, so drop the class now */
onDeactivated(() => { spinning.value = false })

/* 推荐页「再点一次首页」时整页换一批 */
defineExpose({ shuffle })

load()
</script>

<template>
  <section class="sec">
    <div class="sec-hd">
      <h2 class="sec-t">{{ section.title }}</h2>
      <RouterLink v-if="topicPath" class="sec-more" :to="topicPath">全部<Icon name="chevR" /></RouterLink>
    </div>

    <div v-if="videos" :key="batch" v-fade-in="fading" class="grid">
      <VideoCard v-for="(v, i) in videos" :key="v.id" :video="v" :big="section.featured && i === 0" />
    </div>
    <div v-else-if="failed" class="sec-fail">
      这一组没加载出来
      <button type="button" class="retry" @click="load()">重试</button>
    </div>
    <SkeletonGrid v-else :count="section.size || 4" :big="section.featured" />

    <div class="sec-btns">
      <!-- keyed icon: every press restarts the spin -->
      <button type="button" class="btn-soft" :class="{ spin: spinning }" @click="shuffle" @animationend="spinning = false">
        <Icon :key="batchNo" name="refresh" />换一批
      </button>
      <button v-if="topicPath" type="button" class="btn-soft" @click="router.push(topicPath)"><Icon name="more" />看更多</button>
    </div>
  </section>
</template>

<style scoped>
.sec { margin-top: 8px; padding-bottom: 12px; }
.sec + .sec { margin-top: 14px; }
.sec-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 50px;
  padding: 0 15px 4px 12px;
}
.sec-t {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
  font-size: 16px;
  font-weight: 600;
  line-height: 22px;
}
.sec-t::before { content: ''; flex: none; width: 3px; height: 16px; border-radius: 2px; background: var(--accent); }
.sec-more { position: relative; display: flex; align-items: center; gap: 1px; color: var(--t2); font-size: 13px; font-weight: 500; }
/* enlarge the tap area of the small text link without moving it */
.sec-more::after { content: ''; position: absolute; inset: -12px -10px; }
.sec-more svg { width: 13px; height: 13px; stroke-width: 2.8; }
.sec-btns { display: flex; gap: 11px; padding: 12px 14px 0; }
.sec-fail { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 150px; margin: 0 14px; border-radius: 8px; background: #121212; color: var(--t2); font-size: 13px; }
.sec-fail .retry { height: 30px; padding: 0 18px; border-radius: 15px; background: var(--chip); color: var(--t1); font-size: 13px; }
</style>
