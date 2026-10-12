<script setup>
/* 帖子卡片的加载骨架（社区列表、创作者主页的「帖子」）：头像、名字、正文、16:9 主图的位置 */
defineProps({
  count: { type: Number, default: 2 }
})
</script>

<template>
  <div aria-hidden="true">
    <div v-for="i in count" :key="i" class="sk-post">
      <div class="sk av" />
      <div class="bd"><div class="sk l1" /><div class="sk l2" /><div class="sk md" /></div>
    </div>
  </div>
</template>

<style scoped>
.sk-post { display: flex; gap: 11px; padding: 14px; border-bottom: 1px solid var(--line); }
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.av { flex: none; width: 44px; height: 44px; border-radius: 50%; }
.bd { flex: 1; min-width: 0; }
.l1 { width: 40%; height: 14px; margin-top: 4px; }
.l2 { width: 86%; height: 14px; margin-top: 12px; }
.md { margin-top: 12px; aspect-ratio: 16 / 9; border-radius: 7px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}
</style>
