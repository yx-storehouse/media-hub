<script setup>
import { ref, reactive, shallowRef, computed, watch, nextTick, onActivated, onDeactivated, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { getCommunityTabs, getPosts, isDemoId, apiStatus } from '@/api'
import { toast } from '@/composables/useToast'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { useTabRetap } from '@/composables/useTabRetap'
import { useAuthStore } from '@/stores/auth'
import { usePostStore } from '@/stores/posts'
import { createHomeFeed } from '@/components/home/list'
import { PAGE } from '@/components/creator/feed'
import Icon from '@/components/Icon.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import PostCard from '@/components/community/PostCard.vue'
import PostSkeleton from '@/components/community/PostSkeleton.vue'
import { useSlider, under, vRise } from '@/components/home/motion'

/*
 * 社区（常驻页）：最新 / 热门 / 关注 / 收藏四个标签，每个标签各自一份分页列表（滚到底自动加载）和滚动位置。
 *   - 第一次切到某个标签：先显示骨架，不会把上一个标签的内容留在下面；切回已加载过的标签原样恢复，
 *     数据旧了在后台静默刷新（在顶部时整体换新，往下翻过了只原地更新已显示的帖子）。
 *   - 关注 / 收藏要登录：未登录显示登录提示；登录、退出后按新账号重新取，退出时停在这两个标签就回到「最新」。
 *   - 再点一次底部「社区」或当前标签：滚动过就回到顶部，已经在顶部就刷新。
 */
defineOptions({ name: 'CommunityView' })

/* 标签下标就是接口的 tab 参数；接口没回来之前先用这组名字 */
const DEFAULT_TABS = ['最新', '热门', '关注', '收藏']
const FOLLOW = 2
const FAV = 3
const isPersonal = i => i === FOLLOW || i === FAV
/* 离底部还剩这么多像素时取下一页 */
const PRELOAD = 800
/* 切回标签、回到社区时，数据超过这么久才在后台刷新 */
const STALE = 30 * 1000

const router = useRouter()
const auth = useAuthStore()
const postStore = usePostStore()

const tabs = shallowRef(DEFAULT_TABS)
const active = ref(0)
const scroller = ref(null)
useKeepScroll(scroller)

/* 选中标签下面的指示条：换标签时滑过去 */
const tabRow = ref(null)
const tabBar = ref(null)
useSlider(tabRow, tabBar, under('.ct-tab.on', 21), { key: () => active.value, deps: () => tabs.value })
/*
 * 骨架 → 列表时骨架原地淡出（m-skel）；换标签时旧内容直接撤掉（滚动位置已经换成新标签的，再淡出会错位），
 * 新标签的帖子卡片自己错峰浮现
 */
const instant = ref(false)
/* 页面是否显示着（KeepAlive 收起时为 false）；收起期间切了标签，切回来时要放的滚动位置 */
let shown = true
let pendingTop = null

/* ---------- 每个标签一份列表 ---------- */

const feeds = []
/* 各标签离开时的滚动位置、最近一次拿到数据的时间 */
const tops = []
const loadedAt = []
/* 整体换过列表（刷新、换账号）就 +1：卡片重建并淡入，之前发出的后台刷新作废 */
const gen = reactive({})
const genOf = i => gen[i] || 0

/* 拿到一页：记下时间，清掉这些帖子在请求发出前记下的收藏 / 阅读数（列表里已经是接口的最新值） */
async function fetchPage(i, page) {
  const started = Date.now()
  const list = await getPosts(i, page)
  postStore.prune(started, list.map(p => p.id))
  loadedAt[i] = Date.now()
  return list
}

function feedOf(i) {
  return feeds[i] || (feeds[i] = createHomeFeed(page => fetchPage(i, page)))
}
const feed = computed(() => feedOf(active.value))

/* 未登录时的关注 / 收藏：显示登录提示，不请求 */
const needLogin = computed(() => isPersonal(active.value) && auth.ready && !auth.loggedIn)

/** 还没取过（或第一页失败了）就取第一页 */
function ensure(i) {
  if (isPersonal(i) && !auth.loggedIn) return
  const f = feedOf(i)
  if (f.total === null && !f.loading) f.more()
}

function resetTab(i) {
  feeds[i]?.reset()
  tops[i] = 0
  loadedAt[i] = 0
  gen[i] = genOf(i) + 1
}

/* 整体换成新的第一页（之后的页滚到底再取） */
function replaceList(i, list, fade) {
  feedOf(i).restore({ list, total: Infinity, done: list.length < PAGE })
  if (fade) gen[i] = genOf(i) + 1
}

/* 原地更新已显示的帖子（按 id 替换成新数据），顺序和滚动位置不变 */
function mergeList(i, fresh) {
  const f = feedOf(i)
  const byId = new Map(fresh.map(p => [String(p.id), p]))
  if (f.list.some(p => byId.has(String(p.id)))) f.list = f.list.map(p => byId.get(String(p.id)) || p)
}

/* 演示数据和真实数据不混在一起（开发环境 auto 模式下接口一时连不上才会有演示数据） */
const hasDemo = list => list.some(p => isDemoId(p.id))
const sameKind = (a, b) => hasDemo(a) === hasDemo(b)

/* 这个标签显示的是演示数据、接口又已经连上了：作废重取。返回 true 表示重取了 */
function retryDemo(i) {
  const f = feeds[i]
  if (!f || !hasDemo(f.list) || apiStatus().offline) return false
  resetTab(i)
  ensure(i)
  return true
}

/* ---------- 滚到底加载下一页 ---------- */

function checkMore() {
  const el = scroller.value
  const f = feed.value
  if (!el || !el.isConnected || !el.clientHeight) return
  if (f.total === null || f.loading || f.done || f.error) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < PRELOAD) f.more()
}
/* 一页回来后内容可能还不满一屏：接着检查 */
watch(() => feed.value.loading, busy => { if (!busy) nextTick(checkMore) })

