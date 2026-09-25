#!/usr/bin/env node
/* 烟价速查 —— 同步后台（零依赖，纯 Node 内置模块）
 *
 * 职责：
 *  1. 托管网页版（public/index.html）—— 自托管的「烟价速查」网页，和 App 共用同一套前端。
 *  2. 提供同步 API（/api/sync/sync）：手机 App 与网页通过它交换"表数据"，服务器做权威源。
 *
 * 同步模型：
 *  - 同步单元 = 一张表（tables store 里的记录）或 removed 集合（内置表的"已移除"名单）。
 *  - 每个单元带 upd（毫秒时间戳）。合并规则 last-write-wins：incoming.upd >= stored.upd 才接受。
 *  - 删除走 tombstone（del:true 占位），这样"删了"也能传播到其它设备。
 *  - 访问方式（2026-09-25 起两种都认）：
 *      a) 注册用户：/api/sync/register 建号、/api/sync/login 登录拿 30 天 HMAC token，
 *         同步请求带 Bearer <token>。密码加盐哈希存 DATA_DIR/users.json，token 密钥在
 *         DATA_DIR/secret.key（首次用自动生成；换它 = 所有 token 立刻失效）。
 *      b) 旧版共享密钥：环境变量 SYNC_KEY，Bearer <SYNC_KEY>（向后兼容，谁配了谁能用）。
 *    两种都没配 → /api 全部 503。局域网开放注册（适合一个店铺/一个家庭）。
 *
 * 存储：DATA_DIR/store.json（单文件，原子写）。挂个 Docker 卷就能备份/迁移。
 *
 * 环境变量：
 *  PORT        监听端口（默认 8080）
 *  DATA_DIR    数据目录（默认 ./data）
 *  SYNC_KEY    旧版访问密钥（可选；配了它就能当 Bearer 用）
 *  SERVE_DIR   静态文件目录（默认 __dirname/public）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SYNC_KEY = process.env.SYNC_KEY || '';
const SERVE_DIR = process.env.SERVE_DIR || path.join(__dirname, 'public');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

/* ---------- 存储 ---------- */
function emptyStore() { return { tables: {}, removed: { rev: 0, srev: 0, v: [] }, maxSrev: 0 }; }
function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    s.tables = s.tables && typeof s.tables === 'object' ? s.tables : {};
    s.removed = s.removed && Array.isArray(s.removed.v) ? s.removed : { rev: 0, v: [] };
    /* srev（server rev）：服务器收到每次变更时发的**严格递增**序号，是唯一的同步游标。
       老版本游标用的是「客户端 rev（客户机时钟）vs since（服务器时钟）」两套钟比大小 ——
       只要有一台设备在别的设备「改完 → 5 秒防抖推送」的窗口里同步过一次，
       since 就跳到那次改动 rev 的后面，改动永久拉不到（2026-09-26 店主实测：
       表改名后名字死活不同步）。srev 只出自服务器一个钟，杜绝这种竞态。 */
    let maxSrev = s.maxSrev || 0;
    for (const id in s.tables) {
      const e = s.tables[id];
      e.srev = e.srev || e.rev || 0;               // 旧存档没有 srev → 退化成 rev，行为同老版
      if (e.srev > maxSrev) maxSrev = e.srev;
    }
    s.removed.srev = s.removed.srev || s.removed.rev || 0;
    if (s.removed.srev > maxSrev) maxSrev = s.removed.srev;
    s.maxSrev = maxSrev;
    return s;
  } catch (e) {
    return emptyStore();
  }
}
let store = loadStore();
/* 发一个严格递增的 srev：≥ 现在的毫秒，且永远比上一个发出去的大 1。
   buildResponse 的 now 也从这儿出 —— 保证「任何一次响应之后落库的变更，
   srev 一定 > 那次响应的 now」，同毫秒内也不会漏。 */
function nextSrev() {
  store.maxSrev = Math.max(store.maxSrev || 0, Date.now()) + 1;
  return store.maxSrev;
}
function saveStoreSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_FILE);   // 原子替换，避免写到一半被读
  } catch (e) {
    console.error('[store] save failed:', e.message);
  }
}

