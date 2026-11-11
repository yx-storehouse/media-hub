<script>
import { rise, canEnter } from '@/components/home/motion'

/*
 * 同一批挂上的卡片（一页数据、换标签、刷新后的新列表）错峰浮现：挂上时先排队，这一轮挂完一起开始。
 * 帖子卡片很高，一屏最多三四张，只动这一批的前 4 张。返回恢复出来的列表、KeepAlive 切回来都不播（见 motion.js 的 cameBack）。
 */
const queue = []
function enter(el) {
  if (!el || !canEnter()) return
  if (!queue.length) {
    Promise.resolve().then(() => {
      // 整批换 key（换标签、刷新）时 Vue 从后往前挂新卡片，排队的顺序是倒的：按文档顺序排好，最上面的先浮现
      const batch = queue.splice(0).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      rise(batch, { max: 4 })
    })
  }
  queue.push(el)
}
</script>

<script setup>
import { ref, computed, shallowRef, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getPost } from '@/api'
import { toast } from '@/composables/useToast'
import { share } from '@/composables/useShare'
import { useAuthStore } from '@/stores/auth'
import { usePostStore } from '@/stores/posts'
import { haptic } from '@/utils/motion'
import { pop } from '@/components/home/motion'
import { isDesktop } from '@/composables/useDesktop'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import ImageViewer from '@/components/ImageViewer.vue'
import ActBurst from '@/components/video/ActBurst.vue'
import RollNum from '@/components/video/RollNum.vue'

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

const root = ref(null)
onMounted(() => enter(root.value))

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

/*
 * 点卡片任意位置（文字、话题）进详情；图片、分享 / 收藏按钮、标题链接、头像 / 名字（作者主页）自己处理点击。
 * 桌面布局（鼠标）：按着 Ctrl / ⌘ / Shift 点、或者用中键点，和链接一样在新标签页打开；
 * 刚在卡片里拖选了文字（想复制）时松手不跳转。
 */
function open(e) {
  if (e.target.closest('button, a')) return
  if (e.ctrlKey || e.metaKey || e.shiftKey) return openTab()
  if (isDesktop.value && selecting()) return
  router.push(detailTo.value)
}
function openAux(e) {
  if (e.button !== 1 || e.target.closest('button, a')) return
  e.preventDefault()
  openTab()
}
/* 中键按下：Windows 上浏览器会进「自动滚动」，松手就不再有 auxclick；卡片自己处理中键（链接、按钮照旧） */
function onDown(e) {
  if (e.button === 1 && !e.target.closest('button, a')) e.preventDefault()
}
const openTab = () => window.open(router.resolve(detailTo.value).href, '_blank', 'noopener')
function selecting() {
  const sel = window.getSelection?.()
  return !!sel && !sel.isCollapsed && !!root.value && root.value.contains(sel.anchorNode)
}

/* ---------- 图片：视频帖的主图去播放页，其余打开大图 ---------- */

