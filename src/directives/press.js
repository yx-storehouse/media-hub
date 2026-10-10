/**
 * v-press: make a clickable non-button element (a card whose content is block-level, so it
 * cannot be a <button>) behave like a button for keyboard and assistive tech:
 * role="button", focusable, and Enter / Space trigger its click handler.
 *
 *   <div v-press class="card" @click="open">…</div>
 */
export const vPress = {
  mounted(el) {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button')
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0
    el._onPressKey = e => {
      if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      el.click()
    }
    el.addEventListener('keydown', el._onPressKey)
  },
  unmounted(el) {
    el.removeEventListener('keydown', el._onPressKey)
  }
}
