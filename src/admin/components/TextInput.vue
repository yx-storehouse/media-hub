<script setup>
import { ref, computed, useAttrs } from 'vue'
import { useFieldContext } from './formField'
import { fmtNum } from '../utils/format'

/*
 * 单行输入：<TextInput v-model="form.title" placeholder="…" :maxlength="200" />
 * 放在 FormField 里时自动和标签关联；showCount 在框内右侧显示「已输入 / 上限」（12 / 200，带千分位）。
 * 字数计数统一用 TextInput / TextArea 的 show-count，页面不要自己另写计数。
 */
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  type: { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  maxlength: { type: Number, default: undefined },
  showCount: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  size: { type: String, default: 'md' },
  id: { type: String, default: '' },
  invalid: { type: Boolean, default: false },
  autocomplete: { type: String, default: 'off' },
  /** 等宽字体（编号、地址、slug） */
  mono: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'enter', 'blur', 'focus'])
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
const countText = computed(() => `${fmtNum(len(props.modelValue))} / ${fmtNum(props.maxlength)}`)

defineExpose({ focus: () => el.value?.focus(), select: () => el.value?.select(), el })
</script>

<template>
  <div class="ti" :class="[{ counted: showCount && maxlength }, attrs.class]" :style="[attrs.style, showCount && maxlength ? { '--cw': countText.length } : null]">
    <input
      :id="f.id.value"
      ref="el"
      v-bind="inputAttrs()"
      class="a-input"
      :class="[size, { mono }]"
      :type="type"
      :value="modelValue ?? ''"
      :placeholder="placeholder"
      :maxlength="maxlength"
      :disabled="disabled"
      :readonly="readonly"
      :autocomplete="autocomplete"
      :aria-invalid="f.invalid.value || undefined"
      :aria-describedby="f.describedBy.value"
      spellcheck="false"
      @input="emit('update:modelValue', $event.target.value)"
      @keydown.enter="emit('enter', $event)"
      @blur="emit('blur', $event)"
      @focus="emit('focus', $event)"
    >
    <span v-if="showCount && maxlength" class="count" aria-hidden="true">{{ countText }}</span>
  </div>
</template>

<style scoped>
.ti { position: relative; min-width: 0; }
/* 右侧给计数留位置：按计数文字的字符数估宽度（12 / 200 约 60px） */
.ti.counted .a-input { padding-right: calc(var(--cw, 7) * 6.4px + 16px); }
.mono { font-family: var(--mono); font-size: 12.5px; }
.count { position: absolute; top: 50%; right: 10px; color: var(--t3); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; transform: translateY(-50%); pointer-events: none; }
</style>
