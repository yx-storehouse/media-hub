/*
 * 桌面布局（≥ 1024px）下，底部弹层（BottomSheet、LoginSheet，以及直接用 .sheet 类的弹层）是窗口正中的对话框。
 * 对话框开着时键盘 Tab 只在它里面循环，不会跑到后面被遮罩盖住的页面上去。
 *
 *   <div class="sheet" @keydown="e => isDesktop && trapTab(e, sheetEl)">
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/*
 * 对话框里在 Tab 顺序上、而且看得见的元素（文档顺序）。tabindex="-1" 的只能点、不进 Tab 顺序（和浏览器一样跳过）；
 * visibility: hidden 的（比如看大图翻到头时藏起来的箭头）浏览器聚焦不了，也跳过。
 */
function focusables(box) {
  return [...box.querySelectorAll(FOCUSABLE)].filter(el =>
    !el.hidden &&
    el.getAttribute('tabindex') !== '-1' &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility === 'visible')
}

/**
 * keydown 里调：每一次 Tab / Shift+Tab 都由这里按文档顺序挪焦点，到头绕回另一头，不交给浏览器——
 * 浏览器自己的 Tab 顺序不一定都在框里：Safari 默认设置下 Tab 只在输入框之间跳，会从密码框直接跳到
 * 遮罩后面顶栏的搜索框上。焦点在对话框本身（刚打开时）或者框外：Tab 到第一个，Shift+Tab 到最后一个。
 */
export function trapTab(e, box) {
  if (e.key !== 'Tab' || !box || e.altKey || e.ctrlKey || e.metaKey) return
  e.preventDefault()
  const list = focusables(box)
  const n = list.length
  if (!n) return
  const d = e.shiftKey ? -1 : 1
  const i = list.indexOf(document.activeElement)
  let k = i < 0 ? (d > 0 ? 0 : n - 1) : (i + d + n) % n
  // 个别元素这一刻聚焦不了（比如刚被禁用）：接着试下一个
  for (let t = 0; t < n; t++, k = (k + d + n) % n) {
    list[k].focus()
    if (document.activeElement === list[k]) return
  }
}
