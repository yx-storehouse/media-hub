<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { getHistory, removeHistory, clearHistory, getVideo } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import { toast } from '@/composables/useToast'
import { formatClock } from '@/utils/format'
import { createFeed } from '@/components/creator/feed'
import { useAutoMore } from '@/components/home/list'
import { pickResume, setResume } from '@/components/video/resume'
import { rememberVideo } from '@/components/video/preview'
import { useSnapshot } from '@/components/me/snapshot'
import BackHeader from '@/components/BackHeader.vue'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import ConfirmSheet from '@/components/me/ConfirmSheet.vue'

defineOptions({ name: 'HistoryView' })

/*
 * 观看历史（#/history）：最近看的在前，每次 20 条，滚到底自动加载。
 * 每条显示看到哪了（封面底部的进度条 +「看到 12:34 / 已看完」），点进去从上次的位置接着播。
 * 右边的 × 删一条（几秒内可以撤销），右上角「清空」先确认再清。
 * 在本页登录 / 退出后自动重新加载；刷新时等登录状态校验完再取，不会白屏。
 */
const router = useRouter()
const auth = useAuthStore()
const app = useAppStore()

/* 剩不到 5 秒算看完（和 components/video/resume.js 一致） */
const DONE_LEFT = 5
/* 删一条后能撤销的时间 */
const UNDO_MS = 4000

const feed = createFeed(page => getHistory(page))
const scroller = ref(null)
useAutoMore(scroller, feed)

/* 账号：null = 还在校验登录状态，0 = 未登录 */
const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))

function reload() {
  cancelRemovals()
  feed.reset()
  lastTop = 0
  if (scroller.value) scroller.value.scrollTop = 0
  if (session.value) feed.more()
}

/* ---------- 进度 ---------- */

function progress(v) {
  const len = Number(v.len) || 0
  const sec = Number(v.progressSec) || 0
  if (len && sec >= len - DONE_LEFT) return { pct: 100, text: '已看完' }
  if (sec < 3) return { pct: 0, text: '刚开始看' }
  return { pct: len ? Math.min(100, (sec / len) * 100) : 0, text: `看到 ${formatClock(sec)}` }
}

