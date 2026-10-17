import { nextTick, onActivated, watch } from 'vue'
import { isDemoId } from '@/api'
import { createFeed, PAGE } from '@/components/creator/feed'
import { scrollBehavior } from '@/utils/motion'

/*
 * 首页的分页列表（分类页、最新）：和创作者主页同一套 createFeed，每次取 20 条，滚到底再取下一页。
 *
 *   const feed = createHomeFeed(page => getCategoryVideos(tab, { filter, ...page }))
 *   useAutoMore(scroller, feed)            // 离底部不远时自动 more()
 *   refreshFeed(feed, fetchPage, isStale)  // 重新取第一页，回来后整体替换（不先清空，不闪骨架）
 *
 * 这几个接口只返回数组、不给总数：总数记成 Infinity，靠「这一页不足 20 条」判断到底。
 */
const asPage = res => (Array.isArray(res) ? { list: res, total: Infinity } : res)

export function createHomeFeed(fetchPage) {
  return createFeed(async page => {
    const res = asPage(await fetchPage(page))
    // 开发环境 auto 模式下接口一时连不上，这一页会拿到演示数据：翻页时当作失败（底部给重试），
    // 不把演示卡片接在真实列表后面
    if (page.offset > 0 && res?.list?.some(v => isDemoId(v.id))) throw new Error('demo page')
    return res
  })
}

/* 离底部还剩这么多像素时就取下一页（一屏多一点），滚得快也不容易看到底部的「加载中」 */
const PRELOAD = 800

/**
 * 滚到离底部不到 PRELOAD 时取下一页；一页回来后内容还不满一屏，就接着取。
 * 页面被 KeepAlive 收起时元素脱离文档，这时不取，切回来再检查一次。
 */
export function useAutoMore(scroller, feed) {
  function check() {
    const el = scroller.value
    if (!el || !el.isConnected || !el.clientHeight) return
    if (feed.total === null || feed.loading || feed.done || feed.error) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < PRELOAD) feed.more()
  }
  // 模板里的滚动容器可能随 v-if 出现 / 消失，跟着元素走
  watch(scroller, (el, old) => {
    old?.removeEventListener('scroll', check)
    el?.addEventListener('scroll', check, { passive: true })
  }, { immediate: true, flush: 'post' })
  watch(() => feed.loading, busy => { if (!busy) nextTick(check) })
  onActivated(() => nextTick(check))
  return check
}

/**
 * 重新取第一页，成功后整体替换列表（之前翻到的页丢掉）。
 * isStale()：请求期间用户换了筛选，返回 true 时丢弃结果。失败时抛出，原来的列表保留。
 * 返回 false 表示结果已作废。
 */
export async function refreshFeed(feed, fetchPage, isStale = () => false) {
  const res = asPage(await fetchPage({ limit: PAGE, offset: 0 }))
  if (isStale()) return false
  const list = res?.list || []
  const total = res?.total ?? Infinity
  feed.restore({ list, total, done: list.length < PAGE || list.length >= total })
  return true
}

/** 再点一次底部「首页」：滚动过就平滑回到顶部，已经在顶部就刷新 */
export function toTopOrRefresh(el, refresh) {
  if (el && el.scrollTop > 2) el.scrollTo({ top: 0, behavior: scrollBehavior() })
  else refresh()
}
