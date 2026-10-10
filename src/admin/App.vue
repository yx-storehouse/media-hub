<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { session, logout } from './auth'
import { NAV } from './nav'
import AIcon from './components/AIcon.vue'
import ABtn from './components/ABtn.vue'
import ToastHost from './components/ToastHost.vue'
import ConfirmHost from './components/ConfirmHost.vue'
import { trapTab } from './components/layers'
import { metaStatus, refreshMeta } from './composables/useMeta'

/*
 * 后台外壳：左侧导航（220px）+ 右侧内容区（各页面自己负责页头和滚动）。
 * 窗口窄于 900px 时导航收成抽屉，由顶栏的菜单按钮打开：打开时焦点移进导航、Tab 只在导航里循环、
 * 内容区 inert；关闭（Esc / 遮罩 / × / 点了导航项）后焦点回到菜单按钮。登录页不显示外壳。
 */
const route = useRoute()
const navOpen = ref(false)
const bare = computed(() => !!route.meta.public)
const initial = computed(() => [...(session.user?.name || session.user?.uid || '管')][0])
const sideEl = ref(null)
const burgerEl = ref(null)

watch(() => route.fullPath, () => { navOpen.value = false })

function onKey(e) {
  if (!navOpen.value) return
  if (e.key === 'Escape') { e.preventDefault(); navOpen.value = false }
  else if (e.key === 'Tab') trapTab(e, sideEl.value)
}
watch(navOpen, v => {
  if (v) {
    document.addEventListener('keydown', onKey)
    // 焦点放到当前页对应的导航项（没有就第一项）
    ;(sideEl.value?.querySelector('.nav-item.on') || sideEl.value?.querySelector('.nav-item'))?.focus()
  } else {
    document.removeEventListener('keydown', onKey)
    // 焦点还在导航里（导航马上会隐藏，焦点会掉到 body）：还给菜单按钮
    const a = document.activeElement
    if (!a || a === document.body || sideEl.value?.contains(a)) burgerEl.value?.focus()
  }
}, { flush: 'post' }) // 等 DOM 更新完（内容区去掉 inert）再移焦点
/* 窗口拉宽到 900px 以上：导航变回常驻侧栏，抽屉状态作废 */
let mq = null
const onMq = e => { if (e.matches) navOpen.value = false }
onMounted(() => {
  mq = window.matchMedia?.('(min-width: 900px)') || null
  mq?.addEventListener?.('change', onMq)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  mq?.removeEventListener?.('change', onMq)
})

/* 基础数据（专题 / 创作者 / 分类 / 地区）没加载成功：顶部提示 + 重试，否则各页下拉框是空的 */
const metaFailed = computed(() => !bare.value && !!metaStatus.error.value && !metaStatus.loaded.value)
</script>

<template>
  <div v-if="bare" class="bare">
    <RouterView />
  </div>

  <div v-else class="shell" :class="{ 'nav-open': navOpen }">
    <aside id="admin-nav" ref="sideEl" class="side" aria-label="主导航">
      <div class="brand">
        <span class="logo" aria-hidden="true">R</span>
        <span class="brand-t">Reel 管理后台</span>
        <button type="button" class="side-x" aria-label="收起导航" @click="navOpen = false">
          <AIcon name="x" :size="16" />
        </button>
      </div>

      <nav class="nav">
        <RouterLink
          v-for="n in NAV"
          :key="n.name"
          :to="n.to"
          class="nav-item"
          :class="{ on: route.name === n.name }"
          :aria-current="route.name === n.name ? 'page' : undefined"
        >
          <AIcon :name="n.icon" :size="17" />
          <span>{{ n.label }}</span>
        </RouterLink>
      </nav>

      <div class="foot">
        <a class="nav-item" href="./index.html" target="_blank" rel="noopener">
          <AIcon name="external" :size="17" />
          <span>打开前台</span>
        </a>
        <div class="me">
          <span class="avatar" aria-hidden="true">{{ initial }}</span>
          <span class="me-txt">
            <span class="me-name ellipsis">{{ session.user?.name || '管理员' }}</span>
            <span class="me-uid ellipsis">@{{ session.user?.uid }}</span>
          </span>
          <button type="button" class="out" title="退出登录" @click="logout">
            <AIcon name="logout" :size="15" />
            <span>退出</span>
          </button>
        </div>
      </div>
    </aside>

    <div v-if="navOpen" class="scrim" aria-hidden="true" @click="navOpen = false" />

    <div class="main-col" :inert="navOpen || undefined">
      <header class="topbar">
        <button ref="burgerEl" type="button" class="burger" aria-controls="admin-nav" :aria-expanded="navOpen ? 'true' : 'false'" aria-label="打开导航" @click="navOpen = true">
          <AIcon name="menu" :size="20" />
        </button>
        <span class="tb-title">{{ route.meta.title || 'Reel 管理后台' }}</span>
      </header>
      <div v-if="metaFailed" class="meta-bar" role="alert">
        <AIcon name="warning" :size="15" />
        <span class="grow">基础数据（专题、创作者、分类、地区）加载失败：{{ metaStatus.error.value }}。相关下拉框暂时是空的。</span>
        <ABtn size="sm" icon="refresh" :loading="metaStatus.loading.value" @click="refreshMeta()">重试</ABtn>
      </div>
      <main class="main">
        <RouterView v-slot="{ Component }">
          <component :is="Component" :key="route.path" />
        </RouterView>
      </main>
    </div>
  </div>

  <ToastHost />
  <ConfirmHost />
