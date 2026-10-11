/*
 * 管理后台：导入 / 导出字段定义 + 单元格取值规范化。
 *
 * 这里是字段的唯一来源：
 *   - GET /api/admin/schema 把 SCHEMAS 发给前端（下载模板、自动对应列名、帮助说明）
 *   - 导入时服务端用这里的规范化函数解析每个单元格，所以脚本 / curl 直接调导入接口也能用
 *   - 导出时按同样的字段顺序、同样的写法输出，「导出 → Excel 改 → 再导入」不需要手动对应列
 *
 * 所有解析函数都接受字符串 / 数字 / 布尔，出错抛 InputError(message, field)。
 */
import { InputError } from '../lib/errors.mjs'

/* ---------------- 枚举 ---------------- */

export const STATUSES = [{ value: 1, label: '已发布' }, { value: 0, label: '草稿' }, { value: 2, label: '已下架' }]
export const CREATOR_STATUSES = [{ value: 1, label: '正常' }, { value: 0, label: '停用' }]
export const POST_KINDS = [{ value: 1, label: '视频' }, { value: 0, label: '图文' }, { value: 2, label: '文档' }]
export const TOPIC_KINDS = [{ value: 0, label: '普通' }, { value: 1, label: '首页分区' }, { value: 2, label: '片库分类' }]
export const QUALITIES = [{ key: 'sd', label: '标清' }, { key: 'hd', label: '高清' }, { key: 'fhd', label: '超清' }]

/** 词 → 值 的查找表；词统一小写比较 */
const wordTable = groups => {
  const m = new Map()
  for (const [value, words] of groups) for (const w of words) m.set(String(w).toLowerCase(), value)
  return m
}

export const STATUS_WORDS = wordTable([
  [1, ['1', '已发布', '发布', '上架', '已上架', 'published', 'publish', 'online']],
  [0, ['0', '草稿', 'draft', '未发布']],
  [2, ['2', '下架', '已下架', 'offline', 'hidden', '隐藏']]
])
export const CREATOR_STATUS_WORDS = wordTable([
  [1, ['1', '正常', '启用', 'enabled', 'active', 'normal']],
  [0, ['0', '停用', '禁用', 'disabled', 'inactive']]
])
export const POST_KIND_WORDS = wordTable([
  [1, ['1', '视频', 'video', '视频帖']],
  [0, ['0', '图文', 'image', '图片', 'text']],
  [2, ['2', '文档', 'doc', 'document', '长文']]
])
export const TOPIC_KIND_WORDS = wordTable([
  [0, ['0', '普通', 'normal', '普通分类']],
  [1, ['1', '首页分区', 'home', '首页']],
  [2, ['2', '片库分类', 'library', '片库']]
])
export const QUALITY_WORDS = wordTable([
  ['sd', ['sd', '标清', '流畅', '360p', '480p', '540p']],
  ['hd', ['hd', '高清', '720p']],
  ['fhd', ['fhd', '超清', '全高清', '蓝光', '1080p', '2k', '1440p', '4k', '2160p']]
])

const labelOf = (list, value) => list.find(o => o.value === value)?.label ?? String(value)
export const statusLabel = v => labelOf(STATUSES, v)
export const creatorStatusLabel = v => labelOf(CREATOR_STATUSES, v)
export const postKindLabel = v => labelOf(POST_KINDS, v)
export const topicKindLabel = v => labelOf(TOPIC_KINDS, v)

/* ---------------- 单元格 ---------------- */

/** 空单元格：新增时 = 用默认值，更新时 = 不改 */
export const isBlank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.every(isBlank))

/**
 * 去掉首尾空白；导出时为防 CSV 公式注入给 = + - @ 开头的单元格加了 '，导入时还原
 */
export function cleanCell(v) {
  if (typeof v !== 'string') return v
  const s = v.trim()
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s
}

const bad = (field, message) => { throw new InputError(message, field) }
const chars = s => [...s].length

/**
 * 单值字段只收字符串 / 数字 / 布尔：对象、数组不能 String() 成「[object Object]」或「1」再存进去。
 * （标签、多个地址这类列表字段走 toTags / toUrls，允许数组）
 */
export function scalar(v, field, label) {
  if (v !== null && typeof v === 'object') bad(field, `${label}格式不正确`)
  return v
}

