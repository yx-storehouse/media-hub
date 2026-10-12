<script setup>
import { ref, shallowRef, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { listUsers, createUser, resetUserPassword, setUserStatus, setUserRole, deleteUser } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import { useBackDismiss } from '@/composables/useBackDismiss'
import BackHeader from '@/components/BackHeader.vue'
import Icon from '@/components/Icon.vue'

defineOptions({ name: 'AdminUsersView' })

/*
 * 账号管理（仅管理员）。
 * 内网部署时账号不多，直接用表格列出，支持建号、重置密码、停用、改角色、删除。
 * 服务端对每一个操作都会再校验一次管理员权限，这里的判断只是省一次无效请求。
 */
const router = useRouter()
const auth = useAuthStore()

const users = shallowRef([])
const loading = ref(true)
const failed = ref(false)

const createOpen = ref(false)
useBackDismiss(createOpen) // 返回键只关「新建账号」弹层
const form = ref({ uid: '', nickname: '', password: '', role: 'user' })
const submitting = ref(false)

async function load() {
  loading.value = true
  try {
    users.value = await listUsers()
    failed.value = false
  } catch (e) {
    failed.value = true
    if (e.status === 403) {
      toast('需要管理员权限')
      router.replace('/me')
    }
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.value = { uid: '', nickname: '', password: '', role: 'user' }
  createOpen.value = true
}

async function submitCreate() {
  if (submitting.value) return
  const { uid, nickname, password, role } = form.value
  if (!uid.trim()) return toast('请输入登录名')
  if ((password || '').length < 8) return toast('密码至少 8 位')
  submitting.value = true
  try {
    await createUser({ uid: uid.trim(), nickname: nickname.trim() || uid.trim(), password, role })
    createOpen.value = false
    toast('账号已创建')
    await load()
  } catch (e) {
    toast(e.message || '创建失败')
  } finally {
    submitting.value = false
  }
}

async function toggleStatus(u) {
  const next = u.status ? 0 : 1
  try {
    await setUserStatus(u.id, next)
    u.status = next
    toast(next ? '已启用' : '已停用')
  } catch (e) {
    toast(e.message || '操作失败')
  }
}

async function toggleRole(u) {
  const next = u.role === 'admin' ? 'user' : 'admin'
  try {
    await setUserRole(u.id, next)
    u.role = next
    toast(next === 'admin' ? '已设为管理员' : '已取消管理员')
  } catch (e) {
    toast(e.message || '操作失败')
  }
}

async function resetPwd(u) {
  const pwd = prompt(`给「${u.nickname}」设置新密码（至少 8 位）`)
  if (!pwd) return
  if (pwd.length < 8) return toast('密码至少 8 位')
  try {
    await resetUserPassword(u.id, pwd)
    toast('密码已重置，该账号的登录已失效')
  } catch (e) {
    toast(e.message || '重置失败')
  }
}

async function removeUser(u) {
  if (!confirm(`确定删除账号「${u.nickname}」？该操作不可恢复。`)) return
  try {
    await deleteUser(u.id)
    toast('已删除')
    await load()
  } catch (e) {
    toast(e.message || '删除失败')
  }
}

const fmtTime = ts => {
  if (!ts) return '从未'
  const d = new Date(ts * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(load)
</script>

<template>
  <div class="page admin-users">
    <BackHeader title="账号管理">
      <button class="add-btn" @click="openCreate">新建账号</button>
    </BackHeader>

    <div v-if="failed" class="empty">
      加载失败
      <button class="retry" @click="load()">重试</button>
    </div>

    <div v-else-if="loading" class="empty">加载中…</div>

    <div v-else class="scroll">
      <div class="rows">
        <div v-for="u in users" :key="u.id" class="row">
          <div class="info">
            <div class="line1">
              <span class="name">{{ u.nickname }}</span>
              <em v-if="u.role === 'admin'" class="badge">管理员</em>
              <em v-if="!u.status" class="badge off">已停用</em>
              <em v-if="u.id === auth.user?.id" class="badge me">我</em>
            </div>
            <div class="line2">
              账号 {{ u.uid }} · 最近登录 {{ fmtTime(u.last_login_at) }}
            </div>
          </div>

          <div class="ops">
            <button class="op" @click="resetPwd(u)">重置密码</button>
            <button class="op" @click="toggleRole(u)">{{ u.role === 'admin' ? '取消管理' : '设为管理' }}</button>
            <button class="op" :disabled="u.id === auth.user?.id" @click="toggleStatus(u)">
              {{ u.status ? '停用' : '启用' }}
            </button>
            <button class="op danger" :disabled="u.id === auth.user?.id" @click="removeUser(u)">删除</button>
          </div>
        </div>
      </div>
      <div class="pad-b" />
      <p class="tip">提示：停用或重置密码后，该账号所有设备上的登录会立即失效。至少要保留一个可用的管理员。</p>
    </div>

    <!-- 新建账号 -->
    <Teleport to="#app">
      <Transition name="sheet-mask">
        <div v-if="createOpen" class="mask" @click="createOpen = false" />
      </Transition>
      <Transition name="sheet">
        <div v-if="createOpen" class="sheet" role="dialog" aria-modal="true" aria-labelledby="create-title" @keydown.esc="createOpen = false">
          <div class="grab" />
          <h4 id="create-title">新建账号</h4>
          <div class="form">
            <input v-model="form.uid" type="text" placeholder="登录名（字母数字，3-32 位）" autocomplete="off">
            <input v-model="form.nickname" type="text" placeholder="昵称（可留空，默认同登录名）" autocomplete="off">
            <input v-model="form.password" type="password" placeholder="初始密码（至少 8 位）" autocomplete="new-password">
            <div class="roles">
              <button :class="{ on: form.role === 'user' }" @click="form.role = 'user'">普通用户</button>
              <button :class="{ on: form.role === 'admin' }" @click="form.role = 'admin'">管理员</button>
            </div>
            <button class="submit" :disabled="submitting" @click="submitCreate">
              {{ submitting ? '创建中…' : '创建' }}
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.admin-users { padding-top: var(--safe-t); }
.add-btn { height: 28px; margin-left: auto; padding: 0 12px; border-radius: 14px; background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 600; }

.rows { padding: 12px 14px 0; display: flex; flex-direction: column; gap: 10px; }
.row { padding: 12px 14px; border-radius: 12px; background: var(--panel); }
.info { min-width: 0; }
.line1 { display: flex; align-items: center; gap: 6px; }
.name { font-size: 15px; font-weight: 600; }
.badge { height: 16px; padding: 0 6px; border-radius: 8px; background: var(--accent); color: var(--on-accent); font-size: 10.5px; font-style: normal; line-height: 16px; font-weight: 600; }
.badge.off { background: #333; color: #bbb; }
.badge.me { background: transparent; color: var(--t2); box-shadow: inset 0 0 0 1px #3a3a3a; }
.line2 { margin-top: 3px; color: var(--t2); font-size: 12px; line-height: 17px; }

.ops { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.op { height: 26px; padding: 0 10px; border-radius: 13px; background: #1e1e1e; color: var(--t3); font-size: 12px; }
.op:disabled { opacity: .35; }
.op.danger { color: #ff8080; }
.op:active:not(:disabled) { background: #262626; }

.tip { margin: 14px 18px 0; color: var(--t2); font-size: 12px; line-height: 18px; }

.form { display: flex; flex-direction: column; gap: 10px; }
.form input { height: 44px; padding: 0 14px; border: 0; border-radius: 10px; background: var(--field); color: var(--t1); font-size: 15px; }
.form input::placeholder { color: #6e6e6e; }
.roles { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.roles button { height: 38px; border-radius: 10px; background: var(--field); color: var(--t2); font-size: 14px; }
.roles button.on { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.submit { height: 44px; margin-top: 4px; border-radius: 10px; background: var(--accent); color: var(--on-accent); font-size: 15px; font-weight: 700; }
.submit:disabled { opacity: .55; }
</style>
