package com.boki.cigpricer;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * 烟价速查的安卓壳：一个全屏 WebView，把 assets/www/index.html 当成 App。
 *
 * <h3>为什么用「假的 https 域名」，而不是 file:///android_asset/</h3>
 *
 * 先说清楚一件事，免得后来的人凭印象改错：<b>file:// 下 IndexedDB 在这个 WebView 里是可用的</b>。
 * 2026-09-24 实测（MuMu / Android 15 / index.html 导航到 {@code file:///android_asset/}）：
 * <pre>
 *   origin=file://   isSecureContext=true
 *   STORE_OK=true    indexedDB 开库 + 写入 + 读回 全部成功   配额 77358 MB
 * </pre>
 * 所以「file:// 存不住，只能上 https」这个说法是<b>错的</b>，别拿它当理由。
 * （桌面 Edge 138 也是同样结论 —— 见 skill price-photo-crop-app。）
 *
 * 那为什么还是用虚拟 https 域：
 * <ol>
 *   <li><b>file:// 是"整个 scheme 一个源"</b>。Chromium 把任何 file:// 页面都算作同一个来源
 *       {@code file://} —— 这个 WebView 之后加载的任何本地文件都和我们共用一份存储。
 *       现在是没问题（我们只加载自己的页面），但这个性质本身不该拿来当隔离用。</li>
 *   <li><b>它是遗留路径，不是受支持的路径。</b> WebView 是随系统单独升级的组件，
 *       而 file:// 的存储行为在 Chromium 里一直是被逐步收紧/不再投入维护的部分
 *       （否则 AndroidX 也不会专门做 WebViewAssetLoader 来绕开它）。
 *       真正的 https 源才是官方推荐、会被长期支持的那条路。</li>
 *   <li>以后要用 service worker、crypto.subtle、带正规 CORS 语义的 fetch，都需要真实来源。</li>
 * </ol>
 *
 * <h3>⚠️ 改这个域名 = 店主导入过的表会「全部消失」</h3>
 * IndexedDB 是按**来源**隔离的。把 HOST 改掉、或把加载方式换成 file:///，
 * 存储就落到另一个来源上去了 —— 内置表照常显示（它是打包进页面里的），
 * 但店主导入过的表会一个都不剩，而且**看起来就像被删了**。
 * 真要改，得同时做一次迁移（旧来源读出来 → 新来源写进去）。
 *
 * <h3>权限只有两类</h3>
 * <ol>
 *   <li><b>INTERNET</b>：「认字」页签调 AI 读商品名（用户自己填的 API）。其余功能——
 *       页面、切图、整表全在 assets 里，导入的表存在 App 自己的 WebView 数据目录里——
 *       <b>断网也能用</b>，不需要联网。</li>
 *   <li><b>REQUEST_INSTALL_PACKAGES</b>：应用内更新，下载 APK 后拉起系统安装器（2026-09-26 加）。
 *       Android 12+ 还需用户在设置里手动开「允许来自此来源的应用」。</li>
 * </ol>
 * 不读外部存储、不拿任何别的权限——这才是这个 App 的底线。
 */
public class MainActivity extends Activity {

    private static final String TAG = "CigPricer";

    /** 虚拟域名（见类注释）。改这里的话页面来源就变了，已导入的表会「找不到」。 */
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    /** assets 下的站点根目录 */
    private static final String WEB_ROOT = "www";

    private static final int REQ_PICK_FILE = 1001;

    private WebView web;
    /** <input type="file"> 的取值回调（「导入表包」用）。同一时刻只允许有一个。 */
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        web = new WebView(this);
        // 底色跟网页 --bg 对齐，避免启动瞬间闪一下白底
        web.setBackgroundColor(isNightMode() ? 0xFF121316 : 0xFFF2F3F5);
        // 只在 --debug 打包时才开，正式包关掉（开着等于把 WebView 的调试通道暴露给任何能连 adb 的人）
        if (getResources().getBoolean(R.bool.webview_debug)) {
            WebView.setWebContentsDebuggingEnabled(true);
            Log.w(TAG, "WebView 调试通道已开启（这是 --debug 测试包；正式包不会有这行）");
        }

        configure(web.getSettings());

        // 应用内更新需要原生桥：下载 / 安装 / 装完删包 / 读版本号（2026-09-26）
        web.addJavascriptInterface(new CigBridge(), "NasBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return intercept(req);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // 自己的页面：照常加载（会被 shouldInterceptRequest 接管）
                if (HOST.equals(u.getHost())) return false;
                // 别的地址（网页里万一有外链）：丢给系统浏览器，App 自己不留 WebView 历史
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "没有应用能打开 " + u);
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "页面就绪 " + url);
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // WebView 渲染进程崩了：默认行为是让整个 App 一起挂掉。
                // 这个 App 是店主天天要用的，宁可自己重启一次也不要闪退。
                Log.e(TAG, "WebView 渲染进程挂了（crashed=" + detail.didCrash() + "），重建");
                if (view == web) {
                    ViewGroup parent = (ViewGroup) web.getParent();
                    if (parent != null) parent.removeView(web);
                    web.destroy();
                    web = null;
                }
                recreate();
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, "网页 " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;   // 别再往默认的 console 处理器里丢
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                // 没有这个回调，页面里的 <input type="file"> 点了没反应 ——
                // 也就是「导入表包」按下去一动不动，而且不报错。必须实现。
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;

                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                /* accept 怎么处理，取决于是哪个按钮：
                   - 「换照片」的 input 写的是 accept="image/星号" → 直接用它，
                     系统选择器只列图片，店主不用在一堆文件里翻照片；
                   - 「导入表包」写的是 ".json,.cigtable,application/json" → 不做过滤
                     （用万能类型，也就是任意 MIME 都列）。表包叫 xxx.cigtable.json，
                     各家文件管理器给的 MIME 不一致，加了过滤反而可能一个文件都列不出来
                     （这是踩过的）。
                   判据：accept 只有一项、且形如 aaa/bbb（是 MIME，而不是点号开头的扩展名）
                   才采用它。注意本注释里不要出现星号紧跟斜杠的写法 —— 那会提前闭合注释。 */
                String type = "*/*";
                String[] acc = params == null ? null : params.getAcceptTypes();
                if (acc != null && acc.length == 1 && acc[0] != null) {
                    String a = acc[0].trim();
                    if (a.indexOf('/') > 0 && a.charAt(0) != '.') type = a;
                }
                i.setType(type);
                // 打出来是为了能在 logcat 里核对"选照片时到底只列不列图片"
                // （android/acceptance.js 会断言这一行）
                Log.i(TAG, "文件选择器 type=" + type + " accept=" + java.util.Arrays.toString(acc));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivityForResult(Intent.createChooser(i, getString(R.string.pick_pack)),
                            REQ_PICK_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "系统里没有文件选择器", e);
                    fileCallback = null;
                    return false;
                }
            }
        });

        setContentView(web);
        web.loadUrl(START_URL);
    }

    // ------------------------------------------------------------------ WebSettings

    private void configure(WebSettings s) {
        s.setJavaScriptEnabled(true);
        // IndexedDB / localStorage 的总开关。关掉的话「管理」页导入的表存不住。
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);

        // 页面全在 assets 里，不需要任何本地文件 / content 通道
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);

        // 页面是虚拟 https 源（appassets.androidplatform.net），「数据同步」要 fetch
        // 用户填的 http://192.168.x.x:8080 —— 属于混合内容，WebView 默认 NEVER_ALLOW
        // 会静默拦截（表现为 fetch 抛 "Failed to fetch"）。本 App 页面全在本地，
        // 放开没有任何额外风险。
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // 页面自己处理缩放（「原表」页有自己的加减按钮），别叠一层双指缩放
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);

        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);

        // 不跟随系统字体缩放：字号被放大后卡片布局会挤变形，而这个 App 的信息密度是设计死的
        s.setTextZoom(100);

        s.setMediaPlaybackRequiresUserGesture(true);

        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false);   // 不联网，也不该去问 Google

        // 网页自己按 prefers-color-scheme 出深色样式，别再让 WebView 叠一层强制反色
        if (Build.VERSION.SDK_INT >= 29 && Build.VERSION.SDK_INT < 33) {
            s.setForceDark(WebSettings.FORCE_DARK_OFF);
        }
    }

    private boolean isNightMode() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    // ------------------------------------------------------------------ assets 路由

    /**
     * 把 https://appassets.androidplatform.net/xxx 映射到 assets/www/xxx。
     * 找不到就回 404（让页面明确报错，而不是留一个永远转圈的空白）。
     */
    private WebResourceResponse intercept(WebResourceRequest req) {
        Uri u = req.getUrl();
        if (!HOST.equals(u.getHost())) return null;      // 不是我们的域名，交回默认处理

        String path = u.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
        // 浏览器会自动来要 favicon.ico。这个 App 没有网站图标（图标是安卓资源里的），
        // 直接回 204 而不是让它走 404 分支 —— 否则每次开页都会在 logcat 里留一条
        // "assets 里没有 www/favicon.ico" 的假警告，把真正的资源缺失警告淹掉。
        if ("/favicon.ico".equals(path)) {
            return new WebResourceResponse("image/x-icon", null, 204, "No Content", null,
                    new ByteArrayInputStream(new byte[0]));
        }
        // 目录穿越（../）在这里没有意义也做不到：assets.open 只认 assets 里的相对路径
        String asset = WEB_ROOT + path;

        InputStream in = null;
        try {
            in = getAssets().open(asset);
        } catch (IOException e) {
            Log.w(TAG, "assets 里没有 " + asset);
        }
        if (in == null) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null,
                    new ByteArrayInputStream(("找不到 " + asset).getBytes(StandardCharsets.UTF_8)));
        }
        return new WebResourceResponse(mimeOf(asset), encodingOf(asset), 200, "OK", null, in);
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".ico")) return "image/x-icon";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".woff")) return "font/woff";
        if (n.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /** 文本类要声明 utf-8，否则中文会按 latin-1 解出乱码；二进制必须给 null。 */
    private static String encodingOf(String name) {
        String m = mimeOf(name);
        if (m.startsWith("text/") || m.equals("application/javascript")
                || m.equals("application/json") || m.equals("image/svg+xml")) {
            return "utf-8";
        }
        return null;
    }

    // ------------------------------------------------------------------ 文件选择

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_PICK_FILE) {
            super.onActivityResult(req, res, data);
            return;
        }
        Uri[] picked = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                picked = new Uri[n];
                for (int i = 0; i < n; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[]{data.getData()};
            }
        }
        if (fileCallback != null) {
            fileCallback.onReceiveValue(picked);
            fileCallback = null;
        }
        // 用户取消时 picked 为 null，页面会走到「没读到文件」那条分支，不会卡住
    }

    // ------------------------------------------------------------------ 返回键

    /**
     * 返回键三级：先关全屏看图 → 再回「搜索」页 → 都没有才退出。
     * 判断逻辑放在页面里（window.__backHook），因为「现在开着什么」只有页面知道；
     * 这里只负责把结果翻译成「消费掉 / 交给系统」。
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null) {
            backToSystem();
            return;
        }
        web.evaluateJavascript(
                "(typeof window.__backHook==='function')?window.__backHook():false",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        // evaluateJavascript 回的是 JSON；页面没就绪时是 null
                        if (!"true".equals(v)) backToSystem();
                    }
                });
    }

    @SuppressWarnings("deprecation")
    private void backToSystem() {
        super.onBackPressed();
    }

    // ------------------------------------------------------------------ 生命周期

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------ 应用内更新桥

    /**
     * 前端 window.NasBridge.* 与原生 UpdateInstaller 之间的桥接（2026-09-26，移植自 douyin-nas）。
     *
     * <h3>为什么加这个</h3>
     * 应用内更新需要原生能力：流式下载大文件、SHA-256 校验、用 FileProvider 拉起系统安装器、
     * 装完回不到 App（安装器是另一个进程）所以要靠「下次启动运行版本 == 上次交给安装器的版本」来判成功删包。
     * 这些网页都做不到，只能走原生桥。
     *
     * <h3>网页版没原生层</h3>
     * 桌面/浏览器里打开时没有这个桥，appVersion() 会抛错；页面侧已 try/catch 兜底成空版本，
     * 「检查更新」卡片只是不显示，不影响别的功能。
     */
    private class CigBridge {
        private UpdateInstaller updater;
        private UpdateInstaller updater() {
            if (updater == null) updater = new UpdateInstaller(MainActivity.this, web);
            return updater;
        }
        @android.webkit.JavascriptInterface
        public String appVersion() {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return (pi.versionName == null ? "" : pi.versionName) + "|" + pi.versionCode;
            } catch (Throwable t) { return "|0"; }
        }
        @android.webkit.JavascriptInterface
        public void updDownload(String url, String sha256, String version) {
            updater().download(url, sha256, version);
        }
        @android.webkit.JavascriptInterface
        public void updInstall() { updater().install(); }
        @android.webkit.JavascriptInterface
        public void updClear() { updater().clear(); }
        @android.webkit.JavascriptInterface
        public boolean updHasPackage(String version) { return updater().hasDownloaded(version); }
        @android.webkit.JavascriptInterface
        public void updSweep(String curVersion) { updater().sweepAfterInstall(curVersion); }
        @android.webkit.JavascriptInterface
        public String deviceAbi() {
            try { String[] a = Build.SUPPORTED_ABIS; return (a != null && a.length > 0) ? a[0] : ""; }
            catch (Throwable t) { return ""; }
        }
    }
}
