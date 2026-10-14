import { ref } from 'vue'
import { START_LOCATION } from 'vue-router'
import { reducedMotion } from '@/utils/motion'

/*
 * 页面切换用哪种动效（App.vue 的路由出口和底部导航用同一个名字，样式在 styles/motion.css）：
 *   pg-fwd   进入子页面（压栈、浏览器前进）
 *   pg-back  返回（返回键、安卓返回手势、浏览器后退，以及「替换」回到底部 Tab，比如没有上一页时的返回）
 *   pg-fade  底部 Tab 之间（不管是压栈、替换还是退回首页）
 *   ''       不做动画：刚打开 App、系统开了「减少动态效果」、浏览器自己已经做过滑动（iOS Safari 边缘右滑返回）
 *
 * 方向看 history.state.position（路由每压一条 +1，替换不变，后退时变小）：
 *   - 返回键 / 手势 / 浏览器前进后退：路由的 history.listen 直接给出 delta；
 *   - 代码里 push / replace：比较跳转前后的 position。
 * 「下一篇」「下一个」这类替换当前记录、但还是同一个页面组件的跳转，页面组件不换，路由出口不做动画，
 * 由页面自己处理内容的更替。
 */

/** 最近一次页面切换：列表入场动效（v-rise）用它判断「这是返回时恢复出来的内容」，不再播入场动画 */
export const pageMotion = {
  name: '',
  at: 0,          // performance.now()
  rendering: false // 跳转后新页面首次渲染的这一轮（同一个任务内）
}

const IOS = typeof navigator !== 'undefined'
  && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/*
 * iOS Safari 从屏幕边缘右滑返回时，浏览器自己已经把上一页的截图滑出来了，我们再滑一次就是两遍。
 * 新浏览器在 popstate 上直接告诉我们（hasUAVisualTransition）；iOS 14–17 没有这个字段，
 * 就看「从边缘开始、被系统接管（没有正常抬起、没有产生点击）的触摸」之后紧跟着的后退。
 */
let edgeTouchAt = 0
if (IOS) {
  const EDGE = 24
  window.addEventListener('touchstart', e => {
    const x = e.touches[0]?.clientX ?? -1
    edgeTouchAt = x >= 0 && (x < EDGE || x > window.innerWidth - EDGE) ? performance.now() : 0
  }, { capture: true, passive: true })
  // 正常抬起、产生了点击（比如点了左上角的返回按钮）：不是系统手势
  window.addEventListener('touchend', () => { edgeTouchAt = 0 }, { capture: true, passive: true })
  window.addEventListener('click', () => { edgeTouchAt = 0 }, true)
}

const posOf = state => (state && typeof state.position === 'number' ? state.position : null)

/**
 * App.vue 里调一次。返回页面切换的名字（ref）。
 * @param {import('vue-router').Router} router
 */
export function usePageTransition(router) {
  const name = ref('')
  let popDelta = null   // 这次是后退 / 前进：position 的变化
  let uaSlide = false   // 浏览器自己已经做过切换动画
  let fromPos = null    // push / replace 之前的 position

  router.options.history.listen((to, from, info) => { popDelta = info.delta })
  // 在路由自己的 popstate 监听之后注册，跳转（异步）完成之前一定已经记下
  window.addEventListener('popstate', e => {
    uaSlide = !!e.hasUAVisualTransition || (edgeTouchAt > 0 && performance.now() - edgeTouchAt < 5000)
    edgeTouchAt = 0
  })
  // push / replace 时 history.state 还是跳转前的那条（后退时已经是目标那条，但那种情况用 popDelta）
  router.beforeEach(() => { fromPos = posOf(window.history.state) })

  router.afterEach((to, from, failure) => {
    const delta = popDelta
    const ua = uaSlide
    popDelta = null
    uaSlide = false
    if (failure) return

    const isTab = r => !!r.meta.tabbar
    let n = ''
    if (from === START_LOCATION || ua || reducedMotion()) n = ''
    else if (isTab(to) && isTab(from)) n = 'pg-fade'
    else {
      let d = delta
      if (d === null) {
        const p = posOf(window.history.state)
        d = p !== null && fromPos !== null ? p - fromPos : 1
      }
      // 替换当前记录：回到底部 Tab 当返回（子页面没有上一页时的返回），其余当前进
      if (d === 0) d = isTab(to) && !isTab(from) ? -1 : 1
      n = d < 0 ? 'pg-back' : 'pg-fwd'
    }
    name.value = n
    pageMotion.name = n
    pageMotion.at = performance.now()
    pageMotion.rendering = true
    // 新页面在这之后的微任务里渲染、挂载；一个宏任务之后就不算「首次渲染」了
    setTimeout(() => { pageMotion.rendering = false })
  })

  return name
}
