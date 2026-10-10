/*
 * 鉴权：口令哈希、会话令牌、中间件。
 *
 * 设计取舍（内网程序，不引入外部依赖）：
 *   - 口令用 Node 内置 crypto 的 scrypt 加盐哈希，不存明文、不用 bcrypt。
 *   - 会话令牌是 32 字节随机串，存 sessions 表，带过期时间；每次用就顺延（滑动过期）。
 *   - 浏览类接口不要求登录；点赞、收藏、观看历史这类「跟人有关」的写操作要求登录。
 *   - 角色分 admin / user：内网里管理员负责建账号、停用账号。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30)
const DAY = 86400
const now = () => Math.floor(Date.now() / 1000)

/* ---------------- 口令 ---------------- */

/** 返回 `scrypt$<salt>$<hash>`，每个用户独立盐值 */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

/** 定时安全比较，避免通过响应时间推断口令 */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const [algo, saltHex, hashHex] = stored.split('$')
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return expected.length === actual.length && timingSafeEqual(actual, expected)
}

/** 口令强度：内网也要求 8 位以上，避免空口令账号 */
export function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) return '密码至少 8 位'
  if (password.length > 128) return '密码过长'
  return null
}

/* ---------------- 会话 ---------------- */

export function createSession(db, userId, device = null) {
  const token = randomBytes(32).toString('hex')
  const t = now()
  db.prepare('INSERT INTO sessions(token, user_id, device, created_at, expires_at) VALUES(?,?,?,?,?)')
    .run(token, userId, device, t, t + SESSION_DAYS * DAY)
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(t, userId)
  return { token, expiresAt: t + SESSION_DAYS * DAY }
}

/** 校验令牌；有效则顺延过期时间并返回用户 */
export function resolveSession(db, token) {
  if (!token) return null
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token)
  if (!row) return null
  const t = now()
  if (row.expires_at <= t) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    return null
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)
  if (!user || user.status !== 1) return null
  // 滑动过期：用一次就续一次，但最多每 6 小时写一次，避免每个请求都写库
  if (row.expires_at - t < (SESSION_DAYS - 1) * DAY) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(t + SESSION_DAYS * DAY, token)
  }
  return { user, session: row }
}

export function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

/** 退出所有设备（改密码后调用） */
export function deleteUserSessions(db, userId, exceptToken = null) {
  if (exceptToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, exceptToken)
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

/** 顺手清理过期会话 */
export function purgeExpiredSessions(db) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes
}

/* ---------------- 请求上下文 ---------------- */

/** 从 Authorization: Bearer xxx 取出令牌 */
export function readToken(req) {
  const h = req.headers.authorization || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

/** 登录用户对外的样子（绝不包含口令哈希） */
export function publicUser(user) {
  return {
    id: user.id,
    uid: user.uid,
    name: user.nickname,
    avatar: { src: user.avatar_url, fallback: user.avatar_fallback },
    bio: user.bio,
    role: user.role,
    lastLoginAt: user.last_login_at
  }
}

/** 登录失败次数限制（内存版，够内网用；重启即清零） */
const attempts = new Map()
const MAX_ATTEMPTS = 8
const LOCK_MINUTES = 10

export function noteFailedLogin(key) {
  const rec = attempts.get(key) || { count: 0, until: 0 }
  rec.count += 1
  if (rec.count >= MAX_ATTEMPTS) {
    rec.until = now() + LOCK_MINUTES * 60
    rec.count = 0
  }
  attempts.set(key, rec)
  return rec.until > now() ? Math.ceil((rec.until - now()) / 60) : 0
}

export function loginLocked(key) {
  const rec = attempts.get(key)
  if (!rec || rec.until <= now()) return 0
  return Math.ceil((rec.until - now()) / 60)
}

export function clearLoginAttempts(key) {
  attempts.delete(key)
}
