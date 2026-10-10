import { nextTick } from 'vue'

/*
 * 单选组（role="radiogroup"）和标签页（role="tablist"）的键盘操作，普通 <button> 就能用：
 *   ← → ↑ ↓ 在组内移动（首尾循环），Home / End 跳到第一项 / 最后一项；默认移到哪项就点哪项（选中跟着焦点走）。
 *   组内只有一项 tabindex=0（选中项；都没选时第一项），Tab 进组直接落在它上面，再按 Tab 离开整个组。
 *
 *   <div role="radiogroup" aria-label="角色" @keydown="rovingKeydown">
 *     <button v-for="(o, i) in OPTS" type="button" role="radio"
 *             :aria-checked="String(v === o.value)" :tabindex="rovingTabindex(i, OPTS.findIndex(x => x.value === v))"
 *             @click="v = o.value">{{ o.label }}</button>
 *   </div>
 *
 * 选项：@keydown="e => rovingKeydown(e, { orientation: 'horizontal', activate: false, selector: '.tab' })"
 *   selector     组内的项（默认 role=radio / tab / option / menuitemradio）；禁用的项会跳过
 *   orientation  'both'（默认，四个方向键都管）| 'horizontal'（只管 ← →）| 'vertical'（只管 ↑ ↓）
 *   activate     移过去后是否 click()（默认 true；手动激活的标签页传 false，用户再按空格 / 回车）
 *   loop         到头后是否循环（默认 true）
 */
const DEFAULT_ITEMS = '[role="radio"], [role="tab"], [role="option"], [role="menuitemradio"]'

/** 组里第 i 项的 tabindex：activeIndex 为选中项下标（-1 = 都没选，此时第一项可 Tab 进入） */
export const rovingTabindex = (i, activeIndex) => (i === (activeIndex >= 0 ? activeIndex : 0) ? 0 : -1)

export function rovingKeydown(e, opts = {}) {
  const { selector = DEFAULT_ITEMS, orientation = 'both', activate = true, loop = true } = opts || {}
  if (e.altKey || e.ctrlKey || e.metaKey) return
  const keys = {
    ArrowLeft: orientation !== 'vertical' ? -1 : 0,
    ArrowRight: orientation !== 'vertical' ? 1 : 0,
    ArrowUp: orientation !== 'horizontal' ? -1 : 0,
    ArrowDown: orientation !== 'horizontal' ? 1 : 0
  }
  const group = e.currentTarget
  if (!group || !(e.key in keys || e.key === 'Home' || e.key === 'End')) return
  // 组内的输入框（比如标签页里的搜索框）按方向键是移动光标，不归这里管
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return
  const items = [...group.querySelectorAll(selector)].filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.offsetParent !== null)
  if (!items.length) return
  const from = items.findIndex(el => el === e.target || el.contains(e.target))
  let to
  if (e.key === 'Home') to = 0
  else if (e.key === 'End') to = items.length - 1
  else {
    const d = keys[e.key]
    if (!d) return
    const base = from >= 0 ? from : 0
    to = base + d
    if (to < 0) to = loop ? items.length - 1 : 0
    else if (to >= items.length) to = loop ? 0 : items.length - 1
  }
  e.preventDefault()
  const el = items[to]
  if (!el || el === items[from]) return
  el.focus()
  if (activate) {
    el.click()
    // 点击后重新渲染可能换掉元素：把焦点放回选中的那一项
    nextTick(() => {
      if (group.contains(document.activeElement)) return
      group.querySelector('[aria-checked="true"], [aria-selected="true"]')?.focus()
    })
  }
}
