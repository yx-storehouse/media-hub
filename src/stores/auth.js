import { defineStore } from 'pinia'
import { get, post, patch, setUnauthorizedHandler } from '@/api/http'

const TOKEN_KEY = 'reel.token'
/* 上次核对成功的用户信息（名字、头像、角色）：启动时连不上服务器就先用它，不把人当成没登录 */
const USER_KEY = 'reel.user'
/* 启动时核对令牌连不上（断网、超时、5xx）后，隔多久再试（毫秒）；之后一直按最后一档；联网 / 回到前台时马上再试 */
const RETRY_MS = [2000, 5000, 15000, 30000]

/*
 * localStorage 读写都可能失败（隐私模式、存储被禁用）：失败就当没有，不影响使用。
 * 缓存的用户信息带着令牌的尾巴，换了令牌（别的账号）就不认。
 */
function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}
function readCachedUser(token) {
  try {
    const c = JSON.parse(localStorage.getItem(USER_KEY) || 'null')
    return c && c.t === String(token).slice(-12) && c.user && typeof c.user === 'object' && c.user.id != null ? c.user : null
  } catch {
    return null
  }
}
function writeCachedUser(token, user) {
  try {
    if (token && user) localStorage.setItem(USER_KEY, JSON.stringify({ t: String(token).slice(-12), user }))
    else localStorage.removeItem(USER_KEY)
  } catch { /* 存不了就算了 */ }
}

/*
 * 登录成功后要接着做的事（见 requireLogin）：{ redirect, then }。
 * 放在 store 外面：里面是函数，不算状态，也不该进 devtools / 持久化。
 */
let pending = null
/** 登录后跳转用；App.vue 里用 connectAuthToRouter 接上，store 不直接依赖 router */
let navigate = null
/** 令牌过期后在等用户重新登录的请求（http.js 的 relogin）：登录成功给新令牌，放弃给 null */
let waiters = []
let initPromise = null
/* 正在核对的令牌和那次请求：同一个令牌同时只核对一次（联网、回到前台、定时重试可能同时触发） */
let verifying = null
let retryTimer = 0
let retryStep = 0

function settleWaiters(token) {
  const list = waiters
  waiters = []
  for (const w of list) w(token)
}

