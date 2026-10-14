import { cssDuration, cssEasing } from '@/utils/motion'

/*
 * 底部弹层下拉关闭（BottomSheet、LoginSheet 共用）：弹层跟着手指往下走、遮罩跟着变淡，
 * 松手时拉过弹层高度的 30%、或者往下甩得够快就关掉（按甩出去的速度滑走），否则弹回原位。
 *
 *   const drag = useSheetDrag(sheetEl, maskEl, close)
 *   <Transition name="sheet" @before-leave="drag.beforeLeave">
 *     <div ref="sheetEl" class="sheet" v-on="drag.on">…</div>
 *
 * 什么时候算「拉弹层」：第一下明显的移动是往下、竖直方向为主，并且弹层里手指下的内容已经在顶部
 * （没有往上滚过）。往上拉、横着划、内容还能往上滚时都交给浏览器照常滚动。
 * 拉过之后松手不会误触手指下的按钮。
 */

const DECIDE = 4      // px：移动超过这么多才判断方向
const CLOSE_AT = 0.3  // 拉过弹层高度的这个比例就关
const FLICK = 0.5     // px/ms：往下甩的速度超过它就关（不论拉了多远）
const SAMPLE_MS = 80  // 用最后这段时间里的移动算松手速度

/* 手指下（到弹层为止）有没有已经往上滚过的容器：有就让它先滚 */
function scrolledAbove(target, sheet) {
  for (let el = target; el && el !== sheet.parentNode; el = el.parentElement) {
    if (el.scrollTop > 0) return true
    if (el === sheet) break
  }
  return false
}

/**
 * @param {import('vue').Ref<HTMLElement|null>} sheetRef
 * @param {import('vue').Ref<HTMLElement|null>} maskRef
 * @param {() => void} close 关闭弹层（和点遮罩一样）
 */
export function useSheetDrag(sheetRef, maskRef, close) {
  let g = null          // 当前手势：{ x, y, mode: 0 未定 / 1 拉弹层 / -1 不管, dy, h, samples }
  let frame = 0
  let leaving = false   // 拉下去关闭：离场动画由这里接管，不要清掉行内样式

  const sheet = () => sheetRef.value
  const mask = () => maskRef.value

  function paint() {
    frame = 0
    const el = sheet()
    if (!g || !el) return
    el.style.transform = `translate3d(0, ${g.dy}px, 0)`
    const m = mask()
    if (m) m.style.opacity = String(Math.max(0, 1 - g.dy / g.h))
  }

  function clearInline() {
    for (const el of [sheet(), mask()]) {
      if (!el) continue
      el.style.transition = ''
      el.style.transform = ''
      el.style.opacity = ''
      el.style.willChange = ''
    }
  }

  function onTouchstart(e) {
    const el = sheet()
    if (!el || e.touches.length !== 1 || leaving) { g = null; return }
    const t = e.touches[0]
    g = { x: t.clientX, y: t.clientY, mode: scrolledAbove(e.target, el) ? -1 : 0, dy: 0, h: 1, samples: [] }
  }

  function onTouchmove(e) {
    if (!g || g.mode < 0) return
    if (e.touches.length !== 1) { cancel(); return }
    const t = e.touches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    if (g.mode === 0) {
      if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { g.mode = -1; return }
      const el = sheet()
      if (!el) { g.mode = -1; return }
      g.mode = 1
      g.h = el.offsetHeight || 1
      g.y = t.clientY // 从这里开始跟手，不会一下跳 4px
      el.style.transition = 'none'
      el.style.willChange = 'transform'
      if (mask()) mask().style.transition = 'none'
    }
    if (e.cancelable) e.preventDefault() // 拉弹层时不要再滚动里面的内容
    g.dy = Math.max(0, t.clientY - g.y)
    g.samples.push({ y: t.clientY, t: e.timeStamp })
    while (g.samples.length > 2 && e.timeStamp - g.samples[0].t > SAMPLE_MS) g.samples.shift()
    if (!frame) frame = requestAnimationFrame(paint)
  }

  function onTouchend(e) {
    if (!g || g.mode !== 1) { g = null; return }
    const { dy, h, samples } = g
    g = null
    cancelAnimationFrame(frame)
    frame = 0
    const a = samples[0]
    const b = samples[samples.length - 1]
    const v = a && b && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0 // px/ms，往下为正
    swallowClick(e)
    // 甩：速度够、而且确实拉开了一段（点按时手指的轻微抖动不算）
    if ((v > FLICK && dy > DECIDE * 4) || (dy > h * CLOSE_AT && v > -FLICK / 2)) dismiss(dy, h, v)
    else settle()
  }

  function cancel() {
    if (g && g.mode === 1) settle()
    g = null
  }

  /* 松手关闭：从当前位置接着往下滑走。甩得快就按手指的速度匀速出去（出屏就结束，看不到急停），
     慢慢拉过线的就按标准的离场曲线 */
  function dismiss(dy, h, v) {
    const el = sheet()
    if (!el) return close()
    const fast = v > FLICK
    const rest = Math.max(0, h - dy)
    const ms = fast
      ? Math.min(cssDuration('--dur-3'), Math.max(cssDuration('--dur-1'), rest / v))
      : cssDuration('--dur-2')
    const easing = fast ? 'linear' : cssEasing('--ease-in')
    leaving = true
    el.style.transition = `transform ${ms}ms ${easing}`
    el.style.transform = 'translate3d(0, 100%, 0)'
    const m = mask()
    if (m) {
      m.style.transition = `opacity ${ms}ms ${easing}`
      m.style.opacity = '0'
    }
    close()
  }

  /* 没拉够：弹回原位 */
  function settle() {
    const el = sheet()
    if (!el) return
    const ms = cssDuration('--dur-2')
    const easing = cssEasing('--ease-out')
    el.style.transition = `transform ${ms}ms ${easing}`
    el.style.transform = 'translate3d(0, 0, 0)'
    const m = mask()
    if (m) {
      m.style.transition = `opacity ${ms}ms ${easing}`
      m.style.opacity = '1'
    }
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      el.removeEventListener('transitionend', onEnd)
      if (!leaving && !g) clearInline()
    }
    // 里面按钮的颜色过渡也会冒泡上来：只认弹层自己的 transform
    const onEnd = ev => { if (ev.target === el && ev.propertyName === 'transform') done() }
    el.addEventListener('transitionend', onEnd)
    setTimeout(done, ms + 50)
  }

  /* 拉过以后，手指下的按钮不要收到这次点击 */
  function swallowClick() {
    const stop = ev => { ev.stopPropagation(); ev.preventDefault() }
    window.addEventListener('click', stop, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', stop, true), 250)
  }

  return {
    on: { touchstart: onTouchstart, touchmove: onTouchmove, touchend: onTouchend, touchcancel: cancel },
    /** <Transition @before-leave>：不是拉下去关的（遮罩、返回键、Esc），清掉弹回途中的行内样式，照常离场 */
    beforeLeave() {
      if (leaving) return
      g = null
      cancelAnimationFrame(frame)
      frame = 0
      clearInline()
    },
    /** <Transition @after-leave>：下次打开从头来 */
    afterLeave() { leaving = false }
  }
}
