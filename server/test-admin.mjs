/*
 * 管理后台接口测试：/api/admin/* 每个接口 + 素材文件 + 批量导入的各种边界情况，逐条报 PASS / FAIL。
 *
 *   node server/test-admin.mjs
 *
 * 自己起服务、自己建库（server/db/admin-test.db）、素材目录用系统临时目录下的新文件夹，
 * 跑完自动关服务、删临时素材目录，不会动到 reel.db 和项目里的 media/。
 * 为了安全不支持 --base：这套测试会大量写库，不应该对着正在用的服务跑。
 *
 * 退出码 0 表示全部通过。
 */
import { spawn } from 'node:child_process'
import { rmSync, existsSync, mkdtempSync, readdirSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
/* test-auth.mjs 已占用 3179，这里用 3180，两套测试可以同时跑 */
const PORT = 3180
const base = `http://127.0.0.1:${PORT}`
const TEST_DB = join(here, 'db', 'admin-test.db')
const MEDIA_DIR = mkdtempSync(join(tmpdir(), 'reel-admin-media-'))
const MAX_UPLOAD_MB = 1

/* ---------------- 起服务 ---------------- */

const portBusy = await fetch(base + '/api/health', { signal: AbortSignal.timeout(800) }).then(() => true, () => false)
if (portBusy) {
  console.error(`端口 ${PORT} 已被占用，请先关掉占用它的进程再跑测试`)
  process.exit(1)
}

const runNode = (args, env) => new Promise(r => {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: 'ignore' })
  p.on('exit', r)
})
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if (existsSync(f)) rmSync(f)
await runNode([join(here, 'db', 'seed.mjs'), '--reset'], { DB_PATH: TEST_DB })
await runNode([join(here, 'create-admin.mjs'), 'admin', 'admin12345'], { DB_PATH: TEST_DB })
/* 回归 R1-01：老版本导入可能写进读不出来的时长（超过 2^53 的整数、超过 int64 存成的小数），服务启动时应自动清零 */
{
  const w = new DatabaseSync(TEST_DB)
  w.exec('UPDATE videos SET duration_sec = 12345678901234567 WHERE id = 449')
  w.exec('UPDATE videos SET duration_sec = 1e300 WHERE id = 450')
  w.close()
}

let serverLog = ''
const child = spawn(process.execPath, [join(here, 'index.mjs')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB, MEDIA_DIR, MAX_UPLOAD_MB: String(MAX_UPLOAD_MB) },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', d => { serverLog += d })
child.stderr.on('data', d => { serverLog += d })
let up = false
for (let i = 0; i < 150 && child.exitCode === null; i++) {
  if (await fetch(base + '/api/health').then(r => r.ok, () => false)) { up = true; break }
  await new Promise(r => setTimeout(r, 100))
}
/** 关服务并删临时素材目录（等进程真正退出，Windows 上句柄才会释放） */
async function shutdown() {
  if (child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r))
    child.kill()
    await Promise.race([exited, new Promise(r => setTimeout(r, 3000))])
  }
  try { rmSync(MEDIA_DIR, { recursive: true, force: true }) } catch { /* 删不掉就留在系统临时目录 */ }
}
if (!up) {
  console.error('测试服务没有启动起来：\n' + serverLog)
  await shutdown()
  process.exit(1)
}

/* ---------------- 工具 ---------------- */

let adminToken = null
const results = []

async function req(method, path, { body, token = adminToken, raw, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  })
  const buf = Buffer.from(await res.arrayBuffer())
  let json = null
  try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null } catch { /* 非 JSON（静态文件） */ }
  return { status: res.status, json, data: json?.data, headers: res.headers, buf }
}

const t = async (name, fn) => {
  try {
    const note = await fn()
    results.push({ name, ok: true, note: typeof note === 'string' ? note : '' })
  } catch (e) {
    results.push({ name, ok: false, note: e.message })
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg) }
const okData = r => {
  must(r.status === 200 && r.json?.code === 0, `HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`)
  return r.data
}
/** 期望 400（或指定状态）并带上指定 field */
const mustFail = (r, field, status = 400, msgRe) => {
  must(r.status === status, `期望 HTTP ${status}，实际 ${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`)
  must(r.json?.code === 1, '响应不是错误格式')
  if (field !== undefined) must(r.json.field === field, `期望 field=${field}，实际 ${r.json.field}（${r.json.message}）`)
  if (msgRe) must(msgRe.test(r.json.message), `提示不符：${r.json.message}`)
  return r.json.message
}
const get = path => req('GET', path).then(okData)
const post = (path, body) => req('POST', path, { body }).then(okData)
const patch = (path, body) => req('PATCH', path, { body }).then(okData)
const put = (path, body) => req('PUT', path, { body }).then(okData)
const del = path => req('DELETE', path).then(okData)
const importRows = (type, rows, options = {}, dryRun = false) => post(`/api/admin/${type}/import`, { rows, options, dryRun })
const localTs = (...a) => Math.floor(new Date(...a).getTime() / 1000)
const urlOf = rel => '/media/' + rel.split('/').map(encodeURIComponent).join('/')

/* 读测试库（只读），用来核对接口看不到的列：占位图、全文索引、媒体行 */
let roDb = null
const dbq = (sql, ...args) => {
  roDb ??= new DatabaseSync(TEST_DB, { readOnly: true })
  return roDb.prepare(sql).all(...args)
}

/* 上传：PUT 原始字节 */
const upload = (path, bytes, { overwrite, token = adminToken } = {}) =>
  req('PUT', `/api/admin/media/upload?path=${encodeURIComponent(path)}${overwrite ? '&overwrite=1' : ''}`, {
    raw: bytes, token, headers: { 'content-type': 'application/octet-stream' }
  })

/** 不带 content-length 的分块请求（测「边读边计数」那条路径） */
function chunkedRequest(method, path, totalBytes, { token = adminToken, abortAfter } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest(base + path, {
      method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' }
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* ignore */ }
        resolve({ status: res.statusCode, json })
      })
    })
    r.on('error', e => (abortAfter ? resolve({ aborted: true }) : reject(e)))
    const chunk = Buffer.alloc(64 * 1024, 120)
    let sent = 0
    const pump = () => {
      while (sent < totalBytes) {
        if (abortAfter && sent >= abortAfter) {
          r.destroy()
          return setTimeout(() => resolve({ aborted: true }), 50)
        }
        sent += chunk.length
        if (!r.write(chunk)) return r.once('drain', pump)
      }
      r.end()
    }
    pump()
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 原始 TCP 请求：发请求头（行数组）和一段请求体，然后停住（不发完）。
 * 返回 { socket, closed }；closed 在连接关闭时给出 { status, text, firstAt, ms }（firstAt = 收到第一个字节的毫秒数）。
 */
function rawHttp(port, lines, body = '') {
  const socket = connect(port, '127.0.0.1')
  const t0 = Date.now()
  let text = '', firstAt = 0
  const closed = new Promise(resolve => {
    socket.on('data', d => { if (!firstAt) firstAt = Date.now() - t0; text += d })
    socket.on('close', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]) || 0, text, firstAt, ms: Date.now() - t0 }))
    socket.on('error', () => {})
  })
  socket.write(lines.join('\r\n') + '\r\n\r\n')
  if (body) socket.write(body)
  return { socket, closed }
}

/** 第二个服务实例：同一个库、同一个素材目录，但几个超时调得很短，用来测「卡住的连接会被断开」 */
async function withShortTimeouts(fn) {
  const port = PORT + 1
  if (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) }).then(() => true, () => false)) {
    throw new Error(`端口 ${port} 已被占用`)
  }
  const p = spawn(process.execPath, [join(here, 'index.mjs')], {
    env: { ...process.env, PORT: String(port), DB_PATH: TEST_DB, MEDIA_DIR, MAX_UPLOAD_MB: String(MAX_UPLOAD_MB), BODY_TIMEOUT_SEC: '1.5', IDLE_TIMEOUT_SEC: '3', UPLOAD_IDLE_SEC: '1.5' },
    stdio: 'ignore'
  })
  try {
    let ok = false
    for (let i = 0; i < 150 && p.exitCode === null; i++) {
      if (await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.ok, () => false)) { ok = true; break }
      await sleep(100)
    }
    must(ok, '短超时服务没有启动起来')
    return await fn(port)
  } finally {
    if (p.exitCode === null) {
      const exited = new Promise(r => p.once('exit', r))
      p.kill()
      await Promise.race([exited, sleep(3000)])
    }
  }
}

const partFiles = () => {
  const out = []
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name.endsWith('.part')) out.push(e.name)
    }
  }
  walk(MEDIA_DIR)
  return out
}

/* ================================================================ */
/*  鉴权                                                             */
/* ================================================================ */

await t('鉴权：未登录访问后台 401', async () => {
  const r = await req('GET', '/api/admin/meta', { token: null })
  must(r.status === 401, `期望 401，实际 ${r.status}`)
  return r.json.message
})

await t('鉴权：管理员登录', async () => {
  const r = await req('POST', '/api/auth/login', { body: { uid: 'admin', password: 'admin12345' }, token: null })
  adminToken = okData(r).token
  must(adminToken, '没拿到令牌')
  return 'ok'
})

let userToken = null
await t('鉴权：普通用户访问后台 403', async () => {
  await post('/api/admin/users', { uid: 'editor1', nickname: '编辑', password: 'editor12345', role: 'user' })
  userToken = okData(await req('POST', '/api/auth/login', { body: { uid: 'editor1', password: 'editor12345' }, token: null })).token
  const r = await req('GET', '/api/admin/videos', { token: userToken })
  must(r.status === 403, `期望 403，实际 ${r.status}`)
  const r2 = await req('POST', '/api/admin/videos/import', { token: userToken, body: { rows: [] } })
  must(r2.status === 403, `导入期望 403，实际 ${r2.status}`)
  return r.json.message
})

await t('鉴权：未登录上传 401、普通用户上传 403', async () => {
  const r = await upload('videos/x.mp4', Buffer.from('abc'), { token: null })
  must(r.status === 401, `未登录期望 401，实际 ${r.status}`)
  const r2 = await upload('videos/x.mp4', Buffer.from('abc'), { token: userToken })
  must(r2.status === 403, `普通用户期望 403，实际 ${r2.status}`)
  must(!existsSync(join(MEDIA_DIR, 'videos', 'x.mp4')), '被拒绝的上传不应写出文件')
  return '没有写文件'
})

await t('账号接口仍是原来的形状（纯数组 + snake_case）', async () => {
  const d = await get('/api/admin/users')
  must(Array.isArray(d) && d.length === 3 && 'last_login_at' in d[0] && 'created_at' in d[0], JSON.stringify(d).slice(0, 120))
  return `${d.length} 个账号`
})

/* ================================================================ */
/*  meta / stats / schema                                           */
/* ================================================================ */

let META = null
await t('meta：下拉选项', async () => {
  const d = META = await get('/api/admin/meta')
  must(d.topics.length === 11 && d.creators.length === 12, `专题 ${d.topics.length} / 创作者 ${d.creators.length}`)
  must(d.categories.map(c => c.key).join(',') === 'ai,cn,jk,anime,show,doc', '分类：' + d.categories.map(c => c.key))
  must(d.regions.length === 3 && d.qualities.length === 3 && d.statuses.length === 3 && d.postKinds.length === 3 && d.topicKinds.length === 3, '枚举数量不对')
  must(d.mediaBase === '/media/', 'mediaBase')
  must(d.topics[0].name === '热门推荐' && 'slug' in d.topics[0] && 'kind' in d.topics[0] && 'status' in d.topics[0], '专题字段')
  return `${d.categories.length} 个分类，${d.regions.length} 个地区`
})

await t('stats：概览统计', async () => {
  const d = await get('/api/admin/stats')
  must(d.videos.total === 458 && d.videos.published === 458 && d.videos.missingPlayback === 458 && d.videos.short === 5, JSON.stringify(d.videos))
  must(d.posts.total === 4 && d.posts.hot === 1, JSON.stringify(d.posts))
  must(d.topics.total === 11 && d.creators.total === 12 && d.sections.total === 6 && d.keywords.total === 16, '计数不对')
  must(d.users.total === 3 && d.users.admins === 1, JSON.stringify(d.users))
  must(d.media.dirExists === true && d.media.files === 0, JSON.stringify(d.media))
  must(d.recentVideos.length === 8 && d.recentPosts.length === 4, '最近列表')
  must(!('coverFallback' in d.recentVideos[0]) && !JSON.stringify(d).includes('data:image/svg'), '不应返回占位图')
  return `视频 ${d.videos.total}，素材目录存在`
})

/** 和前端一致的列名规范化：小写、去空格 _ - 和括号（连同括号里的内容）、去 * */
const normHeader = s => String(s).toLowerCase().replace(/[（(【[][^）)】\]]*[）)】\]]/g, '').replace(/[\s_\-*]/g, '')
let SCHEMA = null
await t('schema：字段定义完整、别名不冲突', async () => {
  const d = SCHEMA = await get('/api/admin/schema')
  must(Object.keys(d).join(',') === 'videos,posts,topics,creators,keywords', Object.keys(d).join(','))
  for (const [type, s] of Object.entries(d)) {
    const seen = new Map()
    for (const f of s.fields) {
      must(f.key && f.label && Array.isArray(f.aliases) && f.type && typeof f.required === 'boolean' && 'example' in f && 'help' in f, `${type}.${f.key} 缺字段`)
      for (const name of new Set([f.key, f.label, ...f.aliases].map(normHeader))) {
        must(!seen.has(name) || seen.get(name) === f.key, `${type}：「${name}」同时指向 ${seen.get(name)} 和 ${f.key}`)
        seen.set(name, f.key)
      }
    }
  }
  const cat = d.videos.fields.find(f => f.key === 'category')
  must(cat.options.length === 6 && cat.options[1].value === 'cn', '分类选项没填上')
  must(d.videos.fields.find(f => f.key === 'title').required && d.posts.fields.filter(f => f.required).map(f => f.key).join() === 'creator,text', '必填字段')
  return Object.values(d).map(s => `${s.label}${s.fields.length}`).join(' ')
})

await t('schema：帖子「标题」「正文」两列，常见写法各归各的', async () => {
  must(SCHEMA, 'schema 没取到')
  const fs = SCHEMA.posts.fields
  const keys = fs.map(f => f.key)
  const text = fs.find(f => f.key === 'text'), content = fs.find(f => f.key === 'content')
  must(text?.label === '标题' && content?.label === '正文', `表头 ${text?.label} / ${content?.label}`)
  must(keys.indexOf('content') === keys.indexOf('text') + 1, '正文应紧跟在标题后面：' + keys.join())
  must(text.required && !content.required && content.type === 'longtext' && /20000/.test(content.help), '必填 / 类型 / 说明')
  const owner = name => fs.find(f => [f.key, f.label, ...f.aliases].map(normHeader).includes(normHeader(name)))?.key
  for (const n of ['标题', 'title', 'text', '帖子标题', '文案', 'Title']) must(owner(n) === 'text', `「${n}」应对应标题，实际 ${owner(n)}`)
  for (const n of ['正文', 'content', 'body', '内容', '正文内容', '详情', '详情正文', '帖子正文', '帖子内容', '正文（选填）']) {
    must(owner(n) === 'content', `「${n}」应对应正文，实际 ${owner(n)}`)
  }
  return '标题：' + text.aliases.join('/') + '；正文：' + content.aliases.join('/')
})

/* ================================================================ */
/*  视频                                                             */
/* ================================================================ */

