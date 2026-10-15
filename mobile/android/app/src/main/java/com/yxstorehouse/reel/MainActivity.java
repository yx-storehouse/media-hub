package com.yxstorehouse.reel;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Reel 外壳。App 里只有启动页（assets/public），连上服务器后整页跳到服务器上的网页版。
 *
 * 在 Capacitor 默认行为之上补了这些：
 *   - ShellPlugin：服务器的页面留在 App 里，别的网站用系统浏览器打开
 *   - 返回键：先退出全屏，再网页后退（网页版的弹层也跟着历史记录关闭），退到头了才离开 App
 *   - 网页全屏（<video> / 元素 requestFullscreen）：Capacitor 默认直接拒绝，这里真正铺满屏幕、隐藏系统栏，
 *     横的视频竖着拿手机点全屏时转成横屏（FullscreenOrientation）
 *   - 视频播放时屏幕常亮：WebView 自己会做（播放时窗口带 KEEP_SCREEN_ON，暂停就去掉），不用额外处理
 *   - 深色系统栏 + edge-to-edge，安全区由 SystemBars 插件处理（见 capacitor.config.js）
 *   - 下载链接交给系统浏览器
 */
public class MainActivity extends BridgeActivity {

    /** 当前全屏显示的视图（网页 requestFullscreen 时 WebView 给的），没有全屏时为 null */
    private View fullscreenView;
    private android.webkit.WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShellPlugin.class);
        super.onCreate(savedInstanceState);

        // 状态栏、导航栏透明，内容画到系统栏后面；深色背景配浅色图标。
        // 系统栏让出来的位置由 SystemBars 插件处理：新 WebView 交给网页的 env(safe-area-inset-*)，老 WebView 由原生留边
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));

        WebView webView = getBridge().getWebView();
        webView.setWebChromeClient(new ShellChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> openExternal(url));

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (fullscreenView != null) {
                    exitFullscreen();
                    return;
                }
                WebView wv = getBridge().getWebView();
                if (wv.canGoBack()) {
                    wv.goBack();
                    return;
                }
                // 网页已经退到头：离开 App。和安卓 12 起系统的默认做法一样退到后台（不销毁），
                // 再点图标回来还在原来的页面，不用重新连接
                moveTaskToBack(true);
            }
        });
    }

    private void openExternal(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ignored) {
            // 没有浏览器就算了
        }
    }

    /* ---------------- 全屏 ---------------- */

    private void enterFullscreen(View view, android.webkit.WebChromeClient.CustomViewCallback callback) {
        fullscreenView = view;
        fullscreenCallback = callback;
        view.setBackgroundColor(Color.BLACK);
        ViewGroup decor = (ViewGroup) getWindow().getDecorView();
        decor.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), decor);
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.systemBars());
        FullscreenOrientation.onEnter(this, getBridge().getWebView());
    }

    /** 清掉全屏视图、恢复系统栏和方向。WebView 自己退出全屏（网页 exitFullscreen）时也走这里 */
    private void clearFullscreen() {
        if (fullscreenView == null) return;
        ViewGroup decor = (ViewGroup) getWindow().getDecorView();
        decor.removeView(fullscreenView);
        fullscreenView = null;
        fullscreenCallback = null;
        WindowCompat.getInsetsController(getWindow(), decor).show(WindowInsetsCompat.Type.systemBars());
        FullscreenOrientation.onExit(this);
    }

    /** 由 App 发起退出全屏（返回键）：先通知 WebView，再清理 */
    private void exitFullscreen() {
        android.webkit.WebChromeClient.CustomViewCallback cb = fullscreenCallback;
        clearFullscreen();
        if (cb != null) cb.onCustomViewHidden();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 全屏时转屏后系统栏可能被重新显示出来，再藏一次
        if (fullscreenView != null) {
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).hide(WindowInsetsCompat.Type.systemBars());
        }
    }

    private class ShellChromeClient extends BridgeWebChromeClient {

        ShellChromeClient() {
            super(getBridge());
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreenView != null) {
                callback.onCustomViewHidden();
                return;
            }
            enterFullscreen(view, callback);
        }

        @Override
        public void onHideCustomView() {
            clearFullscreen();
        }
    }
}
