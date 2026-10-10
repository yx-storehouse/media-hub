<script setup>
import { ref, shallowRef, computed } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router'
import Icon from '@/components/Icon.vue'
import Cover from '@/components/Cover.vue'
import VideoCard from '@/components/VideoCard.vue'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import { getTopic, getTopicVideos, toggleTopicFav } from '@/api'
import { useAuthStore } from '@/stores/auth'

defineOptions({ name: 'TopicView' })

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const back = useBack()

const scrollEl = ref(null)
const topic = shallowRef(null)
const videos = shallowRef([])
const sort = ref(0)
/* every sort click (even on the active chip) fetches a fresh batch with the next seed */
let seed = 0
/* seed of the batch on screen; keys the grid so each new batch fades in (0 = initial list, no fade) */
const batch = ref(0)
/** 加载失败：{ message, retry }；专题不存在 / 已下架（4xx）不给重试 */
const failed = ref(null)
let loadSeq = 0

const faved = computed(() => !!(topic.value && topic.value.faved))
const favCount = computed(() => (topic.value ? topic.value.favs : 0))

async function load(id) {
  const token = ++loadSeq
  failed.value = null
  try {
    const [t, res] = await Promise.all([getTopic(id), getTopicVideos(id)])
    if (token !== loadSeq) return
    topic.value = t
    videos.value = res.list
    sort.value = 0
    seed = 0
    batch.value = 0
    if (scrollEl.value) scrollEl.value.scrollTop = 0
  } catch (e) {
    if (token !== loadSeq) return
    topic.value = null   // 从别的专题切过来时，不能还显示上一个专题的头图
    const missing = e?.status >= 400 && e?.status < 500 && e?.status !== 401
    failed.value = {
      message: missing ? '专题不存在或已下架' : '加载失败，请检查网络',
      retry: !missing
    }
  }
}

async function changeSort(i) {
  sort.value = i
  const s = ++seed
  try {
    const res = await getTopicVideos(topic.value.id, i)
    if (s !== seed) return
    videos.value = res.list
    batch.value = s
  } catch {
    if (s === seed) toast('加载失败，请稍后重试')
  }
}

/* 播放全部：从当前列表第一条开始播 */
function playAll() {
  const first = videos.value[0]
  router.push(first ? `/video/${encodeURIComponent(first.id)}` : '/short')
}

async function toggleFav() {
  if (!topic.value) return
  if (!auth.requireLogin(route.fullPath)) return   // 未登录：弹登录框
  const next = !faved.value
  try {
    await toggleTopicFav(topic.value.id, { on: next })
    // 数量由后端维护，这里同步一次本地副本即可
    topic.value = { ...topic.value, faved: next, favs: topic.value.favs + (next ? 1 : -1) }
    toast(next ? '已加入收藏' : '已取消收藏')
  } catch {
    toast('操作失败，请稍后重试')
  }
}

load(route.params.id)
onBeforeRouteUpdate(to => {
  if (to.params.id !== route.params.id) load(to.params.id)
})
</script>

<template>
  <div class="page topic">
    <div ref="scrollEl" class="scroll">
      <!-- the hero frame and back button render right away (doubling as the loading skeleton) -->
      <div class="hero">
        <button class="back" aria-label="返回" @click="back"><Icon name="chevL" /></button>
        <template v-if="topic">
          <div class="mos">
            <Cover v-for="(c, i) in topic.covers" :key="i" v-bind="c" eager />
          </div>
          <div class="info">
            <div>
              <h1>{{ topic.name }}</h1>
              <div class="st">{{ topic.plays }}次播放 · {{ favCount }}收藏</div>
            </div>
            <div class="btns">
              <button class="b-play" @click="playAll"><Icon name="play" />播放全部</button>
              <button class="b-fav" :class="{ on: faved }" :aria-pressed="faved" @click="toggleFav">
                <Icon name="heart" /><span>{{ faved ? '已收藏' : '收藏' }}</span>
              </button>
            </div>
          </div>
        </template>
      </div>

      <div v-if="failed" class="empty">
        {{ failed.message }}
        <button v-if="failed.retry" class="retry" @click="load(route.params.id)">重试</button>
      </div>
      <template v-else-if="topic">
        <div class="vtitle">视频 ({{ topic.total }})</div>
        <div class="chips hs">
          <button
            v-for="(s, i) in topic.sorts"
            :key="s"
            class="chip"
            :class="{ on: sort === i }"
            :aria-pressed="sort === i"
            @click="changeSort(i)"
          >
            {{ s }}
          </button>
        </div>
        <div :key="batch" v-fade-in="batch > 0" class="grid g11">
          <VideoCard v-for="v in videos" :key="v.id" :video="v" />
        </div>
        <div class="pad-b" />
      </template>
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
.back {
  position: absolute;
  left: 13px;
  top: 10px;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: rgba(0, 0, 0, .42);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
.back svg { width: 16px; height: 16px; stroke-width: 3; }
.info { position: absolute; left: 16px; right: 15px; bottom: 13px; z-index: 2; display: flex; align-items: flex-end; justify-content: space-between; }
.info h1 { font-size: 18px; font-weight: 700; line-height: 26px; text-shadow: 0 1px 8px rgba(0, 0, 0, .5); }
.info .st { color: #e4e4e4; font-size: 13px; line-height: 20px; white-space: nowrap; }
.btns { display: flex; align-items: center; gap: 11px; }
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
}
.b-fav svg { width: 13px; height: 13px; }
.b-fav.on { border-color: rgba(255, 255, 255, .75); }
.b-fav.on svg { fill: var(--accent); }

/* ---- list ---- */
.vtitle { margin: 0 12px; padding: 13px 2px 0; border-top: 1px solid var(--line); font-size: 16px; font-weight: 500; line-height: 22px; }
</style>
