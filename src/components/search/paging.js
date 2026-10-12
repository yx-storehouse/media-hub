import { nextTick, watch } from 'vue'
import { isDemoId } from '@/api'
import { createFeed } from '@/components/creator/feed'

/*
 * 搜索结果、专题视频的分页列表：和创作者主页同一套 createFeed，每次取 20 条，滚到底再取下一页。
 *
 *   const feed = createPagedFeed(page => searchVideos(q, page))   // page = { limit, offset }，接口返回 { total, list }
 *   useScrollMore(scroller, () => feed)                            // 离底部不远时自动取下一页
 *
 * 开发环境 auto 模式下接口一时连不上会拿到演示数据：第一页就是演示数据时只有这一页（演示数据不分页，
 * 总数按实际条数算，数字和看到的一致）；翻页时拿到演示数据当作失败（底部给重试），不把演示卡片接在真实列表后面。
 */
export function createPagedFeed(fetchPage) {
  return createFeed(async page => {
    const res = await fetchPage(page)
    const list = res?.list || []
    if (!list.some(x => isDemoId(x.id))) return res
    if (page.offset > 0) throw new Error('demo page')
    return { list, total: list.length }
  })
}

/**
 * 列表标题上的数字：取完了就是实际条数（翻页期间有内容下架时总数会偏大），没取完用接口给的总数。
 * 还没取过第一页时为 null。
 */
export const feedCount = feed => (feed.total === null ? null : feed.done ? feed.list.length : feed.total)

/* 离底部还剩这么多像素时就取下一页（一屏多一点），滚得快也不容易看到底部的「加载中」 */
const PRELOAD = 800

/**
 * 滚到离底部不到 PRELOAD 时取当前列表的下一页；一页回来后内容还不满一屏，就接着取。
 * getFeed() 返回当前显示的那个列表（搜索页有视频 / 帖子两个，只翻当前那个）。
 * 第一页由页面自己取（total 为 null 时不自动取）；取失败后等用户点「重试」，不自动反复请求。
 * 返回 check()，页面换了列表 / 恢复了滚动位置后可以手动调一次。
 */
export function useScrollMore(scroller, getFeed) {
  function check() {
    const el = scroller.value
    const feed = getFeed()
    if (!el || !feed || !el.isConnected || !el.clientHeight) return
    if (feed.total === null || feed.loading || feed.done || feed.error) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < PRELOAD) feed.more()
  }
  // 滚动容器可能随 v-if 出现 / 消失，跟着元素走
  watch(scroller, (el, old) => {
    old?.removeEventListener('scroll', check)
    el?.addEventListener('scroll', check, { passive: true })
  }, { immediate: true, flush: 'post' })
  watch(() => getFeed()?.loading, busy => { if (!busy) nextTick(check) })
  return check
}
