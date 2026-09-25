#!/usr/bin/env node
'use strict';
/**
 * 正式包的交付验收：干净安装 → 启动 → 用**真实点击**走一遍关键路径。
 *
 *   node android/acceptance.js                 # 验收 build/cigpricer.apk
 *   node android/acceptance.js --apk=xxx.apk
 *
 * 为什么需要这个脚本（它和 verify.js 是两件事）：
 *   verify.js 要用 CDP 驱动 WebView，**只有 --debug 的包才有调试通道**；
 *   正式包（交付给店主的就是它）连不上 CDP，没法在里面跑断言。
 *   所以正式包只能做"外部可观测"的验收：装得上、起得来、真的点得动、日志干净。
 *
 * 坐标从哪来：
 *   android/build/tap-points.json —— 由 verify.js 在调试包上量出来的
 *   （css 像素 × dpr + 状态栏高度）。正式包和调试包**布局完全一样**，
 *   只有那一个 webview_debug 布尔不同，所以坐标可以直接复用。
 *   取不到就退回脚本里的默认值（同机型）。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PKG = 'com.boki.cigpricer';
const ACTIVITY = PKG + '/.MainActivity';

/* 页面里点 <input type="file"> 会拉起「系统选择器」。⚠️ 具体拉起哪个界面由
   Android 版本 + 传的 MIME 决定，不是固定的一个：
     - 老版本 / 传 application/json ：DocumentsUI（...documentsui/.picker.PickActivity）
     - Android 13+ 传 image/星号     ：系统相册选择器
         （com.android.providers.media.module/...photopicker.PhotoPickerGetContentActivity）
     - 有多个候选时还会套一层 ChooserActivity
   所以判据是「前台不是我们 App，且前台看起来是个选择器」，别写死某一个组件名
   （写死了就会像 2026-09-24 那样：功能明明是好的，断言却 FAIL）。 */
const PICKER_RE = /documentsui|photopicker|mediapicker|PickActivity|ChooserActivity|Picker/i;
const SHOTS = path.join(ROOT, 'shots-apk');
const REPORT_DIR = path.join(__dirname, 'build');

const lines = [];
const log = (s) => { console.log(s); lines.push(s); };
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; log('  PASS  ' + name + (detail === undefined ? '' : '   [' + detail + ']')); }
  else { fail++; log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + detail + ']')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ADB = (() => {
  const c = [
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') : null,
  ];
  for (const p of c) if (p && fs.existsSync(p)) return p;
  throw new Error('找不到 adb');
})();

function parseArgs() {
  const o = { serial: '127.0.0.1:16384', apk: path.join(ROOT, 'build', 'cigpricer.apk') };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--serial=')) o.serial = a.slice(9);
    else if (a.startsWith('--apk=')) o.apk = path.resolve(ROOT, a.slice(6));
    else throw new Error('不认识的参数：' + a);
  }
  return o;
}

let serial = '';
const adb = (args, opts = {}) => execFileSync(ADB, args, {
  encoding: opts.binary ? 'buffer' : 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26,
});

