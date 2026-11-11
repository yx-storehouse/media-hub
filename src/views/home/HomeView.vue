<script setup>
import { computed, ref, watch, onActivated, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { HOME_TABS } from '@/config/nav'
import { isDesktop } from '@/composables/useDesktop'
import AppLogo from '@/components/AppLogo.vue'
import Icon from '@/components/Icon.vue'
import BottomSheet from '@/components/BottomSheet.vue'
import { useTabRetap } from '@/composables/useTabRetap'
import { useSlider, under, fadeIn, scrollBehavior } from '@/components/home/motion'
import { useScrollEdge } from '@/components/motion/scrollEdge'
import RecommendTab from './RecommendTab.vue'
import LatestTab from './LatestTab.vue'
import CategoryTab from './CategoryTab.vue'

defineOptions({ name: 'HomeView' })

const route = useRoute()
const router = useRouter()

/* This view stays alive under other pages, so it only follows the route while a home route is shown.
   The route pattern only accepts ids from HOME_TABS; unknown ids are redirected by the router. */
const tab = ref(route.params.tab)
watch(
  () => route.name === 'home' && route.params.tab,
  id => { if (id) tab.value = id }
)

/* Keep the active tab centred in the row. Detaching the view (KeepAlive) resets the row's
   scroll offset, so it is re-applied instantly whenever the view is shown again. */
const tabRow = ref(null)
function centerActiveTab(behavior) {
  const row = tabRow.value
  const el = row && row.querySelector('.tab.on')
  if (!el) return
  row.scrollTo({ left: Math.max(0, el.offsetLeft + el.offsetWidth / 2 - row.clientWidth / 2), behavior })
}
/* 换分类时放到下一帧开头再量（新分类页刚挂上，当场读位置会逼浏览器在点按的那一下里多排一遍版） */
watch(tab, () => requestAnimationFrame(() => centerActiveTab(scrollBehavior())), { flush: 'post' })
onActivated(() => centerActiveTab('auto'))

/* 选中分类下面的指示条：换分类时滑过去（先拉长再收拢），跟着标签一起横向滚动（桌面上字小一号，指示条也短一点，同社区的标签） */
const tabBar = ref(null)
const underMobile = under('.tab.on', 27)
const underDesk = under('.tab.on', 21)
useSlider(tabRow, tabBar, box => (isDesktop.value ? underDesk : underMobile)(box), { key: () => tab.value, deps: () => isDesktop.value, dur: '--dur-3' })

/* 当前该渲染哪个分类页：推荐 / 最新各有独立组件，其余共用一个组件、靠 tab 参数区分 */
const CATEGORY_VIEWS = { recommend: RecommendTab, latest: LatestTab }
const activeTab = computed(() => CATEGORY_VIEWS[tab.value] || CategoryTab)

/* 再点一次底部「首页」：当前分类页滚动过就平滑回到顶部，已经在顶部就刷新（推荐页整页换一批） */
const body = ref(null)
useTabRetap('home', () => body.value?.retap?.())

/*
 * 分类标签栏跟着滚动变化：内容往上滚过去时底边细线变亮、下面一道淡阴影（components/motion/scrollEdge.js）。
 * 只看紧贴在标签栏下面的滚动容器（分类页最上面就是 .scroll）；「最新」上面还有一条不动的日期栏，不算。
 */
const tabsEl = ref(null)
const edge = useScrollEdge(tabsEl, () => {
  const el = body.value?.$el
  const first = el instanceof Element ? el.firstElementChild : null
  return first && first.classList.contains('scroll') ? first : null
})
watch(tab, () => edge.refresh(), { flush: 'post' })

/* 换分类时新的分类页从切换的方向淡入一点（切回首页、KeepAlive 切回来时不动）；桌面上只淡入，不横移 */
const tabIndex = id => HOME_TABS.findIndex(t => t.id === id)
watch(tab, (now, before) => {
  const el = body.value?.$el
  if (el instanceof Element) fadeIn(el, { x: isDesktop.value ? 0 : tabIndex(now) > tabIndex(before) ? 12 : -12 })
}, { flush: 'post' })

/*
 * 桌面布局：标签行、「最新」的日期行在滚动区外面，网格在滚动区里面。Windows 上滚动区右边有一条滚动条（约 10px），
 * 网格居中时是在「滚动区宽 - 滚动条」里居中的，外面的行要按同样的宽度算才对得齐（超宽窗口才会居中，平时都贴 --desk-pad）。
 * 所以量出当前分类页滚动区的滚动条宽度，写到页面上的 --home-sb（样式里的 --home-x 用它）。手机上不写。
 */
const pageEl = ref(null)
let sbEl = null
const sbRo = typeof ResizeObserver === 'function' ? new ResizeObserver(() => syncSb()) : null
function syncSb() {
  const page = pageEl.value
  if (!page) return
  if (!isDesktop.value) {
    if (page.style.getPropertyValue('--home-sb')) page.style.removeProperty('--home-sb')
    return
  }
  const el = body.value?.$el
  const sc = el instanceof Element ? el.querySelector(':scope > .scroll') : null
  if (sc !== sbEl) {
    if (sbEl) sbRo?.unobserve(sbEl)
    sbEl = sc
    if (sc) sbRo?.observe(sc)
  }
  if (!sc || !sc.isConnected || !sc.clientWidth) return
  const w = `${sc.offsetWidth - sc.clientWidth}px`
  if (page.style.getPropertyValue('--home-sb') !== w) page.style.setProperty('--home-sb', w)
}
watch([tab, isDesktop], () => syncSb(), { flush: 'post' })
onMounted(syncSb)
onActivated(syncSb)
onBeforeUnmount(() => sbRo?.disconnect())

const sheetOpen = ref(false)
function chooseTab(id) {
  sheetOpen.value = false
  if (id !== tab.value) router.replace(`/home/${id}`)
}
</script>

<template>
  <div ref="pageEl" class="page home">
    <!-- 桌面布局里 Logo、搜索、历史、片库都在顶栏和左侧导航上：这一行不显示（m-only） -->
    <header class="hd m-only">
      <AppLogo />
      <RouterLink to="/search" class="sbox m-hold"><Icon name="search" />搜您想搜,看您所想</RouterLink>
      <button class="hi m-hold" @click="router.push('/history')"><Icon name="history" />历史</button>
      <button class="hi m-hold" @click="router.push('/library')"><Icon name="library" />片库</button>
    </header>

    <nav ref="tabsEl" class="tabs m-edge">
      <div ref="tabRow" class="row hs">
        <span ref="tabBar" class="m-bar tab-bar" aria-hidden="true" />
        <!-- replace: top tabs page within home like a pager, so back leaves home instead of walking the tabs -->
        <RouterLink
          v-for="t in HOME_TABS"
          :key="t.id"
          :to="`/home/${t.id}`"
          replace
          class="tab"
          :class="{ on: t.id === tab }"
          :aria-current="t.id === tab ? 'page' : undefined"
        >{{ t.name }}<Icon v-if="t.hot" name="flame" class="flame" /></RouterLink>
      </div>
      <button class="more m-hold" aria-label="全部分类" @click="sheetOpen = true"><Icon name="list" /><span class="d-only">全部分类</span></button>
    </nav>

    <!--
      每个分类页各自保留实例：切回来时滚动位置和筛选状态都还在。
      KeepAlive 只接受一个子节点，所以这里用 <component :is> 动态切换：
      组件类型或 key（分类页是 tab）一变就创建新实例，旧的进缓存。
    -->
    <KeepAlive>
      <component :is="activeTab" ref="body" :key="tab" :tab="tab" class="tab-body" />
    </KeepAlive>

    <BottomSheet v-model:open="sheetOpen" title="全部分类">
      <div class="opts">
        <button
          v-for="t in HOME_TABS"
          :key="t.id"
          class="opt"
          :class="{ on: t.id === tab }"
          :aria-pressed="t.id === tab"
          @click="chooseTab(t.id)"
        >
          {{ t.name }}
        </button>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
/* ---- header ---- */
.hd { display: flex; flex: none; align-items: center; height: 57px; padding: 0 11px 0 14px; }
.hd .logo { width: 50px; height: 35px; margin-right: 11px; }
.sbox {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 36px;
  padding-left: 15px;
  overflow: hidden;
  border-radius: 18px;
  background: var(--field);
  color: var(--t2);
  font-size: 14px;
  white-space: nowrap;
  cursor: text;
  transition: background-color var(--dur-2) var(--ease-out);
}
.sbox svg { width: 14px; height: 14px; color: var(--t2); stroke-width: 2.4; }
/* 按下的那一帧就亮一点（m-hold 加的 .m-pressed），松手淡回去 */
.sbox.m-pressed { background: #202020; transition-duration: var(--dur-1); }
.hi {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 34px;
  color: var(--t2);
  font-size: 10px;
  line-height: 12px;
}
.sbox + .hi { margin-left: 8px; }
.hi svg { width: 17px; height: 17px; transition: transform var(--dur-2) var(--ease-spring); }
/* 按下（全局按压反馈加上 .m-pressed）：图标缩一下，松手回弹 */
.hi.m-pressed svg { transform: scale(var(--press-scale-sm)); transition: transform var(--dur-1) var(--ease-out); }

/* ---- top tabs ---- */
.tabs { position: relative; flex: none; height: 44px; border-bottom: 1px solid var(--line); }
.tabs .row { position: relative; display: flex; align-items: center; gap: 28px; height: 100%; padding: 0 58px 0 14px; }
.tab {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  gap: 3px;
  color: var(--t2);
  font-size: 18px;
  font-weight: 500;
  line-height: 43px;
  white-space: nowrap;
  transition: color var(--dur-2) var(--ease-out), transform var(--dur-3) var(--ease-out);
}
/* 选中的分类字略放大（transform 不影响排版，旁边的标签不会被挤动） */
.tab.on { color: var(--t1); font-weight: 600; transform: scale(1.06); }
/* 指示条：位置由 useSlider 放，换分类时滑过去 */
.tab-bar { bottom: 3px; height: 3px; border-radius: 2px; background: var(--accent); }
.tab .flame { width: 14px; height: 16px; opacity: .85; }
/* "all categories" button over the faded end of the row */
.tabs .more {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 62px;
  padding-right: 14px;
  background: linear-gradient(90deg, rgba(10, 10, 10, 0), var(--bg) 42%);
  color: #d4d4d4;
}
.tabs .more svg { width: 19px; height: 19px; transition: transform var(--dur-2) var(--ease-spring); }
.tabs .more.m-pressed svg { transform: scale(var(--press-scale-sm)); transition: transform var(--dur-1) var(--ease-out); }

/* ---- tab bodies: fill the rest of the page, each owns its .scroll ---- */
.tab-body { display: flex; flex: 1; flex-direction: column; min-height: 0; }

/*
 * ---- 桌面布局（≥ 1024px）----
 * 自己的顶栏（Logo / 搜索 / 历史 / 片库）不显示（在桌面顶栏和左侧导航上），分类标签行就是页面最上面一行：
 * 64px 高、16px 字（同社区的标签行、BackHeader），8 个分类一行全部摆下，不用横着滚；点一下就切换。
 * --home-x：内容左边缘（和 .grid / .desk-wrap 同一个算法：至少 --desk-pad，超宽窗口跟着居中的 --desk-max 走；
 * 减去滚动区的滚动条宽度 --home-sb，见上面 syncSb）。标签行、「最新」的日期行都用它，左边和下面的网格对齐。
 * 「全部分类」是右端的小按钮，右边和网格右边缘对齐，打开居中的对话框（BottomSheet 在桌面上就是对话框）。
 * 平时没有底线，内容滚到标签行下面时才出现细线和淡阴影（m-edge）。
 */
@media (min-width: 1024px) {
  .home { --home-x: max(var(--desk-pad), calc((100% - var(--home-sb, 0px) - var(--desk-max)) / 2 + var(--desk-pad))); }
  .tabs { height: 64px; border-bottom-color: transparent; }
  .tabs .row { gap: 28px; padding: 0 calc(var(--home-x) + 120px) 0 var(--home-x); }
  .tab { font-size: 16px; line-height: 30px; }
  /* 键盘焦点框画在字外面（公共的 .hs 规则往里收 2px，标签和字一样宽，框会压在字上）；64px 高的行里上下都放得下 */
  .tab:focus-visible { border-radius: 4px; outline-offset: 4px; }
  .tab .flame { width: 13px; height: 15px; }
  /* 指示条压在字下面 6px（同社区的 .ct-tab） */
  .tab-bar { bottom: 11px; }
  .tabs .more {
    top: 16px;
    right: calc(var(--home-sb, 0px) + var(--home-x));
    bottom: auto;
    gap: 6px;
    width: auto;
    height: 32px;
    margin-right: -12px;
    padding: 0 12px 0 10px;
    border-radius: 16px;
    background: none;
    color: var(--t2);
    font-size: 13px;
    font-weight: 500;
  }
  .tabs .more svg { width: 16px; height: 16px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .tabs .more { transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out); }
  .tabs .more:hover { background: #1f1f1f; color: var(--t3); }
  .tab:not(.on):hover { color: var(--t3); }
}
</style>
