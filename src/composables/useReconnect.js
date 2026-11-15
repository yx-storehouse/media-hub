import { computed, getCurrentInstance, onActivated, onBeforeUnmount, onDeactivated, onMounted, shallowRef, unref, watch } from 'vue'

/*
 * 出错页自动恢复（断网、服务器 / 容器重启、反向代理 502 之后不用用户自己点「重试」）：
 *
 *   import { useReconnect } from '@/composables/useReconnect'
 *   const { offline } = useReconnect(load, () => !!error.value)   // retry 和「重试」按钮是同一个函数
 *
 *   - 浏览器报告重新联网（online 事件）：正处于出错状态就马上重试一次；
 *   - 出错状态下、页面看得见（标签页在前台，KeepAlive 的页面是激活的）时静默重试：12 秒一次，越试越慢（最多 60 秒一次）——
 *     服务器重启、网关 502 不会触发 online 事件，靠它恢复；
 *   - 切回前台、KeepAlive 的页面被切回来：出错中就马上重试一次；
 *   - 上一次重试还没结束（retry 返回的 Promise）就不再发起。
 * failed：返回「现在是不是出错状态」的函数 / ref；retry 抛的错自己吞掉（页面自己会显示出错）。
 * 返回 { offline }：浏览器报告断网时为 true（出错提示可以写 MSG.offline「网络已断开，连上网后会自动重新加载」）。
 * 渲染出错状态的地方直接用 components/common/LoadState.vue 就行，它已经接好了这个。
 */

/* 全 App 共用一个联网状态 */
const onlineRef = shallowRef(typeof navigator === 'undefined' || navigator.onLine !== false)
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { onlineRef.value = true })
  window.addEventListener('offline', () => { onlineRef.value = false })
}
/** 浏览器现在是不是报告断网（只读） */
export const isOffline = computed(() => !onlineRef.value)

const FIRST = 12000
const MAX = 60000

export function useReconnect(retry, failed, { interval = FIRST } = {}) {
  const isFailed = () => !!(typeof failed === 'function' ? failed() : unref(failed))
  let active = true
  let busy = false
  let timer = 0
  let wait = interval

  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

  async function run() {
    clearTimeout(timer)
    timer = 0
    if (busy || !active || !isFailed() || !visible()) return schedule()
    busy = true
    try {
      await retry()
    } catch { /* 页面自己显示出错 */ }
    busy = false
    wait = Math.min(MAX, wait * 2)
    schedule()
  }

  function schedule() {
    clearTimeout(timer)
    timer = 0
    if (!active || !isFailed()) return
    timer = setTimeout(run, wait)
  }

  // 进入出错状态：从头计时；恢复了：停掉
  watch(isFailed, bad => {
    wait = interval
    if (bad) schedule()
    else {
      clearTimeout(timer)
      timer = 0
    }
  }, { immediate: true })

  const onOnline = () => { if (isFailed()) { wait = interval; run() } }
  const onVisible = () => { if (visible() && isFailed()) run() }

  const start = () => {
    if (typeof window === 'undefined') return
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
  }
  const stop = () => {
    clearTimeout(timer)
    timer = 0
    if (typeof window === 'undefined') return
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisible)
  }

  if (getCurrentInstance()) {
    onMounted(start)
    onBeforeUnmount(() => { active = false; stop() })
    // KeepAlive：切走时不在后台重试，切回来时出错中就马上试一次
    onDeactivated(() => { active = false; stop() })
    onActivated(() => {
      if (active) return
      active = true
      start()
      if (isFailed()) run()
    })
  } else {
    start()
  }

  return { offline: isOffline }
}
