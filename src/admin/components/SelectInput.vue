<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, useId } from 'vue'
import AIcon from './AIcon.vue'
import { useFieldContext } from './formField'

/*
 * 下拉选择：<SelectInput v-model="form.topicId" :options="topicOptions" searchable clearable placeholder="选择专题" />
 *   options：[{ value, label }]；值的比较按字符串（路由参数里的 '1' 与数字 1 视为同一项），null 与 '' 都算「未选」。
 *   searchable：带筛选框的组合框，几千个选项也不卡（最多渲染前 200 个匹配项）。
 *   clearable：右侧出现 ×，列表第一项是 placeholder（筛选栏里当「全部」用），清空时值为 null。
 * 弹层挂到 body 上（不会被抽屉 / 表格的滚动区域裁掉），键盘 ↑ ↓ 回车 Esc 都可用；列表打开时按 Tab 关闭并移到下一个控件。
 * 无障碍名称：放在 FormField 里或有 <label for> 时用标签文字；都没有时用 aria-label，再没有就用 placeholder
 * （筛选栏里的「全部状态」这类下拉不用另外写隐藏标签）。
 */
const props = defineProps({
  modelValue: { type: [String, Number, Boolean], default: null },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  clearable: { type: Boolean, default: false },
  searchable: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  size: { type: String, default: 'md' },
  id: { type: String, default: '' },
  invalid: { type: Boolean, default: false },
  /** 弹层最小宽度（选项文字较长时） */
  popWidth: { type: Number, default: 0 },
  /** 搜索时每次最多显示多少项 */
  limit: { type: Number, default: 200 },
  /** 没有可见标签时的无障碍名称（写 aria-label="…" 即可） */
  ariaLabel: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'change'])

const f = useFieldContext(props)
const uid = useId()
const listId = 'sel-' + uid
const optId = i => `${listId}-o${i}`

const trigger = ref(null)
const pop = ref(null)
const listEl = ref(null)
const searchEl = ref(null)
const open = ref(false)
const term = ref('')
const active = ref(0)
const pos = ref({})

const isEmpty = v => v === null || v === undefined || v === ''
const same = (a, b) => (isEmpty(a) ? isEmpty(b) : !isEmpty(b) && String(a) === String(b))

const current = computed(() => props.options.find(o => same(o.value, props.modelValue)) || null)
const empty = computed(() => isEmpty(props.modelValue))
/* 值有但选项里没有（比如元数据还没加载完）：先显示原值 */
const display = computed(() => (empty.value ? props.placeholder : current.value ? current.value.label : String(props.modelValue)))

/* 触发按钮有没有关联的 <label>（FormField 或页面自己写的 label for）：没有就用 aria-label / placeholder 当名称 */
const hasLabel = ref(true)
const checkLabel = () => { hasLabel.value = !!trigger.value?.labels?.length }
onMounted(checkLabel)
watch(() => f.id.value, () => nextTick(checkLabel))
const accName = computed(() => props.ariaLabel || (hasLabel.value ? undefined : props.placeholder || undefined))

const filtered = computed(() => {
  const t = term.value.trim().toLowerCase()
  const src = props.options
  if (!t) return src
  return src.filter(o => String(o.label).toLowerCase().includes(t) || String(o.value).toLowerCase() === t)
})
/* 列表里实际渲染的项：可清空时第一项是「placeholder」（选它 = 清空） */
const shown = computed(() => {
  const list = filtered.value.slice(0, props.limit)
  return props.clearable && !term.value.trim() ? [{ value: null, label: props.placeholder, clear: true }, ...list] : list
})
const hiddenCount = computed(() => Math.max(0, filtered.value.length - props.limit))

