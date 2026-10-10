import { createRouter, createWebHashHistory } from 'vue-router'

/*
 * 管理后台路由（hash 模式：任何静态服务器上都能直接打开 admin.html#/videos）。
 * 页面全部按需加载；meta.public = 不需要登录（只有登录页）。
 * 列表页约定：?edit=<id> / ?edit=new 打开编辑抽屉（见 composables/useEditor.js），筛选条件也在地址栏里。
 */
const routes = [
  { path: '/login', name: 'login', component: () => import('./pages/LoginPage.vue'), meta: { public: true, title: '登录' } },
  { path: '/', name: 'dashboard', component: () => import('./pages/DashboardPage.vue'), meta: { title: '概览' } },
  { path: '/videos', name: 'videos', component: () => import('./pages/VideosPage.vue'), meta: { title: '视频' } },
  { path: '/posts', name: 'posts', component: () => import('./pages/PostsPage.vue'), meta: { title: '帖子' } },
  { path: '/topics', name: 'topics', component: () => import('./pages/TopicsPage.vue'), meta: { title: '专题' } },
  { path: '/creators', name: 'creators', component: () => import('./pages/CreatorsPage.vue'), meta: { title: '创作者' } },
  { path: '/sections', name: 'sections', component: () => import('./pages/SectionsPage.vue'), meta: { title: '首页推荐' } },
  { path: '/keywords', name: 'keywords', component: () => import('./pages/KeywordsPage.vue'), meta: { title: '搜索热词' } },
  { path: '/users', name: 'users', component: () => import('./pages/UsersPage.vue'), meta: { title: '账号' } },
  { path: '/media', name: 'media', component: () => import('./pages/MediaPage.vue'), meta: { title: '素材文件' } },
  { path: '/import', name: 'import', component: () => import('./pages/ImportPage.vue'), meta: { title: '批量导入' } },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

/* 组件示例页只在开发环境注册（打包时这段连同页面文件一起被去掉） */
if (import.meta.env.DEV) {
  routes.splice(routes.length - 1, 0, { path: '/_kit', name: 'kit', component: () => import('./pages/_KitPage.vue'), meta: { title: '组件示例' } })
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
