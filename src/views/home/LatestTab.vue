<script setup>
import { ref, shallowRef, computed, watch } from 'vue'
import { getLatestFilters, getLatestVideos } from '@/api'
import VideoCard from '@/components/VideoCard.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import WinList from '@/components/home/WinList'
import LoadState from '@/components/common/LoadState.vue'
import ContentSwap from '@/components/home/ContentSwap'
import { createHomeFeed, useAutoMore, refreshFeed, toTopOrRefresh } from '@/components/home/list'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { useSlider, cover, vRise } from '@/components/home/motion'
import { useScrollEdge } from '@/components/motion/scrollEdge'
import { isDesktop } from '@/composables/useDesktop'

/*
 * 最新：最近 7 天 × 地区。地区第一项是「全部」（默认）；地区上的数字是所选那一天的条数，
 * 来自接口的 counts[日期]，和下面列表的条数一致。
 *
 * 最近 7 天一条新视频都没有（管理员一周没上新）时不让整页空着：默认改看「最近上新」（date = RECENT，
 * 接口的 date=recent：不限日期、最新的在前，地区照样筛），日期一个都不选中，列表上面一行说明
 * 「最近 7 天没有新视频，下面是最近上新的（x月x日）」，地区上不显示数字（数字是 7 天里的）；
 * 点某一天照常看那一天，那一天是空的时候空状态里有「看最近上新」回来。
 */
/* { dates: [{ label, count }], regions: [{ code, label, count, counts: [7] }], latestAt }；null = 还没拿到 */
const filters = shallowRef(null)
const filtersFailed = ref(false)
const filtersErr = shallowRef(null)
const RECENT = -1
const date = ref(0)
const region = ref(0)
const regionCount = r => (date.value === RECENT ? null : r.counts?.[date.value] ?? r.count)

