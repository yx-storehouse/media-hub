import { cssEasing, spring, springFrom } from '@/utils/motion'

/*
 * 底部弹层下拉关闭（BottomSheet、LoginSheet 共用）：弹层跟着手指往下走、遮罩跟着变淡，
 * 松手时拉过弹层高度的 30%、或者往下甩得够快就关掉，否则弹回原位。
 * 松手后都是 smooth 弹簧，并且接着手指当时的速度走（甩得越快走得越快；往下拉着松手，会先顺势再往下一点才弹回）。
 *
 *   const drag = useSheetDrag(sheetEl, maskEl, close)
 *   <Transition name="sheet" @before-leave="drag.beforeLeave">
 *     <div ref="sheetEl" class="sheet" v-on="drag.on">…</div>
 *
 * 什么时候算「拉弹层」：第一下明显的移动是往下、竖直方向为主，并且弹层里手指下的内容已经在顶部
 * （没有往上滚过）。往上拉、横着划、内容还能往上滚时都交给浏览器照常滚动。
 * 拉过之后松手不会误触手指下的按钮。弹层还在升起、或者正在弹回时也能直接抓住，从它当时的位置接着拉。
 */

const DECIDE = 4      // px：移动超过这么多才判断方向
const CLOSE_AT = 0.3  // 拉过弹层高度的这个比例就关
const FLICK = 0.5     // px/ms：往下甩的速度超过它就关（不论拉了多远）
const SAMPLE_MS = 80  // 用最后这段时间里的移动算松手速度
const PAST = 64       // 关的时候落到屏幕下沿再往下这么多（和 BottomSheet 的 .sheet-leave-to 一致），弹簧收尾在屏幕外
const SWALLOW_MS = 300 // 松手后这么久之内、
const SWALLOW_PX = 12  // 离松手的地方这么近的点击，当作拖动顺带的，吞掉

/* 手指下（到弹层为止）有没有已经往上滚过的容器：有就让它先滚 */
function scrolledAbove(target, sheet) {
  for (let el = target; el && el !== sheet.parentNode; el = el.parentElement) {
    if (el.scrollTop > 0) return true
    if (el === sheet) break
  }
  return false
}

/* 元素现在看得见的竖直位移（升起、弹回途中被抓住时从这里接着拉）；只在开始拉的那一下读一次 */
function currentY(el) {
  const t = getComputedStyle(el).transform
  if (!t || t === 'none') return 0
  try { return new DOMMatrixReadOnly(t).m42 } catch { return 0 }
}

/**
 * @param {import('vue').Ref<HTMLElement|null>} sheetRef
 * @param {import('vue').Ref<HTMLElement|null>} maskRef
 * @param {() => void} close 关闭弹层（和点遮罩一样）
 */
