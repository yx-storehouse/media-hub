/*
 * 批量导入：把各种来源读成同一种表格 { headers, rows, rowNos }，以及列名 → 字段的自动对应。
 *
 *   readFile(file, { fields })      → { format, raw, headerIndex, table, book?, sheetIndex?, sheetError? }
 *   loadSheet(book, i, { fields })  → { raw, headerIndex, table }        xlsx 换工作表
 *   loadPaste(text, { fields })     → { raw, headerIndex, table }        粘贴的表格
 *   buildTable(raw, headerIndex)    → table                              用户在第 1 步改「表头在第几行」时重算
 *   mapColumns(headers, fields)     → { mapping, warnings }              列名 → 字段（'' = 不导入）
 *   readSheet / readPaste / autoMap 是只要结果的简写
 *
 * raw = { kind: 'grid', records, nos, merges }：所有非空行（还没分表头和数据）+ 每行在源文件里的行号 + 合并单元格；
 *       JSON 没有「表头行」：{ kind: 'json', table }。
 * table.rows 是 string[][]（每行补齐到表头长度）；rowNos 是每行在源文件里的行号（CSV 空行也算一行，和 Excel 里看到的一致），
 * 预检 / 报错时告诉用户「第几行」用的。几万行的数组不放进 Vue 的深层响应式（调用方用 markRaw / shallowRef）。
 * fields 用来认表头（列名能对上字段的那一行才是表头）：传所有类型的字段，换类型时不用重新认。
 */
import { parseDelimited, decodeFile } from '../../utils/csv'
import { openXlsx } from '../../utils/xlsx'

/** 一次最多读入的数据行（服务端单次 2 万行，前端分批提交，这里再留些余量） */
export const MAX_ROWS = 50000
const MAX_COLS = 200
const MAX_BYTES = 100 * 1024 * 1024
/** 表头只在前几行里找（上面可能有标题行、说明行） */
export const HEADER_SCAN = 10
export const ACCEPT = '.csv,.tsv,.txt,.xlsx,.json'

const extOf = name => (/\.([^.]+)$/.exec(String(name || '').toLowerCase()) || [])[1] || ''
const blank = v => String(v ?? '').trim() === ''

/** 让出主线程一帧，好让「正在读取…」先画出来 */
export const yieldFrame = () => new Promise(r => setTimeout(r, 0))

/**
 * 统一整理：列数取表头和数据的最大值；没有表头的列起名「第 N 列」；
 * 表头和数据都为空的列（Excel 末尾多出来的逗号）去掉；每行补齐 / 截齐到列数。
 * 另外数一数有多少行在表头以外的列里有值（extraRows）：多半是分隔符认错了，第 1 步提醒一下。
 */
export function normalizeTable({ headers = [], rows = [], rowNos } = {}, { firstRowNo = 2 } = {}) {
  let width = headers.length
  for (const r of rows) if (r.length > width) width = r.length
  // 导入字段最多十几个；几百上千列多半是选错了文件或表里有很远的杂项单元格，逐列扫描会卡住页面
  if (width > MAX_COLS) throw new Error(`这个表有 ${width} 列，超过 ${MAX_COLS} 列，请删掉不需要的列（或检查是否选错了工作表）后再导入`)
  const keep = []
  for (let c = 0; c < width; c++) {
    const h = String(headers[c] ?? '').trim()
    if (h || rows.some(r => !blank(r[c]))) keep.push(c)
  }
  let headWidth = 0
  headers.forEach((h, c) => { if (!blank(h)) headWidth = c + 1 })
  let extraRows = 0
  if (headWidth) for (const r of rows) if (r.length > headWidth && r.some((v, c) => c >= headWidth && !blank(v))) extraRows++
  const outHeaders = keep.map(c => String(headers[c] ?? '').trim() || `第${c + 1}列`)
  const outRows = rows.map(r => keep.map(c => {
    const v = r[c]
    return v == null ? '' : String(v)
  }))
  const nos = rowNos && rowNos.length === rows.length ? rowNos : rows.map((_, i) => i + firstRowNo)
  if (outRows.length > MAX_ROWS) throw new Error(`一次最多导入 ${MAX_ROWS.toLocaleString()} 行，这个文件有 ${outRows.length.toLocaleString()} 行，请拆分后分批导入`)
  return { headers: outHeaders, rows: outRows, rowNos: nos, extraRows }
}