function screencap(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const buf = adb(['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true });
  fs.writeFileSync(path.join(SHOTS, name), buf);
  log('        截图 → shots-apk/' + name);
}

const resumed = () => {
  const d = adb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']);
  const m = d.match(/(?:topResumedActivity|ResumedActivity)[^\n]*?([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/);
  return m ? m[1] : '(未知)';
};

async function main() {
  const o = parseArgs();
  serial = o.serial;

  log('烟价速查 · 正式包交付验收');
  log('  APK     ' + path.relative(ROOT, o.apk));
  log('');

  adb(['connect', serial]);
  const info = fs.existsSync(path.join(REPORT_DIR, 'tap-points.json'))
    ? JSON.parse(fs.readFileSync(path.join(REPORT_DIR, 'tap-points.json'), 'utf8')) : null;
  check('拿到调试包量出的点按坐标表', !!(info && info.taps && info.taps['导入表包'] && info.taps['换照片']),
    info ? Object.keys(info.taps).join(' / ') : '没有 tap-points.json，先用 verify.js 跑一遍');
  if (!info) throw new Error('先跑 node android/verify.js 生成 android/build/tap-points.json');
  const sizeNow = adb(['-s', serial, 'shell', 'wm', 'size']).trim().replace(/\s+/g, ' ');
  const densNow = adb(['-s', serial, 'shell', 'wm', 'density']).trim().replace(/\s+/g, ' ');
  check('屏幕尺寸/密度与量坐标时一致（不然坐标会打偏）',
    sizeNow === info.device.replace(/\s+/g, ' ') && densNow === info.density.replace(/\s+/g, ' '),
    sizeNow + ' / ' + densNow + '  vs  ' + info.device.replace(/\s+/g, ' ') + ' / ' + info.density.replace(/\s+/g, ' '));

  // 干净安装：先卸掉（连数据一起），再全新装 —— 这才是店主拿到手的那个状态
  log('');
  log('[1] 干净安装（先卸载，连 WebView 数据一起清掉）');
  adb(['-s', serial, 'uninstall', PKG]);
  const out = adb(['-s', serial, 'install', o.apk]);
  check('安装成功', /Success/.test(out), out.trim().split('\n').pop());

  adb(['-s', serial, 'logcat', '-c']);
  adb(['-s', serial, 'shell', 'am', 'start', '-n', ACTIVITY]);
  await sleep(7000);
  check('App 起来了（前台是我们的 Activity）', resumed().indexOf(PKG) >= 0, resumed());
  screencap('10-正式包-首屏.png');

  log('');
  log('[2] 正式包不该有调试通道');
  const n = adb(['-s', serial, 'shell', 'cat', '/proc/net/unix']).split('\n')
    .filter((l) => l.indexOf('webview_devtools_remote') >= 0).length;
  check('没有 webview_devtools_remote socket（调试通道已关）', n === 0, n + ' 个');
  const lg1 = adb(['-s', serial, 'logcat', '-d', '-s', 'CigPricer:V']);
  check('logcat 里没有「调试通道已开启」', lg1.indexOf('调试通道已开启') < 0);
  check('页面加载完成（有「页面就绪」）', lg1.indexOf('页面就绪') >= 0);

  log('');
  log('[3] 真实点击（adb input tap，坐标来自调试包实测）');
  const tap = async (key, waitMs) => {
    const p = info.taps[key];
    log('        点击「' + key + '」 device(' + p.x + ',' + p.y + ')');
    adb(['-s', serial, 'shell', 'input', 'tap', String(p.x), String(p.y)]);
    await sleep(waitMs || 1500);
  };

  /* 关掉系统文件选择器。⚠️ 不能只按一次返回就当真关掉了：
     DocumentsUI 里按一次返回有可能只是退出当前目录/搜索，界面还在，
     后面那次 tap 就会落到选择器上（会连带把后面的断言全带偏）。
     所以按完要**核对前台是谁**，不是 App 就再按。 */
  const closePicker = async () => {
    for (let i = 0; i < 3; i++) {
      if (resumed().indexOf(PKG) >= 0) return true;
      adb(['-s', serial, 'shell', 'input', 'keyevent', '4']);
      await sleep(1600);
    }
    return resumed().indexOf(PKG) >= 0;
  };

  await tap('tab管理', 2000);
  screencap('11-正式包-管理页.png');

  await tap('导入表包', 3000);
  const top = resumed();
  check('点「导入表包」拉起了系统文件选择器', PICKER_RE.test(top), top);
  screencap('12-正式包-文件选择器.png');
  check('关掉选择器后回到 App', await closePicker(), resumed());

  /* 「换照片」走的是同一个 onShowFileChooser 回调，但这是店主每次更新价格都要走的
     那一步，必须在正式包里单独点一次 —— 而且要看它是不是**图片选择器**
     （页面写了 accept="image/*"，壳会据此过滤，不然店主得在一堆文件里翻照片）。 */
  await tap('换照片', 3000);
  const top2 = resumed();
  check('点「换照片」拉起了系统选择器（相册选择器也算）', PICKER_RE.test(top2), top2);
  // 壳会把自己最终用的 type 打进 logcat（MainActivity「文件选择器 type=…」），
  // 拿它核对"选照片时只列图片"，比去猜 DocumentsUI 的界面靠谱
  const lgType = adb(['-s', serial, 'logcat', '-d', '-s', 'CigPricer:I'])
    .split('\n').filter((l) => l.indexOf('文件选择器') >= 0);
  check('「换照片」用的是 image/* 过滤（只列图片）',
    lgType.some((l) => l.indexOf('type=image/') >= 0), (lgType.slice(-1)[0] || 'logcat 里没有这一行').trim().slice(-90));
  screencap('12b-正式包-换照片选择器.png');
  check('关掉换照片的选择器后仍回到 App', await closePicker(), resumed());

  log('');
  log('[4] 返回键：管理页 → 搜索页（不该直接退出）');
  adb(['-s', serial, 'shell', 'input', 'keyevent', '4']);
  await sleep(1500);
  check('按一次返回仍留在 App 里', resumed().indexOf(PKG) >= 0, resumed());
  screencap('13-正式包-返回后.png');

  log('');
  log('[5] 再按一次返回 → 退出到桌面');
  adb(['-s', serial, 'shell', 'input', 'keyevent', '4']);
  await sleep(1800);
  check('退出了 App', resumed().indexOf(PKG) < 0, resumed());

  log('');
  log('通过 ' + pass + ' / ' + (pass + fail));
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 'acceptance-report.txt'), lines.join('\n'), 'utf8');
  log('报告 → android/build/acceptance-report.txt');
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  log('');
  log('运行出错：' + e.message);
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'acceptance-report.txt'), lines.join('\n'), 'utf8');
  } catch (_) { }
  process.exit(1);
});
