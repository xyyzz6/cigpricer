// cigpricer App 冒烟测试 + 出图（CDP / Edge headless）
// 用法: NODE_PATH=... node tools/smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = 'E:/boki/cigpricer';
const SHOTS = path.join(ROOT, 'shots');
const APP = path.join(ROOT, 'build', '烟价速查.html');
const PORT = 9333;
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
      } else if (m.method) {
        (this.handlers[m.method] || []).forEach(f => f(m.params));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, 60000);
    });
  }
  on(m, f) { (this.handlers[m] = this.handlers[m] || []).push(f); }
  once(m) { return new Promise(res => { const f = p => { this.handlers[m] = this.handlers[m].filter(x => x !== f); res(p); }; this.on(m, f); }); }
}

const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cigshot-'));
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
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', p => errors.push('exception: ' + JSON.stringify(p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text)));
  cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') errors.push('console.error: ' + JSON.stringify(p.args.map(a => a.value))); });

  const W = 390, H = 844;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  const url = 'file:///' + encodeURI(APP.replace(/\\/g, '/'));
  await cdp.send('Page.navigate', { url });

  const ev0 = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.value;
  };
  // 轮询等待脚本就绪（比等 loadEventFired 稳，避免 about:blank 的竞态）
  // App 启动是异步的（要先开 IndexedDB 取导入的表），所以等它自己打的 __ready 标记
  const waitReady = async () => {
    for (let i = 0; i < 75; i++) {
      await sleep(400);
      if (await ev0('window.__ready === true && typeof IT !== "undefined" && IT.length >= 0 && typeof search === "function"')) return true;
    }
    return false;
  };
  const ready = await waitReady();
  if (!ready) {
    console.log('诊断:', await ev0('JSON.stringify({url:location.href,rs:document.readyState,title:document.title,hlen:document.body?document.body.innerHTML.length:-1,scripts:document.scripts.length,errs:' + JSON.stringify(errors) + '})'));
    console.log('所有异常:', errors.join(' | '));
    ws.close(); child.kill(); throw new Error('页面脚本未就绪（window.__ready 没置上）');
  }
  await sleep(600);

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('evaluate 失败: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const f = path.join(SHOTS, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    return f;
  };

  const results = [];
  const check = (label, ok, extra) => { results.push({ label, ok: !!ok, extra: extra === undefined ? '' : String(extra) }); };

  // 1. 数据完整性（多表：断言写成对任意表集都成立）
  //    RAW = 构建期写死的内置表；TBL/IT = 运行期可见表（内置去掉已移除的 + 导入的）
  const nItems = await ev('IT.length');
  const nTables = await ev('TBL.length');
  check('表数 >= 1', nTables >= 1, nTables);
  check('可见商品总数 = 各表合计', nItems === await ev('TBL.reduce((a,b)=>a+b.items.length,0)'), nItems);
  check('每张表都有整表图', await ev('TBL.every(t=>t.sheetImg.length>1000)'));
  check('每张表都有列标签', await ev('TBL.every(t=>t.colLabels && t.colLabels.length>0)'));
  check('每个商品都指向有效的表', await ev('IT.every(x=>x.t>=0 && x.t<TBL.length)'));
  check('商品 id 连续且唯一', await ev('IT.every((x,i)=>x.i===i)'));
  check('所有小图都是内嵌 data URI', await ev('IT.every(x=>x.img.startsWith("data:image/png;base64,") && x.img.length>800)'));
  check('商品名无空值', await ev('IT.every(x=>x.n && x.n.length>0)'));
  check('内置表结构与表包结构一致（都自带 items）',
    await ev('RAW.tables.every(t=>t.name && Array.isArray(t.items) && t.nCol && t.colLabels && t.sheetImg)'));
  check('本机存储可用（IndexedDB）', await ev('STORE_OK') === true, await ev('STORE_WHY'));

  // 2. 首屏（品牌快捷入口）
  check('首屏出现品牌快捷入口', await ev('document.querySelectorAll("#hot .chips b").length') >= 10, await ev('document.querySelectorAll("#hot .chips b").length'));
  await shot('01-首屏.png');

  // 3. 搜索命中（用户给过的例子）
  await ev('(()=>{const q=document.querySelector("#q");q.value="感恩";q.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(400);
  const r1 = await ev('JSON.stringify(search("感恩").map(x=>x.n))');
  check('搜 "感恩" 命中中支感恩黄鹤楼', JSON.parse(r1).includes('中支感恩黄鹤楼'), r1);
  check('结果区渲染了卡片', await ev('document.querySelectorAll("#res .card").length') > 0, await ev('document.querySelectorAll("#res .card").length'));
  check('卡片图片已加载（naturalWidth>0）', await ev('[...document.querySelectorAll("#res .card img")].every(i=>i.naturalWidth>0)'));
  // 关键不变量：卡片里的截图必须等比完整显示 —— 曾出现"价格被切一半"的事故
  const geo = JSON.parse(await ev(`JSON.stringify((()=>{
    const c = document.querySelector('#res .card');
    const im = c.querySelector('.shot img'), sh = c.querySelector('.shot');
    const r = im.getBoundingClientRect(), sr = sh.getBoundingClientRect();
    return {shown:+(r.width/r.height).toFixed(3), nat:+(im.naturalWidth/im.naturalHeight).toFixed(3),
            imgW:Math.round(r.width), boxW:Math.round(sr.width),
            ratio:CSS.supports('aspect-ratio','1/1')};
  })())`));
  check('卡片图片等比显示（未变形）', Math.abs(geo.shown - geo.nat) < 0.02, JSON.stringify(geo));
  check('卡片图片未被容器裁切', geo.imgW <= geo.boxW + 1, `图 ${geo.imgW}px / 框 ${geo.boxW}px`);
  check('截图区锁定宽高比（图片加载前不跳版）', geo.ratio);
  await shot('02-搜索感恩.png');

  // 4. 打开全屏看图
  await ev('document.querySelector("#res .card").click()');
  await sleep(400);
  check('全屏查看器已打开', await ev('document.querySelector("#viewer").classList.contains("on")'));
  check('查看器图片有内容', await ev('document.querySelector("#vimg").naturalWidth>0 && document.querySelector("#vimg").src.length>800'));
  check('查看器显示商品名', await ev('document.querySelector("#vttl").textContent.length>1'), await ev('document.querySelector("#vttl").textContent'));
  await shot('03-全屏看图.png');
  await ev('document.querySelector("#vzoom").click()'); await sleep(250);
  check('放大按钮生效', await ev('document.querySelector("#vimg").style.width') === '260%', await ev('document.querySelector("#vimg").style.width'));
  await shot('04-放大.png');
  await ev('document.querySelector("#vclose").click()'); await sleep(250);
  check('返回后查看器关闭', !(await ev('document.querySelector("#viewer").classList.contains("on")')));

  /* 4b. 返回键钩子 —— 安卓壳的返回键完全靠它（壳只负责把 true/false 翻译成退不退 App）。
     ⚠️ 这几条在浏览器里跑得动不代表手机上就对，但**至少能守住"钩子被删了"**：
        钩子一旦消失，壳的行为会退化成"在任何页面按返回都直接退出 App"。 */
  check('返回键钩子存在（安卓壳依赖它）', await ev('typeof window.__backHook') === 'function');
  check('搜索页、没开图 → 钩子放行（交给系统退出）', await ev('window.__backHook()') === false);
  await ev('document.querySelector("#res .card").click()'); await sleep(400);
  check('开着全屏图 → 钩子判为已消费', await ev('window.__backHook()') === true);
  check('钩子确实关掉了全屏图', !(await ev('document.querySelector("#viewer").classList.contains("on")')));
  await ev('document.querySelector(".tabs button[data-tab=\'p-all\']").click()'); await sleep(350);
  check('非搜索页 → 钩子判为已消费', await ev('window.__backHook()') === true);
  check('钩子确实切回了搜索页', await ev('document.querySelector(".tabs button.on").dataset.tab') === 'p-search');
  check('已回到搜索页 → 再按一次才放行', await ev('window.__backHook()') === false);

  // 5. 模糊/跳字搜索
  const cases = [['万宝路', 5], ['中华', null], ['利群', null], ['中支中华', 4], ['玉溪', null]];
  for (const [kw, expect] of cases) {
    const n = await ev(`search(${JSON.stringify(kw)}).length`);
    check(`搜 "${kw}" 有结果` + (expect ? ` 且 =${expect}` : ''), n > 0 && (expect === null || n === expect), n);
  }
  const r555 = JSON.parse(await ev('JSON.stringify(search("555").map(x=>x.n))'));
  check('搜 "555" 前几个都是 555 系列', r555.slice(0, 5).every(x => x.endsWith('555')), JSON.stringify(r555));
  check('搜 "555" 不含只有单个5的商品', !r555.includes('土楼1575'), JSON.stringify(r555));
  const rT = JSON.parse(await ev('JSON.stringify(search("黄鹤搂", true).map(x=>x.n))'));
  check('错别字 "黄鹤搂" 兜底能找到黄鹤楼', rT.some(x => x.indexOf('黄鹤楼') >= 0), JSON.stringify(rT.slice(0, 5)));
  check('搜 "不存在xyz" 返回 0 条', await ev('search("不存在xyz").length') === 0);
  check('搜 "不存在xyz" 兜底也为 0 条', await ev('search("不存在xyz", true).length') === 0);
  await ev('(()=>{document.querySelector("#q").value="";document.querySelector("#q").dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(300);
  await ev('(()=>{document.querySelector("#q").value="黄鹤楼";document.querySelector("#q").dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(400);
  await shot('05-搜索黄鹤楼.png');

  // 6. 全部 tab
  await ev('document.querySelector("[data-tab=\'p-all\']").click()'); await sleep(400);
  check('全部页分组数 = 各表列数之和', await ev('document.querySelectorAll("#groups .grp").length') === await ev('TBL.reduce((a,b)=>a+b.nCol,0)'), await ev('document.querySelectorAll("#groups .grp").length'));
  check('全部页商品总数 = items 总数', await ev('document.querySelectorAll("#groups .items span").length') === nItems, await ev('document.querySelectorAll("#groups .items span").length'));
  check('全部页有表段落', await ev('document.querySelectorAll("#groups .tsec").length') >= 1, await ev('document.querySelectorAll("#groups .tsec").length'));

  // 多表专项（只有一张表时跳过）
  if (nTables > 1) {
    check('多表：显示了表筛选', await ev('document.querySelectorAll("#tfilter b").length') >= nTables, await ev('document.querySelectorAll("#tfilter b").length'));
    check('多表：卡片带表名标签', await ev('document.querySelectorAll("#res .card .tb").length') > 0);
    const t0 = await ev('TBL[0].name');
    // 每张表的商品，过滤后只应剩下本表的
    let allOk = true, detail = '';
    for (let ti = 0; ti < nTables; ti++) {
      const bad = await ev(`search("${t0}", false, ${ti}).filter(x=>x.t!==${ti}).length`);
      if (bad > 0) { allOk = false; detail = '表 ' + ti + ' 混入 ' + bad + ' 条'; }
    }
    check('多表：按表筛选后结果不串表', allOk, detail);
    const inAny = JSON.parse(await ev(`JSON.stringify(TBL.map((t,ti)=>{const w=IT.find(x=>x.t===ti);return w?w.n:''}))`));
    const found = JSON.parse(await ev(`JSON.stringify(${JSON.stringify(inAny)}.map(n=>search(n).some(x=>x.n===n)))`));
    check('多表：每张表的商品都能搜到', found.every(Boolean), JSON.stringify(inAny));
    // 跨表搜索 + 表筛选的界面留一张图
    await ev('document.querySelector("[data-tab=\'p-search\']").click()');
    await sleep(300);
    await ev(`(()=>{const q=document.querySelector("#q");q.value=${JSON.stringify(inAny[0])};q.dispatchEvent(new Event("input",{bubbles:true}));})()`);
    await sleep(500);
    check('多表：搜索结果带表名标签', await ev('document.querySelectorAll("#res .card .tb").length') > 0);
    await shot('11-多表搜索.png');
  }
  // 展开所有分组再截图
  await ev('document.querySelectorAll("#groups .grp").forEach(d=>d.open=true)');
  await sleep(300);
  await shot('06-全部.png');
  await ev('document.querySelector("#groups .items span").click()'); await sleep(350);
  check('从"全部"点商品能打开看图', await ev('document.querySelector("#viewer").classList.contains("on")'));
  const vtxt = await ev('document.querySelector("#vidx").textContent');
  check('查看器显示列/行位置', /第 \d+ 列/.test(vtxt), vtxt);
  await ev('document.querySelector("#vclose").click()'); await sleep(200);

  // 7. 原表 tab
  await ev('document.querySelector("[data-tab=\'p-sheet\']").click()'); await sleep(700);
  check('原表图已加载', await ev('document.querySelector("#sheetimg").naturalWidth>0'), await ev('document.querySelector("#sheetimg").naturalWidth+"x"+document.querySelector("#sheetimg").naturalHeight'));
  check('原表图实际渲染出宽度（面板切回来要重算）', await ev('document.querySelector("#sheetimg").getBoundingClientRect().width') > 100, await ev('Math.round(document.querySelector("#sheetimg").getBoundingClientRect().width)'));
  await shot('07-原表.png');
  await ev('document.querySelector("#zin").click()'); await sleep(300);
  check('原表放大按钮生效', await ev('document.querySelector("#lv").textContent') === '150%', await ev('document.querySelector("#lv").textContent'));
  await shot('08-原表放大.png');
  await ev('document.querySelector("#zfit").click()');

  // 8. 可点区域尺寸
  const small = await ev(`(()=>{
    const bad=[];
    document.querySelectorAll('.card, .items span, .tabs button, .chips b, #viewer button').forEach(el=>{
      const r=el.getBoundingClientRect();
      if(r.width>0 && (r.height<28||r.width<28)) bad.push(el.className+':'+Math.round(r.width)+'x'+Math.round(r.height));
    });
    return bad.slice(0,8);
  })()`);
  check('可点元素均 >= 28px', small.length === 0, JSON.stringify(small));

  // 9. 顶栏没被安全区吃掉 / 无横向溢出
  check('无横向溢出', await ev('document.documentElement.scrollWidth <= window.innerWidth + 1'), await ev('document.documentElement.scrollWidth+" vs "+window.innerWidth'));

  /* ================= 10. 管理页：导入新表 / 删除旧表 / 恢复 ================= */
  const FIX = p => path.join(ROOT, 'tools', 'fixtures', p).replace(/\//g, '\\');
  /** 一张真的价目表照片。两个地方要用它：
   *  ① 验证"误把照片当表包导入"的提示（本节）；② 后面「换照片」那节真的拿它去切图。 */
  const PHOTO = path.join(ROOT, 'tables', '香烟', 'list.jpg').replace(/\//g, '\\');
  await cdp.send('DOM.enable');
  // 走真实的文件选择器路径（CDP 直接把文件塞进 input[type=file] 并触发 change）
  const setFiles = async (selector, files) => {
    const root = await cdp.send('DOM.getDocument', { depth: 1 });
    const n = await cdp.send('DOM.querySelector', { nodeId: root.root.nodeId, selector });
    if (!n || !n.nodeId) throw new Error('找不到文件输入框 ' + selector);
    await cdp.send('DOM.setFileInputFiles', { nodeId: n.nodeId, files });
  };
  const mgrN = () => ev('document.querySelectorAll("#mgrlist .trow").length');
  const hidN = () => ev('document.querySelectorAll("#mgrhidden .trow").length');
  const mgrMsg = () => ev('document.querySelector("#mgrmsg").textContent');
  const storeN = () => ev('dbAll().then(a=>a.length)');

  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(400);
  // 4 个 + 2026-09-25 新增的「认字」（内嵌联网页，认完直接入库）
  check('页签共 5 个（含「管理」「认字」）', await ev('document.querySelectorAll(".tabs button").length') === 5, await ev('document.querySelectorAll(".tabs button").length'));
  check('「认字」页签存在', await ev(`!!document.querySelector("[data-tab='p-ocr']")`));
  check('认字页是懒加载的（没点过就不加载 iframe）', await ev(`!document.getElementById('ocrframe').srcdoc`));
  check('管理页列出 1 张表', await mgrN() === 1, await mgrN());
  check('内置表标了「内置的」', await ev('document.querySelectorAll("#mgrlist .src").length') === 1);
  check('没有已移除的表时该区块为空', await hidN() === 0);
  check('导入按钮可点', await ev(`document.querySelector('.impbtn').getBoundingClientRect().height`) >= 28);
  await shot('13-管理页.png');

  // --- 导入新表 ---
  await setFiles('#impfile', [FIX('测试酒水.cigtable.json')]);
  await sleep(1500);
  check('导入后表数 = 2', await mgrN() === 2, await mgrN());
  check('导入后商品总数 = 原 + 6', await ev('IT.length') === nItems + 6, await ev('IT.length'));
  check('导入的表能搜到', await ev('search("飞天茅台").length') > 0);
  check('导入的表标了「导入的」', await ev('document.querySelectorAll("#mgrlist .src.im").length') === 1);
  check('顶栏统计跟着变', (await ev('document.querySelector("#tsub").textContent')).indexOf('2 张表') >= 0, await ev('document.querySelector("#tsub").textContent'));
  check('提示语说「已导入」', (await mgrMsg()).indexOf('已导入') >= 0, await mgrMsg());
  check('导入的表进了本机存档', await storeN() === 1, await storeN());
  await shot('14-管理页-导入后.png');

  // --- 同名表再导入 = 更新，而不是变成两张 ---
  await setFiles('#impfile', [FIX('测试酒水-更新.cigtable.json')]);
  await sleep(1500);
  check('同名表再导入仍是 2 张（更新语义）', await mgrN() === 2, await mgrN());
  check('更新后商品数 = 原 + 7', await ev('IT.length') === nItems + 7, await ev('IT.length'));
  check('更新后能搜到新加的商品', await ev('search("国窖1573").length') > 0);
  check('更新后日期跟着新表', (await ev('document.querySelectorAll("#mgrlist .tn i")[1].textContent')).indexOf('10月1日') >= 0, await ev('document.querySelectorAll("#mgrlist .tn i")[1].textContent'));
  check('提示语说「已更新」', (await mgrMsg()).indexOf('已更新') >= 0, await mgrMsg());
  check('更新是覆盖，存档里还是 1 张', await storeN() === 1, await storeN());

  /* --- ★ 一次选多个表包 = 店主「同时添加很多张」对应的那一步 --------------
     file input 带 multiple，所以「导入表包」能一次全选。这里一次给两个文件：
     一个全新的（测试饮料）+ 一个同名的（测试酒水）—— 顺带验证"新增"和"更新"
     能在同一次里各走各的，而不是只处理第一个。 */
  await setFiles('#impfile', [FIX('测试饮料.cigtable.json'), FIX('测试酒水-更新.cigtable.json')]);
  await sleep(2200);
  check('一次选两个表包：全都进来了（2 → 3 张）', await mgrN() === 3, await mgrN());
  check('批量导入：全新那张能搜到', await ev('search("可口可乐").length') > 0);
  check('批量导入：同名那张走了"更新"', await ev('search("国窖1573").length') > 0);
  check('批量导入提示里"已导入"和"已更新"都在',
    (await mgrMsg()).indexOf('已导入') >= 0 && (await mgrMsg()).indexOf('已更新') >= 0, await mgrMsg());
  await shot('14c-管理页-一次导入多个表包.png');
  // 收工：把新加的测试饮料删掉，让后面几节回到原来那 2 张表
  await ev(`document.querySelector('#mgrlist button[data-del="测试饮料"]').click()`); await sleep(900);
  check('删掉新表后回到 2 张', await mgrN() === 2, await mgrN());

  // --- 坏包要被挡住 ---
  await setFiles('#impfile', [FIX('坏包.json')]);
  await sleep(1200);
  check('坏包不改变表数', await mgrN() === 2, await mgrN());
  check('坏包给出错误提示', (await ev('document.querySelector("#mgrmsg").className')).indexOf('err') >= 0, await mgrMsg());

  /* --- ★ 店主实测踩的那一步：跑到「导入表包」里选了一张照片 ---
     他的原话是「app 导入不了图片」（2026-09-24）。当时这里只会吐一句 JSON 报错。
     现在这个口子也吃照片：acceptFiles 直接把它转给「用照片加表」——
     也就是"导入图片 → App 自己切格 → 表就在列表里"，不再需要他分清入口。
     这里验完点「取消」，因为下一节要验的正是「换照片」那条路。 */
  await setFiles('#impfile', [PHOTO]);
  await sleep(1300);
  check('在「导入表包」里选照片：自动弹起名框（转给「用照片加表」）',
    await ev(`document.querySelector('#askname').classList.contains('on')`));
  check('在「导入表包」里选照片：起名框先说清"想更新价格该怎么退"',
    (await ev(`document.querySelector('#askbd').textContent`)).indexOf('换照片') >= 0,
    await ev(`document.querySelector('#askbd').textContent`).then(t => t.slice(0, 60)));
  await shot('14b-管理页-照片自动转成加表.png');
  await ev(`document.querySelector('#askcancel').click()`); await sleep(800);
  check('起名框点取消：表数不变', await mgrN() === 2, await mgrN());
  check('照片不再被当成坏表包报错', (await mgrMsg()).indexOf('没能导入') < 0, await mgrMsg());

  // --- 删除内置表 = 移除 + 可恢复 ---
  await ev(`document.querySelector('#mgrlist button[data-del="b:香烟"]').click()`);
  await sleep(1000);
  check('删掉内置表后清单剩 1 张', await mgrN() === 1, await mgrN());
  check('被删的内置表进了「已移除」', await hidN() === 1, await hidN());
  check('被删的表不再参与搜索', await ev('search("玉溪").length') === 0, await ev('search("玉溪").length'));
  check('商品总数跟着减到 7', await ev('IT.length') === 7, await ev('IT.length'));
  check('移除写进了本机存档', (await ev('localStorage.getItem("cigpricer.removed")') || '').indexOf('b:香烟') >= 0, await ev('localStorage.getItem("cigpricer.removed")'));
  await shot('15-管理页-已移除.png');

  // --- 刷新页面：导入的表和移除记录都还在（这才叫"存住了"） ---
  await cdp.send('Page.navigate', { url });
  await sleep(1500);
  if (!(await waitReady())) throw new Error('刷新后页面没就绪');
  await sleep(700);
  check('刷新后：导入的表还在', await ev('TBL.length') === 1 && (await ev('TBL[0].name')) === '测试酒水', await ev('JSON.stringify(TBL.map(t=>t.name))'));
  check('刷新后：移除记录还在', (await ev('localStorage.getItem("cigpricer.removed")') || '').indexOf('b:香烟') >= 0);

  // --- 恢复 ---
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(400);
  await ev(`document.querySelector("#mgrhidden button[data-res]").click()`); await sleep(1000);
  check('恢复后表数 = 2', await ev('TBL.length') === 2, await ev('TBL.length'));
  check('恢复后又能搜到内置表的商品', await ev('search("玉溪").length') > 0);
  check('「已移除」区块清空', await hidN() === 0, await hidN());

  // --- 删除导入的表 = 真删（本机存档里也没了） ---
  await ev(`document.querySelector('#mgrlist button[data-del="测试酒水"]').click()`);
  await sleep(1000);
  check('删掉导入表后清单剩 1 张', await ev('TBL.length') === 1, await ev('TBL.length'));
  check('真删后搜不到了', await ev('search("飞天茅台").length') === 0);
  check('真删后本机存档也空了', await storeN() === 0, await storeN());
  check('回到只有内置表的状态', await ev('TBL[0].src') === 'builtin' && await ev('IT.length') === nItems, await ev('TBL[0].name'));

  /* --- 彻底删掉内置表：不进「已移除」，永久消失 -------------------------
     店主的场景（2026-09-24 原话）：「我要同时添加很多张图片，再把内置的删掉」——
     加了自己的一批新品类之后，不想要自带的那张示例表。原来「删除」只是把它放进
     「已移除」，他觉得不够干净，所以「已移除」里再给一个「彻底删掉」。
     不可逆 → 点两次才生效（第一次只是把按钮武装起来）。 */
  await ev(`document.querySelector('#mgrlist button[data-del="b:香烟"]').click()`); await sleep(900);
  check('彻底删之前：先落到「已移除」', await hidN() === 1, await hidN());
  await ev(`document.querySelector('#mgrhidden button[data-purge]').click()`); await sleep(500);
  const armTxt = await ev(`document.querySelector('#mgrhidden button[data-purge]').textContent`);
  check('第一次点「彻底删掉」只是武装，没真删', (await hidN()) === 1 && armTxt === '再点一次',
    armTxt + ' / 已移除 ' + await hidN());
  await shot('15b-管理页-彻底删掉-待确认.png');
  await ev(`document.querySelector('#mgrhidden button[data-purge]').click()`); await sleep(900);
  check('第二次点才真删：可见表里没有它了', await ev(`TBL.some(t=>t.name==='香烟')`) === false,
    await ev('JSON.stringify(TBL.map(t=>t.name))'));
  check('彻底删掉后「已移除」区块是空的', await hidN() === 0, await hidN());
  check('彻底删掉写进了存档（x:香烟）',
    (await ev('localStorage.getItem("cigpricer.removed")') || '').indexOf('x:香烟') >= 0,
    await ev('localStorage.getItem("cigpricer.removed")'));
  check('彻底删掉后搜不到它的商品', await ev('search("玉溪").length') === 0);
  check('一张表都没有时管理页给空状态、不报错',
    (await mgrN()) === 0 && (await ev(`document.querySelector('#mgrlist .empty') !== null`)));

  /* --- 0 张表时的"指路"：店主最容易卡在这一格 -----------------------------
     他刚把唯一的表删干净，管理页却还在说「在下面那张表上点「换照片」」——
     可下面什么都没有。2026-09-24 他就是这么来问「怎么导入照片」的。
     所以这里守两条：顶部说明必须换掉；0 张表时也要有一条"照片 → 表"的直路。 */
  check('0 张表时不再讲「在下面那张表上点换照片」',
    (await ev(`getComputedStyle(document.querySelector('#mgrhint')).display`)) === 'none',
    await ev(`getComputedStyle(document.querySelector('#mgrhint')).display`));
  check('0 张表时改为显示写清楚现状的那段',
    (await ev(`getComputedStyle(document.querySelector('#mgrempty')).display`)) !== 'none',
    await ev(`getComputedStyle(document.querySelector('#mgrempty')).display`));
  const emptyTxt = await ev(`document.querySelector('#mgrempty').textContent`);
  check('那段里说完"没有换照片按钮"，就把「用照片加表」当起步动作指出来',
    emptyTxt.indexOf('用照片加表') >= 0, emptyTxt.replace(/\s+/g, ' ').slice(0, 90));
  check('那段里也留着"导入表包"这条路（助手做的正式表包）',
    emptyTxt.indexOf('导入表包') >= 0, emptyTxt.replace(/\s+/g, ' ').slice(0, 90));
  check('空状态不再说"在下面把移除的表恢复回来"（下面根本没有那个区）',
    (await ev(`document.querySelector('#mgrlist .empty').textContent`)).indexOf('恢复回来') < 0,
    await ev(`document.querySelector('#mgrlist .empty').textContent`));

  /* 0 张表时塞照片：这里也**不该**再说"发给助手"—— App 自己就能把它变成一张表
     （这正是店主 2026-09-25 要的"全套流程"）。 */
  await setFiles('#impfile', [PHOTO]); await sleep(1300);
  check('0 张表时塞照片：照样弹起名框（App 自己建表，不用先发给助手）',
    await ev(`document.querySelector('#askname').classList.contains('on')`));
  check('0 张表时起名框里不提「换照片」（那按钮此刻根本不存在）',
    (await ev(`document.querySelector('#askbd').textContent`)).indexOf('换照片') < 0,
    await ev(`document.querySelector('#askbd').textContent`).then(t => t.slice(0, 60)));
  await ev(`document.querySelector('#askcancel').click()`); await sleep(800);
  check('0 张表时点取消：仍然 0 张（没白建表）', await mgrN() === 0, await mgrN());

  // 刷新一次：确认不是"暂时藏起来"，而是真的不再挂出来
  await cdp.send('Page.navigate', { url }); await sleep(1500);
  if (!(await waitReady())) throw new Error('刷新后页面没就绪');
  await sleep(700);
  check('刷新后：内置表仍然不在', await ev(`TBL.some(t=>t.name==='香烟')`) === false,
    await ev('JSON.stringify(TBL.map(t=>t.name))'));
  check('刷新后：「已移除」里也没有它', await hidN() === 0, await hidN());
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(500);
  await shot('15c-管理页-彻底删掉后.png');

  /* 还原现场：「彻底删掉」只写名单，照片和切图一直都在 —— 清掉标记它就回来
     （后面「换照片」那节还要用这张内置表）。 */
  await ev(`REMOVED.delete(XKEY + '香烟'); saveRemoved()`); await sleep(600);
  await cdp.send('Page.navigate', { url }); await sleep(1500);
  if (!(await waitReady())) throw new Error('刷新后页面没就绪');
  await sleep(700);
  check('清掉标记它就回来（数据没动，只是名单在控制）', await ev(`TBL.some(t=>t.name==='香烟')`),
    await ev('JSON.stringify(TBL.map(t=>t.name))'));

  // 反过来也要守：有表了，顶部那段「换照片」说明得回来，0 张表那段得收起
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(400);
  check('有表时切回「换照片」那段说明，0 张表那段收起',
    (await ev(`getComputedStyle(document.querySelector('#mgrhint')).display`)) !== 'none' &&
    (await ev(`getComputedStyle(document.querySelector('#mgrempty')).display`)) === 'none',
    await ev(`getComputedStyle(document.querySelector('#mgrhint')).display + ' / ' +
              getComputedStyle(document.querySelector('#mgrempty')).display`));

  // 10. 深色模式再出一张
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await ev('document.querySelector("[data-tab=\'p-search\']").click()'); await sleep(500);
  await shot('09-深色模式.png');

  // 11. 桌面宽屏（老板在电脑上看的场景）：卡片里的截图要又大又完整
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(400);
  await ev('(()=>{const q=document.querySelector("#q");q.value="中华";q.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(600);
  const dgeo = JSON.parse(await ev(`JSON.stringify((()=>{
    const c = document.querySelector('#res .card'), im = c.querySelector('.shot img'), sh = c.querySelector('.shot');
    const r = im.getBoundingClientRect(), sr = sh.getBoundingClientRect();
    return {shown:+(r.width/r.height).toFixed(3), nat:+(im.naturalWidth/im.naturalHeight).toFixed(3),
            imgW:Math.round(r.width), boxW:Math.round(sr.width), h:Math.round(r.height)};
  })())`));
  check('桌面宽屏：卡片图等比且不裁', Math.abs(dgeo.shown - dgeo.nat) < 0.02 && dgeo.imgW <= dgeo.boxW + 1, JSON.stringify(dgeo));
  check('桌面宽屏：卡片图高度够看（>= 90px）', dgeo.h >= 90, dgeo.h + 'px');
  await shot('10-桌面宽屏.png');

  // 12. 桌面宽屏下的管理页（老板平时就是在电脑上用的）
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(400);
  await setFiles('#impfile', [FIX('测试酒水.cigtable.json')]);
  await sleep(1500);
  check('桌面宽屏：导入后表数 = 2', await ev('TBL.length') === 2, await ev('TBL.length'));
  check('桌面宽屏：管理页卡片没被拉伸变形', await ev(`(()=>{const r=document.querySelector('#mgrlist .trow').getBoundingClientRect();return r.width<=881&&r.width>400})()`), await ev(`Math.round(document.querySelector('#mgrlist .trow').getBoundingClientRect().width)`));
  await shot('16-管理页-桌面.png');
  await ev(`document.querySelector('#mgrlist button[data-del="测试酒水"]').click()`); await sleep(900);
  check('桌面宽屏：删掉后又只剩内置表', await ev('TBL.length') === 1, await ev('TBL.length'));

  /* ================= 13. 换照片：相册里选一张新价格照，App 自己切格 =================
     这是店主最常用的更新方式（比"发照片给助手再导入表包"快得多）。
     走真实路径：点「换照片」→ 系统文件选择器 → 选照片 → App 切图 → 存本机。
     桌面能直接给路径，所以用 DOM.setFileInputFiles；手机上不行（路径属于电脑），
     设备验证走 DataTransfer 合成 File（见 android/verify.js）。 */
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(300);
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
  const busyOn = () => ev(`document.querySelector('#busy').classList.contains('on')`);
  const waitIdle = async () => {
    for (let i = 0; i < 90; i++) { if (!(await busyOn())) return true; await sleep(400); }
    return false;
  };
  const builtinImg = await ev('RAW.tables[0].items[0].img.length');

  check('表行有「换照片」按钮', await ev(`document.querySelectorAll("#mgrlist button[data-photo]").length`) === 1);
  await ev(`document.querySelector('#mgrlist button[data-photo]').click()`);
  await sleep(300);
  await setFiles('#shootfile', [PHOTO]);
  await sleep(200);
  check('切图时出现进度遮罩', await busyOn());
  check('处理完进度遮罩收起', await waitIdle());
  await sleep(700);

  check('换照片后仍是 1 张表（不会多出一张）', await ev('TBL.length') === 1, await ev('TBL.length'));
  check('换照片后表名 / 日期没变', (await ev('TBL[0].name')) === '香烟' && (await ev('TBL[0].date')) === '8月14日', await ev('TBL[0].name + " " + TBL[0].date'));
  check('换过的表标了「换过照片」', (await ev('TBL[0].src')) === 'photo', await ev('TBL[0].src'));
  check('商品数没变（名字沿用上一版）', await ev('IT.length') === nItems, await ev('IT.length'));
  check('确实换成了新切的图（与内置那份不同）', await ev('TBL[0].items[0].img.length') !== builtinImg, builtinImg + ' → ' + await ev('TBL[0].items[0].img.length'));
  check('提示语说「已用新照片更新」', (await mgrMsg()).indexOf('已用新照片更新') >= 0, await mgrMsg());
  check('出现「撤销」按钮', await ev(`document.querySelectorAll("#mgrlist button[data-undo]").length`) === 1);
  check('换过的表存进了本机', await ev('dbAll().then(a=>a.filter(t=>String(t.id).indexOf("u:")!==0).length)') === 1);
  check('撤销用的备份也写了', await ev('dbAll().then(a=>a.filter(t=>String(t.id).indexOf("u:")===0).length)') === 1);
  await shot('17-管理页-换过照片.png');

  // 卡片里的图仍要等比完整（换照片会重新生成所有格子，最容易在这里把尺寸搞错）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false });
  await ev('document.querySelector("[data-tab=\'p-search\']").click()');
  await ev('(()=>{const q=document.querySelector("#q");q.value="中华";q.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(700);
  const pgeo = JSON.parse(await ev(`JSON.stringify((()=>{
    const im=document.querySelector('#res .card .shot img');
    const r=im.getBoundingClientRect();
    return {shown:+(r.width/r.height).toFixed(3), nat:+(im.naturalWidth/im.naturalHeight).toFixed(3), h:Math.round(r.height)};
  })())`));
  check('换照片后卡片图仍等比且不裁', Math.abs(pgeo.shown - pgeo.nat) < 0.02 && pgeo.h >= 90, JSON.stringify(pgeo));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(300);

  // --- 刷新：换过的照片必须还在（这才是真的存住了） ---
  await cdp.send('Page.navigate', { url });
  await sleep(1500);
  if (!(await waitReady())) throw new Error('刷新后页面没就绪');
  await sleep(700);
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(300);
  check('刷新后：换过的照片还在', (await ev('TBL[0].src')) === 'photo' && await ev('IT.length') === nItems, await ev('TBL[0].src'));
  check('刷新后：撤销按钮还在', await ev(`document.querySelectorAll("#mgrlist button[data-undo]").length`) === 1);

  // --- 撤销 = 退回换照片之前 ---
  await ev(`document.querySelector('#mgrlist button[data-undo]').click()`);
  await sleep(1800);
  check('撤销后回到内置的那张', (await ev('TBL[0].src')) === 'builtin', await ev('TBL[0].src'));
  check('撤销后图也换回内置那份', await ev('TBL[0].items[0].img.length') === builtinImg, await ev('TBL[0].items[0].img.length'));
  check('撤销后本机存档清空', await ev('dbAll().then(a=>a.length)') === 0, await ev('dbAll().then(a=>a.length)'));
  check('撤销后「撤销」按钮消失', await ev(`document.querySelectorAll("#mgrlist button[data-undo]").length`) === 0);

  /* --- 拒绝路径：选错照片绝不能默默错位（错位 = 搜出来的价格张冠李戴） --- */
  // 造一张 5 列 8 行的假表格：列数（5）跟「香烟」（8）对不上，必须被拦住
  const injectFake = async (kind) => ev(`(() => {
    document.querySelector('#mgrlist button[data-photo]').click();     // 先选好"给谁换"
    const cv = document.createElement('canvas');
    if (${JSON.stringify(kind)} === 'grid'){
      cv.width = 900; cv.height = 600;
      const x = cv.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 600);
      x.strokeStyle = '#000'; x.lineWidth = 3;
      for (let c = 0; c <= 5; c++){ x.beginPath(); x.moveTo(20 + c * 170, 20); x.lineTo(20 + c * 170, 580); x.stroke(); }
      for (let r = 0; r <= 8; r++){ x.beginPath(); x.moveTo(20, 20 + r * 70); x.lineTo(870, 20 + r * 70); x.stroke(); }
    } else {
      cv.width = 600; cv.height = 400;                            // 纯白：没有任何表格线
      const x = cv.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 400);
    }
    return new Promise(res => cv.toBlob(b => {
      const dt = new DataTransfer();
      dt.items.add(new File([b], 'x.png', { type: 'image/png' }));
      const inp = document.querySelector('#shootfile');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      res(true);
    }, 'image/png'));
  })()`);

  await injectFake('grid');
  await waitIdle(); await sleep(500);
  check('列数对不上的照片被拒绝', (await mgrMsg()).indexOf('格式对不上') >= 0, await mgrMsg());
  check('被拒绝后提示是错误样式', (await ev(`document.querySelector('#mgrmsg').className`)).indexOf('err') >= 0);
  check('被拒绝后表还是内置的那张', (await ev('TBL[0].src')) === 'builtin');
  check('被拒绝后没留下任何存档', await ev('dbAll().then(a=>a.length)') === 0, await ev('dbAll().then(a=>a.length)'));

  await injectFake('blank');
  await waitIdle(); await sleep(500);
  check('没表格线的照片被拒绝', (await mgrMsg()).indexOf('没找到表格线') >= 0, await mgrMsg());
  check('被拒绝后商品数没变', await ev('IT.length') === nItems, await ev('IT.length'));
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false });

  /* --- 用照片加表：店主不经过助手也能加新品类 -----------------------------
     这条路的价值是"不用等助手"；代价是**商品名只能先编号**（App 不认字，
     读不出"飞天茅台"就绝不去猜）。所以这里两头都要守：
       ① 照片确实能变成一张能翻的表；
       ② 「编号 → 看图时改名 → 能搜」这条补救链真的通。
     断言里注意：list.jpg 会被 guessName 去掉扩展名当预填名。 */
  check('（前置）加表前只有内置那张', await mgrN() === 1, await mgrN());

  check('相机/截图/微信那串文件名不当表名',
    await ev(`['IMG_20260924_223512.jpg','Screenshot_2026-09-24-22-31-08.png','wx_camera_1.jpg',
              'mmexport1699999999999.jpg','微信图片_20260924143000.jpg','1234567.jpg']
             .every(n => guessName(n) === '')`));
  check('正常的名字直接用（酒水.jpg → 酒水）', await ev(`guessName('酒水.jpg')`) === '酒水',
    await ev(`guessName('酒水.jpg')`));

  await setFiles('#newfile', [PHOTO]); await sleep(900);
  check('选完照片弹出起名输入框',
    await ev(`document.querySelector('#askname').classList.contains('on')`));
  check('表名按文件名预填', (await ev(`document.querySelector('#askinp').value`)) === 'list',
    await ev(`document.querySelector('#askinp').value`));

  await ev(`document.querySelector('#askinp').value = '测试饮料'`);
  await ev(`document.querySelector('#askok').click()`);
  const waitIdle2 = async () => {
    for (let i = 0; i < 120; i++){
      if (!(await ev(`document.querySelector('#busy').classList.contains('on')`))) return true;
      await sleep(400);
    }
    return false;
  };
  check('切完图进度遮罩自己收起', await waitIdle2());

  check('表数 +1', await mgrN() === 2, await mgrN());
  check('新表标了「照片加的」', await ev(`TBL.find(t=>t.name==='测试饮料').src`) === 'shot',
    await ev(`JSON.stringify(TBL.map(t=>t.name+':'+t.src))`));
  check('商品名是「表名 + 序号」',
    await ev(`TBL.find(t=>t.name==='测试饮料').items.every(x=>/^测试饮料 \\d+$/.test(x.n))`),
    await ev(`TBL.find(t=>t.name==='测试饮料').items.slice(0,3).map(x=>x.n).join(' / ')`));
  check('每格都编上了号（不会因为没名字被丢掉）',
    await ev(`TBL.find(t=>t.name==='测试饮料').items.length`) === 328,
    await ev(`TBL.find(t=>t.name==='测试饮料').items.length`));
  check('搜表名能搜到这张表', await ev(`search('测试饮料').length`) === 328,
    await ev(`search('测试饮料').length`));
  check('还没改名时管理页就标出进度', 
    /0 \/ \d+ 格有名字/.test(await ev(`document.querySelector('#mgrlist').textContent`)),
    await ev(`(document.querySelector('#mgrlist').textContent||'').match(/\\d+ \\/ \\d+ 格有名字/)`));
  await shot('16a-管理页-照片加的表.png');

  // 看图 → 改名（这是"照片加的表也能搜"的关键一步）
  await ev(`showViewer(IT.filter(x=>x.n==='测试饮料 1'), 0, '')`); await sleep(500);
  check('本机存的表：看图时有「改名」按钮',
    (await ev(`getComputedStyle(document.querySelector('#vrename')).display`)) !== 'none',
    await ev(`getComputedStyle(document.querySelector('#vrename')).display`));
  await ev(`document.querySelector('#vrename').click()`); await sleep(500);
  check('点「改名」弹出输入框',
    await ev(`document.querySelector('#askname').classList.contains('on')`));
  check('还是编号名时不预填（省得先删一遍）',
    (await ev(`document.querySelector('#askinp').value`)) === '',
    await ev(`document.querySelector('#askinp').value`));
  await ev(`document.querySelector('#askinp').value = '飞天茅台'`);
  await ev(`document.querySelector('#askok').click()`); await sleep(800);
  check('改完名立刻搜得到', await ev(`search('飞天茅台').length`) === 1,
    await ev(`search('飞天茅台').length`));
  check('改名写进了本机存档',
    await ev(`IMP.find(x=>x.id==='测试饮料').items.some(x=>x.n==='飞天茅台')`));
  check('查看器标题跟着变', await ev(`document.querySelector('#vttl').textContent`) === '飞天茅台',
    await ev(`document.querySelector('#vttl').textContent`));
  check('管理页进度跟着走（1 / N）',
    /1 \/ \d+ 格有名字/.test(await ev(`document.querySelector('#mgrlist').textContent`)),
    await ev(`(document.querySelector('#mgrlist').textContent||'').match(/\\d+ \\/ \\d+ 格有名字/)`));
  await shot('16b-看图-改名.png');
  await ev(`closeViewer()`); await sleep(300);

  // 内置示例表不给改（它是打包在 App 里的，改了没地方存）
  await ev(`showViewer(IT.filter(x=>x.t===TBL.findIndex(t=>t.src==='builtin')), 0, '')`);
  await sleep(400);
  check('内置示例表不显示「改名」按钮',
    (await ev(`getComputedStyle(document.querySelector('#vrename')).display`)) === 'none',
    await ev(`getComputedStyle(document.querySelector('#vrename')).display`));
  await ev(`closeViewer()`); await sleep(300);

  // 刷新：照片加的表和改过的名字都得在（存的是 IndexedDB）
  await cdp.send('Page.navigate', { url }); await sleep(1500);
  if (!(await waitReady())) throw new Error('刷新后页面没就绪');
  await sleep(700);
  check('刷新后：照片加的表还在', await ev(`TBL.some(t=>t.name==='测试饮料')`));
  check('刷新后：改的名字还在', await ev(`search('飞天茅台').length`) === 1,
    await ev(`search('飞天茅台').length`));
  check('刷新后：还是「照片加的」', await ev(`TBL.find(t=>t.name==='测试饮料').src`) === 'shot');

  // 重名要给一个不冲突的默认名 —— 宁可多一张，不可静默覆盖
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(400);
  check('重名时给一个不冲突的默认名，不静默覆盖原来那张',
    await ev(`[freeName('测试饮料'), freeName('香烟'), freeName('全新名字')].join('|')`)
      === '测试饮料 2|香烟 2|全新名字',
    await ev(`[freeName('测试饮料'), freeName('香烟'), freeName('全新名字')].join('|')`));

  await setFiles('#newfile', [PHOTO]); await sleep(900);
  check('弹框里预填的是文件名（list）',
    (await ev(`document.querySelector('#askinp').value`)) === 'list',
    await ev(`document.querySelector('#askinp').value`));
  await ev(`document.querySelector('#askcancel').click()`); await sleep(500);
  check('点「跳过这张」就真的不加', await mgrN() === 2, await mgrN());

  /* --- 本机没有"可借名字"的表时，提示必须把唯一的出路说出来 ----------------
     2026-09-25 店主加完一张 434 格的新表就来问「导入新表还是不能搜索」：
     他看到的提示末句只有"其余的：点开图 → 右上角「改名」"—— 对几百格的表
     等于没给办法（照做要按 400 多次），而且完全没提"发照片给助手"这条路。
     这里用**源码字符串**守（真要构造"本机一张能借的表都没有"，得把内置表也
     彻底删掉，后面所有测试会跟着红，不划算）。 */
  const addSrc = await ev(`doAddPhotos.toString()`);
  check('加完表提示：没有可借的表时，给出"发照片给助手做同名表包"（原地替换）',
    /发给助手/.test(addSrc) && /原地替换/.test(addSrc), 'doAddPhotos 源码里没写这条路');
  check('搜不到时同样说清"发照片给助手 / 原地替换"',
    /原地替换/.test(await ev(`renderResults.toString()`)), 'renderResults 源码里没写这条路');

  /* --- ★ 手打一个已经存在的表名：必须拦住，不许静默覆盖 --------------------
     表包 id 就是表名，所以同名 = `IMP[at] = nt` 会把原来那张**整个换掉**。
     默认名已经避开重名（上面那条断言），但店主可以手打 —— 代价是
     "一张有名字的表被编号版顶掉"，比多问一次严重得多。 */
  await setFiles('#newfile', [PHOTO]); await sleep(900);
  await ev(`document.querySelector('#askinp').value = '测试饮料'`);
  await ev(`document.querySelector('#askok').click()`); await sleep(700);
  check('起名撞上已有的表名：不切图，改成再问一次',
    (await ev(`document.querySelector('#askname').classList.contains('on')`)) &&
    (await ev(`document.querySelector('#askttl').textContent`)).indexOf('已经有') >= 0,
    await ev(`document.querySelector('#askttl').textContent`));
  check('重名时预填一个不冲突的名字', (await ev(`document.querySelector('#askinp').value`)) === '测试饮料 2',
    await ev(`document.querySelector('#askinp').value`));
  check('重名时也告诉他"想更新价格就去点换照片"',
    (await ev(`document.querySelector('#askbd').textContent`)).indexOf('换照片') >= 0);
  await ev(`document.querySelector('#askcancel').click()`); await sleep(700);
  check('重名后取消：表数不变', await mgrN() === 2, await mgrN());
  check('原来那张表没被顶掉（名字和改过的商品都还在）',
    await ev(`search('飞天茅台').length === 1 && TBL.find(t=>t.name==='测试饮料').src === 'shot'`));

  // 清理：本机存着的表是直接删，不占「已移除」名额
  await ev(`doDelete(TBL.find(t=>t.name==='测试饮料').key)`); await sleep(1000);
  check('删掉照片加的表后回到 1 张', await mgrN() === 1, await mgrN());
  check('本机表直接删，不占「已移除」', await hidN() === 0, await hidN());

  /* --- 搜索范围：表筛选不能悄悄把新表挡在外面 -----------------------------
     店主实报「导入新表后无法搜索」（2026-09-24）。根因不是数据，是**搜索范围**：
     搜索页顶部那排「表：」筛选是粘滞状态，点过某张表就一直在；后导入/新加的表
     落在范围外，搜它的商品永远 0 条 —— 而失败文案只说"没找到"，把店主引到完全
     错误的方向（他会以为表包坏了、或商品名没读对）。
     这里守四件事：
       ① 加表后自动把范围放回「全部」；
       ② 万一还是被挡住，必须把"只在某张表里搜"说出来，并给一键放开；
       ③ 筛选要跟着**表名**走，不能死盯下标（表增删时下标会整体前移）；
       ④ 照片加的表"格子还没起名"要和"真没这个商品"分开说。 */
  const cntTxt = () => ev(`document.querySelector('#cnt').textContent`);
  const resTxt = () => ev(`document.querySelector('#res').textContent`);
  const setQ = async v => {
    await ev(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(v)};q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(500);
  };
  const clickTChip = async name => {
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('#tfilter b')]
      .find(x=>x.textContent.indexOf(${JSON.stringify(name)})>=0); if(b){b.click();return true;} return false;})()`);
    await sleep(400); return ok;
  };

  check('（前置）此刻只剩内置 1 张表', await mgrN() === 1, await mgrN());

  // 导入两张，凑出"多表"局面（表一多，那排筛选 chip 才会出现）
  await setFiles('#impfile', [FIX('测试酒水.cigtable.json'), FIX('测试饮料.cigtable.json')]);
  await sleep(2200);
  check('一次导入两张后共 3 张表', await mgrN() === 3, await mgrN());
  check('导入后搜索范围自动是「全部」', await ev('curT') === -1, await ev('curT'));

  // 店主点了一下「测试酒水」那张表的筛选 chip（很自然的动作）
  await ev(`document.querySelector("[data-tab='p-search']").click()`); await sleep(400);
  check('点得到表筛选 chip', await clickTChip('测试酒水'));
  check('范围缩到「测试酒水」', await ev('curT') === 1, await ev('curT'));

  // 有结果时，范围必须写在明面上
  await setQ('飞天茅台');
  check('结果计数里写明"只在「测试酒水」里搜"',
    (await cntTxt()).indexOf('只在「测试酒水」里搜') >= 0, await cntTxt());

  // ★ 核心：搜别的表的商品 —— 不能只说"没找到"
  await setQ('可口可乐');
  check('被筛选挡住时，明说它不在当前这张表里',
    (await resTxt()).indexOf('不在「测试酒水」里') >= 0, await resTxt());
  check('并且给出一键放开的按钮', await ev(`!!document.querySelector('#res button[data-wide]')`));
  await shot('17a-搜索-被表筛选挡住.png');
  await ev(`document.querySelector('#res button[data-wide]').click()`); await sleep(600);
  check('点「在所有表里找」后范围放开', await ev('curT') === -1, await ev('curT'));
  check('放开后立刻搜到（结果区有卡片）',
    await ev(`document.querySelectorAll('#res .card').length`) >= 1,
    await ev(`document.querySelectorAll('#res .card').length`));

  // ★ 筛选按下标走会错位：把范围锁在最后一张表，再删掉它前面那张
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(400);
  await ev(`TBL.forEach((t,i)=>{ if(t.name==='测试饮料') curT=i; }); renderFilters();`);
  check('（准备）范围锁在最后一张「测试饮料」',
    await ev('TBL[curT].name') === '测试饮料', await ev('TBL[curT].name'));
  await ev(`doDelete(TBL.find(t=>t.name==='测试酒水').key)`); await sleep(1100);
  check('删掉靠前的表后，范围跟着表名走（没挪到别的表上）',
    await ev(`curT >= 0 ? TBL[curT].name : '(全部)'`) === '测试饮料',
    await ev(`curT >= 0 ? TBL[curT].name : '(全部)'`));
  await ev(`doDelete(TBL.find(t=>t.name==='测试饮料').key)`); await sleep(1100);
  check('把范围内那张表删了，范围回到「全部」', await ev('curT') === -1, await ev('curT'));

  // ★ 店主踩的那一步：范围锁着，然后导入一张新表
  await ev('curT = 0; renderFilters();'); await sleep(300);
  await setFiles('#impfile', [FIX('测试酒水.cigtable.json')]); await sleep(2000);
  check('导入新表后范围自动放开（不用店主自己去点「全部」）', await ev('curT') === -1, await ev('curT'));
  check('于是新表的商品立刻搜得到', await ev(`search('飞天茅台').length`) === 1,
    await ev(`search('飞天茅台').length`));

  /* --- 照片加的表：格子还没名字时，"搜不到"必须说清是没名字 --------------- */
  check('编号识别：表名 + 空格 + 数字', await ev(`numName({name:'酒水'},'酒水 12')`) === true);
  check('编号识别：光有表名不算', await ev(`numName({name:'酒水'},'酒水')`) === false);
  check('编号识别：真名不算', await ev(`numName({name:'酒水'},'飞天茅台')`) === false);
  check('编号识别：序号必须全是数字', await ev(`numName({name:'酒水'},'酒水 1b')`) === false);
  check('编号识别：表名里的正则元字符要转义', await ev(`numName({name:'A.B+C'},'A.B+C 7')`) === true);
  check('编号识别：没有表也要安全返回 false', await ev(`numName(null,'x')`) === false);

  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(400);
  await setFiles('#newfile', [PHOTO]); await sleep(1000);
  await ev(`document.querySelector('#askinp').value = '香香'`);
  await ev(`document.querySelector('#askok').click()`);
  for (let i = 0; i < 120; i++){ if (!(await ev(`document.querySelector('#busy').classList.contains('on')`))) break; await sleep(400); }
  await sleep(700);
  check('照片加的表进来后，格子全是编号', (await ev('numItems().length')) > 300, await ev('numItems().length'));
  check('numItems 只统计照片加的表（导入的表包不算）',
    await ev(`numItems().every(x => TBL[x.t].src === 'shot')`) === true);

  /* --- 「套用名字」：本机有版式一样的表，一下把三百多格名字全填上 ----------- */
  check('借名字要求列数一样（列数对不上就不给借）',
    await ev(`nameSrc({name:'x', nCol:99, nRow:3, items:[]})`) === null);
  check('管理页那张表下面出现「套用「香烟」的商品名」按钮',
    (await ev(`!!document.querySelector('#mgrlist button[data-inh]')`)) === true);
  check('按钮上写清了要套哪张表、几列',
    /套用「香烟」的商品名（8 列版式一样）/.test(await ev(`document.querySelector('#mgrlist').textContent`)),
    await ev(`(document.querySelector('#mgrlist').textContent||'').match(/套用「[^」]+」的商品名（\\d+ 列版式一样）/)`));
  // 截图要能看到那一行：把它滚到屏幕中间再拍
  await ev(`document.querySelector('#mgrlist button[data-inh]').scrollIntoView({block:'center'})`);
  await sleep(300);
  await shot('18a-管理页-可以套用名字.png');

  await ev(`document.querySelector("[data-tab='p-search']").click()`); await sleep(400);
  await setQ('牛栏山二锅头');
  check('搜不到时说明是"格子还没名字"，不是"没这个商品"',
    (await resTxt()).indexOf('还没名字') >= 0, await resTxt());
  check('并且点出是哪张表、还有多少格没名字',
    /「香香」里的商品还没名字（\d+ 格都是编号/.test(await resTxt()), await resTxt());
  await shot('17b-搜索-照片表还没起名.png');

  const numBefore = await ev('numItems().length');
  // ⚠️ 不能写成 await ev('doRename(...)')：doRename 是 async，内部 await 一个
  //    要用户点「确定」才 resolve 的弹框 —— CDP 的 awaitPromise 会一直等下去
  //    （60 秒超时、整个冒烟脚本死在这儿）。void 一下，让它跑起来就返回。
  await ev(`void doRename(IT.find(x=>x.n==='香香 2'))`); await sleep(600);
  await ev(`document.querySelector('#askinp').value = '牛栏山二锅头'`);
  await ev(`document.querySelector('#askok').click()`); await sleep(1000);
  check('改完名，"还没名字"的格子少一个', await ev('numItems().length') === numBefore - 1,
    await ev('numItems().length'));
  await setQ('牛栏山二锅头');
  check('改完名就搜得到了', await ev(`search('牛栏山二锅头').length`) === 1,
    await ev(`search('牛栏山二锅头').length`));
  check('搜到了就不再显示"还没名字"的提示', (await resTxt()).indexOf('还没名字') < 0, await resTxt());

  /* --- 搜不到时直接给「套用名字」的按钮（店主的原话就是这么搜不到） ---------
     先把内置的「香烟」彻底删掉，复现店主的真实处境：他删掉了示例表，
     自己拍了一张同样的表（香香），于是搜「中华」搜不到 —— 但名字还在页面里能借。 */
  await ev(`REMOVED.add('x:香烟'); saveRemoved(); rebuild(); applyAll();`); await sleep(500);
  check('内置「香烟」彻底删掉后，列表里看不到它',
    await ev(`TBL.some(t => t.name === '香烟')`) === false);
  await setQ('中华');
  check('有版式一样的表时，搜不到会直接给「套用名字」按钮',
    (await ev(`!!document.querySelector('#res button[data-inh]')`)) === true,
    await resTxt());
  check('按钮指出的来源是那张"已经彻底删掉、但名字还在"的示例表',
    /套用「香烟」的商品名/.test(await resTxt()), await resTxt());
  await shot('18b-搜索-给了套用名字的按钮.png');
  await ev(`document.querySelector('#res button[data-inh]').click()`); await sleep(600);
  check('点它先弹确认框，把来源表 / 行列数都摆出来',
    (await ev(`document.querySelector('#askname').classList.contains('on')`)) === true &&
    /把「香烟」的商品名套到「香香」上/.test(await ev(`document.querySelector('#askttl').textContent`)),
    await ev(`document.querySelector('#askttl').textContent`));
  check('确认框里注明来源是"已彻底删掉的示例表"',
    /已彻底删掉/.test(await ev(`document.querySelector('#askbd').textContent`)),
    await ev(`document.querySelector('#askbd').textContent`));
  check('确认框里不显示输入框（它只做确认，不是输入）',
    (await ev(`document.querySelector('#askinp').style.display`)) === 'none');
  await shot('18c-套用名字-确认框.png');
  await ev(`document.querySelector('#askok').click()`); await sleep(1500);
  // 只能断言"剩下的编号格必定是 (1,1) 那个日期格"：源表里唯一没名字的就是它。
  // 这里剩 1 格（改的是「香香 2」＝第 2 格）；设备那边改的是第 1 格，所以剩 0 格 —— 都对。
  check('套完只剩"源表里本来就没名字"的那格（(1,1) 日期格）',
    await ev(`numItems().every(x => +x.c === 1 && +x.r === 1)`), '剩 ' + await ev('numItems().length') + ' 格');
  check('店主自己改过的名字没被覆盖', await ev(`IT.some(x => x.n === '牛栏山二锅头')`) === true);
  await setQ('中华');
  check('套完名字，搜「中华」立刻有结果', await ev(`search('中华').length`) > 0, await ev(`search('中华').length`));
  check('内置表的商品名没被动过', await ev(`RAW.tables.find(t=>t.name==='香烟').items.length`) === 327);
  await shot('18d-搜索-套用名字后能搜了.png');

  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(400);
  check('套完给「撤销」，能退回编号版',
    await ev(`document.querySelectorAll("#mgrlist button[data-undo]").length`) === 1);
  check('管理页不再显示「套用名字」（已经套过了）',
    (await ev(`!!document.querySelector('#mgrlist button[data-inh]')`)) === false);
  await ev(`document.querySelector('#mgrlist button[data-undo]').click()`); await sleep(1500);
  check('撤销后退回编号版', (await ev('numItems().length')) > 300, await ev('numItems().length'));
  // 把内置表恢复回来（这个状态后面的断言还要用）
  await ev(`REMOVED.delete('x:香烟'); saveRemoved(); rebuild(); applyAll();`); await sleep(400);
  check('内置「香烟」恢复可见', await ev(`TBL.some(t => t.name === '香烟')`) === true);

  // 清理
  await ev(`doDelete(TBL.find(t=>t.name==='香香').key)`); await sleep(1100);
  await ev(`doDelete(TBL.find(t=>t.name==='测试酒水').key)`); await sleep(1100);
  check('清理后回到只有内置表', await mgrN() === 1, await mgrN());

  /* ---- 认字（内嵌的联网页）：不联网，只验「iframe 起得来 + 表包能送回来入库」 ---- */
  await ev(`document.querySelector("[data-tab='p-ocr']").click()`);
  const frReady = () => ev(`(()=>{try{
    return !!document.getElementById('ocrframe').contentWindow.__recog;
  }catch(e){return 'ERR:'+e.message}})()`);
  for (let i = 0; i < 40 && (await frReady()) !== true; i++) await sleep(300);
  check('点「认字」后内嵌页加载起来了', await frReady() === true, await frReady());

  const ifTxt = (id) => ev(`(()=>{try{
    return document.getElementById('ocrframe').contentWindow.document.getElementById(${JSON.stringify(id)}).textContent;
  }catch(e){return 'ERR'}})()`);
  check('认字页知道自己在 App 里（按钮变成「写进 App」）', /写进/.test(await ifTxt('bexport')), await ifTxt('bexport'));
  const noBuiltin = () => ev(`(()=>{try{
    const d = document.getElementById('ocrframe').contentWindow.document;
    return !d.querySelector('input[name=eng][value=builtin]');
  }catch(e){return 'ERR:'+e.message}})()`);
  check('认字页已彻底没有「内置」引擎选项', await noBuiltin() === true, await noBuiltin());
  const hasCustomForm = () => ev(`(()=>{try{
    const d = document.getElementById('ocrframe').contentWindow.document;
    return !!d.getElementById('abase');
  }catch(e){return 'ERR:'+e.message}})()`);
  check('认字页保留「我自己的 API」配置表单', await hasCustomForm() === true, await hasCustomForm());

  /* 厂商预设下拉：确认 DeepSeek 已加进来（2026-09-25 应要求加入） */
  const ifRun = (arrow) => ev(`(()=>{try{
    const d = document.getElementById('ocrframe').contentWindow.document; return (${arrow})(d);
  }catch(e){return 'ERR:'+e.message}})()`);
  const deepN = await ifRun(`(d)=>Array.from(d.querySelectorAll('#epreset option')).filter(o=>/deepseek/i.test(o.textContent)).length`);
  check('认字页厂商下拉里有 DeepSeek', deepN >= 1, deepN);

  // 手造一个极小的表包，走 postMessage → doImport 这条真链路（跟「导入表包」同一条）
  const pack = JSON.stringify({
    fmt: 'cigpricer.table', v: 1,
    table: {
      id: '认字测试', name: '认字测试', date: '', note: '', colLabels: [],
      nCol: 1, nRow: 1, rot: 0, sheetImg: 'data:image/png;base64,iVBORw0KGgo=',
      items: [{ n: '认字送来的商品', c: 1, r: 1, w: 10, h: 10, img: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' }]
    }
  });
  await ev(`window.postMessage({cigpack:${JSON.stringify(pack)},name:'认字测试'},'*')`);
  await sleep(1500);
  check('认字页送回来的表包直接进了 App', await ev(`TBL.some(t=>t.name==='认字测试')`) === true);
  await ev(`document.querySelector("[data-tab='p-search']").click()`);
  await setQ('认字送来');
  check('送进来的表能立刻搜到', (await ev(`search('认字送来').length`)) > 0, await ev(`search('认字送来').length`));
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(400);
  await ev(`doDelete(TBL.find(t=>t.name==='认字测试').key)`); await sleep(1200);
  check('收尾：测试表删干净', await mgrN() === 1, await mgrN());

  /* 数据同步卡片（2026-09-25 加）：管理页有开关 + 按钮，doSync 在禁用时优雅返回 */
  await ev(`document.querySelector("[data-tab='p-mgr']").click()`); await sleep(300);
  check('管理页有「数据同步」卡片', await ev(`!!document.getElementById('synccard')`) === true);
  check('同步卡片有「启用同步」开关和「立即同步」按钮',
    await ev(`!!document.getElementById('syncOn') && !!document.getElementById('syncNow')`) === true);
  check('doSync 是可调用的函数', await ev(`typeof doSync === 'function'`) === true);
  check('未启用同步时 doSync 直接返回（不联网）',
    await ev(`doSync().then(r=>r.ok===false && r.msg==='未启用同步')`) === true);

  /* 单列 / 双列切换（2026-09-26 加）
     守三件事：① 默认必须是单列（店主看惯的那版，不能让老用户一进来就变样）；
               ② 切双列真的并排（左边不同、顶边对齐、卡片变窄），图还不能被拉变形；
               ③ 这是店主的习惯，刷新后得记住。 */
  await ev(`document.querySelector("[data-tab='p-search']").click()`); await sleep(300);
  await setQ('中华');
  check('计数行里有单列/双列切换',
    await ev(`!!document.querySelector('#cnt .segsm button[data-g="1"]') && !!document.querySelector('#cnt .segsm button[data-g="2"]')`));
  check('默认单列（结果区不带 g2）', await ev(`!document.querySelector('#res').classList.contains('g2')`));
  check('默认高亮在「单列」上', await ev(`document.querySelector('#cnt .segsm button.on').dataset.g`) === '1');

  const colGeo = async () => JSON.parse(await ev(`JSON.stringify((()=>{
    const cs = [...document.querySelectorAll('#res .card')].slice(0,2);
    const im = cs[0].querySelector('.shot img'), r = im.getBoundingClientRect();
    const a = cs[0].getBoundingClientRect(), b = cs[1] ? cs[1].getBoundingClientRect() : null;
    return {n:cs.length, l0:Math.round(a.left), l1:b?Math.round(b.left):null,
            t0:Math.round(a.top), t1:b?Math.round(b.top):null, w0:Math.round(a.width),
            ratio:+(r.width/r.height).toFixed(3), nat:+(im.naturalWidth/im.naturalHeight).toFixed(3)};
  })())`));
  const g1 = await colGeo();
  check('单列：两张卡竖直排（左边相同）', g1.n >= 2 && g1.l0 === g1.l1, JSON.stringify(g1));

  await ev(`document.querySelector('#cnt .segsm button[data-g="2"]').click()`); await sleep(400);
  check('点「双列」后结果区带上 g2', await ev(`document.querySelector('#res').classList.contains('g2')`));
  check('高亮跟着挪到「双列」', await ev(`document.querySelector('#cnt .segsm button.on').dataset.g`) === '2');
  const g2 = await colGeo();
  check('双列：前两张卡并排（左边不同、顶边对齐）',
    g2.n >= 2 && g2.l0 !== g2.l1 && Math.abs(g2.t0 - g2.t1) < 2, JSON.stringify(g2));
  check('双列：卡片确实变窄了（不到单列的 60%）', g2.w0 < g1.w0 * 0.6, g1.w0 + ' → ' + g2.w0);
  check('双列：卡片图仍等比（没被拉变形）', Math.abs(g2.ratio - g2.nat) < 0.02, JSON.stringify(g2));
  await shot('18-搜索-双列.png');

  // 偏好要存住：刷新后还得是双列
  await cdp.send('Page.navigate', { url }); await sleep(1600);
  if (!(await waitReady())) throw new Error('刷新后页面没就绪');
  await sleep(600);
  await setQ('中华');
  check('刷新后仍是双列（偏好存住了）', await ev(`document.querySelector('#res').classList.contains('g2')`));

  // 切回单列收尾：后面/上面的量尺寸断言都按单列写的
  await ev(`document.querySelector('#cnt .segsm button[data-g="1"]').click()`); await sleep(300);
  check('切回单列：g2 摘掉、高亮回到「单列」',
    await ev(`!document.querySelector('#res').classList.contains('g2')`) &&
    (await ev(`document.querySelector('#cnt .segsm button.on').dataset.g`)) === '1');

  check('无 JS 异常 / console.error', errors.length === 0, errors.slice(0, 5).join(' | '));

  // 报告
  const okN = results.filter(r => r.ok).length;
  console.log('\n===== 冒烟测试报告 =====');
  results.forEach(r => console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.label + (r.extra ? '   [' + r.extra + ']' : '')));
  console.log('\n通过 %d / %d', okN, results.length);
  console.log('截图目录: ' + SHOTS);

  ws.close(); child.kill();
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  process.exit(okN === results.length ? 0 : 1);
})().catch(e => { console.error('运行失败:', e); process.exit(2); });
