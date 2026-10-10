/*
 * 管理后台路由表：/api/admin/*，格式与 server/index.mjs 的 routes 相同
 *   [方法, 正则, 处理函数 (m, query, body, ctx), 'admin']
 * 全部要求管理员登录（index.mjs 统一拦 401 / 403）。
 *
 * 各类数据（videos / posts / topics / creators / keywords）的接口形状一致：
 *   GET    /api/admin/:type             列表（?page&pageSize&sort&order + 各自的筛选）
 *   GET    /api/admin/:type/export      导出（同列表筛选）→ { fields, rows }
 *   GET    /api/admin/:type/:id         单条
 *   POST   /api/admin/:type             新建
 *   PATCH  /api/admin/:type/:id         修改（只改传了的字段）
 *   DELETE /api/admin/:type/:id         删除
 *   POST   /api/admin/:type/batch       批量操作 { ids, action, value? }
 *   POST   /api/admin/:type/import      批量导入 { rows, options, dryRun }（options.importId + chunk 可安全重发）
 */
import * as svc from './service.mjs'
import * as media from './media.mjs'

const ADMIN = 'admin'

function entityRoutes(type) {
  const base = `^\\/api\\/admin\\/${type}`
  const re = tail => new RegExp(base + tail + '$')
  return [
    ['GET', re(''), (m, q) => svc.list(type, q), ADMIN],
    ['GET', re('\\/export'), (m, q) => svc.exportRows(type, q), ADMIN],
    ['POST', re('\\/batch'), (m, q, body) => svc.batch(type, body), ADMIN],
    ['POST', re('\\/import'), (m, q, body, c) => svc.importRows(type, body, { userId: c.userId }), ADMIN],
    ['GET', re('\\/(\\d+)'), m => svc.getOne(type, +m[1]), ADMIN],
    ['POST', re(''), (m, q, body) => svc.create(type, body), ADMIN],
    ['PATCH', re('\\/(\\d+)'), (m, q, body) => svc.update(type, +m[1], body), ADMIN],
    ['DELETE', re('\\/(\\d+)'), m => svc.remove(type, +m[1]), ADMIN]
  ]
}

export const adminRoutes = [
  ['GET', /^\/api\/admin\/meta$/, () => svc.meta(), ADMIN],
  ['GET', /^\/api\/admin\/stats$/, () => svc.stats(), ADMIN],
  ['GET', /^\/api\/admin\/schema$/, () => svc.schema(), ADMIN],

  ...entityRoutes('videos'),
  ...entityRoutes('posts'),
  ...entityRoutes('topics'),
  ['PUT', /^\/api\/admin\/topics\/order$/, (m, q, body) => svc.reorderTopics(body), ADMIN],
  ...entityRoutes('creators'),
  ...entityRoutes('keywords'),

  /* 首页推荐分区 */
  ['GET', /^\/api\/admin\/sections$/, () => svc.listSections(), ADMIN],
  ['POST', /^\/api\/admin\/sections$/, (m, q, body) => svc.createSection(body), ADMIN],
  ['PUT', /^\/api\/admin\/sections\/order$/, (m, q, body) => svc.reorderSections(body), ADMIN],
  ['PATCH', /^\/api\/admin\/sections\/(\d+)$/, (m, q, body) => svc.updateSection(+m[1], body), ADMIN],
  ['DELETE', /^\/api\/admin\/sections\/(\d+)$/, m => svc.deleteSection(+m[1]), ADMIN],
  ['GET', /^\/api\/admin\/sections\/(\d+)\/items$/, m => svc.getSectionItems(+m[1]), ADMIN],
  ['PUT', /^\/api\/admin\/sections\/(\d+)\/items$/, (m, q, body) => svc.saveSectionItems(+m[1], body), ADMIN],
  ['POST', /^\/api\/admin\/sections\/(\d+)\/rebuild$/, (m, q, body) => svc.rebuildSection(+m[1], body), ADMIN],

  /* 素材文件 */
  ['GET', /^\/api\/admin\/media$/, (m, q) => media.listMedia(q), ADMIN],
  ['DELETE', /^\/api\/admin\/media$/, (m, q) => media.deleteMedia(q), ADMIN],
  ['PUT', /^\/api\/admin\/media\/upload$/, (m, q, b, c) => media.upload(c.req, q), ADMIN],
  ['POST', /^\/api\/admin\/media\/folder$/, (m, q, body) => media.createFolder(body), ADMIN],
  ['POST', /^\/api\/admin\/media\/scan$/, (m, q, body) => media.scanMedia(body), ADMIN]
]

/** 后台任何写操作（非 GET 的 /api/admin/*，含账号管理）之后由 index.mjs 调用：清掉概览统计的短缓存 */
export const afterAdminWrite = () => svc.invalidateStats()

/** 这个请求的请求体由处理函数自己按字节流读（上传），index.mjs 不要先把它读成 JSON */
export const isRawBodyRoute = (method, pathname) => method === 'PUT' && pathname === '/api/admin/media/upload'
