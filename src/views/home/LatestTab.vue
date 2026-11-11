<script setup>
import { ref, shallowRef, watch } from 'vue'
import { getLatestFilters, getLatestVideos } from '@/api'
import VideoCard from '@/components/VideoCard.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import ContentSwap from '@/components/home/ContentSwap'
import { createHomeFeed, useAutoMore, refreshFeed, toTopOrRefresh } from '@/components/home/list'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { useSlider, cover, vRise } from '@/components/home/motion'
import { useScrollEdge } from '@/components/motion/scrollEdge'
import { isDesktop } from '@/composables/useDesktop'

/*
 * 最新：最近 7 天 × 地区。地区第一项是「全部」（默认）；地区上的数字是所选那一天的条数，
 * 来自接口的 counts[日期]，和下面列表的条数一致。
 */
/* { dates: [{ label, count }], regions: [{ code, label, count, counts: [7] }] }；null = 还没拿到 */
const filters = shallowRef(null)
const filtersFailed = ref(false)
const date = ref(0)
const region = ref(0)
const regionCount = r => r.counts?.[date.value] ?? r.count

const fetchPage = (q, page) => getLatestVideos({ ...q, ...page })
const query = () => ({ date: date.value, region: region.value })
const feed = createHomeFeed(page => fetchPage(query(), page))
/* 刷新后整体替换列表时加一：网格换 key，新列表淡入 */
const batch = ref(0)

const dateRow = ref(null)
const scroller = ref(null)
const { reset: resetScroll } = useKeepScroll(scroller, dateRow)
useAutoMore(scroller, feed)

/* 选中的日期 / 地区：高亮底跟着滑过去（地区上的数字随日期变，宽度变了直接贴过去） */
const dateBar = ref(null)
const regionRow = ref(null)
const regionBar = ref(null)
useSlider(dateRow, dateBar, cover('.dchip.on'), { key: () => date.value, deps: () => filters.value })
// 地区是描边的框：拉长会把左右两条边拉粗、圆头压扁，所以只平移、宽度渐变，不拉长
useSlider(regionRow, regionBar, cover('.rp.on'), { key: () => region.value, deps: () => [filters.value, date.value], stretch: false })

/*
 * 桌面布局：日期行平时没有底线（同上面的分类标签行），列表滚到它下面时才出现细线和淡阴影（m-edge）。
 * 手机上日期行一直有底线，不挂这个（返回 null：不往滚动区里插哨兵）。
 */
const datebarEl = ref(null)
const edge = useScrollEdge(datebarEl, () => (isDesktop.value ? scroller.value : null))
watch(isDesktop, () => edge.refresh(), { flush: 'post' })

async function loadFilters() {
  filtersFailed.value = false
  try {
    filters.value = await getLatestFilters()
  } catch {
    filtersFailed.value = true
  }
}

/** 首次进入和整页重试：筛选项和第一页视频同时请求，哪个失败重取哪个 */
function load() {
  if (!filters.value) loadFilters()
  if (feed.total === null) feed.more()
}

/* 换日期或地区：列表从头开始 */
function select(d, r) {
  if (d === date.value && r === region.value) return
  date.value = d
  region.value = r
  feed.reset()
  resetScroll()
  feed.more()
}

/* 再点一次底部「首页」：回到顶部；已经在顶部就重新取筛选项（计数）和第一页 */
async function refresh() {
  if (feed.total === null || filtersFailed.value) return load()
  const q = query()
  getLatestFilters().then(f => { filters.value = f }, () => { /* 计数刷新失败：保留原来的 */ })
  try {
    const stale = () => q.date !== date.value || q.region !== region.value
    if (await refreshFeed(feed, page => fetchPage(q, page), stale)) batch.value++
  } catch { /* 刷新失败：保留现在的列表 */ }
}

defineExpose({ retap: () => toTopOrRefresh(scroller.value, refresh) })

load()
</script>

<template>
  <div>
    <!-- date bar stays fixed above the list（桌面上 7 天一行摆得下，d-wrap：不再是横向滚动行） -->
    <div ref="datebarEl" class="datebar" :class="{ 'm-edge': isDesktop }">
      <div ref="dateRow" class="row hs d-wrap">
        <span ref="dateBar" class="m-bar dbar" aria-hidden="true" />
        <template v-if="filters">
          <button
            v-for="(d, i) in filters.dates"
            :key="d.label"
            type="button"
            class="dchip"
            :class="{ on: i === date }"
            :aria-pressed="i === date"
            :aria-label="`${d.label}，${d.count} 条`"
            @click="select(i, region)"
          >
            <span class="lb">{{ d.label }}</span><span class="bd" aria-hidden="true">{{ d.count }}</span>
          </button>
        </template>
        <!-- 筛选项回来前的占位：和日期块一样大，回来时不跳 -->
        <template v-else-if="!filtersFailed">
          <span v-for="i in 7" :key="i" class="dchip sk" aria-hidden="true" />
        </template>
      </div>
    </div>

    <div ref="scroller" class="scroll">
      <div v-if="filtersFailed || (feed.error && feed.total === null)" class="empty">
        加载失败，请稍后重试
        <button type="button" class="retry" @click="load()">重试</button>
      </div>
      <template v-else>
        <div ref="regionRow" class="pills hs d-wrap">
          <span ref="regionBar" class="m-bar rbar" aria-hidden="true" />
          <template v-if="filters">
            <button
              v-for="(r, i) in filters.regions"
              :key="r.code || r.label"
              type="button"
              class="rp"
              :class="{ on: i === region }"
              :aria-pressed="i === region"
              @click="select(date, i)"
            >
              {{ r.label }}<span class="n">{{ regionCount(r) }}</span>
            </button>
          </template>
          <template v-else>
            <span v-for="i in 4" :key="i" class="rp sk" aria-hidden="true" />
          </template>
        </div>
        <!-- 换日期 / 地区：旧列表留着等新的，快的直接换成新列表（错峰浮现），慢了（250ms）才淡入骨架 -->
        <ContentSwap :pending="feed.total === null">
          <SkeletonGrid v-if="feed.total === null" :count="10" gap="g16" fill />
          <div v-else-if="!feed.list.length" v-rise.self class="empty">这一天还没有新视频</div>
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
.datebar { position: relative; flex: none; border-bottom: 1px solid var(--line); }
/* min-height：筛选项没回来或加载失败时，日期行也占住同样的高度 */
.datebar .row { position: relative; z-index: 0; display: flex; gap: 13px; min-height: 53px; padding: 11px 14px 12px; }
/* 选中日期的白底（useSlider 滑动）：压在各日期的灰底上面、日期字和角标下面 */
.dbar { top: 11px; z-index: 1; height: 30px; border-radius: 8px; background: var(--accent); }

