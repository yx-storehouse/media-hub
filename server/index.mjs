/*
 * 独立的 HTTP 接口服务（零依赖，只用 Node 内置模块）。
 *
 *   node server/index.mjs            # 默认 http://localhost:3000
 *   PORT=4000 node server/index.mjs  # 换端口
 *
 * 路由与前端 src/api/index.js 的函数一一对应：
 *   GET  /api/home/recommend            推荐分区
 *   GET  /api/home/section/:id/videos   分区视频（?batch=1 换一批）
 *   GET  /api/home/latest/filters       日期 + 地区
 *   GET  /api/home/latest/videos        最新视频（?date=0&region=0）
 *   GET  /api/category/:tab/filters     分类筛选项
 *   GET  /api/category/:tab/videos      分类视频（?filter=0）
 *   GET  /api/search/hot                热门搜索词（?page=0）
 *   GET  /api/search/creators           热门创作者
 *   GET  /api/search/recent             近期搜索
 *   GET  /api/search?q=关键词            搜索视频
 *   GET  /api/topic/:id                 专题详情
 *   GET  /api/topic/:id/videos          专题视频（?sort=0）
 *   GET  /api/library                   片库分类
 *   GET  /api/videos/:id                视频详情（播放页）
 *   GET  /api/videos/:id/related        相似推荐（?batch=0&limit=6，batch 递增 = 换一批）
 *   GET  /api/shorts                    短视频推荐流（?seed=&offset=&limit=&exclude=，翻不到底）
 *   GET  /api/community/tabs            社区 tab
 *   GET  /api/community/posts           社区帖子（?tab=0）
 *   GET  /api/community/posts/:id       帖子详情（标题、正文、图片、关联视频、下一篇；登录时带关注 / 收藏状态）
 *   POST /api/community/posts/:id/view  阅读数 +1（公开，无请求体）→ { read }
 *   POST /api/community/posts/:id/fav   收藏 / 取消收藏
 *   POST /api/creators/:id/follow       关注 / 取消关注创作者（body: { on }）→ { active, followers }
 *   GET  /api/creators/:id              创作者主页头部（登录时带 following）
 *   GET  /api/creators/:id/videos       创作者的视频（?sort=0 最新 | 1 最热&limit=&offset=）→ { total, list }
 *   GET  /api/creators/:id/posts        创作者的帖子（?limit=&offset=，结构同社区列表）→ { total, list }
 *   GET  /api/live/tabs                 直播 tab
 *   GET  /api/live                      直播列表（?tab=0）
 *   GET  /api/nearby/filters            同城筛选项
 *   GET  /api/nearby                    同城列表（?filter=0）
 *   GET  /api/me                        个人信息
 *   GET  /api/me/history                观看历史
 *   POST /api/me/history                记录观看（body: { videoId, progressSec }）
 *   GET  /api/health                    健康检查
 *
 * 鉴权与账号管理：
 *   POST /api/auth/login | logout       登录 / 退出
 *   GET  /api/auth/me                   当前用户
 *   *    /api/admin/users…              账号管理（管理员）
 *
 * 管理后台（管理员，路由表在 server/admin/routes.mjs）：
 *   GET  /api/admin/meta | stats | schema           下拉选项 / 概览统计 / 导入字段
 *   *    /api/admin/{videos|posts|topics|creators|keywords}[/:id|/batch|/import|/export]
 *   PUT  /api/admin/topics/order                    专题排序
 *   *    /api/admin/sections…                       首页推荐分区（含 items / rebuild / order）
 *   *    /api/admin/media…                          素材文件：列目录 / 上传（PUT 原始字节）/ 新建文件夹 / 删除 / 扫描
 *
 * 静态：
 *   GET  /media/<path>                  素材文件（公开，支持 Range），目录由 MEDIA_DIR 指定
 *   GET  /admin                         跳转到 /admin.html（管理后台入口）
 *   GET  其余路径                        dist/ 里打包好的前端
 *
 * 所有接口响应统一为 { code: 0, data } 或 { code: 1, message, field? }。
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, sep } from 'node:path'
import * as api from './api.mjs'
import { readToken, resolveSession, purgeExpiredSessions, loginLocked, noteFailedLogin, clearLoginAttempts } from './auth.mjs'
import { adminRoutes, isRawBodyRoute, afterAdminWrite } from './admin/routes.mjs'
import { MEDIA_DIR, ensureMediaDir, serveMedia } from './admin/media.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const PUBLIC_DIR = join(here, '..', 'dist')   // 顺便可以把打包好的前端一起托管
/* JSON 请求体上限：批量导入一次最多 2 万行，32 MB 足够；再大就是误传了文件 */
const MAX_JSON_BYTES = 32 * 1024 * 1024
const secEnv = (name, def) => Math.round((Number(process.env[name]) > 0 ? Number(process.env[name]) : def) * 1000)
/* JSON 请求体必须在这个时间内收完（32 MB 在内网绰绰有余），防止发一半就停的连接一直占着内存 */
const BODY_DEADLINE_MS = secEnv('BODY_TIMEOUT_SEC', 60)
/* 连接空闲（既没收到也没发出数据）这么久就断开：卡住的请求体、暂停不读的 /media 播放连接都会被回收 */
const IDLE_TIMEOUT_MS = secEnv('IDLE_TIMEOUT_SEC', 120)

