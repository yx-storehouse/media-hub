import { onUnmounted } from 'vue'

/*
 * 底部导航「已经在这个 Tab 上，又点了一次」：TabBar 发出，页面订阅。
 * 短视频页用它刷新推荐并回到第一条（和抖音一样）。
 */
const listeners = new Map()

/** TabBar 调：tab 是 MAIN_TABS 的 id */
export function emitTabRetap(tab) {
  listeners.get(tab)?.forEach(fn => fn())
}

/** 页面里调：组件卸载时自动取消订阅（KeepAlive 收起时不卸载，切回来照常收到） */
export function useTabRetap(tab, fn) {
  if (!listeners.has(tab)) listeners.set(tab, new Set())
  listeners.get(tab).add(fn)
  onUnmounted(() => listeners.get(tab)?.delete(fn))
}