/* ---------- 切换标签 ---------- */

function selectTab(i) {
  if (i === active.value) return toTopOrRefresh()
  const el = scroller.value
  if (el) tops[active.value] = el.scrollTop
  instant.value = true
  nextTick(() => { instant.value = false })
  active.value = i
  const f = feedOf(i)
  const fresh = retryDemo(i) || f.total === null
  ensure(i)
  // 第一次来从顶部开始；来过的回到上次的位置。页面收起时切的（在别处退出登录）等切回来再放
  const top = fresh ? 0 : tops[i] || 0
  nextTick(() => {
    const el2 = scroller.value
    if (el2?.isConnected) el2.scrollTop = top
    else pendingTop = top
    checkMore()
  })
  if (!fresh) silentRefresh(i)
}

/* ---------- 刷新 ---------- */

/*
 * 后台静默刷新第一页：在顶部时整体换成最新的（新帖子出现在最上面）；已经往下翻了就只原地更新
 * 已显示的帖子，不打乱位置。失败不提示，保留原样。
 * 最新 / 热门的数据超过 STALE 才刷；关注 / 收藏每次都刷（刚在别处关注、收藏过，切过来就该看到）。
 */
async function silentRefresh(i) {
  const f = feedOf(i)
  if (f.total === null || f.loading) return
  if (isPersonal(i) ? !auth.loggedIn : Date.now() - (loadedAt[i] || 0) < STALE) return
  const g = genOf(i)
  let list
  try {
    list = await fetchPage(i, { limit: PAGE, offset: 0 })
  } catch { return }
  if (g !== genOf(i) || f.total === null || !sameKind(list, f.list)) return
  const top = i === active.value ? scroller.value?.scrollTop ?? 0 : tops[i] || 0
  if (top < 4) replaceList(i, list, false)
  else mergeList(i, list)
}

/* 再点一次：刷新当前标签的第一页，换掉整个列表；正在刷新的标签顶部显示「正在刷新」 */
const refreshingTab = ref(-1)
async function refresh() {
  const i = active.value
  if (isPersonal(i) && !auth.loggedIn) return
  const f = feedOf(i)
  if (f.total === null) return ensure(i)
  if (refreshingTab.value === i) return
  refreshingTab.value = i
  const g = genOf(i)
  try {
    const list = await fetchPage(i, { limit: PAGE, offset: 0 })
    if (g === genOf(i)) replaceList(i, list, true)
  } catch {
    toast('刷新失败，请检查网络')
  } finally {
    if (refreshingTab.value === i) refreshingTab.value = -1
  }
}

