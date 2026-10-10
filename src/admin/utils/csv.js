/*
 * CSV / TSV 读写（RFC 4180）。
 *
 *   parseDelimited(text, { delimiter: 'auto' }) → { headers, rows: string[][] }
 *   toCSV(headers, rows) → 带 UTF-8 BOM、CRLF 换行的字符串（Excel 直接双击打开不乱码）
 *   decodeFile(arrayBuffer) → 文本；UTF-8 解不开时按 GB18030 解（中文 Excel「CSV（逗号分隔）」存的是 GBK）
 *
 * 导出时做「公式注入」防护：以 = + - @ 开头的单元格前面加一个 '，Excel 就不会把它当公式执行；
 * 纯数字（如 -5）不加。服务端导入时会把这个 ' 去掉，所以导出 → 改 → 再导入不受影响。
 */

/** 第一行里（引号外）哪种分隔符最多就用哪种；都没有按逗号 */
function detectDelimiter(text) {
  const counts = { '\t': 0, ',': 0, ';': 0 }
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') inQ = !inQ
    else if (!inQ && (c === '\n' || c === '\r')) break
    else if (!inQ && c in counts) counts[c]++
  }
  let best = ','
  if (counts['\t'] > 0 && counts['\t'] >= counts[','] && counts['\t'] >= counts[';']) best = '\t'
  else if (counts[';'] > counts[',']) best = ';'
  return best
}

/**
 * @param {string} text
 * @param {{ delimiter?: 'auto'|','|'\t'|';' }} [opts]
 * @returns {{ headers: string[], rows: string[][], delimiter: string }}
 */
export function parseDelimited(text, { delimiter = 'auto' } = {}) {
  let s = String(text ?? '')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  const d = delimiter === 'auto' ? detectDelimiter(s) : delimiter

  const out = []
  let row = []
  let field = ''
  let inQ = false
  let i = 0
  const n = s.length
  const endField = () => { row.push(field); field = '' }
  const endRow = () => {
    endField()
    // 整行都是空白的跳过
    if (row.some(c => c.trim() !== '')) out.push(row)
    row = []
  }

  while (i < n) {
    const c = s[i]
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue }
        inQ = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '') { inQ = true; i++; continue }
    if (c === d) { endField(); i++; continue }
    if (c === '\r') { endRow(); i += s[i + 1] === '\n' ? 2 : 1; continue }
    if (c === '\n') { endRow(); i++; continue }
    field += c
    i++
  }
  if (field !== '' || row.length) endRow()

  const headers = (out.shift() || []).map(h => h.trim())
  // 短行补齐到表头长度，方便按列下标取值
  const rows = out.map(r => (r.length < headers.length ? [...r, ...Array(headers.length - r.length).fill('')] : r))
  return { headers, rows, delimiter: d }
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** 单元格 → CSV 文本（含注入防护与必要的引号） */
function cell(v) {
  if (v === null || v === undefined) return ''
  let s = Array.isArray(v) ? v.join(',') : typeof v === 'boolean' ? (v ? '是' : '否') : String(v)
  if (/^[=+\-@]/.test(s) && !PLAIN_NUMBER.test(s)) s = "'" + s
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

/**
 * @param {string[]} headers
 * @param {Array<Array<any>>} rows
 */
export function toCSV(headers, rows) {
  const lines = [headers.map(cell).join(',')]
  for (const r of rows) lines.push(r.map(cell).join(','))
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/**
 * 读文件字节 → 文本。优先 UTF-8（严格模式），失败退回 GB18030；
 * 也认 Excel「Unicode 文本」存出来的 UTF-16（带 BOM）。
 */
export function decodeFile(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('gb18030').decode(bytes)
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