await t('视频列表：默认分页 + 按发布时间倒序', async () => {
  const d = await get('/api/admin/videos')
  must(d.total === 458 && d.page === 1 && d.pageSize === 20 && d.list.length === 20, `${d.total}/${d.pageSize}/${d.list.length}`)
  must(d.list.every((v, i) => i === 0 || d.list[i - 1].publishedAt >= v.publishedAt), '没有按发布时间倒序')
  const v = d.list[0]
  for (const k of ['id', 'publicId', 'title', 'description', 'topicId', 'topicName', 'creatorId', 'creatorName', 'creatorHandle', 'categoryKey', 'region', 'quality', 'tags', 'durationSec', 'coverUrl', 'playbackUrl', 'isShort', 'playCount', 'likeCount', 'favCount', 'status', 'publishedAt', 'createdAt']) {
    must(k in v, '缺少字段 ' + k)
  }
  must(!('coverFallback' in v) && !('cover_fallback' in v), '不应返回 cover_fallback')
  return `${d.total} 条`
})

await t('视频列表：筛选 / 排序 / 分页上限', async () => {
  const byTopic = await get('/api/admin/videos?topicId=2&pageSize=200')
  must(byTopic.total === 40 && byTopic.list.every(v => v.topicId === 2), `专题筛选 ${byTopic.total}`)
  const none = await get('/api/admin/videos?topicId=none')
  must(none.total === 0, '无专题应为 0')
  const q = await get('/api/admin/videos?q=VID-1001')
  must(q.list.some(v => v.publicId === 'VID-1001'), '编号搜索')
  const qid = await get('/api/admin/videos?q=7')
  must(qid.list.some(v => v.id === 7), '数字搜索应匹配 id')
  const tag = await get('/api/admin/videos?q=' + encodeURIComponent('治愈日常'))
  must(tag.total >= 40, '标签搜索 ' + tag.total)
  const missing = await get('/api/admin/videos?missing=playback&pageSize=1')
  must(missing.total === 458, '缺播放地址 ' + missing.total)
  const short = await get('/api/admin/videos?short=1')
  must(short.total === 5 && short.list.every(v => v.isShort), '短视频筛选')
  const cat = await get('/api/admin/videos?category=ai&region=cn&pageSize=200')
  must(cat.list.every(v => v.categoryKey === 'ai' && v.region === 'cn'), '分类 + 地区')
  const asc = await get('/api/admin/videos?sort=durationSec&order=asc&pageSize=50')
  must(asc.list.every((v, i) => i === 0 || asc.list[i - 1].durationSec <= v.durationSec), '时长升序')
  const big = await get('/api/admin/videos?pageSize=500&page=2')
  must(big.pageSize === 200 && big.list.length === 200 && big.page === 2, 'pageSize 上限 200')
  const evil = await get('/api/admin/videos?sort=' + encodeURIComponent('id; DROP TABLE videos') + '&order=sideways&status=abc')
  must(evil.total === 458, '非法排序 / 筛选应回退默认')
  const byCreator = await get('/api/admin/videos?creatorId=1&status=1&pageSize=1')
  must(byCreator.total > 0, '创作者筛选')
  return '全部正确'
})

let V1 = null
await t('视频新建：最少字段 + 自动编号 + 占位图', async () => {
  V1 = await post('/api/admin/videos', { title: '最简视频' })
  must(V1.publicId === 'VID-1442', '自动编号应为 VID-1442，实际 ' + V1.publicId)
  must(V1.status === 1 && V1.quality === 'hd' && V1.durationSec === 0 && V1.tags.length === 0 && V1.isShort === false, JSON.stringify(V1))
  must(Math.abs(V1.publishedAt - Date.now() / 1000) < 60, '发布时间默认当前')
  const fb = dbq('SELECT cover_fallback FROM videos WHERE id = ?', V1.id)[0].cover_fallback
  must(typeof fb === 'string' && fb.startsWith("url('data:image/svg+xml"), '没有生成占位封面')
  must(fb.length <= 1500, `后台新建的占位封面应 ≤ 1.5 KB，实际 ${fb.length}`)
  return `#${V1.id} ${V1.publicId}，占位图 ${fb.length} 字节`
})

let V2 = null
await t('视频新建：中文标签值都能认', async () => {
  V2 = await post('/api/admin/videos', {
    title: '全字段视频', description: '简介', topicId: 3, creatorId: 2, categoryKey: '国产', region: '日韩', quality: '1080p',
    tags: '日落 旅拍,#海边', durationSec: '1:02:03', coverUrl: 'https://example.com/c.jpg', playbackUrl: '/media/videos/a.mp4',
    status: '草稿', publishedAt: '2026-10-01 08:00', isShort: true
  })
  must(V2.categoryKey === 'cn' && V2.region === 'jk' && V2.quality === 'fhd', '枚举')
  must(JSON.stringify(V2.tags) === JSON.stringify(['#日落', '#旅拍', '#海边']), '标签 ' + JSON.stringify(V2.tags))
  must(V2.durationSec === 3723 && V2.status === 0 && V2.isShort === true, '时长 / 状态 / 短视频')
  must(V2.publishedAt === localTs(2026, 9, 1, 8, 0), '发布时间应按本地时区解析')
  must(V2.topicName === '悬疑短剧' && V2.creatorHandle === 'mrds', '关联名称')
  return `#${V2.id}`
})

await t('视频校验：错误带 field', async () => {
  const cases = [
    [{ title: '' }, 'title'],
    [{ title: 'x'.repeat(201) }, 'title'],
    [{ title: 'a', coverUrl: 'javascript:alert(1)' }, 'coverUrl'],
    [{ title: 'a', playbackUrl: 'data:video/mp4;base64,AAAA' }, 'playbackUrl'],
    [{ title: 'a', playbackUrl: 'videos/a.mp4' }, 'playbackUrl'],
    [{ title: 'a', publicId: 'VID-1001' }, 'publicId'],
    [{ title: 'a', publicId: 'has space' }, 'publicId'],
    [{ title: 'a', topicId: 999999 }, 'topicId'],
    [{ title: 'a', creatorId: 999999 }, 'creatorId'],
    [{ title: 'a', categoryKey: 'nope' }, 'categoryKey'],
    [{ title: 'a', region: 'mars' }, 'region'],
    [{ title: 'a', quality: '8k超清' }, 'quality'],
    [{ title: 'a', durationSec: 'abc' }, 'durationSec'],
    [{ title: 'a', durationSec: '1:75' }, 'durationSec'],
    [{ title: 'a', status: 9 }, 'status'],
    [{ title: 'a', publishedAt: '2026-02-30' }, 'publishedAt'],
    [{ title: 'a', tags: Array.from({ length: 21 }, (_, i) => 't' + i) }, 'tags'],
    [{ title: 'a', tags: ['x'.repeat(21)] }, 'tags'],
    [{ title: 'a', isShort: 'maybe' }, 'isShort']
  ]
  for (const [body, field] of cases) mustFail(await req('POST', '/api/admin/videos', { body }), field)
  mustFail(await req('POST', '/api/admin/videos', { body: [1, 2] }), undefined)
  return `${cases.length} 种错误都带了正确的 field`
})

await t('视频详情 / 不存在 400', async () => {
  const d = await get(`/api/admin/videos/${V2.id}`)
  must(d.id === V2.id && d.title === '全字段视频', '详情')
  return mustFail(await req('GET', '/api/admin/videos/999999'), undefined, 400, /视频不存在/)
})

await t('视频修改：部分字段、null 清空、短视频开关', async () => {
  const d = await patch(`/api/admin/videos/${V2.id}`, { title: '改过的标题', coverUrl: null, topicId: null, isShort: false, status: 1 })
  must(d.title === '改过的标题' && d.coverUrl === null && d.topicId === null && d.isShort === false && d.status === 1, JSON.stringify(d))
  must(d.description === '简介' && d.durationSec === 3723 && d.categoryKey === 'cn', '没传的字段不应变')
  mustFail(await req('PATCH', `/api/admin/videos/${V2.id}`, { body: { title: '' } }), 'title')
  mustFail(await req('PATCH', `/api/admin/videos/${V2.id}`, { body: { publicId: V1.publicId } }), 'publicId', 400, /编号已存在/)
  mustFail(await req('PATCH', '/api/admin/videos/999999', { body: { title: 'x' } }), undefined, 400, /视频不存在/)
  const fts = dbq(`SELECT rowid FROM videos_fts WHERE videos_fts MATCH ?`, '"改过的标题"')
  must(fts.some(r => r.rowid === V2.id), '视频全文索引没更新')
  return 'ok'
})

await t('视频删除', async () => {
  const d = await del(`/api/admin/videos/${V1.id}`)
  must(d.ok === true, '删除返回')
  mustFail(await req('GET', `/api/admin/videos/${V1.id}`), undefined, 400, /视频不存在/)
  mustFail(await req('DELETE', `/api/admin/videos/${V1.id}`), undefined, 400)
  return 'ok'
})

/* ---------------- 视频批量 + 专题视频数 ---------------- */

let TB = null
const batchIds = []
await t('专题视频数：发布 / 下架后重算', async () => {
  TB = await post('/api/admin/topics', { name: '批量测试专题' })
  for (let i = 0; i < 3; i++) batchIds.push((await post('/api/admin/videos', { title: '批量' + i, topicId: TB.id, durationSec: 60 + i })).id)
  let topic = await get(`/api/admin/topics/${TB.id}`)
  must(topic.videoCount === 3 && topic.totalVideos === 3, `新建后 ${topic.videoCount}/${topic.totalVideos}`)
  await post('/api/admin/videos/batch', { ids: [batchIds[0]], action: 'unpublish' })
  topic = await get(`/api/admin/topics/${TB.id}`)
  must(topic.videoCount === 2 && topic.totalVideos === 3, `下架后 ${topic.videoCount}/${topic.totalVideos}`)
  const app = await get(`/api/topic/${TB.id}`)
  must(app.total === 2, 'App 专题页总数 ' + app.total)
  // 新建草稿也不应计入
  const draft = await post('/api/admin/videos', { title: '草稿', topicId: TB.id, status: 0 })
  topic = await get(`/api/admin/topics/${TB.id}`)
  must(topic.videoCount === 2, '草稿不应计入 ' + topic.videoCount)
  await del(`/api/admin/videos/${draft.id}`)
  return `已发布 ${topic.videoCount} / 全部 ${topic.totalVideos}`
})

await t('视频批量：上架 / 下架 / 草稿', async () => {
  for (const [action, status] of [['publish', 1], ['unpublish', 2], ['draft', 0], ['publish', 1]]) {
    const d = await post('/api/admin/videos/batch', { ids: batchIds, action })
    must(d.affected === 3, `${action} affected=${d.affected}`)
    const list = await get(`/api/admin/videos?topicId=${TB.id}&pageSize=10`)
    must(list.list.every(v => v.status === status), `${action} 后状态不对`)
  }
  must((await get(`/api/admin/topics/${TB.id}`)).videoCount === 3, '重新上架后应为 3')
  return 'ok'
})

await t('视频批量：改专题 / 创作者 / 分类 / 地区 / 清晰度', async () => {
  const ids = batchIds
  await post('/api/admin/videos/batch', { ids, action: 'setCreator', value: 3 })
  await post('/api/admin/videos/batch', { ids, action: 'setCategory', value: 'doc' })
  await post('/api/admin/videos/batch', { ids, action: 'setRegion', value: '其他' })
  await post('/api/admin/videos/batch', { ids, action: 'setQuality', value: 'sd' })
  let v = await get(`/api/admin/videos/${ids[0]}`)
  must(v.creatorId === 3 && v.categoryKey === 'doc' && v.region === 'other' && v.quality === 'sd', JSON.stringify(v))
  await post('/api/admin/videos/batch', { ids, action: 'setTopic', value: null })
  v = await get(`/api/admin/videos/${ids[0]}`)
  must(v.topicId === null && (await get(`/api/admin/topics/${TB.id}`)).videoCount === 0, '移出专题后计数应为 0')
  await post('/api/admin/videos/batch', { ids, action: 'setTopic', value: TB.id })
  must((await get(`/api/admin/topics/${TB.id}`)).videoCount === 3, '改回专题后应为 3')
  await post('/api/admin/videos/batch', { ids, action: 'setCreator', value: null })
  must((await get(`/api/admin/videos/${ids[1]}`)).creatorId === null, '清空创作者')
  mustFail(await req('POST', '/api/admin/videos/batch', { body: { ids, action: 'setTopic', value: 999999 } }), 'value')
  mustFail(await req('POST', '/api/admin/videos/batch', { body: { ids, action: 'setQuality', value: '' } }), 'value')
  return 'ok'
})

await t('视频批量：加 / 删标签', async () => {
  await post('/api/admin/videos/batch', { ids: batchIds, action: 'addTags', value: ['日落', '#旅拍'] })
  let v = await get(`/api/admin/videos/${batchIds[0]}`)
  must(JSON.stringify(v.tags) === '["#日落","#旅拍"]', JSON.stringify(v.tags))
  const again = await post('/api/admin/videos/batch', { ids: batchIds, action: 'addTags', value: '旅拍' })
  must(again.affected === 0, '重复添加不应算修改')
  await post('/api/admin/videos/batch', { ids: batchIds, action: 'removeTags', value: '#日落' })
  v = await get(`/api/admin/videos/${batchIds[2]}`)
  must(JSON.stringify(v.tags) === '["#旅拍"]', JSON.stringify(v.tags))
  mustFail(await req('POST', '/api/admin/videos/batch', { body: { ids: batchIds, action: 'addTags', value: [] } }), 'value')
  return 'ok'
})

await t('视频批量：加入 / 移出短视频', async () => {
  const add = await post('/api/admin/videos/batch', { ids: batchIds, action: 'addShort' })
  must(add.affected === 3, 'addShort ' + add.affected)
  // 短视频流从全部视频里推荐，加入短视频的优先：新加的 3 条（还没有播放数）也应在前 50 条里
  const shorts = (await get('/api/shorts?limit=50')).list
  must(batchIds.every(id => shorts.some(s => s.id === id)), 'App 短视频流前 50 条里没有')
  const rm = await post('/api/admin/videos/batch', { ids: batchIds, action: 'removeShort' })
  must(rm.affected === 3 && (await get('/api/admin/videos?short=1')).total === 5, 'removeShort')
  return 'ok'
})

await t('视频批量：参数错误 + 删除', async () => {
  mustFail(await req('POST', '/api/admin/videos/batch', { body: { ids: [], action: 'publish' } }), 'ids')
  mustFail(await req('POST', '/api/admin/videos/batch', { body: { ids: ['x'], action: 'publish' } }), 'ids')
  mustFail(await req('POST', '/api/admin/videos/batch', { body: { ids: Array.from({ length: 5001 }, (_, i) => i + 1), action: 'publish' } }), 'ids')
  mustFail(await req('POST', '/api/admin/videos/batch', { body: { ids: batchIds, action: 'explode' } }), 'action')
  const extra = await post('/api/admin/videos', { title: '待删', topicId: TB.id })
  const d = await post('/api/admin/videos/batch', { ids: [extra.id, 99999999], action: 'delete' })
  must(d.affected === 1, 'affected ' + d.affected)
  must((await get(`/api/admin/topics/${TB.id}`)).videoCount === 3, '删除后计数')
  return 'ok'
})

/* ================================================================ */
/*  帖子                                                             */
/* ================================================================ */