/** JSON：对象数组，或 { rows: [...] }（也认 data / list）；键名可以是字段 key、中文列名或别名 */
export function tableFromJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new Error('JSON 格式不正确：' + e.message)
  }
  if (!Array.isArray(data)) data = data?.rows ?? data?.data ?? data?.list
  if (!Array.isArray(data)) throw new Error('JSON 应该是对象数组 [{…}, {…}]，或者 { "rows": [{…}] }')
  const headers = []
  const index = new Map()
  data.forEach((o, i) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`JSON 第 ${i + 1} 项不是对象`)
    for (const k of Object.keys(o)) if (!index.has(k)) { index.set(k, headers.length); headers.push(k) }
  })
  const cell = v => {
    if (v === null || v === undefined) return ''
    if (Array.isArray(v)) return v.map(cell).filter(Boolean).join(',')
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  }
  // JSON 没有「行号」，用第几项（从 1 开始）
  return { headers, rows: data.map(o => headers.map(h => cell(o[h]))), rowNos: data.map((_, i) => i + 1) }
}

/* ---------------- CSV / 粘贴：每条记录在源文件里是第几行 ---------------- */

/* 和 String.prototype.trim 去掉的空白一致 */
const isSpace = c => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff

/**
 * 非空记录的行号（第一条记录是第 1 行；空行、只有分隔符的行也算一行，但不返回）。
 * utils/csv.js 的 parseDelimited 会丢掉空行，这里按同样的引号规则再扫一遍，好让行号和 Excel 里看到的对得上。
 */
export function recordNos(text, delimiter) {
  let s = String(text ?? '')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  const D = delimiter.charCodeAt(0)
  const nos = []
  let rec = 1
  let inQ = false
  let empty = true // 当前字段还没有字符（引号只在字段开头才算引号）
  let content = false // 当前记录有没有非空白字符
  for (let i = 0, n = s.length; i < n; i++) {
    const c = s.charCodeAt(i)
    if (inQ) {
      if (c === 34) {
        if (s.charCodeAt(i + 1) === 34) { content = true; empty = false; i++ } else inQ = false
        continue
      }
      if (!content && !isSpace(c)) content = true
      empty = false
      continue
    }
    if (c === 34 && empty) { inQ = true; continue }
    if (c === D) { empty = true; continue }
    if (c === 13 || c === 10) {
      if (content) nos.push(rec)
      rec++
      content = false
      empty = true
      if (c === 13 && s.charCodeAt(i + 1) === 10) i++
      continue
    }
    if (!content && !isSpace(c)) content = true
    empty = false
  }
  if (content) nos.push(rec)
  return nos
}

/** 文本 → raw（所有非空记录 + 行号） */
function gridFromText(text, delimiter) {
  const parsed = parseDelimited(text, { delimiter })
  const records = parsed.headers.length || parsed.rows.length ? [parsed.headers, ...parsed.rows] : []
  let nos = recordNos(text, parsed.delimiter)
  // 理论上不会对不上；万一对不上，宁可按顺序编号也不要错位
  if (nos.length !== records.length) nos = records.map((_, i) => i + 1)
  return { raw: { kind: 'grid', records, nos, merges: [] }, delimiter: parsed.delimiter }
}

/** 不拆分：整行就是一个格子（只复制了一列时用） */
const SINGLE_COLUMN = '\u0000'

