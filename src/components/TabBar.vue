<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { MAIN_TABS, isHomePath } from '@/config/nav'
import { emitTabRetap } from '@/composables/useTabRetap'
import { haptic, reducedMotion } from '@/utils/motion'
import { createTabMotion, resetTokens } from '@/components/tabbar/tabMotion'
import Icon from './Icon.vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
/* the home tab returns to whichever home sub-tab was open last */
const target = t => (t.id === 'home' ? `/home/${store.lastHomeTab}` : t.path)
const indexOf = id => MAIN_TABS.findIndex(t => t.id === id)

/*
 * 底部导航的动效（引擎在 components/tabbar/tabMotion.js）：
 *   按下    图标立刻沉一点（.88），标签下的小光点朝这格探一下身；
 *   松手    图标带一点回弹浮起来，实心图标从中心长出来盖住描边，文字由灰变白；
 *           光点被弹簧牵着滑过去（起步拉成一道细长的光痕，落地收回成一粒），其余几格轻轻暗一下；
 *   划走    手指移出这一格就取消：图标安静地弹回、光点收回，不切换；
 *   再点    图标轻跳一下、光点呼吸一次，照常发「再点一次」（回顶 / 刷新）。
 * 打开 App、从子页面回来（导航栏重新挂载）什么都不动：静止状态只由 .on 和 --i 决定。
 *
 * sel 是「看起来选中的」Tab：点下去立刻变（乐观），路由随后跟上；路由没跟上（被守卫拦下、改道）时以路由为准。
 */
const sel = ref(route.meta.tab || MAIN_TABS[0].id)
const selIndex = computed(() => Math.max(0, indexOf(sel.value)))
const navEl = ref(null)
let motion = null
let alive = true
let selectedAt = -1e9

/* 连点不连震：100ms 内只震一次（iOS 没有这个接口，静默） */
let lastBuzz = 0
function buzz(ms) {
  const now = performance.now()
  if (now - lastBuzz < 100) return
  lastBuzz = now
  haptic(ms)
}

/** 换选中：class / aria-current / --i 跟着 sel 在这一帧画出来，动画在同一个任务里建好盖在上面 */
function select(id, how) {
  const i = indexOf(id)
  const old = selIndex.value
  if (i < 0 || id === sel.value) return
  sel.value = id
  selectedAt = performance.now()
  // 路由驱动的变化碰上导航栏正在进出场（App.vue 的 <Transition>）：不播选中动画，直接是新状态
  const still = how === 'route' && navEl.value && /-(enter|leave)-active/.test(navEl.value.className)
  if (still) motion?.snapAll(i)
  else motion?.select(i, old, how)
}

/* ---------- 导航：先把动画交给合成线程（这一帧提交之后），再让路由渲染新页面 ---------- */

/*
 * 新页面第一次渲染是一个长任务（低端机上 70–180ms）：要是先导航，导航栏在这段时间里一帧都不动。
 * 所以点击时只改选中、建好动画，下一帧画出来之后再导航（新页面晚约 16ms 开始渲染）。
 * 万一 requestAnimationFrame 迟迟不来（页面被挂起），100ms 后照样导航。
 */
function afterCommit(fn) {
  let done = false
  const run = () => { if (done) return; done = true; clearTimeout(fb); fn() }
  const fb = setTimeout(run, 100)
  requestAnimationFrame(() => setTimeout(run, 0))
}

/*
 * 返回键先回首页，再按一次才离开（和抖音、B 站一样）：
 *   - 从首页切到别的 Tab：压栈，首页留在下面；
 *   - 非首页 Tab 之间：替换，返回键不在 Tab 之间来回跳，下面始终是首页；
 *   - 切回首页 / 切到下面那条记录：退回去，不叠重复记录。
 * 一打开就落在非首页 Tab（书签、分享链接）时，路由会在下面垫一条首页（router/index.js）。
 *
 * 连点时只有最后点的那个算数（pendingTab 一个槽），压栈 / 替换 / 退回在真正导航的那一刻按当时的路由和 history.state 决定。
 * 上一次压栈 / 替换还在路上（新页面的代码还没到）时直接顶掉它（路由自己会取消旧的那次）；只有退回（popstate，取消不了）
 * 要等它落地。全部跑完后路由和 sel 不一致（被守卫拦下、改道）就以路由为准。
 */
