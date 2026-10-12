/*
 * 鉴权接口测试：登录、令牌、权限、账号管理。
 *
 *   node server/test-auth.mjs                     # 自动起服务，跑完自动关
 *   node server/test-auth.mjs --base http://x:3000
 *
 * 使用独立的测试数据库，不会动到 reel.db。
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { rmSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { hashPassword } from './auth.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argBase = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : null
const PORT = 3179
const base = argBase || `http://127.0.0.1:${PORT}`
const TEST_DB = join(here, 'db', 'auth-test.db')
/* 素材目录也用临时的，测试不碰项目里的 media/ */
const TEST_MEDIA = join(tmpdir(), `reel-media-${PORT}-${process.pid}`)

let child = null
if (!argBase) {
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if (existsSync(f)) rmSync(f)
  // 建一个干净的库（seed.mjs --reset 会先删库），插两个账号
  child = spawn(process.execPath, [join(here, 'db', 'seed.mjs'), '--reset'], { env: { ...process.env, DB_PATH: TEST_DB }, stdio: 'ignore' })
  await new Promise(r => child.on('exit', r))
  const db = new DatabaseSync(TEST_DB)
  const t = Math.floor(Date.now() / 1000)
  const add = (uid, nick, pwd, role) => db.prepare(`INSERT INTO users(uid,nickname,password_hash,role,created_at) VALUES(?,?,?,?,?)`)
    .run(uid, nick, hashPassword(pwd), role, t)
  add('admin', '管理员', 'admin12345', 'admin')
  add('user1', '普通用户', 'user123456', 'user')
  db.close()

  child = spawn(process.execPath, [join(here, 'index.mjs')], { env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB, MEDIA_DIR: TEST_MEDIA }, stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 1400))
}

const results = []
async function req(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json }
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

let adminToken = null, userToken = null, newUserId = null

/* ---------- 未登录 ---------- */

await t('未登录：可以浏览视频列表', async () => {
  const r = await req('GET', '/api/home/latest/videos?limit=3')
  must(r.status === 200 && r.json.data.length === 3, `HTTP ${r.status}`)
  return `${r.json.data.length} 条`
})

await t('未登录：点赞被拒 401', async () => {
  const r = await req('POST', '/api/videos/13/like')
  must(r.status === 401, `期望 401，实际 ${r.status}`)
  return r.json.message
})

await t('未登录：/api/me 返回 null 而不是报错', async () => {
  const r = await req('GET', '/api/me')
  must(r.status === 200 && r.json.data === null, JSON.stringify(r.json))
  return 'null'
})

await t('未登录：观看历史 / 收藏 / 关注 / 搜索记录 401', async () => {
  for (const path of ['/api/me/history', '/api/me/favs', '/api/me/follows', '/api/search/history']) {
    const r = await req('GET', path)
    must(r.status === 401, `${path} 期望 401，实际 ${r.status}`)
  }
  for (const path of ['/api/me/history', '/api/me/history/1', '/api/search/history']) {
    const r = await req('DELETE', path)
    must(r.status === 401, `DELETE ${path} 期望 401，实际 ${r.status}`)
  }
  return '4 个列表、3 个删除都要登录'
})

await t('未登录：管理员接口被拒 401', async () => {
  const r = await req('GET', '/api/admin/users')
  must(r.status === 401, `期望 401，实际 ${r.status}`)
  return r.json.message
})

/* ---------- 登录 ---------- */

await t('登录：管理员成功拿到令牌', async () => {
  const r = await req('POST', '/api/auth/login', { body: { uid: 'admin', password: 'admin12345' } })
  must(r.status === 200 && r.json.data.token, JSON.stringify(r.json))
  adminToken = r.json.data.token
  must(r.json.data.user.role === 'admin', '角色不是 admin')
  must(!('password_hash' in r.json.data.user), '响应里泄漏了口令哈希')
  return `role=${r.json.data.user.role}，有效期 ${Math.round((r.json.data.expiresAt - Date.now() / 1000) / 86400)} 天`
})

