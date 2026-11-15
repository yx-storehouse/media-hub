import { shallowRef, ref, reactive } from 'vue'

/**
 * 创作者主页里的一个分页列表（视频 / 帖子各一个）：每次取 PAGE 条，滚到底再取下一页。
 *
 *   const videos = createFeed(page => getCreatorVideos(id, sort, page))   // page = { limit, offset }
 *   videos.more()      // 取下一页（正在取 / 已取完时什么也不做）
 *   videos.reset()     // 换排序、换创作者：清空，之前还没回来的请求作废
 *
 * total 为 null 表示还没取过第一页；error 是最近一次取失败的错误对象（ApiError 等，没出错是 false；已有的内容保留，
 * 可以 more() 重试）。出错的说法用 api/http.js 的 errorText(feed.error)，或者直接交给 <LoadState :error="feed.error">。
 * 重试期间 error 先留着，取到了才清掉：出错页上的自动重试（LoadState / useReconnect）不会每次都闪一下骨架；
 * 要表示「正在取」看 loading（列表底部 ListFoot 就是先看 loading）。
 * 返回 reactive 对象：模板和脚本里都直接写 videos.list / videos.total，不用 .value。
 */
export const PAGE = 20

export function createFeed(fetchPage) {
  const list = shallowRef([])
  const total = ref(null)
  const loading = ref(false)
  // 错误对象原样存着（不套响应式代理，instanceof ApiError 照常可用）
  const error = shallowRef(false)
  const done = ref(false)
  let seq = 0

  async function more() {
    if (loading.value || done.value) return
    const token = seq
    loading.value = true
    try {
      const res = await fetchPage({ limit: PAGE, offset: list.value.length })
      if (token !== seq) return
      // 翻页期间有新发布的内容时 offset 会错开，同一条不要出现两次
      const seen = new Set(list.value.map(x => String(x.id)))
      const page = res?.list || []
      list.value = [...list.value, ...page.filter(x => !seen.has(String(x.id)))]
      total.value = res?.total ?? list.value.length
      done.value = page.length < PAGE || list.value.length >= total.value
      error.value = false
    } catch (e) {
      if (token === seq) error.value = e || true
    } finally {
      if (token === seq) loading.value = false
    }
  }

  function reset() {
    seq++
    list.value = []
    total.value = null
    loading.value = false
    error.value = false
    done.value = false
  }

  /* 离开页面时存一份，返回时原样放回（见 CreatorView 的返回恢复） */
  const snapshot = () => ({ list: list.value, total: total.value, done: done.value })
  function restore(s) {
    reset()
    list.value = s.list
    total.value = s.total
    done.value = s.done
  }

  return reactive({ list, total, loading, error, done, more, reset, snapshot, restore })
}
