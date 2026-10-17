<script>
/*
 * 返回恢复（做法同 CreatorView）：专题页不常驻（不在 KeepAlive 里），点进视频再返回时，用离开前存下的
 * 专题信息、排序、已加载的视频和滚动位置原样放回，不重新请求，也不回到顶部。
 * 只在「返回到这条历史记录」时恢复（history.state.forward 有值）；重新点进来是全新的一页。
 */
const snapshots = new Map()
const SNAPSHOT_TTL = 10 * 60 * 1000
const SNAPSHOT_MAX = 6
</script>

<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router'
import Icon from '@/components/Icon.vue'
import Cover from '@/components/Cover.vue'
import VideoCard from '@/components/VideoCard.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import { createPagedFeed, feedCount, useScrollMore } from '@/components/search/paging'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import { getTopic, getTopicVideos, toggleTopicFav } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { rememberVideo } from '@/components/video/preview'
import { haptic } from '@/utils/motion'
import { cameBack, useSlider, cover, vRise, pop, scrollBehavior } from '@/components/home/motion'

/*
 * 专题页（#/topic/:id?sort=1）：头图 + 播放 / 收藏数 +「播放全部」「收藏」，下面是排序标签和两列视频，滚到底自动加载下一页。
 * 排序记在地址栏（replace，不多一条历史），刷新 / 返回还是同一个排序；省略 = 第一个（默认）。
 * 从这里打开的视频带上所在列表（?list=topic:专题id&i=第几条&sort=排序），播放页据此接着播下一条。
 */
defineOptions({ name: 'TopicView' })

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const back = useBack()
/* 按返回回到专题：恢复出来的头图和列表不播入场 */
cameBack()

const sortOf = v => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 20 ? n : 0
}
const fmtCount = n => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w' : String(n))

const scrollEl = ref(null)
const listEl = ref(null)
const topic = shallowRef(null)
const sort = ref(sortOf(route.query.sort))
/* 每换一次排序 +1：重建网格，新列表淡入 */
const sortKey = ref(0)
/** 加载失败：{ message, retry }；专题不存在 / 已下架（4xx）不给重试 */
const failed = ref(null)

let currentId = null
const videos = createPagedFeed(page => getTopicVideos(currentId, sort.value, page))
const checkMore = useScrollMore(scrollEl, () => (topic.value ? videos : null))

const faved = computed(() => !!(topic.value && topic.value.faved))
const favCount = computed(() => (topic.value ? topic.value.favs || 0 : 0))
/* 「视频 (n)」：列表取过就用列表的数（更新），否则用专题信息里的 */
const videoCount = computed(() => feedCount(videos) ?? topic.value?.total ?? 0)
/* 播放数 / 收藏数为 0 时不显示这一项（「0次播放」像是没人看）；都没有时显示视频数 */
const stats = computed(() => {
  const t = topic.value
  if (!t) return ''
  const plays = t.playCount ?? (parseFloat(t.plays) || 0)
  const parts = []
  if (plays > 0) parts.push(`${t.plays}次播放`)
  if (favCount.value > 0) parts.push(`${fmtCount(favCount.value)}收藏`)
  return parts.length ? parts.join(' · ') : `${t.total ?? 0}个视频`
})

/* ---------- 加载 ---------- */

let loadSeq = 0
let lastTop = 0

async function load(id) {
  const token = ++loadSeq
  currentId = id
  failed.value = null
  topic.value = null
  videos.reset()
  lastTop = 0
  if (scrollEl.value) scrollEl.value.scrollTop = 0
  videos.more()   // 和专题信息同时请求
  try {
    const t = await getTopic(id)
    if (token !== loadSeq) return
    topic.value = t
    // 地址栏里的排序超出范围：回到默认
    if (sort.value >= (t.sorts?.length || 1)) {
      sort.value = 0
      syncSort()
      videos.reset()
      videos.more()
    }
  } catch (e) {
    if (token !== loadSeq) return
    videos.reset()
    const missing = e?.status >= 400 && e?.status < 500 && e?.status !== 401
    failed.value = {
      message: missing ? '专题不存在或已下架' : '加载失败，请检查网络',
      retry: !missing
    }
  }
}

