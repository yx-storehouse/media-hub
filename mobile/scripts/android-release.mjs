#!/usr/bin/env node
/*
 * 打包签名好的安卓安装包（npm run android:release）：
 *   1. 生成启动页配置（默认服务器取 REEL_SERVER 环境变量或 mobile/.env.local，见 build-www.mjs）
 *   2. cap sync android（把启动页、配置拷进安卓工程）
 *   3. gradlew assembleRelease（签名配置见 android/app/build.gradle：REEL_KEYSTORE_PROPERTIES /
 *      android/keystore.properties / ~/.reel-keys/keystore.properties）
 *   4. 检查签名，复制一份 reel-<版本>.apk 到同一个目录
 *
 * 需要：JDK 21（JAVA_HOME）、Android SDK（ANDROID_HOME 或 android/local.properties 的 sdk.dir）。
 * 版本号在 mobile/package.json："version"（给人看的）和 "versionCode"（每次发包 +1）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, copyFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const androidDir = join(root, 'android')
const outDir = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const win = process.platform === 'win32'

function run(cmd, args, opts = {}) {
  console.log(`\n→ ${cmd} ${args.join(' ')}`)
  // Windows 的 .bat 要经过 cmd：拼成一整条命令（参数都是这里写死的，已加引号）
  const viaShell = win && /\.(bat|cmd)"?$/i.test(cmd)
  const r = viaShell
    ? spawnSync([cmd, ...args].join(' '), { stdio: 'inherit', cwd: root, shell: true, ...opts })
    : spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
  if (r.status !== 0) {
    console.error(`\n✗ 失败：${cmd} ${args.join(' ')}（退出码 ${r.status}）`)
    process.exit(1)
  }
}

function fail(msg) {
  console.error('\n✗ ' + msg)
  process.exit(1)
}

/* ---- 环境检查 ---- */
if (!process.env.JAVA_HOME || !existsSync(join(process.env.JAVA_HOME, 'bin', win ? 'java.exe' : 'java'))) {
  fail('没找到 JDK：请安装 JDK 21 并设置 JAVA_HOME')
}
const localProps = join(androidDir, 'local.properties')
const sdkFromProps = existsSync(localProps) && (readFileSync(localProps, 'utf8').match(/^sdk\.dir=(.*)$/m) || [])[1]
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (sdkFromProps && sdkFromProps.replace(/\\:/g, ':').replace(/\\\\/g, '\\'))
if (!sdk || !existsSync(sdk)) fail('没找到 Android SDK：请设置 ANDROID_HOME，或在 android/local.properties 里写 sdk.dir=')

/* ---- 1、2：启动页 + 同步 ---- */
run(process.execPath, [join(root, 'scripts', 'build-www.mjs')])
run(process.execPath, [join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android'])

/* ---- 3：打包（先删掉上次的包，免得签名失败时拿旧包当新包） ---- */
for (const f of ['app-release.apk', 'app-release-unsigned.apk']) rmSync(join(outDir, f), { force: true })
// 绝对路径：Windows 上 cmd 不一定会在当前目录里找 .bat
const gradlew = join(androidDir, win ? 'gradlew.bat' : 'gradlew')
// --no-daemon：Windows 上常驻的 Gradle 进程会占着上次的 classes.dex，改了原生代码再打包时报「另一个程序正在使用此文件」
// 非 Windows 用 sh 调：仓库里的 gradlew 不一定带可执行权限
if (win) run(`"${gradlew}"`, ['assembleRelease', '--no-daemon', '--console=plain'], { cwd: androidDir })
else run('sh', [gradlew, 'assembleRelease', '--no-daemon', '--console=plain'], { cwd: androidDir })

/* ---- 4：检查签名 ---- */
const apk = join(outDir, 'app-release.apk')
if (!existsSync(apk)) {
  if (existsSync(join(outDir, 'app-release-unsigned.apk'))) {
    fail('打出来的包没有签名：没找到签名配置（keystore.properties），见 mobile/README.md「签名」')
  }
  fail('没找到 ' + apk)
}
const buildTools = join(sdk, 'build-tools')
const latest = existsSync(buildTools) && readdirSync(buildTools).filter(d => existsSync(join(buildTools, d, win ? 'apksigner.bat' : 'apksigner'))).sort().pop()
if (latest) {
  const apksigner = join(buildTools, latest, win ? 'apksigner.bat' : 'apksigner')
  run(win ? `"${apksigner}"` : apksigner, ['verify', '--print-certs', win ? `"${apk}"` : apk])
} else {
  console.warn('（没找到 apksigner，跳过签名检查）')
}
const named = join(outDir, `reel-${pkg.version}.apk`)
copyFileSync(apk, named)
console.log(`\n✓ 安卓安装包：${named}（${(statSync(named).size / 1048576).toFixed(1)} MB，版本 ${pkg.version} / ${pkg.versionCode}）`)
console.log('  放到服务器上：把它改名成 reel.apk → 管理后台「素材文件」→ app 文件夹（没有就新建）→ 先删掉旧的 reel.apk 再上传')
console.log('  （后台上传不会覆盖同名文件，会存成「reel (1).apk」）。安卓浏览器里「我的」就会出现「下载安卓 App」')