/* 滚动过就平滑回到顶部，已经在顶部就刷新 */
function toTopOrRefresh() {
  const el = scroller.value
  if (el && el.scrollTop > 2) el.scrollTo({ top: 0, behavior: 'smooth' })
  else refresh()
}
useTabRetap('community', toTopOrRefresh)

/* 回到社区（从帖子详情返回、从别的 Tab 切回来）：数据旧了就在后台刷新当前标签 */
onActivated(() => {
  shown = true
  // 收起期间换过标签：useKeepScroll 放回的是上一个标签的位置，改成这个标签的
  if (pendingTop !== null && scroller.value) scroller.value.scrollTop = pendingTop
  pendingTop = null
  if (retryDemo(active.value)) return
  nextTick(checkMore)
  silentRefresh(active.value)
})
onDeactivated(() => { shown = false })

/* ---------- 登录 / 退出 ---------- */

/* 已显示的几页按新账号重新取一遍、原地替换：收藏状态跟着账号走，位置不变 */
async function refetchLoaded(i) {
  const f = feeds[i]
  if (!f || !f.list.length) return
  const g = genOf(i)
  const n = f.list.length
  try {
    const pages = []
    for (let offset = 0; offset < n; offset += PAGE) pages.push(fetchPage(i, { limit: PAGE, offset }))
    const fresh = (await Promise.all(pages)).flat()
    if (g === genOf(i)) mergeList(i, fresh)
  } catch { /* 取不到就算了：未登录时卡片本来就不显示收藏状态 */ }
}

const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))
watch(session, (now, before) => {
  // 启动时的首次校验：这时才知道关注 / 收藏能不能取
  if (before === null) return ensure(active.value)
  // 换了账号：关注 / 收藏清空（切过去时按新账号重新取），最新 / 热门已显示的帖子原地刷新
  resetTab(FOLLOW)
  resetTab(FAV)
  feeds.forEach((f, i) => { if (f && !isPersonal(i)) refetchLoaded(i) })
  if (!now && isPersonal(active.value)) selectTab(0)
  else ensure(active.value)
})

function login() {
  auth.requireLogin() // 登录成功后上面的 watch 会取这个标签
}

/* ---------- 断网 / 接口恢复 ---------- */

const online = ref(typeof navigator === 'undefined' || navigator.onLine !== false)
/* 网络恢复：当前标签之前没取到的（整页失败或下一页失败）自动重取 */
function onOnline() {
  online.value = true
  const f = feed.value
  if (f.error && !f.loading) f.more()
}
const onOffline = () => { online.value = false }
/*
 * 开发环境 auto 模式：接口恢复后，正在看的标签如果是演示数据就马上重取（别的标签切过去时再取）。
 * 最多 5 秒一次：某个接口一直连不上、别的接口又能通时，不会来回重取、来回提示。
 */
let apiRetryAt = 0
function onApi(e) {
  if (e.detail?.offline || !shown || Date.now() - apiRetryAt < 5000) return
  if (retryDemo(active.value)) apiRetryAt = Date.now()
}
window.addEventListener('online', onOnline)
window.addEventListener('offline', onOffline)
window.addEventListener('reel:api', onApi)
onUnmounted(() => {
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOffline)
  window.removeEventListener('reel:api', onApi)
})

/* 搜索框：进搜索页并默认搜帖子 */
const openSearch = () => router.push({ path: '/search', query: { type: 'post' } })

getCommunityTabs().then(list => { if (Array.isArray(list) && list.length) tabs.value = list }).catch(() => {})
ensure(active.value)
</script>

