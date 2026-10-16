<script setup>
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
// 点进播放页时先记下封面和标题，播放页加载期间先显示它们（见 components/video/preview.js）
import { rememberVideo } from '@/components/video/preview'

/*
 * 创作者主页「媒体」：三列正方形照片墙，格子之间 2px，左右贴边。
 *   视频格（.mg-video）：右下角一个小播放三角 + 时长，点了进播放页
 *   图片格：点了发 open(item)，由页面打开全屏看大图
 *
 *   <MediaGrid ref="grid" :items="media.list" @open="openImage" />
 *   grid.value.tile(item.id)    // 某一格的元素：看大图从这一格放大出来、关掉时缩回这一格
 *
 * 结构（给动效挂钩子用）：.mg 网格 > .mg-t 一格（按住时全局 m-hold 加 .m-pressed）> .mg-cv 封面 + .mg-meta 视频角标。
 * 正方形用 padding 撑高（iOS 14 不认 aspect-ratio）。
 */
defineProps({
  /** MediaItem[]：{ id, kind: 'image' | 'video', cover, title, postId, videoId, dur }（见 src/api/index.js） */
  items: { type: Array, required: true }
})
const emit = defineEmits(['open'])

/* 每一格的元素，按 item.id 存（视频格是 RouterLink，取它的 <a>） */
const tiles = new Map()
function setTile(id, el) {
  const node = el?.$el ?? el
  if (node) tiles.set(id, node)
  else tiles.delete(id)
}
defineExpose({ tile: id => tiles.get(id) || null })

const videoTo = m => `/video/${encodeURIComponent(m.videoId)}`
const remember = m => rememberVideo({ id: m.videoId, title: m.title, cover: m.cover, dur: m.dur })
const videoLabel = m => `播放视频：${m.title || '未命名'}${m.dur ? `，时长 ${m.dur}` : ''}`
</script>

<template>
  <div class="mg">
    <template v-for="m in items" :key="m.id">
      <RouterLink
        v-if="m.kind === 'video'"
        :ref="el => setTile(m.id, el)"
        class="mg-t mg-video m-hold"
        :to="videoTo(m)"
        :aria-label="videoLabel(m)"
        @click="remember(m)"
      >
        <Cover class="mg-cv" v-bind="m.cover || {}" />
        <span class="mg-meta" aria-hidden="true">
          <Icon name="play" />
          <span v-if="m.dur">{{ m.dur }}</span>
        </span>
      </RouterLink>
      <button
        v-else
        :ref="el => setTile(m.id, el)"
        type="button"
        class="mg-t m-hold"
        :aria-label="`查看大图：${m.title || '图片'}`"
        @click="emit('open', m)"
      >
        <Cover class="mg-cv" v-bind="m.cover || {}" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.mg { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px; }
.mg-t {
  position: relative;
  display: block;
  min-width: 0;
  overflow: hidden;
  background: #161616;
  -webkit-tap-highlight-color: transparent;
}
.mg-t::before { content: ''; display: block; padding-top: 100%; }
.mg-cv {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  filter: var(--media);
  transition: opacity var(--dur-2) var(--ease-out);
}
/* 按住：封面压暗一点（缩放留给格子本身，不让 2px 的缝跟着变） */
.mg-t.m-pressed .mg-cv { opacity: .72; transition-duration: var(--dur-1); }
.mg-t:focus-visible { outline-offset: -3px; }

/* 视频格：底部一层淡淡的暗角托住白字 */
.mg-video::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 42%;
  background: linear-gradient(to top, rgba(0, 0, 0, .52), rgba(0, 0, 0, 0));
  pointer-events: none;
}
.mg-meta {
  position: absolute;
  right: 6px;
  bottom: 5px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 3px;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 14px;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .4);
}
.mg-meta svg { flex: none; width: 10px; height: 10px; }
</style>
