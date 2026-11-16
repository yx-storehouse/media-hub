<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { getHistory, removeHistory, clearHistory, getVideo } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import { toast, toastError } from '@/composables/useToast'
import { createFeed } from '@/components/creator/feed'
import { useAutoMore } from '@/components/home/list'
import { pickResume, setResume } from '@/components/video/resume'
import { rememberVideo } from '@/components/video/preview'
import { useSnapshot } from '@/components/me/snapshot'
import { vGutter } from '@/components/me/gutter'
import { progress, when, DAY_GROUPS, dayOf, stamp } from '@/components/me/history'
import BackHeader from '@/components/BackHeader.vue'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import SkeletonGrid from '@/components/home/SkeletonGrid.vue'
import ConfirmSheet from '@/components/me/ConfirmSheet.vue'
import HistoryCard from '@/components/me/HistoryCard.vue'
import LoadState from '@/components/common/LoadState.vue'
import { cameBack, vRise, leave } from '@/components/home/motion'
import { isDesktop } from '@/composables/useDesktop'

defineOptions({ name: 'HistoryView' })

/*
 * 观看历史（#/history）：最近看的在前，每次 20 条，滚到底自动加载。
 * 每条显示看到哪了（封面底部的进度条 +「看到 12:34 / 已看完」），点进去从上次的位置接着播。
 * 右边的 × 删一条（几秒内可以撤销），右上角「清空」先确认再清。
 * 在本页登录 / 退出后自动重新加载；刷新时等登录状态校验完再取，不会白屏。
 * 桌面布局（≥ 1024px）是铺满内容区的视频网格，按「今天 / 昨天 / 更早」分组（卡片是 components/me/HistoryCard.vue）；
 * 手机上是原来的列表。删一条、撤销、清空、返回恢复两边是同一套。
 */
const router = useRouter()
const auth = useAuthStore()
const app = useAppStore()
/* 按返回回到这一页：恢复出来的列表不播入场 */
cameBack()

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

/* ---------- 桌面网格：按天分组 ---------- */

/*
 * 「今天 / 昨天 / 更早」三组，组里照列表的顺序（最近看的在前）。按进来时的观看时间分（groupAt，见 recheck）：
 * 点进去看了再返回，这条的时间变成刚才，但卡片留在原来的位置，不会在眼前跳到「今天」的最前面
 */
const groups = computed(() => {
  const now = new Date()
  const by = { today: [], yesterday: [], older: [] }
  for (const v of feed.list) by[dayOf(v.groupAt ?? v.watchedAt, now)].push(v)
  return DAY_GROUPS.filter(g => by[g.key].length).map(g => ({ ...g, list: by[g.key] }))
})

/*
 * 网格里离开的卡片（删掉、整组没了的组标题）：绝对定位叠在原处淡出，后面的平滑补位（TransitionGroup 的 move）。
 * 离开前把位置、大小钉在行内样式上（网格里绝对定位的元素会跑到左上角）；同一拍里离开好几个时，位置都按
 * 第一个离开之前的排版量（前一个变成绝对定位后，后面的会先往前挪一下，再量就不对了）
 */
