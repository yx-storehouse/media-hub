/*
 * 接口冒烟测试：把 server/index.mjs 的每个路由都打一遍，逐条报 PASS / FAIL。
 *
 *   node server/test-api.mjs                     # 自动起服务、跑完自动关
 *   node server/test-api.mjs --base http://x:3000  # 测一个已经在跑的服务
 *
 * 退出码 0 表示全部通过。
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { rmSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { request as httpRequest } from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const argBase = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : null
const PORT = 3178
/* 用独立的库，避免污染开发数据 */
/* 素材目录也用临时的，测试不碰项目里的 media/ */
const TEST_MEDIA = join(tmpdir(), `reel-media-${PORT}-${process.pid}`)
/* 打包目录也用临时的假文件：测静态文件的缓存头 / 压缩，不依赖有没有 npm run build */
const TEST_DIST = join(tmpdir(), `reel-dist-${PORT}-${process.pid}`)
const DIST_JS = 'assets/app-Ab12Cd34.js'
const DIST_FILES = {
  'index.html': '<!doctype html><title>Reel</title>' + '<!-- 入口页 -->'.repeat(200),
  'admin.html': '<!doctype html><title>Reel 管理后台</title>' + '<!-- 后台 -->'.repeat(200),
  [DIST_JS]: 'export const hello = "world";\n'.repeat(300),
  'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>'
}
const TEST_DB = join(here, 'db', 'api-test.db')
const base = argBase || `http://127.0.0.1:${PORT}`

let child = null
if (!argBase) {
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if (existsSync(f)) rmSync(f)
  // 建库 + 建一个管理员（写接口需要登录）
  child = spawn(process.execPath, [join(here, 'db', 'seed.mjs'), '--reset'], { env: { ...process.env, DB_PATH: TEST_DB }, stdio: 'ignore' })
  await new Promise(r => child.on('exit', r))
  child = spawn(process.execPath, [join(here, 'create-admin.mjs'), 'admin', 'admin12345'], { env: { ...process.env, DB_PATH: TEST_DB }, stdio: 'ignore' })
  await new Promise(r => child.on('exit', r))

  mkdirSync(join(TEST_DIST, 'assets'), { recursive: true })
  for (const [f, body] of Object.entries(DIST_FILES)) writeFileSync(join(TEST_DIST, f), body)
  child = spawn(process.execPath, [join(here, 'index.mjs')], { env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB, MEDIA_DIR: TEST_MEDIA, DIST_DIR: TEST_DIST }, stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 1400))
}

/* 登录令牌：写接口需要，signIn() 之后填充 */
let authToken = null

const results = []

/* 写操作需要登录：先用管理员账号拿一个令牌，后续请求都会带上 */
async function signIn() {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: 'admin', password: 'admin12345' })
  })
  const json = await res.json()
  if (json.code === 0) authToken = json.data.token
  return json.code === 0
}

/* 没登录成功的话，后面的写操作用例会全红，所以先确认一下 */
if (!await signIn() && !argBase) {
  console.error('无法登录测试账号，请检查 server/create-admin.mjs 是否成功执行')
  process.exit(1)
}

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(authToken ? { authorization: 'Bearer ' + authToken } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!text) return { status: res.status, json: null }
  try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, json: null, raw: text.slice(0, 120) } }
}

/** 期望 code=0，并可以用 check 校验 data 的形状 */
async function t(name, method, path, check, body) {
  try {
    const { status, json, raw } = await call(method, path, body)
    if (!json) throw new Error(`响应不是 JSON (HTTP ${status})${raw ? ' ' + raw : ''}`)
    if (json.code !== 0) throw new Error(`code=${json.code} ${json.message || ''}`)
    const msg = typeof check === 'function' ? check(json.data) : check
    if (msg === false) throw new Error('数据校验未通过')
    results.push({ name, ok: true, note: typeof msg === 'string' ? msg : '' })
  } catch (e) {
    results.push({ name, ok: false, note: e.message })
  }
}

const isArr = (a, min = 1) => Array.isArray(a) && a.length >= min
const hasKeys = (o, ...keys) => o && keys.every(k => o[k] !== undefined)

/** 服务器本地时区 daysAgo 天前的 0 点（秒）；测试与服务端同机同时区，与「最新」页分天口径一致 */
const dayStart = (daysAgo = 0) => {
  const d = new Date()
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime() / 1000)
}

/** 自定义用例：fn 返回说明文字，抛错即失败 */
async function check(name, fn) {
  try {
    const note = await fn()
    results.push({ name, ok: true, note: typeof note === 'string' ? note : '' })
  } catch (e) {
    results.push({ name, ok: false, note: e.message })
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg) }
/** 取 data，code 不为 0 时抛错 */
const data = async (method, path, body) => {
  const { status, json } = await call(method, path, body)
  if (!json || json.code !== 0) throw new Error(`${method} ${path} → HTTP ${status} ${json?.message || ''}`)
  return json.data
}

/* ---- 基础 ---- */
await t('健康检查', 'GET', '/api/health', d => d.ok === true ? 'ok' : false)
await t('首页分类 Tab', 'GET', '/api/home/tabs', d => isArr(d, 6) ? `${d.length} 个：${d.map(x => x.label).join(',')}` : false)
await t('底部导航', 'GET', '/api/main/tabs', d => isArr(d, 6) ? `${d.length} 个` : false)

/* ---- 首页 ---- */
await t('推荐分区', 'GET', '/api/home/recommend', d => isArr(d, 6) ? `${d.length} 个分区，首个「${d[0].title}」${d[0].batches} 个批次` : false)
await t('推荐分区带关联专题', 'GET', '/api/home/recommend', d => d.every(s => 'topicId' in s && s.batches > 0) && d.some(s => Number.isInteger(s.topicId)) ? d.map(s => `${s.id}→${s.topicId}`).join(' ') : false)
await t('分区视频(第一批)', 'GET', '/api/home/section/1/videos?size=5&batch=0', d => isArr(d, 5) && d[0].cover?.src ? `${d.length} 条，首条「${d[0].title}」` : false)
await t('分区视频(换一批)', 'GET', '/api/home/section/1/videos?size=5&batch=1', d => isArr(d, 5) ? `首条「${d[0].title}」` : false)
await t('最新筛选项', 'GET', '/api/home/latest/filters', d => isArr(d.dates, 7) && isArr(d.regions, 4) && d.regions[0].code === 'all' ? `${d.dates.length} 个日期 / ${d.regions.length} 个地区（${d.regions.map(r => r.label).join(',')}）` : false)
await t('最新视频', 'GET', '/api/home/latest/videos?date=0&region=0&limit=6', d => isArr(d, 6) ? `${d.length} 条` : false)
await t('最新按本地日期分天', 'GET', '/api/home/latest/videos?date=1&region=0&limit=50', d => isArr(d) && d.every(v => v.publishedAt >= dayStart(1) && v.publishedAt < dayStart(0)) ? `昨天 ${d.length} 条都在本地 0 点之间` : false)
await t('分类筛选项', 'GET', '/api/category/ai/filters', d => isArr(d, 4) ? d.map(x => x.label).join(',') : false)
await t('分类视频', 'GET', '/api/category/ai/videos?filter=1&limit=6', d => isArr(d, 6) ? `${d.length} 条` : false)

/* ---- 搜索 ---- */
await t('热门搜索词', 'GET', '/api/search/hot', d => isArr(d, 8) ? d.map(x => x.word).join(',') : false)
await t('换一批搜索词', 'GET', '/api/search/hot?page=1', d => isArr(d, 8) ? `${d.length} 个` : false)
await check('热门搜索词都搜得到东西（搜不到的词不列）', async () => {
  const words = new Set()
  for (const page of [0, 1, 2, 3]) for (const w of await data('GET', '/api/search/hot?page=' + page)) words.add(w.word)
  must(!words.has('古风舞蹈'), '「古风舞蹈」搜不到内容，不应列出')
  // 不带令牌搜，不往管理员的近期搜索里记
  const anon = async path => (await (await fetch(base + path)).json()).data
  for (const w of words) {
    const q = encodeURIComponent(w)
    const [v, p] = await Promise.all([anon('/api/search?q=' + q + '&limit=1'), anon('/api/search/posts?q=' + q + '&limit=1')])
    must(v.total + p.total > 0, `「${w}」搜不到内容却列出来了`)
  }
  return `${words.size} 个词都有结果`
})
await t('热门创作者', 'GET', '/api/search/creators', d => isArr(d, 5) && d[0].avatar ? d.map(x => x.name).join(',') : false)
await t('中文搜索(4字, FTS)', 'GET', '/api/search?q=' + encodeURIComponent('治愈日常'), d => d.total > 0 && isArr(d.list) ? `命中 ${d.total} 条，首条「${d.list[0].title}」` : false)
await t('中文搜索(2字, LIKE)', 'GET', '/api/search?q=' + encodeURIComponent('露营'), d => d.total > 0 ? `命中 ${d.total} 条` : false)
await t('英文/数字搜索', 'GET', '/api/search?q=' + encodeURIComponent('Vlog'), d => Array.isArray(d.list) ? `命中 ${d.total} 条` : false)

/* ---- 专题 / 片库 ---- */
await t('专题详情', 'GET', '/api/topic/2', d => hasKeys(d, 'name', 'total', 'covers', 'sorts') && d.covers.length === 4 ? `「${d.name}」${d.total} 条视频，${d.covers.length} 张头图` : false)
await t('视频详情', 'GET', '/api/videos/1', d => hasKeys(d, 'id', 'title', 'dur', 'len', 'cover', 'tags', 'playCount', 'favCount', 'rank') && 'src' in d ? `「${d.title}」热榜 No.${d.rank}，${d.tags.length} 个标签` : false)
await tFail('视频详情(不存在)', 'GET', '/api/videos/99999999', '不存在')
await t('相似推荐', 'GET', '/api/videos/1/related?limit=6', d => isArr(d, 6) && d.every(v => v.id !== 1) ? `${d.length} 条，首条「${d[0].title}」` : false)
await t('相似推荐(换一批)', 'GET', '/api/videos/1/related?limit=6&batch=1', d => isArr(d, 6) ? `首条「${d[0].title}」` : false)
await check('专题不存在返回 400', async () => {
  const { status, json } = await call('GET', '/api/topic/99999999')
  must(status === 400 && /专题不存在或已下架/.test(json?.message), `HTTP ${status} ${json?.message}`)
  const v = await call('GET', '/api/topic/99999999/videos')
  must(v.status === 400, '专题视频 HTTP ' + v.status)
  return json.message
})
await t('专题视频', 'GET', '/api/topic/2/videos?sort=1&limit=8', d => isArr(d.list, 8) && typeof d.total === 'number' ? `${d.list.length}/${d.total} 条` : false)
await t('片库', 'GET', '/api/library', d => isArr(d, 10) && d[0].count > 0 ? `${d.length} 个分类，首个「${d[0].name}」${d[0].count} 条` : false)
await check('片库卡片用专题第一张头图', async () => {
  const lib = await data('GET', '/api/library')
  const t2 = await data('GET', '/api/topic/2')
  const card = lib.find(c => c.id === 2)
  must(card && card.cover?.src === t2.covers[0].src && card.cover.fallback, JSON.stringify(card?.cover?.src))
  return '与专题页头图一致'
})

/* ---- 短视频推荐流（SHORTS）：GET /api/shorts?seed=&offset=&limit=&exclude= ---- */
/* 取一页；带 token 时按那个用户，不带就是未登录 */
async function shortsPage(qs, token = null) {
  const res = await fetch(base + '/api/shorts?' + qs, { headers: token ? { authorization: 'Bearer ' + token } : {} })
  const json = await res.json()
  if (json.code !== 0) throw new Error(`/api/shorts?${qs} → HTTP ${res.status} ${json.message || ''}`)
  return json.data
}
const shortIds = d => d.list.map(v => v.id)
await t('短视频流（结构）', 'GET', '/api/shorts', d => typeof d.seed === 'string' && d.seed && d.hasMore === true && isArr(d.list, 10) && d.list.length === 10 &&
  d.list.every(v => 'src' in v && v.len > 0 && v.likes === v.likeCount && v.favs === v.favCount && v.creator?.id && v.creator.name && v.creator.avatar && 'handle' in v.creator)
  ? `默认 10 条，seed=${d.seed}，首条「${d.list[0].title}」@${d.list[0].creator.name}` : false)
