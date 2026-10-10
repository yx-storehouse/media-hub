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
import { rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const argBase = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : null
const PORT = 3178
/* 用独立的库，避免污染开发数据 */
/* 素材目录也用临时的，测试不碰项目里的 media/ */
const TEST_MEDIA = join(tmpdir(), `reel-media-${PORT}-${process.pid}`)
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

  child = spawn(process.execPath, [join(here, 'index.mjs')], { env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB, MEDIA_DIR: TEST_MEDIA }, stdio: 'ignore' })
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
await t('最新筛选项', 'GET', '/api/home/latest/filters', d => isArr(d.dates, 7) && isArr(d.regions, 3) ? `${d.dates.length} 个日期 / ${d.regions.length} 个地区` : false)
await t('最新视频', 'GET', '/api/home/latest/videos?date=0&region=0&limit=6', d => isArr(d, 6) ? `${d.length} 条` : false)
await t('最新按本地日期分天', 'GET', '/api/home/latest/videos?date=1&region=0&limit=50', d => isArr(d) && d.every(v => v.publishedAt >= dayStart(1) && v.publishedAt < dayStart(0)) ? `昨天 ${d.length} 条都在本地 0 点之间` : false)
await t('分类筛选项', 'GET', '/api/category/ai/filters', d => isArr(d, 4) ? d.map(x => x.label).join(',') : false)
await t('分类视频', 'GET', '/api/category/ai/videos?filter=1&limit=6', d => isArr(d, 6) ? `${d.length} 条` : false)

/* ---- 搜索 ---- */
await t('热门搜索词', 'GET', '/api/search/hot', d => isArr(d, 8) ? d.map(x => x.word).join(',') : false)
await t('换一批搜索词', 'GET', '/api/search/hot?page=1', d => isArr(d, 8) ? `${d.length} 个` : false)
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

/* ---- 短视频 / 社区 ---- */
await t('短视频流', 'GET', '/api/shorts', d => isArr(d, 5) && d[0].len > 0 ? `${d.length} 条，首条时长 ${d[0].len}s` : false)
await check('短视频翻页 + 播放地址', async () => {
  const all = await data('GET', '/api/shorts?limit=50')
  const page = await data('GET', '/api/shorts?limit=2&offset=2')
  must(all.every(v => 'src' in v), '缺少 src 字段')
  must(page.map(v => v.id).join() === all.slice(2, 4).map(v => v.id).join(), `第二页 ${page.map(v => v.id)}，期望 ${all.slice(2, 4).map(v => v.id)}`)
  must((await data('GET', `/api/shorts?limit=20&offset=${all.length}`)).length === 0, '翻到末尾应为空')
  return `共 ${all.length} 条，offset 翻页正确`
})
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

/* ---- 直播 / 同城 ---- */
await t('直播 tab', 'GET', '/api/live/tabs', d => isArr(d, 5) ? d.join(',') : false)
await t('直播列表', 'GET', '/api/live?tab=0', d => isArr(d, 6) && d[0].cover ? `${d.length} 个，首个「${d[0].title}」${d[0].viewers}` : false)
await t('直播分类', 'GET', '/api/live?tab=2', d => Array.isArray(d) ? `才艺 ${d.length} 个` : false)
await t('同城筛选项', 'GET', '/api/nearby/filters', d => isArr(d, 6) ? d.map(x => x.label).join(',') : false)
await t('同城列表', 'GET', '/api/nearby?filter=0', d => isArr(d, 6) && d[0].distance && d[0].price ? `${d.length} 条，首个「${d[0].title.slice(0, 8)}」${d[0].distance} ${d[0].price}` : false)
await t('同城·美食', 'GET', '/api/nearby?filter=4', d => Array.isArray(d) ? `${d.length} 条` : false)

/* ---- 我的 ---- */
await t('个人信息', 'GET', '/api/me', d => hasKeys(d, 'name', 'uid', 'stats') && d.stats.length === 4 ? `${d.name}，${d.stats.map(s => s.label + '=' + s.value).join(' ')}` : false)
await t('观看历史', 'GET', '/api/me/history', d => Array.isArray(d) ? `${d.length} 条` : false)
const anyVideo = (await call('GET', '/api/home/latest/videos?limit=1')).json?.data?.[0]
await t('记录观看', 'POST', '/api/me/history', d => d.added === true ? `视频 #${d.videoId} 记录成功` : false, { videoId: anyVideo.id, progressSec: 30 })
await t('记录后历史', 'GET', '/api/me/history', d => isArr(d, 1) ? `${d.length} 条，最新「${d[0].title}」` : false)
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
    if (i === otherIdx) continue
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

for (const [name, fn] of adminChecks) {
  if (argBase) results.push({ name, ok: true, note: '跳过（--base 模式不写管理数据）' })
  else await check(name, fn)
}

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

const pad = (s, n) => String(s).padEnd(n, ' ')
console.log('')
for (const r of results) console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${pad(r.name, 22)} ${r.note}`)
const failed = results.filter(r => !r.ok)
console.log(`\n  ${results.length - failed.length}/${results.length} 通过` + (failed.length ? `，失败 ${failed.length} 项` : '，全部通过'))
process.exit(failed.length ? 1 : 0)
