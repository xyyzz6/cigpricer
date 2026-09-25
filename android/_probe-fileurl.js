#!/usr/bin/env node
'use strict';
/**
 * 一次性实验：Android WebView 里，file:// 源下 IndexedDB 到底能不能用？
 *
 * 桌面 Edge 138 实测是可以的（skill 里记着）。但 WebView 是另一套嵌入方式，
 * 不能拿桌面的结论照搬。这个脚本把当前 WebView 导航到 file:///android_asset/www/index.html，
 * 直接读页面自己的 STORE_OK / STORE_WHY（那段代码本来就是为"存不住"准备的降级路径）。
 *
 * 用法：node android/_probe-fileurl.js    （需要装着 --debug 包、App 已启动）
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.dirname(__dirname);
const ADB = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const SERIAL = '127.0.0.1:16384';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (a) => execFileSync(ADB, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });

const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej);
});

async function main() {
  adb(['connect', SERIAL]);
  adb(['-s', SERIAL, 'install', '-r', path.join(__dirname, 'build', 'cigpricer-debug.apk')]);
  adb(['-s', SERIAL, 'shell', 'am', 'force-stop', 'com.boki.cigpricer']);
  adb(['-s', SERIAL, 'shell', 'am', 'start', '-n', 'com.boki.cigpricer/.MainActivity']);
  await sleep(5000);

  const unix = adb(['-s', SERIAL, 'shell', 'cat', '/proc/net/unix']);
  const m = unix.match(/@?(webview_devtools_remote_\d+)/);
  adb(['-s', SERIAL, 'forward', '--remove-all']);
  adb(['-s', SERIAL, 'forward', 'tcp:9222', 'localabstract:' + m[1]]);

  const targets = await getJson('http://127.0.0.1:9222/json');
  const page = targets.find((t) => t.type === 'page');
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  ws.on('message', (b) => { let x; try { x = JSON.parse(b.toString()); } catch (_) { return; } if (x.id && pending.has(x.id)) { const p = pending.get(x.id); pending.delete(x.id); x.error ? p.rej(new Error(JSON.stringify(x.error))) : p.res(x.result); } });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: `(async function(){ ${e} })()`, returnByValue: true, awaitPromise: true })).result.value;

  await send('Page.enable');
  console.log('导航前:', await ev('return location.href'));

  await send('Page.navigate', { url: 'file:///android_asset/www/index.html' });
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev('return !!(window.__ready)')) break; }

  const r = {
    href: await ev('return location.href'),
    origin: await ev('return String(location.origin)'),
    secure: await ev('return window.isSecureContext'),
    storeOK: await ev('return typeof STORE_OK === "undefined" ? "(页面没跑到)" : STORE_OK'),
    storeWhy: await ev('return typeof STORE_WHY === "undefined" ? "" : STORE_WHY'),
    tblN: await ev('return typeof TBL === "undefined" ? -1 : TBL.length'),
    idb: await ev('try { return "ok:" + String(!!window.indexedDB) } catch(e) { return "throw:" + e.name }'),
    probe: await ev(`try {
        const d = await new Promise((res, rej) => { const q = indexedDB.open('__probe__', 1);
          q.onupgradeneeded = () => q.result.createObjectStore('s');
          q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); q.onblocked = () => rej(new Error('blocked')); });
        const store = d.transaction('s', 'readwrite').objectStore('s');
        await new Promise((res, rej) => { const t = store.put('hello', 'k'); t.onsuccess = res; t.onerror = () => rej(t.error); });
        const got = await new Promise((res, rej) => { const t = store.get('k'); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
        d.close();
        return '写入并读回：' + got;
      } catch (e) { return '开库/读写失败：' + (e && (e.name + ': ' + e.message)); }`),
  };
  const q = await ev('return navigator.storage && navigator.storage.estimate ? navigator.storage.estimate().then(e=>Math.round(e.quota/1048576)+" MB") : "n/a"').catch(() => 'n/a');
  r.quota = q;

  console.log('\n=== file:// 源下的实测结果 ===');
  for (const [k, v] of Object.entries(r)) console.log('  ' + k.padEnd(9) + ' ' + v);
  fs.writeFileSync(path.join(__dirname, 'build', 'fileurl-probe.txt'),
    Object.entries(r).map(([k, v]) => k + ' = ' + v).join('\n'), 'utf8');
  ws.close();
}
main().catch((e) => { console.error('出错:', e.message); process.exit(1); });
