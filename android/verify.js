#!/usr/bin/env node
'use strict';
/**
 * 在模拟器/真机上验证 APK —— 装包、启动、用 CDP 驱动 WebView 跑断言、截图。
 *
 *   node android/verify.js                 # 装现有 APK 并验证
 *   node android/verify.js --no-install    # 只验证（App 已在机器上）
 *   node android/verify.js --serial=127.0.0.1:16384
 *
 * 为什么整个流程要在一个 Node 进程里跑完：
 *   adb daemon 会在两次工具调用之间被回收，`adb forward` 的规则随 daemon 一起没了。
 *   所以「连接 → 找 socket → forward → 跑 CDP → 截图」必须一口气做完，
 *   分两条命令的话第二条必然连不上。
 *
 * 为什么用 CDP 而不是 adb input tap：
 *   整个 App 就是一页 WebView，uiautomator dump 只能看到一个 web 节点、内层 bounds 拿不到，
 *   tap 全凭目测坐标。CDP 直接在页面里跑 JS，稳且能断言副作用。
 *
 * ⚠️ 返回键这种"原生行为"仍然要用 adb keyevent —— CDP 碰不到系统返回。
 *    所以这个脚本里 adb 和 CDP 是交替使用的。
 *
 * 报告同时写到 android/build/verify-report.txt（UTF-8），
 * 因为 Windows 控制台的中文经常是乱码，看文件更可靠。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.dirname(__dirname);
const APK = path.join(ROOT, 'build', 'cigpricer.apk');
const FIXTURE_DIR = path.join(ROOT, 'tools', 'fixtures');
const REPORT_DIR = path.join(__dirname, 'build');
const REPORT = path.join(REPORT_DIR, 'verify-report.txt');
const SHOTS = path.join(ROOT, 'shots-apk');

const PKG = 'com.boki.cigpricer';
const ACTIVITY = PKG + '/.MainActivity';
const ORIGIN = 'https://appassets.androidplatform.net';
const PORT = 9222;

const lines = [];
const log = (s) => { console.log(s); lines.push(s); };
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; log('  PASS  ' + name + (detail === undefined ? '' : '   [' + detail + ']')); }
  else { fail++; log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + detail + ']')); }
}

function findAdb() {
  const c = [
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') : null,
    'C:/Program Files/Netease/MuMu/nx_main/adb.exe',
  ];
  for (const p of c) if (p && fs.existsSync(p)) return p;
  throw new Error('找不到 adb');
}

const ADB = findAdb();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(args, opts = {}) {
  return execFileSync(ADB, args, {
    encoding: opts.binary ? 'buffer' : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseArgs() {
  const o = { serial: '127.0.0.1:16384', install: true, apk: APK };
  for (const a of process.argv.slice(2)) {
    if (a === '--no-install') o.install = false;
    else if (a.startsWith('--serial=')) o.serial = a.slice(9);
    // 用 --debug 打的包才带 WebView 调试通道；正式包装了它也连不上，只能做人工验收
    else if (a.startsWith('--apk=')) o.apk = path.resolve(ROOT, a.slice(6));
    else throw new Error('不认识的参数：' + a);
  }
  return o;
}

// ------------------------------------------------------------------ CDP

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function connect() {
  const targets = await getJson('http://127.0.0.1:' + PORT + '/json');
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith(ORIGIN));
  if (!page) throw new Error('找不到 App 的 WebView 页面（url 前缀应为 ' + ORIGIN + '）。看看 adb forward 是否还有效。');

  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    }
  });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async function(){ ${expr} })()`,
      returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面 JS 抛异常：' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    }
    return r.result && r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');
  return { send, ev, ws, page };
}

async function waitReady(ev, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 30000)) {
    if (await ev('return window.__ready === true')) return true;
    await sleep(400);
  }
  return false;
}

// ------------------------------------------------------------------ 设备操作

function screencap(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const buf = adb(['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true });
  const p = path.join(SHOTS, name);
  fs.writeFileSync(p, buf);
  log('        截图 → shots-apk/' + name + '  (' + Math.round(buf.length / 1024) + ' KB)');
}

/** 前台残留的 Activity 里有没有我们的 App（用来判断"返回键有没有把 App 退掉"） */
function appForeground() {
  const d = adb(['-s', serial, 'shell', 'dumpsys activity activities']);
  const hits = d.split('\n').filter((l) => /ResumedActivity/.test(l));
  return hits.some((l) => l.indexOf(PKG) >= 0);
}

function currentActivity() {
  const d = adb(['-s', serial, 'shell', 'dumpsys activity activities']);
  const m = d.match(/(?:topResumedActivity|ResumedActivity)[^\n]*?([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/);
  return m ? m[1] : '(未知)';
}

/** uiautomator dump 出来的界面 XML。
 *  ⚠️ 这台 MuMu / Android 15 上 `uiautomator dump` 会**成功写出文件、却返回非零退出码**
 *     （输出里明明有 "UI hierchary dumped to: ..."）。所以这里绝不能让它抛错 ——
 *     要看的是 dump 出来的 XML 本身，不是退出码。 */
function dumpUi() {
  const TMP = '/sdcard/window_dump.xml';
  try { adb(['-s', serial, 'shell', 'rm', '-f', TMP]); } catch (e) { /* 无所谓 */ }
  try { adb(['-s', serial, 'shell', 'uiautomator', 'dump', TMP]); } catch (e) { /* 退出码非零是正常的，见上 */ }
  try { return adb(['-s', serial, 'shell', 'cat', TMP]); } catch (e) { return ''; }
}

/** 从界面 XML 里找「照片格子」：content-desc 形如「拍摄于 2026年9月24日 下午8:10:24的照片」的可点节点。
 *  有多个时取最靠左上那个 —— 我们刚推的这张是最新的，在系统选择器的「最近」里排第一。
 *  这样就不用把选择器的布局坐标写死在脚本里（写死了换个机型/换个系统版本必然点空）。 */
function findPhotoCell(xml) {
  const cells = [];
  for (const s of xml.split('<node').slice(1)) {
    const head = s.split('>')[0];
    if (head.indexOf('拍摄于') < 0) continue;
    const m = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(head);
    if (!m) continue;
    const x1 = +m[1], y1 = +m[2], x2 = +m[3], y2 = +m[4];
    cells.push({ x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) });
  }
  cells.sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1));
  return cells[0] || null;
}

let serial = '127.0.0.1:16384';

// ------------------------------------------------------------------ 主流程