await check('短视频：同一 seed 顺序固定，换 seed 顺序不同', async () => {
  const a1 = shortIds(await shortsPage('seed=same-a&limit=30'))
  const a2 = shortIds(await shortsPage('seed=same-a&limit=30'))
  const b = shortIds(await shortsPage('seed=same-b&limit=30'))
  must(a1.join() === a2.join(), '同一个 seed 两次结果不同')
  must(a1.join() !== b.join(), '不同 seed 结果一样')
  must(new Set(a1).size === 30, '一页里有重复')
  const firsts = new Set()
  for (const s of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) firsts.add((await shortsPage(`seed=${s}&limit=1`)).list[0].id)
  must(firsts.size >= 2, '6 个 seed 的第一条全一样')
  return `seed a / b 前 30 条不同；6 个 seed 的第一条有 ${firsts.size} 种`
})
await check('短视频：加入短视频的优先（前 10 条明显偏多）', async () => {
  const curated = new Set((await data('GET', '/api/admin/videos?short=1&status=1&pageSize=100')).list.map(v => v.id))
  const pool = (await data('GET', '/api/admin/stats')).videos.published
  must(curated.size >= 3, '测试库里短视频不到 3 条')
  const counts = []
  for (const s of ['c1', 'c2', 'c3', 'c4', 'c5']) counts.push(shortIds(await shortsPage(`seed=${s}&limit=10`)).filter(id => curated.has(id)).length)
  const expect = Math.min(3, curated.size)
  must(counts.every(n => n >= expect), `前 10 条里的短视频数 ${counts.join('/')}，应都 ≥ ${expect}`)
  return `${curated.size} / ${pool} 条是短视频，5 个 seed 前 10 条各有 ${counts.join('/')} 条`
})
await check('短视频：exclude 的不出现在第一页', async () => {
  const shown = shortIds(await shortsPage('seed=ex-a&limit=10'))
  const d = await shortsPage(`seed=ex-b&limit=10&exclude=${shown.join(',')},abc,-3,0`)
  const hit = shortIds(d).filter(id => shown.includes(id))
  must(d.list.length === 10 && !hit.length, '第一页里还有 exclude 的：' + hit.join(','))
  // 对照：换个 seed 不带 exclude（同一 seed 会命中按 用户+seed 缓存的顺序，exclude 只在第一次排序时起作用）
  const control = shortIds(await shortsPage('seed=ex-c&limit=10'))
  return `排除 ${shown.length} 条后第一页一条不重；不排除时（另一个 seed）重合 ${control.filter(id => shown.includes(id)).length} 条`
})
await check('短视频：连翻 3 页不重复，与一次取 30 条一致', async () => {
  const pages = []
  for (const off of [0, 10, 20]) pages.push(...shortIds(await shortsPage(`seed=page-a&limit=10&offset=${off}`)))
  const whole = shortIds(await shortsPage('seed=page-a&limit=30'))
  const other = shortIds(await shortsPage('seed=page-b&limit=30'))
  must(new Set(pages).size === 30, '3 页里有重复')
  must(pages.join() === whole.join(), '分页结果和一次取 30 条不一致')
  must(other.join() !== whole.join(), '不同 seed 顺序一样')
  return '30 条无重复，分页 = 整取'
})
await check('短视频：翻过整个视频池还一直有内容', async () => {
  const pool = (await data('GET', '/api/admin/stats')).videos.published
  const seam = await shortsPage(`seed=end-a&limit=20&offset=${pool - 10}`)
  const ids = shortIds(seam)
  must(ids.length === 20 && seam.hasMore === true, `接缝处 ${ids.length} 条`)
  must(ids.every((id, i) => i === 0 || id !== ids[i - 1]), '接缝处连着出现同一条')
  must(new Set(ids.slice(5, 15)).size === 10, '接缝前后 10 条里有重复')
  const far = await shortsPage(`seed=end-a&limit=10&offset=${pool * 3 + 7}`)
  must(far.list.length === 10 && far.hasMore === true, '第 4 轮没有内容')
  const r1 = shortIds(await shortsPage(`seed=end-a&limit=30&offset=${pool}`))
  const r0 = shortIds(await shortsPage('seed=end-a&limit=30'))
  must(r1.join() !== r0.join(), '第二轮和第一轮顺序一样')
  return `池子 ${pool} 条；offset ${pool - 10}~${pool + 9} 跨轮接上、offset ${pool * 3 + 7} 仍有 10 条，第二轮重新洗牌`
})
await check('短视频：limit / offset 取值范围', async () => {
  const n = async qs => (await shortsPage('seed=lim&' + qs)).list.length
  const r = { big: await n('limit=500'), one: await n('limit=1'), bad: await n('limit=abc'), neg: await n('limit=-3'), def: await n('') }
  must(r.big === 50 && r.one === 1 && r.bad === 10 && r.neg === 1 && r.def === 10, JSON.stringify(r))
  const a = shortIds(await shortsPage('seed=lim&limit=5&offset=-8'))
  const b = shortIds(await shortsPage('seed=lim&limit=5&offset=0'))
  must(a.join() === b.join(), '负 offset 应按 0')
  return 'limit 500→50、1→1、abc→10、-3→1、缺省 10；offset 负数按 0'
})
/* 下面两项直接改测试库（看过的时间、造 2 万条视频），--base 模式跳过 */
const feedDbChecks = [
  ['短视频：登录用户 3 天内看过的往后排（10 天前看过的只轻罚）', async () => {
    await data('POST', '/api/admin/users', { uid: 'feeduser', password: 'feeduser123', nickname: '推荐测试' })
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: 'feeduser', password: 'feeduser123' }) }).then(r => r.json())
    const tok = login.data.token
    const top = shortIds(await shortsPage('seed=watch-0&limit=8', tok))
    for (const id of top) {
      const r = await fetch(base + '/api/me/history', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify({ videoId: id, progressSec: 5 }) }).then(r => r.json())
      must(r.code === 0, '记录观看失败 ' + r.message)
    }
    // 其中一条改成 10 天前看的：只轻罚，应排在 3 天内看过的前面
    const w = new DatabaseSync(TEST_DB)
    const uid = w.prepare('SELECT id FROM users WHERE uid = ?').get('feeduser').id
    w.prepare('UPDATE watch_history SET watched_at = ? WHERE user_id = ? AND video_id = ?').run(Math.floor(Date.now() / 1000) - 10 * 86400, uid, top[0])
    w.close()
    const anon = shortIds(await shortsPage('seed=watch-1&limit=10'))
    const order = []
    for (let off = 0; off < 1000 && !top.every(id => order.includes(id)); off += 50) order.push(...shortIds(await shortsPage(`seed=watch-1&limit=50&offset=${off}`, tok)))
    const pos = id => order.indexOf(id) + 1
    const recent = top.slice(1)
    must(!order.slice(0, 20).some(id => recent.includes(id)), '3 天内看过的出现在前 20 条：' + recent.filter(id => order.slice(0, 20).includes(id)).join(','))
    must(recent.every(id => pos(id) > pos(top[0])), `10 天前看过的 #${top[0]}（第 ${pos(top[0])} 条）应排在 3 天内看过的（${recent.map(pos).join('/')}）前面`)
    const anonHit = anon.filter(id => recent.includes(id)).length
    must(anonHit >= 3, `同一 seed 未登录时前 10 条里只有 ${anonHit} 条是这些视频，用例不成立`)
    return `看过 8 条：未登录时前 10 条里有 ${anonHit} 条；登录后 3 天内看过的排在第 ${recent.map(pos).join('/')} 条，10 天前看过的在第 ${pos(top[0])} 条`
  }],
  ['短视频：2 万条视频时排一次序 < 300ms', async () => {
    const w = new DatabaseSync(TEST_DB)
    const c = w.prepare('SELECT MIN(id) lo, COUNT(*) n FROM creators').get()
    const tp = w.prepare('SELECT MIN(id) lo, COUNT(*) n FROM topics').get()
    const now = Math.floor(Date.now() / 1000)
    const t0 = Date.now()
    w.exec('BEGIN')
    w.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
               INSERT INTO videos(public_id, title, creator_id, topic_id, kind, duration_sec, tags, play_count, like_count, fav_count, status, published_at, created_at)
               SELECT 'PERF-' || i, 'perf ' || i, ? + i % ?, ? + i % ?, 1, 30 + i % 600, '[]', (i * 7919) % 100000, (i * 31) % 900, (i * 17) % 400, 1, ? - (i * 97) % 5184000, ?
               FROM n`).run(c.lo, c.n, tp.lo, tp.n, now, now)
    w.exec('COMMIT')
    const insertMs = Date.now() - t0
    try {
      const pool = (await data('GET', '/api/admin/stats')).videos.published
      const times = []
      let d
      for (const s of ['perf-1', 'perf-2']) {
        const t1 = performance.now()
        d = await shortsPage(`seed=${s}&limit=10`)
        times.push(Math.round(performance.now() - t1))
      }
      const t2 = performance.now()
      await shortsPage('seed=perf-1&limit=10&offset=10')
      const pageMs = Math.round(performance.now() - t2)
      must(d.list.length === 10, '只返回了 ' + d.list.length + ' 条')
      must(Math.max(...times) < 300, `排序用了 ${times.join(' / ')} ms`)
      return `${pool} 条候选：新 seed 排序 ${times.join(' / ')} ms，翻页（命中缓存）${pageMs} ms；造数据 ${insertMs} ms`
    } finally {
      w.exec("DELETE FROM videos WHERE public_id LIKE 'PERF-%'")
      w.close()
    }
  }]
]
for (const [name, fn] of feedDbChecks) {
  if (argBase) results.push({ name, ok: true, note: '跳过（--base 模式不改数据）' })
  else await check(name, fn)
}

/* ---- 社区 ---- */
await t('社区 tab', 'GET', '/api/community/tabs', d => isArr(d, 4) ? d.join(',') : false)
await t('社区列表', 'GET', '/api/community/posts?tab=0', d => isArr(d, 4) && d[0].media?.thumbs?.length === 3 ? `${d.length} 条，首条「${d[0].name}」` : false)
await t('社区帖子类型与认证', 'GET', '/api/community/posts?tab=0', d => {
  const kinds = new Set(d.map(p => p.kind))
  const ok = [...kinds].every(k => ['image', 'video', 'doc'].includes(k)) &&
    d.some(p => p.verified) && d.some(p => !p.verified) &&
    d.filter(p => p.kind === 'doc').every(p => p.dur === null) &&
    d.filter(p => p.videoId).every(p => /^\d+:\d\d$/.test(p.dur))
  return ok ? `类型 ${[...kinds].join('/')}，认证 ${d.filter(p => p.verified).length}/${d.length}` : false
})
await t('社区·热门', 'GET', '/api/community/posts?tab=1', d => Array.isArray(d) ? `${d.length} 条` : false)
await t('社区·收藏', 'GET', '/api/community/posts?tab=3', d => Array.isArray(d) ? `${d.length} 条` : false)

/* ---- 帖子详情 ---- */
const POST_KEYS = 'id,title,content,kind,author,following,tags,images,video,read,fav,faved,publishedAt,time,next'
const isCover = c => !!c && typeof c === 'object' && 'src' in c && 'fallback' in c && !!(c.src || c.fallback)
const DUR_RE = /^(\d\d:\d\d|\d+:\d\d:\d\d)$/
const json = v => JSON.stringify(v)
/** 不带令牌（未登录）请求 */
const anonCall = async (method, path) => {
  const res = await fetch(base + path, { method })
  return { status: res.status, json: await res.json().catch(() => null) }
}
/** 图片规则：视频帖 + 关联视频已上架 + 有主图 → 主图是视频封面、images 只放配图；否则 images = [主图, ...配图] */
const expectMedia = p => (p.kind === 'video' && p.videoId != null && p.media.main
  ? { cover: p.media.main, images: p.media.thumbs.filter(Boolean) }
  : { cover: null, images: [p.media.main, ...p.media.thumbs].filter(Boolean) })

await check('帖子详情：结构与列表一致', async () => {
  const list = await data('GET', '/api/community/posts?tab=0&limit=50')
  must(list.length >= 4, '社区帖子不足 4 条')
  for (const lp of list) {
    const d = await data('GET', `/api/community/posts/${lp.id}`)
    const tag = `#${lp.id}`
    must(Object.keys(d).join() === POST_KEYS, `${tag} 字段 ${Object.keys(d).join()}`)
    must(d.id === lp.id && d.title === lp.text && typeof d.content === 'string' && d.kind === lp.kind, `${tag} 基本字段`)
    must(d.author.id > 0 && d.author.name === lp.name && d.author.handle === lp.handle && d.author.verified === lp.verified && isCover(d.author.avatar), `${tag} author ${json(d.author.name)}`)
    must(typeof d.following === 'boolean' && typeof d.faved === 'boolean', `${tag} following / faved 应是布尔`)
    must(json(d.tags) === json(lp.tags) && d.tags.every(x => !x.startsWith('#')), `${tag} tags ${json(d.tags)}`)
    must(d.images.every(isCover), `${tag} images 里有空图`)
    must(d.read === lp.read && d.fav === lp.fav && d.publishedAt === lp.publishedAt && typeof d.time === 'string' && d.time, `${tag} 计数 / 时间`)
    if (lp.videoId != null) {
      must(d.video && d.video.id === lp.videoId && typeof d.video.title === 'string' && isCover(d.video.cover) && DUR_RE.test(d.video.dur) && Number.isInteger(d.video.len), `${tag} video ${json(d.video)}`)
      // 视频块拼图：1～2 张、都是有效的图、互不重复；有主图时第一张就是主图
      const fr = d.video.frames
      must(Array.isArray(fr) && fr.length >= 1 && fr.length <= 2 && fr.every(isCover) && new Set(fr.map(f => f.src || f.fallback)).size === fr.length,
        `${tag} frames ${json(fr?.map(f => f.src))}`)
      if (lp.media.main) must(json(fr[0]) === json(lp.media.main), `${tag} frames[0] 应是帖子主图`)
    } else must(d.video === null, `${tag} 没有已上架的关联视频，video 应为 null`)
  }
  return `${list.length} 条，字段 ${POST_KEYS.split(',').length} 个`
})

