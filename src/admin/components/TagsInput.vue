<script setup>
import { ref } from 'vue'
import AIcon from './AIcon.vue'
import { useFieldContext } from './formField'

/*
 * 标签输入：v-model 是字符串数组。
 *   回车、逗号（, ，）、空格 都会生成一个标签；输入框为空时退格删掉最后一个；
 *   粘贴「a,b c」会拆成多个。重复的自动去掉。
 * hash：视频标签存的是带 # 的（#日落），开启后显示和存储都自动补 #；帖子标签不带 #。
 */
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  hash: { type: Boolean, default: false },
  placeholder: { type: String, default: '输入后回车添加' },
  max: { type: Number, default: 20 },
  maxLength: { type: Number, default: 20 },
  disabled: { type: Boolean, default: false },
  id: { type: String, default: '' },
  invalid: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const f = useFieldContext(props)
const el = ref(null)
const text = ref('')
const note = ref('')

/** 统一成存储格式：去掉多余的 #、首尾空白，按需补 # */
function norm(t) {
  const s = String(t ?? '').trim().replace(/^[#＃]+/, '').trim()
  if (!s) return ''
  const cut = [...s].slice(0, props.maxLength).join('')
  return props.hash ? '#' + cut : cut
}

function add(parts) {
  const next = [...(props.modelValue || [])]
  const seen = new Set(next.map(x => norm(x).toLowerCase()))
  let full = false
  for (const p of parts) {
    const t = norm(p)
    if (!t || seen.has(t.toLowerCase())) continue
    if (next.length >= props.max) { full = true; break }
    next.push(t)
    seen.add(t.toLowerCase())
  }
  note.value = full ? `最多 ${props.max} 个标签` : ''
  if (next.length !== (props.modelValue || []).length) emit('update:modelValue', next)
}

const SPLIT = /[,，;；、\s]+/
function commit() {
  if (!text.value.trim()) { text.value = ''; return }
  add(text.value.split(SPLIT))
  text.value = ''
}

function onKeydown(e) {
  if (e.isComposing) return // 中文输入法选词时的回车 / 空格不算
  if (e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === ' ') {
    if (e.key === 'Enter' && !text.value.trim()) return
    e.preventDefault()
    commit()
  } else if (e.key === 'Backspace' && !text.value && props.modelValue?.length) {
    e.preventDefault()
    emit('update:modelValue', props.modelValue.slice(0, -1))
  }
}
function onInput(e) {
  const v = e.target.value
  // 输入法直接上屏的全角逗号也要拆：最后一个分隔符之前的生成标签，之后的留在输入框里继续输入
  if (/[,，;；、]/.test(v)) {
    const parts = v.split(/[,，;；、]+/)
    text.value = parts.pop()
    add(parts)
  } else text.value = v
}
function onPaste(e) {
  const t = e.clipboardData?.getData('text') || ''
  if (!SPLIT.test(t)) return
  e.preventDefault()
  add((text.value + t).split(SPLIT))
  text.value = ''
}
function remove(i) {
  const next = [...props.modelValue]
  next.splice(i, 1)
  emit('update:modelValue', next)
  el.value?.focus()
}
/* 旧数据里 # 可能缺或多，显示时统一一下 */
const shown = t => norm(t) || t

defineExpose({ focus: () => el.value?.focus() })
</script>

<template>
  <div class="tags-wrap">
    <div class="tags a-input" :class="{ 'is-disabled': disabled, 'is-invalid': f.invalid.value }" @click.self="el?.focus()">
      <span v-for="(t, i) in modelValue" :key="t + i" class="tag">
        {{ shown(t) }}
        <button v-if="!disabled" type="button" class="rm" :aria-label="`删除标签 ${t}`" @click="remove(i)">
          <AIcon name="x" :size="11" :stroke="2" />
        </button>
      </span>
      <input
        :id="f.id.value"
        ref="el"
        class="in"
        type="text"
        :value="text"
        :placeholder="modelValue?.length ? '' : placeholder"
        :disabled="disabled"
        :aria-invalid="f.invalid.value || undefined"
        :aria-describedby="f.describedBy.value"
        autocomplete="off"
        spellcheck="false"
        @input="onInput"
        @keydown="onKeydown"
        @paste="onPaste"
        @blur="commit"
      >
    </div>
    <p v-if="note" class="note">{{ note }}</p>
  </div>
</template>

<style scoped>
.tags-wrap { min-width: 0; }
.tags { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; height: auto; min-height: 32px; padding: 4px 6px; line-height: 1.4; cursor: text; }
.tag { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 4px 0 8px; border-radius: 11px; background: #262626; color: var(--t1); font-size: 12px; white-space: nowrap; }
.rm { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; color: var(--t2); }
.rm:hover { background: #3a3a3a; color: var(--t1); }
.in { flex: 1; min-width: 90px; height: 22px; padding: 0 4px; border: 0; background: transparent; color: var(--t1); }
.in:disabled { cursor: not-allowed; }
.note { margin-top: 4px; color: var(--warn); font-size: 12px; }
</style>
