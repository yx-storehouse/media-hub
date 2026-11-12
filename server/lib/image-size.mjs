/*
 * 读图片文件头拿像素宽高（零依赖，多数图片只读开头 4 KB，最多几十 KB，不解码图片）。
 * 支持 PNG / JPEG / GIF / WebP（VP8 / VP8L / VP8X）/ AVIF；认不出或文件坏了返回 null。
 *
 * JPEG 带 EXIF 方向（手机竖拍常见的 5～8）时宽高对调：浏览器默认按 EXIF 摆正显示，App 拿到的比例才和看到的一致。
 * 用在图集：后台 / 导入只给了图片地址、没给宽高时，站内 /media/ 的文件由服务端补上宽高。
 */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

/* 先读文件开头这么多：PNG / GIF / WebP 的宽高就在最前面，JPEG 的 SOF 多数也在头几 KB；不够再按需往后读。
   导入几万张图时每张都读 64 KB 很费时间（见 admin/service.mjs 的 albumImageSizer） */
const HEAD_BYTES = 4 * 1024
/* AVIF 的 ispe、JPEG 的 EXIF 段最多看这么多 */
const SCAN_BYTES = 64 * 1024
/* JPEG 一段一段往后找 SOF；EXIF / ICC 段很大时也只读段头，最多看这么多段 */
const MAX_JPEG_SEGMENTS = 256

const ok = (width, height) => (Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? { width, height } : null)

function readAt(fd, pos, len) {
  const buf = Buffer.allocUnsafe(len)
  const n = readSync(fd, buf, 0, len, pos)
  return n === len ? buf : buf.subarray(0, n)
}

/** 按位置读：落在已经读进来的文件头里就直接切，不再读盘 */
const readerOf = (fd, head) => (pos, len) => (pos + len <= head.length ? head.subarray(pos, pos + len) : readAt(fd, pos, len))

/** EXIF（APP1 段的内容，从 'Exif\0\0' 开始）里的方向，没有为 1 */
function exifOrientation(seg) {
  if (seg.length < 14 || seg.toString('latin1', 0, 6) !== 'Exif\0\0') return 1
  const t = seg.subarray(6)
  const le = t.toString('latin1', 0, 2) === 'II'
  if (!le && t.toString('latin1', 0, 2) !== 'MM') return 1
  const u16 = p => (p + 2 <= t.length ? (le ? t.readUInt16LE(p) : t.readUInt16BE(p)) : 0)
  const u32 = p => (p + 4 <= t.length ? (le ? t.readUInt32LE(p) : t.readUInt32BE(p)) : 0)
  const ifd = u32(4)
  const n = u16(ifd)
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > t.length) break
    if (u16(e) === 0x0112) return u16(e + 8) || 1
  }
  return 1
}

function jpegSize(read, size) {
  let pos = 2
  let orientation = 1
  for (let k = 0; k < MAX_JPEG_SEGMENTS && pos + 4 <= size; k++) {
    const h = read(pos, 4)
    if (h.length < 4 || h[0] !== 0xff) return null
    const marker = h[1]
    // 填充字节 / 没有长度的标记
    if (marker === 0xff) { pos += 1; continue }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue }
    const len = h.readUInt16BE(2)
    if (len < 2) return null
    // SOF0～SOF15（除了 DHT C4、JPG C8、DAC CC）：[精度 1][高 2][宽 2]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const s = read(pos + 4, 5)
      if (s.length < 5) return null
      const height = s.readUInt16BE(1), width = s.readUInt16BE(3)
      return orientation >= 5 && orientation <= 8 ? ok(height, width) : ok(width, height)
    }
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(read(pos + 4, Math.min(len - 2, SCAN_BYTES)))
    if (marker === 0xda || marker === 0xd9) return null   // 到了图像数据 / 结尾还没见到 SOF
    pos += 2 + len
  }
  return null
}

/** AVIF / HEIF：在 meta 盒子里找 ispe（图像空间范围） */
function avifSize(b) {
  const at = b.indexOf('ispe', 0, 'latin1')
  if (at < 4 || at + 16 > b.length) return null
  return ok(b.readUInt32BE(at + 8), b.readUInt32BE(at + 12))
}

/** 按文件头判断格式并取宽高；b 是文件开头（最多 HEAD_BYTES） */
function sizeFromHead(fd, b, size) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') {
    return ok(b.readUInt32BE(16), b.readUInt32BE(20))
  }
  if (b.length >= 10 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) {
    return ok(b.readUInt16LE(6), b.readUInt16LE(8))
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(readerOf(fd, b), size)
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16)
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21)
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1)
    return null
  }
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^(avif|avis|heic|heix|mif1)$/.test(b.toString('latin1', 8, 12))) {
    // ispe 在 meta 盒子里，通常就在头几百字节；开头没找到再读到 SCAN_BYTES 找一遍
    return avifSize(b) || (b.length < size && b.length < SCAN_BYTES ? avifSize(readAt(fd, 0, Math.min(SCAN_BYTES, size))) : null)
  }
  return null
}

/** 文件 → { width, height } | null（文件不存在、读不了、格式认不出都返回 null，不抛错） */
export function imageSize(file) {
  let fd = null
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const head = readAt(fd, 0, Math.min(HEAD_BYTES, size))
    return sizeFromHead(fd, head, size)
  } catch {
    return null
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* 已经关了 */ }
  }
}