export function useSheetDrag(sheetRef, maskRef, close) {
  let g = null          // 当前手势：{ x, y, mode: 0 未定 / 1 拉弹层 / -1 不管, dy, base, h, samples }
  let frame = 0
  let leaving = false   // 拉下去关闭：离场动画由这里接管，不要清掉行内样式
  let settling = null   // 正在弹回：{ done }，又被抓住时提前收尾

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
    g = { x: t.clientX, y: t.clientY, mode: scrolledAbove(e.target, el) ? -1 : 0, dy: 0, base: 0, h: 1, samples: [] }
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
      // 升起 / 弹回途中被抓住：从现在看到的位置接着拉，不会一下跳回原位
      g.base = Math.max(0, currentY(el))
      settling?.done(true)
      g.y = t.clientY // 从这里开始跟手，不会一下跳 4px
      // 关掉过渡的同时就把位置钉在现在看到的地方：否则在下一帧 paint() 之前，弹层会先闪到过渡的终点（原位）
      el.style.transition = 'none'
      el.style.transform = `translate3d(0, ${g.base}px, 0)`
      el.style.willChange = 'transform'
      const m = mask()
      if (m) {
        m.style.transition = 'none'
        m.style.opacity = String(Math.max(0, 1 - g.base / g.h))
      }
    }
    if (e.cancelable) e.preventDefault() // 拉弹层时不要再滚动里面的内容
    g.dy = Math.max(0, g.base + t.clientY - g.y)
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
    else settle(dy, v)
  }

  function cancel() {
    if (g && g.mode === 1) {
      cancelAnimationFrame(frame)
      frame = 0
      settle(g.dy, 0)
    }
    g = null
  }

  /*
   * 松手关闭：从当前位置接着往下走，弹簧的初速度就是手指的速度（换算成「每秒走完剩下路程的几倍」）。
   * 目标在屏幕下沿再往下 PAST，所以看得见的那段总在弹簧最快的时候走完。
   */
  function dismiss(dy, h, v) {
    const el = sheet()
    if (!el) return close()
    const rest = Math.max(1, h + PAST - dy)
    const { duration, easing } = springFrom('smooth', Math.max(0, v) * 1000 / rest)
    leaving = true
    el.style.transition = `transform ${duration}ms ${easing}`
    el.style.transform = `translate3d(0, calc(100% + ${PAST}px), 0)`
    const m = mask()
    if (m) {
      // 遮罩比弹层先淡完：弹层出屏的时候页面已经亮回来了
      m.style.transition = `opacity ${Math.round(duration * 0.6)}ms ${cssEasing('--ease-out')}`
      m.style.opacity = '0'
    }
    close()
  }

  /* 没拉够：弹回原位。手指还在往下走就先顺着往下一点再弹回来（初速度背离原位为负） */
  function settle(dy, v) {
    const el = sheet()
    if (!el) return
    const { duration, easing } = dy > 1 ? springFrom('smooth', -v * 1000 / dy) : spring('smooth')
    el.style.transition = `transform ${duration}ms ${easing}`
    el.style.transform = 'translate3d(0, 0, 0)'
    const m = mask()
    if (m) {
      m.style.transition = `opacity ${duration}ms ${easing}`
      m.style.opacity = '1'
    }
    let finished = false
    let timer = 0
    // 里面按钮的颜色过渡也会冒泡上来：只认弹层自己的 transform
    const onEnd = ev => { if (ev.target === el && ev.propertyName === 'transform') done(false) }
    const done = grabbed => {
      if (finished) return
      finished = true
      settling = null
      clearTimeout(timer)
      el.removeEventListener('transitionend', onEnd)
      // 又被抓住了：行内样式留给新的拖动接管
      if (!grabbed && !leaving && !g) clearInline()
    }
    el.addEventListener('transitionend', onEnd)
    timer = setTimeout(() => done(false), duration + 50)
    settling = { done }
  }

  /*
   * 拉过以后，手指下的按钮不要收到这次拖动「顺带」的点击：只吞掉紧跟着松手、落在松手那一点附近的那一下。
   * 别处的点击照常（弹层甩下去以后马上点页面上的卡片，不能被吞掉）。
   */
  function swallowClick(e) {
    const t = e?.changedTouches?.[0]
    if (!t) return
    const x = t.clientX
    const y = t.clientY
    const stop = ev => {
      if (Math.abs(ev.clientX - x) > SWALLOW_PX || Math.abs(ev.clientY - y) > SWALLOW_PX) return
      off()
      ev.stopPropagation()
      ev.preventDefault()
    }
    const timer = setTimeout(() => off(), SWALLOW_MS)
    const off = () => {
      clearTimeout(timer)
      window.removeEventListener('click', stop, true)
    }
    window.addEventListener('click', stop, true)
  }

  return {
    on: { touchstart: onTouchstart, touchmove: onTouchmove, touchend: onTouchend, touchcancel: cancel },
    /** <Transition @before-leave>：不是拉下去关的（遮罩、返回键、Esc），清掉弹回途中的行内样式，照常离场 */
    beforeLeave() {
      if (leaving) return
      g = null
      cancelAnimationFrame(frame)
      frame = 0
      settling?.done(true)
      clearInline()
    },
    /** <Transition @after-leave>：下次打开从头来 */
    afterLeave() { leaving = false }
  }
}
