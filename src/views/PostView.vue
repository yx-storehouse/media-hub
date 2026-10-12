<script setup>
import { ref, shallowRef, computed, watch } from 'vue'
import { useRoute, onBeforeRouteUpdate, RouterLink } from 'vue-router'
import { getPost, viewPost, toggleFollow } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { usePostStore } from '@/stores/posts'
import { useBack } from '@/composables/useBack'
import { toast } from '@/composables/useToast'
import { share } from '@/composables/useShare'
import { formatCount } from '@/utils/format'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

/*
 * 帖子详情：作者栏（关注）→ 标题、正文、配图、关联视频、话题、发布时间 →「下一篇」，底部是阅读数 / 分享 / 收藏。
 * 收藏状态和阅读数放在 stores/posts.js，社区列表（常驻）读同一份，返回列表时两边一致。
 */
defineOptions({ name: 'PostView' })

const route = useRoute()
const auth = useAuthStore()
const postStore = usePostStore()
/* 直接打开（没有上一页）时返回社区 */
const back = useBack('/community')

/** PostDetail（见 src/api/index.js） */
const post = shallowRef(null)
/* 加载失败：message 给用户看；retry 只在可能是网络问题时显示（帖子不存在重试也没用） */
const failed = ref(null)
const following = ref(false)
const scroller = ref(null)
/* 配图按原始比例显示：加载完读出宽高，之前先用 4:3 占位 */
const ratios = shallowRef({})

