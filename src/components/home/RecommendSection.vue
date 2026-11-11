<script setup>
import { ref, shallowRef, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { getVideos } from '@/api'
import { toast } from '@/composables/useToast'
import { isDesktop } from '@/composables/useDesktop'
import { reducedMotion } from '@/utils/motion'
import { vRise, dur, ease } from './motion'
import Icon from '@/components/Icon.vue'
import VideoCard from '@/components/VideoCard.vue'
import SkeletonGrid from './SkeletonGrid.vue'
import ContentSwap from './ContentSwap'

/* One block of the 推荐 tab: title, card grid, 换一批 / 看更多. */
const props = defineProps({
  /** { id, topicId, title, featured, size, seed, batches } from getRecommendSections() */
  section: { type: Object, required: true },
  /** 桌面布局里网格现在的列数（RecommendTab 量好传下来）；手机上是 0 */
  cols: { type: Number, default: 0 }
})

const router = useRouter()
/* 「全部 / 看更多」去分区关联的专题（不是分区自己的 id）；没关联或专题已下架时接口给 null，两个入口都不显示 */
const topicPath = computed(() => (props.section.topicId != null ? `/topic/${props.section.topicId}` : null))

/*
 * ---- 桌面布局（≥ 1024px）：每个分区都是整行 ----
 * 网格按 --desk-card 自动排列数（1024 宽 3 列 … 最多 6 列），分区里的卡片数要跟着列数取整行，
 * 不然最后一行半空、各分区参差不齐。所以桌面上一次多要一些（DESK_SIZE：6 列 × 2 行），按列数截成整行显示：
 *   - 第一个分区（featured）：第一张是 2 列 × 2 行的大卡片，旁边两行普通卡片（共 2 × 列数 - 3 张），
 *     4 列时正好是手机上的 5 张；
 *   - 其余分区：两行（2 × 列数）；
 *   - 接口给的不够（后台每批只放了几条）：大卡片排不满就不用大卡片，退成能排满的整行；
 *     连一行都不够（比如 6 列只有 4、5 张）：这一组改成正好这么多列、卡片放大一些铺满一行，右边不空一块
 *     （少于半行就不放大，按原来的宽度靠左排）。
 * 列数变了（拉窗口、收起 / 展开左侧导航）只是重新截，不重新请求。手机上请求和显示都和以前一样（section.size 张）。
 */
const DESK_SIZE = 12
const desk = computed(() => isDesktop.value && props.cols > 0)
/** n 条、c 列：显示几张、第一张是不是大卡片、要不要改成 n 列铺满（0 = 不改） */
function deskLayout(n, c) {
  if (props.section.featured && c >= 3 && n >= 2 * c - 3) return { count: 2 * c - 3, feat: true, span: 0 }
  if (n >= c) return { count: Math.min(2, Math.floor(n / c)) * c, feat: false, span: 0 }
  return { count: n, feat: false, span: n >= Math.ceil(c / 2) ? n : 0 }
}
const phoneSize = () => props.section.size || 4
/* 这一次请求要几条：手机上照旧传 section.size（没有时接口按 4 条） */
const requestSize = () => (isDesktop.value ? Math.max(DESK_SIZE, phoneSize()) : props.section.size)

/* 换一批：向后端要下一个批次；批次数由接口给出，循环回到第一批 */
const batchNo = ref(0)
/* null = 第一批还没回来（显示同样大小的骨架，卡片到了不把页面往下推） */
const videos = shallowRef(null)
const failed = ref(false)
/* 每到一批就 +1：网格换 key，旧的一批原地淡出，新的一批入场 */
const batch = ref(0)
/* 正在换一批：旧的一批留着等新的（ContentSwap），快的直接换成新的一批，慢了（250ms）才淡入骨架 */
const shuffling = ref(false)
/* 新的一批怎么入场：第一次是错峰从下往上浮现；换一批是错峰淡入 + 轻微放大（和旧的一批交叉） */
const fading = ref(false)
const enterWith = () => (fading.value ? { y: 0, scale: 0.96 } : {})

/* 现在显示哪几张、第一张是不是大卡片 */
const shown = computed(() => {
  const list = videos.value || []
  if (!desk.value) return { list: list.length > phoneSize() ? list.slice(0, phoneSize()) : list, feat: false, style: undefined }
  const l = deskLayout(list.length, props.cols)
  return { list: list.slice(0, l.count), feat: l.feat, style: l.span ? { gridTemplateColumns: `repeat(${l.span}, minmax(0, 1fr))` } : undefined }
})
/* 骨架按「接口给满了」排（桌面布局），和真内容一样大 */
const skel = computed(() => (desk.value ? deskLayout(DESK_SIZE, props.cols) : { count: null, feat: false }))

async function load(fade = false) {
  const requested = batchNo.value
  failed.value = false
  shuffling.value = fade && !!videos.value
  try {
    const list = await getVideos(props.section.id, requestSize(), requested, props.section.seed)
    if (requested !== batchNo.value) return // a newer batch was asked for meanwhile
    videos.value = list
    batch.value++
    fading.value = fade
    shuffling.value = false
  } catch {
    if (requested !== batchNo.value) return
    shuffling.value = false
    if (videos.value) {
      // 换一批失败：留着这一批，下次还从这一批往后换
      batchNo.value = prevBatch(requested)
      toast('换一批失败，请稍后重试')
    } else {
      failed.value = true
    }
  }
}

/*
 * 手机宽度下加载、再把窗口拉宽到桌面布局：手里只有 section.size 张，整行排不满。
 * 悄悄把同一批按桌面的条数再取一次（不换 key、不重播入场，前面几张原样留着，后面的直接补上）；失败就算了。
 */
let topping = false
watch(isDesktop, async on => {
  const list = videos.value
  if (!on || !list || topping || shuffling.value || list.length >= requestSize()) return
  topping = true
  const requested = batchNo.value
  try {
    const more = await getVideos(props.section.id, requestSize(), requested, props.section.seed)
    if (requested === batchNo.value && videos.value === list && !shuffling.value && more.length > list.length) videos.value = more
  } catch { /* 留着现在的 */ }
  topping = false
})

const nextBatch = n => {
  // 批次数由接口给；没有就退化成一直往后取
  const total = props.section.batches || 0
  return total ? (n + 1) % total : n + 1
}
const prevBatch = n => {
  const total = props.section.batches || 0
  return total ? (n - 1 + total) % total : Math.max(0, n - 1)
}

/* 换一批：刷新图标快速转一圈（一次性动画，KeepAlive 收起再回来不会重播；连点从头再转）。桌面上转标题行右边的那个按钮 */
const shuffleBtn = ref(null)
const deskShuffleBtn = ref(null)
function spin() {
  const btn = isDesktop.value ? deskShuffleBtn.value : shuffleBtn.value
  const svg = btn?.querySelector('svg')
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
      <!-- 桌面布局：换一批放到标题行右边（下面那排通栏按钮在桌面上不显示） -->
      <button v-if="isDesktop" ref="deskShuffleBtn" type="button" class="sec-act" @click="shuffle">
        <Icon name="refresh" />换一批
      </button>
      <RouterLink v-if="topicPath" class="sec-more" :to="topicPath">全部<Icon name="chevR" /></RouterLink>
    </div>

    <!-- 骨架原地淡出，新的一批错峰入场；换一批时上一批留着等新的，慢了（250ms）才淡入骨架 -->
    <ContentSwap :pending="shuffling || (!videos && !failed)">
      <div v-if="videos && !shuffling" :key="batch" v-rise="enterWith()" class="grid" :style="shown.style">
        <VideoCard
          v-for="(v, i) in shown.list"
          :key="v.id"
          :video="v"
          :big="!desk && section.featured && i === 0"
          :feature="shown.feat && i === 0"
        />
      </div>
      <div v-else-if="failed" class="sec-fail">
        这一组没加载出来
        <button type="button" class="retry" @click="load()">重试</button>
      </div>
      <SkeletonGrid v-else :count="section.size || 4" :big="section.featured" :desk-count="skel.count" :feature="skel.feat" />
    </ContentSwap>

    <div class="sec-btns m-only">
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

/*
 * ---- 桌面布局（≥ 1024px）----
 * 标题行和网格同宽同边（最宽 --desk-max、左右 --desk-pad，和 .grid 一样居中），标题左、「换一批」「全部 ›」两个小按钮靠右；
 * 分区之间留 40px。底下那排通栏按钮（.m-only）不显示。
 */
@media (min-width: 1024px) {
  .sec { margin-top: 0; padding-bottom: 0; }
  .sec + .sec { margin-top: 40px; }
  .sec-hd {
    justify-content: flex-start;
    gap: 4px;
    max-width: var(--desk-max);
    height: 56px;
    margin: 0 auto;
    padding: 0 var(--desk-pad) 4px;
  }
  .sec-t { gap: 8px; margin-right: auto; font-size: 16px; line-height: 24px; }
  .sec-act, .sec-more {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 32px;
    padding: 0 12px;
    border-radius: 16px;
    color: var(--t2);
    font-size: 13px;
    font-weight: 500;
  }
  .sec-act svg { width: 14px; height: 14px; stroke-width: 2.2; }
  /* 「全部 ›」：箭头离右边近一点，看起来和网格右边缘对齐 */
  .sec-more { gap: 2px; margin-right: -6px; padding: 0 8px 0 12px; }
  .sec-more::after { content: none; }
  .sec-more svg { width: 14px; height: 14px; }
  .sec-fail {
    height: 220px;
    max-width: calc(var(--desk-max) - 2 * var(--desk-pad));
    margin: 0 max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad)));
    border-radius: 12px;
    font-size: 14px;
  }
  .sec-fail .retry { height: 36px; padding: 0 20px; border-radius: 18px; font-size: 14px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .sec-act, .sec-more, .sec-fail .retry { transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out); }
  .sec-act:hover, .sec-more:hover, .sec-fail .retry:hover { background: #1f1f1f; color: var(--t3); }
}
</style>