let P1 = null
await t('帖子新建：主图 + 配图 + 标签去 #', async () => {
  P1 = await post('/api/admin/posts', {
    creatorId: 1, text: '原始帖子正文内容', tags: '#AI #剧情,短剧', mediaKind: '视频', videoId: 1,
    mainImage: '/media/images/m.jpg', images: ['https://e.com/1.jpg', 'https://e.com/2.jpg', 'https://e.com/1.jpg'], readCount: '1.2w'
  })
  must(JSON.stringify(P1.tags) === '["AI","剧情","短剧"]', '标签 ' + JSON.stringify(P1.tags))
  must(P1.mainImage === '/media/images/m.jpg' && P1.images.length === 2, '媒体 ' + JSON.stringify([P1.mainImage, P1.images]))
  must(P1.readCount === 12000 && P1.mediaKind === 1 && P1.videoId === 1 && P1.videoPublicId === 'VID-1001', JSON.stringify(P1))
  const rows = dbq('SELECT role, media_type, duration_sec, fallback FROM post_media WHERE post_id = ? ORDER BY role, sort_order', P1.id)
  must(rows.length === 3 && rows[0].role === 0 && rows[0].media_type === 1 && rows[0].duration_sec > 0 && rows.every(r => r.fallback), '媒体行 ' + rows.length)
  must(rows.every(r => r.fallback.length <= 1500), '帖子占位图应 ≤ 1.5 KB：' + rows.map(r => r.fallback.length))
  must(dbq('SELECT thumb_count FROM posts WHERE id = ?', P1.id)[0].thumb_count === 2, 'thumb_count')
  return `#${P1.id}`
})

await t('帖子校验：错误带 field', async () => {
  const cases = [
    [{ text: 'x' }, 'creatorId'],
    [{ creatorId: 1, text: '' }, 'text'],
    [{ creatorId: 1, text: 'x'.repeat(5001) }, 'text'],
    [{ creatorId: 999999, text: 'x' }, 'creatorId'],
    [{ creatorId: 1, text: 'x', videoId: 999999 }, 'videoId'],
    [{ creatorId: 1, text: 'x', mainImage: 'data:image/png;base64,AA' }, 'mainImage'],
    [{ creatorId: 1, text: 'x', images: Array.from({ length: 10 }, (_, i) => `/i/${i}.jpg`) }, 'images'],
    [{ creatorId: 1, text: 'x', mediaKind: 7 }, 'mediaKind'],
    [{ creatorId: 1, text: 'x', readCount: -1 }, 'readCount']
  ]
  for (const [body, field] of cases) mustFail(await req('POST', '/api/admin/posts', { body }), field)
  return `${cases.length} 种`
})

await t('帖子修改：标题同步全文索引（posts_fts_update）', async () => {
  const d = await patch(`/api/admin/posts/${P1.id}`, { text: '全新的帖子正文测试', tags: ['新标签'] })
  must(d.text === '全新的帖子正文测试' && d.tags[0] === '新标签', '修改')
  must(d.mainImage === '/media/images/m.jpg' && d.images.length === 2, '没传媒体不应改')
  const hitNew = dbq('SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?', '"全新的帖子正文"')
  const hitOld = dbq('SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?', '"原始帖子正文"')
  must(hitNew.some(r => r.rowid === P1.id), '新标题搜不到')
  must(!hitOld.some(r => r.rowid === P1.id), '旧标题还能搜到')
  const trig = dbq("SELECT 1 x FROM sqlite_master WHERE type = 'trigger' AND name = 'posts_fts_update'")
  must(trig.length === 1, '触发器不存在')
  return '索引已更新'
})

await t('帖子修改：媒体替换 / 内容相同不重写', async () => {
  const before = dbq('SELECT id FROM post_media WHERE post_id = ? ORDER BY id', P1.id).map(r => r.id).join()
  await patch(`/api/admin/posts/${P1.id}`, { mainImage: '/media/images/m.jpg', images: ['https://e.com/1.jpg', 'https://e.com/2.jpg'] })
  must(dbq('SELECT id FROM post_media WHERE post_id = ? ORDER BY id', P1.id).map(r => r.id).join() === before, '相同内容不应重写媒体行')
  const d = await patch(`/api/admin/posts/${P1.id}`, { images: ['https://e.com/3.jpg'], mediaKind: 2 })
  must(d.images.length === 1 && d.images[0] === 'https://e.com/3.jpg' && d.mainImage === '/media/images/m.jpg', JSON.stringify(d.images))
  const rows = dbq('SELECT role, media_type FROM post_media WHERE post_id = ? ORDER BY role', P1.id)
  must(rows.length === 2 && rows[1].media_type === 2 && rows[0].media_type === 0, '文档帖媒体类型 ' + JSON.stringify(rows))
  const cleared = await patch(`/api/admin/posts/${P1.id}`, { mainImage: null, images: [] })
  must(cleared.mainImage === null && cleared.images.length === 0, '清空')
  must(dbq('SELECT thumb_count FROM posts WHERE id = ?', P1.id)[0].thumb_count === 0, 'thumb_count 应为 0')
  return 'ok'
})

await t('帖子列表：筛选 / 排序', async () => {
  const all = await get('/api/admin/posts')
  must(all.total === 5 && all.list[0].id === P1.id, `总数 ${all.total}`)
  must((await get('/api/admin/posts?creatorId=1')).list.every(p => p.creatorId === 1), '发布者筛选')
  must((await get('/api/admin/posts?isHot=1')).total === 1, '热门筛选')
  must((await get('/api/admin/posts?mediaKind=2')).list.every(p => p.mediaKind === 2), '类型筛选')
  must((await get('/api/admin/posts?q=' + encodeURIComponent('川西'))).total === 1, '标题搜索')
  must((await get('/api/admin/posts?q=' + encodeURIComponent('新标签'))).total === 1, '标签搜索')
  const byRead = await get('/api/admin/posts?sort=readCount&order=desc')
  must(byRead.list.every((p, i) => i === 0 || byRead.list[i - 1].readCount >= p.readCount), '阅读数排序')
  const seedPost = all.list.find(p => p.creatorHandle === 'trip')
  must(seedPost.mainImage && seedPost.images.length === 3, '种子帖子媒体 ' + JSON.stringify(seedPost.images))
  return `${all.total} 条`
})

await t('帖子批量：全部动作', async () => {
  const ids = [P1.id, 2]
  for (const [action, check] of [
    ['unpublish', p => p.status === 2], ['draft', p => p.status === 0], ['publish', p => p.status === 1],
    ['setHot', p => p.isHot], ['unsetHot', p => !p.isHot], ['addTags', p => p.tags.includes('批量')],
    ['removeTags', p => !p.tags.includes('批量')]
  ]) {
    const d = await post('/api/admin/posts/batch', { ids, action, value: action.endsWith('Tags') ? '#批量' : undefined })
    must(d.affected === 2, `${action} affected=${d.affected}`)
    for (const id of ids) must(check(await get(`/api/admin/posts/${id}`)), `${action} 没生效`)
  }
  await post('/api/admin/posts/batch', { ids, action: 'setCreator', value: 5 })
  must((await get('/api/admin/posts/2')).creatorId === 5, 'setCreator')
  mustFail(await req('POST', '/api/admin/posts/batch', { body: { ids, action: 'setCreator', value: null } }), 'value')
  const extra = await post('/api/admin/posts', { creatorId: 1, text: '待删帖子' })
  must((await post('/api/admin/posts/batch', { ids: [extra.id], action: 'delete' })).affected === 1, 'delete')
  const single = await post('/api/admin/posts', { creatorId: 1, text: '单条删除' })
  must((await del(`/api/admin/posts/${single.id}`)).ok, '单条删除')
  mustFail(await req('GET', `/api/admin/posts/${single.id}`), undefined, 400, /帖子不存在/)
  return 'ok'
})

await t('帖子详情正文：新建 / 修改 / 清空 / 列表搜索', async () => {
  const p = await post('/api/admin/posts', { creatorId: 3, text: '正文测试帖', content: '第一段 风铃草  \r\n第二行\t\r\n\r\n\r\n　　第三段缩进保留\n\n  ' })
  must(p.content === '第一段 风铃草\n第二行\n\n\n　　第三段缩进保留', '统一换行、去行尾空白和首尾空白：' + JSON.stringify(p.content))
  must(dbq('SELECT content FROM posts WHERE id = ?', p.id)[0].content === p.content, '库里的值')
  must((await get(`/api/admin/posts/${p.id}`)).content === p.content, '单条读取')
  must((await get('/api/admin/posts?q=' + encodeURIComponent('风铃草'))).list.map(x => x.id).join() === String(p.id), '列表搜索应能搜到正文')
  must((await get('/api/admin/posts?q=' + encodeURIComponent('正文测试帖'))).list.find(x => x.id === p.id)?.content === p.content, '列表行带 content')
  must((await patch(`/api/admin/posts/${p.id}`, { readCount: 5 })).content === p.content, '没传 content 不应改')
  const d = await patch(`/api/admin/posts/${p.id}`, { content: '改过的正文' })
  must(d.content === '改过的正文' && d.text === '正文测试帖', '修改 ' + JSON.stringify([d.text, d.content]))
  must((await patch(`/api/admin/posts/${p.id}`, { content: ' \n ' })).content === '', '只有空白 = 清空')
  await patch(`/api/admin/posts/${p.id}`, { content: 'x' })
  must((await patch(`/api/admin/posts/${p.id}`, { content: null })).content === '', 'null = 清空')
  const plain = await post('/api/admin/posts', { creatorId: 3, text: '没有正文的帖子' })
  must(plain.content === '' && dbq('SELECT content FROM posts WHERE id = ?', plain.id)[0].content === '', '不传时默认空串')
  must((await patch(`/api/admin/posts/${p.id}`, { text: '改了标题' })).content === '', '改标题不动正文')
  await del(`/api/admin/posts/${plain.id}`)
  await del(`/api/admin/posts/${p.id}`)
  return '规范化 / 留空不改 / 清空 / 搜索'
})

await t('帖子详情正文校验：最多 20000 字、只收文本', async () => {
  const p = await post('/api/admin/posts', { creatorId: 3, text: '长正文', content: '字'.repeat(20000) })
  must([...p.content].length === 20000, '20000 字应能保存')
  mustFail(await req('POST', '/api/admin/posts', { body: { creatorId: 3, text: 'x', content: '字'.repeat(20001) } }), 'content', 400, /详情正文最多 20000 个字/)
  mustFail(await req('PATCH', `/api/admin/posts/${p.id}`, { body: { content: 'a'.repeat(20001) } }), 'content', 400, /20000/)
  must([...(await get(`/api/admin/posts/${p.id}`)).content].length === 20000, '校验失败不应改动')
  for (const bad of [{ a: 1 }, ['a'], 'a\u0000b', 'a\u001bb']) {
    mustFail(await req('POST', '/api/admin/posts', { body: { creatorId: 3, text: 'x', content: bad } }), 'content')
  }
  const emoji = await patch(`/api/admin/posts/${p.id}`, { content: '😀'.repeat(20000) })
  must([...emoji.content].length === 20000, 'emoji 按字计数（不是 UTF-16 长度）')
  must((await patch(`/api/admin/posts/${p.id}`, { content: 12345 })).content === '12345', '数字按文本存')
  await del(`/api/admin/posts/${p.id}`)
  return '20000 字可存、20001 字报错，对象 / 数组 / 控制字符报错'
})

/* ================================================================ */
/*  专题                                                             */
/* ================================================================ */

let T1 = null
await t('专题新建：自动标识 + 4 张占位头图', async () => {
  T1 = await post('/api/admin/topics', { name: '新专题' })
  must(T1.slug === 'topic-' + T1.id && T1.kind === 0 && T1.cardSize === 4 && T1.status === 1, JSON.stringify(T1))
  must(T1.covers.length === 0, '头图地址应为空')
  const covers = dbq('SELECT url, fallback FROM topic_covers WHERE topic_id = ? ORDER BY sort_order', T1.id)
  must(covers.length === 4 && covers.every(c => c.url === null && c.fallback), '占位头图 ' + covers.length)
  must(covers.every(c => c.fallback.length <= 1500), '占位头图应 ≤ 1.5 KB：' + covers.map(c => c.fallback.length))
  must(T1.sortOrder > 10, '排序应排在最后 ' + T1.sortOrder)
  return `${T1.slug}`
})

await t('专题校验：错误带 field', async () => {
  const cases = [
    [{ name: '' }, 'name'], [{ name: 'x'.repeat(41) }, 'name'], [{ name: 'a', slug: 'featured' }, 'slug'],
    [{ name: 'a', slug: 'Bad Slug' }, 'slug'], [{ name: 'a', slug: '-x' }, 'slug'], [{ name: 'a', cardSize: 50 }, 'cardSize'],
    [{ name: 'a', kind: 5 }, 'kind'], [{ name: 'a', covers: Array.from({ length: 5 }, (_, i) => `/c/${i}.jpg`) }, 'covers'],
    [{ name: 'a', covers: 'ftp://x/a.jpg' }, 'covers']
  ]
  for (const [body, field] of cases) mustFail(await req('POST', '/api/admin/topics', { body }), field)
  return `${cases.length} 种`
})

await t('专题修改：头图 / 标识 / 类型标签', async () => {
  const d = await patch(`/api/admin/topics/${T1.id}`, { covers: '/media/covers/a.jpg\n/media/covers/b.jpg', slug: 'New-Topic', kind: '片库分类', description: '说明' })
  must(d.covers.join() === '/media/covers/a.jpg,/media/covers/b.jpg' && d.slug === 'new-topic' && d.kind === 2, JSON.stringify(d))
  const rows = dbq('SELECT url FROM topic_covers WHERE topic_id = ? ORDER BY sort_order', T1.id)
  must(rows.length === 4 && rows[0].url === '/media/covers/a.jpg' && rows[3].url === null, '头图应补齐 4 格')
  mustFail(await req('PATCH', `/api/admin/topics/${T1.id}`, { body: { slug: 'featured' } }), 'slug', 400, /标识已存在/)
  return 'ok'
})

await t('专题列表：筛选 / 排序 / 视频数', async () => {
  const d = await get('/api/admin/topics?pageSize=200')
  must(d.total === 13 && d.list.every((x, i) => i === 0 || d.list[i - 1].sortOrder <= x.sortOrder), '默认按排序升序')
  const t2 = d.list.find(x => x.id === 2)
  must(t2.videoCount === 40 && t2.totalVideos === 40 && t2.sectionCount === 1 && t2.covers.length === 4, JSON.stringify(t2))
  must((await get('/api/admin/topics?kind=2')).list.every(x => x.kind === 2), '类型筛选')
  must((await get('/api/admin/topics?q=' + encodeURIComponent('新专题'))).total === 1, '搜索')
  must((await get('/api/admin/topics?q=healing')).total === 1, '按标识搜索')
  const byCount = await get('/api/admin/topics?sort=videoCount&order=desc')
  must(byCount.list.every((x, i) => i === 0 || byCount.list[i - 1].videoCount >= x.videoCount), '视频数排序')
  return `${d.total} 个专题`
})

await t('专题排序：PUT /topics/order', async () => {
  const before = (await get('/api/admin/topics?pageSize=200')).list.map(x => x.id)
  const next = [...before].reverse()
  const r = await put('/api/admin/topics/order', { ids: next })
  must(r.affected === next.length, 'affected ' + r.affected)
  const after = (await get('/api/admin/topics?pageSize=200')).list
  must(after.map(x => x.id).join() === next.join() && after.every((x, i) => x.sortOrder === i), '顺序没变')
  await put('/api/admin/topics/order', { ids: before })
  mustFail(await req('PUT', '/api/admin/topics/order', { body: { ids: 'x' } }), 'ids')
  return 'ok'
})

