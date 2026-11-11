<script setup>
import { ref, shallowRef, watch, nextTick } from 'vue'
import { getLiveTabs, getLives } from '@/api'
import { toast } from '@/composables/useToast'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { useScrollEdge } from '@/components/motion/scrollEdge'
import { isDesktop } from '@/composables/useDesktop'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

defineOptions({ name: 'LiveView' })

const tabs = shallowRef([])
const active = ref(0)
const lives = shallowRef([])
const scroller = ref(null)
useKeepScroll(scroller)

const failed = ref(false)

async function loadLives() {
  const tab = active.value
  try {
    const list = await getLives({ tab })
    if (tab !== active.value) return   // 用户已经切到别的 tab，丢弃这次结果
    lives.value = list
    failed.value = false
  } catch {
    if (tab === active.value) failed.value = true
  }
}

function selectTab(i) {
  if (i === active.value) return
  active.value = i
  loadLives()
}

getLiveTabs().then(list => { tabs.value = list }).catch(() => {})
loadLives()

/*
 * 桌面布局：标签行平时没有底线，卡片从它下面滚过去时才出现细线和淡阴影（和社区、BackHeader 一样，
 * components/motion/scrollEdge.js）。手机布局不看（底线一直都在，也不往滚动区里放哨兵）；窗口跨过 1024px 时重新取一次。
 */
const hd = ref(null)
const edge = useScrollEdge(hd, () => (isDesktop.value ? [scroller.value] : []))
watch(isDesktop, () => nextTick(edge.refresh))
</script>

<template>
  <div class="page live">
    <header ref="hd" class="bar-hd" :class="{ 'm-edge': isDesktop }">
      <div class="ct-tabs" role="tablist">
        <button
          v-for="(name, i) in tabs"
          :key="name"
          class="ct-tab"
          :class="{ on: i === active }"
          role="tab"
          :aria-selected="i === active"
          @click="selectTab(i)"
        >
          {{ name }}
        </button>
      </div>
      <!-- 桌面布局顶栏里就有搜索框：这个手机上的搜索按钮藏起来（.m-only） -->
      <button class="ct-search round m-only" aria-label="搜索" @click="toast('搜索功能即将上线')"><Icon name="search" /></button>
    </header>

    <div ref="scroller" class="scroll">
      <div v-if="failed" class="empty">
        加载失败，请稍后重试
        <button class="retry" @click="loadLives()">重试</button>
      </div>
      <div v-else class="lv-grid">
        <div v-for="item in lives" :key="item.id" v-press class="lv" @click="toast('主播暂未开播，敬请期待')">
          <Cover class="cv" v-bind="item.cover">
            <span class="badge"><i />LIVE</span>
            <span class="vw">{{ item.viewers }}</span>
          </Cover>
          <div class="bt">
            <b>{{ item.title }}</b>
            <span>{{ item.sub }}</span>
          </div>
        </div>
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
.ct-search.round { flex: 0 0 34px; justify-content: center; padding: 0; }

.lv-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 11px; padding: 12px 14px 0; }
.lv { position: relative; cursor: pointer; }
.lv .cv { aspect-ratio: 3 / 4; border-radius: 10px; }
/* darken top and bottom so the badges and the title stay readable on any cover */
.lv .cv::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, .28) 0%, rgba(0, 0, 0, 0) 28%, rgba(0, 0, 0, 0) 58%, rgba(0, 0, 0, .72) 100%);
}

.badge {
  position: absolute;
  left: 8px;
  top: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 7px 0 6px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .3px;
}
.badge i { width: 5px; height: 5px; border-radius: 50%; background: var(--on-accent); animation: blink 1.1s infinite; }
.vw {
  position: absolute;
  right: 8px;
  top: 8px;
  z-index: 2;
  height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  background: rgba(0, 0, 0, .42);
  font-size: 10.5px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

.bt { position: absolute; left: 9px; right: 9px; bottom: 8px; z-index: 2; }
.bt b { display: block; overflow: hidden; font-size: 13px; font-weight: 600; line-height: 18px; white-space: nowrap; text-overflow: ellipsis; }
.bt span { display: block; overflow: hidden; color: rgba(255, 255, 255, .72); font-size: 11px; line-height: 15px; white-space: nowrap; text-overflow: ellipsis; }

/* iOS 14 / WebView 87 兜底：3:4（common.css 的 .cv::before 改个比例） */
@supports not (aspect-ratio: 1 / 1) {
  .lv .cv::before { padding-top: 133.3333%; }
}

/*
 * ---- 桌面布局（≥ 1024px）----
 * 分类标签一行靠左（和下面的卡片、其他页面的内容边对齐），64px 高、平时没有底线（和社区的标签行一样）；
 * 3:4 的直播卡片按 200px 自动排列数（1440 宽的窗口一行 5 张），最宽 --desk-max、居中。
 * 鼠标移到卡片上封面在圆角里放大一点（和视频卡片一样）。
 */
@media (min-width: 1024px) {
  .live .bar-hd {
    position: relative;
    z-index: 1;
    height: 64px;
    padding: 0 max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad)));
    border-bottom-color: transparent;
  }
  .live .ct-tabs { gap: 28px; }

  .lv-grid {
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 24px 16px;
    max-width: var(--desk-max);
    margin: 0 auto;
    padding: 8px var(--desk-pad) 0;
  }
  .lv .cv { border-radius: 12px; }
  .badge { left: 10px; top: 10px; height: 20px; padding: 0 8px 0 7px; border-radius: 10px; font-size: 11px; }
  .vw { right: 10px; top: 10px; height: 20px; padding: 0 8px; border-radius: 10px; font-size: 12px; line-height: 20px; }
  .bt { left: 12px; right: 12px; bottom: 12px; }
  .bt b { font-size: 15px; line-height: 22px; }
  .bt span { font-size: 13px; line-height: 18px; }
  .live .pad-b { height: 32px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .lv .cv > :deep(img) { transition: opacity var(--dur-3) var(--ease-out), filter var(--dur-3) var(--ease-out), transform var(--dur-4) var(--ease-out); }
  .lv .cv > :deep(img.now) { transition: transform var(--dur-4) var(--ease-out); }
  .lv:hover .cv > :deep(img) { transform: scale(1.03); }
}
</style>
