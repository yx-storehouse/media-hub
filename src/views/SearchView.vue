<script>
/*
 * 返回恢复（做法同 CreatorView）：搜索页不常驻（不在 KeepAlive 里），从结果点进视频 / 帖子再返回时，
 * 用离开前存下的结果（两个标签已加载的列表、当前标签、各自的滚动位置）原样放回，不重新请求，也不回到顶部。
 * 只在「返回到这条历史记录」时恢复（history.state.forward 有值）；重新进来是全新的一页。
 */
const snapshots = new Map()
const SNAPSHOT_TTL = 10 * 60 * 1000
const SNAPSHOT_MAX = 6
</script>

<script setup>
import { ref, shallowRef, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router'
import Icon from '@/components/Icon.vue'
import Cover from '@/components/Cover.vue'
import VideoCard from '@/components/VideoCard.vue'
import PostCard from '@/components/community/PostCard.vue'
import PostSkeleton from '@/components/community/PostSkeleton.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import ContentSwap from '@/components/home/ContentSwap'
import { createPagedFeed, feedCount, useScrollMore } from '@/components/search/paging'
import { useRecentSearches } from '@/components/search/recent'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import { getHotWords, getCreators, searchVideos, searchPosts } from '@/api'
import { cameBack, useSlider, under, cover, vRise, fadeIn, pin, scrollBehavior } from '@/components/home/motion'
import { isDesktop } from '@/composables/useDesktop'

/*
 * 搜索页（#/search?q=关键词&type=post）。
 * 没有关键词时是建议页：近期搜索（搜过的关键词，可删除）、热门搜索、热门创作者。
 * 有关键词时是结果页：「视频 / 帖子」两个标签同时搜，标签上是各自的结果数，滚到底自动加载下一页。
 * 关键词和标签记在地址栏，刷新 / 返回还是同样的结果；type 省略 = 视频。
 * 从建议页搜索多一条历史（返回回到建议页），结果页里再换词、切标签不多。
 * 帖子里的话题、社区的搜索框带 type=post 进来，默认显示「帖子」。
 *
 * 桌面布局（≥ 1024px）：搜索框在全局顶栏里（components/desk/DeskSearch.vue，它也只改地址栏 ?q=），这一页自己的搜索栏不显示；
 * 结果页是靠左对齐的「视频 / 帖子」标签 + 公共视频网格 / 帖子一栏，建议页是居中的一栏。地址栏变了这一页照常跟着搜（见文末的 watch）。
 */
defineOptions({ name: 'SearchView' })

const TYPES = [{ key: 'video', label: '视频', unit: '个' }, { key: 'post', label: '帖子', unit: '条' }]
const typeInfo = key => TYPES.find(x => x.key === key)
const typeOf = v => (v === 'post' ? 'post' : 'video')
const otherOf = key => (key === 'video' ? 'post' : 'video')
const queryParam = raw => (typeof raw === 'string' ? raw.trim() : '')
const fmtCount = n => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w' : String(n))

const route = useRoute()
const router = useRouter()
const back = useBack()
/* 按返回回到搜索页：恢复出来的结果、之后取回的建议都不播入场 */
const calm = cameBack()

const inputEl = ref(null)
const scroller = ref(null)

/** 输入框里的字；`query` 是结果页正在显示的关键词（'' = 建议页） */
const text = ref('')
const query = ref('')
const type = ref(typeOf(route.query.type))
/* 每搜一次 +1：重建结果列表，新结果淡入 */
const resultKey = ref(0)

let currentQ = ''
const feeds = {
  video: createPagedFeed(page => searchVideos(currentQ, page)),
  post: createPagedFeed(page => searchPosts(currentQ, page))
}
const checkMore = useScrollMore(scroller, () => (query.value ? feeds[type.value] : null))
/* 各标签自己的滚动位置：切标签时各回各的位置 */
const savedTop = { video: 0, post: 0 }
/*
 * 标签上的数字：换关键词时上一次的数字先留着（上一次的结果也还留着，见 ContentSwap），新结果回来直接变成新的，
 * 不会先消失再出现；回到建议页、这个标签加载失败时才清掉。
 */
const tabCounts = reactive({ video: null, post: null })
watch(() => TYPES.map(t => [feedCount(feeds[t.key]), feeds[t.key].error]), list => {
  TYPES.forEach((t, i) => {
    const [n, error] = list[i]
    if (n !== null || error || !query.value) tabCounts[t.key] = n
  })
}, { immediate: true })

const placeholder = computed(() => (type.value === 'post' && !query.value ? '搜索帖子、话题' : '搜您想搜,看您所想'))

/* ---------- 建议页：近期搜索 / 热门搜索 / 热门创作者 ---------- */

const recent = useRecentSearches()
const recentList = recent.list
/* 近期搜索的编辑状态：点「清除」后每个词带 ×，点一下删掉；「全部清除」清空 */
const editing = ref(false)
watch(recentList, list => { if (!list.length) editing.value = false })

const hotWords = shallowRef([])
/* 每换一批热门词 +1：列表换 key，新的一批错峰浮现 */
const hotGen = ref(0)
/* 一批热门词的个数（和服务端 /api/search/hot 一致）；不够一批说明没有别的可换 */
const HOT_BATCH = 8
const creators = shallowRef([])
/* 换一批的页码；答复回来时页码已经变了就丢掉 */
let hotPage = 0
let hotLoaded = false
let creatorsLoaded = false

async function loadHotWords() {
  const page = hotPage
  hotLoaded = true
  try {
    const words = await getHotWords(page)
    if (page === hotPage) {
      hotWords.value = words
      hotGen.value++
    }
  } catch {
    if (page === hotPage) hotLoaded = false   // 下次显示时再试
  }
}

async function loadCreators() {
  creatorsLoaded = true
  try {
    creators.value = await getCreators()
  } catch {
    creatorsLoaded = false
  }
}

function loadSuggestions() {
  if (!hotLoaded) loadHotWords()
  if (!creatorsLoaded) loadCreators()
  recent.load()
}

/* 没结果时推荐的词：去掉正在搜的这个 */
const hotForEmpty = computed(() => hotWords.value.filter(w => w.word !== query.value))

function shuffleHot() {
  hotPage++
  loadHotWords()
}

function onKeyword(k) {
  if (editing.value) recent.remove(k)
  else searchFor(k)
}

/* 全部清除：近期搜索整块淡出，淡完了下面两块再往上补（.clearing 给补位加一点延迟） */
const clearingRecent = ref(false)
let clearingTimer = 0
function clearRecent() {
  editing.value = false
  clearingRecent.value = true
  clearTimeout(clearingTimer)
  clearingTimer = setTimeout(() => { clearingRecent.value = false }, 800)
  recent.clear()
}
onBeforeUnmount(() => clearTimeout(clearingTimer))

/* 热门创作者：有 id 就进主页；拿不到 id 的（旧数据）还是按名字搜索 */
function openCreator(c) {
  if (c.id != null) router.push(`/creator/${encodeURIComponent(c.id)}`)
  else searchFor(c.name)
}

/* ---------- 结果页 ---------- */

function showResults(q, t = type.value) {
  query.value = currentQ = q
  type.value = t
  editing.value = false
  feeds.video.reset()
  feeds.post.reset()
  savedTop.video = savedTop.post = 0
  resultKey.value++
  if (scroller.value) scroller.value.scrollTop = 0
  // 两个标签一起搜：标签上马上有各自的结果数，切过去也不用再等
  feeds.video.more()
  feeds.post.more()
  // 没结果时要列出热门搜索词
  if (!hotLoaded) loadHotWords()
  recent.note(q)
}

function showSuggestions(t = type.value) {
  query.value = currentQ = ''
  type.value = t
  feeds.video.reset()
  feeds.post.reset()
  if (scroller.value) scroller.value.scrollTop = 0
  loadSuggestions()
}

/** 按地址栏显示：?q=… 结果页，否则建议页 */
function applyQuery(q, t) {
  text.value = q
  if (q) showResults(q, t)
  else showSuggestions(t)
}

/*
 * 关键词和标签记在地址栏，刷新 / 返回能还原。
 * 从建议页搜索时 push（返回回到近期搜索 / 热门搜索）；结果页里换关键词、切标签、清空用 replace，不多一条历史。
 */
function syncUrl(push = false) {
  const q = query.value
  if (queryParam(route.query.q) === q && typeOf(route.query.type) === type.value) return
  const to = { query: { ...(q ? { q } : {}), ...(type.value === 'post' ? { type: 'post' } : {}) } }
  if (push) router.push(to)
  else router.replace(to)
}

function search() {
  const q = text.value.trim()
  if (!q) {
    toast('请输入搜索内容')
    return
  }
  const fromSuggestions = !query.value
  inputEl.value?.blur()
  showResults(q)
  syncUrl(fromSuggestions)
}

function searchFor(word) {
  text.value = word
  search()
}

function onEnter(e) {
  // 输入法确认候选词的那次回车不算搜索（Safari 报 keyCode 229）
  if (e.isComposing || e.keyCode === 229) return
  search()
}

function clear() {
  text.value = ''
  showSuggestions()
  syncUrl()
  inputEl.value?.focus()
}

function selectType(key) {
  const el = scroller.value
  if (key === type.value) {
    // 再点一次当前标签：回到列表开头
    if (el && el.scrollTop > 0) el.scrollTo({ top: 0, behavior: scrollBehavior() })
    return
  }
  if (el) savedTop[type.value] = el.scrollTop
  // 新的一栏从切换的方向淡入一点
  const dir = TYPES.findIndex(t => t.key === key) > TYPES.findIndex(t => t.key === type.value) ? 1 : -1
  type.value = key
  syncUrl()
  nextTick(() => {
    if (el) el.scrollTop = savedTop[key]
    checkMore()
    if (query.value) fadeIn(document.getElementById(`sr-pane-${key}`), { x: dir * 12 })
  })
}

/* 结果标签下的指示条：切标签时滑过去（桌面布局里和标签文字一样宽，同创作者主页的标签） */
const tabRow = ref(null)
const tabBar = ref(null)
const barUnder = under('.sr-tab.on', 20)
const barCover = cover('.sr-tab.on', -6)   // 桌面上标签左右各有 8px 内边距（见样式）：指示条比文字左右各多 2px（同创作者主页、收藏的标签）
useSlider(tabRow, tabBar, box => (isDesktop.value ? barCover : barUnder)(box), { key: () => type.value, deps: () => [query.value, tabCounts.video, tabCounts.post, isDesktop.value] })

/* 方向键在两个标签之间切换（只有选中的标签能 Tab 进入） */
function onTabKey(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const next = otherOf(type.value)
  selectType(next)
  nextTick(() => document.getElementById(`sr-tab-${next}`)?.focus())
}

function onScroll() {
  if (query.value && scroller.value) savedTop[type.value] = scroller.value.scrollTop
}

/* ---------- 返回恢复 ---------- */

let snapKey = window.history.state?.position ?? ''

function saveSnapshot() {
  if (!query.value) return
  const el = scroller.value
  // 桌面布局不在这里重新读：进播放页时左侧导航先换了宽度（收成图标栏）、这一页还没钉住，这一刻读排版会让浏览器的
  // 滚动锚定把 scrollTop 改掉（网格列数变了）；滚动时 onScroll 已经记下了准确的位置
  if (!isDesktop.value && el && el.isConnected && el.clientHeight) savedTop[type.value] = el.scrollTop
  snapshots.delete(snapKey)
  snapshots.set(snapKey, {
    at: Date.now(),
    q: query.value,
    video: feeds.video.snapshot(),
    post: feeds.post.snapshot(),
    top: { ...savedTop }
  })
  while (snapshots.size > SNAPSHOT_MAX) snapshots.delete(snapshots.keys().next().value)
}

function restoreSnapshot(q, t) {
  const s = window.history.state?.forward ? snapshots.get(snapKey) : null
  snapshots.delete(snapKey)
  if (!s || s.q !== q || Date.now() - s.at > SNAPSHOT_TTL) return false
  text.value = query.value = currentQ = q
  type.value = t
  editing.value = false
  feeds.video.restore(s.video)
  feeds.post.restore(s.post)
  // 离开时第一页还没回来的列表：重新取
  for (const f of Object.values(feeds)) if (f.total === null) f.more()
  Object.assign(savedTop, s.top)
  return true
}

function scrollToSaved() {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = savedTop[type.value]
    checkMore()
  })
}

