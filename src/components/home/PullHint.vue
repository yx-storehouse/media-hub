<script setup>
import { computed } from 'vue'
import Icon from '@/components/Icon.vue'
import { PULL_TRIGGER } from './gestures'

/*
 * 下拉刷新的提示条（首页各分类、社区；样子同短视频的）：拉的时候跟着手指往下走、图标跟着转，
 * 「下拉刷新」→ 拉够了「松手刷新」→ 松手后「正在刷新」转圈，刷新完收起。
 *   <PullHint :pull="pull" :busy="refreshing" />
 * busy：别的方式触发的刷新（再点一次底部 Tab）也显示「正在刷新」。
 * 位置：页面上的 --pull-top（离页面顶上多远，默认在 51.5px 高的标签栏下面）。
 */
const props = defineProps({
  /** usePullRefresh() 的返回值 */
  pull: { type: Object, required: true },
  busy: Boolean
})

const spinning = computed(() => props.busy || props.pull.busy)
const ready = computed(() => props.pull.y >= PULL_TRIGGER)
const style = computed(() => (props.pull.on ? { transform: `translate3d(-50%, ${Math.min(props.pull.y * 0.5, 64)}px, 0)` } : undefined))
</script>

<template>
  <Transition name="ph-pill">
    <div v-if="pull.on || spinning" class="ph-pill" :class="{ spin: spinning && !pull.on }" role="status" :style="style">
      <Icon name="refresh" :style="pull.on ? { transform: `rotate(${pull.y * 3}deg)` } : undefined" />
      {{ pull.on ? (ready ? '松手刷新' : '下拉刷新') : '正在刷新…' }}
    </div>
  </Transition>
</template>

<style scoped>
.ph-pill {
  position: absolute;
  top: var(--pull-top, calc(var(--safe-t) + 62px));
  left: 50%;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 14px 0 11px;
  border-radius: 14px;
  background: rgba(30, 30, 30, .92);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .4);
  color: var(--t1);
  font-size: 13px;
  white-space: nowrap;
  transform: translate3d(-50%, 0, 0);
  pointer-events: none;
}
.ph-pill svg { width: 14px; height: 14px; stroke-width: 2.4; }
.ph-pill.spin svg { animation: rot .8s linear infinite; }
/* 从上面轻轻落下，收起时淡出 */
.ph-pill-enter-active { transition: opacity var(--dur-2) var(--ease-out); }
.ph-pill-leave-active { transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in); }
.ph-pill-enter-from, .ph-pill-leave-to { opacity: 0; }
.ph-pill-leave-to { transform: translate3d(-50%, -8px, 0); }
@media (prefers-reduced-motion: reduce) {
  .ph-pill.spin svg { animation: none; }
}
</style>
