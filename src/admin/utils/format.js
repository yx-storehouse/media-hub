/*
 * 显示格式化（后台各页面共用）。时间参数都是 unix 秒；空值统一显示「—」。
 */
const p2 = n => String(n).padStart(2, '0')
const EMPTY = '—'
const toDate = ts => (ts == null || ts === '' || !Number.isFinite(Number(ts)) || Number(ts) <= 0 ? null : new Date(Number(ts) * 1000))

/** 2026-10-10 14:03 */
export function fmtDate(ts) {
  const d = toDate(ts)
  if (!d) return EMPTY
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * 表格里的短日期：今年的显示「10-10 14:03」，其他年份显示「2025-12-31」。
 * 完整时间放进 title 提示：<span :title="fmtDate(v)">{{ fmtShortDate(v) }}</span>
 */
export function fmtShortDate(ts, now = new Date()) {
  const d = toDate(ts)
  if (!d) return EMPTY
  if (d.getFullYear() !== now.getFullYear()) return fmtDay(ts)
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 2026-10-10 */
export function fmtDay(ts) {
  const d = toDate(ts)
  if (!d) return EMPTY
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** 秒 → 不足一小时 mm:ss，否则 hh:mm:ss；0 / 空 显示「—」 */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (!s) return EMPTY
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${p2(h)}:${p2(m)}:${p2(r)}` : `${p2(m)}:${p2(r)}`
}

/**
 * 时长文本 → 秒：'90' / '1:30' / '01:02:03' / '1.5'（秒，四舍五入）。
 * 空串返回 null，格式不对返回 undefined（表单据此提示）。
 */
export function parseDuration(text) {
  const t = String(text ?? '').trim().replace('：', ':')
  if (!t) return null
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t))
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(t)
  if (!m) return undefined
  const [h, mm, ss] = [Number(m[1] || 0), Number(m[2]), Number(m[3])]
  if (ss >= 60 || (m[1] !== undefined && mm >= 60)) return undefined
  return h * 3600 + mm * 60 + ss
}

/** 字节 → 1.2 MB */
export function fmtSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return EMPTY
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
  // 只去掉小数部分末尾的 0（1.50 → 1.5，2.00 → 2），整数不动
  return (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s) + ' ' + units[i]
}

/** 计数 → 999 / 1.2k / 3.4w（和应用里的写法一致） */
export function fmtCount(n) {
  const v = Number(n) || 0
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + 'w'
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(v)
}

/** 千分位：12,345 */
export const fmtNum = n => (Number(n) || 0).toLocaleString('zh-CN')

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 2 天前，超过 30 天显示日期 */
export function relTime(ts) {
  const d = toDate(ts)
  if (!d) return EMPTY
  const diff = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diff < 0) return fmtDate(ts)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前'
  return fmtDay(ts)
}

/** 文件名里用的时间戳：20261010-1403 */
export function fileStamp(date = new Date()) {
  const d = date
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
}
