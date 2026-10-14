import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router, { prefetchRoutes } from './router'
import { useAuthStore, connectAuthToHttp } from './stores/auth'
import { setTokenProvider } from './api/http'
import { vPress } from './directives/press'
import { installPress } from './components/motion/press'
import { toast } from './composables/useToast'

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
app.directive('press', vPress)
/* 全局按压反馈：卡片、按钮按下缩一点、松手弹回（一组委托监听，见 components/motion/press.js） */
installPress()

/* last line of defence: a failed request or render error shows a message instead of failing silently */
app.config.errorHandler = err => {
  console.error(err)
  toast('出错了，请稍后重试')
}
window.addEventListener('unhandledrejection', () => toast('网络开小差了，请稍后重试'))

router.isReady().then(() => {
  app.mount('#app')
  prefetchRoutes()
})
