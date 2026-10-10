<script setup>
import { ref, shallowRef, watch, onMounted, useTemplateRef } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { getProfile } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import { useKeepScroll } from '@/composables/useKeepScroll'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

defineOptions({ name: 'MeView' })

/* 菜单项；没有 to 的表示功能尚未开放 */
const CELLS = [
  { icon: 'iHistory', label: '观看记录', to: '/history' },
  { icon: 'iDownload', label: '离线缓存' },
  { icon: 'iMsg', label: '消息通知' },
  { icon: 'iHelp', label: '意见反馈' },
  { icon: 'iInfo', label: '关于我们' }
]

const router = useRouter()
const auth = useAuthStore()
const profile = shallowRef(null)
const failed = ref(false)
const scroller = useTemplateRef('scroller')
useKeepScroll(scroller)

const pwdOpen = ref(false)
const oldPwd = ref('')
const newPwd = ref('')
const confirmPwd = ref('')
const changing = ref(false)

async function load() {
  if (!auth.loggedIn) { profile.value = null; failed.value = false; return }
  try {
    profile.value = await getProfile()
    failed.value = false
  } catch {
    failed.value = true
  }
}

function open(cell) {
  if (cell.to) {
    // 观看记录需要登录才有内容
    if (!auth.requireLogin(cell.to)) return
    router.push(cell.to)
  } else {
    toast('功能即将上线')
  }
}

async function signOut() {
  await auth.logout()
  profile.value = null
  toast('已退出登录')
}

function openPwd() {
  oldPwd.value = ''
  newPwd.value = ''
  confirmPwd.value = ''
  pwdOpen.value = true
}

async function submitPwd() {
  if (changing.value) return
  if (!oldPwd.value) return toast('请输入原密码')
  if ((newPwd.value || '').length < 8) return toast('新密码至少 8 位')
  if (newPwd.value !== confirmPwd.value) return toast('两次输入的新密码不一致')
  changing.value = true
  try {
    await auth.changePassword(oldPwd.value, newPwd.value)
    pwdOpen.value = false
    toast('密码已修改，其他设备需重新登录')
  } catch (e) {
    toast(e.message || '修改失败')
  } finally {
    changing.value = false
  }
}

onMounted(load)
/* 登录 / 退出后刷新这一页 */
watch(() => auth.loggedIn, load)
</script>

<template>
  <div class="page me">
    <div v-if="failed" class="empty">
      加载失败，请稍后重试
      <button class="retry" @click="load()">重试</button>
    </div>

    <div v-else ref="scroller" class="scroll">
      <!-- 未登录：一个入口，点开登录弹层 -->
      <div v-if="!auth.loggedIn" class="me-top">
        <div class="me-av guest"><Icon name="tMe" /></div>
        <div>
          <div class="me-nm">未登录</div>
          <div class="me-id">登录后可收藏、同步观看记录</div>
        </div>
        <button class="me-login" @click="auth.loginOpen = true">登录</button>
      </div>

      <template v-else>
        <div class="me-top">
          <Cover v-if="profile?.avatar?.src || profile?.avatar?.fallback" class="me-av" v-bind="profile.avatar" eager />
          <div v-else class="me-av guest"><Icon name="tMe" /></div>
          <div>
            <div class="me-nm">{{ auth.displayName }}</div>
            <div class="me-id">
              账号 {{ auth.user?.uid }}
              <em v-if="auth.isAdmin" class="role">管理员</em>
            </div>
          </div>
          <button class="me-login" @click="signOut">退出登录</button>
        </div>

        <div class="me-stat">
          <template v-for="s in profile?.stats || []" :key="s.label">
            <RouterLink v-if="s.to" :to="s.to">
              <b>{{ s.value }}</b>
              <span>{{ s.label }}</span>
            </RouterLink>
            <button v-else type="button" @click="toast('功能即将上线')">
              <b>{{ s.value }}</b>
              <span>{{ s.label }}</span>
            </button>
          </template>
        </div>

        <div class="me-list">
          <!-- 管理后台是独立页面（admin.html，桌面布局），新窗口打开，不打断手机端的浏览状态 -->
          <a v-if="auth.isAdmin" class="me-cell" href="./admin.html" target="_blank" rel="noopener">
            <Icon name="gear" />
            <span>管理后台</span>
            <Icon name="chevR" class="go" />
          </a>
          <button v-if="auth.isAdmin" class="me-cell" @click="router.push('/admin/users')">
            <Icon name="iHelp" />
            <span>账号管理</span>
            <Icon name="chevR" class="go" />
          </button>
          <button class="me-cell" @click="openPwd">
            <Icon name="iInfo" />
            <span>修改密码</span>
            <Icon name="chevR" class="go" />
          </button>
          <button v-for="c in CELLS" :key="c.label" class="me-cell" @click="open(c)">
            <Icon :name="c.icon" />
            <span>{{ c.label }}</span>
            <Icon name="chevR" class="go" />
          </button>
        </div>
      </template>

      <!-- 未登录时也给一份菜单，避免页面太空 -->
      <div v-if="!auth.loggedIn" class="me-list">
        <button v-for="c in CELLS" :key="c.label" class="me-cell" @click="open(c)">
          <Icon :name="c.icon" />
          <span>{{ c.label }}</span>
          <Icon name="chevR" class="go" />
        </button>
      </div>

      <div class="pad-b" />
    </div>

    <!-- 改密码：独立的小弹层 -->
    <Teleport to="#app">
      <Transition name="sheet-mask">
        <div v-if="pwdOpen" class="mask" @click="pwdOpen = false" />
      </Transition>
      <Transition name="sheet">
        <div v-if="pwdOpen" class="sheet pwd" role="dialog" aria-modal="true" aria-labelledby="pwd-title" @keydown.esc="pwdOpen = false">
          <div class="grab" />
          <h4 id="pwd-title">修改密码</h4>
          <div class="pwd-form">
            <input v-model="oldPwd" type="password" autocomplete="current-password" placeholder="原密码">
            <input v-model="newPwd" type="password" autocomplete="new-password" placeholder="新密码（至少 8 位）">
            <input v-model="confirmPwd" type="password" autocomplete="new-password" placeholder="再输一次新密码">
            <button class="pwd-btn" :disabled="changing" @click="submitPwd">{{ changing ? '提交中…' : '确认修改' }}</button>
            <p class="pwd-hint">修改成功后，其他设备需要重新登录。</p>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.me-top { display: flex; align-items: center; gap: 14px; padding: 22px 14px 0; }