await t('登录：口令错误被拒', async () => {
  const r = await req('POST', '/api/auth/login', { body: { uid: 'admin', password: 'nope' } })
  must(r.status === 400 && /账号或密码错误/.test(r.json.message), JSON.stringify(r.json))
  return r.json.message
})

await t('登录：不存在的账号返回同样的提示', async () => {
  const r = await req('POST', '/api/auth/login', { body: { uid: 'nobody', password: 'x' } })
  must(r.status === 400 && /账号或密码错误/.test(r.json.message), JSON.stringify(r.json))
  return '与口令错误不可区分'
})

await t('登录：缺少参数被拒', async () => {
  const r = await req('POST', '/api/auth/login', { body: { uid: '' } })
  must(r.status === 400, `HTTP ${r.status}`)
  return r.json.message
})

await t('令牌：/api/auth/me 返回当前用户', async () => {
  const r = await req('GET', '/api/auth/me', { token: adminToken })
  must(r.status === 200 && r.json.data.uid === 'admin', JSON.stringify(r.json))
  return r.json.data.name
})

await t('令牌：伪造的令牌不被接受', async () => {
  const r = await req('GET', '/api/auth/me', { token: 'deadbeef'.repeat(8) })
  must(r.status === 200 && r.json.data === null, JSON.stringify(r.json))
  return '视为未登录'
})

await t('登录：普通用户也能登录', async () => {
  const r = await req('POST', '/api/auth/login', { body: { uid: 'user1', password: 'user123456' } })
  must(r.status === 200 && r.json.data.token, JSON.stringify(r.json))
  userToken = r.json.data.token
  return `role=${r.json.data.user.role}`
})

/* ---------- 登录后的行为 ---------- */

await t('诊断：确认 userToken 仍然有效', async () => {
  const me = await req('GET', '/api/auth/me', { token: userToken })
  const sessions = (await req('GET', '/api/auth/me', { token: adminToken })).json.data
  must(me.json.data !== null, `userToken 已失效；token 前缀 ${userToken.slice(0, 12)}`)
  return `user1=${me.json.data.uid}`
})

/* 短视频推荐流按 seed 排序：固定一个 seed，同一用户每次拿到的顺序一样（第二页 = 同一顺序的第 3、4 条） */
const SHORTS = '/api/shorts?seed=auth-test&limit=50'
const SHORTS_P2 = '/api/shorts?seed=auth-test&limit=2&offset=2'

await t('已登录：可以点赞并写入数据库', async () => {
  const before = (await req('GET', SHORTS, { token: userToken })).json.data.list[0]
  const r = await req('POST', `/api/videos/${before.id}/like`, { token: userToken })
  must(r.status === 200 && r.json.data.active === true, JSON.stringify(r.json))
  const after = (await req('GET', SHORTS, { token: userToken })).json.data.list.find(s => s.id === before.id)
  must(after.likeCount === before.likeCount + 1, `计数没变：${before.likeCount} -> ${after.likeCount}`)
  must(after.liked === true, '列表里没带上 liked 状态')
  return `${before.likeCount} -> ${after.likeCount}`
})

