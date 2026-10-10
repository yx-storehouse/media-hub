/*
 * 视频「读时长 + 截封面」的统一实现：视频编辑表单的「从视频读取」、视频列表的批量「提取时长和封面」、
 * 素材文件「扫描导入」之后的自动提取都用它（不要再各写一份）。
 *
 *   const vp = useVideoProbe()          // 返回 reactive；组件卸载时自动停止，结果作废
 *
 * ① 表单里读取（不保存，结果由调用方写进表单）
 *   const r = await vp.read(url, { cover: true, coverPath: 'covers/v12.jpg', overwrite: false, isCurrent })
 *     → { durationSec, coverUrl, coverNote }   coverUrl 为 null 时 coverNote 说明原因（截不到画面 / 上传失败）
 *   新的一次 read()、cancel()、组件卸载、或 isCurrent() 返回 false 之后，旧的 read 作废：
 *   reject AbortError，并且不会再上传截图（不会把上一个表单的结果写进下一个表单）。
 *
 * ② 处理一个已保存的视频：读时长 → 截一帧上传为 covers/v<id>.jpg（覆盖同名）→ PATCH { durationSec, coverUrl }
 *   const r = await vp.apply(video, { overwriteCover = false, onlyDuration = false })
 *     → { state: 'ok' | 'skip' | 'fail', msg, patch }    video 要有 id / playbackUrl / coverUrl / title
 *   已有封面且没勾 overwriteCover 时只更新时长；onlyDuration 时不截图。
 *
 * ③ 批量（一次一个，免得同时解码几十个视频把页面拖死）
 *   const sum = await vp.runAll(list, { overwriteCover, onlyDuration, onItem(entry, result), onProgress(progress) })
 *     list：视频对象（含 playbackUrl）或 id（会先 getVideo）；→ { ok, fail, skip, stopped }
 *   vp.cancel()    停止：正在读的那个立即放弃（释放解码器），已经处理的不回滚；它记为 skip「已停止」，
 *                  没轮到的不回调 onItem（调用方自己标成「已停止」）
 *   vp.running / vp.progress = { total, done, ok, fail, skip, current }
 *   list 里的对象：{ id, title, playbackUrl, coverUrl }（扫描导入的结果要把 url 映射成 playbackUrl）
 *
 * 一个实例同一时间只做一件事：新的 read() / runAll() 会先停掉上一个。要同时跑两件事就各用一个实例。
 *
 * 覆盖上传后同一地址的图片内容变了：api.uploadFile 会登记 mediaVersions，后台里的 Thumb 自动加载新图。
 */
import { ref, reactive, getCurrentInstance, onBeforeUnmount } from 'vue'
import { getVideo, updateVideo, uploadFile, resolveUrl } from '../api'
import { probeVideo } from '../utils/probe'
import { fmtDuration } from '../utils/format'

const abortError = (msg = '已取消') => new DOMException(msg, 'AbortError')
const isAbort = e => e?.name === 'AbortError'

