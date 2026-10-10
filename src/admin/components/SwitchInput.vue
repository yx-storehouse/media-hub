<script setup>
import { useFieldContext } from './formField'

/*
 * 开关：<SwitchInput v-model="form.isHot" />，可带右侧文字 label。
 * 用真正的 <button role="switch">，空格 / 回车都能切换。
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '' },
  /** 表格里用的小号 */
  size: { type: String, default: 'md' },
  id: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'change'])

const f = useFieldContext(props)
function toggle() {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
  emit('change', !props.modelValue)
}
</script>

<template>
  <button
    :id="f.id.value"
    type="button"
    role="switch"
    class="sw"
    :class="[size, { on: modelValue }]"
    :aria-checked="modelValue ? 'true' : 'false'"
    :disabled="disabled"
    :aria-describedby="f.describedBy.value"
    @click="toggle"
  >
    <span class="track"><i class="knob" /></span>
    <span v-if="label" class="lbl">{{ label }}</span>
  </button>
</template>

<style scoped>
.sw { display: inline-flex; align-items: center; gap: 8px; min-height: 24px; color: var(--t2); vertical-align: middle; }
.sw:disabled { opacity: .45; }
.track { position: relative; width: 34px; height: 20px; border-radius: 10px; background: #2e2e2e; box-shadow: inset 0 0 0 1px #3a3a3a; transition: background .15s; }
.knob { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #9a9a9a; transition: transform .15s, background .15s; }
.on .track { background: var(--accent); box-shadow: none; }
.on .knob { background: var(--on-accent); transform: translateX(14px); }
.sw.sm .track { width: 28px; height: 16px; border-radius: 8px; }
.sw.sm .knob { top: 2px; left: 2px; width: 12px; height: 12px; }
.sw.sm.on .knob { transform: translateX(12px); }
.lbl { color: var(--t1); font-size: 13px; }
</style>