.dchip {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 50px;
  height: 30px;
  border-radius: 8px;
  background: var(--chip);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .035);
  color: var(--t2);
  font-size: 12.5px;
  font-weight: 500;
  transition: background-color var(--dur-2) var(--ease-in-out);
}
.dchip.on { background: var(--accent); box-shadow: none; color: var(--on-accent); font-weight: 600; }
/* 白底交给滑块 */
[data-slider] > .dchip.on { background: transparent; }
.dchip .lb { position: relative; z-index: 2; transition: opacity var(--dur-1) var(--ease-out); }
/* 日期字用 difference 混合：白底滑到哪里哪里的字反成黑的，滑动途中都看得清（#a2 叠在灰底上 = 原来的 #8c）；角标不混合 */
[data-slider] > .dchip .lb { color: #a2a2a2; mix-blend-mode: difference; }
/* 一变成选中就是满的白 / 黑：按下时调暗的那一下不带进滑动里 */
[data-slider] > .dchip.on .lb { color: #fff; opacity: 1; transition: none; }
/* 按下时把字调暗（不缩放：缩放会让文字跑到白底下面去） */
.dchip:active .lb { opacity: .6; }
/* new-video count badge on the chip's top-right corner */
.dchip .bd {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 23px;
  height: 13px;
  padding: 0 5px;
  border-radius: 7px;
  background: var(--accent);
  box-shadow: 0 0 0 1.5px var(--bg);
  z-index: 2;
  color: var(--on-accent);
  font-size: 10px;
  font-weight: 600;
  line-height: 13px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.pills { position: relative; z-index: 0; display: flex; gap: 9px; padding: 9px 14px 21px; }
/* 选中地区的白框（useSlider 滑动） */
.rbar { top: 9px; z-index: 1; height: 29px; border: 1.5px solid var(--accent); border-radius: 15px; }
.rp {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
  height: 29px;
  padding: 0 15px;
  border: 1.5px solid transparent;
  border-radius: 15px;
  background: var(--chip);
  color: var(--t2);
  font-size: 12px;
  font-weight: 500;
  transition: color var(--dur-2) var(--ease-in-out), background-color var(--dur-2) var(--ease-in-out);
}
.rp:active { color: var(--t3); }
.rp .n { font-size: 11.5px; font-weight: 400; font-variant-numeric: tabular-nums; opacity: .92; }
.rp.on { border-color: var(--accent); background: transparent; color: var(--accent); }
[data-slider] > .rp.on { border-color: transparent; }

/* ---- 骨架 ---- */
.sk { animation: sk 1.2s ease-in-out infinite; }
.rp.sk { width: 72px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}

/*
 * ---- 桌面布局（≥ 1024px）----
 * 日期行（滚动区外面）左边用 HomeView 的 --home-x，地区行和网格在滚动区里面，按同一个算法对齐（100% 是滚动区的内容宽）。
 * 两行都是 d-wrap：一行摆得下就一行，摆不下折行，不藏在横向滚动里。日期块、地区胶囊放大一点（鼠标好点），
 * 滑块的位置 / 高度跟着改。日期行平时没有底线，列表滚上去才出现（m-edge）。
 */
@media (min-width: 1024px) {
  .datebar { border-bottom-color: transparent; }
  .datebar .row { gap: 12px; min-height: 52px; padding: 8px var(--home-x) 12px; }
  .dbar { top: 8px; height: 32px; }
  .dchip { width: 60px; height: 32px; font-size: 13px; }
  .dchip .bd { top: -6px; right: -6px; }

  .pills { gap: 10px; padding: 12px max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad))) 20px; }
  .rbar { top: 12px; height: 32px; border-radius: 16px; }
  .rp { height: 32px; padding: 0 16px; border-radius: 16px; font-size: 13px; }
  .rp .n { font-size: 12px; }
}
@media (min-width: 1024px) and (hover: hover) {
  /* 日期字是 difference 混合：灰底变亮时字要换成白色才是跟着变亮（|#ff - #1f| ≈ #e0），照旧用 #a2 反而变暗 */
  .dchip:not(.on):hover { background: #1f1f1f; }
  [data-slider] > .dchip:not(.on):hover .lb { color: #fff; }
  .dchip .lb { transition: opacity var(--dur-1) var(--ease-out), color var(--dur-2) var(--ease-out); }
  .rp:not(.on):hover { background: #1f1f1f; color: var(--t3); }
}
</style>
