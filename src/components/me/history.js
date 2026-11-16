import { formatClock } from '@/utils/format'

/*
 * 观看历史（views/HistoryView.vue、桌面的卡片 HistoryCard.vue）共用的小工具：看到哪了、什么时候看的、按天分组。
 *
 *   progress(v)        → { pct, text }      封面底部进度条的百分比 + 手机列表里的「看到 12:34 / 已看完 / 刚开始看」
 *   progressBadge(v)   → '看到 12:34 / 20:15' | '已看完' | null（null：刚开始看，桌面卡片照常显示时长）
 *   when(ts)           → '今天 19:56' | '昨天 08:10' | '11月3日' | '2025年11月3日'（手机列表的观看时间）
 *   dayOf(ts)          → 'today' | 'yesterday' | 'older'（桌面网格的分组）
 *   stamp(ts, group)   → 桌面卡片信息行里的时间：分组标题已经说了「今天 / 昨天」，这里只写时分；「更早」写日期
 */

/* 剩不到 5 秒算看完（和 components/video/resume.js 一致） */
const DONE_LEFT = 5

export function progress(v) {
  const len = Number(v.len) || 0
  const sec = Number(v.progressSec) || 0
  if (len && sec >= len - DONE_LEFT) return { pct: 100, text: '已看完' }
  if (sec < 3) return { pct: 0, text: '刚开始看' }
  return { pct: len ? Math.min(100, (sec / len) * 100) : 0, text: `看到 ${formatClock(sec)}` }
}

/* 桌面卡片封面右下角的角标：看到哪 / 总长（和播放器的时间同一种写法；不知道总长时只写看到哪） */
export function progressBadge(v) {
  const p = progress(v)
  if (p.pct === 100) return p.text
  // 刚开始看（3 秒内）：没什么可说的，照常显示时长
  if ((Number(v.progressSec) || 0) < 3) return null
  const len = Number(v.len) || 0
  return len ? `${p.text} / ${formatClock(len)}` : p.text
}

const pad = n => String(n).padStart(2, '0')
const startOfDay = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
/* 离今天几天（按日历日算，0 = 今天） */
const daysAgo = (d, now) => Math.round((startOfDay(now) - startOfDay(d)) / 86400000)

/* 观看时间：今天 / 昨天带时分，更早的只写日期 */
export function when(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  const diff = daysAgo(d, now)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (diff <= 0) return `今天 ${hm}`
  if (diff === 1) return `昨天 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 桌面网格的分组（标题和 when() 的说法一致） */
export const DAY_GROUPS = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'older', label: '更早' }
]

export function dayOf(ts, now = new Date()) {
  if (!ts) return 'older'
  const diff = daysAgo(new Date(ts * 1000), now)
  return diff <= 0 ? 'today' : diff === 1 ? 'yesterday' : 'older'
}

/*
 * 卡片信息行里的时间。分组按进来时的观看时间排（见 HistoryView 的 groupAt）：刚才点进去看过的那条返回后时间更新了，
 * 卡片留在原来的组里不跳走，这时写完整的说法（「今天 21:05」），不会和组标题对不上
 */
export function stamp(ts, group) {
  if (!ts) return ''
  if (group !== 'older' && dayOf(ts) === group) {
    const d = new Date(ts * 1000)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return when(ts)
}
