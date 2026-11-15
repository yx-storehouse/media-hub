<script setup>
import { ref, watch } from 'vue'
import AModal from './AModal.vue'
import ABtn from './ABtn.vue'
import AIcon from './AIcon.vue'
import FormField from './FormField.vue'
import TextInput from './TextInput.vue'
import { relogin, reloginWith, cancelRelogin } from '../auth'

/*
 * 「登录已过期」：用着用着令牌失效（别的标签页退出了、密码被重置、账号被停用）时在原地弹出，不跳登录页。
 * 登录成功后刚才失败的请求（保存、上传、列表）自动用新令牌再发一次，编辑中的内容一直在；
 * 「取消」= 先不登录，留在原页面（内容可以先复制出来），之后再有请求还会再弹。
 * 由 App.vue 挂一次；状态在 auth.js 的 relogin 里。
 */
const uid = ref('')
const password = ref('')
const showPwd = ref(false)
const busy = ref(false)
const error = ref('')
const pwdEl = ref(null)
const uidEl = ref(null)

watch(() => relogin.open, v => {
  if (!v) return
  uid.value = relogin.uid || ''
  password.value = ''
  error.value = ''
  showPwd.value = false
})

async function submit() {
  if (busy.value) return
  error.value = ''
  if (!uid.value.trim()) { error.value = '请输入账号'; uidEl.value?.focus(); return }
  if (!password.value) { error.value = '请输入密码'; pwdEl.value?.focus(); return }
  busy.value = true
  try {
    await reloginWith(uid.value.trim(), password.value)
    password.value = ''
  } catch (e) {
    error.value = e.message || '登录失败'
    password.value = ''
    pwdEl.value?.focus()
  } finally {
    busy.value = false
  }
}

function onOpen(v) {
  if (!v && !busy.value) cancelRelogin()
}
</script>

<template>
  <AModal :open="relogin.open" title="登录已过期" :width="400" persistent :closable="!busy" @update:open="onOpen">
    <form class="col rl" novalidate @submit.prevent="submit">
      <p class="lead">请重新登录。登录后会接着完成刚才的操作，没保存的修改还在。</p>
      <p v-if="error" class="err" role="alert"><AIcon name="warning" :size="15" />{{ error }}</p>
      <FormField label="账号">
        <TextInput ref="uidEl" v-model="uid" name="username" autocomplete="username" placeholder="管理员登录名" />
      </FormField>
      <FormField label="密码">
        <div class="pwd">
          <!-- 登录名已经填好：打开时焦点直接放到密码框（AModal 先找 data-autofocus） -->
          <TextInput ref="pwdEl" v-model="password" :type="showPwd ? 'text' : 'password'" name="password" autocomplete="current-password" placeholder="密码" :data-autofocus="uid ? '' : undefined" />
          <button type="button" class="eye" :aria-label="showPwd ? '隐藏密码' : '显示密码'" :aria-pressed="showPwd ? 'true' : 'false'" @click="showPwd = !showPwd">
            <AIcon :name="showPwd ? 'eye-off' : 'eye'" :size="16" />
          </button>
        </div>
      </FormField>
      <!-- 回车提交 -->
      <button type="submit" class="sr-only" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <ABtn :disabled="busy" @click="cancelRelogin">取消</ABtn>
      <ABtn variant="primary" :loading="busy" @click="submit">登录</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.rl { gap: 14px; }
.lead { color: var(--t2); line-height: 1.6; }
.err { display: flex; align-items: flex-start; gap: 7px; padding: 9px 11px; border: 1px solid rgba(255, 107, 107, .35); border-radius: 7px; background: rgba(255, 107, 107, .08); color: var(--danger); line-height: 1.5; }
.err svg { flex: none; margin-top: 2px; }
.pwd { position: relative; }
.pwd :deep(.a-input) { padding-right: 38px; }
.eye { position: absolute; top: 50%; right: 4px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 5px; color: var(--t3); transform: translateY(-50%); }
.eye:hover { color: var(--t1); }
</style>
