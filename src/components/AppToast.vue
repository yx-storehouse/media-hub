<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { toastState } from '@/composables/useToast'

const route = useRoute()

/*
 * 全屏时只有全屏元素里的内容看得见：提示跟着挪进全屏元素（播放页、短视频全屏时也能看到），
 * 退出全屏再回到原处。
 */
const fsEl = shallowRef(null)
const onFullscreen = () => {
  const el = document.fullscreenElement || document.webkitFullscreenElement || null
  // 整页全屏（本来就看得见）和 <video> 自己全屏（放不进子元素）时不用挪
  fsEl.value = el && el !== document.documentElement && el.tagName !== 'VIDEO' ? el : null
}
onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreen)
  document.addEventListener('webkitfullscreenchange', onFullscreen)
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreen)
  document.removeEventListener('webkitfullscreenchange', onFullscreen)
})

/*
 * 显示中的提示：最多一条。新提示来了，新的从下面弹上来（snappy 弹簧），旧的被它往上顶开一格再淡掉
 * （像一摞卡片往上叠，顶部样式时方向反过来），不是原地换字；到时间了原地缩小淡出。
 */
const items = ref([]) // [{ id, text }]
let seq = 0
watch(() => [toastState.visible, toastState.text], ([visible, text]) => {
  if (!visible || !text) { items.value = []; return }
  const cur = items.value[items.value.length - 1]
  if (!cur || cur.text !== text) items.value = [{ id: ++seq, text }]
}, { immediate: true })
/* 正在离开的那条不再算「显示中」；有新的一条顶上来时（不是到时间）走「被顶开」的离场 */
const leaving = el => {
  el.classList.remove('show')
  if (items.value.length) el.classList.add('pushed')
}
</script>

<template>
  <Teleport :to="fsEl || 'body'" :disabled="!fsEl">
    <!-- 短视频页底部是标题和进度条：提示放到顶栏下面（和「2X 快进中」同一位置），不挡标题 -->
    <div class="toasts" :class="{ top: route.name === 'short' || !!fsEl }" role="status" aria-live="polite">
      <TransitionGroup name="toast" @before-leave="leaving">
        <div v-for="t in items" :key="t.id" class="toast show">{{ t.text }}</div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style>
/* 高度为 0 的定位条：提示贴着它的下沿（顶部样式贴上沿）、水平居中，新旧两条叠在同一个位置 */
.toasts {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(var(--tabbar-h) + var(--safe-b) + 40px);
  z-index: var(--z-toast);
  height: 0;
  pointer-events: none;
  --toast-dir: 1; /* 新提示从哪边来：1 从下面浮上来（旧的往上让），-1 从上面落下来（顶部样式） */
}
.toasts.top { top: calc(var(--safe-t) + 62px); bottom: auto; --toast-dir: -1; }
.toast {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  width: max-content;
  max-width: 82%;
  margin: 0 auto;
  padding: 9px 16px;
  border-radius: 10px;
  background: rgba(38, 38, 38, .94);
  color: #fff;
  font-size: 13px;
  line-height: 18px;
  text-align: center;
}
.toasts.top .toast { top: 0; bottom: auto; }

/*
 * 出现：从来的那一侧带着缩小弹出来（snappy 弹簧，落定时有一点点「顶」的感觉），透明度很快到位。
 * 到时间：原地缩小淡出，比出现快。
 * 被新的一条顶开：往外让出自己一格的高度（smooth 弹簧）再淡掉，两条短暂地叠在一起，看得出是新的盖上来了。
 * 新的一条透明度 --dur-1 就到位、被顶开的那条一开始就往下掉（ease-out）：叠在一起时一眼看得出新的在上面，
 * 不会有旧的还亮着、新的还半透明，看起来像旧的压在新的上面的那几帧。
 */
.toast-enter-active { transition: opacity var(--dur-1) var(--ease-out), transform var(--dur-spring-snappy) var(--spring-snappy); }
.toast-enter-from { opacity: 0; transform: translate3d(0, calc(var(--toast-dir) * 16px), 0) scale(.88); }
.toast-leave-active { transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in); }
.toast-leave-to { opacity: 0; transform: scale(.92); }
.toast.pushed.toast-leave-active { transition: opacity var(--dur-3) var(--ease-out), transform var(--dur-spring-smooth) var(--spring-smooth); }
.toast.pushed.toast-leave-to { opacity: 0; transform: translate3d(0, calc(var(--toast-dir) * (-100% - 8px)), 0) scale(.94); }
</style>
