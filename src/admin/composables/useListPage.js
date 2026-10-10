/*
 * 列表页的状态：筛选 + 分页 + 排序，全部同步到地址栏（?q=…&status=1&page=2），
 * 刷新、前进后退、复制链接给同事都能还原同样的列表。
 *
 *   const list = useListPage(listKeywords, { defaults: { q: '', sort: 'weight', order: 'desc' } })
 *   list.query.q = '春'           // 直接改筛选 → 自动回到第 1 页、清空勾选、重新请求
 *   list.setFilter('status', 1)   // 同上，写法二
 *   list.reload()                 // 保持当前页重新请求（保存 / 删除之后）
 *
 * defaults 里列出的键才会被同步到地址栏；值的类型以默认值为准（数字键会被转成数字）。
 * page / pageSize / sort / order 是内置键（pageSize 默认 20），也可以在 defaults 里改默认值。
 * 地址栏里其他参数（比如编辑器的 ?edit=12）原样保留，变化时也不会触发重新请求。
 *
 * fetcher(params, { signal }) 返回 { total, list }（或直接返回数组）；新请求发出时会取消上一个。
 * 加载失败时 rows / total 清空、loaded 变回 false（APager 在 total 为 0 时不显示）；页头写
 *   :subtitle="loaded ? `共 ${fmtNum(total)} 个` : ''" 即可：首次加载、出错、出错后重试的过程中都不显示旧数字或「共 0 个」。
 */
