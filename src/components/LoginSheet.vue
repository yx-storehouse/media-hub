<script setup>
import { ref, computed, watch, nextTick, useTemplateRef } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import Icon from '@/components/Icon.vue'

/*
 * 登录弹层：底部升起，和 App 其他弹层风格一致。
 * 未登录时点「点赞 / 收藏 / 我的」都会打开它（见 stores/auth.js 的 requireLogin）。
 */
const auth = useAuthStore()
const open = computed(() => auth.loginOpen)

const uid = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const pwdInput = useTemplateRef('pwdInput')

watch(open, isOpen => {
  if (isOpen) {
    error.value = ''
    busy.value = false
    nextTick(() => pwdInput.value?.focus?.())
  } else {
    password.value = ''
  }
})

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
  auth.loginOpen = false
  error.value = ''
}
</script>

<template>
  <Teleport to="#app">
    <Transition name="sheet-mask">
      <div v-if="open" class="mask" @click="close" />
    </Transition>
    <Transition name="sheet">
      <div v-if="open" class="sheet login" role="dialog" aria-modal="true" aria-labelledby="login-title" @keydown.esc="close">
        <div class="grab" />
        <h4 id="login-title">登录</h4>

        <form class="form" @submit.prevent="submit">
          <label class="field">
            <Icon name="tMe" />
            <input
              v-model="uid"
              type="text"
              name="username"
              autocomplete="username"
              placeholder="账号"
              :disabled="busy"
              @keydown.enter.prevent="submit"
            >
          </label>

          <label class="field">
            <Icon name="iInfo" />
            <input
              ref="pwdInput"
              v-model="password"
              type="password"
              name="password"
              autocomplete="current-password"
              placeholder="密码"
              :disabled="busy"
              @keydown.enter.prevent="submit"
            >
          </label>

          <p v-if="error" class="err" role="alert">{{ error }}</p>

          <button class="submit" type="submit" :disabled="busy">
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