const ok = data => ({ code: 0, data })
const fail = (message, field) => (field ? { code: 1, message, field } : { code: 1, message })

/**
 * 路由表：[方法, 正则, 处理函数, 是否需要登录]
 *
 * 处理函数拿到的是 (正则捕获组, query, body, ctx)，ctx = { userId, user, token }。
 * 需要登录的路由由这里统一拦：未登录返回 401，前端据此弹登录框。
 * 「需要登录」分两级：'user' = 任意登录用户，'admin' = 管理员。
 */
/** 请求体里的 on：只认 true / false，其余（含缺省）当作「切换」 */
const onFlag = body => (typeof body?.on === 'boolean' ? body.on : undefined)

const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, ts: Math.floor(Date.now() / 1000) })],
  ['GET', /^\/api\/home\/tabs$/, () => api.getHomeTabs()],
  ['GET', /^\/api\/main\/tabs$/, () => api.getMainTabs()],
  ['GET', /^\/api\/home\/recommend$/, () => api.getRecommendSections()],
  ['GET', /^\/api\/home\/section\/(\d+)\/videos$/, (m, q, b, c) => api.getVideos(+m[1], +(q.size || 4), +(q.batch || 0), c.userId)],
  ['GET', /^\/api\/home\/latest\/filters$/, () => api.getLatestFilters()],
  ['GET', /^\/api\/home\/latest\/videos$/, (m, q, b, c) => api.getLatestVideos({ date: +(q.date || 0), region: +(q.region || 0), limit: +(q.limit || 20), offset: +(q.offset || 0) }, c.userId)],
  ['GET', /^\/api\/category\/([\w-]+)\/filters$/, m => api.getCategoryFilters(m[1])],
  ['GET', /^\/api\/category\/([\w-]+)\/videos$/, (m, q, b, c) => api.getCategoryVideos(m[1], { filter: +(q.filter || 0), limit: +(q.limit || 20), offset: +(q.offset || 0) }, c.userId)],

  ['GET', /^\/api\/search\/hot$/, (m, q) => api.getHotWords(+(q.page || 0))],
  ['GET', /^\/api\/search\/creators$/, (m, q) => api.getCreators(+(q.limit || 5))],
  ['GET', /^\/api\/search\/recent$/, (m, q, b, c) => api.getRecentSearches(c.userId, { limit: +(q.limit || 5), offset: +(q.offset || 0) })],
  ['GET', /^\/api\/search$/, (m, q, b, c) => (q.q ? api.doSearch(String(q.q), { limit: +(q.limit || 20), offset: +(q.offset || 0) }, c.userId) : fail('缺少 q 参数'))],

  ['GET', /^\/api\/topic\/(\d+)$/, m => api.getTopic(+m[1])],
  ['GET', /^\/api\/topic\/(\d+)\/videos$/, (m, q, b, c) => api.getTopicVideos(+m[1], +(q.sort || 0), { limit: +(q.limit || 20), offset: +(q.offset || 0) }, c.userId)],
  ['GET', /^\/api\/library$/, () => api.getLibrary()],
  ['GET', /^\/api\/videos\/(\d+)$/, (m, q, b, c) => api.getVideo(+m[1], c.userId)],
  ['GET', /^\/api\/videos\/(\d+)\/related$/, (m, q, b, c) => api.getRelatedVideos(+m[1], { batch: Math.max(0, +(q.batch || 0)), limit: Math.min(Math.max(1, +(q.limit || 6)), 20) }, c.userId)],
  ['GET', /^\/api\/shorts$/, (m, q, b, c) => api.getShorts({ seed: q.seed, offset: q.offset, limit: q.limit, exclude: q.exclude }, c.userId)],

  ['GET', /^\/api\/community\/tabs$/, () => api.getCommunityTabs()],
  ['GET', /^\/api\/community\/posts$/, (m, q, b, c) => api.getPosts(+(q.tab || 0), { limit: +(q.limit || 20), offset: +(q.offset || 0) }, c.userId)],
  ['GET', /^\/api\/community\/posts\/(\d+)$/, (m, q, b, c) => api.getPost(+m[1], c.userId)],
  // 阅读数 +1：公开，不需要登录、不需要请求体（详情页每打开一次调一次）
  ['POST', /^\/api\/community\/posts\/(\d+)\/view$/, m => api.viewPost(+m[1])],

  // 创作者主页：公开；id 不是正整数也交给接口层，统一回 400「创作者不存在」
  ['GET', /^\/api\/creators\/([^/]+)$/, (m, q, b, c) => api.getCreator(m[1], c.userId)],
  ['GET', /^\/api\/creators\/([^/]+)\/videos$/, (m, q, b, c) => api.getCreatorVideos(m[1], q.sort, { limit: q.limit, offset: q.offset }, c.userId)],
  ['GET', /^\/api\/creators\/([^/]+)\/posts$/, (m, q, b, c) => api.getCreatorPosts(m[1], { limit: q.limit, offset: q.offset }, c.userId)],

  ['GET', /^\/api\/live\/tabs$/, () => api.getLiveTabs()],
  ['GET', /^\/api\/live$/, (m, q) => api.getLives({ tab: +(q.tab || 0), limit: +(q.limit || 20), offset: +(q.offset || 0) })],
  ['GET', /^\/api\/nearby\/filters$/, () => api.getNearbyFilters()],
  ['GET', /^\/api\/nearby$/, (m, q) => api.getNearby({ filter: +(q.filter || 0), city: q.city || null, limit: +(q.limit || 20), offset: +(q.offset || 0) })],

  /* ---- 鉴权（公开） ---- */
  ['POST', /^\/api\/auth\/login$/, (m, q, body, c) => {
    // 同一登录名连续失败会被临时锁定，防止内网里被暴力试密码
    const locked = loginLocked(String(body?.uid || ''))
    if (locked) return fail(`尝试次数过多，请 ${locked} 分钟后再试`)
    try {
      const result = api.login({ uid: body?.uid, password: body?.password, device: c.device })
      clearLoginAttempts(String(body?.uid || ''))
      return result
    } catch (e) {
      const mins = noteFailedLogin(String(body?.uid || ''))
      if (mins) throw new Error(`尝试次数过多，请 ${mins} 分钟后再试`)
      throw e
    }
  }],
  ['POST', /^\/api\/auth\/logout$/, (m, q, b, c) => api.logout(c.token)],
  ['GET', /^\/api\/auth\/me$/, (m, q, b, c) => api.me(c.userId)],

  /* ---- 需要登录 ---- */
  ['POST', /^\/api\/auth\/password$/, (m, q, body, c) => api.changePassword(c.userId, {
    oldPassword: body?.oldPassword, newPassword: body?.newPassword, keepToken: c.token
  }), 'user'],
  ['PATCH', /^\/api\/auth\/profile$/, (m, q, body, c) => api.updateProfile(c.userId, body || {}), 'user'],

  // body { on: true|false } 设为指定状态；不带 on 则切换
  ['POST', /^\/api\/community\/posts\/(\d+)\/fav$/, (m, q, b, c) => api.togglePostFav(+m[1], c.userId, onFlag(b)), 'user'],
  ['POST', /^\/api\/videos\/(\d+)\/fav$/, (m, q, b, c) => api.toggleVideoFav(+m[1], c.userId, onFlag(b)), 'user'],
  ['POST', /^\/api\/videos\/(\d+)\/like$/, (m, q, b, c) => api.toggleVideoLike(+m[1], c.userId, onFlag(b)), 'user'],
  ['POST', /^\/api\/videos\/(\d+)\/dislike$/, (m, q, b, c) => api.toggleVideoDislike(+m[1], c.userId, onFlag(b)), 'user'],
  ['POST', /^\/api\/topics\/(\d+)\/fav$/, (m, q, b, c) => api.toggleTopicFav(+m[1], c.userId, onFlag(b)), 'user'],
  ['POST', /^\/api\/creators\/(\d+)\/follow$/, (m, q, b, c) => api.toggleFollow(+m[1], c.userId, onFlag(b)), 'user'],

  ['GET', /^\/api\/me$/, (m, q, b, c) => api.getProfile(c.userId)],
  ['GET', /^\/api\/me\/history$/, (m, q, b, c) => api.getHistory({ limit: +(q.limit || 20), offset: +(q.offset || 0) }, c.userId)],
  ['POST', /^\/api\/me\/history$/, (m, q, body, c) => {
    const videoId = Number(body?.videoId)
    if (!Number.isInteger(videoId) || videoId <= 0) return fail('缺少或非法的 videoId')
    const progress = Number(body.progressSec || 0)
    // progressOnly：播放页离开时的进度上报，只记进度不计播放数
    return api.addHistory(videoId, Number.isFinite(progress) ? progress : 0, c.userId, { countPlay: body.progressOnly !== true })
  }],

  /* ---- 账号管理（管理员） ---- */
  ['GET', /^\/api\/admin\/users$/, (m, q, b, c) => api.listUsers(c.userId), 'admin'],
  ['POST', /^\/api\/admin\/users$/, (m, q, body, c) => api.createUser(c.userId, body || {}), 'admin'],
  ['POST', /^\/api\/admin\/users\/(\d+)\/password$/, (m, q, body, c) => api.resetPassword(c.userId, +m[1], body?.newPassword), 'admin'],
  ['POST', /^\/api\/admin\/users\/(\d+)\/status$/, (m, q, body, c) => api.setUserStatus(c.userId, +m[1], Number(body?.status) ? 1 : 0), 'admin'],
  ['POST', /^\/api\/admin\/users\/(\d+)\/role$/, (m, q, body, c) => api.setUserRole(c.userId, +m[1], body?.role), 'admin'],
  ['DELETE', /^\/api\/admin\/users\/(\d+)$/, (m, q, b, c) => api.deleteUser(c.userId, +m[1]), 'admin'],

  /* ---- 管理后台：内容管理 / 批量导入 / 素材文件（管理员） ---- */
  ...adminRoutes
]

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8'
}

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  // 只回一次：上传被中途取消等情况下，处理函数结束时响应可能已经发过 / 连接已断
  if (res.headersSent || res.writableEnded || res.destroyed) return
  const body = type.startsWith('application/json') ? JSON.stringify(payload) : payload
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'cache-control': 'no-store'
  })
  res.end(body)
}

