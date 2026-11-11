<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import { useDeskNav } from './deskNav'
import Icon from '@/components/Icon.vue'
import Cover from '@/components/Cover.vue'
import ConfirmSheet from '@/components/me/ConfirmSheet.vue'

/*
 * 桌面顶栏右边的账号区：
 *   没登录：「登录」按钮，打开和手机上同一个登录框（auth.requireLogin()，桌面上是居中的对话框）
 *   登录了：头像，点开一个小菜单——我的、观看历史、我的收藏、管理后台（管理员；新标签页打开 admin.html）、退出登录（先确认）
 *   带着令牌刚打开、还在向服务端核对（auth.ready 之前）：先占一个头像大小的灰圆，不闪一下「登录」；
 *   令牌失效时 auth.init() 也会置 ready，照样换成「登录」。
 * 菜单：点外面 / Esc / 换页面就收起；↑ ↓ 在菜单项之间移动，Esc 收起后焦点回到头像。
 * 点外面关菜单的那一下只关菜单，不顺带点开下面的东西（见 swallowClick）。
 */
const auth = useAuthStore()
const route = useRoute()
const { hrefOf, open: openItem } = useDeskNav()

const ITEMS = [
  { id: 'me', label: '我的', icon: 'user', tab: 'me' },
  { id: 'history', label: '观看历史', icon: 'history', path: '/history', login: true },
  { id: 'favorites', label: '我的收藏', icon: 'bookmark', path: '/favorites', login: true }
]

const avatar = computed(() => {
  const a = auth.user?.avatar
  return a && (a.src || a.fallback) ? a : null
})
const initial = computed(() => [...(auth.displayName || '?').trim()][0] || '?')

const menuOpen = ref(false)
const btnEl = ref(null)
const menuEl = ref(null)
const loginEl = ref(null)

/*
 * 点菜单外面把它关掉：这一下只是关菜单，随后的那次 click 吞掉（和系统菜单一样），不会顺带打开下面的视频卡片、
 * 侧边栏项。按下以后没变成点击（拖成了滚动、松手在别处）就不会有 click：下一次按下时或 1 秒后撤掉，
 * 不会误吞以后真正的点击。只管主键（鼠标左键、手指、笔）；右键本来就没有 click。
 */
let unswallow = null
function swallowClick(down) {
  unswallow?.()
  const eat = e => {
    e.preventDefault()
    e.stopPropagation()
    off()
  }
  // 监听是在这次按下的派发途中加的，不会再收到这一次；保险起见还是认一下
  const next = e => { if (e !== down) off() }
  const timer = setTimeout(() => off(), 1000)
  function off() {
    document.removeEventListener('click', eat, true)
    document.removeEventListener('pointerdown', next, true)
    clearTimeout(timer)
    unswallow = null
  }
  document.addEventListener('click', eat, true)
  document.addEventListener('pointerdown', next, true)
  unswallow = off
}

function onDocDown(e) {
  if (!menuOpen.value) return
  const t = e.target
  if (menuEl.value?.contains(t) || btnEl.value?.contains(t)) return
  menuOpen.value = false
  if (e.button === 0) swallowClick(e)
}
watch(menuOpen, isOpen => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocDown, true)
    nextTick(() => menuEl.value?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }))
  } else document.removeEventListener('pointerdown', onDocDown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  unswallow?.()
})
watch(() => route.fullPath, () => { menuOpen.value = false })
watch(() => auth.loggedIn, () => { menuOpen.value = false })

function closeMenu(focusBtn) {
  menuOpen.value = false
  if (focusBtn) btnEl.value?.focus({ preventScroll: true })
}

function onMenuKey(e) {
  const items = [...(menuEl.value?.querySelectorAll('[role="menuitem"]') || [])]
  const i = items.indexOf(document.activeElement)
  if (e.key === 'Escape') {
    e.preventDefault()
    closeMenu(true)
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const n = items.length
    if (!n) return
    const next = e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n
    items[next].focus()
  } else if (e.key === 'Tab') {
    menuOpen.value = false
  }
}

function pick(item, e) {
  menuOpen.value = false
  openItem(item, e)
}

/*
 * 退出登录：和「我的」页一样先确认。
 * 打开确认框前先把焦点放回头像：确认框关掉后焦点回到打开它的元素，而菜单项那时已经跟着菜单收起了
 * （不然焦点掉到 <body>，键盘用户下一次 Tab 又从页面最前面开始）。真的退出后头像换成「登录」，焦点跟过去。
 */
const askLogout = ref(false)
function logout() {
  menuOpen.value = false
  btnEl.value?.focus({ preventScroll: true })
  askLogout.value = true
}
async function signOut() {
  await auth.logout()
  toast('已退出登录')
  await nextTick()
  const a = document.activeElement
  if (!a || a === document.body) loginEl.value?.focus({ preventScroll: true })
}
</script>

