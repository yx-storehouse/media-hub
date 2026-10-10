<script setup>
import { ref, watch, nextTick, onMounted, useAttrs } from 'vue'
import { useFieldContext } from './formField'
import { fmtNum } from '../utils/format'

/*
 * 多行输入，高度随内容自动增长（rows ~ maxRows 之间）。
 * <TextArea v-model="form.text" :maxlength="5000" show-count />   计数显示在框下右侧：「1,234 / 5,000」
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  rows: { type: Number, default: 3 },
  maxRows: { type: Number, default: 14 },
  maxlength: { type: Number, default: undefined },
  showCount: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  id: { type: String, default: '' },
  invalid: { type: Boolean, default: false }
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
const len = v => [...String(v ?? '')].length

function fit() {
  const t = el.value
  if (!t) return
  const cs = getComputedStyle(t)
  const line = parseFloat(cs.lineHeight) || 20
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
  t.style.height = 'auto'
  const h = Math.min(Math.max(t.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), line * props.rows + pad), line * props.maxRows + pad)
  t.style.height = h + 'px'
}
watch(() => props.modelValue, () => nextTick(fit))
onMounted(fit)

defineExpose({ focus: () => el.value?.focus(), el })
</script>

<template>
  <div class="ta" :class="attrs.class" :style="attrs.style">
    <textarea
      :id="f.id.value"
      ref="el"
      v-bind="inputAttrs()"
      class="a-input"
      :value="modelValue ?? ''"
      :placeholder="placeholder"
      :rows="rows"
      :maxlength="maxlength"
      :disabled="disabled"
      :readonly="readonly"
      :aria-invalid="f.invalid.value || undefined"
      :aria-describedby="f.describedBy.value"
      @input="emit('update:modelValue', $event.target.value); fit()"
    />
    <span v-if="showCount && maxlength" class="count" :class="{ over: len(modelValue) > maxlength }">{{ fmtNum(len(modelValue)) }} / {{ fmtNum(maxlength) }}</span>
  </div>
</template>

<style scoped>
.ta { position: relative; min-width: 0; }
.ta textarea { display: block; resize: none; overflow-y: auto; }
.count { display: block; margin-top: 4px; color: var(--t3); font-size: 11.5px; font-variant-numeric: tabular-nums; text-align: right; }
.count.over { color: var(--danger); }
</style>
