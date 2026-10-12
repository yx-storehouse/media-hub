<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KEEP_ALIVE_VIEWS } from '@/config/nav'
import { connectAuthToRouter } from '@/stores/auth'
import TabBar from '@/components/TabBar.vue'
import AppToast from '@/components/AppToast.vue'
import LoginSheet from '@/components/LoginSheet.vue'

const route = useRoute()
const showTabbar = computed(() => !!route.meta.tabbar)
/* 登录后的跳转（requireLogin 的 redirect）走这个路由 */
connectAuthToRouter(useRouter())
</script>

<template>
  <div class="shell" :class="{ 'has-tabbar': showTabbar }">
    <!-- bottom-tab pages stay alive in the background: instant switching, scroll position and state kept -->
    <RouterView v-slot="{ Component }">
      <KeepAlive :include="KEEP_ALIVE_VIEWS">
        <component :is="Component" />
      </KeepAlive>
    </RouterView>
    <TabBar v-if="showTabbar" />
    <AppToast />
    <LoginSheet />
  </div>
</template>
