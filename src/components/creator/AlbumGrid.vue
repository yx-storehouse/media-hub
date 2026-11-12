<script setup>
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

/*
 * 创作者主页「图片」：一个图集一格，三列竖向 3:4 的格子，缝 2px、左右贴边（和常见的个人主页作品墙一样）。
 * 封面（图集的第一张）裁满整格；不止一张的图集右上角有一个叠图小图标 + 张数；格子上不写标题。
 * 点一格发 open(item)，由页面打开全屏看大图（从这一格放大出来、关掉时缩回这一格）。
 *
 *   <AlbumGrid ref="grid" :items="albums.list" @open="openAlbum" />
 *   grid.value.tile(item.id)    // 某一格的元素：看大图从这一格放大出来、关掉时缩回这一格
 *
 * 结构（给动效挂钩子用）：.ag 网格 > .ag-t 一格（按住时全局 m-hold 加 .m-pressed，封面压暗一点，和「媒体」一样）
 * > .ag-cv 封面 + .ag-n 张数角标。3:4 用 padding 撑高（iOS 14 不认 aspect-ratio）。
 */
defineProps({
  /** AlbumItem[]：{ id, title, cover, count, publishedAt, time }（见 src/api/index.js） */
  items: { type: Array, required: true }
})
const emit = defineEmits(['open'])

/* 每一格的元素，按图集 id 存 */
const tiles = new Map()
function setTile(id, el) {
  if (el) tiles.set(id, el)
  else tiles.delete(id)
}
defineExpose({ tile: id => tiles.get(id) || null })

const label = a => (a.count > 1 ? `查看图集：${a.title || '未命名'}，共 ${a.count} 张` : `查看图片${a.title ? `：${a.title}` : ''}`)
</script>

<template>
  <div class="ag">
    <button
      v-for="a in items"
      :key="a.id"
      :ref="el => setTile(a.id, el)"
      type="button"
      class="ag-t m-hold"
      :class="{ multi: a.count > 1 }"
      :aria-label="label(a)"
      @click="emit('open', a)"
    >
      <Cover class="ag-cv" :src="a.cover?.src || null" :fallback="a.cover?.fallback || null" />
      <span v-if="a.count > 1" class="ag-n" aria-hidden="true">
        <Icon name="images" />
        <span>{{ a.count }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
.ag { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px; }
.ag-t {
  position: relative;
  display: block;
  min-width: 0;
  overflow: hidden;
  background: #161616;
  -webkit-tap-highlight-color: transparent;
}
/* 3:4 竖格 */
.ag-t::before { content: ''; display: block; padding-top: 133.3333%; }
.ag-cv {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  filter: var(--media);
  transition: opacity var(--dur-2) var(--ease-out);
}
/* 按住：封面压暗一点（缩放留给格子本身，不让 2px 的缝跟着变；和「媒体」的照片墙一样） */
.ag-t.m-pressed .ag-cv { opacity: .72; transition-duration: var(--dur-1); }
.ag-t:focus-visible { outline-offset: -3px; }

/* 多张的图集：顶上一层淡淡的暗角托住右上角的白色角标（亮的照片上也看得清） */
.ag-t.multi::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 30%;
  background: linear-gradient(to bottom, rgba(0, 0, 0, .4), rgba(0, 0, 0, 0));
  pointer-events: none;
}
.ag-n {
  position: absolute;
  top: 6px;
  right: 6px;
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
.ag-n svg { flex: none; width: 11px; height: 11px; filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, .35)); }

/*
 * 桌面布局（≥ 1024px）：和「媒体」的照片墙同一个规格——不贴边，和网格同宽、左右对齐，
 * 格子按 180px 起自动排列数（1440 宽 6 列，1920 宽 8 列），缝 6px、小圆角。鼠标移上去照片在格子里放大一点。
 */
@media (min-width: 1024px) {
  .ag {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 6px;
    max-width: var(--desk-max);
    margin: 0 auto;
    padding: 0 var(--desk-pad);
  }
  .ag-t { border-radius: 8px; }
  .ag-t:focus-visible { outline-offset: 2px; }
  .ag-n { top: 8px; right: 8px; gap: 4px; font-size: 12px; line-height: 16px; }
  .ag-n svg { width: 12px; height: 12px; }
}
@media (min-width: 1024px) and (hover: hover) {
  /* 照片在 Cover 组件里（不带本组件的 scoped 标记）：用 :deep 选到 */
  .ag-cv :deep(img) { transition: opacity var(--dur-3) var(--ease-out), filter var(--dur-3) var(--ease-out), transform var(--dur-4) var(--ease-out); }
  .ag-cv :deep(img.now) { transition: transform var(--dur-4) var(--ease-out); }
  .ag-t:hover .ag-cv :deep(img) { transform: scale(1.04); }
}
</style>
