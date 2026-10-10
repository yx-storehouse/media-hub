<script setup>
import { computed } from 'vue'
import AIcon from './AIcon.vue'
import ABtn from './ABtn.vue'

/*
 * 空状态 / 加载失败：
 *   <EmptyState icon="video" title="还没有视频" text="可以批量导入"> <ABtn …/> </EmptyState>
 *   <EmptyState variant="error" :text="error" @retry="reload" />        加载失败：警告图标 +「重试」按钮
 * 默认插槽放引导按钮（CTA）；error 时插槽里的按钮排在「重试」后面。
 * 放在页面的卡片（.card / DataTable）里，不要单独悬在页面上。
 */
const props = defineProps({
  variant: { type: String, default: 'empty', validator: v => ['empty', 'error'].includes(v) },
  icon: { type: String, default: '' },
  title: { type: String, default: '' },
  text: { type: String, default: '' },
  /** error 时显示「重试」按钮（点了 emit retry）；没有可重试的操作时传 false */
  retry: { type: Boolean, default: true },
  /** 正在重试：按钮转圈 */
  retrying: { type: Boolean, default: false },
  /** 紧凑版（小卡片、弹窗里用） */
  compact: { type: Boolean, default: false }
})
const emit = defineEmits(['retry'])

const isError = computed(() => props.variant === 'error')
const ico = computed(() => props.icon || (isError.value ? 'warning' : 'info'))
const ttl = computed(() => props.title || (isError.value ? '加载失败' : '暂无数据'))
</script>

<template>
  <div class="empty" :class="{ error: isError, compact }" :role="isError ? 'alert' : undefined">
    <div class="ico"><AIcon :name="ico" :size="compact ? 20 : 26" :stroke="1.4" /></div>
    <p class="ttl">{{ ttl }}</p>
    <p v-if="text" class="txt">{{ text }}</p>
    <div v-if="(isError && retry) || $slots.default" class="cta">
      <ABtn v-if="isError && retry" size="sm" icon="refresh" :loading="retrying" @click="emit('retry')">重试</ABtn>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 56px 16px; text-align: center; }
.empty.compact { padding: 28px 16px; }
.ico { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 14px; border-radius: 50%; background: var(--panel-2); color: var(--t2); box-shadow: inset 0 0 0 1px var(--line); }
.compact .ico { width: 42px; height: 42px; margin-bottom: 10px; }
.error .ico { background: rgba(255, 107, 107, .08); color: var(--danger); box-shadow: inset 0 0 0 1px rgba(255, 107, 107, .25); }
.ttl { color: var(--t1); font-size: 14.5px; font-weight: 600; }
.compact .ttl { font-size: 13.5px; }
/* 宽一点 + 均衡断行，避免最后一行只剩一个字 */
.txt { max-width: 480px; margin-top: 6px; color: var(--t2); line-height: 1.6; white-space: pre-line; text-wrap: pretty; }
.cta { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 18px; }
.compact .cta { margin-top: 12px; }
</style>