let placed = null
function pin(el) {
  if (!placed) {
    placed = new Map([...el.parentNode.children].map(c => [c, { x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }]))
    queueMicrotask(() => { placed = null })
  }
  const r = placed.get(el) || { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
  Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
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
/* 撤销时间到了、删除请求还没回来：保持「已删除」的样子，直到真的从列表里拿掉（不然原来那条会先回来再走） */
const committing = reactive(new Set())
const isRemoved = id => removing.has(id) || committing.has(id)
const shownTotal = computed(() => Math.max(0, (feed.total ?? 0) - removing.size - committing.size))

/*
 * 桌面上用键盘（回车 / 空格，读屏的「点按」也一样）按的按钮：click 的 detail 是 0。
 * 用鼠标点的不算：Chrome 里点了的按钮也有焦点，按焦点判断会把焦点放到新按钮上，× 就一直挂着（见 HistoryCard）
 */
const byKeys = e => isDesktop.value && e?.detail === 0 && e.currentTarget === document.activeElement

function remove(v, e) {
  if (removing.has(v.id)) return
  removing.set(v.id, setTimeout(() => commit(v.id), UNDO_MS))
  // 桌面上用键盘删的：× 按钮随这张卡片换成撤销条消失了，焦点交给「撤销」，接着按回车就能撤销
  if (byKeys(e)) refocus(v.id, '.undo')
}

function undo(v, e) {
  if (committing.has(v.id)) return
  clearTimeout(removing.get(v.id))
  removing.delete(v.id)
  if (byKeys(e)) refocus(v.id, '.hc-del')
}

/* 等这一张卡片换好（撤销条 ⇄ 记录）再把焦点放到新出现的按钮上（只有桌面上用键盘删 / 撤销时） */
function refocus(id, sel) {
  nextTick(() => {
    const card = [...(gridEl.value?.$el?.children || [])].find(el => el.dataset.hid === String(id))
    card?.querySelector(sel)?.focus({ preventScroll: true })
  })
}

async function commit(id) {
  committing.add(id)
  removing.delete(id)
  try {
    const res = await removeHistory(id)
    // 拿掉这一条、改总数、清掉「提交中」在同一拍里做完：中间不会多渲染一次（标题数字不会先回跳一下）
    feed.list = feed.list.filter(x => x.id !== id)
    if (typeof res?.total === 'number') feed.total = res.total
  } catch (e) {
    // 删除失败：这一条照常显示（登录过期时不提示：登录框已经弹出来了）
    toastError(e, '删除失败，请稍后重试')
  } finally {
    committing.delete(id)
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

/*
 * 清空：请求马上发出，同时屏幕上的记录依次淡出；两样都完了才换成空状态（动画不到 0.3 秒，请求慢时就等请求）。
 * 失败了记录原样放回来。
 */
const listEl = ref(null)
const gridEl = ref(null)
async function clearAll() {
  if (clearing.value) return
  clearing.value = true
  cancelRemovals()
  const out = leave((isDesktop.value ? gridEl : listEl).value?.$el?.children, { y: -6, scale: 0.96 })
  try {
    await Promise.all([clearHistory(), ...out.map(a => a.finished.catch(() => {}))])
    feed.restore({ list: [], total: 0, done: true })
    toast('观看历史已清空')
  } catch (e) {
    out.forEach(a => a.cancel())
    toastError(e, '清空失败，请稍后重试')
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
      // groupAt：桌面网格按进来时的时间分组，这条留在原来的组里（见 groups）
      feed.list = feed.list.map(v => (v.id === id ? { ...v, progressSec: d.progressSec, watchedAt: d.watchedAt ?? v.watchedAt, groupAt: v.groupAt ?? v.watchedAt } : v))
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
  // 正在删的（请求已经发出）也算删掉了：返回时不要从快照里把它放回来
  for (const id of committing) gone.add(id)
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
    <div v-if="session === null || (session && feed.total === null && !feed.error)" v-gutter class="scroll hi-sk" aria-busy="true">
      <!-- 桌面：一条分组标题 + 画满一屏的视频网格骨架，和数据回来后的网格对齐 -->
      <template v-if="isDesktop">
        <div class="hg-sk-hd" aria-hidden="true"><span class="sk" /></div>
        <SkeletonGrid fill class="hg-sk" />
      </template>
      <template v-else>
        <div v-for="i in 6" :key="i" class="hi sk-row" aria-hidden="true">
          <div class="hi-cv sk" />
          <div class="hi-bd"><div class="sk l1" /><div class="sk l2" /><div class="sk l3" /></div>
        </div>
      </template>
    </div>

    <div v-else-if="!session" v-rise.self class="empty">
      <Icon name="iHistory" class="em-ic" />
      登录后可以在这里看到观看记录
      <button type="button" class="retry" @click="auth.requireLogin()">去登录</button>
    </div>

    <!-- 第一页取不到：统一的说法 +「重试」，联网 / 隔一会儿会自己重试 -->
    <LoadState v-else-if="feed.total === null" :error="feed.error" :retry="feed.more" />

    <div v-else-if="!feed.list.length" v-rise.self class="empty">
      <Icon name="iHistory" class="em-ic" />
      还没有观看记录
      <p class="em-sub">看过的视频会出现在这里，下次可以接着看</p>
      <button type="button" class="retry" @click="goHome">去首页看看</button>
    </div>

    <div v-else ref="scroller" v-gutter class="scroll" @scroll.passive="onScroll">
      <!--
        桌面：铺满内容区的视频网格（和别的视频网格同一个列数规则），「今天 / 昨天 / 更早」的组标题各占一整行。
        点 × 后卡片原地换成「已删除 · 撤销」；几秒后真正删掉时这张卡片淡出、后面的平滑补位，整组删空了组标题也跟着淡出
      -->
      <TransitionGroup v-if="isDesktop" ref="gridEl" v-rise tag="div" name="hg" class="grid hg" @before-leave="pin">
        <template v-for="(g, gi) in groups" :key="g.key">
          <h2 class="hg-hd" :class="{ first: !gi }">{{ g.label }}</h2>
          <HistoryCard
            v-for="v in g.list"
            :key="v.id"
            :video="v"
            :at="stamp(v.watchedAt, g.key)"
            :removed="isRemoved(v.id)"
            :locked="committing.has(v.id)"
            @open="open(v)"
            @remove="remove(v, $event)"
            @undo="undo(v, $event)"
          />
        </template>
      </TransitionGroup>
      <!--
        一条记录：点 × 后原地换成「已删除 · 撤销」（交叉淡入淡出，下面的记录平滑补位）；
        几秒后真正删掉时这一条淡出、下面的往上补
      -->
      <TransitionGroup v-else ref="listEl" v-rise tag="div" name="hi" class="hi-list">
        <!-- class 里读一下删除状态：换成撤销条时列表也跟着重新排一次位置，下面的记录才会平滑补位 -->
        <div v-for="v in feed.list" :key="v.id" class="hi" :class="{ removed: isRemoved(v.id) }" :data-hid="v.id">
          <Transition name="hi-swap">
            <div v-if="isRemoved(v.id)" class="hi-undo" role="status">
              <span>已删除「{{ v.title }}」</span>
              <button type="button" class="undo" :disabled="committing.has(v.id)" @click="undo(v, $event)">撤销</button>
            </div>
            <div v-else class="hi-row">
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
              <button type="button" class="hi-del m-hold" :aria-label="`删除观看记录：${v.title}`" @click="remove(v, $event)"><Icon name="close" /></button>
            </div>
          </Transition>
        </div>
      </TransitionGroup>
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
.hd-act { transition: opacity var(--dur-1) var(--ease-out); }
.hd-act:active { opacity: .6; }
.hd-act:disabled { opacity: .5; }

.hi-list { position: relative; padding: 6px 0; }
.hi { position: relative; }
.hi-row { position: relative; }
.hi-link { display: flex; gap: 12px; padding: 9px 14px; transition: background-color var(--dur-2) var(--ease-out); }
.hi-link:active { background: #121212; transition-duration: var(--dur-1); }

/*
 * 列表：删掉的一条原地淡出、往左滑一点，下面的平滑补位（只动 transform）。
 * 淡出用 --dur-1 + ease-out：补位的那条一开始就往上走（ease-out），离开的要先它一步看不见，两行字不会叠在一起
 */
.hi-move { transition: transform var(--dur-3) var(--ease-out); }
.hi-leave-active { position: absolute; left: 0; right: 0; pointer-events: none; transition: opacity var(--dur-1) var(--ease-out), transform var(--dur-2) var(--ease-in); }
.hi-leave-to { opacity: 0; transform: translate3d(-24px, 0, 0); }
/* 一条记录换成「已删除 · 撤销」：旧的叠在原处淡出，新的淡入 */
.hi-swap-enter-active { transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out); }
.hi-swap-leave-active { position: absolute; top: 0; left: 0; right: 0; pointer-events: none; transition: opacity var(--dur-1) var(--ease-in); }
.hi-swap-enter-from { opacity: 0; transform: scale(.98); }
.hi-swap-leave-to { opacity: 0; }
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
/* Safari 15.4 以前不认 overflow-wrap: anywhere（没有空格的长串——英文名、链接——不换行、顶出屏幕）；word-break: break-word 效果一样，老 Safari 也认 */
@supports not (overflow-wrap: anywhere) {
  .hi-tt { word-break: break-word; }
}
.hi-pg { margin-top: auto; color: var(--t2); font-size: 12px; line-height: 17px; font-variant-numeric: tabular-nums; }
.hi-pg.done { color: var(--t-sub); }
.hi-at { color: var(--t-sub); font-size: 12px; line-height: 17px; font-variant-numeric: tabular-nums; }

/* 删除：图标小，点按区域 44x44 */
.hi-del { position: absolute; right: 2px; bottom: 2px; display: grid; place-items: center; width: 44px; height: 44px; color: #6e6e6e; transition: color var(--dur-1) var(--ease-out); }
.hi-del svg { width: 16px; height: 16px; stroke-width: 2.2; transition: transform var(--dur-2) var(--ease-spring); }
.hi-del:active { color: var(--t1); }
.hi-del.m-pressed svg { transform: scale(var(--press-scale-sm)); transition: transform var(--dur-1) var(--ease-out); }

.hi-undo { display: flex; align-items: center; gap: 12px; height: 52px; margin: 6px 14px; padding: 0 6px 0 14px; border-radius: 10px; background: var(--panel); color: var(--t2); font-size: 13px; }
.hi-undo span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.undo { flex: none; height: 40px; padding: 0 12px; color: var(--t1); font-size: 14px; font-weight: 600; transition: opacity var(--dur-1) var(--ease-out); }
.undo:active { opacity: .6; }

.em-ic { width: 34px; height: 34px; margin: 0 auto 12px; color: #4a4a4a; stroke-width: 1.6; }
.em-sub { margin-top: 6px; color: var(--t-sub); font-size: 12px; }

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

/* iOS 14 / 安卓 WebView 87 不认 aspect-ratio（Safari 15、Chrome 88 才有）：里面全是绝对定位的东西，高度会是 0，用 ::before 的 padding 撑出同样的比例 */
@supports not (aspect-ratio: 1 / 1) {
  .hi-cv::before { content: ''; display: block; padding-top: 62.5%; }
}

/*
 * ---- 桌面布局（≥ 1024px）----
 * 铺满内容区的视频网格：公共的 .grid（最宽 --desk-max、两边 --desk-pad、按 --desk-card 自动排列数），和「我的收藏」、首页的网格
 * 同一个宽度、同样的列；标题行（BackHeader 默认和 .desk-wrap 的内容对齐）、组标题、卡片的左边缘对齐。卡片见 components/me/HistoryCard.vue。
 * 组标题（今天 / 昨天 / 更早）是网格里占满一整行的一项（16px / 600，和首页分区标题一样大）：离下面的卡片 16px，离上一组的卡片 52px
 * （负的下外边距吃掉一部分行距）。
 */
@media (min-width: 1024px) {
  /*
   * 标题行和网格对齐：网格在滚动区里，Windows 的常驻滚动条占掉右边一截。components/me/gutter.js 量出它的宽度（--sbw），
   * 标题行右边多让出这么宽（「清空」的右边缘和网格的右边缘对齐），网格到最宽、居中时也扣掉它再居中（和网格同一条中线）。
   * 和 BackHeader 默认的左右内边距是同一个算法，只是多扣了滚动条；没有滚动条时 --sbw 是 0，和默认一样
   */
  .history :deep(.sub-hd) {
    --hd-side: max(var(--desk-pad), calc((100% - var(--sbw, 0px) - var(--desk-max)) / 2 + var(--desk-pad)));
    padding: 0 calc(var(--hd-side) + var(--sbw, 0px)) 0 var(--hd-side);
  }
  .hd-n { font-size: 14px; }
  .hd-act { height: 36px; padding: 0 16px; border-radius: 18px; background: var(--chip); color: var(--t3); font-size: 14px; }
  .hd-act::after { inset: -4px; }

  .hg { position: relative; padding-top: 4px; }
  .hg-hd { grid-column: 1 / -1; margin: 24px 0 -12px; color: var(--t1); font-size: 16px; font-weight: 600; line-height: 24px; }
  .hg-hd.first { margin-top: 0; }
  /* 删掉的卡片、删空了的组标题：钉在原处（pin）淡出、缩一点；后面的补位只动 transform */
  .hg-move { transition: transform var(--dur-3) var(--ease-out); }
  .hg-leave-active { position: absolute; pointer-events: none; transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out); }
  .hg-leave-to { opacity: 0; transform: scale(.96); }
  /*
   * 离开的组标题：pin 量的是外边距以内的位置、相对网格的内边距边；绝对定位时外边距要清掉（不然往下多挪 24px），
   * 也不能再占「整行」（绝对定位的元素占着网格线时，定位的参照变成那一格，会往右多挪一个 --desk-pad）。
   * 标题和整行一样宽、字在最左边：按左边缩，字原地淡出（按中心缩会往右滑 20 多 px）
   */
  .hg-hd.hg-leave-active { grid-column: auto; margin: 0; transform-origin: 0 50%; }

  .em-ic { width: 40px; height: 40px; margin-bottom: 16px; }
  .em-sub { margin-top: 8px; font-size: 13px; }

  /* 骨架：一条组标题（和 .hg-hd 一样高、在同一个位置）+ 视频网格的骨架（第一行卡片的上沿和真网格对齐，数据回来时不跳） */
  .hg-sk-hd { max-width: var(--desk-max); margin: 0 auto; padding: 4px var(--desk-pad) 0; }
  .hg-sk-hd .sk { display: block; width: 40px; height: 16px; margin: 4px 0; }
  .hg-sk { padding-top: 16px; }
  /* 卡片有信息行时标题不固定占两行（VideoCard 的 .has-meta），骨架跟着：一行标题 + 信息行，和大多数卡片一样高 */
  .hg-sk :deep(.tt) { min-height: 0; }
}
@media (min-width: 1024px) and (hover: hover) {
  .hd-act { transition: background-color var(--dur-2) var(--ease-out), opacity var(--dur-1) var(--ease-out); }
  .hd-act:not(:disabled):hover { background: #1f1f1f; }
}
</style>