export function useVideoProbe() {
  /* 每次 read / runAll / cancel 都换一个 token：拿着旧 token 的结果一律作废 */
  let token = 0
  let ctrl = null
  const running = ref(false)
  const progress = reactive({ total: 0, done: 0, ok: 0, fail: 0, skip: 0, current: '' })

  /** 开始新的一轮：取消上一轮，返回本轮的 token 和 signal */
  function begin() {
    ctrl?.abort()
    ctrl = new AbortController()
    return { my: ++token, signal: ctrl.signal }
  }
  function cancel() {
    token++
    ctrl?.abort()
    ctrl = null
  }

  /* ---------- ① 只读（表单） ---------- */
  async function read(url, { cover = true, coverPath = '', overwrite = false, isCurrent = () => true } = {}) {
    if (!url) throw new Error('请先填写播放地址')
    const { my, signal } = begin()
    const live = () => my === token && isCurrent()
    const check = () => { if (!live()) throw abortError('已过期') }
    const { durationSec, blob } = await probeVideo(resolveUrl(url), { signal })
    check()
    let coverUrl = null
    let coverNote = ''
    if (cover) {
      if (!blob) coverNote = '截不到画面（跨域限制或格式不支持），封面未改'
      else {
        try {
          const res = await uploadFile(coverPath || 'covers/frame.jpg', blob, { overwrite, signal })
          coverUrl = res.url
        } catch (e) {
          if (isAbort(e)) throw e
          coverNote = '封面上传失败：' + (e?.message || '未知错误')
        }
        check()
      }
    }
    if (my === token) ctrl = null
    return { durationSec, coverUrl, coverNote }
  }

  /* ---------- ② 处理一个视频并保存 ---------- */
  async function apply(video, { overwriteCover = false, onlyDuration = false, signal } = {}) {
    if (!video?.playbackUrl) return { state: 'skip', msg: '没有播放地址', patch: {} }
    const { durationSec, blob } = await probeVideo(resolveUrl(video.playbackUrl), { signal })
    if (signal?.aborted) throw abortError()
    const patch = {}
    const notes = []
    let coverError = ''
    if (durationSec > 0) { patch.durationSec = durationSec; notes.push('时长 ' + fmtDuration(durationSec)) }
    if (onlyDuration) { /* 只要时长 */ }
    else if (video.coverUrl && !overwriteCover) notes.push('已有封面，未覆盖')
    else if (!blob) notes.push('截不到画面（跨域限制或格式不支持），封面未改')
    else {
      try {
        const res = await uploadFile(`covers/v${video.id}.jpg`, blob, { overwrite: true, signal })
        patch.coverUrl = res.url
        notes.push('封面已更新')
      } catch (e) {
        if (isAbort(e)) throw e
        // 封面没传上去也先把时长存下来，这一条记为失败并写明原因
        coverError = '封面上传失败：' + (e?.message || '未知错误')
      }
    }
    // 封面已经传上去了就把 PATCH 做完（不再响应停止），免得文件换了、记录没改
    if (Object.keys(patch).length) await updateVideo(video.id, patch)
    if (coverError) return { state: 'fail', msg: [...notes, coverError].join('；'), patch }
    return { state: Object.keys(patch).length ? 'ok' : 'skip', msg: notes.join('；') || '没有可更新的内容', patch }
  }

  /* ---------- ③ 批量 ---------- */
  let activeRun = 0
  async function runAll(list, { overwriteCover = false, onlyDuration = false, onItem, onProgress } = {}) {
    const { my, signal } = begin()
    const stopped = () => my !== token
    // 被新的 runAll 接手后，progress 归新的那一轮，旧的这一轮不能再改它
    const mine = () => activeRun === my
    const sum = { ok: 0, fail: 0, skip: 0, done: 0 }
    activeRun = my
    running.value = true
    Object.assign(progress, { total: list.length, done: 0, ok: 0, fail: 0, skip: 0, current: '' })
    try {
      for (const entry of list) {
        if (stopped()) break
        const obj = typeof entry === 'object' && entry !== null ? entry : null
        const id = obj ? obj.id : entry
        if (mine()) progress.current = obj?.title || `视频 #${id}`
        let result
        try {
          const video = obj && 'playbackUrl' in obj ? obj : await getVideo(id)
          if (stopped()) throw abortError()
          if (mine() && video.title) progress.current = video.title
          result = { ...(await apply(video, { overwriteCover, onlyDuration, signal })), video }
        } catch (e) {
          result = isAbort(e) || stopped()
            ? { state: 'skip', msg: '已停止', patch: {}, stopped: true }
            : { state: 'fail', msg: e?.message || '处理失败', patch: {} }
        }
        sum[result.state]++
        sum.done++
        if (!mine()) break
        progress[result.state]++
        progress.done++
        onItem?.(entry, result)
        onProgress?.(progress)
        if (result.stopped) break
      }
    } finally {
      if (mine()) { activeRun = 0; running.value = false; progress.current = '' }
      if (my === token) ctrl = null
    }
    return { ok: sum.ok, fail: sum.fail, skip: sum.skip, stopped: sum.done < list.length || stopped() }
  }

  /* 页面切走 / 对话框卸载：停下来，不在后台继续跑 */
  if (getCurrentInstance()) onBeforeUnmount(cancel)

  return reactive({ read, apply, runAll, cancel, running, progress })
}
