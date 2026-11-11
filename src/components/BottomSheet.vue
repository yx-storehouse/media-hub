<script setup>
import { ref, watch, nextTick, onDeactivated, useId } from 'vue'
import { useRoute } from 'vue-router'
import { useBackDismiss } from '@/composables/useBackDismiss'
import { useSheetDrag } from '@/components/motion/sheetDrag'
import { isDesktop } from '@/composables/useDesktop'
import { trapTab } from '@/components/desk/modal'
import Icon from './Icon.vue'

/*
 * Bottom sheet rendered over the whole app (teleported to #app).
 * Usage: <BottomSheet v-model:open="show" title="播放设置"> …content… </BottomSheet>
 * Content can use the shared classes .opts / .opt / .opt.on / .row2 / .sw / .sw.on (styles/common.css).
 * Closes on mask tap, Escape, the back button / gesture (only the sheet, the page stays),
 * dragging it down (components/motion/sheetDrag.js), route change and when its page is deactivated (KeepAlive).
 * 升起、收起都是 smooth 弹簧（几乎不过冲）；拖动松手接着手指的速度走；遮罩同时淡入淡出（样式在下面，LoginSheet 共用）。
 *
 * 桌面布局（≥ 1024px）：同一个组件、同样的用法，显示成窗口正中的对话框（最宽 480px、圆角 16px，淡入 + 从 .96 放大，
 * smooth 弹簧），右上角多一个关闭按钮；点遮罩、Esc、关闭按钮都能关，键盘 Tab 只在对话框里循环。
 * 下拉关闭只在触屏上有（桌面上不挂拖动手势）。
 */
const open = defineModel('open', { type: Boolean, default: false })
useBackDismiss(open)
defineProps({ title: { type: String, default: '' } })

const titleId = useId()
const sheet = ref(null)
const mask = ref(null)
const drag = useSheetDrag(sheet, mask, () => { open.value = false })
/* 桌面上不挂下拉手势，换成 Tab 键循环 */
const deskOn = { keydown: e => trapTab(e, sheet.value) }
let returnFocus = null

/* move focus into the sheet while it is open and give it back to the opener afterwards */
watch(open, async isOpen => {
  if (isOpen) {
    returnFocus = document.activeElement
    await nextTick()
    sheet.value?.focus({ preventScroll: true })
    // 不认 preventScroll 的 Safari 14：弹层这时还在屏幕下面（升起的起点），浏览器会把整个 #app 往上滚一截、
    // 再随着弹层升起一点点滚回来，整页一晃。和 LoginSheet 一样，聚焦后把外壳拨回原位
    const app = document.getElementById('app')
    if (app?.scrollTop) app.scrollTop = 0
  } else if (returnFocus && returnFocus.isConnected) {
    returnFocus.focus({ preventScroll: true })
    returnFocus = null
  }
})

const route = useRoute()
watch(() => route.fullPath, () => { open.value = false })
onDeactivated(() => { open.value = false })
</script>

<template>
  <Teleport to="#app">
    <Transition name="sheet-mask">
      <div v-if="open" ref="mask" class="mask" @click="open = false" />
    </Transition>
    <Transition name="sheet" @before-leave="drag.beforeLeave" @after-leave="drag.afterLeave">
      <div
        v-if="open"
        ref="sheet"
        class="sheet"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="title ? titleId : undefined"
        tabindex="-1"
        @keydown.esc="open = false"
        v-on="isDesktop ? deskOn : drag.on"
      >
        <div class="grab" />
        <h4 v-if="title" :id="titleId">{{ title }}</h4>
        <slot />
        <!-- 桌面对话框的关闭按钮（放在最后：打开后 Tab 先到内容；位置在右上角） -->
        <button v-if="isDesktop" type="button" class="sheet-x" aria-label="关闭" title="关闭" @click="open = false"><Icon name="close" /></button>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.mask {
  position: absolute;
  inset: 0;
  z-index: var(--z-mask);
  background: rgba(0, 0, 0, .55);
}
.sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-sheet);
  max-height: 72%;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 6px 14px calc(18px + var(--safe-b));
  border-radius: 16px 16px 0 0;
  background: #151515;
  /* 往下延伸一截同色的底：弹簧回弹时弹层会略微越过原位，底下不会露出一道缝（阴影不受自身 overflow 裁剪） */
  box-shadow: 0 64px 0 #151515;
  outline: 0;
}
.sheet .grab { width: 36px; height: 4px; margin: 4px auto 12px; border-radius: 2px; background: #333; }
.sheet h4 { margin-bottom: 12px; font-size: 15px; font-weight: 600; }

/*
 * 升起：smooth 弹簧从屏幕下沿升到原位。
 * 收起：同一根弹簧，目标是屏幕下沿再往下 64px（就是上面那截同色的底）：看得见的部分在弹簧最快的那段里就出了屏，
 * 收尾那段慢的发生在屏幕外面，不会有一道边在底部磨蹭。
 * 收起中的弹层和遮罩不接手指：关的同时就可以点下面的页面。
 */
.sheet-mask-enter-active { transition: opacity var(--dur-3) var(--ease-out); }
.sheet-mask-leave-active { transition: opacity var(--dur-3) var(--ease-out); pointer-events: none; }
.sheet-mask-enter-from, .sheet-mask-leave-to { opacity: 0; }
.sheet-enter-active { transition: transform var(--dur-spring-smooth) var(--spring-smooth); }
.sheet-leave-active { transition: transform var(--dur-spring-smooth) var(--spring-smooth); pointer-events: none; }
.sheet-enter-from { transform: translate3d(0, 100%, 0); }
.sheet-leave-to { transform: translate3d(0, calc(100% + 64px), 0); }

/*
 * ---- 桌面布局（≥ 1024px）：窗口正中的对话框 ----
 * 上下左右都是 0、外边距 auto、高度按内容（max-content）：不用 transform 居中（半像素位移会让文字发虚），
 * transform 留给出现 / 收起的动画。出现：淡入 + 从 .96 放大（smooth 弹簧）；收起：淡出 + 缩一点，比出现快。
 * 遮罩、MeView / AdminUsersView 里直接用 .sheet 类的弹层也一样变成对话框。
 */
@media (min-width: 1024px) {
  .sheet {
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    width: calc(100% - 48px);
    max-width: 480px;
    height: max-content;
    max-height: min(84%, 760px);
    margin: auto;
    padding: 20px 24px 24px;
    border-radius: 16px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .07), 0 16px 48px rgba(0, 0, 0, .5);
    scrollbar-width: thin;
    scrollbar-color: #2e2e2e transparent;
  }
  .sheet .grab { display: none; }
  .sheet h4 { margin: 0 40px 16px 0; font-size: 17px; line-height: 24px; }
  .sheet-x {
    position: absolute;
    top: 16px;
    right: 16px;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--t2);
    transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
  }
  .sheet-x svg { width: 18px; height: 18px; stroke-width: 2.2; }

  .sheet-enter-active { transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-spring-smooth) var(--spring-smooth); }
  .sheet-leave-active { transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in); pointer-events: none; }
  /* 遮罩和对话框同一根曲线、同样长短一起淡掉：不会遮罩先没了、没压暗的页面上还浮着一个完整的对话框 */
  .sheet-mask-leave-active { transition: opacity var(--dur-2) var(--ease-in); }
  .sheet-enter-from { opacity: 0; transform: scale(.96); }
  .sheet-leave-to { opacity: 0; transform: scale(.97); }
}
@media (min-width: 1024px) and (hover: hover) {
  .sheet-x:hover { background: var(--chip); color: var(--t1); }
}
</style>
