/**
 * v-fade-in: play the short fade-in once when the element is created, then drop the class.
 * Lists re-key their container (`:key="batch"`) to fade each new batch in. Removing the class
 * afterwards keeps kept-alive pages from replaying the animation when they are shown again.
 *
 *   <div :key="batch" v-fade-in class="grid">…</div>
 *   <div :key="batch" v-fade-in="batch > 0">…</div>   <!-- skip the first batch -->
 */
const DURATION = 400 // a little longer than the .fade-in animation in base.css

export const vFadeIn = {
  mounted(el, binding) {
    if (binding.value === false) return
    el.classList.add('fade-in')
    // a timer instead of animationend: a page hidden mid-animation is detached and never fires it
    el._fadeTimer = setTimeout(() => el.classList.remove('fade-in'), DURATION)
  },
  unmounted(el) {
    clearTimeout(el._fadeTimer)
  }
}