async function main() {
  const o = parseArgs();
  serial = o.serial;

  log('烟价速查 · 真机/模拟器验证');
  log('  adb     ' + ADB);
  log('  设备    ' + serial);
  log('');

  adb(['connect', serial]);
  const devs = adb(['devices']);
  if (devs.indexOf(serial + '\tdevice') < 0) {
    throw new Error('设备不在线：' + serial + '\n' + devs);
  }
  const size = adb(['-s', serial, 'shell', 'wm', 'size']).trim();
  const dens = adb(['-s', serial, 'shell', 'wm', 'density']).trim();
  const ver = adb(['-s', serial, 'shell', 'getprop', 'ro.build.version.release']).trim();
  log('  画面    ' + size.replace(/\s+/g, ' ') + '   ' + dens.replace(/\s+/g, ' ') + '   Android ' + ver);
  log('');

  if (o.install) {
    log('[1] 安装 APK');
    log('     ' + path.relative(ROOT, o.apk));
    /* ⚠️ 先卸掉再装，不能只用 install -r：
       交付用的正式包 versionCode 每次打包 +1，调试包是 --no-bump 打的（固定低位），
       设备上常常装着版本号更高的正式包 → INSTALL_FAILED_VERSION_DOWNGRADE，
       整个验证一条都不跑（错误只有一行，grep 容易漏）。
       而 `install -d`（允许降级）**只对 debuggable 包有效**，我们的壳没开
       android:debuggable，所以 -d 也救不了。卸载顺带保证是干净状态。 */
    try { adb(['-s', serial, 'uninstall', PKG]); } catch (e) { /* 本来就没装 */ }
    const out = adb(['-s', serial, 'install', o.apk]);
    check('安装成功', /Success/.test(out), out.trim().split('\n').pop());
    log('');
  }

  log('[2] 启动 App 并建立 WebView 调试通道');
  adb(['-s', serial, 'shell', 'am', 'force-stop', PKG]);
  adb(['-s', serial, 'logcat', '-c']);
  adb(['-s', serial, 'shell', 'am', 'start', '-n', ACTIVITY]);
  await sleep(5000);

  // socket 名要去掉开头的 @；MuMu 上可能有多个 webview 进程，取第一个
  const unix = adb(['-s', serial, 'shell', 'cat', '/proc/net/unix']);
  const m = unix.match(/@?(webview_devtools_remote_\d+)/);
  if (!m) throw new Error('没有 webview_devtools_remote socket —— WebView 调试通道没开？\n'
    + '（--debug 打的包才会开；正式包的 webview_debug 是 false）');
  adb(['-s', serial, 'forward', '--remove-all']);
  adb(['-s', serial, 'forward', 'tcp:' + PORT, 'localabstract:' + m[1]]);
  check('调试通道已建立', true, m[1]);

  const { send, ev, ws, page } = await connect();
  check('页面来源是虚拟 https 域（IndexedDB 可用的前提）', page.url.startsWith(ORIGIN), page.url);
  check('页面已就绪（__ready）', await waitReady(ev, 30000));

  /* css 像素 → 设备像素：× dpr(=density/160)，再加 WebView 在屏幕上的原点 Y
     （状态栏高度，CDP target 的 description 里有）。
     正式包没有调试通道、取不到坐标 —— 所以下面会把点按坐标存成 tap-points.json，
     交给 android/acceptance.js 去对**正式包**做真机点击验收。 */
  const dpr = 3;
  const webTop = (page.description && JSON.parse(page.description).screenY) || 0;
  const taps = {};
  const recordTap = async (key, selector) => {
    const p = JSON.parse(await ev(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)})`));
    taps[key] = { x: Math.round(p.x * dpr), y: Math.round(webTop + p.y * dpr), css: p };
  };
  log('');

  // ---------------------------------------------------------------- A. 冷启动
  log('[3] 冷启动状态');
  check('IndexedDB 可用（STORE_OK）', await ev('return STORE_OK') === true, await ev('return STORE_WHY'));
  check('表数 = 1（只有内置的香烟表）', await ev('return TBL.length') === 1, await ev('return JSON.stringify(TBL.map(t=>t.name))'));
  check('商品总数 = 327', await ev('return IT.length') === 327, await ev('return IT.length'));
  check('首屏品牌快捷入口 >= 10 个', await ev('return document.querySelectorAll("#hot .chips b").length') >= 10,
    await ev('return document.querySelectorAll("#hot .chips b").length'));
  check('无横向溢出', await ev('return document.documentElement.scrollWidth <= window.innerWidth + 1'),
    await ev('return document.documentElement.scrollWidth + " vs " + window.innerWidth'));
  check('状态栏/窗口底不与页面冲突（页面顶栏可见）',
    await ev('return document.querySelector("header").getBoundingClientRect().top') >= 0,
    await ev('return Math.round(document.querySelector("header").getBoundingClientRect().top)'));
  await recordTap('tab搜索', '.tabs button[data-tab="p-search"]');
  await recordTap('tab管理', '.tabs button[data-tab="p-mgr"]');
  await recordTap('搜索框', '#q');
  screencap('01-首屏.png');

  log('');
  log('[4] 搜索与看图');
  await ev('const q=document.querySelector("#q");q.value="感恩";q.dispatchEvent(new Event("input",{bubbles:true}));return 1');
  await sleep(700);
  const hits = JSON.parse(await ev('return JSON.stringify(search("感恩").map(x=>x.n))'));
  check('搜「感恩」能命中中支感恩黄鹤楼', hits.includes('中支感恩黄鹤楼'), JSON.stringify(hits.slice(0, 4)));
  check('结果卡片渲染出来了', await ev('return document.querySelectorAll("#res .card").length') > 0,
    await ev('return document.querySelectorAll("#res .card").length'));
  screencap('02-搜索.png');

  await ev('document.querySelector("#res .card").click();return 1');
  await sleep(600);
  check('全屏看图打开', await ev('return document.querySelector("#viewer").classList.contains("on")'));
  check('大图有内容（内嵌 data URI 正常解码）',
    await ev('return document.querySelector("#vimg").naturalWidth') > 0,
    await ev('return document.querySelector("#vimg").naturalWidth + "px"'));
  screencap('03-全屏看图.png');
  await ev('document.querySelector("#vclose").click();return 1');
  await sleep(400);
  check('关闭全屏看图', !(await ev('return document.querySelector("#viewer").classList.contains("on")')));

  // ---------------------------------------------------------------- B. 导入表包
  log('');
  log('[5] 导入表包（管理页）');
  await ev('document.querySelector(".tabs button[data-tab=\'p-mgr\']").click();return 1');
  await sleep(800);
  check('管理页列出 1 张表', await ev('return document.querySelectorAll("#mgrlist .trow").length') === 1,
    await ev('return document.querySelectorAll("#mgrlist .trow").length'));
  await ev('document.querySelector("#mgrlist button[data-del=\'b:香烟\']") && 0; return 1');   // 仅确认可定位
  check('内置表带删除按钮', await ev('return !!document.querySelector("#mgrlist button[data-del]")'));
  await recordTap('导入表包', '.impbtn');
  screencap('04-管理页.png');

  /* 导入：把表包内容合成一个 File 塞进 input。
     ⚠️ 这里绕过了系统文件选择器（DOM.setFileInputFiles 的 files 参数是**设备端**路径，
        而表包在电脑上；推到 /sdcard 又会被分区存储挡住读权限）。
        所以这里测的是"读文件之后的全部逻辑"，包括最关键的一条：存进 IndexedDB。
        系统选择器那一段单独在 [8] 里验（点按钮看有没有真的拉起选择器）。 */
  const pack = fs.readFileSync(path.join(FIXTURE_DIR, '测试酒水.cigtable.json'), 'utf8');
  await ev(`const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(pack)}], '测试酒水.cigtable.json', {type:'application/json'}));
    const inp = document.querySelector('#impfile');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', {bubbles:true}));
    return 1`);
  await sleep(2500);
  check('导入后表数 = 2', await ev('return TBL.length') === 2, await ev('return JSON.stringify(TBL.map(t=>t.name))'));
  check('导入后商品数 = 327 + 6', await ev('return IT.length') === 333, await ev('return IT.length'));
  check('导入的表能搜到（飞天茅台）', await ev('return search("飞天茅台").length') > 0,
    await ev('return search("飞天茅台").length'));
  check('导入的表标了「导入的」', await ev('return document.querySelectorAll("#mgrlist .src.im").length') === 1);
  check('已写入 IndexedDB 存档', await ev('return dbAll().then(a=>a.length)') === 1,
    await ev('return dbAll().then(a=>a.length)'));
  screencap('05-管理页-导入后.png');

  // ---------------------------------------------------------------- C. 持久化
  log('');
  log('[6] 重新加载后是否还在（IndexedDB 真的落盘了吗）');
  await send('Page.reload');
  await sleep(1500);
  check('重载后页面又就绪', await waitReady(ev, 30000));
  check('重载后 IndexedDB 仍可用', await ev('return STORE_OK') === true);
  check('重载后导入的表还在', await ev('return TBL.length') === 2, await ev('return JSON.stringify(TBL.map(t=>t.name))'));
  check('重载后仍能搜到导入表里的商品', await ev('return search("飞天茅台").length') > 0);
  check('重载后内置表也还在', await ev('return search("玉溪").length') > 0);

  // ---------------------------------------------------------------- D. 清理
  log('');
  log('[7] 清掉导入的表，恢复出厂状态');
  await ev('document.querySelector(".tabs button[data-tab=\'p-mgr\']").click();return 1');
  await sleep(600);
  await ev('document.querySelector("#mgrlist button[data-del=\'测试酒水\']").click();return 1');
  await sleep(1800);
  check('删除后表数 = 1', await ev('return TBL.length') === 1, await ev('return JSON.stringify(TBL.map(t=>t.name))'));
  check('删除后存档也空了', await ev('return dbAll().then(a=>a.length)') === 0, await ev('return dbAll().then(a=>a.length)'));
  check('已回到只有内置表', await ev('return search("玉溪").length') > 0);

  /* ------------------------------------------------- D1. 彻底删掉内置表
     店主 2026-09-24 的原话：「我要同时添加很多张图片，再把内置的删掉」。
     上一节的「删除」只是把它放进「已移除」（可恢复），他觉得不够干净 ——
     这里验「彻底删掉」：点两次才生效，之后不进「已移除」、重载也不回来。
     它写的是持久化黑名单，所以**必须在设备上验一遍**：万一本机存储有差异，
     店主看到的就是"删了又自己回来"。 */
  log('');
  log('[7a] 彻底删掉内置表：不进「已移除」、重载也不回来');
  await ev('document.querySelector("#mgrlist button[data-del=\'b:香烟\']").click();return 1');
  await sleep(1400);
  check('删除后先进「已移除」', await ev('return document.querySelectorAll("#mgrhidden .trow").length') === 1,
    await ev('return document.querySelectorAll("#mgrhidden .trow").length'));
  await ev('document.querySelector("#mgrhidden button[data-purge]").click();return 1');
  await sleep(600);
  const armTxt = await ev('return document.querySelector("#mgrhidden button[data-purge]").textContent');
  check('第一次点只是武装（按钮变「再点一次」）',
    (armTxt === '再点一次') && (await ev('return document.querySelectorAll("#mgrhidden .trow").length') === 1),
    armTxt);
  screencap('07-管理页-彻底删掉-待确认.png');
  await ev('document.querySelector("#mgrhidden button[data-purge]").click();return 1');
  await sleep(1400);
  check('第二次点才真删', await ev("return TBL.some(t=>t.name==='香烟')") === false,
    await ev('return JSON.stringify(TBL.map(t=>t.name))'));
  check('彻底删掉后「已移除」是空的',
    await ev('return document.querySelectorAll("#mgrhidden .trow").length') === 0);
  check('彻底删掉写进了本机存档',
    (await ev('return localStorage.getItem("cigpricer.removed")') || '').indexOf('x:香烟') >= 0,
    await ev('return localStorage.getItem("cigpricer.removed")'));

  // 重载一次：确认不是"暂时藏起来"
  await send('Page.reload');
  await sleep(1500);
  check('重载后页面又就绪', await waitReady(ev, 30000));
  await ev('document.querySelector(".tabs button[data-tab=\'p-mgr\']").click();return 1');
  await sleep(900);
  check('重载后内置表仍然不在', await ev("return TBL.some(t=>t.name==='香烟')") === false,
    await ev('return JSON.stringify(TBL.map(t=>t.name))'));
  check('重载后「已移除」里也没有它',
    await ev('return document.querySelectorAll("#mgrhidden .trow").length') === 0);

  /* 还原现场：下一节 [7b] 换照片还要用这张内置表。「彻底删掉」只动名单 ——
     清掉标记它就该回来，顺带证明数据（照片、切图）一直都在。 */
  await ev('REMOVED.delete(XKEY + \'香烟\'); saveRemoved(); rebuild(); applyAll(); return 1');
  await sleep(700);
  check('清掉标记内置表就回来（照片和切图一直在）', await ev("return TBL.some(t=>t.name==='香烟')"),
    await ev('return JSON.stringify(TBL.map(t=>t.name))'));

  // ---------------------------------------------------------------- D2. 换照片
  log('');
  log('[7b] 换照片：相册里选一张新价格照，App 自己切格（店主最常用的更新方式）');
  /* ⚠️ 手机上不能用 DOM.setFileInputFiles —— 它的 files 参数是**设备端**路径，
     而照片在电脑上；推到 /sdcard 又会被分区存储挡住读权限。
     所以用 DataTransfer 合成一个 File 直接塞进 input.files
     （2026-09-24 在 MuMu 上真跑过，页面代码一路走通）。
     代价是绕过了"从磁盘读文件"那一步，所以系统选择器单独在 [9] 里验。
     "给哪张表换"写进 input 的 dataset.key —— 等价于点那行的「换照片」按钮，
     但不会弹出选择器把 App 推到后台。 */
  const photoB64 = fs.readFileSync(path.join(ROOT, 'tables', '香烟', 'list.jpg')).toString('base64');
  await ev('document.querySelector(".tabs button[data-tab=\'p-mgr\']").click();return 1');
  await sleep(700);
  check('表行有「换照片」按钮', await ev('return !!document.querySelector("#mgrlist button[data-photo]")'));
  /* ⚠️ 量「换照片」按钮坐标之前必须把页面上那条提示收起来。
     上面刚删过表，flash 还挂着 12 秒，它会把表行往下推 ~80 css px；
     而正式包验收（android/acceptance.js）是"干净安装后进管理页"，
     页面上没有提示 —— 用带提示的坐标去点正式包，就会点空
     （实测偏差 247 device px，点在提示文字上，选择器根本不弹）。
     所以量的那一刻，页面状态必须和用它的那一刻一致。 */
  await ev('document.querySelector("#mgrmsg").className = "msg"; return 1');
  await sleep(300);
  await recordTap('换照片', '#mgrlist button[data-photo]');
  screencap('08-管理页-有换照片按钮.png');
  const builtinLen = await ev('return RAW.tables[0].items[0].img.length');

  const t0 = Date.now();
  await ev(`(() => {
    const inp = document.querySelector('#shootfile');
    inp.dataset.key = 'b:香烟';
    const b64 = ${JSON.stringify(photoB64)};
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'list.jpg', { type: 'image/jpeg' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  })()`);
  await sleep(800);
  check('切图时出现进度遮罩', await ev('return document.querySelector("#busy").classList.contains("on")'));
  screencap('09-管理页-切图中.png');
  let idle = false;
  for (let i = 0; i < 160; i++) {
    if (!(await ev('return document.querySelector("#busy").classList.contains("on")'))) { idle = true; break; }
    await sleep(500);
  }
  check('切图完成（进度遮罩收起）', idle, ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
  await sleep(800);
  check('换照片后仍是 1 张表（不会多出一张）', await ev('return TBL.length') === 1,
    await ev('return JSON.stringify(TBL.map(t=>t.name))'));
  check('换过的表标了「换过照片」', await ev('return TBL[0].src') === 'photo', await ev('return TBL[0].src'));
  check('商品数没变（名字沿用上一版）', await ev('return IT.length') === 327, await ev('return IT.length'));
  check('确实换成了新切的图', await ev('return TBL[0].items[0].img.length') !== builtinLen,
    builtinLen + ' → ' + await ev('return TBL[0].items[0].img.length'));
  check('提示语说「已用新照片更新」',
    (await ev('return document.querySelector("#mgrmsg").textContent')).indexOf('已用新照片更新') >= 0);
  check('出现「撤销」按钮', await ev('return !!document.querySelector("#mgrlist button[data-undo]")'));
  check('表和备份都写进了 IndexedDB', await ev('return dbAll().then(a=>a.length)') === 2,
    await ev('return dbAll().then(a=>a.length)'));
  check('换过照片后仍能搜到商品', await ev('return search("玉溪").length') > 0);
  check('新切的格子图能正常解码', await ev(`return new Promise(res => {
    const im = new Image();
    im.onload = () => res(im.naturalWidth > 0 && im.naturalHeight > 0);
    im.onerror = () => res(false);
    im.src = TBL[0].items[0].img;
  })`));
  screencap('10-管理页-换过照片.png');

  // 重载：换过的照片必须还在（IndexedDB 真的落盘了）
  await send('Page.reload');
  await sleep(1800);
  check('重载后页面又就绪', await waitReady(ev, 30000));
  check('重载后换过的照片还在', await ev('return TBL.length') === 1 && await ev('return TBL[0].src') === 'photo',
    await ev('return TBL[0].src'));
  check('重载后撤销按钮还在', await ev('return !!document.querySelector("#mgrlist button[data-undo]")'));

  // 撤销 = 退回换照片之前（内置那张）
  await ev('document.querySelector("#mgrlist button[data-undo]").click();return 1');
  await sleep(2500);
  check('撤销后回到内置的那张', await ev('return TBL[0].src') === 'builtin', await ev('return TBL[0].src'));
  check('撤销后图也换回内置那份', await ev('return TBL[0].items[0].img.length') === builtinLen,
    await ev('return TBL[0].items[0].img.length'));
  check('撤销后本机存档清空', await ev('return dbAll().then(a=>a.length)') === 0,
    await ev('return dbAll().then(a=>a.length)'));

  // ------------------------------------------------- D2b. 用照片加表（不经过助手）
  log('');
  log('[7d] 用照片加表：店主「同时加很多张照片」走的就是这条路');
  /* 桌面 Edge 已经全绿（smoke），设备上要单独确认的是最容易"桌面全绿、手机不动"的两件事：
       ① createImageBitmap 解真实 JPEG 的 EXIF 方向；
       ② CompressionStream('deflate') 编码 indexed PNG —— 老 WebView 可能压根没有。
     这里仍用 DataTransfer 合成 File（和 [7b] 一样），因为"从系统相册选文件"那一步 [7c] 单独验过。 */
  /* 先守一条最容易在设备上翻车的：照片塞进「导入表包」那个口子。
     店主的原话是「app 导入不了图片」（2026-09-24）—— 现在两个入口都吃照片，
     这里必须确认 acceptFiles 真的把它转成了「用照片加表」（弹出起名框），
     而不是又吐一句 JSON 报错。取消掉，不真的建表。 */
  await ev(`(() => {
    const inp = document.querySelector('#impfile');
    const b64 = ${JSON.stringify(photoB64)};
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'list.jpg', { type: 'image/jpeg' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  })()`);
  await sleep(1200);
  check('照片从「导入表包」进来：转给「用照片加表」（弹起名框，不报错）',
    await ev(`return document.querySelector('#askname').classList.contains('on')`));
  check('起名框提醒了"想更新价格该去点换照片"',
    (await ev(`return document.querySelector('#askbd').textContent`)).indexOf('换照片') >= 0);
  screencap('09a-照片从导入表包进来.png');
  await ev(`document.querySelector('#askcancel').click(); return 1`);
  await sleep(700);
  check('取消后表数不变', await ev('return TBL.length') === 1,
    await ev('return JSON.stringify(TBL.map(t=>t.name))'));

  const beforeAdd = await ev('return TBL.length');
  await ev(`(() => {
    const inp = document.querySelector('#newfile');
    const b64 = ${JSON.stringify(photoB64)};
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'list.jpg', { type: 'image/jpeg' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  })()`);
  await sleep(1500);
  check('选完照片弹出起名输入框',
    await ev(`return document.querySelector('#askname').classList.contains('on')`));
  screencap('09b-用照片加表-起名.png');

  await ev(`document.querySelector('#askinp').value = '设备测试表'; return 1`);
  await ev(`document.querySelector('#askok').click(); return 1`);
  await sleep(1000);
  check('切图时出现进度遮罩', await ev('return document.querySelector("#busy").classList.contains("on")'));
  let idleAdd = false;
  for (let i = 0; i < 160; i++) {
    if (!(await ev('return document.querySelector("#busy").classList.contains("on")'))) { idleAdd = true; break; }
    await sleep(500);
  }
  check('切图完成（进度遮罩收起）', idleAdd);
  await sleep(1000);

  check('表数 +1', await ev('return TBL.length') === beforeAdd + 1,
    beforeAdd + ' → ' + await ev('return TBL.length'));
  check('新表标了「照片加的」', await ev(`return (TBL.find(t=>t.name==='设备测试表')||{}).src`) === 'shot',
    await ev('return JSON.stringify(TBL.map(t=>t.name+":"+t.src))'));
  check('商品名是「表名 + 序号」',
    await ev(`return TBL.find(t=>t.name==='设备测试表').items.every(x=>/^设备测试表 \\d+$/.test(x.n))`));
  check('搜表名能搜到', await ev(`return search('设备测试表').length`) === 328,
    await ev(`return search('设备测试表').length`));
  check('新切的格子图在 WebView 里能正常解码', await ev(`return new Promise(res => {
    const it = TBL.find(t=>t.name==='设备测试表').items[0];
    const im = new Image();
    im.onload = () => res(im.naturalWidth > 0 && im.naturalHeight > 0);
    im.onerror = () => res(false);
    im.src = it.img;
  })`));
  screencap('09c-管理页-照片加的表.png');

  // 看图 → 改名 → 能搜（这是"照片加的表也能搜"的关键一步）
  await ev(`showViewer(IT.filter(x=>x.t===TBL.findIndex(t=>t.name==='设备测试表')), 0, ''); return 1`);
  await sleep(700);
  check('本机存的表看图时有「改名」按钮',
    (await ev(`return getComputedStyle(document.querySelector('#vrename')).display`)) !== 'none',
    await ev(`return getComputedStyle(document.querySelector('#vrename')).display`));
  await ev(`document.querySelector('#vrename').click(); return 1`); await sleep(700);
  await ev(`document.querySelector('#askinp').value = '设备改名款'; return 1`);
  await ev(`document.querySelector('#askok').click(); return 1`); await sleep(1000);
  await ev('closeViewer(); return 1'); await sleep(400);
  check('改完名立刻搜得到', await ev(`return search('设备改名款').length`) === 1,
    await ev(`return search('设备改名款').length`));

  // 重载：照片加的表 + 改过的名字都得还在（IndexedDB 真落盘了）
  await send('Page.reload');
  await sleep(1800);
  check('重载后页面又就绪', await waitReady(ev, 30000));
  check('重载后：照片加的表还在', await ev(`return TBL.some(t=>t.name==='设备测试表')`));
  check('重载后：改的名字还在', await ev(`return search('设备改名款').length`) === 1,
    await ev(`return search('设备改名款').length`));

  /* ------------------------------------------------- D5. 套用名字（店主实报）
     店主的处境：他先「彻底删掉」了内置的「香烟」，然后自己拍了一张同样的表
     （商品名全是编号），于是搜「中华」搜不到。这条在设备上验的是"一键把名字套过去"：
       · 借名字的是**已经看不到**的内置表 —— 名字仍打包在页面里，照样能借；
       · 套完立刻能搜；重载后名字还在；
       · 套完给「撤销」能退回编号版。
     ⚠️ 本节会临时把内置表标成"彻底删掉"，结束时必须还原 —— 后面 [7c]/[8] 还要用它。 */
  log('');
  log('[7f] 套用名字：把内置表的商品名套到"照片加的表"上');

  await ev(`document.querySelector(".tabs button[data-tab='p-mgr']").click(); return 1`);
  await sleep(700);
  check('管理页那行出现「套用名字」按钮（本机有版式一样的表）',
    await ev(`return !!document.querySelector('#mgrlist button[data-inh]')`),
    await ev(`return (document.querySelector('#mgrlist').textContent||'').match(/套用[^）]*）/)`));
  // 截图里要真能看到那一行：滚到屏幕中间再拍
  await ev(`document.querySelector('#mgrlist button[data-inh]').scrollIntoView({block:'center'}); return 1`);
  await sleep(500);
  screencap('09d-管理页-可以套用名字.png');

  // 复现"内置那张已经被彻底删掉" —— 名字仍然要能借
  await ev(`REMOVED.add('x:香烟'); saveRemoved(); rebuild(); applyAll(); return 1`);
  await sleep(700);
  check('内置「香烟」彻底删掉后，列表里看不到它',
    await ev(`return TBL.some(t=>t.name==='香烟')`) === false,
    await ev(`return JSON.stringify(TBL.map(t=>t.name))`));

  await ev(`return (() => {
    document.querySelector(".tabs button[data-tab='p-search']").click();
    const q = document.querySelector('#q'); q.value = '中华';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(900);
  check('搜不到时直接给「套用名字」按钮（名字仍能借）',
    await ev(`return !!document.querySelector('#res button[data-inh]')`) === true,
    await ev(`return document.querySelector('#res').textContent`));
  screencap('09e-搜索-给了套用名字的按钮.png');

  await ev(`document.querySelector('#res button[data-inh]').click(); return 1`);
  await sleep(900);
  check('点它先弹确认框', await ev(`return document.querySelector('#askname').classList.contains('on')`));
  check('确认框说明了来源是"已彻底删掉的示例表"',
    await ev(`return /已彻底删掉/.test(document.querySelector('#askbd').textContent)`));
  check('确认框承诺"图片和价格一个像素都不动"',
    await ev(`return /图片和价格一个像素都不动/.test(document.querySelector('#askbd').textContent)`));
  screencap('09f-套用名字-确认框.png');
  await ev(`document.querySelector('#askok').click(); return 1`);
  await sleep(1800);
  /* ⚠️ 只能断言"剩下的编号格必定是第 1 列第 1 行那格（日期格）"，不能写死数量：
     源表（香烟）里唯一没有名字的格子就是 (1,1) 那个手写日期格，所以套完最多剩它一格。
     而 [7d] 恰好把 items[0]（也就是 (1,1)）改名成了「设备改名款」—— 那一格本来就不会被套，
     于是这里剩 0 格完全正确（桌面冒烟那边改的是第 2 格，所以剩 1 格）。 */
  const leftNum = await ev(`return numItems().length`);
  check('套完只剩"源表里本来就没名字"的格子（最多就是 (1,1) 那个日期格）',
    await ev(`return numItems().every(x => +x.c === 1 && +x.r === 1)`), '剩 ' + leftNum + ' 格');
  check('店主自己改过的名字没被覆盖', await ev(`return IT.some(x=>x.n==='设备改名款')`));
  check('于是搜「中华」搜得到', await ev(`return search('中华').length`) > 0,
    await ev(`return search('中华').length`));
  screencap('09g-搜索-套用名字后能搜了.png');

  // 重载：套来的名字要真落盘
  await send('Page.reload');
  await sleep(1800);
  check('重载后页面又就绪', await waitReady(ev, 30000));
  check('重载后：套来的名字还在', await ev(`return search('中华').length`) > 0,
    await ev(`return search('中华').length`));
  check('重载后：还留着「撤销」（能退回编号版）',
    await ev(`return document.querySelectorAll('#mgrlist button[data-undo]').length`) === 1,
    await ev(`return document.querySelectorAll('#mgrlist button[data-undo]').length`));

  await ev(`document.querySelector("#mgrlist button[data-undo]").click(); return 1`);
  await sleep(1800);
  check('撤销后退回编号版', await ev(`return numItems().length`) > 300,
    await ev(`return numItems().length`));

  // 还原现场：内置表的可见性（后面几节都要它）
  await ev(`REMOVED.delete('x:香烟'); saveRemoved(); rebuild(); applyAll(); return 1`);
  await sleep(700);
  check('内置「香烟」恢复可见', await ev(`return TBL.some(t=>t.name==='香烟')`) === true,
    await ev(`return JSON.stringify(TBL.map(t=>t.name))`));

  // 清理干净 —— [7c] 假定只有内置那张表
  await ev(`document.querySelector(".tabs button[data-tab='p-mgr']").click(); return 1`);
  await sleep(500);
  await ev(`doDelete(TBL.find(t=>t.name==='设备测试表').key); return 1`);
  await sleep(1500);
  check('清理：删掉照片加的表后回到 1 张', await ev('return TBL.length') === beforeAdd,
    await ev('return TBL.length'));
  check('清理：表又回到内置那张（[7c] 的前提）', await ev('return TBL[0].src') === 'builtin',
    await ev('return TBL[0].src'));

  // ---------------------------------------------------------------- D3. 真实照片（端到端）
  log('');
  log('[7c] 真实照片端到端：从系统相册选择器挑一张真照片（content:// → EXIF → 切图）');
  /* 为什么 [7b] 那条不够、必须再走一遍真实的：
     [7b] 的 File 是页面里用 base64 现场合成的，恰好绕过了这条路上最容易出事的两个环节：
       ① 从照片选择器给的 content:// URI 读字节（分区存储 + 临时授权）；
       ② 真实 JPEG 的 EXIF 方向 —— 我们正是在这里踩过坑：
          Android WebView 不认 createImageBitmap 的 {imageOrientation:'from-image'}，
          桌面 Edge 却认，于是"桌面全绿、手机上照片纹丝不动"。
     所以这一节老老实实按店主的路径走：推一张真照片进相册 → 点「换照片」→
     在系统选择器里点那张照片 → 回来断言表真的换掉了。 */
  const SRCJPG = path.join(ROOT, 'tables', '香烟', 'list.jpg');
  const DSTJPG = '/sdcard/DCIM/Camera/cigpricer-e2e.jpg';
  adb(['-s', serial, 'shell', 'mkdir', '-p', '/sdcard/DCIM/Camera']);
  adb(['-s', serial, 'push', SRCJPG, DSTJPG]);
  adb(['-s', serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
    '-d', 'file://' + DSTJPG]);
  await sleep(3000);
  /* 相册里到底有没有这张图，直接查 MediaStore。
     （查不到就说明这次扫描没生效，后面必然点空 —— 与其让断言在别处莫名其妙地失败，
       不如在这里先问清楚。`content query` 也常带非零退出码，所以 stdout/stderr 都要看。） */
  const inStore = (() => {
    try {
      return adb(['-s', serial, 'shell', 'content', 'query', '--uri', 'content://media/external/images/media']);
    } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
  })();
  check('真照片已进入系统相册（MediaStore 里有它）', /cigpricer-e2e\.jpg/.test(inStore),
    'content://media/external/images/media');
  screencap('07a-相册里有了这张照片.png');

  // 前置状态：上一节撤销过，表应该是内置的那张
  await ev('document.querySelector(".tabs button[data-tab=\'p-search\']").click();return 1');
  await sleep(400);
  await ev('document.querySelector(".tabs button[data-tab=\'p-mgr\']").click();return 1');
  await sleep(800);
  check('（前置）表是内置的那张', await ev('return TBL[0].src') === 'builtin', await ev('return TBL[0].src'));

  /* 点「换照片」必须用 CDP 的真鼠标事件，不能合成 click()：
     Chromium 要求 file chooser 有"用户激活"（真实手势）才允许弹窗。

     🔴 点之前**必须**先把页面上那条 flash 收掉、再把按钮滚进可视区。
        [7d] 结尾删表留下的「已删除…」会挂 12 秒，把表行往下推 ~86 css px；
        管理页那条提示块本身就有 300+ css px 高，两下一叠，「换照片」直接掉出
        360×640 的视口。CDP 的 mouse 事件**不会自动滚动**，点在一个视口外的坐标上
        等于什么都没点 —— 现象是"活动还是 MainActivity、选择器压根不弹"，
        看着像壳坏了，其实是坐标落在了屏幕外（2026-09-25 实测，加了提示文案后必现）。
        这里读坐标和点下去之间不留任何会改布局的动作，量到哪就点哪。 */
  await ev('document.querySelector("#mgrmsg").className = "msg"; return 1');
  await ev(`document.querySelector('#mgrlist button[data-photo]').scrollIntoView({block:'center'}); return 1`);
  await sleep(400);
  const pb = JSON.parse(await ev(`const r = document.querySelector('#mgrlist button[data-photo]').getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), h: window.innerHeight})`));
  if (!(pb.y > 0 && pb.y < pb.h)) {
    throw new Error('「换照片」不在视口里（y=' + pb.y + '，视口高 ' + pb.h + '）—— 点下去必然是空的');
  }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pb.x, y: pb.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pb.x, y: pb.y, button: 'left', clickCount: 1 });
  await sleep(3500);
  const pk = currentActivity();
  check('「换照片」拉起了系统选择器', /photopicker|Picker|documentsui/i.test(pk), pk);
  screencap('07b-系统相册选择器（能看到那张照片）.png');

  /* 在选择器里定位那张照片。⚠️ 不目测坐标、也不写死布局 ——
     uiautomator dump 能直接给出 content-desc="拍摄于 …的照片" 的节点和它的 bounds。 */
  const uix = dumpUi();
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 'picker-ui.xml'), uix, 'utf8');
  const cell = findPhotoCell(uix);
  check('在选择器里定位到了那张照片的格子', !!cell,
    cell ? 'bounds=[' + cell.x1 + ',' + cell.y1 + '][' + cell.x2 + ',' + cell.y2 + '] 中心(' + cell.cx + ',' + cell.cy + ')'
      : '没找到 —— 界面 XML 见 android/build/picker-ui.xml');
  if (cell) {
    log('        点照片格子 device(' + cell.cx + ',' + cell.cy + ')');
    adb(['-s', serial, 'shell', 'input', 'tap', String(cell.cx), String(cell.cy)]);
    await sleep(1500);
  }

  /* 照片选择器是单选（没传 EXTRA_ALLOW_MULTIPLE），点一下就直接返回 App，
     页面随即开始切图。等它跑完 —— 这里顺便验证了"App 从后台回来之后 WebView 还活着"。
     CDP 偶尔会因为页面被挂起而报错，所以这里容错重试，别让一次抖动把整条验证带走。 */
  let swapped = false, evErr = 0;
  for (let i = 0; i < 200; i++) {
    let s = null;
    try {
      s = JSON.parse(await ev(`const b = document.querySelector("#busy");
        return JSON.stringify({ busy: b ? b.classList.contains("on") : null,
          src: (typeof TBL !== "undefined" && TBL[0]) ? TBL[0].src : null })`));
      evErr = 0;
    } catch (e) {
      if (++evErr > 8) throw new Error('照片选择器返回后 CDP 连不上了：' + e.message);
      await sleep(1000);
      continue;
    }
    if (!s.busy && s.src === 'photo') { swapped = true; break; }
    await sleep(600);
  }
  check('真照片走完了整条路：表换成了新切的', swapped,
    swapped ? '（从相册选择器选的真 JPEG）' : '等了 2 分钟仍没换成 photo');
  if (swapped) {
    await sleep(600);
    check('商品数仍是 327（名字沿用上一版，不认字）', await ev('return IT.length') === 327, await ev('return IT.length'));
    check('切出来的是新图（与内置那份不同）', await ev('return TBL[0].items[0].img.length') !== builtinLen,
      builtinLen + ' → ' + await ev('return TBL[0].items[0].img.length'));
    check('新切的格子图能正常解码（EXIF 方向没把图转坏）', await ev(`return new Promise(res => {
      const im = new Image();
      im.onload = () => res(im.naturalWidth > 0 && im.naturalHeight > 0);
      im.onerror = () => res(false);
      im.src = TBL[0].items[0].img;
    })`));
    check('存档写进了 IndexedDB', await ev('return dbAll().then(a=>a.length)') === 2,
      await ev('return dbAll().then(a=>a.length)'));
    screencap('07c-真照片换完.png');

    // 收尾：撤销回内置那张，别影响后面的小节
    await ev('document.querySelector("#mgrlist button[data-undo]").click();return 1');
    await sleep(2500);
    check('可以通过「撤销」退回内置那张', await ev('return TBL[0].src') === 'builtin', await ev('return TBL[0].src'));
  }

  /* ------------------------------------------------- D4. 搜索范围（店主实报）
     店主报「导入新表后无法搜索」。根因不是数据，是搜索范围：搜索页顶部那排
     「表：」筛选是粘滞状态（点过某张表就一直在），之后新加的表落在范围外，
     搜它的商品永远 0 条 —— 而失败文案只说"没找到"，把店主引到完全错误的方向。
     桌面（tools/smoke.js）已把这条钉死；设备上再验一遍"把话说清楚"这件事，
     因为 WebView 里这句话要真的出现在店主的屏幕上才作数。 */
  log('');
  log('[7e] 搜索范围：表筛选不能悄悄把新表挡在外面');

  // 造一张「照片加的」表：商品名故意全是编号（App 读不出商品名时就是这样），
  // 直接落内存 + IndexedDB —— 等价于"店主刚用照片加了一张表"。
  const madeN = await ev(`return (async () => {
    const src = RAW.tables[0];
    const t = { id: '设备测试表', name: '设备测试表', date: '', note: '',
                colLabels: src.colLabels, nCol: src.nCol, nRow: src.nRow,
                rot: null, blank: 0, upd: '', sheetImg: src.sheetImg, from: 'shot',
                items: src.items.slice(0, 4).map((x, i) => ({
                  n: '设备测试表 ' + (i + 1), c: x.c, r: x.r, w: x.w, h: x.h, img: x.img })) };
    await dbPut(t);
    IMP.push(t); rebuild(); applyAll();
    return TBL.length;
  })()`);
  check('设备上凑出两张表（内置 + 照片加的）', madeN === 2, madeN);
  check('照片加的表被标成 shot（管理页的进度提示靠它）',
    await ev('return TBL.find(t=>t.name==="设备测试表").src') === 'shot',
    await ev('return TBL.find(t=>t.name==="设备测试表").src'));

  // 把范围锁在内置那张上，再搜只存在于新表里的商品
  await ev(`return (() => {
    document.querySelector(".tabs button[data-tab='p-search']").click();
    curT = 0; renderFilters();
    const q = document.querySelector('#q'); q.value = '设备测试表 2';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(900);
  const resHtml = await ev('return document.querySelector("#res").textContent');
  check('被筛选挡住时不只说"没找到"，而是说清它不在「香烟」里',
    resHtml.indexOf('不在「香烟」里') >= 0, resHtml.slice(0, 60));
  check('并给出「在所有表里找」的按钮（一条真出路）',
    await ev('return !!document.querySelector("#res button[data-wide]")') === true);
  screencap('07e-搜索-被表筛选挡住.png');

  await ev('document.querySelector("#res button[data-wide]").click();return 1');
  await sleep(900);
  check('点一下范围就放开了', await ev('return curT') === -1, await ev('return curT'));
  check('放开后立刻搜到（不用重打关键词）',
    await ev('return search("设备测试表 2").length') === 1,
    await ev('return search("设备测试表 2").length'));

  // 照片加的表"格子还没名字" —— 必须和"真没这个商品"分开说
  await ev(`return (() => { const q = document.querySelector('#q');
    q.value = '不存在xyz'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(900);
  const res2 = await ev('return document.querySelector("#res").textContent');
  check('照片加的表还没起名时，说清是"格子没名字"而不是"没这个商品"',
    res2.indexOf('还没名字') >= 0 && res2.indexOf('设备测试表') >= 0, res2.slice(0, 70));
  check('只统计「照片加的表」（内置/导入的表不背这个锅）',
    await ev('return numItems().every(x => TBL[x.t].src === "shot")') === true);
  screencap('07f-搜索-照片表还没起名.png');

  // 清理：别把这张测试表留给后面的小节
  const backN = await ev(`return (async () => {
    await dbDel('设备测试表');
    IMP = IMP.filter(x => x.id !== '设备测试表');
    rebuild(); applyAll();
    return TBL.length;
  })()`);
  check('清掉测试表后回到 1 张', backN === 1, backN);

  // ---------------------------------------------------------------- E. 返回键
  log('');
  log('[8] 返回键（原生行为，走 adb keyevent）');
  // E1: 全屏看图时按返回 → 应只关掉图，App 不退
  await ev('document.querySelector(".tabs button[data-tab=\'p-search\']").click();return 1');
  await sleep(400);
  await ev('const q=document.querySelector("#q");q.value="玉溪";q.dispatchEvent(new Event("input",{bubbles:true}));return 1');
  await sleep(700);
  await ev('document.querySelector("#res .card").click();return 1');
  await sleep(600);
  adb(['-s', serial, 'shell', 'input', 'keyevent', '4']);
  await sleep(1200);
  check('看图时按返回：图关掉了', !(await ev('return document.querySelector("#viewer").classList.contains("on")')));
  check('看图时按返回：App 没被退掉', appForeground(), currentActivity());

  // E2: 在「管理」页按返回 → 应切回搜索页，App 不退
  await ev('document.querySelector(".tabs button[data-tab=\'p-mgr\']").click();return 1');
  await sleep(600);
  adb(['-s', serial, 'shell', 'input', 'keyevent', '4']);
  await sleep(1200);
  check('管理页按返回：切回了搜索页',
    await ev('return document.querySelector(".tabs button.on").dataset.tab') === 'p-search',
    await ev('return document.querySelector(".tabs button.on").dataset.tab'));
  check('管理页按返回：App 没被退掉', appForeground(), currentActivity());
  screencap('06-返回后回到搜索页.png');

  // E3: 搜索页、没开图 → 应真的退出
  adb(['-s', serial, 'shell', 'input', 'keyevent', '4']);
  await sleep(1500);
  check('搜索页按返回：App 退出了（回到桌面）', !appForeground(), currentActivity());

  // ---------------------------------------------------------------- F. 系统文件选择器
  log('');
  log('[9] 系统文件选择器（原生 onShowFileChooser）');
  adb(['-s', serial, 'shell', 'am', 'start', '-n', ACTIVITY]);
  await sleep(4000);
  const c2 = await connect();
  await waitReady(c2.ev, 30000);
  await c2.ev('document.querySelector(".tabs button[data-tab=\'p-mgr\']").click();return 1');
  await sleep(700);

  /* ⚠️ 这里**不能**用 `document.querySelector('#impfile').click()`：
     Chromium 要求 file chooser 必须有"用户激活"（真实手势）才允许弹窗，
     合成 click 不算 —— 日志里会明说
     "File chooser dialog can only be shown with a user activation"。
     CDP 的 Input.dispatchMouseEvent 走的是浏览器真实输入管线，算用户激活，
     所以用它（Puppeteer 的 page.click() 就是这么点开文件选择器的）。 */
  const btn = JSON.parse(await c2.ev(`const r = document.querySelector('.impbtn').getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)})`));
  await c2.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await c2.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await sleep(2500);
  const top = currentActivity();
  const isPicker = /documentsui|DocumentsActivity|ChooserActivity|mediapicker/i.test(top);
  check('点「导入表包」能拉起系统文件选择器', isPicker, top);
  screencap('07-系统文件选择器.png');
  adb(['-s', serial, 'shell', 'input', 'keyevent', '4']);
  await sleep(1200);

  // ---------------------------------------------------------------- 收尾
  c2.ws.close();
  log('');
  log('日志里的 App 输出：');
  const lg = adb(['-s', serial, 'logcat', '-d', '-s', 'CigPricer:V']);
  for (const l of lg.split('\n').filter((x) => x.indexOf('CigPricer') >= 0).slice(-8)) log('  ' + l.replace(/\s+$/, ''));

  log('');
  log('通过 ' + pass + ' / ' + (pass + fail));
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  /* 把点按坐标交给 android/acceptance.js —— 正式包没有调试通道，取不到元素坐标，
     只能靠这一份"由调试包量出来"的坐标表去做真机点击。 */
  fs.writeFileSync(path.join(REPORT_DIR, 'tap-points.json'),
    JSON.stringify({ dpr: dpr, webTop: webTop, device: size.trim(), density: dens.trim(), taps: taps }, null, 1), 'utf8');
  log('点按坐标 → android/build/tap-points.json（' + Object.keys(taps).join(' / ') + '）');

  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  log('报告 → android/build/verify-report.txt');
  ws.close();
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  log('');
  log('运行出错：' + e.message);
  try { fs.mkdirSync(REPORT_DIR, { recursive: true }); fs.writeFileSync(REPORT, lines.join('\n'), 'utf8'); } catch (_) { }
  process.exit(1);
});
