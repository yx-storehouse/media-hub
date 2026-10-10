/*
 * 批量导入向导的状态（ImportPage 创建一份，provide 给各步骤组件 inject）。
 *
 *   数据：table = { headers, rows, rowNos }（几万行，放在 shallowRef 里，不做深层响应式）；
 *         raw = 读入的所有非空行（换「表头在第几行」时从它重算 table），见 parse.js
 *   第 2 步：mapping[列下标] = 字段 key（'' = 不导入）+ options
 *   第 3 步：预检 dryRun，每批 5000 行；第 4 步：正式导入，每批 1000 行，批与批之间可以取消、可以继续
 *
 * 正式导入每批带 importId（这次导入一个）+ chunk（第几批）：响应在路上丢了（断网、超时、代理重置）时，
 * 这一批其实可能已经写入；重试时带同样的 importId / chunk，服务端认出来直接返回上次的结果（replayed），不会重复写。
 *
 * results 也可能有几万条：放在 markRaw 的数组里，追加后把 version + 1，表格据此重新取数据。
 */
import { reactive, shallowRef, markRaw, computed, inject } from 'vue'
import { importRows } from '../../api'
import { refreshMeta } from '../../composables/useMeta'
import { loadSchema } from '../../composables/useSchema'
import { typeInfo, isType, exampleMarker } from './types'
import { mapColumns, loadMapping, saveMapping, loadOptions, saveOptions, buildTable } from './parse'

export const PREVIEW_CHUNK = 5000
export const IMPORT_CHUNK = 1000
const KEY = Symbol('import-store')
const DEFAULT_OPTIONS = { onDuplicate: 'skip', defaultStatus: 1, autoCreate: true }

/** 存储里读出来的选项不一定可信：逐项校验 */
function cleanOptions(o) {
  const out = { ...DEFAULT_OPTIONS }
  if (o && ['skip', 'update', 'error'].includes(o.onDuplicate)) out.onDuplicate = o.onDuplicate
  if (o && [0, 1].includes(Number(o.defaultStatus))) out.defaultStatus = Number(o.defaultStatus)
  if (o && typeof o.autoCreate === 'boolean') out.autoCreate = o.autoCreate
  return out
}

/** 这次导入的编号（服务端要求 1-64 位字母、数字、_、-）；内网 http 下没有 crypto.randomUUID，用 getRandomValues */
function newImportId() {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
  return `imp-${Date.now().toString(36)}-${hex}`
}

/**
 * 请求失败时这一批是否「可能已经写入」：服务端明确回了错误（带 HTTP 状态和错误码）说明没写；
 * 断网、超时、网关回了非 JSON 的页面（502 / 504）都可能是服务端已经提交、只是响应没回来。
 */
const maybeCommitted = e => e?.code === 'network' || e?.code === 'timeout' || e?.code === 'bad_response'

function newRun() {
  return {
    status: 'idle', // idle | running | done | error | cancelled
    processed: 0,
    total: 0,
    next: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    error: '',
    /** 出错的那一批可能已经写入（响应丢了），见 maybeCommitted */
    maybeWritten: false,
    /** 重试时服务端认出「这一批之前已经写入」、直接返回上次结果的批数 */
    replayed: 0,
    importId: '',
    cancelRequested: false,
    key: '',
    version: 0,
    results: markRaw([]),
    autoTopics: markRaw(new Set()),
    autoCreators: markRaw(new Set())
  }
}

const yieldUI = () => new Promise(r => setTimeout(r, 0))

