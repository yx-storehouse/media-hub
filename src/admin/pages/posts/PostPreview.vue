<script setup>
import { computed } from 'vue'
import AIcon from '../../components/AIcon.vue'
import Thumb from '../../components/Thumb.vue'
import { fmtDuration, fmtCount, relTime } from '../../utils/format'

/*
 * 帖子预览：照前台社区页的卡片（src/components/community/PostCard.vue）画一个缩小版：
 * 头像、名字、@账号 · 时间、正文、#标签、16:9 主图（关联了视频的视频帖带播放按钮和时长）、
 * 配图最多 3 张（多出来的张数显示在第 3 张上：+N，和 App 一样按真实张数算）、阅读 / 分享 / 收藏。
 * 只是「大概长这样」，不追求像素一致；图片打不开时显示灰色占位。
 * 卡片下面另有一小块「详情页」：详情正文只在详情页显示（卡片上没有），这里给出前几行。
 */
const props = defineProps({
  /** 表单数据：{ text, content, tags, mediaKind, videoId, mainImage, images, readCount, publishedAt } */
  post: { type: Object, required: true },
  /** { name, handle, avatarUrl, isVerified }；没选发布者时为 null */
  creator: { type: Object, default: null },
  favCount: { type: Number, default: 0 },
  /** 关联视频的时长（秒），显示在主图右下角 */
  durationSec: { type: Number, default: 0 }
})

const tags = computed(() => (props.post.tags || []).map(t => String(t).replace(/^#+/, '')).filter(Boolean))
const images = computed(() => (props.post.images || []).filter(Boolean))
/* 和 App 的社区卡片一致：最多 3 张缩略图，其余的张数显示在第 3 张上 */
const MAX_THUMBS = 3
const thumbs = computed(() => images.value.slice(0, MAX_THUMBS))
const extra = computed(() => Math.max(0, images.value.length - MAX_THUMBS))
/* 只有关联了视频的视频帖主图带播放按钮（App 里点主图直接播放） */
const playable = computed(() => props.post.mediaKind === 1 && props.post.videoId != null)
const time = computed(() => (props.post.publishedAt ? relTime(props.post.publishedAt) : '刚刚'))
const content = computed(() => String(props.post.content || '').trim())
</script>

<template>
  <div>
    <article class="pc" aria-label="前台效果预览">
      <Thumb class="av" :src="creator?.avatarUrl || ''" :width="40" :ratio="1" round icon="user" />
      <div class="bd">
        <div class="meta">
          <span class="nm ellipsis">{{ creator?.name || '未选择发布者' }}</span>
          <AIcon v-if="creator?.isVerified" class="vf" name="verified" :size="14" />
          <span class="hd ellipsis">@{{ creator?.handle || '—' }} · {{ time }}</span>
        </div>
        <p class="tx" :class="{ ph: !post.text?.trim() }">{{ post.text?.trim() || '标题会显示在这里' }}</p>
        <p v-if="tags.length" class="tg">
          <span v-for="t in tags" :key="t">#{{ t }}</span>
        </p>

        <div v-if="post.mainImage" class="md">
          <Thumb :src="post.mainImage" :ratio="16 / 9" icon="image" />
          <span v-if="playable" class="pl" aria-hidden="true"><AIcon name="play" :size="20" /></span>
          <span v-if="playable && durationSec" class="du num">{{ fmtDuration(durationSec) }}</span>
        </div>
        <div v-if="thumbs.length" class="th">
          <div v-for="(u, k) in thumbs" :key="k + u" class="tn">
            <Thumb :src="u" :ratio="236 / 210" :icon="post.mediaKind === 2 ? 'file' : 'image'" />
            <span v-if="k === thumbs.length - 1 && extra > 0" class="more num">+{{ extra }}</span>
          </div>
        </div>

        <div class="act">
          <span><AIcon name="eye" :size="14" />阅读 {{ fmtCount(post.readCount) }}</span>
          <span><AIcon name="external" :size="14" />分享</span>
          <span><AIcon name="star" :size="14" />{{ fmtCount(favCount) }}</span>
        </div>
      </div>
    </article>

    <section class="dp" aria-label="详情页正文预览">
      <p class="dp-hd">详情页 · 标题下面的正文</p>
      <p class="dp-tx" :class="{ ph: !content }">{{ content || '还没有详情正文：详情页只显示标题、图片和视频' }}</p>
    </section>
  </div>
</template>

<style scoped>
.pc { display: flex; gap: 10px; padding: 12px 12px 6px; border: 1px solid var(--line); border-radius: 10px; background: #0f0f0f; }
.av { flex: none; align-self: flex-start; }
.bd { flex: 1; min-width: 0; }
.meta { display: flex; align-items: center; gap: 5px; height: 22px; white-space: nowrap; }
.nm { flex: none; max-width: 50%; font-size: 14px; font-weight: 700; }
.vf { color: var(--t1); }
.hd { min-width: 0; color: var(--t3); font-size: 12px; }
.tx { margin-top: 2px; color: var(--t2); font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
.tx.ph { color: var(--t3); font-style: italic; }
.tg { display: flex; flex-wrap: wrap; gap: 0 8px; margin-top: 2px; color: var(--t1); font-size: 13px; line-height: 1.7; }
.md { position: relative; margin-top: 8px; overflow: hidden; border-radius: 7px; }
.pl { position: absolute; left: 50%; top: 50%; display: grid; place-items: center; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; background: rgba(40, 40, 40, .6); color: #fff; }
.du { position: absolute; right: 8px; bottom: 8px; height: 18px; padding: 0 6px; border-radius: 4px; background: rgba(0, 0, 0, .45); color: #fff; font-size: 11px; line-height: 18px; }
.th { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 4px; }
.tn { position: relative; overflow: hidden; border-radius: 6px; }
.more { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, .52); color: #fff; font-size: 18px; font-weight: 700; }
.act { display: flex; align-items: center; gap: 18px; height: 34px; margin-top: 6px; color: var(--t3); font-size: 12px; }
.act span { display: inline-flex; align-items: center; gap: 5px; }

/* 详情正文：保留换行，最多显示 6 行 */
.dp { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: #0f0f0f; }
.dp-hd { margin-bottom: 4px; color: var(--t3); font-size: 11.5px; }
.dp-tx { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 6; color: var(--t2); font-size: 13px; line-height: 1.7; white-space: pre-line; word-break: break-all; }
.dp-tx.ph { color: var(--t3); font-style: italic; }
</style>
