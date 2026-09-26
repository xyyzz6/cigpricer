#!/usr/bin/env node
'use strict';
/**
 * 把 build/烟价速查.html 打包成安卓 APK —— 不需要 Gradle，也不需要 Android Studio。
 *
 *   node android/build.js                # 正式包 → build/cigpricer.apk
 *   node android/build.js --debug        # 测试包（开 WebView 调试通道，便于 CDP 驱动验证）
 *   node android/build.js --out=D:/x.apk --clean
 *   node android/build.js --no-bump      # 版本号不变（反复打同一版本，调试用）
 *
 * 流程：aapt2 compile → aapt2 link → javac → d8 → 拼 zip → zipalign → apksigner
 *
 * 依赖：JDK 17（javac/keytool）+ Android SDK（build-tools / platforms）。
 * 打包用的 zip 读写是 android/lib/zip.js，零依赖，只用 Node 自带模块。
 *
 * ⚠️ 页面（assets/www/index.html）不在这里生成 —— 它由 python tools/build_app.py 产出，
 *    这个脚本只负责"装进壳里"。所以改了页面一定要**先重跑 build_app.py**，
 *    否则打出来的 APK 里是旧页面（build.js 里有一道新鲜度检查专门拦这个）。
 *
 * ⚠️ 关于"能不能用 sha256 判断包有没有变"：
 *    连打两次是**逐字节相同**的（时间戳全写 0，deflate 确定）。但**改注释也会让 sha256 变** ——
 *    javac 默认带 `-g`，class 文件里有 LineNumberTable，注释行数的增减会改掉行号，
 *    进而改掉 classes.dex 的字节。所以"只改了注释，包应该没变，不用重新验收"这个推理是**错的**：
 *    功能虽然等价，但校验和不会一致。改完源码就老老实实重跑一遍验收。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const zip = require('./lib/zip.js');

const HERE = __dirname;                       // .../cigpricer/android
const ROOT = path.dirname(HERE);              // .../cigpricer
const BUILD = path.join(HERE, 'build');
const GEN_RES = path.join(BUILD, 'gen-res');  // 生成的 bools.xml
const GEN_JAVA = path.join(BUILD, 'gen-java');// aapt2 生成的 R.java
const OBJ = path.join(BUILD, 'obj');
const DEX = path.join(BUILD, 'dex');

const APP = {
  pkg: 'com.boki.cigpricer',
  // 24 = Android 7.0。这个 App 只用 WebView + 几个标准控件，没有 native 库、没有第三方依赖，
  // 所以下限完全由"系统里的 WebView 够不够新"决定 —— 那是可以单独升级的组件，不用管系统版本。
  minApi: 24,
  targetApi: 34,
  // ---------------------------------------------------------------- 版本号
  // 🔴 这两个值是**上次打包留下的**，不是手写常量：每次打包会把涨完的新值写回本文件。
  //    versionName 涨末位（1.0.0 → 1.0.1 → 1.0.2 …），versionCode 每次 +1。
  //    versionCode 是安卓判断"谁更新"的唯一依据，只许单调递增 ——
  //    网上重装覆盖不了、提示"应用未安装"基本都是它变小或换签名导致的。
  //    想手动起一个新基线（比如发 1.1）就自己改这儿，下一轮从 1.1.1 接着涨。
  versionCode: 43,
  versionName: '1.0.42',
  keystore: path.join(HERE, 'cigpricer.keystore'),
  ksPass: 'cigpricer',
  ksAlias: 'cigpricer',
};

/** 页面源文件（build_app.py 的产物）。中文名，Node 在 Windows 下按 UTF-8 处理没问题。 */
const HTML = path.join(ROOT, 'build', '烟价速查.html');
/** 打进 APK 里的路径。**保持 ASCII**，免得某些 ROM 的解压/校验环节出岔子。 */
const HTML_IN_APK = 'assets/www/index.html';

const JVM_SMALL = ['-Xmx256m', '-XX:+UseSerialGC'];

