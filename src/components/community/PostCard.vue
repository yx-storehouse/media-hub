<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from '@/composables/useToast'
import { share } from '@/composables/useShare'
import { togglePostFav } from '@/api'
import { useAuthStore } from '@/stores/auth'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

const props = defineProps({
  /**
   * Post from getPosts(): { id, name, handle, verified, time, avatar, text, tags, kind, dur, more, read, fav, videoId, media: { main, thumbs } }
   * kind：'image' 图文 / 'video' 视频 / 'doc' 文档
   */
  post: { type: Object, required: true }
})

const router = useRouter()
const auth = useAuthStore()

/* 只有视频帖的主图带播放按钮和时长；其余类型的主图就是一张图 */
const isVideo = computed(() => props.post.kind === 'video')
/* 主图点进去：关联了视频就去播放页；没关联的视频帖去短视频流；图文 / 文档帖没关联视频时不可点 */
const mainTarget = computed(() => {
  if (props.post.videoId != null) return `/video/${encodeURIComponent(props.post.videoId)}`
  return isVideo.value ? '/short' : null
})

/* 帖子对象由父组件持有，收藏状态改完直接写回去（列表整体替换不影响） */
const faved = computed(() => !!props.post.faved)

async function toggleFav() {
  if (!auth.requireLogin(router.currentRoute.value.fullPath)) return   // 未登录：弹登录框
  const next = !faved.value
  try {
    await togglePostFav(props.post.id, { on: next })
    props.post.faved = next
    props.post.fav += next ? 1 : -1
    toast(next ? '已收藏' : '已取消收藏')
  } catch {
    toast('操作失败，请稍后重试')
  }
}
</script>

<template>
  <article v-fade-in class="post">
    <Cover class="av" v-bind="post.avatar" />
    <div class="bd">
      <div class="meta">
        <span class="nm">{{ post.name }}</span>
        <Icon v-if="post.verified" name="verified" class="vf" />
        <span class="hd2">@{{ post.handle }} · {{ post.time }}</span>
        <Icon name="chevR" class="go" />
      </div>
      <div class="tx">{{ post.text }}</div>
      <div class="tg">
        <span v-for="tag in post.tags" :key="tag">#{{ tag }}</span>
      </div>

      <!-- 16:9 主图：视频帖带播放按钮和时长，图文 / 文档帖只是图；关联了视频时点主图去播放页 -->
      <template v-if="post.media.main">
        <Cover
          v-if="mainTarget"
          v-press
          class="md link"
          v-bind="post.media.main"
          :aria-label="isVideo ? '播放视频' : '查看关联视频'"
          @click="router.push(mainTarget)"
        >
          <div v-if="isVideo" class="pl"><Icon name="play" /></div>
          <span v-if="isVideo && post.dur" class="dur">{{ post.dur }}</span>
        </Cover>
        <Cover v-else class="md" v-bind="post.media.main" />
      </template>
      <div v-if="post.media.thumbs.length" class="th">
        <Cover v-for="(thumb, k) in post.media.thumbs" :key="k" class="tn" v-bind="thumb">
          <span v-if="k === post.media.thumbs.length - 1 && post.more > 0" class="more">+{{ post.more }}</span>
        </Cover>
      </div>

      <div class="act">
        <span class="ai"><Icon name="eye" />阅读 {{ post.read }}</span>
        <button class="ai" @click="share({ title: post.text })"><Icon name="shareUp" />分享</button>
        <button class="ai" :class="{ on: faved }" :aria-pressed="faved" :aria-label="`收藏 ${post.fav}`" @click="toggleFav">
          <Icon name="bookmark" />{{ post.fav }}
        </button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.post { display: flex; gap: 11px; padding: 12px 14px 19px; border-bottom: 1px solid var(--line); }
.av { flex: none; width: 44px; height: 44px; border-radius: 50%; filter: var(--media); }
.bd { flex: 1; min-width: 0; }

.meta { display: flex; align-items: center; gap: 5px; height: 24px; white-space: nowrap; }
.nm { font-size: 15px; font-weight: 700; }
.vf { width: 15px; height: 15px; }
.hd2 { min-width: 0; overflow: hidden; color: var(--t2); font-size: 13px; text-overflow: ellipsis; }
.go { width: 16px; height: 16px; margin-left: auto; color: var(--t2); }

.tx { color: var(--t3); font-size: 15px; line-height: 24px; word-break: break-all; }
.tg { display: flex; flex-wrap: wrap; gap: 0 9px; margin-top: 4px; color: var(--tag); font-size: 15px; line-height: 24px; }

.md { margin-top: 8px; aspect-ratio: 16 / 9; border-radius: 7px; filter: var(--media); }
.md.link { cursor: pointer; }
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
