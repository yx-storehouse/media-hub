<script setup>
import LoadState from '@/components/common/LoadState.vue'
import { feedError } from './list'

/*
 * 分页列表的底部：加载中 / 加载失败（统一的说法 +「重试」，断网恢复、服务器恢复后自动接着加载）/ 没有更多了。
 * 首页分类 / 最新、社区、专题、搜索、创作者主页共用。feed 的 err 是最近一次的错误对象（createHomeFeed / createPagedFeed 记的）
 */
defineProps({
  /** createHomeFeed() / createPagedFeed() 的返回值 */
  feed: { type: Object, required: true }
})
</script>

<template>
  <LoadState v-if="feed.error && !feed.loading" class="lf-err" :error="feedError(feed)" :retry="() => feed.more()" inline />
  <div v-else class="lf" role="status">
    <span v-if="feed.loading">加载中…</span>
    <span v-else-if="feed.done">没有更多了</span>
  </div>
</template>

<style scoped>
.lf { display: grid; place-items: center; height: 52px; color: var(--t2); font-size: 13px; }
/* 出错时：一行说明 + 重试，上下留白比空状态小（inline），和列表贴得近一点 */
.lf-err.ls.inline { padding: 14px 0 18px; }

/* 桌面布局（≥ 1024px）：网格下面多留一点（行距 28px 的网格贴着一行小字太挤） */
@media (min-width: 1024px) {
  .lf { height: 64px; margin-top: 8px; }
  .lf-err.ls.inline { padding: 20px 0 24px; }
}
</style>