const startQ = queryParam(route.query.q)
const restored = !!startQ && restoreSnapshot(startQ, typeOf(route.query.type))
if (!restored) applyQuery(startQ, typeOf(route.query.type))

onMounted(() => {
  if (restored) {
    scrollToSaved()
    return
  }
  // 只在有鼠标的设备上自动聚焦：触屏上会弹出键盘挡住建议。桌面布局里这一页的搜索栏不显示（用顶栏的搜索框，按「/」聚焦）
  if (!query.value && !isDesktop.value && window.matchMedia('(hover: hover)').matches) inputEl.value?.focus()
})
onBeforeUnmount(saveSnapshot)

/* 同一页里换了关键词（比如结果里帖子的话题）：先给当前结果存一份，按返回能原样回来 */
onBeforeRouteUpdate(to => {
  if (queryParam(to.query.q) !== query.value) saveSnapshot()
})
/* 地址栏变了（返回 / 前进、外部链接）；自己 replace 的地址和页面一致，不会重新搜索 */
watch(() => route.fullPath, () => {
  if (route.name !== 'search') return   // 正在离开搜索页
  snapKey = window.history.state?.position ?? ''
  const q = queryParam(route.query.q)
  const t = typeOf(route.query.type)
  if (q !== query.value) {
    if (q && restoreSnapshot(q, t)) scrollToSaved()
    else applyQuery(q, t)
  } else if (t !== type.value) {
    if (q) selectType(t)
    else type.value = t
  }
})
</script>