/**
 * 粘贴内容的分隔符：Excel / WPS 复制出来的一定是制表符分隔；
 * 没有制表符时，第一行（表头）引号外有逗号 / 分号才当 CSV 文本，否则就是只复制了一列 ——
 * 这时「Vlog, Day 1」这种带逗号的值不能被拆开。
 */
export function pasteDelimiter(text) {
  const s = String(text ?? '')
  if (s.includes('\t')) return '\t'
  const first = s.replace(/^﻿/, '').split(/\r\n|\n|\r/).find(l => l.trim()) || ''
  let inQ = false
  let commas = 0
  let semis = 0
  for (const ch of first) {
    if (ch === '"') inQ = !inQ
    else if (!inQ && ch === ',') commas++
    else if (!inQ && ch === ';') semis++
  }
  if (!commas && !semis) return SINGLE_COLUMN
  return semis > commas ? ';' : ','
}

/* ---------------- 表头在哪一行 ---------------- */

/** 字段的 key / 中文名 / 别名（规范化后）→ 字段 key */
function nameIndex(fields) {
  const m = new Map()
  for (const f of fields || []) {
    for (const s of [f.key, f.label, ...(f.aliases || [])]) {
      const n = normHeader(s)
      if (n && !m.has(n)) m.set(n, f.key)
    }
  }
  return m
}

/** 一行里有几个格子能对上不同的字段 */
function fieldHits(cells, names) {
  const hit = new Set()
  for (const c of cells) {
    const k = names.get(normHeader(c))
    if (k) hit.add(k)
  }
  return hit.size
}

const filledCount = cells => cells.reduce((n, c) => n + (blank(c) ? 0 : 1), 0)

/**
 * 认表头：前 HEADER_SCAN 行里第一行能对上 ≥ 2 个字段的；没有就第一行能对上 1 个的；
 * 列名一个都认不出时，跳过开头那些只有一个格子有值的行（「2026年10月 视频清单」这种合并的标题行）。
 * 认错了用户可以在第 1 步自己选。
 * @returns {number} raw.records 的下标
 */
export function detectHeader(raw, fields = []) {
  if (raw?.kind !== 'grid') return 0
  const head = raw.records.slice(0, HEADER_SCAN)
  if (head.length < 2) return 0
  const names = nameIndex(fields)
  if (names.size) {
    const hits = head.map(r => fieldHits(r, names))
    let i = hits.findIndex(h => h >= 2)
    if (i < 0) i = hits.findIndex(h => h >= 1)
    if (i >= 0) return i
  }
  const i = head.findIndex(r => filledCount(r) >= 2)
  return i > 0 ? i : 0
}

/** 第 1 步「表头在第几行」的选项：前 HEADER_SCAN 行，标签带上这一行开头几个格子的内容 */
export function headerChoices(raw) {
  if (raw?.kind !== 'grid') return []
  return raw.records.slice(0, HEADER_SCAN).map((cells, i) => {
    const vals = cells.map(c => String(c ?? '').trim()).filter(Boolean)
    const text = vals.slice(0, 3).join(' / ') + (vals.length > 3 ? ' …' : '')
    return { value: i, label: `第 ${raw.nos[i]} 行：${[...text].length > 40 ? [...text].slice(0, 40).join('') + '…' : text}` }
  })
}

/**
 * 合并单元格：Excel 里合并的格子只有左上角存了值，但用户看到的是每一行都有这个值（常见的分组写法）。
 *   竖向合并（数据区）：把值填进范围里每一行的这一列（只填本来就有数据的行）；
 *   跨过表头行的合并：表头行里被盖住的列都用这个列名。
 * 横向合并的数据格不展开（和 Excel 另存为 CSV 一样只保留左上角）。
 */
