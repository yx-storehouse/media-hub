/*
 * 网页版是不是在 Reel App（mobile/ 里的 iOS / 安卓外壳）里打开的。
 *
 * 外壳给 WebView 的 User-Agent 末尾加了「ReelApp/<版本>」（mobile/capacitor.config.js 的 appendUserAgent），
 * 服务器上的网页拿不到原生桥接，只靠这个判断。普通浏览器里这些值都是 false / 空。
 */
const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || ''
const m = ua.match(/\bReelApp\/([\w.+-]+)/)

/** 在 Reel App 里 */
export const inApp = !!m
/** App 版本号，如 1.0.0（不在 App 里为空） */
export const appVersion = m ? m[1] : ''
export const isAndroid = /\bAndroid\b/i.test(ua)

/**
 * App 启动页的地址（打包在 App 里的那一页）。「切换服务器」跳到 <它>?settings。
 * 安卓是 https://localhost/，iOS 是 capacitor://localhost/（Capacitor 的默认值，见 mobile/capacitor.config.js）
 */
export const launcherUrl = inApp ? (isAndroid ? 'https://localhost/' : 'capacitor://localhost/') : ''

/** 回到 App 的启动页改服务器地址（只在 App 里有用） */
export function openServerSettings() {
  if (launcherUrl) location.href = launcherUrl + '?settings'
}

/**
 * 服务器上的安卓安装包：管理后台「素材文件」里建 app 文件夹，上传 reel.apk（新版本覆盖同名文件）。
 * 「我的」页在安卓浏览器里（不在 App 里）且这个文件存在时显示「下载安卓 App」。
 */
export const APK_URL = '/media/app/reel.apk'

let apkCheck = null
/** 服务器上有没有安卓安装包（HEAD 一次，同一次打开只问一次，网络出错下次再问；不是安卓浏览器直接 false） */
export function hasAndroidApk() {
  if (inApp || !isAndroid || typeof fetch !== 'function') return Promise.resolve(false)
  if (!apkCheck) apkCheck = fetch(APK_URL, { method: 'HEAD', cache: 'no-store' }).then(r => r.ok, () => { apkCheck = null; return false })
  return apkCheck
}
