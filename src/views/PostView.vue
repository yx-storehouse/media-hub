<script>
/*
 * 返回恢复：详情页不常驻（不在 KeepAlive 里），点进作者主页 / 视频 / 话题再按返回时，用离开前存下的
 * 帖子内容和滚动位置原样放回：不重新加载、不回到顶部，也不再记一次阅读。
 * 只在「返回到这条历史记录」时恢复（history.state.forward 有值）；重新点进来是全新的一页。
 */
const snapshots = new Map()
const SNAPSHOT_TTL = 10 * 60 * 1000
const SNAPSHOT_MAX = 8

/* 同一次打开 App 里每篇帖子只记一次阅读：读过的 id 记在 sessionStorage（取不到就只记在内存里） */
const READ_KEY = 'reel:read-posts'
const READ_MAX = 500
let readIds = null
function readSet() {
  if (!readIds) {
    try {
      readIds = new Set(JSON.parse(sessionStorage.getItem(READ_KEY) || '[]').map(String))
    } catch {
      readIds = new Set()
    }
  }
  return readIds
}
function setRead(id, on) {
  const s = readSet()
  if (on) s.add(String(id))
  else s.delete(String(id))
  try {
    sessionStorage.setItem(READ_KEY, JSON.stringify([...s].slice(-READ_MAX)))
  } catch { /* 存不了就只在内存里记 */ }
}
</script>

<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, onBeforeRouteUpdate, RouterLink } from 'vue-router'
import { getPost, viewPost, toggleFollow } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { usePostStore } from '@/stores/posts'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import { share } from '@/composables/useShare'
import { formatCount } from '@/utils/format'
import { linkify } from '@/components/community/linkify'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import ImageViewer from '@/components/ImageViewer.vue'
import UnfollowSheet from '@/components/creator/UnfollowSheet.vue'
import FollowBtn from '@/components/creator/FollowBtn.vue'
import ActBurst from '@/components/video/ActBurst.vue'
import RollNum from '@/components/video/RollNum.vue'
import { rememberVideo } from '@/components/video/preview'
import { haptic } from '@/utils/motion'
import { cameBack, pop, vRise } from '@/components/home/motion'

/*
 * 帖子详情：作者栏（关注）→ 标题、关联视频（紧跟标题）、正文、配图、话题、发布时间 →「下一篇」，底部是阅读数 / 分享 / 收藏。
 * 收藏状态和阅读数放在 stores/posts.js，社区列表（常驻）读同一份，返回列表时两边一致。
 * 配图点开是全屏大图（左右滑、双指 / 双击放大）；正文里的网址、邮箱、电话可以点。
 */
defineOptions({ name: 'PostView' })

const route = useRoute()
const auth = useAuthStore()
const postStore = usePostStore()
/* 直接打开（没有上一页）时返回社区 */
const back = useBack('/community')
/* 按返回回到这一篇：恢复出来的内容不播入场 */
cameBack()

/** PostDetail（见 src/api/index.js） */
const post = shallowRef(null)
/* 加载失败：message 给用户看；retry 只在可能是网络问题时显示（帖子不存在重试也没用） */
const failed = ref(null)
const following = ref(false)
const scroller = ref(null)
/* 配图按原始比例显示：加载完读出宽高，之前先用 4:3 占位 */
const ratios = shallowRef({})
/* 全屏看大图：{ images, index } */
const viewer = shallowRef(null)
/* 取消关注前的确认 */
const unfollowAsk = ref(false)

