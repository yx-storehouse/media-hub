<script setup>
import { computed } from 'vue'
import { formatCount } from '@/utils/format'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import FollowBtn from '@/components/creator/FollowBtn.vue'
import RollNum from '@/components/video/RollNum.vue'

/*
 * 桌面布局（≥ 1024px）「我的关注」网格里的一张创作者卡片（views/FollowsView.vue 用；手机上还是原来的列表）。
 *
 *   <FollowCard :creator="c" :following="following(c)" :followers="followers(c)" @open="…" @follow="onFollowBtn(c)" />
 *   <FollowCard />        不传 creator：同样大小的骨架
 *
 * 竖着排、居中：头像 64px、名字（带认证标）、@名字、粉丝 · 视频数、两行简介，最下面是关注按钮（FollowBtn，状态由页面管）。
 * 整张卡片都能点进创作者主页（链接的 ::after 铺满卡片，关注按钮浮在它上面）；鼠标移上去底色亮一档、头像微微放大；
 * 按下去整张卡片缩一点（m-press），按关注按钮只缩按钮。简介固定占两行、按钮贴底：同一行的卡片一样高、按钮对齐。
 * 视频数：接口（/api/me/follows）给了 videoCount 才显示。
 */
const props = defineProps({
  /** { id, name, handle, avatar, verified, bio, videoCount? }；不传是骨架 */
  creator: { type: Object, default: null },
  following: Boolean,
  followers: { type: Number, default: 0 }
})
defineEmits(['open', 'follow'])

const to = computed(() => (props.creator ? `/creator/${encodeURIComponent(props.creator.id)}` : ''))
const videos = computed(() => {
  const n = props.creator?.videoCount
  return typeof n === 'number' ? n : null
})
</script>

<template>
  <div v-if="creator" class="fc m-press" :data-cid="creator.id">
    <RouterLink class="fc-link" :to="to" @click="$emit('open', creator)">
      <Cover class="fc-av" v-bind="creator.avatar || {}" />
      <div class="fc-nm">
        <span class="fc-n" :title="creator.name">{{ creator.name }}</span>
        <span v-if="creator.verified" class="vf" role="img" aria-label="已认证"><Icon name="verified" /></span>
      </div>
      <div v-if="creator.handle" class="fc-hd">@{{ creator.handle }}</div>
      <!-- 关注 / 取消关注后粉丝数像里程表一样翻过去（和创作者主页一致） -->
      <div class="fc-st">
        <span><b><RollNum :value="formatCount(followers)" :n="followers" /></b> 粉丝</span>
        <span v-if="videos !== null"><b>{{ formatCount(videos) }}</b> 视频</span>
      </div>
      <p class="fc-bio">{{ creator.bio }}</p>
    </RouterLink>
    <FollowBtn
      class="fc-btn"
      :on="following"
      :aria-label="following ? `已关注 ${creator.name}，点按取消关注` : `关注 ${creator.name}`"
      @click="$emit('follow', creator)"
    />
  </div>
  <!-- 骨架：和真卡片一样高，头像、名字、@名字、数据行、两行简介、按钮落在同一个位置 -->
  <div v-else class="fc fc-skel" aria-hidden="true">
    <div class="fc-av sk" />
    <div class="sk sk-n" />
    <div class="sk sk-h" />
    <div class="sk sk-s" />
    <div class="sk sk-b1" />
    <div class="sk sk-b2" />
    <div class="fc-btn sk" />
  </div>
</template>

<style scoped>
.fc {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
  padding: 24px 20px 20px;
  border-radius: 12px;
  background: var(--panel);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .04);
  text-align: center;
}
.fc-link { display: flex; flex: 1 0 auto; flex-direction: column; align-items: center; width: 100%; min-width: 0; }
/* 整张卡片都是这个链接：::after 铺满卡片（.fc 是定位的，链接本身不定位） */
.fc-link::after { content: ''; position: absolute; inset: 0; z-index: 0; border-radius: inherit; }
.fc-link:focus-visible { outline: 0; }
.fc-link:focus-visible::after { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 12px; }

