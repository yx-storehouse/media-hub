<script setup>
import { ref, shallowRef, onMounted } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router'
import Icon from '@/components/Icon.vue'
import Cover from '@/components/Cover.vue'
import VideoCard from '@/components/VideoCard.vue'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import { getHotWords, getCreators, getRecentSearches, searchVideos } from '@/api'

defineOptions({ name: 'SearchView' })

const route = useRoute()
const router = useRouter()
const back = useBack()

const inputEl = ref(null)
const recentEl = ref(null)

/** text in the field; `query` is what the results currently show ('' = suggestions) */
const text = ref('')
const query = ref('')
/** { q, total, list, key }; `key` re-mounts the grid so every search fades in */
const results = shallowRef(null)
let searchSeq = 0

const hotWords = shallowRef([])
const creators = shallowRef([])
const recent = shallowRef([])
/* 换一批 pages; an answer for a page that is no longer current is dropped */
let hotPage = 0
let recentPage = 0
let suggestionsLoaded = false

const queryParam = raw => (typeof raw === 'string' ? raw.trim() : '')

async function loadHotWords() {
  const page = hotPage
  const words = await getHotWords(page)
  if (page === hotPage) hotWords.value = words
}

/** Resolves to false when the answer is stale. */
async function loadRecent() {
  const page = recentPage
  const videos = await getRecentSearches(page)
  if (page !== recentPage) return false
  recent.value = videos
  return true
}

async function loadSuggestions() {
  if (suggestionsLoaded) return
  suggestionsLoaded = true
  loadHotWords()
  loadRecent()
  creators.value = await getCreators()
}

async function showResults(q) {
  query.value = q
  const key = ++searchSeq
  const res = await searchVideos(q)
  if (key !== searchSeq) return
  results.value = { q, total: res.total, list: res.list, key }
}

function showSuggestions() {
  ++searchSeq
  query.value = ''
  results.value = null
  loadSuggestions()
}

/** Show what the URL asks for: ?q=… -> results, otherwise suggestions. */
function applyQuery(q) {
  text.value = q
  if (q) showResults(q)
  else showSuggestions()
}

/* the query lives in the URL (replace, no extra history entry) so refresh / back restore the results */
function syncUrl(q) {
  if (queryParam(route.query.q) === q) return
  router.replace({ query: q ? { q } : {} })
}

function search() {
  const q = text.value.trim()
  if (!q) {
    toast('请输入搜索内容')
    return
  }
  inputEl.value.blur()
  showResults(q)
  syncUrl(q)
}

function searchFor(word) {
  text.value = word
  search()
}

function onEnter(e) {
  // the Enter that confirms an IME composition must not search (Safari reports it as keyCode 229)
  if (e.isComposing || e.keyCode === 229) return
  search()
}

/* 热门创作者：有 id 就进主页；拿不到 id 的（旧数据）还是按名字搜索 */
function openCreator(c) {
  if (c.id != null) router.push(`/creator/${encodeURIComponent(c.id)}`)
  else searchFor(c.name)
}

function clear() {
  text.value = ''
  showSuggestions()
  syncUrl('')
  inputEl.value.focus()
}

function shuffleHot() {
  hotPage++
  loadHotWords()
}

async function shuffleRecent() {
  recentPage++
  // the row may be gone (a search started) by the time the answer arrives
  if (await loadRecent() && recentEl.value) recentEl.value.scrollLeft = 0
}

applyQuery(queryParam(route.query.q))
onBeforeRouteUpdate(to => {
  // our own router.replace() already shows that query; only react to back/forward or external links
  const q = queryParam(to.query.q)
  if (q !== query.value) applyQuery(q)
})

onMounted(() => {
  // only auto-focus with a real pointer: on touch devices it would pop the keyboard over the suggestions
  if (!query.value && window.matchMedia('(hover: hover)').matches) inputEl.value.focus()
})
</script>

