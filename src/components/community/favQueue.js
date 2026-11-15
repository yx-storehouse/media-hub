import { togglePostFav } from '@/api'

/*
 * 帖子的收藏 / 取消收藏（帖子详情、社区和创作者主页、搜索里的帖子卡片）：网慢时连点也不丢、不反。
 *
 * 请求还没回来时再点：界面立刻跟着变，只记下「最后想要的状态」；正在发的那个请求回来后，服务端的状态和想要的
 * 不一样就再补发一次（接口带明确的 on，是幂等的开 / 关），一样就停。最后以服务端的答复为准；
 * 失败时回滚到最后一次确认过的状态，把错误抛给发起的那一下（调用方提示）。
 * 收藏状态 / 收藏数写在 stores/posts.js（详情页和列表共用，返回列表时一致）。
 *
 *   const on = await setPostFav(postStore, post, next)
 *     // 这一轮的第一下：等到最终状态（true / false），出错时抛出；
 *     // 请求进行中又点的：返回 null（结果由第一下那里统一提示，不会弹好几次）
 *   favBusy(id)   // 这篇帖子的收藏请求还在进行中（登录后补做收藏、静默刷新状态时别去覆盖）
 */
const runs = new Map()

/* 以 base（这一轮开始前的状态）为准算收藏数：状态没变数量不变 */
const countOf = (base, on) => (on === base.faved ? base.fav : Math.max(0, base.fav + (on ? 1 : -1)))

export const favBusy = id => runs.has(String(id))

export function setPostFav(store, post, on) {
  const id = String(post.id)
  const run = runs.get(id)
  if (run) {
    run.want = on
    store.patch(post.id, { faved: on, fav: countOf(run.base, on) })
    return Promise.resolve(null)
  }
  const s = store.stats(post)
  const r = { want: on, base: { faved: !!s.faved, fav: s.fav || 0 } }
  runs.set(id, r)
  store.patch(post.id, { faved: on, fav: countOf(r.base, on) })
  return (async () => {
    let server = r.base.faved
    try {
      while (r.want !== server) {
        const want = r.want
        const res = await togglePostFav(post.id, { on: want })
        server = typeof res?.active === 'boolean' ? res.active : want
      }
      return server
    } finally {
      // 成功：服务端最后的状态；失败：最后一次确认过的状态（第一个请求就失败 = 原来的样子）
      runs.delete(id)
      store.patch(post.id, { faved: server, fav: countOf(r.base, server) })
    }
  })()
}