let pendingTab = null
let flushQueued = false
let navBusy = false   // 我们发起的导航还在路上（这期间路由的变化不当成「外面来的」）
let navSeq = 0
let popWait = 0       // 等退回落地的计时器

function schedule() {
  if (flushQueued || popWait) return
  if (reducedMotion()) return flush()
  flushQueued = true
  afterCommit(flush)
}
function queueNav(t) {
  pendingTab = t
  schedule()
}
function flush() {
  flushQueued = false
  if (!alive || popWait) return
  const t = pendingTab
  pendingTab = null
  // 这一帧里已经去了别的页面（子页面、登录跳转）：不再切 Tab
  if (!t || !route.meta.tab) return
  const to = target(t)
  if (to === route.fullPath && !navBusy) return reconcile()
  const seq = ++navSeq
  const done = () => settle(seq)
  const back = window.history.state && window.history.state.back
  navBusy = true
  // 点回了还没离开的那个 Tab：重复导航到原地，顶掉还在路上的那次（不改历史记录）
  if (to === route.fullPath) router.replace(to).catch(() => {}).finally(done)
  else if (route.meta.tab === 'home') router.push(to).catch(() => {}).finally(done)
  else if (back === to || (t.id === 'home' && isHomePath(back))) {
    router.back()
    // 退回是异步的（popstate）：路由变了就算完成；没有可退的记录时 700ms 后放弃
    popWait = setTimeout(done, 700)
  } else router.replace(to).catch(() => {}).finally(done)
}
function settle(seq) {
  if (seq !== navSeq) return // 已经被后来的导航顶掉了
  clearTimeout(popWait)
  popWait = 0
  navBusy = false
  if (!alive) return
  // 排着的下一个同样等这一帧画出来再导航（它的动画可能刚建好，还没交给合成线程）
  if (pendingTab) schedule()
  else reconcile()
}
/** 路由才是事实：导航被拦下、改道之后让导航栏回到路由所在的 Tab */
function reconcile() {
  const id = route.meta.tab
  if (id && id !== sel.value) select(id, 'route')
}
watch(() => route.fullPath, () => { if (popWait) settle(navSeq) })
/* 不是点导航栏引起的路由变化（安卓返回键从「我的」回首页、守卫改道、页面里的跳转）：光点飞过去，图标不弹、不震 */
watch(() => route.meta.tab, id => {
  if (!id || navBusy || pendingTab || flushQueued) return
  if (id !== sel.value) select(id, 'route')
})

/*
 * 再点一次当前 Tab：图标轻跳、光点呼吸，然后发「再点一次」（首页 / 社区回顶，短视频换一批）。
 * 刚切过来 350ms 内的再点（双击 Tab）只播动画不发：不然一到短视频就被刷新掉。
 * 路由还没跟上（导航没跑完）时也不发。
 */
function retap(t, how) {
  motion?.retap(indexOf(t.id))
  if (how === 'pointer') buzz(6)
  if (performance.now() - selectedAt < 350) return
  const fire = () => {
    if (!alive || navBusy || pendingTab || sel.value !== t.id) return
    if (target(t) !== route.fullPath) return queueNav(t)
    emitTabRetap(t.id)
  }
  if (reducedMotion()) fire()
  else afterCommit(fire)
}

function activate(i, how) {
  const t = MAIN_TABS[i]
  if (t.id === sel.value) return retap(t, how)
  select(t.id, how)
  if (how === 'pointer') buzz(8)
  queueNav(t)
}

/* ---------- 手势：按下即沉；手指移出这一格就取消；抬起后的 click 才切换 ---------- */

/*
 * 取消只看手指有没有离开这一格（左右各放宽 8px、上下 14px），不看移动了多少：
 * 拇指在格子里滚动十几像素照样算点到（和系统 Tab 栏一样）。
 * 按住不放、或者手指挪得比浏览器的「点按」阈值多一点时，浏览器不会给 click：抬起 120ms 内没等到 click 就自己切换，
 * 之后 450ms 内这一格迟到的 click 忽略。
 */
let press = null        // { i, id, rect }
let cancelledAt = -1e9  // 划走取消的时间：之后 600ms 内由这次触摸产生的 click 不算
let pendingUp = -1      // 抬起了、等 click 的那一格
let upTimer = 0
let swallow = null      // { i, until }：兜底切换过的那一格，迟到的 click 不再算

