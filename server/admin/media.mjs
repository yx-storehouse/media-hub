/*
 * 素材文件夹（MEDIA_DIR，默认项目根目录下的 media/）。
 *
 *   - GET/HEAD /media/<path>   公开的静态访问，支持 Range（<video> 拖进度条要用），不需要登录：
 *                              <video>/<img> 带不了 Bearer 令牌，内网可以接受，README 里写明了
 *   - /api/admin/media*        列目录、流式上传、新建文件夹、删除、扫描入库（仅管理员）
 *
 * 只允许视频 / 图片 / 字幕这几类扩展名，上传和访问都卡住，避免有人传个 .html / .js 当网页执行。
 */
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { stat, readdir, mkdir, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative, extname, basename, sep } from 'node:path'
import { InputError } from '../lib/errors.mjs'
import { urlKey, urlSpellings } from '../lib/urls.mjs'
import * as A from '../db/admin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const MEDIA_DIR = resolve(process.env.MEDIA_DIR || join(here, '..', '..', 'media'))
const MB = 1024 * 1024
const MAX_UPLOAD_BYTES = Math.floor((Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 8192) * MB)
/* 上传时这么久收不到数据就中止并删掉临时文件（客户端卡死、断网没发 FIN 的情况） */
const UPLOAD_IDLE_MS = Math.round((Number(process.env.UPLOAD_IDLE_SEC) > 0 ? Number(process.env.UPLOAD_IDLE_SEC) : 60) * 1000)
/* 上传临时文件（*.part）超过这么久没动过，就当作中断后留下的垃圾 */
const STALE_PART_MS = 10 * 60 * 1000

const VIDEO_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.ogv': 'video/ogg', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t'
}
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif'
}
const EXTRA_TYPES = { '.vtt': 'text/vtt; charset=utf-8', '.srt': 'text/plain; charset=utf-8' }
const MIME = { ...VIDEO_TYPES, ...IMAGE_TYPES, ...EXTRA_TYPES }
/* 同名封面的优先顺序 */
const COVER_EXTS = ['.jpg', '.jpeg', '.png', '.webp']

const fail = (message, field) => { throw new InputError(message, field) }
const extOf = name => extname(name).toLowerCase()
const kindOf = name => (VIDEO_TYPES[extOf(name)] ? 'video' : IMAGE_TYPES[extOf(name)] ? 'image' : 'other')
/** 列表里不显示：隐藏文件、上传中的临时文件 */
const hidden = name => name.startsWith('.') || name.toLowerCase().endsWith('.part')
/** 本服务自己的临时文件：上传中的 <名字>.<8 位随机>.part、覆盖时挪开的 <名字>.<8 位随机>.old.part（自动清理只认这两种） */
const isOurPart = name => /\.[0-9a-f]{8}(?:\.old)?\.part$/i.test(name)

/** 启动时建好 media/ 和常用子目录，并在后台清掉上次中断留下的旧临时文件 */
export function ensureMediaDir() {
  try {
    for (const d of ['', 'videos', 'covers', 'images']) mkdirSync(join(MEDIA_DIR, d), { recursive: true })
  } catch (e) {
    console.warn('无法创建素材目录', MEDIA_DIR, e.message)
  }
  sweepStaleParts().then(n => { if (n) console.log(`清理上传中断留下的临时文件 ${n} 个`) }, () => {})
}

/**
 * 删除 MEDIA_DIR 下超过 10 分钟没动过的本服务临时文件（进程被杀、断电时上传到一半的 *.part）。
 * 列表里看不到它们，却会让文件夹删不掉。只看修改时间够旧的：同一目录若被别的进程用着，正在传的不会误删。
 */
async function sweepStaleParts() {
  let removed = 0, seen = 0
  const cutoff = Date.now() - STALE_PART_MS
  const walk = async abs => {
    let dirents
    try { dirents = await readdir(abs, { withFileTypes: true }) } catch { return }
    for (const d of dirents) {
      if (++seen > MAX_STAT_ENTRIES) return
      const p = join(abs, d.name)
      if (d.isDirectory()) await walk(p)
      else if (d.isFile() && isOurPart(d.name)) {
        try {
          if ((await stat(p)).mtimeMs < cutoff) { await rm(p, { force: true }); removed++ }
        } catch { /* 删不掉就下次再说 */ }
      }
    }
  }
  await walk(MEDIA_DIR)
  return removed
}

