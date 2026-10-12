<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router'
import {
  getVideo, getRelatedVideos, getCreator, toggleVideoLike, toggleVideoDislike, toggleVideoFav, toggleFollow, addHistory, isDemoId
} from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import { share } from '@/composables/useShare'
import { formatCount, formatDate } from '@/utils/format'
import Icon from '@/components/Icon.vue'
import Cover from '@/components/Cover.vue'
import VideoPlayer from '@/components/video/VideoPlayer.vue'
import RelatedVideo from '@/components/video/RelatedVideo.vue'
import { pickResume, setResume } from '@/components/video/resume'
import { peekVideo, rememberVideo } from '@/components/video/preview'
import { parseList, nextInList } from '@/components/video/playlist'

/*
 * 播放页：播放器 → 标题、数据、作者（关注）、简介、热门榜 / 所属专题、标签 → 相似推荐，底部赞 / 不喜欢 / 收藏 / 分享。
 * - 续播：本机和服务端记录里取更新的一份（resume.js）；播放中、切后台、离开时都记进度。
 * - 播完的「下一个」：地址里带了列表（专题「播放全部」，见 playlist.js）就是列表的下一条，否则是相似推荐的第一条；
 *   跳过去替换当前记录，连着看几个以后，返回键仍然回到进来之前的页面。
 * - 在本页登录 / 退出后重新取一次自己的赞 / 收藏 / 关注状态；没登录时点的操作，登录后补做。
 */
defineOptions({ name: 'VideoView' })

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const back = useBack()

const video = shallowRef(null)
const related = shallowRef([])
/* 加载中先显示列表里带过来的封面和标题（preview.js） */
const preview = shallowRef(peekVideo(route.params.id))
/* 加载失败：message 给用户看；retry 只在可能是网络问题时显示（视频不存在重试也没用） */
const failed = ref(null)
const scroller = ref(null)
const relatedEl = ref(null)
/* 换一批：batch 递增；relatedKey 让新的一批重新淡入 */
const batch = ref(0)
const relatedKey = ref(0)
const spinning = ref(false)
const tagsOpen = ref(false)
const descOpen = ref(false)
/** 从第几秒开始播（每次加载算一次） */
const startSec = ref(0)
/** 列表（专题「播放全部」）里的下一条：{ video, query } */
const listNext = shallowRef(null)
/** 作者的详细信息（认证、粉丝数）和是否已关注：视频详情里只有名字和头像，另取一次 */
const creatorInfo = shallowRef(null)
const following = ref(false)

