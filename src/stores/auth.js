import { defineStore } from 'pinia'
import { get, post, patch, setUnauthorizedHandler } from '@/api/http'

const TOKEN_KEY = 'reel.token'

/*
 * 登录成功后要接着做的事（见 requireLogin）：{ redirect, then }。
 * 放在 store 外面：里面是函数，不算状态，也不该进 devtools / 持久化。
 */
let pending = null
/** 登录后跳转用；App.vue 里用 connectAuthToRouter 接上，store 不直接依赖 router */
let navigate = null

/**
 * 登录状态。
 *
 * 令牌存在 localStorage，刷新后自动恢复；接口层遇到 401 会调用 onUnauthorized()，
 * 这里把用户清掉并弹出登录框（LoginSheet，挂在 App.vue）。
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: null,
    /** 首次校验令牌是否有效，避免进页面就闪一下登录框 */
    ready: false,
    /** 登录弹层开关（LoginSheet 渲染）；关闭请用 closeLogin()，会一并作废待办 */
    loginOpen: false
  }),
  getters: {
    loggedIn: state => !!state.user,
    isAdmin: state => state.user?.role === 'admin',
    displayName: state => state.user?.name || '未登录'
  },
  actions: {
    /** 应用启动时调一次：有令牌就换取用户信息 */
    async init() {
      if (this.token) {
        try {
          this.user = await get('/api/auth/me', null, { token: this.token })
        } catch {
          // 令牌过期或失效，安静地清掉
          this.clearToken()
        }
      }
      this.ready = true
    },

    async login(uid, password) {
      const res = await post('/api/auth/login', { uid, password })
      this.setToken(res.token)
      this.user = res.user
      const next = pending
      pending = null
      this.loginOpen = false
      if (next) runPending(next, res.user)
      return res.user
    },

    async logout() {
      try {
        if (this.token) await post('/api/auth/logout', null, { token: this.token })
      } catch {
        // 令牌可能已经失效，忽略即可
      }
      this.clearToken()
    },

    async changePassword(oldPassword, newPassword) {
      return post('/api/auth/password', { oldPassword, newPassword }, { token: this.token })
    },

    async updateProfile(payload) {
      this.user = await patch('/api/auth/profile', payload, { token: this.token })
      return this.user
    },

    setToken(token) {
      this.token = token
      localStorage.setItem(TOKEN_KEY, token)
    },

    clearToken() {
      this.token = ''
      this.user = null
      localStorage.removeItem(TOKEN_KEY)
    },

    /**
     * 需要登录才能做的事。已登录返回 true，调用方照常继续；
     * 没登录就弹登录框、返回 false 让调用方中止，登录成功后：
     *   - then(user)：补做这次操作（只执行一次），比如点赞、收藏、关注；
     *   - redirect：跳到这个地址（已经在这个地址上就不跳），比如「我的」→ 观看记录。
     * 两个都可选，先执行 then 再跳转。没登录就关掉登录框（遮罩、返回键、换页面）时两者作废，
     * 再次调用会替换上一次的待办。
     *
     *   if (!auth.requireLogin(route.fullPath, { then: () => toggleLike() })) return
     *   auth.requireLogin({ then: load })              // 也可以只传选项
     */
    requireLogin(redirect = null, options = {}) {
      if (this.loggedIn) return true
      if (redirect && typeof redirect === 'object') {
        options = redirect
        redirect = options.redirect || null
      }
      const then = typeof options.then === 'function' ? options.then : null
      pending = redirect || then ? { redirect, then } : null
      this.loginOpen = true
      return false
    },

    /** 不登录、直接关掉登录框：待办作废 */
    closeLogin() {
      pending = null
      this.loginOpen = false
    },

    /** 被接口层回调：令牌失效 */
    onUnauthorized() {
      if (!this.token) return
      this.clearToken()
      pending = null
      this.loginOpen = true
    }
  }
})

/** 在 main.js 里把 store 的方法接到 HTTP 层（两边的依赖方向：http 不认识 store） */
export function connectAuthToHttp(store) {
  setUnauthorizedHandler(() => store.onUnauthorized())
}

/** 在 App.vue 里接上路由：登录后的 redirect 用它跳转 */
export function connectAuthToRouter(router) {
  navigate = path => {
    if (path !== router.currentRoute.value.fullPath) router.push(path)
  }
}

/* 登录成功后的待办：先补做操作，再跳转（登录框的历史记录会先退掉，见 useBackDismiss） */
function runPending({ redirect, then }, user) {
  if (then) Promise.resolve().then(() => then(user)).catch(err => console.error(err))
  if (redirect && navigate) navigate(redirect)
}
