import { reactive } from 'vue'

/** Global toast state, rendered once by <AppToast /> in App.vue. */
export const toastState = reactive({ text: '', visible: false })

let timer = 0

/** Show a short message at the bottom of the screen. */
export function toast(text, duration = 1600) {
  toastState.text = text
  toastState.visible = true
  clearTimeout(timer)
  timer = setTimeout(() => { toastState.visible = false }, duration)
}