const log = (...a) => console.log(...a);
const step = (n, t) => console.log('\n\x1b[36m[' + n + ']\x1b[0m ' + t);
const ok = (t) => console.log('    \x1b[32m✓\x1b[0m ' + t);
const warn = (t) => console.log('    \x1b[33m!\x1b[0m ' + t);

function fatal(msg) {
  console.error('\n\x1b[31m打包失败：\x1b[0m ' + msg + '\n');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (opts.capture) {
      if (e.stdout) console.error(e.stdout);
      if (e.stderr) console.error(e.stderr);
    }
    fatal('命令失败：' + path.basename(cmd) + ' ' + args.join(' '));
  }
}

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ 工具链

const exe = (p) => (process.platform === 'win32' && fs.existsSync(p + '.exe') ? p + '.exe' : p);

function findJavaHome() {
  const home = process.env.JAVA_HOME;
  if (home && fs.existsSync(path.join(home, 'bin', exe('java')))) return home;

  const bases = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs'),
    'C:/Program Files/Java',
    'C:/Program Files/Eclipse Adoptium',
    'C:/Program Files/Microsoft',
    'C:/Program Files/Android/Android Studio',
  ];
  const found = [];
  for (const b of bases) {
    if (!b || !fs.existsSync(b)) continue;
    for (const name of fs.readdirSync(b)) {
      const p = path.join(b, name);
      const bin = fs.existsSync(path.join(p, 'bin', 'java.exe'))
        ? path.join(p, 'bin')
        : fs.existsSync(path.join(p, 'jbr', 'bin', 'java.exe')) ? path.join(p, 'jbr', 'bin') : null;
      if (bin) found.push({ home: path.dirname(bin), rank: /jbr/i.test(bin) ? 1 : 0 });
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  if (found.length) return found[0].home;
  fatal('找不到 JDK。装一个 JDK 17 并设好 JAVA_HOME（或放在 %LOCALAPPDATA%\\Programs 下）。');
}

function findSdk() {
  const cands = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    'C:/Android/Sdk',
  ];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'build-tools')) && fs.existsSync(path.join(c, 'platforms'))) return c;
  }
  fatal('找不到 Android SDK。装好 SDK 后设 ANDROID_HOME 指向它。');
}

const verNum = (v) => v.split('.').map(Number).reduce((a, b) => a * 1000 + b, 0);

function pickBuildTools(sdk) {
  const dir = path.join(sdk, 'build-tools');
  const vs = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => verNum(a) - verNum(b));
  if (!vs.length) fatal('build-tools 目录是空的，用 sdkmanager 装一个（如 build-tools;34.0.0）。');
  return path.join(dir, vs[vs.length - 1]);
}

function pickAndroidJar(sdk, wantApi) {
  const dir = path.join(sdk, 'platforms');
  const vs = fs.readdirSync(dir).filter((v) => /^android-\d+$/.test(v))
    .map((v) => ({ v, n: parseInt(v.slice(8), 10) })).sort((a, b) => a.n - b.n);
  if (!vs.length) fatal('platforms 目录是空的，用 sdkmanager 装一个（如 platforms;android-34）。');
  const pick = vs.find((x) => x.n === wantApi) || vs[vs.length - 1];
  const jar = path.join(dir, pick.v, 'android.jar');
  if (!fs.existsSync(jar)) fatal('android.jar 不存在：' + jar);
  return { jar, api: pick.n };
}

// ------------------------------------------------------------------ 参数

function parseArgs() {
  const o = { out: path.join(ROOT, 'build', 'cigpricer.apk'), clean: false, noBump: false, debug: false, versionPinned: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--clean') o.clean = true;
    else if (a === '--debug') o.debug = true;
    else if (a === '--no-bump') o.noBump = true;
    else if (a.startsWith('--out=')) o.out = path.resolve(ROOT, a.slice(6));
    else if (a.startsWith('--version-name=')) { APP.versionName = a.slice(15); o.versionPinned = true; }
    else if (a.startsWith('--version-code=')) { APP.versionCode = parseInt(a.slice(15), 10); o.versionPinned = true; }
    else fatal('不认识的参数：' + a);
  }
  return o;
}