.fc-av { flex: none; width: 64px; height: 64px; border-radius: 50%; background-color: #1a1a1a; box-shadow: 0 0 0 1px rgba(255, 255, 255, .08); filter: var(--media); }
.fc-nm { display: flex; justify-content: center; align-items: center; gap: 6px; max-width: 100%; margin-top: 12px; color: var(--t1); font-size: 16px; font-weight: 600; line-height: 24px; }
.fc-n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-nm .vf { display: flex; flex: none; }
.fc-nm .vf svg { width: 16px; height: 16px; }
.fc-hd { max-width: 100%; margin-top: 2px; overflow: hidden; color: var(--t2); font-size: 13px; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
.fc-st { display: flex; justify-content: center; gap: 12px; margin-top: 8px; color: var(--t2); font-size: 13px; line-height: 20px; white-space: nowrap; }
.fc-st, .fc-st * { font-variant-numeric: tabular-nums; }
.fc-st b { color: var(--t3); font-weight: 600; }
/* 简介：最多两行，固定占两行的高度（没有简介也一样），同一行的卡片按钮对齐 */
.fc-bio {
  display: -webkit-box;
  max-width: 100%;
  min-height: 40px;
  margin-top: 8px;
  overflow: hidden;
  color: var(--t-sub);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
@supports not (overflow-wrap: anywhere) {
  .fc-bio { word-break: break-word; }
}

/* 关注按钮（FollowBtn）：浮在铺满卡片的链接上面；链接撑满剩下的高度，按钮贴着卡片底部（同一行的卡片一样高） */
.fc-btn {
  position: relative;
  z-index: 1;
  flex: none;
  min-width: 96px;
  height: 36px;
  margin-top: 16px;
  padding: 0 18px;
  border-radius: 18px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-weight: 700;
}
.fc-btn.on { background: #1f1f1f; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); color: var(--t2); }

/* ---- 骨架 ---- */
.fc-skel { cursor: default; }
.sk { border-radius: 6px; background: #1a1a1a; animation: sk 1.2s ease-in-out infinite; }
/* 头像、按钮的骨架和真的一样是圆的 / 胶囊（上面 .sk 的 6px 圆角写在后面，会盖掉 .fc-av / .fc-btn 自己的圆角） */
.fc-av.sk { border-radius: 50%; box-shadow: none; }
/* 每条的高度 + 上下边距和真卡片那一行文字一样（名字 12 + 24、@名字 2 + 20、数据 8 + 20、简介 8 + 两行 20），条落在文字的位置上 */
.sk-n { width: 44%; height: 16px; margin: 16px 0 4px; }
.sk-h { width: 30%; height: 12px; margin: 6px 0 4px; }
.sk-s { width: 52%; height: 12px; margin: 12px 0 4px; }
.sk-b1 { width: 80%; height: 12px; margin-top: 12px; }
.sk-b2 { width: 56%; height: 12px; margin: 8px 0 4px; }
.fc-btn.sk { width: 96px; border-radius: 18px; background: #1a1a1a; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}

@media (hover: hover) {
  .fc:not(.fc-skel) { transition: background-color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out); }
  .fc:not(.fc-skel):hover { background: #161616; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .07); }
  /* 头像在自己的圆里放大一点（和视频卡片的封面一样，只放大照片） */
  .fc-av > :deep(img) { transition: opacity var(--dur-3) var(--ease-out), filter var(--dur-3) var(--ease-out), transform var(--dur-4) var(--ease-out); }
  .fc-av > :deep(img.now) { transition: transform var(--dur-4) var(--ease-out); }
  .fc:hover .fc-av > :deep(img) { transform: scale(1.06); }
  .fc-btn:not(.on):hover { background: #e6e6e6; }
  .fc-btn.on:hover { background: #2a2a2a; color: var(--t3); }
}
</style>
