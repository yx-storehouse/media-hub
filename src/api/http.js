/*
 * HTTP 客户端。
 *
 * 统一处理：基础地址、JSON 解析、code!=0 报错、超时、请求取消、令牌失效后重新登录再补发。
 * 页面里不要直接用这个文件，用 src/api/index.js（那里定义了每个接口）。
 *
 * 出错时抛的 ApiError，message 已经是给用户看的话（见下面 MSG），页面统一用 errorText(e) 取提示文字：
 *   断网 / 连不上 →「网络连接失败，请检查网络」  超时 →「请求超时，请检查网络」
 *   5xx、网关回的不是 JSON（反向代理正在重启的 502 页面）→「服务器开小差了，请稍后重试」
 *   只有 4xx 才用接口自己的说明（「帖子不存在或已下架」之类）
 */

/**
 * 接口地址，按优先级取值：
 *   1. .env 里的 VITE_API_BASE（生产环境指向真实域名）
 *   2. 开发环境走 Vite 代理的 /api（见 vite.config.js）
 */
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

/** 统一的出错文案（用户端、管理后台共用；页面里别再自己写一套） */
export const MSG = Object.freeze({
  network: '网络连接失败，请检查网络',
  /* 出错页上、浏览器报告断网时（navigator.onLine 为 false）：会自动重试的页面用它 */
  offline: '网络已断开，连上网后会自动重新加载',
  timeout: '请求超时，请检查网络',
  server: '服务器开小差了，请稍后重试',
  login: '登录已过期，请重新登录',
  load: '加载失败，请稍后重试',
  action: '操作失败，请稍后重试'
})

/**
 * 令牌：由 auth store 注入，避免 http 层直接依赖 store（会形成循环引用）。
 * 401 时回调 auth store（setUnauthorizedHandler），见 request() 的 unauthorized 选项。
 */
let tokenProvider = () => ''
/** (failedToken, { wait }) => 新令牌 | null | Promise<新令牌 | null>：wait 时等用户重新登录完（或放弃）再给结果 */
let onUnauthorized = () => null
export const setTokenProvider = fn => { tokenProvider = fn }
export const setUnauthorizedHandler = fn => { onUnauthorized = fn }

export class ApiError extends Error {
  /** field：出错的字段名（管理后台的表单据此把错误显示在对应输入框下） */
  constructor(message, { status, code, field } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.field = field
  }
}

/** 是不是「连不上 / 服务器出错」这一类（断网、超时、5xx、网关页面）：页面据此决定要不要自动重试 */
export const isNetworkError = e => !!e && (['network', 'timeout', 'bad_response'].includes(e.code) || e.status >= 500)

/**
 * 把任何错误变成给用户看的一句话（出错页、提示条都用它）：
 *   errorText(e)                       // 加载出错：默认「加载失败，请稍后重试」
 *   errorText(e, MSG.action)           // 操作出错：不认识的错误（代码异常之类）用这句
 * 取消（AbortError）返回 ''：调用方不用提示。
 */
export function errorText(e, fallback = MSG.load) {
  if (!e) return fallback
  if (e.name === 'AbortError') return ''
  if (e instanceof ApiError) {
    if (e.code === 'network') return MSG.network
    if (e.code === 'timeout') return MSG.timeout
    if (e.code === 'unauthorized') return e.message || MSG.login
    if (e.code === 'bad_response' || e.status >= 500) return MSG.server
    return e.message || fallback
  }
  return fallback
}

/* ---------------- 正在进行的请求（首屏「数据都回来了」的信号，见 whenApiIdle） ---------------- */

let active = 0
let lastActivity = 0

/**
 * 等接口都空下来：没有进行中的请求，并且已经安静了 quiet 毫秒。
 * 首屏的数据回来之后才去预取别的页面（router/index.js 的 prefetchRoutes），不和首屏的接口抢连接。
 */
export function whenApiIdle(quiet = 300) {
  return new Promise(resolve => {
    const check = () => {
      const idleFor = performance.now() - lastActivity
      if (!active && idleFor >= quiet) resolve()
      else setTimeout(check, active ? 100 : quiet - idleFor)
    }
    check()
  })
}

