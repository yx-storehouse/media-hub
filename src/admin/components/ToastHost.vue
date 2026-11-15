<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import AIcon from './AIcon.vue'
import { toasts, dismissToast, bottomInset, rightInset } from './toast'
import { openLayers } from './layers'

/*
 * 右下角堆叠。会挡东西的几种情况：
 *   - 右侧抽屉开着：提示条放到抽屉左边（遮罩上），不盖抽屉里的输入框和按钮；
 *     窗口太窄、抽屉左边放不下一条提示（< 280px）时退回到下面那条规则。
 *   - 对话框开着：底部按钮栏固定 76px 以内，提示条整体上移。
 *   - 列表页的批量操作条：按它实际的高度（可能换成两排）再留 8px 间距。
 */
const GAP = 20
const MIN_ROOM = 280
const vw = ref(typeof window === 'undefined' ? 1280 : window.innerWidth)
const onResize = () => { vw.value = window.innerWidth }
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

const beside = computed(() => rightInset.value > 0 && vw.value - rightInset.value - GAP * 2 >= MIN_ROOM)
const right = computed(() => (beside.value ? rightInset.value + GAP : GAP))
const bottom = computed(() => Math.max(GAP, openLayers.value > 0 && !beside.value ? 76 : 0, bottomInset.value ? bottomInset.value + 8 : 0))
const maxWidth = computed(() => `calc(100vw - ${right.value + GAP}px)`)

const ICON = { info: 'info', ok: 'check-circle', error: 'warning' }
</script>

<template>
  <Teleport to="body">
    <!-- 屏幕阅读器会读出新提示；错误用 alert 级别 -->
    <TransitionGroup tag="div" name="toast" class="toast-host" :style="{ bottom: bottom + 'px', right: right + 'px', maxWidth }" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type" :role="t.type === 'error' ? 'alert' : 'status'">
        <AIcon :name="ICON[t.type] || 'info'" :size="16" />
        <span class="msg">{{ t.message }}</span>
        <button type="button" class="x" aria-label="关闭提示" @click="dismissToast(t.id)">
          <AIcon name="x" :size="14" />
        </button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: 20px;
  bottom: 20px;
  transition: bottom .2s, right .2s;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: calc(100vw - 40px);
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 200px;
  max-width: 420px;
  padding: 10px 10px 10px 14px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: #1c1c1c;
  box-shadow: var(--shadow);
  color: var(--t1);
  line-height: 1.5;
  pointer-events: auto;
}
.toast > svg { margin-top: 2px; color: var(--t2); }
.toast.ok > svg { color: var(--ok); }
.toast.error { border-color: rgba(255, 107, 107, .45); }
.toast.error > svg { color: var(--danger); }
.msg { flex: 1; min-width: 0; white-space: pre-line; word-break: break-word; }
.x { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; color: var(--t3); }
.x:hover { background: var(--hover); color: var(--t1); }

.toast-enter-active, .toast-leave-active { transition: opacity .2s, transform .2s; }
.toast-move { transition: transform .2s; }
.toast-enter-from { opacity: 0; transform: translateY(8px); }
.toast-leave-to { opacity: 0; transform: translateX(16px); }
</style>
