import { watch, onActivated } from 'vue'
import { useRouter } from 'vue-router'

/*
 * 浏览器标题（标签页、历史记录、读屏软件换页时读出来、分享时的默认标题）。
 *
 * 每个路由的固定标题写在路由的 meta.title 里，router/index.js 每次换页后设成「<标题> - Reel」（首页、搜索也在那里）。
 * 内容页（播放页、帖子、创作者主页、专题）拿到数据后换成内容自己的标题：
 *
 *   import { usePageTitle } from '@/composables/usePageTitle'
 *   usePageTitle(() => video.value?.title)        // 播放页：「<视频标题> - Reel」
 *   usePageTitle(() => creator.value?.name)       // 创作者主页
 *
 * 传一个返回字符串的函数（数据还没回来时返回空，先显示路由的固定标题）；值变了跟着变，KeepAlive 的页面回来时重新设一次。
 * 已经离开这一页（换到了别的路由）后数据才回来时不会改标题。分享时 share({ title }) 也可以直接用同一个标题。
 */
export const APP_NAME = 'Reel'

/** 「<标题> - Reel」；没有标题时就是「Reel」 */
export function titleOf(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return APP_NAME
  return `${[...t].length > 60 ? [...t].slice(0, 59).join('') + '…' : t} - ${APP_NAME}`
}

export function setPageTitle(title) {
  if (typeof document !== 'undefined') document.title = titleOf(title)
}

export function usePageTitle(source) {
  const router = useRouter()
  // 记下这一页的路由名：离开以后（离场动画里、数据晚回来）不再改标题
  const name = router.currentRoute.value.name
  const apply = () => {
    if (router.currentRoute.value.name !== name) return
    const t = typeof source === 'function' ? source() : source
    if (t) setPageTitle(t)
  }
  watch(() => (typeof source === 'function' ? source() : source), apply, { immediate: true })
  onActivated(apply)
}
