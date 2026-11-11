<script setup>
import { ref, computed, watch, nextTick, useTemplateRef } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import { useBackDismiss } from '@/composables/useBackDismiss'
import { useSheetDrag } from '@/components/motion/sheetDrag'
import { shake, haptic, spring, reducedMotion } from '@/utils/motion'
import Icon from '@/components/Icon.vue'
import { isDesktop } from '@/composables/useDesktop'
import { trapTab } from '@/components/desk/modal'

/*
 * 登录弹层：底部升起，和 App 其他弹层风格一致（动效、下拉关闭和 BottomSheet 共用）。
 * 未登录时点「点赞 / 收藏 / 我的」都会打开它（见 stores/auth.js 的 requireLogin，登录后补做那次操作）。
 * 返回键 / 返回手势只关登录框；换页面时自动关掉，不会留到下一个页面上。
 * 没填、登录失败时表单左右摇一下（像 iOS 输错密码），错误信息从上面落下来。
 * 再点登录时上一条错误先留着（变淡），等新的结果出来再换：弹层高度不会在请求中先缩回去、出错时再跳上来。
 * 桌面布局（≥ 1024px）：窗口正中的对话框（样式和 BottomSheet 共用），右上角有关闭按钮，Tab 只在框里循环，
 * 关掉后焦点回到打开它的按钮；下拉关闭只在触屏上有。
 */
const auth = useAuthStore()
const open = computed(() => auth.loginOpen)
useBackDismiss(open, () => auth.closeLogin())

const route = useRoute()
watch(() => route.fullPath, () => { if (auth.loginOpen) auth.closeLogin() })

const uid = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const uidInput = useTemplateRef('uidInput')
const pwdInput = useTemplateRef('pwdInput')
const sheetEl = useTemplateRef('sheetEl')
const maskEl = useTemplateRef('maskEl')
const formEl = useTemplateRef('formEl')

/*
 * 出错：显示信息，表单摇一下，轻轻震一下（震动只有支持的安卓设备有）。
 * 第一次出错时错误信息插进来，贴着底边的弹层高出一行（顶边往上跳 28px）：先记下顶边，插进去以后
 * 从原来的位置用 smooth 弹簧升上去，和摇一下同时进行。正在拖动 / 升起收起中（有行内 transform 或别的动画）不做，
 * 减少动态效果时直接出现。
 */
function fail(msg) {
  const el = sheetEl.value
  const top = !error.value && el && !reducedMotion() && !el.style.transform && !el.getAnimations?.().length
    ? el.getBoundingClientRect().top
    : null
  error.value = msg
  shake(formEl.value)
  haptic(12)
  if (top === null) return
  nextTick(() => {
    if (!el.isConnected || el.style.transform) return
    const dy = top - el.getBoundingClientRect().top
    if (Math.abs(dy) > 0.5) el.animate([{ transform: `translate3d(0, ${dy}px, 0)` }, { transform: 'none' }], spring('smooth'))
  })
}

/*
 * 聚焦输入框，但不让浏览器去「滚到它」：这时弹层还在屏幕下面（升起动画的起点），浏览器会把整个 #app
 * 往上滚一大截，升起的过程中再一点点滚回来，整页跟着上下晃。不认 preventScroll 的老 iOS 聚焦后把外壳拨回原位。
 */
function focusField(el) {
  if (!el?.focus) return
  el.focus({ preventScroll: true })
  const app = document.getElementById('app')
  if (app?.scrollTop) app.scrollTop = 0
}

/* 桌面：关掉后焦点回到打开它的按钮（键盘用户接着往下操作） */
let returnFocus = null

/*
 * 登录成功时顶栏的「登录」按钮正要换成头像，这一轮渲染之后就不在了：所以等渲染完再看——打开它的元素还在就回到它；
 * 不在了（焦点掉到 <body>，或者还留在正在收起的登录框里）就落到顶栏的头像上，不让下一次 Tab 又从页面最前面开始。
 */
function restoreFocus(to, box) {
  nextTick(() => {
    if (to && to.isConnected && to !== document.body) {
      to.focus({ preventScroll: true })
      return
    }
    const a = document.activeElement
    if (!a || a === document.body || box?.contains(a)) document.querySelector('.da-av')?.focus({ preventScroll: true })
  })
}

// immediate：启动时就要登录（直接打开需要登录的页面）也照样聚焦
watch(open, (isOpen, wasOpen) => {
  if (isDesktop.value) {
    if (isOpen) returnFocus = document.activeElement
    // 只在真的关掉时（启动时 immediate 的那一次不算：不能一打开网页就把焦点放到头像上）
    else if (wasOpen) restoreFocus(returnFocus, sheetEl.value)
    if (!isOpen) returnFocus = null
  }
  if (isOpen) {
    error.value = ''
    busy.value = false
    // 先填账号；账号已经填过（上次输错密码）就直接到密码框
    nextTick(() => focusField((uid.value.trim() ? pwdInput : uidInput).value))
  } else {
    password.value = ''
  }
}, { immediate: true })

/* 账号框回车：跳到密码框，而不是提交 */
function nextField() {
  if (uid.value.trim()) pwdInput.value?.focus()
  else fail('请输入账号')
}

