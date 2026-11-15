/*
 * 管理后台的登录态（不用 pinia：后台只有这一份全局状态，reactive 就够了）。
 *
 * 令牌单独存在 localStorage 的 reel.admin.token，和移动端应用的登录互不影响。
 * 只有管理员能进后台：普通账号登录会立刻退出并提示「该账号不是管理员」。
 *
 * 用着用着收到 401（另一个标签页点了退出、密码被重置、账号被停用）：
 *   不跳登录页（编辑到一半的内容会丢），而是在原地弹「登录已过期」对话框（ReloginModal）。
 *   重新登录成功后，刚才失败的请求（保存、上传、列表）用新令牌自动再发一次（src/api/http.js 的 relogin 机制），
 *   表单里的内容一直都在；点「取消」就留在原页面（内容可以先复制出来），下次请求还会再问。
 * 标签页之间同步（storage 事件）：别的标签页登录了，这里直接换上新令牌（正在等重新登录的请求也一起用它）；
 *   别的标签页退出了，这里先不动（可能正编辑到一半、正在上传），下次请求 401 时弹对话框。
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

/** 原地重新登录的对话框（App.vue 里的 ReloginModal 渲染）：open 时显示；uid 预填上次的登录名 */
export const relogin = reactive({ open: false, uid: '' })
let reloginWait = null // Promise<新令牌 | null>
let reloginDone = null

let router = null
let initPromise = null

function clear(message = '') {
  session.token = ''
  session.user = null
  session.message = message
  writeToken('')
}

/* 回登录页（登录后再回到现在这一页） */
function toLogin() {
  const cur = router?.currentRoute.value
  if (router && cur?.name !== 'login') {
    router.replace({ name: 'login', query: cur?.fullPath && cur.fullPath !== '/' ? { redirect: cur.fullPath } : {} })
  }
}

/* 重新登录有了结果：新令牌（登录成功 / 别的标签页登录了）或 null（取消） */
function settleRelogin(token) {
  relogin.open = false
  const done = reloginDone
  reloginWait = null
  reloginDone = null
  done?.(token)
}

/**
 * 接口层遇到 401 时调用（http.js 与 api.uploadFile 共用）。
 * failedToken：发请求时带的令牌；wait：调用方要等重新登录的结果（拿到新令牌后重发请求）。
 * 返回新令牌（或它的 Promise）；null = 不重发。
 */
export function handleUnauthorized(failedToken = '', { wait = false } = {}) {
  // 这个请求发出之后令牌已经换了（别的标签页登录了 / 刚刚重新登录过）：用新的再发一次
  if (session.token && failedToken && failedToken !== session.token && session.user) return session.token
  if (!session.token && !session.user) return null
  const cur = router?.currentRoute.value
  // 还没进后台（登录页、启动时）：照旧清掉、去登录页
  if (!router || !session.user || cur?.meta?.public) {
    clear('登录已失效，请重新登录')
    toLogin()
    return null
  }
  if (!reloginWait) {
    reloginWait = new Promise(resolve => { reloginDone = resolve })
    relogin.uid = session.user?.uid || ''
    relogin.open = true
  }
  return wait ? reloginWait : null
}

/** 对话框里点「取消」：留在原页面，等着的请求按 401 失败（页面提示「登录已过期」），下次请求会再问 */
export function cancelRelogin() {
  settleRelogin(null)
}

/** 对话框里登录：成功后正在等的请求用新令牌重发 */
export async function reloginWith(uid, password) {
  const user = await login(uid, password)
  settleRelogin(session.token)
  return user
}

setTokenProvider(() => session.token)
setUnauthorizedHandler(handleUnauthorized)

/** 启动时校验一次本地令牌；重复调用共用同一个请求 */
export function init() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (session.token) {
      try {
        // ignore：令牌失效就是没登录，不弹重新登录框
        const user = await get('/api/auth/me', null, { token: session.token, unauthorized: 'ignore' })
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
    try { await post('/api/auth/logout', null, { token: res?.token, unauthorized: 'ignore' }) } catch { /* 忽略 */ }
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
  if (relogin.open) settleRelogin(null)
  clear('')
  try { if (token) await post('/api/auth/logout', null, { token, unauthorized: 'ignore' }) } catch { /* 令牌可能已失效，忽略 */ }
  router?.replace({ name: 'login' })
}

/*
 * 别的标签页改了令牌（同一个浏览器的后台标签页共用 reel.admin.token）：
 *   - 登录了 / 重新登录了：核对一下新令牌，换上；正在等重新登录的请求直接用它重发；在登录页的话进去
 *   - 退出了：不动（这里可能正编辑到一半、正在上传），下次请求 401 时弹重新登录框
 */
let syncSeq = 0
async function onStorage(e) {
  if (e.key !== TOKEN_KEY && e.key !== null) return
  const next = readToken()
  if (!next || next === session.token) return
  const my = ++syncSeq
  let user = null
  try { user = await get('/api/auth/me', null, { token: next, unauthorized: 'ignore' }) } catch { return }
  if (my !== syncSeq || readToken() !== next || user?.role !== 'admin') return
  session.token = next
  session.user = user
  session.message = ''
  if (reloginWait) settleRelogin(next)
  const cur = router?.currentRoute.value
  if (router && cur?.name === 'login') router.replace(safeRedirect(cur.query.redirect))
}

/** 在 main.js 里调用：记住 router，并装上登录守卫 */
export function installAuth(r) {
  router = r
  window.addEventListener('storage', onStorage)
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
