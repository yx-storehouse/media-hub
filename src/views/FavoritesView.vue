<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getMyFavs, getVideo, getTopic, toggleVideoFav, toggleTopicFav } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import { usePostStore } from '@/stores/posts'
import { toast } from '@/composables/useToast'
import { createFeed } from '@/components/creator/feed'
import { useAutoMore } from '@/components/home/list'
import { useSnapshot } from '@/components/me/snapshot'
import BackHeader from '@/components/BackHeader.vue'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import VideoCard from '@/components/VideoCard.vue'
import PostCard from '@/components/community/PostCard.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'

defineOptions({ name: 'FavoritesView' })

/*
 * 我的收藏（#/favorites?tab=video|post|topic）：视频 / 帖子 / 专题三个标签，最近收藏的在前，滚到底自动加载。
 * 每张卡片上直接取消收藏：卡片留在原处变暗，再点一次可以收藏回来（下次进来才从列表里去掉）。
 * 标签记在地址栏（replace），每个标签各自的滚动位置；点进视频 / 帖子 / 专题再返回时原样恢复。
 */
const TABS = [
  { key: 'video', label: '视频', empty: '还没有收藏视频', hint: '在播放页点「收藏」，视频会出现在这里', go: '去首页看看' },
  { key: 'post', label: '帖子', empty: '还没有收藏帖子', hint: '在社区或帖子详情点「收藏」，帖子会出现在这里', go: '去社区看看' },
  { key: 'topic', label: '专题', empty: '还没有收藏专题', hint: '在专题页点「收藏」，专题会出现在这里', go: '去片库看看' }
]
const KEYS = TABS.map(t => t.key)

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const app = useAppStore()
const postStore = usePostStore()

const feeds = {
  video: createFeed(page => getMyFavs('video', page)),
  // 收藏列表里的帖子就是最新状态：写进帖子 store，社区列表 / 详情页看到的收藏数一致
  post: createFeed(async page => {
    const res = await getMyFavs('post', page)
    for (const p of res?.list || []) postStore.patch(p.id, { faved: true, fav: p.fav ?? 0, read: p.read ?? 0 })
    return res
  }),
  topic: createFeed(page => getMyFavs('topic', page))
}
const scrollers = { video: ref(null), post: ref(null), topic: ref(null) }
/* 隐藏的标签不取下一页；切过去时再检查一次（内容不满一屏也会接着取） */
const checkMore = Object.fromEntries(KEYS.map(k => [k, useAutoMore(scrollers[k], feeds[k])]))
const tops = { video: 0, post: 0, topic: 0 }

const queryTab = v => (KEYS.includes(v) ? v : null)
const tab = ref(queryTab(route.query.tab) || 'video')
/* 地址栏里指定了标签：不再自动切到有内容的标签 */
let pinned = !!queryTab(route.query.tab)

/* 账号：null = 还在校验登录状态，0 = 未登录 */
const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))

/* ---------- 取消收藏 / 收藏回来（视频、专题；帖子卡片自带收藏按钮） ---------- */

/* 在本页取消了收藏的：'video:12'、'topic:3' */
const off = reactive(new Set())
const busy = new Set()
const isOff = (type, id) => off.has(`${type}:${id}`)

async function toggleFav(type, item) {
  const k = `${type}:${item.id}`
  if (busy.has(k)) return
  const on = off.has(k) // 现在是取消状态 → 收藏回来
  const set = active => (active ? off.delete(k) : off.add(k))
  busy.add(k)
  set(on)
  try {
    const res = await (type === 'video' ? toggleVideoFav : toggleTopicFav)(item.id, { on })
    const active = typeof res?.active === 'boolean' ? res.active : on
    set(active)
    toast(active ? '已收藏' : '已取消收藏')
  } catch (e) {
    set(!on)
    toast(e?.status === 400 && e.message ? e.message : '操作失败，请稍后重试')
  } finally {
    busy.delete(k)
  }
}