/* 专题信息（是否收藏、播放 / 收藏数）在别处可能变了：静默刷新一次，失败就保持原样 */
async function refreshTopic() {
  const id = currentId
  if (!topic.value) return
  try {
    const t = await getTopic(id)
    if (currentId === id && topic.value && !favBusy) topic.value = t
  } catch { /* 保持原样 */ }
}

function onScroll() {
  if (scrollEl.value) lastTop = scrollEl.value.scrollTop
}

/* ---------- 排序 ---------- */

/* 排序胶囊的白底：换排序时滑过去 */
const sortRow = ref(null)
const sortBar = ref(null)
useSlider(sortRow, sortBar, cover('.chip.on'), { key: () => sort.value, deps: () => topic.value })

function syncSort() {
  if (sortOf(route.query.sort) === sort.value) return
  const query = { ...route.query }
  if (sort.value) query.sort = String(sort.value)
  else delete query.sort
  router.replace({ query })
}

/* 列表开头（「视频 (n)」那一行）的滚动位置 */
function listTop() {
  const el = scrollEl.value
  const head = listEl.value
  if (!el || !head) return 0
  return Math.max(0, el.scrollTop + head.getBoundingClientRect().top - el.getBoundingClientRect().top)
}

function changeSort(i) {
  if (!topic.value) return
  const el = scrollEl.value
  const top = listTop()
  if (i === sort.value) {
    // 再点一次当前排序：回到列表开头
    if (el && el.scrollTop > top + 1) el.scrollTo({ top, behavior: scrollBehavior() })
    return
  }
  sort.value = i
  sortKey.value++
  syncSort()
  videos.reset()
  if (el && el.scrollTop > top) el.scrollTop = top
  videos.more()
}

/* ---------- 播放 ---------- */

/* 视频链接带上所在列表，播放页播完可以接着播专题里的下一条 */
function videoTo(v, i) {
  const sortPart = sort.value ? `&sort=${sort.value}` : ''
  return `/video/${encodeURIComponent(v.id)}?list=topic:${encodeURIComponent(currentId)}&i=${i}${sortPart}`
}

/* 播放全部：从当前排序的第一条开始播 */
function playAll() {
  const first = videos.list[0]
  if (first) {
    rememberVideo(first)
    router.push(videoTo(first, 0))
    return
  }
  if (videos.error) toast('加载失败，请稍后重试')
  else if (videos.total === null || videos.loading) toast('视频还在加载，请稍候')
  else toast('专题里还没有视频')
}

/* ---------- 收藏：一次请求（带明确的 on）→ 以返回为准；未登录先登录，登录后补上这次收藏 ---------- */

let favBusy = false
/* 点了收藏：心形弹一下（收藏时回弹 + 轻震，取消时轻轻一缩） */
const favIcon = ref(null)
async function toggleFav() {
  const t = topic.value
  if (!t || favBusy) return
  if (!auth.requireLogin({ then: favAfterLogin })) return
  const before = !!t.faved
  const next = !before
  pop(favIcon.value?.$el, next)
  if (next) haptic()
  favBusy = true
  try {
    const res = await toggleTopicFav(t.id, { on: next })
    const on = typeof res?.active === 'boolean' ? res.active : next
    const cur = topic.value
    if (cur && cur.id === t.id) {
      // 数量由后端维护；状态没变（别处已经收藏过）时数量也不变
      const delta = on === before ? 0 : on ? 1 : -1
      topic.value = { ...cur, faved: on, favs: Math.max(0, (cur.favs || 0) + delta) }
    }
    toast(on ? '已加入收藏' : '已取消收藏')
  } catch (e) {
    toast(e?.code === 'demo' && e.message ? e.message : '操作失败，请稍后重试')
  } finally {
    favBusy = false
  }
}

/* 未登录时点的收藏：登录后先取一次专题（可能早就收藏过），还没收藏才补上 */
async function favAfterLogin() {
  await refreshTopic()
  if (!topic.value) return
  if (topic.value.faved) toast('已在收藏中')
  else toggleFav()
}

/* 在本页登录 / 退出后，重新取一次「是否收藏」（未登录时接口给的都是 false） */
const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))
watch(session, (now, before) => {
  if (before !== null) refreshTopic()   // 启动时的首次校验不算
})

