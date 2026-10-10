<script setup>
import Thumb from '../../components/Thumb.vue'
import { fmtCount } from '../../utils/format'

/*
 * 专题页头图预览：和前台专题页一样，4 张竖图并排 + 底部渐变 + 名称 / 播放 / 收藏。
 * 没填的格子在前台会用生成的占位图补上，这里标「自动」。
 */
defineProps({
  covers: { type: Array, default: () => [] },
  name: { type: String, default: '' },
  playsCount: { type: Number, default: 0 },
  favCount: { type: Number, default: 0 }
})
</script>

<template>
  <figure class="hero" aria-label="专题页头图预览">
    <div class="mos">
      <div v-for="k in 4" :key="k" class="cell">
        <Thumb :src="covers[k - 1] || ''" width="100%" :ratio="1 / 2" />
        <span class="no num">{{ k }}</span>
        <span v-if="!covers[k - 1]" class="auto">自动</span>
      </div>
    </div>
    <figcaption class="info">
      <b class="ellipsis">{{ name.trim() || '专题名称' }}</b>
      <span class="st">{{ fmtCount(playsCount) }}次播放 · {{ fmtCount(favCount) }}收藏</span>
    </figcaption>
  </figure>
</template>

<style scoped>
/* 按手机宽度（402px）等比缩放：4 张 1:2 的竖图，整体高度是宽度的一半，和前台 200px 高的头图一致 */
.hero { position: relative; width: 100%; max-width: 402px; overflow: hidden; border-radius: 8px; background: #161616; box-shadow: inset 0 0 0 1px var(--line); }
.mos { display: flex; }
.cell { position: relative; flex: 1; min-width: 0; }
.cell :deep(.thumb) { border-radius: 0; box-shadow: none; }
.hero::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, .18) 0%, rgba(10, 10, 10, 0) 35%, rgba(10, 10, 10, .78) 78%, rgba(10, 10, 10, .95) 100%);
  pointer-events: none;
}
.no { position: absolute; top: 6px; left: 6px; z-index: 1; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: rgba(0, 0, 0, .55); color: var(--t2); font-size: 11px; }
.auto { position: absolute; top: 34%; left: 50%; z-index: 1; padding: 1px 6px; border: 1px dashed #444; border-radius: 4px; color: var(--t3); font-size: 11px; transform: translateX(-50%); white-space: nowrap; }
.info { position: absolute; right: 14px; bottom: 11px; left: 14px; z-index: 2; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.info b { font-size: 16px; font-weight: 700; line-height: 22px; text-shadow: 0 1px 8px rgba(0, 0, 0, .5); }
.st { color: #d8d8d8; font-size: 12px; }
</style>