await t('专题批量：上架 / 下架', async () => {
  must((await post('/api/admin/topics/batch', { ids: [T1.id], action: 'unpublish' })).affected === 1, 'unpublish')
  must((await get(`/api/admin/topics/${T1.id}`)).status === 2, '状态')
  const lib = await get('/api/library')
  must(!lib.some(x => x.id === T1.id), '下架的专题不应出现在片库')
  await post('/api/admin/topics/batch', { ids: [T1.id], action: 'publish' })
  must((await get(`/api/admin/topics/${T1.id}`)).status === 1, 'publish')
  return 'ok'
})

await t('专题删除：返回删掉的分区数和脱离的视频数', async () => {
  const tp = await post('/api/admin/topics', { name: '将被删除' })
  await post('/api/admin/sections', { title: '跟着被删', topicId: tp.id })
  const v1 = await post('/api/admin/videos', { title: '脱离1', topicId: tp.id })
  await post('/api/admin/videos', { title: '脱离2', topicId: tp.id, status: 0 })
  const row = await get(`/api/admin/topics/${tp.id}`)
  must(row.sectionCount === 1 && row.totalVideos === 2 && row.videoCount === 1, JSON.stringify(row))
  const d = await del(`/api/admin/topics/${tp.id}`)
  must(d.ok && d.deletedSections === 1 && d.detachedVideos === 2, JSON.stringify(d))
  must((await get(`/api/admin/videos/${v1.id}`)).topicId === null, '视频应变成无专题')
  must(!(await get('/api/admin/sections')).list.some(s => s.title === '跟着被删'), '分区应被级联删除')
  // 批量删除也返回影响数
  const tp2 = await post('/api/admin/topics', { name: '批量删' })
  await post('/api/admin/videos', { title: '脱离3', topicId: tp2.id })
  const b = await post('/api/admin/topics/batch', { ids: [tp2.id], action: 'delete' })
  must(b.affected === 1 && b.detachedVideos === 1 && b.deletedSections === 0, JSON.stringify(b))
  return `分区 ${d.deletedSections}，视频 ${d.detachedVideos}`
})

/* ================================================================ */
/*  创作者                                                           */
/* ================================================================ */

let C1 = null
await t('创作者新建：自动账号 + 首字头像', async () => {
  C1 = await post('/api/admin/creators', { name: '测试作者', bio: '简介', isVerified: true })
  must(C1.handle === 'c' + C1.id && C1.isVerified === true && C1.status === 1 && C1.videoCount === 0, JSON.stringify(C1))
  const fb = dbq('SELECT avatar_fallback FROM creators WHERE id = ?', C1.id)[0].avatar_fallback
  must(fb && fb.startsWith("url('data:image/svg+xml"), '没有首字头像')
  const c2 = await post('/api/admin/creators', { name: '带账号', handle: '@abc_1' })
  must(c2.handle === 'abc_1', c2.handle)
  return `${C1.handle} / ${c2.handle}`
})

await t('创作者校验：错误带 field', async () => {
  const cases = [
    [{ name: '' }, 'name'], [{ name: 'x'.repeat(31) }, 'name'], [{ name: 'a', handle: 'aijc' }, 'handle'],
    [{ name: 'a', handle: 'a' }, 'handle'], [{ name: 'a', handle: '中文账号' }, 'handle'], [{ name: 'a', bio: 'x'.repeat(201) }, 'bio'],
    [{ name: 'a', avatarUrl: 'avatar.png' }, 'avatarUrl'], [{ name: 'a', status: 2 }, 'status']
  ]
  for (const [body, field] of cases) mustFail(await req('POST', '/api/admin/creators', { body }), field)
  return `${cases.length} 种`
})

await t('创作者修改：改名后头像占位图跟着变', async () => {
  const before = dbq('SELECT avatar_fallback FROM creators WHERE id = ?', C1.id)[0].avatar_fallback
  const d = await patch(`/api/admin/creators/${C1.id}`, { name: '新名字', isOfficial: '是' })
  must(d.name === '新名字' && d.isOfficial === true, JSON.stringify(d))
  must(dbq('SELECT avatar_fallback FROM creators WHERE id = ?', C1.id)[0].avatar_fallback !== before, '头像占位图没变')
  mustFail(await req('PATCH', `/api/admin/creators/${C1.id}`, { body: { handle: 'trip' } }), 'handle', 400, /账号已存在/)
  return 'ok'
})

await t('创作者列表：筛选 / 排序', async () => {
  const d = await get('/api/admin/creators')
  must(d.total === 14 && d.list[0].id > d.list[1].id, '默认 id 倒序')
  must((await get('/api/admin/creators?q=@trip')).list.some(c => c.handle === 'trip'), '@账号搜索')
  must((await get('/api/admin/creators?verified=1')).list.every(c => c.isVerified), '认证筛选')
  const byVid = await get('/api/admin/creators?sort=videoCount&order=desc')
  must(byVid.list.every((c, i) => i === 0 || byVid.list[i - 1].videoCount >= c.videoCount) && byVid.list[0].videoCount > 30, '视频数排序')
  return `${d.total} 个`
})

await t('创作者批量：启用 / 停用 / 认证 / 取消认证', async () => {
  for (const [action, check] of [['disable', c => c.status === 0], ['enable', c => c.status === 1], ['unverify', c => !c.isVerified], ['verify', c => c.isVerified]]) {
    must((await post('/api/admin/creators/batch', { ids: [C1.id], action })).affected === 1, action)
    must(check(await get(`/api/admin/creators/${C1.id}`)), `${action} 没生效`)
  }
  return 'ok'
})

await t('创作者删除：帖子级联删除、视频脱离', async () => {
  const c = await post('/api/admin/creators', { name: '将删除的作者' })
  await post('/api/admin/posts', { creatorId: c.id, text: '帖子一' })
  await post('/api/admin/posts', { creatorId: c.id, text: '帖子二' })
  const v = await post('/api/admin/videos', { title: '作者的视频', creatorId: c.id })
  const row = await get(`/api/admin/creators/${c.id}`)
  must(row.postCount === 2 && row.videoCount === 1, JSON.stringify(row))
  const d = await del(`/api/admin/creators/${c.id}`)
  must(d.ok && d.deletedPosts === 2 && d.detachedVideos === 1, JSON.stringify(d))
  must((await get(`/api/admin/videos/${v.id}`)).creatorId === null, '视频应脱离创作者')
  const c2 = await post('/api/admin/creators', { name: '批量删除的作者' })
  await post('/api/admin/posts', { creatorId: c2.id, text: '帖子三' })
  const b = await post('/api/admin/creators/batch', { ids: [c2.id], action: 'delete' })
  must(b.affected === 1 && b.deletedPosts === 1 && b.detachedVideos === 0, JSON.stringify(b))
  return `帖子 ${d.deletedPosts}，视频 ${d.detachedVideos}`
})

/* ================================================================ */
/*  搜索热词                                                         */
/* ================================================================ */

await t('热词：增删改查 + 批量', async () => {
  const k = await post('/api/admin/keywords', { word: '新热词', weight: '1,000', isHot: '是' })
  must(k.word === '新热词' && k.weight === 1000 && k.isHot === true && k.isBanned === false, JSON.stringify(k))
  mustFail(await req('POST', '/api/admin/keywords', { body: { word: '新热词' } }), 'word', 400, /热词已存在/)
  mustFail(await req('POST', '/api/admin/keywords', { body: { word: 'x'.repeat(21) } }), 'word')
  mustFail(await req('POST', '/api/admin/keywords', { body: { word: 'ok', weight: 'abc' } }), 'weight')
  // App 只列搜得到内容的热词：「新热词」搜不到任何视频 / 帖子，不显示；搜得到的「城市」权重最高，排第一
  must(!(await get('/api/search/hot')).some(x => x.word === '新热词'), '搜不到内容的热词不应显示')
  const k3 = await post('/api/admin/keywords', { word: '城市', weight: 2000 })
  const hot = await get('/api/search/hot')
  must(hot.length === 8 && hot[0].word === '城市', 'App 热词第一位应是权重最高的新词 ' + hot.map(x => x.word).join(','))
  must((await post('/api/admin/keywords/batch', { ids: [k3.id], action: 'ban' })).affected === 1, 'ban 城市')
  must(!(await get('/api/search/hot?page=0')).some(x => x.word === '城市'), '屏蔽后 App 不应显示')
  must((await del(`/api/admin/keywords/${k3.id}`)).ok, '删除城市')
  const p = await patch(`/api/admin/keywords/${k.id}`, { weight: 5, sortOrder: 99 })
  must(p.weight === 5 && p.sortOrder === 99, JSON.stringify(p))
  mustFail(await req('PATCH', `/api/admin/keywords/${k.id}`, { body: { word: '露营' } }), 'word')
  const list = await get('/api/admin/keywords?q=' + encodeURIComponent('热词'))
  must(list.total === 1, '搜索')
  const sorted = await get('/api/admin/keywords?pageSize=100')
  must(sorted.list.every((x, i) => i === 0 || sorted.list[i - 1].weight >= x.weight), '默认权重倒序')
  for (const [action, check] of [['ban', x => x.isBanned], ['unban', x => !x.isBanned], ['unhot', x => !x.isHot], ['hot', x => x.isHot]]) {
    must((await post('/api/admin/keywords/batch', { ids: [k.id], action })).affected === 1, action)
    must(check(await get(`/api/admin/keywords/${k.id}`)), action + ' 没生效')
  }
  must((await post('/api/admin/keywords/batch', { ids: [k.id], action: 'ban' })).affected === 1, 'ban')
  const k2 = await post('/api/admin/keywords', { word: '待删热词' })
  must((await del(`/api/admin/keywords/${k2.id}`)).ok, '单条删除')
  must((await post('/api/admin/keywords/batch', { ids: [k.id], action: 'delete' })).affected === 1, '批量删除')
  return 'ok'
})

/* ================================================================ */
/*  首页推荐分区                                                     */
/* ================================================================ */

let S1 = null
await t('分区：列表 + 新建（大卡唯一）', async () => {
  const before = await get('/api/admin/sections')
  must(before.list.length === 6 && before.list[0].isFeatured && before.list[0].batchCount === 4 && before.list[0].itemCount === 160, JSON.stringify(before.list[0]))
  S1 = await post('/api/admin/sections', { title: '测试分区', subtitle: '副标题', topicId: TB.id, cardSize: 3, isFeatured: true })
  must(S1.topicName === '批量测试专题' && S1.isFeatured && S1.status === 1 && S1.sortOrder === 6 && S1.itemCount === 0, JSON.stringify(S1))
  const after = await get('/api/admin/sections')
  must(after.list.filter(s => s.isFeatured).length === 1, '应只剩一个大卡')
  mustFail(await req('POST', '/api/admin/sections', { body: { title: '' } }), 'title')
  mustFail(await req('POST', '/api/admin/sections', { body: { title: 'x'.repeat(31) } }), 'title')
  mustFail(await req('POST', '/api/admin/sections', { body: { title: 'a', cardSize: 0 } }), 'cardSize')
  mustFail(await req('POST', '/api/admin/sections', { body: { title: 'a', topicId: 999999 } }), 'topicId')
  return `#${S1.id}`
})

await t('分区：修改', async () => {
  const d = await patch(`/api/admin/sections/${S1.id}`, { title: '改名分区', isFeatured: false, status: 0 })
  must(d.title === '改名分区' && !d.isFeatured && d.status === 0 && d.updatedAt >= S1.updatedAt, JSON.stringify(d))
  must(!(await get('/api/home/recommend')).some(s => s.id === S1.id), '停用后 App 不应显示')
  await patch(`/api/admin/sections/${S1.id}`, { status: 1 })
  mustFail(await req('PATCH', '/api/admin/sections/999999', { body: { title: 'x' } }), undefined, 400, /分区不存在/)
  return 'ok'
})

await t('分区内容：GET 分批 + PUT 去重 / 去空批', async () => {
  const seeded = await get('/api/admin/sections/1/items')
  must(seeded.batches.length === 4 && seeded.batches[0].length === 40, `种子分区 ${seeded.batches.length} 批`)
  const b = seeded.batches[0][0]
  must(['id', 'publicId', 'title', 'coverUrl', 'status', 'durationSec', 'topicName'].every(k => k in b), 'VideoBrief 字段')
  const [a, c, d] = batchIds
  const r = await put(`/api/admin/sections/${S1.id}/items`, { batches: [[a, c, a], [], [d, c]] })
  must(r.batches.length === 2 && r.batches[0].join && r.batches[0].map(x => x.id).join() === `${a},${c}` && r.batches[1].map(x => x.id).join() === `${d},${c}`, JSON.stringify(r.batches.map(x => x.map(y => y.id))))
  const app = await get(`/api/home/section/${S1.id}/videos?size=3&batch=1`)
  must(app.map(v => v.id).join() === `${d},${c}`, 'App 第 2 批 ' + app.map(v => v.id))
  const rec = (await get('/api/home/recommend')).find(s => s.id === S1.id)
  must(rec && rec.batches === 2, 'App 批次数')
  mustFail(await req('PUT', `/api/admin/sections/${S1.id}/items`, { body: { batches: [[a, 99999991, 99999992]] } }), 'batches', 400, /99999991, 99999992/)
  mustFail(await req('PUT', `/api/admin/sections/${S1.id}/items`, { body: { batches: [Array.from({ length: 61 }, (_, i) => i + 1)] } }), 'batches')
  mustFail(await req('PUT', `/api/admin/sections/${S1.id}/items`, { body: { batches: Array.from({ length: 21 }, () => [a]) } }), 'batches')
  // 草稿视频也返回，前端据 status 标出来
  await post('/api/admin/videos/batch', { ids: [a], action: 'draft' })
  const items = await get(`/api/admin/sections/${S1.id}/items`)
  must(items.batches[0][0].status === 0, '草稿也应返回')
  must((await get(`/api/home/section/${S1.id}/videos?size=3&batch=0`)).every(v => v.id !== a), 'App 不应显示草稿')
  await post('/api/admin/videos/batch', { ids: [a], action: 'publish' })
  return 'ok'
})

await t('分区自动生成：按专题 / 最热 / 最新', async () => {
  const byTopic = await post(`/api/admin/sections/${S1.id}/rebuild`, { source: 'topic', batches: 2 })
  must(byTopic.batches.length === 2 && byTopic.batches.every(b => b.length === 3), '按专题 ' + byTopic.batches.map(b => b.length))
  must(byTopic.batches.flat().every(v => batchIds.includes(v.id)), '只能来自关联专题')
  const hot = await post(`/api/admin/sections/${S1.id}/rebuild`, { source: 'hot', batches: 3, size: 5 })
  const top = (await get('/api/admin/videos?status=1&sort=playCount&order=desc&pageSize=10')).list.map(v => v.id)
  must(hot.batches.length === 3 && hot.batches[0].map(v => v.id).join() === top.slice(0, 5).join() && hot.batches[1].map(v => v.id).join() === top.slice(5, 10).join(), '最热')
  const latest = await post(`/api/admin/sections/${S1.id}/rebuild`, { source: 'latest' })
  const newest = (await get('/api/admin/videos?status=1&sort=publishedAt&order=desc&pageSize=3')).list.map(v => v.id)
  must(latest.batches.length === 4 && latest.batches[0].map(v => v.id).join() === newest.join(), '最新：默认 4 批、每批 = 首屏数量')
  mustFail(await req('POST', `/api/admin/sections/${S1.id}/rebuild`, { body: { source: 'random' } }), 'source')
  mustFail(await req('POST', `/api/admin/sections/${S1.id}/rebuild`, { body: { source: 'hot', batches: 21 } }), 'batches')
  const noTopic = await post('/api/admin/sections', { title: '无专题分区' })
  mustFail(await req('POST', `/api/admin/sections/${noTopic.id}/rebuild`, { body: { source: 'topic' } }), 'source')
  await del(`/api/admin/sections/${noTopic.id}`)
  return '三种来源都正确'
})

