<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { formatCount } from '@/utils/format'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import { heroRelated } from '@/components/motion/hero'
import { isDesktop } from '@/composables/useDesktop'
import { rememberVideo } from './preview'

/*
 * 播放页「相似推荐」的一行：左封面，右标题 + 标签 + 播放 / 收藏数；点进去时先记下封面和标题，新页面加载时先显示。
 * 点下去缩略图飞进上面的播放器（components/motion/hero.js 的 heroRelated）。
 * 桌面布局（≥ 1024px）：16:9 的 168px 缩略图，标题下面是作者名（不显示标签）；鼠标移上去整行有一层浅底、封面在圆角里放大一点。
 */
const props = defineProps({
  /** Video + { tags, playCount, favCount } */
  video: { type: Object, required: true },
  /** 缩略图已经飞上去了（播放页在等新视频的内容，旧列表还留着）：这里空着，画面上只有飞上去的那一份 */
  away: Boolean
})

const router = useRouter()
const to = computed(() => `/video/${encodeURIComponent(props.video.id)}`)
const tags = computed(() => (props.video.tags || []).slice(0, 3).map(t => String(t).replace(/^#/, '')))

/* RouterLink 自己的点击处理先跑（真的跳了才会 preventDefault） */
function onClick(e) {
  rememberVideo(props.video)
  heroRelated(e, e.currentTarget?.querySelector(':scope > .rv-cv'), props.video, router, to.value)
}
</script>

<template>
  <RouterLink :to="to" class="rv" :class="{ away }" @click="onClick">
    <Cover class="rv-cv" v-bind="video.cover"><span class="dur">{{ video.dur }}</span></Cover>
    <div class="rv-bd">
      <div class="rv-tt">{{ video.title }}</div>
      <div v-if="isDesktop && video.creator?.name" class="rv-by">{{ video.creator.name }}</div>
      <div v-if="tags.length" class="rv-tags"><span v-for="t in tags" :key="t">{{ t }}</span></div>
      <div class="rv-st">
        <span><Icon name="play" />{{ formatCount(video.playCount) }}</span>
        <span><Icon name="heart" />{{ formatCount(video.favCount) }}</span>
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
.rv { display: flex; gap: 11px; padding: 0 14px; }
.rv:active { opacity: .82; }
.rv-cv { flex: none; width: 142px; aspect-ratio: 16 / 10; border-radius: 7px; filter: var(--media); }
/* hero.js 落地时会把缩略图露回来：旧列表还在的这一会儿用 class 接着藏着 */
.rv.away .rv-cv { visibility: hidden; }
.rv-bd { display: flex; flex: 1; flex-direction: column; min-width: 0; padding: 1px 0; }
.rv-tt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--t1);
  font-size: 14px;
  line-height: 20px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.rv-tags { display: flex; gap: 5px; margin-top: 6px; overflow: hidden; }
.rv-tags span { flex: none; height: 19px; padding: 0 7px; border-radius: 4px; background: var(--chip); color: var(--t2); font-size: 11px; line-height: 19px; }
.rv-st { display: flex; gap: 22px; margin-top: auto; color: var(--t2); font-size: 12px; font-variant-numeric: tabular-nums; }
.rv-st span { display: flex; align-items: center; gap: 4px; }
.rv-st svg { width: 11px; height: 11px; }

/* iOS 14 / 安卓 WebView 87 不认 aspect-ratio（Safari 15、Chrome 88 才有）：里面全是绝对定位的东西，高度会是 0，用 ::before 的 padding 撑出同样的比例 */
@supports not (aspect-ratio: 1 / 1) {
  .rv-cv::before { content: ''; display: block; padding-top: 62.5%; }
}

/* ---------- 桌面布局（≥ 1024px）：一行往两边各伸出 8px，鼠标移上去的浅底不贴着字 ---------- */
@media (min-width: 1024px) {
  .rv { gap: 12px; margin: 0 -8px; padding: 6px 8px; border-radius: 12px; }
  .rv-cv { width: 168px; aspect-ratio: 16 / 9; border-radius: 8px; }
  .rv-cv .dur { right: 6px; bottom: 6px; }
  .rv-bd { padding: 0; }
  .rv-tt { font-size: 14px; font-weight: 500; line-height: 20px; }
  .rv-by { margin-top: 4px; overflow: hidden; color: var(--t2); font-size: 13px; line-height: 18px; white-space: nowrap; text-overflow: ellipsis; }
  .rv-tags { display: none; }
  .rv-st { gap: 16px; font-size: 12px; line-height: 16px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .rv { transition: background-color var(--dur-2) var(--ease-out); }
  .rv:hover { background: #151515; }
  .rv-by { transition: color var(--dur-2) var(--ease-out); }
  .rv:hover .rv-by { color: #a6a6a6; }
  /* 封面照片在自己的圆角里放大一点（缓存里直接显示的图 .now 也要这段过渡；占位图不动） */
  .rv-cv :deep(img) { transition: opacity var(--dur-3) var(--ease-out), filter var(--dur-3) var(--ease-out), transform var(--dur-4) var(--ease-out); }
  .rv-cv :deep(img.now) { transition: transform var(--dur-4) var(--ease-out); }
  .rv:hover .rv-cv :deep(img) { transform: scale(1.03); }
}
@media (min-width: 1024px) {
  @supports not (aspect-ratio: 1 / 1) {
    .rv-cv::before { padding-top: 56.25%; }
  }
}
</style>
