<script>
/*
 * 返回恢复：主页不常驻（不在 KeepAlive 里），点进视频 / 帖子再按返回时，用离开前存下的状态
 * （已加载的列表、标签页、排序、滚动位置）原样放回，不用从头加载、也不会回到顶部。
 * 只在「返回到这条历史记录」时恢复（history.state.forward 有值）；重新点进来是全新的一页。
 */
const snapshots = new Map()
const SNAPSHOT_TTL = 10 * 60 * 1000
const SNAPSHOT_MAX = 6
</script>

<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router'
import { getCreator, getCreatorVideos, getCreatorPosts, toggleFollow } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import Icon from '@/components/Icon.vue'
import VideoCard from '@/components/VideoCard.vue'
import PostCard from '@/components/community/PostCard.vue'
import PostSkeleton from '@/components/community/PostSkeleton.vue'
import CreatorHeader from '@/components/creator/CreatorHeader.vue'
import UnfollowSheet from '@/components/creator/UnfollowSheet.vue'
import { createFeed, PAGE } from '@/components/creator/feed'
import { haptic } from '@/utils/motion'
import { cameBack, useSlider, cover, vRise, fadeIn } from '@/components/home/motion'

/*
 * 创作者主页（#/creator/:id?tab=videos|posts）：头图 + 头像 + 关注 + 数据行，下面是吸顶的「视频 / 帖子」标签。
 * 视频：最新 / 最热 + 两列卡片；帖子：社区卡片列表。两个列表都是滚到底自动加载下一页。
 * 标签记在地址栏（replace，不多一条历史），刷新 / 返回还是同一个标签；没指定时默认「视频」，没有视频而有帖子时默认「帖子」。
 */
defineOptions({ name: 'CreatorView' })

const TABS = [{ key: 'videos', label: '视频' }, { key: 'posts', label: '帖子' }]
const SORTS = ['最新', '最热']
/* 顶栏（返回键那一行）高度；标签栏吸顶在它下面。和样式里的 48px 保持一致 */
const TOP_BAR = 48
/* 头图高度，滚过它（减去顶栏）顶栏变成实底并显示名字。和 CreatorHeader 的 150px 一致 */
const BANNER = 150
/* 离底部还有这么多像素就取下一页 */
const PRELOAD = 800

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const back = useBack()
/* 按返回回到这一页：恢复出来的头部和列表不播入场 */
cameBack()

const scroller = ref(null)
const header = ref(null)
const creator = shallowRef(null)
/* 加载失败：message 给用户看；retry 只在可能是网络问题时显示（创作者不存在重试也没用） */
const failed = ref(null)
const following = ref(false)
const followers = ref(0)
const tab = ref('videos')
const sort = ref(0)
/* 每换一次排序 +1：重建网格，新列表淡入 */
const sortKey = ref(0)
const collapsed = ref(false)
/* 取消关注前的确认 */
const unfollowAsk = ref(false)

let currentId = null
const videos = createFeed(page => getCreatorVideos(currentId, sort.value, page))
const posts = createFeed(page => getCreatorPosts(currentId, page))
const feeds = { videos, posts }
const feed = computed(() => feeds[tab.value])

const queryTab = v => (v === 'videos' || v === 'posts' ? v : null)
/* 标签上的数字：列表取过就用列表的 total（更新），否则用头部的计数 */
const count = key => feeds[key].total ?? (key === 'videos' ? creator.value?.videoCount : creator.value?.postCount) ?? 0

/* ---------- 加载 ---------- */

let loadSeq = 0
let lastTop = 0
const savedTop = { videos: 0, posts: 0 }

function resetView() {
  creator.value = null
  failed.value = null
  following.value = false
  followers.value = 0
  sort.value = 0
  videos.reset()
  posts.reset()
  collapsed.value = false
  lastTop = savedTop.videos = savedTop.posts = 0
  if (scroller.value) scroller.value.scrollTop = 0
}

async function load(id) {
  const token = ++loadSeq
  currentId = id
  resetView()
  const want = queryTab(route.query.tab)
  tab.value = want || 'videos'
  feed.value.more() // 和头部同时请求
  try {
    const c = await getCreator(id)
    if (token !== loadSeq) return
    applyHeader(c)
    if (!want && !c.videoCount && c.postCount) tab.value = 'posts'
    await nextTick()
    checkMore()
  } catch (e) {
    if (token !== loadSeq) return
    videos.reset()
    posts.reset()
    const missing = e?.status >= 400 && e?.status < 500 && e?.status !== 401
    failed.value = missing
      ? { message: (e.status === 400 && e.message) || '创作者不存在', retry: false }
      : { message: e?.message || '加载失败，请检查网络', retry: true }
  }
}

