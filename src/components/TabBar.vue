<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { MAIN_TABS } from '@/config/nav'
import Icon from './Icon.vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const current = computed(() => route.meta.tab)
/* the home tab returns to whichever home sub-tab was open last */
const target = t => (t.id === 'home' ? `/home/${store.lastHomeTab}` : t.path)

/*
 * Switching bottom tabs replaces the history entry like a native tab bar, so back leaves the
 * section instead of cycling through tabs. If the previous entry already is the target, step
 * back to it rather than stacking a duplicate.
 */
function go(t) {
  const to = target(t)
  if (to === route.fullPath) return
  if (window.history.state && window.history.state.back === to) router.back()
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
