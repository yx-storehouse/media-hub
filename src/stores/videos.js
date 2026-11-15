import { defineStore } from 'pinia'
import { computed, reactive, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

/**
 * 视频的互动状态（赞、不喜欢、收藏和赞 / 收藏数），按视频 id 记最新值：几个页面看同一个视频时以这里为准。
 *
 * 短视频页常驻（KeepAlive）：从「看完整版」进播放页点了赞 / 收藏再返回，短视频这一条要马上显示最新的，
 * 不用等重新请求（以前要等下一轮核对，期间显示旧的赞 / 收藏和数字，想取消要多点一次）。
 *
 *   const videos = useVideoStore()
 *   videos.note(id, { liked, faved, likeCount, favCount })   // 拿到接口数据、点赞 / 收藏成功后记一笔（只记传了的字段）
 *   const s = videos.latest(id)                               // { liked?, disliked?, faved?, likeCount?, favCount?, at } 或 null
 *   if (s && s.at > clip.syncedAt) { …用 s 里的值更新这一条… }   // at 是 Date.now()，和自己上次核对的时间比
 *   videos.version                                            // 任何一条变了就 +1（watch 它就知道该对一遍）
 *
 * 播放页：拿到视频详情、点赞 / 不喜欢 / 收藏的接口返回后 note；短视频：onActivated（和 note 之后）按 latest 更新屏幕附近的几条，
 * 自己点赞 / 收藏成功后也 note（播放页再打开这个视频时接口本来就是最新的，不需要读这里）。
 * 换了账号（登录、退出、别的标签页换人）全部清掉：赞 / 收藏是上一个人的。
 */
const FIELDS = ['liked', 'disliked', 'faved', 'likeCount', 'favCount']

export const useVideoStore = defineStore('videos', () => {
  /** id -> { liked?, disliked?, faved?, likeCount?, favCount?, at } */
  const states = reactive({})
  const meta = reactive({ version: 0 })

  function note(id, fields = {}) {
    if (id == null) return
    const key = String(id)
    const next = { ...states[key] }
    let changed = false
    for (const f of FIELDS) {
      const v = fields[f]
      if (v === undefined) continue
      if (f === 'likeCount' || f === 'favCount') {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue
      } else if (typeof v !== 'boolean') continue
      next[f] = v
      changed = true
    }
    if (!changed) return
    next.at = Date.now()
    states[key] = next
    meta.version++
  }

  const latest = id => (id == null ? null : states[String(id)] || null)

  function clear() {
    for (const k of Object.keys(states)) delete states[k]
    meta.version++
  }

  // 换账号：启动时的首次校验（ready 之前）不算
  const auth = useAuthStore()
  watch(() => (auth.ready ? auth.user?.id ?? 0 : null), (now, before) => {
    if (before !== null && now !== before) clear()
  }, { flush: 'sync' })

  const version = computed(() => meta.version)

  return { states, version, note, latest, clear }
})