await t('分区排序 + 删除', async () => {
  const ids = (await get('/api/admin/sections')).list.map(s => s.id)
  const next = [S1.id, ...ids.filter(i => i !== S1.id)]
  await put('/api/admin/sections/order', { ids: next })
  const after = (await get('/api/admin/sections')).list
  must(after[0].id === S1.id && after.every((s, i) => s.sortOrder === i), '排序')
  must((await get('/api/home/recommend'))[0].id === S1.id, 'App 分区顺序')
  const tmp = await post('/api/admin/sections', { title: '临时' })
  must((await del(`/api/admin/sections/${tmp.id}`)).ok, '删除')
  mustFail(await req('GET', `/api/admin/sections/${tmp.id}/items`), undefined, 400, /分区不存在/)
  return 'ok'
})

/* ================================================================ */
/*  批量导入                                                         */
/* ================================================================ */

const vCount = async () => (await get('/api/admin/videos?pageSize=1')).total
const IMPORT_ROWS = [
  { _row: 2, title: '导入视频一', publicId: 'IMP-001', topic: '自动专题A', creator: '@newbie', category: '国产', region: 'cn', quality: '720p', tags: '城市 夜景', duration: '01:02:03', playbackUrl: '/media/videos/imp1.mp4', status: '下架', publishedAt: 45292 },
  { _row: 3, title: '导入视频二', topic: '治愈日常', creator: '旅行日记', duration: '75:30', status: 'draft', publishedAt: '45292.5', isShort: '是' },
  { _row: 4, title: '', publicId: 'IMP-BAD' },
  { _row: 5, title: "'=SUM(1+1)", publicId: 'IMP-003', topic: 'healing', creator: '3', duration: '90.6', tags: ['#a', 'b,c'], publishedAt: '2024/05/06 07:08:09', status: 'published' }
]

await t('导入预检（dryRun）：结果准确且不落库', async () => {
  const before = await vCount()
  const topicsBefore = (await get('/api/admin/meta')).topics.length
  const d = await importRows('videos', IMPORT_ROWS, {}, true)
  must(d.total === 4 && d.created === 3 && d.failed === 1 && d.updated === 0 && d.skipped === 0, JSON.stringify({ ...d, results: undefined }))
  must(d.results.map(r => r.row).join() === '2,3,4,5', '行号应用 _row')
  must(d.results[2].status === 'error' && d.results[2].field === 'title', JSON.stringify(d.results[2]))
  must(d.autoCreated.topics.join() === '自动专题A' && d.autoCreated.creators.join() === 'newbie', JSON.stringify(d.autoCreated))
  must(await vCount() === before, '预检不应落库')
  must((await get('/api/admin/meta')).topics.length === topicsBefore, '预检不应留下自动创建的专题')
  return `新增 ${d.created} / 错误 ${d.failed}`
})

const IMP = {}
await t('导入：真正写入 + 各种取值格式', async () => {
  const before = await vCount()
  const d = await importRows('videos', IMPORT_ROWS)
  must(d.created === 3 && d.failed === 1 && await vCount() === before + 3, JSON.stringify({ ...d, results: undefined }))
  const ids = d.results.filter(r => r.status === 'created').map(r => r.id)
  const [a, b, c] = await Promise.all(ids.map(id => get(`/api/admin/videos/${id}`)))
  Object.assign(IMP, { a, b, c })
  must(a.topicName === '自动专题A' && a.creatorHandle === 'newbie' && a.categoryKey === 'cn' && a.quality === 'hd', '引用 / 枚举 ' + JSON.stringify(a))
  must(JSON.stringify(a.tags) === '["#城市","#夜景"]' && a.durationSec === 3723 && a.status === 2, '标签 / 时长 / 下架')
  must(a.publishedAt === localTs(2024, 0, 1), 'Excel 日期序号 45292 应为 2024-01-01 本地零点')
  must(b.publishedAt === localTs(2024, 0, 1, 12, 0, 0) && b.durationSec === 4530 && b.status === 0 && b.isShort === true, 'Excel 小数日期 / 75:30 / draft / 短视频')
  must(b.topicId === 2 && b.creatorHandle === 'trip', '按名称找到已有专题 / 创作者')
  must(c.title === '=SUM(1+1)', "CSV 防注入的 ' 应去掉：" + c.title)
  must(c.topicId === 2 && c.creatorId === 3 && c.durationSec === 91 && c.status === 1, '按标识找专题 / 按 id 找创作者 / 小数秒')
  must(JSON.stringify(c.tags) === '["#a","#b","#c"]', '数组标签再拆分 ' + JSON.stringify(c.tags))
  must(c.publishedAt === localTs(2024, 4, 6, 7, 8, 9), '斜杠日期')
  const topic = (await get('/api/admin/meta')).topics.find(x => x.name === '自动专题A')
  must(topic && topic.kind === 0 && topic.status === 1 && topic.slug === 'topic-' + topic.id, '自动创建的专题 ' + JSON.stringify(topic))
  must(dbq('SELECT COUNT(*) n FROM topic_covers WHERE topic_id = ?', topic.id)[0].n === 4, '自动专题应有 4 张占位头图')
  must((await get(`/api/admin/topics/${topic.id}`)).videoCount === 0, '下架视频不计入专题视频数')
  return `新增 ${d.created}`
})

await t('导入：重复数据 skip / error / update', async () => {
  const rows = [
    { title: '按编号重复', publicId: 'IMP-001' },
    { title: '按播放地址重复', playbackUrl: '/media/videos/imp1.mp4' }
  ]
  const skip = await importRows('videos', rows)
  must(skip.skipped === 2 && skip.results.every(r => r.id === IMP.a.id), JSON.stringify(skip.results))
  const err = await importRows('videos', rows, { onDuplicate: 'error' })
  must(err.failed === 2 && err.results[0].field === 'publicId' && err.results[1].field === 'playbackUrl', JSON.stringify(err.results))
  const upd = await importRows('videos', [{ publicId: 'IMP-001', title: '更新后的标题', description: '' }], { onDuplicate: 'update' })
  must(upd.updated === 1, JSON.stringify(upd))
  const a = await get(`/api/admin/videos/${IMP.a.id}`)
  must(a.title === '更新后的标题' && a.durationSec === 3723 && a.topicName === '自动专题A' && a.status === 2, '空单元格应保持不变 ' + JSON.stringify(a))
  return 'ok'
})

await t('导入：文件内重复（第二行能看到第一行的写入）', async () => {
  const rows = [
    { title: '文件内一', playbackUrl: '/media/videos/dup.mp4' },
    { title: '文件内二', playbackUrl: '/media/videos/dup.mp4' }
  ]
  const dry = await importRows('videos', rows, {}, true)
  must(dry.created === 1 && dry.skipped === 1, '预检 ' + JSON.stringify(dry.results))
  const upd = await importRows('videos', rows, { onDuplicate: 'update' })
  must(upd.created === 1 && upd.updated === 1 && upd.results[1].id === upd.results[0].id, JSON.stringify(upd.results))
  must((await get(`/api/admin/videos/${upd.results[0].id}`)).title === '文件内二', '第二行应覆盖第一行')
  return 'ok'
})

await t('导入：autoCreate 关闭时引用不存在报错', async () => {
  const d = await importRows('videos', [
    { title: 'x', topic: '不存在的专题' }, { title: 'y', creator: '不存在的人' }, { title: 'z', topic: '99999' }
  ], { autoCreate: false })
  must(d.failed === 3, JSON.stringify(d.results))
  must(d.results[0].field === 'topic' && /专题「不存在的专题」不存在/.test(d.results[0].message), JSON.stringify(d.results[0]))
  must(d.results[1].field === 'creator' && d.results[2].field === 'topic', JSON.stringify(d.results))
  const on = await importRows('videos', [{ title: 'z', topic: '99999' }], {}, true)
  must(on.failed === 1, '按 id 引用不存在时即使 autoCreate 也不创建')
  return d.results[0].message
})

await t('导入：坏行不影响其他行 + 显式 ID 不存在', async () => {
  const before = await vCount()
  const d = await importRows('videos', [
    { title: '好行一' }, { title: '坏行', duration: 'abc' }, { id: '99999999', title: '不存在的 ID' }, { title: '坏地址', coverUrl: 'javascript:1' }, { title: '好行二' }, null, {}
  ])
  must(d.created === 2 && d.failed === 4 && d.skipped === 1, JSON.stringify({ ...d, results: d.results.map(r => r.status + ':' + (r.field || '')) }))
  must(d.results[1].field === 'duration', '时长错误应标在 duration 列：' + d.results[1].field)
  must(d.results[2].message === 'ID 不存在' && d.results[2].field === 'id', JSON.stringify(d.results[2]))
  must(d.results[3].field === 'coverUrl', JSON.stringify(d.results[3]))
  must(await vCount() === before + 2, '只应写入 2 条')
  return '2 成功 / 4 失败 / 1 空行'
})

await t('导入：参数校验', async () => {
  mustFail(await req('POST', '/api/admin/videos/import', { body: { rows: 'x' } }), 'rows')
  mustFail(await req('POST', '/api/admin/videos/import', { body: { rows: [], options: { onDuplicate: 'merge' } } }), 'onDuplicate')
  mustFail(await req('POST', '/api/admin/videos/import', { body: { rows: [], options: { defaultStatus: 5 } } }), 'defaultStatus')
  const many = Array.from({ length: 20001 }, () => ({ title: 'x' }))
  mustFail(await req('POST', '/api/admin/videos/import', { body: { rows: many, dryRun: true } }), 'rows', 400, /20000/)
  const ds = await importRows('videos', [{ title: '默认草稿' }], { defaultStatus: 0 })
  must((await get(`/api/admin/videos/${ds.results[0].id}`)).status === 0, 'defaultStatus 没生效')
  return 'ok'
})

await t('导入：帖子（账号 / 名称 / 视频编号 / 1.2w / 千分位）', async () => {
  const d = await importRows('posts', [
    // moreCount（旧的「折叠数」列）不再导入：App 按真实图片数显示 +N，这一列忽略
    { creator: '@aijc', text: '导入帖子一', kind: '文档', tags: '#AI #剧情,短剧', readCount: '1.2w', moreCount: '1,234', video: 'VID-1002', isHot: 'y', images: '/i/1.jpg /i/2.jpg' },
    { creator: '晴川', text: '导入帖子二', kind: 'image', mainImage: 'https://e.com/m.jpg' },
    { creator: '全新作者', text: '自动建作者' },
    { creator: '@aijc', text: '' }
  ])
  must(d.created === 3 && d.failed === 1 && d.results[3].field === 'text', JSON.stringify(d.results))
  const [p1, p2, p3] = await Promise.all(d.results.slice(0, 3).map(r => get(`/api/admin/posts/${r.id}`)))
  must(p1.creatorHandle === 'aijc' && p1.mediaKind === 2 && p1.readCount === 12000 && p1.moreCount === 0 && p1.videoPublicId === 'VID-1002' && p1.isHot, JSON.stringify(p1))
  must(JSON.stringify(p1.tags) === '["AI","剧情","短剧"]' && p1.images.length === 2, '帖子标签不带 # ' + JSON.stringify(p1.tags))
  must(p2.creatorHandle === 'qingchuan' && p2.mediaKind === 0 && p2.mainImage === 'https://e.com/m.jpg', JSON.stringify(p2))
  must(p3.creatorName === '全新作者' && /^c\d+$/.test(p3.creatorHandle) && d.autoCreated.creators.join() === '全新作者', '中文名自动建作者账号应为 c<id>')
  const bad = await importRows('posts', [{ id: '99999999', text: 'x', creator: '@aijc' }, { creator: '@aijc', text: 'x', video: 'NOPE-1' }])
  must(bad.results[0].message === 'ID 不存在' && bad.results[1].field === 'video', JSON.stringify(bad.results))
  return '帖子导入正确'
})

await t('导入 / 导出：帖子正文（多行、留空不改、超长报错）', async () => {
  const d = await importRows('posts', [{ creator: '@trip', text: '导入正文帖', content: '第一段\r\n\r\n第二段  ' }])
  must(d.created === 1, JSON.stringify(d.results))
  const id = d.results[0].id
  must((await get(`/api/admin/posts/${id}`)).content === '第一段\n\n第二段', '导入时规范化')
  const ex = await get('/api/admin/posts/export?q=' + encodeURIComponent('导入正文帖'))
  must(ex.fields.indexOf('content') === ex.fields.indexOf('text') + 1, 'fields 顺序 ' + ex.fields.join())
  must(ex.rows.length === 1 && ex.rows[0].text === '导入正文帖' && ex.rows[0].content === '第一段\n\n第二段', JSON.stringify(ex.rows[0]))
  // 原样导回去：不改
  const same = await importRows('posts', ex.rows, { onDuplicate: 'update' })
  must(same.updated === 1 && (await get(`/api/admin/posts/${id}`)).content === '第一段\n\n第二段', '原样导回不应改')
  // 正文列留空 = 不改（只改了标题）
  await importRows('posts', [{ id: String(id), text: '导入正文帖（改标题）', content: '  ' }], { onDuplicate: 'update' })
  let p = await get(`/api/admin/posts/${id}`)
  must(p.content === '第一段\n\n第二段' && p.text === '导入正文帖（改标题）', '空单元格不应清空正文 ' + JSON.stringify([p.text, p.content]))
  // 只给正文：只改正文
  const u = await importRows('posts', [{ id: String(id), content: '新的正文\n第二行' }], { onDuplicate: 'update' })
  p = await get(`/api/admin/posts/${id}`)
  must(u.updated === 1 && p.content === '新的正文\n第二行' && p.text === '导入正文帖（改标题）', '只改正文 ' + JSON.stringify(p.content))
  const long = await importRows('posts', [{ id: String(id), content: '长'.repeat(20001) }, { creator: '@trip', text: '超长正文', content: '长'.repeat(20001) }], { onDuplicate: 'update' })
  must(long.failed === 2 && long.results.every(r => r.field === 'content'), JSON.stringify(long.results))
  must((await get(`/api/admin/posts/${id}`)).content === '新的正文\n第二行', '失败行不应改动')
  return `#${id} 导入 / 导出 / 留空不改`
})

await t('导入：专题 / 创作者 / 热词', async () => {
  const tp = await importRows('topics', [
    { name: '导入专题', slug: 'imp-topic', kind: '首页分区', cardSize: '6', covers: '/c/1.jpg,/c/2.jpg' },
    { name: '治愈日常', playsCount: '2w' },
    { name: '另一个', slug: 'healing' }
  ], { onDuplicate: 'update' })
  must(tp.created === 1 && tp.updated === 2, JSON.stringify(tp.results))
  const it = await get(`/api/admin/topics/${tp.results[0].id}`)
  must(it.slug === 'imp-topic' && it.kind === 1 && it.cardSize === 6 && it.covers.length === 2, JSON.stringify(it))
  const t2 = await get('/api/admin/topics/2')
  must(t2.name === '另一个' && t2.playsCount === 20000, '按名称、按标识匹配后更新 ' + JSON.stringify([t2.name, t2.playsCount]))
  await patch('/api/admin/topics/2', { name: '治愈日常' })
  const cr = await importRows('creators', [
    { name: '导入作者', handle: '@imp_author', isVerified: '√', status: '停用' },
    { name: '改名', handle: 'aijc' },
    { name: 'x', handle: '!' }
  ], { onDuplicate: 'update' })
  must(cr.created === 1 && cr.updated === 1 && cr.failed === 1 && cr.results[2].field === 'handle', JSON.stringify(cr.results))
  const ic = await get(`/api/admin/creators/${cr.results[0].id}`)
  must(ic.handle === 'imp_author' && ic.isVerified && ic.status === 0, JSON.stringify(ic))
  await patch('/api/admin/creators/1', { name: 'AI剧场' })
  const kw = await importRows('keywords', [{ word: '导入热词', weight: '3.4k', isHot: '是' }, { word: '露营', weight: 1 }, { word: '', weight: 5 }], { onDuplicate: 'update' })
  must(kw.created === 1 && kw.updated === 1 && kw.failed === 1, JSON.stringify(kw.results))
  must((await get(`/api/admin/keywords/${kw.results[0].id}`)).weight === 3400, '3.4k')
  return 'ok'
})

