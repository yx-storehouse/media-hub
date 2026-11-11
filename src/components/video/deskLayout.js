import { computed, shallowRef } from 'vue'
import { isDesktop } from '@/composables/useDesktop'
import { deskSide, DESK_SIDE_RAIL, DESK_SIDE_FULL } from '@/composables/useDeskSide'

/*
 * 播放页的桌面布局（窗口 ≥ 1024px）：两栏还是单栏，以及播放器会出现在哪。
 * 尺寸规则写在 VideoView.vue 的桌面样式里，这里是同一组数（改一边要改另一边）：
 *   - 页面（窗口减左侧导航）至少 V_TWO_MIN 宽才分两栏：左边播放器 + 信息，右边相似推荐（宽 28%，限制在 360–400px）
 *   - 播放器宽 = min(左栏能给的宽, (窗口高 − 顶栏 − V_RESERVE) × 16/9)，最小 480px：整个播放器连同标题都在一屏里
 *   - 两栏（或单栏）和左右留白一起居中，内容最宽 --desk-max（1760px，含左右留白 --desk-pad）
 *
 *   import { twoCol, deskPlayerBox } from '@/components/video/deskLayout'
 *   twoCol.value              // 现在是不是两栏（只读，跟着窗口宽度、左侧导航宽度变）
 *   deskPlayerBox()           // 播放器的位置（视口坐标）：hero.js 起飞时先飞向这里，播放页挂上后再按真实位置核对
 */
export const V_TWO_MIN = 1028   // 页面至少这么宽才分两栏（左侧导航收成图标栏时 = 窗口 1100px）
export const V_GAP = 24         // 两栏之间
export const V_RESERVE = 170    // 播放器下面至少留出这么高（标题、数据）
export const V_TOP = 24         // 页面顶部留白
export const V_RADIUS = 12      // 播放器圆角（全屏时没有）
/* 和 styles/tokens.css 的桌面变量一致 */
const DESK_TOP = 56
const DESK_MAX = 1760
const deskPad = w => (w >= 1600 ? 32 : 24)
/* 右栏宽：clamp(360px, 28%, 400px)（百分比按页面宽） */
const sideOf = pageW => Math.min(400, Math.max(360, pageW * 0.28))

/*
 * 两栏的门槛跟着左侧导航的宽度走（展开 232px / 图标栏 72px）：两个 matchMedia，窗口拉宽拉窄不用每次都算。
 * 没有 matchMedia 的环境当窄屏（反正也不是桌面布局）。
 */
function mqRef(px) {
  const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(`(min-width: ${px}px)`) : null
  const r = shallowRef(!!mq?.matches)
  if (mq) {
    const on = e => { r.value = !!e.matches }
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', on)
    else if (typeof mq.addListener === 'function') mq.addListener(on)
  }
  return r
}
const wideRail = mqRef(V_TWO_MIN + DESK_SIDE_RAIL)
const wideFull = mqRef(V_TWO_MIN + DESK_SIDE_FULL)

/** 播放页现在是不是两栏（桌面布局、页面够宽） */
export const twoCol = computed(() => isDesktop.value && (deskSide.width === DESK_SIDE_RAIL ? wideRail.value : wideFull.value))

/**
 * 桌面布局下播放器的位置（视口坐标 { x, y, w, h, r }）。
 * side：左侧导航的宽度——进播放页时导航一定收成图标栏（路由 meta.deskRail），所以默认按图标栏算。
 * 竖向滚动条的宽度不算（各平台不一样），差的几像素由 hero.js 挂上后的核对接上。
 */
export function deskPlayerBox(side = DESK_SIDE_RAIL) {
  const W = window.innerWidth
  const H = window.innerHeight
  const pad = deskPad(W)
  const pageW = W - side
  const aside = pageW >= V_TWO_MIN ? V_GAP + sideOf(pageW) : 0
  const inner = Math.min(pageW, DESK_MAX) - 2 * pad
  const w = Math.min(inner - aside, Math.max(480, (H - DESK_TOP - V_RESERVE) * 16 / 9))
  const gut = Math.max(pad, (pageW - w - aside) / 2)
  return { x: side + gut, y: DESK_TOP + V_TOP, w, h: w * 9 / 16, r: V_RADIUS }
}
