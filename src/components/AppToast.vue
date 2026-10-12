<script setup>
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'
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
</script>

<template>
  <Teleport :to="fsEl || 'body'" :disabled="!fsEl">
    <!-- 短视频页底部是标题和进度条：提示放到顶栏下面（和「2X 快进中」同一位置），不挡标题 -->
    <div
      class="toast"
      :class="{ show: toastState.visible, top: route.name === 'short' || !!fsEl }"
      role="status"
      aria-live="polite"
    >
      {{ toastState.text }}
    </div>
  </Teleport>
</template>

<style>
.toast {
  position: absolute;
  left: 50%;
  bottom: calc(var(--tabbar-h) + var(--safe-b) + 40px);
  z-index: 80;
  max-width: 82%;
  padding: 9px 16px;
  border-radius: 10px;
  background: rgba(38, 38, 38, .94);
  color: #fff;
  font-size: 13px;
  line-height: 18px;
  text-align: center;
  opacity: 0;
  transform: translate(-50%, 10px);
  transition: .2s;
  pointer-events: none;
}
.toast.top {
  top: calc(var(--safe-t) + 62px);
  bottom: auto;
  transform: translate(-50%, -10px);
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }
</style>
