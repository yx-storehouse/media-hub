import { getTopicVideos } from '@/api'

/*
 * 播放页的「下一个」从哪来：从某个列表点进来的（比如专题的「播放全部」），地址里带上
 *   /video/:id?list=topic:<专题 id>&i=<在列表里的序号>[&sort=<专题排序>]
 * 播完就接着播这个列表往后第一条有片源的；没带列表、或者列表往后都没有片源，就播「相似推荐」里第一条有片源的。
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

/**
 * 能不能播：服务端的列表每条带 hasSrc（有没有片源）；详情（和没有 hasSrc 的旧数据、演示数据）看 src。
 * 播放页的「下一个」、自动连播只挑能播的，不会连到只有封面的「暂无视频源」上
 */
export const playable = v => (typeof v?.hasSrc === 'boolean' ? v.hasSrc : !!v?.src)

/** 往后找能播的下一条：一次取 PAGE 条，最多找 PAGES 页（专题里一长串没有片源的就不再往后找，播相似推荐） */
const PAGE = 10
const PAGES = 3

/** 列表里往后第一条能播的 → { video, query }（query 是跳过去时带的地址参数）；没有为 null，取不到会抛错 */
export async function nextInList(list) {
  if (!list) return null
  let offset = list.i + 1
  for (let n = 0; n < PAGES; n++) {
    const res = await getTopicVideos(list.id, list.sort, { offset, limit: PAGE })
    let items = res?.list || []
    // 演示数据不分页，给的是整个列表：从 offset 开始截
    if (items.length > PAGE) items = items.slice(offset)
    const k = items.findIndex(playable)
    if (k >= 0) return { video: items[k], query: listQuery(list.id, offset + k, list.sort) }
    if (items.length < PAGE) return null
    offset += PAGE
  }
  return null
}