<template>
  <div class="page search">
    <div class="sh-hd">
      <button class="sh-back" aria-label="返回" @click="back"><Icon name="chevL" /></button>
      <div class="sh-field">
        <Icon name="search" />
        <input
          ref="inputEl"
          v-model="text"
          type="search"
          enterkeyhint="search"
          autocomplete="off"
          aria-label="搜索"
          placeholder="搜您想搜,看您所想"
          @keydown.enter="onEnter"
        >
        <button v-show="text" class="clr" aria-label="清除" @click="clear"><Icon name="close" /></button>
      </div>
      <button class="sh-btn" @click="search">搜索</button>
    </div>

    <div class="scroll">
      <template v-if="results">
        <div class="res-t">“{{ results.q }}”<span>共 {{ results.total }} 个结果</span></div>
        <div :key="results.key" v-fade-in class="grid g16">
          <VideoCard v-for="v in results.list" :key="v.id" :video="v" />
        </div>
      </template>

      <!-- suggestions; a search whose first results are still loading shows neither -->
      <template v-else-if="!query">
        <div class="sh-st">
          <div class="t">热门搜索</div>
          <button class="pill" @click="shuffleHot">换一批</button>
        </div>
        <div class="hot">
          <button v-for="w in hotWords" :key="w.word" @click="searchFor(w.word)">
            {{ w.word }}<Icon v-if="w.hot" name="flame" class="fl" />
          </button>
        </div>

        <div class="sh-st">
          <div class="t">热门创作者</div>
          <button class="pill r" @click="toast('创作者列表即将上线')">查看全部<Icon name="chevR" /></button>
        </div>
        <div class="stars">
          <div v-for="c in creators" :key="c.id ?? c.name" v-press class="st" :aria-label="c.id != null ? `${c.name} 的主页` : undefined" @click="openCreator(c)">
            <Cover class="av" v-bind="c.avatar" />
            <div class="nm">{{ c.name }}</div>
          </div>
        </div>

        <div class="sh-st">
          <div class="t">近期搜索</div>
          <button class="pill" @click="shuffleRecent">换一批</button>
        </div>
        <div ref="recentEl" class="recent hs">
          <VideoCard v-for="v in recent" :key="v.id" :video="v">
            <template #badge><span class="code">{{ v.code }}</span></template>
          </VideoCard>
        </div>
      </template>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
/* ---- header ---- */
.sh-hd { display: flex; flex: none; align-items: center; gap: 9px; height: 57px; padding: 0 14px; border-bottom: 1px solid var(--line); }
.sh-field {
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
}
.sh-field svg { width: 14px; height: 14px; color: var(--t2); stroke-width: 2.4; }
.sh-field input { flex: 1; min-width: 0; border: 0; background: none; color: var(--t2); font-size: 14px; caret-color: #fff; }
.sh-field input::placeholder { color: #6e6e6e; }
/* the custom .clr button replaces the browser's own clear button of type="search" */
.sh-field input::-webkit-search-cancel-button { display: none; }
.sh-field .clr { position: relative; display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: #3a3a3a; color: var(--bg); }
/* 16px is too small to tap: enlarge the hit area only */
.sh-field .clr::after { content: ''; position: absolute; inset: -10px; }
.sh-field .clr svg { width: 10px; height: 10px; color: var(--bg); stroke-width: 3; }
.sh-btn { flex: none; width: 59px; height: 36px; border-radius: 18px; background: var(--accent); color: var(--on-accent); font-size: 14px; font-weight: 700; }
.sh-btn:active { filter: brightness(.92); }

/* ---- suggestions ---- */
.sh-st { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 14px 0 12px; }
.sh-st .t { display: flex; align-items: center; gap: 6px; color: var(--t2); font-size: 13px; font-weight: 500; }
.sh-st .t::before { content: ''; width: 3px; height: 13px; border-radius: 2px; background: var(--accent); }

.hot { display: grid; grid-template-columns: 189.5px 1fr; margin-bottom: 22px; padding-left: 22px; }
.hot button { display: flex; align-items: center; gap: 7px; height: 29px; color: #fff; font-size: 13px; white-space: nowrap; }
.hot .fl { width: 11px; height: 13px; opacity: .5; }

.stars { display: flex; margin-bottom: 10px; padding: 0 8px; }
.stars .st { flex: 1; text-align: center; cursor: pointer; }
/* transparent (not the Cover placeholder grey) so the round edge anti-aliases against the page */
.stars .av { width: 55px; height: 55px; margin: 0 auto; border-radius: 50%; background-color: transparent; box-shadow: 0 0 0 1px rgba(255, 255, 255, .18); filter: var(--media); }
.stars .nm { margin-top: 6px; color: #fff; font-size: 12px; line-height: 17px; }

.recent { display: flex; gap: 10px; padding: 0 12px; }
.recent .vc { flex: none; width: 148px; }
.recent .code { position: absolute; left: 9px; top: 7px; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .2px; text-shadow: 0 1px 3px rgba(0, 0, 0, .7); }
.recent :deep(.tt) { color: #fff; }

/* ---- results ---- */
.res-t { padding: 14px 14px 10px; font-size: 15px; font-weight: 600; }
.res-t span { margin-left: 6px; color: var(--t2); font-size: 12px; font-weight: 400; }
</style>