const tags = computed(() => (video.value?.tags || []).map(t => String(t).replace(/^#/, '')))
const creator = computed(() => (video.value?.creator?.id != null ? video.value.creator : null))
const description = computed(() => String(video.value?.description || '').trim())
/* 所属专题：只认路由能打开的 id（数字，或演示数据的 demo:数字） */
const topicTo = computed(() => {
  const v = video.value
  return v?.topicName && /^(\d+|demo:\d+)$/.test(String(v.topicId ?? '')) ? `/topic/${encodeURIComponent(v.topicId)}` : null
})

/** 播完后的下一个（给播放器显示）：{ video, query, hint } */
const nextItem = computed(() => {
  const cur = video.value
  if (!cur) return null
  if (listNext.value) return { video: listNext.value.video, query: listNext.value.query, hint: '专题下一条' }
  const r = related.value.find(v => String(v.id) !== String(cur.id))
  return r ? { video: r, query: null, hint: '相似推荐' } : null
})

/* ---------- 加载 ---------- */

let loadSeq = 0
async function load(id, query = route.query) {
  const token = ++loadSeq
  failed.value = null
  tagsOpen.value = false
  descOpen.value = false
  batch.value = 0
  listNext.value = null
  // 换成另一个视频：先撤掉旧的（播放器立即停下、操作栏不再作用于旧视频），加载期间显示占位
  if (String(video.value?.id) !== String(id)) {
    video.value = null
    related.value = []
    creatorInfo.value = null
    following.value = false
    preview.value = peekVideo(id)
  }
  try {
    // 相似推荐取不到不影响看视频
    const [v, list] = await Promise.all([getVideo(id), getRelatedVideos(id, { batch: 0 }).catch(() => [])])
    if (token !== loadSeq) return
    startSec.value = pickResume(v)
    video.value = v
    related.value = list
    relatedKey.value++
    if (scroller.value) scroller.value.scrollTop = 0
    loadCreator(v)
    loadListNext(parseList(query), v.id)
    await nextTick()
    measure()
  } catch (e) {
    if (token !== loadSeq) return
    const missing = e?.status >= 400 && e?.status < 500 && e?.status !== 401
    failed.value = missing
      ? { message: '视频不存在或已下架', retry: false }
      // 断网、超时的提示本身就是给用户看的；其他（服务器出错、返回格式不对）不把技术细节露出来
      : { message: ['network', 'timeout'].includes(e?.code) ? e.message : '加载失败，请稍后重试', retry: true }
  }
}

async function loadCreator(v) {
  const c = v.creator
  if (!c || c.id == null) return
  try {
    const d = await getCreator(c.id)
    if (video.value?.creator?.id !== c.id) return
    creatorInfo.value = { verified: !!d.verified, followers: d.followers ?? null }
    following.value = !!d.following
  } catch { /* 取不到就只显示名字和头像 */ }
}

async function loadListNext(list, id) {
  if (!list) return
  try {
    const n = await nextInList(list)
    if (String(video.value?.id) !== String(id)) return
    listNext.value = n && String(n.video.id) !== String(id) ? n : null
  } catch { /* 取不到就播相似推荐 */ }
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
  if (to.params.id !== route.params.id) load(to.params.id, to.query)
})

/* ---------- 播完：下一个（替换当前记录） ---------- */

function playNext() {
  const n = nextItem.value
  if (!n) return
  rememberVideo(n.video)
  router.replace({ path: `/video/${encodeURIComponent(n.video.id)}`, query: n.query || {} })
}

/* 没有片源时「看相似推荐」：滚到相似推荐 */
function scrollToRelated() {
  const s = scroller.value
  const r = relatedEl.value
  if (!s || !r) return
  if (!related.value.length) toast('暂时没有相似推荐')
  const top = r.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop
  s.scrollTo({ top, behavior: 'smooth' })
}

/* ---------- 观看记录 / 续播进度（服务端只记登录用户；本机都记） ---------- */

/* 直接打开播放页（刷新、书签）时，视频可能在登录状态校验完之前就开播了：等校验完再决定记不记 */
const authReady = () => (auth.ready ? Promise.resolve() : new Promise(resolve => {
  const stop = watch(() => auth.ready, ok => {
    if (!ok) return
    stop()
    resolve()
  })
}))

/* 播放器自己报 id：换视频时旧播放器卸载那一刻 video.value 已经是新视频了 */
async function onStarted(id) {
  await authReady()
  if (auth.loggedIn && !isDemoId(id)) addHistory(id, 0).catch(() => {})
}
let lastReport = ''
function onProgress({ id, sec, len, reason }) {
  setResume(id, sec, len)
  if (reason === 'tick' || !auth.loggedIn || isDemoId(id) || sec <= 3) return
  const s = Math.floor(sec)
  // 切后台紧接着关页面会报两次同一个位置，只发一次
  const key = `${id}:${s}`
  if (key === lastReport) return
  lastReport = key
  addHistory(id, s, { progressOnly: true, keepalive: reason === 'hide' }).catch(() => {})
}

/* ---------- 登录状态变了：重新取自己的赞 / 收藏 / 关注状态（未登录时接口给的都是 false） ---------- */

const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))
/* 登录后「补做操作」和这里会同时要状态：同一个视频、同一个登录只请求一次 */
const inflight = new Map()
function syncState() {
  const v = video.value
  if (!v) return Promise.resolve()
  const key = `${v.id}|${session.value}`
  if (inflight.has(key)) return inflight.get(key)
  const p = Promise.allSettled([
    getVideo(v.id).then(d => {
      if (String(video.value?.id) !== String(v.id)) return
      video.value = { ...video.value, liked: !!d.liked, disliked: !!d.disliked, faved: !!d.faved, likeCount: d.likeCount, favCount: d.favCount }
    }),
    loadCreator(v)
  ]).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}
