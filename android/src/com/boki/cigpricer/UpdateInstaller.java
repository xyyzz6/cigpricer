package com.boki.cigpricer;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * 应用内更新：下载 APK + 校验 + 拉起系统安装器（2026-09-26，移植自 douyin-nas）。
 *
 * <h3>流程</h3>
 * <pre>
 *   网页                         本类
 *   ────                         ────
 *   updDownload(url,sha,ver) ──► 工作线程流式下载 → cacheDir/update/app-update.apk
 *                               ├─ 每 ~2% 回一次进度 → window.__updProgress({pct,mb,mbTotal})
 *                               └─ 完成后回           → window.__updDone({ok:true,...})
 *   updInstall()            ──► 校验「未知来源」权限 → FileProvider Uri → ACTION_VIEW
 * </pre>
 *
 * <h3>🔴 两个必踩的坑</h3>
 * 1. Android 12+ 不能再「下完直接弹安装」：只允许「用户主动点击」触发，所以下载/安装拆成两个按钮，
 *    绝不在下载回调里自动 install()。
 * 2. 未知来源权限要跳系统设置页，返回后页面再点一次安装（不自动重试）。
 *
 * <h3>装完自动删包</h3>
 * 把包交给系统安装器后收不到可靠回调，所以用「下次启动运行版本 == 上次交给安装器的版本」当成功信号：
 * 相等 → 装成功了 → 删包；不等 → 被取消/失败 → 留着让用户重试。
 * 判据方向极易写反（见 sweepAfterInstall 注释里的对照表），且尝试安装的版本必须落盘（新进程内存清零）。
 */
class UpdateInstaller {

    private static final String TAG = "CigPricer";
    /** 下载文件名固定：覆盖式重写，不堆积 / 不占用户存储 */
    private static final String APK_NAME = "app-update.apk";
    /**
     * 伴随文件：记录「这个包是哪个版本」（version，下载时写）与「已经交给过安装器的版本」（attempt，安装前写）。
     * 没有它就会「检测到新版却装了缓存的旧包」。
     */
    private static final String META_NAME = "app-update.json";
    private static final int PROGRESS_STEP = 2;
    private static final int CONNECT_TIMEOUT = 15000;
    private static final int READ_TIMEOUT = 30000;

    private final Activity act;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile Thread worker;
    /** 刚拉起过安装器的版本号（优先用磁盘上的伴随文件，因为装成功后是新进程） */
    private String installAttemptVer = null;

    UpdateInstaller(Activity act, WebView web) {
        this.act = act;
        this.web = web;
    }

