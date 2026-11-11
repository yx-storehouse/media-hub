<script setup>
import { ref, shallowRef, watch, nextTick } from 'vue'
import { getNearbyFilters, getNearby } from '@/api'
import { toast } from '@/composables/useToast'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { useScrollEdge } from '@/components/motion/scrollEdge'
import { isDesktop } from '@/composables/useDesktop'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

defineOptions({ name: 'NearbyView' })

/* 筛选项由接口给出：[{ label, category, sort_key }] */
const filters = shallowRef([])
const active = ref(0)
const items = shallowRef([])
const scroller = ref(null)
const chipRow = ref(null)
useKeepScroll(scroller, chipRow)

async function loadItems() {
  const filter = active.value
  const list = await getNearby({ filter })
  if (filter === active.value) items.value = list // ignore answers for a filter the user already left
}

function selectFilter(i) {
  if (i === active.value) return
  active.value = i
  loadItems()
}

getNearbyFilters().then(list => { filters.value = list })
loadItems()

/*
 * 桌面布局：筛选行平时没有底线，卡片从它下面滚过去时才出现细线和淡阴影（和社区、直播的标签行一样，
 * components/motion/scrollEdge.js）。手机布局不看（不往滚动区里放哨兵）；窗口跨过 1024px 时重新取一次。
 */
const edge = useScrollEdge(chipRow, () => (isDesktop.value ? [scroller.value] : []))
watch(isDesktop, () => nextTick(edge.refresh))
</script>

<template>
  <div class="page nearby">
    <header class="bar-hd nb-hd">
      <div class="city"><Icon name="tNearby" />上海<Icon name="chevD" class="dn" /></div>
      <button class="ct-search" @click="toast('搜索功能即将上线')"><Icon name="search" /><span>搜索同城好去处</span></button>
    </header>

    <!-- d-wrap：桌面上筛选项折行显示，不用横着滚 -->
    <div ref="chipRow" class="chips hs d-wrap" :class="{ 'm-edge': isDesktop }">
      <button
        v-for="(f, i) in filters"
        :key="f.label"
        class="chip"
        :class="{ on: i === active }"
        :aria-pressed="i === active"
        @click="selectFilter(i)"
      >
        {{ f.label }}
      </button>
    </div>

    <div ref="scroller" class="scroll">
      <!-- 手机上是一列，桌面布局（≥ 1024px）是两三列的卡片网格 -->
      <div class="nb-list">
        <div v-for="item in items" :key="item.id" v-press class="nb-item" @click="toast('详情页即将上线')">
          <Cover class="cv" v-bind="item.cover" />
          <div class="bd">
            <h3>{{ item.title }}</h3>
            <div class="tags">
              <span v-for="tag in item.tags" :key="tag">{{ tag }}</span>
            </div>
            <div class="ft">
              <span><Icon name="tNearby" class="pin" />{{ item.distance }}</span>
              <b>{{ item.price }}</b>
            </div>
          </div>
        </div>
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
.nb-hd { gap: 10px; }
.nb-hd .ct-search { flex: 1; }
.city { display: flex; flex: none; align-items: center; gap: 3px; font-size: 16px; font-weight: 600; }
.city svg { width: 15px; height: 15px; color: var(--accent); }
.city .dn { width: 12px; height: 12px; color: var(--t2); stroke-width: 2.8; }

.chips { padding-bottom: 8px; }

.nb-item { display: flex; gap: 11px; padding: 13px 14px; border-bottom: 1px solid var(--line); cursor: pointer; }
.nb-item .cv { flex: none; width: 112px; aspect-ratio: 1; border-radius: 8px; }
.nb-item .bd { display: flex; flex: 1; flex-direction: column; min-width: 0; padding: 1px 0; }
.nb-item h3 {
  display: -webkit-box;
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.tags span { height: 18px; padding: 0 7px; border-radius: 4px; background: #1e1e1e; color: var(--t2); font-size: 11px; line-height: 18px; }
.ft { display: flex; align-items: center; justify-content: space-between; margin-top: auto; color: var(--t2); font-size: 12px; }
.ft b { color: var(--accent); font-size: 14px; font-weight: 600; }
.ft .pin { display: inline; width: 12px; height: 12px; margin-right: 3px; vertical-align: -2px; }

/* iOS 14 / WebView 87 兜底：正方形（common.css 的 .cv::before 改个比例） */
@supports not (aspect-ratio: 1 / 1) {
  .nb-item .cv::before { padding-top: 100%; }
}

/*
 * ---- 桌面布局（≥ 1024px）----
 * 城市 + 搜索一行、筛选项一行，都和下面的卡片对齐在内容边上（最宽 --desk-max、居中）；筛选行下面平时没有线，滚动时才出现；
 * 地点是横向的卡片（方图 + 标题、标签、距离 / 价格），按 420px 自动排列数：一般两列，很宽的窗口三列。
 * 鼠标移到卡片上底色亮一点、图片在圆角里放大一点。
 */
@media (min-width: 1024px) {
  /* 顶栏、筛选行铺满整个宽度（滚动时的细线横跨整页），左右留白按「内容最宽 --desk-max、居中」算 */
  .nearby { --nb-pad: max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad))); }
  .nb-list { width: 100%; max-width: var(--desk-max); margin: 0 auto; }
  .nearby .bar-hd { gap: 24px; height: 64px; padding: 0 var(--nb-pad); border-bottom: 0; }
  .city { gap: 4px; font-size: 18px; }
  .city svg { width: 16px; height: 16px; }
  .nb-hd .ct-search { flex: 0 1 320px; height: 36px; margin-left: auto; border-radius: 18px; }
  .nearby .chips { position: relative; z-index: 1; gap: 10px; padding: 0 var(--nb-pad) 16px; }

  .nb-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 16px;
    padding: 8px var(--desk-pad) 0;
  }
  .nb-item { gap: 16px; padding: 12px; border-bottom: 0; border-radius: 14px; background: var(--panel); }
  .nb-item .cv { width: 128px; border-radius: 10px; }
  .nb-item .bd { padding: 2px 4px 2px 0; }
  .nb-item h3 { font-size: 16px; line-height: 24px; }
  .tags { gap: 6px; margin-top: 8px; }
  .tags span { height: 22px; padding: 0 8px; border-radius: 6px; font-size: 12px; line-height: 22px; }
  .ft { font-size: 13px; }
  .ft b { font-size: 16px; }
  .ft .pin { width: 13px; height: 13px; }
  .nearby .pad-b { height: 32px; }
}
@media (min-width: 1024px) and (hover: hover) {
  /* 悬停：底色亮一档、再描一圈很淡的边（生成的占位图不会放大，光靠底色看不出来）；底色停在标签底色（#1e1e1e）下面，标签不融进去 */
  .nb-item { transition: background-color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out); }
  .nb-item:hover { background: #181818; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .07); }
  .nb-item .cv > :deep(img) { transition: opacity var(--dur-3) var(--ease-out), filter var(--dur-3) var(--ease-out), transform var(--dur-4) var(--ease-out); }
  .nb-item .cv > :deep(img.now) { transition: transform var(--dur-4) var(--ease-out); }
  .nb-item:hover .cv > :deep(img) { transform: scale(1.03); }
  .city { cursor: default; }
}
</style>
