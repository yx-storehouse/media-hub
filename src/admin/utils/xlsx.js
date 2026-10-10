/*
 * 极简 .xlsx 读取（不引第三方库）：只取单元格的值，够批量导入用。
 *
 *   const book = await openXlsx(arrayBuffer)
 *   book.sheets                       → [{ name, hidden }]
 *   book.firstVisible                 → 默认选中的工作表下标
 *   const { records, nos, merges } = await book.readRows(0)
 *     records：所有非空行（string[][]，空格补 ''）；nos：每行在 Excel 里的行号；
 *     merges：合并单元格 [{ r1, c1, r2, c2 }]（行号从 1 起、列下标从 0 起）。哪一行是表头由调用方决定（parse.js）
 *   const { headers, rows, rowNos } = await book.readSheet(0)   第一行非空行当表头（简单场景用）
 *
 * 做法：从 ZIP 中央目录找到各文件 → 浏览器自带的 DecompressionStream('deflate-raw') 解压 →
 *   workbook.xml + 关系文件找到工作表 → sharedStrings（共享字符串）+ styles（哪些数字其实是日期）→ 工作表单元格。
 * 日期单元格转成「YYYY-MM-DD HH:mm:ss」；纯时间 / 经过时间（如时长 00:12:34）转成「HH:mm:ss」；
 * 不带秒的时间格式（h:mm、[h]:mm，Excel 里直接敲 12:34 就是这种）按显示的样子输出「12:34」，和 CSV 里写 12:34 一样处理；
 * 公式取缓存的结果；错误值（#N/A 等）按空单元格处理；布尔值转成 TRUE / FALSE。
 * 工作表 XML 用正则扫描而不是 DOMParser：几万行的表也只要几百毫秒，不卡界面。
 */

const u16 = (b, o) => b[o] | (b[o + 1] << 8)
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32
const utf8 = new TextDecoder('utf-8')

/* ---------------- ZIP ---------------- */

/** 中央目录 → Map(小写路径 → 条目) */
function readZipDirectory(bytes) {
  // 旧版 .xls（OLE 复合文档）和加了打开密码的 .xlsx 都是这个文件头
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new Error('这是旧版 .xls 或设置了打开密码的 Excel 文件，请在 Excel 里「另存为」.xlsx 或 CSV（并取消密码）后再导入')
  }
  // 目录结尾记录（EOCD）在文件末尾，后面最多跟 65535 字节注释
  const min = Math.max(0, bytes.length - 22 - 65535)
  let eocd = -1
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 .xlsx 文件（文件可能已损坏，或者其实是别的格式）')
  let count = u16(bytes, eocd + 10)
  let offset = u32(bytes, eocd + 16)
  // ZIP64：条目数或偏移放不下时记在 ZIP64 目录结尾里
  if (count === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20
    if (loc >= 0 && u32(bytes, loc) === 0x07064b50) {
      const z = u64(bytes, loc + 8)
      if (u32(bytes, z) === 0x06064b50) {
        count = u64(bytes, z + 32)
        offset = u64(bytes, z + 48)
      }
    }
  }

  const entries = new Map()
  let p = offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new Error('.xlsx 文件结构损坏，无法读取')
    const flags = u16(bytes, p + 8)
    const method = u16(bytes, p + 10)
    let compSize = u32(bytes, p + 20)
    let size = u32(bytes, p + 24)
    const nameLen = u16(bytes, p + 28)
    const extraLen = u16(bytes, p + 30)
    const commentLen = u16(bytes, p + 32)
    let local = u32(bytes, p + 42)
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/')
    // ZIP64 扩展字段（id = 1）：依次是原始大小、压缩后大小、本地头偏移（只有对应字段是 0xffffffff 时才出现）
    if (size === 0xffffffff || compSize === 0xffffffff || local === 0xffffffff) {
      let q = p + 46 + nameLen
      const end = q + extraLen
      while (q + 4 <= end) {
        const id = u16(bytes, q)
        const len = u16(bytes, q + 2)
        if (id === 1) {
          let r = q + 4
          if (size === 0xffffffff) { size = u64(bytes, r); r += 8 }
          if (compSize === 0xffffffff) { compSize = u64(bytes, r); r += 8 }
          if (local === 0xffffffff) local = u64(bytes, r)
          break
        }
        q += 4 + len
      }
    }
    entries.set(name.toLowerCase(), { name, flags, method, compSize, size, local })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function inflateEntry(bytes, e) {
  if (e.flags & 1) throw new Error('文件已加密，请在 Excel 里取消密码后再导入')
  const p = e.local
  if (u32(bytes, p) !== 0x04034b50) throw new Error('.xlsx 文件结构损坏，无法读取')
  const start = p + 30 + u16(bytes, p + 26) + u16(bytes, p + 28)
  const data = bytes.subarray(start, start + e.compSize)
  if (e.method === 0) return data
  if (e.method !== 8) throw new Error('.xlsx 使用了不支持的压缩方式，请另存为 CSV 后导入')
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持读取 .xlsx，请升级浏览器，或在 Excel 里另存为 CSV 后导入')
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/* ---------------- XML 小工具 ---------------- */

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** 实体（&amp; &#x4E2D;）+ OOXML 的 _x000D_ 转义 */
function unescapeXml(s) {
  if (s.indexOf('&') >= 0) {
    s = s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
      if (e[0] !== '#') return ENT[e] ?? m
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
  }
  if (s.indexOf('_x') >= 0) s = s.replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
  return s
}

/** 属性：同时按全名（r:id）和去掉前缀的名字（id）存 */
function attrsOf(s) {
  const o = {}
  if (!s) return o
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(s))) {
    const v = unescapeXml(m[2] ?? m[3] ?? '')
    o[m[1]] = v
    const local = m[1].includes(':') ? m[1].slice(m[1].indexOf(':') + 1) : m[1]
    if (!(local in o)) o[local] = v
  }
  return o
}

