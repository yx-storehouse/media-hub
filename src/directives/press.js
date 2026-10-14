/**
 * v-press: make a clickable non-button element (a card whose content is block-level, so it
 * cannot be a <button>) behave like a button for keyboard and assistive tech:
 * role="button", focusable, and Enter / Space trigger its click handler.
 * 同时带上按压反馈（按下缩一点、松手弹回，见 components/motion/press.js）：
 *
 *   <div v-press class="card" @click="open">…</div>        卡片：缩到 --press-scale
 *   <div v-press.sm class="ic-btn" @click="…">…</div>      小图标：缩得多一点，松手带回弹
 *   <div v-press.plain class="row" @click="…">…</div>      只要键盘支持，不缩放
 */
const feedbackClass = m => (m.plain ? null : m.sm ? 'm-press-sm' : 'm-press')

export const vPress = {
  mounted(el, { modifiers }) {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button')
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0
    el._pressClass = feedbackClass(modifiers)
    if (el._pressClass) el.classList.add(el._pressClass)
    el._onPressKey = e => {
      if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      el.click()
    }
    el.addEventListener('keydown', el._onPressKey)
  },
  // 元素的 :class 一变，Vue 会整个重写 className，把加上的类补回来
  updated(el) {
    if (el._pressClass && !el.classList.contains(el._pressClass)) el.classList.add(el._pressClass)
  },
  unmounted(el) {
    el.removeEventListener('keydown', el._onPressKey)
  }
}