function place() {
  const el = trigger.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const want = 300
  const below = window.innerHeight - r.bottom - 8
  const above = r.top - 8
  const up = below < Math.min(want, 220) && above > below
  const width = Math.max(r.width, props.popWidth, 160)
  const left = Math.min(r.left, window.innerWidth - width - 8)
  pos.value = up
    ? { left: Math.max(8, left) + 'px', bottom: window.innerHeight - r.top + 4 + 'px', width: width + 'px', maxHeight: Math.min(want, above) + 'px' }
    : { left: Math.max(8, left) + 'px', top: r.bottom + 4 + 'px', width: width + 'px', maxHeight: Math.min(want, below) + 'px' }
}

function onDocDown(e) {
  if (trigger.value?.contains(e.target) || pop.value?.contains(e.target)) return
  close(false)
}
const onReflow = () => { if (open.value) place() }

function openPop(initial = '') {
  if (props.disabled || open.value) return
  term.value = initial
  open.value = true
  const i = shown.value.findIndex(o => !o.clear && same(o.value, props.modelValue))
  active.value = i >= 0 ? i : 0
  place()
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('resize', onReflow)
  window.addEventListener('scroll', onReflow, true)
  nextTick(() => {
    // 键盘操作挂在触发按钮 / 搜索框上；Safari 点按钮不会自动聚焦，这里手动聚焦一次
    if (props.searchable) searchEl.value?.focus()
    else trigger.value?.focus()
    scrollActive()
  })
}
function close(refocus = true) {
  if (!open.value) return
  open.value = false
  term.value = ''
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('resize', onReflow)
  window.removeEventListener('scroll', onReflow, true)
  if (refocus) trigger.value?.focus()
}
onBeforeUnmount(() => close(false))

function pick(o) {
  const v = o.clear ? null : o.value
  if (!same(v, props.modelValue) || (o.clear && !empty.value)) {
    emit('update:modelValue', v)
    emit('change', v, o.clear ? null : o)
  }
  close()
}
function clear() {
  emit('update:modelValue', null)
  emit('change', null, null)
  trigger.value?.focus()
}

function scrollActive() {
  nextTick(() => listEl.value?.children[active.value]?.scrollIntoView({ block: 'nearest' }))
}
watch(term, () => { active.value = 0; scrollActive() })

/* 列表打开时的按键（触发按钮和搜索框共用） */
function navKey(e) {
  const n = shown.value.length
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); active.value = n ? (active.value + 1) % n : 0; scrollActive(); break
    case 'ArrowUp': e.preventDefault(); active.value = n ? (active.value - 1 + n) % n : 0; scrollActive(); break
    case 'Home': if (!props.searchable) { e.preventDefault(); active.value = 0; scrollActive() } break
    case 'End': if (!props.searchable) { e.preventDefault(); active.value = Math.max(0, n - 1); scrollActive() } break
    case 'PageDown': e.preventDefault(); active.value = Math.min(n - 1, active.value + 8); scrollActive(); break
    case 'PageUp': e.preventDefault(); active.value = Math.max(0, active.value - 8); scrollActive(); break
    case 'Enter': e.preventDefault(); if (shown.value[active.value]) pick(shown.value[active.value]); break
    // Esc 只关下拉，不能冒泡到对话框 / 抽屉把它们也关掉
    case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break
    // 焦点可能在挂到 body 末尾的搜索框里：先同步把焦点还给触发按钮，浏览器默认的 Tab 再从它往后（往前）移，
    // 不会跳到页面开头、也不会跑出抽屉 / 对话框
    case 'Tab': close(true); break
  }
}

function onTriggerKey(e) {
  if (open.value) return navKey(e)
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openPop() }
  // 可搜索时直接打字就打开并开始筛选
  else if (props.searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openPop(e.key) }
  else if ((e.key === 'Backspace' || e.key === 'Delete') && props.clearable && !empty.value) { e.preventDefault(); clear() }
}

/* 点弹层里的空白处不让触发按钮失焦；搜索框本身照常可以点 */
const popDown = e => { if (e.target !== searchEl.value) e.preventDefault() }

defineExpose({ focus: () => trigger.value?.focus(), open: openPop, close })
</script>

