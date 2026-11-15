import { reactive } from 'vue'
import { isDesktop } from '@/composables/useDesktop'

/*
 * 让桌面顶栏的搜索框（DeskSearch.vue）聚焦，可以顺便指定搜什么：
 *
 *   import { focusDeskSearch } from '@/components/desk/deskSearch'
 *   if (!focusDeskSearch({ scope: 'post' })) router.push('/search?type=post')   // 手机布局没有顶栏：照旧去搜索页
 *
 *   scope  'post'：占位文字变成「搜索帖子」，回车去 #/search?q=…&type=post（帖子标签）；不传就是普通搜索
 * 桌面布局（顶栏在）时返回 true；手机布局返回 false，调用方自己去搜索页。
 * 输入框失焦、框里又是空的时候，范围自动回到普通搜索。
 */
export const deskSearchRequest = reactive({ seq: 0, scope: '' })

export function focusDeskSearch({ scope = '' } = {}) {
  if (!isDesktop.value || !document.querySelector('.dsr input')) return false
  deskSearchRequest.scope = scope === 'post' ? 'post' : ''
  deskSearchRequest.seq++
  return true
}