function onDown(i, e) {
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
  // 上一下还没收尾：没抬起的弹回去；抬起了、还在等 click 的（挪得多了一点的点按）现在就算它点到
  if (press) cancelPress()
  if (pendingUp >= 0) {
    const j = pendingUp
    pendingUp = -1
    clearTimeout(upTimer)
    swallow = { i: j, until: performance.now() + 450 }
    activate(j, 'pointer')
  }
  // 唯一的一次排版读取：在写任何东西之前量这一格（取消用）
  const r = e.currentTarget.getBoundingClientRect()
  press = { i, id: e.pointerId, rect: { l: r.left - 8, r: r.right + 8, t: r.top - 14, b: r.bottom + 14 } }
  cancelledAt = -1e9
  pendingUp = -1
  clearTimeout(upTimer)
  document.addEventListener('pointermove', onMove, { capture: true, passive: true })
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('pointercancel', cancelPress, true)
  document.addEventListener('visibilitychange', cancelPress)
  window.addEventListener('blur', cancelPress)
  motion?.down(i)
}
function onMove(e) {
  if (!press || e.pointerId !== press.id) return
  const b = press.rect
  if (e.clientX < b.l || e.clientX > b.r || e.clientY < b.t || e.clientY > b.b) cancelPress()
}
function onUp(e) {
  if (!press || e.pointerId !== press.id) return
  const i = press.i
  endPress()
  pendingUp = i
  clearTimeout(upTimer)
  upTimer = setTimeout(() => {
    if (pendingUp !== i || !alive) return
    pendingUp = -1
    swallow = { i, until: performance.now() + 450 }
    activate(i, 'pointer')
  }, 120)
}
function cancelPress() {
  if (!press) return
  const i = press.i
  endPress()
  cancelledAt = performance.now()
  motion?.cancel(i)
}
function endPress() {
  press = null
  document.removeEventListener('pointermove', onMove, true)
  document.removeEventListener('pointerup', onUp, true)
  document.removeEventListener('pointercancel', cancelPress, true)
  document.removeEventListener('visibilitychange', cancelPress)
  window.removeEventListener('blur', cancelPress)
}
function onClick(i, e) {
  const now = performance.now()
  if (swallow && swallow.i === i && now < swallow.until) { swallow = null; return }
  // 键盘回车（detail 为 0）不受划走取消的影响
  if (e.detail !== 0 && now - cancelledAt < 600) { cancelledAt = -1e9; return }
  const how = pendingUp === i ? 'pointer' : 'key'
  if (pendingUp >= 0 && pendingUp !== i) motion?.cancel(pendingUp) // 按下的那格没等到自己的 click：弹回去
  pendingUp = -1
  clearTimeout(upTimer)
  activate(i, how)
}

/* ---------- 挂载：什么都不播；空闲时预热；系统「减少动态效果」中途变了就全部落定 ---------- */

const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
function onMotionPref() {
  resetTokens()
  motion?.snapAll(selIndex.value)
}
let warmId = 0
onMounted(() => {
  motion = createTabMotion(navEl.value, selIndex.value)
  const warm = () => { warmId = 0; if (alive) motion.warm() }
  warmId = window.requestIdleCallback ? -window.requestIdleCallback(warm, { timeout: 1000 }) : setTimeout(warm, 600)
  if (mq?.addEventListener) mq.addEventListener('change', onMotionPref)
  else mq?.addListener?.(onMotionPref)
})
onBeforeUnmount(() => {
  alive = false
  endPress()
  clearTimeout(upTimer)
  clearTimeout(popWait)
  pendingTab = null
  if (warmId < 0) window.cancelIdleCallback?.(-warmId)
  else clearTimeout(warmId)
  if (mq?.removeEventListener) mq.removeEventListener('change', onMotionPref)
  else mq?.removeListener?.(onMotionPref)
  // 正在跑的动画留给正在离场的这条导航栏自己放完
})
</script>

