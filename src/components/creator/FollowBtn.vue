<script setup>
import Icon from '@/components/Icon.vue'

/*
 * 关注按钮（创作者主页、帖子详情、我的关注共用）：「+ 关注」和「✓ 已关注」叠在同一格里，
 * 状态变了两者交叉淡入淡出、轻微缩放，底色跟着过渡，「✓」一笔画出来；按下去立刻缩一点，松手回弹（全局 m-press）。
 * 两种文字都占着位置，按钮宽度不会跳。尺寸、颜色由父组件的 class 定（.on 是已关注）；
 * 第一次显示时直接是对应的状态，不播动画（只有状态真的变了才动）。
 *
 *   <FollowBtn class="cr-follow" :on="following" :aria-label="…" @click="onFollow" />
 */
defineProps({
  /** 已关注 */
  on: Boolean
})
</script>

<template>
  <button type="button" class="fb m-press" :class="{ on }" :aria-pressed="on">
    <span class="fb-l fb-add" aria-hidden="true"><Icon name="plus" />关注</span>
    <span class="fb-l fb-done" aria-hidden="true">
      <svg class="ic fb-ck" viewBox="0 0 24 24" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>已关注
    </span>
  </button>
</template>

<style scoped>
.fb {
  position: relative;
  display: inline-grid;
  place-items: center;
  transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}
/*
 * 两种文字叠在同一格。藏起来的那个淡出后再 visibility: hidden（文字不算在按钮的内容里，也不会被选中），
 * 要出现的那个立刻可见再淡入
 */
.fb-l {
  display: flex;
  grid-area: 1 / 1;
  align-items: center;
  justify-content: center;
  gap: 3px;
  white-space: nowrap;
  transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out), visibility 0s;
}
.fb-l svg { width: 1em; height: 1em; stroke-width: 3; }
.fb-done,
.on .fb-add {
  opacity: 0;
  transform: scale(.8);
  visibility: hidden;
  transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out), visibility 0s linear var(--dur-2);
}
.on .fb-done {
  opacity: 1;
  transform: none;
  visibility: visible;
  transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out), visibility 0s;
}
/* 「✓」一笔画出来：比文字晚一点开始 */
.fb-ck { stroke-dasharray: 20; stroke-dashoffset: 20; transition: stroke-dashoffset var(--dur-1) var(--ease-in); }
.on .fb-ck { stroke-dashoffset: 0; transition: stroke-dashoffset var(--dur-3) var(--ease-out) var(--dur-1); }
</style>
