// 原型：验证"用 JS 在 App 里切图"能切出跟 Python 一样的东西
//
// 三件事一起验：
//   ① 网格检测的坐标跟 grid.json 对得上（否则两边切出来的图不一样）
//   ② 自写的 indexed PNG 编码器产出的文件能被 PIL 正常打开、尺寸对、不是黑图
//   ③ 体积和耗时能不能接受（要存进手机的 IndexedDB，还要在几秒内跑完）
//
// 用法: NODE_PATH=... node tools/proto_crop.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = 'E:/boki/cigpricer';
const PORT = 9341;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TB = path.join(ROOT, 'tables', '香烟');
const OUT = path.join(ROOT, 'tools', '_proto_out');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, 300000);
    });
  }
}
const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const MB = n => (n / 1048576).toFixed(2) + ' MB';
const KB = n => (n / 1024).toFixed(1) + ' KB';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cigproto-'));
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

  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  const cropjs = fs.readFileSync(path.join(ROOT, 'tools', 'cropjs_src.js'), 'utf8');
  const photoB64 = fs.readFileSync(path.join(TB, 'list.jpg')).toString('base64');
  const names = JSON.parse(fs.readFileSync(path.join(TB, 'names.json'), 'utf8'));
  const grid = JSON.parse(fs.readFileSync(path.join(TB, 'grid.json'), 'utf8'));

  // 模拟 App 里已有的那张表（App 会把它当 oldTable 传进来）
  const oldItems = [];
  names.cols.forEach((col, ci) => col.forEach((nm, ri) => {
    if (nm) oldItems.push({ n: nm, c: ci + 1, r: ri + 1 });
  }));
  const oldTable = { nCol: grid.n_col, nRow: grid.n_row, rot: 90, items: oldItems };

  console.log('源照片   %s  %s', path.basename(path.join(TB, 'list.jpg')), KB(photoB64.length * 3 / 4));
  console.log('旧表     %d 列 × %d 行，%d 个已命名商品', grid.n_col, grid.n_row, oldItems.length);
  console.log('');

  const expr = `(async () => {
    ${cropjs}
    const b64 = ${JSON.stringify(photoB64)};
    let bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], 'list.jpg', { type: 'image/jpeg' });

    // 先只做检测，拿来跟 grid.json 比坐标。decode 走 CIGCROP.toDrawable，
    // 跟 App 里完全同一条路径（别在这里另写一个 createImageBitmap 调用）
    const bmp = await CIGCROP.toDrawable(file);
    const probe0 = CIGCROP.analyzeOne(bmp, 0);
    const probe90 = CIGCROP.analyzeOne(bmp, 90);

    const t0 = performance.now();
    const r = await CIGCROP.processPhoto(file, ${JSON.stringify(oldTable)}, (d, t, ph) => {
      if (t) console.log('PROGRESS ' + d + '/' + t);
    });
    const ms = Math.round(performance.now() - t0);

    // 只回传前两格，剩下的量体积用
    const head = r.items.slice(0, 2).map(x => ({ name: x.n, w: x.w, h: x.h, len: x.img.length, img: x.img }));
    const sheetLen = r.sheetImg.length;
    return {
      bmp: [bmp.width, bmp.height],
      deflate: CIGCROP.hasDeflate(),
      p0: { ang: 0, W: probe0.W, H: probe0.H, cols: probe0.cols.length, rows: probe0.rows.length, score: +probe0.score.toFixed(3) },
      p90: { ang: 90, W: probe90.W, H: probe90.H, cols: probe90.cols.length, rows: probe90.rows.length, score: +probe90.score.toFixed(3) },
      colBounds: CIGCROP.analyzeOne(bmp, 90).cols,
      rowBounds: CIGCROP.analyzeOne(bmp, 90).rows,
      n: r.items.length, nCol: r.nCol, nRow: r.nRow, unnamed: r.unnamed,
      ang: r.ang, how: r.how, up: r.up, sheet: [r.W, r.H],
      cellsBytes: r.bytes - sheetLen, sheetLen, ms,
      quant: CIGCROP.encodePNG.last,
      head,
      // 全部格子 + 整表图都带回来（约 4 MB），交给 Python 逐格验收
      all: r.items.map(x => ({ n: x.n, c: x.c, r: x.r, w: x.w, h: x.h, img: x.img })),
      sheetImg: r.sheetImg,
    };
  })()`;

  const out = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  child.kill();
  if (out.exceptionDetails) {
    console.error('页面里报错：', JSON.stringify(out.exceptionDetails, null, 1));
    process.exit(1);
  }
  const r = out.result.value;

  console.log('① 方向判定   浏览器解码 %dx%d', r.bmp[0], r.bmp[1]);
  console.log('   0°   → %dx%d  列组 %d  行 %d  分 %s', r.p0.W, r.p0.H, r.p0.cols, r.p0.rows, r.p0.score);
  console.log('   90°  → %dx%d  列组 %d  行 %d  分 %s   ← 选中', r.p90.W, r.p90.H, r.p90.cols, r.p90.rows, r.p90.score);
  console.log('   选了 %d°（依据 %s），放大 %dx', r.ang, r.how, r.up);

  const cmp = (label, mine, py) => {
    if (mine.length !== py.length) { console.log('   ✗ %s 个数不同: JS %d / PY %d', label, mine.length, py.length); return false; }
    let bad = 0, maxd = 0;
    for (let i = 0; i < mine.length; i++) {
      const m = Math.max(Math.abs(mine[i][0] - py[i][0]), Math.abs(mine[i][1] - py[i][1]));
      if (m > 0) { bad++; maxd = Math.max(maxd, m); }
    }
    console.log('   %s %s  共 %d 项，%d 项有差，最大差 %d px', bad ? '≈' : '✓', label, mine.length, bad, maxd);
    return bad === 0;
  };
  console.log('\n② 跟 Python 的 grid.json 比对');
  cmp('列组边界', r.colBounds, grid.col_bounds);
  cmp('行边界  ', r.rowBounds, grid.row_bounds);
  console.log('   %s 表尺寸   JS %dx%d / PY %dx%d', (r.sheet[0] === grid.sheet[0] && r.sheet[1] === grid.sheet[1]) ? '✓' : '✗', r.sheet[0], r.sheet[1], grid.sheet[0], grid.sheet[1]);

  console.log('\n③ 切图结果');
  console.log('   压缩通道     %s', r.deflate ? 'CompressionStream(deflate)' : 'stored 兜底');
  console.log('   量化         %s（色差中位数 %d，bitDepth %d）',
    r.quant.gray ? '16 级灰 / 4bit' : '16 级灰 + 216 web-safe / 8bit',
    r.quant.medColor, r.quant.bitDepth);
  console.log('   商品 %d 个，未命名格 %d 个（%d 列 × %d 行）', r.n, r.unnamed, r.nCol, r.nRow);
  console.log('   格子图合计 %s   整表图 %s', MB(r.cellsBytes), MB(r.sheetLen));
  console.log('   总耗时 %s 秒', (r.ms / 1000).toFixed(2));

  // 把全部格子和整表图落盘，交给 Python 逐格验
  const allDir = path.join(OUT, 'all');
  fs.rmSync(allDir, { recursive: true, force: true });
  fs.mkdirSync(allDir, { recursive: true });
  const manifest = [];
  for (const it of r.all) {
    const f = `c${it.c}r${String(it.r).padStart(2, '0')}.png`;
    fs.writeFileSync(path.join(allDir, f), Buffer.from(it.img.split(',')[1], 'base64'));
    manifest.push({ f, w: it.w, h: it.h, n: it.n });
  }
  fs.writeFileSync(path.join(OUT, 'sheet_js.png'), Buffer.from(r.sheetImg.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log('\n   已落盘 %d 格 + 整表图 → tools/_proto_out/', manifest.length);

  console.log('\n结论: %s',
    (r.nCol === grid.n_col && r.nRow === grid.n_row && r.n === oldItems.length) ? 'App 端切图可用 ✓' : '有出入，需要确认');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