.me-av { width: 64px; height: 64px; border-radius: 50%; box-shadow: 0 0 0 2px rgba(255, 255, 255, .3); filter: var(--media); }
.me-av.guest { display: grid; place-items: center; background: var(--field); box-shadow: none; }
.me-av.guest svg { width: 28px; height: 28px; color: var(--t2); }
.me-nm { font-size: 18px; font-weight: 700; line-height: 26px; }
.me-id { display: flex; align-items: center; gap: 8px; color: var(--t2); font-size: 12px; line-height: 18px; }
.me-id em { height: 16px; padding: 0 6px; border-radius: 8px; background: #1e1e1e; font-size: 10.5px; font-style: normal; line-height: 16px; }
.me-id em.role { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.me-login { height: 30px; margin-left: auto; padding: 0 16px; border-radius: 15px; background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 700; }

.me-stat { display: grid; grid-template-columns: repeat(4, 1fr); margin: 20px 14px 0; padding: 14px 0; border-radius: 12px; background: var(--panel); }
.me-stat > * { text-align: center; cursor: pointer; }
.me-stat b { display: block; font-size: 17px; font-weight: 700; line-height: 22px; font-variant-numeric: tabular-nums; }
.me-stat span { color: var(--t2); font-size: 12px; }

.me-list { margin: 14px 14px 0; border-radius: 12px; background: var(--panel); overflow: hidden; }
.me-cell { display: flex; align-items: center; gap: 12px; width: 100%; height: 50px; padding: 0 14px; border-bottom: 1px solid var(--line); font-size: 14px; text-align: left; }
.me-cell:last-child { border: 0; }
.me-cell > svg:first-child { width: 20px; height: 20px; color: var(--t2); }
.me-cell .go { width: 15px; height: 15px; margin-left: auto; color: #5a5a5a; }
.me-cell:active { background: #161616; }

.pwd { padding-bottom: calc(22px + var(--safe-b)); }
.pwd-form { display: flex; flex-direction: column; gap: 10px; }
.pwd-form input { height: 44px; padding: 0 14px; border: 0; border-radius: 10px; background: var(--field); color: var(--t1); font-size: 15px; }
.pwd-form input::placeholder { color: #6e6e6e; }
.pwd-btn { height: 44px; margin-top: 4px; border-radius: 10px; background: var(--accent); color: var(--on-accent); font-size: 15px; font-weight: 700; }
.pwd-btn:disabled { opacity: .55; }
.pwd-hint { color: var(--t2); font-size: 12px; line-height: 18px; text-align: center; }
</style>
