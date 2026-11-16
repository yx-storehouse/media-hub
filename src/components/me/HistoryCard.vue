<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import { rememberVideo } from '@/components/video/preview'
import { heroTap } from '@/components/motion/hero'
import { formatClock } from '@/utils/format'
import { progress, progressBadge } from './history'

/*
 * 桌面布局（≥ 1024px）观看历史网格里的一张卡片（views/HistoryView.vue 用；手机上还是原来的列表，不用它）。
 *
 *   <HistoryCard :video="v" :at="stamp(v.watchedAt, g.key)" :removed="isRemoved(v.id)" :locked="committing.has(v.id)"
 *                @open="open(v)" @remove="remove(v, $event)" @undo="undo(v, $event)" />
 *
 * 和视频卡片（VideoCard）同一套：.vc / .cv / .tt / .vc-meta 的尺寸、悬停（封面放大、标题变亮）、按压缩放、
 * 点下去封面飞进播放器（hero，返回时缩回这张卡片：data-vid）都一样，网格里和别的视频网格对得上。不同的几处：
 *   - 封面底部一条进度条（白色是看过的部分），右下角的角标是「看到 12:34 / 20:15」「已看完」（刚开始看的照常是时长）；
 *   - 信息行是「作者 · 观看时间」；
 *   - 右上角的 × 删除：鼠标移到卡片上、或键盘焦点在卡片上时才出现（没有鼠标的设备一直显示）；
 *   - 删掉后封面的位置换成「已删除 · 撤销」（removed），卡片原地不动，几秒后才真正删掉（由页面决定）。
 * 点卡片只发出 open（页面记下续播的位置），跳转由 RouterLink 自己做。
 */
const props = defineProps({
  /** 观看历史的一条：Video + { progressSec, watchedAt } */
  video: { type: Object, required: true },
  /** 信息行里的观看时间 */
  at: { type: String, default: '' },
  /** 已删除、还能撤销 */
  removed: Boolean,
  /** 撤销时间到了、删除请求在路上：「撤销」不能再点 */
  locked: Boolean
})
const emit = defineEmits(['open', 'remove', 'undo'])

const router = useRouter()
const to = computed(() => `/video/${encodeURIComponent(props.video.id)}`)
const p = computed(() => progress(props.video))
/*
 * 右下角的角标：看到哪 / 已看完；刚开始看的照常是时长。时长也用播放器的写法（「24:30」「1:02:03」），
 * 和同一个网格里「看到 4:24 / 24:30」的角标是一种写法（接口的 dur 是「00:24:30」）；不知道总长时才用 dur
 */
const badge = computed(() => {
  const b = progressBadge(props.video)
  if (b) return b
  const len = Number(props.video.len) || 0
  return len ? formatClock(len) : props.video.dur || ''
})
const meta = computed(() => [props.video.creator?.name, props.at].filter(Boolean).join(' · '))

/* RouterLink 自己的点击处理先跑（真的跳了才会 preventDefault）：页面先记下续播位置，这里记数据、起飞（同 VideoCard） */
function onClick(e) {
  emit('open', props.video)
  rememberVideo(props.video)
  heroTap(e, e.currentTarget?.querySelector(':scope > .cv'), props.video, router, to.value)
}
</script>

<template>
  <div class="hc" :class="{ removed }" :data-hid="video.id">
    <RouterLink :to="to" class="vc has-meta hc-link m-press" :data-vid="video.id" @click="onClick">
      <Cover class="cv" v-bind="video.cover">
        <span v-if="p.pct" class="hc-track"><span class="hc-bar" :style="{ width: p.pct + '%' }" /></span>
        <span v-if="badge" class="dur">{{ badge }}</span>
      </Cover>
      <div class="tt" :title="video.title">{{ video.title }}</div>
      <div v-if="meta" class="vc-meta">{{ meta }}</div>
    </RouterLink>
    <button v-if="!removed" type="button" class="hc-del m-press-sm" :aria-label="`删除观看记录：${video.title}`" title="删除这条记录" @click="emit('remove', $event)">
      <Icon name="close" />
    </button>
    <!-- 删掉以后：封面的位置换成「已删除 · 撤销」（交叉淡入淡出），卡片的位置不变 -->
    <Transition name="hc-swap">
      <div v-if="removed" class="hc-undo" role="status">
        <p class="hc-undo-t">已删除「{{ video.title }}」</p>
        <button type="button" class="undo" :disabled="locked" @click="emit('undo', $event)">撤销</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.hc { position: relative; min-width: 0; }