/* ---------------- 路径 ---------------- */

/** 站内地址：每段 encodeURIComponent，中文和空格也能直接放进 <video src> */
export const urlOf = rel => '/media/' + rel.split('/').map(encodeURIComponent).join('/')
const relOf = abs => relative(MEDIA_DIR, abs).split(sep).join('/')
const inside = abs => abs === MEDIA_DIR || abs.startsWith(MEDIA_DIR + sep)

/**
 * 规范化相对路径（POSIX，/ 分隔，不带开头的 /）。
 *   strict = 要新建的名字：额外禁止 .. 子串、Windows 保留字符 / 保留名、首尾点和空格、超过 200 字节
 *   否则   = 引用已有文件：只挡 . / ..、控制字符、反斜杠和冒号（NTFS 备用数据流）
 */
function cleanRel(input, field, { strict = false, required = false } = {}) {
  const s = String(input ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!s) {
    if (required) fail('路径不能为空', field)
    return ''
  }
  if (s.includes('\\')) fail('路径请用 / 分隔', field)
  const segs = s.split('/')
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') fail('路径不正确', field)
    if (/[\u0000-\u001f\u007f:]/.test(seg)) fail('路径包含非法字符', field)
    if (strict) {
      if (seg.includes('..')) fail('名称不能包含 ..', field)
      if (/[<>"|?*]/.test(seg)) fail('名称不能包含 < > : " | ? * 这些字符', field)
      if (Buffer.byteLength(seg) > 200) fail('名称过长（最多 200 字节）', field)
      if (/^[. ]|[. ]$/.test(seg)) fail('名称不能以点或空格开头 / 结尾', field)
      if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(seg)) fail(`「${seg}」是系统保留名称`, field)
    }
  }
  return segs.join('/')
}

function absOf(rel, field = 'path') {
  const abs = rel ? resolve(MEDIA_DIR, ...rel.split('/')) : MEDIA_DIR
  if (!inside(abs)) fail('路径不正确', field)
  return abs
}

const exists = async p => { try { await stat(p); return true } catch { return false } }

/** name.ext 已存在 → name (1).ext、name (2).ext …（调用方要在 withDirLock 里用，查和占名之间才不会被插队） */
async function uniquePath(abs) {
  if (!await exists(abs)) return abs
  const ext = extname(abs), base = basename(abs, ext), dir = dirname(abs)
  for (let n = 1; n < 10000; n++) {
    const p = join(dir, `${base} (${n})${ext}`)
    if (!await exists(p)) return p
  }
  fail('同名文件太多，请换个文件名')
}

/**
 * 一批文件各被多少个视频引用（播放地址或封面；编码 / 未编码 / 带 ?v= 缓存参数都算同一个文件），一次查询。
 * 比较规则和导入查重、扫描「已导入」一样（lib/urls.mjs）。同一个视频既用作播放又用作封面只算一次。
 */
function usage(paths) {
  const keyToPath = new Map()
  const spellings = new Set()
  for (const p of paths) {
    const url = urlOf(p)
    keyToPath.set(urlKey(url), p)
    for (const s of urlSpellings(url)) spellings.add(s)
  }
  const users = new Map()
  if (!keyToPath.size) return new Map()
  for (const v of A.videosByUrlSpellings([...spellings], { playback: true, cover: true })) {
    const p = keyToPath.get(urlKey(v.url))
    if (!p) continue
    if (!users.has(p)) users.set(p, new Set())
    users.get(p).add(v.id)
  }
  return new Map([...users].map(([p, ids]) => [p, ids.size]))
}

/* ---------------- 静态访问 /media/* ---------------- */

function sendJson(res, status, message, extra = {}) {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...extra
  })
  res.end(JSON.stringify({ code: 1, message }))
}

/** 只认单段 Range；多段 / 写法不对的忽略（按 RFC 回整个文件），越界返回 'unsatisfiable' */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (m[2] !== '' && Number(m[2]) < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end }
}

