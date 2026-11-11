<script setup>
import { ref, shallowRef, watch, onMounted, onActivated, onBeforeUnmount } from 'vue'
import { getRecommendSections } from '@/api'
import RecommendSection from '@/components/home/RecommendSection.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'
import { toTopOrRefresh } from '@/components/home/list'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { isDesktop } from '@/composables/useDesktop'

/* null = 分区还没回来（先画两组骨架） */
const sections = shallowRef(null)
const failed = ref(false)
const scroller = ref(null)
useKeepScroll(scroller)
const secRefs = ref([])

async function load() {
  failed.value = false
  try {
    sections.value = await getRecommendSections()
  } catch {
    failed.value = true
  }
}

/* 已经在顶部时再点一次底部「首页」：每个分区都换一批；分区还没加载出来就重新加载 */
function refresh() {
  if (!sections.value) return failed.value ? load() : undefined
  secRefs.value.forEach(s => s?.shuffle())
}

defineExpose({ retap: () => toTopOrRefresh(scroller.value, refresh) })

/*
 * 桌面布局（≥ 1024px）：网格现在有几列（和 common.css 里桌面 .grid 的 auto-fill 同一个算法：
 * 内容宽 = min(滚动区宽, --desk-max) - 2 × --desk-pad，列宽至少 --desk-card、列距 16px）。
 * 各分区按它取整行（见 RecommendSection）。滚动区宽度变了（拉窗口、收起 / 展开左侧导航、出现滚动条）跟着变；
 * 页面被 KeepAlive 收起（脱离文档、宽度是 0）时不算，留着原来的。手机上是 0。
 */
const cols = ref(0)
function measureCols() {
  const el = scroller.value
  if (!isDesktop.value) { cols.value = 0; return }
  if (!el || !el.isConnected || !el.clientWidth) return
  const cs = getComputedStyle(el)
  const px = (name, fallback) => parseFloat(cs.getPropertyValue(name)) || fallback
  const w = Math.min(el.clientWidth, px('--desk-max', 1760)) - 2 * px('--desk-pad', 24)
  const card = px('--desk-card', 232)
  cols.value = Math.max(1, Math.floor((w + 16) / (card + 16)))
}
/*
 * ResizeObserver 的回调在布局之后、绘制之前跑：当场量、当场改列数，Vue 的更新在这之后的微任务里做完，
 * 浏览器同一帧里重新排版——收起 / 展开左侧导航、拉窗口时不会先画出一帧旧张数（缺一块 / 多出一行）。
 * 首页内容总比一屏长，滚动条一直在，换张数不会反过来改滚动区的宽度（不会来回触发）
 */
let ro = null
onMounted(() => {
  measureCols()
  if (typeof ResizeObserver === 'function' && scroller.value) {
    ro = new ResizeObserver(measureCols)
    ro.observe(scroller.value)
  }
})
onActivated(measureCols)
watch(isDesktop, () => measureCols(), { flush: 'post' })
onBeforeUnmount(() => {
  ro?.disconnect()
})

/* 骨架：手机上两组；桌面上一组大约半屏高，画三组才铺满大屏 */
const skelSections = () => (isDesktop.value ? 3 : 2)
/* 桌面骨架里每组的卡片数和大卡片：和真分区一样按列数取整行（第一组 2 × 列数 - 3 张带大卡片，其余 2 × 列数） */
const skelDesk = i => {
  const c = cols.value || 4
  return i === 1 && c >= 3 ? { count: 2 * c - 3, feat: true } : { count: 2 * c, feat: false }
}

load()
</script>

<template>
  <div>
    <div ref="scroller" class="scroll">
      <!-- 骨架原地淡出，分区接着出现（分区自己的卡片到了再浮现） -->
      <div class="m-swap">
        <Transition name="m-skel">
          <div v-if="failed" class="empty">
            加载失败，请稍后重试
            <button type="button" class="retry" @click="load()">重试</button>
          </div>
          <div v-else-if="sections">
            <RecommendSection v-for="s in sections" ref="secRefs" :key="s.id" :section="s" :cols="cols" />
          </div>
          <div v-else aria-hidden="true">
            <!-- 分区标题 + 卡片 + 按钮的骨架，和真分区一样的尺寸 -->
            <section v-for="i in skelSections()" :key="i" class="sec-sk">
              <div class="hd"><span class="sk t" /><span v-if="isDesktop" class="sk act" /><span v-if="isDesktop" class="sk act" /></div>
              <SkeletonGrid
                :count="i === 1 ? 5 : 4"
                :big="i === 1"
                :desk-count="skelDesk(i).count"
                :feature="skelDesk(i).feat"
              />
              <div class="btns m-only"><span class="sk" /><span class="sk" /></div>
            </section>
          </div>
        </Transition>
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
/* 尺寸照 RecommendSection 的 .sec / .sec-hd / .sec-btns */
.sec-sk { margin-top: 8px; padding-bottom: 12px; }
.sec-sk + .sec-sk { margin-top: 14px; }
.sec-sk .hd { display: flex; align-items: center; height: 50px; padding: 0 15px 4px 12px; }
.sec-sk .t { width: 84px; height: 16px; }
.sec-sk .btns { display: flex; gap: 11px; padding: 12px 14px 0; }
.sec-sk .btns .sk { flex: 1; height: 29px; border-radius: 8px; }
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}

/* ---- 桌面布局：同 RecommendSection 的桌面规则（标题行 56px、和网格同宽同边，分区之间 40px） ---- */
@media (min-width: 1024px) {
  .sec-sk { margin-top: 0; padding-bottom: 0; }
  .sec-sk + .sec-sk { margin-top: 40px; }
  .sec-sk .hd { gap: 8px; max-width: var(--desk-max); height: 56px; margin: 0 auto; padding: 0 var(--desk-pad) 4px; }
  .sec-sk .t { width: 96px; height: 18px; margin-right: auto; }
  .sec-sk .act { width: 72px; height: 24px; border-radius: 12px; }
  .scroll { padding-top: 4px; }
  .pad-b { height: 48px; }
}
</style>