/** 元素标签可能带命名空间前缀（<x:row>），统一用这个片段匹配 */
const P = '(?:[\\w.-]+:)?'
const tagRe = (name, flags = 'g') => new RegExp(`<${P}${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${P}${name}>)`, flags)
const RE_T = new RegExp(`<${P}t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${P}t>`, 'g')
const RE_RPH = new RegExp(`<${P}rPh\\b[\\s\\S]*?<\\/${P}rPh>`, 'g')
const RE_V = new RegExp(`<${P}v(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${P}v>`)
const RE_IS = new RegExp(`<${P}is\\b[^>]*>([\\s\\S]*?)<\\/${P}is>`)

const stripCdata = s => (s.indexOf('<![CDATA[') >= 0 ? s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')) : s)

/** 富文本：把所有 <t> 拼起来（跳过日文注音 <rPh>） */
function richText(inner) {
  if (!inner) return ''
  const s = stripCdata(inner).replace(RE_RPH, '')
  let out = ''
  RE_T.lastIndex = 0
  let m
  while ((m = RE_T.exec(s))) out += m[1]
  return unescapeXml(out)
}

/** 路径：相对 base 目录解析 rels 里的 Target（可能是 /xl/... 绝对路径或 ../ 相对路径） */
function resolvePath(baseDir, target) {
  const raw = target.startsWith('/') ? target.slice(1) : baseDir + target
  const out = []
  for (const seg of raw.split('/')) {
    if (seg === '..') out.pop()
    else if (seg && seg !== '.') out.push(seg)
  }
  return out.join('/')
}

function parseRels(xml, baseDir) {
  const rels = []
  if (!xml) return rels
  const re = tagRe('Relationship')
  let m
  while ((m = re.exec(xml))) {
    const a = attrsOf(m[1])
    if (!a.Id || !a.Target || a.TargetMode === 'External') continue
    rels.push({ id: a.Id, type: a.Type || '', target: resolvePath(baseDir, a.Target) })
  }
  return rels
}

/* ---------------- 日期格式 ---------------- */

/* 内置日期格式：14-17、22 是日期，18-21、45-47 是时间；27-36、50-58 是中日韩区域的日期格式（中文 Excel 常用） */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58])
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 46, 47])
/* 不带秒的内置时间格式：18 = h:mm AM/PM，20 = h:mm（在单元格里敲 12:34，Excel 自动套的就是 20） */
const BUILTIN_NO_SECONDS = new Set([18, 20])

