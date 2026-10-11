import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { togglePostFav } from '@/api'

/**
 * 帖子的互动状态（收藏、收藏数、阅读数），按帖子 id 记最新值。
 *
 * 社区页常驻（KeepAlive），从详情页收藏 / 阅读后返回时不会重新加载；列表卡片和详情页都从这里读，
 * 两边看到的就是同一个值，不用为此重新请求。
 *   - 详情页拿到接口数据时写进来（接口为准），收藏、阅读后再更新；
 *   - 社区列表重新加载时，把加载开始前写入的值清掉（列表里已经是接口的最新数据）。
 */
export const usePostStore = defineStore('posts', () => {
  /** id -> { faved?, fav?, read?, at } */
  const patches = reactive({})
  /* 正在请求中的收藏：同一条帖子一次只发一个请求 */
  const pending = new Set()

  /** 帖子当前应显示的值：本地记过的优先，否则用帖子对象自带的 */
  function stats(post) {
    const p = patches[post.id]
    return {
      faved: p?.faved ?? !!post.faved,
      fav: p?.fav ?? post.fav ?? 0,
      read: p?.read ?? post.read ?? 0
    }
  }

  function patch(id, fields) {
    patches[id] = { ...patches[id], ...fields, at: Date.now() }
  }

  /** 清掉 before（毫秒时间戳）之前写入的值 */
  function prune(before) {
    for (const id of Object.keys(patches)) if (patches[id].at < before) delete patches[id]
  }

  const isPending = id => pending.has(String(id))

  /**
   * 收藏 / 取消收藏：乐观更新 → 一次请求（带明确的 on）→ 以返回的 active 为准；失败回滚并把错误抛给调用方提示。
   * 返回最终的收藏状态。
   */
  async function setFav(post, on) {
    const id = post.id
    const before = stats(post)
    const count = active => (active === before.faved ? before.fav : Math.max(0, before.fav + (active ? 1 : -1)))
    patch(id, { faved: on, fav: count(on) })
    pending.add(String(id))
    try {
      const res = await togglePostFav(id, { on })
      const active = typeof res?.active === 'boolean' ? res.active : on
      patch(id, { faved: active, fav: count(active) })
      return active
    } catch (e) {
      patch(id, { faved: before.faved, fav: before.fav })
      throw e
    } finally {
      pending.delete(String(id))
    }
  }

  return { patches, stats, patch, prune, isPending, setFav }
})
