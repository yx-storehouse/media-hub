import { createRouter, createWebHashHistory, START_LOCATION } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { HOME_TABS, DEFAULT_HOME_TAB, KEEP_ALIVE_VIEWS } from '@/config/nav'
import { LAZY_VIEWS } from '@/config/views'
import { whenApiIdle } from '@/api/http'
import { setPageTitle } from '@/composables/usePageTitle'
// 静态导入（它本来就在入口里）：断网时再 import() 它也会失败，提示就出不来
import { toast } from '@/composables/useToast'
import { isChunkError, whenOnline, probe, sleep, importFresh, ensureStyles, reloadOnce } from '@/utils/chunkRetry'
// 弹层跟随返回键：它的 popstate 监听要比路由的先注册，所以在创建路由之前导入
import { installBackDismiss } from '@/composables/useBackDismiss'
// the landing page ships in the entry bundle (no extra round trip before first paint); other pages are lazy
import HomeView from '@/views/home/HomeView.vue'

/*
 * meta.tabbar  -> show the bottom tab bar
 * meta.tab     -> which bottom tab is highlighted
 * meta.title   -> 浏览器标题「<title> - Reel」（内容页拿到数据后自己换成内容的标题，见 composables/usePageTitle.js）
 * meta.deskRail -> 桌面布局（≥ 1024px）下左侧导航默认收成图标栏（播放页：播放器和相似推荐要宽）。短视频是导航里的主入口，不收——刚点的导航不能在鼠标底下缩一截，见 composables/useDeskSide.js
 * Pages with meta.tabbar are kept alive (see App.vue), so switching tabs keeps their scroll position and state.
 * 懒加载的页面都用 lazyView 包一层（下载失败自动重试，见下面），并在 src/config/views.js 登记（深链提前下载、空闲预取）。
 */

/* 浏览器里 window.__REEL_VIEWS__ 是打包时写进 index.html 的「页面 → 文件」清单（vite.config.js 的 viewChunks）；开发环境没有 */
const viewFiles = view => (typeof window !== 'undefined' && window.__REEL_VIEWS__?.[view]?.f) || null

/*
 * 页面代码下载失败（断网几秒、服务器 / 容器重启、换 Wi-Fi）时的恢复，用户什么都不用做：
 *   原地址再试一次（Chrome、Firefox 这样就好了）→ 看一眼服务器：
 *     断网 / 连不上：提示一句，等联网，隔 1 / 2 / 4 / 8 秒用带参数的新地址再试（Safari 内核会记住失败的地址，见 utils/chunkRetry.js），
 *                    样式表也补上；
 *     文件不在了（发了新版本）：交给 router.onError 整页重新加载；
 *   都不行（大约半分钟）才交给 router.onError。
 */
const RETRY_WAIT = [1000, 2000, 4000, 8000, 8000]
let noticeAt = -1e9
function notice(text) {
  if (performance.now() - noticeAt < 4000) return
  noticeAt = performance.now()
  toast(text, 2200)
}
/** 页面名 → 原始的 import（空闲预取用：文件已经在缓存里了，不需要重试，也不要提示） */
const loaders = {}
function lazyView(view, load) {
  const fn = () => load().catch(async err => {
    if (!isChunkError(err)) throw err
    const files = viewFiles(view)
    // 先补上没加载成功的样式表（Vite 对每个 CSS 只试一次），再加载页面代码：fresh 时换新地址
    const attempt = async fresh => {
      if (files) await ensureStyles(files)
      return fresh && files ? importFresh(files[0]) : load()
    }
    try {
      return await attempt(false)
    } catch (e) {
      if (!isChunkError(e)) throw e
    }
    for (const wait of RETRY_WAIT) {
      // 开发环境没有文件清单：不看服务器，直接原地址再试
      const state = files ? await probe(files[0]) : 'unknown'
      if (state === 'missing') throw err
      if (state === 'offline') {
        notice(navigator.onLine === false ? '网络已断开，连上网后自动打开' : '网络不太稳定，正在重试…')
        await whenOnline()
        await sleep(wait)
        continue
      }
      try {
        return await attempt(true)
      } catch (e) {
        if (!isChunkError(e)) throw e
        await sleep(wait)
      }
    }
    throw err
  })
  loaders[view] = load
  return fn
}