function fillMerges(raw, h, headers, rows, rowNos) {
  const headNo = raw.nos[h]
  const recByNo = new Map(raw.nos.map((n, i) => [n, raw.records[i]]))
  const idxByNo = new Map(rowNos.map((n, i) => [n, i]))
  const copied = new Set()
  let ranges = 0 // 数据区里展开了几处（表头里的合并不算，第 1 步提示用）
  for (const m of raw.merges) {
    const v = recByNo.get(m.r1)?.[m.c1]
    if (blank(v)) continue
    let did = false
    if (m.r1 <= headNo && headNo <= m.r2) {
      for (let c = m.c1; c <= Math.min(m.c2, m.c1 + MAX_COLS); c++) {
        if (blank(headers[c])) headers[c] = v
      }
    } else if (m.r1 > headNo) {
      for (let r = m.r1 + 1; r <= m.r2; r++) {
        const i = idxByNo.get(r)
        if (i === undefined || !blank(rows[i][m.c1])) continue
        if (!copied.has(i)) { rows[i] = rows[i].slice(); copied.add(i) }
        while (rows[i].length < m.c1) rows[i].push('')
        rows[i][m.c1] = v
        did = true
      }
    }
    if (did) ranges++
  }
  return ranges
}

/**
 * raw + 表头在第几条记录 → 表格。
 * 返回的 table 另带：headerRow（表头在源文件第几行）、skippedAbove（表头上面跳过了几行）、merged（展开了几处合并单元格）。
 */
export function buildTable(raw, headerIndex = 0) {
  if (raw?.kind === 'json') return normalizeTable(raw.table)
  const records = raw?.records || []
  if (!records.length) return { headers: [], rows: [], rowNos: [], extraRows: 0, headerRow: 0, skippedAbove: 0, merged: 0 }
  const h = Math.min(Math.max(0, Number(headerIndex) || 0), records.length - 1)
  const headers = records[h].slice()
  const rows = records.slice(h + 1)
  const rowNos = raw.nos.slice(h + 1)
  const merged = raw.merges?.length ? fillMerges(raw, h, headers, rows, rowNos) : 0
  const t = normalizeTable({ headers, rows, rowNos })
  return { ...t, headerRow: raw.nos[h], skippedAbove: h, merged }
}

const loaded = (raw, fields) => {
  const headerIndex = detectHeader(raw, fields)
  return { raw, headerIndex, table: buildTable(raw, headerIndex) }
}

/**
 * 读取用户选的文件。xlsx 有多个工作表时返回 book，调用方让用户选，再用 loadSheet() 换表。
 * @param {File} file
 * @param {{ fields?: Array }} [opts]  用来认表头的字段定义
 */
export async function readFile(file, { fields = [] } = {}) {
  if (file.size > MAX_BYTES) throw new Error('文件太大（超过 100 MB），请拆分后再导入')
  const ext = extOf(file.name)
  if (ext === 'xls') throw new Error('不支持旧版 .xls 格式，请在 Excel 里「另存为」.xlsx 或 CSV 后再导入')
  if (!['csv', 'tsv', 'txt', 'xlsx', 'json', ''].includes(ext)) throw new Error(`不支持「.${ext}」文件，请选择 CSV / TSV / TXT / XLSX / JSON`)
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  if (!bytes.length) throw new Error('文件是空的')

  // 按内容认：ZIP（PK 开头）就是 xlsx，不管扩展名
  if (ext === 'xlsx' || (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)) {
    const book = await openXlsx(bytes)
    const sheetIndex = book.firstVisible
    try {
      return { format: 'xlsx', book, sheetIndex, ...(await loadSheet(book, sheetIndex, { fields })) }
    } catch (e) {
      // 第一个表读不了（比如列太多）也把工作簿交出去，让用户换别的工作表
      if (book.sheets.length < 2) throw e
      const raw = { kind: 'grid', records: [], nos: [], merges: [] }
      return { format: 'xlsx', book, sheetIndex, raw, headerIndex: 0, table: buildTable(raw), sheetError: e.message }
    }
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new Error('这是旧版 .xls 文件，请在 Excel 里「另存为」.xlsx 或 CSV 后再导入')
  }

  const text = decodeFile(buf)
  if (ext === 'json' || (ext !== 'csv' && ext !== 'tsv' && /^\s*[[{]/.test(text))) {
    const raw = { kind: 'json', table: tableFromJson(text) }
    return { format: 'json', raw, headerIndex: 0, table: buildTable(raw) }
  }
  const { raw, delimiter } = gridFromText(text, ext === 'tsv' ? '\t' : 'auto')
  return { format: delimiter === '\t' ? 'tsv' : 'csv', delimiter, ...loaded(raw, fields) }
}

/** xlsx 换工作表 */
export async function loadSheet(book, index, { fields = [] } = {}) {
  const r = await book.readRows(index)
  return loaded({ kind: 'grid', ...r }, fields)
}
export const readSheet = async (book, index, opts) => (await loadSheet(book, index, opts)).table

/** 粘贴的表格（Excel / WPS 复制出来是制表符分隔，表头一般在第一行） */
export function loadPaste(text, { fields = [] } = {}) {
  const { raw, delimiter } = gridFromText(text, pasteDelimiter(text))
  return { delimiter, ...loaded(raw, fields) }
}
export const readPaste = (text, opts) => loadPaste(text, opts).table

/* ---------------- 列名自动对应 ---------------- */

const BRACKETS = /[(（[【［{｛]([^)）\]】］}｝]*)[)）\]】］}｝]/g

