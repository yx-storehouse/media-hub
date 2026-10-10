/*
 * 管理后台入口（admin.html）。和移动端应用（src/main.js）完全独立：
 * 不用 pinia、不加载应用的样式和组件，只共用 src/api/http.js 这一个请求工具。
 */
import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { installAuth } from './auth'
import { toast } from './components/toast'

import './styles/admin.css'

const app = createApp(App)
installAuth(router)
app.use(router)

/* 兜底：渲染出错或漏掉的异步错误，至少给一个看得见的提示 */
app.config.errorHandler = err => {
  console.error(err)
  toast('页面出错：' + (err?.message || err), { type: 'error' })
}
window.addEventListener('unhandledrejection', e => {
  const err = e.reason
  if (err?.name === 'AbortError') { e.preventDefault(); return }
  toast(err?.message || '操作失败，请重试', { type: 'error' })
})

/* 发版后旧页面去加载已不存在的页面文件：提示刷新 */
router.onError(err => {
  if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(err?.message || '')) {
    toast('页面文件已更新，请刷新浏览器', { type: 'error', duration: 8000 })
  } else {
    toast('页面加载失败：' + (err?.message || err), { type: 'error' })
  }
})

router.isReady().then(() => app.mount('#admin'))
