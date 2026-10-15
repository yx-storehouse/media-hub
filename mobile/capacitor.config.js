/*
 * Capacitor 配置（外壳模式）。
 *
 * App 里只打包了 www/ 这个很小的启动页：它连上服务器以后整页跳到服务器上的网页版，
 * 所以服务器每次部署 App 都自动是最新的，不用重新安装。
 *
 * 注意：不要把服务器地址写进 server.url / server.allowNavigation：
 *   - server.url 会让 App 一启动就直接打开那个地址，连不上时什么都做不了，也没法在 App 里改地址；
 *   - 写进 allowNavigation 的域名，Capacitor（安卓）会用原生代码代理这个域名的请求并往网页里注入桥接脚本，
 *     视频拖进度（Range 请求）、上传都会受影响。
 * 服务器地址是用户在启动页里填的，「跳过去的页面留在 App 里、别的网站用系统浏览器打开」由原生代码
 * （安卓 ShellPlugin.java，iOS ShellPlugin.swift）按启动页登记的服务器决定。
 */
const pkg = require('./package.json')

/* 只在测试时打开：REEL_WEBVIEW_DEBUG=1 时 release 包也能用 chrome://inspect 调试网页 */
const webviewDebug = process.env.REEL_WEBVIEW_DEBUG === '1'

/** @type {import('@capacitor/cli').CapacitorConfig} */
module.exports = {
  appId: 'com.yxstorehouse.reel',
  appName: 'Reel',
  webDir: 'www',
  backgroundColor: '#0a0a0a',
  // 网页版靠它认出自己在 App 里（显示「切换服务器」、不显示「下载安卓 App」）
  appendUserAgent: `ReelApp/${pkg.version}`,
  loggingBehavior: 'debug',
  server: {
    // 启动页的地址：安卓 https://localhost/，iOS capacitor://localhost/（网页版「切换服务器」按这个跳回来）
    androidScheme: 'https',
    hostname: 'localhost',
    // 内网服务器是 http://，要允许明文 HTTP（安卓另外在 network_security_config.xml 里放开，
    // iOS 在 ios/App/App/Info.plist 的 NSAppTransportSecurity 里放开）
    cleartext: true,
    // 服务器的页面整页加载失败（断网、服务器关了）时回到启动页，显示「连不上服务器」而不是 WebView 的报错页
    // （iOS 上由 ReelViewController.swift 按这个路径跳回启动页：Capacitor 自己在 iOS 上拼不对带 ? 的路径）
    errorPath: 'index.html?error'
  },
  android: {
    // 启动页是 https://localhost，它要用 fetch 检查 http:// 服务器的 /api/health，属于混合内容，必须放开
    allowMixedContent: true,
    webContentsDebuggingEnabled: webviewDebug
  },
  ios: {
    // WebView 铺满整个屏幕（刘海、底部横条下面也画），安全区交给网页的 env(safe-area-inset-*)（网页版和启动页都用了 viewport-fit=cover）
    contentInset: 'never',
    // iPad 也按手机版排版（默认会伪装成桌面 Safari）
    preferredContentMode: 'mobile',
    // 长按链接不弹系统的链接预览（网页版有长按倍速等手势）
    allowsLinkPreview: false,
    webContentsDebuggingEnabled: webviewDebug
  },
  plugins: {
    SystemBars: {
      // native：WebView 140+ 时按 viewport-fit=cover 把安全区交给网页的 env(safe-area-inset-*)；
      // 更老的 WebView 上由原生给网页留出状态栏 / 手势条的位置。不往服务器的网页里注入脚本。
      insetsHandling: 'native',
      initialViewportFitValueHint: 'cover',
      // 深色系统栏：浅色图标
      style: 'DARK'
    }
  }
}