await t('已登录：取消点赞后计数复原', async () => {
  // 自己建立前置状态（用第二条视频，避免和别的用例互相影响）
  const id = (await req('GET', SHORTS, { token: userToken })).json.data.list[1].id
  const base = (await req('GET', SHORTS, { token: userToken })).json.data.list.find(s => s.id === id)
  must(base.liked === false, '前置状态：这条视频应该是未点赞')
  await req('POST', `/api/videos/${id}/like`, { token: userToken })
  const liked = (await req('GET', SHORTS, { token: userToken })).json.data.list.find(s => s.id === id)
  if (liked.liked !== true) {
    const all = (await req('GET', SHORTS, { token: userToken })).json.data.list.map(s => `${s.id}:${s.liked}`).join(' ')
    const act = await req('POST', `/api/videos/${id}/like`, { token: userToken })
    throw new Error(`liked 状态没变（id=${id}）；当前所有: ${all}；再点一次返回 ${JSON.stringify(act.json)}`)
  }
must(liked.likeCount === base.likeCount + 1, `计数没变：${base.likeCount} -> ${liked.likeCount}`)

  await req('POST', `/api/videos/${id}/like`, { token: userToken })
  const after = (await req('GET', SHORTS, { token: userToken })).json.data.list.find(s => s.id === id)
  must(after.likeCount === base.likeCount, `${liked.likeCount} -> ${after.likeCount}，期望回到 ${base.likeCount}`)
  must(after.liked === false, '状态没有回到未点赞')
  return `${base.likeCount} -> ${liked.likeCount} -> ${after.likeCount}`
})

await t('状态隔离：两个用户的点赞互不影响', async () => {
  const id = (await req('GET', SHORTS, { token: userToken })).json.data.list[1].id
  await req('POST', `/api/videos/${id}/like`, { token: userToken })
  const asAdmin = (await req('GET', SHORTS, { token: adminToken })).json.data.list.find(s => s.id === id)
  const asUser = (await req('GET', SHORTS, { token: userToken })).json.data.list.find(s => s.id === id)
  must(asUser.liked === true, 'user1 应该是已点赞')
  must(asAdmin.liked === false, 'admin 不应该被影响')
  await req('POST', `/api/videos/${id}/like`, { token: userToken })
  return 'user1=true admin=false'
})

await t('已登录：短视频翻页后点赞状态照样回填', async () => {
  // 前端短视频流按 offset 翻页，后面几页也要带上当前用户的 liked
  const all = (await req('GET', SHORTS, { token: userToken })).json.data.list
  must(all.length >= 4, `短视频只有 ${all.length} 条`)
  const target = all[3]
  must(target.liked === false, '前置状态：这条视频应该是未点赞')
  await req('POST', `/api/videos/${target.id}/like`, { token: userToken, body: { on: true } })
  const page = (await req('GET', SHORTS_P2, { token: userToken })).json.data.list
  const hit = page.find(s => s.id === target.id)
  must(hit && hit.liked === true, '第二页里没有带上 liked：' + JSON.stringify(page.map(s => `${s.id}:${s.liked}`)))
  const anon = (await req('GET', SHORTS)).json.data.list.find(s => s.id === target.id)
  must(anon && anon.liked === false, '未登录时不应带上别人的 liked')
  await req('POST', `/api/videos/${target.id}/like`, { token: userToken, body: { on: false } })
  return `#${target.id} 在第二页 liked=true`
})

await t('已登录：观看历史会记录', async () => {
  const id = (await req('GET', '/api/home/latest/videos?limit=1')).json.data[0].id
  const r = await req('POST', '/api/me/history', { token: userToken, body: { videoId: id, progressSec: 12 } })
  must(r.status === 200 && r.json.data.added === true, JSON.stringify(r.json))
  const { total, list } = (await req('GET', '/api/me/history', { token: userToken })).json.data
  must(total >= 1 && list[0].id === id && list[0].progressSec === 12, JSON.stringify(list.map(v => [v.id, v.progressSec])))
  return `历史 ${total} 条`
})

await t('已登录：个人中心返回统计', async () => {
  const r = await req('GET', '/api/me', { token: userToken })
  must(r.status === 200 && r.json.data.stats.length === 3, JSON.stringify(r.json))
  const history = r.json.data.stats.find(s => s.label === '观看历史').value
  must(history >= 1, `观看历史统计为 ${history}`)
  return r.json.data.stats.map(s => `${s.label}=${s.value}`).join(' ')
})

/* ---------- 改密码 ---------- */

