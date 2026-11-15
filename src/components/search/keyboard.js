/*
 * 手机上点首页顶部的搜索框进搜索页时，直接弹出键盘（不用再点一次输入框）。
 *
 * iOS（包括 App 里的 WKWebView）只有在用户点按的同一个手势里调 focus() 才会弹键盘；搜索页是懒加载的，
 * 它挂上时早就不在那个手势里了。所以点按的那一刻先聚焦一个看不见的输入框把键盘叫出来，
 * 搜索页挂上后再把焦点交给真正的输入框（焦点从一个输入框换到另一个，键盘不会收起）。安卓上一样用。
 *
 *   holdKeyboard()        // 首页搜索框的点击处理里（同一个手势内）
 *   takeKeyboard(input)   // 搜索页挂上后：有临时输入框在等着就把焦点交给 input，返回 true；没有返回 false
 * 搜索页一直没挂上（跳转失败、加载太慢）：几秒后临时输入框自己撤掉，键盘跟着收起。
 */
let proxy = null
let timer = 0

function release() {
  clearTimeout(timer)
  timer = 0
  const el = proxy
  proxy = null
  if (el) {
    el.blur()
    el.remove()
  }
}

export function holdKeyboard() {
  release()
  if (typeof document === 'undefined') return
  const el = document.createElement('input')
  el.type = 'text'
  el.tabIndex = -1
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('autocomplete', 'off')
  // 16px：iOS 聚焦字号小于 16px 的输入框会放大页面；放在视口左上角、看不见，不会让浏览器为了它滚动页面
  el.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;margin:0;padding:0;border:0;opacity:0;font-size:16px;pointer-events:none;'
  document.body.appendChild(el)
  try {
    el.focus({ preventScroll: true })
  } catch {
    el.focus()
  }
  proxy = el
  timer = setTimeout(release, 4000)
}

export function takeKeyboard(input) {
  if (!proxy) return false
  if (input) {
    try {
      input.focus({ preventScroll: true })
    } catch {
      input.focus()
    }
  }
  release()
  return !!input
}
