<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { session, login, safeRedirect } from '../auth'
import ABtn from '../components/ABtn.vue'
import AIcon from '../components/AIcon.vue'
import FormField from '../components/FormField.vue'
import TextInput from '../components/TextInput.vue'

defineOptions({ name: 'LoginPage' })

/*
 * 管理员登录。只有 role = admin 的账号能进；普通账号会被提示「该账号不是管理员」。
 * 第一次部署还没有管理员时：node server/create-admin.mjs <登录名> <密码>
 */
const route = useRoute()
const router = useRouter()

const uid = ref('')
const password = ref('')
const showPwd = ref(false)
const busy = ref(false)
const error = ref(session.message || '')
const uidEl = ref(null)
const pwdEl = ref(null)

async function submit() {
  if (busy.value) return
  error.value = ''
  if (!uid.value.trim()) { error.value = '请输入账号'; uidEl.value?.focus(); return }
  if (!password.value) { error.value = '请输入密码'; pwdEl.value?.focus(); return }
  busy.value = true
  try {
    await login(uid.value.trim(), password.value)
    router.replace(safeRedirect(route.query.redirect))
  } catch (e) {
    error.value = e.message || '登录失败'
    password.value = ''
    pwdEl.value?.focus()
  } finally {
    busy.value = false
  }
}

onMounted(() => uidEl.value?.focus())
</script>

<template>
  <div class="login">
    <form class="box" novalidate @submit.prevent="submit">
      <div class="brand">
        <span class="logo" aria-hidden="true">R</span>
        <div>
          <h1>Reel 管理后台</h1>
          <p class="muted">内容、素材与批量导入管理</p>
        </div>
      </div>

      <p v-if="error" class="err" role="alert">
        <AIcon name="warning" :size="15" />{{ error }}
      </p>

      <FormField label="账号">
        <TextInput ref="uidEl" v-model="uid" name="username" autocomplete="username" placeholder="管理员登录名" />
      </FormField>
      <FormField label="密码">
        <div class="pwd">
          <TextInput ref="pwdEl" v-model="password" :type="showPwd ? 'text' : 'password'" name="password" autocomplete="current-password" placeholder="密码" />
          <button type="button" class="eye" :aria-label="showPwd ? '隐藏密码' : '显示密码'" :aria-pressed="showPwd ? 'true' : 'false'" @click="showPwd = !showPwd">
            <AIcon :name="showPwd ? 'eye-off' : 'eye'" :size="16" />
          </button>
        </div>
      </FormField>

      <ABtn class="go" variant="primary" type="submit" :loading="busy">登录</ABtn>
      <p class="tip">还没有管理员账号？在服务器上运行 <code>node server/create-admin.mjs 登录名 密码</code></p>
    </form>
  </div>
</template>

<style scoped>
.login { display: grid; min-height: 100vh; place-items: center; padding: 24px 16px; background: radial-gradient(1200px 600px at 50% -10%, #1a1a1a, var(--bg) 60%); }
.box { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 380px; padding: 30px 28px 24px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); box-shadow: var(--shadow); }
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
.logo { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: var(--accent); color: var(--on-accent); font-size: 21px; font-weight: 800; }
h1 { font-size: 18px; font-weight: 650; }
.brand p { margin-top: 2px; font-size: 12.5px; }
.err { display: flex; align-items: flex-start; gap: 7px; padding: 9px 11px; border: 1px solid rgba(255, 107, 107, .35); border-radius: 7px; background: rgba(255, 107, 107, .08); color: var(--danger); line-height: 1.5; }
.err svg { margin-top: 2px; }
.pwd { position: relative; }
.pwd :deep(.a-input) { padding-right: 38px; }
.eye { position: absolute; top: 50%; right: 4px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 5px; color: var(--t3); transform: translateY(-50%); }
.eye:hover { color: var(--t1); }
.go { width: 100%; height: 38px; margin-top: 4px; font-size: 14px; }
.tip { color: var(--t3); font-size: 12px; line-height: 1.6; }
code { padding: 1px 5px; border-radius: 4px; background: #1d1d1d; color: var(--t2); font-family: var(--mono); font-size: 11.5px; white-space: nowrap; }
</style>