export function createImportStore(provideFn) {
  const state = reactive({
    type: 'videos',
    step: 1,
    /** { name, size, format: csv|tsv|xlsx|json|paste, sheets?: [{ name, hidden }], sheetIndex? } */
    source: null,
    tableId: 0,
    /** 表头是 raw.records 里的第几条（第 1 步可以改） */
    headerIndex: 0,
    mapping: [],
    /** mapping 是为哪个「类型 + 数据」算的；换了任意一个就要重新自动对应 */
    mappingFor: '',
    /** 当前对应关系是不是套用了上次记住的 */
    remembered: false,
    /** 模板里没删掉的示例行（源行号）：不发给服务端 */
    exampleRows: [],
    options: { ...DEFAULT_OPTIONS },
    preview: newRun(),
    run: newRun()
  })
  const table = shallowRef(null)
  /** xlsx 工作簿（换工作表用）、读入的原始行（换表头行用），都不需要响应式 */
  let book = null
  let raw = null

  const info = computed(() => typeInfo(state.type))
  const rowCount = computed(() => table.value?.rows.length || 0)

  function useTable(t) {
    table.value = markRaw(t)
    state.tableId++
    state.mapping = t.headers.map(() => '')
    resetRuns()
  }

  /** 读入新数据：t = buildTable(rawData, headerIndex) */
  function setTable(t, source, workbook = null, rawData = null, headerIndex = 0) {
    book = workbook
    raw = rawData ? markRaw(rawData) : null
    state.source = source
    state.headerIndex = headerIndex
    useTable(t)
  }

  /** 第 1 步改「表头在第几行」：从原始行重算表格（列太多等情况会抛错，调用方显示） */
  function setHeaderRow(i) {
    if (!raw || i === state.headerIndex) return
    const t = buildTable(raw, i)
    state.headerIndex = i
    useTable(t)
  }

  function clearTable() {
    table.value = null
    book = null
    raw = null
    state.source = null
    state.headerIndex = 0
    state.tableId++
    state.mapping = []
    resetRuns()
  }

  const getBook = () => book
  const getRaw = () => raw

  /** 换数据类型：选项换成这个类型上次用的，对应关系下次进第 2 步时重算 */
  function setType(type, { force = false } = {}) {
    if (!isType(type) || (type === state.type && !force)) return
    state.type = type
    state.options = cleanOptions(loadOptions(type))
    state.mappingFor = ''
    resetRuns()
  }

  /**
   * 进入第 2 步前：一模一样的表头用上次记住的对应（包括手动选的「不导入」），否则按列名 / 别名自动对应。
   * 记住的字段已经不存在（字段定义改了）的列，退回自动对应的结果。
   */
  async function ensureMapping({ force = false } = {}) {
    const schema = await loadSchema()
    const fields = schema?.[state.type]?.fields || []
    const sig = state.type + ':' + state.tableId
    if (!force && state.mappingFor === sig) return
    const headers = table.value?.headers || []
    const auto = mapColumns(headers, fields).mapping
    const remembered = force ? null : loadMapping(state.type, headers)
    let mapping = auto
    if (remembered) {
      const valid = new Set(fields.map(f => f.key))
      const used = new Set()
      mapping = remembered.map(k => {
        if (k && valid.has(k) && !used.has(k)) { used.add(k); return k }
        return ''
      })
      remembered.forEach((k, i) => {
        if (k && !valid.has(k) && auto[i] && !used.has(auto[i])) { mapping[i] = auto[i]; used.add(auto[i]) }
      })
    }
    state.mapping = mapping
    state.mappingFor = sig
    state.remembered = !!remembered
  }

  /** 记住这次的对应关系和选项（下一步时调用） */
  function remember() {
    if (table.value) saveMapping(state.type, table.value.headers, state.mapping)
    saveOptions(state.type, state.options)
  }

  function resetRuns() {
    cancel(state.preview)
    cancel(state.run)
    state.preview = newRun()
    state.run = newRun()
  }

  /** 源行号 → 行下标（结果表、错误报告按行号找回原始数据） */
  let indexCache = { id: -1, map: null }
  function rowIndexOf(rowNo) {
    if (indexCache.id !== state.tableId) {
      indexCache = { id: state.tableId, map: new Map((table.value?.rowNos || []).map((n, i) => [n, i])) }
    }
    return indexCache.map.get(rowNo)
  }

  /** 某个字段对应的源列下标（没对应返回 -1） */
  const colOf = key => state.mapping.indexOf(key)

  /**
   * 发给接口的行：{ _row, [字段]: 单元格 }；空单元格不发（服务端视为「新增用默认值 / 更新不改」）。
   * 模板里没删的示例行跳过（行号记在 state.exampleRows，预检页提示）。
   */
  function buildRows() {
    const t = table.value
    if (!t) return []
    const cols = []
    state.mapping.forEach((k, i) => { if (k) cols.push([i, k]) })
    const ex = exampleMarker(state.type)
    const exCol = ex ? colOf(ex.key) : -1
    const examples = []
    const out = []
    t.rows.forEach((r, idx) => {
      if (exCol >= 0 && String(r[exCol] ?? '').trim() === ex.value) { examples.push(t.rowNos[idx]); return }
      const o = { _row: t.rowNos[idx] }
      for (const [i, k] of cols) {
        const v = r[i]
        if (v !== '' && v != null) o[k] = v
      }
      out.push(o)
    })
    state.exampleRows = examples
    return out
  }

  function apiOptions() {
    const o = { onDuplicate: state.options.onDuplicate }
    if (info.value.hasStatus) o.defaultStatus = Number(state.options.defaultStatus)
    if (info.value.autoCreate) o.autoCreate = !!state.options.autoCreate
    return o
  }

  /** 预检结果对应的「输入」：类型、数据、对应关系、选项任何一个变了都要重新预检 */
  const inputKey = () => JSON.stringify([state.type, state.tableId, state.mapping, apiOptions()])

  function cancel(run) {
    if (run.status === 'running') run.cancelRequested = true
  }

  function merge(run, res) {
    run.created += res.created || 0
    run.updated += res.updated || 0
    run.skipped += res.skipped || 0
    run.failed += res.failed || 0
    if (res.replayed) run.replayed++
    for (const r of res.results || []) run.results.push(r)
    for (const t of res.autoCreated?.topics || []) run.autoTopics.add(t)
    for (const c of res.autoCreated?.creators || []) run.autoCreators.add(c)
    run.version++
  }

  /**
   * 分批提交；出错 / 取消时记下 next，之后从这一批继续。
   * 正式导入每批带 importId + chunk（= 第几批，从 0 起）：同一批重试时两者都不变，服务端可以安全地重放。
   */
  async function runChunks(run, rows, size, dryRun) {
    run.status = 'running'
    run.error = ''
    run.maybeWritten = false
    run.cancelRequested = false
    run.total = rows.length
    const options = apiOptions()
    const type = state.type
    if (!dryRun && !run.importId) run.importId = newImportId()
    for (let i = run.next; i < rows.length; i += size) {
      if (run.cancelRequested) {
        run.status = 'cancelled'
        run.cancelRequested = false
        return
      }
      const opts = dryRun ? options : { ...options, importId: run.importId, chunk: Math.floor(i / size) }
      let res
      try {
        res = await importRows(type, rows.slice(i, i + size), opts, dryRun)
      } catch (e) {
        if (run.cancelRequested && e.name === 'AbortError') { run.status = 'cancelled'; return }
        run.status = 'error'
        run.error = e.message || '请求失败'
        run.maybeWritten = !dryRun && maybeCommitted(e)
        return
      }
      // 这一批期间整个向导被重置了（换了文件 / 类型）：结果作废
      if (run !== state.preview && run !== state.run) return
      merge(run, res)
      run.next = Math.min(rows.length, i + size)
      run.processed = run.next
      await yieldUI()
    }
    run.status = 'done'
  }

  /** 第 3 步：预检（dryRun）。同样的输入已经预检完就不再跑 */
  async function startPreview({ force = false } = {}) {
    const key = inputKey()
    const p = state.preview
    // 正在跑但已经要求取消（刚点了「返回修改」又回来）：重新开始，旧的那一批结果会被丢掉
    if (!force && p.key === key && (p.status === 'done' || (p.status === 'running' && !p.cancelRequested))) return
    cancel(p)
    const run = newRun()
    run.key = key
    state.preview = run
    state.run = newRun()
    await runChunks(state.preview, buildRows(), PREVIEW_CHUNK, true)
  }

  /** 第 4 步：正式导入（从头开始，或在取消 / 出错后从断点继续：importId 不变，出错的那一批原样重发） */
  let importRowsCache = null
  async function startImport({ resume = false } = {}) {
    if (!resume || !importRowsCache) {
      state.run = newRun()
      state.run.key = inputKey()
      importRowsCache = buildRows()
    }
    const run = state.run
    await runChunks(run, importRowsCache, IMPORT_CHUNK, false)
    if (run.status !== 'running' && (run.created || run.updated)) {
      // 新建了专题 / 创作者，其他页面的下拉框要刷新
      if (run.autoTopics.size || run.autoCreators.size || state.type === 'topics' || state.type === 'creators') refreshMeta()
    }
    if (run.status === 'done') importRowsCache = null
  }

  /** 再导入一批：保留类型和选项，其余清空 */
  function reset() {
    clearTable()
    importRowsCache = null
    state.step = 1
  }

  const store = {
    state,
    table,
    info,
    rowCount,
    setTable,
    setHeaderRow,
    clearTable,
    getBook,
    getRaw,
    setType,
    ensureMapping,
    remember,
    rowIndexOf,
    colOf,
    buildRows,
    inputKey,
    startPreview,
    startImport,
    cancelPreview: () => cancel(state.preview),
    cancelImport: () => cancel(state.run),
    reset
  }
  provideFn?.(KEY, store)
  return store
}

export const useImportStore = () => inject(KEY)