<template>
  <div class="dacc">
    <button v-if="!auth.loggedIn && (auth.ready || !auth.token)" ref="loginEl" type="button" class="da-login" @click="auth.requireLogin()">
      <Icon name="user" />登录
    </button>

    <!-- 带着令牌、还在核对：头像大小的灰圆占位（不闪「登录」） -->
    <span v-else-if="!auth.loggedIn" class="da-wait" aria-hidden="true"><span class="av" /></span>

    <template v-else>
      <button
        ref="btnEl"
        type="button"
        class="da-av"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        :aria-label="`账号：${auth.displayName}`"
        :title="auth.displayName"
        @click="menuOpen = !menuOpen"
      >
        <Cover v-if="avatar" class="av" v-bind="avatar" eager />
        <span v-else class="av ini">{{ initial }}</span>
      </button>

      <Transition name="da-pop">
        <div v-if="menuOpen" ref="menuEl" class="da-menu" role="menu" aria-label="账号菜单" @keydown="onMenuKey">
          <div class="da-who">
            <Cover v-if="avatar" class="av" v-bind="avatar" eager />
            <span v-else class="av ini">{{ initial }}</span>
            <div class="da-nm">
              <b>{{ auth.displayName }}</b>
              <span>账号 {{ auth.user?.uid }}<em v-if="auth.isAdmin">管理员</em></span>
            </div>
          </div>
          <div class="da-sep" />
          <a
            v-for="it in ITEMS"
            :key="it.id"
            :href="hrefOf(it)"
            class="da-i"
            role="menuitem"
            @click="pick(it, $event)"
          >
            <Icon :name="it.icon" /><span>{{ it.label }}</span>
          </a>
          <!-- 管理后台是独立页面（admin.html，桌面布局），新标签页打开 -->
          <a v-if="auth.isAdmin" href="./admin.html" target="_blank" rel="noopener" class="da-i" role="menuitem" @click="menuOpen = false">
            <Icon name="gear" /><span>管理后台</span><Icon name="external" class="ext" />
          </a>
          <div class="da-sep" />
          <button type="button" class="da-i" role="menuitem" @click="logout">
            <Icon name="logout" /><span>退出登录</span>
          </button>
        </div>
      </Transition>
    </template>

    <ConfirmSheet
      v-model:open="askLogout"
      title="退出登录？"
      text="退出后需要重新输入账号和密码才能登录。"
      ok="退出登录"
      danger
      @confirm="signOut"
    />
  </div>
</template>

<style scoped>
.dacc { position: relative; display: flex; align-items: center; }
.da-login {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 16px 0 12px;
  border-radius: 18px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18);
  color: var(--t1);
  font-size: 14px;
  font-weight: 600;
  transition: background-color var(--dur-2) var(--ease-out);
}
.da-login svg { width: 18px; height: 18px; }

.av { display: grid; flex: none; place-items: center; width: 32px; height: 32px; border-radius: 50%; }
.av.ini { background: #2a2a2a; color: var(--t1); font-size: 14px; font-weight: 600; }
.da-av { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; transition: background-color var(--dur-2) var(--ease-out); }
/* 核对令牌时的占位：和头像按钮一样大，换成头像时位置不动 */
.da-wait { display: grid; place-items: center; width: 40px; height: 40px; }
.da-wait .av { background: var(--chip); }

.da-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 248px;
  padding: 8px 0;
  border-radius: 14px;
  background: #151515;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .07), 0 16px 48px rgba(0, 0, 0, .6);
  transform-origin: 100% 0;
}
.da-who { display: flex; align-items: center; gap: 12px; padding: 8px 16px 12px; }
.da-who .av { width: 40px; height: 40px; }
.da-who .av.ini { font-size: 16px; }
.da-nm { display: flex; flex-direction: column; min-width: 0; }
.da-nm b { overflow: hidden; color: var(--t1); font-size: 15px; font-weight: 600; line-height: 22px; text-overflow: ellipsis; white-space: nowrap; }
.da-nm span { color: var(--t2); font-size: 12px; line-height: 18px; }
.da-nm em { margin-left: 6px; padding: 0 5px; border-radius: 4px; background: var(--chip); color: var(--t3); font-size: 11px; font-style: normal; }
.da-sep { height: 1px; margin: 6px 0; background: var(--line); }
.da-i {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  height: 40px;
  padding: 0 16px;
  color: var(--t3);
  font-size: 14px;
  text-align: left;
}
.da-i svg { width: 18px; height: 18px; color: var(--t2); }
.da-i span { flex: 1; }
.da-i .ext { width: 14px; height: 14px; }
.da-i:focus-visible { outline-offset: -2px; background: #232323; }

/* 出现：从头像那一角轻轻放大淡入（snappy 弹簧）；收起：淡出 */
.da-pop-enter-active { transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-spring-snappy) var(--spring-snappy); }
.da-pop-leave-active { transition: opacity var(--dur-1) var(--ease-in); pointer-events: none; }
.da-pop-enter-from { opacity: 0; transform: scale(.94); }
.da-pop-leave-to { opacity: 0; }

@media (hover: hover) {
  .da-login:hover { background: var(--chip); }
  .da-av:hover { background: var(--chip); }
  .da-i:hover { background: #232323; color: var(--t1); }
}
</style>
