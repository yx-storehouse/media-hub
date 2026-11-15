/*
 * 把占位图换回内联写法：退回老版本服务端之前跑一次（回滚用）。
 *
 * 这一版服务端第一次启动时，把行里内联的 SVG 占位图挪进 art_blobs 表，行里只留短地址 url(/api/art/<哈希>.svg)
 * （见 lib/art-store.mjs）。老版本（52ac38d 及以前）没有 /api/art 这个接口：只把代码退回去的话，
 * 没有真封面的视频、帖子图只剩深色块，没有头像的创作者是空圈。这个脚本把这几列里的短地址按 art_blobs
 * 换回原来的 url('data:image/svg+xml;utf8,…')，和迁移前逐字节一样，老版本照常显示：
 *
 *   node server/inline-art.mjs                    # 库取 DB_PATH（默认 server/db/reel.db）
 *   node server/inline-art.mjs --check            # 只数一数有多少行要换，不改
 *   docker exec reel node server/inline-art.mjs   # 线上：在新版本的容器里跑（镜像里有这个脚本）
 *   docker exec -i reel node --input-type=module - < server/inline-art.mjs   # 容器已经是老镜像时，用仓库里这份喂进去
 *
 * 回滚的完整顺序见 server/README.md「启动时的自动补建 → 回滚到老版本」。
 *   - 只改下面 COLUMNS 里这几列、并且是短地址的行；art_blobs 表留着（老版本不认识它，也不碍事），别的数据不动。
 *   - 可以重复执行（已经是内联的跳过）；服务开着也能跑（每 500 行一个小事务，别的进程照常读写）。
 *   - 新版本再启动时又会挪回 art_blobs，所以跑完以后直接换成老版本启动，不要再起新版本。
 *   - art_blobs 里找不到的短地址（不该有）原样留着，最后报出条数。
 * 不引仓库里别的文件（同 backup-db.mjs）：老镜像里也能用 stdin 喂进去跑。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/* 与 lib/art-store.mjs 的 ART_COLUMNS 一致（test-api 核对两边一样） */
const COLUMNS = [
  ['videos', 'cover_fallback'],
  ['post_media', 'fallback'],
  ['topic_covers', 'fallback'],
  ['live_rooms', 'cover_fallback'],
  ['places', 'cover_fallback'],
  ['creators', 'avatar_fallback']
]
/* 短地址的写法（lib/art-store.mjs 的 artRef）和内联的写法（lib/art.mjs 的 svgUrl） */
const REF = /^url\(\/api\/art\/([0-9a-f]{16})\.svg\)$/
const inline = svg => "url('data:image/svg+xml;utf8," + encodeURIComponent(svg).replace(/'/g, '%27') + "')"
const CHUNK = 500

const here = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || join(here, 'db', 'reel.db')
const checkOnly = process.argv.includes('--check')

if (!existsSync(DB_PATH)) {
  console.error(`找不到数据库：${DB_PATH}（用 DB_PATH 指定）`)
  process.exit(1)
}
const db = new DatabaseSync(DB_PATH)
// 服务开着时它偶尔在写：每个小事务最多等 5 秒
db.exec('PRAGMA busy_timeout = 5000')
const has = name => !!db.prepare("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

if (!has('art_blobs')) {
  console.log('库里没有 art_blobs 表：占位图本来就是内联的，不用换')
  process.exit(0)
}
const svgOf = db.prepare('SELECT svg FROM art_blobs WHERE hash = ?')
let total = 0, missing = 0
for (const [table, col] of COLUMNS) {
  if (!has(table)) continue
  // 短地址都以 url(/api/art/ 开头：按 rowid 分块往后扫，每块一个事务
  const pick = db.prepare(`SELECT rowid AS rid, ${col} AS v FROM ${table}
                           WHERE rowid > ? AND substr(${col}, 1, 13) = 'url(/api/art/' ORDER BY rowid LIMIT ?`)
  const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ? AND ${col} = ?`)
  let last = 0, n = 0
  for (;;) {
    const rows = pick.all(last, CHUNK)
    if (!rows.length) break
    last = rows.at(-1).rid
    if (!checkOnly) db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        const m = REF.exec(r.v)
        const svg = m && svgOf.get(m[1])?.svg
        if (!svg) { missing++; continue }
        if (!checkOnly) upd.run(inline(svg), r.rid, r.v)
        n++
      }
      if (!checkOnly) db.exec('COMMIT')
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw e
    }
  }
  console.log(`${table}.${col}：${checkOnly ? '要换' : '换回'} ${n} 行`)
  total += n
}
db.close()
console.log(checkOnly
  ? `一共 ${total} 行是短地址，去掉 --check 再跑一次就换回内联写法`
  : total ? `已把 ${total} 行占位图换回内联写法，现在可以换成老版本的服务端启动了` : '没有要换的行（已经都是内联的）')
if (missing) {
  console.warn(`有 ${missing} 行的短地址在 art_blobs 里找不到，原样留着（老版本上这几行没有占位图）`)
  process.exit(2)
}
