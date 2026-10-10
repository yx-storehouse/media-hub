/*
 * 地址比较：同一个文件的「编码」和「未编码」写法算同一个地址。
 *   /media/a b.mp4        ==  /media/a%20b.mp4
 *   /media/已有/old.webm  ==  /media/%E5%B7%B2%E6%9C%89/old.webm
 * 用在导入按播放地址查重、扫描导入的「已导入」、素材的「被 N 个视频使用」，三处规则一致。
 *
 * 库里存的是用户填的原样写法，比较时才规范化：先用 urlSpellings() 列出库里可能存的几种写法去查索引，
 * 再用 urlKey() 精确比对。
 */

const decodeSeg = s => { try { return decodeURIComponent(s) } catch { return s } }
const encodeSegs = path => path.split('/').map(encodeURIComponent).join('/')
const safeEncodeURI = s => { try { return encodeURI(s) } catch { return s } }

/** 拆成 [路径, ?查询串#片段] */
function splitUrl(url) {
  const s = String(url ?? '').trim()
  const cut = s.search(/[?#]/)
  return cut < 0 ? [s, ''] : [s.slice(0, cut), s.slice(cut)]
}

/** 路径逐段解码（解不开的段原样保留） */
const decodePath = path => path.split('/').map(decodeSeg).join('/')

/**
 * 比较用的键：路径部分逐段解码。
 * 站内 /media/ 地址再去掉 ?查询串 和 #片段（?v=123 这类缓存参数指的还是同一个文件）；
 * 外部地址保留查询串（签名、清晰度参数可能真的指向不同资源）。
 */
export function urlKey(url) {
  const [path, rest] = splitUrl(url)
  const decoded = decodePath(path)
  return decoded.startsWith('/media/') ? decoded : decoded + rest
}

/**
 * 库里可能存的几种路径写法（原样、全解码、逐段 encodeURIComponent（大写 / 小写十六进制）、encodeURI），去重，不含查询串。
 * 查库时按这些写法做前缀范围查找（带 ?v= 的也能命中），再用 urlKey() 过滤。
 */
export function urlSpellings(url) {
  const s = String(url ?? '').trim()
  if (!s) return []
  const [path] = splitUrl(s)
  const decoded = decodePath(path)
  // http(s)://host 部分不编码，只编码后面的路径
  const m = decoded.match(/^(https?:\/\/[^/]*)(.*)$/i)
  const head = m ? m[1] : '', tail = m ? m[2] : decoded
  const encoded = head + encodeSegs(tail)
  const lower = encoded.replace(/%[0-9A-F]{2}/g, x => x.toLowerCase())
  return [...new Set([path, decoded, encoded, lower, safeEncodeURI(decoded)])].filter(Boolean)
}
