<script setup>
import { computed } from 'vue'

/*
 * 状态徽标。
 *   kind="content"（视频 / 帖子 / 专题）：1 已发布 · 0 草稿 · 2 已下架
 *   kind="creator"（创作者、分区、账号）：1 正常 · 0 停用
 * 也可以用 label 覆盖文字（如分区的「启用 / 停用」）。
 */
const props = defineProps({
  status: { type: [Number, String], default: null },
  kind: { type: String, default: 'content', validator: v => ['content', 'creator'].includes(v) },
  label: { type: String, default: '' }
})

const MAP = {
  content: { 1: ['已发布', 'on'], 0: ['草稿', 'draft'], 2: ['已下架', 'off'] },
  creator: { 1: ['正常', 'on'], 0: ['停用', 'off'] }
}
const info = computed(() => MAP[props.kind][Number(props.status)] || [String(props.status ?? '—'), 'draft'])
</script>

<template>
  <span class="badge" :class="info[1]">
    <i class="dot" aria-hidden="true" />{{ label || info[0] }}
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  font-size: 11.5px;
  line-height: 20px;
  white-space: nowrap;
  vertical-align: middle;
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
/* 已发布：深色底白字，最醒目 */
.on { background: #262626; color: var(--t1); box-shadow: inset 0 0 0 1px #3a3a3a; }
.on .dot { background: var(--ok); }
/* 草稿：灰 */
.draft { background: transparent; color: var(--t2); box-shadow: inset 0 0 0 1px var(--line-2); }
.draft .dot { background: transparent; box-shadow: inset 0 0 0 1.5px currentColor; }
/* 下架 / 停用：更暗 */
.off { background: transparent; color: var(--t3); box-shadow: inset 0 0 0 1px #2a2a2a; }
</style>