await check('帖子详情：图片规则（视频帖主图当封面 / 其余主图并入 images）', async () => {
  const list = await data('GET', '/api/community/posts?tab=0&limit=50')
  let asCover = 0, merged = 0, maxImages = 0
  for (const lp of list) {
    const d = await data('GET', `/api/community/posts/${lp.id}`)
    const exp = expectMedia(lp)
    must(json(d.images) === json(exp.images), `#${lp.id} images ${d.images.length} 张，期望 ${exp.images.length} 张`)
    if (exp.cover) { must(json(d.video.cover) === json(exp.cover), `#${lp.id} 视频封面应是帖子主图`); asCover++ } else merged++
    maxImages = Math.max(maxImages, d.images.length)
  }
  must(asCover > 0 && merged > 0, `两种情况都要覆盖：主图当封面 ${asCover}，并入 images ${merged}`)
  must(maxImages >= 4, '至少要有一条帖子 ≥ 4 张图，实际最多 ' + maxImages)
  return `主图当封面 ${asCover} 条，并入 images ${merged} 条，最多 ${maxImages} 张图`
})

await check('帖子详情：种子帖子有多段正文', async () => {
  const list = await data('GET', '/api/community/posts?tab=0&limit=50')
  const bodies = await Promise.all(list.map(p => data('GET', `/api/community/posts/${p.id}`).then(d => d.content)))
  must(bodies.every(c => c.split('\n\n').length >= 2 && c === c.trim()), '正文 ' + json(bodies.map(c => c.slice(0, 12))))
  return bodies.map(c => c.split('\n\n').length + ' 段').join(' / ')
})

await check('帖子详情：下一篇按「最新」顺序', async () => {
  const list = await data('GET', '/api/community/posts?tab=0&limit=50')
  for (let i = 0; i < list.length; i++) {
    const d = await data('GET', `/api/community/posts/${list[i].id}`)
    const exp = list[i + 1]
    if (!exp) {
      if (list.length < 50) must(d.next === null, `最后一篇 #${list[i].id} 的 next 应为 null：${json(d.next)}`)
      continue
    }
    must(d.next && d.next.id === exp.id && d.next.title === exp.text, `#${list[i].id} 的下一篇是 ${d.next?.id}，期望 ${exp.id}`)
    const thumb = exp.media.main || exp.media.thumbs.find(Boolean) || null
    must(json(d.next.thumb) === json(thumb), `#${exp.id} 的缩略图应是主图（没有就第一张配图）`)
  }
  return list.map(p => '#' + p.id).join(' → ') + ' → null'
})

await check('帖子详情：不存在返回 400', async () => {
  for (const path of ['/api/community/posts/99999999', '/api/community/posts/99999999999999999999999']) {
    const { status, json: j } = await call('GET', path)
    must(status === 400 && j?.message === '帖子不存在或已下架', `${path} → HTTP ${status} ${j?.message}`)
  }
  const v = await call('POST', '/api/community/posts/99999999/view')
  must(v.status === 400 && v.json?.message === '帖子不存在或已下架', `view → HTTP ${v.status} ${v.json?.message}`)
  return '400 · 帖子不存在或已下架'
})

await check('帖子阅读数 +1（未登录也算，详情 GET 不算）', async () => {
  const id = (await data('GET', '/api/community/posts?tab=0'))[0].id
  const before = (await data('GET', `/api/community/posts/${id}`)).read
  const r1 = await data('POST', `/api/community/posts/${id}/view`)
  must(Object.keys(r1).join() === 'read' && r1.read === before + 1, '登录 ' + json(r1))
  const r2 = await anonCall('POST', `/api/community/posts/${id}/view`)
  must(r2.status === 200 && r2.json?.data?.read === before + 2, '未登录 ' + json(r2.json))
  const d = await data('GET', `/api/community/posts/${id}`)
  const lp = (await data('GET', '/api/community/posts?tab=0')).find(p => p.id === id)
  must(d.read === before + 2 && lp.read === before + 2, `详情 ${d.read} / 列表 ${lp.read}，期望 ${before + 2}`)
  return `${before} → ${d.read}`
})

await check('帖子详情：关注 / 收藏状态按当前用户', async () => {
  const id = (await data('GET', '/api/community/posts?tab=0'))[0].id
  const aid = (await data('GET', `/api/community/posts/${id}`)).author.id
  await data('POST', `/api/creators/${aid}/follow`, { on: false })
  await data('POST', `/api/community/posts/${id}/fav`, { on: false })
  const d0 = await data('GET', `/api/community/posts/${id}`)
  must(d0.following === false && d0.faved === false, '起始应为未关注、未收藏')
  must((await data('POST', `/api/creators/${aid}/follow`, { on: true })).active === true, '关注失败')
  must((await data('POST', `/api/community/posts/${id}/fav`, { on: true })).active === true, '收藏失败')
  const d1 = await data('GET', `/api/community/posts/${id}`)
  must(d1.following === true && d1.faved === true && d1.fav === d0.fav + 1, '登录后 ' + json({ following: d1.following, faved: d1.faved, fav: d1.fav }))
  const anon = await anonCall('GET', `/api/community/posts/${id}`)
  const a = anon.json?.data
  must(anon.status === 200 && a.following === false && a.faved === false && a.fav === d1.fav, '未登录 ' + json(a && { following: a.following, faved: a.faved }))
  await data('POST', `/api/creators/${aid}/follow`, { on: false })
  await data('POST', `/api/community/posts/${id}/fav`, { on: false })
  const d2 = await data('GET', `/api/community/posts/${id}`)
  must(d2.following === false && d2.faved === false && d2.fav === d0.fav, '取消后应复原')
  return '登录后 true，未登录 false，取消后复原'
})

/* ---- 直播 / 同城 ---- */
await t('直播 tab', 'GET', '/api/live/tabs', d => isArr(d, 5) ? d.join(',') : false)
await t('直播列表', 'GET', '/api/live?tab=0', d => isArr(d, 6) && d[0].cover ? `${d.length} 个，首个「${d[0].title}」${d[0].viewers}` : false)
await t('直播分类', 'GET', '/api/live?tab=2', d => Array.isArray(d) ? `才艺 ${d.length} 个` : false)
await t('同城筛选项', 'GET', '/api/nearby/filters', d => isArr(d, 6) ? d.map(x => x.label).join(',') : false)
await t('同城列表', 'GET', '/api/nearby?filter=0', d => isArr(d, 6) && d[0].distance && d[0].price ? `${d.length} 条，首个「${d[0].title.slice(0, 8)}」${d[0].distance} ${d[0].price}` : false)
await t('同城·美食', 'GET', '/api/nearby?filter=4', d => Array.isArray(d) ? `${d.length} 条` : false)

/* ---- 我的 ---- */
await t('个人信息', 'GET', '/api/me', d => hasKeys(d, 'name', 'uid', 'stats', 'counts') && d.stats.map(s => s.key).join() === 'history,favs,follows' && d.stats.every(s => s.to) ? `${d.name}，${d.stats.map(s => s.label + '=' + s.value).join(' ')}` : false)
await t('观看历史', 'GET', '/api/me/history', d => Array.isArray(d.list) && typeof d.total === 'number' ? `${d.list.length}/${d.total} 条` : false)
const anyVideo = (await call('GET', '/api/home/latest/videos?limit=1')).json?.data?.[0]
await t('记录观看', 'POST', '/api/me/history', d => d.added === true ? `视频 #${d.videoId} 记录成功` : false, { videoId: anyVideo.id, progressSec: 30 })
await t('记录后历史', 'GET', '/api/me/history', d => isArr(d.list, 1) && d.list[0].id === anyVideo.id && d.list[0].progressSec === 30 ? `${d.total} 条，最新「${d.list[0].title}」看到 ${d.list[0].progressSec} 秒` : false)
await t('观看数已累加', 'GET', '/api/home/latest/videos?limit=1', d => d[0].playCount > 0 ? `播放数 ${d[0].playCount}` : false)

/* ---- 互动（成对调用，验证触发器计数） ---- */
/* 与初始状态无关：先记录基线，切换一次后断言计数确实动了一位，再切回来 */
const topicBefore = (await call('GET', '/api/topic/3')).json?.data?.favs
const t1 = (await call('POST', '/api/topics/3/fav')).json?.data
await t('收藏专题(切换)', 'GET', '/api/topic/3', d => d.favs === topicBefore + (t1.active ? 1 : -1) ? `${topicBefore} -> ${d.favs}（active=${t1.active}）` : false)
const t2 = (await call('POST', '/api/topics/3/fav')).json?.data
await t('取消后计数复原', 'GET', '/api/topic/3', d => d.favs === topicBefore && t2.active === !t1.active ? `回到 ${d.favs}` : false)

const postBefore = (await call('GET', '/api/community/posts?tab=0')).json?.data?.[0]?.fav
await t('收藏帖子', 'POST', '/api/community/posts/1/fav', d => d.active === true ? '已收藏' : false)
await t('帖子收藏计数 +1', 'GET', '/api/community/posts?tab=0', d => d[0].fav === postBefore + 1 ? `${postBefore} -> ${d[0].fav}` : false)
await t('取消收藏帖子', 'POST', '/api/community/posts/1/fav', d => d.active === false ? '已取消' : false)

/* ---- 播放页：指定状态的写入 + 赞 / 不喜欢互斥 + 进度上报不计播放数 ---- */
const vid = anyVideo.id
await call('POST', `/api/videos/${vid}/like`, { on: false })
await call('POST', `/api/videos/${vid}/dislike`, { on: false })
const likesBase = (await call('GET', `/api/videos/${vid}`)).json?.data?.likeCount
await t('点赞(指定 on)', 'POST', `/api/videos/${vid}/like`, d => d.active === true && d.liked === true && d.likeCount === likesBase + 1 ? `${likesBase} -> ${d.likeCount}` : false, { on: true })
await t('重复点赞不变', 'POST', `/api/videos/${vid}/like`, d => d.active === true && d.likeCount === likesBase + 1 ? '幂等' : false, { on: true })
await t('不喜欢清掉赞', 'POST', `/api/videos/${vid}/dislike`, d => d.disliked === true && d.liked === false && d.likeCount === likesBase ? `赞数回到 ${d.likeCount}` : false, { on: true })
await t('详情回填状态', 'GET', `/api/videos/${vid}`, d => d.disliked === true && d.liked === false ? 'disliked=true' : false)
await t('取消不喜欢', 'POST', `/api/videos/${vid}/dislike`, d => d.active === false && d.disliked === false ? '已取消' : false, { on: false })
const playsBase = (await call('GET', `/api/videos/${vid}`)).json?.data?.playCount
await t('进度上报不计播放', 'POST', '/api/me/history', d => d.added === true ? '已记录' : false, { videoId: vid, progressSec: 42, progressOnly: true })
await t('播放数未变', 'GET', `/api/videos/${vid}`, d => d.playCount === playsBase ? `仍为 ${d.playCount}` : false)

/* ---- 管理后台改动在 App 里的效果：会写管理数据，只在自带的测试库上跑（--base 时记为跳过） ---- */
const adminChecks = []
const adminCheck = (name, fn) => adminChecks.push([name, fn])

adminCheck('无地区视频归入「其他」', async () => {
  const regions = (await data('GET', '/api/home/latest/filters')).regions
  const otherIdx = regions.findIndex(r => r.code === 'other')
  must(otherIdx >= 0, '没有 other 地区')
  const v = await data('POST', '/api/admin/videos', { title: '无地区测试视频', status: 1 })
  must(v.region == null, 'region 应为空 ' + v.region)
  const after = (await data('GET', '/api/home/latest/filters')).regions
  must(after[otherIdx].count === regions[otherIdx].count + 1, `其他计数 ${regions[otherIdx].count} -> ${after[otherIdx].count}`)
  const inOther = await data('GET', `/api/home/latest/videos?date=0&region=${otherIdx}&limit=50`)
  must(inOther.some(x => x.id === v.id), '「其他」里没有')
  for (let i = 0; i < regions.length; i++) {
    if (i === otherIdx || regions[i].code === 'all') continue
    must(!(await data('GET', `/api/home/latest/videos?date=0&region=${i}&limit=50`)).some(x => x.id === v.id), '不该出现在 ' + regions[i].label)
  }
  return `#${v.id} 在「其他」，计数 +1`
})

adminCheck('本地 0 点前后分在今天 / 昨天', async () => {
  const v = await data('POST', '/api/admin/videos', { title: '零点测试视频', status: 1, region: 'jk' })
  const jk = (await data('GET', '/api/home/latest/filters')).regions.findIndex(r => r.code === 'jk')
  const has = async date => (await data('GET', `/api/home/latest/videos?date=${date}&region=${jk}&limit=50`)).some(x => x.id === v.id)
  await data('PATCH', `/api/admin/videos/${v.id}`, { publishedAt: dayStart(0) })
  must(await has(0) && !(await has(1)), '0 点整应算今天')
  await data('PATCH', `/api/admin/videos/${v.id}`, { publishedAt: dayStart(0) - 1 })
  must(!(await has(0)) && await has(1), '0 点前 1 秒应算昨天')
  const dates = (await data('GET', '/api/home/latest/filters')).dates
  const d2 = new Date(dayStart(2) * 1000)
  must(dates[2].label === `${d2.getMonth() + 1}/${d2.getDate()}`, '日期标签 ' + dates[2].label)
  return '边界按本地时间'
})

