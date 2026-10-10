/*
 * 在浏览器里读取视频的时长，并截一帧当封面。
 *
 *   const { durationSec, blob } = await probeVideo('/media/videos/a.mp4', { signal })
 *   blob 是 JPEG（可能为 null：跨域图像被污染、定位失败、纯音频…）；连时长都读不到时 reject（中文错误信息）。
 *   signal 取消时立即放弃（释放 video 元素和解码器），reject AbortError。
 *
 * 先带 crossOrigin 加载（同源 /media 或开了 CORS 的外链可以截图）；外链不允许跨域时退回不带 crossOrigin
 * 再试一次，这样至少能拿到时长。用完一定清理：去掉 src、load()、移除元素，避免占着连接和解码器。
 */
export function probeVideo(url, { at = 0.1, maxWidth = 640, timeout = 20000, signal } = {}) {
  if (!url) return Promise.reject(new Error('没有播放地址'))
  return attempt(url, { at, maxWidth, timeout, signal, cors: true }).catch(e => {
    if (e.retryWithoutCors) return attempt(url, { at, maxWidth, timeout, signal, cors: false })
    throw e
  })
}

const abortError = () => new DOMException('已取消', 'AbortError')

const isCrossOrigin = url => {
  try { return new URL(url, location.href).origin !== location.origin } catch { return false }
}

function attempt(url, { at, maxWidth, timeout, signal, cors }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const v = document.createElement('video')
    v.muted = true
    v.defaultMuted = true
    v.playsInline = true
    v.preload = 'metadata'
    v.setAttribute('muted', '')
    v.setAttribute('playsinline', '')
    if (cors) v.crossOrigin = 'anonymous'
    v.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none'

    let duration = null
    let settled = false
    let fixingInfinity = false

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try {
        v.removeAttribute('src')
        v.load()
      } catch { /* 忽略 */ }
      v.remove()
    }
    const finish = (blob, err) => {
      if (settled) return
      settled = true
      cleanup()
      if (duration != null) resolve({ durationSec: duration, blob: blob || null })
      else reject(err || new Error('读取视频信息失败'))
    }
    const timer = setTimeout(() => finish(null, new Error('读取视频超时（地址无法访问或文件过大）')), timeout)
    /* 取消：不管读到哪一步都立刻收尾，结果丢掉 */
    function onAbort() {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    function seekForFrame() {
      const d = v.duration
      // 取 10% 处，但不超过 30 秒；能做到的话至少 1 秒（避开片头黑屏）
      let t = Math.min(d * at, 30)
      if (t < 1 && d > 2) t = 1
      try { v.currentTime = Math.max(0, Math.min(t, d - 0.05)) } catch { finish(null) }
    }

    v.addEventListener('loadedmetadata', () => {
      const d = v.duration
      if (d === Infinity) {
        // 部分 WebM（MediaRecorder 录的）不写时长：跳到很远处，浏览器会算出真实时长
        fixingInfinity = true
        try { v.currentTime = 1e101 } catch { finish(null, new Error('无法读取视频时长')) }
        return
      }
      if (!Number.isFinite(d) || d <= 0) return finish(null, new Error('无法读取视频时长（可能是直播流或格式不支持）'))
      duration = Math.round(d)
      seekForFrame()
    })

    v.addEventListener('durationchange', () => {
      if (!fixingInfinity || !Number.isFinite(v.duration) || v.duration <= 0) return
      fixingInfinity = false
      duration = Math.round(v.duration)
      seekForFrame()
    })

    v.addEventListener('seeked', () => {
      if (fixingInfinity || duration == null) return
      if (v.readyState >= 2) capture()
      else v.addEventListener('loadeddata', capture, { once: true })
    })

    function capture() {
      if (settled) return
      const w0 = v.videoWidth
      const h0 = v.videoHeight
      if (!w0 || !h0) return finish(null) // 没有画面（纯音频）
      const w = Math.min(w0, maxWidth)
      const h = Math.round((h0 * w) / w0)
      try {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d').drawImage(v, 0, 0, w, h)
        // 跨域画面会让 canvas 被污染，toBlob 抛 SecurityError：只返回时长
        c.toBlob(b => finish(b), 'image/jpeg', 0.82)
      } catch {
        finish(null)
      }
    }

    v.addEventListener('error', () => {
      if (duration != null) return finish(null)
      if (cors && isCrossOrigin(url) && !settled) {
        settled = true
        cleanup()
        const e = new Error('跨域加载失败')
        e.retryWithoutCors = true
        return reject(e)
      }
      finish(null, new Error('视频无法加载（地址无效或浏览器不支持该格式）'))
    })

    document.body.appendChild(v)
    v.src = url
  })
}
