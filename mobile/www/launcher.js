/*
 * Reel App 启动页。
 *
 *   1. 服务器地址：本机保存的（localStorage）> 打包时的默认地址（config.js 的 defaultServer）> 都没有就让用户填
 *   2. GET <服务器>/api/health，4 秒超时，回 { code: 0, data: { ok: true } } 才算连上
 *   3. 连上：登记给原生外壳（只有这个服务器的页面留在 App 里，别的网站用系统浏览器打开），
 *      再 location.replace(<服务器>/)，返回键不会退回启动页
 *   4. 连不上：显示「连不上服务器」、地址输入框、连接 / 重试；联网或回到前台时自动重试
 *
 *   ?settings  打开「切换服务器」（网页版「我的 → 切换服务器」跳到这里），长按图标也能打开
 *   ?error     原生在服务器页面整页加载失败时跳回这里（capacitor.config.js 的 server.errorPath）
 *
 * 只用老 WebView（安卓 7 + Chrome 6x）也支持的语法，不用 ?. 和 ??。
 */
(function () {
  'use strict'

  var STORE_KEY = 'reel:server'
  var TIMEOUT_MS = 4000
  var cfg = window.REEL_CONFIG || {}

  var $ = function (id) { return document.getElementById(id) }
  var ui = {
    splash: $('splash'), mark: $('mark'), status: $('status'), change: $('change'),
    panel: $('panel'), title: $('title'), detail: $('detail'), form: $('form'), addr: $('addr'),
    error: $('error'), connect: $('connect'), retry: $('retry'), back: $('back'), ver: $('ver')
  }

  var params = new URLSearchParams(location.search)
  var current = ''       // 正在用 / 刚才试过的服务器
  var state = 'idle'     // connecting | failed | settings | navigating
  var seq = 0            // 每次连接递增，过期的结果直接丢掉
  var changeTimer = 0

  /* ---------------- 地址 ---------------- */

  /**
   * 规范化用户填的地址：没写协议的补 http://；只接受 http / https；去掉末尾的 /、查询和 #。
   * 返回 { url } 或 { error }。
   */
  function normalize(raw) {
    var s = String(raw == null ? '' : raw).trim()
    if (!s) return { error: '请填写服务器地址' }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d+(\/|$)/.test(s)) return { error: '只支持 http:// 或 https:// 开头的地址' }
      s = 'http://' + s
    }
    var u
    try { u = new URL(s) } catch (e) { return { error: '地址格式不对，例如 http://192.168.1.10:27381' } }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: '只支持 http:// 或 https:// 开头的地址' }
    if (!u.hostname) return { error: '地址里缺少服务器名' }
    if (u.username || u.password) return { error: '地址里不能带用户名和密码' }
    // 主机名只能是字母、数字、点、横线（中文域名已被转成 xn--），或者 [IPv6]
    if (!/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(u.hostname)) return { error: '地址格式不对，例如 http://192.168.1.10:27381' }
    return { url: u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '') }
  }

  function loadSaved() {
    try { return localStorage.getItem(STORE_KEY) || '' } catch (e) { return '' }
  }
  function save(url) {
    try { localStorage.setItem(STORE_KEY, url) } catch (e) { /* 存不了就下次再填 */ }
  }
  /** 保存的、打包时默认的，规范化后第一个可用的 */
  function initialServer() {
    var list = [loadSaved(), cfg.defaultServer]
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue
      var n = normalize(list[i])
      if (n.url) return n.url
    }
    return ''
  }
  var shown = function (url) { return url.replace(/^https?:\/\//, '') }

  /* ---------------- 连接 ---------------- */

  /** GET /api/health；连上时返回最终地址（服务器把 http 跳到 https 时用跳转后的） */
  function checkHealth(server) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null
    var timedOut = false
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        timedOut = true
        if (ctrl) ctrl.abort()
        resolve({ ok: false, reason: '连接超时（' + TIMEOUT_MS / 1000 + ' 秒没有响应）' })
      }, TIMEOUT_MS)
      fetch(server + '/api/health', { cache: 'no-store', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          if (!r.ok) return { ok: false, reason: '服务器返回 ' + r.status + '，可能不是 Reel 服务器' }
          return r.json().then(function (j) {
            // Reel 接口统一回 { code: 0, data: { ok: true, ts } }
            if (!j || j.code !== 0 || !j.data || j.data.ok !== true) return { ok: false, reason: '这个地址不是 Reel 服务器' }
            var base = server
            if (r.url && /\/api\/health$/.test(r.url)) {
              var n = normalize(r.url.replace(/\/api\/health$/, ''))
              if (n.url) base = n.url
            }
            return { ok: true, base: base }
          }, function () { return { ok: false, reason: '这个地址不是 Reel 服务器' } })
        }, function () {
          return { ok: false, reason: navigator.onLine === false ? '手机没有联网，联网后会自动重试' : '连不上这个地址，请确认手机和服务器在同一个网络' }
        })
        .then(function (res) {
          clearTimeout(timer)
          if (!timedOut) resolve(res)
        })
    })
  }

  /** 告诉原生外壳现在用哪个服务器（安卓 / iOS 的 ReelShell 插件）；不在 App 里（桌面浏览器调试）就跳过 */
  function registerNative(server) {
    var cap = window.Capacitor
    if (!cap || typeof cap.nativePromise !== 'function' || (cap.isNativePlatform && !cap.isNativePlatform())) return Promise.resolve()
    return new Promise(function (resolve) {
      var done = function () { clearTimeout(t); resolve() }
      var t = setTimeout(done, 1500)
      try {
        cap.nativePromise('ReelShell', 'setServer', { url: server }).then(done, function (e) {
          console.warn('ReelShell.setServer 失败', e)
          done()
        })
      } catch (e) {
        done()
      }
    })
  }

  function connect(server) {
    var my = ++seq
    current = server
    state = 'connecting'
    showSplash('正在连接 ' + shown(server), true)
    return checkHealth(server).then(function (r) {
      if (my !== seq) return
      if (!r.ok) return showFailed(r.reason)
      open(r.base)
    })
  }

  function open(base) {
    state = 'navigating'
    current = base
    save(base)
    showSplash('正在打开 ' + shown(base), true)
    registerNative(base).then(function () {
      if (state === 'navigating') location.replace(base + '/')
    })
  }

  /* ---------------- 界面 ---------------- */

  function showSplash(text, busy) {
    ui.panel.hidden = true
    ui.splash.hidden = false
    ui.status.textContent = text || ''
    ui.status.className = busy ? 'status busy' : 'status'
    // 连得慢时才露出「更改服务器」，连得快就不闪一下
    clearTimeout(changeTimer)
    ui.change.hidden = true
    if (busy) changeTimer = setTimeout(function () { if (state === 'connecting') ui.change.hidden = false }, 1200)
  }

  /**
   * mode：first 第一次用 / failed 连不上 / settings 切换服务器 / pageError 服务器连得上但页面没打开
   */
  function showPanel(mode, detail) {
    clearTimeout(changeTimer)
    ui.splash.hidden = true
    ui.panel.hidden = false
    ui.title.textContent = { first: '连接服务器', failed: '连不上服务器', settings: '切换服务器', pageError: '页面没有打开' }[mode]
    ui.detail.textContent = detail || ''
    ui.error.textContent = ''
    ui.addr.value = current || initialServer()
    ui.retry.hidden = !(current && (mode === 'failed' || mode === 'pageError'))
    // 从网页版「切换服务器」进来的才有「返回」（启动时历史里只有这一页），试了新地址连不上时也能返回
    ui.back.hidden = !(params.has('settings') && history.length > 1 && mode !== 'first')
    if (mode === 'first') setTimeout(function () { ui.addr.focus() }, 50)
  }

  function showFailed(reason) {
    state = 'failed'
    showPanel('failed', reason + '\n' + shown(current) + (needsLocalNetworkHint(current) ? '\n' + LOCAL_NETWORK_HINT : ''))
  }

  /*
   * iPhone 第一次连内网地址时系统会问「是否允许查找并连接到本地网络上的设备」，点了「不允许」就一直连不上。
   * 启动页在 iOS 上的地址是 capacitor://localhost（安卓是 https://localhost），只在 iOS 上提示。
   */
  var LOCAL_NETWORK_HINT = 'iPhone 还要允许 Reel 访问本地网络：设置 → Reel → 打开「本地网络」'
  function needsLocalNetworkHint(server) {
    if (location.protocol !== 'capacitor:' || !server) return false
    var host
    try { host = new URL(server).hostname.toLowerCase() } catch (e) { return false }
    return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host) ||
      /\.local$/.test(host) || host.indexOf('.') < 0 || /^\[(fc|fd|fe80)/.test(host)
  }

  function openSettings() {
    ++seq           // 正在进行的连接作废
    state = 'settings'
    var saved = loadSaved()
    showPanel('settings', saved ? '当前：' + shown(saved) : '还没有连接过服务器')
  }

  ui.form.addEventListener('submit', function (e) {
    e.preventDefault()
    var n = normalize(ui.addr.value)
    if (n.error) {
      ui.error.textContent = n.error
      ui.addr.focus()
      return
    }
    ui.addr.blur()
    connect(n.url)
  })
  ui.retry.addEventListener('click', function () { if (current) connect(current) })
  ui.back.addEventListener('click', function () { history.back() })
  ui.change.addEventListener('click', openSettings)
  ui.addr.addEventListener('input', function () { ui.error.textContent = '' })

  // 长按图标打开地址设置（连不上又一直在转圈时也能改）
  var pressTimer = 0
  var cancelPress = function () { clearTimeout(pressTimer) }
  ui.mark.addEventListener('pointerdown', function () {
    cancelPress()
    pressTimer = setTimeout(openSettings, 700)
  })
  ui.mark.addEventListener('pointerup', cancelPress)
  ui.mark.addEventListener('pointerleave', cancelPress)
  ui.mark.addEventListener('pointercancel', cancelPress)
  ui.mark.addEventListener('contextmenu', function (e) { e.preventDefault() })

  // 断网时连不上：联网了、或者用户去系统设置连好 Wi-Fi 回来，自动再试一次
  var autoRetry = function () { if (state === 'failed' && current) connect(current) }
  window.addEventListener('online', autoRetry)
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') autoRetry() })
  // iOS 外壳（ReelViewController.swift）在 App 回到前台、系统弹窗（比如「本地网络」权限）关掉后发这个事件：
  // 系统弹窗不会触发 visibilitychange，用户点了「允许」后要靠它重试
  window.addEventListener('reel:resume', autoRetry)
  // 从后退缓存里恢复（比如切换服务器后又按了返回）时重新开始
  window.addEventListener('pageshow', function (e) { if (e.persisted && state === 'navigating') start() })

  if (cfg.version) ui.ver.textContent = 'Reel App ' + cfg.version

  /* ---------------- 启动 ---------------- */

  function start() {
    var server = initialServer()
    current = server
    if (params.has('settings')) return openSettings()
    if (!server) {
      state = 'settings'
      return showPanel('first', '填写 Reel 服务器的地址，以后打开 App 会自动连接。')
    }
    if (params.has('error')) {
      // 原生报告服务器页面整页加载失败：先看看服务器还在不在
      state = 'connecting'
      showSplash('正在检查 ' + shown(server), true)
      return checkHealth(server).then(function (r) {
        if (!r.ok) return showFailed(r.reason)
        state = 'failed'
        showPanel('pageError', '服务器能连上，但页面加载失败了，可以再试一次。\n' + shown(server))
      })
    }
    connect(server)
  }

  start()
})()
