<script setup>
/* 分页列表的底部：加载中 / 加载失败点击重试 / 没有更多了（和创作者主页一样） */
defineProps({
  /** createHomeFeed() 的返回值 */
  feed: { type: Object, required: true }
})
</script>

<template>
  <div class="lf" role="status">
    <span v-if="feed.loading">加载中…</span>
    <button v-else-if="feed.error" type="button" class="lf-more" @click="feed.more()">加载失败，点击重试</button>
    <span v-else-if="feed.done">没有更多了</span>
  </div>
</template>

<style scoped>
.lf { display: grid; place-items: center; height: 52px; color: var(--t2); font-size: 13px; }
.lf-more { height: 32px; padding: 0 14px; color: var(--t1); font-size: 13px; }

/* 桌面布局（≥ 1024px）：网格下面多留一点（行距 28px 的网格贴着一行小字太挤）；「点击重试」是个圆角小按钮，鼠标移上去有底色 */
@media (min-width: 1024px) {
  .lf { height: 64px; margin-top: 8px; }
  .lf-more { border-radius: 16px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .lf-more { transition: background-color var(--dur-2) var(--ease-out); }
  .lf-more:hover { background: #1f1f1f; }
}
</style>