/** 条件请求：If-None-Match（可带多个、弱比较）优先；没有时看 If-Modified-Since（秒级） */
function notModified(req, etag, mtimeMs) {
  const inm = req.headers['if-none-match']
  if (inm) {
    const bare = etag.replace(/^W\//, '')
    return inm.split(',').some(t => {
      const v = t.trim()
      return v === '*' || v === etag || v.replace(/^W\//, '') === bare
    })
  }
  const ims = Date.parse(req.headers['if-modified-since'] || '')
  return Number.isFinite(ims) && Math.floor(mtimeMs / 1000) <= Math.floor(ims / 1000)
}

/**
 * GET / HEAD /media/<path>：pathname 已经 decodeURIComponent 过。
 * 解析后跑出 MEDIA_DIR 的一律 403（/media/..%2f..%2fserver%2findex.mjs 这类）。
 */
export async function serveMedia(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, '素材文件只支持 GET / HEAD', { allow: 'GET, HEAD' })
  const rel = pathname.replace(/^\/media\/?/, '')
  if (!rel || rel.includes('\0')) return sendJson(res, 404, '文件不存在')
  const abs = resolve(MEDIA_DIR, rel)
  if (!abs.startsWith(MEDIA_DIR + sep)) return sendJson(res, 403, '禁止访问')
  const type = MIME[extOf(abs)]
  if (!type) return sendJson(res, 403, '不支持的文件类型')

  let st
  try { st = await stat(abs) } catch { return sendJson(res, 404, '文件不存在') }
  if (!st.isFile()) return sendJson(res, 404, '文件不存在')

  const size = st.size
  const etag = `W/"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    // 图片每次都向服务器确认一下（没变就是很便宜的 304）：重新截取的封面写回同一个地址（covers/v<id>.jpg）也能马上看到；
    // 视频等大文件缓存 5 分钟
    'cache-control': IMAGE_TYPES[extOf(abs)] ? 'no-cache' : 'public, max-age=300',
    'last-modified': st.mtime.toUTCString(),
    etag,
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*'
  }
  if (!req.headers.range && notModified(req, etag, st.mtimeMs)) {
    res.writeHead(304, headers)
    return res.end()
  }

  // If-Range 对不上（文件已经变了）就忽略 Range，回整个文件
  const ifRange = req.headers['if-range']
  const range = req.headers.range && (!ifRange || ifRange === etag || ifRange === headers['last-modified'])
    ? parseRange(req.headers.range, size) : null
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 })
    return res.end()
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  const length = size === 0 ? 0 : end - start + 1
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'content-length': length,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
  })
  if (req.method === 'HEAD' || length === 0) return res.end()
  try {
    await pipeline(createReadStream(abs, { start, end }), res)
  } catch {
    // 播放器拖进度条时会主动断开上一个请求，属于正常情况
    if (!res.destroyed) res.destroy()
  }
}

/* ---------------- 列目录 ---------------- */

export async function listMedia(q = {}) {
  const rel = cleanRel(q.dir, 'dir')
  const abs = absOf(rel, 'dir')
  let dirents
  try {
    dirents = await readdir(abs, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') fail('文件夹不存在', 'dir')
    throw e
  }
  const entries = (await Promise.all(dirents.filter(d => !hidden(d.name)).map(async d => {
    const p = rel ? `${rel}/${d.name}` : d.name
    let st
    try { st = await stat(join(abs, d.name)) } catch { return null }
    const isDir = st.isDirectory()
    if (!isDir && !st.isFile()) return null
    return {
      name: d.name, path: p, type: isDir ? 'dir' : kindOf(d.name), size: isDir ? 0 : st.size,
      mtime: Math.floor(st.mtimeMs / 1000), url: urlOf(p), usedBy: 0
    }
  }))).filter(Boolean)

  const counts = usage(entries.filter(e => e.type !== 'dir').map(e => e.path))
  for (const e of entries) e.usedBy = counts.get(e.path) || 0
  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1)
  return { dir: rel, parent: rel ? rel.split('/').slice(0, -1).join('/') : null, entries }
}

/* ---------------- 上传（PUT 原始字节流） ---------------- */

const tooLarge = () => {
  const e = new InputError(`文件太大，单个文件最大 ${Math.round(MAX_UPLOAD_BYTES / MB)} MB`)
  e.status = 413
  return e
}
const withStatus = (message, status) => Object.assign(new InputError(message), { status })

/**
 * 把请求体流式写进临时文件：边收边计数，超限立即停写并删掉临时文件；
 * 客户端中途断开、或 UPLOAD_IDLE_MS 内收不到数据，也删掉。写完并关闭文件句柄后才 resolve（Windows 上没关句柄不能改名）。
 */
function receive(req, file, max) {
  return new Promise((resolvePromise, reject) => {
    // 进来之前连接就已经断了（mkdir 期间客户端发了一点就关）：data / aborted / close 都已经触发过、不会再来，
    // 这时再建文件就会留下一个永远开着的写句柄和永远不结束的请求，直接按「已取消」处理
    if (req.destroyed || req.readableAborted) return reject(withStatus('上传已取消', 400))
    const ws = createWriteStream(file, { flags: 'wx' })
    let bytes = 0, done = false, idle = null
    const removePart = () => rm(file, { force: true }).catch(() => {})
    const finish = err => {
      if (done) return
      done = true
      clearTimeout(idle)
      if (!err) return resolvePromise(bytes)
      req.resume()                       // 剩下的数据照收照扔，让 413 能正常回给客户端
      ws.destroy()
      const cleanup = () => removePart().finally(() => reject(err))
      if (ws.closed) cleanup()
      else ws.once('close', cleanup)
    }
    const aborted = () => finish(withStatus('上传已取消', 400))
    // 收不到数据的计时：每来一块数据 / 磁盘写完一批就重新计时；是我们自己在等磁盘（背压暂停）时不算客户端卡住
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => {
        if (done) return
        if (req.isPaused()) return arm()
        finish(withStatus(`上传超时：${Math.round(UPLOAD_IDLE_MS / 1000)} 秒没有收到数据，已取消`, 408))
        req.destroy()                    // 卡住的连接不再等它
      }, UPLOAD_IDLE_MS)
    }
    arm()
    req.on('data', chunk => {
      if (done) return
      arm()
      bytes += chunk.length
      if (bytes > max) return finish(tooLarge())
      if (!ws.write(chunk)) {
        req.pause()
        ws.once('drain', () => { if (!done) { arm(); req.resume() } })
      }
    })
    req.on('end', () => { if (!done) { clearTimeout(idle); ws.end() } })
    req.on('aborted', aborted)
    req.on('close', () => { if (!req.complete) aborted() })
    req.on('error', aborted)
    ws.on('error', e => finish(e))
    ws.on('close', () => { if (!done && ws.writableFinished) finish(null) })
  })
}

/*
 * 同一文件夹里「定名字 + 改名到位」串行执行（服务是单进程）：
 * 两个同名上传同时收完，也不会都查到「这个名字空着」然后后一个把前一个覆盖掉。
 * Windows 文件名不区分大小写，键也不区分。
 */
const dirLocks = new Map()
async function withDirLock(dir, fn) {
  const key = sep === '\\' ? dir.toLowerCase() : dir
  const prev = dirLocks.get(key) || Promise.resolve()
  let release
  const mine = new Promise(r => { release = r })
  const tail = prev.then(() => mine)
  dirLocks.set(key, tail)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (dirLocks.get(key) === tail) dirLocks.delete(key)
  }
}

/** 删旧文件：被占用时（Windows）稍后重试几次；实在删不掉留给启动时的临时文件清理 */
function removeLater(file, tries = 5) {
  unlink(file).catch(e => {
    if (e.code !== 'ENOENT' && tries > 1) setTimeout(() => removeLater(file, tries - 1), 2000).unref()
  })
}

/**
 * 临时文件改名到位。覆盖时先把旧文件挪到隐藏的临时名，再把新文件改过去，最后删旧文件：
 * Windows 上旧文件正被播放（有读句柄）时直接覆盖会失败，但挪开 / 删除是允许的（Node 打开文件时带 FILE_SHARE_DELETE）。
 */
async function moveInto(part, target, overwrite) {
  let aside = null
  if (overwrite) {
    let st = null
    try { st = await stat(target) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (st?.isDirectory()) throw Object.assign(new Error('目标是文件夹'), { code: 'EISDIR' })
    if (st) {
      aside = `${target}.${randomBytes(4).toString('hex')}.old.part`
      await rename(target, aside)
    }
  }
  try {
    await rename(part, target)
  } catch (e) {
    if (aside) await rename(aside, target).catch(() => {})   // 放回旧文件
    throw e
  }
  if (aside) removeLater(aside)
}

/** PUT /api/admin/media/upload?path=videos/a.mp4&overwrite=0|1 */
export async function upload(req, q = {}) {
  const rel = cleanRel(q.path, 'path', { strict: true, required: true })
  if (!MIME[extOf(rel)]) fail(`不支持的文件类型「${extOf(rel) || '无扩展名'}」，只能上传视频、图片或字幕文件`, 'path')
  const overwrite = q.overwrite === '1' || q.overwrite === 'true'
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw tooLarge()

  const abs = absOf(rel)
  try {
    await mkdir(dirname(abs), { recursive: true })
  } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'ENOTDIR') fail('上级路径里有同名文件，不能当作文件夹', 'path')
    throw e
  }
  const part = `${abs}.${randomBytes(4).toString('hex')}.part`
  const size = await receive(req, part, MAX_UPLOAD_BYTES)
  if (size === 0) {
    await rm(part, { force: true })
    fail('文件是空的', 'path')
  }
  // 名字在收完之后再定，并且「查重名 + 改名」在文件夹锁里一次做完：同时上传的同名文件各自得到不同的名字，不会互相覆盖
  let target
  try {
    target = await withDirLock(dirname(abs), async () => {
      const t = overwrite ? abs : await uniquePath(abs)
      await moveInto(part, t, overwrite)
      return t
    })
  } catch (e) {
    await rm(part, { force: true }).catch(() => {})
    if (e instanceof InputError) throw e
    if (['EPERM', 'EBUSY', 'EACCES', 'EISDIR', 'ENOTEMPTY'].includes(e.code)) fail('目标文件正在被使用或是文件夹，换个名字或稍后再试', 'path')
    throw e
  }
  const finalRel = relOf(target)
  return { path: finalRel, url: urlOf(finalRel), size }
}

/* ---------------- 新建文件夹 / 删除 ---------------- */

export async function createFolder(body = {}) {
  const rel = cleanRel(body?.path, 'path', { strict: true, required: true })
  const abs = absOf(rel)
  try {
    await mkdir(abs, { recursive: true })
  } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'ENOTDIR') fail('已有同名文件', 'path')
    throw e
  }
  return { path: rel, url: urlOf(rel) }
}

/** DELETE /api/admin/media?path=&force=0|1：删文件或空文件夹；被视频引用的文件默认不让删 */
export async function deleteMedia(q = {}) {
  const rel = cleanRel(q.path, 'path', { required: true })
  const abs = absOf(rel)
  let st
  try { st = await stat(abs) } catch { fail('文件不存在', 'path') }
  try {
    if (st.isDirectory()) {
      await removeDir(abs)
    } else {
      const n = usage([rel]).get(rel) || 0
      if (n > 0 && q.force !== '1' && q.force !== 'true') fail(`该文件被 ${n} 个视频使用`, 'usedBy')
      await unlink(abs)
    }
  } catch (e) {
    if (e instanceof InputError) throw e
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') fail('文件夹不为空，请先删除里面的文件', 'path')
    if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') fail('文件正在被使用，请稍后再试', 'path')
    throw e
  }
  return { ok: true }
}

/**
 * 删空文件夹。列表里看着是空的、其实只剩隐藏文件时：上传中断留下的旧临时文件（*.part）顺手清掉再删；
 * 还有别的隐藏文件就说清楚是什么，免得用户对着一个「空」文件夹删不掉。
 */
async function removeDir(abs) {
  try {
    return await rmdir(abs)
  } catch (e) {
    if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e
    const names = await readdir(abs)
    if (names.some(n => !hidden(n))) throw e
    const cutoff = Date.now() - STALE_PART_MS
    for (const n of names.filter(isOurPart)) {
      const ps = await stat(join(abs, n)).catch(() => null)
      if (ps?.isFile() && ps.mtimeMs < cutoff) await rm(join(abs, n), { force: true }).catch(() => {})
    }
    try {
      return await rmdir(abs)
    } catch (e2) {
      if (e2.code !== 'ENOTEMPTY' && e2.code !== 'EEXIST') throw e2
      const rest = await readdir(abs).catch(() => [])
      if (rest.some(isOurPart)) fail('文件夹里有正在上传的文件，请稍后再试', 'path')
      fail(`文件夹里还有隐藏文件（${rest.slice(0, 3).join('、')}${rest.length > 3 ? ' 等' : ''}），请在服务器上手动删除`, 'path')
    }
  }
}

/* ---------------- 扫描入库 ---------------- */

const MAX_SCAN_FILES = 5000
const MAX_SCAN_DEPTH = 8

/** 文件名 → 标题：去扩展名，_ 和 . 换成空格 */
const titleOf = name => basename(name, extname(name)).replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim() || name

/**
 * POST /api/admin/media/scan { dir, recursive }：列出视频文件，带同名封面和「是否已入库」
 */
export async function scanMedia(body = {}) {
  const root = cleanRel(body?.dir, 'dir')
  const recursive = body?.recursive !== false
  const rootAbs = absOf(root, 'dir')
  try {
    if (!(await stat(rootAbs)).isDirectory()) fail('文件夹不存在', 'dir')
  } catch (e) {
    if (e instanceof InputError) throw e
    fail('文件夹不存在', 'dir')
  }

  const files = []
  let truncated = false
  const walk = async (rel, abs, depth) => {
    let dirents
    try { dirents = await readdir(abs, { withFileTypes: true }) } catch { return }
    const names = dirents.filter(d => !hidden(d.name))
    // 同名图片 = 封面：a.mp4 配 a.jpg / a.jpeg / a.png / a.webp（文件名不区分大小写）
    const images = new Map()
    for (const d of names) {
      if (d.isFile() && COVER_EXTS.includes(extOf(d.name))) {
        const key = basename(d.name, extname(d.name)).toLowerCase()
        const prev = images.get(key)
        if (!prev || COVER_EXTS.indexOf(extOf(d.name)) < COVER_EXTS.indexOf(extOf(prev))) images.set(key, d.name)
      }
    }
    for (const d of names) {
      if (files.length >= MAX_SCAN_FILES) { truncated = true; return }
      const p = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (recursive && depth < MAX_SCAN_DEPTH) await walk(p, join(abs, d.name), depth + 1)
        continue
      }
      if (!d.isFile() || kindOf(d.name) !== 'video') continue
      let st
      try { st = await stat(join(abs, d.name)) } catch { continue }
      const img = images.get(basename(d.name, extname(d.name)).toLowerCase())
      files.push({
        path: p, url: urlOf(p), name: d.name, title: titleOf(d.name), size: st.size, mtime: Math.floor(st.mtimeMs / 1000),
        coverUrl: img ? urlOf(rel ? `${rel}/${img}` : img) : null, imported: false, videoId: null
      })
    }
  }
  await walk(root, rootAbs, 1)

  // 播放地址已在库里的标「已导入」：和导入查重同一套比较规则（编码 / 未编码 / 带 ?v= 都算同一个文件），
  // 所以勾上已导入的文件再导入也只会被跳过，不会重复建；对应多条时取 id 最小的，和导入查重一致
  const byKey = new Map(), spellings = new Set()
  for (const f of files) {
    byKey.set(urlKey(f.url), f)
    for (const s of urlSpellings(f.url)) spellings.add(s)
  }
  for (const v of A.videosByUrlSpellings([...spellings])) {
    const f = byKey.get(urlKey(v.url))
    if (f && !f.imported) { f.imported = true; f.videoId = v.id }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh'))
  return { files, truncated }
}

/* ---------------- 概览统计 ---------------- */

const MAX_STAT_ENTRIES = 20000

export async function mediaStats() {
  let dirExists = false
  try { dirExists = (await stat(MEDIA_DIR)).isDirectory() } catch { /* 目录不存在 */ }
  let files = 0, bytes = 0, seen = 0
  const walk = async abs => {
    let dirents
    try { dirents = await readdir(abs, { withFileTypes: true }) } catch { return }
    for (const d of dirents) {
      if (++seen > MAX_STAT_ENTRIES) return
      if (hidden(d.name)) continue
      const p = join(abs, d.name)
      if (d.isDirectory()) await walk(p)
      else if (d.isFile()) {
        try { bytes += (await stat(p)).size; files++ } catch { /* 刚被删掉 */ }
      }
    }
  }
  if (dirExists) await walk(MEDIA_DIR)
  return { files, bytes, dirExists }
}
