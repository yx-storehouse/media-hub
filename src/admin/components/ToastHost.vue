<script setup>
import { computed } from 'vue'
import AIcon from './AIcon.vue'
import { toasts, dismissToast, bottomInset } from './toast'
import { openLayers } from './layers'

/*
 * 抽屉 / 对话框的底部按钮、列表页的批量操作条都在右下角：提示条整体上移。
 * 弹层底部按钮栏固定 76px 以内；批量操作条按它实际的高度（可能换成两排）再留 8px 间距。
 */
const bottom = computed(() => Math.max(20, openLayers.value > 0 ? 76 : 0, bottomInset.value ? bottomInset.value + 8 : 0))

const ICON = { info: 'info', ok: 'check-circle', error: 'warning' }
</script>

<template>
  <Teleport to="body">
    <!-- 屏幕阅读器会读出新提示；错误用 alert 级别 -->
    <TransitionGroup tag="div" name="toast" class="toast-host" :style="{ bottom: bottom + 'px' }" aria-live="polite">
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
  transition: bottom .2s;
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
