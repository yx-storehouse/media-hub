package com.yxstorehouse.reel;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 外壳插件：记住启动页连上的服务器，决定哪些页面留在 App 里。
 *
 * 为什么不用 capacitor.config 的 server.allowNavigation：
 *   1. 服务器地址是用户在启动页里填的，打包时并不知道；
 *   2. 写进 allowNavigation 的域名，Capacitor 会用原生代码代理它的请求并注入桥接脚本，
 *      视频的 Range 请求、上传都会受影响。
 * 这里只做导航判断，服务器的网页由 WebView 直接加载，拿不到原生桥接（也不需要）。
 *
 * 只有启动页（https://localhost）能调用 setServer：Capacitor 只给本地页面注入桥接。
 */
@CapacitorPlugin(name = "ReelShell")
public class ShellPlugin extends Plugin {

    private static final String PREFS = "reel_shell";
    private static final String KEY_SERVER = "server";

    /** 服务器的主机名（不含端口，小写）。同一主机 http 跳 https、换端口也算自己的页面 */
    private volatile String serverHost;
    /** 刚换过服务器：新服务器的页面加载完后清掉 WebView 的历史，返回键不会退回旧服务器 / 启动页 */
    private volatile boolean clearHistoryPending;

    private WebViewListener historyCleaner;

    @Override
    public void load() {
        serverHost = hostOf(prefs().getString(KEY_SERVER, null));
    }

    /*
     * 页面监听要在这里加，不能在 load() 里：Bridge 创建完插件后会用 Builder 里的列表整个替换掉监听列表，
     * load() 里加的会丢（Capacitor 自带的 SystemBars 也是在这里加的）
     */
    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        if (historyCleaner != null) return;
        historyCleaner = new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView webView, String url) {
                // 新页面一提交（开始显示）就清，不用等图片都加载完
                if (url == null) return;
                // 服务器页面整页加载失败、跳回启动页（errorPath = index.html?error）：清掉历史，
                // 不然返回键会退回那个打不开的页面、再失败、再跳回来，App 退不出去
                if (url.startsWith(bridge.getLocalUrl() + "/") && Uri.parse(url).getQueryParameterNames().contains("error")) {
                    webView.clearHistory();
                    return;
                }
                if (!clearHistoryPending) return;
                String host = hostOf(url);
                if (host != null && host.equals(serverHost)) {
                    clearHistoryPending = false;
                    webView.clearHistory();
                }
            }
        };
        bridge.addWebViewListener(historyCleaner);
    }

    /** 启动页连上服务器、跳过去之前调用：{ url: "http://192.168.1.10:27381" } */
    @PluginMethod
    public void setServer(PluginCall call) {
        String url = call.getString("url");
        String host = hostOf(url);
        if (host == null) {
            call.reject("服务器地址不正确");
            return;
        }
        serverHost = host;
        clearHistoryPending = true;
        prefs().edit().putString(KEY_SERVER, url).apply();
        call.resolve();
    }

    /**
     * WebView 要打开一个地址时（点链接、location.href、重定向）先问这里：
     *   - 服务器的页面：返回 false，留在 App 里（Capacitor 默认会把它交给系统浏览器）
     *   - 其余：返回 null，按 Capacitor 默认处理——启动页（https://localhost）留在 App 里，
     *     别的网站、tel: / mailto: 交给系统浏览器 / 对应的 App
     */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String scheme = url.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;
        String host = url.getHost();
        String server = serverHost;
        if (host != null && server != null && host.equalsIgnoreCase(server)) return false;
        return null;
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String hostOf(String url) {
        if (url == null) return null;
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;
            String host = u.getHost();
            return host == null || host.isEmpty() ? null : host.toLowerCase(java.util.Locale.ROOT);
        } catch (Exception e) {
            return null;
        }
    }
}