<template>
  <div class="page search" :class="{ 'has-res': query }">
    <!-- m-only：桌面布局里用顶栏的搜索框，这一栏不显示 -->
    <div class="sh-hd m-only">
      <button type="button" class="sh-back" aria-label="返回" @click="back"><Icon name="chevL" /></button>
      <div class="sh-field">
        <Icon name="search" />
        <input
          ref="inputEl"
          v-model="text"
          type="search"
          enterkeyhint="search"
          autocomplete="off"
          aria-label="搜索"
          :placeholder="placeholder"
          @keydown.enter="onEnter"
        >
        <Transition name="sh-clr">
          <button v-show="text" type="button" class="clr" aria-label="清除" @click="clear"><Icon name="close" /></button>
        </Transition>
      </div>
      <button type="button" class="sh-btn m-press" @click="search">搜索</button>
    </div>

    <!-- 结果页：视频 / 帖子 -->
    <div v-if="query" ref="tabRow" class="sr-tabs" role="tablist" aria-label="搜索结果">
      <span ref="tabBar" class="m-bar sr-bar" aria-hidden="true" />
      <button
        v-for="t in TYPES"
        :id="`sr-tab-${t.key}`"
        :key="t.key"
        type="button"
        role="tab"
        class="sr-tab"
        :class="{ on: type === t.key }"
        :aria-selected="type === t.key"
        :aria-controls="`sr-pane-${t.key}`"
        :tabindex="type === t.key ? 0 : -1"
        @click="selectType(t.key)"
        @keydown="onTabKey"
      >
        {{ t.label }}<span v-if="tabCounts[t.key] !== null" class="n">{{ fmtCount(tabCounts[t.key]) }}</span>
      </button>
    </div>

    <div ref="scroller" class="scroll" @scroll.passive="onScroll">
      <template v-if="query">
        <section
          v-for="t in TYPES"
          v-show="type === t.key"
          :id="`sr-pane-${t.key}`"
          :key="t.key"
          class="sr-pane"
          role="tabpanel"
          :aria-labelledby="`sr-tab-${t.key}`"
        >
          <!--
            第一页还没回来：骨架；第一页失败：重试。骨架原地淡出，新结果错峰浮现；
            换关键词时上一次的结果留着等新的，快的直接换成新结果，慢了（250ms）才淡入骨架
          -->
          <ContentSwap :pending="feeds[t.key].total === null && !feeds[t.key].error">
            <div v-if="feeds[t.key].total === null && feeds[t.key].error" class="empty">
              加载失败，请检查网络
              <button type="button" class="retry" @click="feeds[t.key].more()">重试</button>
            </div>
            <!-- 桌面布局一行 4–6 张：12 张骨架铺满一屏，不会只剩半行 -->
            <SkeletonGrid v-else-if="feeds[t.key].total === null && t.key === 'video'" :count="isDesktop ? 12 : 6" gap="g16" />
            <!-- 帖子骨架：和社区、创作者主页同一个（桌面布局里也是一张张圆角卡片） -->
            <PostSkeleton v-else-if="feeds[t.key].total === null" class="sr-posts" :count="3" />

            <div v-else-if="!feeds[t.key].list.length" :key="`none${resultKey}`" v-rise.self class="sr-none">
              <!-- 没有结果：换个词，或者看看另一个标签 -->
              <p class="t1">没有找到相关{{ t.label }}</p>
              <p class="t2">换个关键词试试</p>
              <button
                v-if="feedCount(feeds[otherOf(t.key)]) > 0"
                type="button"
                class="sr-alt"
                @click="selectType(otherOf(t.key))"
              >
                看看相关{{ typeInfo(otherOf(t.key)).label }} · {{ fmtCount(feedCount(feeds[otherOf(t.key)])) }} {{ typeInfo(otherOf(t.key)).unit }}<Icon name="chevR" />
              </button>
              <template v-if="hotForEmpty.length">
                <div class="sr-hot-t">大家都在搜</div>
                <div class="kws">
                  <button v-for="w in hotForEmpty" :key="w.word" type="button" class="kw" @click="searchFor(w.word)"><span>{{ w.word }}</span></button>
                </div>
              </template>
            </div>

            <div v-else :key="`res${resultKey}`">
              <div v-if="t.key === 'video'" v-rise class="grid g16 sr-grid">
                <VideoCard v-for="v in feeds.video.list" :key="v.id" :video="v" />
              </div>
              <!-- sr-posts：桌面布局里帖子是一栏（最宽 --desk-col），左边和标签对齐；手机上没有样式 -->
              <div v-else class="sr-posts">
                <PostCard v-for="p in feeds.post.list" :key="p.id" :post="p" />
              </div>
              <ListFoot :feed="feeds[t.key]" :class="{ 'sr-pfoot': t.key === 'post' }" />
            </div>
          </ContentSwap>
        </section>
      </template>

      <!--
        建议页：三块各自出现时错峰浮现；「全部清除」时近期搜索的词依次淡出，下面的两块平滑往上补位；
        编辑时删掉一个词，后面的词平滑挪过来
      -->
      <!-- desk-col：桌面布局里建议页是居中的一栏（手机上这个类什么都不做） -->
      <TransitionGroup v-else tag="div" name="sh-blk" class="sh-sug desk-col" :class="{ clearing: clearingRecent }" @before-leave="pin">
        <section v-if="recentList.length" key="recent" class="sh-blk">
          <div class="sh-st">
            <div class="t">近期搜索</div>
            <button v-if="!editing" type="button" class="pill" @click="editing = true">清除</button>
            <div v-else class="sh-ops">
              <button type="button" class="pill" @click="clearRecent">全部清除</button>
              <button type="button" class="pill" @click="editing = false">完成</button>
            </div>
          </div>
          <TransitionGroup v-rise="!calm" tag="div" name="sh-kw" class="kws recent" :class="{ editing }" @before-leave="pin">
            <button
              v-for="(k, i) in recentList"
              :key="k"
              type="button"
              class="kw"
              :style="{ '--i': Math.min(i, 7) }"
              :aria-label="editing ? `删除 ${k}` : undefined"
              @click="onKeyword(k)"
            >
              <span>{{ k }}</span><Icon v-if="editing" name="close" class="x" />
            </button>
          </TransitionGroup>
        </section>

        <!-- 热门搜索：服务端只给搜得到东西的词；一个都没有就整块不显示，不够一批时没有「换一批」 -->
        <section v-if="hotWords.length" key="hot" class="sh-blk">
          <div class="sh-st">
            <div class="t">热门搜索</div>
            <button v-if="hotWords.length >= HOT_BATCH" type="button" class="pill" @click="shuffleHot">换一批</button>
          </div>
          <div :key="hotGen" v-rise="!calm" class="hot">
            <button v-for="w in hotWords" :key="w.word" type="button" @click="searchFor(w.word)">
              {{ w.word }}<Icon v-if="w.hot" name="flame" class="fl" />
            </button>
          </div>
        </section>

        <section key="stars" class="sh-blk">
          <div class="sh-st">
            <div class="t">热门创作者</div>
            <button type="button" class="pill r" @click="toast('创作者列表即将上线')">查看全部<Icon name="chevR" /></button>
          </div>
          <div v-if="creators.length" v-rise="!calm" class="stars">
            <div v-for="c in creators" :key="c.id ?? c.name" v-press class="st" :aria-label="c.id != null ? `${c.name} 的主页` : undefined" @click="openCreator(c)">
              <Cover class="av" v-bind="c.avatar" />
              <div class="nm">{{ c.name }}</div>
            </div>
          </div>
        </section>
      </TransitionGroup>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
