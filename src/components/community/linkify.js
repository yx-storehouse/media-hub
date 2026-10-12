/*
 * 帖子正文里的网址、邮箱、电话号码变成可点的链接。
 *
 * 只把文字切成「普通文本 / 链接」片段，由模板渲染成文本节点和 <a>，不拼 HTML：
 * 正文里的尖括号、引号等原样显示，不会被当成标签执行。
 *
 *   linkify('官网 https://a.com，电话 13800138000')
 *   → [{ text: '官网 ' }, { text: 'https://a.com', href: 'https://a.com', external: true },
 *      { text: '，电话 ' }, { text: '13800138000', href: 'tel:13800138000' }]
 *
 * 不用后行断言（iOS 16.4 以前的 Safari 不支持，整个文件会解析失败），号码前后是不是数字在代码里判断。
 */
const URL_CHARS = "[\\w\\-.~:/?#\\[\\]@!$&'()*+,;=%]"
const RE = new RegExp(
  // 1 网址：http(s):// 开头，或 www. 开头；遇到中文、空格、全角标点就结束
  `(https?://${URL_CHARS}+|www\\.[\\w-]+(?:\\.[\\w-]+)+${URL_CHARS}*)` +
  // 2 邮箱
  '|([\\w.%+-]+@[\\w-]+(?:\\.[\\w-]+)*\\.[A-Za-z]{2,})' +
  // 3 国家码 + 4 电话：手机号、400 电话、带区号的座机
  '|(\\+?86[- ]?)?(1[3-9]\\d{9}|400-?\\d{3}-?\\d{4}|0\\d{2,3}-\\d{7,8})',
  'g'
)
const isDigit = ch => ch >= '0' && ch <= '9'

/* 网址末尾的标点多半是句子的，不是网址的（括号成对时保留） */
function trimUrl(url) {
  let end = url.length
  for (;;) {
    const ch = url[end - 1]
    if ('.,;:!?\'"'.includes(ch)) { end--; continue }
    if (ch === ')' && count(url.slice(0, end), '(') < count(url.slice(0, end), ')')) { end--; continue }
    if (ch === ']' && count(url.slice(0, end), '[') < count(url.slice(0, end), ']')) { end--; continue }
    return url.slice(0, end)
  }
}
const count = (s, ch) => s.split(ch).length - 1

/** @returns {{ text: string, href?: string, external?: boolean }[]} */
export function linkify(text) {
  const str = String(text ?? '')
  const out = []
  let last = 0
  const push = (seg, from) => {
    if (from > last) out.push({ text: str.slice(last, from) })
    out.push(seg)
    last = from + seg.text.length
  }
  RE.lastIndex = 0
  for (let m; (m = RE.exec(str));) {
    const at = m.index
    if (m[1]) {
      const url = trimUrl(m[1])
      if (url.length < 8 && !url.startsWith('www.')) continue
      push({ text: url, href: url.startsWith('www.') ? 'http://' + url : url, external: true }, at)
      RE.lastIndex = at + url.length
    } else if (m[2]) {
      push({ text: m[2], href: 'mailto:' + m[2] }, at)
    } else if (m[4]) {
      // 前后紧挨着数字（订单号、更长的数字串）就不是电话号码
      if (isDigit(str[at - 1] || '') || isDigit(str[at + m[0].length] || '')) continue
      push({ text: m[0], href: 'tel:' + (m[3] ? '+86' : '') + m[4].replace(/-/g, '') }, at)
    }
  }
  if (last < str.length) out.push({ text: str.slice(last) })
  return out
}