<template>
  <div class="page community">
    <header class="bar-hd">
      <div ref="tabRow" class="ct-tabs cm-tabs" role="tablist">
        <span ref="tabBar" class="m-bar cm-bar" aria-hidden="true" />
        <button
          v-for="(name, i) in tabs"
          :key="name"
          type="button"
          class="ct-tab"
          :class="{ on: i === active }"
          role="tab"
          :aria-selected="i === active"
          @click="selectTab(i)"
        >
          {{ name }}
        </button>
      </div>
      <button type="button" class="ct-search" aria-label="搜索帖子" @click="openSearch"><Icon name="search" /><span>搜索帖子</span></button>
    </header>

    <Transition name="cm-pill">
      <div v-if="refreshingTab === active" class="cm-refresh" role="status">正在刷新…</div>
    </Transition>

    <div ref="scroller" class="scroll" :aria-busy="feed.total === null && !feed.error && !needLogin" @scroll.passive="checkMore">
      <!-- 关注 / 收藏未登录、第一页失败、骨架、空列表、帖子列表：骨架原地淡出，其余的自己入场 -->
      <div class="m-swap">
        <Transition name="m-skel" :css="!instant">
          <div v-if="needLogin" :key="`login${active}`" v-rise.self class="cm-empty">
            <p class="t">{{ active === FOLLOW ? '登录后查看关注的创作者动态' : '登录后查看你收藏的帖子' }}</p>
            <p class="s">{{ active === FOLLOW ? '关注喜欢的创作者，他们发的新帖子都在这里' : '收藏的帖子会保存在这里，随时回来看' }}</p>
            <button type="button" class="cm-btn m-press" @click="login">登录</button>
          </div>

          <div v-else-if="feed.total === null && feed.error" key="error" class="empty">
            {{ online ? '加载失败，请检查网络后重试' : '网络已断开，连上网后会自动重新加载' }}
            <button type="button" class="retry" @click="feed.more()">重试</button>
          </div>

          <PostSkeleton v-else-if="feed.total === null" key="skeleton" :count="3" />

          <div v-else-if="!feed.list.length" :key="`empty${active}`" v-rise.self class="cm-empty">
            <template v-if="active === FOLLOW">
              <p class="t">还没有关注的创作者</p>
              <p class="s">关注喜欢的创作者，他们发的新帖子会出现在这里</p>
              <button type="button" class="cm-btn m-press" @click="router.push('/search')">去发现创作者</button>
            </template>
            <template v-else-if="active === FAV">
              <p class="t">收藏的帖子会出现在这里</p>
              <p class="s">看到喜欢的帖子，点卡片右下角的书签就能收藏</p>
            </template>
            <p v-else class="t">还没有帖子</p>
          </div>

          <div v-else key="list">
            <PostCard v-for="post in feed.list" :key="`${active}:${genOf(active)}:${post.id}`" :post="post" />
            <ListFoot :feed="feed" />
          </div>
        </Transition>
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
/* 标签指示条（useSlider 滑动），代替公共样式里固定在选中标签下的那一条 */
.cm-tabs { position: relative; }
.cm-tabs .ct-tab { transition: color var(--dur-2) var(--ease-out); }
.cm-tabs .ct-tab.on::after { content: none; }
.cm-bar { bottom: -6px; height: 3px; border-radius: 2px; background: var(--accent); }
.ct-search { transition: background-color var(--dur-1) var(--ease-out); }
.ct-search:active { background: #1e1e1e; }

.cm-empty { padding: 84px 32px 40px; text-align: center; }
.cm-empty .t { color: var(--t1); font-size: 16px; font-weight: 600; line-height: 23px; }
.cm-empty .s { margin-top: 8px; color: var(--t2); font-size: 13px; line-height: 20px; }
.cm-btn { height: 38px; margin-top: 20px; padding: 0 26px; border-radius: 19px; background: var(--accent); color: var(--on-accent); font-size: 14px; font-weight: 700; }

/* 刷新中：压在列表顶部的小胶囊，不推动列表 */
.cm-refresh {
  position: absolute;
  top: calc(var(--safe-t) + 62px);
  left: 50%;
  z-index: 5;
  height: 28px;
  padding: 0 14px;
  border-radius: 14px;
  background: rgba(30, 30, 30, .92);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .4);
  color: var(--t1);
  font-size: 13px;
  line-height: 28px;
  transform: translateX(-50%);
  pointer-events: none;
}
/* 「正在刷新」胶囊：从上面轻轻落下，收起时淡出 */
.cm-pill-enter-active { transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out); }
.cm-pill-leave-active { pointer-events: none; transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in); }
.cm-pill-enter-from, .cm-pill-leave-to { opacity: 0; transform: translate(-50%, -8px); }
</style>