await t('改密码：旧密码错误被拒', async () => {
  const r = await req('POST', '/api/auth/password', { token: userToken, body: { oldPassword: 'wrong', newPassword: 'newpass1234' } })
  must(r.status === 400 && /原密码不正确/.test(r.json.message), JSON.stringify(r.json))
  return r.json.message
})

await t('改密码：新密码太短被拒', async () => {
  const r = await req('POST', '/api/auth/password', { token: userToken, body: { oldPassword: 'user123456', newPassword: '123' } })
  must(r.status === 400 && /至少 8 位/.test(r.json.message), JSON.stringify(r.json))
  return r.json.message
})

await t('改密码：成功后当前令牌仍可用', async () => {
  const r = await req('POST', '/api/auth/password', { token: userToken, body: { oldPassword: 'user123456', newPassword: 'newpass1234' } })
  must(r.status === 200, JSON.stringify(r.json))
  const me = await req('GET', '/api/auth/me', { token: userToken })
  must(me.json.data?.uid === 'user1', '当前会话被误踢')
  return '当前设备保留'
})

await t('改密码：旧密码不能再登录，新密码可以', async () => {
  const old = await req('POST', '/api/auth/login', { body: { uid: 'user1', password: 'user123456' } })
  must(old.status === 400, '旧密码仍然能登录')
  const fresh = await req('POST', '/api/auth/login', { body: { uid: 'user1', password: 'newpass1234' } })
  must(fresh.status === 200, JSON.stringify(fresh.json))
  return '旧密码失效'
})

/* ---------- 权限 ---------- */

await t('权限：普通用户访问管理员接口被拒 403', async () => {
  const r = await req('GET', '/api/admin/users', { token: userToken })
  must(r.status === 403, `期望 403，实际 ${r.status}`)
  return r.json.message
})

await t('管理员：可以看到账号列表', async () => {
  const r = await req('GET', '/api/admin/users', { token: adminToken })
  must(r.status === 200 && r.json.data.length >= 2, JSON.stringify(r.json))
  return `${r.json.data.length} 个账号`
})

await t('管理员：密码字段没有出现在账号列表里', async () => {
  const r = await req('GET', '/api/admin/users', { token: adminToken })
  const leaked = JSON.stringify(r.json.data).includes('scrypt')
  must(!leaked, '响应里包含口令哈希')
  return '无泄漏'
})

await t('管理员：能创建新账号', async () => {
  const r = await req('POST', '/api/admin/users', { token: adminToken, body: { uid: 'viewer1', nickname: '访客一号', password: 'viewer12345' } })
  must(r.status === 200 && r.json.data.uid === 'viewer1', JSON.stringify(r.json))
  newUserId = r.json.data.id
  return `#${newUserId} ${r.json.data.name}`
})

await t('管理员：新账号可以登录', async () => {
  const r = await req('POST', '/api/auth/login', { body: { uid: 'viewer1', password: 'viewer12345' } })
  must(r.status === 200, JSON.stringify(r.json))
  return '登录成功'
})

await t('管理员：登录名重复被拒', async () => {
  const r = await req('POST', '/api/admin/users', { token: adminToken, body: { uid: 'viewer1', password: 'viewer12345' } })
  must(r.status === 400, `期望 400，实际 ${r.status}`)
  must(/已存在/.test(r.json.message), r.json.message)
  return r.json.message
})

await t('管理员：登录名格式非法被拒', async () => {
  const r = await req('POST', '/api/admin/users', { token: adminToken, body: { uid: 'a b', password: 'viewer12345' } })
  must(r.status === 400, `期望 400，实际 ${r.status}`)
  must(/3-32 位/.test(r.json.message), r.json.message)
  return r.json.message
})

