/*
 * 弹层栈：抽屉、对话框、确认框打开时入栈。
 * 作用：① Esc / Ctrl+S 只交给最上面那一层；② 后打开的层 z-index 更高（确认框盖在抽屉上）。
 * 组件内部用，页面不需要直接调用。
 */
import { ref, computed } from 'vue'

const stack = ref([])
let seq = 0

export function pushLayer() {
  const id = ++seq
  stack.value = [...stack.value, id]
  return id
}

export function popLayer(id) {
  stack.value = stack.value.filter(x => x !== id)
}

export const isTopLayer = id => stack.value[stack.value.length - 1] === id
/** 当前打开的弹层数（响应式，提示条据此避开抽屉底部的按钮） */
export const openLayers = computed(() => stack.value.length)
export const layerDepth = () => stack.value.length
/** 层级：从 1000 起，每层 +10 */
export const layerZ = id => 1000 + Math.max(0, stack.value.indexOf(id)) * 10

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 可聚焦元素（跳过隐藏的） */
export function focusables(root) {
  if (!root) return []
  return [...root.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement)
}

/** Tab 键焦点只在弹层内循环 */
export function trapTab(e, root) {
  if (e.key !== 'Tab' || !root) return
  const els = focusables(root)
  if (!els.length) { e.preventDefault(); root.focus(); return }
  const first = els[0]
  const last = els[els.length - 1]
  if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

/* 「第一个表单控件」：文字输入框、下拉（SelectInput 的触发按钮）、开关；按文档顺序取最前面的那个 */
const FIRST_CONTROL = [
  '.a-body input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]):not([disabled]):not([tabindex="-1"])',
  '.a-body textarea:not([disabled])',
  '.a-body button[role="combobox"]:not([disabled])',
  '.a-body [role="switch"]:not([disabled])'
].join(', ')

/** 打开时把焦点移进弹层：优先 [autofocus] / [data-autofocus]，其次第一个表单控件，最后是面板本身 */
export function focusInto(root) {
  if (!root) return
  const pick = root.querySelector('[autofocus], [data-autofocus]') || root.querySelector(FIRST_CONTROL)
  ;(pick || root).focus({ preventScroll: true })
}

/** 关闭后把焦点还给打开它的元素（还在页面上的话） */
export function restoreFocus(el) {
  if (el && el.isConnected && typeof el.focus === 'function') el.focus({ preventScroll: true })
}
