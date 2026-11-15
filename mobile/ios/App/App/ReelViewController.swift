import UIKit
import WebKit
import SafariServices
import Capacitor

/**
 * Reel 外壳的主界面。App 里只有启动页（public/，来自 mobile/www），连上服务器后整页跳到服务器上的网页版。
 *
 * 在 Capacitor 默认行为之上补了这些（安卓对应的是 MainActivity.java / ShellPlugin.java）：
 *   - ReelShell 插件（ShellPlugin.swift）：服务器的页面留在 App 里，别的网站用 Safari 打开
 *   - 只有启动页能调用原生插件：iOS 上 Capacitor 会把桥接脚本注入到每个页面（包括服务器的网页），
 *     服务器网页、iframe 发来的原生调用一律丢掉（安卓上服务器网页本来就拿不到桥接）
 *   - 页面整页加载失败：回到启动页（index.html?error）显示「连不上服务器」。
 *     不用 Capacitor 自己的 errorPath 处理：它在 iOS 上用 appendingPathComponent 拼地址，
 *     「index.html?error」会变成「index.html%3Ferror」，找不到文件又算加载失败，会一直循环；
 *     它也不区分「被新的跳转打断」（-999）这种并不是出错的情况
 *   - 服务器上 target=_blank 的链接（「我的 → 管理后台」）：在 App 里弹出 Safari 页面，点「完成」回来。
 *     iPhone 没有返回键，留在主 WebView 里就回不去了
 *   - 回到前台、系统弹窗（比如第一次连内网时的「本地网络」权限）关掉后：通知启动页，连不上时自动重试
 *   - 双指放大不受网页的 maximum-scale=1 限制（ignoresViewportScaleLimits），整页跟随系统「更大字体」（pageZoom）
 *
 * 状态栏（深色底、浅色字）由 SystemBars 插件按 capacitor.config.js 设置；安全区交给网页的 env(safe-area-inset-*)
 * （ios.contentInset = never）；横竖屏、视频全屏、播放时屏幕常亮都是 WebView / 系统自己处理的。
 */
class ReelViewController: CAPBridgeViewController {

    private let shell = ShellPlugin()
    private var navigationProxy: ShellNavigationDelegate?
    private var messageGuard: LocalOnlyMessageHandler?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let bridge = bridge, let webView = webView else { return }

        bridge.registerPluginInstance(shell)

        // Capacitor 的导航 / 界面代理换成一个转发代理：只接管上面说的几件事，其余原样交给 Capacitor
        if let capacitor = webView.navigationDelegate as? WebViewDelegationHandler {
            let proxy = ShellNavigationDelegate(capacitor: capacitor, shell: shell, config: bridge.config, presenter: self)
            webView.navigationDelegate = proxy
            webView.uiDelegate = proxy
            navigationProxy = proxy

            let localScheme = bridge.config.localURL.scheme ?? "capacitor"
            let guardHandler = LocalOnlyMessageHandler(inner: capacitor, localScheme: localScheme)
            capacitor.contentController.removeScriptMessageHandler(forName: "bridge")
            capacitor.contentController.add(guardHandler, name: "bridge")
            messageGuard = guardHandler
        } else {
            CAPLog.print("⚡️  ReelShell: 没找到 Capacitor 的 WebView 代理，外壳的导航处理没有生效")
        }

        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)

        // 跟随系统「更大字体」（Dynamic Type）：整页按比例放大
        applyTextScale()
        NotificationCenter.default.addObserver(self, selector: #selector(contentSizeDidChange),
                                               name: UIContentSizeCategory.didChangeNotification, object: nil)
    }

    /// 像 Safari 一样：网页给 iPhone 加的 maximum-scale=1（挡住点进输入框时整页自动放大）不挡双指放大（全局-03）。
    /// WKWebView 默认遵守 maximum-scale，要在建 WebView 之前改 configuration
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        configuration.ignoresViewportScaleLimits = true
        return configuration
    }

    @objc private func contentSizeDidChange() {
        applyTextScale()
    }

    /// 系统「更大字体」：整页按比例放大（最多 1.35 倍；放大后网页宽度不小于 320，网页最窄按 320 排版）。
    /// 安卓的 WebView 默认就按系统字体比例放大文字（textZoom），不用这里处理
    private func applyTextScale() {
        guard let webView = webView else { return }
        // capacitorDidLoad 时 WebView 还没进窗口、没排版：字号取系统设置，宽度取屏幕（不读 view 的尺寸和 traitCollection）
        let traits = UITraitCollection(preferredContentSizeCategory: UIApplication.shared.preferredContentSizeCategory)
        let scale = UIFontMetrics(forTextStyle: .body).scaledValue(for: 17, compatibleWith: traits) / 17
        let width = min(UIScreen.main.bounds.width, UIScreen.main.bounds.height)
        let zoom = min(max(scale, 1), 1.35, max(width / 320, 1))
        if abs(webView.pageZoom - zoom) > 0.01 { webView.pageZoom = zoom }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// 回到前台：如果正停在启动页（比如「连不上服务器」），让它再试一次（www/launcher.js 监听 reel:resume）
    @objc private func appDidBecomeActive() {
        guard let webView = webView, let scheme = bridge?.config.localURL.scheme, webView.url?.scheme == scheme else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('reel:resume'))", completionHandler: nil)
    }
}

