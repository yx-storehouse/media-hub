<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { isDesktop } from '@/composables/useDesktop'
import { scrollBehavior } from '@/utils/motion'
import Icon from '@/components/Icon.vue'

/*
 * 横向滚动行（.hs）两头的 ‹ › 按钮：桌面上用鼠标不用 shift + 滚轮也能看到后面的内容（触控板横划照常能滚）。
 *
 *   <div class="xx-wrap">                         <!-- 要有定位：position: relative -->
 *     <div ref="row" class="chips hs">…</div>
 *     <HsArrows :target="row" />                   <!-- 模板 ref（元素或组件实例都行） -->
 *   </div>
 *
 * 只在桌面布局显示；能往哪边滚才显示哪边的按钮（滚动、行变宽变窄、内容增减时都跟着变）；
 * 点一下滚过大约 80% 的可见宽度（step 可改），减少动态效果时直接跳过去。
 * 按钮贴在定位祖先的左右两边、上下居中，下面一道从背景色到透明的渐变把被盖住的内容压暗；渐变本身不接鼠标。
 * 按钮不进 Tab 顺序（键盘用户 Tab 到行里的元素时浏览器会自己把它滚出来）。
 */
const props = defineProps({
  /** 横向滚动的那个元素（或它的组件实例） */
  target: { type: null, default: null },
  /** 一次滚过可见宽度的多少 */
  step: { type: Number, default: 0.8 }
})

const canL = ref(false)
const canR = ref(false)
let el = null
let ro = null
let mo = null
let raf = 0

function measure() {
  raf = 0
  if (!el || !el.isConnected) { canL.value = canR.value = false; return }
  const max = el.scrollWidth - el.clientWidth
  canL.value = el.scrollLeft > 1
  canR.value = max - el.scrollLeft > 1
}
const schedule = () => { if (!raf) raf = requestAnimationFrame(measure) }

function detach() {
  if (el) el.removeEventListener('scroll', schedule)
  ro?.disconnect()
  mo?.disconnect()
  ro = mo = null
  el = null
}
function attach(t) {
  detach()
  const node = t && (t.$el || t)
  if (!isDesktop.value || !(node instanceof Element)) { canL.value = canR.value = false; return }
  el = node
  el.addEventListener('scroll', schedule, { passive: true })
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(schedule)
    ro.observe(el)
  }
  if (typeof MutationObserver === 'function') {
    mo = new MutationObserver(schedule)
    mo.observe(el, { childList: true, subtree: true })
  }
  schedule()
}
watch(() => [props.target, isDesktop.value], ([t]) => attach(t), { immediate: true, flush: 'post' })
onBeforeUnmount(() => {
  detach()
  cancelAnimationFrame(raf)
})

function go(dir) {
  if (!el) return
  el.scrollBy({ left: dir * Math.max(80, el.clientWidth * props.step), behavior: scrollBehavior() })
}
</script>

<template>
  <template v-if="isDesktop">
    <div v-show="canL" class="hsa l">
      <button type="button" tabindex="-1" aria-label="向左滚动" @click="go(-1)"><Icon name="chevL" /></button>
    </div>
    <div v-show="canR" class="hsa r">
      <button type="button" tabindex="-1" aria-label="向右滚动" @click="go(1)"><Icon name="chevR" /></button>
    </div>
  </template>
</template>

<style scoped>
.hsa {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  width: 72px;
  pointer-events: none;
}
.hsa.l { left: 0; justify-content: flex-start; background: linear-gradient(90deg, var(--bg) 40%, rgba(10, 10, 10, 0)); }
.hsa.r { right: 0; justify-content: flex-end; background: linear-gradient(270deg, var(--bg) 40%, rgba(10, 10, 10, 0)); }
.hsa button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #1f1f1f;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08);
  color: var(--t3);
  pointer-events: auto;
  transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.hsa button svg { width: 16px; height: 16px; stroke-width: 2.4; }
@media (hover: hover) {
  .hsa button:hover { background: #2a2a2a; color: var(--t1); }
}
</style>
