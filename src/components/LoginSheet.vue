<script setup>
import { ref, computed, watch, nextTick, useTemplateRef } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import { useBackDismiss } from '@/composables/useBackDismiss'
import { useSheetDrag } from '@/components/motion/sheetDrag'
import Icon from '@/components/Icon.vue'

/*
 * 登录弹层：底部升起，和 App 其他弹层风格一致（动效、下拉关闭和 BottomSheet 共用）。
 * 未登录时点「点赞 / 收藏 / 我的」都会打开它（见 stores/auth.js 的 requireLogin，登录后补做那次操作）。
 * 返回键 / 返回手势只关登录框；换页面时自动关掉，不会留到下一个页面上。
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

// immediate：启动时就要登录（直接打开需要登录的页面）也照样聚焦
watch(open, isOpen => {
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
  else error.value = '请输入账号'
}

async function submit() {
  if (busy.value) return
  const name = uid.value.trim()
  if (!name) { error.value = '请输入账号'; return }
  if (!password.value) { error.value = '请输入密码'; return }
  busy.value = true
  error.value = ''
  try {
    const user = await auth.login(name, password.value)
    toast(`欢迎回来，${user.name}`)
    uid.value = ''
    password.value = ''
  } catch (e) {
    error.value = e.message || '登录失败'
  } finally {
    busy.value = false
  }
}

function close() {
  auth.closeLogin()
  error.value = ''
}
/* 往下拉关闭：和点遮罩一样 */
const drag = useSheetDrag(sheetEl, maskEl, close)
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
        @keydown.esc="close"
        v-on="drag.on"
      >
        <div class="grab" />
        <h4 id="login-title">登录</h4>

        <form class="form" @submit.prevent="submit">
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

.err { color: #ff8080; font-size: 12.5px; line-height: 18px; }

.submit {
  height: 44px;
  margin-top: 4px;
  border-radius: 10px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 15px;
  font-weight: 700;
}
.submit:disabled { opacity: .55; }
.submit:active:not(:disabled) { filter: brightness(.92); }

.hint { margin-top: 14px; color: var(--t2); font-size: 12px; line-height: 18px; text-align: center; }
</style>