/**
 * 读 JSON 请求体，边读边数字节：
 *   - 超过 limit → 'tooLarge'（调用方回 413）；剩下的数据照收照扔，不攒在内存里，这样 413 还能正常回给客户端
 *   - deadline 内没收完 → 'timeout'（调用方回 408 并断开）
 *   - 客户端中途断开（包括进来之前就已经断了）→ reject
 */
function readBody(req, limit, deadline) {
  return new Promise((resolve, reject) => {
    if (req.destroyed || req.readableAborted) return reject(new Error('aborted'))
    if (Number(req.headers['content-length']) > limit) {
      req.resume()
      return resolve('tooLarge')
    }
    let chunks = [], size = 0, settled = false
    const settle = (fn, v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chunks = null                // 结果已定：之后到的数据照收照扔
      fn(v)
    }
    const timer = setTimeout(() => settle(resolve, 'timeout'), deadline)
    req.on('data', c => {
      if (settled) return
      size += c.length
      if (size > limit) settle(resolve, 'tooLarge')
      else chunks.push(c)
    })
    req.on('end', () => { if (!settled) settle(resolve, Buffer.concat(chunks)) })
    req.on('error', e => settle(reject, e))
    req.on('close', () => { if (!req.complete) settle(reject, new Error('aborted')) })
  })
}

