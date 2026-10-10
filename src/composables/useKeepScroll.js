import { watch, onActivated } from 'vue'

/**
 * Keep the scroll offsets of scrollers inside kept-alive pages.
 *
 * KeepAlive moves an inactive page's DOM into a detached container, and a detached element loses
 * its scroll offsets (they already read 0 by the time onDeactivated runs). So the offsets are
 * tracked from scroll events while the element is live and written back in onActivated.
 *
 *   const list = ref(null)                         // <div ref="list" class="scroll">
 *   const { reset } = useKeepScroll(list, chips)   // any number of scroller refs
 *   reset()                                        // back to the start (e.g. after loading a new list);
 *                                                  // also safe while the page is detached
 */
export function useKeepScroll(...targets) {
  const saved = targets.map(() => ({ top: 0, left: 0 }))

  targets.forEach((target, i) => {
    const onScroll = e => {
      saved[i].top = e.target.scrollTop
      saved[i].left = e.target.scrollLeft
    }
    // template refs can appear / disappear (v-if), so follow the element instead of binding once
    watch(target, (el, old) => {
      old?.removeEventListener('scroll', onScroll)
      el?.addEventListener('scroll', onScroll, { passive: true })
    }, { immediate: true, flush: 'post' })
  })

  onActivated(() => {
    targets.forEach((target, i) => {
      const el = target.value
      if (!el) return
      el.scrollTop = saved[i].top
      el.scrollLeft = saved[i].left
    })
  })

  function reset(target = targets[0]) {
    const i = targets.indexOf(target)
    if (i < 0) return
    saved[i].top = saved[i].left = 0
    if (target.value) {
      target.value.scrollTop = 0
      target.value.scrollLeft = 0
    }
  }

  return { reset }
}