/* ---------------- 导出 → 再导入（更新）= 数据不变 ---------------- */

const snapshot = async type => {
  const pages = []
  for (let page = 1; ; page++) {
    const d = await get(`/api/admin/${type}?pageSize=200&page=${page}&sort=id&order=asc`)
    pages.push(...d.list)
    if (pages.length >= d.total) break
  }
  return JSON.stringify(pages)
}

for (const type of ['videos', 'posts', 'topics', 'creators', 'keywords']) {
  await t(`导出 → 再导入（${type}）：updated = n，数据不变`, async () => {
    const ex = await get(`/api/admin/${type}/export`)
    must(ex.fields.join() === SCHEMA[type].fields.map(f => f.key).join(), 'fields 应为 schema 顺序')
    must(ex.rows.length > 0 && ex.rows.every(r => Object.values(r).every(v => typeof v === 'string')), '导出值都应是字符串')
    const before = await snapshot(type)
    const mediaRows = () => JSON.stringify(dbq('SELECT id, url, fallback, duration_sec FROM post_media ORDER BY id').map(r => [r.id, r.url, r.fallback?.length, r.duration_sec]))
    const mediaBefore = mediaRows()
    const coversBefore = JSON.stringify(dbq('SELECT id, url FROM topic_covers ORDER BY id'))
    const d = await importRows(type, ex.rows.map((r, i) => ({ ...r, _row: i + 2 })), { onDuplicate: 'update' })
    must(d.updated === ex.rows.length && d.failed === 0 && d.created === 0, JSON.stringify({ ...d, results: d.results.filter(r => r.status !== 'updated').slice(0, 3) }))
    must(await snapshot(type) === before, '再导入后数据变了')
    must(JSON.stringify((await get(`/api/admin/${type}/export`)).rows) === JSON.stringify(ex.rows), '再导出结果不同')
    must(mediaRows() === mediaBefore, '帖子媒体行（含主图时长）被改了')
    must(JSON.stringify(dbq('SELECT id, url FROM topic_covers ORDER BY id')) === coversBefore, '专题头图被重写了')
    return `${ex.rows.length} 行全部 updated`
  })
}

await t('导出：筛选 + 导入格式', async () => {
  const ex = await get(`/api/admin/videos/export?topicId=${TB.id}`)
  must(ex.rows.length === 3 && ex.rows.every(r => r.topic === '批量测试专题'), '筛选 ' + ex.rows.length)
  const r = (await get(`/api/admin/videos/export?q=IMP-001`)).rows[0]
  must(r.duration === '01:02:03' && r.status === '已下架' && r.isShort === '否' && r.tags === '#城市,#夜景' && r.creator === 'newbie' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(r.publishedAt), JSON.stringify(r))
  const p = (await get('/api/admin/posts/export?q=' + encodeURIComponent('导入帖子一'))).rows[0]
  must(p.kind === '文档' && p.isHot === '是' && p.images === '/i/1.jpg\n/i/2.jpg' && p.video === 'VID-1002' && p.creator === 'aijc', JSON.stringify(p))
  return 'ok'
})

/* ================================================================ */
/*  素材文件                                                         */
/* ================================================================ */

const VIDEO_BYTES = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251))
let UP = null
await t('素材：新建文件夹', async () => {
  const d = await post('/api/admin/media/folder', { path: 'videos/测试 目录' })
  must(d.path === 'videos/测试 目录', JSON.stringify(d))
  const list = await get('/api/admin/media?dir=videos')
  must(list.dir === 'videos' && list.parent === '' && list.entries.some(e => e.type === 'dir' && e.name === '测试 目录'), JSON.stringify(list))
  for (const bad of ['../x', 'a/../../x', 'a:b', 'con', 'x/..', '.hidden', 'a\\b']) {
    mustFail(await req('POST', '/api/admin/media/folder', { body: { path: bad } }), 'path')
  }
  mustFail(await req('POST', '/api/admin/media/folder', { body: { path: '' } }), 'path')
  mustFail(await req('GET', '/api/admin/media?dir=nope'), 'dir', 400, /文件夹不存在/)
  mustFail(await req('GET', '/api/admin/media?dir=' + encodeURIComponent('../')), 'dir')
  return 'ok'
})

await t('素材：上传 + 重名自动改名 + 覆盖', async () => {
  const r = await upload('videos/测试 目录/片段_01.mp4', VIDEO_BYTES)
  UP = okData(r)
  must(UP.path === 'videos/测试 目录/片段_01.mp4' && UP.size === 5000, JSON.stringify(UP))
  must(UP.url === '/media/videos/' + encodeURIComponent('测试 目录') + '/' + encodeURIComponent('片段_01.mp4'), 'url 应逐段编码：' + UP.url)
  const r2 = okData(await upload('videos/测试 目录/片段_01.mp4', Buffer.from('second')))
  must(r2.path === 'videos/测试 目录/片段_01 (1).mp4', '自动改名 ' + r2.path)
  const r3 = okData(await upload('videos/测试 目录/片段_01 (1).mp4', Buffer.from('third!!'), { overwrite: true }))
  must(r3.path === 'videos/测试 目录/片段_01 (1).mp4' && r3.size === 7, '覆盖 ' + JSON.stringify(r3))
  okData(await upload('videos/测试 目录/片段_01.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])))
  okData(await upload('new/deep/dir/a.webm', Buffer.from('webm')))
  must(existsSync(join(MEDIA_DIR, 'new', 'deep', 'dir', 'a.webm')), '应自动建上级目录')
  must(partFiles().length === 0, '不应留下 .part')
  return UP.url
})

await t('素材：扩展名白名单 / 非法文件名', async () => {
  for (const p of ['videos/a.html', 'videos/a.js', 'videos/a.svg', 'videos/noext', 'videos/a.mp4.part']) {
    mustFail(await upload(p, Buffer.from('x')), 'path')
  }
  for (const p of ['../evil.mp4', 'videos/../../evil.mp4', 'videos/a..b.mp4', 'videos/a:b.mp4', 'videos/.x.mp4', 'videos/ x.mp4', 'videos/x.mp4.', '/', '']) {
    mustFail(await upload(p, Buffer.from('x')), 'path')
  }
  mustFail(await upload('videos/' + 'a'.repeat(201) + '.mp4', Buffer.from('x')), 'path')
  mustFail(await upload('videos/empty.mp4', Buffer.alloc(0)), 'path', 400, /空/)
  must(!existsSync(join(MEDIA_DIR, '..', 'evil.mp4')), '目录穿越写出了文件')
  return 'ok'
})

await t('素材：上传超过 MAX_UPLOAD_MB 返回 413 并删掉临时文件', async () => {
  const r = await upload('videos/big.mp4', Buffer.alloc(MAX_UPLOAD_MB * 1024 * 1024 + 10))
  must(r.status === 413 && r.json.code === 1, `声明长度超限期望 413，实际 ${r.status}`)
  const c = await chunkedRequest('PUT', '/api/admin/media/upload?path=videos/big2.mp4', MAX_UPLOAD_MB * 1024 * 1024 + 200 * 1024)
  must(c.status === 413, `分块上传超限期望 413，实际 ${c.status}`)
  must(!existsSync(join(MEDIA_DIR, 'videos', 'big.mp4')) && !existsSync(join(MEDIA_DIR, 'videos', 'big2.mp4')), '不应写出文件')
  must(partFiles().length === 0, '留下了 .part：' + partFiles())
  must((await get('/api/admin/meta')).mediaBase === '/media/', '超限后服务应正常')
  return c.json.message
})

await t('素材：上传中途断开会删掉临时文件', async () => {
  const r = await chunkedRequest('PUT', '/api/admin/media/upload?path=videos/aborted.mp4', 900 * 1024, { abortAfter: 300 * 1024 })
  must(r.aborted, '应该是客户端主动断开')
  let left = []
  for (let i = 0; i < 30; i++) {
    left = partFiles()
    if (!left.length) break
    await new Promise(res => setTimeout(res, 100))
  }
  must(!left.length, '留下了 .part：' + left)
  must(!existsSync(join(MEDIA_DIR, 'videos', 'aborted.mp4')), '不应生成文件')
  return '已清理'
})

await t('素材静态访问：200 + 类型 + 缓存头', async () => {
  const r = await req('GET', UP.url, { token: null })
  must(r.status === 200 && r.headers.get('content-type') === 'video/mp4' && r.headers.get('accept-ranges') === 'bytes', `HTTP ${r.status} ${r.headers.get('content-type')}`)
  must(Number(r.headers.get('content-length')) === 5000 && r.buf.equals(VIDEO_BYTES), '内容不一致')
  must(r.headers.get('cache-control') === 'public, max-age=300' && r.headers.get('x-content-type-options') === 'nosniff', '缓存 / nosniff 头：' + r.headers.get('cache-control'))
  const raw = await req('GET', '/media/videos/测试 目录/片段_01.jpg', { token: null })
  must(raw.status === 200 && raw.headers.get('content-type') === 'image/jpeg', '未编码的中文路径 ' + raw.status)
  return 'ok'
})

await t('素材静态访问：Range 206 / 后缀 / 416 / HEAD', async () => {
  const r = await req('GET', UP.url, { token: null, headers: { range: 'bytes=0-99' } })
  must(r.status === 206 && r.headers.get('content-range') === 'bytes 0-99/5000' && r.buf.length === 100 && r.buf.equals(VIDEO_BYTES.subarray(0, 100)), `206 ${r.status} ${r.headers.get('content-range')}`)
  const mid = await req('GET', UP.url, { token: null, headers: { range: 'bytes=4990-' } })
  must(mid.status === 206 && mid.buf.equals(VIDEO_BYTES.subarray(4990)) && mid.headers.get('content-range') === 'bytes 4990-4999/5000', '开放区间')
  const suf = await req('GET', UP.url, { token: null, headers: { range: 'bytes=-10' } })
  must(suf.status === 206 && suf.buf.equals(VIDEO_BYTES.subarray(4990)), '后缀区间')
  const over = await req('GET', UP.url, { token: null, headers: { range: 'bytes=999999-' } })
  must(over.status === 416 && over.headers.get('content-range') === 'bytes */5000', `416 ${over.status}`)
  const multi = await req('GET', UP.url, { token: null, headers: { range: 'bytes=0-1,5-6' } })
  must(multi.status === 200 && multi.buf.length === 5000, '多段 Range 应回整个文件')
  const head = await req('HEAD', UP.url, { token: null })
  must(head.status === 200 && Number(head.headers.get('content-length')) === 5000 && head.buf.length === 0, 'HEAD')
  const headR = await req('HEAD', UP.url, { token: null, headers: { range: 'bytes=10-19' } })
  must(headR.status === 206 && Number(headR.headers.get('content-length')) === 10, 'HEAD + Range')
  const post = await req('POST', UP.url, { token: null, body: {} })
  must(post.status === 405, 'POST 应 405')
  return 'ok'
})

await t('素材静态访问：目录穿越 403 / 类型白名单 / 404', async () => {
  for (const p of ['/media/..%2f..%2fserver%2findex.mjs', '/media/..%5c..%5cserver%5cindex.mjs', '/media/videos/..%2f..%2f..%2fpackage.json', '/media/%2e%2e%2f%2e%2e%2fserver/index.mjs']) {
    const r = await req('GET', p, { token: null })
    must(r.status === 403, `${p} 期望 403，实际 ${r.status}`)
    must(!r.buf.toString().includes('createServer'), '泄漏了源码')
  }
  const norm = await req('GET', '/media/../server/index.mjs', { token: null })
  must(!norm.buf.toString().includes('createServer'), '规范化后的路径泄漏了源码')
  writeFileSync(join(MEDIA_DIR, 'x.html'), '<script>alert(1)</script>')
  const html = await req('GET', '/media/x.html', { token: null })
  must(html.status === 403, '.html 不应被访问 ' + html.status)
  const miss = await req('GET', '/media/videos/nope.mp4', { token: null })
  must(miss.status === 404 && miss.json?.code === 1, '不存在应 JSON 404')
  const dir = await req('GET', '/media/videos.mp4', { token: null })
  must(dir.status === 404, '不存在')
  const badEnc = await req('GET', '/media/%E0%A4%A', { token: null })
  must(badEnc.status === 400, '非法编码应 400，实际 ' + badEnc.status)
  return 'ok'
})

await t('素材：安卓安装包 .apk 可上传，按附件下载；白名单只多了 .apk', async () => {
  const bytes = Buffer.from('PK\u0003\u0004fake-apk')
  const d = okData(await upload('app/reel.apk', bytes))
  must(d.path === 'app/reel.apk' && d.url === '/media/app/reel.apk', JSON.stringify(d))
  const r = await req('GET', '/media/app/reel.apk', { token: null })
  must(r.status === 200 && r.buf.equals(bytes), 'GET ' + r.status)
  must(r.headers.get('content-type') === 'application/vnd.android.package-archive', 'content-type ' + r.headers.get('content-type'))
  must(r.headers.get('content-disposition') === `attachment; filename="reel.apk"; filename*=UTF-8''reel.apk`, 'content-disposition ' + r.headers.get('content-disposition'))
  must(r.headers.get('cache-control') === 'no-cache' && r.headers.get('x-content-type-options') === 'nosniff', 'cache-control ' + r.headers.get('cache-control'))
  // 「我的」页用 HEAD 判断服务器上有没有安装包
  const head = await req('HEAD', '/media/app/reel.apk', { token: null })
  must(head.status === 200 && Number(head.headers.get('content-length')) === bytes.length && head.buf.length === 0, 'HEAD ' + head.status)
  // 发新版本 = 覆盖同名文件；ETag 变了，客户端不会拿到旧包
  const v2 = okData(await upload('app/reel.apk', Buffer.from('PK-v2'), { overwrite: true }))
  must(v2.path === 'app/reel.apk' && v2.size === 5, JSON.stringify(v2))
  const r2 = await req('GET', '/media/app/reel.apk', { token: null, headers: { 'if-none-match': r.headers.get('etag') } })
  must(r2.status === 200 && r2.buf.toString() === 'PK-v2', '覆盖后应返回新包 ' + r2.status)
  // 中文文件名：filename 退成 ASCII，filename* 带原名
  okData(await upload('app/安装包 v2.apk', bytes))
  const zh = await req('GET', '/media/app/' + encodeURIComponent('安装包 v2.apk'), { token: null })
  must(zh.headers.get('content-disposition') === `attachment; filename="___ v2.apk"; filename*=UTF-8''${encodeURIComponent('安装包 v2.apk')}`, zh.headers.get('content-disposition'))
  const list = await get('/api/admin/media?dir=app')
  must(list.entries.some(e => e.name === 'reel.apk' && e.type === 'other' && e.url === '/media/app/reel.apk'), JSON.stringify(list.entries))
  // 其他可执行 / 安装包格式照样拒绝：上传 400，放进文件夹的也访问不到
  for (const p of ['app/a.exe', 'app/a.aab', 'app/a.apks', 'app/a.xapk', 'app/a.ipa', 'app/a.bat', 'app/a.sh', 'app/a.jar', 'app/a.apk.part']) {
    mustFail(await upload(p, Buffer.from('x')), 'path')
  }
  writeFileSync(join(MEDIA_DIR, 'app', 'x.exe'), 'MZ')
  must((await req('GET', '/media/app/x.exe', { token: null })).status === 403, '.exe 不应被访问')
  // 只有安装包按附件下载，视频照常在页面里播放
  must(!(await req('GET', UP.url, { token: null })).headers.get('content-disposition'), '视频不应带 content-disposition')
  return 'ok'
})

await t('静态：/admin 跳转 + 前端目录穿越 403', async () => {
  for (const p of ['/admin', '/admin/']) {
    const r = await fetch(base + p, { redirect: 'manual' })
    must(r.status === 302 && r.headers.get('location') === '/admin.html', `${p} → ${r.status} ${r.headers.get('location')}`)
  }
  const r = await req('GET', '/..%2f..%2fserver%2findex.mjs', { token: null })
  must(r.status === 403 && !r.buf.toString().includes('createServer'), '期望 403，实际 ' + r.status)
  return 'ok'
})

let USED = null
await t('素材列表：被引用数（编码 / 未编码都算）', async () => {
  USED = await post('/api/admin/videos', { title: '引用素材', playbackUrl: UP.url })
  await post('/api/admin/videos', { title: '引用素材（未编码封面）', coverUrl: '/media/' + UP.path })
  const list = await get('/api/admin/media?dir=' + encodeURIComponent('videos/测试 目录'))
  const e = list.entries.find(x => x.name === '片段_01.mp4')
  must(e && e.usedBy === 2 && e.type === 'video' && e.size === 5000 && e.url === UP.url, JSON.stringify(e))
  must(list.entries.find(x => x.name === '片段_01.jpg').type === 'image', '图片类型')
  must(list.entries.every(x => !x.name.endsWith('.part') && !x.name.startsWith('.')), '不应列出临时 / 隐藏文件')
  const root = await get('/api/admin/media')
  must(root.parent === null && root.entries.findIndex(x => x.type !== 'dir') > root.entries.filter(x => x.type === 'dir').length - 1, '文件夹在前')
  const st = await get('/api/admin/stats')
  must(st.media.files >= 5 && st.media.bytes > 5000, '统计 ' + JSON.stringify(st.media))
  return `usedBy=${e.usedBy}`
})

await t('素材扫描：同名封面 + 已导入标记', async () => {
  const d = await post('/api/admin/media/scan', { dir: 'videos', recursive: true })
  const f = d.files.find(x => x.name === '片段_01.mp4')
  must(f && f.title === '片段 01' && f.coverUrl === urlOf('videos/测试 目录/片段_01.jpg') && f.imported === true && f.videoId === USED.id, JSON.stringify(f))
  const g = d.files.find(x => x.name === '片段_01 (1).mp4')
  must(g && g.imported === false && g.coverUrl === null && g.videoId === null, JSON.stringify(g))
  must(d.files.every(x => x.path.startsWith('videos/')) && !d.files.some(x => x.name.endsWith('.jpg')), '只列视频')
  const flat = await post('/api/admin/media/scan', { dir: 'videos', recursive: false })
  must(flat.files.length === 0, '不递归时 videos/ 根下没有视频')
  const all = await post('/api/admin/media/scan', {})
  must(all.files.some(x => x.path === 'new/deep/dir/a.webm'), '默认从根目录递归')
  mustFail(await req('POST', '/api/admin/media/scan', { body: { dir: 'nope' } }), 'dir')
  // 和扫描导入页一样：用扫描结果调导入接口
  const rows = d.files.filter(x => !x.imported).map(x => ({ title: x.title, playbackUrl: x.url, coverUrl: x.coverUrl, topic: String(TB.id), category: 'cn', status: '1' }))
  const imp = await importRows('videos', rows, { onDuplicate: 'skip', autoCreate: false })
  must(imp.created === rows.length && imp.failed === 0, JSON.stringify(imp.results))
  const again = await post('/api/admin/media/scan', { dir: 'videos' })
  must(again.files.every(x => x.imported), '导入后应全部标为已导入')
  return `${d.files.length} 个视频`
})

await t('素材删除：被引用需 force / 非空文件夹 / 空文件夹', async () => {
  const p = encodeURIComponent(UP.path)
  mustFail(await req('DELETE', `/api/admin/media?path=${p}`), 'usedBy', 400, /该文件被 2 个视频使用/)
  must(existsSync(join(MEDIA_DIR, ...UP.path.split('/'))), '没加 force 不应删除')
  must((await del(`/api/admin/media?path=${p}&force=1`)).ok, 'force 删除')
  must(!existsSync(join(MEDIA_DIR, ...UP.path.split('/'))), '文件还在')
  mustFail(await req('DELETE', '/api/admin/media?path=new'), 'path', 400, /不为空/)
  await del('/api/admin/media?path=' + encodeURIComponent('new/deep/dir/a.webm'))
  must((await del('/api/admin/media?path=new/deep/dir')).ok, '删除空文件夹')
  mustFail(await req('DELETE', '/api/admin/media?path=nope.mp4'), 'path', 400, /不存在/)
  mustFail(await req('DELETE', '/api/admin/media?path=' + encodeURIComponent('../package.json')), 'path')
  mustFail(await req('DELETE', '/api/admin/media?path='), 'path')
  return 'ok'
})

/* ================================================================ */
/*  请求体上限                                                       */
/* ================================================================ */

await t('请求体超过 32 MB 返回 413（声明长度 / 分块两种）', async () => {
  const big = '{"rows":[' + '"' + 'x'.repeat(33 * 1024 * 1024) + '"]}'
  const r = await req('POST', '/api/admin/videos/import', { raw: big, headers: { 'content-type': 'application/json' } })
  must(r.status === 413 && r.json?.message === '请求体过大', `期望 413，实际 ${r.status}`)
  const c = await chunkedRequest('POST', '/api/admin/videos/import', 33 * 1024 * 1024)
  must(c.status === 413, `分块期望 413，实际 ${c.status}`)
  const normal = await req('POST', '/api/admin/keywords', { body: { word: '大包之后' } })
  must(normal.status === 200, '413 之后普通请求应正常')
  return r.json.message
})

await t('普通大小的导入请求不受上限影响（约 5 MB）', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ title: '批量导入 ' + i, description: 'x'.repeat(900), playbackUrl: `/media/videos/bulk-${i}.mp4` }))
  const t0 = Date.now()
  const d = await importRows('videos', rows, {}, true)
  must(d.created === 5000 && d.failed === 0, JSON.stringify({ ...d, results: undefined }))
  return `5000 行预检 ${Date.now() - t0} ms`
})