const author = computed(() => post.value?.author || null)
/* 头像 + 名字进作者主页（作者已删除时 id 为空，就只是展示） */
const authorLink = computed(() => (author.value?.id != null ? { to: `/creator/${encodeURIComponent(author.value.id)}` } : null))
const stats = computed(() => (post.value ? postStore.stats(post.value) : { faved: false, fav: 0, read: 0 }))
const tags = computed(() => (post.value?.tags || []).map(t => String(t).replace(/^#/, '')).filter(Boolean))
/* 正文按空行分段；段内的单个换行原样显示（pre-line） */
const paragraphs = computed(() => String(post.value?.content || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean))

const videoTo = v => `/video/${encodeURIComponent(v.id)}`
const postTo = id => `/post/${encodeURIComponent(id)}`
const searchTo = t => ({ path: '/search', query: { q: t } })

/* ---------- 加载 ---------- */

let loadSeq = 0
async function load(id) {
  const token = ++loadSeq
  // 换一篇：先撤掉上一篇（加载期间显示骨架），不会把旧内容当成新帖子显示
  post.value = null
  failed.value = null
  following.value = false
  ratios.value = {}
  if (scroller.value) scroller.value.scrollTop = 0
  try {
    const p = await getPost(id)
    if (token !== loadSeq) return
    following.value = !!p.following
    // 这次打开也算一次阅读：先在本地 +1，接口返回新的阅读数后以它为准
    postStore.patch(p.id, { faved: !!p.faved, fav: p.fav ?? 0, read: (p.read ?? 0) + 1 })
    post.value = p
    viewPost(p.id).then(r => {
      if (typeof r?.read === 'number') postStore.patch(p.id, { read: r.read })
    })
  } catch (e) {
    if (token !== loadSeq) return
    const missing = e?.status >= 400 && e?.status < 500 && e?.status !== 401
    failed.value = missing
      ? { message: (e.status === 400 && e.message) || '帖子不存在或已下架', retry: false }
      : { message: e?.message || '加载失败，请检查网络', retry: true }
  }
}

load(route.params.id)
onBeforeRouteUpdate(to => {
  if (to.params.id !== route.params.id) load(to.params.id)
})

/* 在本页登录 / 退出后，重新取一次「是否关注 / 是否收藏」（未登录时接口给的都是 false） */
const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))
watch(session, async (now, before) => {
  const p = post.value
  if (before === null || !p) return // 启动时的首次校验不算
  try {
    const d = await getPost(p.id)
    if (post.value?.id !== p.id) return
    following.value = !!d.following
    postStore.patch(p.id, { faved: !!d.faved, fav: d.fav ?? 0 })
  } catch { /* 取不到就保持原样 */ }
})

function onImage(i, e) {
  const { naturalWidth: w, naturalHeight: h } = e.target
  if (w && h) ratios.value = { ...ratios.value, [i]: `${w} / ${h}` }
}

/* ---------- 关注 / 收藏：乐观更新 → 一次请求（带明确的 on）→ 以返回为准，失败回滚并提示 ---------- */

let followBusy = false
async function onFollow() {
  const a = author.value
  if (!a || a.id == null || followBusy) return
  if (!auth.requireLogin(route.fullPath)) return // 未登录：弹登录框
  const next = !following.value
  following.value = next
  followBusy = true
  try {
    const res = await toggleFollow(a.id, { on: next })
    const on = typeof res?.active === 'boolean' ? res.active : next
    if (author.value?.id === a.id) following.value = on
    toast(on ? '已关注' : '已取消关注')
  } catch {
    if (author.value?.id === a.id) following.value = !next
    toast('操作失败，请稍后重试')
  } finally {
    followBusy = false
  }
}

async function onFav() {
  const p = post.value
  if (!p || postStore.isPending(p.id)) return
  if (!auth.requireLogin(route.fullPath)) return
  try {
    const on = await postStore.setFav(p, !stats.value.faved)
    toast(on ? '已收藏' : '已取消收藏')
  } catch {
    toast('操作失败，请稍后重试')
  }
}
</script>

<template>
  <div class="page post-pg">
    <header class="pd-hd">
      <button type="button" class="pd-back" aria-label="返回" @click="back"><Icon name="chevL" /></button>
      <template v-if="post">
        <component :is="authorLink ? RouterLink : 'div'" class="pd-author" v-bind="authorLink || {}">
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
        <button v-if="author && author.id != null" type="button" class="pd-follow" :class="{ on: following }" @click="onFollow">
          <template v-if="following">已关注</template>
          <template v-else><Icon name="plus" />关注</template>
        </button>
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

    <div ref="scroller" class="scroll" :aria-busy="!post && !failed">
      <div v-if="failed" class="empty">
        {{ failed.message }}
        <button v-if="failed.retry" type="button" class="retry" @click="load(route.params.id)">重试</button>
      </div>

      <template v-else-if="post">
        <article class="pd-body">
          <h1 class="pd-title">{{ post.title }}</h1>
          <div v-if="paragraphs.length" class="pd-text">
            <p v-for="(para, i) in paragraphs" :key="i">{{ para }}</p>
          </div>

          <div v-if="post.images?.length" class="pd-imgs">
            <Cover
              v-for="(img, i) in post.images"
              :key="i"
              class="pd-img"
              v-bind="img"
              :style="{ aspectRatio: ratios[i] || '4 / 3' }"
              @load="onImage(i, $event)"
            />
          </div>

          <RouterLink v-if="post.video" class="pd-video" :to="videoTo(post.video)" :aria-label="`播放视频：${post.video.title || post.title}`">
            <Cover class="pd-vcv" v-bind="post.video.cover">
              <span class="pl"><Icon name="play" /></span>
              <span v-if="post.video.dur" class="dur">{{ post.video.dur }}</span>
            </Cover>
          </RouterLink>

          <div v-if="tags.length" class="pd-tags">
            <RouterLink v-for="t in tags" :key="t" class="pd-tag" :to="searchTo(t)">#{{ t }}</RouterLink>
          </div>
          <div v-if="post.time" class="pd-time">{{ post.time }}</div>
        </article>

        <hr class="pd-div">
        <!-- 下一篇替换当前记录：连着往下看几篇，返回键仍然直接回到进来之前的页面 -->
        <RouterLink v-if="post.next" class="pd-next" :to="postTo(post.next.id)" replace>
          <div class="nx">
            <span class="lb">下一篇</span>
            <span class="tt2">{{ post.next.title }}</span>
          </div>
          <Cover v-if="post.next.thumb" class="th" v-bind="post.next.thumb" />
        </RouterLink>
        <div v-else class="pd-end">已经是最后一篇了</div>
        <div class="pad-b" />
      </template>

      <!-- 加载中：正文骨架 -->
      <div v-else class="pd-body" aria-hidden="true">
        <div class="sk sk-t" />
        <div class="sk sk-t" style="width: 62%" />
        <div class="sk sk-p" />
        <div class="sk sk-p" />
        <div class="sk sk-p" style="width: 80%" />
        <div class="sk sk-img" />
      </div>
    </div>

    <footer v-if="post" class="pd-bar">
      <span class="pd-read">阅读 {{ formatCount(stats.read) }}</span>
      <button type="button" class="pd-share" aria-label="分享" @click="share({ title: post.title })"><Icon name="shareUp" /></button>
      <button type="button" class="pd-fav" :class="{ on: stats.faved }" :aria-pressed="stats.faved" @click="onFav">
        <Icon name="bookmark" /><span>收藏 {{ formatCount(stats.fav) }}</span>
      </button>
    </footer>
  </div>
</template>

<style scoped>
/* ---------- 作者栏（在滚动区外面，始终可见） ---------- */
.pd-hd { display: flex; flex: none; align-items: center; gap: 10px; height: 66px; padding: 0 16px 0 4px; border-bottom: 1px solid var(--line); }
.pd-back { display: grid; flex: none; place-items: center; width: 36px; height: 44px; }
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
.pd-follow {
  display: flex;
  flex: none;
  align-items: center;
  gap: 3px;
  height: 32px;
  padding: 0 15px 0 12px;
  border-radius: 16px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-weight: 700;
}
.pd-follow svg { width: 14px; height: 14px; stroke-width: 3; }
.pd-follow.on { padding: 0 14px; background: var(--chip); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1); color: var(--t2); font-weight: 500; }

/* ---------- 正文 ---------- */
.pd-body { padding: 14px 16px 0; }
.pd-title { font-size: 20px; font-weight: 700; line-height: 1.45; overflow-wrap: break-word; word-break: break-word; }
.pd-text { margin-top: 10px; color: var(--t3); font-size: 16px; line-height: 1.75; white-space: pre-line; overflow-wrap: break-word; word-break: break-word; }
.pd-text p + p { margin-top: 12px; }

.pd-imgs { display: flex; flex-direction: column; gap: 14px; margin-top: 16px; }
.pd-img { width: 100%; border-radius: 12px; filter: var(--media); }

.pd-video { display: block; margin-top: 14px; border-radius: 12px; }
.pd-vcv { aspect-ratio: 16 / 9; border-radius: 12px; filter: var(--media); }
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
.pd-tag { color: var(--accent); font-size: 15px; font-weight: 500; line-height: 26px; }
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
}
.pd-next:active { background: #171717; }
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
.pd-share { display: grid; flex: none; place-items: center; width: 44px; height: 44px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .16); }
.pd-share svg { width: 19px; height: 19px; stroke-width: 1.9; }
.pd-share:active { background: var(--chip); }
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
}
.pd-fav svg { width: 18px; height: 18px; stroke-width: 2.2; }
.pd-fav.on { background: var(--accent); color: var(--on-accent); }
.pd-fav.on svg { fill: currentColor; }

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
