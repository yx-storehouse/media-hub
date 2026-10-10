<script setup>
import { ref, watch, useAttrs } from 'vue'
import { useFieldContext } from './formField'

/*
 * 整数输入：v-model 是 number 或 null（清空 = null）。
 * 允许输入千分位逗号（1,200）；↑ / ↓ 键加减 step；失焦时按 min / max 收紧。
 */
const props = defineProps({
  modelValue: { type: Number, default: null },
  min: { type: Number, default: undefined },
  max: { type: Number, default: undefined },
  step: { type: Number, default: 1 },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  /** 不允许留空时，清空会回到 min（或 0） */
  required: { type: Boolean, default: false },
  size: { type: String, default: 'md' },
  id: { type: String, default: '' },
  invalid: { type: Boolean, default: false },
  /** 右侧单位文字，如「秒」「个」 */
  suffix: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])
defineOptions({ inheritAttrs: false })

/* class / style 给外层（布局用），其余属性（name、@keydown…）给真正的输入框。
   attrs 不是响应式的，所以用函数在渲染时现取，不用 computed 缓存 */
const attrs = useAttrs()
const inputAttrs = () => {
  const { class: _c, style: _s, ...rest } = attrs
  return rest
}

const f = useFieldContext(props)
const el = ref(null)
const text = ref(fmt(props.modelValue))
const bad = ref(false)

function fmt(v) { return v == null || Number.isNaN(v) ? '' : String(v) }
watch(() => props.modelValue, v => { if (parse(text.value) !== v) text.value = fmt(v) })

/** '' → null；非整数 → undefined（不合法） */
function parse(s) {
  const t = String(s ?? '').replace(/[,，\s]/g, '')
  if (t === '') return null
  if (!/^-?\d+$/.test(t)) return undefined
  return Number(t)
}
const clamp = n => {
  if (props.min !== undefined && n < props.min) n = props.min
  if (props.max !== undefined && n > props.max) n = props.max
  return n
}

function onInput(e) {
  text.value = e.target.value
  const n = parse(text.value)
  bad.value = n === undefined
  if (n !== undefined) emit('update:modelValue', n)
}
function onBlur() {
  let n = parse(text.value)
  if (n === undefined) n = props.modelValue
  if (n === null && props.required) n = props.min ?? 0
  if (n !== null) n = clamp(n)
  bad.value = false
  text.value = fmt(n)
  if (n !== props.modelValue) emit('update:modelValue', n)
}
function bump(dir, e) {
  e.preventDefault()
  const cur = parse(text.value)
  const n = clamp((typeof cur === 'number' ? cur : props.min ?? 0) + dir * props.step * (e.shiftKey ? 10 : 1))
  text.value = fmt(n)
  bad.value = false
  emit('update:modelValue', n)
}

defineExpose({ focus: () => el.value?.focus(), el })
</script>

<template>
  <div class="ni" :class="[{ suffixed: !!suffix }, attrs.class]" :style="attrs.style">
    <input
      :id="f.id.value"
      ref="el"
      v-bind="inputAttrs()"
      class="a-input num"
      :class="size"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      :value="text"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-invalid="bad || f.invalid.value || undefined"
      :aria-describedby="f.describedBy.value"
      @input="onInput"
      @blur="onBlur"
      @keydown.up="bump(1, $event)"
      @keydown.down="bump(-1, $event)"
    >
    <span v-if="suffix" class="sfx">{{ suffix }}</span>
  </div>
</template>

<style scoped>
.ni { position: relative; min-width: 0; }
.ni.suffixed .a-input { padding-right: 34px; }
.sfx { position: absolute; top: 50%; right: 10px; color: var(--t3); font-size: 12px; transform: translateY(-50%); pointer-events: none; }
</style>
