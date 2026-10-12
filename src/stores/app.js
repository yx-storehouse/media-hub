import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'
import { DEFAULT_HOME_TAB } from '@/config/nav'

/** 记在本机的偏好：想不想要声音、倍速 / 自动连播 / 循环、短视频的「不喜欢」 */
const PREFS_KEY = 'reel:prefs'
const SPEEDS = ['0.5x', '0.75x', '1.0x', '1.25x', '1.5x', '2.0x']
/** 「不喜欢」最多记这么多条（最新的在后） */
const DISLIKE_MAX = 200
const DISLIKE_PREFIX = 'dislike:short:'

/* 读写都可能失败（隐私模式、存储被禁用、内容被改坏）：失败就用默认值，不影响使用 */
function readPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null')
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}
function writePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* 不记也能用 */ }
}

/**
 * App-wide UI state.
 *
 * `flags` is a small key/value bag for per-item toggles so they survive navigation, e.g.
 *   like:short:<id>   dislike:short:<id>   fav:short:<id>   fav:topic:<id>   fav:post:<id>
 * 其中 dislike:short:<数字 id> 会记在本机（未登录时「不喜欢」只存在这里，刷新推荐时带给服务端往后排）。
 *
 * 声音：sound 是用户的选择（点过「恢复声音」就是 true，记在本机）；muted 是此刻实际是否静音。
 * 浏览器不让有声自动播放时 muted 会被临时置回 true，但 sound 不变，用户在页面上点一下就自动恢复。
 */
export const useAppStore = defineStore('app', () => {
  const saved = readPrefs()

  const lastHomeTab = ref(DEFAULT_HOME_TAB)
  const sound = ref(saved.sound === true)
  const muted = ref(!sound.value)
  const playback = reactive({
    speed: SPEEDS.includes(saved.speed) ? saved.speed : '1.0x',
    autoNext: saved.autoNext !== false,
    loop: saved.loop === true
  })
  const flags = reactive({})
  if (Array.isArray(saved.dislikes)) {
    for (const id of saved.dislikes.slice(-DISLIKE_MAX)) if (Number.isSafeInteger(id)) flags[DISLIKE_PREFIX + id] = true
  }

  /** 本机记下的「不喜欢」视频 id（数字 id，最新的在后） */
  function dislikedIds() {
    const out = []
    for (const [k, v] of Object.entries(flags)) {
      if (!v || !k.startsWith(DISLIKE_PREFIX)) continue
      const id = Number(k.slice(DISLIKE_PREFIX.length))
      if (Number.isSafeInteger(id)) out.push(id)
    }
    return out.slice(-DISLIKE_MAX)
  }

  watch(
    () => [sound.value, playback.speed, playback.autoNext, playback.loop, dislikedIds().join(',')],
    () => writePrefs({ sound: sound.value, speed: playback.speed, autoNext: playback.autoNext, loop: playback.loop, dislikes: dislikedIds() })
  )

  const has = key => !!flags[key]
  /** flip a flag and return its new value */
  function toggle(key) {
    return set(key, !flags[key])
  }
  /** 设成 true 时挪到最后（「不喜欢」按先后裁掉最早的） */
  function set(key, value) {
    delete flags[key]
    if (value) flags[key] = true
    return !!value
  }

  return { lastHomeTab, sound, muted, playback, flags, has, toggle, set, dislikedIds }
})
