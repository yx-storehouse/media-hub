<script setup>
import { ref, computed } from 'vue'
import { formatCount } from '@/utils/format'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import RollNum from '@/components/video/RollNum.vue'
import FollowBtn from './FollowBtn.vue'
import { vRise } from '@/components/home/motion'

/*
 * 创作者主页头部：头图（最近作品拼成的一排图，没有作品时用按 id 生成的灰色渐变）→ 压在头图上的头像 + 关注按钮
 * → 名字、认证 → 一行灰色数据（窄屏自动换行，行首不会出现「·」）→ 简介。
 * creator 为空时是加载骨架。
 */
const props = defineProps({
  /** getCreator() 的结果；null = 加载中 */
  creator: { type: Object, default: null },
  following: Boolean,
  followers: { type: Number, default: 0 },
  /** 返回恢复：头部原样出现，不播入场 */
  calm: Boolean
})
defineEmits(['follow'])

/* 和 CreatorView 的 BANNER 一致 */
const BANNER = 150

/*
 * 头图跟着滚动：往上滚时头图比内容慢（视差）并慢慢变淡；iOS 在顶部往下拉（回弹）时头图从底边往上放大，
 * 填满拉出来的空白。CreatorView 在滚动时调（每帧最多一次），直接改样式，不触发重新渲染。
 */
const bg = ref(null)
function parallax(top) {
  const el = bg.value
  if (!el) return
  if (top < 0) {
    el.style.transform = `scale(${1 + -top / BANNER})`
    el.style.opacity = ''
  } else if (top < BANNER) {
    el.style.transform = top ? `translate3d(0, ${top * 0.4}px, 0)` : ''
    el.style.opacity = top ? String(1 - (top / BANNER) * 0.6) : ''
  }
}
defineExpose({ parallax })

const banner = computed(() => (props.creator?.banner || []).filter(Boolean).slice(0, 3))

/* 没有作品图时的头图：同一个创作者每次都是同一张（角度、光斑位置由 id 决定） */
const generated = computed(() => {
  let h = 2166136261
  for (const ch of String(props.creator?.id ?? '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  const angle = 115 + (h % 60)
  const x = 12 + ((h >>> 6) % 72)
  const y = 18 + ((h >>> 13) % 46)
  return `radial-gradient(circle at ${x}% ${y}%, rgba(255, 255, 255, .13), rgba(255, 255, 255, 0) 58%), linear-gradient(${angle}deg, #2b2b2b, #151515 72%)`
})

const stats = computed(() => {
  const c = props.creator
  if (!c) return []
  return [
    c.handle ? { text: '@' + c.handle } : null,
    { num: formatCount(props.followers), n: props.followers, text: '粉丝' },
    { num: formatCount(c.videoCount), text: '视频' },
    { num: formatCount(c.postCount), text: '帖子' },
    c.lastActive ? { text: '最后更新 ' + c.lastActive } : null
  ].filter(Boolean)
})
</script>

<template>
  <header class="cr-hd" :aria-busy="!creator">
    <div class="cr-banner" :class="{ sk: !creator }">
      <!-- 头图单独一层：视差、回弹放大都只动这一层 -->
      <div ref="bg" class="cr-bg" :style="creator && !banner.length ? { backgroundImage: generated } : undefined">
        <div v-if="banner.length" v-rise="calm ? false : { y: 0, scale: 1.06 }" class="tiles">
          <Cover v-for="(c, i) in banner" :key="i" v-bind="c" eager />
        </div>
      </div>
    </div>

    <template v-if="creator">
      <div v-rise="!calm" class="cr-row">
        <Cover class="cr-av" v-bind="creator.avatar || {}" eager />
        <FollowBtn
          class="cr-follow"
          :on="following"
          :aria-label="following ? `已关注 ${creator.name}，点按取消关注` : `关注 ${creator.name}`"
          @click="$emit('follow')"
        />
      </div>
      <h1 class="cr-name">
        <span>{{ creator.name }}</span>
        <span v-if="creator.verified" class="vf" role="img" aria-label="已认证"><Icon name="verified" /></span>
      </h1>
      <!-- 外层裁掉换行后行首的「·」：每一项前面都有一个点，整行向左挪出一个点的宽度 -->
      <div class="cr-stats">
        <div class="in">
          <!-- 粉丝数变了（关注 / 取消关注）像里程表一样翻过去 -->
          <span v-for="(s, i) in stats" :key="i" class="s"><b v-if="s.num"><RollNum v-if="s.n != null" :value="s.num" :n="s.n" /><template v-else>{{ s.num }}</template></b>{{ s.num ? ' ' : '' }}{{ s.text }}</span>
        </div>
      </div>
      <p v-if="creator.bio" class="cr-bio">{{ creator.bio }}</p>
    </template>

    <!-- 加载中：头像、名字、数据行的骨架 -->
    <template v-else>
      <div class="cr-row" aria-hidden="true">
        <div class="cr-av sk" />
        <div class="cr-follow sk" />
      </div>
      <div class="sk sk-n" />
      <div class="sk sk-s" />
    </template>
  </header>
</template>

<style scoped>
.cr-hd { position: relative; padding-bottom: 14px; }

/* ---- 头图：最多 3 张并排，压一层渐变，底部融进页面背景 ---- */
/* 不用 overflow 裁：底边照常裁掉（视差往下移时不压住名字），顶边放开（回弹放大时往上长） */
.cr-banner { position: relative; height: 150px; background: var(--panel); clip-path: inset(-100vh 0 0 0); }
.cr-bg { position: absolute; inset: 0; overflow: hidden; background-size: cover; transform-origin: 50% 100%; }
@supports not (clip-path: inset(0px 0px 0px 0px)) {
  .cr-banner { overflow: hidden; }
}
.cr-banner::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, .34) 0%, rgba(10, 10, 10, .08) 38%, rgba(10, 10, 10, .62) 82%, var(--bg) 100%);
}
.tiles { position: absolute; inset: 0; display: flex; gap: 1px; filter: var(--media); }
.tiles > .cover { flex: 1; min-width: 0; }