/* 标签上的数字：总数减去在本页取消掉的 */
function count(key) {
  const f = feeds[key]
  if (f.total === null) return null
  const gone = key === 'post'
    ? f.list.filter(p => !postStore.stats(p).faved).length
    : f.list.filter(x => isOff(key, x.id)).length
  return Math.max(0, f.total - gone)
}

/* ---------- 加载 ---------- */

function reload() {
  off.clear()
  for (const k of KEYS) {
    feeds[k].reset()
    tops[k] = 0
    if (scrollers[k].value) scrollers[k].value.scrollTop = 0
  }
  if (!session.value) return
  // 三个标签一起取第一页：标签上马上有数字
  for (const k of KEYS) feeds[k].more()
}

/* 没指定标签、视频一个也没有：切到第一个有内容的标签 */
watch(() => KEYS.map(k => feeds[k].total), totals => {
  if (pinned || totals.some(t => t === null)) return
  pinned = true
  if (totals[KEYS.indexOf(tab.value)] > 0) return
  const i = totals.findIndex(t => t > 0)
  if (i >= 0) selectTab(KEYS[i])
})

function selectTab(key) {
  if (key === tab.value) {
    // 再点一次当前标签：回到顶部
    scrollers[key].value?.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }
  pinned = true
  tab.value = key
  router.replace({ query: { ...route.query, tab: key } })
  nextTick(checkMore[key])
}

/* 方向键在标签之间切换（只有选中的标签能 Tab 进入） */
function onTabKey(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const i = KEYS.indexOf(tab.value)
  const next = KEYS[(i + (e.key === 'ArrowRight' ? 1 : KEYS.length - 1)) % KEYS.length]
  selectTab(next)
  nextTick(() => document.getElementById(`fv-tab-${next}`)?.focus())
}

function goFind(key) {
  router.push(key === 'post' ? '/community' : key === 'topic' ? '/library' : `/home/${app.lastHomeTab}`)
}

let opened = null
const onOpen = (type, id) => { opened = { type, id } }
const onScroll = (key, e) => { tops[key] = e.target.scrollTop }

/* ---------- 返回恢复 ---------- */

const snap = useSnapshot('favorites', () => auth.user?.id ?? 0)
const saved = snap.take()
if (saved) {
  for (const k of KEYS) feeds[k].restore(saved.feeds[k])
  Object.assign(tops, saved.tops)
  for (const k of saved.off) off.add(k)
  tab.value = saved.tab
  pinned = true
}

/* 刚才点进去的那个视频 / 专题，可能在详情页里改了收藏：静默核对一次（帖子的状态在帖子 store 里） */
async function recheck(item) {
  if (!item || item.type === 'post') return
  try {
    const d = await (item.type === 'video' ? getVideo : getTopic)(item.id)
    if (typeof d?.faved !== 'boolean') return
    const k = `${item.type}:${item.id}`
    if (busy.has(k)) return
    if (d.faved) off.delete(k)
    else off.add(k)
  } catch { /* 保持原样 */ }
}

watch(session, (now, before) => {
  if (now === null) return
  if (saved && before === undefined) return // 返回到本页：用恢复的列表
  reload()
}, { immediate: true })

/* 地址栏里的标签被改了（浏览器前进后退到同一页的另一条记录） */
watch(() => route.query.tab, v => {
  const t = queryTab(v)
  if (route.name === 'favorites' && t && t !== tab.value) tab.value = t
})

onMounted(() => {
  if (!saved) return
  nextTick(() => {
    for (const k of KEYS) if (scrollers[k].value) scrollers[k].value.scrollTop = tops[k]
  })
  recheck(saved.opened)
})

onBeforeUnmount(() => {
  if (!session.value || KEYS.some(k => feeds[k].total === null)) return snap.keep(null)
  snap.keep({
    tab: tab.value,
    feeds: Object.fromEntries(KEYS.map(k => [k, feeds[k].snapshot()])),
    tops: { ...tops },
    off: [...off],
    opened
  })
})
</script>

