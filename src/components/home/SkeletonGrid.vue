<script setup>
/*
 * 视频卡片网格的骨架：数据回来前占住和真卡片一样的位置，内容到了不往下推。
 * 卡片尺寸直接用 .vc / .cv / .tt（common.css），卡片样式改了这里跟着变。
 */
defineProps({
  /** 卡片数 */
  count: { type: Number, default: 6 },
  /** 第一张是通栏大卡（推荐分区的 featured） */
  big: Boolean,
  /** 网格行距：和真网格同一个修饰类，如 'g16' */
  gap: { type: String, default: '' }
})
</script>

<template>
  <div class="grid sk-grid" :class="gap" aria-hidden="true">
    <div v-for="i in count" :key="i" class="vc" :class="{ big: big && i === 1 }">
      <div class="cv sk" />
      <div class="tt"><span class="sk sk-tt" /></div>
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
</style>