/** 文本：去空白、限长；required 时空串报错 */
export function toText(v, field, label, { max = 200, required = false } = {}) {
  scalar(v, field, label)
  const s = v == null ? '' : String(v).trim()
  if (!s && required) bad(field, `${label}不能为空`)
  if (chars(s) > max) bad(field, `${label}最多 ${max} 个字`)
  // 控制字符会把 CSV / 前端排版搞乱（换行、制表符除外）
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) bad(field, `${label}包含非法字符`)
  return s
}

/** 帖子详情正文的长度上限（字） */
export const POST_CONTENT_MAX = 20000

/**
 * 多行长文本（帖子详情正文）：换行统一成 \n，去掉每行行尾的空白和整段首尾的空白
 * （和导入时的单元格清理一致，导出再导入不会变），段落之间的空行、后面各行的行首缩进保留；限长、拒绝控制字符
 */
export function toLongText(v, field, label, { max = POST_CONTENT_MAX } = {}) {
  scalar(v, field, label)
  const s = (v == null ? '' : String(v)).replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '').trim()
  if (chars(s) > max) bad(field, `${label}最多 ${max} 个字`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) bad(field, `${label}包含非法字符`)
  return s
}

/**
 * 整数：支持千分位「1,234」和单位「1.2w / 1.2万 / 3.4k / 1亿」
 */