const author = computed(() => post.value?.author || null)
/* 头像 + 名字进作者主页（作者已删除时 id 为空，就只是展示） */
const authorLink = computed(() => (author.value?.id != null ? { to: `/creator/${encodeURIComponent(author.value.id)}` } : null))
/* 未登录时一律不显示为已收藏（退出登录后不会留着上一个人的收藏状态） */
const stats = computed(() => {
  if (!post.value) return { faved: false, fav: 0, read: 0 }
  const s = postStore.stats(post.value)
  return auth.ready && !auth.loggedIn ? { ...s, faved: false } : s
})
const tags = computed(() => (post.value?.tags || []).map(t => String(t).replace(/^#/, '')).filter(Boolean))
/* 正文按空行分段（段内的单个换行原样显示，pre-line）；每段切成文字和链接片段 */
const paragraphs = computed(() => String(post.value?.content || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).map(linkify))

const videoTo = v => `/video/${encodeURIComponent(v.id)}`
const postTo = id => `/post/${encodeURIComponent(id)}`
/* 话题搜帖子（搜索页的「帖子」标签） */
const searchTo = t => ({ path: '/search', query: { q: t, type: 'post' } })

/* ---------- 加载 ---------- */

let loadSeq = 0
let currentId = route.params.id
let lastTop = 0

async function load(id) {
  const token = ++loadSeq
  currentId = id
  // 换一篇：先撤掉上一篇（加载期间显示骨架），不会把旧内容当成新帖子显示
  post.value = null
  failed.value = null
  following.value = false
  ratios.value = {}
  viewer.value = null
  lastTop = 0
  if (scroller.value) scroller.value.scrollTop = 0
  try {
    const p = await getPost(id)
    if (token !== loadSeq) return
    following.value = !!p.following
    // 这次会话里第一次打开才算一次阅读：先在本地 +1，接口返回新的阅读数后以它为准
    const first = !readSet().has(String(p.id))
    postStore.patch(p.id, { faved: !!p.faved, fav: p.fav ?? 0, read: (p.read ?? 0) + (first ? 1 : 0) })
    post.value = p
    if (first) {
      setRead(p.id, true)
      viewPost(p.id).then(r => {
        if (typeof r?.read === 'number') postStore.patch(p.id, { read: r.read })
        else setRead(p.id, false) // 没记上（断网等）：下次打开再记
      })
    }
  } catch (e) {
    if (token !== loadSeq) return
    const missing = e?.status >= 400 && e?.status < 500 && e?.status !== 401
    failed.value = missing
      ? { message: (e.status === 400 && e.message) || '帖子不存在或已下架', retry: false }
      : { message: e?.message || '加载失败，请检查网络', retry: true }
  }
}

/* 按当前账号重新取「是否关注 / 是否收藏」（不记阅读）；同时发起的几次合并成一个请求 */
let stateReq = null
function refreshState() {
  const p = post.value
  if (!p) return Promise.resolve()
  if (!stateReq) {
    stateReq = getPost(p.id)
      .then(d => {
        if (post.value?.id !== p.id) return
        if (!followBusy) following.value = !!d.following
        if (!postStore.isPending(p.id)) postStore.patch(p.id, { faved: !!d.faved, fav: d.fav ?? 0 })
      })
      .catch(() => { /* 取不到就保持原样 */ })
      .finally(() => { stateReq = null })
  }
  return stateReq
}

/* 在本页登录 / 退出后，重新取一次「是否关注 / 是否收藏」（未登录时接口给的都是 false） */
const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))
watch(session, (now, before) => {
  if (before !== null) refreshState() // 启动时的首次校验不算
})

function onImage(i, e) {
  const { naturalWidth: w, naturalHeight: h } = e.target
  if (w && h) ratios.value = { ...ratios.value, [i]: `${w} / ${h}` }
}

const openImage = i => { viewer.value = { images: post.value?.images || [], index: i } }
/* 大图从点的那张配图放大出来、关掉时缩回去 */
const imgBtns = []
const imageEl = i => imgBtns[i] || null

/* ---------- 关注 / 收藏：乐观更新 → 一次请求（带明确的 on）→ 以返回为准，失败回滚并提示 ---------- */

const failText = e => (e?.code === 'demo' ? e.message : '操作失败，请稍后重试')

let followBusy = false
async function setFollow(next) {
  const a = author.value
  if (!a || a.id == null || followBusy) return
  following.value = next
  followBusy = true
  try {
    const res = await toggleFollow(a.id, { on: next })
    const on = typeof res?.active === 'boolean' ? res.active : next
    if (author.value?.id === a.id) following.value = on
    toast(on ? '已关注' : '已取消关注')
  } catch (e) {
    if (author.value?.id === a.id) following.value = !next
    toast(failText(e))
  } finally {
    followBusy = false
  }
}

/* 登录后补做关注：先按新账号取一次状态，已经关注过就不再重复 */
async function followAfterLogin() {
  await refreshState()
  if (following.value) toast('已关注')
  else setFollow(true)
}

function onFollow() {
  const a = author.value
  if (!a || a.id == null || followBusy) return
  if (!auth.requireLogin({ then: followAfterLogin })) return // 未登录：弹登录框，登录后自动关注
  if (following.value) unfollowAsk.value = true // 取消关注先确认
  else {
    haptic()
    setFollow(true)
  }
}

async function setFav(on) {
  const p = post.value
  if (!p || postStore.isPending(p.id)) return
  try {
    const active = await postStore.setFav(p, on)
    toast(active ? '已收藏' : '已取消收藏')
  } catch (e) {
    toast(failText(e))
  }
}

/* 登录后补做收藏：同样先对一下状态 */
async function favAfterLogin() {
  await refreshState()
  if (stats.value.faved) toast('已收藏')
  else setFav(true)
}

/* 点了收藏：胶囊变色，图标立刻弹一下（点亮时回弹 + 冒一圈小点 + 轻震，取消时轻轻一缩），数字翻过去 */
const favIcon = ref(null)
const favBurst = ref(0)
function onFav() {
  const p = post.value
  if (!p || postStore.isPending(p.id)) return
  if (!auth.requireLogin({ then: favAfterLogin })) return
  const next = !stats.value.faved
  pop(favIcon.value?.$el, next)
  if (next) {
    favBurst.value++
    haptic()
  }
  setFav(next)
}

/* ---------- 返回恢复 ---------- */

/* 这条历史记录的位置：「下一篇」是替换当前记录，位置不变 */
const historyPos = window.history.state?.position ?? ''
const snapKey = id => `${historyPos}:${id}`

function saveSnapshot() {
  if (!post.value || failed.value) return
  const key = snapKey(currentId)
  snapshots.delete(key)
  snapshots.set(key, {
    at: Date.now(),
    id: String(currentId),
    post: post.value,
    following: following.value,
    ratios: ratios.value,
    top: lastTop
  })
  while (snapshots.size > SNAPSHOT_MAX) snapshots.delete(snapshots.keys().next().value)
}

function restoreSnapshot(id) {
  const key = snapKey(id)
  const s = window.history.state?.forward ? snapshots.get(key) : null
  snapshots.delete(key)
  if (!s || s.id !== String(id) || Date.now() - s.at > SNAPSHOT_TTL) return false
  currentId = id
  post.value = s.post
  following.value = s.following
  ratios.value = s.ratios
  lastTop = s.top
  return true
}

const onScroll = () => { if (scroller.value) lastTop = scroller.value.scrollTop }

const restored = restoreSnapshot(route.params.id)
if (!restored) load(route.params.id)

onMounted(() => {
  if (!restored) return
  nextTick(() => { if (scroller.value) scroller.value.scrollTop = lastTop })
  refreshState() // 离开期间可能在别处关注 / 收藏过，静默对一下
})
onBeforeUnmount(saveSnapshot)

onBeforeRouteUpdate(to => {
  if (to.params.id !== route.params.id) load(to.params.id)
})
</script>

<template>
  <div class="page post-pg">
    <header class="pd-hd">
      <button type="button" class="pd-back hit-44" aria-label="返回" @click="back"><Icon name="chevL" /></button>
      <template v-if="post">
        <component :is="authorLink ? RouterLink : 'div'" v-rise.self="{ y: 0 }" class="pd-author" v-bind="authorLink || {}">
          <Cover class="pd-av" v-bind="author?.avatar || {}" eager />
          <div class="pd-who">
            <div class="pd-nm">
              <span>{{ author?.name || '匿名用户' }}</span>
              <Icon v-if="author?.verified" name="verified" class="vf" />
            </div>
            <!-- 账号太长时只截账号，发布时间始终显示 -->
            <div class="pd-sub">
              <span v-if="author?.handle" class="hd">@{{ author.handle }}</span>
              <span v-if="post.time" class="tm">{{ post.time }}</span>
            </div>
          </div>
        </component>
        <FollowBtn
          v-if="author && author.id != null"
          v-rise.self="{ y: 0 }"
          class="pd-follow"
          :on="following"
          :aria-label="following ? `已关注 ${author.name}，点按取消关注` : `关注 ${author.name}`"
          @click="onFollow"
        />
      </template>
      <!-- 加载中：作者栏骨架 -->
      <template v-else-if="!failed">
        <div class="pd-av sk" />
        <div class="pd-who" aria-hidden="true">
          <div class="sk sk-l" style="width: 96px" />
          <div class="sk sk-s" style="width: 128px" />
        </div>
      </template>
    </header>

    <div ref="scroller" class="scroll" :aria-busy="!post && !failed" @scroll.passive="onScroll">
      <!-- 骨架原地淡出，正文浮现；「下一篇」时旧的一篇淡出、骨架接上 -->
      <div class="m-swap">
        <Transition name="m-skel">
          <div v-if="failed" class="empty">
            {{ failed.message }}
            <button v-if="failed.retry" type="button" class="retry" @click="load(route.params.id)">重试</button>
          </div>

          <div v-else-if="post" :key="`post${post.id}`" v-rise.self>
            <article class="pd-body">
              <h1 class="pd-title">{{ post.title }}</h1>

              <!-- 视频帖：视频紧跟标题，点了去播放页（不用先翻过正文和所有配图） -->
              <RouterLink v-if="post.video" class="pd-video m-hold" :to="videoTo(post.video)" @click="rememberVideo(post.video)" :aria-label="`播放视频：${post.video.title || post.title}`">
                <!-- 有两张图（帖子主图 + 视频封面）时左右拼成一张：中间一道细缝，播放键压在缝上 -->
                <div v-if="post.video.frames?.length === 2" class="pd-vcv pd-split">
                  <Cover v-for="(f, i) in post.video.frames" :key="i" class="pd-half" :class="i ? 'r' : 'l'" v-bind="f" />
                  <span class="pl"><Icon name="play" /></span>
                  <span v-if="post.video.dur" class="dur">{{ post.video.dur }}</span>
                </div>
                <Cover v-else class="pd-vcv" v-bind="post.video.cover">
                  <span class="pl"><Icon name="play" /></span>
                  <span v-if="post.video.dur" class="dur">{{ post.video.dur }}</span>
                </Cover>
              </RouterLink>

              <!-- 正文：网址、邮箱、电话是链接（只切成文字和链接片段，不拼 HTML） -->
              <div v-if="paragraphs.length" class="pd-text">
                <p v-for="(para, i) in paragraphs" :key="i">
                  <template v-for="(seg, k) in para" :key="k">
                    <a
                      v-if="seg.href"
                      class="pd-link"
                      :href="seg.href"
                      :target="seg.external ? '_blank' : undefined"
                      :rel="seg.external ? 'noopener noreferrer' : undefined"
                    >{{ seg.text }}</a>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </p>
              </div>

              <!-- 配图：点开全屏看大图 -->
              <div v-if="post.images?.length" class="pd-imgs">
                <button
                  v-for="(img, i) in post.images"
                  :key="i"
                  :ref="el => { imgBtns[i] = el }"
                  type="button"
                  class="pd-img-b m-hold"
                  :aria-label="`查看大图：第 ${i + 1} 张，共 ${post.images.length} 张`"
                  @click="openImage(i)"
                >
                  <Cover
                    class="pd-img"
                    v-bind="img"
                    :style="{ aspectRatio: ratios[i] || '4 / 3' }"
                    @load="onImage(i, $event)"
                  />
                </button>
              </div>

              <div v-if="tags.length" class="pd-tags">
                <RouterLink v-for="t in tags" :key="t" class="pd-tag" :to="searchTo(t)">#{{ t }}</RouterLink>
              </div>
              <div v-if="post.time" class="pd-time">{{ post.time }}</div>
            </article>

            <hr class="pd-div">
            <!-- 下一篇替换当前记录：连着往下看几篇，返回键仍然直接回到进来之前的页面 -->
            <RouterLink v-if="post.next" class="pd-next m-press" :to="postTo(post.next.id)" replace>
              <div class="nx">
                <span class="lb">下一篇</span>
                <span class="tt2">{{ post.next.title }}</span>
              </div>
              <Cover v-if="post.next.thumb" class="th" v-bind="post.next.thumb" />
            </RouterLink>
            <div v-else class="pd-end">已经是最后一篇了</div>
            <div class="pad-b" />
          </div>

          <div v-else class="pd-body" aria-hidden="true">
            <!-- 加载中：正文骨架 -->
            <div class="sk sk-t" />
            <div class="sk sk-t" style="width: 62%" />
            <div class="sk sk-p" />
            <div class="sk sk-p" />
            <div class="sk sk-p" style="width: 80%" />
            <div class="sk sk-img" />
          </div>
        </Transition>
      </div>
    </div>

    <footer v-if="post" class="pd-bar">
      <span class="pd-read">阅读 {{ formatCount(stats.read) }}</span>
      <button type="button" class="pd-share m-press-sm" aria-label="分享" @click="share({ title: post.title })"><Icon name="shareUp" /></button>
      <button type="button" class="pd-fav m-press" :class="{ on: stats.faved }" :aria-pressed="stats.faved" @click="onFav">
        <span class="ico"><Icon ref="favIcon" name="bookmark" /><ActBurst v-if="favBurst" :key="favBurst" @done="favBurst = 0" /></span>
        <span>收藏 <RollNum :value="formatCount(stats.fav)" :n="stats.fav" /></span>
      </button>
    </footer>

    <ImageViewer v-if="viewer" :images="viewer.images" :index="viewer.index" :origin="imageEl" @close="viewer = null" />
    <UnfollowSheet v-model:open="unfollowAsk" :name="author?.name || ''" @confirm="setFollow(false)" />
  </div>
</template>

<style scoped>
/* ---------- 作者栏（在滚动区外面，始终可见） ---------- */
.pd-hd { display: flex; flex: none; align-items: center; gap: 10px; height: 66px; padding: 0 16px 0 4px; border-bottom: 1px solid var(--line); }
.pd-back { position: relative; display: grid; flex: none; place-items: center; width: 36px; height: 44px; }
.pd-back svg { width: 24px; height: 24px; stroke-width: 2.5; }
.pd-author { display: flex; flex: 1; align-items: center; gap: 10px; min-width: 0; align-self: stretch; }
.pd-av { flex: none; width: 46px; height: 46px; border-radius: 50%; filter: var(--media); }
.pd-who { display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 3px; min-width: 0; }
.pd-nm { display: flex; align-items: center; gap: 5px; min-width: 0; }
.pd-nm span { overflow: hidden; font-size: 17px; font-weight: 700; line-height: 23px; white-space: nowrap; text-overflow: ellipsis; }
.pd-nm .vf { width: 16px; height: 16px; }
.pd-sub { display: flex; min-width: 0; color: var(--t2); font-size: 13px; line-height: 18px; white-space: nowrap; }
.pd-sub .hd { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pd-sub .tm { flex: none; }
.pd-sub .hd + .tm::before { content: '·'; padding: 0 4px; }
/* 关注按钮（FollowBtn）：两种文字叠在一格里，宽度不跳 */
.pd-follow {
  flex: none;
  height: 32px;
  padding: 0 14px;
  border-radius: 16px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-weight: 700;
}
.pd-follow.on { background: var(--chip); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1); color: var(--t2); }

/* ---------- 正文 ---------- */
.pd-body { padding: 14px 16px 0; }
.pd-title { font-size: 20px; font-weight: 700; line-height: 1.45; overflow-wrap: break-word; word-break: break-word; }
.pd-text { margin-top: 10px; color: var(--t3); font-size: 16px; line-height: 1.75; white-space: pre-line; overflow-wrap: break-word; word-break: break-word; }
.pd-text p + p { margin-top: 12px; }
.pd-video + .pd-text { margin-top: 14px; }
.pd-link { color: var(--accent); text-decoration: underline; text-decoration-color: rgba(255, 255, 255, .4); text-underline-offset: 3px; word-break: break-all; }

.pd-imgs { display: flex; flex-direction: column; gap: 14px; margin-top: 16px; }
.pd-img-b { display: block; width: 100%; border-radius: 12px; cursor: zoom-in; }
.pd-img { width: 100%; border-radius: 12px; filter: var(--media); transition: opacity var(--dur-2) var(--ease-out); }
.pd-img-b.m-pressed .pd-img { opacity: .85; transition-duration: var(--dur-1); }

.pd-video { display: block; margin-top: 14px; border-radius: 12px; }
.pd-vcv { aspect-ratio: 16 / 9; border-radius: 12px; filter: var(--media); transition: opacity var(--dur-2) var(--ease-out); }
.pd-video.m-pressed .pd-vcv { opacity: .85; transition-duration: var(--dur-1); }
/* 左右拼图：两半各自 cover 铺满，中间露出 1px 底色当作缝；高度用 padding 撑（iOS 14 不认 aspect-ratio） */
.pd-split { position: relative; overflow: hidden; aspect-ratio: auto; background: var(--bg); }
.pd-split::before { content: ''; display: block; padding-top: 56.25%; }
.pd-half { position: absolute; top: 0; bottom: 0; width: calc(50% - .5px); }
.pd-half.l { left: 0; }
.pd-half.r { right: 0; }
.pd-split .pl { z-index: 1; }
.pd-split .dur { z-index: 1; }
.pd-vcv .pl {
  position: absolute;
  left: 50%;
  top: 50%;
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  margin: -29px 0 0 -29px;
  border-radius: 50%;
  background: rgba(40, 40, 40, .55);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #fff;
}
.pd-vcv .pl svg { width: 26px; height: 26px; margin-left: 3px; }
.pd-vcv .dur { right: 10px; bottom: 10px; height: 22px; padding: 0 7px; font-size: 12px; line-height: 22px; }

.pd-tags { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 16px; }
.pd-tag { color: var(--accent); font-size: 15px; font-weight: 500; line-height: 26px; transition: opacity var(--dur-1) var(--ease-out); }
.pd-tag:active { opacity: .6; }
.pd-time { margin-top: 10px; color: var(--t2); font-size: 13px; line-height: 18px; }

.pd-div { height: 1px; margin: 18px 0 16px; border: 0; background: var(--line); }

/* ---------- 下一篇 ---------- */
.pd-next {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 16px;
  padding: 12px 12px 12px 14px;
  border-radius: 14px;
  background: var(--panel);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06);
  transition: background-color var(--dur-2) var(--ease-out);
}
/* 按下去立刻缩一点（全局 m-press）、底色变亮 */
.pd-next.m-pressed { background: #171717; transition-duration: var(--dur-1); }
.pd-next .nx { flex: 1; min-width: 0; }
.pd-next .lb { display: block; color: var(--accent); font-size: 13px; font-weight: 700; line-height: 18px; }
.pd-next .tt2 {
  display: -webkit-box;
  margin-top: 4px;
  overflow: hidden;
  color: var(--t3);
  font-size: 15px;
  line-height: 22px;
  word-break: break-all;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pd-next .th { flex: none; width: 96px; height: 68px; border-radius: 8px; filter: var(--media); }
.pd-end { padding: 6px 16px; color: var(--t2); font-size: 13px; text-align: center; }

/* ---------- 底部栏（在滚动区外面，不会盖住正文） ---------- */
.pd-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  height: calc(66px + var(--safe-b));
  padding: 0 16px var(--safe-b);
  border-top: 1px solid var(--line);
  background: var(--bg);
}
.pd-read { margin-right: auto; overflow: hidden; color: var(--t2); font-size: 14px; white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.pd-share { display: grid; flex: none; place-items: center; width: 44px; height: 44px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .16); transition: background-color var(--dur-2) var(--ease-out); }
.pd-share svg { width: 19px; height: 19px; stroke-width: 1.9; }
.pd-share.m-pressed { background: var(--chip); transition-duration: var(--dur-1); }
.pd-fav {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
  height: 44px;
  padding: 0 20px 0 17px;
  border-radius: 22px;
  box-shadow: inset 0 0 0 1.5px var(--accent);
  color: var(--accent);
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
/* 收藏后胶囊填满、图标弹一下（按压缩放是全局 m-press） */
.pd-fav .ico { position: relative; display: block; }
.pd-fav svg { width: 18px; height: 18px; stroke-width: 2.2; fill: currentColor; fill-opacity: 0; transition: fill-opacity var(--dur-1) var(--ease-out); }
.pd-fav.on { background: var(--accent); color: var(--on-accent); }
.pd-fav.on svg { fill-opacity: 1; }

/* ---------- 骨架 ---------- */
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.pd-av.sk { border-radius: 50%; }
.sk-l { height: 16px; }
.sk-s { height: 12px; }
.sk-t { height: 22px; margin-bottom: 8px; }
.sk-p { height: 15px; margin-top: 12px; }
.sk-img { margin-top: 18px; aspect-ratio: 4 / 3; border-radius: 12px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}
</style>