<template>
  <nav ref="navEl" class="tabbar" aria-label="主导航" :style="{ '--i': selIndex }" @contextmenu.prevent>
    <!--
      根节点只能是这一个 <nav>（App.vue 的 <Transition> 要整个滑走它，注释放在外面开发时会变成多根节点、转场失效）。
      contextmenu.prevent + touch-callout：长按 Tab 不弹安卓 WebView 的链接菜单、iOS 的链接预览，松手照样切换
    -->
    <RouterLink v-for="(t, i) in MAIN_TABS" :key="t.id" v-slot="{ href }" :to="target(t)" custom>
      <a
        :href="href"
        class="tb-i"
        :class="{ on: sel === t.id }"
        :aria-current="sel === t.id ? 'page' : undefined"
        draggable="false"
        @pointerdown="onDown(i, $event)"
        @click.prevent="onClick(i, $event)"
      >
        <!-- 描边 / 实心两个图标一直都在，叠在一起，只交接透明度和缩放 -->
        <span class="tb-ic"><Icon class="tb-o" :name="t.icon" /><Icon class="tb-f" :name="t.icon + 'On'" /></span>
        <span class="tb-l">{{ t.label }}</span>
      </a>
    </RouterLink>
    <!-- 光点（放在 6 个链接后面，.tb-i:nth-child(n) 照常对得上）：两个发光的端点 + 中间的桥 -->
    <div class="tb-dot" aria-hidden="true"><i class="d-c" /><i class="d-a" /><i class="d-b" /></div>
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
  /* 导航栏不滚动：手指稍微挪一点浏览器也不会接管（不发 pointercancel），取消只看是不是移出了这一格 */
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
/*
 * 竖排（栏高 60 + 1px 上边框）：图标 7–29px、文字 32–48px、光点 51–55px。
 * 不用 flex 的 gap（iOS 14.0–14.4 不支持），文字用 margin-top。
 * 这里没有任何 transition：所有变化都由 tabMotion.js 的动画盖在静止状态上。
 */
.tb-i {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 7px;
  color: var(--t2);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  -webkit-touch-callout: none;
}
/* 键盘焦点：收在格子里面的圆角框，不压到隔壁（盖掉全局的外描边）；鼠标、触摸不显示 */
.tb-i:focus-visible { outline: none; }
.tb-i:focus-visible::before {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  top: 3px;
  bottom: 3px;
  border-radius: 12px;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, .9);
  pointer-events: none;
}
/* 图标：外层管按压缩放和再点一次的轻跳，里面叠两个 svg：描边（灰）/ 实心（白） */
.tb-ic { position: relative; display: block; width: 22px; height: 22px; }
.tb-ic > svg { position: absolute; left: 0; top: 0; width: 22px; height: 22px; }
.tb-f { color: var(--t1); opacity: 0; transform: scale(.45); }
.tb-i.on .tb-f { opacity: 1; transform: none; }
.tb-i.on .tb-o { opacity: 0; }
/* 文字只有一层：白字 .53 透明度叠在 #0a0a0a 上正好是 --t2（#8c8c8c），选中时到 1；字重直接换，不做过渡 */
.tb-l { margin-top: 3px; color: var(--t1); opacity: .53; white-space: nowrap; }
.tb-i.on .tb-l { opacity: 1; font-weight: 600; }

/*
 * 光点：三块都只用 transform。每块一格宽，translateX 的 % 就是格数：静止位置由 --i 给，首帧、320 / 390、转屏都不用量尺寸；
 * 动画的关键帧同样用 %（tabMotion.js 的 Dot）。
 */
.tb-dot { position: absolute; left: 0; right: 0; top: 51px; height: 4px; pointer-events: none; }
.tb-dot > i { position: absolute; top: 0; left: 0; width: calc(100% / 6); height: 4px; }
.tb-dot > .d-a, .tb-dot > .d-b { transform: translateX(calc(var(--i, 0) * 100%)); }
.tb-dot > .d-a::after, .tb-dot > .d-b::after {
  content: '';
  position: absolute;
  top: 0;
  left: calc(50% - 2px);
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 4px rgba(255, 255, 255, .55), 0 0 10px rgba(255, 255, 255, .2);
}
/* 桥：从左端点的圆心伸到右端点的圆心；不带光晕（被 scaleX 压到 0 宽时竖直方向的阴影会剩一道细线） */
.tb-dot > .d-c {
  left: calc(100% / 12);
  background: #fff;
  transform-origin: 0 50%;
  transform: translateX(calc(var(--i, 0) * 100%)) scaleX(.001);
}
</style>