function applyHeader(c) {
  creator.value = c
  following.value = !!c.following
  followers.value = c.followers ?? 0
}

/* 头部数据（是否关注、粉丝数）在别处可能变了：静默刷新一次，失败就保持原样；同时发起的几次合并成一个请求 */
let headerReq = null
function refreshHeader() {
  const c = creator.value
  if (!c) return Promise.resolve()
  if (!headerReq) {
    headerReq = getCreator(c.id)
      .then(d => { if (creator.value?.id === c.id && !followBusy) applyHeader(d) })
      .catch(() => { /* 保持原样 */ })
      .finally(() => { headerReq = null })
  }
  return headerReq
}

/* ---------- 滚动：顶栏变实底、滚到底加载下一页 ---------- */

function onScroll() {
  const el = scroller.value
  if (!el) return
  lastTop = el.scrollTop
  collapsed.value = el.scrollTop > BANNER - TOP_BAR
  checkMore()
  // 头图视差 / 回弹放大：每帧最多改一次
  if (!parallaxRaf) parallaxRaf = requestAnimationFrame(applyParallax)
}
let parallaxRaf = 0
function applyParallax() {
  parallaxRaf = 0
  header.value?.parallax?.(scroller.value?.scrollTop ?? 0)
}
onBeforeUnmount(() => cancelAnimationFrame(parallaxRaf))

function checkMore() {
  const el = scroller.value
  const f = feed.value
  if (!el || !creator.value || f.loading || f.done || f.error) return
  if (f.total === null || el.scrollHeight - el.scrollTop - el.clientHeight < PRELOAD) f.more()
}

/* 一页回来后内容可能还不满一屏：接着检查 */
watch(() => feed.value.loading, busy => { if (!busy) nextTick(checkMore) })

/* 标签栏吸顶时的滚动位置 */
const stickTop = () => Math.max(0, (header.value?.$el?.offsetHeight ?? 0) - TOP_BAR)

/* 标签下的指示条（跟着文字宽度）、排序胶囊的白底：选中项变了滑过去 */
const tabRow = ref(null)
const tabBar = ref(null)
useSlider(tabRow, tabBar, cover('.cr-tab.on .lb', 2), { key: () => tab.value, deps: () => [creator.value, count('videos'), count('posts')] })
const sortRow = ref(null)
const sortBar = ref(null)
useSlider(sortRow, sortBar, cover('.chip.on'), { key: () => sort.value })

/* 切标签：新的一栏从切换的方向淡入一点 */
const panes = {}
function showPane(key) {
  const dir = TABS.findIndex(t => t.key === key) > TABS.findIndex(t => t.key === tab.value) ? 1 : -1
  nextTick(() => fadeIn(panes[key], { x: dir * 12 }))
}

/* ---------- 标签 / 排序 ---------- */

function selectTab(key) {
  const el = scroller.value
  if (!el || !creator.value) return
  const stick = stickTop()
  if (key === tab.value) {
    // 再点一次当前标签：回到列表开头
    if (el.scrollTop > stick) el.scrollTo({ top: stick, behavior: 'smooth' })
    return
  }
  savedTop[tab.value] = el.scrollTop
  const stuck = el.scrollTop >= stick - 1
  showPane(key)
  tab.value = key
  router.replace({ query: { ...route.query, tab: key } })
  nextTick(() => {
    // 标签栏已经吸顶：回到这个标签上次看到的位置（至少吸顶）；头部还露着就保持不动
    if (stuck) el.scrollTop = Math.max(stick, savedTop[key])
    onScroll()
  })
}

/* 方向键在两个标签之间切换（只有选中的标签能 Tab 进入） */
function onTabKey(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const i = TABS.findIndex(t => t.key === tab.value)
  const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].key
  selectTab(next)
  nextTick(() => document.getElementById(`cr-tab-${next}`)?.focus())
}

function changeSort(i) {
  if (sort.value === i) return
  sort.value = i
  sortKey.value++
  videos.reset()
  const el = scroller.value
  const stick = stickTop()
  if (el && el.scrollTop > stick) el.scrollTop = stick
  videos.more()
}

