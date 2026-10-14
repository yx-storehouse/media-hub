<script setup>
import { ref, shallowRef, computed } from 'vue'
import { useRouter } from 'vue-router'
import { getVideos } from '@/api'
import { toast } from '@/composables/useToast'
import { reducedMotion } from '@/utils/motion'
import { vRise, dur, ease } from './motion'
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
/* 每到一批就 +1：网格换 key，旧的一批原地淡出，新的一批入场 */
const batch = ref(0)
/* 新的一批怎么入场：第一次是错峰从下往上浮现；换一批是错峰淡入 + 轻微放大（和旧的一批交叉） */
const fading = ref(false)
const enterWith = () => (fading.value ? { y: 0, scale: 0.96 } : {})

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

/* 换一批：刷新图标快速转一圈（一次性动画，KeepAlive 收起再回来不会重播；连点从头再转） */
const shuffleBtn = ref(null)
function spin() {
  const svg = shuffleBtn.value?.querySelector('svg')
  if (!svg || reducedMotion()) return
  svg.getAnimations?.().forEach(a => a.cancel())
  svg.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: dur('--dur-4'), easing: ease('--ease-out') })
}

function shuffle() {
  spin()
  batchNo.value = nextBatch(batchNo.value)
  load(true)
}

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

    <!-- 骨架 / 上一批原地淡出，新的一批错峰入场 -->
    <div class="m-swap">
      <Transition name="m-skel">
        <div v-if="videos" :key="batch" v-rise="enterWith()" class="grid">
          <VideoCard v-for="(v, i) in videos" :key="v.id" :video="v" :big="section.featured && i === 0" />
        </div>
        <div v-else-if="failed" class="sec-fail">
          这一组没加载出来
          <button type="button" class="retry" @click="load()">重试</button>
        </div>
        <SkeletonGrid v-else :count="section.size || 4" :big="section.featured" />
      </Transition>
    </div>

    <div class="sec-btns">
      <button ref="shuffleBtn" type="button" class="btn-soft" @click="shuffle">
        <Icon name="refresh" />换一批
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
.sec-more:active { color: var(--t3); }
.sec-btns { display: flex; gap: 11px; padding: 12px 14px 0; }
.sec-fail { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 150px; margin: 0 14px; border-radius: 8px; background: #121212; color: var(--t2); font-size: 13px; }
.sec-fail .retry { height: 30px; padding: 0 18px; border-radius: 15px; background: var(--chip); color: var(--t1); font-size: 13px; }
</style>