async function submit() {
  if (busy.value) return
  const name = uid.value.trim()
  if (!name) { fail('请输入账号'); return }
  if (!password.value) { fail('请输入密码'); return }
  /*
   * 桌面：请求中输入框和按钮都是禁用的，浏览器会把焦点丢到 <body>，Esc、回车、Tab 循环就都不灵了。
   * 所以先把焦点放到对话框本身（桌面上它可以聚焦，没有外框），出错回来再放回输入框（见下面）。
   */
  if (isDesktop.value && sheetEl.value?.contains(document.activeElement)) sheetEl.value.focus({ preventScroll: true })
  busy.value = true
  let failed = false
  try {
    const user = await auth.login(name, password.value)
    toast(`欢迎回来，${user.name}`)
    uid.value = ''
    password.value = ''
  } catch (e) {
    failed = true
    fail(e.message || '登录失败')
  } finally {
    // 登录成功时弹层已经在收起：按钮保持「登录中…」一起滑走，不在半路变回「登录」（下次打开时重置）
    if (auth.loginOpen) busy.value = false
  }
  /*
   * 桌面：登录失败，输入框恢复可用以后焦点回到密码框并选中（直接重新输入、回车再试；账号没填就回到账号框），
   * 和「我的」页改密码失败时一样。手机上不动（不去弹 / 收软键盘）。
   */
  if (failed && isDesktop.value && auth.loginOpen) {
    nextTick(() => {
      const el = (uid.value.trim() ? pwdInput : uidInput).value
      if (!el?.isConnected || el.disabled) return
      el.focus({ preventScroll: true })
      el.select?.()
    })
  }
}

function close() {
  auth.closeLogin()
  error.value = ''
}
/* 往下拉关闭：和点遮罩一样 */
const drag = useSheetDrag(sheetEl, maskEl, close)
/* 桌面上不挂下拉手势，换成 Tab 键循环 */
const deskOn = { keydown: e => trapTab(e, sheetEl.value) }
</script>

<template>
  <Teleport to="#app">
    <Transition name="sheet-mask">
      <div v-if="open" ref="maskEl" class="mask" @click="close" />
    </Transition>
    <Transition name="sheet" @before-leave="drag.beforeLeave" @after-leave="drag.afterLeave">
      <div
        v-if="open"
        ref="sheetEl"
        class="sheet login"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
        :tabindex="isDesktop ? -1 : undefined"
        @keydown.esc="close"
        v-on="isDesktop ? deskOn : drag.on"
      >
        <div class="grab" />
        <h4 id="login-title">登录</h4>

        <form ref="formEl" class="form" :class="{ busy }" @submit.prevent="submit">
          <label class="field">
            <Icon name="tMe" />
            <input
              ref="uidInput"
              v-model="uid"
              type="text"
              name="username"
              autocomplete="username"
              autocapitalize="off"
              spellcheck="false"
              enterkeyhint="next"
              placeholder="账号"
              :disabled="busy"
              @keydown.enter.prevent="nextField"
            >
          </label>

          <label class="field">
            <Icon name="lock" />
            <input
              ref="pwdInput"
              v-model="password"
              type="password"
              name="password"
              autocomplete="current-password"
              enterkeyhint="go"
              placeholder="密码"
              :disabled="busy"
              @keydown.enter.prevent="submit"
            >
          </label>

          <p v-if="error" class="err" role="alert">{{ error }}</p>

          <button class="submit m-press" type="submit" :disabled="busy">
            {{ busy ? '登录中…' : '登录' }}
          </button>
        </form>

        <p class="hint">账号由管理员分配。忘记密码请联系管理员重置。</p>
        <button v-if="isDesktop" type="button" class="sheet-x" aria-label="关闭" title="关闭" @click="close"><Icon name="close" /></button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.login { padding-bottom: calc(22px + var(--safe-b)); }
.form { display: flex; flex-direction: column; gap: 10px; }
.field {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 46px;
  padding: 0 14px;
  border-radius: 10px;
  background: var(--field);
}
.field:focus-within { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18); }
.field svg { width: 18px; height: 18px; color: var(--t2); }
.field input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--t1);
  font-size: 15px;
}
.field input::placeholder { color: #6e6e6e; }
.field input:disabled { opacity: .6; }

.err { color: #ff8080; font-size: 12.5px; line-height: 18px; transition: opacity var(--dur-2) var(--ease-out); animation: m-rise var(--dur-2) var(--ease-out); --rise: -4px; }
/* 请求中：上一条错误变淡留着，结果出来再换（不撤掉，弹层高度不变） */
.form.busy .err { opacity: .5; }

.submit {
  height: 44px;
  margin-top: 4px;
  border-radius: 10px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 15px;
  font-weight: 700;
  /* 请求中变淡、回来复原：过渡一下，不一帧跳过去 */
  transition: opacity var(--dur-2) var(--ease-out);
}
.submit:disabled { opacity: .55; }
.submit:active:not(:disabled) { filter: brightness(.92); }

.hint { margin-top: 14px; color: var(--t2); font-size: 12px; line-height: 18px; text-align: center; }

/* 桌面对话框：底边不用让出手机的安全区；字段高一点、好点 */
@media (min-width: 1024px) {
  .login { padding-bottom: 24px; }
  .field { height: 48px; }
}
</style>