/* ---------- 关注：乐观更新 → 一次请求（带明确的 on）→ 以返回为准，失败回滚并提示 ---------- */

let followBusy = false
function onFollow() {
  const c = creator.value
  if (!c || followBusy) return
  if (!auth.requireLogin({ then: followAfterLogin })) return // 未登录：弹登录框，登录后自动关注
  if (following.value) unfollowAsk.value = true // 取消关注先确认
  else {
    haptic()
    setFollow(true)
  }
}

/* 登录后补做关注：先按新账号取一次头部（是否已关注、粉丝数），已经关注过就不再重复 */
async function followAfterLogin() {
  await refreshHeader()
  if (following.value) toast('已关注')
  else setFollow(true)
}

async function setFollow(next) {
  const c = creator.value
  if (!c || followBusy) return
  const before = { following: following.value, followers: followers.value }
  if (next === before.following) return
  following.value = next
  followers.value = Math.max(0, before.followers + (next ? 1 : -1))
  followBusy = true
  try {
    const res = await toggleFollow(c.id, { on: next })
    if (creator.value?.id !== c.id) return
    const on = typeof res?.active === 'boolean' ? res.active : next
    following.value = on
    if (typeof res?.followers === 'number') followers.value = res.followers
    else if (on !== next) followers.value = before.followers
    toast(on ? '已关注' : '已取消关注')
  } catch (e) {
    if (creator.value?.id === c.id) {
      following.value = before.following
      followers.value = before.followers
    }
    toast((e?.status === 400 || e?.code === 'demo') && e.message ? e.message : '操作失败，请稍后重试')
  } finally {
    followBusy = false
  }
}

/* 「帖子」里已显示的几页按当前账号重新取一遍、原地替换（收藏状态跟着账号走，顺序和位置不变） */
async function refetchPosts() {
  const id = currentId
  const n = posts.list.length
  if (!n) return
  try {
    const pages = []
    for (let offset = 0; offset < n; offset += PAGE) pages.push(getCreatorPosts(id, { limit: PAGE, offset }))
    const byId = new Map((await Promise.all(pages)).flatMap(r => r?.list || []).map(p => [String(p.id), p]))
    if (currentId === id) posts.list = posts.list.map(p => byId.get(String(p.id)) || p)
  } catch { /* 取不到就算了：未登录时卡片本来就不显示收藏状态 */ }
}

/* 在本页登录 / 退出后，重新取一次「是否关注」和帖子的收藏状态（未登录时接口给的都是 false） */
const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))
watch(session, (now, before) => {
  if (before === null) return // 启动时的首次校验不算
  refreshHeader()
  refetchPosts()
})

/* ---------- 返回恢复 ---------- */

const snapKey = `${window.history.state?.position ?? ''}:${route.params.id}`

function saveSnapshot() {
  if (!creator.value || failed.value) return
  snapshots.delete(snapKey)
  snapshots.set(snapKey, {
    at: Date.now(),
    id: currentId,
    creator: creator.value,
    following: following.value,
    followers: followers.value,
    tab: tab.value,
    sort: sort.value,
    top: lastTop,
    savedTop: { ...savedTop },
    videos: videos.snapshot(),
    posts: posts.snapshot()
  })
  while (snapshots.size > SNAPSHOT_MAX) snapshots.delete(snapshots.keys().next().value)
}

function restoreSnapshot(id) {
  const s = window.history.state?.forward ? snapshots.get(snapKey) : null
  snapshots.delete(snapKey)
  if (!s || String(s.id) !== String(id) || Date.now() - s.at > SNAPSHOT_TTL) return false
  currentId = id
  applyHeader(s.creator)
  following.value = s.following
  followers.value = s.followers
  tab.value = s.tab
  sort.value = s.sort
  videos.restore(s.videos)
  posts.restore(s.posts)
  Object.assign(savedTop, s.savedTop)
  lastTop = s.top
  return true
}

const restored = restoreSnapshot(route.params.id)
if (!restored) load(route.params.id)

onMounted(() => {
  if (!restored) return
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = lastTop
    onScroll()
  })
  refreshHeader()
})
onBeforeUnmount(saveSnapshot)

