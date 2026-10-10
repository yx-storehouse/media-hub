/*
 * 每个视频看到哪儿（本次打开应用期间有效）。
 * 从播放页点标签 / 热榜出去再回来时，播放器从这里接着播。
 */
const MAX = 50
const positions = new Map()

export const getResume = id => positions.get(String(id)) || 0

export function setResume(id, sec, len = 0) {
  const key = String(id)
  positions.delete(key)
  // 没怎么看或者快看完（剩 5 秒内）就不记，下次从头播
  if (sec < 3 || (len && sec >= len - 5)) return
  positions.set(key, Math.floor(sec))
  if (positions.size > MAX) positions.delete(positions.keys().next().value)
}
