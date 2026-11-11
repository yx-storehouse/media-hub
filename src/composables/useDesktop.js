import { computed, shallowRef } from 'vue'

/*
 * 桌面布局（电脑浏览器）：窗口宽度 ≥ 1024px 时整个 App 换成「顶栏 + 左侧导航 + 宽内容区」，
 * 比这窄的（手机、竖着的平板、缩窄的浏览器窗口）和以前完全一样。
 *
 *   CSS：所有桌面规则写在 @media (min-width: 1024px) 里；只有鼠标悬停才有的效果再套一层 @media (hover: hover)
 *   JS ：import { isDesktop } from '@/composables/useDesktop'      // 只读 ref，模板里直接用 isDesktop
 *        const desk = useDesktop()                                 // 同一个 ref（组件里习惯这样写也行）
 *        if (isDesktop.value) …
 *
 * 全 App 只有一个 matchMedia 监听；窗口拉宽 / 拉窄跨过 1024 时实时变（页面状态不丢）。
 * 没有 matchMedia 的环境（极老的 WebView、测试环境）一律当手机。
 */
export const DESKTOP_MQ = '(min-width: 1024px)'

const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia(DESKTOP_MQ)
  : null

const state = shallowRef(!!mq?.matches)
if (mq) {
  const onChange = e => { state.value = !!e.matches }
  // Safari 14 以前只有 addListener
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange)
  else if (typeof mq.addListener === 'function') mq.addListener(onChange)
}

/** 现在是不是桌面布局（只读 ref） */
export const isDesktop = computed(() => state.value)

/** 组件里用：返回同一个只读 ref */
export function useDesktop() {
  return isDesktop
}
