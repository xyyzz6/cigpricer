// 「烟价认字」页的探针 / 离线自检（CDP 驱动）
//
//   local  —— 不开网络、不烧配额：验证「照片 → 切网格 → 切格 → 拼表包」这条链路，
//             名字由本地 names.json 灌进去代替 AI，产出的表包落盘后可交给
//             check_pack_e2e.js 灌进真 App 页面验证。
//   acc    —— 打开线上页（要云服务 origin 才通），把本地照片塞进 file input，
//             真调大模型认字，跟标准答案逐行比。
//
// 用法：
//   NODE_PATH=<workspace>/node_modules node tools/probe_recognizer.js local \
//       --photo tables/香烟/list.jpg --truth tables/香烟/names.json --name 香烟
//   NODE_PATH=<workspace>/node_modules node tools/probe_recognizer.js acc \
//       --photo tables/香烟/list.jpg --truth tables/香烟/names.json
//
// 连真机 / 模拟器（先 adb forward tcp:9222 localabstract:chrome_devtools_remote）：
//   node tools/probe_recognizer.js acc --remote 9222 --devphoto /sdcard/Download/list.jpg ...
//   node tools/probe_recognizer.js acc --api-base https://api.openai.com/v1 \
//       --api-key sk-xxx --api-model gpt-4o-mini --photo tables/香烟/list.jpg --truth ...
//   ⚠️ 设备侧要用 --devphoto：DOM.setFileInputFiles 的路径由**浏览器所在的机器**解析，
//      所以照片必须先 adb push 到设备上，塞进去的是设备路径，不是宿主机路径。
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const argv = process.argv.slice(2);
const MODE = argv[0] || 'local';
const arg = (k, def) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : def;
};
const has = k => argv.includes('--' + k);

const ROOT = 'E:/boki/cigpricer';
const PHOTO = arg('photo', 'tables/香烟/list.jpg');
const TRUTH = arg('truth', 'tables/香烟/names.json');
const NAME = arg('name', '探针表');
const OUT = arg('out', 'build/pack/_probe_recog.cigtable.json');
const DEVICE = arg('device', '');
const REMOTE = arg('remote', '');                 // 连现成的 CDP（adb forward 出来的端口）
const DEVPHOTO = arg('devphoto', '');             // 照片在设备上的路径（配合 --remote）

const URL_LOCAL = 'file:///E:/boki/cigpricer/recognizer/index.html';
const URL_ACC = arg('url', 'https://cig-price-ocr.app.workbuddy.host/');
const URL_ = MODE === 'acc' ? URL_ACC : URL_LOCAL;

const PORT = 9346;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const abs = p => path.isAbsolute(p) ? p : path.join(ROOT, p);

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = {};
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        (this.handlers[m.method] || []).forEach(f => f(m.params));
      }
    });
  }
  send(method, params = {}, timeout = 120000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, timeout);
    });
  }
  on(m, f) { (this.handlers[m] = this.handlers[m] || []).push(f); }
}