/**
 * @param {string} path   以 / 开头的接口路径，如 /api/home/recommend
 * @param {object} [options]
 * @param {object} [options.query]  查询参数，值为 undefined / null 的会被丢掉
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} [options.method]
 * @param {object} [options.body]   POST / PATCH / PUT 的 JSON 请求体
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeout] 毫秒，默认 12 秒
 * @param {boolean} [options.keepalive] 页面卸载后也把请求发完（请求体要小于 64 KB）
 * @param {string} [options.token]  指定令牌（不传用当前登录的）
 * @param {'relogin'|'prompt'|'ignore'} [options.unauthorized] 带着令牌却收到 401（令牌过期、在别处退出、被停用）时：
 *   relogin（默认）弹登录框（「登录已过期，请重新登录」），等用户重新登录后用新令牌把这个请求再发一次，
 *            调用方拿到的就是重发的结果——点赞、收藏、个人页面的读取都不用自己处理；用户不登录就关掉时抛 unauthorized；
 *   prompt   弹登录框但不重发，直接抛 unauthorized（改密码这种不该自动重做的）；
 *   ignore   什么都不做，直接抛（启动时核对令牌、退出登录）。
 *   keepalive 的请求默认 prompt（页面要关了，等不到重新登录）。
 */
export async function request(path, options = {}) {
  const { query, method = 'GET', body, signal, timeout = 12000, keepalive = false } = options

  let url = BASE + path
  if (query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.append(k, String(v))
    }
    const s = qs.toString()
    if (s) url += (url.includes('?') ? '&' : '?') + s
  }

  /* 超时 + 外部取消，合并成一个 signal */
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeout)
  const onAbort = () => ctrl.abort(signal.reason)
  if (signal?.aborted) ctrl.abort(signal.reason) // 传进来时就已经取消了：不再发请求
  else if (signal) signal.addEventListener('abort', onAbort, { once: true })

  const token = options.token !== undefined ? options.token : tokenProvider()
  let res
  active++
  lastActivity = performance.now()
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      // 页面隐藏 / 关闭时的上报（如观看进度）：页面卸载后浏览器也会把请求发完
      keepalive
    })

    if (res.status !== 401) {
      let json = null
      const text = await res.text()
      if (text) {
        try { json = JSON.parse(text) } catch {
          // 不是 JSON：多半是反向代理 / 网关的错误页面（NAS 正在重启之类），没打到接口服务
          throw new ApiError(MSG.server, { status: res.status, code: 'bad_response' })
        }
      }
      if (!res.ok || (json && json.code !== 0)) {
        // 5xx 一律说「服务器开小差了」（接口自己的「服务器内部错误」对用户没用）；
        // 4xx 用接口的说明；没有 code 的 4xx 不是接口服务回的（如网关 404）
        const msg = res.status >= 500 ? MSG.server : json?.message || `请求失败（HTTP ${res.status}）`
        throw new ApiError(msg, { status: res.status, code: json?.code ?? 'bad_response', field: json?.field })
      }
      return json ? json.data : null
    }
  } catch (e) {
    if (e instanceof ApiError) throw e
    // 外部取消（切页面、换筛选）一律抛 AbortError，调用方据此忽略（abort(原因) 传了别的原因也一样）
    if (signal?.aborted) throw e?.name === 'AbortError' ? e : new DOMException('已取消', 'AbortError')
    // 超时：fetch 以 abort 的原因（TimeoutError）reject；老浏览器不带原因时是没有外部取消的 AbortError
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || ctrl.signal.reason?.name === 'TimeoutError') {
      throw new ApiError(MSG.timeout, { code: 'timeout' })
    }
    throw new ApiError(MSG.network, { code: 'network' })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
    active--
    lastActivity = performance.now()
  }

  /* ---- 401：令牌失效 ---- */
  const unauthorized = new ApiError(token ? MSG.login : '请先登录', { status: 401, code: 'unauthorized' })
  const mode = options.unauthorized || (keepalive ? 'prompt' : 'relogin')
  // 没带令牌（本来就没登录）或调用方说不管：直接抛，由页面自己决定（一般先 requireLogin 再请求）
  if (!token || mode === 'ignore') throw unauthorized
  const wait = mode === 'relogin' && !options._retried
  const next = await waitOrAbort(Promise.resolve(onUnauthorized(token, { wait })), signal)
  if (!wait || !next || next === token) throw unauthorized
  // 重新登录了（或者别的标签页已经换了新令牌）：用新令牌再发一次，只重发这一次
  return request(path, { ...options, token: next, _retried: true })
}

/* 等重新登录的时候页面取消了这个请求（切走了）：不再等，按取消处理 */
function waitOrAbort(p, signal) {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('已取消', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export const get = (path, query, options) => request(path, { ...options, query })
export const post = (path, body, options) => request(path, { ...options, method: 'POST', body })
export const patch = (path, body, options) => request(path, { ...options, method: 'PATCH', body })
export const put = (path, body, options) => request(path, { ...options, method: 'PUT', body })
export const del = (path, options) => request(path, { ...options, method: 'DELETE' })
