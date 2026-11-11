import { computed, reactive, readonly, shallowRef, watch } from 'vue'
import { isDesktop } from './useDesktop'

/*
 * 桌面布局的左侧导航：展开（232px，图标 + 文字）还是收成图标栏（72px，图标下面一行小字）。
 *
 *   默认：窗口 ≥ 1280px 展开，1024–1279px 收起；
 *   顶栏的 ☰ 切换，记在本机（localStorage，读写都包 try/catch），之后不管窗口多宽都按记下的来；
 *   路由 meta.deskRail 的页面（播放页、短视频）默认收起，在这些页面上点 ☰ 只是这一次临时展开，不记，
 *   换到别的页面（路由名变了）就恢复。
 *
 * 宽度通过 :root 上的 CSS 变量 --desk-side 给页面（App.vue 在 <html> 上加 / 去 .desk-rail，
 * 样式在 styles/tokens.css）。JS 里要知道当前宽度时读 deskSide.width / deskSide.rail（只读、响应式）。
 * 手机布局下这些值照样算，但不起作用（<html> 上也不会加类，免得手机上换页时整页重算样式）。
 */
export const DESK_SIDE_FULL = 232
export const DESK_SIDE_RAIL = 72
export const DESK_WIDE_MQ = '(min-width: 1280px)'

const KEY = 'reel:desk-side'

const wideMq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia(DESK_WIDE_MQ)
  : null
const wide = shallowRef(!!wideMq?.matches)
if (wideMq) {
  const onChange = e => { wide.value = !!e.matches }
  if (typeof wideMq.addEventListener === 'function') wideMq.addEventListener('change', onChange)
  else if (typeof wideMq.addListener === 'function') wideMq.addListener(onChange)
}

function readPref() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'full' || v === 'rail' ? v : ''
  } catch {
    return ''
  }
}
function writePref(v) {
  try { localStorage.setItem(KEY, v) } catch { /* 存不了就只在这次打开里有效 */ }
}

/** 用户点 ☰ 记下的选择：'full' | 'rail' | ''（没选过，按窗口宽度） */
const pref = shallowRef(readPref())
/** 当前路由（App.vue 接上）；meta.deskRail 的页面默认收起 */
const routeRef = shallowRef(null)
const routeRail = computed(() => !!routeRef.value?.meta?.deskRail)
/** 在 deskRail 页面上临时展开了 */
const railOpened = shallowRef(false)

const rail = computed(() => {
  if (routeRail.value) return !railOpened.value
  if (pref.value) return pref.value === 'rail'
  return !wide.value
})

/** 左侧导航的状态（只读）：{ rail: 是否收成图标栏, width: 现在的宽度 px } */
export const deskSide = readonly(reactive({
  rail,
  width: computed(() => (rail.value ? DESK_SIDE_RAIL : DESK_SIDE_FULL))
}))

/** 顶栏 ☰：展开 ↔ 收起 */
export function toggleDeskSide() {
  if (routeRail.value) {
    railOpened.value = !railOpened.value
    return
  }
  pref.value = rail.value ? 'full' : 'rail'
  writePref(pref.value)
}

/**
 * App.vue 的 setup 里调一次：接上当前路由，并在 <html> 上维护 .desk-rail（只在桌面布局时加）。
 * 用默认的 pre 时机：路由一变，类名在新页面渲染之前就换好，同一帧画出来。
 * @param {import('vue-router').RouteLocationNormalizedLoaded} route useRoute() 的结果
 */
export function bindDeskSide(route) {
  routeRef.value = route
  watch(() => route.name, () => { railOpened.value = false })
  const root = typeof document !== 'undefined' ? document.documentElement : null
  watch(() => [isDesktop.value && rail.value, route.name], ([on, name], old) => {
    if (!root || root.classList.contains('desk-rail') === on) return
    /*
     * 换页带来的宽度变化（进出播放页、短视频）：类名一换，屏幕上的页面马上按新宽度排版。离开的那页要是在
     * App.vue 的 before-leave 把它钉住之前就被读了布局（onBeforeUnmount 里量东西之类），它的网格会按新宽度重排一次，
     * Chrome 的滚动锚定跟着改掉 scrollTop，返回时回到错的位置。所以先把屏幕上的页面钉在旧位置（行内 left，
     * App.vue 的 after-leave / leave-cancelled / before-enter 会去掉），再换类名。
     * 同一个页面上点 ☰、窗口变宽变窄不钉：页面本来就该跟着变。
     * 导航变宽（图标栏 → 展开，比如从播放页回来）时，钉住的页面同时浮到导航上面（z-index 和导航一样、DOM 里在后面），
     * 不被一下子展开的导航盖掉左边一截；见 App.vue 的 onPageLeave，一起在那里去掉。
     */
    if (old && old[1] !== name && isDesktop.value) {
      const px = `${on ? DESK_SIDE_FULL : DESK_SIDE_RAIL}px`
      for (const p of root.querySelectorAll('.shell > .page')) {
        p.style.left = px
        if (!on) {
          p.style.zIndex = '43'
          p.style.pointerEvents = 'none'
        }
      }
    }
    root.classList.toggle('desk-rail', on)
  }, { immediate: true })
}