adminCheck('分区：空批次不计数、专题下架后不给链接', async () => {
  const pub = (await data('GET', '/api/home/latest/videos?date=0&region=0&limit=2')).map(v => v.id)
  const draft = await data('POST', '/api/admin/videos', { title: '草稿视频', status: 0 })
  const topic = await data('POST', '/api/admin/topics', { name: '测试下架专题' })
  const sec = await data('POST', '/api/admin/sections', { title: '空批次分区', topicId: topic.id, cardSize: 2 })
  must(!(await data('GET', '/api/home/recommend')).some(s => s.id === sec.id), '没有内容的分区不该下发')
  await data('PUT', `/api/admin/sections/${sec.id}/items`, { batches: [[pub[0]], [draft.id], [pub[1]]] })
  let rec = (await data('GET', '/api/home/recommend')).find(s => s.id === sec.id)
  must(rec && rec.batches === 2 && rec.topicId === topic.id, 'recommend ' + JSON.stringify(rec))
  const b1 = await data('GET', `/api/home/section/${sec.id}/videos?size=2&batch=1`)
  must(b1.map(v => v.id).join() === String(pub[1]), '第 2 批应跳过全是草稿的那批：' + b1.map(v => v.id))
  await data('POST', '/api/admin/topics/batch', { ids: [topic.id], action: 'unpublish' })
  rec = (await data('GET', '/api/home/recommend')).find(s => s.id === sec.id)
  must(rec && rec.topicId === null, '下架专题后 topicId 应为 null：' + rec?.topicId)
  const { status } = await call('GET', `/api/topic/${topic.id}`)
  must(status === 400, '下架专题 HTTP ' + status)
  await data('DELETE', `/api/admin/sections/${sec.id}`)
  return '批次 3 → 2，下架后不给链接'
})

adminCheck('图文 / 视频帖：类型、认证、关联视频', async () => {
  const off = await data('POST', '/api/admin/videos', { title: '下架的关联视频', status: 2 })
  const creators = (await data('GET', '/api/admin/creators?pageSize=100')).list
  const cid = h => creators.find(c => c.handle === h).id
  const img = await data('POST', '/api/admin/posts', { creatorId: cid('trip'), text: '图文帖测试', mediaKind: 0, mainImage: '/media/covers/x.jpg', images: ['/media/covers/y.jpg'] })
  const vid = await data('POST', '/api/admin/posts', { creatorId: cid('aijc'), text: '视频帖测试', mediaKind: 1, videoId: off.id, mainImage: '/media/covers/x.jpg' })
  const list = await data('GET', '/api/community/posts?tab=0&limit=50')
  const pi = list.find(p => p.id === img.id), pv = list.find(p => p.id === vid.id)
  must(pi && pi.kind === 'image' && pi.verified === false && pi.dur === null && pi.more === 0, '图文帖 ' + JSON.stringify(pi && { kind: pi.kind, verified: pi.verified, dur: pi.dur }))
  must(pv && pv.kind === 'video' && pv.verified === true && pv.videoId === null && pv.dur === null, '关联下架视频时不给 videoId ' + JSON.stringify(pv && { videoId: pv.videoId, dur: pv.dur }))
  await data('PATCH', `/api/admin/videos/${off.id}`, { status: 1 })
  const pv2 = (await data('GET', '/api/community/posts?tab=0&limit=50')).find(p => p.id === vid.id)
  must(pv2.videoId === off.id && /^\d+:\d\d$/.test(pv2.dur), '视频上架后应带 videoId 和时长 ' + JSON.stringify({ videoId: pv2.videoId, dur: pv2.dur }))
  return 'image / video，认证按创作者'
})

adminCheck('帖子详情：图片规则 / 正文 / 时长写法', async () => {
  const creators = (await data('GET', '/api/admin/creators?pageSize=100')).list
  const cid = creators.find(c => c.handle === 'trip').id
  const v1 = await data('POST', '/api/admin/videos', { title: '详情测试视频', status: 1, durationSec: 462, coverUrl: '/media/covers/v1.jpg' })
  const v2 = await data('POST', '/api/admin/videos', { title: '一小时的视频', status: 1, durationSec: 3725, coverUrl: '/media/covers/v2.jpg' })
  const off = await data('POST', '/api/admin/videos', { title: '下架视频', status: 2, coverUrl: '/media/covers/off.jpg' })
  const mk = body => data('POST', '/api/admin/posts', { creatorId: cid, text: '详情测试', ...body })
  const srcs = d => d.images.map(c => c.src).join()
  const made = []
  try {
    // 视频帖 + 主图：主图当视频封面，images 只有配图
    const a = await mk({ mediaKind: 1, videoId: v1.id, mainImage: '/m/a.jpg', images: ['/m/a1.jpg', '/m/a2.jpg'], content: '第一段\n\n第二段' })
    made.push(a.id)
    let d = await data('GET', `/api/community/posts/${a.id}`)
    must(d.kind === 'video' && d.video.cover.src === '/m/a.jpg' && srcs(d) === '/m/a1.jpg,/m/a2.jpg', '视频帖 ' + json({ cover: d.video.cover.src, images: srcs(d) }))
    must(d.video.id === v1.id && d.video.title === '详情测试视频' && d.video.dur === '07:42' && d.video.len === 462, 'video ' + json(d.video))
    must(d.title === '详情测试' && d.content === '第一段\n\n第二段', '标题 / 正文 ' + json([d.title, d.content]))
    // 图文帖 + 关联视频：主图并入 images，视频封面用视频自己的封面；超过 1 小时写成 h:mm:ss
    const b = await mk({ mediaKind: 0, videoId: v2.id, mainImage: '/m/b.jpg', images: ['/m/b1.jpg'] })
    made.push(b.id)
    d = await data('GET', `/api/community/posts/${b.id}`)
    must(d.kind === 'image' && srcs(d) === '/m/b.jpg,/m/b1.jpg' && d.video.cover.src === '/media/covers/v2.jpg', '图文帖 ' + json({ images: srcs(d), cover: d.video.cover.src }))
    must(d.video.dur === '1:02:05' && d.content === '', '时长 ' + d.video.dur)
    // 视频帖没有主图：images = 配图，封面用视频的
    const c = await mk({ mediaKind: 1, videoId: v1.id, images: ['/m/c1.jpg', '/m/c2.jpg'] })
    made.push(c.id)
    d = await data('GET', `/api/community/posts/${c.id}`)
    must(srcs(d) === '/m/c1.jpg,/m/c2.jpg' && d.video.cover.src === '/media/covers/v1.jpg', '无主图视频帖 ' + json({ images: srcs(d), cover: d.video.cover.src }))
    // 关联视频已下架：video 为 null，主图回到 images
    const e = await mk({ mediaKind: 1, videoId: off.id, mainImage: '/m/e.jpg', images: ['/m/e1.jpg'] })
    made.push(e.id)
    d = await data('GET', `/api/community/posts/${e.id}`)
    must(d.video === null && srcs(d) === '/m/e.jpg,/m/e1.jpg', '下架视频 ' + json({ video: d.video, images: srcs(d) }))
    // 后台改正文，详情马上变
    await data('PATCH', `/api/admin/posts/${e.id}`, { content: '后台改的正文\r\n第二行  ' })
    must((await data('GET', `/api/community/posts/${e.id}`)).content === '后台改的正文\n第二行', '改正文后')
    return '主图当封面 / 并入 images / 下架视频 / 07:42 · 1:02:05'
  } finally {
    for (const id of made) await data('DELETE', `/api/admin/posts/${id}`).catch(() => {})
  }
})

adminCheck('帖子详情：草稿 / 下架返回 400，同一时间按 id 排下一篇', async () => {
  const creators = (await data('GET', '/api/admin/creators?pageSize=100')).list
  const cid = creators.find(c => c.handle === 'craft').id
  // 比所有帖子都早的一个时间点，这几条就是「最新」列表的最后几条
  const T = dayStart(30) + 3600
  const mk = body => data('POST', '/api/admin/posts', { creatorId: cid, publishedAt: T, ...body })
  const made = []
  const get400 = async (path, method = 'GET') => {
    const { status, json: j } = await call(method, path)
    return status === 400 && j?.message === '帖子不存在或已下架'
  }
  try {
    const old = await mk({ text: '更早的一篇', publishedAt: T - 10, images: ['/m/old1.jpg', '/m/old2.jpg'] })
    const pa = await mk({ text: '同一时间 A' })
    const draft = await mk({ text: '同一时间草稿', status: 0 })
    const pb = await mk({ text: '同一时间 B' })
    made.push(old.id, pa.id, draft.id, pb.id)
    must(old.id < pa.id && pa.id < draft.id && draft.id < pb.id, 'id 顺序')
    must(await get400(`/api/community/posts/${draft.id}`), '草稿详情应 400')
    must(await get400(`/api/community/posts/${draft.id}/view`, 'POST'), '草稿 view 应 400')
    must((await data('GET', `/api/admin/posts/${draft.id}`)).readCount === 0, '草稿的阅读数不该变')
    let d = await data('GET', `/api/community/posts/${pb.id}`)
    must(d.next?.id === pa.id && d.next.title === '同一时间 A' && d.next.thumb === null, 'B 的下一篇应是 A（跳过草稿，没图时 thumb 为 null）：' + json(d.next))
    d = await data('GET', `/api/community/posts/${pa.id}`)
    must(d.next?.id === old.id && d.next.thumb?.src === '/m/old1.jpg', 'A 的下一篇应是更早的一篇，缩略图取第一张配图：' + json(d.next))
    must((await data('GET', `/api/community/posts/${old.id}`)).next === null, '最早的一篇 next 应为 null')
    await data('PATCH', `/api/admin/posts/${pa.id}`, { status: 2 })
    must(await get400(`/api/community/posts/${pa.id}`), '下架后详情应 400')
    must((await data('GET', `/api/community/posts/${pb.id}`)).next?.id === old.id, 'A 下架后 B 的下一篇应跳过 A')
    await data('PATCH', `/api/admin/posts/${pa.id}`, { status: 1 })
    must((await data('GET', `/api/community/posts/${pa.id}`)).id === pa.id, '重新上架后能打开')
    return `#${pb.id} → #${pa.id} → #${old.id} → null，草稿 / 下架 400`
  } finally {
    for (const id of made) await data('DELETE', `/api/admin/posts/${id}`).catch(() => {})
  }
})

/*
 * ---- 创作者主页（GET /api/creators/:id、/videos、/posts）----
 * 每个用例自己建创作者 / 视频 / 帖子，结束时删掉（删创作者会连带删他的帖子）。
 */
const PROFILE_KEYS = 'id,name,handle,avatar,verified,official,bio,followers,videoCount,postCount,mediaCount,lastActiveAt,lastActive,following,banner'
/** 建一个只给这个用例用的创作者，fn 结束后连同他的视频、帖子一起删掉 */
async function withCreator(body, fn) {
  const c = await data('POST', '/api/admin/creators', body)
  const videos = []
  const mkVideo = async v => { const r = await data('POST', '/api/admin/videos', { creatorId: c.id, status: 1, ...v }); videos.push(r.id); return r }
  const mkPost = p => data('POST', '/api/admin/posts', { creatorId: c.id, mediaKind: 0, ...p })
  try {
    return await fn(c, { mkVideo, mkPost })
  } finally {
    for (const id of videos) await data('DELETE', `/api/admin/videos/${id}`).catch(() => {})
    await data('DELETE', `/api/admin/creators/${c.id}`).catch(() => {})
  }
}
const expect400 = async (path, method = 'GET', body) => {
  const { status, json: j } = await call(method, path, body)
  must(status === 400 && j?.message === '创作者不存在', `${method} ${path} → HTTP ${status} ${j?.message}`)
}