/* ---- header ---- */
.sh-hd { display: flex; flex: none; align-items: center; gap: 9px; height: 57px; padding: 0 14px; border-bottom: 1px solid var(--line); }
/* 结果页下面紧跟着标签栏（它自己有分隔线） */
.has-res .sh-hd { border-bottom-color: transparent; }
.sh-field {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  gap: 9px;
  min-width: 0;
  height: 36px;
  padding: 0 14px;
  border-radius: 18px;
  background: var(--field);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .02);
  transition: background-color var(--dur-2) var(--ease-out);
}
/* 聚焦：一圈细边从里往外展开、底色微亮，放大镜变亮 */
.sh-field::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .22);
  opacity: 0;
  transform: scale(.96);
  transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-3) var(--ease-out);
  pointer-events: none;
}
.sh-field:focus-within { background: #1f1f1f; }
.sh-field:focus-within::before { opacity: 1; transform: none; }
.sh-field svg { width: 14px; height: 14px; color: var(--t2); stroke-width: 2.4; transition: color var(--dur-2) var(--ease-out); }
.sh-field:focus-within > svg { color: var(--t1); }
/* 输入的字用主文字色，和灰色的占位文字分得开；16px 让 iOS 聚焦时不自动放大页面 */
.sh-field input { flex: 1; min-width: 0; height: 100%; border: 0; background: none; color: var(--t1); font-size: 16px; caret-color: #fff; }
.sh-field input::placeholder { color: #6e6e6e; }
/* the custom .clr button replaces the browser's own clear button of type="search" */
.sh-field input::-webkit-search-cancel-button { display: none; }
.sh-field .clr { position: relative; display: grid; flex: none; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: #3a3a3a; color: var(--bg); }
/* 16px is too small to tap: enlarge the hit area only */
.sh-field .clr::after { content: ''; position: absolute; inset: -10px; }
.sh-field .clr svg { width: 10px; height: 10px; color: var(--bg); stroke-width: 3; }
/* 清除键：有字时弹出来，清空时缩回去 */
.sh-clr-enter-active { transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-spring); }
.sh-clr-leave-active { transition: opacity var(--dur-1) var(--ease-in), transform var(--dur-1) var(--ease-in); }
.sh-clr-enter-from, .sh-clr-leave-to { opacity: 0; transform: scale(.5); }
.sh-btn { flex: none; width: 59px; height: 36px; border-radius: 18px; background: var(--accent); color: var(--on-accent); font-size: 14px; font-weight: 700; }

/* ---- suggestions ---- */
/* 三块：离场时钉在原处淡出（pin），淡完了下面的再平滑补位（不和淡出的字叠在一起） */
.sh-sug { position: relative; }
.sh-blk-move { transition: transform var(--dur-3) var(--ease-out); }
.sh-sug.clearing .sh-blk-move { transition-delay: var(--dur-2); }
.sh-blk-leave-active { position: absolute; pointer-events: none; transition: opacity var(--dur-2) var(--ease-in); }
.sh-blk-leave-to { opacity: 0; }
/* 整块离场时里面的词依次淡出、缩一点 */
.sh-blk-leave-active .kw { transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in); transition-delay: calc(var(--i, 0) * var(--stagger) / 2); }
.sh-blk-leave-to .kw { opacity: 0; transform: scale(.9); }
/* 编辑时删掉一个词：它原地缩小淡出，后面的词挪过来 */
.kws.recent { position: relative; }
/* 写成两级选择器：要压过下面 .kw 自己的 transition（按压变色） */
.kws .sh-kw-move { transition: transform var(--dur-3) var(--ease-out); }
.kws .sh-kw-leave-active { position: absolute; pointer-events: none; transition: opacity var(--dur-2) var(--ease-in), transform var(--dur-2) var(--ease-in); }
.kws .sh-kw-leave-to { opacity: 0; transform: scale(.8); }
.sh-st { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 14px 0 12px; }
.sh-st .t { display: flex; align-items: center; gap: 6px; color: var(--t2); font-size: 13px; font-weight: 500; }
.sh-st .t::before { content: ''; width: 3px; height: 13px; border-radius: 2px; background: var(--accent); }
.sh-ops { display: flex; gap: 14px; }

/* 关键词标签（近期搜索、没结果时的「大家都在搜」） */
.kws { display: flex; flex-wrap: wrap; gap: 9px 8px; padding: 0 14px; }
.kws.recent { margin-bottom: 14px; }
.kw {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  height: 30px;
  padding: 0 13px;
  border-radius: 15px;
  background: var(--chip);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .04);
  color: #e6e6e6;
  font-size: 13px;
}
.kw span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kw { transition: background-color var(--dur-1) var(--ease-out); }
.kw:active { background: #222; }
.kw .x { flex: none; width: 11px; height: 11px; margin-right: -3px; color: var(--t2); stroke-width: 2.8; }
.editing .kw { padding-right: 11px; }

.hot { display: grid; grid-template-columns: 189.5px 1fr; margin-bottom: 22px; padding-left: 22px; }
.hot button { display: flex; align-items: center; gap: 7px; height: 29px; color: #fff; font-size: 13px; white-space: nowrap; transition: opacity var(--dur-1) var(--ease-out); }
.hot button:active { opacity: .55; }
.hot .fl { width: 11px; height: 13px; opacity: .5; }

.stars { display: flex; margin-bottom: 10px; padding: 0 8px; }
.stars .st { flex: 1; text-align: center; cursor: pointer; }
/* transparent (not the Cover placeholder grey) so the round edge anti-aliases against the page */
.stars .av { width: 55px; height: 55px; margin: 0 auto; border-radius: 50%; background-color: transparent; box-shadow: 0 0 0 1px rgba(255, 255, 255, .18); filter: var(--media); }
.stars .nm { margin-top: 6px; color: #fff; font-size: 12px; line-height: 17px; }

/* ---- results ---- */
.sr-tabs { position: relative; display: flex; flex: none; gap: 28px; height: 42px; padding: 0 18px; border-bottom: 1px solid var(--line); }
.sr-tab { position: relative; display: flex; align-items: center; gap: 4px; height: 100%; color: var(--t2); font-size: 15px; font-weight: 500; transition: color var(--dur-2) var(--ease-out); }
.sr-tab .n { font-size: 12px; font-weight: 400; font-variant-numeric: tabular-nums; }
.sr-tab.on { color: var(--t1); font-weight: 600; }
/* 指示条（useSlider）：切标签时滑过去 */
.sr-bar { bottom: 0; height: 3px; border-radius: 2px; background: var(--accent); }
.sr-grid, .sr-pane .sk-grid { padding-top: 12px; }

.sr-none { padding: 56px 0 8px; text-align: center; }
.sr-none .t1 { color: var(--t1); font-size: 15px; font-weight: 500; }
.sr-none .t2 { margin-top: 6px; color: var(--t2); font-size: 13px; }
.sr-alt { display: inline-flex; align-items: center; gap: 2px; height: 32px; margin-top: 18px; padding: 0 12px 0 16px; border-radius: 16px; background: var(--chip); color: var(--t1); font-size: 13px; }
.sr-alt svg { width: 12px; height: 12px; stroke-width: 2.6; }
.sr-hot-t { margin: 40px 0 12px; color: var(--t2); font-size: 12px; }
.sr-none .kws { justify-content: center; }

/*
 * ---- 桌面布局（≥ 1024px）----
 * 搜索栏（.sh-hd）由 .m-only 藏起来，搜索框在全局顶栏里。
 * 结果页：标签栏靠左、和网格内容的左边缘对齐（至少 --desk-pad，宽屏时跟着居中的 --desk-max 内容走，同 BackHeader）；
 * 帖子是一栏（最宽 --desk-col，卡片样式在 PostCard 里），也靠左和标签对齐。
 * 建议页：居中的一栏（.desk-col），分区标题 16px，关键词、热门词、创作者都放大到鼠标好点的尺寸。
 */
@media (min-width: 1024px) {
  /* 底边细线只画在内容宽度里；48px 高、文字间距 32px、选中 600（和创作者主页、收藏的标签栏同一个规格） */
  .sr-tabs {
    gap: 32px;
    height: 48px;
    padding: 0 max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad)));
    border-bottom: 0;
    background: linear-gradient(var(--line), var(--line)) 0 100% / 100% 1px no-repeat content-box;
  }
  /* 左右 8px 内边距再用负外边距收回：文字位置不变，键盘焦点框不贴着字 */
  .sr-tab { gap: 6px; margin: 0 -8px; padding: 0 8px; font-size: 16px; }
  .sr-tab .n { font-size: 13px; font-weight: 500; }
  .sr-tab:focus-visible { outline-offset: -4px; }
  .sr-grid, .sr-pane .sk-grid { padding-top: 24px; }
  .sr-posts, .sr-pfoot {
    max-width: var(--desk-col);
    margin-left: max(var(--desk-pad), calc((100% - var(--desk-max)) / 2 + var(--desk-pad)));
  }
  .sr-posts { padding-top: 24px; }
  .sr-none { padding: 96px 0 8px; }
  .sr-none .t1 { font-size: 16px; }
  .sr-none .t2 { margin-top: 8px; font-size: 14px; }
  .sr-alt { height: 36px; margin-top: 20px; padding: 0 14px 0 18px; border-radius: 18px; font-size: 14px; }
  .sr-hot-t { margin: 48px 0 14px; font-size: 13px; }

  .sh-sug { padding-top: 16px; padding-bottom: 24px; }
  .sh-st { height: 56px; padding: 0; }
  .sh-st .t { gap: 8px; color: var(--t1); font-size: 16px; font-weight: 600; line-height: 24px; }
  .sh-st .t::before { height: 16px; }
  /*
   * 分区标题右边的「清除」「换一批」「查看全部 ›」：和首页分区标题行一样是文字按钮（平时没有底色，鼠标移上去才有），
   * 最右边那个往右挪出内边距，文字和这一栏的右边缘对齐（同下面热门搜索整行往两边伸出 12px）
   */
  .sh-ops { gap: 4px; }
  .sh-st .pill { height: 32px; padding: 0 12px; border-radius: 16px; background: transparent; box-shadow: none; font-size: 13px; font-weight: 500; }
  .sh-st > .pill, .sh-ops > .pill:last-child { margin-right: -12px; }
  .sh-st .pill.r { gap: 2px; margin-right: -8px; padding: 0 8px 0 12px; }
  .sh-st .pill svg { width: 14px; height: 14px; }
  .sh-st .pill::after { inset: -4px 0; }

  .kws { gap: 10px; padding: 0; }
  .kws.recent { margin-bottom: 28px; }
  .kw { height: 34px; padding: 0 16px; border-radius: 17px; font-size: 14px; }
  .editing .kw { padding-right: 13px; }
  .kw .x { width: 12px; height: 12px; }

  /* 热门搜索：两列，每一项一整行可点（鼠标移上去整行变亮）；整块往左右各伸出 12px，字和标题对齐 */
  .hot { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 24px; margin: 0 -12px 28px; padding-left: 0; }
  .hot button { gap: 8px; min-width: 0; height: 40px; padding: 0 12px; border-radius: 8px; font-size: 14px; }
  .hot .fl { width: 12px; height: 14px; }

  .stars { margin: 4px -8px 16px; padding: 0; }
  .stars .st { padding: 12px 0 10px; border-radius: 12px; }
  .stars .av { width: 72px; height: 72px; }
  .stars .nm { margin-top: 10px; overflow: hidden; color: var(--t3); font-size: 14px; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
}
@media (min-width: 1024px) and (hover: hover) {
  .sr-tab:not(.on):hover { color: var(--t3); }
  .sh-st .pill:hover { background: #1f1f1f; color: var(--t3); }
  .kw:hover { background: #1f1f1f; }
  .hot button { transition: background-color var(--dur-2) var(--ease-out), opacity var(--dur-1) var(--ease-out); }
  .hot button:hover { background: var(--chip); }
  .stars .st { transition: background-color var(--dur-2) var(--ease-out); }
  .stars .st:hover { background: var(--chip); }
  .stars .st:hover .nm { color: var(--t1); }
  .sr-alt { transition: background-color var(--dur-2) var(--ease-out); }
  .sr-alt:hover { background: #1f1f1f; }
}
</style>
