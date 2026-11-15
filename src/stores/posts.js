import { defineStore } from 'pinia'
import { reactive, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

/**
 * 帖子的互动状态（收藏、收藏数、阅读数），按帖子 id 记最新值。
 *
 * 社区页常驻（KeepAlive），从详情页收藏 / 阅读后返回时不会重新加载；列表卡片和详情页都从这里读，
 * 两边看到的就是同一个值，不用为此重新请求。
 *   - 详情页拿到接口数据时写进来（接口为准），收藏、阅读后再更新；
 *   - 社区列表重新加载时，把加载开始前写入的值清掉（列表里已经是接口的最新数据）；
 *   - 换了账号（登录、退出）时全部清掉：收藏状态是上一个人的，不能留给下一个人看。
 * 收藏 / 取消收藏的请求只走 components/community/favQueue.js 的 setPostFav（连点不丢、最后想要的状态为准），
 * 它用这里的 stats / patch 读写状态；这里不再另有一份发请求的代码。
 */
export const usePostStore = defineStore('posts', () => {
  /** id -> { faved?, fav?, read?, at } */
  const patches = reactive({})

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

  /** 清掉 before（毫秒时间戳）之前写入的值；传 ids 时只清这些帖子的（刷新了一部分列表） */
  function prune(before, ids = null) {
    const keys = ids ? ids.map(String).filter(id => id in patches) : Object.keys(patches)
    for (const id of keys) if (patches[id].at < before) delete patches[id]
  }

  // 换账号：启动时的首次校验（ready 之前）不算
  const auth = useAuthStore()
  watch(() => (auth.ready ? auth.user?.id ?? 0 : null), (now, before) => {
    if (before !== null) prune(Infinity)
  }, { flush: 'sync' })

  return { patches, stats, patch, prune }
})