adminCheck('创作者主页：结构、计数只算已发布、最后更新、头图顺序和上限', async () => {
  const T = Math.floor(Date.now() / 1000)
  return withCreator({ name: '主页测试', handle: 'profile_t1', bio: '一句简介', isVerified: true }, async (c, { mkVideo, mkPost }) => {
    await mkVideo({ title: '主页视频 A', publishedAt: T - 7200, coverUrl: '/m/va.jpg' })
    await mkVideo({ title: '主页视频 B', publishedAt: T - 5 * 3600, coverUrl: '/m/vb.jpg' })
    await mkVideo({ title: '主页视频 C', publishedAt: T - 3 * 86400, coverUrl: '/m/vc.jpg' })
    await mkVideo({ title: '草稿视频', status: 0, publishedAt: T, coverUrl: '/m/draft.jpg' })
    await mkVideo({ title: '下架视频', status: 2, publishedAt: T, coverUrl: '/m/off.jpg' })
    await mkPost({ text: '有主图的帖子', mediaKind: 1, mainImage: '/m/p1.jpg', images: ['/m/p1a.jpg'], publishedAt: T - 1800 })
    await mkPost({ text: '只有配图的帖子', images: ['/m/p2a.jpg', '/m/p2b.jpg'], publishedAt: T - 5400 })
    await mkPost({ text: '文档帖（配图是文档页）', mediaKind: 2, images: ['/m/doc.jpg'], publishedAt: T - 600 })
    await mkPost({ text: '草稿帖子', status: 0, mainImage: '/m/pdraft.jpg', publishedAt: T })
    const d = await data('GET', `/api/creators/${c.id}`)
    must(Object.keys(d).join() === PROFILE_KEYS, '字段 ' + Object.keys(d).join())
    must(d.id === c.id && d.name === '主页测试' && d.handle === 'profile_t1' && d.verified === true && d.official === false && d.bio === '一句简介', '基本字段 ' + json(d).slice(0, 160))
    must(isCover(d.avatar), '头像应有占位图')
    must(d.videoCount === 3 && d.postCount === 3, `计数只算已发布：视频 ${d.videoCount} / 帖子 ${d.postCount}`)
    // 媒体：3 张视频封面 + 有主图的帖子 2 张 + 只有配图的帖子 2 张（文档页、草稿不算）
    must(d.mediaCount === 7, `媒体计数 ${d.mediaCount}`)
    must(d.lastActiveAt === T - 600 && d.lastActive === '10分钟前', `最后更新 ${d.lastActiveAt} ${d.lastActive}（草稿不算）`)
    // 头图：新的在前，最多 3 张；帖子取主图（没有就取第一张配图），文档帖和草稿 / 下架的不要
    must(d.banner.map(b => b.src).join() === '/m/p1.jpg,/m/p2a.jpg,/m/va.jpg', '头图 ' + d.banner.map(b => b.src).join())
    must(d.banner.every(isCover) && d.followers === 0 && d.following === false, '头图结构 / 粉丝')
    return `视频 3 / 帖子 3，最后更新「${d.lastActive}」，头图 ${d.banner.length} 张`
  })
})

adminCheck('创作者主页：没有作品时头图为空、不显示最后更新', async () =>
  withCreator({ name: '空主页', handle: 'profile_t2' }, async c => {
    const d = await data('GET', `/api/creators/${c.id}`)
    must(d.videoCount === 0 && d.postCount === 0 && d.mediaCount === 0 && d.banner.length === 0 && d.lastActiveAt === null && d.lastActive === '', json(d).slice(0, 200))
    const v = await data('GET', `/api/creators/${c.id}/videos`)
    const p = await data('GET', `/api/creators/${c.id}/posts`)
    const m = await data('GET', `/api/creators/${c.id}/media`)
    must(v.total === 0 && v.list.length === 0 && p.total === 0 && p.list.length === 0 && m.total === 0 && m.list.length === 0, '空列表')
    return 'banner []，lastActive \'\''
  }))

adminCheck('创作者主页：关注后 following / 粉丝数变化，未登录 following 为 false', async () =>
  withCreator({ name: '关注测试', handle: 'profile_t3' }, async c => {
    const d0 = await data('GET', `/api/creators/${c.id}`)
    must(d0.following === false && d0.followers === 0, '起始 ' + json({ following: d0.following, followers: d0.followers }))
    const r1 = await data('POST', `/api/creators/${c.id}/follow`, { on: true })
    must(r1.active === true && r1.followers === 1, '关注返回 ' + json(r1))
    const d1 = await data('GET', `/api/creators/${c.id}`)
    must(d1.following === true && d1.followers === 1, '关注后 ' + json({ following: d1.following, followers: d1.followers }))
    const anon = await anonCall('GET', `/api/creators/${c.id}`)
    must(anon.status === 200 && anon.json.data.following === false && anon.json.data.followers === 1, '未登录 ' + json(anon.json?.data && { following: anon.json.data.following, followers: anon.json.data.followers }))
    must((await data('POST', `/api/creators/${c.id}/follow`, { on: true })).followers === 1, '重复关注粉丝数不变')
    const r2 = await data('POST', `/api/creators/${c.id}/follow`, { on: false })
    must(r2.active === false && r2.followers === 0, '取消关注返回 ' + json(r2))
    const d2 = await data('GET', `/api/creators/${c.id}`)
    must(d2.following === false && d2.followers === 0, '取消后 ' + json({ following: d2.following, followers: d2.followers }))
    return '0 → 1 → 0，未登录 following=false'
  }))

adminCheck('创作者主页：不存在 / 已停用返回 400', async () =>
  withCreator({ name: '停用测试', handle: 'profile_t4' }, async (c, { mkVideo, mkPost }) => {
    await mkVideo({ title: '停用作者的视频' })
    await mkPost({ text: '停用作者的帖子' })
    await data('POST', `/api/creators/${c.id}/follow`, { on: true })
    await data('PATCH', `/api/admin/creators/${c.id}`, { status: 0 })
    for (const sub of ['', '/videos', '/posts', '/media']) await expect400(`/api/creators/${c.id}${sub}`)
    // 已停用的不能再关注，但可以取消关注
    await data('POST', `/api/creators/${c.id}/follow`, { on: false })
    await expect400(`/api/creators/${c.id}/follow`, 'POST', { on: true })
    for (const path of ['/api/creators/99999999', '/api/creators/0', '/api/creators/abc', '/api/creators/99999999999999999999', '/api/creators/1.5',
      '/api/creators/99999999/videos', '/api/creators/abc/posts', '/api/creators/99999999/media', '/api/creators/abc/media']) await expect400(path)
    await expect400('/api/creators/99999999/follow', 'POST', { on: true })
    await data('PATCH', `/api/admin/creators/${c.id}`, { status: 1 })
    must((await data('GET', `/api/creators/${c.id}`)).videoCount === 1, '重新启用后能打开')
    return '停用 / 不存在 / 非法 id 都是 400「创作者不存在」，不会 500'
  }))

adminCheck('创作者主页：视频 最新 / 最热 + 翻页 + 赞收藏状态', async () => {
  const T = Math.floor(Date.now() / 1000)
  return withCreator({ name: '视频测试', handle: 'profile_t5' }, async (c, { mkVideo }) => {
    // 7 条已发布（发布时间各不相同）+ 1 条草稿；播放数用观看记录累加，故意和发布顺序不同，并有一组并列
    const plays = [3, 0, 6, 1, 5, 3, 4]
    const vs = []
    for (let i = 0; i < plays.length; i++) vs.push(await mkVideo({ title: `排序视频 ${i}`, publishedAt: T - 3600 * (i + 1) }))
    await mkVideo({ title: '排序草稿', status: 0, publishedAt: T })
    for (let i = 0; i < vs.length; i++) for (let k = 0; k < plays[i]; k++) await data('POST', '/api/me/history', { videoId: vs[i].id, progressSec: 1 })
    const ids = list => list.map(v => v.id).join()
    const latest = await data('GET', `/api/creators/${c.id}/videos?sort=0&limit=50`)
    must(latest.total === 7 && ids(latest.list) === ids(vs), '最新 ' + ids(latest.list))
    const hot = await data('GET', `/api/creators/${c.id}/videos?sort=1&limit=50`)
    // 播放数倒序，并列（3 次的第 0、5 条）按发布时间新的在前
    const expHot = [2, 4, 6, 0, 5, 3, 1].map(i => vs[i].id).join()
    must(ids(hot.list) === expHot && hot.list.every((v, i, a) => !i || a[i - 1].playCount >= v.playCount), '最热 ' + ids(hot.list) + ' 期望 ' + expHot)
    for (const sort of [0, 1]) {
      const pages = []
      for (let off = 0; off < 7; off += 3) pages.push(...(await data('GET', `/api/creators/${c.id}/videos?sort=${sort}&limit=3&offset=${off}`)).list)
      must(ids(pages) === ids(sort ? hot.list : latest.list) && new Set(pages.map(v => v.id)).size === 7, `sort=${sort} 分页 ${ids(pages)}`)
    }
    must((await data('GET', `/api/creators/${c.id}/videos?limit=999`)).list.length === 7, 'limit 上限')
    must((await data('GET', `/api/creators/${c.id}/videos?limit=0&offset=-5`)).list.length === 7, 'limit 0 → 默认 20、offset 负数 → 0')
    must((await data('GET', `/api/creators/${c.id}/videos?sort=9`)).list[0].id === vs[0].id, '未知 sort 按最新')
    const v0 = latest.list[0]
    must(hasKeys(v0, 'id', 'title', 'dur', 'cover', 'creator', 'playCount', 'liked', 'faved') && v0.creator.id === c.id, '视频结构 ' + Object.keys(v0).join())
    await data('POST', `/api/videos/${vs[0].id}/like`, { on: true })
    await data('POST', `/api/videos/${vs[0].id}/fav`, { on: true })
    const mine = (await data('GET', `/api/creators/${c.id}/videos`)).list[0]
    const anonV = (await anonCall('GET', `/api/creators/${c.id}/videos`)).json.data.list[0]
    must(mine.liked === true && mine.faved === true && anonV.liked === false && anonV.faved === false, '赞 / 收藏状态 ' + json({ mine: [mine.liked, mine.faved], anon: [anonV.liked, anonV.faved] }))
    await data('POST', `/api/videos/${vs[0].id}/like`, { on: false })
    await data('POST', `/api/videos/${vs[0].id}/fav`, { on: false })
    return `最新 / 最热各 7 条，3 条一页翻页一致，最热首条播放 ${hot.list[0].playCount}`
  })
})

adminCheck('创作者主页：帖子与社区列表同结构，翻页、收藏状态', async () => {
  const T = Math.floor(Date.now() / 1000)
  return withCreator({ name: '帖子测试', handle: 'profile_t6', isVerified: true }, async (c, { mkPost }) => {
    const made = []
    for (let i = 0; i < 4; i++) made.push(await mkPost({ text: `主页帖子 ${i}`, mediaKind: i % 2, mainImage: i ? null : '/m/pm.jpg', images: ['/m/pi.jpg'], tags: ['测试'], publishedAt: T - 3600 * (i + 1) }))
    await mkPost({ text: '主页草稿帖', status: 0, publishedAt: T })
    const res = await data('GET', `/api/creators/${c.id}/posts?limit=50`)
    must(res.total === 4 && res.list.map(p => p.id).join() === made.map(p => p.id).join(), '帖子 ' + res.list.map(p => p.id).join())
    const community = await data('GET', '/api/community/posts?tab=0&limit=50')
    for (const p of res.list) {
      const cp = community.find(x => x.id === p.id)
      must(cp && json(cp) === json(p), `#${p.id} 与社区列表不一致：\n${json(p).slice(0, 200)}\n${json(cp).slice(0, 200)}`)
      must(p.creatorId === c.id && p.verified === true && typeof p.time === 'string' && p.media && Array.isArray(p.media.thumbs), `#${p.id} 字段`)
    }
    // 社区列表 / 详情的作者 id 一致（卡片头像点进主页用的就是它）
    must((await data('GET', `/api/community/posts/${made[0].id}`)).author.id === res.list[0].creatorId, '详情 author.id')
    const pages = [...(await data('GET', `/api/creators/${c.id}/posts?limit=3&offset=0`)).list, ...(await data('GET', `/api/creators/${c.id}/posts?limit=3&offset=3`)).list]
    must(pages.map(p => p.id).join() === made.map(p => p.id).join(), '分页 ' + pages.map(p => p.id).join())
    await data('POST', `/api/community/posts/${made[1].id}/fav`, { on: true })
    const faved = (await data('GET', `/api/creators/${c.id}/posts`)).list.find(p => p.id === made[1].id)
    const anonP = (await anonCall('GET', `/api/creators/${c.id}/posts`)).json.data.list.find(p => p.id === made[1].id)
    must(faved.faved === true && faved.fav === 1 && anonP.faved === false, '收藏状态 ' + json({ faved: faved.faved, fav: faved.fav, anon: anonP.faved }))
    return `4 条（草稿不算），字段与社区列表逐条相同：${Object.keys(res.list[0]).join(',')}`
  })
})

