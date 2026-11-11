<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isDesktop } from '@/composables/useDesktop'

/*
 * 视频卡片网格的骨架：数据回来前占住和真卡片一样的位置，内容到了不往下推。
 * 卡片尺寸直接用 .vc / .cv / .tt（common.css），卡片样式改了这里跟着变。
 *
 * 桌面布局（≥ 1024px）：
 *   - 每张卡片多一条信息行的骨架（和 VideoCard 桌面上的「作者 · 播放数」一样高）；
 *   - deskCount：桌面上画几张（不给就用 count）；
 *   - fill：桌面上按真网格的列数画满一屏（自己量列数和卡片高度，窗口变宽变窄跟着变），列表页首屏不会只有半屏骨架；
 *   - feature：第一张是 2 列 × 2 行的大卡片（推荐页第一个分区，和 VideoCard 的 feature 一样）。
 */
const props = defineProps({
  /** 卡片数 */
  count: { type: Number, default: 6 },
  /** 第一张是通栏大卡（推荐分区的 featured） */
  big: Boolean,
  /** 网格行距：和真网格同一个修饰类，如 'g16' */
  gap: { type: String, default: '' },
  /** 桌面布局画几张（null = 用 count） */
  deskCount: { type: Number, default: null },
  /** 桌面布局画满一屏（按实际列数取整行） */
  fill: Boolean,
  /** 桌面布局第一张占 2 列 × 2 行 */
  feature: Boolean
})

const root = ref(null)
/* fill 量出来的张数；0 = 还没量（或不在桌面布局） */
const fillN = ref(0)

const n = computed(() => {
  if (!isDesktop.value) return props.count
  if (props.fill && fillN.value) return fillN.value
  return props.deskCount ?? props.count
})

/*
 * 列数直接读网格算好的列（grid-template-columns 的计算值是一列一个长度）；行高 = 第一张卡片的高度 + 行距。
 * 从网格上沿到窗口底边能放几行就画几行（多出来的一行在屏幕外，不要紧）。
 */
function measure() {
  raf = 0
  const el = root.value
  if (!props.fill || !isDesktop.value || !el || !el.isConnected || !el.clientWidth) return
  const cs = getComputedStyle(el)
  const cols = cs.gridTemplateColumns.split(' ').filter(s => s && s !== 'none').length || 1
  const card = el.querySelector('.vc:not(.feat)')
  const rowH = (card ? card.offsetHeight : 240) + (parseFloat(cs.rowGap) || 0)
  const top = Math.max(0, el.getBoundingClientRect().top)
  const rows = Math.max(2, Math.ceil((window.innerHeight - top) / Math.max(120, rowH)))
  fillN.value = cols * rows
}
let raf = 0
let ro = null
let lastW = -1
const schedule = () => { if (!raf) raf = requestAnimationFrame(measure) }
onMounted(() => {
  if (!props.fill) return
  // 只跟宽度变：画多了几行高度会变，再量一次也是同样的列数和行高
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      const w = root.value ? root.value.clientWidth : 0
      if (w !== lastW) { lastW = w; schedule() }
    })
    ro.observe(root.value)
  }
  schedule()
})
watch(isDesktop, schedule)
onBeforeUnmount(() => {
  ro?.disconnect()
  cancelAnimationFrame(raf)
})
</script>

<template>
  <div ref="root" class="grid sk-grid" :class="gap" aria-hidden="true">
    <div v-for="i in n" :key="i" class="vc" :class="{ big: big && i === 1, feat: feature && isDesktop && i === 1 }">
      <div class="cv sk" />
      <div class="tt"><span class="sk sk-tt" /></div>
      <div v-if="isDesktop" class="sk-meta"><span class="sk" /></div>
    </div>
  </div>
</template>

<style scoped>
.sk-grid .vc { cursor: default; }
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.cv.sk { border-radius: 8px; }
/* 行内块：高度由 .tt 的行高决定，和真标题一样高 */
.sk-tt { display: inline-block; width: 70%; height: 12px; vertical-align: middle; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}

/* ---- 桌面布局：卡片尺寸跟着 common.css 的桌面规则走；信息行和 VideoCard 的 .vc-meta 一样高（4px + 18px） ---- */
@media (min-width: 1024px) {
  .cv.sk { border-radius: 10px; }
  .sk-tt { width: 76%; height: 14px; }
  .sk-meta { height: 18px; margin-top: 4px; }
  .sk-meta .sk { display: block; width: 44%; height: 12px; margin-top: 3px; }
  /* 2 列 × 2 行的大卡片（同 VideoCard 的 .vc.feat） */
  .grid > .vc.feat { display: flex; flex-direction: column; grid-column: span 2; grid-row: span 2; }
  .vc.feat > .cv { flex: 1 1 0; min-height: 0; aspect-ratio: auto; border-radius: 12px; }
  .vc.feat .tt { flex: none; min-height: 0; margin-top: 12px; line-height: 26px; }
  .vc.feat .sk-tt { width: 54%; height: 18px; }
  .vc.feat .sk-meta { flex: none; height: 20px; margin-top: 6px; }
  .vc.feat .sk-meta .sk { width: 30%; height: 14px; }
}
</style>