/**
 * WebView 的导航 / 界面代理。自己实现的方法见下面，其余的（decidePolicyFor、didFinish、alert 等）
 * 通过 Objective-C 消息转发原样交给 Capacitor 的 WebViewDelegationHandler。
 * WebKit 在设置代理时就会问清楚代理实现了哪些方法，所以 responds(to:) 要把 Capacitor 实现的也算上。
 */
final class ShellNavigationDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {

    private let capacitor: WebViewDelegationHandler
    private weak var shell: ShellPlugin?
    private weak var presenter: UIViewController?
    private let localScheme: String?
    /// 加载失败时回到的启动页地址（capacitor.config.js 的 server.errorPath，如 capacitor://localhost/index.html?error）
    private let errorURL: URL?

    init(capacitor: WebViewDelegationHandler, shell: ShellPlugin, config: InstanceConfiguration, presenter: UIViewController) {
        self.capacitor = capacitor
        self.shell = shell
        self.presenter = presenter
        self.localScheme = config.localURL.scheme
        if let path = config.errorPath, !path.isEmpty {
            var base = config.localURL.absoluteString
            while base.hasSuffix("/") { base.removeLast() }
            let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
            self.errorURL = URL(string: base + "/" + trimmed)
        } else {
            self.errorURL = nil
        }
        super.init()
    }

    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || capacitor.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if capacitor.responds(to: aSelector) { return capacitor }
        return super.forwardingTarget(for: aSelector)
    }

    // MARK: - 加载失败

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(webView, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(webView, error)
    }

    private func handleLoadFailure(_ webView: WKWebView, _ error: Error) {
        let nsError = error as NSError
        CAPLog.print("⚡️  WebView 页面加载失败：\(nsError.domain) \(nsError.code) \(nsError.localizedDescription)")
        // 不是「连不上」：被新的跳转打断（-999）、内容不能在 WebView 里显示（WebKit 102，比如下载）、交给插件处理（WebKit 204）
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && (nsError.code == 102 || nsError.code == 204) { return }
        guard let errorURL = errorURL else { return }
        // 启动页自己打不开就不要再跳回启动页（防止死循环，正常不会发生）
        let failing = nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL
        if let scheme = failing?.scheme, scheme == localScheme { return }
        webView.load(URLRequest(url: errorURL))
    }

    // MARK: - 新窗口（target=_blank、window.open）

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // 服务器自己的页面（管理后台 admin.html）：在 App 里弹出 Safari 页面；别的网站照旧交给 Safari
        if let url = navigationAction.request.url, shell?.isServerURL(url) == true, var top = presenter {
            while let presented = top.presentedViewController { top = presented }
            let safari = SFSafariViewController(url: url)
            safari.dismissButtonStyle = .done
            safari.preferredBarTintColor = UIColor(red: 10 / 255, green: 10 / 255, blue: 10 / 255, alpha: 1)
            safari.preferredControlTintColor = .white
            top.present(safari, animated: true)
            return nil
        }
        return capacitor.webView(webView, createWebViewWith: configuration, for: navigationAction, windowFeatures: windowFeatures)
    }
}

/**
 * Capacitor 原生调用的消息入口（window.webkit.messageHandlers.bridge）外面再包一层：
 * 只放行启动页（capacitor://localhost 主框架）发来的消息。服务器的网页虽然也被注入了桥接脚本，
 * 但它（以及它里面的 iframe）调不动任何原生插件。
 */
final class LocalOnlyMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var inner: WKScriptMessageHandler?
    private let localScheme: String

    init(inner: WKScriptMessageHandler, localScheme: String) {
        self.inner = inner
        self.localScheme = localScheme
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == localScheme else { return }
        inner?.userContentController(userContentController, didReceive: message)
    }
}
