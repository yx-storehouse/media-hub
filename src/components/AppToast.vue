<script setup>
import { toastState } from '@/composables/useToast'
</script>

<template>
  <div class="toast" :class="{ show: toastState.visible }" role="status" aria-live="polite">{{ toastState.text }}</div>
</template>

<style>
.toast {
  position: absolute;
  left: 50%;
  bottom: calc(var(--tabbar-h) + var(--safe-b) + 40px);
  z-index: 80;
  max-width: 82%;
  padding: 9px 16px;
  border-radius: 10px;
  background: rgba(38, 38, 38, .94);
  color: #fff;
  font-size: 13px;
  line-height: 18px;
  text-align: center;
  opacity: 0;
  transform: translate(-50%, 10px);
  transition: .2s;
  pointer-events: none;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }
</style>