const MEDIA_KEYS = 'id,kind,cover,title,postId,videoId,dur,publishedAt'
adminCheck('创作者主页「媒体」：视频封面 + 帖子的图，新的在前、翻页、只算已发布、去重', async () => {
  const T = Math.floor(Date.now() / 1000)
  return withCreator({ name: '媒体测试', handle: 'profile_t7' }, async (c, { mkVideo, mkPost }) => {
    const va = await mkVideo({ title: '媒体视频 A', publishedAt: T - 3600, coverUrl: '/m/wa.jpg', durationSec: 75 })
    const vb = await mkVideo({ title: '媒体视频 B', publishedAt: T - 3 * 3600 })   // 没有封面图（只有占位图）、没有时长
    const vc = await mkVideo({ title: '媒体视频 C', publishedAt: T - 2 * 3600, coverUrl: '/m/wc.jpg', durationSec: 3725 })
    await mkVideo({ title: '媒体草稿视频', status: 0, publishedAt: T, coverUrl: '/m/wdraft.jpg' })
    await mkVideo({ title: '媒体下架视频', status: 2, publishedAt: T, coverUrl: '/m/woff.jpg' })
    const p1 = await mkPost({ text: '三张图的图文帖', mainImage: '/m/w1.jpg', images: ['/m/w1a.jpg', '/m/w1b.jpg'], publishedAt: T - 1800 })
    // 和视频 C 同一时间：视频在前；主图就是视频 A 的封面，不再单独出现
    const p2 = await mkPost({ text: '视频帖拿视频封面当主图', mediaKind: 1, videoId: va.id, mainImage: '/m/wa.jpg', images: ['/m/w2a.jpg'], publishedAt: T - 2 * 3600 })
    // 文档帖：主图算，配图是文档页、不算
    const p3 = await mkPost({ text: '文档帖', mediaKind: 2, mainImage: '/m/w3.jpg', images: ['/m/w3doc1.jpg', '/m/w3doc2.jpg'], publishedAt: T - 600 })
    await mkPost({ text: '没有图的帖子', publishedAt: T - 300 })
    await mkPost({ text: '草稿帖', status: 0, mainImage: '/m/wpdraft.jpg', publishedAt: T })
    await mkPost({ text: '下架帖', status: 2, images: ['/m/wpoff.jpg'], publishedAt: T })

    const all = await data('GET', `/api/creators/${c.id}/media?limit=50`)
    const srcs = list => list.map(m => m.cover?.src ?? '-').join()
    const expSrcs = '/m/w3.jpg,/m/w1.jpg,/m/w1a.jpg,/m/w1b.jpg,/m/wa.jpg,/m/wc.jpg,/m/w2a.jpg,-'
    must(all.total === 8 && all.list.length === 8 && srcs(all.list) === expSrcs, `顺序 ${srcs(all.list)}（total ${all.total}），期望 ${expSrcs}`)
    must(all.list.map(m => m.kind).join() === 'image,image,image,image,video,video,image,video', '类型 ' + all.list.map(m => m.kind).join())
    must(all.list.every(m => Object.keys(m).join() === MEDIA_KEYS && isCover(m.cover)), '字段 ' + Object.keys(all.list[0]).join())
    must(new Set(all.list.map(m => m.id)).size === 8, 'id 不重复')
    must(all.list.every((m, i, a) => !i || a[i - 1].publishedAt >= m.publishedAt), '发布时间倒序')
    const [doc, img] = all.list
    must(doc.postId === p3.id && doc.videoId === null && doc.dur === null && doc.title === '文档帖' && doc.publishedAt === T - 600, '文档帖主图 ' + json({ ...doc, cover: undefined }))
    must(img.postId === p1.id && all.list[2].postId === p1.id && all.list[3].postId === p1.id, '同一帖子：主图在前、配图按顺序')
    const byVideo = id => all.list.find(m => m.videoId === id)
    const a = byVideo(va.id), b = byVideo(vb.id), cc = byVideo(vc.id)
    must(a.postId === null && a.dur === '01:15' && a.title === '媒体视频 A' && a.publishedAt === T - 3600, '视频 A ' + json({ ...a, cover: undefined }))
    must(cc.dur === '1:02:05' && b.dur === null && b.cover.src === null && !!b.cover.fallback, '时长写法 / 没有封面图的视频用占位图 ' + json([cc.dur, b.dur, b.cover.src]))
    must(all.list[6].postId === p2.id, '视频帖的配图还在 ' + json(all.list[6].postId))
    must((await data('GET', `/api/creators/${c.id}`)).mediaCount === 8, '头部 mediaCount 和 total 一致')

    // 翻页：3 条一页拼起来和一次取完全一样
    const pages = []
    for (let off = 0; off < 9; off += 3) {
      const pg = await data('GET', `/api/creators/${c.id}/media?limit=3&offset=${off}`)
      must(pg.total === 8, '每页 total 一样')
      pages.push(...pg.list)
    }
    must(pages.map(m => m.id).join() === all.list.map(m => m.id).join(), '分页 ' + pages.map(m => m.id).join())
    must((await data('GET', `/api/creators/${c.id}/media?limit=999`)).list.length === 8, 'limit 上限')
    must((await data('GET', `/api/creators/${c.id}/media?limit=0&offset=-5`)).list.length === 8, 'limit 0 → 默认 20、offset 负数 → 0')
    must((await data('GET', `/api/creators/${c.id}/media?offset=8`)).list.length === 0, '翻过头是空页')

    // 下架帖子 / 视频后马上少掉，重新上架回来
    await data('PATCH', `/api/admin/posts/${p1.id}`, { status: 2 })
    await data('PATCH', `/api/admin/videos/${vc.id}`, { status: 2 })
    const less = await data('GET', `/api/creators/${c.id}/media?limit=50`)
    must(less.total === 4 && srcs(less.list) === '/m/w3.jpg,/m/wa.jpg,/m/w2a.jpg,-', '下架后 ' + srcs(less.list))
    await data('PATCH', `/api/admin/posts/${p1.id}`, { status: 1 })
    await data('PATCH', `/api/admin/videos/${vc.id}`, { status: 1 })
    must((await data('GET', `/api/creators/${c.id}/media?limit=50`)).total === 8, '重新上架后 8 条')
    // 未登录也能看（公开接口）
    const anon = await anonCall('GET', `/api/creators/${c.id}/media`)
    must(anon.status === 200 && anon.json.data.total === 8, '未登录 ' + anon.status)
    return `8 条：${all.list.map(m => m.kind[0]).join('')}，3 条一页翻页一致，草稿 / 下架 / 文档页 / 重复封面不算`
  })
})

adminCheck('帖子详情：视频块 frames（帖子主图 + 视频封面，同一张只留一张）', async () => {
  const creators = (await data('GET', '/api/admin/creators?pageSize=100')).list
  const cid = creators.find(c => c.handle === 'trip').id
  const v1 = await data('POST', '/api/admin/videos', { title: 'frames 视频', status: 1, durationSec: 90, coverUrl: '/media/covers/f1.jpg' })
  const v2 = await data('POST', '/api/admin/videos', { title: 'frames 没封面图的视频', status: 1, durationSec: 90 })
  const mk = body => data('POST', '/api/admin/posts', { creatorId: cid, text: 'frames 测试', ...body })
  const made = []
  const detail = async body => {
    const p = await mk(body)
    made.push(p.id)
    return data('GET', `/api/community/posts/${p.id}`)
  }
  const fsrc = d => d.video.frames.map(f => f.src ?? '-').join()
  const isrc = d => d.images.map(c => c.src).join()
  try {
    // 视频帖 + 主图：[主图, 视频封面]；video.cover 仍是主图，images 只有配图（原规则不变）
    let d = await detail({ mediaKind: 1, videoId: v1.id, mainImage: '/m/fa.jpg', images: ['/m/fa1.jpg'] })
    must(fsrc(d) === '/m/fa.jpg,/media/covers/f1.jpg' && d.video.frames.every(isCover), '视频帖 ' + fsrc(d))
    must(d.video.cover.src === '/m/fa.jpg' && isrc(d) === '/m/fa1.jpg', '封面 / 配图规则没变 ' + json([d.video.cover.src, isrc(d)]))
    must(Object.keys(d.video).join() === 'id,title,cover,dur,len,frames', 'video 字段 ' + Object.keys(d.video).join())
    // 主图就是视频封面：只留一张（App 显示一整张）
    d = await detail({ mediaKind: 1, videoId: v1.id, mainImage: '/media/covers/f1.jpg' })
    must(fsrc(d) === '/media/covers/f1.jpg', '同一张 ' + fsrc(d))
    // 没有主图：只有视频封面
    d = await detail({ mediaKind: 1, videoId: v1.id, images: ['/m/fc1.jpg'] })
    must(fsrc(d) === '/media/covers/f1.jpg' && isrc(d) === '/m/fc1.jpg', '没有主图 ' + fsrc(d))
    // 图文帖关联视频：主图照旧在 images 里，frames 也带上它
    d = await detail({ mediaKind: 0, videoId: v1.id, mainImage: '/m/fe.jpg', images: ['/m/fe1.jpg'] })
    must(fsrc(d) === '/m/fe.jpg,/media/covers/f1.jpg' && isrc(d) === '/m/fe.jpg,/m/fe1.jpg' && d.video.cover.src === '/media/covers/f1.jpg', '图文帖 ' + json([fsrc(d), isrc(d)]))
    // 视频没有封面图：它的占位图也算一张
    d = await detail({ mediaKind: 1, videoId: v2.id, mainImage: '/m/fg.jpg' })
    must(fsrc(d) === '/m/fg.jpg,-' && !!d.video.frames[1].fallback, '占位封面 ' + fsrc(d))
    // 没有关联视频：video 为 null
    d = await detail({ mediaKind: 1, mainImage: '/m/fh.jpg' })
    must(d.video === null, 'video 应为 null')
    return '[主图, 视频封面] / 同一张 1 张 / 没主图 1 张 / 图文帖 2 张 / 占位封面也算'
  } finally {
    for (const id of made) await data('DELETE', `/api/admin/posts/${id}`).catch(() => {})
    for (const v of [v1, v2]) await data('DELETE', `/api/admin/videos/${v.id}`).catch(() => {})
  }
})

/* ---- 「我的」、搜索记录、帖子搜索、短视频排序、最新、专题、压缩与缓存 ---- */

/** 管理员建一个普通账号并登录，返回令牌 */
async function newUser(uid) {
  await data('POST', '/api/admin/users', { uid, password: 'pass12345', nickname: uid })
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid, password: 'pass12345' }) }).then(r => r.json())
  must(r.code === 0, `${uid} 登录失败 ${r.message}`)
  return r.data.token
}
/** 用指定令牌请求，取 data（token 为 null = 未登录） */
async function asData(token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const j = await res.json().catch(() => null)
  if (!j || j.code !== 0) throw new Error(`${method} ${path} → HTTP ${res.status} ${j?.message || ''}`)
  return j.data
}
/** 原始 HTTP 请求（不自动解压），用来看响应头和压缩后的字节 */
function raw(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path)
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}
const decode = r => {
  const enc = r.headers['content-encoding']
  return (enc === 'br' ? brotliDecompressSync(r.body) : enc === 'gzip' ? gunzipSync(r.body) : r.body).toString('utf8')
}

adminCheck('我的：计数实时统计，收藏 / 关注列表和计数一致', async () => {
  const tok = await newUser('mefavs')
  const me0 = await asData(tok, 'GET', '/api/me')
  must(me0.stats.map(s => `${s.key}:${s.value}:${s.to}`).join() === 'history:0:/history,favs:0:/favorites,follows:0:/follows', '初始 ' + json(me0.stats))
  const [va, vb, vc] = (await data('GET', '/api/category/ai/videos?limit=3')).map(v => v.id)
  for (const v of [va, vb, vc]) await asData(tok, 'POST', `/api/videos/${v}/fav`, { on: true })
  const post = (await data('GET', '/api/community/posts?tab=0&limit=1'))[0]
  await asData(tok, 'POST', `/api/community/posts/${post.id}/fav`, { on: true })
  await asData(tok, 'POST', '/api/topics/2/fav', { on: true })
  const [c1, c2] = (await data('GET', '/api/admin/creators?pageSize=100&status=1')).list
  for (const c of [c1, c2]) await asData(tok, 'POST', `/api/creators/${c.id}/follow`, { on: true })
  // 下架一条收藏过的视频、停用一个关注的创作者：不再计数，也不出现在列表里
  await data('PATCH', `/api/admin/videos/${vc}`, { status: 2 })
  await data('POST', '/api/admin/creators/batch', { ids: [c2.id], action: 'disable' })
  try {
    const me = await asData(tok, 'GET', '/api/me')
    must(json(me.counts) === json({ history: 0, favVideos: 2, favPosts: 1, favTopics: 1, follows: 1 }), 'counts ' + json(me.counts))
    must(me.stats.find(s => s.key === 'favs').value === 4 && me.stats.find(s => s.key === 'follows').value === 1, 'stats ' + json(me.stats))
    const fv = await asData(tok, 'GET', '/api/me/favs?type=video')
    must(fv.total === 2 && fv.list.length === 2 && fv.list.every(v => v.faved === true && v.favedAt > 0 && [va, vb].includes(v.id)), 'video ' + json(fv.list.map(v => v.id)))
    const page2 = await asData(tok, 'GET', '/api/me/favs?type=video&limit=1&offset=1')
    must(page2.total === 2 && page2.list.length === 1 && page2.list[0].id === fv.list[1].id, '分页 ' + json(page2.list.map(v => v.id)))
    const fp = await asData(tok, 'GET', '/api/me/favs?type=post')
    must(fp.total === 1 && fp.list[0].id === post.id && fp.list[0].faved === true && fp.list[0].favedAt > 0, 'post ' + json(fp.list.map(p => p.id)))
    must(Object.keys(fp.list[0]).filter(k => k !== 'favedAt').sort().join() === Object.keys(post).sort().join(), '帖子字段和社区列表不同 ' + Object.keys(fp.list[0]).join())
    const ft = await asData(tok, 'GET', '/api/me/favs?type=topic')
    must(ft.total === 1 && ft.list[0].id === 2 && ft.list[0].name && ft.list[0].cover && typeof ft.list[0].count === 'number', 'topic ' + json(ft.list[0]))
    const fl = await asData(tok, 'GET', '/api/me/follows')
    must(fl.total === 1 && fl.list[0].id === c1.id && fl.list[0].following === true && typeof fl.list[0].followers === 'number' && fl.list[0].avatar && fl.list[0].followedAt > 0, 'follows ' + json(fl.list.map(c => c.id)))
    must((await asData(tok, 'GET', '/api/me/favs?type=nope')).total === 2, '未知 type 应按视频')
    return '收藏 视频 2 / 帖子 1 / 专题 1、关注 1（下架的视频、停用的创作者不算），列表 total 与计数一致'
  } finally {
    await data('PATCH', `/api/admin/videos/${vc}`, { status: 1 })
    await data('POST', '/api/admin/creators/batch', { ids: [c2.id], action: 'enable' })
  }
})

