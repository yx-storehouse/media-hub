import { defineStore } from 'pinia'
import { get, post, patch, setUnauthorizedHandler } from '@/api/http'

const TOKEN_KEY = 'reel.token'

/**
 * 登录状态。
 *
 * 令牌存在 localStorage，刷新后自动恢复；接口层遇到 401 会调用 onUnauthorized()，
 * 这里把用户清掉并弹出登录页（见 App.vue）。
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: null,
    /** 首次校验令牌是否有效，避免进页面就闪一下登录框 */
    ready: false,
    /** 登录弹层开关（由 Layout 渲染） */
    loginOpen: false,
    /** 登录成功后要回到哪里（可选） */
    redirect: null
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
      this.loginOpen = false
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

    /** 需要登录才能做的事：没登录就弹登录框，返回 false 让调用方中止 */
    requireLogin(redirect = null) {
      if (this.loggedIn) return true
      this.redirect = redirect
      this.loginOpen = true
      return false
    },

    /** 被接口层回调：令牌失效 */
    onUnauthorized() {
      if (!this.token) return
      this.clearToken()
      this.loginOpen = true
    }
  }
})

/** 在 main.js 里把 store 的方法接到 HTTP 层（两边的依赖方向：http 不认识 store） */
export function connectAuthToHttp(store) {
  setUnauthorizedHandler(() => store.onUnauthorized())
}