watch(session, (now, before) => {
  if (before !== null) syncState() // 启动时的首次校验不算
})

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
  // 未登录：弹登录框，登录后补做这一下
  if (!auth.requireLogin({ then: () => afterLogin(kind, v.id) })) return

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
  } catch (e) {
    if (video.value?.id === v.id) video.value = { ...video.value, ...pick(v) } // 回滚
    toast(e?.code === 'demo' ? e.message : '操作失败，请稍后重试')
  } finally {
    pending.delete(kind)
  }
}
const pick = v => ({ liked: v.liked, disliked: v.disliked, faved: v.faved, likeCount: v.likeCount, favCount: v.favCount })

/* 登录后补做：先拿到自己真实的状态，已经是点亮的就不再点（否则会把原本的赞 / 收藏取消掉） */
async function afterLogin(kind, id) {
  await syncState()
  const v = video.value
  if (!v || String(v.id) !== String(id)) return
  if (v[FIELD[kind]]) {
    if (kind === 'fav') toast('已收藏')
    return
  }
  interact(kind)
}

/* ---------- 关注作者 ---------- */

let followBusy = false
async function onFollow() {
  const c = creator.value
  if (!c || followBusy) return
  if (!auth.requireLogin({ then: () => afterLoginFollow(c.id) })) return
  const next = !following.value
  following.value = next
  followBusy = true
  try {
    const res = await toggleFollow(c.id, { on: next })
    const on = typeof res?.active === 'boolean' ? res.active : next
    if (creator.value?.id === c.id) {
      following.value = on
      if (typeof res?.followers === 'number' && creatorInfo.value) creatorInfo.value = { ...creatorInfo.value, followers: res.followers }
    }
    toast(on ? '已关注' : '已取消关注')
  } catch (e) {
    if (creator.value?.id === c.id) following.value = !next
    toast(e?.code === 'demo' ? e.message : '操作失败，请稍后重试')
  } finally {
    followBusy = false
  }
}
async function afterLoginFollow(id) {
  await syncState()
  if (creator.value?.id !== id) return
  if (following.value) toast('已关注')
  else onFollow()
}

const searchTag = t => router.push({ path: '/search', query: { q: t } })

/* ---------- 「展开」只在放不下时出现（标签一行、简介三行） ---------- */

