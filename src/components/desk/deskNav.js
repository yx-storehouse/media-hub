import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { MAIN_TABS, DESK_SECTION, isHomePath } from '@/config/nav'
import { emitTabRetap } from '@/composables/useTabRetap'
import { scrollBehavior } from '@/utils/motion'

/*
 * 桌面布局的导航（左侧导航、顶栏的 Logo / 头像菜单共用）：
 *
 *   const nav = useDeskNav()
 *   nav.activeId          现在高亮哪一项（DESK_NAV 的 id；'' = 都不高亮）
 *   nav.hrefOf(item)      链接地址（#/…，中键 / Ctrl + 点击在新标签页打开）
 *   nav.open(item, e)     点了一项：底部 Tab 页和点底部导航一样，其余的压栈（要登录的先登录）
 *
 * 底部 Tab 页之间的历史记录规则和 TabBar.vue 一样（返回键先回首页）：从首页去别的 Tab 压栈，非首页 Tab 之间替换，
 * 回首页 / 回到上一条记录就退回去，不叠重复的记录；从子页面点 Tab 压栈（上一条就是它时退回去，列表和滚动位置原样）。
 * 再点一次当前 Tab = 底部导航的「再点一次」（useTabRetap：回顶 / 刷新）；刚切过来 350ms 内的连点不算（双击不会一到短视频就刷新掉）。
 * 再点一次当前的子页面（观看历史、片库……）：滚回顶部。
 */
const RETAP_GUARD = 350

let selectedAt = -1e9
let busy = false

export function useDeskNav() {
  const route = useRoute()
  const router = useRouter()
  const store = useAppStore()
  const auth = useAuthStore()

  const tabPath = id => (id === 'home' ? `/home/${store.lastHomeTab}` : MAIN_TABS.find(t => t.id === id)?.path || '/')
  const pathOf = item => (item.tab ? tabPath(item.tab) : item.path)
  const hrefOf = item => router.resolve(pathOf(item)).href
  const activeId = computed(() => route.meta.tab || DESK_SECTION[route.name] || '')

  function track(p) {
    busy = true
    Promise.resolve(p).catch(() => {}).finally(() => { busy = false })
  }

  /** 上一条记录就是要去的地方：退回去（KeepAlive 的页面原样回来），返回 true */
  function backIfPrevious(to, homeToo) {
    const back = window.history.state && window.history.state.back
    if (back !== to && !(homeToo && isHomePath(back))) return false
    router.back()
    return true
  }

  function goTab(id) {
    const to = tabPath(id)
    if (route.meta.tab === id && to === route.fullPath) {
      if (busy || performance.now() - selectedAt < RETAP_GUARD) return
      emitTabRetap(id)
      return
    }
    selectedAt = performance.now()
    if (backIfPrevious(to, id === 'home' && !!route.meta.tab)) return
    if (!route.meta.tab || route.meta.tab === 'home') track(router.push(to))
    else track(router.replace(to))
  }

  function goPath(item) {
    if (route.path === item.path) {
      scrollPageTop()
      return
    }
    if (item.login && !auth.requireLogin(item.path)) return
    if (backIfPrevious(item.path, false)) return
    track(router.push(item.path))
  }

  /**
   * 点了一项（左侧导航、Logo、头像菜单）。带修饰键 / 中键的点击交给浏览器（新标签页打开）。
   * @param {{ tab?: string, path?: string, login?: boolean }} item
   * @param {MouseEvent} [e]
   */
  function open(item, e) {
    if (e) {
      if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
    }
    if (item.tab) goTab(item.tab)
    else goPath(item)
  }

  return { activeId, hrefOf, pathOf, open, goTab }
}

/* 当前页面（最上面那一页）里看得见的第一个竖向滚动容器滚回顶部 */
function scrollPageTop() {
  const pages = document.querySelectorAll('.shell > .page')
  const page = pages[pages.length - 1]
  if (!page) return
  for (const el of page.querySelectorAll('.scroll')) {
    if (el.clientHeight && el.scrollTop > 0) {
      el.scrollTo({ top: 0, behavior: scrollBehavior() })
      return
    }
  }
}
