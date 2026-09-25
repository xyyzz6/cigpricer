/* ============================================================================
 * cigpricer —— 「照片 → 逐格小图」的浏览器版实现
 *
 * ★ 这份文件是唯一源码，两边都从它来，不要各改一份：
 *     tools/proto_crop.js      离线验证（Edge headless 里跑，跟 Python 的 grid.json 对坐标）
 *     tools/app_template.html  构建时通过 __CROPJS__ 占位符整段注入进 App
 *   build_app.py 负责读这个文件；改完这里，重新构建 App 即可。
 *
 * 算法与 tools/plib.py 逐行对齐（阈值、round、外扩像素都一样），
 * 目的是让"App 里换照片"切出来的格子和"电脑上重做一版"切出来的一样。
 *
 * 为什么不用 canvas.toDataURL('image/png')：
 *   浏览器只会输出**真彩色** PNG —— 536×80 的一格要 68 KB，328 格 = 21.8 MB，
 *   存进 IndexedDB 会让 App 每次启动都要多解几 MB 的 base64。
 *   Python 那边用 16 色调色板只要 9 KB。所以这里自己编码 indexed PNG
 *   （调色板 + zlib via CompressionStream），把体积拉回同一量级。
 * ==========================================================================*/
window.CIGCROP = (function () {
  'use strict';

  /* 与 plib.py 顶部常量一一对应 */
  const DARK = 160;        // 灰度低于它算"黑"
  const LINE_THR = 0.55;   // 一列/一行里 55% 是黑的才认作表格线
  const MIN_GAP = 8;       // 两条线离得比这近就并成一条（防双线）
  const PAD = 1;           // 四边外扩：网格线 1~2px 宽，取中心线会切掉一半
  const TARGET_W = 720;    // 输出目标宽度（手机上 ≈1:1：366 css × dpr 2）
  const UP_MAX = 4;        // 放大上限（跟 plib.UPSCALE 同值）

  /* ------------------------------------------------------------------ 画布 */

  function canvasOf(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /**
   * 把 File/Blob 变成能画到 canvas 上的东西（ImageBitmap 或 <img>）。
   *
   * ⚠️ **不要**写 `createImageBitmap(file, {imageOrientation:'from-image'})`：
   *   桌面 Chrome / Edge 认这个值，但有些 Android WebView 的 ImageOrientation
   *   枚举里没有它，会直接抛
   *     "The provided value 'from-image' is not a valid enum value of type ImageOrientation"
   *   —— 「换照片」在手机上第一步就挂，而且**桌面测试全绿**，极难发现。
   *   不传 options 时 Chromium 自己就按 EXIF 方向摆正（M81 起是默认行为），
   *   正是我们要的。
   */
  async function toDrawable(file) {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      // 兜底：<img> + canvas。老 WebView 上 createImageBitmap 可能压根不存在。
      const url = URL.createObjectURL(file);
      try {
        return await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error('这张图片解不开（格式不支持？）'));
          im.src = url;
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    }
  }

  /**
   * 逆时针转 ang 度（0/90/180/270），跟 PIL 的 im.rotate(ang, expand=True) 对齐。
   * canvas 的 rotate 正角度是顺时针，所以这里用负角。
   */
  function rotCanvas(src, ang) {
    const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
    if (!ang) {
      const cv = canvasOf(W, H);
      cv.getContext('2d').drawImage(src, 0, 0);
      return { cv, W, H };
    }
    const swap = ang === 90 || ang === 270;
    const cw = swap ? H : W, ch = swap ? W : H;
    const cv = canvasOf(cw, ch);
    const ctx = cv.getContext('2d');
    ctx.save();
    if (ang === 90) { ctx.translate(0, W); ctx.rotate(-Math.PI / 2); }
    else if (ang === 270) { ctx.translate(H, 0); ctx.rotate(Math.PI / 2); }
    else { ctx.translate(W, H); ctx.rotate(Math.PI); }
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    return { cv, W: cw, H: ch };
  }

  /** 灰度 + 暗像素掩码（1 = 黑） */
  function darkMask(cv, W, H) {
    const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
    const m = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < m.length; i++, p += 4) {
      m[i] = ((d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000) < DARK ? 1 : 0;
    }
    return m;
  }

  function colRatio(m, W, H) {
    const r = new Float32Array(W);
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) r[x] += m[o + x];
    }
    for (let x = 0; x < W; x++) r[x] /= H;
    return r;
  }

  function rowRatio(m, W, H) {
    const r = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let s = 0; const o = y * W;
      for (let x = 0; x < W; x++) s += m[o + x];
      r[y] = s / W;
    }
    return r;
  }

  /** 从"暗像素占比"里找表格线中心坐标（= plib.find_lines） */
  function findLines(ratio, thr, minGap) {
    const idx = [];
    for (let i = 0; i < ratio.length; i++) if (ratio[i] > thr) idx.push(i);
    const grp = [];
    if (idx.length) {
      let s = idx[0], p = idx[0];
      for (let k = 1; k < idx.length; k++) {
        const i = idx[k];
        if (i <= p + 2) p = i;
        else { grp.push([s, p]); s = p = i; }
      }
      grp.push([s, p]);
    }
    const out = [];
    for (const [a, b] of grp) {
      const c = (a + b) / 2;
      if (out.length && c - out[out.length - 1] < minGap) out[out.length - 1] = (out[out.length - 1] + c) / 2;
      else out.push(c);
    }
    return out.map(v => Math.round(v));
  }

  /** 宽列（商品名）+ 紧跟的窄列（价格）合成一个商品格（= plib.group_columns） */
  function groupColumns(xs) {
    const out = [];
    let i = 0;
    while (i + 1 < xs.length) {
      const a = xs[i], b = xs[i + 1];
      if (i + 2 < xs.length && (xs[i + 2] - b) < (b - a) * 0.7) { out.push([a, xs[i + 2]]); i += 2; }
      else { out.push([a, b]); i += 1; }
    }
    return out;
  }

  /** 单元格扁长比：明显 >1 才是"正看"（= plib.orient_score） */
  function orientScore(cols, ys) {
    if (cols.length < 2 || ys.length < 3) return 0;
    const cw = cols.map(p => p[1] - p[0]).sort((a, b) => a - b);
    const rh = [];
    for (let i = 0; i + 1 < ys.length; i++) rh.push(ys[i + 1] - ys[i]);
    rh.sort((a, b) => a - b);
    return cw[Math.floor(cw.length / 2)] / Math.max(rh[Math.floor(rh.length / 2)], 1);
  }

  const MIN_SCORE = 1.2;   // 跟 plib.analyze 里那条门槛一致

  /** 分析某一个朝向 */
  function analyzeOne(src, ang) {
    const { cv, W, H } = rotCanvas(src, ang);
    const m = darkMask(cv, W, H);
    const xs = findLines(colRatio(m, W, H), LINE_THR, MIN_GAP);
    const ys = findLines(rowRatio(m, W, H), LINE_THR, MIN_GAP);
    const cols = groupColumns(xs);
    const rows = [];
    for (let i = 0; i + 1 < ys.length; i++) rows.push([ys[i], ys[i + 1]]);
    return { ang, W, H, cols, rows, score: orientScore(cols, ys) };
  }

  /**
   * 定方向。
   * 优先沿用 hint（上一版表的旋转角）—— 同一个人拍同一张纸，方向基本不会变，
   * 而且这样能确定"正看还是倒看"（纯几何分不出 90° 和 270°，两者得分完全相同）。
   * hint 不可用时才在 0/90 里挑扁长比大的那个。
   */
  function analyze(src, hint) {
    const tried = [];
    if (hint != null) {
      const r = analyzeOne(src, hint);
      tried.push({ ang: hint, score: r.score });
      if (r.score >= MIN_SCORE) return { plan: r, how: 'hint', tried };
    }
    let best = null;
    for (const ang of [0, 90]) {
      const r = analyzeOne(src, ang);
      tried.push({ ang, score: r.score });
      if (r.score > 0 && (!best || r.score > best.score)) best = r;
    }
    if (!best || best.score < MIN_SCORE) {
      const e = new Error('NOGRID');
      e.code = 'NOGRID';
      e.tried = tried;
      e.best = best ? best.score : 0;
      throw e;
    }
    return { plan: best, how: hint != null ? 'auto-fallback' : 'auto', tried };
  }

  /* --------------------------------------------------- indexed PNG 编码器 */

  let CRC_T = null;
  function crc32(buf) {
    if (!CRC_T) {
      CRC_T = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_T[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function be32(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }

  /**
   * 一个 PNG chunk：长度 + 类型 + 数据 + CRC。
   * ⚠️ CRC 只覆盖「类型 + 数据」，**不含前面那 4 字节长度**。
   * 把长度也算进去的话 CRC 全错 —— 文件头看起来完全正常、zlib 也能解开，
   * 但 PIL 会直接拒绝（UnidentifiedImageError），极难一眼看出。
   */
  function chunk(type, data) {
    const td = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i);
    td.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    out.set(new Uint8Array(be32(data.length)), 0);
    out.set(td, 4);
    out.set(new Uint8Array(be32(crc32(td))), 8 + data.length);
    return out;
  }

  /**
   * zlib 流（PNG 的 IDAT 要的就是带 zlib 头的 deflate）。
   * ⚠️ 不能写成 getWriter() → await write() → close()：readable 那头没人消费时，
   * write 的 promise 会因为背压永远不 resolve，直接死锁（踩过，整个进程卡住不返回）。
   * 用 pipeThrough 让 readable 立刻被 Response 消费掉才是对的。
   */
  async function zlibDeflate(bytes) {
    const st = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(st).arrayBuffer());
  }

  const HAS_DEFLATE = typeof CompressionStream === 'function';

  /**
   * 兜底：不压缩的 zlib 流（stored 块）。
   * 老 WebView 没有 CompressionStream 时用 —— 体积大约是压缩后的 4 倍，
   * 但仍是 canvas 真彩 PNG 的三分之一，比"直接不能用"强。
   */
  function adler32(bytes) {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  }

  function storedZlib(bytes) {
    const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
    const out = new Uint8Array(2 + blocks * 5 + bytes.length + 4);
    let at = 0;
    out[at++] = 0x78; out[at++] = 0x01;
    let off = 0;
    while (off < bytes.length || off === 0) {
      const n = Math.min(65535, bytes.length - off);
      const last = (off + n >= bytes.length) ? 1 : 0;
      out[at++] = last;
      out[at++] = n & 255; out[at++] = (n >> 8) & 255;
      out[at++] = (~n) & 255; out[at++] = ((~n) >> 8) & 255;
      out.set(bytes.subarray(off, off + n), at);
      at += n;
      off += n;
      if (off >= bytes.length) break;
    }
    const a = adler32(bytes);
    out[at++] = (a >>> 24) & 255; out[at++] = (a >>> 16) & 255;
    out[at++] = (a >>> 8) & 255; out[at++] = a & 255;
    return out.subarray(0, at);
  }

  function rowCost(b) {
    let s = 0;
    for (let i = 0; i < b.length; i++) { const v = b[i]; s += v < 128 ? v : 256 - v; }
    return s;
  }

  /**
   * 把 ImageData 编码成 indexed PNG。
   *   近似灰度 → 16 级灰 + bitDepth 4（每像素半字节，线稿的压缩比最优）
   *   有颜色    → 216 色 web-safe + bitDepth 8
   * 每行在 None / Sub / Up 三种 filter 里挑绝对值和最小的那个。
   */
  async function encodePNG(data, W, H) {
    // 防御：这里要的是 RGBA 的字节数组（ImageData.data），不是 ImageData 本身。
    // 传错的话每个像素都是 undefined，量化后全变 0 —— PNG 照样能生成、能打开，
    // 只是整张图是纯色，体积小到离谱（第一版就是这么静默出错的）。
    if (!data || data.length !== W * H * 4) {
      throw new Error('encodePNG: 像素数据长度 ' + (data && data.length) + '，应为 ' + (W * H * 4));
    }
    const total = W * H;
    // 这本质上是不是一张灰阶图？
    // ⚠️ 不能只看"有多少像素带颜色" —— 手机拍的纸基本都整体偏色（这张 list.jpg
    // 整张偏黄，几乎 100% 的像素都有色差），那样会被判成彩色图，黑字全被映射到
    // web-safe 的 (51,51,51)，整张图发灰。
    // 正确的判据是**色差的分布**：整体偏色的照片，色差集中在低位（同一种偏色），
    // 取中位数就能把它认出来；真有红笔标注时中位数会被拉高。
    const chist = new Uint32Array(256);
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      chist[Math.max(r, g, b) - Math.min(r, g, b)]++;
    }
    let acc = 0, medColor = 255;
    for (let v = 0; v < 256; v++) { acc += chist[v]; if (acc * 2 >= total) { medColor = v; break; } }
    const gray = medColor <= 40;

    const idx = new Uint8Array(total);
    encodePNG.last = { gray, medColor, bitDepth: gray ? 4 : 8 };
    let pal;
    if (gray) {
      // 近乎纯灰：16 级灰 + 每像素半字节，体积最小
      pal = [];
      for (let i = 0; i < 16; i++) { const v = Math.round(i * 255 / 15); pal.push(v, v, v); }
      for (let i = 0, p = 0; i < total; i++, p += 4) {
        const g = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
        idx[i] = Math.max(0, Math.min(15, Math.round(g * 15 / 255)));
      }
    } else {
      // 有颜色（纸张偏色、红笔标注、照片噪点…）：
      // 调色板前 16 项仍是精细灰阶，后面 216 项是 web-safe 彩色。
      // 关键是**按像素**分派 —— 黑字走灰阶档（黑得下去、边缘干净），
      // 只有真带色的像素才吃 web-safe 那粗步长。全走 web-safe 的话
      // 黑线会被映射成 (51,51,51)，整张图发灰（第一版就是这个问题）。
      pal = [];
      for (let i = 0; i < 16; i++) { const v = Math.round(i * 255 / 15); pal.push(v, v, v); }
      for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) pal.push(r * 51, g * 51, b * 51);
      const q = v => v < 26 ? 0 : v < 77 ? 1 : v < 128 ? 2 : v < 179 ? 3 : v < 230 ? 4 : 5;
      for (let i = 0, p = 0; i < total; i++, p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx - mn <= 16) idx[i] = Math.round((r + g + b) / 3 * 15 / 255);
        else idx[i] = 16 + (q(r) * 6 + q(g)) * 6 + q(b);
      }
    }
    const bitDepth = gray ? 4 : 8;

    // 每行打包成字节（4bit 时高半字节是左边的像素）
    const rowBytes = bitDepth === 4 ? ((W + 1) >> 1) : W;
    const rows = [];
    for (let y = 0; y < H; y++) {
      const o = y * W;
      let cur;
      if (bitDepth === 8) cur = idx.subarray(o, o + W);
      else {
        cur = new Uint8Array(rowBytes);
        for (let x = 0; x < W; x += 2) {
          cur[x >> 1] = (idx[o + x] << 4) | (x + 1 < W ? idx[o + x + 1] : 0);
        }
      }
      rows.push(cur);
    }

    const raw = new Uint8Array(H * (rowBytes + 1));
    let prev = null;
    for (let y = 0; y < H; y++) {
      const cur = rows[y];
      let bestType = 0, bestBuf = cur, bestCost = -1;
      for (const t of [0, 1, 2]) {
        const buf = new Uint8Array(cur.length);
        for (let i = 0; i < cur.length; i++) {
          if (t === 0) buf[i] = cur[i];
          else if (t === 1) buf[i] = (cur[i] - (i > 0 ? cur[i - 1] : 0)) & 255;
          else buf[i] = (cur[i] - (prev ? prev[i] : 0)) & 255;
        }
        const c = rowCost(buf);
        if (bestCost < 0 || c < bestCost) { bestCost = c; bestType = t; bestBuf = buf; }
      }
      raw[y * (rowBytes + 1)] = bestType;
      raw.set(bestBuf, y * (rowBytes + 1) + 1);
      prev = cur;
    }

    const ihdr = new Uint8Array(be32(W).concat(be32(H), [bitDepth, 3, 0, 0, 0]));
    const idat = HAS_DEFLATE ? await zlibDeflate(raw) : storedZlib(raw);
    const parts = [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('PLTE', new Uint8Array(pal)),
      chunk('IDAT', idat),
      chunk('IEND', new Uint8Array(0)),
    ];
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  function toB64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  /** ImageData → data URI（注意取 .data，不是 ImageData 本身） */
  async function pngDataUrl(im, W, H) {
    return 'data:image/png;base64,' + toB64(await encodePNG(im.data, W, H));
  }

  /* ---------------------------------------------------------------- 主流程 */

  /** 输出宽度 → 放大倍率（源已经够大就不放大，别徒增体积） */
  function scaleFor(srcW) {
    return Math.max(1, Math.min(UP_MAX, Math.round(TARGET_W / Math.max(srcW, 1)) || 1));
  }

  /**
   * 把整表按网格切成 items。
   *
   * 名字有两个来源，按优先级：
   *   ① oldTable 里 (列,行) 位置上那个商品名 —— 「换照片」走这条，名字沿用上一版；
   *   ② nameFor(ci, ri) 现取一个名字 —— 「用照片加表」走这条（没有旧表可继承）。
   *      两个都没有就把这格丢掉（unnamed++）。
   *
   * ⚠️ nameFor 是按 **ci 外层、ri 内层** 的顺序调用的，正好就是"阅读顺序"
   *    （第 1 列从上到下、再第 2 列…）。所以外部可以用一个自增计数器当序号，
   *    不必自己算 (ci-1)*nRow+ri。
   */
  async function cutAll(bitmap, plan, oldTable, onProgress, nameFor) {
    const { cv, W, H } = rotCanvas(bitmap, plan.ang);
    const up = scaleFor(Math.max(1, plan.cols[0][1] - plan.cols[0][0]));
    const work = canvasOf(1, 1);
    const ctx = work.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 旧表：名字按 (列,行) 建索引
    const old = new Map();
    if (oldTable && oldTable.items) {
      for (const it of oldTable.items) old.set((+it.c) + ',' + (+it.r), it.n);
    }

    const items = [];
    let unnamed = 0, done = 0, bytes = 0;
    const totalCells = plan.cols.length * plan.rows.length;

    for (let ci = 0; ci < plan.cols.length; ci++) {
      const x0 = plan.cols[ci][0], x1 = plan.cols[ci][1];
      for (let ri = 0; ri < plan.rows.length; ri++) {
        const y0 = plan.rows[ri][0], y1 = plan.rows[ri][1];
        const bx = Math.max(0, x0 - PAD), by = Math.max(0, y0 - PAD);
        const ex = Math.min(W, x1 + PAD), ey = Math.min(H, y1 + PAD);
        const sw = ex - bx, sh = ey - by;
        const ow = Math.max(1, Math.round(sw * up)), oh = Math.max(1, Math.round(sh * up));
        if (work.width !== ow || work.height !== oh) { work.width = ow; work.height = oh; }
        // 先铺白：源图若有透明区，不铺的话 PNG 里会变黑
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, ow, oh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(cv, bx, by, sw, sh, 0, 0, ow, oh);

        let nm = old.get((ci + 1) + ',' + (ri + 1)) || '';
        if (!nm && nameFor) nm = nameFor(ci + 1, ri + 1);
        if (nm) {
          const url = await pngDataUrl(ctx.getImageData(0, 0, ow, oh), ow, oh);
          bytes += url.length;
          items.push({ n: nm, c: ci + 1, r: ri + 1, w: ow, h: oh, img: url });
        } else {
          unnamed++;
        }
        done++;
        if (onProgress && (done % 8 === 0 || done === totalCells)) onProgress(done, totalCells);
      }
    }

    // 整表图（「原表」页兜底用）
    const sheetCanvas = canvasOf(W, H);
    const sc = sheetCanvas.getContext('2d');
    sc.fillStyle = '#fff'; sc.fillRect(0, 0, W, H);
    sc.drawImage(cv, 0, 0);
    const sheetImg = await pngDataUrl(sc.getImageData(0, 0, W, H), W, H);

    return {
      items, sheetImg, unnamed, up, W, H,
      nCol: plan.cols.length, nRow: plan.rows.length,
      bytes: bytes + sheetImg.length,
    };
  }

  /**
   * 一张照片 → 一张表。
   *
   * 两种用法：
   *   A. 「换照片」  processPhoto(file, oldTable)   —— 名字沿用 oldTable，
   *      并且**卡版式**（列数必须相等、行数差 ≤4），对不上就拒。
   *   B. 「用照片加表」processPhoto(file, null, cb, {nameFor})
   *      —— 全新的一张表，没有旧表可继承，也不该卡版式（什么列数都收），
   *      名字由 nameFor 现场给（通常是「表名 + 序号」）。
   *      ★ 这条路上"商品名"不是真名字，只是编号：App 不认字，读不出"茅台"。
   *        所以它建出来的表**搜不到具体商品**，只能按表名搜 / 翻网格。
   *        店主想要真名字，把照片发给助手重做一版同名的表包导进来即可 ——
   *        表包 id 就是表名，导入时会原地替换（见 app_template.html 的 doImport）。
   *
   * 失败时抛的 Error 带 code：
   *   NOGRID   照片里找不到表格线（拍歪/没拍全/太糊）
   *   LAYOUT   切出来的列组数跟原来对不上（不是同一张表，或者重新排版了）—— 只有用法 A
   *   ROWS     行数差太多（超过 4 行），多半换了纸或者选错了照片 —— 只有用法 A
   *   EMPTY    一个格子都没切出来
   */
  async function processPhoto(file, oldTable, onProgress, opts) {
    if (onProgress) onProgress(0, 0, 'read');
    const bmp = await toDrawable(file);
    const hint = oldTable && oldTable.rot != null ? +oldTable.rot : null;
    const { plan, how, tried } = analyze(bmp, hint);
    if (oldTable && oldTable.nCol && plan.cols.length !== +oldTable.nCol) {
      const e = new Error('LAYOUT');
      e.code = 'LAYOUT';
      e.got = plan.cols.length;
      e.want = +oldTable.nCol;
      e.rows = plan.rows.length;
      throw e;
    }
    // 列数一样但行数差太多，说明不是"同一张表重拍" —— 这种要拦住，
    // 否则逐行对位会整体错位，搜出来的价格张冠李戴。
    if (oldTable && oldTable.nRow && Math.abs(plan.rows.length - (+oldTable.nRow)) > 4) {
      const e = new Error('ROWS');
      e.code = 'ROWS';
      e.got = plan.rows.length;
      e.want = +oldTable.nRow;
      throw e;
    }
    const built = await cutAll(bmp, plan, oldTable, (d, t) => {
      if (onProgress) onProgress(d, t, 'cut');
    }, opts && opts.nameFor);
    if (!built.items.length) {
      const e = new Error('EMPTY');
      e.code = 'EMPTY';
      throw e;
    }
    return Object.assign({ ang: plan.ang, how, tried, score: +plan.score.toFixed(2) }, built);
  }

  /* 给外部做尺寸/方向自测用 */
  return {
    analyze, analyzeOne, cutAll, processPhoto, encodePNG, scaleFor, rotCanvas, toDrawable,
    hasDeflate: () => HAS_DEFLATE,
    consts: { DARK, LINE_THR, MIN_GAP, PAD, TARGET_W, UP_MAX, MIN_SCORE },
  };
})();
