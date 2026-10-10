<script setup>
import { computed } from 'vue'
import { useFieldContext } from './formField'

/*
 * 日期时间：v-model 是 unix 秒（或 null）。
 * 用原生 datetime-local，按本地时区换算（不用 new Date('YYYY-MM-DD…') 那种会按 UTC 解析的写法）。
 */
const props = defineProps({
  modelValue: { type: Number, default: null },
  disabled: { type: Boolean, default: false },
  /** 显示「清空」按钮（可为空的字段） */
  clearable: { type: Boolean, default: false },
  /** 显示「现在」快捷按钮 */
  nowButton: { type: Boolean, default: true },
  id: { type: String, default: '' },
  invalid: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const f = useFieldContext(props)
const p2 = n => String(n).padStart(2, '0')

const local = computed(() => {
  if (props.modelValue == null || !Number.isFinite(props.modelValue)) return ''
  const d = new Date(props.modelValue * 1000)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`
})

function onChange(e) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(e.target.value)
  if (!m) return emit('update:modelValue', null)
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))
  emit('update:modelValue', Math.floor(d.getTime() / 1000))
}
const setNow = () => emit('update:modelValue', Math.floor(Date.now() / 1000))
</script>

<template>
  <div class="dt">
    <input
      :id="f.id.value"
      class="a-input num"
      type="datetime-local"
      :value="local"
      :disabled="disabled"
      :aria-invalid="f.invalid.value || undefined"
      :aria-describedby="f.describedBy.value"
      @change="onChange"
    >
    <button v-if="nowButton && !disabled" type="button" class="mini" @click="setNow">现在</button>
    <button v-if="clearable && modelValue != null && !disabled" type="button" class="mini" @click="emit('update:modelValue', null)">清空</button>
  </div>
</template>

<style scoped>
.dt { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dt .a-input { flex: 1; }
.mini { flex: none; height: 32px; padding: 0 8px; border-radius: 6px; color: var(--t2); font-size: 12px; }
.mini:hover { background: var(--hover); color: var(--t1); }
</style>
