<script setup>
import { ref, shallowRef } from 'vue'
import { getRecommendSections } from '@/api'
import RecommendSection from '@/components/home/RecommendSection.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'
import { toTopOrRefresh } from '@/components/home/list'
import { useKeepScroll } from '@/composables/useKeepScroll'

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
            <RecommendSection v-for="s in sections" ref="secRefs" :key="s.id" :section="s" />
          </div>
          <div v-else aria-hidden="true">
            <!-- 分区标题 + 卡片 + 按钮的骨架，和真分区一样的尺寸 -->
            <section v-for="i in 2" :key="i" class="sec-sk">
              <div class="hd"><span class="sk t" /></div>
              <SkeletonGrid :count="i === 1 ? 5 : 4" :big="i === 1" />
              <div class="btns"><span class="sk" /><span class="sk" /></div>
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
</style>
