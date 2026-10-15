# Reel App（iOS / 安卓外壳）

`mobile/` 是 Reel 的手机 App 工程，用 [Capacitor](https://capacitorjs.com/) 8 打包。和仓库里的网页版、接口服务完全分开：自己的 `package.json`、自己的 `node_modules`，部署脚本和 Docker 都不会带上这个文件夹。

## 工作方式：外壳模式

App 里只打包了一个很小的**启动页**（`www/`），网页版本身不在 App 里：

```
打开 App → 启动页（黑底 + 图标）
        → GET <服务器>/api/health（4 秒超时）
        → 连上：整页跳到 <服务器>/，之后就是服务器上的网页版
        → 连不上：显示「连不上服务器」、地址输入框、连接 / 重试
```

- **服务器部署一次，App 就是最新的**：网页、接口的改动不用重新打包、不用重新安装。
- 只有这些改动才要重新打包 App：启动页（`www/`）、`capacitor.config.js`、图标、权限、原生代码（`android/`、`ios/`）、Capacitor 升级、版本号。
- 服务器地址按顺序取：用户在 App 里填过的 → 打包时的默认地址（`REEL_SERVER`，见下面）→ 都没有就让用户填。
- 网页版靠 User-Agent 里的 `ReelApp/<版本>` 认出自己在 App 里（`src/utils/shell.js`）：「我的」页显示「切换服务器」，不显示「下载安卓 App」。

### 换服务器

- App 里：「我的 → 切换服务器」，回到启动页改地址（安卓是 `https://localhost/?settings`，iOS 是 `capacitor://localhost/?settings`）。这一项是网页版的，服务器要先部署这一版代码才有。
- 启动页上：连不上时直接显示地址框；连得慢时下面会出现「更改服务器」；也可以**长按图标**。
- 地址写法：`192.168.1.10:27381`、`http://192.168.1.10:27381`、`https://reel.example.com` 都行（没写协议的按 `http://`），只接受 http / https，末尾的 `/` 会自动去掉。
- 家里 Wi-Fi 用内网地址；在外面要用 HTTPS 域名（NAS 前面加一层带证书的反向代理）。

## 目录

```
mobile/
  package.json              Capacitor 依赖、打包脚本、版本号（version / versionCode）
  capacitor.config.js       Capacitor 配置（UA 标记、明文 HTTP、安全区、加载失败回启动页……）
  .env.local                本机打包用的默认服务器地址 REEL_SERVER=…（自己建，不入库）
  www/                      启动页：index.html、launcher.css、launcher.js（纯 HTML/CSS/JS）
    config.js               打包时生成：默认服务器地址 + 版本号（不入库）
  assets/                   图标 / 启动图源图（scripts/make-icon-sources.mjs 生成）
  scripts/
    build-www.mjs           生成 www/config.js
    android-release.mjs     一条命令打签名好的安卓安装包
    make-icon-sources.mjs   用网页版的吉祥物生成图标源图
    ios-assets.mjs          生成 iOS 图标、启动图
    ios-csr.sh              iOS 证书第 1 步：生成私钥和证书申请文件（CSR）
    ios-p12.sh              iOS 证书第 2 步：证书 + 私钥合成 .p12，打印 GitHub secrets
    ios-ci-signing.sh       GitHub Actions 里导入证书、描述文件（不要在自己电脑上运行）
    ios-sim-test.mjs        GitHub Actions 里的 iOS 模拟器冒烟测试
  android/                  安卓工程（Android Studio 可以直接打开）
    keystore.properties     指向签名配置的一行 file=…（可选，不入库，见「签名」）
  ios/                      iOS 工程（Xcode + Swift Package Manager，在 GitHub Actions 的 macOS 上打包）
    App/App/                原生代码 ReelViewController.swift、ShellPlugin.swift，Info.plist，图标
    release.xcconfig        Release 配置；签名信息在 signing.local.xcconfig（CI 生成，不入库）

.github/workflows/
  mobile-ios.yml            iOS 打包（签名 → .ipa / TestFlight；没配签名时只编译模拟器版 + 冒烟测试）
  mobile-android.yml        安卓的 CI 备份：只编译调试版 APK，正式包在本机打
```

## 打包安卓安装包（APK）

需要：Node 22+、JDK 21（设置 `JAVA_HOME`）、Android SDK（Platform 36 + Build-Tools 36，设置 `ANDROID_HOME`）。

```bash
cd mobile
npm ci
# 第一次：写默认服务器地址（这个文件不入库，仓库是公开的）
echo "REEL_SERVER=http://192.168.1.10:27381" > .env.local
npm run android:release
```

`.env.local` 也可以用记事本新建，内容就一行 `REEL_SERVER=http://服务器地址:27381`（Git Bash、PowerShell 里用上面的 `echo` 都行）。不建这个文件也能打包，只是 App 第一次打开时要用户自己填地址。

脚本依次：生成启动页配置 → `cap sync android` → `gradlew assembleRelease` → 检查签名。产物：

```
mobile/android/app/build/outputs/apk/release/app-release.apk
mobile/android/app/build/outputs/apk/release/reel-<版本>.apk   （同一个文件，名字带版本号）
```

同一份代码、同一把钥匙、同一个默认服务器地址，每次打出来的 APK 都一模一样（sha256 相同），可以用来核对手里的包是不是这份代码打的。

第一次打包 Gradle 会下载它自己和 Android 构建依赖（几百 MB，需要能访问 services.gradle.org、Google Maven、Maven Central），之后一两分钟就好。

### 让大家下载安装

1. 服务器先部署这一版代码（`scripts/deploy.sh`）：旧版服务器不收 `.apk`，网页版里也没有「下载安卓 App」「切换服务器」。
2. 把打出来的 `reel-<版本>.apk` 在电脑上**改名成 `reel.apk`**。
3. 管理后台 →「素材文件」→ 进 `app` 文件夹（第一次先「新建文件夹」建一个 `app`）→ 里面有旧的 `reel.apk` 就**先删掉** → 上传 `reel.apk`。
   后台上传不会覆盖同名文件，会另存成 `reel (1).apk`，所以一定要先删旧的。

之后用安卓手机的浏览器打开网页版，「我的」里会出现「下载安卓 App」（服务器上没有 `app/reel.apk` 时不显示；电脑、iPhone 的浏览器和 App 里也不显示）。

安装时 Chrome 可能提示「这类文件可能会损害设备」，点「仍然下载」；手机会提示「允许安装未知来源应用」，这是正常的（App 没上架应用商店）。

## 签名（重要）

安卓要求**同一个 App 的每个新版本都用同一把钥匙签名**，否则装不上去，只能先卸载旧版（App 里的登录状态、设置会丢）。

- 钥匙：`~/.reel-keys/reel-release.jks`（现在打包的这台电脑上是 `C:\Users\Administrator\.reel-keys\reel-release.jks`）
- 密码等配置：`~/.reel-keys/keystore.properties`（随机生成的密码，只存在这里）
- **把这两个文件一起备份到安全的地方**（U 盘、密码管理器的附件……）。不要放进代码仓库、不要发到群里。

Gradle 按顺序找签名配置（`android/app/build.gradle`）：

1. 环境变量 `REEL_KEYSTORE_PROPERTIES` 指向的文件
2. `mobile/android/keystore.properties`（不入库）：可以直接写四项，也可以只写一行 `file=<真正的 keystore.properties 路径>`
3. `~/.reel-keys/keystore.properties`

`keystore.properties` 的格式：

```properties
storeFile=C:/Users/你/.reel-keys/reel-release.jks
storePassword=……
keyAlias=reel
keyPassword=……
```

`storeFile`（还有上面的 `file=`）可以写相对路径，相对于写它的那个文件所在的文件夹，比如 `storeFile=reel-release.jks`。

换电脑打包：把 `.reel-keys` 文件夹拷到新电脑的用户目录下。`storeFile` 写的是绝对路径、而新电脑的用户名不一样时，把它改成新路径（或者改成 `storeFile=reel-release.jks`）。都找不到时打出来的包没有签名，脚本会报错停下。

## 版本号与更新

版本号只在 `mobile/package.json` 里改：

```json
"version": "1.0.1",     ← 给人看的版本（安卓 versionName / iOS 版本号，也会出现在 UA 和启动页上）
"versionCode": 2,       ← 每发一个新包 +1（安卓 versionCode / iOS build 号），只能变大
```

然后：

- 安卓：`npm run android:release`，再按上面「让大家下载安装」换掉服务器上的 `app/reel.apk`（先删旧的再传）。用户下载安装新包会直接覆盖旧版，登录状态、服务器地址都保留（前提是用同一把签名钥匙）。App 不会自己提醒有新版本，要告诉大家去「我的 → 下载安卓 App」重新装。
- iOS：推到 `main`（改了 `mobile/` 就会自动打包）或手动运行 GitHub Actions 的「iOS App」。
  iOS 的 build 号是 `versionCode.运行序号`（比如 `2.57`），每次打包自动变大，TestFlight 不会因为 build 号重复拒收。

再强调一次：**只改网页版、接口时不需要发新包**，部署服务器就行。

## 安卓上做了哪些处理

| | |
|---|---|
| 明文 HTTP | 内网服务器是 `http://`：`res/xml/network_security_config.xml` 允许明文；启动页本身是 `https://localhost`，用 fetch 检查 `http://` 服务器属于混合内容，`android.allowMixedContent` 放开 |
| 页面留在 App 里 | 原生插件 `ShellPlugin.java`：启动页连上后登记服务器，同一主机的页面留在 App 里，别的网站（帖子里的链接等）用系统浏览器打开。没用 `server.allowNavigation`：地址是用户填的，打包时不知道；而且写进去的域名 Capacitor 会用原生代码代理请求，影响视频拖进度和上传 |
| 换服务器后 | 清掉 WebView 的历史，返回键不会退回旧服务器 / 启动页 |
| 加载失败 | 服务器页面整页加载失败（断网、服务器关了）时回到启动页（`server.errorPath`），显示「连不上服务器」；联网、回到前台时自动重试 |
| 返回键 | 先退出全屏 → 网页后退（网页版的弹层、页面跟着历史关闭 / 返回）→ 退到头了离开 App（退到后台，和系统默认一样） |
| 安全区 | edge-to-edge（安卓 15/16 强制）+ Capacitor 8 的 SystemBars（`insetsHandling: native`）：WebView 140+ 把安全区交给网页的 `env(safe-area-inset-*)`；更老的 WebView 由原生给状态栏 / 手势条留边。系统栏是深色（#0a0a0a）、浅色图标 |
| 全屏 / 横屏 | 跟随系统自动旋转。网页全屏（播放器、短视频）真正铺满屏幕并隐藏系统栏（Capacitor 默认会直接拒绝）；WebView 不支持 `screen.orientation.lock`，竖着点全屏且视频是横的时由原生转成横屏，退出全屏解锁；手机横过来自动全屏、竖回去退出（网页版自己的逻辑） |
| 屏幕常亮 | 视频播放时 WebView 自己会让屏幕常亮，暂停就恢复，不用额外处理 |
| 震动 | `VIBRATE` 权限，网页版的 `navigator.vibrate` 可用 |
| 下载链接 | 交给系统浏览器 |

## 图标和启动图

图案就是网页版左上角的吉祥物（`src/components/AppLogo.vue`）：

```bash
npm run assets   # 生成 assets/*.png，再生成安卓各尺寸图标、启动图（@capacitor/assets）和 iOS 的图标、启动图
```

安卓 12 起启动时是系统的启动画面（深色底 + 自适应图标），更早的版本用 `drawable/splash.png`。

iOS 的图标、启动图由 `scripts/ios-assets.mjs` 生成（`npm run assets` 的最后一步）：图标去掉了透明通道（App Store 不收带透明的图标）；
启动图上吉祥物的大小、位置和启动页第一屏对齐，从系统启动画面切到启动页时图标不跳。

## 调试

```bash
REEL_WEBVIEW_DEBUG=1 npm run android:release   # 这样打的包能用桌面 Chrome 的 chrome://inspect 调试网页
# PowerShell 里：$env:REEL_WEBVIEW_DEBUG='1'; npm run android:release; Remove-Item Env:REEL_WEBVIEW_DEBUG
```

**不要把这样打的包发给别人**，正式包不带这个开关（之后不带开关再打一次，就又是正式包）。也可以 `npx cap open android` 用 Android Studio 打开调试。

`npm audit` 报的漏洞都在打包工具里（`@capacitor/assets` 带的 sharp / tar，`@capacitor/cli` 带的 uuid），只在电脑上打包时用，不会进 App。

## iOS

iOS 工程在 `ios/`（Xcode 工程 + Swift Package Manager）。Windows 上编译不了 iOS，所以在 **GitHub Actions 的 macOS 机器**上打包（`.github/workflows/mobile-ios.yml`）。启动页、`capacitor.config.js` 和安卓共用。

- 配好签名（下面第 1～4 步）：打出 `.ipa` 安装包（Ad Hoc），或者上传到 TestFlight。
- 没配签名：工作流只编译模拟器版本，再在模拟器里跑一遍外壳的冒烟测试（`scripts/ios-sim-test.mjs`），确认工程没坏。**这时没有能装到 iPhone 上的包**，运行结果页会写「没有配置签名 secrets」。

### iOS 上做了哪些处理

| | |
|---|---|
| 明文 HTTP | `Info.plist` 的 App Transport Security 放开了 http：`NSAllowsArbitraryLoadsInWebContent`（WebView 里的网页、接口、图片）、`NSAllowsArbitraryLoadsForMedia`（视频），外加 `NSAllowsArbitraryLoads`（iOS 10 起有前两个时会被忽略，留着表明意图）。服务器是用户填的，打包时不知道域名，没法只给某个域名开例外 |
| 本地网络权限 | iOS 14 起连局域网里的 NAS 要用户同意：第一次连接时系统弹窗（文字在 `NSLocalNetworkUsageDescription`）。点「允许」后启动页自动重试；点了「不允许」就一直连不上，启动页会提示去「设置 → Reel → 本地网络」打开 |
| 页面留在 App 里 | `ShellPlugin.swift`（插件名 `ReelShell`，和安卓同一个约定）：启动页连上后 `setServer({ url })` 登记服务器，同一主机的页面留在 App 里，别的网站用 Safari 打开 |
| 只有启动页能调原生 | iOS 上 Capacitor 会把桥接脚本注入到每个页面（包括服务器的网页）。`ReelViewController.swift` 只放行 `capacitor://localhost` 启动页发来的原生调用，服务器网页（和里面的 iframe）调不动任何插件 |
| 加载失败 | 服务器页面整页加载失败时回到启动页（`index.html?error`），显示「页面没有打开 / 连不上服务器」。不用 Capacitor 自己的 errorPath 处理：它在 iOS 上把 `index.html?error` 拼成 `index.html%3Ferror`，找不到文件又算失败，会死循环；被新跳转打断（-999）这种不算出错 |
| 管理后台（新窗口） | 服务器上 `target=_blank` 的链接（「我的 → 管理后台」）在 App 里弹出 Safari 页面，点「完成」回来。iPhone 没有返回键，在主 WebView 里打开就回不去了。管理后台在这个页面里要单独登录一次 |
| 返回 | 没有返回键，也没开左滑返回（和「添加到主屏幕」的网页一样，靠网页版自己的返回按钮）。左滑返回会退回换服务器之前的旧页面，iOS 又没法清空 WebView 的历史 |
| 安全区 / 状态栏 | `ios.contentInset = never`：WebView 铺满全屏，安全区交给网页的 `env(safe-area-inset-*)`。深色状态栏、浅色字；`UIUserInterfaceStyle = Dark`，键盘、系统菜单也是深色 |
| 全屏 / 横屏 | 支持横竖屏。Capacitor 打开了 WebView 的元素全屏（iOS 15.4+）；系统不让元素全屏时网页版自己退回伪全屏或 `<video>` 自带的全屏。`screen.orientation.lock` 在 iOS 上不支持，横过来看靠转手机（网页版横屏自动全屏的逻辑照常） |
| 屏幕常亮 | 视频播放时系统自己会保持亮屏 |
| 震动 | iOS 的网页不支持 `navigator.vibrate`，App 里也没有震动（网页版调用时什么都不发生） |
| 其他 | 长按链接不弹系统预览；iPad 也按手机版排版；系统自带的界面（视频播放器、复制粘贴菜单）跟着手机语言，手机是中文就显示中文；上传 TestFlight 不用回答加密问题（`ITSAppUsesNonExemptEncryption = false`） |

### Ad Hoc 还是 TestFlight

两条路选一条就行（以后也可以换，换的时候把 `IOS_PROFILE_BASE64` 换成另一种描述文件）：

| | Ad Hoc（安装包） | TestFlight |
|---|---|---|
| 要做的准备 | 登记每台 iPhone 的 UDID | 在 App Store Connect 建 App、生成 API 密钥 |
| 谁能装 | 登记过的设备（每年每类设备最多 100 台） | 内部测试员：App Store Connect 里你团队的成员（最多 100 人），不用审核 |
| 怎么装 | 下载 `.ipa`，用电脑装到手机上（见第 6 步） | iPhone 上的 TestFlight App，自动收到新版本 |
| 有效期 | 到发布证书 / 描述文件过期（最长 1 年），过期后 App 打不开，要重新打包安装 | 每个版本 90 天，到期前上传新版本就行 |
| 加新手机 | 登记 UDID → 重新生成描述文件 → 更新 secret → 重新打包 | 在 App Store Connect 加一个用户 |

外部测试（发公开链接给不在团队里的人）每个版本都要过 Apple 的 Beta 审核；这个 App 只能连你家里的服务器，审核员打不开，大概率不通过，所以这里只写内部测试。

### 第 1 步：Apple 开发者账号和 App ID

1. 加入 Apple Developer Program（每年 99 美元），用开启了双重认证的 Apple ID。
2. 打开 <https://developer.apple.com/account>，在「会员资格详细信息」（Membership details）里记下 **Team ID**（10 位字母数字）。
3. 「Certificates, Identifiers & Profiles」→ **Identifiers** → 「+」→ App IDs → App：
   - Description：`Reel`
   - Bundle ID：选 **Explicit**，填 `com.yxstorehouse.reel`
   - Capabilities 什么都不用勾 → Continue → Register

### 第 2 步：发布证书（Apple Distribution）

在 Windows 上打开 **Git Bash**（装 Git 时自带），进到仓库目录：

```bash
# 2.1 生成私钥和证书申请文件（放在 C:\Users\你\.reel-keys\ios，仓库外面）
bash mobile/scripts/ios-csr.sh 你的Apple账号邮箱
```

2.2 打开 <https://developer.apple.com/account/resources/certificates/add> → 选 **Apple Distribution** → Continue → 上传 `~/.reel-keys/ios/reel-ios-distribution.csr` → 下载得到 `distribution.cer`。

```bash
# 2.3 合成 .p12，脚本会打印要存进 GitHub 的 secrets
bash mobile/scripts/ios-p12.sh ~/Downloads/distribution.cer

# 2.4 照着脚本打印的命令存 secrets（第一次用 gh 先 gh auth login）
gh secret set IOS_CERT_P12_BASE64 -R yx-storehouse/media-hub < ~/.reel-keys/ios/reel-ios-distribution.p12.base64
gh secret set IOS_CERT_PASSWORD   -R yx-storehouse/media-hub < ~/.reel-keys/ios/reel-ios-distribution.p12.password
gh secret set IOS_TEAM_ID         -R yx-storehouse/media-hub --body "你的TeamID"
gh secret set KEYCHAIN_PASSWORD   -R yx-storehouse/media-hub --body "$(openssl rand -hex 24)"
```

不用 `gh` 也行：GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，名字照上面填（`ios-p12.sh` 最后会打印 `IOS_CERT_P12_BASE64` 要粘贴的那一长串）。

**把整个 `~/.reel-keys/ios` 文件夹备份好**（和安卓的钥匙放在一起）。发布证书有效期 1 年，到期前重新走一遍第 2、3 步（先把旧的 `reel-ios-distribution.*` 挪到别的文件夹，`ios-csr.sh` 不会覆盖已有的私钥）。

### 第 3 步（Ad Hoc）：登记 iPhone、生成描述文件

1. 拿到每台 iPhone 的 **UDID**：iPhone 用数据线连电脑，打开「Apple 设备」App（微软商店）或 iTunes，在设备概要里点几下「序列号」会切换成 UDID，右键复制；也可以用爱思助手，首页的设备信息里有 UDID。
2. 开发者网站 → **Devices** → 「+」→ 平台 iOS，名字随便（比如「爸爸的 iPhone」），填 UDID → Register。每台手机都登记。
3. **Profiles** → 「+」→ Distribution 下的 **Ad Hoc** → App ID 选 `com.yxstorehouse.reel` → 选第 2 步的证书 → 勾选要装的设备 → 名字填 `Reel Ad Hoc` → Generate → Download。
4. 存成 secret（在 Git Bash 里，文件名按实际下载的改）：

   ```bash
   base64 -w0 ~/Downloads/Reel_Ad_Hoc.mobileprovision | gh secret set IOS_PROFILE_BASE64 -R yx-storehouse/media-hub
   ```

以后加新手机：登记设备 → 在 Profiles 里编辑 `Reel Ad Hoc`、勾上新设备 → 重新下载 → 再运行一次上面的命令 → 重新打包。

### 第 3 步（TestFlight）：App Store Connect

1. **描述文件**：开发者网站 → Profiles → 「+」→ Distribution 下的 **App Store Connect** → App ID 选 `com.yxstorehouse.reel` → 选第 2 步的证书 → 名字 `Reel App Store` → Generate → Download，然后：

   ```bash
   base64 -w0 ~/Downloads/Reel_App_Store.mobileprovision | gh secret set IOS_PROFILE_BASE64 -R yx-storehouse/media-hub
   ```

2. **新建 App**：打开 <https://appstoreconnect.apple.com> →「App」→「+」→ 新建 App：平台 iOS；名称要在整个 App Store 里不重复（`Reel` 多半被占了，可以填「Reel 家庭影院」之类，手机桌面上显示的名字仍然是 Reel）；主要语言 简体中文；套装 ID 选 `com.yxstorehouse.reel`；SKU 随便填（比如 `reel-ios`）；用户访问权限 完全访问。只用 TestFlight 的话 App 的商店信息都不用填。
3. **API 密钥**（让 GitHub Actions 上传）：App Store Connect →「用户和访问」→「集成」→ App Store Connect API →「团队密钥」→ 生成，访问权限选 **App 管理**。下载 `AuthKey_XXXXXXXXXX.p8`（**只能下载一次**，放进 `~/.reel-keys/ios` 一起备份），记下页面上的「密钥 ID」和「Issuer ID」：

   ```bash
   gh secret set ASC_KEY_ID    -R yx-storehouse/media-hub --body "密钥ID"
   gh secret set ASC_ISSUER_ID -R yx-storehouse/media-hub --body "Issuer ID"
   gh secret set ASC_KEY_P8    -R yx-storehouse/media-hub < ~/.reel-keys/ios/AuthKey_XXXXXXXXXX.p8
   ```

4. **测试员**：要装 App 的人先加进团队：「用户和访问」→「+」→ 填邮箱，角色随便选一个（比如「客户支持」），对方在邮件里接受邀请。然后「App → Reel → TestFlight → 内部测试」→ 新建群组 → 把这些人加进去（第一次上传的版本处理完后再加也行）。他们在 iPhone 上装 **TestFlight** App，用同一个 Apple ID 登录就能看到 Reel。

### 第 4 步：默认服务器地址（可选）

App 第一次打开时默认连的地址。不设的话第一次打开会让用户自己填。

```bash
gh secret set REEL_SERVER -R yx-storehouse/media-hub --body "http://你的服务器内网地址:27381"
```

**用 secret，不要用 Variables**：仓库是公开的，运行日志谁都能看，secret 在日志里会被打码，变量不会（工作流两种都认，secret 优先）。

### 第 5 步：打包

- 自动：改了 `mobile/` 的提交推到 `main` 就会打包（只改网页版、接口不会触发，也不需要）。
- 手动：GitHub 仓库 → Actions →「iOS App」→ Run workflow，或者：

  ```bash
  gh workflow run mobile-ios.yml -R yx-storehouse/media-hub              # 按描述文件自动选 Ad Hoc / App Store
  gh workflow run mobile-ios.yml -R yx-storehouse/media-hub -f testflight=false   # App Store 描述文件但这次不传 TestFlight
  gh run watch -R yx-storehouse/media-hub                                  # 看进度，大约 10 分钟
  ```

  `export_method` 默认 `auto`：Ad Hoc 描述文件就导出 Ad Hoc 包，App Store 描述文件就导出 App Store 包，并在配了 `ASC_*` 时上传 TestFlight。
  改了原生代码（`ios/`）想顺便在模拟器里测一遍：加 `-f simulator_test=true`（没配签名时总会测）。冒烟测试的截图在运行结果的 Artifacts「ios-simulator-test」里。

运行结果页（Summary）会写打出了什么。出错时看红色的那一步，常见的：

| 报错 | 原因 |
|---|---|
| 证书导入失败 | `IOS_CERT_PASSWORD` 和 `.p12` 的密码对不上（重新跑 `ios-p12.sh` 会生成新的密码，两个 secret 要一起更新） |
| 描述文件的 App ID 是 … | 生成描述文件时 App ID 选错了 |
| 描述文件里没有这张发布证书 | 证书换过：编辑描述文件、勾选新证书、重新下载、更新 `IOS_PROFILE_BASE64` |
| 描述文件已经过期 / 开发描述文件 | 重新生成 Ad Hoc 或 App Store 类型的描述文件 |
| 上传 TestFlight 失败 | App Store Connect 里还没建 App、套装 ID 不对，或者 API 密钥权限不够（要「App 管理」） |

### 第 6 步：安装

**TestFlight**：上传后 App Store Connect 要处理 10～30 分钟，测试员的 TestFlight App 里就会出现新版本，点安装。之后每次打包都会自动推送。

**Ad Hoc**：运行结果页最下面的 Artifacts 里下载 `Reel-<版本>-<build>-ad-hoc.ipa`（是个 zip，解压出 `.ipa`；也可以 `gh run download <运行编号> -R yx-storehouse/media-hub`）。**只保留 3 天**，下载后自己存好。然后用电脑装到手机上：

- Windows：**爱思助手**（连接手机 →「应用游戏」→「导入安装」选 `.ipa`），或 **iMazing**（「管理应用」→ 从 `.ipa` 安装）。
- Mac：**Apple Configurator**（把 `.ipa` 拖到设备上），或者直接拖到「访达」里的 iPhone 上。
- Sideloadly 主要是用个人 Apple ID 重新签名安装，装已经签好的 Ad Hoc 包不如上面两个直接。
- 「点链接就能安装」（`itms-services://`）要求安装包放在 HTTPS 网址上，等以后服务器有了 HTTPS 域名再考虑（服务器的素材白名单目前只放开了安卓的 `.apk`）。

只有第 3 步登记过的 iPhone 才装得上。新版本直接覆盖安装，App 里的登录状态、服务器地址都保留。

**第一次打开**：系统会问「允许 Reel 查找并连接到本地网络上的设备」，点**允许**（不然连不上家里的 NAS）；点错了去「设置 → Reel → 本地网络」打开。之后和安卓一样：「我的 → 切换服务器」或者在启动页长按图标改地址。

### 公开仓库要注意

- 证书、私钥、`.p12`、`.p8`、描述文件**永远不要提交**（`.gitignore` 兜了底，但还是要小心），只放在 `~/.reel-keys/ios` 和 GitHub secrets 里。泄露了就去开发者网站把证书 Revoke 掉、重新做第 2、3 步。
- secrets 在日志里会被打码；fork 出去的仓库和别人提的 PR 拿不到这些 secrets（工作流只在推到 `main` 和手动运行时打包）。
- 运行日志和 Artifacts 是公开的：任何登录 GitHub 的人在 3 天内都能下载 `.ipa` 和安卓 CI 打的调试版 APK，两个里面都有默认服务器地址（内网地址，外面的人连不上）。`.ipa` 别人拿到也装不上（Ad Hoc 包只能装在登记过的手机上，App Store 包根本装不了）；调试版 APK 谁都能装，但只是个外壳，连不上你的服务器就什么都看不到。介意的话不设 `REEL_SERVER`，或者把仓库改成私有（私有仓库的 macOS 机器按分钟计费）。

### 在 Mac 上用 Xcode 调试（可选）

有 Mac 的话可以直接跑模拟器 / 真机：

```bash
cd mobile
npm ci
npm run ios:sync      # 生成启动页配置 + cap sync ios
npm run ios:open      # 用 Xcode 打开，Signing & Capabilities 里选自己的 Team，再运行
REEL_WEBVIEW_DEBUG=1 npm run ios:sync   # 这样运行的 App 能用 Safari 的「开发」菜单调试网页（不要发给别人）
```

### 原生外壳的约定（和安卓一样）

- 插件名 `ReelShell`，方法 `setServer({ url })`：启动页连上服务器、跳转之前调用（`www/launcher.js` 的 `registerNative`），记下服务器主机名；
- 导航判断（`shouldOverrideLoad`）：服务器同一主机的页面留在 App 里，其他网站交给系统浏览器；
- 网页版「切换服务器」跳 `capacitor://localhost/?settings`（安卓 `https://localhost/?settings`）；
- iOS 外壳在 App 回到前台时给启动页发 `reel:resume` 事件，连不上的时候自动重试。