adminCheck('观看历史：分页、进度、删一条、清空；播放页带上次进度', async () => {
  const tok = await newUser('mehistory')
  const [v1, v2, v3] = (await data('GET', '/api/category/cn/videos?limit=3')).map(v => v.id)
  const report = (id, progressSec, progressOnly = false) => asData(tok, 'POST', '/api/me/history', { videoId: id, progressSec, progressOnly })
  await report(v1, 0)
  await report(v1, 37, true)
  await report(v2, 0)
  await report(v3, 0)
  // 同一秒写进去的，改成相隔 10 秒，顺序才确定
  const w = new DatabaseSync(TEST_DB)
  const uid = w.prepare('SELECT id FROM users WHERE uid = ?').get('mehistory').id
  const now = Math.floor(Date.now() / 1000)
  ;[v1, v2, v3].forEach((id, i) => w.prepare('UPDATE watch_history SET watched_at = ? WHERE user_id = ? AND video_id = ?').run(now - 30 + i * 10, uid, id))
  w.close()
  const p1 = await asData(tok, 'GET', '/api/me/history?limit=2')
  must(p1.total === 3 && p1.list.map(v => v.id).join() === [v3, v2].join(), '第一页 ' + json(p1.list.map(v => v.id)))
  const p2 = await asData(tok, 'GET', '/api/me/history?limit=2&offset=2')
  must(p2.list.length === 1 && p2.list[0].id === v1 && p2.list[0].progressSec === 37 && p2.list[0].watchedAt > 0 && p2.list[0].len > 0, '第二页 ' + json(p2.list.map(v => [v.id, v.progressSec])))
  const d = await asData(tok, 'GET', `/api/videos/${v1}`)
  must(d.progressSec === 37 && d.watchedAt > 0, '详情进度 ' + json({ p: d.progressSec, w: d.watchedAt }))
  const anon = (await anonCall('GET', `/api/videos/${v1}`)).json.data
  must(anon.progressSec === 0 && anon.watchedAt === null, '未登录 ' + json({ p: anon.progressSec, w: anon.watchedAt }))
  // 再打开同一个视频：开始播放那次上报（进度 0、计播放数）不覆盖上次看到的位置
  await report(v1, 0)
  must((await asData(tok, 'GET', `/api/videos/${v1}`)).progressSec === 37, '开始播放的上报把进度清零了')
  // 进度上报明确传 0（比如看完了从头再来）才清零
  await report(v1, 0, true)
  must((await asData(tok, 'GET', `/api/videos/${v1}`)).progressSec === 0, 'progressOnly 传 0 应清零')
  const del = await asData(tok, 'DELETE', `/api/me/history/${v2}`)
  must(del.removed === 1 && del.total === 2, '删一条 ' + json(del))
  must((await asData(tok, 'DELETE', `/api/me/history/${v2}`)).removed === 0, '重复删除应为 0')
  must((await asData(tok, 'GET', '/api/me')).counts.history === 2, '删一条后「我的」计数没变')
  const clr = await asData(tok, 'DELETE', '/api/me/history')
  must(clr.removed === 2 && clr.total === 0, '清空 ' + json(clr))
  const after = await asData(tok, 'GET', '/api/me/history')
  must(after.total === 0 && after.list.length === 0, '清空后 ' + json(after))
  return '3 条分 2 页，进度 37 秒带到详情且重开不丢；删一条 / 清空后计数跟着变'
})

await check('社区关注 / 收藏：未登录是空列表', async () => {
  const all = (await anonCall('GET', '/api/community/posts?tab=0')).json.data
  const follow = (await anonCall('GET', '/api/community/posts?tab=2')).json
  const fav = (await anonCall('GET', '/api/community/posts?tab=3')).json
  must(all.length > 0 && follow.code === 0 && follow.data.length === 0 && fav.code === 0 && fav.data.length === 0,
    json({ all: all.length, follow: follow.data?.length, fav: fav.data?.length }))
  return `最新 ${all.length} 条；关注 / 收藏未登录都是 []`
})

adminCheck('帖子搜索：标题 / 话题都能搜，只算已发布，结构同社区列表', async () => {
  const cid = (await data('GET', '/api/admin/creators?pageSize=1&status=1')).list[0].id
  const pub = await data('POST', '/api/admin/posts', { creatorId: cid, text: '帖子搜索测试：秋日银杏大道', tags: '银杏观赏, 秋天', status: 1 })
  const draft = await data('POST', '/api/admin/posts', { creatorId: cid, text: '帖子搜索测试：草稿里的银杏', tags: '银杏观赏, 秋天', status: 0 })
  try {
    const q = (kw, extra = '') => data('GET', '/api/search/posts?q=' + encodeURIComponent(kw) + extra)
    const byText = await q('银杏大道')
    must(byText.total === 1 && byText.list.length === 1 && byText.list[0].id === pub.id, '标题 ' + json(byText.list.map(p => p.id)))
    const byTag = await q('银杏观赏')
    must(byTag.total === 1 && byTag.list[0].id === pub.id, '话题（4 字） ' + json(byTag.list.map(p => p.id)))
    const short = await q('秋天', '&limit=50')
    must(short.list.some(p => p.id === pub.id) && !short.list.some(p => p.id === draft.id), '话题（2 字） ' + json(short.list.map(p => p.id)))
    const listItem = (await data('GET', '/api/community/posts?tab=0&limit=50')).find(p => p.id === pub.id)
    must(listItem && Object.keys(byText.list[0]).sort().join() === Object.keys(listItem).sort().join(), '字段和社区列表不同 ' + Object.keys(byText.list[0]).join())
    must(byText.list[0].media && byText.list[0].time, '缺 media / time')
    const paged = await q('帖子搜索测试', '&limit=1')
    must(paged.total === 1 && paged.list.length === 1, '分页 ' + json({ total: paged.total, n: paged.list.length }))
    const blank = await call('GET', '/api/search/posts?q=%20')
    must(blank.status === 400, '空关键词 HTTP ' + blank.status)
    return '标题 / 4 字话题 / 2 字话题都能搜到，草稿不算，字段与社区列表一致'
  } finally {
    await data('POST', '/api/admin/posts/batch', { ids: [pub.id, draft.id], action: 'delete' })
  }
})

adminCheck('近期搜索：记关键词（没结果也记）、去重、翻页不记、删一个、清空', async () => {
  const tok = await newUser('mesearch')
  const s = path => asData(tok, 'GET', path)
  const enc = encodeURIComponent
  await s('/api/search?q=' + enc('治愈日常'))
  await s('/api/search?q=' + enc('一个肯定搜不到的词'))
  await s('/api/search/posts?q=' + enc('旅行'))
  await s('/api/search?q=' + enc('翻页才搜的词') + '&offset=20')
  let h = (await s('/api/search/history')).list.map(x => x.keyword)
  must(h.join() === ['旅行', '一个肯定搜不到的词', '治愈日常'].join(), '记录 ' + json(h))
  await s('/api/search?q=' + enc('治愈日常'))
  const top = (await s('/api/search/history?limit=2')).list
  must(top.length === 2 && top[0].keyword === '治愈日常' && top[0].searchedAt > 0, '再搜一次应排到最前且不重复 ' + json(top))
  must((await s('/api/search/history')).list.length === 3, '去重失败')
  await anonCall('GET', '/api/search?q=' + enc('未登录搜的词'))
  must((await anonCall('GET', '/api/search/history')).status === 401, '未登录应 401')
  // 旧接口（视频卡片）：没结果的搜索不出现，id 是视频 id
  const old = await s('/api/search/recent?limit=10')
  const first = (await data('GET', '/api/search?q=' + enc('治愈日常') + '&limit=1')).list[0]
  must(old.length === 1 && old[0].id === first.id, '旧版近期搜索 ' + json(old.map(v => v.id)))
  const one = await asData(tok, 'DELETE', '/api/search/history?keyword=' + enc('旅行'))
  must(one.removed === 1, '删一个 ' + json(one))
  h = (await s('/api/search/history')).list.map(x => x.keyword)
  must(h.join() === ['治愈日常', '一个肯定搜不到的词'].join(), '删后 ' + json(h))
  const all = await asData(tok, 'DELETE', '/api/search/history')
  must(all.removed === 2 && (await s('/api/search/history')).list.length === 0, '清空 ' + json(all))
  return '没结果的也记，同一个词只留最新一条，翻页不记；删一个 / 清空'
})

adminCheck('短视频：点了不喜欢的不再出现，同一创作者的其他视频往后排', async () => {
  const tok = await newUser('medislike')
  const first = await shortsPage('seed=dis-a&limit=10', tok)
  const target = first.list[2]
  must(target.creator?.id, '第 3 条没有创作者')
  await asData(tok, 'POST', `/api/videos/${target.id}/dislike`, { on: true })
  // 同一个 seed（排序已缓存）再取：直接跳过它
  const again = shortIds(await shortsPage('seed=dis-a&limit=10', tok))
  must(!again.includes(target.id) && again.length === 9, '缓存的顺序里还有它 ' + json(again))
  // 新 seed：一整轮都不出现；同一创作者的其他视频和未登录（没有不喜欢）比名次往后
  const pool = (await data('GET', '/api/admin/stats')).videos.published
  const roundOf = async token => {
    const out = []
    for (let off = 0; off < pool; off += 50) out.push(...shortIds(await shortsPage(`seed=dis-b&limit=${Math.min(50, pool - off)}&offset=${off}`, token)))
    return out
  }
  const mine = await roundOf(tok)
  const anon = await roundOf(null)
  must(!mine.includes(target.id) && mine.length === pool - 1, `一整轮 ${mine.length} 条（应为 ${pool - 1}），含不喜欢的：${mine.includes(target.id)}`)
  const same = (await data('GET', `/api/creators/${target.creator.id}/videos?limit=50`)).list.map(v => v.id).filter(id => id !== target.id)
  const avg = order => same.reduce((sum, id) => sum + order.indexOf(id), 0) / same.length
  must(same.length > 0 && avg(mine) > avg(anon), `同一创作者 ${same.length} 条的平均名次 ${avg(anon).toFixed(1)} → ${avg(mine).toFixed(1)}`)
  return `#${target.id} 不再出现；同一创作者 ${same.length} 条平均名次 ${avg(anon).toFixed(0)} → ${avg(mine).toFixed(0)}`
})

adminCheck('短视频：有视频文件的、短的排在前面', async () => {
  const mk = async (title, durationSec, playbackUrl) =>
    (await data('POST', '/api/admin/videos', { title, status: 1, durationSec, ...(playbackUrl ? { playbackUrl } : {}) })).id
  const made = { fileShort: [], fileLong: [], bareShort: [], bareLong: [] }
  for (let i = 0; i < 4; i++) {
    made.fileShort.push(await mk('排序测试 有文件短片' + i, 60, `/media/videos/rank-s${i}.mp4`))
    made.fileLong.push(await mk('排序测试 有文件长片' + i, 3600, `/media/videos/rank-l${i}.mp4`))
    made.bareShort.push(await mk('排序测试 无文件短片' + i, 60))
    made.bareLong.push(await mk('排序测试 无文件长片' + i, 3600))
  }
  try {
    const pool = (await data('GET', '/api/admin/stats')).videos.published
    const curated = (await data('GET', '/api/admin/videos?short=1&status=1&pageSize=100')).total
    const pos = { fileShort: [], fileLong: [], bareShort: [], bareLong: [] }
    for (const seed of ['rank-1', 'rank-2', 'rank-3']) {
      const order = []
      for (let off = 0; off < pool; off += 50) order.push(...shortIds(await shortsPage(`seed=${seed}&limit=${Math.min(50, pool - off)}&offset=${off}`)))
      for (const k in made) for (const id of made[k]) pos[k].push(order.indexOf(id))
    }
    must(Object.values(pos).every(p => p.every(x => x >= 0)), '有视频没出现在一整轮里')
    const avg = k => pos[k].reduce((a, b) => a + b, 0) / pos[k].length
    // 有文件的短片：只可能排在精选和其他有文件的后面
    must(Math.max(...pos.fileShort) < curated + 8, `有文件短片最靠后排在第 ${Math.max(...pos.fileShort) + 1} 条（精选 ${curated} 条）`)
    must(avg('fileShort') < avg('fileLong') && avg('fileLong') < avg('bareShort') && avg('bareShort') < avg('bareLong'),
      '平均名次 ' + json(Object.fromEntries(Object.keys(pos).map(k => [k, Math.round(avg(k))]))))
    return '平均名次 ' + Object.keys(pos).map(k => `${k} ${Math.round(avg(k)) + 1}`).join(' / ') + `（精选 ${curated} 条，池子 ${pool}）`
  } finally {
    await data('POST', '/api/admin/videos/batch', { ids: Object.values(made).flat(), action: 'delete' })
  }
})

