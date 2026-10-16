<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Cover from './Cover.vue'
// 点进播放页时先记下封面和标题，播放页加载期间先显示它们（见 components/video/preview.js）
import { rememberVideo } from './video/preview'
// 共享元素过渡：封面从卡片飞进播放器，返回时缩回来（见 components/motion/hero.js）
import { heroTap } from './motion/hero'

const props = defineProps({
  /** Video: { id, title, dur, cover } */
  video: { type: Object, required: true },
  /** full-width featured card */
  big: Boolean,
  /** link target; defaults to the video's play page */
  to: { type: String, default: null }
})

const router = useRouter()
const target = computed(() => props.to || `/video/${encodeURIComponent(props.video.id)}`)

/* RouterLink 自己的点击处理先跑（真的跳了才会 preventDefault），这里只记数据、起飞 */
function onClick(e) {
  rememberVideo(props.video)
  heroTap(e, e.currentTarget?.querySelector(':scope > .cv'), props.video, router, target.value)
}
</script>

<template>
  <!--
    m-press：按下缩一点、松手弹回（components/motion/press.js）
    data-vid：返回时找回这张卡片，封面从播放器缩回到这里（hero.js）
  -->
  <RouterLink :to="target" class="vc m-press" :class="{ big }" :data-vid="video.id" @click="onClick">
    <Cover class="cv" v-bind="video.cover">
      <!-- extra overlays (e.g. the code badge on recent searches) -->
      <slot name="badge" />
      <span class="dur">{{ video.dur }}</span>
    </Cover>
    <div class="tt">{{ video.title }}</div>
  </RouterLink>
</template>