/* ---------- 鉴权 ----------
 * 两种方式任一通过即可：
 *  a) 用户 token：Bearer <token>，token = base64url(用户名).过期毫秒.HMAC-SHA256
 *     （密钥在 DATA_DIR/secret.key，登录时签发，30 天有效，用户被删立即失效）。
 *  b) 共享密钥：Bearer <SYNC_KEY>（或 ?key= 查询参数，向后兼容旧版网页）。
 */
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const TOKEN_TTL = 30 * 24 * 3600 * 1000;    // token 30 天

function loadUsers() {
  try {
    const u = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return (u && u.users && typeof u.users === 'object') ? u : { users: {} };
  } catch (e) {
    return { users: {} };
  }
}
let users = loadUsers();
function saveUsersSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(users));
    fs.renameSync(tmp, USERS_FILE);
  } catch (e) {
    console.error('[users] save failed:', e.message);
  }
}
function getSecret() {
  try { const s = fs.readFileSync(SECRET_FILE, 'utf8').trim(); if (s) return s; } catch (e) {}
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, s);
  } catch (e) {
    console.error('[secret] save failed:', e.message);
  }
  return s;
}
const SECRET = getSecret();

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function hmacB64(body) {
  return crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64url');
}
function makeToken(username) {
  const exp = Date.now() + TOKEN_TTL;
  const body = String(username) + '.' + exp;
  return Buffer.from(String(username), 'utf8').toString('base64url') + '.' + exp + '.' + hmacB64(body);
}
function parseToken(tok) {
  if (typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length !== 3) return null;
  let username;
  try { username = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch (e) { return null; }
  const exp = +parts[1];
  if (!username || !exp || exp < Date.now()) return null;
  if (hmacB64(username + '.' + parts[1]) !== parts[2]) return null;
  if (!users.users[username]) return null;      // 用户被删，token 立即作废
  return username;
}
function authOk(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  if (m) {
    if (parseToken(m[1].trim())) return true;
    if (SYNC_KEY && m[1].trim() === SYNC_KEY) return true;
    return false;
  }
  if (SYNC_KEY) {
    const u = new URL(req.url, 'http://localhost');
    const k = u.searchParams.get('key');
    return k != null && k === SYNC_KEY;
  }
  return false;
}
function hasAnyAuth() { return !!SYNC_KEY || Object.keys(users.users).length > 0; }

/* 注册 / 登录的公共入口：读完小 JSON body 再回调 */
function readJsonBody(req, res, cb) {
  let body = '';
  req.on('data', (d) => {
    body += d;
    if (body.length > 64 * 1024) { req.destroy(); }   // 这俩接口用不了大 body
  });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
    cb(data);
  });
}
function checkUserPass(name, pass) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 32) return '用户名要 1~32 个字符';
  if (typeof pass !== 'string' || pass.length < 4) return '密码至少 4 位';
  return null;
}

/* 表 id 只允许 ASCII + 中日韩常用字符 + 常见标点，其它一律下划线。
   存储是单文件（不走文件名），这里主要是为了把脏数据挡在外面。 */
