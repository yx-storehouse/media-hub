/*
 * 上传队列：同时传 3 个，其余排队；每个文件有进度、速度、取消、失败原因，失败 / 取消的可以重试。
 * 真正的上传交给 kit 的 useUploader（按 item.id 取消；页面卸载时自动中止没传完的），所以要在组件 setup 里创建。
 *
 *   const queue = createUploadQueue({ onDone: item => … })
 *   queue.add([{ file, rel: 'a.mp4' }], 'videos')   // 传到 media/videos/a.mp4（重名自动改名）
 *   queue.items / queue.stats / queue.cancel(item) / queue.cancelAll() / queue.retry(item) / queue.clearFinished()
 */
import { reactive, computed, markRaw } from 'vue'
import { useUploader } from '../../composables/useUploader'
import { isAllowed, extOf } from './files'

let seq = 0

export function createUploadQueue({ concurrency = 3, onDone } = {}) {
  const items = reactive([])
  const up = useUploader()
  let active = 0

  const stats = computed(() => {
    const s = { total: items.length, wait: 0, up: 0, done: 0, fail: 0, cancel: 0, bytes: 0, loaded: 0, speed: 0 }
    for (const it of items) {
      s[it.state]++
      if (it.state === 'wait' || it.state === 'up') {
        s.bytes += it.size
        s.loaded += it.loaded
      }
      if (it.state === 'up') s.speed += it.speed
    }
    s.running = s.wait + s.up
    return s
  })

  /**
   * @param {Array<{ file: File, rel: string }>} list  rel 是相对目标文件夹的路径（拖入文件夹时带子目录）
   * @param {string} dir  目标文件夹（相对 media/，'' = 根目录）
   */
  function add(list, dir) {
    let added = 0
    for (const { file, rel } of list) {
      const parts = String(rel || file.name).split('/').filter(Boolean)
      // .DS_Store 之类的隐藏文件不传
      if (!parts.length || parts.some(p => p.startsWith('.'))) continue
      const relPath = parts.join('/')
      const item = reactive({
        id: ++seq,
        file: markRaw(file),
        name: relPath,
        size: file.size,
        path: (dir ? dir + '/' : '') + relPath,
        dir,
        state: 'wait', // wait | up | done | fail | cancel
        loaded: 0,
        percent: 0,
        speed: 0,
        error: '',
        result: null
      })
      if (!isAllowed(file.name)) {
        item.state = 'fail'
        item.error = `不支持的文件类型（.${extOf(file.name) || '无扩展名'}），只能上传视频、图片或字幕`
        item.final = true
      } else if (!file.size) {
        item.state = 'fail'
        item.error = '文件是空的'
        item.final = true
      }
      items.push(item)
      added++
    }
    pump()
    return added
  }

  function pump() {
    while (active < concurrency) {
      const next = items.find(i => i.state === 'wait')
      if (!next) break
      start(next)
    }
  }

  async function start(item) {
    active++
    item.state = 'up'
    item.error = ''
    item.loaded = 0
    item.percent = 0
    item.speed = 0
    let lastT = performance.now()
    let lastL = 0
    try {
      const res = await up.upload(item.path, item.file, {
        key: item.id,
        onProgress: p => {
          item.loaded = p.loaded
          item.percent = p.percent
          // 速度：每 0.4 秒算一次，和上一次平滑一下，数字不乱跳
          const now = performance.now()
          const dt = now - lastT
          if (dt >= 400) {
            const inst = ((p.loaded - lastL) / dt) * 1000
            item.speed = item.speed ? item.speed * 0.5 + inst * 0.5 : inst
            lastT = now
            lastL = p.loaded
          }
        }
      })
      item.state = 'done'
      item.result = res
      item.loaded = item.size
      item.percent = 100
      item.speed = 0
      onDone?.(item)
    } catch (e) {
      item.speed = 0
      if (e?.name === 'AbortError') {
        item.state = 'cancel'
        item.error = '已取消'
      } else {
        item.state = 'fail'
        item.error = e?.message || '上传失败'
      }
    } finally {
      active--
      // 页面已经卸载（离开了素材页）：不再接着传排队的
      if (!up.disposed) pump()
    }
  }

  function cancel(item) {
    if (item.state === 'wait') { item.state = 'cancel'; item.error = '已取消' }
    else if (item.state === 'up') up.cancel(item.id)
  }

  function cancelAll() {
    for (const it of items) cancel(it)
  }

  function retry(item) {
    if ((item.state !== 'fail' && item.state !== 'cancel') || item.final) return
    item.state = 'wait'
    item.error = ''
    pump()
  }

  /** 清掉已结束的（完成 / 失败 / 取消），进行中的留着 */
  function clearFinished() {
    for (let i = items.length - 1; i >= 0; i--) {
      if (!['wait', 'up'].includes(items[i].state)) items.splice(i, 1)
    }
  }

  return { items, stats, add, cancel, cancelAll, retry, clearFinished }
}