/** 去掉引号里的文字、[颜色] [$-804] 这类方括号、\ 转义、_ * 占位，只留真正的格式字符 */
const formatChars = first => first.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/[_*]./g, '')

/** 自定义格式 → 'date' | 'time' | 'elapsed' | null：看剩下的格式字符里有没有 y m d h s */
export function classifyFormat(code) {
  if (!code) return null
  const first = String(code).split(';')[0]
  const elapsed = /\[(h+|m+|s+)\]/i.test(first)
  const s = formatChars(first)
  if (/general/i.test(s)) return null
  if (/[yd]/i.test(s)) return 'date'
  if (elapsed) return 'elapsed'
  if (/[hs]/i.test(s)) return 'time'
  if (/m/i.test(s)) return 'date'
  return null
}

/** 时间格式有没有「秒」：h:mm、[h]:mm 没有；mm:ss、[ss]、h:mm:ss 有 */
export function formatHasSeconds(code) {
  const first = String(code || '').split(';')[0]
  return /\[s+\]/i.test(first) || /s/i.test(formatChars(first))
}

/** styles.xml → 每个单元格样式下标对应的 { kind, seconds }（不是日期 / 时间的为 null） */
function parseStyles(xml) {
  if (!xml) return []
  const custom = new Map()
  const reFmt = tagRe('numFmt')
  let m
  while ((m = reFmt.exec(xml))) {
    const a = attrsOf(m[1])
    custom.set(Number(a.numFmtId), a.formatCode || '')
  }
  const block = new RegExp(`<${P}cellXfs\\b[^>]*>([\\s\\S]*?)<\\/${P}cellXfs>`).exec(xml)
  const styles = []
  if (!block) return styles
  const reXf = new RegExp(`<${P}xf\\b([^>]*?)\\/?>`, 'g')
  while ((m = reXf.exec(block[1]))) {
    const id = Number(attrsOf(m[1]).numFmtId || 0)
    let kind = null
    let seconds = true
    if (custom.has(id)) {
      kind = classifyFormat(custom.get(id))
      seconds = formatHasSeconds(custom.get(id))
    } else if (BUILTIN_DATE.has(id)) kind = 'date'
    else if (BUILTIN_TIME.has(id)) {
      kind = id === 46 ? 'elapsed' : 'time'
      seconds = !BUILTIN_NO_SECONDS.has(id)
    }
    styles.push(kind ? { kind, seconds } : null)
  }
  return styles
}

const p2 = n => String(n).padStart(2, '0')

/**
 * Excel 日期序号 → 本地「墙上时间」字符串（序号本身不带时区，按 UTC 计算再按 UTC 读出，避免夏令时干扰）
 * @param {boolean} [seconds=true]  格式里有没有秒；没有秒的纯时间 / 经过时间按显示的样子输出「12:34」
 */
export function serialToText(serial, kind, date1904 = false, seconds = true) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958466) return null
  const totalSec = Math.round(serial * 86400)
  // 纯时间（时长列 00:12:34）或经过时间 [h]:mm:ss：输出总时长
  if (kind === 'elapsed' || (kind === 'time' && serial < 1) || (kind === 'date' && serial < 1 && serial > 0)) {
    const secs = kind === 'date' ? totalSec % 86400 : totalSec
    // 在 h:mm 格式的单元格里敲「12:34」，Excel 存的是 12 小时 34 分；按显示的「12:34」交给服务端，
    // 和 CSV 里同样写的 12:34 一样按 mm:ss 理解（字段说明写的就是「秒数，或 mm:ss / hh:mm:ss」），不再变成 12:34:00
    if (!seconds && kind !== 'date') {
      const mins = Math.floor(secs / 60)
      return `${p2(Math.floor(mins / 60))}:${p2(mins % 60)}`
    }
    return `${p2(Math.floor(secs / 3600))}:${p2(Math.floor((secs % 3600) / 60))}:${p2(secs % 60)}`
  }
  let days = serial
  if (date1904) days += 1462
  // 1900 日期系统把不存在的 1900-02-29 当成了第 60 天，之前的日期要往后挪一天才对得上
  else if (days < 60) days += 1
  const d = new Date(Math.round((days - 25569) * 86400) * 1000)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
}

