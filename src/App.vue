<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KEEP_ALIVE_VIEWS } from '@/config/nav'
import { connectAuthToRouter } from '@/stores/auth'
import { usePageTransition, beforePageEnter } from '@/components/motion/pageTransition'
import TabBar from '@/components/TabBar.vue'
import AppToast from '@/components/AppToast.vue'
import LoginSheet from '@/components/LoginSheet.vue'

const route = useRoute()
const router = useRouter()
const showTabbar = computed(() => !!route.meta.tabbar)
/* 登录后的跳转（requireLogin 的 redirect）走这个路由 */
connectAuthToRouter(router)
/*
 * 页面切换的动效名（pg-fwd / pg-back / pg-tab / pg-hero / pg-hero-back / '' 不动），
 * 见 components/motion/pageTransition.js，样式在 styles/motion.css
 */
const pageAnim = usePageTransition(router)
</script>

<template>
  <div class="shell">
    <!--
      bottom-tab pages stay alive in the background: instant switching, scroll position and state kept.
      切换时新旧两页同时在场（各自的滚动位置不动），离开的那页播完动画才收起 / 卸载。
      with-tabbar 跟着每一页走（不放在外层）：进子页面时，正在滑走的 Tab 页底部不会突然空出导航栏的位置。
      before-enter：Tab 之间切换时把方向（--pg-dir）写到进来的那一页上，新页从那一侧滑进来。
    -->
    <RouterView v-slot="{ Component, route: r }">
      <Transition :name="pageAnim" :css="!!pageAnim" @before-enter="beforePageEnter">
        <KeepAlive :include="KEEP_ALIVE_VIEWS">
          <component :is="Component" :class="{ 'with-tabbar': !!r.meta.tabbar }" />
        </KeepAlive>
      </Transition>
    </RouterView>
    <!-- 底部导航和 Tab 页一起滑走、一起回来（Tab 之间切换时它不动；共享元素过渡时往下收起 / 弹回来） -->
    <Transition :name="pageAnim" :css="!!pageAnim">
      <TabBar v-if="showTabbar" />
    </Transition>
    <AppToast />
    <LoginSheet />
  </div>
</template>

<style>
/* 有底部导航的页面（路由 meta.tabbar）给导航栏让出位置 */
.page.with-tabbar { bottom: calc(var(--tabbar-h) + var(--safe-b)); }
</style>
