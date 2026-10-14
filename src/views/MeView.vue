<script setup>
import { ref, reactive, shallowRef, computed, watch, nextTick, onMounted, onActivated, onDeactivated, useTemplateRef } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { getProfile } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { useBackDismiss } from '@/composables/useBackDismiss'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import ConfirmSheet from '@/components/me/ConfirmSheet.vue'
import { countUp } from '@/components/home/motion'

defineOptions({ name: 'MeView' })

/* 菜单项；没有 to 的表示功能尚未开放 */
const CELLS = [
  { icon: 'iHistory', label: '观看历史', to: '/history' },
  { icon: 'iDownload', label: '离线缓存' },
  { icon: 'iMsg', label: '消息通知' },
  { icon: 'iHelp', label: '意见反馈' },
  { icon: 'iInfo', label: '关于我们' }
]

/* 统计行的三格：接口还没回来 / 未登录时也占住位置，点了先登录，登录后进对应页面 */
const STAT_SLOTS = [
  { key: 'history', label: '观看历史', to: '/history' },
  { key: 'favs', label: '我的收藏', to: '/favorites' },
  { key: 'follows', label: '我的关注', to: '/follows' }
]

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const profile = shallowRef(null)
const failed = ref(false)
const scroller = useTemplateRef('scroller')
useKeepScroll(scroller)

/*
 * v-count：统计数字。第一次拿到（从「-」变成数字）时从 0 数上去；之后数字变了（切回本页时的静默刷新）
 * 从旧的数到新的；页面收起着的时候直接换。数字由这里写，Vue 不管这个元素的文字。
 */
const vCount = {
  mounted(el, { value }) {
    el.textContent = String(value)
  },
  updated(el, { value, oldValue }) {
    if (value === oldValue) return
    const to = Number(value)
    const from = oldValue === '-' || oldValue == null ? 0 : Number(oldValue)
    if (el.isConnected && Number.isFinite(to) && Number.isFinite(from) && to > 0) countUp(el, to, { from })
    else {
      cancelAnimationFrame(el._countRaf)
      el.textContent = String(value)
    }
  },
  unmounted(el) {
    cancelAnimationFrame(el._countRaf)
  }
}

const stats = computed(() => {
  const got = profile.value?.stats || []
  return STAT_SLOTS.map(slot => {
    const s = got.find(x => x.key === slot.key)
    return { ...slot, ...s, value: auth.loggedIn && s ? s.value : '-' }
  })
})

/* silent：切回本页时的静默刷新，失败就保留原来的数字 */
let loadSeq = 0
async function load({ silent = false } = {}) {
  const token = ++loadSeq
  if (!auth.loggedIn) { profile.value = null; failed.value = false; return }
  try {
    const p = await getProfile()
    if (token !== loadSeq) return
    profile.value = p
    failed.value = false
  } catch {
    if (token === loadSeq && !silent) failed.value = true
  }
}

/* 需要登录的入口：未登录先弹登录框，登录后直接进去 */
function go(to) {
  if (!auth.requireLogin(to)) return
  router.push(to)
}

function open(cell) {
  if (cell.to) go(cell.to)
  else toast('功能即将上线')
}

/* ---------- 退出登录：先确认 ---------- */

const askLogout = ref(false)

async function signOut() {
  await auth.logout()
  profile.value = null
  toast('已退出登录')
}

/* ---------- 修改密码 ---------- */

const PWD_FIELDS = [
  { key: 'old', label: '原密码', autocomplete: 'current-password', placeholder: '输入现在的密码', enter: 'next' },
  { key: 'next', label: '新密码', autocomplete: 'new-password', placeholder: '至少 8 位', enter: 'next' },
  { key: 'again', label: '确认新密码', autocomplete: 'new-password', placeholder: '再输一次新密码', enter: 'done' }
]
const pwdOpen = ref(false)
useBackDismiss(pwdOpen) // 返回键只关改密码弹层
const pwd = reactive({ old: '', next: '', again: '' })
const shown = reactive({ old: false, next: false, again: false })
const errs = reactive({ old: '', next: '', again: '' })
const formErr = ref('')
const changing = ref(false)
const inputs = {}
let returnFocus = null

