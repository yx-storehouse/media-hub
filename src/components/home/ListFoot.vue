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
</style>
