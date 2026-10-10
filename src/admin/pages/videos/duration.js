import { parseDuration } from '../../utils/format'

/*
 * 视频时长文本（90 / 1:30 / 01:02:03）的校验：表单边输入边提示、保存前再挡一次都用它。
 * 上限和服务端一致（720 小时），超了在输入框下直接提示，不用等保存时接口报错。
 */
export const MAX_DURATION_SEC = 720 * 3600

/** 合法（含留空）返回 ''，否则返回错误文字 */
export function durationError(text) {
  const s = parseDuration(text)
  if (s === undefined) return '时长格式不对，例如 90、1:30 或 01:02:03'
  if (s > MAX_DURATION_SEC) return '时长过大（最长 720 小时）'
  return ''
}
