/*
 * HTTP 客户端。
 *
 * 统一处理：基础地址、JSON 解析、code!=0 报错、超时、请求取消。
 * 页面里不要直接用这个文件，用 src/api/index.js（那里定义了每个接口）。
 */

/**
 * 接口地址，按优先级取值：
 *   1. .env 里的 VITE_API_BASE（生产环境指向真实域名）
 *   2. 开发环境走 Vite 代理的 /api（见 vite.config.js）
 */
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

/**
 * 令牌：由 auth store 注入，避免 http 层直接依赖 store（会形成循环引用）。
 * 401 时回调 auth store 清理登录态并弹出登录页。
 */
let tokenProvider = () => ''
let onUnauthorized = () => {}
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

/**
 * @param {string} path   以 / 开头的接口路径，如 /api/home/recommend
 * @param {object} [options]
 * @param {object} [options.query]  查询参数，值为 undefined / null 的会被丢掉
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} [options.method]
 * @param {object} [options.body]   POST / PATCH / PUT 的 JSON 请求体
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeout] 毫秒，默认 12 秒
 * @param {boolean} [options.keepalive] 页面卸载后也把请求发完（请求体要小于 64 KB）
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
  try {
    const res = await fetch(url, {
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

    // 令牌失效：交给 auth store 处理（清登录态 + 弹登录框）
    if (res.status === 401) {
      onUnauthorized()
      throw new ApiError('请先登录', { status: 401, code: 'unauthorized' })
    }

    let json = null
    const text = await res.text()
    if (text) {
      try { json = JSON.parse(text) } catch {
        // 不是 JSON：多半是静态服务器 / 网关的页面，说明没打到接口服务
        throw new ApiError('接口返回的不是合法 JSON', { status: res.status, code: 'bad_response' })
      }
    }

    if (!res.ok || (json && json.code !== 0)) {
      // 接口服务的错误一定带 code；没有 code 的 4xx 不是它回的（如网关 404）
      throw new ApiError(json?.message || `请求失败（HTTP ${res.status}）`, { status: res.status, code: json?.code ?? 'bad_response', field: json?.field })
    }
    return json ? json.data : null
  } catch (e) {
    if (e instanceof ApiError) throw e
    // 外部取消（切页面、换筛选）一律抛 AbortError，调用方据此忽略（abort(原因) 传了别的原因也一样）
    if (signal?.aborted) throw e?.name === 'AbortError' ? e : new DOMException('已取消', 'AbortError')
    // 超时：fetch 以 abort 的原因（TimeoutError）reject；老浏览器不带原因时是没有外部取消的 AbortError
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || ctrl.signal.reason?.name === 'TimeoutError') {
      throw new ApiError('请求超时，请检查网络', { code: 'timeout' })
    }
    throw new ApiError('网络连接失败，请检查网络', { code: 'network' })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

export const get = (path, query, options) => request(path, { ...options, query })
export const post = (path, body, options) => request(path, { ...options, method: 'POST', body })
export const patch = (path, body, options) => request(path, { ...options, method: 'PATCH', body })
export const put = (path, body, options) => request(path, { ...options, method: 'PUT', body })
export const del = (path, options) => request(path, { ...options, method: 'DELETE' })
