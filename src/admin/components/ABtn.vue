<script setup>
import { computed, useSlots } from 'vue'
import { RouterLink } from 'vue-router'
import AIcon from './AIcon.vue'

/*
 * 按钮：<ABtn variant="primary" icon="plus" :loading="saving" @click="save">保存</ABtn>
 *   variant: primary | default | ghost | danger；size: sm | md
 *   to  → 渲染成 RouterLink；href → 渲染成 <a>（可配 target="_blank"）；否则一定是 <button type="button">
 *   只有图标没有文字时是方形按钮，记得给 aria-label / title。
 */
const props = defineProps({
  variant: { type: String, default: 'default', validator: v => ['primary', 'default', 'ghost', 'danger'].includes(v) },
  size: { type: String, default: 'md', validator: v => ['sm', 'md'].includes(v) },
  icon: { type: String, default: '' },
  /** 图标放在文字右边 */
  iconRight: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  to: { type: [String, Object], default: null },
  href: { type: String, default: '' },
  /** 原生 type，表单里提交按钮用 submit */
  type: { type: String, default: 'button' }
})

const slots = useSlots()
const iconOnly = computed(() => !slots.default)
const off = computed(() => props.disabled || props.loading)
const cls = computed(() => ['a-btn', props.variant, props.size, { 'icon-only': iconOnly.value, 'is-loading': props.loading, 'is-disabled': off.value }])
const iconSize = computed(() => (props.size === 'sm' ? 14 : 16))

/* 链接形态的按钮被禁用时拦掉点击 */
const blockIfOff = e => { if (off.value) { e.preventDefault(); e.stopImmediatePropagation() } }
</script>

<template>
  <RouterLink v-if="to" :to="to" :class="cls" :aria-disabled="off || undefined" @click="blockIfOff">
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <AIcon v-else-if="icon" :name="icon" :size="iconSize" />
    <span v-if="$slots.default" class="lbl"><slot /></span>
    <AIcon v-if="iconRight" :name="iconRight" :size="iconSize" />
  </RouterLink>
  <a v-else-if="href" :href="href" :class="cls" :aria-disabled="off || undefined" @click="blockIfOff">
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <AIcon v-else-if="icon" :name="icon" :size="iconSize" />
    <span v-if="$slots.default" class="lbl"><slot /></span>
    <AIcon v-if="iconRight" :name="iconRight" :size="iconSize" />
  </a>
  <button v-else :type="type" :class="cls" :disabled="off" :aria-busy="loading || undefined">
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <AIcon v-else-if="icon" :name="icon" :size="iconSize" />
    <span v-if="$slots.default" class="lbl"><slot /></span>
    <AIcon v-if="iconRight" :name="iconRight" :size="iconSize" />
  </button>
</template>

<style scoped>
.a-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--t1);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: background .12s, border-color .12s, color .12s, opacity .12s;
}
.a-btn:hover:not(.is-disabled) { border-color: #474747; background: var(--hover); }
.a-btn:active:not(.is-disabled) { background: #262626; }
.a-btn.sm { gap: 4px; height: 26px; padding: 0 9px; font-size: 12.5px; }
.a-btn.icon-only { width: 32px; padding: 0; }
.a-btn.sm.icon-only { width: 26px; }

.a-btn.primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); font-weight: 600; }
.a-btn.primary:hover:not(.is-disabled) { border-color: #dcdcdc; background: #dcdcdc; }
.a-btn.primary:active:not(.is-disabled) { background: #c8c8c8; }

.a-btn.ghost { border-color: transparent; background: transparent; color: var(--t2); }
.a-btn.ghost:hover:not(.is-disabled) { border-color: transparent; background: var(--hover); color: var(--t1); }

.a-btn.danger { border-color: rgba(255, 107, 107, .35); background: rgba(255, 107, 107, .08); color: var(--danger); }
.a-btn.danger:hover:not(.is-disabled) { border-color: rgba(255, 107, 107, .6); background: rgba(255, 107, 107, .16); }

.a-btn.is-disabled { opacity: .45; cursor: not-allowed; }
.a-btn.is-loading { opacity: .75; cursor: progress; }
.a-btn .spinner { width: 14px; height: 14px; border-width: 2px; }
.lbl { display: inline-flex; align-items: center; gap: 4px; }
</style>