<template>
  <div class="sel" :class="[size, { disabled, open }]">
    <button
      :id="f.id.value"
      ref="trigger"
      type="button"
      class="a-input trigger"
      :class="[size, { 'is-focus': open, 'is-invalid': f.invalid.value, clearable: clearable && !empty }]"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="open && !searchable && shown.length ? optId(active) : undefined"
      :aria-invalid="f.invalid.value || undefined"
      :aria-describedby="f.describedBy.value"
      :aria-label="accName"
      :disabled="disabled"
      @click="open ? close() : openPop()"
      @keydown="onTriggerKey"
    >
      <span class="val" :class="{ ph: empty }">{{ display }}</span>
      <AIcon class="caret" name="chevron-down" :size="14" />
    </button>
    <button v-if="clearable && !empty && !disabled" type="button" class="clear" aria-label="清除选择" tabindex="-1" @click="clear">
      <AIcon name="x" :size="12" />
    </button>

    <Teleport to="body">
      <div v-if="open" ref="pop" class="sel-pop" :style="pos" @mousedown="popDown">
        <div v-if="searchable" class="search">
          <AIcon name="search" :size="14" />
          <input
            ref="searchEl"
            v-model="term"
            class="search-input"
            type="text"
            placeholder="输入关键字筛选…"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            :aria-controls="listId"
            :aria-activedescendant="shown.length ? optId(active) : undefined"
            autocomplete="off"
            spellcheck="false"
            @keydown="navKey"
          >
        </div>
        <ul :id="listId" ref="listEl" class="opts" role="listbox" :aria-label="ariaLabel || placeholder || undefined">
          <li
            v-for="(o, i) in shown"
            :id="optId(i)"
            :key="o.clear ? '__clear' : String(o.value)"
            role="option"
            class="opt"
            :class="{ active: i === active, sel: !o.clear && same(o.value, modelValue), clr: o.clear }"
            :aria-selected="!o.clear && same(o.value, modelValue) ? 'true' : 'false'"
            @click="pick(o)"
            @mousemove="active = i"
          >
            <span class="ol">{{ o.label }}</span>
            <AIcon v-if="!o.clear && same(o.value, modelValue)" name="check" :size="14" />
          </li>
        </ul>
        <p v-if="!shown.length" class="note">没有匹配的选项</p>
        <p v-else-if="hiddenCount" class="note">还有 {{ hiddenCount }} 项未显示，继续输入以筛选</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sel { position: relative; display: inline-block; width: 100%; min-width: 0; vertical-align: middle; }
.trigger { display: flex; align-items: center; gap: 6px; text-align: left; cursor: pointer; }
.trigger.clearable { padding-right: 46px; }
.val { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.val.ph { color: var(--t3); }
.caret { color: var(--t3); transition: transform .15s; }
.trigger.clearable .caret { position: absolute; right: 10px; }
.open .caret { transform: rotate(180deg); }
.clear { position: absolute; top: 50%; right: 28px; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: #2a2a2a; color: var(--t2); transform: translateY(-50%); }
.clear:hover { background: #3a3a3a; color: var(--t1); }
.sm .clear { right: 26px; width: 16px; height: 16px; }

.sel-pop {
  position: fixed;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: #171717;
  box-shadow: var(--shadow);
}
.search { display: flex; flex: none; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid var(--line); color: var(--t3); }
.search-input { flex: 1; min-width: 0; height: 34px; border: 0; background: transparent; color: var(--t1); }
.opts { flex: 1; min-height: 0; padding: 4px; overflow-y: auto; overscroll-behavior: contain; }
.opt { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 5px 9px; border-radius: 5px; color: var(--t1); cursor: pointer; }
.opt .ol { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.opt.active { background: var(--hover); }
.opt.sel { font-weight: 600; }
.opt.clr { color: var(--t2); }
.note { flex: none; padding: 8px 12px; border-top: 1px solid var(--line); color: var(--t3); font-size: 12px; }
.opts:empty { display: none; }
</style>