// ------------------------------------------------------------------ 版本号

function bumpVersionName(v) {
  const parts = String(v).trim().split('.');
  if (parts.length < 2) fatal('versionName 至少两位（如 1.0），拿到 ' + JSON.stringify(v));
  for (const p of parts) if (!/^\d+$/.test(p)) fatal('versionName 每段只能是数字：' + v);
  if (parts.length === 2) return parts[0] + '.' + parts[1] + '.1';
  const last = parts.length - 1;
  parts[last] = String(parseInt(parts[last], 10) + 1);
  return parts.join('.');
}

/**
 * 把涨完的版本号写回本文件。
 * 不写回去的话下次又从字面量那个旧值起涨 —— 结果每次都打出同一个版本号，
 * 看着"自动了"，其实永远停在第一次的值。这类自增最容易踩的坑就是只涨了内存里的副本。
 */
function writeBackVersion(code, name) {
  const src = fs.readFileSync(__filename, 'utf8');
  let out = src
    .replace(/(\n\s*versionCode:\s*)\d+(,)/, '$1' + code + '$2')
    .replace(/(\n\s*versionName:\s*)'[^']*'(,)/, "$1'" + name + "'$2");
  if (out === src) fatal('版本号没写回 build.js（正则没匹配上）—— 下次打包会重复用同一个版本号。');
  fs.writeFileSync(__filename, out);
  ok('版本号已写回 build.js：versionCode ' + code + ' / versionName ' + name);
}

function bumpVersion(o) {
  if (o.versionPinned) {
    log('  版本       ' + APP.versionName + ' (' + APP.versionCode + ')  \x1b[90m命令行指定\x1b[0m');
    writeBackVersion(APP.versionCode, APP.versionName);
    return;
  }
  if (o.noBump) {
    log('  版本       ' + APP.versionName + ' (' + APP.versionCode + ')  \x1b[90m--no-bump 保持\x1b[0m');
    return;
  }
  const oldName = APP.versionName, oldCode = APP.versionCode;
  APP.versionName = bumpVersionName(oldName);
  APP.versionCode = oldCode + 1;
  log('  版本       \x1b[1m' + oldName + ' → ' + APP.versionName + '\x1b[0m'
    + '  (versionCode ' + oldCode + ' → ' + APP.versionCode + ')');
  writeBackVersion(APP.versionCode, APP.versionName);
}

// ------------------------------------------------------------------ 前置检查

/**
 * ⚠️ 两道必查的事，都跟"XML 注释"有关。
 *
 * 1) **XML 注释里不能出现连续两个减号**（`--`）。这是 XML 规范硬性禁止的。
 *    在 manifest 里踩到后果极隐蔽：aapt2 解析失败后**不报错、直接退回默认 minSdk**，
 *    构建一路绿、装机也成功 —— 只有 aapt2 dump badging 才看得出 minSdk 是错的。
 *    res/ 里的后果没那么隐蔽（aapt2 会直接报 not well-formed），但报错信息只给行号，
 *    还是得人肉回去找，不如在这里一次性说清楚。
 *    💡 这个坑第二次踩是 2026-09-24：colors.xml 的注释里写了网页变量名 `--primary`。
 *       所以在 res/ 里写注释时，**别直接抄 CSS 变量名或命令行参数**。
 *
 * 2) manifest 里的 minSdkVersion 必须和 APP.minApi 一致 —— manifest 那份会赢过
 *    aapt2 的 min-sdk-version 参数，只改一处装机 dumpsys 看到的就是另一个值。
 */
