<script setup>
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KEEP_ALIVE_VIEWS } from '@/config/nav'
import { connectAuthToRouter } from '@/stores/auth'
import { usePageTransition, beforePageEnter } from '@/components/motion/pageTransition'
import { isDesktop } from '@/composables/useDesktop'
import { deskSide, bindDeskSide } from '@/composables/useDeskSide'
import TabBar from '@/components/TabBar.vue'
import AppToast from '@/components/AppToast.vue'
import LoginSheet from '@/components/LoginSheet.vue'
import DeskTopBar from '@/components/desk/DeskTopBar.vue'
import DeskSidebar from '@/components/desk/DeskSidebar.vue'

const route = useRoute()
const router = useRouter()
/* 底部导航只在手机布局里有；桌面布局（≥ 1024px）是顶栏 + 左侧导航 */
const showTabbar = computed(() => !!route.meta.tabbar && !isDesktop.value)
/* 登录后的跳转（requireLogin 的 redirect）走这个路由 */
connectAuthToRouter(router)
/*
 * 页面切换的动效名（pg-fwd / pg-back / pg-tab / pg-hero / pg-hero-back / '' 不动；桌面布局上前三种是 pgd），
 * 见 components/motion/pageTransition.js，样式在 styles/motion.css
 */
const pageAnim = usePageTransition(router)

/*
 * 桌面布局的左侧导航：展开 / 图标栏跟着路由走（播放页、短视频默认收起），宽度通过 <html>.desk-rail 给 --desk-side，
 * 见 composables/useDeskSide.js。
 * 换页时导航宽度变了（比如从首页进播放页）：所有页面的 left 都跟着 --desk-side 变，正在离开的那页会先横着跳一下
 * 再被新页盖住（共享元素过渡时它整页都还看得见）。所以离开的那页钉在原来的位置（行内 left），离场结束再去掉。
 * shownSide 是「现在屏幕上的页面按多宽的导航排的」：每次渲染完更新，换页那一轮渲染里读到的还是旧值。
 */
bindDeskSide(route)
let shownSide = deskSide.width
watch(() => [route.fullPath, isDesktop.value, deskSide.width], () => { shownSide = deskSide.width }, { flush: 'post' })
function onPageLeave(el) {
  if (!isDesktop.value || !(el instanceof HTMLElement) || shownSide === deskSide.width) return
  el.style.left = `${shownSide}px`
  /*
   * 导航变宽了（从播放页、短视频回来，图标栏 → 展开）：离开的那页还按窄导航排着，左边那一截会被一下子展开的导航盖住
   * （标题、关注按钮被切掉，导航的字压在飞回去的封面下面）。离场的这一小会儿让它浮到导航上面（和导航同一层、
   * DOM 里排在后面；仍在顶栏下面），它淡出时导航从下面露出来。导航本身不动、不加动画。
   * 浮上来的旧页这时也盖在新页上面：不接鼠标（点到的是下面的新页和导航，和平时离开中的页面一样）。
   */
  if (shownSide < deskSide.width) raise(el)
}
function raise(el) {
  el.style.zIndex = '43'
  el.style.pointerEvents = 'none'
}
function unpin(el) {
  if (!(el instanceof HTMLElement)) return
  if (el.style.left) el.style.left = ''
  if (el.style.zIndex === '43') {
    el.style.zIndex = ''
    el.style.pointerEvents = ''
  }
}
function onPageEnter(el) {
  unpin(el)
  beforePageEnter(el)
}
</script>

<template>
  <div class="shell">
    <!-- 桌面布局：顶栏 + 左侧导航（放在页面前面：键盘 Tab 的顺序是顶栏 → 导航 → 内容）；手机布局里不渲染 -->
    <DeskTopBar v-if="isDesktop" />
    <DeskSidebar v-if="isDesktop" />
    <!--
      bottom-tab pages stay alive in the background: instant switching, scroll position and state kept.
      切换时新旧两页同时在场（各自的滚动位置不动），离开的那页播完动画才收起 / 卸载。
      with-tabbar 跟着每一页走（不放在外层）：进子页面时，正在滑走的 Tab 页底部不会突然空出导航栏的位置。
      before-enter：Tab 之间切换时把方向（--pg-dir）写到进来的那一页上，新页从那一侧滑进来。
      before-leave / after-leave：桌面上换页时导航宽度变了，离开的那页钉在原位（见上面 onPageLeave）。
    -->
    <RouterView v-slot="{ Component, route: r }">
      <Transition
        :name="pageAnim"
        :css="!!pageAnim"
        @before-enter="onPageEnter"
        @before-leave="onPageLeave"
        @after-leave="unpin"
        @leave-cancelled="unpin"
      >
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
/* 桌面布局没有底部导航：页面一直铺到窗口底边（顶栏、左侧导航的位置见 styles/base.css 的 .page） */
@media (min-width: 1024px) {
  .page.with-tabbar { bottom: 0; }
}
</style>
