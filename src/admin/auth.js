/*
 * 管理后台的登录态（不用 pinia：后台只有这一份全局状态，reactive 就够了）。
 *
 * 令牌单独存在 localStorage 的 reel.admin.token，和移动端应用的登录互不影响。
 * 只有管理员能进后台：普通账号登录会立刻退出并提示「该账号不是管理员」。
 * 任何接口返回 401（令牌过期、被停用、密码被重置）都会清掉登录态并跳回登录页。
 */
import { reactive } from 'vue'
import { get, post, setTokenProvider, setUnauthorizedHandler } from '@/api/http'

const TOKEN_KEY = 'reel.admin.token'

const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' } }
const writeToken = t => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) } catch { /* 隐私模式等：只在本页有效 */ }
}

/** token：令牌；user：{ id, uid, name, role, … }；ready：首次校验完成；message：登录页要显示的提示 */
export const session = reactive({ token: readToken(), user: null, ready: false, message: '' })

let router = null
let initPromise = null

function clear(message = '') {
  session.token = ''
  session.user = null
  session.message = message
  writeToken('')
}

/** 接口层遇到 401 时调用（http.js 与 api.uploadFile 共用） */
export function handleUnauthorized() {
  if (!session.token && !session.user) return
  clear('登录已失效，请重新登录')
  const cur = router?.currentRoute.value
  if (router && cur?.name !== 'login') {
    router.replace({ name: 'login', query: cur?.fullPath && cur.fullPath !== '/' ? { redirect: cur.fullPath } : {} })
  }
}

setTokenProvider(() => session.token)
setUnauthorizedHandler(handleUnauthorized)

/** 启动时校验一次本地令牌；重复调用共用同一个请求 */
export function init() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (session.token) {
      try {
        const user = await get('/api/auth/me', null, { token: session.token })
        if (!user) clear('登录已失效，请重新登录')
        else if (user.role !== 'admin') clear('需要管理员账号')
        else session.user = user
      } catch (e) {
        // 接口连不上：保留令牌（服务恢复后刷新即可），先去登录页给出原因
        if (e.status === 401) clear('登录已失效，请重新登录')
        else session.message = '无法连接接口服务：' + e.message
      }
    }
    session.ready = true
  })()
  return initPromise
}

export async function login(uid, password) {
  const res = await post('/api/auth/login', { uid, password }, { token: '' })
  if (res?.user?.role !== 'admin') {
    // 普通账号：立刻注销刚拿到的会话，不在后台留下登录态
    try { await post('/api/auth/logout', null, { token: res?.token }) } catch { /* 忽略 */ }
    throw new Error('该账号不是管理员')
  }
  session.token = res.token
  session.user = res.user
  session.message = ''
  writeToken(res.token)
  return res.user
}

export async function logout() {
  const token = session.token
  clear('')
  try { if (token) await post('/api/auth/logout', null, { token }) } catch { /* 令牌可能已失效，忽略 */ }
  router?.replace({ name: 'login' })
}

/** 在 main.js 里调用：记住 router，并装上登录守卫 */
export function installAuth(r) {
  router = r
  r.beforeEach(async to => {
    if (!session.ready) await init()
    if (to.meta.public) {
      // 已登录还访问登录页：直接去目标页
      if (to.name === 'login' && session.user) return safeRedirect(to.query.redirect)
      return true
    }
    if (!session.user) {
      return { name: 'login', query: to.fullPath && to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
    }
    return true
  })
}

/** 只接受站内 hash 路由路径，防止 redirect 参数被拿来跳到外部地址 */
export function safeRedirect(r) {
  const s = Array.isArray(r) ? r[0] : r
  return typeof s === 'string' && s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/login') ? s : '/'
}