/** 普通数字：去掉二进制浮点的尾巴（12.300000000000001 → 12.3），整数原样 */
function numberText(v) {
  if (/^-?\d+$/.test(v)) return v
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  return String(Number(n.toPrecision(15)))
}

/* ---------------- 工作表 ---------------- */

/** A → 0，Z → 25，AA → 26 */
function colIndex(letters) {
  let n = 0
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64)
  return n - 1
}

const MAX_COLS = 16384

/** 「A1:C3」→ { r1: 1, c1: 0, r2: 3, c2: 2 }；单个格子或写错的返回 null */
function parseRange(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(ref || '').trim())
  if (!m) return null
  const a = { r: Number(m[2]), c: colIndex(m[1].toUpperCase()) }
  const b = { r: Number(m[4]), c: colIndex(m[3].toUpperCase()) }
  const out = { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) }
  if (out.r1 < 1 || out.c1 < 0 || out.c2 >= MAX_COLS || (out.r1 === out.r2 && out.c1 === out.c2)) return null
  return out
}

/** 合并单元格（<mergeCells> 在 <sheetData> 后面）：只有左上角那格存了值 */
function parseMerges(xml, from) {
  const at = xml.indexOf('mergeCell', from)
  if (at < 0) return []
  const out = []
  const re = new RegExp(`<${P}mergeCell\\b([^>]*?)\\/?>`, 'g')
  re.lastIndex = Math.max(0, at - 32)
  let m
  while ((m = re.exec(xml))) {
    const r = parseRange(attrsOf(m[1]).ref)
    if (r) out.push(r)
  }
  return out
}

function parseSheet(xml, ctx) {
  const dataM = new RegExp(`<${P}sheetData\\b[^>]*>([\\s\\S]*)<\\/${P}sheetData>`).exec(xml)
  if (!dataM) return { list: [], merges: [] }
  const body = dataM[1]
  const out = []
  const reRow = tagRe('row')
  const reCell = tagRe('c')
  let lastRow = 0
  let rm
  while ((rm = reRow.exec(body))) {
    const ra = attrsOf(rm[1])
    const rowNo = Number(ra.r) > 0 ? Number(ra.r) : lastRow + 1
    lastRow = rowNo
    const inner = rm[2]
    if (!inner) continue
    const cells = []
    let lastCol = -1
    reCell.lastIndex = 0
    let cm
    while ((cm = reCell.exec(inner))) {
      const a = attrsOf(cm[1])
      let col = lastCol + 1
      const ref = /^\$?([A-Za-z]{1,3})\$?\d*$/.exec(a.r || '')
      if (ref) col = colIndex(ref[1].toUpperCase())
      lastCol = col
      if (col < 0 || col >= MAX_COLS) continue
      const v = cellValue(a, cm[2] || '', ctx)
      if (v !== '') cells[col] = v
    }
    // 只有空白的行（比如只设了格式、或者只敲了空格）不算数据
    if (cells.length && cells.some(c => c !== undefined && String(c).trim() !== '')) {
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = ''
      out.push({ r: rowNo, cells })
    }
  }
  return { list: out, merges: parseMerges(xml, dataM.index + dataM[0].length) }
}