const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  if (!DEVPHOTO && !fs.existsSync(abs(PHOTO))) throw new Error('照片不存在：' + abs(PHOTO));
  let truth = null;
  if (fs.existsSync(abs(TRUTH))) {
    const d = JSON.parse(fs.readFileSync(abs(TRUTH), 'utf8'));
    truth = d.cols || d;
  }

  /* 照片该用哪个路径：连设备就用设备路径，本地 headless 就用宿主机路径 */
  const photoPath = DEVPHOTO || abs(PHOTO);

  let child = null, port = PORT;
  if (REMOTE) {
    port = +REMOTE;
    console.log('连设备浏览器：http://127.0.0.1:' + port + '（不再启动本地 Edge）');
  } else {
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cigrec-'));
    child = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + PORT, '--user-data-dir=' + udd, 'about:blank',
    ], { stdio: 'ignore' });
  }

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try { const l = await getJSON(`http://127.0.0.1:${port}/json/list`); if (l.some(t => t.type === 'page')) { targets = l; break; } } catch (e) { }
    await sleep(300);
  }
  if (!targets) { if (child) child.kill(); throw new Error('浏览器调试端口没起来（' + port + '）'); }

  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  const cdp = new CDP(ws);

  const errors = [];
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  cdp.on('Runtime.exceptionThrown', p => errors.push('exception: ' + (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text)));
  cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') errors.push('console.error: ' + JSON.stringify(p.args.map(a => a.value))); });

  const ev = async (expr, timeout) => {
    const r = await cdp.send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
    return r.result.value;
  };

  console.log('模式 ' + MODE + '，打开 ' + URL_);
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(1500);

  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { ok = await ev('return !!(window.__recog && window.CIGCROP)'); if (!ok) await sleep(300); }
  if (!ok) throw new Error('页面没就绪（缺 __recog 或 CIGCROP）');
  console.log('页面就绪：' + await ev('return document.title'));

  /* ---- 塞照片 ---- */
  const doc = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#picker' });
  if (!nodeId) throw new Error('找不到 #picker');
  await cdp.send('DOM.setFileInputFiles', { files: [photoPath], nodeId });
  console.log('已塞照片：' + photoPath);

  let st = '';
  for (let i = 0; i < 120; i++) {
    st = await ev('const p=window.__recog.photos[0];return p?p.state:"none"');
    if (i % 20 === 0) console.log('  state=' + st + ' (' + i + ')');
    if (st === 'grid' || st === 'err') break;
    await sleep(500);
  }
  if (st !== 'grid') {
    const err = await ev('const p=window.__recog.photos[0];return p?(p.err||p.state):"没有照片"');
    throw new Error('切网格失败：' + err);
  }
  const dim = await ev('const p=window.__recog.photos[0];return p.plan.cols.length+"列 x "+p.plan.rows.length+"行, rot="+p.plan.ang+", 尺="+p.plan.W+"x"+p.plan.H');
  console.log('切成：' + dim);

  /* ---- 认字：acc 模式真调模型，local 模式灌标准答案 ---- */
  let summary = null;
  const MODEL = arg('model', '');
  const COLS = (arg('cols', '') || '').split(',').filter(Boolean).map(x => +x - 1);
  if (MODE === 'acc') {
    const APIBASE = arg('api-base', ''), APIKEY = arg('api-key', ''), APIMODEL = arg('api-model', '');
    if (APIBASE) {
      const eng = await ev('return window.__recog.setEngine(' + JSON.stringify({
        mode: 'custom', base: APIBASE, key: APIKEY,
        models: String(APIMODEL || '').split(',').filter(Boolean)
      }) + ')');
      console.log('自带 API：' + eng.base + '，模型 ' + (eng.models.join(', ') || '(没填)') +
        '，密钥 ' + (eng.hasKey ? '已填' : '⚠ 没填'));
    }
    if (MODEL) { await ev('return window.__recog.setModel(' + JSON.stringify(MODEL) + ')'); console.log('指定模型：' + MODEL); }
    if (has('apitest')) {
      const r = await ev(`return await (async()=>{
        await window.__recog.fetchModels();
        const a = document.getElementById('tstat').textContent;
        await window.__recog.testEngine();
        return [a, document.getElementById('tstat').textContent,
                document.getElementById('amodel').value,
                document.getElementById('mlist').options.length];
      })()`, 120000);
      console.log('  拉模型列表：' + r[0]);
      console.log('  候选数：' + r[3] + '，填进去的是：' + r[2]);
      console.log('  接口测试：' + r[1]);
    }
    console.log('开始认字（联网）' + (COLS.length ? '，只认第 ' + COLS.map(c => c + 1).join(',') + ' 列' : '') + '…');
    await ev('await window.__recog.runCols(1, ' + JSON.stringify(COLS) + ')', 900000);
    // 跟标准答案逐行比
    const cmp = await ev(`
      const cols=${JSON.stringify(truth)};
      const p=window.__recog.photos[0];const out=[];
      for(let i=0;i<p.cols.length;i++){
        const want=cols[i]||[];const got=p.cols[i].names||[];
        let exact=0,bad=[];
        const norm=s=>String(s||'').replace(/\\s+/g,'');
        for(let r=0;r<Math.max(want.length,got.length);r++){
          const a=want[r]==null?'-':want[r],b=got[r]==null?'-':got[r];
          if(norm(a)===norm(b))exact++;else bad.push((r+1)+':'+a+'→'+b);
        }
        out.push({col:i+1,want:want.length,exact,bad:bad.slice(0,8),state:p.cols[i].state});
      }
      return out;`, 120000);
    if (has('raw')) {
      const raw = await ev('return window.__recog.photos[0].cols.map(c=>c.raw).join("\\n#####\\n")');
      console.log('\n=== 模型原始输出 ===\n' + raw + '\n');
    }
    let tw = 0, te = 0;
    cmp.forEach(c => {
      if (COLS.length && COLS.indexOf(c.col - 1) < 0) return;
      tw += c.want; te += c.exact;
      console.log('  第' + c.col + '列 ' + c.exact + '/' + c.want + (c.bad.length ? '  错：' + c.bad.join('，') : ''));
    });
    console.log('合计 ' + te + '/' + tw + ' = ' + (te / tw * 100).toFixed(1) + '%');
    summary = await ev('return await window.__recog.packSummary(1, ' + JSON.stringify(NAME) + ')', 300000);
  } else {
    await ev('return window.__recog.setTruth(1, ' + JSON.stringify(truth || []) + ')', 60000);
    console.log('已灌名字（代替 AI）');
    summary = await ev('return await window.__recog.packSummary(1, ' + JSON.stringify(NAME) + ')', 600000);
  }

  console.log('\n=== 表包摘要 ===');
  Object.keys(summary).forEach(k => { if (k !== 'names') console.log('  ' + k + ' = ' + summary[k]); });
  console.log('  前 5 个商品：' + summary.names.slice(0, 5).join(' | '));

  const json = await ev('return window.__recog.lastPackJson', 300000);
  fs.mkdirSync(path.dirname(abs(OUT)), { recursive: true });
  fs.writeFileSync(abs(OUT), json, 'utf8');
  console.log('\n表包已写：' + abs(OUT) + '（' + Math.round(json.length / 1048576 * 100) / 100 + ' MB）');

  const logs = await ev('return window.__recog.logs.slice(-40)');
  console.log('\n=== 页面日志尾部 ===');
  logs.forEach(l => console.log('  ' + l));
  if (errors.length) console.log('\n=== 页面异常 ===\n' + errors.slice(0, 6).join('\n'));

  ws.close(); if (child) child.kill();
  process.exit(0);
})().catch(e => { console.error('探针挂了：', e.message || e); process.exit(1); });