<template>
  <div class="page favorites">
    <BackHeader title="我的收藏" />

    <div v-if="session === 0" class="empty">
      <Icon name="heart" class="em-ic" />
      登录后可以在这里看到收藏的视频、帖子和专题
      <button type="button" class="retry" @click="auth.requireLogin()">去登录</button>
    </div>

    <template v-else>
      <div class="fv-tabs" role="tablist" aria-label="收藏的内容">
        <button
          v-for="t in TABS"
          :id="`fv-tab-${t.key}`"
          :key="t.key"
          type="button"
          role="tab"
          class="fv-tab"
          :class="{ on: tab === t.key }"
          :aria-selected="tab === t.key"
          :aria-controls="`fv-pane-${t.key}`"
          :tabindex="tab === t.key ? 0 : -1"
          @click="selectTab(t.key)"
          @keydown="onTabKey"
        >
          <span class="lb">{{ t.label }}<span v-if="count(t.key) !== null" class="n">{{ count(t.key) }}</span></span>
        </button>
      </div>

      <section
        v-for="t in TABS"
        v-show="tab === t.key"
        :id="`fv-pane-${t.key}`"
        :key="t.key"
        :ref="el => { scrollers[t.key].value = el }"
        class="scroll fv-pane"
        role="tabpanel"
        :aria-labelledby="`fv-tab-${t.key}`"
        @scroll.passive="onScroll(t.key, $event)"
      >
        <!-- 第一页还没回来：骨架 -->
        <template v-if="session === null || (feeds[t.key].total === null && !feeds[t.key].error)">
          <SkeletonGrid v-if="t.key === 'video'" :count="6" gap="g16" class="fv-pt" />
          <div v-else-if="t.key === 'topic'" class="tp-grid" aria-hidden="true">
            <div v-for="i in 4" :key="i" class="tp sk" />
          </div>
          <div v-else aria-hidden="true">
            <div v-for="i in 2" :key="i" class="sk-post">
              <div class="sk av" />
              <div class="bd"><div class="sk l1" /><div class="sk l2" /><div class="sk md" /></div>
            </div>
          </div>
        </template>

        <div v-else-if="feeds[t.key].total === null" class="empty">
          加载失败，请检查网络
          <button type="button" class="retry" @click="feeds[t.key].more()">重试</button>
        </div>

        <div v-else-if="!feeds[t.key].list.length" class="empty">
          <Icon name="heart" class="em-ic" />
          {{ t.empty }}
          <p class="em-sub">{{ t.hint }}</p>
          <button type="button" class="retry" @click="goFind(t.key)">{{ t.go }}</button>
        </div>

        <template v-else>
          <!-- 视频：两列卡片，右上角的心形取消 / 恢复收藏 -->
          <div v-if="t.key === 'video'" class="grid g16 fv-pt">
            <div v-for="v in feeds.video.list" :key="v.id" class="fv" :class="{ off: isOff('video', v.id) }">
              <VideoCard :video="v" @click="onOpen('video', v.id)" />
              <button
                type="button"
                class="fv-heart hit-44"
                :aria-pressed="!isOff('video', v.id)"
                :aria-label="isOff('video', v.id) ? `收藏：${v.title}` : `取消收藏：${v.title}`"
                @click="toggleFav('video', v)"
              >
                <Icon name="heart" />
              </button>
            </div>
          </div>

          <!-- 帖子：和社区同一个卡片，卡片底部的收藏按钮就能取消 -->
          <template v-else-if="t.key === 'post'">
            <PostCard v-for="p in feeds.post.list" :key="p.id" :post="p" :class="{ 'fv-off': !postStore.stats(p).faved }" />
          </template>

          <!-- 专题：和片库一样的卡片 -->
          <div v-else class="tp-grid">
            <div v-for="c in feeds.topic.list" :key="c.id" class="tp-it" :class="{ off: isOff('topic', c.id) }">
              <RouterLink :to="`/topic/${encodeURIComponent(c.id)}`" @click="onOpen('topic', c.id)">
                <Cover class="tp" v-bind="c.cover">
                  <b>{{ c.name }}</b>
                  <span>{{ c.count }}部</span>
                </Cover>
              </RouterLink>
              <button
                type="button"
                class="fv-heart hit-44"
                :aria-pressed="!isOff('topic', c.id)"
                :aria-label="isOff('topic', c.id) ? `收藏：${c.name}` : `取消收藏：${c.name}`"
                @click="toggleFav('topic', c)"
              >
                <Icon name="heart" />
              </button>
            </div>
          </div>

          <ListFoot :feed="feeds[t.key]" />
        </template>
        <div class="pad-b" />
      </section>
    </template>
  </div>