onBeforeRouteUpdate(to => {
  if (to.params.id !== route.params.id) return load(to.params.id)
  // 地址栏里的标签被外部改了（比如别处的链接）：跟着切
  const t = queryTab(to.query.tab)
  if (t && t !== tab.value && creator.value) selectTab(t)
})
</script>

<template>
  <div class="page creator">
    <!-- 顶栏：返回键压在头图上；滚过头图后变成实底并显示名字 -->
    <div class="cr-top" :class="{ solid: collapsed || failed }">
      <button type="button" class="cr-back hit-44 m-press-sm" aria-label="返回" @click="back"><Icon name="chevL" /></button>
      <span class="cr-tt" :aria-hidden="!collapsed">{{ creator?.name }}</span>
    </div>

    <div ref="scroller" class="scroll" @scroll.passive="onScroll">
      <div v-if="failed" class="empty cr-fail">
        {{ failed.message }}
        <button v-if="failed.retry" type="button" class="retry" @click="load(route.params.id)">重试</button>
        <button v-else type="button" class="retry" @click="back">返回</button>
      </div>

      <template v-else>
        <CreatorHeader ref="header" :creator="creator" :following="following" :followers="followers" :calm="restored" @follow="onFollow" />

        <div ref="tabRow" class="cr-tabs" role="tablist" aria-label="主页内容">
          <span ref="tabBar" class="m-bar cr-bar" aria-hidden="true" />
          <button
            v-for="t in TABS"
            :id="`cr-tab-${t.key}`"
            :key="t.key"
            type="button"
            role="tab"
            class="cr-tab"
            :class="{ on: tab === t.key }"
            :aria-selected="tab === t.key"
            :aria-controls="`cr-pane-${t.key}`"
            :tabindex="tab === t.key ? 0 : -1"
            @click="selectTab(t.key)"
            @keydown="onTabKey"
          >
            <span class="lb">{{ t.label }}<span v-if="creator" class="n">{{ count(t.key) }}</span></span>
          </button>
        </div>

        <!-- 视频 -->
        <section
          v-show="tab === 'videos'"
          id="cr-pane-videos"
          :ref="el => { panes.videos = el }"
          class="cr-pane"
          role="tabpanel"
          aria-labelledby="cr-tab-videos"
        >
          <div v-if="creator && (count('videos') > 0 || sort !== 0)" ref="sortRow" class="chips">
            <span ref="sortBar" class="m-bar cr-sort-bar" aria-hidden="true" />
            <button
              v-for="(s, i) in SORTS"
              :key="s"
              type="button"
              class="chip m-off"
              :class="{ on: sort === i }"
              :aria-pressed="sort === i"
              @click="changeSort(i)"
            >
              <span class="lb">{{ s }}</span>
            </button>
          </div>
          <!-- 骨架 / 换排序前的旧列表原地淡出，新列表错峰浮现 -->
          <div class="m-swap">
            <Transition name="m-skel">
              <div v-if="videos.total === null && !videos.error" class="grid g11 cr-sk" :class="{ pt: !creator }" aria-hidden="true">
                <div v-for="i in 6" :key="i" class="vc"><div class="cv sk" /><div class="sk sk-tt" /></div>
              </div>
              <div v-else-if="videos.total === null" class="empty">
                加载失败，请检查网络
                <button type="button" class="retry" @click="videos.more()">重试</button>
              </div>
              <div v-else-if="!videos.list.length" v-rise.self class="empty">还没有发布视频</div>
              <div v-else :key="`list${sortKey}`">
                <div v-rise class="grid g11">
                  <VideoCard v-for="v in videos.list" :key="v.id" :video="v" />
                </div>
                <div class="cr-foot">
                  <span v-if="videos.loading">加载中…</span>
                  <button v-else-if="videos.error" type="button" class="cr-more" @click="videos.more()">加载失败，点击重试</button>
                  <span v-else-if="videos.done">没有更多了</span>
                </div>
              </div>
            </Transition>
          </div>
        </section>

        <!-- 帖子：卡片和社区列表同一个组件；作者就是本页的创作者，头像 / 名字不再链接 -->
        <section
          v-show="tab === 'posts'"
          id="cr-pane-posts"
          :ref="el => { panes.posts = el }"
          class="cr-pane"
          role="tabpanel"
          aria-labelledby="cr-tab-posts"
        >
          <div class="m-swap">
            <Transition name="m-skel">
              <PostSkeleton v-if="posts.total === null && !posts.error" :count="2" />
              <div v-else-if="posts.total === null" class="empty">
                加载失败，请检查网络
                <button type="button" class="retry" @click="posts.more()">重试</button>
              </div>
              <div v-else-if="!posts.list.length" v-rise.self class="empty">还没有发布帖子</div>
              <div v-else>
                <PostCard v-for="p in posts.list" :key="p.id" :post="p" :author-link="false" />
                <div class="cr-foot">
                  <span v-if="posts.loading">加载中…</span>
                  <button v-else-if="posts.error" type="button" class="cr-more" @click="posts.more()">加载失败，点击重试</button>
                  <span v-else-if="posts.done">没有更多了</span>
                </div>
              </div>
            </Transition>
          </div>
        </section>
      </template>
      <div class="pad-b" />
    </div>

    <UnfollowSheet v-model:open="unfollowAsk" :name="creator?.name || ''" @confirm="setFollow(false)" />
  </div>