/* ---------- 返回恢复 ---------- */

const snapKey = `${window.history.state?.position ?? ''}:${route.params.id}`

function saveSnapshot() {
  if (!topic.value || failed.value) return
  snapshots.delete(snapKey)
  snapshots.set(snapKey, {
    at: Date.now(),
    id: currentId,
    topic: topic.value,
    sort: sort.value,
    videos: videos.snapshot(),
    top: lastTop
  })
  while (snapshots.size > SNAPSHOT_MAX) snapshots.delete(snapshots.keys().next().value)
}

function restoreSnapshot(id) {
  const s = window.history.state?.forward ? snapshots.get(snapKey) : null
  snapshots.delete(snapKey)
  if (!s || String(s.id) !== String(id) || s.sort !== sort.value || Date.now() - s.at > SNAPSHOT_TTL) return false
  currentId = id
  topic.value = s.topic
  videos.restore(s.videos)
  if (videos.total === null) videos.more()   // 离开时第一页还没回来
  lastTop = s.top
  return true
}

const restored = restoreSnapshot(route.params.id)
if (!restored) load(route.params.id)

onMounted(() => {
  if (!restored) return
  nextTick(() => {
    if (scrollEl.value) scrollEl.value.scrollTop = lastTop
    checkMore()
  })
  refreshTopic()
})
onBeforeUnmount(saveSnapshot)

onBeforeRouteUpdate(to => {
  if (to.params.id !== route.params.id) {
    sort.value = sortOf(to.query.sort)
    sortKey.value++
    load(to.params.id)
    return
  }
  // 地址栏里的排序被外部改了（比如别处的链接）：跟着切
  const s = sortOf(to.query.sort)
  if (s !== sort.value && topic.value) changeSort(s)
})
</script>

<template>
  <div class="page topic">
    <div ref="scrollEl" class="scroll" @scroll.passive="onScroll">
      <!-- the hero frame and back button render right away (doubling as the loading skeleton) -->
      <div class="hero">
        <button type="button" class="back hit-44 m-press-sm" aria-label="返回" @click="back"><Icon name="chevL" /></button>
        <template v-if="topic">
          <!-- 专题信息到了：封面一张张淡入并从微微放大落回原位，标题和按钮浮上来 -->
          <div v-rise="{ y: 0, scale: 1.08 }" class="mos">
            <Cover v-for="(c, i) in topic.covers" :key="i" v-bind="c" eager />
          </div>
          <div v-rise.self="{ delay: 80 }" class="info">
            <div class="ti">
              <h1>{{ topic.name }}</h1>
              <div class="st">{{ stats }}</div>
            </div>
            <div class="btns">
              <button type="button" class="b-play m-press" @click="playAll"><Icon name="play" />播放全部</button>
              <button type="button" class="b-fav m-press" :class="{ on: faved }" :aria-pressed="faved" @click="toggleFav">
                <Icon ref="favIcon" name="heart" /><span>{{ faved ? '已收藏' : '收藏' }}</span>
              </button>
            </div>
          </div>
        </template>
      </div>

      <div v-if="failed" class="empty">
        {{ failed.message }}
        <button v-if="failed.retry" type="button" class="retry" @click="load(route.params.id)">重试</button>
        <button v-else type="button" class="retry" @click="back">返回</button>
      </div>
      <SkeletonGrid v-else-if="!topic" class="tp-sk" :count="6" gap="g11" />
      <template v-else>
        <div ref="listEl" class="vtitle">视频 ({{ videoCount }})</div>
        <!-- 排序吸顶：滚到下面也能换排序；再点当前排序回到列表开头 -->
        <div ref="sortRow" class="chips hs tp-chips">
          <span ref="sortBar" class="m-bar tp-bar" aria-hidden="true" />
          <button
            v-for="(s, i) in topic.sorts"
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
        <!-- 换排序：旧列表原地淡出，骨架接上，新列表错峰浮现 -->
        <div class="m-swap">
          <Transition name="m-skel">
            <div v-if="videos.total === null && videos.error" class="empty">
              加载失败，请检查网络
              <button type="button" class="retry" @click="videos.more()">重试</button>
            </div>
            <SkeletonGrid v-else-if="videos.total === null" :count="6" gap="g11" />
            <div v-else-if="!videos.list.length" v-rise.self class="empty">专题里还没有视频</div>
            <div v-else :key="`list${sortKey}`">
              <div v-rise class="grid g11">
                <VideoCard v-for="(v, i) in videos.list" :key="v.id" :video="v" :to="videoTo(v, i)" />
              </div>
              <ListFoot :feed="videos" />
            </div>
          </Transition>
        </div>
      </template>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
