import { createRouter, createWebHashHistory } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { HOME_TABS, DEFAULT_HOME_TAB, KEEP_ALIVE_VIEWS } from '@/config/nav'
// the landing page ships in the entry bundle (no extra round trip before first paint); other pages are lazy
import HomeView from '@/views/home/HomeView.vue'

/*
 * meta.tabbar  -> show the bottom tab bar
 * meta.tab     -> which bottom tab is highlighted
 * Pages with meta.tabbar are kept alive (see App.vue), so switching tabs keeps their scroll position and state.
 */
const routes = [
  { path: '/', redirect: `/home/${DEFAULT_HOME_TAB}` },
  { path: '/home', redirect: `/home/${DEFAULT_HOME_TAB}` },
  {
    // only known tab ids match, case-sensitively and also on param-only changes; anything else falls through to the catch-all
    path: `/home/:tab(${HOME_TABS.map(t => t.id).join('|')})`,
    sensitive: true,
    name: 'home',
    component: HomeView,
    meta: { tabbar: true, tab: 'home' }
  },
  { path: '/short', name: 'short', component: () => import('@/views/ShortView.vue'), meta: { tabbar: true, tab: 'short' } },
  { path: '/live', name: 'live', component: () => import('@/views/LiveView.vue'), meta: { tabbar: true, tab: 'live' } },
  { path: '/community', name: 'community', component: () => import('@/views/CommunityView.vue'), meta: { tabbar: true, tab: 'community' } },
  { path: '/nearby', name: 'nearby', component: () => import('@/views/NearbyView.vue'), meta: { tabbar: true, tab: 'nearby' } },
  { path: '/me', name: 'me', component: () => import('@/views/MeView.vue'), meta: { tabbar: true, tab: 'me' } },
  { path: '/search', name: 'search', component: () => import('@/views/SearchView.vue') },
  // 播放页；id 来自接口（数字）或演示数据（如 rec0:3），链接里统一 encodeURIComponent
  { path: '/video/:id', name: 'video', component: () => import('@/views/VideoView.vue') },
  // numeric ids only; anything else falls through to the catch-all
  { path: '/topic/:id(\\d+)', name: 'topic', component: () => import('@/views/TopicView.vue') },
  { path: '/history', name: 'history', component: () => import('@/views/HistoryView.vue') },
  // 账号管理：需要管理员（前端拦一次给出友好提示，服务端还会再校验一次）
  {
    path: '/admin/users',
    name: 'admin-users',
    component: () => import('@/views/AdminUsersView.vue'),
    meta: { requiresAdmin: true }
  },
  { path: '/library', name: 'library', component: () => import('@/views/LibraryView.vue') },
  { path: '/:pathMatch(.*)*', redirect: `/home/${DEFAULT_HOME_TAB}` }
]

const router = createRouter({
  // hash history: works on any static host and inside native WebViews without server rewrites
  history: createWebHashHistory(),
  routes
})

/*
 * 路由守卫：需要登录 / 需要管理员的页面，在进入前就拦下来。
 * 未登录时弹登录框并留在原地，而不是先进去再报错。
 */
router.beforeEach(async to => {
  if (!to.meta.requiresAdmin) return true
  const { useAuthStore } = await import('@/stores/auth')
  const auth = useAuthStore()
  if (!auth.ready) await auth.init()
  if (!auth.loggedIn) {
    auth.requireLogin(to.fullPath)
    return false
  }
  if (!auth.isAdmin) {
    const { toast } = await import('@/composables/useToast')
    toast('需要管理员权限')
    return false
  }
  return true
})

router.afterEach(to => {
  if (to.name === 'home') useAppStore().lastHomeTab = to.params.tab

  // a tab-bar page that is not in KEEP_ALIVE_VIEWS would silently lose its state on every switch
  if (import.meta.env.DEV && to.meta.tabbar) {
    const view = to.matched[to.matched.length - 1]?.components?.default
    const name = view && (view.name || view.__name)
    if (name && !KEEP_ALIVE_VIEWS.includes(name)) console.warn(`[router] "${name}" shows the tab bar but is not listed in KEEP_ALIVE_VIEWS (src/config/nav.js)`)
  }
})

/** Warm up the other pages' chunks once the first screen is idle, so later navigation is instant. */
export function prefetchRoutes() {
  const run = () => routes.forEach(r => typeof r.component === 'function' && r.component())
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 3000 })
  else setTimeout(run, 1500)
}

export default router
