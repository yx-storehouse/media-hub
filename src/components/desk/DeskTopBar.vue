<script setup>
import { deskSide, toggleDeskSide } from '@/composables/useDeskSide'
import { useDeskNav } from './deskNav'
import AppLogo from '@/components/AppLogo.vue'
import Icon from '@/components/Icon.vue'
import DeskSearch from './DeskSearch.vue'
import DeskAccount from './DeskAccount.vue'

/*
 * 桌面布局的顶栏（只在桌面布局时由 App.vue 渲染）：横跨整个窗口，高 --desk-top（56px），换页时不动。
 *   左：☰（左侧导航展开 / 收起）、Logo（回首页，和点左侧「首页」一样）
 *   中：搜索框（窗口正中，最宽约 560px，DeskSearch.vue）
 *   右：登录按钮 / 头像菜单（DeskAccount.vue）
 */
const { hrefOf, open } = useDeskNav()
const HOME = { tab: 'home' }
</script>

<template>
  <header class="dtop">
    <div class="dt-l">
      <button
        type="button"
        class="dt-menu"
        :aria-label="deskSide.rail ? '展开导航' : '收起导航'"
        :title="deskSide.rail ? '展开导航' : '收起导航'"
        aria-controls="desk-side"
        :aria-expanded="!deskSide.rail"
        @click="toggleDeskSide"
      >
        <Icon name="menu" />
      </button>
      <a :href="hrefOf(HOME)" class="dt-logo" aria-label="Reel 首页" draggable="false" @click="open(HOME, $event)">
        <AppLogo aria-hidden="true" />
        <span class="dt-word" aria-hidden="true">Reel</span>
      </a>
    </div>
    <div class="dt-c"><DeskSearch /></div>
    <div class="dt-r"><DeskAccount /></div>
  </header>
</template>

<style scoped>
.dtop {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 44;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 640px) minmax(0, 1fr);
  align-items: center;
  height: var(--desk-top);
  padding: 0 20px 0 16px;
  background: var(--bg);
  -webkit-user-select: none;
  user-select: none;
}
.dt-l { display: flex; align-items: center; gap: 12px; min-width: 0; }
/* ☰ 的中心和图标栏的图标对齐（图标栏 72px 宽，中心在 36px） */
.dt-menu {
  display: grid;
  flex: none;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--t3);
  transition: background-color var(--dur-2) var(--ease-out);
}
.dt-menu svg { width: 22px; height: 22px; }
.dt-logo { display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 6px 0 2px; border-radius: 10px; transition: opacity var(--dur-2) var(--ease-out); }
.dt-logo .logo { width: 44px; height: 31px; }
.dt-word { color: var(--t1); font-size: 20px; font-weight: 700; letter-spacing: -.3px; line-height: 1; }
.dt-c { display: flex; justify-content: center; min-width: 0; padding: 0 24px; }
.dt-r { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }

@media (hover: hover) {
  .dt-menu:hover { background: var(--chip); color: var(--t1); }
  .dt-logo:hover { opacity: .82; }
}
</style>