</template>

<style scoped>
/* ---- 顶栏 ---- */
.cr-top {
  position: absolute;
  top: var(--safe-t);
  left: 0;
  right: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 14px 0 12px;
  /* 透明时不挡住下面的滚动（拖头图也能滚）；变成实底后挡住，免得点穿到下面的卡片 */
  pointer-events: none;
  transition: background-color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}
.cr-top > * { pointer-events: auto; }
.cr-top.solid { background: var(--bg); box-shadow: 0 1px 0 var(--line); pointer-events: auto; }
.cr-back {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(0, 0, 0, .42);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #fff;
  transition: background-color var(--dur-2) var(--ease-out);
}
.cr-back svg { width: 18px; height: 18px; stroke-width: 2.8; }
.cr-top.solid .cr-back { background: transparent; }
/* 顶栏变实底时名字从下面浮上来，变回透明时淡出 */
.cr-tt {
  min-width: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
  opacity: 0;
  transform: translate3d(0, 8px, 0);
  transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in);
}
.cr-top.solid .cr-tt { opacity: 1; transform: none; transition: opacity var(--dur-3) var(--ease-out), transform var(--dur-3) var(--ease-out); }

.cr-fail { padding-top: 120px; }

/* ---- 吸顶标签栏 ---- */
.cr-tabs { position: sticky; top: 48px; z-index: 4; display: flex; height: 46px; border-bottom: 1px solid var(--line); background: var(--bg); }
.cr-tab { display: flex; flex: 1; justify-content: center; color: var(--t2); font-size: 16px; font-weight: 500; transition: color var(--dur-2) var(--ease-out); }
.cr-tab .lb { position: relative; display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.cr-tab .n { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
.cr-tab.on { color: var(--t1); font-weight: 700; }
/* 指示条（useSlider）：和文字一样宽，换标签时滑过去 */
.cr-bar { bottom: 0; height: 3px; border-radius: 2px; background: var(--accent); }
/* 排序胶囊的白底（useSlider）：压在灰底上面、文字下面 */
.cr-pane .chips { position: relative; z-index: 0; }
.cr-sort-bar { top: 12px; z-index: 1; height: 27.5px; border-radius: 14px; background: var(--accent); }
.cr-pane .chip { transition: color var(--dur-2) var(--ease-in-out), background-color var(--dur-2) var(--ease-in-out); }
.cr-pane [data-slider] > .chip.on { background: transparent; }
.cr-pane .chip .lb { position: relative; z-index: 2; transition: opacity var(--dur-1) var(--ease-out); }
/* 胶囊不缩放（m-off）：缩放会让文字跑到白底下面去，按下时只把字调暗 */
.cr-pane .chip:active .lb { opacity: .6; }
.cr-tab:focus-visible { outline-offset: -4px; }

/* 内容不满一屏时也能让标签栏吸顶（切标签时不跳回头部） */
.cr-pane { min-height: calc(100% - 94px); }
.cr-pane > .m-swap:first-child .grid { padding-top: 14px; }

.cr-foot { display: grid; place-items: center; height: 52px; color: var(--t2); font-size: 13px; }
.cr-more { height: 32px; padding: 0 14px; color: var(--t1); font-size: 13px; }

/* ---- 骨架 ---- */
.cr-sk.pt { padding-top: 14px; }
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.cv.sk { border-radius: 8px; }
.sk-tt { width: 70%; height: 12px; margin-top: 8px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}
</style>
