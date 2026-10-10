<script setup>
import { ref, shallowRef, computed, onMounted } from 'vue'
import { listUsers, createUser, resetUserPassword, setUserStatus, setUserRole, deleteUser } from '../api'
import { session } from '../auth'
import { confirmDialog } from '../components/confirm'
import { toast, toastError } from '../components/toast'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
import AIcon from '../components/AIcon.vue'
import AModal from '../components/AModal.vue'
import DataTable from '../components/DataTable.vue'
import EmptyState from '../components/EmptyState.vue'
import SearchBox from '../components/SearchBox.vue'
import FormField from '../components/FormField.vue'
import TextInput from '../components/TextInput.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { fmtDate, fmtShortDate } from '../utils/format'
import { rovingKeydown, rovingTabindex } from '../utils/roving'

defineOptions({ name: 'UsersPage' })

/*
 * 账号管理：建号、重置密码、启用 / 停用、设为 / 取消管理员、删除。
 * 内网账号不多，接口一次返回全部（普通数组，字段是下划线风格），这里在前端筛选、排序。
 * 服务端会拦住危险操作（不能停用 / 删除自己、至少保留一个管理员），这里只是先把按钮置灰。
 */
const users = shallowRef([])
const loading = ref(true)
const loaded = ref(false)
const error = ref('')
const q = ref('')
const busyId = ref(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    users.value = await listUsers()
    loaded.value = true
  } catch (e) {
    users.value = []
    loaded.value = false
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}
onMounted(load)

const meId = computed(() => session.user?.id)
const adminCount = computed(() => users.value.filter(u => u.role === 'admin' && u.status === 1).length)

/* 排序：点表头（前端排序）；默认和接口一样「管理员在前，再按 ID」 */
const sort = ref({ key: 'role', order: 'desc' })
const SORT_VALUE = {
  id: u => u.id,
  uid: u => u.uid,
  nickname: u => u.nickname || '',
  role: u => (u.role === 'admin' ? 1 : 0),
  status: u => u.status,
  last_login_at: u => u.last_login_at || 0,
  created_at: u => u.created_at || 0
}
const cmp = (a, b) => (typeof a === 'string' || typeof b === 'string' ? String(a).localeCompare(String(b), 'zh-CN') : a - b)
const shown = computed(() => {
  const t = q.value.trim().toLowerCase()
  const list = t ? users.value.filter(u => u.uid.toLowerCase().includes(t) || String(u.nickname || '').toLowerCase().includes(t)) : users.value.slice()
  const get = SORT_VALUE[sort.value?.key]
  if (!get) return list
  const dir = sort.value.order === 'asc' ? 1 : -1
  return list.sort((a, b) => cmp(get(a), get(b)) * dir || a.id - b.id)
})

const columns = [
  { key: 'id', label: 'ID', width: 64, sortable: true, firstOrder: 'asc', class: 'dim' },
  { key: 'uid', label: '登录名', minWidth: 140, sortable: true, firstOrder: 'asc' },
  { key: 'nickname', label: '昵称', minWidth: 120, sortable: true, firstOrder: 'asc' },
  { key: 'role', label: '角色', width: 92, sortable: true },
  { key: 'status', label: '状态', width: 80, sortable: true },
  { key: 'last_login_at', label: '最近登录', width: 112, sortable: true },
  { key: 'created_at', label: '创建时间', width: 112, sortable: true }
]

/* 接口错误没有字段名时，按提示文字归到对应输入框 */
const guessField = (e, map) => (e?.field && map[e.field] ? e.field : Object.keys(map).find(k => map[k].test(e?.message || '')) || '')

/* ---------- 新建账号 ---------- */
const createOpen = ref(false)
const form = ref({ uid: '', nickname: '', password: '', role: 'user' })
const formErr = ref({})
const creating = ref(false)
const showPwd = ref(false)
const ROLES = [{ value: 'user', label: '普通用户' }, { value: 'admin', label: '管理员' }]
const roleIndex = computed(() => ROLES.findIndex(r => r.value === form.value.role))

function openCreate() {
  form.value = { uid: '', nickname: '', password: '', role: 'user' }
  formErr.value = {}
  showPwd.value = false
  createOpen.value = true
}

