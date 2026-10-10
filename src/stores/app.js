import { defineStore } from 'pinia'
import { DEFAULT_HOME_TAB } from '@/config/nav'

/**
 * App-wide UI state.
 *
 * `flags` is a small key/value bag for per-item toggles so they survive navigation, e.g.
 *   like:short:<id>   dislike:short:<id>   fav:short:<id>   fav:topic:<id>   fav:post:<id>
 */
export const useAppStore = defineStore('app', {
  state: () => ({
    lastHomeTab: DEFAULT_HOME_TAB,
    /** short videos start muted (autoplay policy); the user unmutes once for the whole feed */
    muted: true,
    playback: { speed: '1.0x', autoNext: true, loop: false },
    flags: {}
  }),
  getters: {
    has: state => key => !!state.flags[key]
  },
  actions: {
    /** flip a flag and return its new value */
    toggle(key) {
      this.flags[key] = !this.flags[key]
      return this.flags[key]
    },
    set(key, value) {
      this.flags[key] = !!value
    }
  }
})