/* ---- 头像 + 关注 ---- */
.cr-row { position: relative; z-index: 1; display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-top: -44px; padding: 0 16px; }
.cr-av { flex: none; width: 84px; height: 84px; border-radius: 50%; background-color: #1a1a1a; box-shadow: 0 0 0 4px var(--bg); filter: var(--media); }
/* 关注按钮（FollowBtn）：两种文字叠在一格里，宽度不跳 */
.cr-follow {
  flex: none;
  min-width: 84px;
  height: 34px;
  margin-bottom: 6px;
  padding: 0 16px;
  border-radius: 17px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-weight: 700;
}
.cr-follow.on { background: var(--chip); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); color: var(--t2); }

/* ---- 名字 / 数据 / 简介 ---- */
/* 名字很长换行时，认证标跟在最后一个字后面（而不是被挤到最右边） */
.cr-name { margin: 10px 16px 0; font-size: 22px; font-weight: 700; line-height: 30px; overflow-wrap: anywhere; }
.cr-name .vf { display: inline-block; margin-left: 6px; vertical-align: -3px; white-space: nowrap; }
.cr-name .vf svg { width: 19px; height: 19px; }

.cr-stats { margin: 5px 16px 0; overflow: hidden; color: var(--t2); font-size: 13px; line-height: 21px; }
.cr-stats .in { display: flex; flex-wrap: wrap; margin-left: -15px; }
.cr-stats .s { white-space: nowrap; }
.cr-stats .s::before { content: '·'; display: inline-block; width: 15px; color: #575757; text-align: center; }
.cr-stats b { color: var(--t1); font-weight: 600; font-variant-numeric: tabular-nums; }
.cr-stats .roll { vertical-align: bottom; }

.cr-bio { margin: 8px 16px 0; color: var(--t3); font-size: 14px; line-height: 21px; overflow-wrap: anywhere; white-space: pre-line; }

/* ---- 骨架 ---- */
.sk { background: #161616; animation: sk 1.2s ease-in-out infinite; }
.cr-banner.sk::after { display: none; }
.cr-av.sk { box-shadow: 0 0 0 4px var(--bg); }
.cr-follow.sk { width: 84px; }
.sk-n { width: 132px; height: 22px; margin: 14px 16px 0; border-radius: 6px; }
.sk-s { width: 220px; max-width: calc(100% - 32px); height: 13px; margin: 12px 16px 0; border-radius: 6px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}
</style>
