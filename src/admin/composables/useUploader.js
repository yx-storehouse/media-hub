/*
 * 上传文件到素材目录：带进度、可取消；组件卸载时（关抽屉、关对话框、离开页面）自动取消还没传完的。
 * MediaUrlInput / UrlListInput / MediaPicker 都用它，页面里要自己做上传按钮时也用它，不要直接调 api.uploadFile。
 *
 *   const up = useUploader()
 *   try {
 *     const res = await up.upload('covers/a.jpg', file)          // → { path, url, size }
 *     // 可选：{ overwrite: true, key: row.k, onProgress: p => … }（p = { loaded, total, percent }）
 *   } catch (e) {
 *     if (up.isCancel(e)) { if (!up.disposed) toast('已取消上传') }  // 卸载导致的取消不用提示
 *     else toastError(e, '上传失败')
 *   }
 *   up.busy     是否有上传在进行
 *   up.percent  最近发起的那个上传的进度（0-100），没有上传时为 null
 *   up.count    进行中的个数
 *   up.cancel(key?)  取消 key 对应的上传（upload 时传的 key）；不传 = 全部取消
 *
 * 同一个 key 再次 upload 会先取消上一个。在 ADrawer 里使用时，有上传进行中关抽屉会先确认（见 UPLOAD_GUARD）。
 * 返回 reactive 对象：模板里直接写 up.busy / up.percent。
 */
import { reactive, computed, markRaw, inject, getCurrentInstance, onBeforeUnmount } from 'vue'
import { uploadFile } from '../api'

/** ADrawer provide 的计数器：{ add(), remove() }，用来在关闭前提醒「还有文件在上传」 */
export const UPLOAD_GUARD = Symbol('a-upload-guard')

const cancelError = () => new DOMException('已取消上传', 'AbortError')

export function useUploader() {
  const inComponent = !!getCurrentInstance()
  const guard = inComponent ? inject(UPLOAD_GUARD, null) : null
  const tasks = reactive(new Map()) // key → { ctrl, percent }
  let seq = 0
  let disposed = false

  function upload(path, file, { overwrite = false, onProgress, key } = {}) {
    if (disposed) return Promise.reject(cancelError())
    const k = key ?? `auto-${++seq}`
    tasks.get(k)?.ctrl.abort()
    const ctrl = new AbortController()
    // ctrl 不能被包成响应式代理（原生对象的方法会报 Illegal invocation）
    const task = reactive({ ctrl: markRaw(ctrl), percent: 0 })
    tasks.delete(k) // 重新插入，保证「最近发起的」排在最后
    tasks.set(k, task)
    guard?.add()
    return uploadFile(path, file, {
      overwrite,
      signal: ctrl.signal,
      onProgress: p => { task.percent = p.percent; onProgress?.(p) }
    }).finally(() => {
      if (tasks.get(k)?.ctrl === ctrl) tasks.delete(k)
      guard?.remove()
    })
  }

  function cancel(key) {
    if (key === undefined) { for (const t of tasks.values()) t.ctrl.abort() }
    else tasks.get(key)?.ctrl.abort()
  }

  const busy = computed(() => tasks.size > 0)
  const count = computed(() => tasks.size)
  const percent = computed(() => {
    let p = null
    for (const t of tasks.values()) p = t.percent
    return p
  })
  const isCancel = e => e?.name === 'AbortError'

  if (inComponent) onBeforeUnmount(() => { disposed = true; cancel() })

  return reactive({
    upload,
    cancel,
    busy,
    count,
    percent,
    isCancel,
    /** 组件已卸载（此后的取消都是卸载造成的，不必提示） */
    get disposed() { return disposed }
  })
}
