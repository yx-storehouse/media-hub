<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from '@/composables/useToast'
import { share } from '@/composables/useShare'
import { useAuthStore } from '@/stores/auth'
import { usePostStore } from '@/stores/posts'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

const props = defineProps({
  /**
   * Post from getPosts(): { id, creatorId, name, handle, verified, time, avatar, text, tags, kind, dur, more, read, fav, videoId, media: { main, thumbs } }
   * kind：'image' 图文 / 'video' 视频 / 'doc' 文档
   */
  post: { type: Object, required: true },
  /** 头像 / 名字链到作者主页；创作者主页里的卡片作者就是本人，传 false 关掉 */
  authorLink: { type: Boolean, default: true }
})

const router = useRouter()
const auth = useAuthStore()
const postStore = usePostStore()

/* 只有视频帖的主图带播放按钮和时长；其余类型的主图就是一张图 */
const isVideo = computed(() => props.post.kind === 'video')
const detailTo = computed(() => `/post/${encodeURIComponent(props.post.id)}`)
/* 作者主页；作者已删除（creatorId 为空）时头像 / 名字和卡片其他地方一样进详情 */
const authorTo = computed(() => (props.authorLink && props.post.creatorId != null ? `/creator/${encodeURIComponent(props.post.creatorId)}` : null))

/* 收藏状态 / 收藏数 / 阅读数：详情页里改过的值也在 store 里，返回列表时一致 */
const stats = computed(() => postStore.stats(props.post))

/* 点卡片任意位置（文字、话题、图片）进详情；分享 / 收藏按钮、标题链接、头像 / 名字（作者主页）自己处理点击 */
function open(e) {
  if (e.target.closest('button, a')) return
  router.push(detailTo.value)
}

/* 分享这条帖子的详情页地址（而不是当前的社区页） */
const shareUrl = () => new URL(router.resolve(detailTo.value).href, location.href).href

async function toggleFav() {
  if (postStore.isPending(props.post.id)) return
  if (!auth.requireLogin(router.currentRoute.value.fullPath)) return   // 未登录：弹登录框
  try {
    const on = await postStore.setFav(props.post, !stats.value.faved)
    toast(on ? '已收藏' : '已取消收藏')
  } catch {
    toast('操作失败，请稍后重试')
  }
}
</script>

<template>
  <article v-fade-in class="post" @click="open">
    <!-- 头像和名字进作者主页（读屏只读名字那个链接，头像链接不重复朗读） -->
    <RouterLink v-if="authorTo" class="av-l" :to="authorTo" tabindex="-1" aria-hidden="true"><Cover class="av" v-bind="post.avatar" /></RouterLink>
    <Cover v-else class="av" v-bind="post.avatar" />
    <div class="bd">
      <div class="meta">
        <RouterLink v-if="authorTo" class="nm-l" :to="authorTo" :aria-label="`${post.name} 的主页`">
          <span class="nm">{{ post.name }}</span>
          <Icon v-if="post.verified" name="verified" class="vf" />
        </RouterLink>
        <template v-else>
          <span class="nm">{{ post.name }}</span>
          <Icon v-if="post.verified" name="verified" class="vf" />
        </template>
        <span class="hd2">@{{ post.handle }} · {{ post.time }}</span>
        <Icon name="chevR" class="go" />
      </div>
      <!-- 键盘 / 读屏用户通过这个链接进详情 -->
      <RouterLink class="tx" :to="detailTo">{{ post.text }}</RouterLink>
      <div class="tg">
        <span v-for="tag in post.tags" :key="tag">#{{ tag }}</span>
      </div>

      <!-- 16:9 主图：视频帖带播放按钮和时长，图文 / 文档帖只是图 -->
      <Cover v-if="post.media.main" class="md" v-bind="post.media.main">
        <div v-if="isVideo" class="pl"><Icon name="play" /></div>
        <span v-if="isVideo && post.dur" class="dur">{{ post.dur }}</span>
      </Cover>
      <div v-if="post.media.thumbs.length" class="th">
        <Cover v-for="(thumb, k) in post.media.thumbs" :key="k" class="tn" v-bind="thumb">
          <span v-if="k === post.media.thumbs.length - 1 && post.more > 0" class="more">+{{ post.more }}</span>
        </Cover>
      </div>

      <div class="act">
        <span class="ai"><Icon name="eye" />阅读 {{ stats.read }}</span>
        <button class="ai" @click="share({ title: post.text, url: shareUrl() })"><Icon name="shareUp" />分享</button>
        <button class="ai" :class="{ on: stats.faved }" :aria-pressed="stats.faved" :aria-label="`收藏 ${stats.fav}`" @click="toggleFav">
          <Icon name="bookmark" />{{ stats.fav }}
        </button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.post { display: flex; gap: 11px; padding: 12px 14px 19px; border-bottom: 1px solid var(--line); cursor: pointer; }
.av { flex: none; width: 44px; height: 44px; border-radius: 50%; filter: var(--media); }
.av-l { flex: none; align-self: flex-start; border-radius: 50%; }
.nm-l { display: flex; flex: none; align-items: center; gap: 5px; min-width: 0; max-width: 62%; }
.nm-l .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.bd { flex: 1; min-width: 0; }

.meta { display: flex; align-items: center; gap: 5px; height: 24px; white-space: nowrap; }
.nm { font-size: 15px; font-weight: 700; }
.vf { width: 15px; height: 15px; }
.hd2 { min-width: 0; overflow: hidden; color: var(--t2); font-size: 13px; text-overflow: ellipsis; }
.go { width: 16px; height: 16px; margin-left: auto; color: var(--t2); }

.tx { display: block; color: var(--t3); font-size: 15px; line-height: 24px; word-break: break-all; }
.tg { display: flex; flex-wrap: wrap; gap: 0 9px; margin-top: 4px; color: var(--tag); font-size: 15px; line-height: 24px; }

.md { margin-top: 8px; aspect-ratio: 16 / 9; border-radius: 7px; filter: var(--media); }
.md .pl {
  position: absolute;
  left: 50%;
  top: 50%;
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin: -28px 0 0 -28px;
  border-radius: 50%;
  background: rgba(40, 40, 40, .55);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
.md .pl svg { width: 25px; height: 25px; margin-left: 3px; }
.md .dur { right: 11px; bottom: 11px; height: 19px; background: rgba(0, 0, 0, .35); font-size: 12px; line-height: 19px; }

.th { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 4px; filter: var(--media); }
.tn { aspect-ratio: 236 / 210; border-radius: 6px; }
.more { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, .52); font-size: 22px; font-weight: 700; }

.act { display: flex; align-items: center; gap: 23px; height: 36px; margin-top: 14px; color: var(--t2); font-size: 13px; }
.ai { display: flex; align-self: stretch; align-items: center; gap: 7px; } /* full row height = bigger tap area */
.ai svg { width: 17px; height: 17px; stroke-width: 1.9; }
.ai.on { color: var(--accent); }
.ai.on svg { fill: currentColor; }
</style>