async function submitCreate() {
  if (creating.value) return
  const f = form.value
  const { uid, nickname, password, role } = f
  const err = {}
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(uid.trim())) err.uid = '登录名需为 3-32 位字母、数字或 _ . -'
  if ((password || '').length < 8) err.password = '密码至少 8 位'
  formErr.value = err
  if (Object.keys(err).length) return
  creating.value = true
  try {
    await createUser({ uid: uid.trim(), nickname: nickname.trim() || uid.trim(), password, role })
    // 请求期间对话框关不掉（closable=false），这里仍按「还是同一份表单」再确认一次
    if (form.value === f) createOpen.value = false
    toast(`已创建账号「${uid.trim()}」`, { type: 'ok' })
    load()
  } catch (e) {
    if (form.value === f) {
      const k = guessField(e, { uid: /登录名/, password: /密码/, nickname: /昵称/ })
      if (k) formErr.value = { [k]: e.message }
    }
    toastError(e, '创建失败')
  } finally {
    creating.value = false
  }
}

/* ---------- 重置密码（弹窗，不用浏览器的 prompt） ---------- */
const pwdUser = ref(null)
const pwdOpen = ref(false)
const pwd = ref({ a: '', b: '' })
const pwdErr = ref({})
const pwdBusy = ref(false)

function openReset(u) {
  pwdUser.value = u
  pwd.value = { a: '', b: '' }
  pwdErr.value = {}
  showPwd.value = false
  pwdOpen.value = true
}
async function submitReset() {
  if (pwdBusy.value) return
  const err = {}
  if (pwd.value.a.length < 8) err.a = '密码至少 8 位'
  else if (pwd.value.a !== pwd.value.b) err.b = '两次输入的密码不一致'
  pwdErr.value = err
  if (Object.keys(err).length) return
  // 记住是给谁重置的：提示和关闭都只认这一个账号（不能套到之后打开的另一个账号上）
  const u = pwdUser.value
  pwdBusy.value = true
  try {
    await resetUserPassword(u.id, pwd.value.a)
    if (pwdUser.value === u) pwdOpen.value = false
    toast(`已重置「${u.nickname || u.uid}」的密码，该账号的登录已失效`, { type: 'ok' })
  } catch (e) {
    if (pwdUser.value === u && pwdOpen.value) pwdErr.value = { a: e.message }
    toastError(e, '重置失败')
  } finally {
    pwdBusy.value = false
  }
}

/* ---------- 启用 / 停用、角色、删除 ---------- */
async function run(u, fn, okText) {
  busyId.value = u.id
  try {
    await fn()
    toast(okText, { type: 'ok' })
    await load()
  } catch (e) {
    toastError(e)
  } finally {
    busyId.value = null
  }
}

async function toggleStatus(u) {
  const next = u.status ? 0 : 1
  if (!next && !(await confirmDialog({ title: '停用账号', message: `确定停用「${u.nickname}」？\n该账号在所有设备上的登录会立即失效，之后也无法再登录。`, confirmText: '停用', danger: true }))) return
  run(u, () => setUserStatus(u.id, next), next ? '已启用' : '已停用')
}

async function toggleRole(u) {
  const next = u.role === 'admin' ? 'user' : 'admin'
  const ok = await confirmDialog(next === 'admin'
    ? { title: '设为管理员', message: `确定把「${u.nickname}」设为管理员？\n管理员可以登录后台、修改所有数据和账号。`, confirmText: '设为管理员' }
    : { title: '取消管理员', message: `确定取消「${u.nickname}」的管理员权限？`, confirmText: '取消管理员', danger: true })
  if (!ok) return
  run(u, () => setUserRole(u.id, next), next === 'admin' ? '已设为管理员' : '已取消管理员')
}

async function remove(u) {
  if (!(await confirmDialog({ title: '删除账号', message: `确定删除账号「${u.nickname}」（${u.uid}）？\n该操作不可恢复。`, confirmText: '删除', danger: true }))) return
  run(u, () => deleteUser(u.id), '已删除')
}

/*
 * 和服务端规则保持一致：可用的管理员只剩 1 个时，任何管理员账号（包括已停用的）都不能
 * 停用、降级或删除（服务端按「可用管理员数」判断）。先把另一个管理员启用即可解除。
 */
