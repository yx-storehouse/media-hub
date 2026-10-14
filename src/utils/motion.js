/*
 * 动效小工具：和 src/styles/motion.css 配套。
 *
 *   import { reducedMotion, haptic } from '@/utils/motion'
 *   if (!reducedMotion()) el.animate(...)
 *   haptic()        // 点赞等「确认」类操作的轻微震动（只有支持的安卓设备会震）
 */

const mq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null

/** 系统是否开了「减少动态效果」（实时读取，用户中途改设置也能跟上） */
export const reducedMotion = () => !!mq?.matches

/** 轻微震动反馈；不支持、或开了减少动态效果时什么都不做 */
export function haptic(ms = 8) {
  if (reducedMotion()) return
  try { navigator.vibrate?.(ms) } catch { /* 部分浏览器在没有用户手势时会抛错，忽略 */ }
}

/** 读 CSS 里的时长变量（毫秒），给 JS 动画（element.animate）用，保证和样式一致 */
export function cssDuration(name = '--dur-3', fallback = 280) {
  if (reducedMotion()) return 1
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

/** 读 CSS 里的缓动变量，给 element.animate 的 easing 用 */
export function cssEasing(name = '--ease-out', fallback = 'cubic-bezier(.22, 1, .36, 1)') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}