/* ================================================================ */
/*  回归：评审发现的问题                                              */
/* ================================================================ */

await t('回归 R1-01：时长上限（导入 / 新建 / 修改）+ 启动时清零读不出来的时长', async () => {
  // 启动前在库里写坏的两条（超过 2^53 的整数、1e300 小数）：已被清零，详情 / 列表 / 导出都能正常读
  const [v449, v450] = await Promise.all([get('/api/admin/videos/449'), get('/api/admin/videos/450')])
  must(v449.durationSec === 0 && v450.durationSec === 0, `应清零：${v449.durationSec} / ${v450.durationSec}`)
  must(/异常时长清零/.test(serverLog), '启动日志应提示清零')
  await get('/api/admin/videos?sort=durationSec&order=desc')
  await get('/api/admin/videos/export')
  const before = await vCount()
  const imp = await importRows('videos', [
    { title: '订单号误映射到时长', duration: '12345678901234567' },
    { title: '超大分钟', duration: '99999999999999999:00' },
    { title: '刚好 30 天', duration: '720:00:00' },
    { title: '超过 30 天', duration: '720:00:01' },
    { title: '超大数字', duration: 1e300 }
  ], {}, true)
  must(imp.results.map(r => r.status).join() === 'error,error,created,error,error', JSON.stringify(imp.results))
  must(imp.results.filter(r => r.status === 'error').every(r => r.field === 'duration' && /时长过大/.test(r.message)), JSON.stringify(imp.results[0]))
  mustFail(await req('POST', '/api/admin/videos', { body: { title: 'x', durationSec: '99999999999999999:00' } }), 'durationSec', 400, /过大/)
  mustFail(await req('POST', '/api/admin/videos', { body: { title: 'x', durationSec: 9007199254740993 } }), 'durationSec', 400, /过大/)
  must(await vCount() === before, '被拒绝的新建不应留下数据')
  mustFail(await req('PATCH', '/api/admin/videos/1', { body: { durationSec: 1e16 } }), 'durationSec', 400, /过大/)
  must((await get('/api/admin/videos')).list.length === 20, '列表应正常')
  must((await req('GET', '/api/videos/1')).status === 200, 'App 详情应正常')
  return imp.results[0].message
})

await t('回归 R1-02：先定路由、先鉴权，再读请求体', async () => {
  const r = await req('POST', '/api/admin/videos/import', { token: null, raw: 'x'.repeat(5 * 1024 * 1024), headers: { 'content-type': 'application/json' } })
  must(r.status === 401, `未登录的大请求体应直接 401（不先解析），实际 ${r.status} ${r.json?.message}`)
  const nope = await req('POST', '/api/admin/nope', { token: null, raw: 'x'.repeat(1024 * 1024) })
  must(nope.status === 404, '不存在的路由 404，实际 ' + nope.status)
  const wrong = await req('PATCH', '/api/admin/meta', { raw: 'not json' })
  must(wrong.status === 405, '方法不对应 405（不先解析请求体），实际 ' + wrong.status)
  must((await req('POST', '/api/admin/keywords', { body: { word: '鉴权之后' } })).status === 200, '之后的正常请求应 200')
  return 'ok'
})

await t('回归 R1-02 / R1-05：卡住的请求体、上传会被断开，不留临时文件（短超时实例）', () => withShortTimeouts(async port => {
  const auth = 'Authorization: Bearer ' + adminToken
  // 1) 已登录，但 JSON 请求体发一半就停：1.5 秒后 408 并断开
  const a = rawHttp(port, ['POST /api/admin/keywords HTTP/1.1', 'Host: x', auth, 'Content-Type: application/json', 'Content-Length: 1000'], '{"word":')
  // 2) 未登录、声明 32 MB：不等请求体，马上 401；之后客户端不再发数据，空闲 3 秒被断开
  const b = rawHttp(port, ['POST /api/admin/videos/import HTTP/1.1', 'Host: x', 'Content-Type: application/json', 'Content-Length: ' + 32 * 1024 * 1024], 'x'.repeat(64 * 1024))
  // 3) 上传发一点就停：1.5 秒收不到数据就中止，删掉 .part
  const c = rawHttp(port, [`PUT /api/admin/media/upload?path=${encodeURIComponent('stall/x.mp4')} HTTP/1.1`, 'Host: x', auth, 'Content-Length: 100000'], 'y'.repeat(1000))
  const [ra, rb, rc] = await Promise.all([a, b, c].map(x => Promise.race([x.closed, sleep(12000).then(() => null)])))
  for (const x of [a, b, c]) x.socket.destroy()
  must(ra && ra.status === 408 && ra.ms >= 1000 && ra.ms < 6000, 'JSON 请求体卡住：' + JSON.stringify(ra && { status: ra.status, ms: ra.ms }))
  must(rb && rb.status === 401 && rb.firstAt < 1500 && rb.ms < 10000, '未登录大请求体：' + JSON.stringify(rb && { status: rb.status, firstAt: rb.firstAt, ms: rb.ms }))
  must(rc && rc.ms < 6000, '上传卡住应被断开：' + JSON.stringify(rc && { status: rc.status, ms: rc.ms }))
  let left = []
  for (let i = 0; i < 30; i++) { left = partFiles(); if (!left.length) break; await sleep(100) }
  must(!left.length && !existsSync(join(MEDIA_DIR, 'stall', 'x.mp4')), '留下了临时文件：' + left)
  if (existsSync(join(MEDIA_DIR, 'stall'))) must((await del('/api/admin/media?path=stall')).ok, '空文件夹应能删除')
  return `408 用时 ${ra.ms} ms；401 用时 ${rb.firstAt} ms、${rb.ms} ms 后断开；上传 ${rc.ms} ms 后断开`
}))

await t('回归 R1-05：上传一开始就断开（发一点就 FIN）不会留下打开的 .part', async () => {
  for (let i = 0; i < 6; i++) {
    const x = rawHttp(PORT, [`PUT /api/admin/media/upload?path=${encodeURIComponent(`abortA/x${i}.mp4`)} HTTP/1.1`, 'Host: x', 'Authorization: Bearer ' + adminToken, 'Content-Length: 100000'], 'z'.repeat(500))
    x.socket.end()
    await Promise.race([x.closed, sleep(3000)])
    x.socket.destroy()
  }
  let left = []
  for (let i = 0; i < 30; i++) { left = partFiles(); if (!left.length) break; await sleep(100) }
  must(!left.length, '留下了 .part：' + left)
  if (existsSync(join(MEDIA_DIR, 'abortA'))) must((await del('/api/admin/media?path=abortA')).ok, '文件夹应能删除')
  return '6 次都已清理'
})

await t('回归 R1-03：同时上传同名文件（不覆盖）各得到不同的名字、内容都在', async () => {
  for (const n of [2, 2, 2, 6]) {
    const dir = `race${n}-${Math.random().toString(36).slice(2, 6)}`
    const bodies = Array.from({ length: n }, (_, i) => Buffer.from(`BODY-${i}-`.repeat(2000 + i)))
    const rs = await Promise.all(bodies.map(b => upload(`${dir}/same.mp4`, b)))
    const paths = rs.map(r => okData(r).path)
    must(new Set(paths).size === n, `${n} 个上传只得到 ${new Set(paths).size} 个不同的名字：${paths}`)
    paths.forEach((p, i) => must(readFileSync(join(MEDIA_DIR, ...p.split('/'))).equals(bodies[i]), `${p} 的内容不是第 ${i + 1} 个上传的`))
  }
  return 'ok'
})

await t('回归 R1-04：文件正被读取（播放连接暂停不读）时也能覆盖', async () => {
  mkdirSync(join(MEDIA_DIR, 'hold'), { recursive: true })
  writeFileSync(join(MEDIA_DIR, 'hold', 'big.mp4'), Buffer.alloc(12 * 1024 * 1024, 7))
  const reader = rawHttp(PORT, ['GET /media/hold/big.mp4 HTTP/1.1', 'Host: x'])
  for (let i = 0; i < 100 && !reader.socket.bytesRead; i++) await sleep(20)
  reader.socket.pause()                       // 像暂停的 <video>：不再读，服务端的读句柄一直开着
  await sleep(200)
  const d = okData(await upload('hold/big.mp4', Buffer.from('new-content'), { overwrite: true }))
  must(d.path === 'hold/big.mp4' && d.size === 11, JSON.stringify(d))
  must((await req('GET', '/media/hold/big.mp4', { token: null })).buf.toString() === 'new-content', '覆盖后应返回新内容')
  reader.socket.destroy()
  let left = []
  for (let i = 0; i < 60; i++) { left = partFiles(); if (!left.length) break; await sleep(200) }
  must(!left.length, '挪开的旧文件没删掉：' + left)
  return 'ok'
})

