import { nextTick } from 'vue'
import { START_LOCATION } from 'vue-router'
import { isDesktop } from './useDesktop'

/*
 * 桌面布局（≥ 1024px）的键盘焦点：
 *
 *   - 每一页的「主内容」是它里面最大的那个看得见的竖向滚动容器（.scroll，或者整页自己滚的那一页）。页面是各自滚动的，document 本身不滚，
 *     焦点在 <body>、左侧导航、顶栏上时浏览器不知道 PageDown / 空格 / ↓ / End 该滚哪个——所以换页后
 *     （和第一次打开时）把焦点放到新页面的主内容上（不显示焦点框、不滚动），键盘直接能滚，下一次 Tab 也从内容开始；
 *   - 返回（返回键、浏览器后退）时：焦点回到打开那一页时按的那张卡片 / 那个按钮（还在页面上的话；
 *     视频卡片按 data-vid 找），没有就落到主内容；
 *   - 顶栏最前面的「跳到主要内容」（只在键盘 Tab 到它时出现）调 focusMain()。
 * 焦点本来就在输入框里、或者开着弹层时不动它。手机布局不管（没有键盘）。
 *
 *   installMainFocus(router)   // App.vue 里调一次
 *   focusMain()                // 把焦点放到当前页面的主内容上
 */

/* 当前显示的那一页（换页动画里正在离开的那页不算） */
function currentPage() {
  const pages = [...document.querySelectorAll('.shell > .page')].filter(p => !/-leave-/.test(p.className))
  return pages[pages.length - 1] || null
}

/* 页面里最大的那个看得见的竖向滚动容器（各页的 .scroll；桌面播放页是整页自己滚） */
export function mainScroller(page = currentPage()) {
  if (!page) return null
  let best = null
  let area = 0
  for (const el of [page, ...page.querySelectorAll('.scroll')]) {
    if (!el.clientHeight || !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue
    const r = el.getBoundingClientRect()
    const a = r.width * r.height
    if (a > area) {
      best = el
      area = a
    }
  }
  return best
}

/** 把焦点放到当前页面的主内容上（不滚动、不显示焦点框），成功返回 true */
export function focusMain() {
  const el = mainScroller()
  if (!el) return false
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.dataset.main = ''
  el.focus({ preventScroll: true })
  return document.activeElement === el
}

/* 焦点现在在「没意义」的地方：<body>、左侧导航、顶栏（不是输入框），或者已经不在页面上了 */
function focusIsLost() {
  const a = document.activeElement
  if (!a || a === document.body || a === document.documentElement || !a.isConnected) return true
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) return false
  if (a.closest('.dside, .dtop')) return true
  // 还在离开中的那一页里（点的卡片、导航到别处的按钮）
  const page = a.closest('.shell > .page')
  return !!page && page !== currentPage()
}

const modalOpen = () => !!document.querySelector('[aria-modal="true"]')

export function installMainFocus(router) {
  /* history.state.position → 离开那一页时焦点所在的元素（返回时放回去） */
  const opener = new Map()
  let curPos = null

  router.beforeEach((to, from) => {
    if (!isDesktop.value || from === START_LOCATION || curPos == null) return
    const a = document.activeElement
    const page = currentPage()
    if (a && a !== document.body && page && page.contains(a)) {
      const vid = a.closest('[data-vid]')?.getAttribute('data-vid') || null
      opener.set(curPos, { el: a, vid })
      // 只留最近的一些（每一条都是 DOM 引用）
      if (opener.size > 50) opener.delete(opener.keys().next().value)
    }
  })

  router.afterEach((to, from, failure) => {
    const state = window.history.state
    curPos = state && typeof state.position === 'number' ? state.position : null
    if (failure || !isDesktop.value) return
    const pos = curPos
    const back = from !== START_LOCATION && !!state && typeof state.forward === 'string' && opener.has(pos)
    // 等新页面渲染出来（懒加载页面第一次可能晚几帧）
    let tries = 0
    const settle = () => {
      if (pos !== curPos) return // 又换页了
      const page = currentPage()
      if (!page && tries++ < 20) return requestAnimationFrame(settle)
      if (modalOpen()) return
      if (back) {
        const o = opener.get(pos)
        const el = o && (o.el.isConnected && page?.contains(o.el) ? o.el : o.vid ? page?.querySelector(`[data-vid="${CSS.escape(o.vid)}"]`) : null)
        if (el && el.getClientRects().length) {
          el.focus({ preventScroll: true })
          if (document.activeElement === el) return
        }
      }
      if (!focusIsLost()) return
      if (!focusMain() && tries++ < 20) requestAnimationFrame(settle)
    }
    nextTick(() => requestAnimationFrame(settle))
  })
}