await t('管理员：重置他人口令后旧会话失效', async () => {
  const login = await req('POST', '/api/auth/login', { body: { uid: 'viewer1', password: 'viewer12345' } })
  const oldToken = login.json.data.token
  const r = await req('POST', `/api/admin/users/${newUserId}/password`, { token: adminToken, body: { newPassword: 'reset12345' } })
  must(r.status === 200, JSON.stringify(r.json))
  const me = await req('GET', '/api/auth/me', { token: oldToken })
  must(me.json.data === null, '旧令牌仍然有效')
  const relogin = await req('POST', '/api/auth/login', { body: { uid: 'viewer1', password: 'reset12345' } })
  must(relogin.status === 200, '新口令登录失败')
  return '旧会话已作废'
})

await t('管理员：停用账号后立刻无法使用', async () => {
  const login = await req('POST', '/api/auth/login', { body: { uid: 'viewer1', password: 'reset12345' } })
  const tok = login.json.data.token
  const r = await req('POST', `/api/admin/users/${newUserId}/status`, { token: adminToken, body: { status: 0 } })
  must(r.status === 200, JSON.stringify(r.json))
  const me = await req('GET', '/api/auth/me', { token: tok })
  must(me.json.data === null, '停用后令牌仍然有效')
  const relogin = await req('POST', '/api/auth/login', { body: { uid: 'viewer1', password: 'reset12345' } })
  must(relogin.status === 400, `期望 400，实际 ${relogin.status}`)
  must(/停用/.test(relogin.json.message), relogin.json.message)
  return relogin.json.message
})

await t('管理员：不能停用自己', async () => {
  const me = (await req('GET', '/api/auth/me', { token: adminToken })).json.data
  const r = await req('POST', `/api/admin/users/${me.id}/status`, { token: adminToken, body: { status: 0 } })
  must(r.status === 400 && /不能停用自己/.test(r.json.message), JSON.stringify(r.json))
  return r.json.message
})

await t('管理员：不能删除自己', async () => {
  const me = (await req('GET', '/api/auth/me', { token: adminToken })).json.data
  const r = await req('DELETE', `/api/admin/users/${me.id}`, { token: adminToken })
  must(r.status === 400 && /不能删除自己/.test(r.json.message), JSON.stringify(r.json))
  return r.json.message
})

await t('管理员：删除账号', async () => {
  const r = await req('DELETE', `/api/admin/users/${newUserId}`, { token: adminToken })
  must(r.status === 200, JSON.stringify(r.json))
  const list = (await req('GET', '/api/admin/users', { token: adminToken })).json.data
  must(!list.some(u => u.id === newUserId), '账号还在')
  return '已删除'
})

/* ---------- 退出 ---------- */

await t('退出登录：令牌立即失效', async () => {
  const login = await req('POST', '/api/auth/login', { body: { uid: 'user1', password: 'newpass1234' } })
  const tok = login.json.data.token
  await req('POST', '/api/auth/logout', { token: tok })
  const me = await req('GET', '/api/auth/me', { token: tok })
  must(me.json.data === null, '退出后令牌仍然有效')
  return '已失效'
})

await t('退出登录：不影响其他设备的会话', async () => {
  const a = (await req('POST', '/api/auth/login', { body: { uid: 'user1', password: 'newpass1234' } })).json.data.token
  const b = (await req('POST', '/api/auth/login', { body: { uid: 'user1', password: 'newpass1234' } })).json.data.token
  await req('POST', '/api/auth/logout', { token: a })
  const meB = await req('GET', '/api/auth/me', { token: b })
  must(meB.json.data !== null, 'B 的会话被误踢')
  await req('POST', '/api/auth/logout', { token: b })
  return '只有 A 退出'
})

if (child) child.kill()
try { rmSync(TEST_MEDIA, { recursive: true, force: true }) } catch {}

const pad = (s, n) => String(s).padEnd(n)
console.log('')
for (const r of results) console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${pad(r.name, 32)} ${r.note}`)
const bad = results.filter(r => !r.ok)
console.log(`\n  ${results.length - bad.length}/${results.length} 通过` + (bad.length ? `，失败 ${bad.length} 项` : '，全部通过'))
process.exit(bad.length ? 1 : 0)