await check('最新：「全部」在最前，地区计数按日期、和日期上的数字对得上', async () => {
  const f = await data('GET', '/api/home/latest/filters')
  must(f.regions[0].code === 'all' && f.regions[0].label === '全部', '第一项 ' + json(f.regions[0]))
  for (let d = 0; d < 7; d++) {
    const sum = f.regions.slice(1).reduce((s, r) => s + r.counts[d], 0)
    must(f.regions[0].counts[d] === f.dates[d].count && sum === f.dates[d].count, `第 ${d} 天：全部 ${f.regions[0].counts[d]} / 日期 ${f.dates[d].count} / 各地区之和 ${sum}`)
  }
  must(f.regions.every(r => r.count === r.counts[0]), '默认 count 应是今天的')
  const f2 = await data('GET', '/api/home/latest/filters?date=2')
  must(f2.regions.every(r => r.count === r.counts[2]), 'date=2 时 count 应是那天的')
  for (const [i, r] of f.regions.entries()) {
    const byIdx = await data('GET', `/api/home/latest/videos?date=1&region=${i}&limit=50`)
    must(byIdx.length === Math.min(50, r.counts[1]), `${r.label} 昨天 ${byIdx.length} 条，数字是 ${r.counts[1]}`)
    const byCode = await data('GET', `/api/home/latest/videos?date=1&region=${r.code}&limit=50`)
    must(byCode.map(v => v.id).join() === byIdx.map(v => v.id).join(), `${r.code} 按 code 和按下标结果不同`)
  }
  return f.regions.map(r => `${r.label} ${r.counts.join('/')}`).join('；')
})

adminCheck('专题：播放 / 收藏数由视频汇总（后台填的更大时用后台的），登录时带 faved', async () => {
  const topic = await data('POST', '/api/admin/topics', { name: '汇总测试专题', status: 1 })
  const v1 = await data('POST', '/api/admin/videos', { title: '汇总测试 1', status: 1, topicId: topic.id })
  const v2 = await data('POST', '/api/admin/videos', { title: '汇总测试 2', status: 1, topicId: topic.id })
  try {
    const t0 = await data('GET', `/api/topic/${topic.id}`)
    must(t0.playCount === 0 && t0.plays === '0' && t0.favs === 0 && t0.faved === false, '新专题 ' + json({ p: t0.playCount, f: t0.favs, faved: t0.faved }))
    for (const [id, n] of [[v1.id, 3], [v2.id, 2]]) for (let i = 0; i < n; i++) await data('POST', '/api/me/history', { videoId: id, progressSec: 1 })
    await data('POST', `/api/videos/${v1.id}/fav`, { on: true })
    await data('POST', `/api/topics/${topic.id}/fav`, { on: true })
    const t1 = await data('GET', `/api/topic/${topic.id}`)
    must(t1.playCount === 5 && t1.plays === '5' && t1.favs === 2 && t1.faved === true, '汇总 ' + json({ p: t1.playCount, f: t1.favs, faved: t1.faved }))
    const anon = (await anonCall('GET', `/api/topic/${topic.id}`)).json.data
    must(anon.faved === false && anon.favs === 2, '未登录 ' + json({ faved: anon.faved, favs: anon.favs }))
    await data('PATCH', `/api/admin/topics/${topic.id}`, { playsCount: 25000 })
    const t2 = await data('GET', `/api/topic/${topic.id}`)
    must(t2.playCount === 25000 && t2.plays === '2.5w', '后台填的 ' + json({ p: t2.playCount, s: t2.plays }))
    return '播放 3+2=5、收藏 视频 1 + 专题 1 = 2；后台填 25000 时显示 2.5w'
  } finally {
    await data('POST', `/api/videos/${v1.id}/fav`, { on: false })
    await data('POST', `/api/topics/${topic.id}/fav`, { on: false })
    await data('POST', '/api/admin/videos/batch', { ids: [v1.id, v2.id], action: 'delete' })
    await data('DELETE', `/api/admin/topics/${topic.id}`)
  }
})

await check('压缩：接口 JSON 按 Accept-Encoding 压缩（br 优先，其次 gzip），小响应不压', async () => {
  const path = '/api/category/cn/videos?limit=20'
  const plain = await raw(path)
  const br = await raw(path, { 'accept-encoding': 'gzip, deflate, br' })
  const gz = await raw(path, { 'accept-encoding': 'gzip' })
  const noBr = await raw(path, { 'accept-encoding': 'br;q=0, gzip;q=0.8' })
  must(!plain.headers['content-encoding'] && /accept-encoding/.test(plain.headers.vary || ''), '不接受压缩时不该压 ' + json(plain.headers))
  must(br.headers['content-encoding'] === 'br' && gz.headers['content-encoding'] === 'gzip' && noBr.headers['content-encoding'] === 'gzip',
    json([br, gz, noBr].map(r => r.headers['content-encoding'])))
  must(decode(br) === plain.body.toString() && decode(gz) === plain.body.toString(), '解压后内容不一致')
  must(br.body.length * 4 < plain.body.length, `br ${br.body.length} / 原始 ${plain.body.length}`)
  must(br.headers['cache-control'] === 'no-store', '接口应 no-store：' + br.headers['cache-control'])
  const small = await raw('/api/health', { 'accept-encoding': 'br' })
  must(!small.headers['content-encoding'], '小响应不该压')
  return `${plain.body.length} 字节 → br ${br.body.length} / gzip ${gz.body.length}`
})

async function staticCheck() {
  const js = await raw('/' + DIST_JS, { 'accept-encoding': 'br' })
  must(js.status === 200 && js.headers['cache-control'] === 'public, max-age=31536000, immutable', 'assets 缓存头 ' + js.headers['cache-control'])
  must(js.headers['content-encoding'] === 'br' && decode(js) === DIST_FILES[DIST_JS], 'assets 没压缩或内容不对')
  const js2 = await raw('/' + DIST_JS, { 'accept-encoding': 'gzip' })
  must(js2.headers['content-encoding'] === 'gzip' && decode(js2) === DIST_FILES[DIST_JS], 'assets gzip')
  const index = await raw('/', { 'accept-encoding': 'gzip' })
  must(index.status === 200 && index.headers['cache-control'] === 'no-cache' && index.headers.etag && decode(index) === DIST_FILES['index.html'], '入口页 ' + json(index.headers))
  const again = await raw('/index.html', { 'if-none-match': index.headers.etag })
  must(again.status === 304 && again.body.length === 0, '带 ETag 应 304，实际 ' + again.status)
  const spa = await raw('/some/page')
  must(spa.status === 200 && spa.headers['cache-control'] === 'no-cache' && spa.body.toString() === DIST_FILES['index.html'], '前端路由兜底 ' + spa.status)
  const admin = await raw('/admin.html')
  must(admin.status === 200 && admin.headers['cache-control'] === 'no-cache', 'admin.html ' + admin.headers['cache-control'])
  const icon = await raw('/favicon.svg')
  must(icon.headers['cache-control'] === 'no-cache' && icon.headers.etag, '图标 ' + icon.headers['cache-control'])
  const gone = await raw('/assets/app-old123.js')
  must(gone.status === 404, '旧分包应 404，实际 ' + gone.status)
  return 'assets 一年 immutable + br / gzip；入口页、后台、图标 no-cache + ETag（304）；缺的分包 404'
}
if (argBase) results.push({ name: '静态文件：缓存头 / 压缩 / 304 / 缺失分包 404', ok: true, note: '跳过（--base 模式）' })
else await check('静态文件：缓存头 / 压缩 / 304 / 缺失分包 404', staticCheck)

for (const [name, fn] of adminChecks) {
  if (argBase) results.push({ name, ok: true, note: '跳过（--base 模式不写管理数据）' })
  else await check(name, fn)
}

/*
 * ---- 老库迁移：按现在的表结构建库、再删掉 posts.content，模拟升级前的库 ----
 * 另起一个服务（端口 3182）指向它：启动时应自动补上这一列，详情接口照常可用（正文为空串）。
 */
async function oldDbCheck() {
  const dir = mkdtempSync(join(tmpdir(), 'reel-old-db-'))
  const OLD_DB = join(dir, 'old.db')
  const OLD_PORT = 3182
  let srv = null
  try {
    await new Promise(r => spawn(process.execPath, [join(here, 'db', 'seed.mjs')], { env: { ...process.env, DB_PATH: OLD_DB }, stdio: 'ignore' }).on('exit', r))
    const w = new DatabaseSync(OLD_DB)
    w.exec('ALTER TABLE posts DROP COLUMN content')
    // 老版本的 v_users：收藏 / 关注读 user_stats 里没人维护的列
    w.exec(`DROP VIEW v_users; CREATE VIEW v_users AS SELECT u.id, u.uid, u.nickname AS name, u.bio, u.avatar_url, u.avatar_fallback,
             COALESCE(s.history_count, 0) AS history_count, COALESCE(s.fav_count, 0) AS fav_count,
             COALESCE(s.download_count, 0) AS download_count, COALESCE(s.follow_count, 0) AS follow_count
             FROM users u LEFT JOIN user_stats s ON s.user_id = u.id WHERE u.status = 1`)
    const before = w.prepare('PRAGMA table_info(posts)').all().some(c => c.name === 'content')
    w.close()
    must(!before, '没能删掉 content 列')
    let log = ''
    srv = spawn(process.execPath, [join(here, 'index.mjs')], { env: { ...process.env, PORT: String(OLD_PORT), DB_PATH: OLD_DB, MEDIA_DIR: TEST_MEDIA }, stdio: ['ignore', 'pipe', 'pipe'] })
    srv.stdout.on('data', d => { log += d })
    srv.stderr.on('data', d => { log += d })
    const oldBase = `http://127.0.0.1:${OLD_PORT}`
    let up = false
    for (let i = 0; i < 100 && srv.exitCode === null && !up; i++) {
      up = await fetch(oldBase + '/api/health').then(r => r.ok, () => false)
      if (!up) await new Promise(r => setTimeout(r, 100))
    }
    must(up, '老库上的服务没启动起来：' + log.slice(0, 200))
    const res = await fetch(oldBase + '/api/community/posts/1').then(r => r.json())
    must(res.code === 0 && res.data.content === '' && res.data.title && res.data.next?.id === 2, '详情 ' + JSON.stringify(res).slice(0, 160))
    const view = await fetch(oldBase + '/api/community/posts/1/view', { method: 'POST' }).then(r => r.json())
    must(view.code === 0 && view.data.read > 0, 'view ' + JSON.stringify(view))
    const r = new DatabaseSync(OLD_DB, { readOnly: true })
    const col = r.prepare('PRAGMA table_info(posts)').all().find(c => c.name === 'content')
    r.close()
    must(col && col.notnull === 1 && col.dflt_value === "''", '补上的列 ' + JSON.stringify(col))
    must(/补上 content 列/.test(log), '启动日志里应提示补列')
    const viewSqlOf = db2 => db2.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'v_users'").get()?.sql || ''
    const rv = new DatabaseSync(OLD_DB, { readOnly: true })
    const viewSql = viewSqlOf(rv)
    const u = rv.prepare('SELECT * FROM v_users LIMIT 1').get()
    rv.close()
    must(/fav_video_count/.test(viewSql) && u && 'fav_post_count' in u && 'follow_count' in u, 'v_users 没有按新定义重建：' + viewSql.slice(0, 120))
    must(/已更新 v_users 视图/.test(log), '启动日志里应提示重建 v_users')
    return 'content 列已补上（NOT NULL DEFAULT \'\'），详情 / 阅读数正常；v_users 改为实时计数'
  } finally {
    if (srv && srv.exitCode === null) {
      const exited = new Promise(r => srv.once('exit', r))
      srv.kill()
      await Promise.race([exited, new Promise(r => setTimeout(r, 3000))])
    }
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}
if (argBase) results.push({ name: '老库自动补 posts.content 列 / 重建 v_users', ok: true, note: '跳过（--base 模式）' })
else await check('老库自动补 posts.content 列 / 重建 v_users', oldDbCheck)

/* ---- 错误处理：这些用例「必须失败」 ---- */
async function tFail(name, method, path, expectHint, body) {
  try {
    const { status, json } = await call(method, path, body)
    const bad = json && json.code === 0
    results.push({ name, ok: !bad, note: bad ? `本应报错却成功了` : `HTTP ${status}${json?.message ? ' · ' + json.message : ''}` })
  } catch (e) {
    results.push({ name, ok: true, note: '连接层报错：' + e.message.slice(0, 40) })
  }
}
await tFail('空关键词被拒绝', 'GET', '/api/search?q=')
await tFail('未知路由被拒绝', 'GET', '/api/nope')
await tFail('方法不对被拒绝', 'POST', '/api/topic/2')
await tFail('非法 JSON 被拒绝', 'POST', '/api/me/history', null, 'not-json')
await tFail('不存在的视频被拒绝', 'POST', '/api/me/history', null, { videoId: 999999 })

if (child) child.kill()
try { rmSync(TEST_MEDIA, { recursive: true, force: true }) } catch {}
try { rmSync(TEST_DIST, { recursive: true, force: true }) } catch {}

const pad = (s, n) => String(s).padEnd(n, ' ')
console.log('')
for (const r of results) console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${pad(r.name, 22)} ${r.note}`)
const failed = results.filter(r => !r.ok)
console.log(`\n  ${results.length - failed.length}/${results.length} 通过` + (failed.length ? `，失败 ${failed.length} 项` : '，全部通过'))
process.exit(failed.length ? 1 : 0)
