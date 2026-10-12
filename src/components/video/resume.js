/*
 * 每个视频看到哪儿：内存里一份，同时记在本机（localStorage，最多 50 条），App 重开也在。
 * 登录用户服务端也记着（getVideo 的 progressSec / watchedAt），打开播放页时用 pickResume
 * 在本机记录和服务端记录里取更新的那一份（换了设备看也能接上）。
 * 本机读写都可能失败（隐私模式、存储被禁用）：失败就只记在内存里，不影响播放。
 */
const MAX = 50
const KEY = 'reel:resume'
/** 没怎么看（3 秒内）或者快看完（剩 5 秒内）都算从头播 */
const MIN_SEC = 3
const TAIL_SEC = 5

/** id → { s: 秒, t: 记下的时间（毫秒） }；s 为 0 表示「下次从头播」（看完了 / 刚开头），也要记，免得被更早的记录盖过 */
const positions = new Map()

try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
  if (Array.isArray(saved)) {
    for (const row of saved.slice(-MAX)) {
      if (Array.isArray(row) && row.length === 3 && Number.isFinite(row[1]) && Number.isFinite(row[2])) {
        positions.set(String(row[0]), { s: row[1], t: row[2] })
      }
    }
  }
} catch { /* 读不到就当没有 */ }

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...positions].map(([id, p]) => [id, p.s, p.t])))
  } catch { /* 不记也能用 */ }
}

const clean = (sec, len) => (sec < MIN_SEC || (len > 0 && sec >= len - TAIL_SEC) ? 0 : Math.floor(sec))

/** 本机记录的秒数（没有记录为 0） */
export const getResume = id => positions.get(String(id))?.s || 0

/** 记下看到第几秒；len 是总时长（秒），快看完就记成「从头播」 */
export function setResume(id, sec, len = 0) {
  const key = String(id)
  positions.delete(key)
  positions.set(key, { s: clean(Number(sec) || 0, Number(len) || 0), t: Date.now() })
  while (positions.size > MAX) positions.delete(positions.keys().next().value)
  persist()
}

/**
 * 打开播放页时从第几秒开始：本机记录和服务端记录（progressSec / watchedAt）取更新的一份，
 * 再按总时长过滤（快看完了就从头播）。video 是 getVideo 的结果。
 */
export function pickResume(video) {
  if (!video) return 0
  const local = positions.get(String(video.id))
  const serverAt = (Number(video.watchedAt) || 0) * 1000
  const sec = local && local.t >= serverAt ? local.s : Number(video.progressSec) || 0
  return clean(sec, Number(video.len) || 0)
}