function resetPwd() {
  for (const f of PWD_FIELDS) {
    pwd[f.key] = ''
    shown[f.key] = false
    errs[f.key] = ''
  }
  formErr.value = ''
}

function openPwd() {
  resetPwd()
  returnFocus = document.activeElement
  pwdOpen.value = true
  // preventScroll：弹层这时还在屏幕下面（升起动画的起点），不然浏览器会把整个页面往上滚一截再晃回来；
  // 不认这个参数的老 iOS 聚焦后把外壳拨回原位（和 LoginSheet 一样）
  nextTick(() => {
    inputs.old?.focus({ preventScroll: true })
    const app = document.getElementById('app')
    if (app?.scrollTop) app.scrollTop = 0
  })
}

/* 关掉时清空输入（密码不留在页面里），焦点还给「修改密码」那一行 */
watch(pwdOpen, isOpen => {
  if (isOpen) return
  resetPwd()
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
  returnFocus = null
})
watch(() => route.fullPath, () => { pwdOpen.value = false })
onDeactivated(() => { pwdOpen.value = false; askLogout.value = false })

function onInput(key) {
  errs[key] = ''
  formErr.value = ''
}

/* 回车：跳到下一个框，最后一个框提交 */
function onEnter(i) {
  const nextField = PWD_FIELDS[i + 1]
  if (nextField) inputs[nextField.key]?.focus()
  else submitPwd()
}

function check() {
  if (!pwd.old) errs.old = '请输入原密码'
  if (pwd.next.length < 8) errs.next = pwd.next ? '新密码至少 8 位' : '请输入新密码'
  else if (pwd.next === pwd.old) errs.next = '新密码不能和原密码一样'
  if (!errs.next) {
    if (!pwd.again) errs.again = '请再输一次新密码'
    else if (pwd.again !== pwd.next) errs.again = '两次输入的新密码不一致'
  }
  const bad = PWD_FIELDS.find(f => errs[f.key])
  if (bad) inputs[bad.key]?.focus()
  return !bad
}

async function submitPwd() {
  if (changing.value) return
  for (const f of PWD_FIELDS) errs[f.key] = ''
  formErr.value = ''
  if (!check()) return
  changing.value = true
  let refocus = null
  try {
    await auth.changePassword(pwd.old, pwd.next)
    pwdOpen.value = false
    toast('密码已修改，其他设备需重新登录')
  } catch (e) {
    // 原密码不对：提示放在原密码下面；其他错误（网络等）放在按钮上面
    if (/原密码/.test(e?.message || '')) {
      errs.old = e.message
      refocus = 'old'
    } else {
      formErr.value = e?.message || '修改失败，请稍后重试'
    }
  } finally {
    changing.value = false
  }
  // 提交期间输入框是禁用的，等恢复了再把焦点放回去
  if (refocus) nextTick(() => inputs[refocus]?.focus())
}

