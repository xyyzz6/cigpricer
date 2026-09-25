'use strict';
/**
 * 极简 ZIP 读写（零依赖）。
 *
 * 打包 APK 只差最后一步：把 d8 产出的 classes.dex 塞进 aapt2 出来的 base.apk。
 * 用 Node 自带 zlib 自己拼，就不必再依赖 python 的 zipfile 或系统的 zip 命令。
 *
 * 关键点：**原样保留每个条目的压缩方式**。
 * aapt2 会把 resources.arsc 以「不压缩」方式写入，Android 要求它必须保持不压缩，
 * 重写时若统一 DEFLATE，安装/运行时会出问题。
 */

const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/**
 * 读取 zip 的全部条目（数据按原有压缩方式原样取出）。
 * @returns {{name:string, method:number, data:Buffer, crc:number, usize:number}[]}
 */
function read(file) {
  const buf = fs.readFileSync(file);

  // 从尾部往前找 EOCD（注释最长 64KB）
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件：' + file);

  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== SIG_CENTRAL) throw new Error('中央目录损坏，偏移 ' + off);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (buf.readUInt32LE(lho) !== SIG_LOCAL) throw new Error('本地头损坏：' + name);
    // 本地头的 extra 长度不一定等于中央目录里的，必须单独读，否则数据起点会偏
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;

    entries.push({ name, method, data: buf.subarray(start, start + csize), crc, usize });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/** 把一批条目写成一个全新的 zip（本地头 + 中央目录 + EOCD） */
function write(file, entries) {
  const body = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // 文件名按 UTF-8
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0x21, 12);         // mod date = 1980-01-01
    local.writeUInt32LE(e.crc >>> 0, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.usize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // 不写 extra，交由 zipalign 处理对齐
    body.push(local, name, e.data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(SIG_CENTRAL, 0);
    c.writeUInt16LE(20, 4);                // version made by
    c.writeUInt16LE(20, 6);                // version needed
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(e.method, 10);
    c.writeUInt16LE(0, 12);                // mod time
    c.writeUInt16LE(0x21, 14);             // mod date
    c.writeUInt32LE(e.crc >>> 0, 16);
    c.writeUInt32LE(e.data.length, 20);
    c.writeUInt32LE(e.usize, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(0, 38);                // external attrs
    c.writeUInt32LE(offset, 42);
    central.push(c, name);

    offset += local.length + name.length + e.data.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  fs.writeFileSync(file, Buffer.concat([...body, cd, eocd]));
}

/** 造一个 DEFLATE 压缩的条目 */
function deflated(name, content) {
  const data = zlib.deflateRawSync(content, { level: 9 });
  return { name, method: 8, data, crc: crc32(content), usize: content.length };
}

/**
 * 读 zip 并把内容**解压**出来（read() 给的是原始压缩数据，直接写文件会坏）。
 * 处理 aar 里的 classes.jar 用的就是这个 —— 压缩方式 0=stored，8=deflate。
 */
function readFile(file, wanted) {
  const e = read(file).find((x) => x.name === wanted);
  if (!e) return null;
  if (e.method === 0) return Buffer.from(e.data);
  if (e.method === 8) return zlib.inflateRawSync(e.data);
  throw new Error('不支持的压缩方式 ' + e.method + '：' + wanted);
}

/** 把整个 zip 解出来，返回 {name, data(已解压), method}[] */
function readAll(file) {
  return read(file).map((e) => ({
    name: e.name,
    method: e.method,
    data: e.method === 0 ? Buffer.from(e.data)
      : e.method === 8 ? zlib.inflateRawSync(e.data)
        : null,
  }));
}

/** 造一个不压缩的条目 */
function stored(name, content) {
  return { name, method: 0, data: content, crc: crc32(content), usize: content.length };
}

module.exports = { read, readFile, readAll, write, deflated, stored, crc32 };
