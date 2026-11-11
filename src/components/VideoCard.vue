<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Cover from './Cover.vue'
import { isDesktop } from '@/composables/useDesktop'
import { formatCount } from '@/utils/format'
// 点进播放页时先记下封面和标题，播放页加载期间先显示它们（见 components/video/preview.js）
import { rememberVideo } from './video/preview'
// 共享元素过渡：封面从卡片飞进播放器，返回时缩回来（见 components/motion/hero.js）
import { heroTap } from './motion/hero'

const props = defineProps({
  /** Video: { id, title, dur, cover, creator?, playCount? } */
  video: { type: Object, required: true },
  /** full-width featured card */
  big: Boolean,
  /** 桌面布局的大卡片：在网格里占 2 列 × 2 行（推荐页第一个分区，由 RecommendSection 决定什么时候用） */
  feature: Boolean,
  /** 桌面布局的信息行里显示作者名（创作者自己的主页上可以关掉，只留播放数） */
  by: { type: Boolean, default: true },
  /** link target; defaults to the video's play page */
  to: { type: String, default: null }
})

const router = useRouter()
const target = computed(() => props.to || `/video/${encodeURIComponent(props.video.id)}`)

/*
 * 桌面布局（≥ 1024px）标题下面多一行：作者 · 播放数（和观看历史的写法一样）。手机上没有这一行，卡片和以前一模一样。
 * 两样都没有时不渲染，卡片少一行高（同一行里的卡片照样上沿对齐，标题固定占两行）。
 */
const meta = computed(() => {
  const v = props.video
  const parts = []
  if (props.by && v.creator?.name) parts.push(v.creator.name)
  if (Number(v.playCount) > 0) parts.push(`${formatCount(v.playCount)}次播放`)
  return parts.join(' · ')
})

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
  <RouterLink :to="target" class="vc m-press" :class="{ big, feat: feature, 'has-meta': isDesktop && !!meta }" :data-vid="video.id" @click="onClick">
    <Cover class="cv" v-bind="video.cover">
      <!-- extra overlays (e.g. the code badge on recent searches) -->
      <slot name="badge" />
      <span class="dur">{{ video.dur }}</span>
    </Cover>
    <!-- 桌面上标题最多两行，鼠标停在标题上能看到全名 -->
    <div class="tt" :title="isDesktop ? video.title : undefined">{{ video.title }}</div>
    <div v-if="isDesktop && meta" class="vc-meta">{{ meta }}</div>
  </RouterLink>
</template>

<style>
/*
 * ---- 桌面布局（≥ 1024px）----
 * 卡片的尺寸、悬停（封面放大、标题变亮）都在 styles/common.css 的公共样式里，这里只加两样：
 *   .vc-meta  标题下面的「作者 · 播放数」，13px 一行（比标题暗一档，标题悬停变亮时层次更清楚）
 *   .vc.feat  推荐页的大卡片：占 2 列 × 2 行，封面撑满标题以外的高度（比例随列宽在 4:3 上下），标题 18px
 */
@media (min-width: 1024px) {
  /* 有信息行时标题不再固定占两行：一行的标题下面紧跟着信息行（同一行的卡片照样上沿对齐，下沿参差看不出来） */
  .vc.has-meta .tt { min-height: 0; }
  .vc-meta {
    margin-top: 4px;
    overflow: hidden;
    color: #7a7a7a;
    font-size: 13px;
    line-height: 18px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .grid > .vc.feat { display: flex; flex-direction: column; grid-column: span 2; grid-row: span 2; }
  /* 封面不按 16:10 定高，而是吃掉两行里标题、信息行以外的全部高度；网格的行高由旁边的普通卡片决定 */
  .vc.feat > .cv { flex: 1 1 0; min-height: 0; aspect-ratio: auto; border-radius: 12px; }
  .vc.feat .dur { right: 12px; bottom: 12px; height: 24px; padding: 0 9px; border-radius: 7px; font-size: 13px; line-height: 24px; }
  .vc.feat .tt { flex: none; min-height: 0; margin-top: 12px; color: var(--t3); font-size: 18px; font-weight: 600; line-height: 26px; }
  .vc.feat .vc-meta { flex: none; margin-top: 6px; font-size: 14px; line-height: 20px; }
  /* 骨架 / 旧列表整块淡出时（common.css 的 .m-skel-leave-active）信息行和标题一样立刻藏起来，文字交叉淡化会叠成一团 */
  .m-skel-leave-active .vc-meta { visibility: hidden; }
  /* 键盘焦点框：跟着封面的圆角、离开一点，不是贴着卡片的直角方框 */
  .vc:focus-visible { border-radius: 14px; outline-offset: 4px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .vc.feat:hover .tt { color: var(--t1); }
}
</style>
