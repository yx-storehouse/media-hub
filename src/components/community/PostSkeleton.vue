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

/* iOS 14 / 安卓 WebView 87 不认 aspect-ratio（Safari 15、Chrome 88 才有）：里面全是绝对定位的东西，高度会是 0，用 ::before 的 padding 撑出同样的比例 */
@supports not (aspect-ratio: 1 / 1) {
  .md::before { content: ''; display: block; padding-top: 56.25%; }
}

/* 桌面布局（≥ 1024px）：和帖子卡片（PostCard.vue）一样是一张张圆角卡片，位置、大小对得上，换成内容时不跳 */
@media (min-width: 1024px) {
  .sk-post {
    gap: 12px;
    padding: 18px 20px 20px;
    border-bottom: 0;
    border-radius: 16px;
    background: var(--panel);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06);
  }
  .sk-post + .sk-post { margin-top: 12px; }
  .l1 { width: 32%; margin-top: 4px; }
  .l2 { width: 78%; margin-top: 14px; }
  .md { margin-top: 18px; border-radius: 12px; }
}
</style>
