// 假的大模型接口（只为了「自带 API」这条链路的离线自测）
//
//   node tools/mock_vendor_api.js            # 起在 8787
//   PORT=9000 node tools/mock_vendor_api.js
//
// 行为完全照 OpenAI 的 /chat/completions 来：缺 Authorization 就 401，
// 正文里有图就跟据提示词里的「行号从 1 到 K」回 K 行 `行号|MOCK商品N`。
// 它的意义是让我们在**没有真 key 的时候**也能验证：请求格式对不对、
// 响应解析对不对、换模型/重试/退避逻辑跑不跑得通。
// ⚠️ 别指望它认字 —— 它只会应数。

const http = require('http');

const PORT = +(process.env.PORT || 8787);
const LOG = 'build/mock-vendor.log';
const fs = require('fs');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function linesFor(text) {
  let m = /行号从 1 到 (\d+)/.exec(text);            // 整列
  if (!m) m = /只要 (\d+) 行/.exec(text);            // 开头核对那 3 格
  const K = m ? +m[1] : (/双喜|行的什么/.test(text) ? 1 : 3);
  const out = [];
  for (let i = 1; i <= K; i++) out.push(i + '|MOCK商品' + i);
  return out.join('\n');
}

http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (/\/models$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'Qwen/Qwen3-VL-30B-A3B-Instruct', object: 'model' },
          { id: 'mock-vl', object: 'model' },
          { id: 'Qwen/Qwen2.5-VL-32B-Instruct', object: 'model' },
          { id: 'gpt-4o-mini', object: 'model' }
        ]
      }));
    }
    if (!/\/chat\/completions$/.test(req.url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: '假接口只认 /chat/completions' } }));
    }
    const auth = req.headers.authorization || '';
    if (!/^Bearer\s+\S+/i.test(auth)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: '缺少 Bearer 密钥' } }));
    }

    let j = {};
    try { j = JSON.parse(body); } catch (e) { }

    /* 把这一请求的要点记下来，出错时能看清到底发出去的是什么 */
    const msgs = j.messages || [];
    const user = msgs.filter(m => m.role === 'user').pop() || {};
    const parts = Array.isArray(user.content) ? user.content : [{ type: 'text', text: String(user.content || '') }];
    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    const imgs = parts.filter(p => p.type === 'image_url');
    const rec = {
      t: new Date().toISOString(), model: j.model, stream: !!j.stream, temp: j.temperature,
      nMsg: msgs.length, nImg: imgs.length,
      imgHead: imgs[0] ? String(imgs[0].image_url && imgs[0].image_url.url || '').slice(0, 24) : '',
      imgDetail: imgs[0] ? (imgs[0].image_url && imgs[0].image_url.detail) : '',
      bytes: (imgs[0] ? String(imgs[0].image_url && imgs[0].image_url.url || '').length : 0),
      promptHead: text.slice(0, 60).replace(/\n/g, '⏎')
    };
    try {
      fs.mkdirSync(require('path').dirname(LOG), { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
    } catch (e) { }
    console.log(JSON.stringify(rec));

    const content = linesFor(text);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', created: Date.now(), model: j.model,
      choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: content.split('\n').length, total_tokens: 1 }
    }));
  });
}).listen(PORT, () => console.log('假 OpenAI 接口已起：http://127.0.0.1:' + PORT + '/v1/chat/completions'));
