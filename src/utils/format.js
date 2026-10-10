/* Display formatting shared by pages. */

/** 4123 -> '4.1k', 52300 -> '5.2w', 87 -> '87' */
export function formatCount(n) {
  n = Number(n) || 0
  if (n >= 10000) return trim(n / 10000) + 'w'
  if (n >= 1000) return trim(n / 1000) + 'k'
  return String(n)
}
const trim = x => x.toFixed(1).replace(/\.0$/, '')

/** seconds -> '0:05', '12:34', '1:02:03' (player clock) */
export function formatClock(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** unix seconds -> '2026-10-09'; empty -> '-' */
export function formatDate(ts) {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
