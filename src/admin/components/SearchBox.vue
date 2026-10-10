<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import AIcon from './AIcon.vue'
import { layerDepth } from './layers'

/*
 * 搜索框：<SearchBox v-model="query.q" placeholder="搜索标题 / 编号" />
 * 输入停顿 300ms 才更新 v-model（回车立即更新），右侧 × 清空。
 * 页面上没有输入框在聚焦、也没有弹层时，按 / 键聚焦它（autoKey=false 关闭）。
 */
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  placeholder: { type: String, default: '搜索' },
  delay: { type: Number, default: 300 },
  autoKey: { type: Boolean, default: true },
  width: { type: [Number, String], default: 240 }
})
const emit = defineEmits(['update:modelValue', 'search'])

const el = ref(null)
const text = ref(String(props.modelValue ?? ''))
let timer = 0

/* 外部改了值（比如点了「重置」）：同步到输入框 */
watch(() => props.modelValue, v => { if (String(v ?? '') !== text.value.trim()) text.value = String(v ?? '') })

function commit() {
  clearTimeout(timer)
  const v = text.value.trim()
  if (v !== String(props.modelValue ?? '')) emit('update:modelValue', v)
  emit('search', v)
}
function onInput(e) {
  text.value = e.target.value
  clearTimeout(timer)
  timer = setTimeout(commit, props.delay)
}
function clearText() {
  text.value = ''
  commit()
  el.value?.focus()
}
function onKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); commit() }
  else if (e.key === 'Escape' && text.value) { e.preventDefault(); e.stopPropagation(); clearText() }
}

/* 全局快捷键 / */
function onSlash(e) {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || !props.autoKey) return
  const a = document.activeElement
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return
  // 有弹层时只认弹层里的搜索框
  if (layerDepth() && !el.value?.closest('[role="dialog"]')) return
  if (!el.value || el.value.offsetParent === null) return
  e.preventDefault()
  el.value.focus()
  el.value.select()
}
onMounted(() => document.addEventListener('keydown', onSlash))
onBeforeUnmount(() => { document.removeEventListener('keydown', onSlash); clearTimeout(timer) })

defineExpose({ focus: () => el.value?.focus() })
</script>

<template>
  <div class="sb" :style="{ width: typeof width === 'number' ? width + 'px' : width }">
    <AIcon class="ico" name="search" :size="14" />
    <input
      ref="el"
      class="a-input"
      type="search"
      :value="text"
      :placeholder="placeholder"
      :aria-label="placeholder"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
    >
    <button v-if="text" type="button" class="x" aria-label="清空搜索" @click="clearText">
      <AIcon name="x" :size="12" />
    </button>
    <span v-else-if="autoKey" class="kbd hint" aria-hidden="true">/</span>
  </div>
</template>

<style scoped>
.sb { position: relative; flex: none; max-width: 100%; }
.sb .a-input { padding: 0 30px 0 30px; }
.sb .a-input::-webkit-search-cancel-button { display: none; }
.ico { position: absolute; top: 50%; left: 10px; color: var(--t3); transform: translateY(-50%); pointer-events: none; }
.x { position: absolute; top: 50%; right: 7px; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: #2a2a2a; color: var(--t2); transform: translateY(-50%); }
.x:hover { background: #3a3a3a; color: var(--t1); }
.hint { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); pointer-events: none; }
</style>
