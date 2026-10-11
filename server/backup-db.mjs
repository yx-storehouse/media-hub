/*
 * 备份数据库：把当前库完整导出成一个独立文件（VACUUM INTO，运行中也能安全备份），并只保留最近 N 份。
 *
 *   node server/backup-db.mjs                     # 备份到 server/db/backups，保留 10 份
 *   node server/backup-db.mjs /data/backups 20    # 指定目录和保留份数（容器里部署前就是这样调用的）
 *
 * 源库取 DB_PATH（默认 server/db/reel.db），只读打开，不会改动它。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || join(here, 'db', 'reel.db')
const dir = resolve(process.argv[2] || join(here, 'db', 'backups'))
const keep = Math.max(1, Number(process.argv[3]) || 10)

if (!existsSync(DB_PATH)) {
  console.log(`没有数据库可备份：${DB_PATH}`)
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
const p = n => String(n).padStart(2, '0')
const d = new Date()
const file = join(dir, `reel-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`)

const db = new DatabaseSync(DB_PATH, { readOnly: true })
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
db.close()
console.log(`已备份：${file}`)

// 文件名里是时间，按名字倒序就是从新到旧
const old = readdirSync(dir).filter(f => /^reel-\d{8}-\d{6}\.db$/.test(f)).sort().reverse().slice(keep)
for (const f of old) rmSync(join(dir, f))
if (old.length) console.log(`清理旧备份 ${old.length} 份（保留最近 ${keep} 份）`)