const routes = [
  { path: '/', redirect: `/home/${DEFAULT_HOME_TAB}` },
  { path: '/home', redirect: `/home/${DEFAULT_HOME_TAB}` },
  {
    // only known tab ids match, case-sensitively and also on param-only changes; anything else falls through to the catch-all
    path: `/home/:tab(${HOME_TABS.map(t => t.id).join('|')})`,
    sensitive: true,
    name: 'home',
    component: HomeView,
    meta: { tabbar: true, tab: 'home', title: '首页' }
  },
  { path: '/short', name: 'short', component: lazyView('ShortView', () => import('@/views/ShortView.vue')), meta: { tabbar: true, tab: 'short', title: '短视频' } },
  { path: '/live', name: 'live', component: lazyView('LiveView', () => import('@/views/LiveView.vue')), meta: { tabbar: true, tab: 'live', title: '直播' } },
  { path: '/community', name: 'community', component: lazyView('CommunityView', () => import('@/views/CommunityView.vue')), meta: { tabbar: true, tab: 'community', title: '社区' } },
  { path: '/nearby', name: 'nearby', component: lazyView('NearbyView', () => import('@/views/NearbyView.vue')), meta: { tabbar: true, tab: 'nearby', title: '同城' } },
  { path: '/me', name: 'me', component: lazyView('MeView', () => import('@/views/MeView.vue')), meta: { tabbar: true, tab: 'me', title: '我的' } },
  { path: '/search', name: 'search', component: lazyView('SearchView', () => import('@/views/SearchView.vue')), meta: { title: '搜索' } },
  // 播放页；id 来自接口（数字）或演示数据（如 rec0:3），链接里统一 encodeURIComponent
  { path: '/video/:id', name: 'video', component: lazyView('VideoView', () => import('@/views/VideoView.vue')), meta: { deskRail: true, title: '视频' } },
  // 帖子详情（社区卡片点进来）；id 同样可能来自接口或演示数据，链接里 encodeURIComponent
  { path: '/post/:id', name: 'post', component: lazyView('PostView', () => import('@/views/PostView.vue')), meta: { title: '帖子' } },
  // 创作者主页（?tab=videos|posts）；id 来自接口（数字）或演示数据（如 aijc、c1），链接里 encodeURIComponent
  { path: '/creator/:id', name: 'creator', component: lazyView('CreatorView', () => import('@/views/CreatorView.vue')), meta: { title: '创作者' } },
  // 只认数字 id（接口）和 demo:数字（演示数据，见 src/api/mock-fallback.js）；其他的落到最后的兜底路由
  { path: '/topic/:id(\\d+|demo:\\d+)', name: 'topic', component: lazyView('TopicView', () => import('@/views/TopicView.vue')), meta: { title: '专题' } },
  { path: '/history', name: 'history', component: lazyView('HistoryView', () => import('@/views/HistoryView.vue')), meta: { title: '观看历史' } },
  // 我的收藏（?tab=video|post|topic）、我的关注：「我的」页统计行点进来，未登录时页面里给登录入口
  { path: '/favorites', name: 'favorites', component: lazyView('FavoritesView', () => import('@/views/FavoritesView.vue')), meta: { title: '我的收藏' } },
  { path: '/follows', name: 'follows', component: lazyView('FollowsView', () => import('@/views/FollowsView.vue')), meta: { title: '我的关注' } },
  // 账号管理：需要管理员（前端拦一次给出友好提示，服务端还会再校验一次）
  {
    path: '/admin/users',
    name: 'admin-users',
    component: lazyView('AdminUsersView', () => import('@/views/AdminUsersView.vue')),
    meta: { requiresAdmin: true, title: '账号管理' }
  },
  { path: '/library', name: 'library', component: lazyView('LibraryView', () => import('@/views/LibraryView.vue')), meta: { title: '片库' } },
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
  const auth = useAuthStore()
  if (!auth.ready) await auth.init()
  const stay = from === START_LOCATION ? '/me' : false
  if (!auth.loggedIn) {
    auth.requireLogin(to.fullPath)
    return stay
  }
  if (!auth.isAdmin) {
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

/* 换页后的浏览器标题：路由的固定标题；搜索页带上关键词。同一页只改了查询参数（排序、下一集的序号）时不动，留着页面设的内容标题 */
function routeTitle(to) {
  if (to.name === 'search') {
    const q = typeof to.query.q === 'string' ? to.query.q.trim() : ''
    return q ? `${q} - 搜索` : '搜索'
  }
  return to.meta.title || ''
}

router.afterEach((to, from, failure) => {
  if (to.name === 'home') useAppStore().lastHomeTab = to.params.tab

  if (!failure && (to.path !== from.path || to.name === 'search' || from === START_LOCATION)) setPageTitle(routeTitle(to))

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

/*
 * 页面代码怎么都加载不上（lazyView 的重试也失败了）：
 *   服务器连得上（多半是发了新版本，旧页面里的文件名过期了）→ 整页重新加载一次，直接落到要去的那一页（30 秒内只重载一次）；
 *   连不上，或者已经重载过还是不行 → 提示一句、留在原地（一打开就失败时回首页：首页随入口加载，总能显示）。
 */
router.onError(async (err, to) => {
  if (!isChunkError(err)) return
  const target = to?.fullPath
  if ((await probe('./')) === 'ok') {
    const reloading = reloadOnce('reel:chunk-reload', () => {
      if (target && target !== router.currentRoute.value.fullPath) router.options.history.replace(target)
    })
    if (reloading) return
  }
  notice(navigator.onLine === false ? '网络已断开，请连上网后重试' : '页面加载失败，请检查网络后重试')
  if (router.currentRoute.value === START_LOCATION) router.replace(homePath()).catch(() => {})
})

/* ---------------- 空闲时预取别的页面 ---------------- */

/*
 * 首屏的数据都回来、页面空闲以后，再把别的页面的代码下载进 HTTP 缓存，之后点过去不用等：
 *   - 等 window load + 接口安静 0.5 秒 + 浏览器空闲：不和首屏的接口、图片抢连接（HTTP/1.1 每个站点只有 6 条连接）；
 *   - 按 src/config/views.js 的顺序一次下载 2 个文件（低优先级）；省流量模式、2G 不预取，3G 只预取最常去的 4 个页面
 *     （短视频、播放页、社区、创作者）；账号管理只给管理员预取；
 *   - 用 fetch 只把文件放进 HTTP 缓存，一个页面的文件都下好了才 import 它（提前编译好）：
 *     下载失败（正好断网）不会在 Safari 内核里留下「这个模块加载失败」的记录（见 utils/chunkRetry.js）。
 * 开发环境没有文件清单：空闲时直接 import。
 */
let prefetchStarted = false
export function prefetchRoutes() {
  if (prefetchStarted || typeof window === 'undefined') return
  prefetchStarted = true
  const conn = navigator.connection
  const type = conn?.effectiveType || ''
  if (conn?.saveData || /2g$/.test(type)) return
  const slow = type === '3g'
  const idle = fn => ('requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 300))
  const loaded = new Promise(resolve => {
    if (document.readyState === 'complete') resolve()
    else window.addEventListener('load', resolve, { once: true })
  })
  loaded.then(() => whenApiIdle(500)).then(() => idle(() => runPrefetch(slow ? 4 : Infinity)))
}

async function runPrefetch(limit) {
  const isAdmin = useAuthStore().isAdmin
  const views = LAZY_VIEWS.filter(v => !v.admin || isAdmin).slice(0, limit)
  const manifest = !!window.__REEL_VIEWS__
  const seen = new Set()
  for (const v of views) {
    if (navigator.onLine === false) return
    const load = loaders[v.view]
    if (!manifest) {
      if (load) await load().catch(() => {})
      continue
    }
    const files = (viewFiles(v.view) || []).filter(f => !seen.has(f))
    files.forEach(f => seen.add(f))
    const ok = await warm(files)
    if (ok && load) await load().catch(() => {})
  }
}

/* 把文件下载进 HTTP 缓存（同时最多 2 个、低优先级），全部成功返回 true */
async function warm(files) {
  let ok = true
  for (let i = 0; i < files.length; i += 2) {
    const batch = files.slice(i, i + 2).map(f => fetch(f, { credentials: 'same-origin', priority: 'low' })
      .then(r => { if (!r.ok) ok = false; return r.arrayBuffer() })
      .catch(() => { ok = false }))
    await Promise.all(batch)
  }
  return ok
}

/* 开发环境：懒加载页面要在 src/config/views.js 登记（深链提前下载和空闲预取靠它），两边对得上 */
if (import.meta.env.DEV) {
  const listed = LAZY_VIEWS.map(v => v.view)
  for (const v of Object.keys(loaders)) if (!listed.includes(v)) console.warn(`[router] 懒加载页面 ${v} 没有登记在 src/config/views.js`)
  for (const v of listed) if (!loaders[v]) console.warn(`[router] src/config/views.js 里的 ${v} 没有对应的路由`)
}

export default router