await t('回归 R2-08：图片 no-cache + ETag（覆盖后马上能看到新图）', async () => {
  okData(await upload('covers/v-cache.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])))
  const a = await req('GET', '/media/covers/v-cache.jpg', { token: null })
  const etag = a.headers.get('etag')
  must(a.headers.get('cache-control') === 'no-cache' && etag && a.headers.get('last-modified'), '图片缓存头：' + a.headers.get('cache-control'))
  const same = await req('GET', '/media/covers/v-cache.jpg', { token: null, headers: { 'if-none-match': etag } })
  must(same.status === 304 && same.buf.length === 0, '没变应 304，实际 ' + same.status)
  const multi = await req('GET', '/media/covers/v-cache.jpg', { token: null, headers: { 'if-none-match': `"x", ${etag}` } })
  must(multi.status === 304, 'If-None-Match 带多个值也应认出来，实际 ' + multi.status)
  const ims = await req('GET', '/media/covers/v-cache.jpg', { token: null, headers: { 'if-modified-since': a.headers.get('last-modified') } })
  must(ims.status === 304, 'If-Modified-Since 没变应 304，实际 ' + ims.status)
  okData(await upload('covers/v-cache.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 9]), { overwrite: true }))
  const b = await req('GET', '/media/covers/v-cache.jpg', { token: null, headers: { 'if-none-match': etag } })
  must(b.status === 200 && b.buf.length === 9 && b.headers.get('etag') !== etag, '覆盖后应返回新图，实际 ' + b.status)
  return 'ok'
})

await t('回归 R1-06：列表排序走索引、统计在写操作后立即更新、新建数据的占位图轻量', async () => {
  const idx = dbq("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_videos_pubtime', 'idx_videos_created')").map(r => r.name).sort()
  must(idx.join() === 'idx_videos_created,idx_videos_pubtime', '缺少索引：' + idx)
  for (const col of ['published_at', 'created_at']) {
    const plan = dbq(`EXPLAIN QUERY PLAN SELECT v.id, v.title FROM videos v LEFT JOIN topics t ON t.id = v.topic_id
                      ORDER BY v.${col} DESC, v.id DESC LIMIT 20`).map(r => r.detail).join(' | ')
    must(!/TEMP B-TREE/.test(plan), `${col} 排序没走索引：${plan}`)
  }
  const s1 = await get('/api/admin/stats')
  await post('/api/admin/keywords', { word: '统计缓存' })
  const s2 = await get('/api/admin/stats')
  must(s2.keywords.total === s1.keywords.total + 1, `写操作后统计应立即更新：${s1.keywords.total} → ${s2.keywords.total}`)
  const maxLen = sql => dbq(sql)[0].n || 0
  const v = maxLen('SELECT MAX(LENGTH(cover_fallback)) n FROM videos WHERE id > 458')
  const tc = maxLen('SELECT MAX(LENGTH(fallback)) n FROM topic_covers WHERE topic_id > 11')
  const pm = maxLen('SELECT MAX(LENGTH(fallback)) n FROM post_media WHERE post_id > 4')
  must(v > 0 && v <= 1500 && tc <= 1500 && pm <= 1500, `后台新建的占位图应 ≤ 1.5 KB：视频 ${v} / 专题 ${tc} / 帖子 ${pm}`)
  return `占位图最大：视频 ${v}、专题 ${tc}、帖子 ${pm} 字节`
})

await t('回归 R1-07 / R3-01：专题引用按 ID → 名称 → 标识，导出再导入不换专题', async () => {
  const news = await post('/api/admin/topics', { name: '新闻频道', slug: 'dailyx' })
  const daily = await post('/api/admin/topics', { name: 'Dailyx' })                      // 名称 = 别的专题的标识（大小写不同）
  const anime = await post('/api/admin/topics', { name: 'Anime' })                       // 种子专题「动漫新番」的标识是 anime
  const num = await post('/api/admin/topics', { name: '2024', slug: 'y2024' })           // 纯数字名称
  const dupA = await post('/api/admin/topics', { name: '同名专题' })
  const dupB = await post('/api/admin/topics', { name: '同名专题', slug: String(news.id) }) // 同名 + 标识是别的专题的 ID → 只能用 ID
  for (const tp of [daily, anime, num, dupA, dupB]) await post('/api/admin/videos', { title: '专题引用 ' + tp.name, publicId: 'TREF-' + tp.id, topicId: tp.id })
  // 新数据按名称（精确）优先，名称对不上再按标识（不区分大小写）
  const imp = await importRows('videos', [
    { title: 'n1', publicId: 'TREF-N1', topic: 'Anime' }, { title: 'n2', publicId: 'TREF-N2', topic: 'anime' },
    { title: 'n3', publicId: 'TREF-N3', topic: 'Dailyx' }, { title: 'n4', publicId: 'TREF-N4', topic: 'DAILYX' }
  ], { autoCreate: false })
  const got = await Promise.all(imp.results.map(r => get(`/api/admin/videos/${r.id}`).then(v => v.topicId)))
  must(got.join() === [anime.id, 5, daily.id, news.id].join(), `按名称优先：${got}`)
  // 导出写法：读得回同一个专题的名称 → 标识 → ID
  const ex = (await get('/api/admin/videos/export?q=TREF-&sort=id&order=asc')).rows
  const cell = pid => ex.find(r => r.publicId === pid).topic
  const want = { [daily.id]: 'Dailyx', [anime.id]: 'Anime', [num.id]: '2024', [dupA.id]: '同名专题', [dupB.id]: String(dupB.id) }
  for (const [id, w] of Object.entries(want)) must(cell('TREF-' + id) === w, `专题 #${id} 导出为「${cell('TREF-' + id)}」，应为「${w}」`)
  const before = JSON.stringify((await get('/api/admin/videos?q=TREF-&pageSize=50&sort=id&order=asc')).list.map(v => [v.id, v.topicId]))
  const re = await importRows('videos', ex, { onDuplicate: 'update' })
  must(re.updated === ex.length && re.failed === 0, JSON.stringify(re.results.filter(r => r.status !== 'updated')))
  const after = JSON.stringify((await get('/api/admin/videos?q=TREF-&pageSize=50&sort=id&order=asc')).list.map(v => [v.id, v.topicId]))
  must(after === before, `再导入后专题变了：${before} → ${after}`)
  return `${ex.length} 行专题不变`
})

await t('回归 R1-08：批量动作名是 toString / __proto__ 这类继承来的键 → 400', async () => {
  const before = (await get('/api/admin/videos/3')).status
  for (const [type, action] of [['creators', 'toString'], ['keywords', 'constructor'], ['videos', '__proto__'], ['posts', 'valueOf'], ['topics', 'hasOwnProperty'], ['creators', '__proto__'], ['keywords', 'toString']]) {
    mustFail(await req('POST', `/api/admin/${type}/batch`, { body: { ids: [3], action } }), 'action', 400, /不支持的批量操作/)
  }
  must((await get('/api/admin/videos/3')).status === before, '视频状态不应变')
  return 'ok'
})

await t('回归 R1-09：单值字段传对象 / 数组 → 400，不再存成 [object Object]', async () => {
  mustFail(await req('POST', '/api/admin/videos', { body: { title: { a: 1 } } }), 'title', 400, /格式不正确/)
  mustFail(await req('POST', '/api/admin/videos', { body: { title: 'x', publishedAt: ['2026-01-01'] } }), 'publishedAt')
  mustFail(await req('POST', '/api/admin/videos', { body: { title: 'x', topicId: [2] } }), 'topicId')
  mustFail(await req('POST', '/api/admin/posts', { body: { creatorId: 1, text: 'x', mainImage: { u: 1 } } }), 'mainImage')
  const d = await importRows('videos', [
    { title: { a: 1 } }, { title: 'x', publishedAt: ['2026-01-01'] }, { id: [1], title: 'y' }, { title: 'z', topic: ['2'] }, { title: 'w', publicId: ['VID-1001'] }
  ], {}, true)
  must(d.failed === 5 && d.results.map(r => r.field).join() === 'title,publishedAt,id,topic,publicId', JSON.stringify(d.results))
  mustFail(await req('PUT', '/api/admin/sections/1/items', { body: { batches: [[true]] } }), 'batches')
  mustFail(await req('PUT', '/api/admin/sections/1/items', { body: { batches: [[[3], [4]]] } }), 'batches')
  mustFail(await req('POST', '/api/admin/videos/batch', { body: { ids: [[5]], action: 'publish' } }), 'ids')
  mustFail(await req('POST', '/api/admin/videos/batch', { body: { ids: [true], action: 'publish' } }), 'ids')
  mustFail(await req('POST', '/api/admin/videos/import', { body: { rows: [], options: { defaultStatus: ['1'] } } }), 'defaultStatus')
  return 'ok'
})

await t('回归 R3-05：编号不存在就是新视频，不再退到播放地址去改别的视频', async () => {
  const orig = await post('/api/admin/videos', { title: '原视频', publicId: 'ORIG-R305', playbackUrl: '/media/videos/shared-r305.mp4' })
  const d = await importRows('videos', [
    { publicId: 'NEW-R305A', title: '新视频甲', playbackUrl: '/media/videos/shared-r305.mp4' },
    { publicId: 'NEW-R305B', title: '新视频乙', playbackUrl: '/media/videos/shared-r305.mp4' }
  ], { onDuplicate: 'update' })
  must(d.created === 2 && d.updated === 0, JSON.stringify(d.results))
  const o = await get(`/api/admin/videos/${orig.id}`)
  must(o.publicId === 'ORIG-R305' && o.title === '原视频', '原视频被改了：' + JSON.stringify([o.publicId, o.title]))
  // 只填了播放地址的行仍按播放地址查重；「已更新」写明按哪个键匹配到的
  const u = await importRows('videos', [{ title: '按地址更新', playbackUrl: '/media/videos/shared-r305.mp4' }], { onDuplicate: 'update' })
  must(u.updated === 1 && u.results[0].id === orig.id && /按播放地址匹配到 ID/.test(u.results[0].message), JSON.stringify(u.results))
  return u.results[0].message
})

await t('回归 R3-09：编码 / 未编码 / 带 ?v= 算同一个文件（扫描已导入、导入查重、被引用数一致）', async () => {
  mkdirSync(join(MEDIA_DIR, 'videos', '已有'), { recursive: true })
  writeFileSync(join(MEDIA_DIR, 'videos', '已有', 'old 1.webm'), Buffer.from('webm-data'))
  const v = await post('/api/admin/videos', { title: '手填未编码地址', playbackUrl: '/media/videos/已有/old 1.webm' })
  await post('/api/admin/videos', { title: '带缓存参数的封面', coverUrl: '/media/videos/%E5%B7%B2%E6%9C%89/old%201.webm?v=123' })
  const scan = await post('/api/admin/media/scan', { dir: 'videos/已有' })
  const f = scan.files.find(x => x.name === 'old 1.webm')
  must(f && f.imported && f.videoId === v.id, JSON.stringify(f))
  // 和扫描导入页一样发编码后的地址：应跳过，不重复建
  const d = await importRows('videos', [{ title: f.title, playbackUrl: f.url }], { onDuplicate: 'skip', autoCreate: false })
  must(d.skipped === 1 && d.created === 0 && d.results[0].id === v.id, JSON.stringify(d.results))
  const q = await importRows('videos', [{ title: 'x', playbackUrl: f.url + '?v=9' }], {}, true)
  must(q.skipped === 1, '带 ?v= 的站内地址也算同一个文件 ' + JSON.stringify(q.results))
  const list = await get('/api/admin/media?dir=' + encodeURIComponent('videos/已有'))
  must(list.entries.find(e => e.name === 'old 1.webm')?.usedBy === 2, '被引用数应为 2：' + JSON.stringify(list.entries))
  return f.url
})

await t('回归 R3-13：中文长日期、ISO 带时区的发布时间', async () => {
  const d = await importRows('videos', [
    { title: '中文日期', publishedAt: '2026年10月10日' },
    { title: '中文日期时间', publishedAt: '2026年10月10日 14:30' },
    { title: 'ISO Z', publishedAt: '2026-10-10T14:30:00Z' },
    { title: 'ISO 偏移', publishedAt: '2026-10-10T14:30:00+08:00' },
    { title: '中文时分', publishedAt: '2026年1月2日 9时5分' },
    { title: '不存在的日期', publishedAt: '2026年2月30日' }
  ])
  must(d.created === 5 && d.results[5].field === 'publishedAt', JSON.stringify(d.results))
  const ts = await Promise.all(d.results.slice(0, 5).map(r => get(`/api/admin/videos/${r.id}`).then(v => v.publishedAt)))
  const want = [localTs(2026, 9, 10), localTs(2026, 9, 10, 14, 30), Date.UTC(2026, 9, 10, 14, 30) / 1000, Date.UTC(2026, 9, 10, 6, 30) / 1000, localTs(2026, 0, 2, 9, 5)]
  must(ts.join() === want.join(), `${ts} ≠ ${want}`)
  return 'ok'
})

await t('回归 导入重发保护：同一 importId + chunk 重发返回上次结果（replayed），不重复写库', async () => {
  const before = await vCount()
  const rows = [{ title: '幂等一', publicId: 'IDEM-1' }, { title: '幂等二' }]
  const first = await importRows('videos', rows, { importId: 'test-run_1', chunk: 0 })
  must(first.created === 2 && !first.replayed, JSON.stringify(first))
  const again = await importRows('videos', rows, { importId: 'test-run_1', chunk: 0 })
  must(again.replayed === true && JSON.stringify({ ...again, replayed: undefined }) === JSON.stringify(first), '重发应返回同样的结果 + replayed')
  must(await vCount() === before + 2, '重发不应再建数据')
  const next = await importRows('videos', [{ title: '幂等三' }], { importId: 'test-run_1', chunk: '1' })
  must(next.created === 1 && !next.replayed, '下一块正常导入')
  const other = await importRows('posts', [{ creator: '@aijc', text: '幂等帖子' }], { importId: 'test-run_1', chunk: 0 })
  must(other.created === 1 && !other.replayed, '不同类型不共用')
  const dry1 = await importRows('videos', [{ title: '预检' }], { importId: 'test-run_2', chunk: 0 }, true)
  const dry2 = await importRows('videos', [{ title: '预检' }], { importId: 'test-run_2', chunk: 0 }, true)
  must(!dry1.replayed && !dry2.replayed, '预检不缓存')
  const real = await importRows('videos', [{ title: '预检之后真导入' }], { importId: 'test-run_2', chunk: 0 })
  must(real.created === 1 && !real.replayed, '预检之后同一个键的真导入应真正执行')
  await importRows('videos', [{ title: '只有 importId' }], { importId: 'test-run_3' })
  const noChunk = await importRows('videos', [{ title: '只有 importId' }], { importId: 'test-run_3' })
  must(!noChunk.replayed && noChunk.created === 1, '缺 chunk 时不缓存')
  mustFail(await req('POST', '/api/admin/videos/import', { body: { rows: [], options: { importId: 'bad id!', chunk: 0 } } }), 'importId')
  mustFail(await req('POST', '/api/admin/videos/import', { body: { rows: [], options: { importId: 'x'.repeat(65), chunk: 0 } } }), 'importId')
  mustFail(await req('POST', '/api/admin/videos/import', { body: { rows: [], options: { importId: 'ok', chunk: -1 } } }), 'chunk')
  must(await vCount() === before + 6, `总共应新增 6 条，实际 ${await vCount() - before}`)
  return 'ok'
})

/* ================================================================ */

roDb?.close()
await shutdown()

const pad = (s, n) => String(s).padEnd(n)
console.log('')
for (const r of results) console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${pad(r.name, 40)} ${r.note}`)
const bad = results.filter(r => !r.ok)
console.log(`\n  ${results.length - bad.length}/${results.length} 通过` + (bad.length ? `，失败 ${bad.length} 项` : '，全部通过'))
if (bad.length && /error|Error/.test(serverLog)) console.log('\n服务端日志：\n' + serverLog.slice(-3000))
process.exit(bad.length ? 1 : 0)