/* 删掉的卡片：内容淡出后藏起来（不能再 Tab 到、读屏也读不到），位置留着 */
.hc-link { display: block; transition: opacity var(--dur-2) var(--ease-out), visibility 0s; }
.removed .hc-link { opacity: 0; visibility: hidden; transition: opacity var(--dur-1) var(--ease-out), visibility 0s linear var(--dur-1); }
/* 键盘焦点框：跟着封面的圆角、离开一点（同 VideoCard） */
.hc-link:focus-visible { border-radius: 14px; outline-offset: 4px; }

/* 进度条：封面底部，白色是看过的部分（刚开始看的不画） */
.hc-track { position: absolute; left: 0; right: 0; bottom: 0; z-index: 1; height: 4px; background: rgba(255, 255, 255, .22); }
.hc-bar { display: block; height: 100%; background: var(--accent); }
/* 有进度条时角标往上挪一点，不贴着进度条 */
.hc-track ~ .dur { bottom: 10px; }

/* × 删除：和「我的收藏」卡片上的心形同一个样子（右上角半透明圆底） */
.hc-del {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(0, 0, 0, .46);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #fff;
}
.hc-del svg { width: 16px; height: 16px; stroke-width: 2.4; }
/* 圆底只有 32px：能点的范围撑到 44px（触屏大屏上手指也好点；离封面边缘 8px，撑出去的还在封面里） */
.hc-del::after { content: ''; position: absolute; inset: -6px; }

/* 「已删除 · 撤销」：盖在封面的位置上，和封面一样大 */
.hc-undo {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  aspect-ratio: 16 / 10;
  padding: 0 20px;
  border-radius: 10px;
  background: var(--panel);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06);
  color: var(--t2);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}
.hc-undo-t {
  display: -webkit-box;
  max-width: 100%;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
@supports not (overflow-wrap: anywhere) {
  .hc-undo-t { word-break: break-word; }
}
/* 老引擎不认 aspect-ratio：盖住整张卡片 */
@supports not (aspect-ratio: 1 / 1) {
  .hc-undo { bottom: 0; }
}
.undo { flex: none; height: 32px; padding: 0 18px; border-radius: 16px; background: #222; color: var(--t1); font-size: 13px; font-weight: 600; transition: opacity var(--dur-1) var(--ease-out); }
.undo:active { opacity: .6; }
.undo:disabled { opacity: .5; }

/* 换成撤销条：旧的淡出，新的淡入、轻轻放大到位 */
.hc-swap-enter-active { transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out); }
.hc-swap-leave-active { pointer-events: none; transition: opacity var(--dur-1) var(--ease-in); }
.hc-swap-enter-from { opacity: 0; transform: scale(.98); }
.hc-swap-leave-to { opacity: 0; }

@media (hover: hover) {
  /* 鼠标在 × 上时卡片照样是「悬停」的样子（common.css 的 .vc:hover 只管链接本身） */
  .hc:hover .tt { color: var(--t1); }
  .hc:hover .cv > :deep(img) { transform: scale(1.03); }
  /*
   * × 平时藏着，鼠标移到卡片上、或键盘焦点在卡片上（或 × 本身）时才出现。
   * 不用 :focus-within / :focus：用鼠标点进播放页再返回时，焦点会被放回这张卡片（useMainFocus）；用鼠标点了的按钮
   * 焦点也会留在上面——× 会一直挂着。只认键盘焦点（:focus-visible）。
   * :focus-visible 单独一条（老 Safari 不认，写在一起整条都会失效）；不认它的老 Safari 退回到 :focus
   */
  .hc-del { opacity: 0; transition: opacity var(--dur-2) var(--ease-out), background-color var(--dur-2) var(--ease-out); }
  .hc:hover .hc-del { opacity: 1; }
  .hc-del:focus-visible { opacity: 1; }
  .hc-link:focus-visible ~ .hc-del { opacity: 1; }
  @supports not selector(:focus-visible) {
    .hc-del:focus { opacity: 1; }
  }
  .hc-del:hover { background: rgba(0, 0, 0, .66); }
  .undo { transition: background-color var(--dur-2) var(--ease-out), opacity var(--dur-1) var(--ease-out); }
  .undo:not(:disabled):hover { background: #2a2a2a; }
}
</style>