import { reactive, ref, shallowRef, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const PAGING = ['page', 'pageSize', 'sort', 'order']
const PAGE_SIZES = [20, 50, 100, 200]
const isEmpty = v => v === null || v === undefined || v === ''

export function useListPage(fetcher, { defaults = {} } = {}) {
  const route = useRoute()
  const router = useRouter()
  const path = route.path

  const base = { page: 1, pageSize: 20, sort: '', order: '', ...defaults }
  const keys = Object.keys(base)
  const filterKeys = keys.filter(k => !PAGING.includes(k))

  /** 地址栏 → 查询对象（缺省用默认值，数字键转数字） */
  function readRoute() {
    const q = {}
    for (const k of keys) {
      let v = route.query[k]
      if (Array.isArray(v)) v = v[0]
      if (isEmpty(v)) { q[k] = base[k]; continue }
      if (typeof base[k] === 'number') {
        const n = Number(v)
        q[k] = Number.isFinite(n) ? n : base[k]
      } else q[k] = String(v)
    }
    if (!(q.page >= 1)) q.page = 1
    q.page = Math.floor(q.page)
    if (!PAGE_SIZES.includes(q.pageSize)) q.pageSize = PAGE_SIZES.includes(base.pageSize) ? base.pageSize : 20
    if (q.order && q.order !== 'asc' && q.order !== 'desc') q.order = base.order
    return q
  }

  const query = reactive(readRoute())
  const rows = shallowRef([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref('')
  const selected = ref([])
  /** 当前显示的是一次成功加载的结果（首次加载完成前、出错后为 false，直到下次加载成功） */
  const loaded = ref(false)

  const sigOf = (q, ks) => JSON.stringify(ks.map(k => (isEmpty(q[k]) ? '' : String(q[k]))))
  let filterSig = sigOf(query, filterKeys)
  let resetSig = sigOf(query, [...filterKeys, 'pageSize', 'sort', 'order'])

  /** 查询对象 → 地址栏参数：等于默认值的不写，非本页管理的参数保留 */
  function toRouteQuery() {
    const out = {}
    for (const [k, v] of Object.entries(route.query)) if (!keys.includes(k)) out[k] = v
    for (const k of keys) {
      const v = query[k]
      if (isEmpty(v) || String(v) === String(base[k] ?? '')) continue
      out[k] = String(v)
    }
    return out
  }
  const sameQuery = (a, b) => {
    const ka = Object.keys(a).filter(k => !isEmpty(a[k]))
    const kb = Object.keys(b).filter(k => !isEmpty(b[k]))
    return ka.length === kb.length && ka.every(k => String(a[k]) === String(b[k]))
  }

  /* 用户改了筛选 / 排序 / 每页条数 → 回到第 1 页（筛选变了还要清空勾选），再写回地址栏 */
  watch(query, () => {
    const fs = sigOf(query, filterKeys)
    const rs = sigOf(query, [...filterKeys, 'pageSize', 'sort', 'order'])
    if (fs !== filterSig) { filterSig = fs; selected.value = [] }
    if (rs !== resetSig) { resetSig = rs; if (query.page !== 1) query.page = 1 }
    const next = toRouteQuery()
    if (route.path === path && !sameQuery(next, route.query)) router.replace({ query: next }).catch(() => {})
  }, { deep: true })

  /* 地址栏变了（前进后退、点了带参数的链接、上面的 replace 完成）→ 同步回查询对象并请求 */
  const routeSig = computed(() => (route.path === path ? JSON.stringify(readRoute()) : null))
  watch(routeSig, (s, old) => {
    if (s == null || s === old) return
    const next = JSON.parse(s)
    // 先更新签名，免得上面的 watch 把「后退带回来的页码」当成筛选变化重置成 1；
    // 筛选从地址栏变了（深链、侧栏、前进后退）同样要清空勾选，否则批量操作会落到看不见的行上
    const fs = sigOf(next, filterKeys)
    if (fs !== filterSig) selected.value = []
    filterSig = fs
    resetSig = sigOf(next, [...filterKeys, 'pageSize', 'sort', 'order'])
    for (const k of keys) if (query[k] !== next[k]) query[k] = next[k]
    load()
  })

  /** 发给接口的参数：去掉空值 */
  function params() {
    const p = {}
    for (const k of keys) if (!isEmpty(query[k])) p[k] = query[k]
    return p
  }

  let ctrl = null
  let seq = 0
  let waiters = []
  async function load() {
    ctrl?.abort()
    ctrl = new AbortController()
    const my = ++seq
    loading.value = true
    error.value = ''
    try {
      const res = await fetcher(params(), { signal: ctrl.signal })
      if (my !== seq) return
      const list = Array.isArray(res) ? res : res?.list || []
      rows.value = list
      total.value = Array.isArray(res) ? list.length : Number(res?.total) || 0
      loaded.value = true
      // 删光了最后一页：退到实际的最后一页
      if (!list.length && total.value > 0 && query.page > 1) {
        query.page = Math.max(1, Math.ceil(total.value / query.pageSize))
      }
    } catch (e) {
      if (my !== seq || e?.name === 'AbortError') return
      // 清掉旧数据和总数，让表格显示「加载失败 + 重试」、分页条隐藏，免得把过期的数字当成当前筛选结果
      rows.value = []
      total.value = 0
      loaded.value = false
      error.value = e?.message || '加载失败'
    } finally {
      if (my === seq) {
        loading.value = false
        const w = waiters
        waiters = []
        w.forEach(fn => fn())
      }
    }
  }
  load()
  onBeforeUnmount(() => ctrl?.abort())

  /** 等当前这次加载结束（深链打开编辑器时要先等列表到手） */
  const whenLoaded = () => (loading.value ? new Promise(r => waiters.push(r)) : Promise.resolve())

  function setFilter(key, value) {
    query[key] = isEmpty(value) ? base[key] : value
  }
  function resetFilters() {
    for (const k of filterKeys) query[k] = base[k]
  }
  const hasFilters = computed(() => filterKeys.some(k => String(query[k] ?? '') !== String(base[k] ?? '')))
  const clearSelection = () => { selected.value = [] }

  /** 给 DataTable 的 v-model:sort 用 */
  const sortModel = computed({
    get: () => ({ key: query.sort, order: query.order || 'desc' }),
    set: v => { query.sort = v?.key || base.sort; query.order = v?.order || base.order }
  })

  /**
   * 只改当前页里的一行（行内开关的乐观更新、保存后用接口返回的新数据替换），不重新请求。
   * rows 是 shallowRef，直接改行对象的属性不会刷新界面，所以这里整体换一个新数组。
   */
  function patchRow(id, changes) {
    rows.value = rows.value.map(r => (r.id === id ? { ...r, ...changes } : r))
  }

  /** 当前页里被勾选的行对象（跨页勾选的只有 id） */
  const selectedRows = computed(() => {
    const set = new Set(selected.value)
    return rows.value.filter(r => set.has(r.id))
  })

  return {
    query, rows, total, loading, error, selected, loaded,
    reload: load, setFilter, resetFilters, hasFilters, clearSelection, sortModel, selectedRows, params, whenLoaded, patchRow
  }
}