</template>

<style scoped>
.bare { min-height: 100vh; }

.shell { display: flex; height: 100vh; overflow: hidden; }
@supports (height: 100dvh) {
  .shell { height: 100dvh; }
}

/* ---- 侧边栏 ---- */
.side {
  display: flex;
  flex: none;
  flex-direction: column;
  width: var(--sidebar-w);
  border-right: 1px solid var(--line);
  background: #0e0e0e;
}
.brand { display: flex; flex: none; align-items: center; gap: 10px; height: 60px; padding: 0 18px; }
.logo { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; background: var(--accent); color: var(--on-accent); font-size: 15px; font-weight: 800; }
.brand-t { font-size: 14.5px; font-weight: 650; letter-spacing: .02em; white-space: nowrap; }
.side-x { display: none; place-items: center; width: 28px; height: 28px; margin-left: auto; border-radius: 6px; color: var(--t2); }

.nav { display: flex; flex: 1; flex-direction: column; gap: 2px; min-height: 0; padding: 6px 10px; overflow-y: auto; }
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  height: 36px;
  padding: 0 12px;
  border-radius: 7px;
  color: var(--t2);
  font-size: 13.5px;
  white-space: nowrap;
  transition: background .12s, color .12s;
}
.nav-item:hover { background: #171717; color: var(--t1); }
.nav-item.on { background: var(--hover); color: var(--t1); font-weight: 600; }
.nav-item.on::before { content: ''; position: absolute; top: 9px; bottom: 9px; left: -10px; width: 3px; border-radius: 0 2px 2px 0; background: var(--accent); }
.nav-item:focus-visible { outline-offset: -2px; }

.foot { flex: none; padding: 8px 10px 12px; border-top: 1px solid var(--line); }
.me { display: flex; align-items: center; gap: 9px; margin-top: 6px; padding: 6px 4px 0 8px; }
.avatar { display: grid; flex: none; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: #2a2a2a; color: var(--t1); font-size: 12.5px; font-weight: 600; }
.me-txt { display: flex; flex: 1; flex-direction: column; min-width: 0; line-height: 1.3; }
.me-name { font-size: 12.5px; font-weight: 500; }
.me-uid { color: var(--t3); font-size: 11.5px; }
.out { display: inline-flex; flex: none; align-items: center; gap: 4px; height: 26px; padding: 0 8px; border-radius: 6px; color: var(--t2); font-size: 12px; }
.out:hover { background: var(--hover); color: var(--t1); }

/* ---- 内容区 ---- */
.main-col { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.topbar { display: none; flex: none; align-items: center; gap: 8px; height: 48px; padding: 0 12px; border-bottom: 1px solid var(--line); background: #0e0e0e; }
.burger { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 7px; color: var(--t1); }
.burger:hover { background: var(--hover); }
.tb-title { font-weight: 600; }
.main { position: relative; flex: 1; min-height: 0; overflow: auto; }
.meta-bar { display: flex; flex: none; align-items: center; gap: 10px; padding: 8px 16px 8px 24px; border-bottom: 1px solid rgba(255, 107, 107, .3); background: rgba(255, 107, 107, .08); color: var(--t1); font-size: 12.5px; }
.meta-bar > svg { color: var(--danger); }

.scrim { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, .55); }

/* 窄屏：导航变成抽屉 */
@media (max-width: 899px) {
  .side {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 100;
    width: min(260px, 82vw);
    box-shadow: var(--shadow);
    transform: translateX(-102%);
    visibility: hidden;
    transition: transform .2s ease, visibility 0s linear .2s;
  }
  .nav-open .side { transform: none; visibility: visible; transition: transform .2s ease; }
  .side-x { display: grid; }
  .topbar { display: flex; }
}
</style>