function cleanId(id) {
  if (typeof id !== 'string') return null;
  const s = id.slice(0, 200)
    .replace(/[^\u0020-\u007E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/g, '_')
    .trim();
  return s.length ? s : null;
}

/* ---------- 同步合并 ---------- */
function applyPush(data) {
  const tables = Array.isArray(data && data.tables) ? data.tables : [];
  for (const t of tables) {
    const id = cleanId(t && t.id);
    if (!id) continue;
    const rev = +(t && t.rev) || 0;          // rev = 客户机时间戳，只用于 last-write-wins
    const cur = store.tables[id];
    if (!cur || rev >= cur.rev) {
      store.tables[id] = {
        id,
        rev,
        srev: nextSrev(),                    // 游标用服务器序号，不用客户机时钟（见 loadStore 注释）
        del: !!t.del,
        table: t.del ? undefined : (t.table || null),
      };
    }
  }
  const rem = data && data.removed;
  if (rem && rem.rev && (!store.removed.rev || rem.rev >= store.removed.rev)) {
    store.removed = { rev: +(rem.rev) || 0, srev: nextSrev(), v: Array.isArray(rem.v) ? rem.v : [] };
  }
}

function buildResponse(since) {
  const now = nextSrev();                    // now 也是同一序列里的号：之后落库的 srev 必 > 任何一次 now
  const tables = [];
  for (const id in store.tables) {
    const e = store.tables[id];
    if ((e.srev || e.rev || 0) > since) {
      tables.push({ id, rev: e.rev, del: e.del, table: e.del ? undefined : e.table });
    }
  }
  const rmS = store.removed.srev || store.removed.rev || 0;
  const removed = rmS > since ? { rev: store.removed.rev, v: store.removed.v } : null;
  return { now, tables, removed };
}

/* ---------- HTTP ---------- */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function setCORS(res) { for (const k in CORS_HEADERS) res.setHeader(k, CORS_HEADERS[k]); }

function sendJSON(res, code, obj) {
  setCORS(res);
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return sendJSON(res, 400, { error: 'bad url' }); }
  const p = url.pathname;

  if (req.method === 'OPTIONS') {        // 跨域预检（file:// 的 App / 网页调服务器会触发）
    setCORS(res);
    res.writeHead(204);
    return res.end();
  }

  if (p === '/api/health') {
    return sendJSON(res, 200, { ok: true, hasKey: !!SYNC_KEY, hasUsers: Object.keys(users.users).length > 0, tables: Object.keys(store.tables).length });
  }

  /* ---- 注册：开放注册（局域网自用），用户名查重，密码加盐哈希 ---- */
  if (p === '/api/sync/register' && req.method === 'POST') {
    return readJsonBody(req, res, (data) => {
      const name = String(data.username || '').trim();
      const pass = String(data.password || '');
      const bad = checkUserPass(name, pass);
      if (bad) return sendJSON(res, 400, { error: bad });
      if (users.users[name]) return sendJSON(res, 409, { error: '该用户名已被注册' });
      const salt = crypto.randomBytes(8).toString('hex');
      users.users[name] = { salt, hash: sha256hex(salt + ':' + pass), created: Date.now() };
      saveUsersSync();
      return sendJSON(res, 200, { ok: true, username: name, token: makeToken(name) });
    });
  }

  /* ---- 登录：校验盐哈希，签发 30 天 token ---- */
  if (p === '/api/sync/login' && req.method === 'POST') {
    return readJsonBody(req, res, (data) => {
      const name = String(data.username || '').trim();
      const pass = String(data.password || '');
      const u = users.users[name];
      if (!u || u.hash !== sha256hex(String(u.salt) + ':' + pass)) {
        return sendJSON(res, 401, { error: '用户名不存在或密码不对' });
      }
      return sendJSON(res, 200, { ok: true, username: name, token: makeToken(name) });
    });
  }

  if (p === '/api/sync/sync') {
    if (!hasAnyAuth()) return sendJSON(res, 503, { error: 'server has no SYNC_KEY and no registered users' });
    if (!authOk(req)) return sendJSON(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') {
      const since = +(url.searchParams.get('since') || 0) || 0;
      return sendJSON(res, 200, buildResponse(since));
    }
    if (req.method === 'POST') {
      let body = '';
      let tooBig = false;
      req.on('data', (d) => {
        body += d;
        if (body.length > 300 * 1024 * 1024) { tooBig = true; req.destroy(); }  // 300MB 上限，防撑爆
      });
      req.on('end', () => {
        if (tooBig) return sendJSON(res, 413, { error: 'payload too large' });
        let data;
        try { data = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
        const since = +(data.since || 0) || 0;
        try {
          applyPush(data);
          saveStoreSync();
        } catch (e) {
          return sendJSON(res, 500, { error: 'save failed: ' + e.message });
        }
        return sendJSON(res, 200, buildResponse(since));
      });
      return;
    }
    return sendJSON(res, 405, { error: 'method not allowed' });
  }

  // 静态：网页版（自托管）。/ 和 /index.html 都给 public/index.html
  if (p === '/' || p === '/index.html') {
    const f = path.join(SERVE_DIR, 'index.html');
    if (fs.existsSync(f)) {
      setCORS(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }
    setCORS(res);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('index.html 不存在 —— 请先运行 tools/build_app.py 生成（需带 build/index.html）。');
  }

  setCORS(res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.on('error', (e) => {
  console.error('[server] listen error:', e.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[cigpricer-sync] listening on :${PORT}`);
  console.log(`[cigpricer-sync] data dir: ${DATA_DIR}`);
  console.log(`[cigpricer-sync] auth: SYNC_KEY=${SYNC_KEY ? '已设置' : '未设置'} 用户数=${Object.keys(users.users).length}`);
});
