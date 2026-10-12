/*
 * 列表里点进播放页时，先把这条视频的列表数据（封面、标题、时长）记下来：
 * 播放页在详情接口回来之前就能显示封面和标题，不再是一整块黑屏。只在内存里，最多 30 条。
 *
 *   <RouterLink :to="..." @click="rememberVideo(video)">
 */
const MAX = 30
const cache = new Map()

export function rememberVideo(video) {
  if (!video || video.id == null) return
  const key = String(video.id)
  cache.delete(key)
  cache.set(key, { id: video.id, title: video.title || '', cover: video.cover || null, dur: video.dur || '' })
  if (cache.size > MAX) cache.delete(cache.keys().next().value)
}

/** 记下的列表数据，没有为 null */
export const peekVideo = id => cache.get(String(id)) || null
