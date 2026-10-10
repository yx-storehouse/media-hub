<script setup>
/*
 * 页头：标题 + 副标题（常放「共 N 条」）+ 右侧操作按钮。
 * <PageHeader title="视频" :subtitle="`共 ${total} 条`"><template #actions>…</template></PageHeader>
 */
defineProps({
  title: { type: String, required: true },
  subtitle: { type: [String, Number], default: '' }
})
</script>

<template>
  <header class="page-hd">
    <div class="txt">
      <h1 class="ttl">{{ title }}</h1>
      <p v-if="subtitle !== '' && subtitle != null" class="sub">{{ subtitle }}</p>
      <slot />
    </div>
    <div v-if="$slots.actions" class="acts">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
/* 最小高度按「有一排按钮」算：没有按钮的页面（或按钮按步骤出现 / 消失）标题位置也不跳 */
.page-hd { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 12px 16px; min-height: 66px; padding: 20px 24px 14px; }
.txt { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-width: 180px; }
.ttl { font-size: 19px; font-weight: 650; letter-spacing: .01em; line-height: 1.3; }
.sub { color: var(--t2); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
</style>
