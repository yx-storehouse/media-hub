<script setup>
import { ref } from 'vue'
import Icon from './Icon.vue'
import { useBack } from '@/composables/useBack'
import { useScrollEdge } from '@/components/motion/scrollEdge'

/* Header for simple sub pages: back arrow + title. */
defineProps({ title: { type: String, default: '' } })
const back = useBack()

/*
 * 内容从顶栏下面滚过去时，底边细线变亮、下面一道淡阴影（components/motion/scrollEdge.js）。
 * 看的是同一页里和顶栏并排的滚动容器（.scroll）：列表换成骨架 / 空状态（v-if）、几个标签轮流显示（v-show）都跟得上。
 */
const hd = ref(null)
useScrollEdge(hd, () => {
  const page = hd.value?.parentElement
  return page ? [...page.children].filter(el => el.classList.contains('scroll')) : []
}, { watchParent: true })
</script>

<template>
  <div ref="hd" class="sub-hd m-edge">
    <!-- m-press-sm：按下缩一点、松手带回弹（components/motion/press.js） -->
    <button class="sh-back m-press-sm" aria-label="返回" @click="back"><Icon name="chevL" /></button>
    <slot>{{ title }}</slot>
  </div>
</template>

<style>
.sub-hd {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 14px 0 12px;
  border-bottom: 1px solid var(--line);
  font-size: 16px;
  font-weight: 600;
}
.sub-hd .sh-back { margin: 0; }

/*
 * 桌面布局（≥ 1024px）：干净的页面标题行——返回键（圆形，鼠标移上去有底色）+ 20px 标题，没有通栏的底线
 * （内容滚过去时 m-edge 的细线和淡阴影照旧出现）。左右和页面内容对齐：内容宽度默认是 .desk-wrap 的
 * （--desk-max 减去两边 --desk-pad），单栏页面在自己的 .page 上设 --desk-hd-w: var(--desk-col) 就和 .desk-col 对齐。
 * 返回键往左挪出 8px：箭头本身和下面内容的左边缘对齐。
 */
@media (min-width: 1024px) {
  .sub-hd {
    gap: 8px;
    height: 64px;
    padding: 0 max(var(--desk-pad), calc((100% - var(--desk-hd-w, calc(var(--desk-max) - 2 * var(--desk-pad)))) / 2));
    border-bottom-color: transparent;
    font-size: 20px;
    line-height: 28px;
  }
  .sub-hd .sh-back { width: 36px; height: 36px; margin-left: -8px; border-radius: 50%; transition: background-color var(--dur-2) var(--ease-out); }
  .sub-hd .sh-back svg { width: 22px; height: 22px; }
  .sub-hd .sh-back::after { inset: -4px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .sub-hd .sh-back:hover { background: var(--chip); }
}
</style>
