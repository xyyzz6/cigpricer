// 真实表包端到端复核（CDP / Edge headless）
// 用法: NODE_PATH=... node tools/check_pack_e2e.js build/pack/行情8月14日.cigtable.json [更多表包...]
//
// 它回答的是一个具体问题：**发给店主的那个 .cigtable.json，导进 App 里到底能不能搜到货**。
// 冒烟测试用的是 mkfixture.py 的假表，只证明"导入机制"没问题；
// 这个脚本拿真表包、抽里面真实的商品名去搜，并刷新一次确认落盘。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = 'E:/boki/cigpricer';
const SHOTS = path.join(ROOT, 'shots');
const APP = path.join(ROOT, 'build', '烟价速查.html');
const PORT = 9336;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = {};
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) (this.handlers[m.method] || []).forEach(f => f(m.params));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, 120000);
    });
  }
  on(m, f) { (this.handlers[m] = this.handlers[m] || []).push(f); }
}
const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const packs = process.argv.slice(2).map(p => path.resolve(p));
  if (!packs.length) throw new Error('至少要给一个表包路径');
  fs.mkdirSync(SHOTS, { recursive: true });
  const want = packs.map(p => {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const items = j.table.items;
    // 抽 5 个真名字去搜：头 2 个、中间 1 个、尾 2 个
    const pick = [items[0], items[1], items[Math.floor(items.length / 2)],
                  items[items.length - 2], items[items.length - 1]].map(x => x.n);
    return { file: p, name: j.table.name, n: items.length, pick };
  });

  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cigpack-'));
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + udd, 'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try { const l = await getJSON(`http://127.0.0.1:${PORT}/json/list`); if (l.some(t => t.type === 'page')) { targets = l; break; } } catch (e) {}
    await sleep(300);
  }
  if (!targets) { child.kill(); throw new Error('浏览器调试端口没起来'); }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  const cdp = new CDP(ws);
  const errors = [];
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', p => errors.push('exception: ' + (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text)));
  cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') errors.push('console.error: ' + JSON.stringify(p.args.map(a => a.value))); });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const url = 'file:///' + encodeURI(APP.replace(/\\/g, '/'));
  await cdp.send('Page.navigate', { url });

  const ev0 = async e => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  let ready = false;
  for (let i = 0; i < 75; i++) { await sleep(400); if (await ev0('window.__ready===true && typeof IT!=="undefined"')) { ready = true; break; } }
  if (!ready) { ws.close(); child.kill(); throw new Error('页面没就绪'); }
  await sleep(600);
  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('evaluate 失败: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const shot = async name => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
  };
  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

  const before = await ev('TBL.length');
  check('导入前只有内置表', before === 1, before);

  const root = await cdp.send('DOM.getDocument', { depth: 1 });
  const node = await cdp.send('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#impfile' });
  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: packs });   // 一次全选，跟店主一样
  await sleep(1200 + packs.length * 900);

  check(`导入 ${packs.length} 个真实表包后表数 = ${before + packs.length}`,
    await ev('TBL.length') === before + packs.length, await ev('TBL.length'));
  check('管理页提示「已导入」', (await ev('document.querySelector("#mgrmsg").textContent')).indexOf('已导入') >= 0,
    await ev('document.querySelector("#mgrmsg").textContent'));

  for (const w of want) {
    const ti = await ev(`TBL.findIndex(t=>t.name===${JSON.stringify(w.name)})`);
    check(`表「${w.name}」进来了`, ti >= 0, 'index=' + ti);
    check(`表「${w.name}」商品数 = 表包里的 ${w.n}`,
      await ev(`TBL[${ti}] ? TBL[${ti}].items.length : -1`) === w.n,
      await ev(`TBL[${ti}] ? TBL[${ti}].items.length : -1`));
    check(`表「${w.name}」标了「导入的」`,
      await ev(`[...document.querySelectorAll('#mgrlist .trow')].some(r => {` +
               `var tn = r.querySelector('.tn'); ` +
               `return tn && tn.textContent.indexOf(${JSON.stringify(w.name)}) === 0 && !!r.querySelector('.src.im'); })`));
  }

  // 拿真名字去搜
  for (const w of want) {
    const ti = await ev(`TBL.findIndex(t=>t.name===${JSON.stringify(w.name)})`);
    for (const nm of w.pick) {
      const hits = await ev(`search(${JSON.stringify(nm)}).map(x=>({n:x.n,t:x.t}))`);
      const good = Array.isArray(hits) && hits.some(h => h.n === nm && h.t === ti);
      check(`搜「${nm}」命中本表`, good, JSON.stringify(hits && hits.slice(0, 3)));
    }
  }

  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(500);
  await shot('17-真实表包-导入后管理页.png');
  const probe = want[0].pick[2];
  await ev(`document.querySelector("[data-tab='p-search']").click()`); await sleep(300);
  await ev(`document.querySelector('#q').value=${JSON.stringify(probe)}; document.querySelector('#q').dispatchEvent(new Event('input',{bubbles:true}))`);
  await sleep(900);
  await shot('18-真实表包-搜索结果.png');
  check(`搜「${probe}」结果区渲染了卡片`,
    await ev(`document.querySelectorAll('#res .card').length`) > 0,
    await ev(`document.querySelectorAll('#res .card').length`));

  // 刷新一次：证明真的落盘了（不是只在内存里）
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 75; i++) { await sleep(400); if (await ev0('window.__ready===true && typeof IT!=="undefined"')) break; }
  await sleep(700);
  check(`刷新后表还在（${before + packs.length} 张）`, await ev('TBL.length') === before + packs.length, await ev('TBL.length'));
  for (const w of want) {
    const nm = w.pick[0];
    check(`刷新后搜「${nm}」仍然命中`, await ev(`search(${JSON.stringify(nm)}).length`) > 0,
      await ev(`search(${JSON.stringify(nm)}).length`));
  }
  check('没有 JS 异常 / console.error', errors.length === 0, errors.slice(0, 2).join(' | '));

  let pass = 0;
  console.log('===== 真实表包端到端复核 =====');
  for (const r of results) {
    if (r.ok) pass++;
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.extra ? '   [' + r.extra + ']' : ''}`);
  }
  console.log(`\n通过 ${pass} / ${results.length}`);
  ws.close(); child.kill();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('运行失败:', e); process.exit(1); });
