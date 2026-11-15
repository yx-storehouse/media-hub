import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router, { prefetchRoutes } from './router'
import { useAuthStore, connectAuthToHttp } from './stores/auth'
import { setTokenProvider } from './api/http'
import { vPress } from './directives/press'
import { installPress } from './components/motion/press'
import { toast } from './composables/useToast'
import { isChunkError } from './utils/chunkRetry'
import { installMainFocus } from './composables/useMainFocus'

import './styles/tokens.css'
import './styles/motion.css'
import './styles/base.css'
import './styles/common.css'

const app = createApp(App)
app.use(createPinia())

/* 登录态要在路由挂载前就接好：页面首次请求就需要带上令牌 */
const auth = useAuthStore()
setTokenProvider(() => auth.token)
connectAuthToHttp(auth)
auth.init()

app.use(router)
/* 桌面布局：换页后焦点落到新页面的内容上（键盘直接能滚），返回时回到刚才那张卡片（见 composables/useMainFocus.js） */
installMainFocus(router)
app.directive('press', vPress)
/* 全局按压反馈：卡片、按钮按下缩一点、松手弹回（一组委托监听，见 components/motion/press.js） */
installPress()

/* last line of defence: a failed request or render error shows a message instead of failing silently */
app.config.errorHandler = err => {
  console.error(err)
  toast('出错了，请稍后重试')
}
window.addEventListener('unhandledrejection', e => {
  const err = e.reason
  // 取消的请求不用提示；页面代码加载失败由路由自己恢复（router/index.js），不再多弹一句
  if (err?.name === 'AbortError' || isChunkError(err)) return
  toast('网络开小差了，请稍后重试')
})

/*
 * 一打开就是的那一页代码怎么都加载不上时（router.onError 会整页重载一次 / 退回首页），isReady 会失败：
 * 照样挂载，不留一个黑屏。首屏的数据都回来、空闲以后才去预取别的页面（见 prefetchRoutes）。
 */
router.isReady().catch(() => {}).then(() => {
  app.mount('#app')
  prefetchRoutes()
})