export function toInt(v, field, label, { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  scalar(v, field, label)
  let n
  if (typeof v === 'number') n = v
  else {
    const s = String(v ?? '').trim().replace(/\s+/g, '').replace(/,(?=\d{3}(?!\d))/g, '')
    const m = s.match(/^([+-]?\d+(?:\.\d+)?)(w|万|k|千|亿)?$/i)
    if (!m) bad(field, `${label}需为整数（如 1200、1,200、1.2w）`)
    const unit = m[2] ? { w: 1e4, '万': 1e4, k: 1e3, '千': 1e3, '亿': 1e8 }[m[2].toLowerCase()] : 1
    n = Number(m[1]) * unit
    if (m[2]) n = Math.round(n)               // 带单位的写法本来就是约数，四舍五入
  }
  n = Math.round(n * 1e6) / 1e6               // 消掉 1.15*1e4 这类浮点误差
  if (!Number.isFinite(n) || !Number.isInteger(n) || !Number.isSafeInteger(n)) bad(field, `${label}需为整数`)
  if (n < min) bad(field, `${label}不能小于 ${min}`)
  if (n > max) bad(field, `${label}不能大于 ${max}`)
  return n
}

/** 布尔：1/0、true/false、是/否、y/n、yes/no、√/× */
const TRUE_WORDS = new Set(['1', 'true', '是', 'y', 'yes', '√', '✓', '✔', 't', 'on', '对'])
const FALSE_WORDS = new Set(['0', 'false', '否', 'n', 'no', '×', '✗', '✘', 'f', 'off', '错'])
export function toBool(v, field, label) {
  scalar(v, field, label)
  if (typeof v === 'boolean') return v
  if (typeof v === 'number' && (v === 0 || v === 1)) return v === 1
  const s = String(v ?? '').trim().toLowerCase()
  if (TRUE_WORDS.has(s)) return true
  if (FALSE_WORDS.has(s)) return false
  bad(field, `${label}只能填 是 / 否`)
}

/**
 * 时长上限：30 天（720 小时）。不设上限的话，把订单号之类的长数字误映射到「时长」会存进超过 2^53 的整数，
 * 之后读这一行就会抛错，列表、导出、App 详情页全部 500，后台也删不掉它。
 */
export const MAX_DURATION_SEC = 30 * 86400

/** 时长：秒数（可带小数）、mm:ss、hh:mm:ss；三种写法都按同一个上限检查 */
export function toDuration(v, field, label = '时长') {
  scalar(v, field, label)
  let n
  if (typeof v === 'number') {
    if (Number.isNaN(v)) bad(field, `${label}格式不正确，应为秒数、mm:ss 或 hh:mm:ss`)
    if (v < 0) bad(field, `${label}不能为负数`)
    n = Math.round(v)
  } else {
    const s = String(v ?? '').trim().replace(/：/g, ':')
    const parts = s.split(':')
    if (/^\d+(\.\d+)?$/.test(s)) n = Math.round(Number(s))
    else if ((parts.length === 2 || parts.length === 3) && parts.every((p, i) => (i === parts.length - 1 ? /^\d{1,2}(\.\d+)?$/ : /^\d+$/).test(p))) {
      const nums = parts.map(Number)
      const sec = nums[nums.length - 1]
      // 中间的「分」在 hh:mm:ss 里不能超过 59；mm:ss 的分钟可以超过 60（如 75:30）
      if (sec >= 60 || (nums.length === 3 && nums[1] >= 60)) bad(field, `${label}「${s}」不正确`)
      n = Math.round(nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + sec : nums[0] * 60 + sec)
    } else bad(field, `${label}格式不正确，应为秒数、mm:ss 或 hh:mm:ss`)
  }
  if (!Number.isSafeInteger(n) || n > MAX_DURATION_SEC) bad(field, `${label}过大（最长 ${MAX_DURATION_SEC / 3600} 小时）`)
  return n
}

/**
 * 时间 → Unix 秒。接受：
 *   Unix 秒（9-10 位）/ 毫秒（12-13 位）
 *   Excel 日期序号（20000-80000，可带小数，按服务器本地时区）
 *   YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD，后面可跟 HH:mm 或 HH:mm:ss（本地时区）
 *   2026年10月10日、2026年10月10日 14:30、2026年10月10日 14时30分（中文 Excel 长日期存成 CSV 就是这样）
 *   ISO 带时区：2026-10-10T14:30:00Z、2026-10-10T14:30:00+08:00（按给定的时区换算）
 * 不用 new Date('YYYY-MM-DD')：那会按 UTC 解析。
 */
export function toTimestamp(v, field, label = '时间') {
  scalar(v, field, label)
  const s = (typeof v === 'number' ? String(v) : String(v ?? '')).trim()
    .replace(/：/g, ':')
    .replace(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*/, '$1-$2-$3 ')
    .replace(/\s(\d{1,2})\s*[时點点]\s*(\d{1,2})\s*分(?:\s*(\d{1,2})\s*秒)?$/, (m, h, mi, se) => ` ${h}:${mi}${se ? ':' + se : ''}`)
    .trim()
  if (/^\d{9,10}$/.test(s)) return Number(s)
  if (/^\d{12,13}$/.test(s)) return Math.floor(Number(s) / 1000)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (n >= 20000 && n <= 80000) {
      const days = Math.floor(n)
      const secs = Math.round((n - days) * 86400)
      // Excel 的 0 号是 1899-12-30；用本地时间构造，秒数溢出由 Date 自己进位
      return Math.floor(new Date(1899, 11, 30 + days, 0, 0, secs).getTime() / 1000)
    }
  }
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i)
  if (m) {
    const [y, mo, d, h = 0, mi = 0, se = 0] = m.slice(1, 7).map(x => (x === undefined ? undefined : Number(x)))
    const tz = m[7]
    if (h > 23 || mi > 59 || se > 59) bad(field, `${label}「${s}」不是有效的日期`)
    if (tz) {
      // 带时区：先按 UTC 构造再减去偏移（+08:00 表示比 UTC 快 8 小时）
      const off = /^z$/i.test(tz) ? 0 : (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(-2)))
      const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se))
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d ||
          Math.abs(off) > 14 * 60 || Number(tz.slice(-2)) > 59) bad(field, `${label}「${s}」不是有效的日期`)
      return Math.floor(dt.getTime() / 1000) - off * 60
    }
    const dt = new Date(y, mo - 1, d, h, mi, se)
    // 2026-02-30 这类会被 Date 自动进位，回读一遍确认没有越界
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) bad(field, `${label}「${s}」不是有效的日期`)
    return Math.floor(dt.getTime() / 1000)
  }
  bad(field, `${label}格式不正确，应为 2026-10-10 14:30 这样的日期时间`)
}

