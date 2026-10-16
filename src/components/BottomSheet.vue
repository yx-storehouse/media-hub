<script setup>
import { ref, watch, nextTick, onDeactivated, useId } from 'vue'
import { useRoute } from 'vue-router'
import { useBackDismiss } from '@/composables/useBackDismiss'
import { useSheetDrag } from '@/components/motion/sheetDrag'

/*
 * Bottom sheet rendered over the whole app (teleported to #app).
 * Usage: <BottomSheet v-model:open="show" title="播放设置"> …content… </BottomSheet>
 * Content can use the shared classes .opts / .opt / .opt.on / .row2 / .sw / .sw.on (styles/common.css).
 * Closes on mask tap, Escape, the back button / gesture (only the sheet, the page stays),
 * dragging it down (components/motion/sheetDrag.js), route change and when its page is deactivated (KeepAlive).
 * 升起、收起都是 smooth 弹簧（几乎不过冲）；拖动松手接着手指的速度走；遮罩同时淡入淡出（样式在下面，LoginSheet 共用）。
 */
const open = defineModel('open', { type: Boolean, default: false })
useBackDismiss(open)
defineProps({ title: { type: String, default: '' } })

const titleId = useId()
const sheet = ref(null)
const mask = ref(null)
const drag = useSheetDrag(sheet, mask, () => { open.value = false })
let returnFocus = null

/* move focus into the sheet while it is open and give it back to the opener afterwards */
watch(open, async isOpen => {
  if (isOpen) {
    returnFocus = document.activeElement
    await nextTick()
    sheet.value?.focus({ preventScroll: true })
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
        v-on="drag.on"
      >
        <div class="grab" />
        <h4 v-if="title" :id="titleId">{{ title }}</h4>
        <slot />
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
</style>
