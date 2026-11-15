import { createRouter, createWebHashHistory } from 'vue-router'
import { isChunkError, whenOnline, sleep, ensureStyles } from './utils/chunkRetry'
import { toast } from './components/toast'

/*
 * 管理后台路由（hash 模式：任何静态服务器上都能直接打开 admin.html#/videos）。
 * 页面全部按需加载；meta.public = 不需要登录（只有登录页）。
 * 列表页约定：?edit=<id> / ?edit=new 打开编辑抽屉（见 composables/useEditor.js），筛选条件也在地址栏里。
 *
 * 页面文件下载失败（断网几秒、NAS / 容器重启）：lazy() 等联网后原地址再试一次（Chrome 会重新下载）；
 * 断网时先提示一句（不然点了没反应），连上网后自动打开。
 * 失败的是样式表（Vite 报「Unable to preload CSS for …」）就先换个带参数的地址把它补上。
 * 还是不行（发了新版本、旧文件已经删了）交给 main.js 的 router.onError：整页重新加载 / 提示。
 */
let noticeAt = -1e9
function lazy(load) {
  return () => load().catch(async err => {
    if (!isChunkError(err)) throw err
    if (navigator.onLine === false && performance.now() - noticeAt > 4000) {
      noticeAt = performance.now()
      toast('网络已断开，连上网后自动打开这个页面', { type: 'error', duration: 6000 })
    }
    if (!(await whenOnline())) throw err
    await sleep(600)
    // 样式表补不上就别继续（不然页面打开了却没有样式），交给 onError
    const css = /Unable to preload CSS for (\S+)/i.exec(err?.message || '')?.[1]
    if (css) await ensureStyles([css]).catch(() => { throw err })
    return load()
  })
}

const routes = [
  { path: '/login', name: 'login', component: lazy(() => import('./pages/LoginPage.vue')), meta: { public: true, title: '登录' } },
  { path: '/', name: 'dashboard', component: lazy(() => import('./pages/DashboardPage.vue')), meta: { title: '概览' } },
  { path: '/videos', name: 'videos', component: lazy(() => import('./pages/VideosPage.vue')), meta: { title: '视频' } },
  { path: '/posts', name: 'posts', component: lazy(() => import('./pages/PostsPage.vue')), meta: { title: '帖子' } },
  { path: '/albums', name: 'albums', component: lazy(() => import('./pages/AlbumsPage.vue')), meta: { title: '图片' } },
  { path: '/topics', name: 'topics', component: lazy(() => import('./pages/TopicsPage.vue')), meta: { title: '专题' } },
  { path: '/creators', name: 'creators', component: lazy(() => import('./pages/CreatorsPage.vue')), meta: { title: '创作者' } },
  { path: '/sections', name: 'sections', component: lazy(() => import('./pages/SectionsPage.vue')), meta: { title: '首页推荐' } },
  { path: '/keywords', name: 'keywords', component: lazy(() => import('./pages/KeywordsPage.vue')), meta: { title: '搜索热词' } },
  { path: '/users', name: 'users', component: lazy(() => import('./pages/UsersPage.vue')), meta: { title: '账号' } },
  { path: '/media', name: 'media', component: lazy(() => import('./pages/MediaPage.vue')), meta: { title: '素材文件' } },
  { path: '/import', name: 'import', component: lazy(() => import('./pages/ImportPage.vue')), meta: { title: '批量导入' } },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

/* 组件示例页只在开发环境注册（打包时这段连同页面文件一起被去掉） */
if (import.meta.env.DEV) {
  routes.splice(routes.length - 1, 0, { path: '/_kit', name: 'kit', component: lazy(() => import('./pages/_KitPage.vue')), meta: { title: '组件示例' } })
}

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  // 列表页翻页靠地址栏参数，内容区自己滚动，这里不需要恢复滚动位置
  scrollBehavior: () => false
})

router.afterEach(to => {
  document.title = to.meta.title ? `${to.meta.title} · Reel 管理后台` : 'Reel 管理后台'
})

export default router