/** Unix 秒 → 「YYYY-MM-DD HH:mm:ss」（服务器本地时区），导出用 */
export function fmtTimestamp(ts) {
  if (!ts && ts !== 0) return ''
  const d = new Date(ts * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 秒 → hh:mm:ss，导出用 */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const p = n => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

export const fmtBool = v => (v ? '是' : '否')

/* ---------------- 列表：标签 / 多个地址 ---------------- */

const LIST_SEP = /[,，;；|、\r\n]+|\s+(?=[#＃])/
const LIST_SEP_SPACE = /[,，;；|、\s]+/

/** 数组或分隔字符串 → 去空白的项；数组里只收字符串 / 数字（嵌套数组、对象报错） */
function splitList(v, sep, field, label) {
  const items = Array.isArray(v) ? v : [v]
  const out = []
  for (const it of items) {
    if (it == null) continue
    scalar(it, field, label)
    for (const part of String(it).split(sep)) {
      const t = part.trim()
      if (t) out.push(t)
    }
  }
  return out
}

/**
 * 标签：数组或分隔字符串（, ， ; ； | 、 换行）。
 * 视频标签另外按空白切开，存成带 # 的写法（["#日落"]）；帖子标签不带 #（["AI"]）。
 */
export function toTags(v, field, { hash = false, label = '标签', maxCount = 20, maxLen = 20 } = {}) {
  const seen = new Set(), out = []
  for (const raw of splitList(v, hash ? LIST_SEP_SPACE : LIST_SEP, field, label)) {
    const t = raw.replace(/^[#＃]+/, '').trim()
    if (!t) continue
    if (chars(t) > maxLen) bad(field, `${label}「${t}」超过 ${maxLen} 个字`)
    if (/[\u0000-\u001f\u007f]/.test(t)) bad(field, `${label}包含非法字符`)
    if (seen.has(t)) continue
    seen.add(t)
    out.push(hash ? '#' + t : t)
  }
  if (out.length > maxCount) bad(field, `${label}最多 ${maxCount} 个`)
  return out
}

/**
 * 地址：http(s):// 绝对地址，或以 / 开头的站内路径（如 /media/videos/a.mp4）。
 * javascript:、data:、不带 / 的相对路径一律拒绝。
 * 单个地址允许中间有普通空格（未编码的 /media/我的 视频.mp4），换行 / 制表符等不允许。
 */
export function toUrl(v, field, label = '地址') {
  scalar(v, field, label)
  const s = String(v ?? '').trim()
  if (!s) bad(field, `${label}不能为空`)
  if (s.length > 2000) bad(field, `${label}过长（最多 2000 个字符）`)
  if (/[\u0000-\u001f\u007f\u0085\u00a0\u2028\u2029\u3000]/.test(s)) bad(field, `${label}不能包含换行或特殊空白字符`)
  if (/^https?:\/\/[^/?#]+/i.test(s)) return s
  if (s.startsWith('/') && !s.startsWith('//')) return s
  bad(field, `${label}必须以 http://、https:// 或 / 开头`)
}

/** 多个地址：数组或分隔字符串（含空白、换行），去重 */
export function toUrls(v, field, { label = '图片', max = 9 } = {}) {
  const out = []
  for (const s of splitList(v, LIST_SEP_SPACE, field, label)) {
    const u = toUrl(s, field, label)
    if (!out.includes(u)) out.push(u)
  }
  if (out.length > max) bad(field, `${label}最多 ${max} 张`)
  return out
}

/** 枚举：按查找表认值或标签（不区分大小写） */
export function toEnum(v, field, label, words, options) {
  scalar(v, field, label)
  const s = String(v ?? '').trim().toLowerCase()
  if (words.has(s)) return words.get(s)
  const hint = options ? `，可选：${options.join(' / ')}` : ''
  bad(field, `${label}「${String(v).trim()}」无法识别${hint}`)
}

/* ---------------- 字段定义 ---------------- */

/**
 * Field = { key, label, aliases, type, required, example, help, options? }
 * label 就是 CSV 模板 / 导出的表头；aliases 是常见的其他写法（小写），前端据此自动对应列。
 * options 为 'categories' / 'regions' 这类字符串时，由 schema() 用库里的实时数据填充。
 */
const f = (key, label, type, aliases, extra = {}) => ({ key, label, aliases, type, required: false, example: '', help: '', ...extra })

const STATUS_HELP = '已发布 / 草稿 / 已下架（或 1 / 0 / 2）；留空用导入选项里的默认状态'
const statusOptions = STATUSES.map(o => ({ value: o.value, label: o.label }))
const BOOL_HELP = '是 / 否（也可填 1 / 0、y / n、√ / ×）'
const TIME_HELP = '2026-10-10 14:30、2026/10/10、2026年10月10日、Excel 日期或 Unix 时间戳；留空为当前时间'

export const SCHEMAS = {
  videos: {
    type: 'videos', label: '视频', keyFields: ['id', 'publicId', 'playbackUrl'],
    fields: [
      f('id', 'ID', 'id', ['id', '视频id'], { example: '', help: '已有视频的 ID：填了就更新这条视频（不存在会报错）；新增留空' }),
      f('publicId', '编号', 'text', ['publicid', 'public_id', 'code', '视频编号', 'vid'], { example: 'VID-2001', help: '对外编号，如 VID-2001；留空自动生成。也用于判断是否重复' }),
      f('title', '标题', 'text', ['title', '视频标题', '标题名', '名称', 'name'], { required: true, example: '海边日落治愈系Vlog', help: '必填，最多 200 字' }),
      f('description', '简介', 'longtext', ['description', 'desc', '描述', '介绍', '视频简介', '说明'], { example: '傍晚六点的海边', help: '最多 5000 字' }),
      f('topic', '专题', 'ref', ['topic', 'topicid', 'topic_id', '专题id', '专题名称', '合集'], { example: '治愈日常', help: '专题 ID、标识或名称；名称不存在时可自动创建' }),
      f('creator', '创作者', 'ref', ['creator', 'creatorid', 'creator_id', '作者', 'up主', '创作者账号', 'author'], { example: '@trip', help: '创作者 ID、账号（可带 @）或名称；不存在时可自动创建' }),
      f('category', '分类', 'enum', ['category', 'categorykey', 'category_key', '类别', '频道'], { example: 'cn', help: '分类 key 或名称', options: 'categories' }),
      f('region', '地区', 'enum', ['region', '地域', '国家', '产地'], { example: 'cn', help: '地区代码或名称', options: 'regions' }),
      f('quality', '清晰度', 'enum', ['quality', '画质', '分辨率'], { example: '高清', help: '标清 / 高清 / 超清（也可填 sd / hd / fhd、720p、1080p、4k）', options: QUALITIES.map(q => ({ value: q.key, label: q.label })) }),
      f('tags', '标签', 'tags', ['tags', 'tag', '关键词', '话题'], { example: '#日落,#旅拍', help: '多个用逗号、空格或分号隔开，# 可写可不写；最多 20 个' }),
      f('duration', '时长', 'duration', ['duration', 'durationsec', 'duration_sec', '时长秒', '片长', '长度'], { example: '00:12:34', help: '秒数，或 mm:ss / hh:mm:ss' }),
      f('coverUrl', '封面地址', 'url', ['cover', 'coverurl', 'cover_url', '封面', '封面图', '缩略图', 'thumbnail', 'poster', '封面链接'], { example: '/media/covers/a.jpg', help: 'http(s):// 地址或 /media/ 开头的站内路径' }),
      f('playbackUrl', '播放地址', 'url', ['playback', 'playbackurl', 'playback_url', 'url', 'src', '视频地址', '播放链接', '视频链接', '视频url', '视频文件'], { example: '/media/videos/a.mp4', help: 'http(s):// 地址或 /media/ 开头的站内路径；也用于判断是否重复' }),
      f('status', '状态', 'enum', ['status', '发布状态', '上架状态'], { example: '已发布', help: STATUS_HELP, options: statusOptions }),
      f('publishedAt', '发布时间', 'datetime', ['publishedat', 'published_at', 'publishtime', '发布日期', '上架时间', '日期', 'date'], { example: '2026-10-10 14:30', help: TIME_HELP }),
      f('isShort', '短视频', 'bool', ['isshort', 'is_short', 'short', '是否短视频', '加入短视频'], { example: '否', help: '是否出现在短视频流；' + BOOL_HELP })
    ]
  },
  posts: {
    type: 'posts', label: '帖子', keyFields: ['id'],
    fields: [
      f('id', 'ID', 'id', ['id', '帖子id'], { help: '已有帖子的 ID：填了就更新这条帖子（不存在会报错）；新增留空' }),
      f('creator', '发布者', 'ref', ['creator', 'creatorid', 'creator_id', '作者', '创作者', '发帖人', 'author'], { required: true, example: '@aijc', help: '必填：创作者 ID、账号（可带 @）或名称；不存在时可自动创建' }),
      f('text', '标题', 'longtext', ['text', 'title', '帖子标题', '文案'], { required: true, example: '川西环线十日自驾攻略', help: '必填，最多 5000 字；显示在社区列表和详情页顶部' }),
      f('content', '正文', 'longtext', ['content', 'body', '详情', '详情正文', '帖子正文', '正文内容', '内容', '帖子内容'], { example: '路线：成都 → 康定 → 新都桥 → 理塘 → 稻城亚丁', help: `详情页标题下面的正文，可以换行；最多 ${POST_CONTENT_MAX} 字；更新时留空表示不改` }),
      f('kind', '类型', 'enum', ['kind', 'mediakind', 'media_kind', '帖子类型', '媒体类型'], { example: '视频', help: '视频 / 图文 / 文档（或 1 / 0 / 2）；留空为视频', options: POST_KINDS.map(o => ({ value: o.value, label: o.label })) }),
      f('video', '关联视频', 'ref', ['video', 'videoid', 'video_id', '视频', '视频id', '视频编号'], { example: 'VID-1001', help: '视频 ID 或编号' }),
      f('tags', '标签', 'tags', ['tags', 'tag', '话题', '关键词'], { example: 'AI,剧情', help: '多个用逗号或分号隔开，不需要写 #；最多 20 个' }),
      f('mainImage', '主图', 'url', ['mainimage', 'main_image', 'main', '封面', '封面图', '头图', 'cover'], { example: '/media/images/p1.jpg', help: 'http(s):// 地址或 /media/ 开头的站内路径' }),
      f('images', '配图', 'urls', ['images', 'imgs', '图片', '多图', 'thumbs', '缩略图'], { example: '/media/images/p1-1.jpg,/media/images/p1-2.jpg', help: '多个地址用逗号、空格或换行隔开；最多 9 张' }),
      f('moreCount', '折叠数', 'int', ['more', 'morecount', 'more_count', '更多'], { example: '3', help: '缩略图最后一张上显示的 +N' }),
      f('readCount', '阅读数', 'int', ['read', 'readcount', 'read_count', '阅读', '阅读量', '浏览量'], { example: '1.2w', help: '整数，可写 1,200 或 1.2w' }),
      f('isHot', '热门', 'bool', ['hot', 'ishot', 'is_hot', '是否热门'], { example: '否', help: BOOL_HELP }),
      f('status', '状态', 'enum', ['status', '发布状态'], { example: '已发布', help: STATUS_HELP, options: statusOptions }),
      f('publishedAt', '发布时间', 'datetime', ['publishedat', 'published_at', '发布日期', '日期', 'date'], { example: '2026-10-10 14:30', help: TIME_HELP })
    ]
  },
  topics: {
    type: 'topics', label: '专题', keyFields: ['id', 'slug', 'name'],
    fields: [
      f('id', 'ID', 'id', ['id', '专题id'], { help: '已有专题的 ID：填了就更新（不存在会报错）；新增留空' }),
      f('name', '名称', 'text', ['name', '专题', '专题名', '专题名称', 'title'], { required: true, example: '城市漫游', help: '必填，最多 40 字；也用于判断是否重复' }),
      f('slug', '标识', 'text', ['slug', 'key', '英文标识', '别名'], { example: 'citywalk', help: '小写字母、数字和 -；留空自动生成' }),
      f('description', '简介', 'longtext', ['description', 'desc', '描述', '介绍'], { example: '', help: '最多 500 字' }),
      f('kind', '类型', 'enum', ['kind', '专题类型'], { example: '普通', help: '普通 / 首页分区 / 片库分类（或 0 / 1 / 2）', options: TOPIC_KINDS.map(o => ({ value: o.value, label: o.label })) }),
      f('sortOrder', '排序', 'int', ['sort', 'sortorder', 'sort_order', '顺序', '序号'], { example: '10', help: '越小越靠前；留空排在最后' }),
      f('isFeatured', '大卡', 'bool', ['featured', 'isfeatured', 'is_featured', '是否大卡'], { example: '否', help: BOOL_HELP }),
      f('cardSize', '首屏数量', 'int', ['cardsize', 'card_size', 'size', '首屏', '每批数量'], { example: '4', help: '1-20，默认 4' }),
      f('playsCount', '播放数', 'int', ['plays', 'playscount', 'plays_count', '播放', '播放量'], { example: '8100', help: '专题页展示的播放数' }),
      f('status', '状态', 'enum', ['status', '发布状态'], { example: '已发布', help: STATUS_HELP, options: statusOptions }),
      f('covers', '头图', 'urls', ['covers', 'cover', '封面', '封面图', '图片'], { example: '/media/covers/t1.jpg', help: '最多 4 张，用逗号、空格或换行隔开；留空自动生成占位图' })
    ]
  },
  creators: {
    type: 'creators', label: '创作者', keyFields: ['id', 'handle'],
    fields: [
      f('id', 'ID', 'id', ['id', '创作者id'], { help: '已有创作者的 ID：填了就更新（不存在会报错）；新增留空' }),
      f('handle', '账号', 'text', ['handle', '用户名', 'username', 'account'], { example: 'trip', help: '2-32 位字母、数字或 _ . -（可带 @）；留空自动生成；也用于判断是否重复' }),
      f('name', '名称', 'text', ['name', '昵称', '名字', '创作者', '作者'], { required: true, example: '旅行日记', help: '必填，最多 30 字' }),
      f('avatarUrl', '头像', 'url', ['avatar', 'avatarurl', 'avatar_url', '头像地址'], { example: '/media/images/trip.jpg', help: 'http(s):// 地址或 /media/ 开头的站内路径；留空用首字头像' }),
      f('bio', '简介', 'longtext', ['bio', '签名', '个人简介', '介绍', '描述'], { example: '记录路上的风景', help: '最多 200 字' }),
      f('isVerified', '认证', 'bool', ['verified', 'isverified', 'is_verified', '是否认证', '加v'], { example: '否', help: BOOL_HELP }),
      f('isOfficial', '官方', 'bool', ['official', 'isofficial', 'is_official', '是否官方'], { example: '否', help: BOOL_HELP }),
      f('status', '状态', 'enum', ['status', '账号状态'], { example: '正常', help: '正常 / 停用（或 1 / 0）', options: CREATOR_STATUSES.map(o => ({ value: o.value, label: o.label })) })
    ]
  },
  keywords: {
    type: 'keywords', label: '搜索热词', keyFields: ['word'],
    fields: [
      f('word', '热词', 'text', ['word', 'keyword', '关键词', '搜索词', '词'], { required: true, example: '露营', help: '必填，最多 20 字；也用于判断是否重复' }),
      f('isHot', '火焰标', 'bool', ['hot', 'ishot', 'is_hot', '热门', '火'], { example: '是', help: BOOL_HELP }),
      f('isBanned', '屏蔽', 'bool', ['banned', 'isbanned', 'is_banned', '禁用', '是否屏蔽'], { example: '否', help: '屏蔽后不出现在热门搜索；' + BOOL_HELP }),
      f('weight', '权重', 'int', ['weight', '热度', '分值'], { example: '100', help: '越大越靠前' }),
      f('sortOrder', '排序', 'int', ['sort', 'sortorder', 'sort_order', '顺序', '序号'], { example: '0', help: '权重相同时按它排，越小越靠前' })
    ]
  }
}

export const IMPORT_TYPES = Object.keys(SCHEMAS)

/** 字段 key 列表（导出的 fields 就是这个顺序） */
export const fieldKeys = type => SCHEMAS[type].fields.map(x => x.key)

/**
 * 发给前端的 schema：动态选项（分类 / 地区）用库里的实时数据填上
 * @param {{ categories: {key,label}[], regions: {code,label}[] }} dyn
 */
export function buildSchema(dyn) {
  const out = {}
  for (const [type, s] of Object.entries(SCHEMAS)) {
    out[type] = {
      ...s,
      fields: s.fields.map(x => {
        if (x.options === 'categories') return { ...x, options: dyn.categories.map(c => ({ value: c.key, label: c.label })) }
        if (x.options === 'regions') return { ...x, options: dyn.regions.map(r => ({ value: r.code, label: r.label })) }
        return { ...x }
      })
    }
  }
  return out
}

/** 导入 key ↔ 接口字段名：错误提示要标回导入的列 */
export const IMPORT_TO_API = {
  videos: { topic: 'topicId', creator: 'creatorId', category: 'categoryKey', duration: 'durationSec' },
  posts: { creator: 'creatorId', kind: 'mediaKind', video: 'videoId' },
  topics: {}, creators: {}, keywords: {}
}
export const apiToImportKey = (type, apiKey) => {
  const m = IMPORT_TO_API[type]
  for (const [k, v] of Object.entries(m)) if (v === apiKey) return k
  return apiKey
}
