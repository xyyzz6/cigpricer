#!/usr/bin/env node
'use strict';
/**
 * 一次性诊断：设备上「换照片」为什么没反应。
 * 用法: NODE_PATH=... node android/_diag-photo.js
 *
 * adb daemon 会在两次工具调用之间被回收，forward 规则跟着没 ——
 * 所以 connect → forward → CDP 必须在同一个进程里做完。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PKG = 'com.boki.cigpricer';
const ACTIVITY = PKG + '/.MainActivity';
const ORIGIN = 'https://appassets.androidplatform.net';
const PORT = 9223;
const serial = process.argv[2] || '127.0.0.1:16384';

const ADB = (() => {
  const c = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') : null,
    'C:/Program Files/Netease/MuMu/nx_main/adb.exe',
  ];
  for (const p of c) if (p && fs.existsSync(p)) return p;
  throw new Error('找不到 adb');
})();
const adb = (a) => execFileSync(ADB, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  adb(['connect', serial]);
  // 确保 App 在前台、调试通道在
  adb(['-s', serial, 'shell', 'am', 'force-stop', PKG]);
  adb(['-s', serial, 'shell', 'am', 'start', '-n', ACTIVITY]);
  await sleep(5000);
  const unix = adb(['-s', serial, 'shell', 'cat', '/proc/net/unix']);
  const m = unix.match(/@?(webview_devtools_remote_\d+)/);
  if (!m) throw new Error('没有 webview_devtools_remote socket');
  adb(['-s', serial, 'forward', '--remove-all']);
  adb(['-s', serial, 'forward', 'tcp:' + PORT, 'localabstract:' + m[1]]);

  const targets = await getJson('http://127.0.0.1:' + PORT + '/json');
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith(ORIGIN));
  if (!page) throw new Error('找不到 WebView 页面');

  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  let id = 0; const pending = new Map();
  ws.on('message', (buf) => {
    let x; try { x = JSON.parse(buf.toString()); } catch (_) { return; }
    if (x.id && pending.has(x.id)) { const p = pending.get(x.id); pending.delete(x.id); x.error ? p.rej(new Error(JSON.stringify(x.error))) : p.res(x.result); }
  });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async function(){ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __throw: JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails) };
    return r.result && r.result.value;
  };
  await send('Runtime.enable');
  await sleep(1500);

  const say = (k, v) => console.log('  ' + k.padEnd(26) + (typeof v === 'string' ? v : JSON.stringify(v)));

  console.log('\n=== 1. 环境 ===');
  say('CIGCROP', await ev('return typeof CIGCROP'));
  say('CompressionStream', await ev('return typeof CompressionStream'));
  say('createImageBitmap', await ev('return typeof createImageBitmap'));
  say('DataTransfer', await ev('return typeof DataTransfer'));
  say('页面就绪', await ev('return !!window.__ready'));

  console.log('\n=== 2. 表与按钮 ===');
  say('表', await ev('return JSON.stringify(TBL.map(t=>[t.name,t.key,t.src]))'));
  await ev('document.querySelector(".tabs button[data-tab=\'p-mgr\']").click();return 1');
  await sleep(600);
  say('换照片按钮', await ev('return !!document.querySelector("#mgrlist button[data-photo]")'));
  say('按钮 dataset', await ev('return document.querySelector("#mgrlist button[data-photo]").dataset.photo'));

  console.log('\n=== 3. input 注入能力（用 3 字节的假文件试） ===');
  say('注入 files', await ev(`const inp=document.querySelector('#shootfile');
    const dt=new DataTransfer(); dt.items.add(new File([new Uint8Array([1,2,3])],'a.txt',{type:'text/plain'}));
    inp.files=dt.files;
    return JSON.stringify({len: inp.files.length, name: inp.files[0]&&inp.files[0].name});`));
  say('清空 value', await ev(`const inp=document.querySelector('#shootfile');
    try { inp.value=''; return 'ok'; } catch(e){ return 'ERR: '+e.name+' '+e.message; }`));

  console.log('\n=== 4. 完整走一遍（合成真照片） ===');
  const b64 = fs.readFileSync(path.join(ROOT, 'tables', '香烟', 'list.jpg')).toString('base64');
  say('照片 base64', b64.length + ' 字符');
  const r = await ev(`(() => {
    try {
      const inp = document.querySelector('#shootfile');
      inp.dataset.key = 'b:香烟';
      const b64 = ${JSON.stringify(b64)};
      let bin;
      try { bin = atob(b64); } catch (e) { return 'A atob 失败: ' + e.name + ' ' + e.message; }
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      let dt, file;
      try { dt = new DataTransfer(); file = new File([u8], 'list.jpg', {type:'image/jpeg'}); dt.items.add(file); }
      catch (e) { return 'B 造 File 失败: ' + e.name + ' ' + e.message; }
      inp.files = dt.files;
      if (!inp.files.length) return 'C inp.files 是空的（WebView 不让赋值？）';
      window.__diag = { hit: 0, err: null };
      inp.addEventListener('change', () => { window.__diag.hit++; }, true);
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return 'D 已派发，files=' + inp.files.length + ' file=' + inp.files[0].name + ' size=' + inp.files[0].size;
    } catch (e) { return 'E 意外异常: ' + e.name + ' ' + e.message + ' @ ' + (e.stack||'').split('\\n')[1]; }
  })()`);
  say('结果', r);
  await sleep(1200);
  say('change 命中次数', await ev('return window.__diag ? window.__diag.hit : "没有 __diag"'));
  say('input.dataset.key', await ev(`return document.querySelector('#shootfile').dataset.key === undefined ? '(已清掉)' : document.querySelector('#shootfile').dataset.key`));
  say('进度遮罩是否在', await ev('return document.querySelector("#busy").classList.contains("on")'));
  say('管理页提示', await ev('return document.querySelector("#mgrmsg").textContent.slice(0,200)'));
  await sleep(6000);
  say('6 秒后 遮罩', await ev('return document.querySelector("#busy").classList.contains("on")'));
  say('6 秒后 表状态', await ev('return JSON.stringify(TBL.map(t=>[t.name,t.src]))'));
  say('6 秒后 存档数', await ev('return dbAll().then(a=>a.length)'));
  say('6 秒后 提示', await ev('return document.querySelector("#mgrmsg").textContent.slice(0,300)'));

  console.log('\n=== 5. 单独试 createImageBitmap（换照片第一步） ===');
  say('createImageBitmap(blob)', await ev(`try {
      const cv = document.createElement('canvas'); cv.width = 40; cv.height = 30;
      cv.getContext('2d').fillRect(0,0,40,30);
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return 'ok ' + bmp.width + 'x' + bmp.height;
    } catch (e) { return 'ERR: ' + e.name + ' ' + e.message; }`));

  console.log('\n=== 6. logcat 最近的页面报错 ===');
  const lg = adb(['-s', serial, 'logcat', '-d', '-s', 'CigPricer:V']);
  lg.split('\n').filter((x) => x.indexOf('CigPricer') >= 0).slice(-12).forEach((l) => console.log('  ' + l.trim()));

  ws.close();
})().catch((e) => { console.error('诊断脚本出错：' + e.message); process.exit(1); });