/* 7 天全是 0、库里又有更早的视频：可以看「最近上新」 */
const quiet = computed(() => {
  const f = filters.value
  return !!f && f.latestAt != null && Array.isArray(f.dates) && f.dates.length > 0 && f.dates.every(d => !d.count)
})
/* 最近上新那一天（x月x日；不是今年的带上年份） */
const latestDay = computed(() => {
  const at = Number(filters.value?.latestAt)
  if (!Number.isFinite(at) || at <= 0) return ''
  const d = new Date(at * 1000)
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`
})
/* 用户自己点过日期（之后刷新出来 7 天还是 0 也不再自动换回最近上新） */
let picked = false

const fetchPage = (q, page) => getLatestVideos({ ...q, ...page })
const query = () => ({ date: date.value === RECENT ? 'recent' : date.value, region: region.value })
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
    filtersErr.value = null
    autoRecent()
  } catch (e) {
    filtersErr.value = e
    filtersFailed.value = true
  }
}

/* 7 天都是 0：还停在默认的「今天」时换成看最近上新（第一页是和筛选项同时请求的，这时重新取） */
function autoRecent() {
  if (!quiet.value || picked || date.value !== 0) return
  date.value = RECENT
  feed.reset()
  resetScroll()
  feed.more()
}

/** 首次进入和整页重试：筛选项和第一页视频同时请求，哪个失败重取哪个（返回的 Promise 两个都完了才结束） */
function load() {
  return Promise.all([!filters.value && loadFilters(), feed.total === null && feed.more()])
}
/* 整页出错：筛选项或第一页没取到（断网、服务器出错时 LoadState 会自动重试） */
const pageError = () => (filtersFailed.value ? filtersErr.value || true : feed.total === null ? feed.error || null : null)
/* 筛选项还没回来、第一页已经空着回来了：先别说「这一天还没有新视频」（可能马上换成最近上新），接着显示骨架 */
const waiting = () => feed.total === null || (!filters.value && !feed.list.length)

/* 换日期或地区：列表从头开始 */
function select(d, r) {
  if (d !== RECENT && d !== date.value) picked = true
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
  const counts = getLatestFilters().then(f => {
    filters.value = f
    // 刷新后 7 天还是 0（或者变成了 0）：还在默认的「今天」就换成最近上新
    autoRecent()
  }, () => { /* 计数刷新失败：保留原来的 */ })
  try {
    const stale = () => q.date !== query().date || q.region !== region.value
    if (await refreshFeed(feed, page => fetchPage(q, page), stale)) batch.value++
  } catch { /* 刷新失败：保留现在的列表 */ }
  await counts
}

/* retap：再点一次底部「首页」；refresh：下拉刷新（HomeView 的手势，这时一定在顶上） */
defineExpose({ retap: () => toTopOrRefresh(scroller.value, refresh), refresh })

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
      <LoadState v-if="pageError()" :error="pageError()" :retry="load" />
      <template v-else>
        <!-- 7 天都没有新视频：说明下面的是最近上新的 -->
        <p v-if="date === RECENT && quiet" class="lt-note" role="status">最近 7 天没有新视频，下面是最近上新的<template v-if="latestDay">（{{ latestDay }}）</template></p>
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
              {{ r.label }}<span v-if="regionCount(r) != null" class="n">{{ regionCount(r) }}</span>
            </button>
          </template>
          <template v-else>
            <span v-for="i in 4" :key="i" class="rp sk" aria-hidden="true" />
          </template>
        </div>
        <!-- 换日期 / 地区：旧列表留着等新的，快的直接换成新列表（错峰浮现），慢了（250ms）才淡入骨架 -->
        <ContentSwap :pending="waiting()">
          <SkeletonGrid v-if="waiting()" :count="10" gap="g16" fill />
          <div v-else-if="!feed.list.length" v-rise.self class="empty">
            {{ date === RECENT ? '还没有视频' : '这一天还没有新视频' }}
            <button v-if="date !== RECENT && quiet" type="button" class="retry" @click="select(RECENT, region)">看最近上新</button>
          </div>
          <div v-else :key="batch">
            <!-- 很长时只渲染视口附近的卡片（WinList） -->
            <div v-rise class="grid g16">
              <WinList v-slot="{ item: v }" :items="feed.list"><VideoCard :video="v" /></WinList>
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
/* 日期块只有 30px 高：能点的范围上下各撑 7px（44px，还在日期行上下 11 / 12px 的留白里）、左右各 6px（一半间距），外观不变 */
.dchip::after { content: ''; position: absolute; top: -7px; right: -6px; bottom: -7px; left: -6px; }
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
  position: relative;
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
/* 地区胶囊 29px 高：能点的范围上下各撑 8px（45px，上面 9px、下面 21px 的留白里）、左右各 4px（一半间距） */
.rp::after { content: ''; position: absolute; top: -9.5px; right: -5.5px; bottom: -9.5px; left: -5.5px; }

/* 7 天没有新视频时的说明（列表上面一行小字） */
.lt-note { padding: 12px 14px 0; color: var(--t2); font-size: 12.5px; line-height: 18px; }
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
  /* 鼠标不用撑那么大（折行时上下只隔 10px 左右） */
  .dchip::after, .rp::after { top: -4px; bottom: -4px; }
  .lt-note { padding: 12px max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad))) 0; font-size: 13px; }
}
@media (min-width: 1024px) and (hover: hover) {
  /* 日期字是 difference 混合：灰底变亮时字要换成白色才是跟着变亮（|#ff - #1f| ≈ #e0），照旧用 #a2 反而变暗 */
  .dchip:not(.on):hover { background: #1f1f1f; }
  [data-slider] > .dchip:not(.on):hover .lb { color: #fff; }
  .dchip .lb { transition: opacity var(--dur-1) var(--ease-out), color var(--dur-2) var(--ease-out); }
  .rp:not(.on):hover { background: #1f1f1f; color: var(--t3); }
}
</style>
