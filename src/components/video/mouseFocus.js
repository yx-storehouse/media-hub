import { unref } from 'vue'
import { isDesktop } from '@/composables/useDesktop'

/*
 * 桌面（鼠标 + 键盘）：鼠标点过的按钮不留焦点，之后按空格还是播放 / 暂停。播放页（VideoView + VideoPlayer）和短视频页共用。
 *
 * Chrome 在按过键以后把鼠标点出来的焦点也当成键盘焦点（:focus-visible），空格就会再按一下刚点的那个按钮
 * （取消刚点的赞 / 收藏、又静音、退出全屏、又换一批、又把导航收起来），而不是播放 / 暂停。所以分两层：
 *
 *   1. 页面里的按钮：鼠标按下时焦点不留在按钮上（和 Safari 一样）。useMouseFocusGuard(根元素) 返回两个监听，挂在页面根上：
 *        const guard = useMouseFocusGuard(root)
 *        <div ref="root" @pointerdown.capture="guard.onPointerDown" @focusin="guard.onFocusIn">
 *      按下鼠标的那一下按钮收到的焦点直接交回页面的主内容（[data-main]，见 composables/useMainFocus.js，键盘照样能滚；
 *      没有就还给 <body>）；焦点本来就在页面里某个按钮上（Tab 走过来的）又用鼠标点了别处，也不留。键盘走过来的焦点照旧。
 *   2. 页面外面的按钮（顶栏的 ☰、「登录」……）管不到焦点：记下鼠标最后按下的那个按钮，空格时 spaceToPlayer() 把焦点还回去，
 *      这一下照样是播放 / 暂停。鼠标按在别处、按 Tab 走开就不算了；开着弹出菜单的按钮（头像菜单）空格照常归它。
 *
 *   空格键：if (!spaceToPlayer(e.target)) return   // false：焦点在键盘走过来的按钮上，空格按那个按钮
 */

/** 按钮一类（空格会按下它）；链接也算：焦点在键盘走过来的链接上时空格交给浏览器 */
const BTN = 'button, a[href], [role="button"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemradio"]'
/** 鼠标点了不留焦点的控件：按钮一类加上滑块（进度条、音量条） */
const CONTROL = `${BTN}, [role="slider"]`
const isTyping = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/* 鼠标最后按下的那个按钮（任何地方）：全 App 一份，第一次用到时挂上监听（捕获阶段，先于页面自己的处理） */
let mouseBtn = null
let installed = false
function install() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('pointerdown', e => {
    mouseBtn = isDesktop.value && e.pointerType === 'mouse' && e.target instanceof Element ? e.target.closest(BTN) : null
  }, true)
  document.addEventListener('keydown', e => { if (e.key === 'Tab') mouseBtn = null }, true)
}

/** 焦点在键盘走过来的按钮上（Tab 过来的；老 Safari 不认 :focus-visible 时当作是） */
function keyboardButton(t) {
  if (!t.closest(BTN)) return false
  try { return t.matches(':focus-visible') } catch { return true }
}

/**
 * 空格该不该当成播放 / 暂停：焦点不在按钮上 → 是；在鼠标点过、焦点还留着的按钮上 → 先把焦点还回去，是；
 * 在键盘走过来的按钮上 → 不是（空格照常按下它）
 */
export function spaceToPlayer(t) {
  install()
  if (!(t instanceof Element) || !keyboardButton(t)) return true
  if (!mouseBtn || t.closest(BTN) !== mouseBtn || mouseBtn.matches('[aria-haspopup][aria-expanded="true"]')) return false
  t.blur()
  mouseBtn = null
  return true
}

/** 页面根上的两个监听（见文件开头）：root 是根元素的 ref */
export function useMouseFocusGuard(root) {
  install()
  let mouseFocusing = false
  /* 把焦点交回页面的主内容（键盘还能滚这一页）；没有就让它落到 <body> 上 */
  function release(el) {
    const r = unref(root)
    el.blur()
    const main = r && (r.matches('[data-main]') ? r : r.querySelector('[data-main]'))
    // 全屏时主内容在全屏元素外面：只把焦点还给 <body>，不往外挪
    const fs = document.fullscreenElement || document.webkitFullscreenElement
    if (main && main !== el && (!fs || fs.contains(main))) main.focus({ preventScroll: true })
  }
  function onPointerDown(e) {
    if (!isDesktop.value || e.pointerType !== 'mouse') return
    const a = document.activeElement
    if (a instanceof Element && unref(root)?.contains(a) && !isTyping(a) && a.matches(CONTROL)) release(a)
    mouseFocusing = true
    setTimeout(() => { mouseFocusing = false })
  }
  function onFocusIn(e) {
    const t = e.target
    if (mouseFocusing && t instanceof Element && !isTyping(t) && t.matches(CONTROL)) release(t)
  }
  return { onPointerDown, onFocusIn }
}