/* ---- hero: 4-cover mosaic under a dark gradient ---- */
.hero { position: relative; flex: none; height: 200px; overflow: hidden; background: var(--panel); }
.hero::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, .18) 0%, rgba(10, 10, 10, 0) 35%, rgba(10, 10, 10, .78) 78%, rgba(10, 10, 10, .95) 100%);
}
.mos { position: absolute; inset: 0; display: flex; filter: var(--media); }
.mos > .cover { flex: 1; }
/* 32px 的圆钮，hit-44 把可点区域扩到 44×44（外观不变） */
.back {
  position: absolute;
  left: 10px;
  top: 8px;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(0, 0, 0, .42);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
.back svg { width: 18px; height: 18px; stroke-width: 3; }
.info { position: absolute; left: 16px; right: 15px; bottom: 13px; z-index: 2; display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; }
.info .ti { min-width: 0; }
.info h1 { overflow: hidden; font-size: 18px; font-weight: 700; line-height: 26px; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 8px rgba(0, 0, 0, .5); }
.info .st { overflow: hidden; color: #e4e4e4; font-size: 13px; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
.btns { display: flex; flex: none; align-items: center; gap: 11px; }
.b-play { display: flex; align-items: center; justify-content: center; gap: 4px; width: 85px; height: 27px; border-radius: 14px; background: var(--accent); color: var(--on-accent); font-size: 12px; font-weight: 700; }
.b-play svg { width: 11px; height: 11px; }
.b-fav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 65px;
  height: 27px;
  border: 1px solid rgba(255, 255, 255, .4);
  border-radius: 14px;
  background: rgba(0, 0, 0, .32);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #fff;
  font-size: 12px;
  transition: border-color var(--dur-2) var(--ease-out);
}
/* 填充用 fill-opacity 过渡（fill 从 none 到颜色没法渐变） */
.b-fav svg { width: 13px; height: 13px; fill: var(--accent); fill-opacity: 0; transition: fill-opacity var(--dur-1) var(--ease-out); }
.b-fav.on { border-color: rgba(255, 255, 255, .75); }
.b-fav.on svg { fill-opacity: 1; }

/* ---- list ---- */
.vtitle { margin: 0 12px; padding: 13px 2px 0; border-top: 1px solid var(--line); font-size: 16px; font-weight: 500; line-height: 22px; }
.tp-chips { position: sticky; top: 0; z-index: 4; background: var(--bg); }
/* 选中排序的白底（useSlider 滑动）：压在灰底上面、文字下面（吸顶栏自己有层级，滑块和文字的层级只在它里面比） */
.tp-bar { top: 12px; z-index: 1; height: 27.5px; border-radius: 14px; background: var(--accent); }
.tp-chips .chip { transition: background-color var(--dur-2) var(--ease-in-out); }
.tp-chips[data-slider] > .chip.on { background: transparent; }
.tp-chips .chip .lb { position: relative; z-index: 2; transition: opacity var(--dur-1) var(--ease-out); }
/* 字用 difference 混合：白底滑到哪里哪里的字反成黑的，滑动途中每个字都看得清（#b9 叠在灰底上 = 原来的 #a3） */
.tp-chips[data-slider] > .chip .lb { color: #b9b9b9; mix-blend-mode: difference; }
/* 一变成选中就是满的白 / 黑：按下时调暗的那一下不带进滑动里 */
.tp-chips[data-slider] > .chip.on .lb { color: #fff; opacity: 1; transition: none; }
/* 胶囊不缩放（m-off）：缩放会让文字跑到白底下面去，按下时只把字调暗 */
.tp-chips .chip:active .lb { opacity: .6; }
/* 专题信息还没回来：骨架接在头图下面，位置和真列表差不多 */
.tp-sk { padding-top: 88px; }
</style>
