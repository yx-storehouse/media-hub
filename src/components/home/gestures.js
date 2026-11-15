import { reactive, watch, onBeforeUnmount } from 'vue'

/*
 * 列表页的触屏手势（首页各分类、社区；和短视频的下拉刷新、创作者主页的横划换标签同一种手感）：
 *
 *   const pull = usePullRefresh(rootEl, { scroller: () => el, refresh: () => promise })
 *     列表停在最顶上时往下拉，拉过 PULL_TRIGGER 松手就刷新；pull.on / pull.y / pull.busy 给提示条用（<PullHint :pull="pull" />）。
 *   useSwipeTabs(rootEl, dir => …)
 *     在内容上横着划一下（够远、明显是横着的、不慢、这期间没有竖着滚），dir = 1 往后一个标签、-1 往前一个。
 *
 * 两个都只读触摸、不拦默认行为（passive）：竖着滚动永远优先，不会误触；鼠标没有这些手势（桌面上有刷新按钮、标签直接点）。
 * 从屏幕左右边缘起手的横划不算（留给系统的返回手势）；横着滚的行（.hs，筛选胶囊、日期行）、输入框、
 * 标了 data-no-swipe 的地方不算横划；正在拖进度条之类的自己处理的地方加 data-no-pull 就不算下拉。
 */

export const PULL_TRIGGER = 72
const SWIPE_EDGE = 24
const SWIPE_MIN = 60
const SWIPE_MS = 700

/* 跟着元素走（模板 ref 可能随 v-if 出现 / 消失）：挂上 / 换掉触摸监听 */
function bind(target, handlers) {
  const opts = { passive: true }
  const on = el => { for (const [type, fn] of Object.entries(handlers)) el.addEventListener(type, fn, opts) }
  const off = el => { for (const [type, fn] of Object.entries(handlers)) el.removeEventListener(type, fn, opts) }
  const resolve = () => {
    const v = target.value
    return v && v.$el ? v.$el : v
  }
  let cur = null
  watch(resolve, el => {
    if (cur) off(cur)
    cur = el instanceof Element ? el : null
    if (cur) on(cur)
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(() => { if (cur) off(cur) })
}

const skipPull = t => t instanceof Element && !!t.closest('input, textarea, [data-no-pull]')
const skipSwipe = t => !(t instanceof Element) || !!t.closest('.hs, input, textarea, [data-no-swipe]')

/**
 * 下拉刷新。refresh() 返回 Promise（刷新完 busy 才变回 false）；enabled() 返回 false 时不响应（比如还没有内容）。
 */
export function usePullRefresh(target, { scroller, refresh, enabled = () => true }) {
  const pull = reactive({ on: false, y: 0, busy: false })
  let from = null
  const sc = () => {
    const el = scroller()
    return el instanceof Element ? el : null
  }

  function start(e) {
    from = null
    if (e.touches.length !== 1 || pull.busy || !enabled() || skipPull(e.target)) return
    const el = sc()
    if (!el || el.scrollTop > 1) return
    from = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }
  function move(e) {
    if (!from) return
    const t = e.touches[0]
    if (!t) return
    const dy = t.clientY - from.y
    const dx = t.clientX - from.x
    if (!pull.on) {
      // 往上（滚列表）或者横着（换标签）：不是下拉
      if (dy < -4 || Math.abs(dx) > Math.abs(dy)) {
        from = null
        return
      }
      if (dy < 10 || (sc()?.scrollTop ?? 0) > 1) return
      pull.on = true
    }
    pull.y = Math.max(0, dy)
  }
  function end() {
    const go = pull.on && pull.y >= PULL_TRIGGER
    from = null
    pull.on = false
    pull.y = 0
    if (!go) return
    pull.busy = true
    Promise.resolve()
      .then(refresh)
      .catch(() => { /* 刷新失败由页面自己提示 */ })
      .finally(() => { pull.busy = false })
  }

  bind(target, { touchstart: start, touchmove: move, touchend: end, touchcancel: end })
  return pull
}

/**
 * 横划换标签：go(1) 下一个、go(-1) 上一个（到头了由页面决定不动）。
 * scroller()：竖着滚的那个容器；划的这段时间里它滚动过就不算。
 */
export function useSwipeTabs(target, go, { scroller = () => null, enabled = () => true } = {}) {
  let s = null
  function start(e) {
    s = null
    const t = e.touches[0]
    if (e.touches.length !== 1 || !t || !enabled() || skipSwipe(e.target)) return
    if (t.clientX < SWIPE_EDGE || t.clientX > window.innerWidth - SWIPE_EDGE) return
    s = { x: t.clientX, y: t.clientY, at: performance.now(), top: scroller()?.scrollTop ?? 0 }
  }
  function end(e) {
    const st = s
    s = null
    const t = e.changedTouches?.[0]
    if (!st || !t || e.touches.length) return
    const dx = t.clientX - st.x
    const dy = t.clientY - st.y
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 2 || performance.now() - st.at > SWIPE_MS) return
    if (Math.abs((scroller()?.scrollTop ?? 0) - st.top) > 4) return
    go(dx < 0 ? 1 : -1)
  }
  const cancel = () => { s = null }
  bind(target, { touchstart: start, touchend: end, touchcancel: cancel })
}