function checkXml() {
  const files = [path.join(HERE, 'AndroidManifest.xml'), ...walk(path.join(HERE, 'res'), '.xml')];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/<!--([\s\S]*?)-->/g)) {
      if (m[1].includes('--')) {
        fatal(path.relative(ROOT, f) + ' 的 XML 注释里出现了连续两个减号（XML 不允许）。\n'
          + '      注释开头：' + JSON.stringify(m[1].trim().slice(0, 60)) + '\n'
          + '      写注释时别直接抄 CSS 变量名（--primary）或命令行参数（--debug）。');
      }
    }
  }

  const xml = fs.readFileSync(path.join(HERE, 'AndroidManifest.xml'), 'utf8');
  const m = xml.match(/android:minSdkVersion\s*=\s*"(\d+)"/);
  if (!m) fatal('AndroidManifest.xml 里没写 android:minSdkVersion');
  const inManifest = parseInt(m[1], 10);
  if (inManifest !== APP.minApi) {
    fatal('minSdk 不一致：manifest 是 ' + inManifest + '，build.js 的 APP.minApi 是 ' + APP.minApi
      + '。\n      manifest 里那份会赢，两处必须同时改。');
  }
  log('  minSdk     ' + inManifest + '（manifest 与 build.js 一致 ✓）');
  log('  XML 注释   ' + files.length + ' 个文件无连续减号 ✓');
}

/**
 * 页面必须存在、且不能是旧版。
 *
 * 这道检查拦的是"改了页面忘了重新生成 HTML，结果 APK 里是上一个版本"——
 * 那种包能装、能跑，只是功能是老样子，最难发现。
 */
function checkHtml() {
  if (!fs.existsSync(HTML)) {
    fatal('找不到页面文件：' + HTML + '\n      先跑： python tools/build_app.py');
  }
  const htmlM = fs.statSync(HTML).mtimeMs;
  const older = [];
  const watch = [
    path.join(ROOT, 'tools', 'app_template.html'),
    path.join(ROOT, 'tools', 'build_app.py'),
    path.join(ROOT, 'tools', 'plib.py'),
  ];
  for (const f of walk(path.join(ROOT, 'tables'), 'names.json')) watch.push(f);
  for (const f of watch) {
    if (fs.existsSync(f) && fs.statSync(f).mtimeMs > htmlM) older.push(path.relative(ROOT, f));
  }
  if (older.length) {
    fatal('页面比源文件旧，先重新生成 HTML： python tools/build_app.py\n'
      + '      下面这些文件比 ' + path.relative(ROOT, HTML) + ' 新：\n        ' + older.join('\n        '));
  }
  const html = fs.readFileSync(HTML, 'utf8');
  if (!html.includes('__backHook')) {
    fatal('页面里没有 window.__backHook —— 返回键会失灵（点了直接退出 App，而不是先关图/回搜索页）。\n'
      + '      检查 tools/app_template.html 里的返回键钩子是不是被删了。');
  }
  return { size: Buffer.byteLength(html, 'utf8'), mtime: htmlM };
}

function checkIcons() {
  const need = [];
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_fg.png']) {
      const p = path.join(HERE, 'res', 'mipmap-' + d, f);
      if (!fs.existsSync(p)) need.push(path.relative(ROOT, p));
    }
  }
  if (need.length) {
    fatal('缺少 ' + need.length + ' 个图标（例：' + need[0] + '）。\n      先跑： python tools/mkicon.py');
  }
  log('  图标       15 张就位（5 密度 × 方/圆/前景）');
}

// ------------------------------------------------------------------ 生成资源

