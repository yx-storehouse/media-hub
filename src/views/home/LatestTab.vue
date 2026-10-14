<script setup>
import { ref, shallowRef } from 'vue'
import { getLatestFilters, getLatestVideos } from '@/api'
import VideoCard from '@/components/VideoCard.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import { createHomeFeed, useAutoMore, refreshFeed, toTopOrRefresh } from '@/components/home/list'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { useSlider, cover, vRise } from '@/components/home/motion'

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
useSlider(regionRow, regionBar, cover('.rp.on'), { key: () => region.value, deps: () => [filters.value, date.value] })

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
    <!-- date bar stays fixed above the list -->
    <div class="datebar">
      <div ref="dateRow" class="row hs">
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
        <div ref="regionRow" class="pills hs">
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
        <!-- 骨架 / 旧列表原地淡出，新列表错峰浮现 -->
        <div class="m-swap">
          <Transition name="m-skel">
            <SkeletonGrid v-if="feed.total === null" :count="10" gap="g16" />
            <div v-else-if="!feed.list.length" v-rise.self class="empty">这一天还没有新视频</div>
            <div v-else :key="batch">
              <div v-rise class="grid g16">
                <VideoCard v-for="v in feed.list" :key="v.id" :video="v" />
              </div>
              <ListFoot :feed="feed" />
            </div>
          </Transition>
        </div>
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
  transition: color var(--dur-2) var(--ease-in-out), background-color var(--dur-2) var(--ease-in-out);
}
.dchip.on { background: var(--accent); box-shadow: none; color: var(--on-accent); font-weight: 600; }
/* 白底交给滑块 */
[data-slider] > .dchip.on { background: transparent; }
.dchip .lb { position: relative; z-index: 2; transition: opacity var(--dur-1) var(--ease-out); }
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
</style>
