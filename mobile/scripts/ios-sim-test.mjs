#!/usr/bin/env node
/*
 * iOS 外壳的模拟器冒烟测试（GitHub Actions 的 macOS 机器上跑，见 .github/workflows/mobile-ios.yml）。
 *
 *   node scripts/ios-sim-test.mjs <模拟器版 App.app> <输出目录>
 *
 * 不碰真正的 Reel 服务器：本机起一个假的「服务器」（127.0.0.1），有 /api/health 和几个测试页面，
 * 测试页面每 0.4 秒问一次「下一步做什么」（/cmd），把看到的情况报回来（/report）。
 * 测试用的那份 App 里给启动页加了一个探针（test-probe.js，正式包里没有），把启动页显示的标题等报回来。依次检查：
 *
 *   0. 没有默认服务器时第一次打开：启动页显示「连接服务器」（截图里键盘应该弹出来）
 *   1. 默认服务器换成假服务器，覆盖安装后冷启动：启动页 → GET /api/health → 整页跳到服务器，页面留在 App 里（UA 带 ReelApp/版本）、
 *      安全区 env(safe-area-inset-top) 有值（ios.contentInset = never 生效）
 *   2. 服务器网页调不动原生插件（ReelShell.setServer 没有回应）
 *   3. 同一服务器的整页跳转留在 App 里
 *   4. 别的网站（http://localhost:端口，主机名不同）交给 Safari，App 里的页面不动
 *   5. 网页跳回 capacitor://localhost/（「切换服务器」的路子）：启动页自动重连，回到服务器
 *   6. capacitor://localhost/?settings 显示地址设置（截图）；杀掉 App 冷启动，自动连上保存的服务器
 *   7. 页面整页加载失败（同一主机、关着的端口）：回到启动页「页面没有打开」（截图）
 *   8. 切到别的 App 再回来：启动页自动重试，回到服务器
 *
 * 每一步截图、App 的日志、请求记录都放在输出目录里（工作流把它上传成附件）。有一项不通过就以非 0 退出。
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [appArg, outArg] = process.argv.slice(2)
if (appArg === '--boot') {
  // 只启动模拟器（工作流在编译之前放到后台跑，冷启动模拟器要好几分钟）
  const d = pickDevice()
  console.log('启动模拟器', d.name, d.runtime, d.udid)
  simctl(['bootstatus', d.udid, '-b'], { timeout: 900000 })
  console.log('模拟器已启动')
  process.exit(0)
}
if (!appArg || !outArg) {
  console.error('用法：node scripts/ios-sim-test.mjs <App.app> <输出目录>')
  process.exit(2)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const OUT = resolve(outArg)
const PORT = 27399
const CLOSED_PORT = 27398
const SERVER = `http://127.0.0.1:${PORT}`
const BUNDLE = 'com.yxstorehouse.reel'
const UA_TOKEN = `ReelApp/${pkg.version}`

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's'
const log = (...a) => console.log(stamp(), ...a)

/* ---------------- 假服务器 ---------------- */

const events = []          // 页面报回来的事件 + 每个请求
const commands = []        // 等着页面来取的指令
let lastPoll = null        // 最近一次 /cmd 轮询 { page, at }

function record(e) {
  e.at = Date.now()
  events.push(e)
  appendFileSync(join(OUT, 'server.log'), JSON.stringify(e) + '\n')
}

