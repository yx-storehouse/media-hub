<script setup>
import { ref, reactive, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { getMyFollows, getCreator, toggleFollow } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import { formatCount } from '@/utils/format'
import { createFeed } from '@/components/creator/feed'
import { useAutoMore } from '@/components/home/list'
import { useSnapshot } from '@/components/me/snapshot'
import BackHeader from '@/components/BackHeader.vue'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import ListFoot from '@/components/home/ListFoot.vue'
import ConfirmSheet from '@/components/me/ConfirmSheet.vue'

defineOptions({ name: 'FollowsView' })

/*
 * 我的关注（#/follows）：关注的创作者，最近关注的在前，滚到底自动加载。点头像 / 名字进创作者主页。
 * 「已关注」点了先确认再取消（文案和帖子详情、创作者主页的 UnfollowSheet 一致）；
 * 取消后这一行留在原处，按钮变回「关注」，点一下就能关注回来。
 */
const router = useRouter()
const auth = useAuthStore()

const feed = createFeed(page => getMyFollows(page))
const scroller = ref(null)
useAutoMore(scroller, feed)

/* 账号：null = 还在校验登录状态，0 = 未登录 */
const session = computed(() => (auth.ready ? auth.user?.id ?? 0 : null))

/* 在本页改过的关注状态：id -> { following, followers } */
const changed = reactive(new Map())
const busy = new Set()
const following = c => changed.get(c.id)?.following ?? true
const followers = c => changed.get(c.id)?.followers ?? c.followers ?? 0
const shownTotal = computed(() => Math.max(0, (feed.total ?? 0) - feed.list.filter(c => !following(c)).length))

function reload() {
  changed.clear()
  feed.reset()
  lastTop = 0
  if (scroller.value) scroller.value.scrollTop = 0
  if (session.value) feed.more()
}

/* ---------- 关注 / 取消关注 ---------- */

const asking = ref(false)
const target = shallowRef(null)

function onFollowBtn(c) {
  if (busy.has(c.id)) return
  if (following(c)) {
    // 取消关注先确认
    target.value = c
    asking.value = true
  } else {
    setFollow(c, true)
  }
}

async function setFollow(c, on) {
  if (!c || busy.has(c.id)) return
  const before = { following: following(c), followers: followers(c) }
  busy.add(c.id)
  changed.set(c.id, { following: on, followers: Math.max(0, before.followers + (on ? 1 : -1)) })
  try {
    const res = await toggleFollow(c.id, { on })
    const active = typeof res?.active === 'boolean' ? res.active : on
    const count = typeof res?.followers === 'number' ? res.followers : active === on ? changed.get(c.id).followers : before.followers
    changed.set(c.id, { following: active, followers: count })
    toast(active ? '已关注' : '已取消关注')
  } catch (e) {
    changed.set(c.id, before)
    toast(e?.status === 400 && e.message ? e.message : '操作失败，请稍后重试')
  } finally {
    busy.delete(c.id)
  }
}

const goCommunity = () => router.push('/community')

let opened = null
let lastTop = 0
const onScroll = e => { lastTop = e.target.scrollTop }

/* ---------- 返回恢复 ---------- */

const snap = useSnapshot('follows', () => auth.user?.id ?? 0)
const saved = snap.take()
if (saved) {
  feed.restore(saved.feed)
  for (const [id, v] of saved.changed) changed.set(id, v)
  lastTop = saved.top
}

/* 刚才点进去的那个创作者，可能在主页里取消 / 恢复了关注：静默核对一次 */
async function recheck(id) {
  if (id == null) return
  try {
    const d = await getCreator(id)
    if (busy.has(id) || typeof d?.following !== 'boolean') return
    changed.set(id, { following: d.following, followers: d.followers ?? 0 })
  } catch { /* 保持原样 */ }
}

watch(session, (now, before) => {
  if (now === null) return
  if (saved && before === undefined) return // 返回到本页：用恢复的列表
  reload()
}, { immediate: true })

onMounted(() => {
  if (!saved) return
  nextTick(() => { if (scroller.value) scroller.value.scrollTop = lastTop })
  recheck(saved.opened)
})

onBeforeUnmount(() => {
  if (!session.value || feed.total === null) return snap.keep(null)
  snap.keep({ feed: feed.snapshot(), changed: [...changed], top: lastTop, opened })
})
</script>

<template>
  <div class="page follows">
    <BackHeader>
      <span class="hd-tt">我的关注</span>
      <span v-if="session && feed.total" class="hd-n">{{ shownTotal }}</span>
    </BackHeader>

    <!-- 还在校验登录状态 / 第一页还没回来：骨架 -->
    <div v-if="session === null || (session && feed.total === null && !feed.error)" class="scroll" aria-busy="true">
      <div v-for="i in 7" :key="i" class="fl sk-row" aria-hidden="true">
        <div class="fl-av sk" />
        <div class="fl-bd"><div class="sk l1" /><div class="sk l2" /></div>
      </div>
    </div>

    <div v-else-if="!session" class="empty">
      <Icon name="tMe" class="em-ic" />
      登录后可以在这里看到关注的创作者
      <button type="button" class="retry" @click="auth.requireLogin()">去登录</button>
    </div>

    <div v-else-if="feed.total === null" class="empty">
      加载失败，请检查网络
      <button type="button" class="retry" @click="feed.more()">重试</button>
    </div>

    <div v-else-if="!feed.list.length" class="empty">
      <Icon name="tMe" class="em-ic" />
      还没有关注任何创作者
      <p class="em-sub">在帖子、创作者主页点「关注」，就能在这里找到 TA</p>
      <button type="button" class="retry" @click="goCommunity">去社区看看</button>
    </div>

    <div v-else ref="scroller" class="scroll" @scroll.passive="onScroll">
      <div class="fl-list">
        <div v-for="c in feed.list" :key="c.id" class="fl">
          <RouterLink class="fl-main" :to="`/creator/${encodeURIComponent(c.id)}`" @click="opened = c.id">
            <Cover class="fl-av" v-bind="c.avatar || {}" />
            <div class="fl-bd">
              <div class="fl-nm">
                <span>{{ c.name }}</span>
                <span v-if="c.verified" class="vf" role="img" aria-label="已认证"><Icon name="verified" /></span>
              </div>
              <div class="fl-meta">
                <template v-if="c.handle">@{{ c.handle }} · </template>{{ formatCount(followers(c)) }} 粉丝
              </div>
              <div v-if="c.bio" class="fl-bio">{{ c.bio }}</div>
            </div>
          </RouterLink>
          <button
            type="button"
            class="fl-btn"
            :class="{ on: following(c) }"
            :aria-pressed="following(c)"
            :aria-label="following(c) ? `已关注 ${c.name}，点按取消关注` : `关注 ${c.name}`"
            @click="onFollowBtn(c)"
          >
            <template v-if="following(c)">已关注</template>
            <template v-else><Icon name="plus" />关注</template>
          </button>
        </div>
      </div>
      <ListFoot :feed="feed" />
      <div class="pad-b" />
    </div>

    <ConfirmSheet
      v-model:open="asking"
      :title="`不再关注「${target?.name || ''}」？`"
      text="之后社区「关注」里不再显示 TA 的新帖子，随时可以重新关注。"
      ok="不再关注"
      danger
      @confirm="setFollow(target, false)"
    />
  </div>
</template>

<style scoped>
.hd-tt { white-space: nowrap; }
.hd-n { color: var(--t2); font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }

.fl-list { padding: 4px 0; }
.fl { display: flex; align-items: center; gap: 10px; padding-right: 14px; }
.fl-main { display: flex; flex: 1; align-items: center; gap: 12px; min-width: 0; padding: 11px 0 11px 14px; }
.fl-main:active { opacity: .75; }
.fl-av { flex: none; width: 48px; height: 48px; border-radius: 50%; background-color: #1a1a1a; filter: var(--media); }
.fl-bd { flex: 1; min-width: 0; }
.fl-nm { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: 15px; font-weight: 600; line-height: 21px; }
.fl-nm > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fl-nm .vf svg { width: 15px; height: 15px; }
.fl-meta { overflow: hidden; color: var(--t2); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.fl-bio { overflow: hidden; color: #6e6e6e; font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }

.fl-btn {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 70px;
  height: 30px;
  padding: 0 12px;
  border-radius: 15px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 700;
}
/* 按钮只有 30px 高：点按区域上下各放大 7px */
.fl-btn::after { content: ''; position: absolute; inset: -7px -4px; }
.fl-btn svg { width: 13px; height: 13px; stroke-width: 3; }
.fl-btn.on { background: var(--chip); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); color: var(--t2); font-weight: 500; }
.fl-btn:active { filter: brightness(.9); }

.em-ic { width: 34px; height: 34px; margin: 0 auto 12px; color: #4a4a4a; stroke-width: 1.6; }
.em-sub { margin-top: 6px; color: #6e6e6e; font-size: 12px; }

/* ---- 骨架 ---- */
.sk-row { padding: 11px 14px; gap: 12px; }
.sk { border-radius: 6px; background: #161616; animation: sk 1.2s ease-in-out infinite; }
.fl-av.sk { border-radius: 50%; }
.sk-row .l1 { width: 38%; height: 14px; }
.sk-row .l2 { width: 62%; height: 11px; margin-top: 9px; }
@keyframes sk { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}
</style>
