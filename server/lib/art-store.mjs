/*
 * 占位图仓库：生成的风景占位图（SVG）不再整段内联在接口 JSON 里。
 *
 * 以前每条视频 / 帖子图 / 专题头图的 fallback 是一整段 url('data:image/svg+xml;…')（种子数据 2–21 KB 一张）：
 * 列表 JSON 大十倍、手机上每追加一页都要同步解析十几个 SVG 文档、videos 表一半以上是占位图（扫表要顺着溢出页读）。
 * 现在 SVG 原文存进 art_blobs 表，行里只留一个按内容哈希的短地址：
 *
 *   url(/api/art/<16 位十六进制>.svg)          （约 37 字节）
 *
 * 前端 Cover 的 fallback 仍是 CSS background-image 的值，Cover.vue 不用改；画面和原来一模一样。
 * 同一张图浏览器只下载、解析一次（接口给一年 immutable 缓存），而且是异步加载，不再堵在追加列表的那一帧里。
 *
 * 用户头像（users.avatar_fallback）不搬；创作者头像搬（见下面 ART_COLUMNS）。
 * 这个文件不碰数据库连接本身：db/index.mjs 启动时、seed.mjs 建完种子数据后各调一次 moveInlineArt(db)。
 *
 * 这是启动迁移里唯一会改写已有行的一步（别的都是只增不删）：老版本服务端（52ac38d 及以前）没有 /api/art，
 * 只把代码退回去的话这些占位图都显示不出来。回滚前先跑 server/inline-art.mjs 把短地址换回内联写法
 * （逐字节还原；它不引本文件，列表 ART_COLUMNS 改了要一起改），步骤见 server/README.md「回滚到老版本」。
 */
import { createHash } from 'node:crypto'

/** 内联 SVG 占位图的写法（art.mjs / lite-art.mjs 的 svgUrl） */
const INLINE_HEAD = "url('data:image/svg+xml;utf8,"
const INLINE_TAIL = "')"

/** 占位图接口的路径前缀：GET /api/art/<hash>.svg */
export const ART_PREFIX = '/api/art/'
/** 地址里的哈希：sha1 前 16 位十六进制（64 位，几百万张也不会撞） */
export const ART_HASH = /^[0-9a-f]{16}$/

export const artHash = svg => createHash('sha1').update(svg).digest('hex').slice(0, 16)
/** 行里存的值（也就是接口下发的 fallback） */
export const artRef = hash => `url(${ART_PREFIX}${hash}.svg)`

/** 内联的 SVG 占位图 → SVG 原文；不是这种写法（已经是短地址、渐变、空）返回 null */
export function inlineSvg(value) {
  if (typeof value !== 'string' || !value.startsWith(INLINE_HEAD) || !value.endsWith(INLINE_TAIL)) return null
  try {
    const svg = decodeURIComponent(value.slice(INLINE_HEAD.length, -INLINE_TAIL.length))
    return svg.startsWith('<svg') ? svg : null
  } catch {
    return null
  }
}

/*
 * 要搬的列：[表, 列]。
 * 创作者头像（首字圆盘）也搬：每条视频都带着创作者头像，一页 20 条就是 20 份同样的 SVG。后台新建 / 改名时写的仍是内联的，
 * 下次启动时再搬（内联的照样能显示）。用户头像（users.avatar_fallback，可能是 App 传上来的）不动。
 */
export const ART_COLUMNS = [
  ['videos', 'cover_fallback'],
  ['post_media', 'fallback'],
  ['topic_covers', 'fallback'],
  ['live_rooms', 'cover_fallback'],
  ['places', 'cover_fallback'],
  ['creators', 'avatar_fallback']
]

/* 与 schema.sql 里的定义一致（老库由 moveInlineArt 补建） */
export const ART_TABLE_SQL = `CREATE TABLE IF NOT EXISTS art_blobs (
  id         INTEGER PRIMARY KEY,
  hash       TEXT    NOT NULL UNIQUE,
  svg        TEXT    NOT NULL,
  created_at INTEGER NOT NULL
)`

/* 一次挪走这么多字节的占位图才值得整理一次库（见 moveInlineArt 末尾） */
const COMPACT_BYTES = 1024 * 1024

const tableExists = (db, name) => !!db.prepare("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

/** 存一张 SVG（同样的内容只存一份），返回行里要存的短地址 */
export function storeArt(db, svg) {
  const hash = artHash(svg)
  db.prepare('INSERT OR IGNORE INTO art_blobs(hash, svg, created_at) VALUES(?,?,?)').run(hash, svg, Math.floor(Date.now() / 1000))
  return artRef(hash)
}

/**
 * 把内联在行里的 SVG 占位图挪进 art_blobs，行里换成短地址；返回挪了多少行。
 * 每 CHUNK 行一个事务（内存里最多同时放这么多张图），已经是短地址 / 渐变的行不动，重复执行没有副作用。
 * 第一次在大库上要把占位图整个读一遍、写一遍（5 万条视频约几秒），之后每次启动只是扫一遍这几列（行已经很小）。
 */
export function moveInlineArt(db, { chunk = 500, log = null, compact = true } = {}) {
  if (!tableExists(db, 'videos')) return 0
  db.exec(ART_TABLE_SQL)
  const ins = db.prepare('INSERT OR IGNORE INTO art_blobs(hash, svg, created_at) VALUES(?,?,?)')
  let moved = 0, movedBytes = 0
  for (const [table, col] of ART_COLUMNS) {
    if (!tableExists(db, table)) continue
    const pick = db.prepare(`SELECT rowid AS rid, ${col} AS v FROM ${table}
                             WHERE rowid > ? AND substr(${col}, 1, ${INLINE_HEAD.length}) = ? ORDER BY rowid LIMIT ?`)
    const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`)
    let last = 0
    for (;;) {
      const rows = pick.all(last, INLINE_HEAD, chunk)
      if (!rows.length) break
      const t = Math.floor(Date.now() / 1000)
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const r of rows) {
          last = r.rid
          const svg = inlineSvg(r.v)
          if (!svg) continue       // 解不开的原样留着（下次也只是再跳过）
          const hash = artHash(svg)
          ins.run(hash, svg, t)
          upd.run(artRef(hash), r.rid)
          moved++
          movedBytes += r.v.length
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    }
  }
  /*
   * 第一次挪完以后整理一次库（VACUUM）：行在原地变短，原来一页只放得下两三行的数据页还是那么多页、八成是空的，
   * 扫表照样要读那么多页。只在这一次挪走的占位图超过 COMPACT_BYTES 时做（之后后台新建创作者留下的几个内联头像不值得整理）。
   * 线上几百条视频的库不到 1 秒，5 万条视频的库约 10 秒（一次性），要临时多占一份库大小的磁盘。失败（比如磁盘满）不影响使用，只是库没变小。
   */
  let vacuumMs = null
  if (movedBytes >= COMPACT_BYTES && compact && !db.isTransaction) {
    const t = Date.now()
    try {
      db.exec('VACUUM')
      vacuumMs = Date.now() - t
    } catch (e) {
      console.warn('整理数据库（VACUUM）失败，不影响使用：', e.message)
    }
  }
  if (moved && log) log(moved, vacuumMs)
  return moved
}