function page(path) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Reel 冒烟测试</title>
<style>
  html,body{margin:0;height:100%;background:#0a0a0a;color:#fff;font:16px/1.5 -apple-system,sans-serif}
  .top{position:fixed;left:0;right:0;top:0;height:env(safe-area-inset-top);background:#c33}
  .bar{position:fixed;left:0;right:0;top:env(safe-area-inset-top);padding:12px 16px;background:#246;font-weight:700}
  .bottom{position:fixed;left:0;right:0;bottom:0;height:env(safe-area-inset-bottom);background:#c33}
  .foot{position:fixed;left:0;right:0;bottom:env(safe-area-inset-bottom);padding:12px 16px;background:#246}
  main{padding:calc(env(safe-area-inset-top) + 72px) 16px 120px;word-break:break-all;font-size:13px;color:#aaa}
  #p{position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
</style></head>
<body>
<div class="top"></div><div class="bar">Reel 冒烟测试 · ${path}</div>
<main><p id="ua"></p><p id="st"></p></main>
<div class="foot">红色 = 安全区（应该正好盖住状态栏 / 底部横条）</div><div class="bottom"></div>
<div id="p"></div>
<script>
(function () {
  var id = Math.random().toString(36).slice(2)
  function send(ev, data) {
    var q = new URLSearchParams(Object.assign({ ev: ev, page: location.pathname, id: id }, data || {}))
    return fetch('/report?' + q, { cache: 'no-store' }).catch(function () {})
  }
  var cs = getComputedStyle(document.getElementById('p'))
  document.getElementById('ua').textContent = navigator.userAgent
  setTimeout(function () { send('safe', { top: cs.paddingTop, bottom: cs.paddingBottom, w: innerWidth, h: innerHeight }) }, 1500)
  send('load', { ua: navigator.userAgent, cap: typeof window.Capacitor,
    fs: String(document.fullscreenEnabled) + '/' + String(document.webkitFullscreenEnabled) + '/' + typeof document.documentElement.requestFullscreen })
  function run(c) {
    if (!c || !c.do) return
    document.getElementById('st').textContent = '指令：' + JSON.stringify(c)
    if (c.do === 'guard') {
      var cap = window.Capacitor
      if (!cap || typeof cap.nativePromise !== 'function') return send('guard', { result: 'no-bridge' })
      var done = false
      setTimeout(function () { if (!done) { done = true; send('guard', { result: 'blocked' }) } }, 2500)
      try {
        cap.nativePromise('ReelShell', 'setServer', { url: 'http://evil.example' }).then(
          function () { if (!done) { done = true; send('guard', { result: 'resolved' }) } },
          function (e) { if (!done) { done = true; send('guard', { result: 'rejected: ' + (e && e.message) }) } })
      } catch (e) { done = true; send('guard', { result: 'threw: ' + e.message }) }
    } else if (c.do === 'go') {
      send('going', { to: c.url }).then(function () { location.href = c.url })
    }
  }
  function poll() {
    fetch('/cmd?page=' + encodeURIComponent(location.pathname), { cache: 'no-store' })
      .then(function (r) { return r.json() }).then(run, function () {})
      .then(function () { setTimeout(poll, 400) })
  }
  poll()
})()
</script></body></html>`
}

const server = createServer((req, res) => {
  const url = new URL(req.url, SERVER)
  const ua = req.headers['user-agent'] || ''
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  if (url.pathname === '/cmd') {
    lastPoll = { page: url.searchParams.get('page'), at: Date.now() }
    const c = commands.shift() || {}
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify(c))
  }
  record({ type: 'req', host: req.headers.host, path: url.pathname + url.search, ua })
  if (url.pathname === '/api/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ code: 0, data: { ok: true, ts: Date.now() } }))
  }
  if (url.pathname === '/report') {
    const e = Object.fromEntries(url.searchParams)
    record({ type: 'event', ...e })
    log('页面报告', e.ev, e.page, e.result || e.to || '')
    res.writeHead(204, cors)
    return res.end()
  }
  if (url.pathname === '/external') {
    // Safari 打开的「别的网站」：不带测试脚本，免得它也来领指令
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' })
    return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><h1>外部网站（应该在 Safari 里）</h1>')
  }
  if (url.pathname === '/' || url.pathname === '/page2.html') {
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' })
    return res.end(page(url.pathname))
  }
  res.writeHead(404, cors)
  res.end('not found')
})
await new Promise((ok, fail) => server.listen(PORT, '127.0.0.1', ok).on('error', fail))
log('假服务器', SERVER)

/* ---------------- 模拟器 ---------------- */

function simctl(args, { timeout = 120000, allowFail = false } = {}) {
  const r = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout })
  if (r.status !== 0 && !allowFail) {
    throw new Error(`xcrun simctl ${args.join(' ')} 失败：${r.stderr || r.stdout || r.error}`)
  }
  return r.stdout || ''
}

function pickDevice() {
  const { devices } = JSON.parse(simctl(['list', 'devices', 'available', '--json']))
  const runtimes = Object.keys(devices).filter(k => /SimRuntime\.iOS-/.test(k) && devices[k].length)
  const ver = k => k.replace(/.*iOS-/, '').split('-').map(Number)
  runtimes.sort((a, b) => { const x = ver(a), y = ver(b); return (y[0] - x[0]) || ((y[1] || 0) - (x[1] || 0)) })
  for (const rt of runtimes) {
    // 带刘海 / 灵动岛的 iPhone（不要 SE），这样能看出安全区
    const d = devices[rt].find(d => /^iPhone \d+( Pro)?$/.test(d.name)) || devices[rt].find(d => /^iPhone/.test(d.name) && !/SE/.test(d.name))
    if (d) return { ...d, runtime: rt }
  }
  throw new Error('没有可用的 iPhone 模拟器')
}

let shot = 0
function screenshot(name) {
  const file = join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`)
  simctl(['io', udid, 'screenshot', file], { allowFail: true })
  log('截图', file.replace(OUT + '/', ''))
}

let launchNo = 0
function launch() {
  const n = ++launchNo
  simctl(['launch', `--stdout=${join(OUT, `app-${n}.out.log`)}`, `--stderr=${join(OUT, `app-${n}.err.log`)}`, udid, BUNDLE])
  log('启动 App', `（第 ${n} 次）`)
}

/* ---------------- 检查 ---------------- */

const results = []
function check(ok, name, detail = '') {
  results.push({ ok, name, detail })
  log(ok ? '✓' : '✗', name, detail)
  return ok
}
function soft(ok, name, detail = '') {
  results.push({ ok: true, soft: !ok, name, detail })
  log(ok ? '✓' : '!', name, detail)
}

/** 等到 since 之后出现满足条件的记录 */
async function waitFor(pred, { since = 0, timeout = 60000 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const e = events.find(e => e.at >= since && pred(e))
    if (e) return e
    await sleep(250)
  }
  return null
}
const isLoad = path => e => e.type === 'event' && e.ev === 'load' && e.page === path
const inApp = ua => ua.includes(UA_TOKEN)

/** 等页面开始轮询（App 回到前台后） */
async function waitPoll(page, since, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (lastPoll && lastPoll.at >= since && lastPoll.page === page) return true
    await sleep(250)
  }
  return false
}

async function command(c) {
  commands.length = 0
  commands.push(c)
}

/* ---------------- 准备 App ---------------- */

/** 复制一份 App，默认服务器换成 defaultServer，启动页加上探针（模拟器版没签名，直接改包里的文件） */
function prepareApp(name, defaultServer) {
  const dir = join(OUT, 'build', name, 'App.app')
  cpSync(resolve(appArg), dir, { recursive: true })
  writeFileSync(join(dir, 'public', 'config.js'),
    `window.REEL_CONFIG = ${JSON.stringify({ defaultServer, version: pkg.version })}\n`)
  writeFileSync(join(dir, 'public', 'test-probe.js'), PROBE)
  const index = join(dir, 'public', 'index.html')
  const html = readFileSync(index, 'utf8')
  if (!html.includes('</body>')) throw new Error('启动页 index.html 里没有 </body>')
  writeFileSync(index, html.replace('</body>', '<script src="test-probe.js"></script>\n</body>'))
  return dir
}

// 启动页探针（只在测试用的这份 App 里有）：把启动页显示的内容报给假服务器
const PROBE = `(function () {
  function report(ev) {
    var $ = function (id) { return document.getElementById(id) }
    var q = new URLSearchParams({ ev: ev, page: 'launcher' + location.search, title: $('title').textContent,
      panel: String(!$('panel').hidden), splash: String(!$('splash').hidden), status: $('status').textContent,
      detail: $('detail').textContent, back: String(!$('back').hidden), hist: String(history.length) })
    fetch('${SERVER}/report?' + q, { cache: 'no-store' }).catch(function () {})
  }
  report('launcher-0s')
  setTimeout(function () { report('launcher-1s') }, 1000)
  setTimeout(function () { report('launcher-3s') }, 3000)
})()
`
const firstRunApp = prepareApp('first-run', '')   // 和没设 REEL_SERVER 打的正式包一样
const app = prepareApp('test', SERVER)

const device = pickDevice()
const udid = device.udid
log('模拟器', device.name, device.runtime.replace(/.*SimRuntime\./, ''), udid)
simctl(['bootstatus', udid, '-b'], { timeout: 600000 })

// App 的标准输出不缓冲，日志能及时写进文件
process.env.SIMCTL_CHILD_NSUnbufferedIO = 'YES'

let failed = false
try {
  // 0. 没有默认服务器，第一次打开
  let since = Date.now()
  simctl(['install', udid, firstRunApp])
  launch()
  const first = await waitFor(e => e.type === 'event' && e.ev === 'launcher-1s' && e.page === 'launcher', { since, timeout: 180000 })
  check(!!first && first.panel === 'true' && first.title === '连接服务器', '没有默认服务器时，第一次打开让用户填地址',
    first ? `标题「${first.title}」` : '启动页没有报告')
  await sleep(1500)
  screenshot('first-run')
  simctl(['terminate', udid, BUNDLE], { allowFail: true })

  // 1. 默认服务器是假服务器：冷启动（覆盖安装，和用户升级一样）
  simctl(['install', udid, app])
  since = Date.now()
  launch()
  const health = await waitFor(e => e.type === 'req' && e.path.startsWith('/api/health'), { since, timeout: 120000 })
  check(!!health, '启动页请求 /api/health', health ? health.ua : '超时')
  const home = await waitFor(isLoad('/'), { since, timeout: 60000 })
  if (!check(!!home, '启动页连上后跳到服务器首页')) throw new Error('没打开服务器首页')
  check(inApp(home.ua) && !/ Safari\//.test(home.ua), '服务器页面在 App 里打开（UA 带 ' + UA_TOKEN + '）', home.ua)
  // 跨源跳转后 WebKit 过一会儿才把安全区交给新页面（CSS 的 env() 会自动更新），所以页面 1.5 秒后再量
  const safe = await waitFor(e => e.type === 'event' && e.ev === 'safe' && e.id === home.id, { since, timeout: 15000 })
  check(!!safe && parseFloat(safe.top) > 0 && parseFloat(safe.bottom) > 0, '安全区交给网页（env(safe-area-inset-top / bottom) > 0）',
    safe ? `top ${safe.top}，bottom ${safe.bottom}，视口 ${safe.w}×${safe.h}` : '超时')
  soft(true, '元素全屏 API（fullscreenEnabled / webkitFullscreenEnabled / requestFullscreen）', home.fs)
  await sleep(1500)
  screenshot('home')

  // 2. 服务器网页调不动原生插件
  since = Date.now()
  await command({ do: 'guard' })
  const guard = await waitFor(e => e.type === 'event' && e.ev === 'guard', { since, timeout: 20000 })
  check(guard && (guard.result === 'blocked' || guard.result === 'no-bridge'), '服务器网页调不动原生插件', guard ? guard.result : '超时')

  // 3. 同一服务器的整页跳转留在 App 里
  since = Date.now()
  await command({ do: 'go', url: '/page2.html' })
  const p2 = await waitFor(isLoad('/page2.html'), { since, timeout: 20000 })
  check(p2 && inApp(p2.ua), '同一服务器的整页跳转留在 App 里', p2 ? p2.ua : '超时')
  await sleep(800)
  screenshot('page2')

  // 4. 别的网站交给 Safari
  since = Date.now()
  await command({ do: 'go', url: `http://localhost:${PORT}/external` })
  const ext = await waitFor(e => e.type === 'req' && e.path === '/external', { since, timeout: 30000 })
  check(!ext || !inApp(ext.ua), '别的网站没有在 App 里打开', ext ? ext.ua : '')
  soft(!!ext, '别的网站交给了 Safari', ext ? ext.ua : '30 秒内 Safari 没有请求（模拟器的 Safari 可能停在欢迎页）')
  await sleep(3000)
  screenshot('external-safari')
  since = Date.now()
  launch()
  check(await waitPoll('/page2.html', since), '回到 App 还是原来的页面（/page2.html）')

  // 5. 跳回启动页：自动重连
  since = Date.now()
  await command({ do: 'go', url: 'capacitor://localhost/' })
  const relaunch = await waitFor(isLoad('/'), { since, timeout: 30000 })
  const relaunchHealth = events.find(e => e.at >= since && e.type === 'req' && e.path.startsWith('/api/health'))
  check(!!relaunch && !!relaunchHealth, '网页跳回 capacitor://localhost/，启动页重新连上服务器', relaunch ? '' : '超时')

  // 6. 地址设置页；冷启动自动连上保存的服务器
  since = Date.now()
  await command({ do: 'go', url: 'capacitor://localhost/?settings' })
  const settings = await waitFor(e => e.type === 'event' && e.ev === 'launcher-1s' && e.page === 'launcher?settings', { since, timeout: 20000 })
  check(!!settings && settings.panel === 'true' && settings.title === '切换服务器',
    '网页跳到 capacitor://localhost/?settings：启动页显示「切换服务器」',
    settings ? `标题「${settings.title}」，${settings.detail}，返回按钮 ${settings.back}` : '启动页没有报告（没打开？）')
  soft(!!settings && settings.back === 'true', '「切换服务器」页有「返回」', settings ? `history.length = ${settings.hist}` : '')
  await sleep(1500)
  screenshot('settings')
  simctl(['terminate', udid, BUNDLE], { allowFail: true })
  await sleep(1000)
  since = Date.now()
  launch()
  const cold = await waitFor(isLoad('/'), { since, timeout: 60000 })
  check(!!cold, '杀掉后冷启动，自动连上保存的服务器')
  await sleep(1500)

  // 7. 页面加载失败 → 启动页「页面没有打开」
  since = Date.now()
  await command({ do: 'go', url: `http://127.0.0.1:${CLOSED_PORT}/` })
  const errHealth = await waitFor(e => e.type === 'req' && e.path.startsWith('/api/health'), { since, timeout: 30000 })
  check(!!errHealth, '页面加载失败后回到启动页（启动页重新检查了服务器）')
  const errPage = await waitFor(e => e.type === 'event' && e.ev === 'launcher-3s' && e.page === 'launcher?error', { since, timeout: 30000 })
  check(!!errPage && errPage.panel === 'true' && errPage.title === '页面没有打开', '加载失败的启动页显示「页面没有打开」',
    errPage ? `标题「${errPage.title}」` : '启动页没有报告')
  screenshot('page-error')
  check(!events.some(e => e.at >= since && e.type === 'event' && e.ev === 'load'), '加载失败后停在启动页，没有自己跳走')

  // 8. 切到别的 App 再回来：启动页自动重试
  simctl(['launch', udid, 'com.apple.Preferences'], { allowFail: true })
  await sleep(3000)
  since = Date.now()
  launch()
  const retried = await waitFor(isLoad('/'), { since, timeout: 30000 })
  check(!!retried, '回到 App 后启动页自动重试，回到服务器')
  await sleep(1500)
  screenshot('after-resume')
} catch (e) {
  failed = true
  log('✗ 测试中断：', e.message)
  try { screenshot('failure') } catch {}
} finally {
  server.close()
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ device, results }, null, 2))
  rmSync(join(OUT, 'build'), { recursive: true, force: true })
  simctl(['shutdown', udid], { allowFail: true })
}

const bad = results.filter(r => !r.ok)
const warn = results.filter(r => r.soft)
console.log(`\n冒烟测试：${results.length - bad.length}/${results.length} 通过` + (warn.length ? `，${warn.length} 项提醒` : ''))
for (const r of bad) console.log('  ✗', r.name, r.detail)
for (const r of warn) console.log('  !', r.name, r.detail)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### 模拟器冒烟测试（${device.name}，${device.runtime.replace(/.*SimRuntime\./, '')}）\n\n` +
    results.map(r => `- ${r.ok ? (r.soft ? '⚠️' : '✅') : '❌'} ${r.name}${r.detail ? `：${String(r.detail).replace(/\|/g, '/')}` : ''}`).join('\n') +
    (failed ? '\n- ❌ 测试中断，见日志' : '') + '\n\n截图在本次运行的 Artifacts「ios-simulator-test」里。\n\n')
}
process.exit(bad.length || failed ? 1 : 0)
