<script>
/*
 * 返回恢复（做法同 CreatorView）：片库不常驻，点进专题再返回时，用离开前的列表和滚动位置原样放回，
 * 不重新请求，也不回到顶部。只在「返回到这条历史记录」时恢复（history.state.forward 有值）。
 */
const snapshots = new Map()
const SNAPSHOT_TTL = 10 * 60 * 1000
const SNAPSHOT_MAX = 4
</script>

<script setup>
import { ref, shallowRef, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { getLibrary } from '@/api'
import BackHeader from '@/components/BackHeader.vue'
import Cover from '@/components/Cover.vue'

defineOptions({ name: 'LibraryView' })

const scrollEl = ref(null)
/* null = 还没取到（显示骨架） */
const categories = shallowRef(null)
const failed = ref(false)
let lastTop = 0
let loadSeq = 0

async function load() {
  const token = ++loadSeq
  failed.value = false
  try {
    const list = await getLibrary()
    if (token === loadSeq) categories.value = list
  } catch {
    if (token === loadSeq) failed.value = true
  }
}

function onScroll() {
  if (scrollEl.value) lastTop = scrollEl.value.scrollTop
}

/* ---------- 返回恢复 ---------- */

const snapKey = window.history.state?.position ?? ''

function saveSnapshot() {
  if (!categories.value || failed.value) return
  snapshots.delete(snapKey)
  snapshots.set(snapKey, { at: Date.now(), categories: categories.value, top: lastTop })
  while (snapshots.size > SNAPSHOT_MAX) snapshots.delete(snapshots.keys().next().value)
}

function restoreSnapshot() {
  const s = window.history.state?.forward ? snapshots.get(snapKey) : null
  snapshots.delete(snapKey)
  if (!s || Date.now() - s.at > SNAPSHOT_TTL) return false
  categories.value = s.categories
  lastTop = s.top
  return true
}

const restored = restoreSnapshot()
if (!restored) load()

onMounted(() => {
  if (restored) nextTick(() => { if (scrollEl.value) scrollEl.value.scrollTop = lastTop })
})
onBeforeUnmount(saveSnapshot)
</script>

<template>
  <div class="page library">
    <BackHeader title="片库" />
    <div v-if="failed" class="empty">
      加载失败，请稍后重试
      <button type="button" class="retry" @click="load()">重试</button>
    </div>
    <div v-else ref="scrollEl" class="scroll" @scroll.passive="onScroll">
      <div v-if="!categories" class="cat-grid" aria-hidden="true">
        <div v-for="i in 8" :key="i" class="cat sk" />
      </div>
      <div v-else-if="!categories.length" class="empty">片库里还没有专题</div>
      <div v-else class="cat-grid">
        <RouterLink v-for="c in categories" :key="c.id" :to="`/topic/${c.id}`">
          <Cover class="cat" v-bind="c.cover">
            <b>{{ c.name }}</b>
            <span>{{ c.count }}部</span>
          </Cover>
        </RouterLink>
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
.cat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px 14px; padding: 14px; }
.cat {
  display: flex;
  align-items: flex-end;
  aspect-ratio: 16 / 8;
  padding: 10px 12px;
  border-radius: 10px;
  filter: var(--media);
}
/* bottom shade for the label; z-index keeps it (and the text) above the lazily loaded photo */
.cat::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 30%, rgba(0, 0, 0, .65));
}
.cat b { position: relative; z-index: 1; font-size: 14px; font-weight: 700; }
.cat span { position: relative; z-index: 1; margin-left: auto; font-size: 11px; opacity: .78; }
/* 骨架：和卡片一样大的灰块 */
.cat.sk { position: relative; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.cat.sk::before { content: none; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .cat.sk { animation: none; }
}
</style>
