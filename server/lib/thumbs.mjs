/*
 * 缩略图地址：网格、头图横幅这类小格子用小图，原图只在全屏看大图时用。
 *
 *   thumbOf('/media/images/albums/a.jpg')   → '/media/images/albums/a.jpg.thumb.jpg'（素材目录里有这个文件时）
 *   thumbOf('https://picsum.photos/seed/x/1080/1440') → 'https://picsum.photos/seed/x/360/480'（按比例缩到长边 480）
 *   其余地址（外链、没有小图的素材）→ 原地址
 *
 * 小图由管理后台上传图片时在浏览器里生成（长边约 480、短边至少 360，长图的小图最多约 69 万像素，存成同目录下的 <原图完整文件名>.thumb.jpg，
 * 规则和 admin/media.mjs、src/admin/utils/imagePrep.js 的 thumbPathOf 一致），
 * 老图没有小图时照旧用原图，什么都不用迁移。是否存在按文件查，结果记 30 秒（新传的小图最多 30 秒后用上）。
 */
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
/* 与 admin/media.mjs 的 MEDIA_DIR 同一个规则（那边会顺带打开数据库，这里不引它） */
const MEDIA_DIR = resolve(process.env.MEDIA_DIR || join(here, '..', '..', 'media'))

/** 缩略图的长边（像素），和后台生成小图的尺寸一致 */
export const THUMB_EDGE = 480
const THUMB_SUFFIX = '.thumb.jpg'

/* picsum 的地址：/seed/<种子>/<宽>/<高>、/id/<编号>/<宽>/<高>、/<宽>/<高>（高可省，后面可带 .jpg / .webp、?查询串） */
const PICSUM = /^(https?:\/\/(?:fastly\.)?picsum\.photos\/(?:seed\/[^/?#]+\/|id\/\d+\/)?)(\d{1,5})(?:\/(\d{1,5}))?(\.(?:jpg|jpeg|webp))?([?#].*)?$/i

function picsumThumb(url) {
  const m = PICSUM.exec(url)
  if (!m) return null
  const w = Number(m[2]), h = Number(m[3] ?? m[2])
  if (!(w > 0 && h > 0) || Math.max(w, h) <= THUMB_EDGE) return url
  const k = THUMB_EDGE / Math.max(w, h)
  return `${m[1]}${Math.max(1, Math.round(w * k))}/${Math.max(1, Math.round(h * k))}${m[4] || ''}${m[5] || ''}`
}

/* 文件存在与否的短缓存：key = 磁盘路径 → { ok, at } */
const TTL_MS = 30_000
const MAX_ENTRIES = 20_000
const seen = new Map()

function fileExists(path) {
  const now = Date.now()
  const hit = seen.get(path)
  if (hit && now - hit.at < TTL_MS) return hit.ok
  let ok = false
  try { ok = statSync(path).isFile() } catch { ok = false }
  if (seen.size >= MAX_ENTRIES) seen.clear()
  seen.set(path, { ok, at: now })
  return ok
}

const decodeSeg = s => { try { return decodeURIComponent(s) } catch { return null } }

function mediaThumb(url) {
  const cut = url.search(/[?#]/)
  const path = cut < 0 ? url : url.slice(0, cut)
  const rest = cut < 0 ? '' : url.slice(cut)
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name.lastIndexOf('.') <= 0) return url                       // 没有扩展名的不是图片
  if (name.toLowerCase().endsWith(THUMB_SUFFIX)) return url        // 本身就是小图
  // 小图名字带着原图的扩展名（a.jpg → a.jpg.thumb.jpg）：同一个文件夹里的 a.jpg 和 a.png 各有各的小图
  const thumbPath = path + THUMB_SUFFIX
  const segs = thumbPath.slice('/media/'.length).split('/').map(decodeSeg)
  if (segs.some(s => s == null || s === '' || s === '.' || s === '..')) return url
  const file = join(MEDIA_DIR, ...segs)
  if (!file.startsWith(MEDIA_DIR + sep)) return url
  return fileExists(file) ? thumbPath + rest : url
}

/** 图片地址 → 小图地址（没有更小的就是原地址；空地址返回 null） */
export function thumbOf(url) {
  if (typeof url !== 'string' || !url) return null
  if (url.startsWith('/media/')) return mediaThumb(url)
  return picsumThumb(url) ?? url
}