const pad = n => String(n).padStart(2, '0')
/* 观看时间：今天 / 昨天带时分，更早的只写日期 */
function when(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86400000)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (diff <= 0) return `今天 ${hm}`
  if (diff === 1) return `昨天 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

let opened = null
/* 点进播放页：本机记录和这条历史里的进度取更新的一份交给播放器（快看完的从头播，见 resume.js） */
function open(v) {
  opened = v.id
  setResume(v.id, pickResume(v), Number(v.len) || 0)
  rememberVideo(v)
}

/* ---------- 删一条（先藏起来，几秒后才真正删，期间可以撤销） ---------- */

const removing = reactive(new Map())   // id -> timer
const shownTotal = computed(() => Math.max(0, (feed.total ?? 0) - removing.size))

function remove(v) {
  if (removing.has(v.id)) return
  removing.set(v.id, setTimeout(() => commit(v.id), UNDO_MS))
}

function undo(v) {
  clearTimeout(removing.get(v.id))
  removing.delete(v.id)
}

async function commit(id) {
  removing.delete(id)
  try {
    const res = await removeHistory(id)
    feed.list = feed.list.filter(x => x.id !== id)
    if (typeof res?.total === 'number') feed.total = res.total
  } catch {
    // 删除失败：这一条照常显示
    toast('删除失败，请稍后重试')
  }
}

/* 离开页面时还没到时间的删除：直接删掉（不再等撤销） */
function flushRemovals() {
  for (const [id, timer] of removing) {
    clearTimeout(timer)
    removeHistory(id).catch(() => {})
  }
  const ids = new Set(removing.keys())
  removing.clear()
  return ids
}

function cancelRemovals() {
  for (const timer of removing.values()) clearTimeout(timer)
  removing.clear()
}

/* ---------- 清空 ---------- */

const asking = ref(false)
const clearing = ref(false)

async function clearAll() {
  if (clearing.value) return
  clearing.value = true
  cancelRemovals()
  try {
    await clearHistory()
    feed.restore({ list: [], total: 0, done: true })
    toast('观看历史已清空')
  } catch {
    toast('清空失败，请稍后重试')
  } finally {
    clearing.value = false
  }
}

const goHome = () => router.push(`/home/${app.lastHomeTab}`)

/* ---------- 返回恢复 ---------- */

const snap = useSnapshot('history', () => auth.user?.id ?? 0)
const saved = snap.take()
let lastTop = 0
const onScroll = e => { lastTop = e.target.scrollTop }

if (saved) {
  feed.restore(saved.feed)
  lastTop = saved.top
}

/* 刚才点进去看的那条：进度换成这次看到的位置（稍等一下，让播放页离开时的上报先到） */
function recheck(id) {
  if (id == null) return
  setTimeout(async () => {
    try {
      const d = await getVideo(id)
      if (typeof d?.progressSec !== 'number') return
      feed.list = feed.list.map(v => (v.id === id ? { ...v, progressSec: d.progressSec, watchedAt: d.watchedAt ?? v.watchedAt } : v))
    } catch { /* 保持原样 */ }
  }, 400)
}

watch(session, (now, before) => {
  if (now === null) return
  if (saved && before === undefined) return // 刚从播放页返回，用恢复的列表
  reload()
}, { immediate: true })

onMounted(() => {
  if (!saved) return
  nextTick(() => { if (scroller.value) scroller.value.scrollTop = lastTop })
  recheck(saved.opened)
})

onBeforeUnmount(() => {
  const gone = flushRemovals()
  if (!session.value || feed.total === null) return snap.keep(null)
  snap.keep({
    feed: {
      list: feed.list.filter(v => !gone.has(v.id)),
      total: Math.max(0, feed.total - gone.size),
      done: feed.done
    },
    top: lastTop,
    opened
  })
})
</script>

<template>
  <div class="page history">
    <BackHeader>
      <span class="hd-tt">观看历史</span>
      <span v-if="session && feed.total" class="hd-n">{{ shownTotal }}</span>
      <button v-if="session && feed.list.length" type="button" class="hd-act" :disabled="clearing" @click="asking = true">清空</button>
    </BackHeader>

    <!-- 还在校验登录状态 / 第一页还没回来：骨架 -->
    <div v-if="session === null || (session && feed.total === null && !feed.error)" class="scroll" aria-busy="true">
      <div v-for="i in 6" :key="i" class="hi sk-row" aria-hidden="true">
        <div class="hi-cv sk" />
        <div class="hi-bd"><div class="sk l1" /><div class="sk l2" /><div class="sk l3" /></div>
      </div>
    </div>

    <div v-else-if="!session" class="empty">
      <Icon name="iHistory" class="em-ic" />
      登录后可以在这里看到观看记录
      <button type="button" class="retry" @click="auth.requireLogin()">去登录</button>
    </div>

    <div v-else-if="feed.total === null" class="empty">
      加载失败，请检查网络
      <button type="button" class="retry" @click="feed.more()">重试</button>
    </div>

    <div v-else-if="!feed.list.length" class="empty">
      <Icon name="iHistory" class="em-ic" />
      还没有观看记录
      <p class="em-sub">看过的视频会出现在这里，下次可以接着看</p>
      <button type="button" class="retry" @click="goHome">去首页看看</button>
    </div>

    <div v-else ref="scroller" class="scroll" @scroll.passive="onScroll">
      <div class="hi-list">
        <div v-for="v in feed.list" :key="v.id" class="hi">
          <div v-if="removing.has(v.id)" class="hi-undo" role="status">
            <span>已删除「{{ v.title }}」</span>
            <button type="button" class="undo" @click="undo(v)">撤销</button>
          </div>
          <template v-else>
            <RouterLink class="hi-link" :to="`/video/${encodeURIComponent(v.id)}`" @click="open(v)">
              <Cover class="hi-cv" v-bind="v.cover">
                <span v-if="v.dur" class="dur">{{ v.dur }}</span>
                <span v-if="progress(v).pct" class="hi-track"><span class="hi-bar" :style="{ width: progress(v).pct + '%' }" /></span>
              </Cover>
              <div class="hi-bd">
                <div class="hi-tt">{{ v.title }}</div>
                <div class="hi-pg" :class="{ done: progress(v).pct === 100 }">{{ progress(v).text }}</div>
                <div class="hi-at">{{ when(v.watchedAt) }}</div>
              </div>
            </RouterLink>
            <button type="button" class="hi-del" :aria-label="`删除观看记录：${v.title}`" @click="remove(v)"><Icon name="close" /></button>
          </template>
        </div>
      </div>
      <ListFoot :feed="feed" />
      <div class="pad-b" />
    </div>

    <ConfirmSheet
      v-model:open="asking"
      title="清空观看历史？"
      text="所有观看记录和看到哪的进度都会删掉，清空后不能恢复。"
      ok="清空"
      danger
      @confirm="clearAll"
    />
  </div>
</template>

<style scoped>
.hd-tt { white-space: nowrap; }
.hd-n { color: var(--t2); font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
.hd-act { position: relative; height: 30px; margin-left: auto; padding: 0 4px; color: var(--t2); font-size: 14px; font-weight: 500; }
.hd-act::after { content: ''; position: absolute; inset: -7px -10px; }
.hd-act:disabled { opacity: .5; }

.hi-list { padding: 6px 0; }
.hi { position: relative; }
.hi-link { display: flex; gap: 12px; padding: 9px 14px; }
.hi-link:active { background: #121212; }
.hi-cv { flex: none; width: 136px; aspect-ratio: 16 / 10; border-radius: 8px; filter: var(--media); }
/* 进度条：封面底部，白色是看过的部分（刚开始看的不画） */
.hi-track { position: absolute; left: 0; right: 0; bottom: 0; z-index: 1; height: 3px; background: rgba(255, 255, 255, .22); }
.hi-bar { display: block; height: 100%; background: var(--accent); }
.hi-cv .dur { bottom: 7px; }

.hi-bd { display: flex; flex: 1; flex-direction: column; min-width: 0; padding-right: 30px; }
.hi-tt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--t3);
  font-size: 14px;
  line-height: 20px;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.hi-pg { margin-top: auto; color: var(--t2); font-size: 12px; line-height: 17px; font-variant-numeric: tabular-nums; }
.hi-pg.done { color: #6e6e6e; }
.hi-at { color: #6e6e6e; font-size: 12px; line-height: 17px; font-variant-numeric: tabular-nums; }

/* 删除：图标小，点按区域 44x44 */
.hi-del { position: absolute; right: 2px; bottom: 2px; display: grid; place-items: center; width: 44px; height: 44px; color: #6e6e6e; }
.hi-del svg { width: 16px; height: 16px; stroke-width: 2.2; }
.hi-del:active { color: var(--t1); }

.hi-undo { display: flex; align-items: center; gap: 12px; height: 52px; margin: 6px 14px; padding: 0 6px 0 14px; border-radius: 10px; background: var(--panel); color: var(--t2); font-size: 13px; }
.hi-undo span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.undo { flex: none; height: 40px; padding: 0 12px; color: var(--t1); font-size: 14px; font-weight: 600; }

.em-ic { width: 34px; height: 34px; margin: 0 auto 12px; color: #4a4a4a; stroke-width: 1.6; }
.em-sub { margin-top: 6px; color: #6e6e6e; font-size: 12px; }

/* ---- 骨架 ---- */
.sk-row { display: flex; gap: 12px; padding: 9px 14px; }
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.hi-cv.sk { border-radius: 8px; }
.sk-row .l1 { width: 92%; height: 13px; margin-top: 4px; }
.sk-row .l2 { width: 60%; height: 13px; margin-top: 9px; }
.sk-row .l3 { width: 40%; height: 11px; margin-top: auto; margin-bottom: 4px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}
</style>
