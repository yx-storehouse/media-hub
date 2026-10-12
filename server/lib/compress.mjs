/*
 * 响应压缩：按请求头 Accept-Encoding 选 br / gzip，只压文本类（JSON、HTML、JS、CSS、SVG…）。
 *
 *   接口 JSON 每次现压：brotli 用低档（4），几十 KB 的列表 1 ms 左右；放在 zlib 线程池里，不卡事件循环。
 *   打包好的前端文件（dist/）压一次就记住，按「路径 + 大小 + 修改时间」区分版本，重新打包后自动换新。
 */
import { brotliCompress, gzip, constants as Z } from 'node:zlib'

/* 小于这个字节数不压：省下的流量还不够头部开销 */
export const MIN_COMPRESS_BYTES = 1024

const TEXT_TYPE = /^(application\/(json|javascript|manifest\+json)|text\/|image\/svg\+xml)/

/** 这种 content-type 值得压缩 */
export const compressible = type => TEXT_TYPE.test(String(type || ''))

/**
 * 从 Accept-Encoding 里挑一个：br 优先，其次 gzip；都不接受（或 q=0）时返回 null。
 * 例：'gzip, deflate, br' → 'br'；'gzip;q=1, br;q=0' → 'gzip'；'*' → 'br'
 */
export function pickEncoding(header) {
  const accepted = new Map()
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    const qp = params.map(p => p.trim()).find(p => p.startsWith('q='))
    const q = qp ? Number(qp.slice(2)) : 1
    accepted.set(name.trim(), Number.isFinite(q) ? q : 0)
  }
  const ok = name => (accepted.has(name) ? accepted.get(name) > 0 : (accepted.get('*') ?? 0) > 0)
  if (ok('br')) return 'br'
  if (ok('gzip')) return 'gzip'
  return null
}

/** 压缩一段内容（Buffer / 字符串），quality 只对 brotli 生效 */
export function compress(body, encoding, { quality = 4 } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  return new Promise((resolve, reject) => {
    const done = (err, out) => (err ? reject(err) : resolve(out))
    if (encoding === 'br') {
      brotliCompress(buf, {
        params: {
          [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT,
          [Z.BROTLI_PARAM_QUALITY]: quality,
          [Z.BROTLI_PARAM_SIZE_HINT]: buf.length
        }
      }, done)
    } else {
      gzip(buf, { level: 6 }, done)
    }
  })
}

/* 静态文件的压缩结果：key = 路径|大小|修改时间|编码；dist 不大，总量封顶后按最早放进来的先丢 */
const STATIC_CACHE_MAX_BYTES = 64 * 1024 * 1024
const staticCache = new Map()
let staticBytes = 0

/** 压缩静态文件并记住结果（同一个版本只压一次，用较高的 brotli 档位） */
export async function compressStatic(key, body, encoding) {
  const k = key + '|' + encoding
  const hit = staticCache.get(k)
  if (hit) return hit
  const out = await compress(body, encoding, { quality: 9 })
  staticCache.set(k, out)
  staticBytes += out.length
  while (staticBytes > STATIC_CACHE_MAX_BYTES && staticCache.size > 1) {
    const [oldKey, old] = staticCache.entries().next().value
    staticCache.delete(oldKey)
    staticBytes -= old.length
  }
  return out
}
