import { createRouter, createWebHashHistory, START_LOCATION } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { HOME_TABS, DEFAULT_HOME_TAB, KEEP_ALIVE_VIEWS } from '@/config/nav'
// 弹层跟随返回键：它的 popstate 监听要比路由的先注册，所以在创建路由之前导入
import { installBackDismiss } from '@/composables/useBackDismiss'
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
  // 帖子详情（社区卡片点进来）；id 同样可能来自接口或演示数据，链接里 encodeURIComponent
  { path: '/post/:id', name: 'post', component: () => import('@/views/PostView.vue') },
  // 创作者主页（?tab=videos|posts）；id 来自接口（数字）或演示数据（如 aijc、c1），链接里 encodeURIComponent
  { path: '/creator/:id', name: 'creator', component: () => import('@/views/CreatorView.vue') },
  // 只认数字 id（接口）和 demo:数字（演示数据，见 src/api/mock-fallback.js）；其他的落到最后的兜底路由
  { path: '/topic/:id(\\d+|demo:\\d+)', name: 'topic', component: () => import('@/views/TopicView.vue') },
  { path: '/history', name: 'history', component: () => import('@/views/HistoryView.vue') },
  // 我的收藏（?tab=video|post|topic）、我的关注：「我的」页统计行点进来，未登录时页面里给登录入口
  { path: '/favorites', name: 'favorites', component: () => import('@/views/FavoritesView.vue') },
  { path: '/follows', name: 'follows', component: () => import('@/views/FollowsView.vue') },
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
installBackDismiss(router)

/*
 * 路由守卫：需要登录 / 需要管理员的页面，在进入前就拦下来。
 * 未登录时弹登录框并留在原地（登录后再进去），而不是先进去再报错。
 * 一打开就是这一页（书签、刷新）时没有「原地」可留，拦下来会是白屏：改落到「我的」。
 */
router.beforeEach(async (to, from) => {
  if (!to.meta.requiresAdmin) return true
  const { useAuthStore } = await import('@/stores/auth')
  const auth = useAuthStore()
  if (!auth.ready) await auth.init()
  const stay = from === START_LOCATION ? '/me' : false
  if (!auth.loggedIn) {
    auth.requireLogin(to.fullPath)
    return stay
  }
  if (!auth.isAdmin) {
    const { toast } = await import('@/composables/useToast')
    toast('需要管理员权限')
    return stay
  }
  return true
})

/*
 * 返回键先回首页（Tab 之间的切换见 TabBar.vue）：非首页 Tab 的下面总要有一条首页记录。
 * 落在最底下一条的非首页 Tab（书签、分享链接直接打开；子页面没有上一页时退回 Tab）：
 * 只改历史记录，不导航——当前记录改成首页，再把这个 Tab 压上去。页面不会先渲染一次首页，
 * 按返回时才真正回到首页。刷新时记录里已经有上一页（state.back），不会重复垫。
 */
const isSideTab = r => !!r.meta.tabbar && r.meta.tab !== 'home'
const homePath = () => `/home/${useAppStore().lastHomeTab}`

router.afterEach((to, from, failure) => {
  if (to.name === 'home') useAppStore().lastHomeTab = to.params.tab

  if (!failure && isSideTab(to) && !(window.history.state && window.history.state.back)) {
    const h = router.options.history
    h.replace(homePath())
    h.push(to.fullPath)
  }

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