/** 静态托管 dist（打包后的前端），找不到就交给前端 hash 路由 */
function serveStatic(res, pathname) {
  const clean = pathname === '/' ? '/index.html' : pathname
  const file = join(PUBLIC_DIR, clean)
  // 带上分隔符比较，dist-xxx 这类同前缀的兄弟目录也挡住；已经回了 403 就算处理完
  if (!file.startsWith(PUBLIC_DIR + sep)) { send(res, 403, fail('forbidden')); return true }
  try {
    const buf = readFileSync(file)
    send(res, 200, buf, MIME[extname(file)] || 'application/octet-stream')
    return true
  } catch {
    return false
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  let pathname
  try { pathname = decodeURIComponent(url.pathname) } catch { return send(res, 400, fail('请求路径编码不正确')) }
  const query = Object.fromEntries(url.searchParams)

  if (req.method === 'OPTIONS') return send(res, 204, '')

  // 静态资源不需要会话和请求体：素材文件、管理后台入口、打包好的前端
  if (!pathname.startsWith('/api/')) {
    if (pathname === '/media' || pathname.startsWith('/media/')) return serveMedia(req, res, pathname)
    if (pathname === '/admin' || pathname === '/admin/') {
      res.writeHead(302, { location: '/admin.html', 'cache-control': 'no-store' })
      return res.end()
    }
    if (serveStatic(res, pathname)) return
    if (serveStatic(res, '/index.html')) return
    return send(res, 404, fail('not found: ' + pathname))
  }

  // 解析会话令牌：公开接口也解析，这样列表能带上「我点过赞没有」
  const token = readToken(req)
  const session = resolveSession(api.queries.db, token)
  const ctx = {
    token,
    userId: session?.user?.id ?? null,
    user: session?.user ?? null,
    device: (req.headers['user-agent'] || '').slice(0, 120),
    req     // 上传接口要自己按字节流读请求体
  }

  // 先定路由、先鉴权，再读请求体：没登录 / 没权限 / 路径不对的请求不会先被收进内存
  // （没读的请求体由 Node 在响应发完后自动丢弃）。同一路径可能注册了多个方法，扫完所有路由再判断 405。
  let route = null, m = null
  const allowed = new Set()
  for (const r of routes) {
    const hit = pathname.match(r[1])
    if (!hit) continue
    if (r[0] !== req.method) { allowed.add(r[0]); continue }
    route = r
    m = hit
    break
  }
  if (!route) {
    if (allowed.size) return send(res, 405, fail(`${pathname} 只支持 ${[...allowed].join(' / ')}`))
    return send(res, 404, fail('no route: ' + pathname))
  }
  const [, , handler, need] = route

  // 统一鉴权
  if (need && !ctx.userId) return send(res, 401, fail('请先登录'))
  if (need === 'admin' && ctx.user?.role !== 'admin') return send(res, 403, fail('需要管理员权限'))

  // 收集 JSON 请求体（POST / PATCH / PUT）；上传接口的原始字节流留给处理函数
  let body = {}
  if ((req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') && !isRawBodyRoute(req.method, pathname)) {
    let buf
    try { buf = await readBody(req, MAX_JSON_BYTES, BODY_DEADLINE_MS) } catch { return res.destroy() }   // 客户端中途断开
    if (buf === 'tooLarge') return send(res, 413, fail('请求体过大'))
    if (buf === 'timeout') {
      res.once('finish', () => req.destroy())    // 408 发出去之后断开：发得这么慢 / 卡住的连接不再复用
      return send(res, 408, fail('请求体接收超时'))
    }
    const raw = buf.toString('utf8')
    if (raw) { try { body = JSON.parse(raw) } catch { return send(res, 400, fail('请求体不是合法 JSON')) } }
  }

  // 后台写操作之后清掉概览统计的短缓存（成功失败都清：失败的请求也可能已经写了一部分，如上传）
  const adminWrite = req.method !== 'GET' && pathname.startsWith('/api/admin/')
  try {
    const data = await handler(m, query, body, ctx)
    if (data && data.code === 1) return send(res, 400, data)
    return send(res, 200, ok(data))
  } catch (e) {
    // 校验类错误（ID 不存在、口令不对、未登录…）返回 400（上传超限等带 status 的按 status），
    // 提示原样给前端，带 field 的同时告诉前端是哪个字段；
    // 其余的（SQL 出错、代码 bug）记日志并返回 500，不把内部细节漏出去。
    if (e instanceof api.InputError) return send(res, e.status || 400, fail(e.message, e.field))
    console.error(`[${req.method} ${pathname}]`, e)
    return send(res, 500, fail('服务器内部错误'))
  } finally {
    if (adminWrite) afterAdminWrite()
  }
}

const server = createServer((req, res) => {
  // 兜底：任何没接住的异常都只影响这一个请求，不让整个进程退出
  handle(req, res).catch(e => {
    console.error(`[${req.method} ${req.url}]`, e)
    send(res, 500, fail('服务器内部错误'))
  })
})
/*
 * 超时：大文件上传可能远超 Node 默认的 5 分钟「整个请求」超时，所以 requestTimeout 关掉，
 * 改用「连接空闲」超时兜底 —— 只要还在收发数据就不断，停住不动 2 分钟就断开。
 * 另外 JSON 请求体有 60 秒的收完期限（readBody），上传 60 秒收不到数据会中止并删掉临时文件（media.mjs）。
 * 请求头仍受 Node 默认的 headersTimeout（60 秒）限制。
 */
server.requestTimeout = 0
server.timeout = IDLE_TIMEOUT_MS

/* 每小时清理一次过期会话 */
setInterval(() => {
  const n = purgeExpiredSessions(api.queries.db)
  if (n) console.log(`清理过期会话 ${n} 条`)
}, 3600_000).unref()

ensureMediaDir()

server.listen(PORT, () => {
  console.log(`接口服务已启动  http://localhost:${PORT}/api/health`)
  console.log(`静态目录（可选）  ${PUBLIC_DIR}`)
  console.log(`素材目录          ${MEDIA_DIR}（/media/*，管理后台 http://localhost:${PORT}/admin）`)
})
