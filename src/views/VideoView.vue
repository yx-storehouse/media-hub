<script setup>
import { ref, shallowRef, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router'
import { getVideo, getRelatedVideos, toggleVideoLike, toggleVideoDislike, toggleVideoFav, addHistory } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import { share } from '@/composables/useShare'
import { formatCount, formatDate } from '@/utils/format'
import Icon from '@/components/Icon.vue'
import VideoPlayer from '@/components/video/VideoPlayer.vue'
import RelatedVideo from '@/components/video/RelatedVideo.vue'
import { getResume, setResume } from '@/components/video/resume'

defineOptions({ name: 'VideoView' })

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const back = useBack()

const video = shallowRef(null)
const related = shallowRef([])
/* 加载失败：message 给用户看；retry 只在可能是网络问题时显示（视频不存在重试也没用） */
const failed = ref(null)
const scroller = ref(null)
/* 换一批：batch 递增；relatedKey 让新的一批重新淡入 */
const batch = ref(0)
const relatedKey = ref(0)
const spinning = ref(false)
const tagsOpen = ref(false)

const tags = computed(() => (video.value?.tags || []).map(t => String(t).replace(/^#/, '')))

/* ---------- 加载 ---------- */

let loadSeq = 0
async function load(id) {
  const token = ++loadSeq
  failed.value = null
  tagsOpen.value = false
  batch.value = 0
  // 换成另一个视频：先撤掉旧的（播放器立即停下、操作栏不再作用于旧视频），加载期间显示占位
  if (String(video.value?.id) !== String(id)) {
    video.value = null
    related.value = []
  }
  try {
    const [v, list] = await Promise.all([getVideo(id), getRelatedVideos(id, { batch: 0 })])
    if (token !== loadSeq) return
    video.value = v
    related.value = list
    relatedKey.value++
    if (scroller.value) scroller.value.scrollTop = 0
    await nextTick()
    measureTags()
  } catch (e) {
    if (token !== loadSeq) return
    const missing = e?.status === 404 || (e?.status >= 400 && e?.status < 500 && e?.status !== 401)
    failed.value = {
      message: missing ? '视频不存在或已下架' : e?.message || '加载失败，请检查网络',
      retry: !missing
    }
  }
}

async function shuffle() {
  const id = video.value?.id
  if (id == null) return
  const b = ++batch.value
  spinning.value = true
  try {
    const list = await getRelatedVideos(id, { batch: b })
    if (b !== batch.value || id !== video.value?.id) return
    related.value = list
    relatedKey.value++
  } catch {
    toast('加载失败，请稍后重试')
  }
}

load(route.params.id)
onBeforeRouteUpdate(to => {
  if (to.params.id !== route.params.id) load(to.params.id)
})

/* ---------- 观看记录（登录后才记） ---------- */

/* 播放器自己报 id：换视频时旧播放器卸载那一刻 video.value 已经是新视频了 */
function onStarted(id) {
  if (auth.loggedIn) addHistory(id, 0).catch(() => {})
}
function onLeave({ id, sec, len }) {
  setResume(id, sec, len)
  if (auth.loggedIn && sec > 3) addHistory(id, Math.floor(sec), { progressOnly: true }).catch(() => {})
}

/* ---------- 赞 / 不喜欢 / 收藏：乐观更新 → 一次请求（服务端保证赞和不喜欢互斥）→ 以返回为准 / 失败回滚 ---------- */

const TOGGLE = { like: toggleVideoLike, dislike: toggleVideoDislike, fav: toggleVideoFav }
const FIELD = { like: 'liked', dislike: 'disliked', fav: 'faved' }
const COUNT = { like: 'likeCount', fav: 'favCount' }
const pending = new Set()

function patch(kind, on, into) {
  into[FIELD[kind]] = on
  if (COUNT[kind]) into[COUNT[kind]] = Math.max(0, (into[COUNT[kind]] ?? 0) + (on ? 1 : -1))
}

async function interact(kind) {
  const v = video.value
  if (!v || pending.size) return
  if (!auth.requireLogin(route.fullPath)) return // 未登录：弹登录框

  const next = !v[FIELD[kind]]
  // 赞和不喜欢互斥：点亮一个时，另一个若亮着就一起熄掉
  const other = next && kind === 'like' && v.disliked ? 'dislike' : next && kind === 'dislike' && v.liked ? 'like' : null
  const updated = { ...v }
  patch(kind, next, updated)
  if (other) patch(other, false, updated)
  video.value = updated

  pending.add(kind)
  try {
    const res = await TOGGLE[kind](v.id, { on: next })
    // 服务端返回了最新状态就以它为准（多端操作、重复点击时不会和服务端对不上）
    if (res && video.value?.id === v.id) {
      const sync = {}
      if (typeof res.liked === 'boolean') sync.liked = res.liked
      if (typeof res.disliked === 'boolean') sync.disliked = res.disliked
      if (typeof res.likeCount === 'number') sync.likeCount = res.likeCount
      if (kind === 'fav' && typeof res.active === 'boolean') sync.faved = res.active
      if (Object.keys(sync).length) video.value = { ...video.value, ...sync }
    }
    if (kind === 'fav') toast(next ? '已收藏' : '已取消收藏')
  } catch {
    if (video.value?.id === v.id) video.value = { ...video.value, ...pick(v) } // 回滚
    toast('操作失败，请稍后重试')
  } finally {
    pending.delete(kind)
  }
}
const pick = v => ({ liked: v.liked, disliked: v.disliked, faved: v.faved, likeCount: v.likeCount, favCount: v.favCount })

const searchTag = t => router.push({ path: '/search', query: { q: t } })

/* 「展开」只在标签一行放不下时出现 */
const tagList = ref(null)
const canExpand = ref(false)
function measureTags() {
  const el = tagList.value
  if (!el || tagsOpen.value) return
  canExpand.value = el.scrollWidth > el.clientWidth + 1
}
let ro = null
onMounted(() => {
  if ('ResizeObserver' in window) {
    ro = new ResizeObserver(() => measureTags())
    if (scroller.value) ro.observe(scroller.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div class="page video">
    <VideoPlayer
      v-if="video"
      :key="video.id"
      :video="video"
      :start="getResume(video.id)"
      @back="back"
      @started="onStarted"
      @leave="onLeave"
    />
    <!-- 加载中 / 失败时的占位：保留返回键，用户随时能离开 -->
    <div v-else class="player-ph">
      <button type="button" class="ph-back" aria-label="返回" @click="back"><Icon name="chevL" /></button>
    </div>

    <div ref="scroller" class="scroll">
      <div v-if="failed" class="empty">
        {{ failed.message }}
        <button v-if="failed.retry" type="button" class="retry" @click="load(route.params.id)">重试</button>
      </div>

      <template v-else-if="video">
        <section class="info">
          <h1 class="v-title">{{ video.title }}</h1>
          <div class="v-meta">
            <span>发行: {{ formatDate(video.publishedAt) }}</span>
            <span>播放: {{ formatCount(video.playCount) }}次</span>
            <span>收藏: {{ formatCount(video.favCount) }}次</span>
          </div>

          <div v-if="tags.length" class="v-tags" :class="{ open: tagsOpen }">
            <span class="lb">标签:</span>
            <div ref="tagList" class="list">
              <button v-for="t in tags" :key="t" type="button" class="tag" @click="searchTag(t)">{{ t }}</button>
            </div>
            <button v-if="canExpand || tagsOpen" type="button" class="more" :aria-expanded="tagsOpen" @click="tagsOpen = !tagsOpen">
              {{ tagsOpen ? '收起' : '展开' }}<Icon name="chevD" />
            </button>
          </div>

          <RouterLink v-if="video.rank" class="rank" to="/home/recommend">
            <Icon name="flame" class="fl" />
            <b>热门榜 No.{{ video.rank }}</b>
            <span>查看更多<Icon name="chevR" /></span>
          </RouterLink>
        </section>

        <section class="related">
          <div class="r-hd">
            <h2 class="r-t">相似推荐</h2>
            <button type="button" class="r-more" :class="{ spin: spinning }" @click="shuffle" @animationend="spinning = false">
              <Icon name="refresh" />换一批
            </button>
          </div>
          <div :key="relatedKey" v-fade-in="relatedKey > 1" class="r-list">
            <RelatedVideo v-for="v in related" :key="v.id" :video="v" />
          </div>
        </section>
        <div class="pad-b" />
      </template>
    </div>

    <nav v-if="video" class="acts" aria-label="视频操作">
      <button type="button" :class="{ on: video.liked }" :aria-pressed="!!video.liked" :aria-label="`点赞 ${video.likeCount ?? 0}`" @click="interact('like')">
        <Icon name="thumbUp" /><span>{{ formatCount(video.likeCount) }}</span>
      </button>
      <button type="button" :class="{ on: video.disliked }" :aria-pressed="!!video.disliked" @click="interact('dislike')">
        <Icon name="thumbDown" /><span>不喜欢</span>
      </button>
      <button type="button" :class="{ on: video.faved }" :aria-pressed="!!video.faved" :aria-label="`收藏 ${video.favCount ?? 0}`" @click="interact('fav')">
        <Icon name="heart" /><span>{{ formatCount(video.favCount) }}</span>
      </button>
      <button type="button" @click="share({ title: video.title })">
        <Icon name="shareNodes" /><span>分享</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.page.video { background: var(--bg); }

.player-ph { position: relative; flex: none; width: 100%; aspect-ratio: 16 / 9; background: #000; }
.ph-back { position: absolute; left: 6px; top: 6px; display: grid; place-items: center; width: 40px; height: 40px; color: #fff; }
.ph-back svg { width: 24px; height: 24px; stroke-width: 2.6; }

/* ---------- 标题 / 数据 / 标签 ---------- */
.info { padding: 14px 14px 0; }
.v-title { font-size: 17px; font-weight: 700; line-height: 25px; word-break: break-all; }
.v-meta { display: grid; grid-template-columns: repeat(3, 1fr); column-gap: 8px; margin-top: 8px; color: var(--t2); font-size: 13px; line-height: 20px; }
.v-meta span { white-space: nowrap; }

.v-tags { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.v-tags .lb { flex: none; color: var(--t2); font-size: 13px; }
.v-tags .list { display: flex; flex: 1; gap: 7px; min-width: 0; overflow: hidden; }
.v-tags.open { align-items: flex-start; }
.v-tags.open .lb { line-height: 24px; }
.v-tags.open .list { flex-wrap: wrap; }
.tag { flex: none; height: 24px; padding: 0 11px; border-radius: 12px; background: var(--chip); color: #b5b5b5; font-size: 12px; }
.tag:active { background: #222; }
.more { display: flex; flex: none; align-items: center; gap: 2px; height: 24px; color: var(--t1); font-size: 13px; font-weight: 500; }
.more svg { width: 13px; height: 13px; stroke-width: 2.6; transition: transform .2s; }
.v-tags.open .more svg { transform: rotate(180deg); }

/* 热门榜 */
.rank {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 40px;
  margin-top: 14px;
  padding: 0 12px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  background: linear-gradient(90deg, #191919, #111);
}
.rank .fl { width: 14px; height: 16px; color: var(--t1); }
.rank b { color: var(--t1); font-size: 14px; font-weight: 700; }
.rank span { display: flex; align-items: center; margin-left: auto; color: var(--t2); font-size: 13px; }
.rank span svg { width: 13px; height: 13px; stroke-width: 2.6; }

/* ---------- 相似推荐 ---------- */
.related { margin-top: 16px; padding: 4px 0 6px; border-radius: 14px 14px 0 0; background: var(--panel); }
.r-hd { display: flex; align-items: center; justify-content: space-between; height: 48px; padding: 0 14px 0 12px; }
.r-t { display: flex; align-items: center; gap: 6px; font-size: 16px; font-weight: 600; }
.r-t::before { content: ''; width: 3px; height: 16px; border-radius: 2px; background: var(--accent); }
.r-more { position: relative; display: flex; align-items: center; gap: 4px; color: var(--t1); font-size: 13px; }
.r-more svg { width: 13px; height: 13px; }
.r-more::after { content: ''; position: absolute; inset: -12px -10px; }
.r-list { display: flex; flex-direction: column; gap: 14px; }

/* ---------- 底部操作栏 ---------- */
.acts {
  display: grid;
  flex: none;
  grid-template-columns: repeat(4, 1fr);
  height: calc(56px + var(--safe-b));
  padding-bottom: var(--safe-b);
  border-top: 1px solid var(--line);
  background: var(--bg);
}
.acts button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: var(--t2); font-size: 11px; font-variant-numeric: tabular-nums; }
.acts svg { width: 23px; height: 23px; stroke-width: 1.8; }
.acts .on { color: var(--t1); }
.acts .on svg { fill: currentColor; }
</style>