const viewer = shallowRef(null)
function openViewer(index) {
  if (gallery.value.length) viewer.value = { images: gallery.value, index }
}
/* 大图从哪张图放大出来、关掉时缩回哪张：主图是图集第 0 张（视频帖除外），缩略图依次在后；没显示出来的（+N 里的）没有 */
const mainBtn = ref(null)
const thumbBtns = []
function originOf(i) {
  if (mainBtn.value && !playable.value && i === 0) return mainBtn.value
  const k = i - thumbBase.value
  return k >= 0 && k < thumbs.value.length ? thumbBtns[k] || null : null
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

/* 点了收藏：图标立刻弹一下（点亮时回弹 + 冒一圈小点 + 轻震，取消时轻轻一缩），数字翻过去；失败时状态照常回滚 */
const favIcon = ref(null)
const burst = ref(0)
function favFx(on) {
  pop(favIcon.value?.$el, on)
  if (!on) return
  burst.value++
  haptic()
}

function toggleFav() {
  if (postStore.isPending(props.post.id)) return
  if (!auth.requireLogin({ then: favAfterLogin })) return // 未登录：弹登录框
  const next = !stats.value.faved
  favFx(next)
  setFav(next)
}
</script>

<template>
  <article ref="root" class="post m-hold" @click="open" @mousedown="onDown" @auxclick="openAux">
    <!--
      按压反馈（全局 components/motion/press.js）：按在卡片上（会进详情）时卡片底色微亮（m-hold → .m-pressed）；
      按在图片、按钮、头像 / 名字上时只有它们自己有反馈（离手指最近的那个接手），卡片不亮；一滑动就撤掉
    -->
    <!-- 头像和名字进作者主页（读屏只读名字那个链接，头像链接不重复朗读） -->
    <RouterLink v-if="authorTo" class="av-l m-hold" :to="authorTo" tabindex="-1" aria-hidden="true"><Cover class="av" v-bind="post.avatar" /></RouterLink>
    <Cover v-else class="av" v-bind="post.avatar" />
    <div class="bd">
      <div class="meta">
        <RouterLink v-if="authorTo" class="nm-l m-hold" :to="authorTo" :aria-label="`${post.name} 的主页`">
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
        ref="mainBtn"
        type="button"
        class="md-b m-hold"
        :class="{ play: playable }"
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
          :ref="el => { thumbBtns[k] = el }"
          type="button"
          class="tn-b m-press"
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
        <button class="ai m-hold" @click="share({ title: post.text, url: shareUrl() })"><span class="ico"><Icon name="shareUp" /></span>分享</button>
        <button class="ai fav m-hold" :class="{ on: stats.faved }" :aria-pressed="stats.faved" :aria-label="`收藏 ${stats.fav}`" @click="toggleFav">
          <span class="ico"><Icon ref="favIcon" name="bookmark" /><ActBurst v-if="burst" :key="burst" @done="burst = 0" /></span>
          <RollNum :value="String(stats.fav)" :n="stats.fav" />
        </button>
      </div>
    </div>
    <ImageViewer v-if="viewer" :images="viewer.images" :index="viewer.index" :origin="originOf" @close="viewer = null" />
  </article>
</template>

<style scoped>
.post { display: flex; gap: 11px; padding: 12px 14px 19px; border-bottom: 1px solid var(--line); cursor: pointer; transition: background-color var(--dur-2) var(--ease-out); }
.post.m-pressed { background-color: #121212; transition-duration: var(--dur-1); }
.av { flex: none; width: 44px; height: 44px; border-radius: 50%; filter: var(--media); }
.av-l { flex: none; align-self: flex-start; border-radius: 50%; }
.av-l .av, .nm-l { transition: opacity var(--dur-2) var(--ease-out); }
.av-l.m-pressed .av, .nm-l.m-pressed { opacity: .7; transition-duration: var(--dur-1); }
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
.md { aspect-ratio: 16 / 9; border-radius: 7px; filter: var(--media); transition: opacity var(--dur-2) var(--ease-out); }
.md-b.m-pressed .md { opacity: .82; transition-duration: var(--dur-1); }
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
.ai { display: flex; align-self: stretch; align-items: center; gap: 7px; transition: color var(--dur-1) var(--ease-out); } /* full row height = bigger tap area */
.ai svg { width: 17px; height: 17px; stroke-width: 1.9; }
/* 图标外面包一层：按压缩放在外层，点亮的弹跳在图标上，两者互不打断 */
.ai .ico { position: relative; display: block; transition: transform var(--dur-2) var(--ease-spring); }
.ai.m-pressed .ico { transform: scale(var(--press-scale-sm)); transition: transform var(--dur-1) var(--ease-out); }
.ai.on { color: var(--accent); }
/* 填充用 fill-opacity 过渡（fill 从 none 到颜色没法渐变） */
.fav svg { fill: currentColor; fill-opacity: 0; transition: fill-opacity var(--dur-1) var(--ease-out); }
.fav.on svg { fill-opacity: 1; }

/* iOS 14 / 安卓 WebView 87 不认 aspect-ratio（Safari 15、Chrome 88 才有）：里面全是绝对定位的东西，高度会是 0，用 ::before 的 padding 撑出同样的比例 */
@supports not (aspect-ratio: 1 / 1) {
  .md::before { content: ''; display: block; padding-top: 56.25%; }
  .tn::before { content: ''; display: block; padding-top: 88.9831%; }
}

/*
 * 桌面布局（≥ 1024px）：每条帖子是一张圆角卡片（深灰底 + 很淡的描边），卡片之间留 12px。
 * 社区、搜索、收藏、创作者主页里都是这个样子，不依赖外面的容器（外面只管这一栏多宽）。
 * 主图仍是 16:9、缩略图三张一排，跟着卡片宽度变大；「›」是手机上「点卡片能进去」的提示，桌面上有悬停效果，不要了。
 * 鼠标：卡片底色微亮，图片在自己的圆角里放大一点（只放大加载好的照片），操作按钮有圆角底色。
 */
@media (min-width: 1024px) {
  .post {
    gap: 12px;
    padding: 18px 20px 10px;
    border-bottom: 0;
    border-radius: 16px;
    background-color: var(--panel);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06);
  }
  .post + .post { margin-top: 12px; }
  .post.m-pressed { background-color: #171717; }
  .meta { gap: 6px; height: 22px; }
  .nm { font-weight: 600; }
  .go { display: none; }
  .tx { margin-top: 4px; word-break: break-word; }
  .tg { gap: 0 12px; margin-top: 4px; font-size: 14px; line-height: 22px; }

  .md-b { margin-top: 12px; border-radius: 12px; cursor: zoom-in; }
  .md-b.play { cursor: pointer; }
  .md { border-radius: 12px; }
  .md .pl { width: 60px; height: 60px; margin: -30px 0 0 -30px; transition: background-color var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out); }
  .md .pl svg { width: 26px; height: 26px; }
  .md .dur { right: 12px; bottom: 12px; height: 22px; padding: 0 8px; line-height: 22px; }
  .th { gap: 6px; margin-top: 6px; }
  .tg + .th { margin-top: 12px; }
  .tn-b { border-radius: 10px; cursor: zoom-in; }
  .tn { border-radius: 10px; }
  .more { font-size: 24px; }

  /* 操作：阅读 / 分享 / 收藏是三个带圆角底色（悬停时）的小胶囊，往左挪出 10px 让图标和正文左边对齐 */
  .act { gap: 4px; height: 34px; margin: 10px 0 0 -10px; }
  .ai { align-self: center; height: 34px; padding: 0 10px; border-radius: 17px; transition: color var(--dur-1) var(--ease-out), background-color var(--dur-2) var(--ease-out); }
}
@media (min-width: 1024px) and (hover: hover) {
  /* 悬停：底色亮一档、描边也亮一点（指针在文字上时也看得出来）；按下时再暗回一点 */
  .post { transition: background-color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out); }
  .post:hover { background-color: #191919; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .09); }
  .post.m-pressed { background-color: #151515; }
  .av-l:hover .av { opacity: .85; }
  .nm-l:hover .nm { text-decoration: underline; text-underline-offset: 3px; }
  .md > :deep(img), .tn > :deep(img) { transition: opacity var(--dur-3) var(--ease-out), filter var(--dur-3) var(--ease-out), transform var(--dur-4) var(--ease-out); }
  .md > :deep(img.now), .tn > :deep(img.now) { transition: transform var(--dur-4) var(--ease-out); }
  .md-b:hover .md > :deep(img.on), .tn-b:hover .tn > :deep(img.on) { transform: scale(1.03); }
  .md-b:hover .pl { background: rgba(20, 20, 20, .72); transform: scale(1.06); }
  button.ai:hover { background: rgba(255, 255, 255, .08); color: var(--t3); }
  button.ai.on:hover { color: var(--accent); }
}
</style>