onMounted(load)
/* 登录 / 退出后刷新这一页 */
watch(() => auth.loggedIn, () => load())
/* 切回「我的」时静默刷新计数（在别处收藏、关注、看过之后数字是新的） */
let mounted = false
onActivated(() => {
  if (mounted) load({ silent: true })
  mounted = true
})
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
        <button class="me-login m-press" @click="auth.requireLogin()">登录</button>
      </div>

      <div v-else class="me-top">
        <Cover v-if="profile?.avatar?.src || profile?.avatar?.fallback" class="me-av" v-bind="profile.avatar" eager />
        <div v-else class="me-av guest"><Icon name="tMe" /></div>
        <div class="me-who">
          <div class="me-nm">{{ auth.displayName }}</div>
          <div class="me-id">
            账号 {{ auth.user?.uid }}
            <em v-if="auth.isAdmin" class="role">管理员</em>
          </div>
        </div>
      </div>

      <!-- 观看历史 / 我的收藏 / 我的关注：数字是实时统计，点进对应列表 -->
      <nav class="me-stat" aria-label="我的内容">
        <template v-for="s in stats" :key="s.key">
          <RouterLink v-if="auth.loggedIn" :to="s.to">
            <b v-count="s.value" />
            <span>{{ s.label }}</span>
          </RouterLink>
          <button v-else type="button" @click="go(s.to)">
            <b v-count="s.value" />
            <span>{{ s.label }}</span>
          </button>
        </template>
      </nav>

      <div class="me-list">
        <button v-for="c in CELLS" :key="c.label" class="me-cell" @click="open(c)">
          <Icon :name="c.icon" />
          <span>{{ c.label }}</span>
          <Icon name="chevR" class="go" />
        </button>
      </div>

      <!-- 账号相关：管理入口、修改密码；退出登录单独放在最下面，点了先确认，避免误触 -->
      <template v-if="auth.loggedIn">
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
            <Icon name="lock" />
            <span>修改密码</span>
            <Icon name="chevR" class="go" />
          </button>
        </div>
        <div class="me-list">
          <button class="me-cell me-out" @click="askLogout = true">退出登录</button>
        </div>
      </template>

      <div class="pad-b" />
    </div>

    <ConfirmSheet
      v-model:open="askLogout"
      title="退出登录？"
      text="退出后需要重新输入账号和密码才能登录。"
      ok="退出登录"
      danger
      @confirm="signOut"
    />

    <!-- 改密码：独立的小弹层；每个框上面有常驻的标签，出错提示就在出错的框下面 -->
    <Teleport to="#app">
      <Transition name="sheet-mask">
        <div v-if="pwdOpen" class="mask" @click="pwdOpen = false" />
      </Transition>
      <Transition name="sheet">
        <div v-if="pwdOpen" class="sheet pwd" role="dialog" aria-modal="true" aria-labelledby="pwd-title" @keydown.esc="pwdOpen = false">
          <div class="grab" />
          <h4 id="pwd-title">修改密码</h4>
          <form class="pwd-form" novalidate @submit.prevent="submitPwd">
            <!-- 给浏览器的密码管理用：这是哪个账号的密码 -->
            <input type="text" name="username" autocomplete="username" :value="auth.user?.uid || ''" readonly hidden>
            <div v-for="(f, i) in PWD_FIELDS" :key="f.key" class="pf" :class="{ bad: errs[f.key] }">
              <label class="pf-lb" :for="`pwd-${f.key}`">{{ f.label }}</label>
              <div class="pf-box">
                <input
                  :id="`pwd-${f.key}`"
                  :ref="el => { inputs[f.key] = el }"
                  v-model="pwd[f.key]"
                  :type="shown[f.key] ? 'text' : 'password'"
                  :name="f.key === 'old' ? 'current-password' : `new-password-${i}`"
                  :autocomplete="f.autocomplete"
                  :placeholder="f.placeholder"
                  :enterkeyhint="f.enter"
                  autocapitalize="off"
                  spellcheck="false"
                  :disabled="changing"
                  :aria-invalid="!!errs[f.key]"
                  :aria-describedby="errs[f.key] ? `pwd-${f.key}-err` : undefined"
                  @input="onInput(f.key)"
                  @keydown.enter.prevent="onEnter(i)"
                >
                <button
                  type="button"
                  class="pf-eye"
                  :aria-pressed="shown[f.key]"
                  :aria-label="`${shown[f.key] ? '隐藏' : '显示'}${f.label}`"
                  @click="shown[f.key] = !shown[f.key]"
                >
                  {{ shown[f.key] ? '隐藏' : '显示' }}
                </button>
              </div>
              <p v-if="errs[f.key]" :id="`pwd-${f.key}-err`" class="pf-err" role="alert">{{ errs[f.key] }}</p>
            </div>
            <p v-if="formErr" class="pf-err form" role="alert">{{ formErr }}</p>
            <button class="pwd-btn m-press" type="submit" :disabled="changing">{{ changing ? '提交中…' : '确认修改' }}</button>
            <p class="pwd-hint">修改成功后，其他设备需要重新登录。</p>
          </form>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.me-top { display: flex; align-items: center; gap: 14px; padding: 22px 14px 0; }