function cellValue(a, inner, ctx) {
  const t = a.t || 'n'
  if (t === 'inlineStr') {
    const is = RE_IS.exec(inner)
    return is ? richText(is[1]) : ''
  }
  const vm = RE_V.exec(inner)
  if (!vm) return ''
  const raw = unescapeXml(stripCdata(vm[1]))
  switch (t) {
    case 's': return ctx.strings[Number(raw)] ?? ''
    case 'str': return raw
    case 'b': return raw === '1' || raw.toLowerCase() === 'true' ? 'TRUE' : 'FALSE'
    case 'e': return '' // #N/A、#DIV/0! 之类按空处理
    case 'd': return raw.replace('T', ' ').replace(/(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/, '')
    default: {
      const s = raw.trim()
      if (!s) return ''
      const st = ctx.styles[Number(a.s || 0)]
      if (st) {
        const text = serialToText(Number(s), st.kind, ctx.date1904, st.seconds)
        if (text) return text
      }
      return numberText(s)
    }
  }
}

/* ---------------- 对外接口 ---------------- */

/**
 * 打开 .xlsx：解析目录、共享字符串和样式；工作表按需读取
 * @param {ArrayBuffer|Uint8Array} buffer
 */
export async function openXlsx(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const entries = readZipDirectory(bytes)
  const text = async path => {
    const e = entries.get(String(path).toLowerCase())
    return e ? utf8.decode(await inflateEntry(bytes, e)) : null
  }

  // 根关系文件里写着工作簿在哪（几乎总是 xl/workbook.xml）
  const rootRels = parseRels(await text('_rels/.rels'), '')
  const wbPath = rootRels.find(r => /\/officeDocument$/.test(r.type))?.target || 'xl/workbook.xml'
  const wbXml = await text(wbPath)
  if (!wbXml) throw new Error('不是有效的 .xlsx 文件（找不到工作簿），如果是 WPS / Numbers 文件请另存为 .xlsx 或 CSV')
  const baseDir = wbPath.includes('/') ? wbPath.slice(0, wbPath.lastIndexOf('/') + 1) : ''
  const relsPath = baseDir + '_rels/' + wbPath.slice(baseDir.length) + '.rels'
  const rels = parseRels(await text(relsPath), baseDir)
  const relById = new Map(rels.map(r => [r.id, r]))

  const prM = new RegExp(`<${P}workbookPr\\b([^>]*?)\\/?>`).exec(wbXml)
  const pr = prM ? attrsOf(prM[1]) : {}
  const date1904 = pr.date1904 === '1' || pr.date1904 === 'true'

  const sheets = []
  const reSheet = new RegExp(`<${P}sheet\\b([^>]*?)\\/?>`, 'g')
  let m
  while ((m = reSheet.exec(wbXml))) {
    const a = attrsOf(m[1])
    const rel = relById.get(a['r:id'] || a.id)
    // 图表页（chartsheet）没有单元格，跳过
    if (!rel || /chartsheet/i.test(rel.type)) continue
    sheets.push({ name: a.name || `Sheet${sheets.length + 1}`, hidden: a.state === 'hidden' || a.state === 'veryHidden', path: rel.target })
  }
  if (!sheets.length) throw new Error('这个 Excel 文件里没有工作表')

  const sstPath = rels.find(r => /\/sharedStrings$/.test(r.type))?.target || baseDir + 'sharedStrings.xml'
  const stylesPath = rels.find(r => /\/styles$/.test(r.type))?.target || baseDir + 'styles.xml'
  const [sstXml, stylesXml] = await Promise.all([text(sstPath), text(stylesPath)])

  const strings = []
  if (sstXml) {
    const reSi = tagRe('si')
    while ((m = reSi.exec(sstXml))) strings.push(richText(m[2] || ''))
  }
  const ctx = { strings, styles: parseStyles(stylesXml), date1904 }
  const firstVisible = Math.max(0, sheets.findIndex(s => !s.hidden))

  /** 读一个工作表的所有非空行 + 合并单元格（不区分表头和数据） */
  async function readRows(index = firstVisible) {
    const sh = sheets[index]
    if (!sh) throw new Error('工作表不存在')
    const xml = await text(sh.path)
    if (xml == null) throw new Error(`读取工作表「${sh.name}」失败（文件不完整）`)
    const { list, merges } = parseSheet(xml, ctx)
    return { records: list.map(r => r.cells), nos: list.map(r => r.r), merges }
  }

  return {
    sheets: sheets.map(s => ({ name: s.name, hidden: s.hidden })),
    firstVisible,
    readRows,
    /** 读一个工作表：第一行非空行当表头（不处理合并单元格；导入页用 readRows + parse.js 的 buildTable） */
    async readSheet(index = firstVisible) {
      const { records, nos } = await readRows(index)
      if (!records.length) return { headers: [], rows: [], rowNos: [] }
      return {
        headers: records[0].map(c => String(c).trim()),
        rows: records.slice(1),
        rowNos: nos.slice(1),
        headerRow: nos[0]
      }
    }
  }
}
