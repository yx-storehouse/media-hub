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
</style>
