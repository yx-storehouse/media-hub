<script setup>
import AModal from './AModal.vue'
import ABtn from './ABtn.vue'
import AIcon from './AIcon.vue'
import { confirmState as s, settleConfirm } from './confirm'

/* 危险操作默认把焦点放在「取消」上，误按回车不会直接删掉东西 */
</script>

<template>
  <AModal :open="s.open" :title="s.title" :width="420" @update:open="v => !v && settleConfirm(false)">
    <div class="msg-wrap">
      <AIcon v-if="s.danger" class="ico" name="warning" :size="20" />
      <p class="msg">{{ s.message }}</p>
    </div>
    <template #footer>
      <ABtn :data-autofocus="s.danger ? '' : undefined" @click="settleConfirm(false)">{{ s.cancelText }}</ABtn>
      <ABtn :variant="s.danger ? 'danger' : 'primary'" :data-autofocus="s.danger ? undefined : ''" @click="settleConfirm(true)">
        {{ s.confirmText }}
      </ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.msg-wrap { display: flex; gap: 12px; }
.ico { margin-top: 1px; color: var(--danger); }
.msg { flex: 1; min-width: 0; color: var(--t1); line-height: 1.65; white-space: pre-line; word-break: break-word; }
</style>