</template>

<style scoped>
/* ---- 标签栏 ---- */
.fv-tabs { display: flex; flex: none; height: 44px; border-bottom: 1px solid var(--line); }
.fv-tab { display: flex; flex: 1; justify-content: center; color: var(--t2); font-size: 15px; font-weight: 500; }
.fv-tab .lb { position: relative; display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.fv-tab .n { font-size: 12.5px; font-weight: 500; font-variant-numeric: tabular-nums; }
.fv-tab.on { color: var(--t1); font-weight: 700; }
.fv-tab.on .lb::after { content: ''; position: absolute; left: -2px; right: -2px; bottom: 0; height: 3px; border-radius: 2px; background: var(--accent); }
.fv-tab:focus-visible { outline-offset: -4px; }

.fv-pt { padding-top: 14px; }

/* ---- 视频卡片 + 心形按钮 ---- */
.fv { position: relative; min-width: 0; }
.fv .vc { display: block; transition: opacity .2s; }
.fv.off .vc, .tp-it.off > a { opacity: .4; }
.fv-heart {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(0, 0, 0, .46);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #fff;
}
.fv-heart svg { width: 16px; height: 16px; fill: currentColor; stroke-width: 2; }
.fv-heart[aria-pressed="false"] svg { fill: none; }
.fv-heart:active { transform: scale(.92); }

/* ---- 帖子：取消收藏后变暗 ---- */
.fv-off { opacity: .55; }

/* ---- 专题卡片（同片库） ---- */
.tp-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; padding: 14px; }
.tp-it { position: relative; min-width: 0; }
.tp-it > a { display: block; transition: opacity .2s; }
.tp {
  display: flex;
  align-items: flex-end;
  aspect-ratio: 16 / 8;
  padding: 10px 12px;
  border-radius: 10px;
  filter: var(--media);
}
.tp::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 30%, rgba(0, 0, 0, .65));
}
.tp b { position: relative; z-index: 1; min-width: 0; overflow: hidden; font-size: 14px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.tp span { position: relative; z-index: 1; flex: none; margin-left: auto; padding-left: 6px; font-size: 11px; opacity: .78; }

.em-ic { width: 34px; height: 34px; margin: 0 auto 12px; color: #4a4a4a; stroke-width: 1.6; }
.em-sub { margin-top: 6px; padding: 0 30px; color: #6e6e6e; font-size: 12px; line-height: 18px; }

/* ---- 骨架 ---- */
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.tp.sk { border-radius: 10px; }
.sk-post { display: flex; gap: 11px; padding: 14px; border-bottom: 1px solid var(--line); }
.sk-post .av { flex: none; width: 44px; height: 44px; border-radius: 50%; }
.sk-post .bd { flex: 1; min-width: 0; }
.sk-post .l1 { width: 40%; height: 14px; margin-top: 4px; }
.sk-post .l2 { width: 86%; height: 14px; margin-top: 12px; }
.sk-post .md { margin-top: 12px; aspect-ratio: 16 / 9; border-radius: 7px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}
</style>
