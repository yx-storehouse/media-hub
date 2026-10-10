/*
 * 创建 / 重置管理员账号。
 *
 *   node server/create-admin.mjs admin 你的密码            # 建一个管理员
 *   node server/create-admin.mjs admin 新密码 --reset      # 已存在就重置口令
 *   node server/create-admin.mjs --list                    # 列出所有账号
 *
 * 内网第一次部署时跑一次即可；之后可以在网页里管理账号。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hashPassword, checkPasswordStrength } from './auth.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || join(here, 'db', 'reel.db')
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA foreign_keys = ON')

const args = process.argv.slice(2)

if (args.includes('--list')) {
  const rows = db.prepare('SELECT id, uid, nickname, role, status, last_login_at FROM users ORDER BY id').all()
  if (!rows.length) console.log('还没有任何账号，先运行：node server/create-admin.mjs <登录名> <密码>')
  for (const u of rows) {
    const last = u.last_login_at ? new Date(u.last_login_at * 1000).toLocaleString('zh-CN') : '从未登录'
    console.log(`#${u.id}  ${u.uid.padEnd(16)} ${u.nickname.padEnd(10)} ${u.role.padEnd(6)} ${u.status ? '启用' : '停用'}  最近登录：${last}`)
  }
  process.exit(0)
}

const [uid, password] = args.filter(a => !a.startsWith('--'))
const reset = args.includes('--reset')

if (!uid || !password) {
  console.error('用法：node server/create-admin.mjs <登录名> <密码> [--reset]')
  console.error('      node server/create-admin.mjs --list')
  process.exit(1)
}

const bad = checkPasswordStrength(password)
if (bad) {
  console.error('密码不合要求：' + bad)
  process.exit(1)
}

const existing = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid)

if (existing) {
  if (!reset) {
    console.error(`账号 ${uid} 已存在。要重置它的密码请加 --reset`)
    process.exit(1)
  }
  db.prepare('UPDATE users SET password_hash = ?, role = ?, status = 1 WHERE id = ?')
    .run(hashPassword(password), 'admin', existing.id)
  // 改密码后把旧会话全部作废
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id)
  console.log(`已重置管理员 ${uid} 的密码，并踢掉它的旧登录`)
} else {
  const t = Math.floor(Date.now() / 1000)
  const id = Number(db.prepare(`INSERT INTO users(uid, nickname, password_hash, role, created_at)
                                VALUES(?,?,?,?,?)`).run(uid, '管理员', hashPassword(password), 'admin', t).lastInsertRowid)
  db.prepare('INSERT INTO user_stats(user_id, updated_at) VALUES(?,?)').run(id, t)
  console.log(`已创建管理员：${uid}`)
  console.log('现在可以启动服务并用它登录：node server/index.mjs')
}
db.close()