/** 列名规范化：小写，去掉空格、_、-、*，以及各种括号和括号里的内容（「标题（必填）」→「标题」） */
export const normHeader = s => String(s ?? '')
  .toLowerCase()
  .replace(BRACKETS, '')
  .replace(/[\s_\-*＊]/g, '')

/** 列名括号里的说明（「时长（单位：分钟）」→ ['分钟']） */
export function headerNotes(h) {
  const out = []
  for (const m of String(h ?? '').matchAll(BRACKETS)) {
    const t = m[1].replace(/^\s*单位\s*[:：]?/, '').replace(/\s+/g, '').toLowerCase()
    if (t) out.push(t)
  }
  return out
}

/*
 * 括号里写了单位、而且和字段要求的单位对不上时（「时长(分钟)」「阅读数(万)」），不能悄悄按字段默认单位导入：
 * 自动对应时跳过这一列并说明原因；用户手动选了也照样提醒。单位对得上的（「时长(秒)」「时长(mm:ss)」）照常对应。
 */
const UNIT_RULES = {
  duration: {
    bad: [
      [/^(分钟|分|min|mins|minute|minutes|m)$/, '分钟'],
      [/^(小时|时|h|hr|hrs|hour|hours)$/, '小时'],
      [/^(毫秒|ms|msec|millisecond|milliseconds)$/, '毫秒'],
      [/^(天|d|day|days)$/, '天']
    ],
    accept: '按秒导入，也认 mm:ss / hh:mm:ss（例如 754、12:34、00:12:34）'
  },
  int: {
    bad: [[/^(万|w|万次|万人)$/, '万'], [/^(千|k|千次)$/, '千'], [/^(百万|million)$/, '百万'], [/^(亿|亿次)$/, '亿']],
    accept: '按整数导入（也可以写 1,200 或 1.2w）'
  }
}

/** 列名里的单位和字段冲突时返回单位名（如「分钟」），否则 '' */
export function unitConflict(header, field) {
  const rule = field && UNIT_RULES[field.type]
  if (!rule) return ''
  for (const note of headerNotes(header)) {
    for (const [re, name] of rule.bad) if (re.test(note)) return name
  }
  return ''
}

/** 单位冲突的说明：「时长」按秒导入，也认 mm:ss / hh:mm:ss…，这一列的单位是「分钟」 */
export const unitHint = (field, unit) => `「${field.label}」${UNIT_RULES[field.type]?.accept || ''}，这一列的单位是「${unit}」，请先在表格里换算`

