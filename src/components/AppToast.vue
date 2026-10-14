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
 * 显示中的提示：最多一条。新提示来了，旧的往上淡出、新的从下面浮上来（像叠上去一样），
 * 不是原地换字；到时间了往上淡出。
 */
const items = ref([]) // [{ id, text }]
let seq = 0
watch(() => [toastState.visible, toastState.text], ([visible, text]) => {
  if (!visible || !text) { items.value = []; return }
  const cur = items.value[items.value.length - 1]
  if (!cur || cur.text !== text) items.value = [{ id: ++seq, text }]
}, { immediate: true })
/* 正在离开的那条不再算「显示中」 */
const leaving = el => el.classList.remove('show')
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
  z-index: 80;
  height: 0;
  pointer-events: none;
}
.toasts.top { top: calc(var(--safe-t) + 62px); bottom: auto; }
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

/* 从稍下方放大浮现；离开时往上淡出，比出现快 */
.toast-enter-active { transition: opacity var(--dur-3) var(--ease-out), transform var(--dur-3) var(--ease-out); }
.toast-leave-active { transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in); }
.toast-enter-from { opacity: 0; transform: translate3d(0, var(--rise), 0) scale(.94); }
.toast-leave-to { opacity: 0; transform: translate3d(0, calc(var(--rise) * -1), 0) scale(.98); }
</style>