function genResources(debug) {
  rmrf(GEN_RES);
  mkdirp(path.join(GEN_RES, 'values'));
  fs.writeFileSync(path.join(GEN_RES, 'values', 'build_flags.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
    + '    <!-- 由 build.js 生成，勿手改：WebView 调试通道开关 -->\n'
    + '    <bool name="webview_debug">' + (debug ? 'true' : 'false') + '</bool>\n'
    + '</resources>\n', 'utf8');
  ok('webview_debug = ' + debug + (debug ? '（测试包：可用 CDP 驱动 WebView）' : '（正式包：调试通道关闭）'));
}

// ------------------------------------------------------------------ 组装

function assemble(dexFiles, baseApk, apkOut) {
  const entries = zip.read(baseApk);                 // 原样保留 aapt2 写好的资源（含不压缩的 resources.arsc）
  const seen = new Set(entries.map((e) => e.name));

  for (const d of dexFiles) {
    const name = path.basename(d);
    if (seen.has(name)) continue;
    entries.push(zip.deflated(name, fs.readFileSync(d)));
  }

  const asset = zip.deflated(HTML_IN_APK, fs.readFileSync(HTML));
  if (seen.has(HTML_IN_APK)) fatal('assets 里已经有同名文件：' + HTML_IN_APK);
  entries.push(asset);

  // resources.arsc 放最前面（部分 ROM 按顺序找）
  const arsc = entries.filter((e) => e.name === 'resources.arsc');
  const rest = entries.filter((e) => e.name !== 'resources.arsc');
  const ordered = arsc.concat(rest);
  zip.write(apkOut, ordered);
  return ordered;
}

function sanityCheck(apk, htmlInfo) {
  const entries = zip.read(apk);
  const find = (n) => entries.find((e) => e.name === n);

  const arsc = find('resources.arsc');
  if (!arsc) fatal('APK 里没有 resources.arsc');
  if (arsc.method !== 0) fatal('resources.arsc 被压缩了（method=' + arsc.method + '），系统会拒绝加载');

  const dexes = entries.filter((e) => /^classes\d*\.dex$/.test(e.name));
  if (!dexes.length) fatal('APK 里没有 classes.dex');

  /* 正查：页面必须在包里，而且**必须和 build/ 里那份一模一样**。
     少了它 = 白屏；不一致 = 装着个旧版本（见 checkHtml 的注释）。 */
  const a = find(HTML_IN_APK);
  if (!a) fatal('APK 里没有 ' + HTML_IN_APK);
  const inApk = require('zlib').inflateRawSync(a.data);
  const h1 = crypto.createHash('sha256').update(inApk).digest('hex');
  const h2 = crypto.createHash('sha256').update(fs.readFileSync(HTML)).digest('hex');
  if (h1 !== h2) fatal('打进 APK 的页面和 build/ 里的不一致（打包过程中文件被改了？）');
  if (inApk.length !== htmlInfo.size) fatal('打进 APK 的页面长度不对');

  // 反向查：不该出现的东西
  for (const e of entries) {
    if (e.name.startsWith('assets/') && e.name !== HTML_IN_APK) {
      fatal('APK 里混进了多余的 assets 条目：' + e.name
        + '\n      这个 App 只需要 ' + HTML_IN_APK + '。');
    }
    if (e.name.startsWith('lib/')) {
      fatal('APK 里出现了 lib/ —— 这个 App 没有任何 native 库：' + e.name);
    }
  }

  return { entries, dexes, htmlBytes: inApk.length };
}

/** 权限自检：只允许 INTERNET（「认字」页签调 AI 用）与 REQUEST_INSTALL_PACKAGES（应用内更新拉起系统安装器）。
    2026-09-25 之前这里是"零权限"，认字做进 App 之后必须联网；2026-09-26 加应用内更新，
    又必须能拉起系统安装器（Android 12+ 还需用户在设置里手动开"允许来自此来源的应用"）。
    仍要守住"不读外部存储 / 不拿任何别的权限"这条线 —— 这才是这个 App 的底线。 */
function checkPermissions(aapt2, apk) {
  let out = '';
  try {
    out = execFileSync(aapt2, ['dump', 'permissions', apk], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    warn('aapt2 dump permissions 没跑起来，跳过权限检查');
    return;
  }
  const allowed = new Set([
    'android.permission.INTERNET',
    'android.permission.REQUEST_INSTALL_PACKAGES',
  ]);
  const got = (out.match(/uses-permission: name='([^']+)'/g) || [])
    .map((s) => s.replace(/uses-permission: name='/, '').replace(/'$/, ''));
  const extra = got.filter((p) => !allowed.has(p));
  if (extra.length) {
    fatal('APK 里出现了不该有的权限 —— 只允许 INTERNET + REQUEST_INSTALL_PACKAGES（认字联网 + 应用内更新）：\n'
      + extra.join('\n') + '\n' + out);
  }
  if (!got.includes('android.permission.INTERNET')) {
    warn('APK 里没有 INTERNET 权限 —— 「认字」页签会调不通（其余功能不受影响）');
  }
  const have = got.map((p) => p.replace('android.permission.', '')).join(' + ') || '（无）';
  ok('权限干净：' + have + '（搜索看图换照片全离线）');
}

// ------------------------------------------------------------------ 主流程

function main() {
  const t0 = Date.now();
  const o = parseArgs();

  const javaHome = findJavaHome();
  const sdk = findSdk();
  const bt = pickBuildTools(sdk);
  const { jar: androidJar, api: platformApi } = pickAndroidJar(sdk, APP.targetApi);
  const java = path.join(javaHome, 'bin', exe('java'));
  const keytool = path.join(javaHome, 'bin', exe('keytool'));
  const aapt2 = exe(path.join(bt, 'aapt2'));
  const zipalign = exe(path.join(bt, 'zipalign'));
  const d8Jar = path.join(bt, 'lib', 'd8.jar');
  const signerJar = path.join(bt, 'lib', 'apksigner.jar');
  for (const p of [aapt2, zipalign, d8Jar, signerJar, androidJar]) {
    if (!fs.existsSync(p)) fatal('缺少工具：' + p);
  }

  log('\x1b[1m烟价速查 · 打包 APK\x1b[0m');
  log('  JDK        ' + javaHome);
  log('  Android SDK ' + sdk + '  (build-tools ' + path.basename(bt) + ', ' + path.basename(path.dirname(androidJar)) + ')');
  log('  目标       min ' + APP.minApi + ' / target ' + APP.targetApi + ', 平台 android-' + platformApi);
  log('  包名       ' + APP.pkg + (o.debug ? '   \x1b[33m[测试包 --debug]\x1b[0m' : ''));

  // 前置检查排在涨版本号之前：检查不过就不该动版本号
  checkXml();
  const htmlInfo = checkHtml();
  checkIcons();
  log('  页面       ' + path.relative(ROOT, HTML) + '  ' + (htmlInfo.size / 1024 / 1024).toFixed(2) + ' MB');

  bumpVersion(o);

  if (o.clean) { rmrf(BUILD); ok('已清空 build/'); }
  for (const d of [GEN_RES, GEN_JAVA, OBJ, DEX]) mkdirp(d);

  // 1) 资源
  step(1, 'aapt2 compile —— 编译资源');
  genResources(o.debug);
  const resZip = path.join(BUILD, 'res.zip');
  const genZip = path.join(BUILD, 'gen-res.zip');
  run(aapt2, ['compile', '--dir', path.join(HERE, 'res'), '-o', resZip]);
  run(aapt2, ['compile', '--dir', GEN_RES, '-o', genZip]);
  ok('资源编译完成');

  // 2) 链接
  step(2, 'aapt2 link —— 链接资源，产出基础 APK');
  const baseApk = path.join(BUILD, 'base.apk');
  run(aapt2, [
    'link', '-o', baseApk,
    '-I', androidJar,
    '--manifest', path.join(HERE, 'AndroidManifest.xml'),
    '--java', GEN_JAVA,
    '--min-sdk-version', String(APP.minApi),
    '--target-sdk-version', String(APP.targetApi),
    '--version-code', String(APP.versionCode),
    '--version-name', APP.versionName,
    resZip, genZip,
  ]);
  const rJava = walk(GEN_JAVA, 'R.java');
  if (!rJava.length) fatal('aapt2 没有生成 R.java');
  ok('基础 APK + R.java');

  // 3) 编译 Java
  step(3, 'javac —— 编译 Java 源码');
  const sources = walk(path.join(HERE, 'src'), '.java').concat(rJava);
  run(path.join(javaHome, 'bin', exe('javac')), [
    '-source', '8', '-target', '8', '-Xlint:-options',
    '-encoding', 'UTF-8',
    '-classpath', androidJar,
    '-d', OBJ,
    ...sources,
  ]);
  ok(sources.length + ' 个源文件 → ' + walk(OBJ, '.class').length + ' 个 class');

  // 4) dex
  step(4, 'd8 —— 转成 Dalvik 字节码');
  rmrf(DEX); mkdirp(DEX);
  run(java, [
    ...JVM_SMALL,
    '-cp', d8Jar, 'com.android.tools.r8.D8',
    '--release', '--lib', androidJar, '--min-api', String(APP.minApi),
    '--output', DEX,
    ...walk(OBJ, '.class'),
  ]);
  const dexFiles = walk(DEX, '.dex');
  if (!dexFiles.length) fatal('d8 没有产出 .dex');
  ok(dexFiles.map((d) => path.basename(d)).join(', '));

  // 5) 组装
  step(5, '组装 —— 把 dex 和页面塞进基础 APK');
  const unsigned = path.join(BUILD, 'unsigned.apk');
  const entries = assemble(dexFiles, baseApk, unsigned);
  const chk = sanityCheck(unsigned, htmlInfo);
  ok(entries.length + ' 个条目（' + chk.dexes.length + ' 个 dex，resources.arsc 未压缩）');
  ok('页面已内嵌并逐个字节核对：' + (chk.htmlBytes / 1024 / 1024).toFixed(2) + ' MB');

  // 6) 对齐
  step(6, 'zipalign —— 4 字节对齐');
  const aligned = path.join(BUILD, 'aligned.apk');
  run(zipalign, ['-f', '-p', '4', unsigned, aligned]);
  ok('对齐完成');

  // 7) 签名
  step(7, 'apksigner —— 签名');
  if (!fs.existsSync(APP.keystore)) {
    run(keytool, [
      '-genkeypair', '-keystore', APP.keystore,
      '-alias', APP.ksAlias,
      '-storepass', APP.ksPass, '-keypass', APP.ksPass,
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
      '-dname', 'CN=CigPricer,O=Boki,C=CN',
    ]);
    ok('已生成 cigpricer.keystore（升级覆盖安装要一直用它，别删）');
  }
  mkdirp(path.dirname(o.out));
  run(java, [
    ...JVM_SMALL,
    '-cp', signerJar, 'com.android.apksigner.ApkSignerTool', 'sign',
    '--ks', APP.keystore,
    '--ks-pass', 'pass:' + APP.ksPass,
    '--key-pass', 'pass:' + APP.ksPass,
    '--ks-key-alias', APP.ksAlias,
    '--min-sdk-version', String(APP.minApi),
    '--out', o.out, aligned,
  ]);
  const verify = run(java, [
    ...JVM_SMALL,
    '-cp', signerJar, 'com.android.apksigner.ApkSignerTool', 'verify',
    '--min-sdk-version', String(APP.minApi), '--verbose', o.out,
  ], { capture: true });
  if (!/Verified using v\d+ scheme/.test(verify || '')) fatal('签名校验没过：\n' + verify);
  ok('签名校验通过');

  checkPermissions(aapt2, o.out);

  const size = fs.statSync(o.out).size;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(o.out)).digest('hex');
  log('\n\x1b[32m完成\x1b[0m  ' + o.out);
  log('       v' + APP.versionName + ' (' + APP.versionCode + ')   '
    + (size / 1024 / 1024).toFixed(2) + ' MB,  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  log('       sha256 ' + sha);
  log('\n装到手机： adb install -r "' + o.out + '"');
}

main();
