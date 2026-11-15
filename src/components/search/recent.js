import { shallowRef, computed, watch, effectScope } from 'vue'
import { getSearchHistory, clearSearchHistory } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'

/*
 * 近期搜索（关键词）：新的在前、同一个词只留一条，没结果的搜索也算。
 *   登录时：服务端记录（搜索接口第一页顺便记下），这里只负责读、删
 *   未登录：存在本机 localStorage（读写都包 try/catch，隐私模式下存不了也不报错）
 * 登录用户的记录不写进本机，同一台设备退出登录后看不到别人的搜索词。
 *
 * 全 App 共用一份列表：搜索页和桌面顶栏的搜索框（DeskSearch）谁搜了一次（note），另一边马上就看得到，
 * 不用等下一次从服务端重读。
 */
const KEY = 'reel:search:recent'
const MAX = 20      // 本机最多存这么多
const SHOW = 10     // 页面上最多显示这么多
const KEYWORD_MAX = 100   // 和服务端 SEARCH_KEYWORD_MAX 一致

const clean = kw => [...String(kw ?? '').trim()].slice(0, KEYWORD_MAX).join('')

function readLocal() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(list) ? list.filter(k => typeof k === 'string' && k) : []
  } catch {
    return []
  }
}

function writeLocal(list) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
    else localStorage.removeItem(KEY)
  } catch { /* 存不了就算了 */ }
}

const withFirst = (list, kw) => [kw, ...list.filter(k => k !== kw)]

/* ---- 共用的状态（第一次用到时建好，之后一直在：不跟着某个组件卸载） ---- */
let shared = null

function create() {
  const auth = useAuthStore()
  const list = shallowRef([])
  /*
   * 登录状态还没确认（启动时带着 token 校验中，或者连不上服务器、还不知道是谁）为 null：
   * 这时不读也不写本机记录，免得把登录用户的词存进本机
   */
  const session = computed(() => {
    if (!auth.ready) return null
    if (auth.user) return auth.user.id
    return auth.token && !auth.verified ? null : 0
  })
  /* 这次该用本机记录：确认未登录，或者还在校验但根本没有 token */
  const local = () => session.value === 0 || (session.value === null && !auth.token)
  let seq = 0

  async function load() {
    const token = ++seq
    if (local()) {
      list.value = readLocal().slice(0, SHOW)
      return
    }
    if (session.value === null) return
    try {
      const res = await getSearchHistory({ limit: SHOW })
      if (token === seq) list.value = (res?.list || []).map(x => x.keyword).filter(Boolean)
    } catch {
      // 读不到就先不显示这一块，不打扰
      if (token === seq) list.value = []
    }
  }

  /** 搜了一次：放到最前面（登录时服务端已经记下，这里只更新显示） */
  function note(kw) {
    const k = clean(kw)
    if (!k) return
    seq++   // 之前还没回来的读取作废，免得把这次搜索冲掉
    list.value = withFirst(list.value, k).slice(0, SHOW)
    if (local()) writeLocal(withFirst(readLocal(), k))
  }

  /** 删一个词；失败时提示并重新读一次 */
  async function remove(kw) {
    seq++
    list.value = list.value.filter(k => k !== kw)
    if (local()) {
      writeLocal(readLocal().filter(k => k !== kw))
      return
    }
    try {
      await clearSearchHistory(kw)
    } catch {
      toast('删除失败，请稍后重试')
      load()
    }
  }

  /** 清空全部 */
  async function clear() {
    seq++
    const before = list.value
    list.value = []
    if (local()) {
      writeLocal([])
      toast('已清除搜索记录')
      return
    }
    try {
      await clearSearchHistory()
      toast('已清除搜索记录')
    } catch {
      list.value = before
      toast('清除失败，请稍后重试')
    }
  }

  // 启动时的登录校验完成、登录 / 退出后，换成对应的记录（同一个账号只是核对上了，不重读）
  watch(session, load, { immediate: true })

  return { list, load, note, remove, clear }
}

/**
 * 近期搜索：{ list, load, note, remove, clear }，所有调用方拿到的是同一份。
 *   list    关键词数组（shallowRef，新的在前，最多 10 个）
 *   load()  重新读一次（登录时从服务端，未登录从本机）
 *   note(kw)  搜了一次：马上放到最前面（未登录时顺便存进本机）
 */
export function useRecentSearches() {
  if (!shared) {
    // 不挂在调用它的组件上：组件卸载了，共用的列表和监听照样在
    shared = effectScope(true).run(create)
  }
  return shared
}