/**
 * 登录状态。
 *
 * 令牌存在 localStorage，刷新后自动恢复（启动时 init() 向服务端核对一次）：
 *   - 服务端明确说令牌无效（/api/auth/me 回 null 或 401）才清掉；
 *   - 连不上（断网、超时、5xx、反向代理 502）时保留令牌，先用上次缓存的用户信息（verified 为 false），
 *     隔 2 / 5 / 15 / 30 秒、联网时、回到前台时再核对，核对上了就恢复，不会把人登出。
 *     这时 restoring 为 true；没有缓存（老版本登录的）时 user 还是 null，页面可以提示「暂时连不上，登录状态稍后恢复」。
 * 接口层遇到 401（令牌过期、在别处退出、改了密码）会调用 onUnauthorized()：弹出登录框并说明「登录已过期」，
 * 用户重新登录后，刚才那个请求（点赞、收藏、个人页面的读取）用新令牌自动再发一次（见 api/http.js 的 unauthorized 选项）。
 * 同一个浏览器的多个标签页：别的标签页退出 / 登录了，这里跟着变（storage 事件）；旧标签页收到 401 时
 * 不会删掉别的标签页刚写进去的新令牌，而是直接换用新令牌。
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: readToken(),
    user: null,
    /** 首次校验令牌是否有效（或者确认连不上、先用缓存）之前为 false，避免进页面就闪一下登录框 */
    ready: false,
    /** 这次打开以来服务端确认过这个令牌（核对成功或刚登录）；连不上服务器时为 false */
    verified: false,
    /** 登录弹层开关（LoginSheet 渲染）；关闭请用 closeLogin()，会一并作废待办 */
    loginOpen: false,
    /** 为什么弹登录框：'' 普通登录 / 'expired' 令牌过期（LoginSheet 显示「登录已过期，请重新登录」） */
    loginReason: ''
  }),
  getters: {
    loggedIn: state => !!state.user,
    isAdmin: state => state.user?.role === 'admin',
    displayName: state => state.user?.name || '未登录',
    /** 有令牌，但服务器暂时连不上、还没核对上（登录状态稍后自动恢复） */
    restoring: state => !!state.token && state.ready && !state.verified
  },
  actions: {
    /** 应用启动时调一次（重复调用共用同一次）：有令牌就向服务端核对，换取用户信息 */
    init() {
      if (!initPromise) initPromise = this.verify()
      return initPromise
    },

    /** 向服务端核对当前令牌（见上面的规则）；令牌在核对途中换掉了（登录、别的标签页）就不管这次的结果 */
    verify() {
      const token = this.token
      if (verifying && verifying.token === token) return verifying.p
      const p = this.verifyNow(token).finally(() => { if (verifying?.p === p) verifying = null })
      verifying = { token, p }
      return p
    },

    async verifyNow(token) {
      if (!token) {
        this.ready = true
        return
      }
      clearTimeout(retryTimer)
      retryTimer = 0
      try {
        const user = await get('/api/auth/me', null, { token, unauthorized: 'ignore', timeout: 8000 })
        if (token !== this.token) return
        if (user) {
          this.setUser(user)
          this.verified = true
          retryStep = 0
        } else {
          // 服务端明确说这个令牌没用了（过期、被退出、账号停用）：安静地清掉
          this.clearToken()
        }
      } catch (e) {
        if (token !== this.token) return
        if (e?.code === 'unauthorized') {
          this.clearToken()
        } else {
          // 连不上：令牌留着，先用缓存的用户信息，过一会儿再核对
          if (!this.user) this.user = readCachedUser(token)
          scheduleRetry(this)
        }
      } finally {
        this.ready = true
      }
    },

    async login(uid, password) {
      const res = await post('/api/auth/login', { uid, password }, { token: '', unauthorized: 'ignore' })
      this.setToken(res.token)
      this.setUser(res.user)
      this.verified = true
      this.finishLogin(res.user)
      return res.user
    },

    /** 登录成功（本页登录，或别的标签页登录后这里核对上了）：关登录框、补做待办、放行等着重发的请求 */
    finishLogin(user) {
      const next = pending
      pending = null
      this.loginOpen = false
      this.loginReason = ''
      settleWaiters(this.token)
      if (next) runPending(next, user)
    },

    async logout() {
      try {
        if (this.token) await post('/api/auth/logout', null, { token: this.token, unauthorized: 'ignore' })
      } catch {
        // 令牌可能已经失效，忽略即可
      }
      this.clearToken()
    },

    async changePassword(oldPassword, newPassword) {
      return post('/api/auth/password', { oldPassword, newPassword }, { token: this.token, unauthorized: 'prompt' })
    },

    async updateProfile(payload) {
      this.setUser(await patch('/api/auth/profile', payload))
      return this.user
    },

    setToken(token) {
      this.token = token
      try { localStorage.setItem(TOKEN_KEY, token) } catch { /* 存不了：这次打开里照样是登录的 */ }
    },

    setUser(user) {
      this.user = user || null
      writeCachedUser(this.token, this.user)
    },

    /**
     * 清掉登录状态。本机记的令牌只有还是自己这一个时才删：别的标签页刚登录写进去的新令牌不能被旧标签页删掉。
     */
    clearToken() {
      const t = this.token
      this.token = ''
      this.user = null
      this.verified = false
      clearTimeout(retryTimer)
      retryTimer = 0
      try {
        const stored = localStorage.getItem(TOKEN_KEY)
        if (!stored || stored === t) {
          localStorage.removeItem(TOKEN_KEY)
          localStorage.removeItem(USER_KEY)
        }
      } catch { /* 忽略 */ }
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
      if (!this.loginOpen) this.loginReason = ''
      this.loginOpen = true
      return false
    },

    /** 不登录、直接关掉登录框：待办作废，等着重发的请求按「未登录」失败 */
    closeLogin() {
      pending = null
      this.loginOpen = false
      this.loginReason = ''
      settleWaiters(null)
    },

    /**
     * 被接口层回调：带着 failedToken 的请求收到了 401。返回可以拿来重发的新令牌，或者 null。
     * wait 为 true 时（http.js 的 relogin）弹登录框并等结果：登录成功给新令牌，关掉登录框给 null。
     */
    onUnauthorized(failedToken, { wait = false } = {}) {
      const stored = readToken()
      // 别的标签页已经登录、换了新令牌：直接用它（不弹登录框），这个请求用新令牌重发
      if (stored && stored !== failedToken) {
        if (stored !== this.token) this.adopt(stored)
        return wait ? stored : null
      }
      // 本页已经换了令牌（重新登录完了，旧请求才回来）
      if (this.token && this.token !== failedToken) return wait ? this.token : null
      // 已经清掉过了（同一批过期的请求陆续回来）：登录框还开着就一起等，用户已经关掉了就不再弹
      if (!this.token) return wait && this.loginOpen ? new Promise(r => waiters.push(r)) : null
      this.clearToken()
      pending = null
      this.loginReason = 'expired'
      this.loginOpen = true
      return wait ? new Promise(r => waiters.push(r)) : null
    },

    /** 换用别的标签页写进来的令牌，并核对它是谁；登录框正开着（等登录）就当这里也登录成功了 */
    async adopt(token) {
      this.token = token
      this.verified = false
      if (this.user && readCachedUser(token)?.id !== this.user.id) this.user = null
      await this.verify()
      if (token === this.token && this.user && this.loginOpen) this.finishLogin(this.user)
    }
  }
})

/* 连不上服务器时隔一会儿再核对令牌（页面在后台时不试，回到前台马上试） */
function scheduleRetry(store) {
  clearTimeout(retryTimer)
  const ms = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)]
  retryStep++
  retryTimer = setTimeout(() => {
    retryTimer = 0
    if (document.visibilityState !== 'hidden') store.verify()
  }, ms)
}

/**
 * 在 main.js 里把 store 接到 HTTP 层（两边的依赖方向：http 不认识 store），
 * 并跟上别的标签页的登录 / 退出、联网和回到前台时补核对令牌。
 */
export function connectAuthToHttp(store) {
  setUnauthorizedHandler((token, opts) => store.onUnauthorized(token, opts))
  if (typeof window === 'undefined') return
  const recheck = () => {
    if (store.token && store.ready && !store.verified && document.visibilityState !== 'hidden') store.verify()
  }
  window.addEventListener('online', recheck)
  document.addEventListener('visibilitychange', recheck)
  // 别的标签页登录 / 退出（storage 事件只在别的标签页改了 localStorage 时才来）
  window.addEventListener('storage', e => {
    if (e.key !== TOKEN_KEY && e.key !== null) return
    const next = readToken()
    if (next === store.token) return
    if (!next) {
      // 在别处退出了：这里也变成没登录（不弹登录框，等用户自己点）
      store.token = ''
      store.user = null
      store.verified = false
      return
    }
    store.adopt(next)
  })
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
