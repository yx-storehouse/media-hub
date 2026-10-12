import { getTopicVideos } from '@/api'

/*
 * 播放页的「下一个」从哪来：从某个列表点进来的（比如专题的「播放全部」），地址里带上
 *   /video/:id?list=topic:<专题 id>&i=<在列表里的序号>[&sort=<专题排序>]
 * 播完就接着播这个列表的下一条；没带列表、或者列表已经播到最后一条，就播「相似推荐」的第一条。
 *
 *   router.push({ path: `/video/${id}`, query: listQuery(topic.id, 0, sort) })   // 专题「播放全部」
 */

const TOPIC = /^topic:(\d+|demo:\d+)$/

/** 地址参数：专题列表的第 i 条（sort 是专题页的排序，默认 0） */
export const listQuery = (topicId, i = 0, sort = 0) => ({ list: `topic:${topicId}`, i: String(i), ...(sort ? { sort: String(sort) } : {}) })

/** 地址参数 → { kind: 'topic', id, i, sort, key }；不认识就是 null */
export function parseList(query = {}) {
  const m = TOPIC.exec(String(query.list || ''))
  const i = Number(query.i)
  if (!m || !Number.isInteger(i) || i < 0) return null
  const sort = Number(query.sort) || 0
  return { kind: 'topic', id: m[1], i, sort, key: String(query.list) }
}

/** 列表里的下一条 → { video, query }（query 是跳过去时带的地址参数）；没有下一条为 null，取不到会抛错 */
export async function nextInList(list) {
  if (!list) return null
  const res = await getTopicVideos(list.id, list.sort, { offset: list.i + 1, limit: 1 })
  const items = res?.list || []
  // 接口按 offset 只给一条；演示数据不分页，给的是整个列表
  const video = items.length > 1 ? items[list.i + 1] : items[0]
  if (!video) return null
  return { video, query: listQuery(list.id, list.i + 1, list.sort) }
}
