<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { MAIN_TABS, isHomePath } from '@/config/nav'
import { emitTabRetap } from '@/composables/useTabRetap'
import Icon from './Icon.vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const current = computed(() => route.meta.tab)
/* the home tab returns to whichever home sub-tab was open last */
const target = t => (t.id === 'home' ? `/home/${store.lastHomeTab}` : t.path)

/*
 * 返回键先回首页，再按一次才离开（和抖音、B 站一样）：
 *   - 从首页切到别的 Tab：压栈，首页留在下面；
 *   - 非首页 Tab 之间：替换，返回键不在 Tab 之间来回跳，下面始终是首页；
 *   - 切回首页 / 切到下面那条记录：退回去，不叠重复记录。
 * 一打开就落在非首页 Tab（书签、分享链接）时，路由会在下面垫一条首页（router/index.js）。
 * 点当前所在的 Tab 是「再点一次」（短视频页借此刷新）。
 */
function go(t) {
  const to = target(t)
  if (to === route.fullPath) return emitTabRetap(t.id)
  const back = window.history.state && window.history.state.back
  if (route.meta.tab === 'home') router.push(to)
  else if (back === to || (t.id === 'home' && isHomePath(back))) router.back()
  else router.replace(to)
}
</script>

<template>
  <nav class="tabbar">
    <RouterLink v-for="t in MAIN_TABS" :key="t.id" v-slot="{ href }" :to="target(t)" custom>
      <a
        :href="href"
        class="tb-i"
        :class="{ on: current === t.id }"
        :aria-current="current === t.id ? 'page' : undefined"
        @click.prevent="go(t)"
      >
        <Icon :name="current === t.id ? t.icon + 'On' : t.icon" />
        <span>{{ t.label }}</span>
      </a>
    </RouterLink>
  </nav>
</template>

<style>
.tabbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  height: calc(var(--tabbar-h) + var(--safe-b));
  padding-bottom: var(--safe-b);
  background: var(--bg);
  border-top: 1px solid var(--field);
}
.tb-i {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding-top: 10px;
  color: var(--t2);
  font-size: 12px;
  line-height: 17px;
  font-weight: 500;
}
.tb-i svg { width: 22px; height: 22px; }
.tb-i.on { color: var(--accent); font-weight: 600; }
</style>