.me-av { flex: none; width: 64px; height: 64px; border-radius: 50%; box-shadow: 0 0 0 2px rgba(255, 255, 255, .3); filter: var(--media); }
.me-av.guest { display: grid; place-items: center; background: var(--field); box-shadow: none; }
.me-av.guest svg { width: 28px; height: 28px; color: var(--t2); }
.me-who { min-width: 0; }
.me-nm { overflow: hidden; font-size: 18px; font-weight: 700; line-height: 26px; text-overflow: ellipsis; white-space: nowrap; }
.me-id { display: flex; align-items: center; gap: 8px; color: var(--t2); font-size: 12px; line-height: 18px; }
.me-id em { height: 16px; padding: 0 6px; border-radius: 8px; background: #1e1e1e; font-size: 10.5px; font-style: normal; line-height: 16px; }
.me-id em.role { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.me-login { flex: none; height: 30px; margin-left: auto; padding: 0 16px; border-radius: 15px; background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 700; }

/* 每一格一样宽，格数跟着接口走 */
.me-stat { display: grid; grid-auto-columns: 1fr; grid-auto-flow: column; margin: 20px 14px 0; padding: 6px 0; border-radius: 12px; background: var(--panel); }
.me-stat > * { display: block; padding: 8px 0; text-align: center; cursor: pointer; transition: opacity var(--dur-2) var(--ease-out); }
.me-stat > *:active { opacity: .6; transition-duration: var(--dur-1); }
.me-stat b { display: block; font-size: 17px; font-weight: 700; line-height: 22px; font-variant-numeric: tabular-nums; }
.me-stat span { color: var(--t2); font-size: 12px; }
.me-stat :focus-visible { outline-offset: -2px; }

.me-list { margin: 14px 14px 0; border-radius: 12px; background: var(--panel); overflow: hidden; }
.me-cell { display: flex; align-items: center; gap: 12px; width: 100%; height: 50px; padding: 0 14px; border-bottom: 1px solid var(--line); font-size: 14px; text-align: left; transition: background-color var(--dur-2) var(--ease-out); }
.me-cell:last-child { border: 0; }
.me-cell > svg:first-child { width: 20px; height: 20px; color: var(--t2); }
.me-cell .go { width: 15px; height: 15px; margin-left: auto; color: #5a5a5a; }
.me-cell:active { background: #161616; transition-duration: var(--dur-1); }
.me-cell .go { transition: transform var(--dur-2) var(--ease-out); }
.me-cell:active .go { transform: translateX(2px); }
.me-cell:focus-visible { outline-offset: -2px; }
.me-out { justify-content: center; color: var(--t2); }

/* ---- 改密码 ---- */
.pwd { padding-bottom: calc(22px + var(--safe-b)); }
.pwd-form { display: flex; flex-direction: column; gap: 12px; }
.pf-lb { display: block; margin-bottom: 6px; color: var(--t2); font-size: 12.5px; line-height: 18px; }
.pf-box { display: flex; align-items: center; height: 44px; border-radius: 10px; background: var(--field); transition: box-shadow var(--dur-2) var(--ease-out); }
.pf-box:focus-within { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18); }
.pf.bad .pf-box { box-shadow: inset 0 0 0 1px rgba(255, 128, 128, .55); }
.pf-box input { flex: 1; min-width: 0; height: 100%; padding: 0 0 0 14px; border: 0; background: none; color: var(--t1); font-size: 15px; }
.pf-box input::placeholder { color: #6e6e6e; }
.pf-box input:disabled { opacity: .6; }
.pf-eye { flex: none; height: 100%; padding: 0 14px; color: var(--t2); font-size: 13px; }
.pf-eye[aria-pressed="true"] { color: var(--t1); }
.pf-eye:focus-visible { outline-offset: -2px; }
/* 出错提示从上面轻轻落下 */
.pf-err { margin-top: 6px; color: #ff8080; font-size: 12.5px; line-height: 18px; animation: m-rise var(--dur-2) var(--ease-out); --rise: -4px; }
.pf-err.form { margin-top: 0; }
.pwd-btn { height: 44px; margin-top: 4px; border-radius: 10px; background: var(--accent); color: var(--on-accent); font-size: 15px; font-weight: 700; transition: opacity var(--dur-2) var(--ease-out); }
.pwd-btn:disabled { opacity: .55; }
.pwd-hint { color: var(--t2); font-size: 12px; line-height: 18px; text-align: center; }
</style>
