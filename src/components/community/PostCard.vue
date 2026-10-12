<script setup>
import { computed, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { getPost } from '@/api'
import { toast } from '@/composables/useToast'
import { share } from '@/composables/useShare'
import { useAuthStore } from '@/stores/auth'
import { usePostStore } from '@/stores/posts'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import ImageViewer from '@/components/ImageViewer.vue'

const props = defineProps({
  /**
   * Post from getPosts(): { id, creatorId, name, handle, verified, time, avatar, text, tags, kind, dur, read, fav, videoId, media: { main, thumbs } }
   * kind：'image' 图文 / 'video' 视频 / 'doc' 文档
   */
  post: { type: Object, required: true },
  /** 头像 / 名字链到作者主页；创作者主页里的卡片作者就是本人，传 false 关掉 */
  authorLink: { type: Boolean, default: true }
})

const router = useRouter()
const auth = useAuthStore()
const postStore = usePostStore()

/* 卡片上最多放 3 张缩略图，其余的在第 3 张上显示「+N」（N 是真实剩下的张数，详情页里都能看到） */
const MAX_THUMBS = 3

/* 能播的视频帖（关联了已上架的视频）：主图带播放按钮，点主图直接去播放页 */
const playable = computed(() => props.post.kind === 'video' && props.post.videoId != null)
const detailTo = computed(() => `/post/${encodeURIComponent(props.post.id)}`)
/* 作者主页；作者已删除（creatorId 为空）时头像 / 名字和卡片其他地方一样进详情 */
const authorTo = computed(() => (props.authorLink && props.post.creatorId != null ? `/creator/${encodeURIComponent(props.post.creatorId)}` : null))

const allThumbs = computed(() => props.post.media?.thumbs || [])
const thumbs = computed(() => allThumbs.value.slice(0, MAX_THUMBS))
const extra = computed(() => Math.max(0, allThumbs.value.length - MAX_THUMBS))
/* 大图浏览的图集，和详情页的配图一致：能播的视频帖主图是视频封面，不算配图 */
const gallery = computed(() => {
  const main = props.post.media?.main
  return main && !playable.value ? [main, ...allThumbs.value] : allThumbs.value
})
/* 第 k 张缩略图在图集里的位置 */
const thumbBase = computed(() => gallery.value.length - allThumbs.value.length)

/* 收藏状态 / 收藏数 / 阅读数：详情页里改过的值也在 store 里，返回列表时一致；未登录时一律不显示为已收藏 */
const stats = computed(() => {
  const s = postStore.stats(props.post)
  return auth.ready && !auth.loggedIn ? { ...s, faved: false } : s
})

/* 点卡片任意位置（文字、话题）进详情；图片、分享 / 收藏按钮、标题链接、头像 / 名字（作者主页）自己处理点击 */
function open(e) {
  if (e.target.closest('button, a')) return
  router.push(detailTo.value)
}

/* ---------- 图片：视频帖的主图去播放页，其余打开大图 ---------- */

const viewer = shallowRef(null)
function openViewer(index) {
  if (gallery.value.length) viewer.value = { images: gallery.value, index }
}
function onMain() {
  if (playable.value) router.push(`/video/${encodeURIComponent(props.post.videoId)}`)
  else openViewer(0)
}

/* 分享这条帖子的详情页地址（而不是当前的社区页） */
const shareUrl = () => new URL(router.resolve(detailTo.value).href, location.href).href

/* ---------- 收藏：未登录先登录，登录后自动补做 ---------- */

async function setFav(on) {
  try {
    const active = await postStore.setFav(props.post, on)
    toast(active ? '已收藏' : '已取消收藏')
  } catch (e) {
    toast(e?.code === 'demo' ? e.message : '操作失败，请稍后重试')
  }
}

/* 登录后补做收藏：先按新账号取一次这篇的收藏状态，已经收藏过就不再重复 */
async function favAfterLogin() {
  const p = props.post
  try {
    const d = await getPost(p.id)
    postStore.patch(p.id, { faved: !!d.faved, fav: d.fav ?? 0 })
  } catch { /* 取不到就照常收藏（带明确的 on，重复也不会多算） */ }
  if (postStore.isPending(p.id)) return
  if (postStore.stats(p).faved) toast('已收藏')
  else await setFav(true)
}

function toggleFav() {
  if (postStore.isPending(props.post.id)) return
  if (!auth.requireLogin({ then: favAfterLogin })) return // 未登录：弹登录框
  setFav(!stats.value.faved)
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

      <!-- 16:9 主图：能播的视频帖带播放按钮和时长，点了直接播放；其余点了看大图 -->
      <button
        v-if="post.media.main"
        type="button"
        class="md-b"
        :aria-label="playable ? `播放视频：${post.text}` : `查看大图，共 ${gallery.length} 张`"
        @click="onMain"
      >
        <Cover class="md" v-bind="post.media.main">
          <span v-if="playable" class="pl"><Icon name="play" /></span>
          <span v-if="playable && post.dur" class="dur">{{ post.dur }}</span>
        </Cover>
      </button>
      <div v-if="thumbs.length" class="th">
        <button
          v-for="(thumb, k) in thumbs"
          :key="k"
          type="button"
          class="tn-b"
          :aria-label="`查看大图：第 ${thumbBase + k + 1} 张，共 ${gallery.length} 张`"
          @click="openViewer(thumbBase + k)"
        >
          <Cover class="tn" v-bind="thumb">
            <span v-if="k === thumbs.length - 1 && extra > 0" class="more" aria-hidden="true">+{{ extra }}</span>
          </Cover>
        </button>
      </div>

      <div class="act">
        <span class="ai"><Icon name="eye" />阅读 {{ stats.read }}</span>
        <button class="ai" @click="share({ title: post.text, url: shareUrl() })"><Icon name="shareUp" />分享</button>
        <button class="ai" :class="{ on: stats.faved }" :aria-pressed="stats.faved" :aria-label="`收藏 ${stats.fav}`" @click="toggleFav">
          <Icon name="bookmark" />{{ stats.fav }}
        </button>
      </div>
    </div>
    <ImageViewer v-if="viewer" :images="viewer.images" :index="viewer.index" @close="viewer = null" />
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

.md-b { display: block; width: 100%; margin-top: 8px; border-radius: 7px; }
.md { aspect-ratio: 16 / 9; border-radius: 7px; filter: var(--media); }
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
.tn-b { display: block; min-width: 0; border-radius: 6px; }
.tn { aspect-ratio: 236 / 210; border-radius: 6px; }
.more { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, .52); color: #fff; font-size: 22px; font-weight: 700; }

.act { display: flex; align-items: center; gap: 23px; height: 36px; margin-top: 14px; color: var(--t2); font-size: 13px; }
.ai { display: flex; align-self: stretch; align-items: center; gap: 7px; } /* full row height = bigger tap area */
.ai svg { width: 17px; height: 17px; stroke-width: 1.9; }
.ai.on { color: var(--accent); }
.ai.on svg { fill: currentColor; }
</style>
