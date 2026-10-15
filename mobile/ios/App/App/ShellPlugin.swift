import Foundation
import WebKit
import Capacitor

/**
 * 外壳插件 ReelShell：记住启动页连上的服务器，决定哪些页面留在 App 里。
 * 和安卓的 ShellPlugin.java 是同一个约定（见 mobile/README.md「iOS」）：
 *
 *   - setServer({ url })：启动页（www/launcher.js 的 registerNative）连上服务器、跳过去之前调用，记下服务器的主机名；
 *   - shouldOverrideLoad：服务器同一主机（http 跳 https、换端口也算）的页面留在 App 里，
 *     其他网站按 Capacitor 默认交给 Safari，tel: / mailto: 交给系统。
 *
 * 为什么不用 capacitor.config 的 server.allowNavigation：服务器地址是用户在启动页里填的，打包时并不知道。
 *
 * 服务器只记在内存里：App 每次冷启动都先打开启动页，启动页连上服务器后会重新登记。
 * 只有启动页能调用这个插件（ReelViewController 会丢掉服务器网页发来的原生调用），这里再检查一遍。
 */
@objc(ReelShellPlugin)
public class ShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReelShellPlugin"
    public let jsName = "ReelShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setServer", returnType: CAPPluginReturnPromise)
    ]

    /// 服务器的主机名（小写、不含端口）。只在主线程读写
    private(set) var serverHost: String?

    /// 启动页连上服务器、跳过去之前调用：{ url: "http://192.168.1.10:27381" }
    @objc func setServer(_ call: CAPPluginCall) {
        let url = call.getString("url")
        // 插件方法在 Capacitor 的后台队列里执行，读 WebView 地址、改状态都回到主线程
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let page = self.bridge?.webView?.url, page.scheme == self.bridge?.config.localURL.scheme else {
                call.reject("只有启动页能设置服务器")
                return
            }
            guard let host = ShellPlugin.host(of: url) else {
                call.reject("服务器地址不正确")
                return
            }
            self.serverHost = host
            call.resolve()
        }
    }

    /// 是不是登记过的服务器上的 http / https 地址
    func isServerURL(_ url: URL?) -> Bool {
        guard let server = serverHost, let url = url else { return false }
        return ShellPlugin.host(of: url.absoluteString) == server
    }

    /**
     * WebView 要打开一个地址时（点链接、location.href、重定向）Capacitor 先问这里：
     *   - 服务器的页面：返回 false，留在 App 里（Capacitor 默认会把它交给 Safari）
     *   - 其余：返回 nil，按 Capacitor 默认处理——启动页（capacitor://localhost）留在 App 里，
     *     别的网站、tel: / mailto: 交给 Safari / 对应的 App
     */
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        return isServerURL(navigationAction.request.url) ? NSNumber(value: false) : nil
    }

    /// http / https 地址的主机名（小写），其他协议、解析不了的返回 nil
    static func host(of string: String?) -> String? {
        guard let string = string, let url = URL(string: string), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host, !host.isEmpty else {
            return nil
        }
        return host.lowercased()
    }
}
