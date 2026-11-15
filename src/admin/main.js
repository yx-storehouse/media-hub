/*
 * 管理后台入口（admin.html）。和移动端应用（src/main.js）完全独立：
 * 不用 pinia、不加载应用的样式和组件，只共用 src/api/http.js（页面文件加载失败的恢复用后台自己的 utils/chunkRetry.js）。
 */
import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { installAuth } from './auth'
import { toast, toasts } from './components/toast'
import { hasUnsavedChanges } from './composables/useLeaveGuard'
import { MSG } from '@/api/http'
import { isChunkError, probe, reloadOnce, whenOnline, sleep } from './utils/chunkRetry'

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
  // 页面文件加载失败：router.onError 已经处理（刷新 / 提示），这里不再报一遍英文原文
  if (isChunkError(err)) { e.preventDefault(); return }
  toast(err?.message || '操作失败，请重试', { type: 'error' })
})

/*
 * 页面文件加载失败（router.js 的 lazy() 已经等联网、重试过一次）：
 *   - 服务器能连上：多半是发了新版本、旧标签页要的文件已经删了 → 整页重新加载到要去的那一页（30 秒内只重载一次）；
 *     页面上有没保存的修改就不刷新，提示先保存（刷新会丢）；
 *   - 连不上服务器：提示网络问题，等联网 / 服务器回来（隔 2、4、8…最长 30 秒看一眼，最多等 10 分钟）后自动再去一次。
 */
let staleToast = 0
let pendingTarget = null

/** 等到服务器能连上：断网时等 online 事件，否则（NAS 重启之类）隔一会儿看一眼 */
async function waitForServer(maxMs = 10 * 60000) {
  const end = Date.now() + maxMs
  let wait = 2000
  while (Date.now() < end) {
    if (navigator.onLine === false) {
      if (!(await whenOnline(end - Date.now()))) return false
    } else {
      await sleep(wait)
      wait = Math.min(wait * 2, 30000)
    }
    if ((await probe('./admin.html')) === 'ok') return true
  }
  return false
}

router.onError(async (err, to) => {
  if (!isChunkError(err)) {
    toast('页面加载失败：' + (err?.message || err), { type: 'error' })
    return
  }
  const target = to?.fullPath
  if ((await probe('./admin.html')) === 'ok') {
    if (hasUnsavedChanges()) {
      // 不自动消失（关掉之后再点别的页面会再出现）
      if (!toasts.some(t => t.id === staleToast)) staleToast = toast('后台已更新：请先保存修改，再刷新浏览器', { type: 'error', duration: 0 })
      return
    }
    const reloading = reloadOnce('reel:admin-chunk-reload', () => {
      if (target && target !== router.currentRoute.value.fullPath) router.options.history.replace(target)
    })
    if (reloading) return
    toast('页面文件加载失败，请刷新浏览器', { type: 'error', duration: 8000 })
    return
  }
  // 已经在等了：只换成最新要去的页面，不重复提示
  const waiting = pendingTarget !== null
  pendingTarget = target || ''
  if (waiting) return
  toast(MSG.network + '，连上后会自动打开', { type: 'error', duration: 8000 })
  const from = router.currentRoute.value.fullPath
  const ok = await waitForServer()
  const dest = pendingTarget
  pendingTarget = null
  // 期间用户自己去了别的页面（成功了）就不再跳
  if (ok && dest && router.currentRoute.value.fullPath === from) router.push(dest).catch(() => {})
})

/* 第一页就加载失败也要把外壳挂上（onError 会刷新或提示），不能整页空白 */
router.isReady().catch(() => {}).then(() => app.mount('#admin'))
