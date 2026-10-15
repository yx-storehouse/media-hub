package com.yxstorehouse.reel;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

/**
 * 网页全屏时决定要不要把屏幕转成横的。
 *
 * 网页版点「全屏」时会调 screen.orientation.lock('landscape')，但安卓 WebView 不支持（NotSupportedError），
 * 这里用原生补上同样的规则（src/components/video/VideoPlayer.vue、ShortView.vue）：
 *   - 竖着拿手机进入全屏，且正在看的视频是横的 → 锁成横屏（左右两个方向都行），退出全屏时解锁
 *   - 已经是横屏（转屏自动进的全屏）、或者视频是竖的 → 不锁，竖回来时网页自己退出全屏
 */
final class FullscreenOrientation {

    /** 找全屏元素里正在看的视频（在屏幕上面积最大的，正在播放的优先），返回 landscape / portrait / none / unknown */
    private static final String PROBE_JS =
        "(function(){var f=document.fullscreenElement||document.webkitFullscreenElement;if(!f)return 'none';" +
        "var vs=f.tagName==='VIDEO'?[f]:[].slice.call(f.querySelectorAll('video'));var best=null,area=0,W=innerWidth,H=innerHeight;" +
        "for(var i=0;i<vs.length;i++){var v=vs[i],r=v.getBoundingClientRect();" +
        "var a=Math.max(0,Math.min(r.right,W)-Math.max(r.left,0))*Math.max(0,Math.min(r.bottom,H)-Math.max(r.top,0));" +
        "if(!v.paused)a*=2;if(a>area){area=a;best=v}}" +
        "if(!best||!best.videoWidth)return 'unknown';return best.videoWidth>best.videoHeight?'landscape':'portrait'})()";

    private static final int MAX_TRIES = 8;
    private static final long RETRY_MS = 150;

    /** 每次进入全屏 +1，退出时也 +1：过期的探测结果直接丢掉 */
    private static int generation = 0;

    private FullscreenOrientation() {}

    static void onEnter(Activity activity, WebView webView) {
        int gen = ++generation;
        boolean portrait = activity.getResources().getConfiguration().orientation != Configuration.ORIENTATION_LANDSCAPE;
        if (!portrait) return;
        probe(activity, webView, gen, 0);
    }

    static void onExit(Activity activity) {
        generation++;
        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    /** 全屏元素要等 WebView 进入全屏后才设置好、视频尺寸要等元数据加载完：拿不到就稍后再试几次 */
    private static void probe(Activity activity, WebView webView, int gen, int tries) {
        webView.evaluateJavascript(PROBE_JS, result -> {
            if (gen != generation || activity.isFinishing()) return;
            if ("\"landscape\"".equals(result)) {
                activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            } else if (("\"none\"".equals(result) || "\"unknown\"".equals(result)) && tries + 1 < MAX_TRIES) {
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (gen == generation) probe(activity, webView, gen, tries + 1);
                }, RETRY_MS);
            }
        });
    }
}