    File apkFile() {
        File dir = new File(act.getCacheDir(), "update");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, APK_NAME);
    }

    private File metaFile() {
        File dir = new File(act.getCacheDir(), "update");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, META_NAME);
    }

    /**
     * 本地是否已有一个**属于 ver 这个版本**的下好的包。
     * @param ver 期望版本；空/null 时退化为旧的「有文件就算」行为。
     */
    boolean hasDownloaded(String ver) {
        File f = apkFile();
        if (!f.isFile() || f.length() == 0) return false;
        if (ver == null || ver.isEmpty()) return true;
        return ver.equals(readMetaVersion());
    }

    private String readMetaVersion() { return metaString("version"); }

    private String readMetaAttempt() { return metaString("attempt"); }

    private String metaString(String key) {
        File m = metaFile();
        if (!m.isFile()) return null;
        try (java.io.FileInputStream in = new java.io.FileInputStream(m)) {
            byte[] b = new byte[(int) m.length()];
            int off = 0, n;
            while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
            JSONObject o = new JSONObject(new String(b, 0, off, "UTF-8"));
            String v = o.optString(key, "");
            return v.isEmpty() ? null : v;
        } catch (Throwable t) {
            return null;   // 读坏了一律当「不是这个版本」→ 重下，别拿不准的包去装
        }
    }

    private void writeMeta(String ver, String sha, boolean attempt) {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(metaFile(), false)) {
            JSONObject o = new JSONObject();
            if (attempt) {
                String oldVer = readMetaVersion();
                o.put("version", oldVer == null ? "" : oldVer);
                o.put("attempt", ver == null ? "" : ver);
            } else {
                o.put("version", ver == null ? "" : ver);
                o.put("sha256", sha == null ? "" : sha);
                o.put("attempt", "");
            }
            o.put("at", System.currentTimeMillis());
            out.write(o.toString().getBytes("UTF-8"));
        } catch (Throwable t) {
            Log.w(TAG, "写更新包伴随文件失败（下次会重新下载）", t);
        }
    }

    private void deletePackage() {
        File f = apkFile();
        if (f.exists()) f.delete();
        File m = metaFile();
        if (m.exists()) m.delete();
    }

    /**
     * 装完之后的清理（用户要求「安装后删除安装包」）。
     *
     * 🔴 判据是「**相等**才删」：
     *   - attempt == curVer → 现在跑的正好是刚装上去那个版本 → 装成功 → 删包。
     *   - attempt != curVer → 用户取消/装失败，还跑老版本 → 留着让用户再点一次。
     */
    void sweepAfterInstall(String curVer) {
        String attempted = installAttemptVer != null ? installAttemptVer : readMetaAttempt();
        installAttemptVer = null;
        if (attempted == null || attempted.isEmpty()) return;
        if (curVer == null || curVer.isEmpty()) return;
        if (attempted.equals(curVer)) {
            Log.i(TAG, "检测到升级成功（已运行 " + curVer + "），清掉安装包");
            deletePackage();
        } else {
            Log.i(TAG, "上次安装未生效（尝试 " + attempted + "，仍运行 " + curVer + "），保留安装包");
        }
    }

    /**
     * 下载 APK 到 cacheDir/update/app-update.apk。
     * @param version 包对应的版本号（写进伴随文件，供 hasDownloaded 判断）—— 漏了会装旧包。
     */
    void download(final String url, final String sha256, final String version) {
        if (worker != null && worker.isAlive()) {
            js("window.__updDone&&window.__updDone(" + err("已有下载在进行中").toString() + ")");
            return;
        }
        final File out = apkFile();
        worker = new Thread(() -> {
            HttpURLConnection conn = null;
            InputStream in = null;
            FileOutputStream os = null;
            try {
                deletePackage();   // 先删旧包：避免半截文件被当完整包装上去

                long done = 0, total = -1;
                int lastPct = -1;
                conn = open(url);
                int code = conn.getResponseCode();
                if (code / 100 == 3) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (loc == null) throw new Exception("重定向没有 Location 头");
                    conn = open(loc);
                    code = conn.getResponseCode();
                }
                if (code != 200) throw new Exception("服务器返回 HTTP " + code);
                total = conn.getContentLengthLong();

                in = conn.getInputStream();
                os = new FileOutputStream(out);
                byte[] buf = new byte[64 * 1024];
                MessageDigest md = sha256 == null || sha256.isEmpty() ? null : MessageDigest.getInstance("SHA-256");
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    if (md != null) md.update(buf, 0, n);
                    done += n;
                    if (total > 0) {
                        int pct = (int) (done * 100 / total);
                        if (pct >= lastPct + PROGRESS_STEP || pct == 100) {
                            lastPct = pct;
                            reportProgress(pct, done, total);
                        }
                    }
                }
                os.flush();
                os.close(); os = null;
                in.close(); in = null;

                if (total > 0 && done != total) {
                    throw new Exception("下载不完整：" + done + "/" + total + " 字节");
                }
                if (md != null) {
                    String got = hex(md.digest());
                    if (!got.equalsIgnoreCase(sha256)) {
                        deletePackage();
                        throw new Exception("校验失败，文件可能不完整（sha256 不匹配）");
                    }
                }
                // 校验都过了才写伴随文件（attempt=false：记"这个包属于哪个版本"，先不记"已交给安装器"）
                writeMeta(version, sha256, false);

                final long size = done;
                ui.post(() -> {
                    JSONObject o = new JSONObject();
                    try {
                        o.put("ok", true);
                        o.put("mb", String.format(java.util.Locale.US, "%.1f", size / 1048576.0));
                        o.put("path", out.getAbsolutePath());
                        o.put("version", version == null ? "" : version);
                    } catch (Throwable ignore) {}
                    js("window.__updDone&&window.__updDone(" + o + ")");
                });
            } catch (Throwable t) {
                Log.e(TAG, "更新包下载失败", t);
                deletePackage();
                js("window.__updDone&&window.__updDone(" + err(String.valueOf(t.getMessage())) + ")");
            } finally {
                try { if (os != null) os.close(); } catch (Throwable ignore) {}
                try { if (in != null) in.close(); } catch (Throwable ignore) {}
                if (conn != null) conn.disconnect();
            }
        }, "apk-download");
        worker.setDaemon(true);
        worker.start();
    }

    private HttpURLConnection open(String u) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setInstanceFollowRedirects(false);      // 自己控制跳转（GitHub 302 → CDN）
        c.setConnectTimeout(CONNECT_TIMEOUT);
        c.setReadTimeout(READ_TIMEOUT);
        c.setRequestProperty("Accept", "application/octet-stream");
        c.setRequestProperty("User-Agent", "cigpricer-android");
        return c;
    }

    /**
     * 拉起系统安装器安装已下好的包。
     * ⚠️ 必须跑在主线程、且不能在下载线程里调（Android 12+ 认「用户点击触发」）。
     */
    void install() {
        ui.post(() -> {
            try {
                File f = apkFile();
                if (!f.isFile() || f.length() == 0) {
                    js("window.__updDone&&window.__updDone(" + err("还没下载安装包") + ")");
                    return;
                }
                if (Build.VERSION.SDK_INT >= 26 && !act.getPackageManager().canRequestPackageInstalls()) {
                    js("window.__updDone&&window.__updDone(" + err("NEED_UNKNOWN_SOURCE") + ")");
                    try {
                        Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                        s.setData(Uri.parse("package:" + act.getPackageName()));
                        act.startActivity(s);
                    } catch (Throwable t) {
                        Intent s2 = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        s2.setData(Uri.parse("package:" + act.getPackageName()));
                        try { act.startActivity(s2); } catch (Throwable ignore) {}
                    }
                    return;
                }

                Uri uri = Uri.parse("content://" + UpdateProvider.AUTHORITY + "/" + f.getName());
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                i.setComponent(null);
                // 🔴 必须在 startActivity **之前**记 attempt（持久化，因为装成功后是新进程）
                installAttemptVer = readMetaVersion();
                if (installAttemptVer != null && !installAttemptVer.isEmpty()) {
                    writeMeta(installAttemptVer, null, true);
                }
                act.startActivity(i);
                js("window.__updDone&&window.__updDone(" + new JSONObject().put("ok", true).put("installing", true) + ")");
            } catch (Throwable t) {
                Log.e(TAG, "拉起安装器失败", t);
                js("window.__updDone&&window.__updDone(" + err("拉起安装器失败：" + t.getMessage()) + ")");
            }
        });
    }

    /** 删掉下好的包（用户点「取消下载」/ 关面板时清缓存） */
    void clear() {
        deletePackage();
    }

    private void reportProgress(int pct, long done, long total) {
        final String jsStr = "window.__updProgress&&window.__updProgress(" + pct + ","
                + (done / 1048576.0) + "," + (total / 1048576.0) + ")";
        ui.post(() -> js(jsStr));
    }

    private static JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("err", msg == null ? "未知错误" : msg);
        } catch (Throwable ignore) {}
        return o;
    }

    private void js(final String code) {
        ui.post(() -> {
            try { web.evaluateJavascript(code, null); } catch (Throwable ignore) {}
        });
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xF, 16)).append(Character.forDigit(x & 0xF, 16));
        return sb.toString();
    }
}