/**
 * 按 key / 中文名 / 别名 自动对应。先认 key 和中文名，再认别名：
 * 这样表里同时有「标题」和「名称」时，标题列优先拿到「标题」字段。每个字段只给一列。
 * @param {string[]} headers
 * @param {Array<{ key, label, aliases, type }>} fields
 * @returns {{ mapping: string[], warnings: Array<null | { key, unit }> }}
 *   mapping 与 headers 等长，'' = 不导入；warnings[i] = 列名对上了字段 key 但单位冲突、没有自动对应
 */
export function mapColumns(headers, fields) {
  const primary = new Map()
  const alias = new Map()
  const byKey = new Map(fields.map(f => [f.key, f]))
  for (const f of fields) {
    for (const s of [f.key, f.label]) { const n = normHeader(s); if (n && !primary.has(n)) primary.set(n, f.key) }
    for (const a of f.aliases || []) { const n = normHeader(a); if (n && !alias.has(n)) alias.set(n, f.key) }
  }
  const mapping = headers.map(() => '')
  const warnings = headers.map(() => null)
  const used = new Set()
  for (const table of [primary, alias]) {
    headers.forEach((h, i) => {
      if (mapping[i] || warnings[i]) return
      const k = table.get(normHeader(h))
      if (!k || used.has(k)) return
      const unit = unitConflict(h, byKey.get(k))
      if (unit) { warnings[i] = { key: k, unit }; return }
      mapping[i] = k
      used.add(k)
    })
  }
  return { mapping, warnings }
}

export const autoMap = (headers, fields) => mapColumns(headers, fields).mapping

/* ---------------- 记住对应关系 / 选项（localStorage，读写都包 try/catch） ---------------- */

/*
 * 对应关系按「这一模一样的表头」记：列名逐列完全相同才套用，按列下标存（同名的两列各记各的）。
 * 列名写法不同（「时长」和「时长(秒)」）就重新自动对应，免得上次在另一种表头里的「不导入」把这次能认出的列盖掉。
 * 旧版（按规范化后的表头签名、以列名为键）的记录读不出列下标，换新键后不再使用。
 */
const MAP_KEY = 'reel.admin.import.mapping.v2'
const OLD_MAP_KEY = 'reel.admin.import.mapping'
const OPT_KEY = 'reel.admin.import.options'

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || {} } catch { return {} }
}
function writeJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* 隐私模式 / 存储已满：不记也能用 */ }
}

const exactSignature = headers => JSON.stringify(headers.map(h => String(h ?? '')))

/** 上次这个类型、一模一样的表头时的对应：string[]（与 headers 等长，'' = 不导入）；没有记录返回 null */
export function loadMapping(type, headers) {
  const hit = readJson(MAP_KEY)?.[type]?.[exactSignature(headers)]
  if (!hit || !Array.isArray(hit.cols) || !Array.isArray(hit.headers) || hit.cols.length !== headers.length) return null
  if (hit.headers.some((h, i) => h !== String(headers[i] ?? ''))) return null
  return hit.cols.map(k => (typeof k === 'string' ? k : ''))
}

export function saveMapping(type, headers, mapping) {
  const all = readJson(MAP_KEY)
  const bucket = all[type] && typeof all[type] === 'object' ? all[type] : {}
  const sig = exactSignature(headers)
  bucket[sig] = { headers: JSON.parse(sig), cols: headers.map((_, i) => mapping[i] || ''), t: Date.now() }
  // 每种类型只留最近 20 种表头
  const keys = Object.keys(bucket).sort((a, b) => (bucket[b].t || 0) - (bucket[a].t || 0))
  for (const k of keys.slice(20)) delete bucket[k]
  all[type] = bucket
  writeJson(MAP_KEY, all)
  try { localStorage.removeItem(OLD_MAP_KEY) } catch { /* 读不了存储也没关系 */ }
}

export function loadOptions(type) {
  const o = readJson(OPT_KEY)?.[type]
  return o && typeof o === 'object' ? o : null
}

export function saveOptions(type, options) {
  const all = readJson(OPT_KEY)
  all[type] = { ...options }
  writeJson(OPT_KEY, all)
}
