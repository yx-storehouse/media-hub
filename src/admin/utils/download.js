/*
 * 浏览器里生成文件并下载（导出 CSV、错误报告、模板）。
 */

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻回收在部分浏览器上会导致下载失败，稍等一下
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  downloadBlob(filename, new Blob([text], { type: mime }))
}

/** 直接下载 CSV（text 已由 toCSV 生成，自带 BOM） */
export const downloadCSV = (filename, csvText) => downloadText(filename, csvText, 'text/csv;charset=utf-8')