const adminLocked = u => u.role === 'admin' && adminCount.value <= 1
const lockTip = u => (u.id === meId.value ? '不能对自己执行此操作' : adminLocked(u) ? '至少要保留一个可用的管理员' : undefined)
</script>

<template>
  <div class="list-page">
    <PageHeader title="账号" :subtitle="loaded ? `共 ${users.length} 个，管理员 ${adminCount} 个` : ''">
      <template #actions>
        <ABtn icon="refresh" :loading="loading" @click="load">刷新</ABtn>
        <ABtn variant="primary" icon="plus" @click="openCreate">新建账号</ABtn>
      </template>
    </PageHeader>

    <div class="filters">
      <SearchBox v-model="q" placeholder="搜索登录名 / 昵称" :delay="0" />
      <button v-if="q" type="button" class="reset" @click="q = ''">清除筛选</button>
      <span class="grow" />
      <span class="dim small tip">停用或重置密码后，该账号所有设备上的登录会立即失效。</span>
    </div>

    <div class="table-area">
      <DataTable v-model:sort="sort" :columns="columns" :rows="shown" :loading="loading" :error="error" :actions-width="244" @retry="load">
        <template #cell-uid="{ row }">
          <span class="row nowrap">
            <span class="mono">{{ row.uid }}</span>
            <span v-if="row.id === meId" class="chip outline">我</span>
          </span>
        </template>
        <template #cell-role="{ row }">
          <span v-if="row.role === 'admin'" class="chip solid">管理员</span>
          <span v-else class="muted">普通用户</span>
        </template>
        <template #cell-status="{ row }"><StatusBadge kind="creator" :status="row.status" /></template>
        <template #cell-last_login_at="{ value }">
          <span v-if="value" class="muted nowrap" :title="fmtDate(value)">{{ fmtShortDate(value) }}</span>
          <span v-else class="dim nowrap">从未登录</span>
        </template>
        <template #cell-created_at="{ value }"><span class="muted nowrap" :title="fmtDate(value)">{{ fmtShortDate(value) }}</span></template>

        <template #actions="{ row }">
          <ABtn size="sm" variant="ghost" icon="key" :disabled="busyId === row.id" @click="openReset(row)">重置密码</ABtn>
          <ABtn
            size="sm"
            variant="ghost"
            :disabled="busyId === row.id || row.id === meId || adminLocked(row)"
            :title="lockTip(row)"
            @click="toggleRole(row)"
          >{{ row.role === 'admin' ? '取消管理' : '设为管理' }}</ABtn>
          <ABtn
            size="sm"
            variant="ghost"
            :disabled="busyId === row.id || row.id === meId || (row.status === 1 && adminLocked(row))"
            :title="row.status === 1 ? lockTip(row) : undefined"
            @click="toggleStatus(row)"
          >{{ row.status ? '停用' : '启用' }}</ABtn>
          <ABtn
            size="sm"
            variant="ghost"
            icon="trash"
            :title="lockTip(row) || '删除'"
            :aria-label="`删除账号 ${row.uid}`"
            :disabled="busyId === row.id || row.id === meId || adminLocked(row)"
            @click="remove(row)"
          />
        </template>

        <template #empty>
          <EmptyState v-if="q" icon="search" title="没有匹配的账号" text="换个登录名或昵称试试">
            <ABtn @click="q = ''">清除筛选</ABtn>
          </EmptyState>
          <EmptyState v-else icon="users" title="还没有账号">
            <ABtn variant="primary" icon="plus" @click="openCreate">新建账号</ABtn>
          </EmptyState>
        </template>
      </DataTable>
      <p class="foot dim small">
        <AIcon name="info" :size="13" />
        至少要保留一个可用的管理员；不能停用、降级或删除自己。忘记管理员密码时，可在服务器上运行
        <code>node server/create-admin.mjs 登录名 新密码 --reset</code>
      </p>
    </div>

    <!-- 新建账号（请求进行中不能关闭，免得结果套到下一次打开的表单上） -->
    <AModal v-model:open="createOpen" title="新建账号" :width="440" persistent :closable="!creating">
      <form class="col gap" novalidate @submit.prevent="submitCreate">
        <FormField label="登录名" required :error="formErr.uid" hint="3-32 位字母、数字或 _ . -，登录时使用">
          <TextInput v-model="form.uid" autocomplete="off" placeholder="例如 editor01" mono />
        </FormField>
        <FormField label="昵称" :error="formErr.nickname" hint="留空则与登录名相同">
          <TextInput v-model="form.nickname" autocomplete="off" placeholder="显示名称" />
        </FormField>
        <FormField label="初始密码" required :error="formErr.password" hint="至少 8 位，建好后告诉对方">
          <div class="pwd">
            <TextInput v-model="form.password" :type="showPwd ? 'text' : 'password'" autocomplete="new-password" placeholder="至少 8 位" />
            <button type="button" class="eye" :aria-label="showPwd ? '隐藏密码' : '显示密码'" :aria-pressed="showPwd ? 'true' : 'false'" @click="showPwd = !showPwd">
              <AIcon :name="showPwd ? 'eye-off' : 'eye'" :size="16" />
            </button>
          </div>
        </FormField>
        <div class="ff-role">
          <span id="role-label" class="role-label">角色</span>
          <div class="seg" role="radiogroup" aria-labelledby="role-label" @keydown="rovingKeydown">
            <button
              v-for="(r, i) in ROLES"
              :key="r.value"
              type="button"
              role="radio"
              :aria-checked="form.role === r.value ? 'true' : 'false'"
              :tabindex="rovingTabindex(i, roleIndex)"
              :class="{ on: form.role === r.value }"
              @click="form.role = r.value"
            >{{ r.label }}</button>
          </div>
        </div>
        <button type="submit" class="sr-only" tabindex="-1">创建</button>
      </form>
      <template #footer>
        <ABtn :disabled="creating" @click="createOpen = false">取消</ABtn>
        <ABtn variant="primary" :loading="creating" @click="submitCreate">创建</ABtn>
      </template>
    </AModal>

    <!-- 重置密码 -->
    <AModal v-model:open="pwdOpen" :title="`重置密码：${pwdUser?.nickname || ''}`" :width="420" persistent :closable="!pwdBusy">
      <form class="col gap" novalidate @submit.prevent="submitReset">
        <p class="muted small">重置后该账号在所有设备上的登录都会失效，需要用新密码重新登录。</p>
        <FormField label="新密码" required :error="pwdErr.a">
          <div class="pwd">
            <TextInput v-model="pwd.a" :type="showPwd ? 'text' : 'password'" autocomplete="new-password" placeholder="至少 8 位" />
            <button type="button" class="eye" :aria-label="showPwd ? '隐藏密码' : '显示密码'" :aria-pressed="showPwd ? 'true' : 'false'" @click="showPwd = !showPwd">
              <AIcon :name="showPwd ? 'eye-off' : 'eye'" :size="16" />
            </button>
          </div>
        </FormField>
        <FormField label="再输入一次" required :error="pwdErr.b">
          <TextInput v-model="pwd.b" :type="showPwd ? 'text' : 'password'" autocomplete="new-password" placeholder="再次输入新密码" />
        </FormField>
        <button type="submit" class="sr-only" tabindex="-1">确定</button>
      </form>
      <template #footer>
        <ABtn :disabled="pwdBusy" @click="pwdOpen = false">取消</ABtn>
        <ABtn variant="primary" :loading="pwdBusy" @click="submitReset">重置密码</ABtn>
      </template>
    </AModal>
  </div>
</template>

<style scoped>
.gap { gap: 14px; }
.tip { white-space: nowrap; }
@media (max-width: 1100px) {
  .tip { display: none; }
}
.foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 12px 0 18px; line-height: 1.6; }
code { padding: 1px 5px; border-radius: 4px; background: #1d1d1d; color: var(--t2); font-family: var(--mono); font-size: 11.5px; }
.pwd { position: relative; }
.pwd :deep(.a-input) { padding-right: 38px; }
.eye { position: absolute; top: 50%; right: 4px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 5px; color: var(--t3); transform: translateY(-50%); }
.eye:hover { color: var(--t1); }
.ff-role { display: flex; flex-direction: column; gap: 6px; }
.role-label { color: var(--t2); font-size: 12.5px; font-weight: 500; }
.seg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 3px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--field); }
.seg button { height: 28px; border-radius: 5px; color: var(--t2); }
.seg button:hover { color: var(--t1); }
.seg button.on { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.seg button:focus-visible { outline-offset: 1px; }
</style>
