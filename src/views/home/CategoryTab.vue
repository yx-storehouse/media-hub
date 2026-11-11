<script setup>
import { ref, shallowRef } from 'vue'
import { getCategoryFilters, getCategoryVideos } from '@/api'
import VideoCard from '@/components/VideoCard.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import ContentSwap from '@/components/home/ContentSwap'
import { createHomeFeed, useAutoMore, refreshFeed, toTopOrRefresh } from '@/components/home/list'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { useSlider, cover, vRise } from '@/components/home/motion'

/* 普通分类页（AI短剧 / 国产 / 日韩 / 动漫 / 综艺 / 纪录片）：筛选胶囊 + 视频网格，滚到底接着加载 */
const props = defineProps({
  /** home tab id, e.g. 'ai' */
  tab: { type: String, required: true }
})

/* 筛选项由接口给出：[{ label, sort_key }]；null = 还没拿到 */
const filters = shallowRef(null)
const filtersFailed = ref(false)
const active = ref(0)

const fetchPage = (filter, page) => getCategoryVideos(props.tab, { filter, ...page })
const feed = createHomeFeed(page => fetchPage(active.value, page))
/* 刷新后整体替换列表时加一：网格换 key，新列表淡入 */
const batch = ref(0)

const scroller = ref(null)
const { reset: resetScroll } = useKeepScroll(scroller)
useAutoMore(scroller, feed)

/* 选中筛选的白底跟着滑过去 */
const chipRow = ref(null)
const chipBar = ref(null)
useSlider(chipRow, chipBar, cover('.chip.on'), { key: () => active.value, deps: () => filters.value })

async function loadFilters() {
  filtersFailed.value = false
  try {
    filters.value = await getCategoryFilters(props.tab)
  } catch {
    filtersFailed.value = true
  }
}

/** 首次进入和整页重试：筛选项和第一页视频同时请求，哪个失败重取哪个 */
function load() {
  if (!filters.value) loadFilters()
  if (feed.total === null) feed.more()
}

function select(i) {
  if (i === active.value) return
  active.value = i
  feed.reset()
  resetScroll()
  feed.more()
}

/* 再点一次底部「首页」：回到顶部；已经在顶部就重新取第一页 */
async function refresh() {
  if (feed.total === null || filtersFailed.value) return load()
  const filter = active.value
  try {
    if (await refreshFeed(feed, page => fetchPage(filter, page), () => filter !== active.value)) batch.value++
  } catch { /* 刷新失败：保留现在的列表 */ }
}

defineExpose({ retap: () => toTopOrRefresh(scroller.value, refresh) })

load()
</script>

<template>
  <div>
    <div ref="scroller" class="scroll">
      <div v-if="filtersFailed || (feed.error && feed.total === null)" class="empty">
        加载失败，请稍后重试
        <button type="button" class="retry" @click="load()">重试</button>
      </div>
      <template v-else>
        <div ref="chipRow" class="chips">
          <span ref="chipBar" class="m-bar cbar" aria-hidden="true" />
          <template v-if="filters">
            <button
              v-for="(f, i) in filters"
              :key="f.label"
              type="button"
              class="chip m-off"
              :class="{ on: i === active }"
              :aria-pressed="i === active"
              @click="select(i)"
            >
              <span class="lb">{{ f.label }}</span>
            </button>
          </template>
          <!-- 筛选项回来前的占位：和胶囊一样高，回来时不跳 -->
          <template v-else>
            <span v-for="i in 4" :key="i" class="chip chip-sk" aria-hidden="true" />
          </template>
        </div>
        <!-- 换筛选：旧列表留着等新的，快的直接换成新列表（错峰浮现），慢了（250ms）才淡入骨架 -->
        <ContentSwap :pending="feed.total === null">
          <SkeletonGrid v-if="feed.total === null" :count="10" gap="g16" fill />
          <div v-else-if="!feed.list.length" v-rise.self class="empty">这里还没有视频</div>
          <div v-else :key="batch">
            <div v-rise class="grid g16">
              <VideoCard v-for="v in feed.list" :key="v.id" :video="v" />
            </div>
            <ListFoot :feed="feed" />
          </div>
        </ContentSwap>
      </template>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
/* 选中筛选的白底（useSlider 滑动）：压在各胶囊的灰底上面、文字下面 */
.chips { position: relative; z-index: 0; }
.cbar { top: 12px; z-index: 1; height: 27.5px; border-radius: 14px; background: var(--accent); }
.chip { transition: background-color var(--dur-2) var(--ease-in-out); }
[data-slider] > .chip.on { background: transparent; }
.chip .lb { position: relative; z-index: 2; transition: opacity var(--dur-1) var(--ease-out); }
/*
 * 字用 difference 混合：白底滑到哪里，哪里的字就反成黑的，途中经过的、刚离开的、要去的都看得清，
 * 点下去的那一帧选中的字就变了（不等颜色过渡）。#b9 叠在 #161616 灰底上正好是原来的 #a3。
 * 一排胶囊本身是独立的层叠上下文（.chips 有 z-index），混合只和这一排里的东西算。
 */
[data-slider] > .chip .lb { color: #b9b9b9; mix-blend-mode: difference; }
/* 点下去的那个一变成选中就是满的白 / 黑：按下时调暗的那一下（:active 松手后还会留一会儿）不带进滑动里 */
[data-slider] > .chip.on .lb { color: #fff; opacity: 1; transition: none; }
/* 胶囊不缩放（m-off）：缩放会让文字跑到白底下面去，按下时只把字调暗 */
.chip:active .lb { opacity: .6; }
.chip-sk { width: 56px; animation: sk 1.2s ease-in-out infinite; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .chip-sk { animation: none; }
}

/*
 * ---- 桌面布局（≥ 1024px）----
 * 筛选胶囊一行（接口给的筛选项不多，摆不下时折行，不横着滚），左边和网格对齐（同 .grid 的算法，100% 是滚动区的内容宽）；
 * 胶囊放大一点（鼠标好点），滑块跟着改。
 */
@media (min-width: 1024px) {
  .chips { flex-wrap: wrap; gap: 10px; padding: 8px max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad))) 20px; }
  .cbar { top: 8px; height: 32px; border-radius: 16px; }
  /* 胶囊尺寸用公共的桌面值（common.css）；骨架胶囊的宽度这里的手机值优先级更高，要在这里改 */
  .chip-sk { width: 64px; }
}
@media (min-width: 1024px) and (hover: hover) {
  /*
   * 胶囊的字是 difference 混合（见上面）：公共样式把没选中的胶囊悬停底色变成 #1f1f1f 时，
   * 字要跟着换成白色才是变亮（|#ff - #1f| ≈ #e0），照旧用 #b9 反而变暗
   */
  .chip .lb { transition: opacity var(--dur-1) var(--ease-out), color var(--dur-2) var(--ease-out); }
  [data-slider] > .chip:not(.on):hover .lb { color: #fff; }
}
</style>