const tagList = ref(null)
const canExpand = ref(false)
const descEl = ref(null)
const canExpandDesc = ref(false)
function measure() {
  const t = tagList.value
  if (t && !tagsOpen.value) canExpand.value = t.scrollWidth > t.clientWidth + 1
  const d = descEl.value
  if (d && !descOpen.value) canExpandDesc.value = d.scrollHeight > d.clientHeight + 1
}
let ro = null
onMounted(() => {
  if ('ResizeObserver' in window) {
    ro = new ResizeObserver(() => measure())
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
      :start="startSec"
      :next="nextItem"
      @back="back"
      @started="onStarted"
      @progress="onProgress"
      @next="playNext"
      @related="scrollToRelated"
    />
    <!-- 加载中 / 失败时的占位：有列表带过来的封面就先显示；保留返回键，用户随时能离开 -->
    <div v-else class="player-ph" :aria-busy="!failed">
      <Cover v-if="preview?.cover && !failed" class="ph-cv" v-bind="preview.cover" eager />
      <div v-if="!failed" class="ph-spin" aria-hidden="true" />
      <button type="button" class="ph-back hit-44" aria-label="返回" @click="back"><Icon name="chevL" /></button>
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

          <!-- 作者：头像 + 名字进主页，右边关注 -->
          <div v-if="creator" class="au">
            <RouterLink class="au-link" :to="`/creator/${encodeURIComponent(creator.id)}`">
              <Cover class="au-av" v-bind="creator.avatar || {}" />
              <div class="au-who">
                <div class="au-nm">
                  <span>{{ creator.name || '未命名创作者' }}</span>
                  <Icon v-if="creatorInfo?.verified" name="verified" class="vf" />
                </div>
                <div class="au-sub">
                  <template v-if="creatorInfo?.followers != null">{{ formatCount(creatorInfo.followers) }} 粉丝</template>
                  <template v-else-if="creator.handle">@{{ creator.handle }}</template>
                </div>
              </div>
            </RouterLink>
            <button type="button" class="au-follow" :class="{ on: following }" :aria-pressed="following" @click="onFollow">
              <template v-if="following">已关注</template>
              <template v-else><Icon name="plus" />关注</template>
            </button>
          </div>

          <!-- 简介：超过三行可以展开 -->
          <div v-if="description" class="desc" :class="{ open: descOpen }">
            <p ref="descEl" class="desc-t">{{ description }}</p>
            <button v-if="canExpandDesc || descOpen" type="button" class="more" :aria-expanded="descOpen" @click="descOpen = !descOpen">
              {{ descOpen ? '收起' : '展开' }}<Icon name="chevD" />
            </button>
          </div>

          <!-- 热门榜名次（目前没有榜单页，只是标识）、所属专题 -->
          <div v-if="video.rank || topicTo" class="v-chips">
            <span v-if="video.rank" class="rank"><Icon name="flame" class="fl" />热门榜 No.{{ video.rank }}</span>
            <RouterLink v-if="topicTo" class="topic" :to="topicTo">
              <span class="lb">专题</span><span class="nm">{{ video.topicName }}</span><Icon name="chevR" />
            </RouterLink>
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
        </section>

        <section ref="relatedEl" class="related">
          <div class="r-hd">
            <h2 class="r-t">相似推荐</h2>
            <button type="button" class="r-more" :class="{ spin: spinning }" @click="shuffle" @animationend="spinning = false">
              <Icon name="refresh" />换一批
            </button>
          </div>
          <div :key="relatedKey" v-fade-in="relatedKey > 1" class="r-list">
            <RelatedVideo v-for="v in related" :key="v.id" :video="v" />
            <div v-if="!related.length" class="r-empty">暂时没有相似推荐</div>
          </div>
        </section>
        <div class="pad-b" />
      </template>

      <!-- 加载中：信息区骨架（有列表带过来的标题就先显示标题） -->
      <div v-else class="info" aria-hidden="true">
        <h1 v-if="preview?.title" class="v-title">{{ preview.title }}</h1>
        <div v-else class="sk sk-t" />
        <div class="sk sk-m" />
        <div class="au">
          <div class="au-av sk" />
          <div class="au-who">
            <div class="sk sk-l" style="width: 96px" />
            <div class="sk sk-s" style="width: 64px" />
          </div>
        </div>
        <div class="sk sk-m" style="width: 70%" />
        <div v-for="i in 3" :key="i" class="sk-row">
          <div class="sk sk-cv" />
          <div class="sk-col">
            <div class="sk sk-l" />
            <div class="sk sk-s" style="width: 50%" />
          </div>
        </div>
      </div>
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

.player-ph { position: relative; flex: none; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; background: #000; }
.ph-cv { position: absolute; inset: 0; filter: var(--media); }
.ph-cv::after { content: ''; position: absolute; inset: 0; background: rgba(0, 0, 0, .35); }
.ph-spin {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 30px;
  height: 30px;
  margin: -15px 0 0 -15px;
  border: 3px solid rgba(255, 255, 255, .25);
  border-top-color: #fff;
  border-radius: 50%;
  animation: rot .8s linear infinite;
}
.ph-back { position: absolute; left: 6px; top: 6px; display: grid; place-items: center; width: 40px; height: 40px; color: #fff; }
.ph-back svg { width: 24px; height: 24px; stroke-width: 2.6; filter: drop-shadow(0 1px 3px rgba(0, 0, 0, .5)); }

/* ---------- 标题 / 数据 / 标签 ---------- */
.info { padding: 14px 14px 0; }
.v-title { font-size: 17px; font-weight: 700; line-height: 25px; word-break: break-all; }
.v-meta { display: grid; grid-template-columns: repeat(3, 1fr); column-gap: 8px; margin-top: 8px; color: var(--t2); font-size: 13px; line-height: 20px; }
.v-meta span { white-space: nowrap; }

/* ---------- 作者 ---------- */
.au { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.au-link { display: flex; flex: 1; align-items: center; gap: 10px; min-width: 0; }
.au-av { flex: none; width: 38px; height: 38px; border-radius: 50%; filter: var(--media); }
.au-who { display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 3px; min-width: 0; }
.au-nm { display: flex; align-items: center; gap: 4px; min-width: 0; }
.au-nm span { overflow: hidden; font-size: 15px; font-weight: 600; line-height: 20px; white-space: nowrap; text-overflow: ellipsis; }
.au-nm .vf { width: 14px; height: 14px; }
.au-sub { overflow: hidden; color: var(--t2); font-size: 12px; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.au-follow {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  gap: 3px;
  height: 30px;
  padding: 0 14px 0 11px;
  border-radius: 15px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 700;
}
.au-follow::after { content: ''; position: absolute; inset: -7px -4px; }
.au-follow svg { width: 13px; height: 13px; stroke-width: 3; }
.au-follow.on { padding: 0 13px; background: var(--chip); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1); color: var(--t2); font-weight: 500; }

/* ---------- 简介 ---------- */
.desc { margin-top: 10px; }
.desc-t {
  display: -webkit-box;
  overflow: hidden;
  color: var(--t3);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: break-word;
  word-break: break-word;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
/* 收起时分段并成一段（空行不占折叠的行数），展开后按原样分段 */
.desc.open .desc-t { display: block; white-space: pre-line; -webkit-line-clamp: unset; }
.desc .more { margin-top: 2px; }

/* ---------- 热门榜 / 所属专题 ---------- */
.v-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.rank, .topic {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
  height: 28px;
  padding: 0 11px;
  border: 1px solid #2a2a2a;
  border-radius: 14px;
  background: linear-gradient(90deg, #191919, #111);
  font-size: 13px;
}
.rank { color: var(--t1); font-weight: 700; }
.rank .fl { width: 12px; height: 14px; }
.topic { position: relative; color: var(--t1); }
.topic::after { content: ''; position: absolute; inset: -8px -2px; }
.topic .lb { flex: none; color: var(--t2); }
.topic .nm { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.topic svg { width: 12px; height: 12px; margin-right: -3px; color: var(--t2); stroke-width: 2.6; }
.topic:active { background: #1c1c1c; }

.v-tags { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.v-tags .lb { flex: none; color: var(--t2); font-size: 13px; }
.v-tags .list { display: flex; flex: 1; gap: 7px; min-width: 0; overflow: hidden; }
.v-tags.open { align-items: flex-start; }
.v-tags.open .lb { line-height: 24px; }
.v-tags.open .list { flex-wrap: wrap; }
.tag { flex: none; height: 24px; padding: 0 11px; border-radius: 12px; background: var(--chip); color: #b5b5b5; font-size: 12px; }
.tag:active { background: #222; }
.more { display: flex; flex: none; align-items: center; gap: 2px; height: 24px; color: var(--t1); font-size: 13px; font-weight: 500; }
.more svg { width: 13px; height: 13px; stroke-width: 2.6; transition: transform .2s; }
.v-tags.open .more svg, .desc.open .more svg { transform: rotate(180deg); }

/* ---------- 相似推荐 ---------- */
.related { margin-top: 16px; padding: 4px 0 6px; border-radius: 14px 14px 0 0; background: var(--panel); }
.r-hd { display: flex; align-items: center; justify-content: space-between; height: 48px; padding: 0 14px 0 12px; }
.r-t { display: flex; align-items: center; gap: 6px; font-size: 16px; font-weight: 600; }
.r-t::before { content: ''; width: 3px; height: 16px; border-radius: 2px; background: var(--accent); }
.r-more { position: relative; display: flex; align-items: center; gap: 4px; color: var(--t1); font-size: 13px; }
.r-more svg { width: 13px; height: 13px; }
.r-more::after { content: ''; position: absolute; inset: -12px -10px; }
.r-list { display: flex; flex-direction: column; gap: 14px; }
.r-empty { padding: 18px 0 24px; color: var(--t2); font-size: 13px; text-align: center; }

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

/* ---------- 骨架 ---------- */
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.au-av.sk { border-radius: 50%; }
.sk-t { height: 22px; width: 82%; }
.sk-m { height: 14px; margin-top: 12px; }
.sk-l { height: 15px; }
.sk-s { height: 12px; }
.sk-row { display: flex; gap: 11px; margin-top: 18px; }
.sk-cv { flex: none; width: 142px; aspect-ratio: 16 / 10; border-radius: 7px; }
.sk-col { display: flex; flex: 1; flex-direction: column; gap: 8px; padding-top: 2px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk, .ph-spin { animation: none; }
}
</style>
