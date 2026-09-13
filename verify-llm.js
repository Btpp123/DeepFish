// ============================================================
// verify-llm.js —— DeepSeek 讲棋的验收测试
//
// 这个文件分三层，从里往外：
//
//   ① 客户端单元测试 —— 给 llm.js 塞一个假的 fetch，
//      把「401 会怎样」「429 重试几次」「超时怎么办」这些分支全走一遍。
//      ★ 关键：**不需要真实密钥、不需要联网**。这样这些错误分支才有人测 ——
//        靠真人去制造一个"账户余额不足"来测代码，等于永远不测。
//
//   ② 提示词组装测试 —— 纯函数，验证喂给模型的事实是准确的。
//      尤其是"这一步亏了多少"这个减法，算反了整套讲解就全反了。
//
//   ③ 端到端 —— 起一个**假的 DeepSeek 服务器**（本地 mock，OpenAI 兼容格式），
//      再起一个真的后端，用真 HTTP 把整条链路跑通。
//      仍然不需要真实密钥，但验证的东西是真的：
//      请求真的发出去了、格式对不对、密钥有没有漏给浏览器。
//
// 运行： node verify-llm.js
// ============================================================

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Chess } = require('chess.js');

const { DeepSeekClient, LlmError, resolveEndpoint, maskKey, getLlm, loadEnvFile, ENV_PATH } =
  require('./src/llm');
const { buildExplainPrompt, normalizeSwing, describeEval, scoreToText, candidatesOf } =
  require('./src/coach');
const P = require('./src/position');
const K = require('./src/knowledge');

const ROOT = __dirname;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log('  ✅ ' + name + (detail ? '   [' + detail + ']' : ''));
  } else {
    fail++;
    failures.push(name);
    console.log('  ❌ ' + name + (detail ? '   [' + detail + ']' : ''));
  }
}

function section(t) {
  console.log('\n' + '─'.repeat(64));
  console.log(t);
  console.log('─'.repeat(64));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M = [{ role: 'user', content: '讲讲这一步' }];

// ---------- 测试用的小工具 ----------

/** 造一个假的 Response */
function fakeResponse({ status = 200, body = '', headers = {} } = {}) {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = String(headers[k]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null) },
    text: async () => body,
  };
}

/**
 * 造一个假的 fetch。script 是一个"剧本"数组，第 n 次调用用第 n 个元素。
 * 元素是 Response 就返回它，是 Error 就抛它，是函数就调用它。
 * 数组不够长就重复用最后一个 —— 方便写"一直 429"这种场景。
 */
function makeFetch(script = []) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = script.length ? script[Math.min(i, script.length - 1)] : fakeResponse();
    i++;
    if (typeof step === 'function') return step(url, init);
    if (step instanceof Error) throw step;
    return step;
  };
  fn.calls = calls;
  return fn;
}

/** 假睡：不真的等，但把每次等了多久记下来 —— 好验证"退避是不是真的在退" */
function makeSleep() {
  const waits = [];
  const fn = (ms) => { waits.push(ms); return Promise.resolve(); };
  fn.waits = waits;
  return fn;
}

const OK_BODY = JSON.stringify({
  id: 'chatcmpl-test',
  model: 'deepseek-chat',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: '**这一步是败着。** 你没看到对手的牵制。' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320 },
});

const jsonOf = (obj) => JSON.stringify(obj);
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** 从一串着法算出 FEN */
function fenAfter(moves) {
  const text = (Array.isArray(moves) ? moves.join(' ') : String(moves))
    .replace(/\d+\.(\.\.)?/g, ' ').trim();
  const g = new Chess();
  for (const m of text ? text.split(/\s+/).filter(Boolean) : []) g.move(m);
  return g.fen();
}

/** 拿一个空闲端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ============================================================
(async () => {
  console.log('\n🐟🤖 DeepFish —— DeepSeek 讲棋验收测试');

  // ============================================================
  section('① 客户端：密钥与配置（不需要网络）');
  // ============================================================

  {
    const f = makeFetch();
    const c = new DeepSeekClient({ apiKey: '', fetchImpl: f });
    check('没配密钥时 configured = false', c.configured === false);

    let err = null;
    try { await c.chat(M); } catch (e) { err = e; }
    check('没配密钥时抛 LlmError', err instanceof LlmError);
    check('  错误码是 no_key', err && err.code === 'no_key', err && err.code);
    check('  ★ 本地就拦下了，一个请求都没发出去', f.calls.length === 0, f.calls.length + ' 次');
    check('  提示指向 .env 文件', /\.env/.test(err.hint || ''), (err.hint || '').slice(0, 30) + '…');
  }

  {
    const KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const c = new DeepSeekClient({ apiKey: KEY });
    const info = c.info();
    const dumped = JSON.stringify(info);

    check('info() 报告了"已配置"', info.configured === true);
    check('★★ info() 里没有密钥原文', !dumped.includes(KEY));
    check('  info() 里连 apiKey 这个字段都没有', !('apiKey' in info));
    check('  只给出打码预览', /^[\w-]{1,8}\*{4}[\w-]{1,8}$/.test(info.keyPreview), info.keyPreview);
    check('  打码后的东西不足以还原密钥', info.keyPreview.length < KEY.length - 6,
      info.keyPreview.length + ' < ' + (KEY.length - 6));
  }

  {
    // 环境变量要能覆盖一切
    const backup = {};
    for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_TIMEOUT_MS']) {
      backup[k] = process.env[k];
    }
    process.env.DEEPSEEK_API_KEY = 'sk-from-env-1234567890';
    process.env.DEEPSEEK_MODEL = 'deepseek-reasoner';
    process.env.DEEPSEEK_BASE_URL = 'https://example.com/v1';
    process.env.DEEPSEEK_TIMEOUT_MS = '9000';

    const c = new DeepSeekClient();
    check('密钥能从头到尾从环境变量读进来', c.configured === true);
    check('  模型名也读进来了', c.model === 'deepseek-reasoner', c.model);
    check('  超时也读进来了', c.timeoutMs === 9000, c.timeoutMs);
    check('  ★ base url 带 /v1 时拼得对',
      c.endpoint === 'https://example.com/v1/chat/completions', c.endpoint);

    for (const k of Object.keys(backup)) {
      if (backup[k] === undefined) delete process.env[k]; else process.env[k] = backup[k];
    }
  }

  // ---------- ①.5 「改完 .env 不用重启」这件事的机制 ----------
  // 用户实际踩到的坑：密钥填好、保存、刷新页面 —— 功能一直用不了，
  // 界面上还什么都不说。根因是配置只在进程启动那一刻读了一次。
  // 修法：loadEnvFile() 每次按 .env 的修改时间决定要不要重新读，
  // 而 getLlm()（每个请求都会走过）每次都会刷新一遍客户端的配置。
  //
  // ⚠️ 这里**绝不去碰真的 .env 文件** —— 那是用户的真实配置。
  //    验的是机制本身：环境变量一变，同一个客户端实例就能跟上。
  {
    const backup = process.env.DEEPSEEK_API_KEY;
    const c = new DeepSeekClient({ apiKey: 'sk-first-1234567890' });
    check('换个配置之前，用的是旧的那个', c.info().keyPreview.endsWith('7890'), c.info().keyPreview);

    process.env.DEEPSEEK_API_KEY = 'sk-second-abcd1234efgh';
    c.refreshFromEnv();
    check('★ 不用重建客户端，refreshFromEnv() 就能读到新的密钥',
      c.info().keyPreview.endsWith('efgh'), c.info().keyPreview);

    // getLlm 是每个请求都会走的那条路。空字符串是"有配置项但没填内容"，
    // 它会挡住 .env 里的值（dotenv 不去覆盖已存在的环境变量）——
    // 正好拿来模拟"用户把密钥删了"。
    process.env.DEEPSEEK_API_KEY = '';
    const g1 = getLlm();
    check('  环境变量清空后，getLlm() 立刻报告"未配置"', g1.configured === false);

    process.env.DEEPSEEK_API_KEY = 'sk-third-zzzz9999yyyy';
    const g2 = getLlm();
    check('★★ 再把密钥放回去，同一个实例立刻又能用了（这就是"不用重启"）',
      g2 === g1 && g2.configured === true, g2.info().keyPreview);
    check('  ★ 刷了这么多次，info() 里始终没有密钥原文',
      !JSON.stringify(g2.info()).includes('sk-third'));

    if (backup === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = backup;
  }

  check('loadEnvFile / ENV_PATH 有导出（服务和测试都靠它读 .env）',
    typeof loadEnvFile === 'function' && /\.env$/.test(ENV_PATH), ENV_PATH);

  check('★ base url 不带 /v1 也拼得对',
    resolveEndpoint('https://api.deepseek.com') === 'https://api.deepseek.com/chat/completions');  check('  base url 末尾多个斜杠也不怕',
    resolveEndpoint('https://api.deepseek.com//') === 'https://api.deepseek.com/chat/completions');
  check('  可以整个覆盖成别的地址（自建中转用得上）',
    resolveEndpoint('https://api.deepseek.com', 'http://127.0.0.1:8080/v1/chat/completions')
      === 'http://127.0.0.1:8080/v1/chat/completions');

  check('打码函数对短字符串也安全', maskKey('abc') === '***', maskKey('abc'));
  check('  空字符串不会炸', maskKey('') === '', JSON.stringify(maskKey('')));

  // ============================================================
  section('② 客户端：请求与响应（假 fetch，不需要网络）');
  // ============================================================

  {
    const f = makeFetch([fakeResponse({ body: OK_BODY })]);
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: makeSleep() });
    const r = await c.chat(M);

    check('能取到正文', /败着/.test(r.text), r.text.slice(0, 24) + '…');
    check('  正文两头的空白被去掉了', r.text === r.text.trim());
    check('  带回了模型名', r.model === 'deepseek-chat');
    check('  带回了 token 用量', r.usage && r.usage.total_tokens === 320);
    check('  只请求了一次', f.calls.length === 1);

    const call = f.calls[0];
    check('  请求打在 /chat/completions 上', call.url.endsWith('/chat/completions'), call.url);
    check('  带了 Bearer 鉴权头', call.init.headers.Authorization === 'Bearer sk-test-1234567890');
    check('  用的是 POST', call.init.method === 'POST');

    const sent = JSON.parse(call.init.body);
    check('  请求体是标准 OpenAI 格式（model / messages / stream）',
      sent.model === 'deepseek-chat' && Array.isArray(sent.messages) && sent.stream === false);
    check('  关掉了流式（我们的后端一次性收完）', sent.stream === false);
    check('  messages 原样送过去', sent.messages[0].content === '讲讲这一步');
  }

  {
    // ---------- 401：密钥不对 ----------
    const f = makeFetch([fakeResponse({
      status: 401,
      body: jsonOf({ error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } }),
    })]);
    const c = new DeepSeekClient({ apiKey: 'sk-wrong-1234567', fetchImpl: f, sleepImpl: makeSleep() });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }

    check('401 → 错误码 auth', err && err.code === 'auth', err && err.code);
    check('  ★ 不重试（密钥错，重试一百次也还是错）', f.calls.length === 1, f.calls.length + ' 次');
    check('  标成不可重试', err.retryable === false);
    check('  保留了 HTTP 状态码', err.status === 401);
    check('  带回了上游的原始说法', /Authentication Fails/.test(err.detail || ''), (err.detail || '').slice(0, 40));
    check('  给人话提示，指向密钥本身', /密钥/.test(err.hint || ''));
  }

  {
    // ---------- 402：余额不足 ----------
    const f = makeFetch([fakeResponse({
      status: 402,
      body: jsonOf({ error: { message: 'Insufficient Balance' } }),
    })]);
    const c = new DeepSeekClient({ apiKey: 'sk-poor-1234567', fetchImpl: f, sleepImpl: makeSleep() });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }

    check('402 → 错误码 insufficient_balance', err && err.code === 'insufficient_balance', err && err.code);
    check('  不重试', f.calls.length === 1);
    check('  提示告诉用户去充值', /充值|余额/.test(err.hint || ''), (err.hint || '').slice(0, 20) + '…');
  }

  {
    // ---------- 429：限流，重试一次就成功 ----------
    const f = makeFetch([
      fakeResponse({ status: 429, body: jsonOf({ error: { message: 'Rate limit reached' } }) }),
      fakeResponse({ body: OK_BODY }),
    ]);
    const sl = makeSleep();
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: sl, maxRetries: 2 });
    const r = await c.chat(M);

    check('429 → 自动重试，第二次成功', f.calls.length === 2, f.calls.length + ' 次');
    check('  结果是好的', /败着/.test(r.text));
    check('  报告了真实尝试次数', r.attempts === 2, r.attempts);
    check('  ★ 重试之前等了一会儿（不是立刻重发）', sl.waits.length === 1 && sl.waits[0] > 0,
      JSON.stringify(sl.waits));
  }

  {
    // ---------- 429：一直失败，重试耗尽 ----------
    const f = makeFetch([fakeResponse({ status: 429, body: jsonOf({ error: { message: 'slow down' } }) })]);
    const sl = makeSleep();
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: sl, maxRetries: 2 });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }

    check('429 一直失败 → 最终抛出 rate_limit', err && err.code === 'rate_limit', err && err.code);
    check('  ★ 总共请求 3 次（原始 1 次 + 重试 2 次）', f.calls.length === 3, f.calls.length + ' 次');
    check('  提示告诉用户等一下', /等/.test(err.hint || ''), (err.hint || '').slice(0, 20) + '…');
    check('  ★ 退避是递增的（第二次等得比第一次久）',
      sl.waits.length === 2 && sl.waits[1] > sl.waits[0],
      JSON.stringify(sl.waits.map((w) => Math.round(w))));
  }

  {
    // ---------- 429 带 Retry-After：要听对方的 ----------
    const f = makeFetch([
      fakeResponse({ status: 429, headers: { 'retry-after': '3' }, body: '{}' }),
      fakeResponse({ body: OK_BODY }),
    ]);
    const sl = makeSleep();
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: sl, maxRetries: 2 });
    await c.chat(M);

    check('★ 对方用 Retry-After 说了等 3 秒，就等 3 秒',
      sl.waits.length === 1 && sl.waits[0] === 3000, JSON.stringify(sl.waits));
  }

  {
    // ---------- 500：对方服务器出错 ----------
    const f = makeFetch([fakeResponse({ status: 503, body: '<html>Service Unavailable</html>' })]);
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: makeSleep(), maxRetries: 0 });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }

    check('5xx → 错误码 server', err && err.code === 'server', err && err.code);
    check('  标成可重试', err.retryable === true);
    check('  提示说清楚这是对方的锅', /不是你的/.test(err.hint || ''), (err.hint || '').slice(0, 24) + '…');
  }

  {
    // ---------- 网络断了 ----------
    const f = makeFetch([new TypeError('fetch failed')]);
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: makeSleep(), maxRetries: 1 });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }

    check('连不上 → 错误码 network', err && err.code === 'network', err && err.code);
    check('  会自动重试一次', f.calls.length === 2, f.calls.length + ' 次');
    check('  提示让用户查网络', /网络|外网/.test(err.hint || ''));
  }

  {
    // ---------- 超时 ----------
    const f = makeFetch([(url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    })]);
    const c = new DeepSeekClient({
      apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: makeSleep(),
      timeoutMs: 40, maxRetries: 0,
    });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }

    check('等太久 → 错误码 timeout', err && err.code === 'timeout', err && err.code);
    check('  ★ 超时真的会中止请求（没有一直挂着）', f.calls.length === 1);
    check('  提示里给出可调的参数名', /DEEPSEEK_TIMEOUT_MS/.test(err.hint || ''));
  }

  {
    // ---------- 200 但不是 JSON ----------
    const f = makeFetch([fakeResponse({ status: 200, body: '<html><body>502 Bad Gateway</body></html>' })]);
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: makeSleep() });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }

    check('200 但内容是 HTML → bad_response', err && err.code === 'bad_response', err && err.code);
    check('  把拿到的片段记下来了（方便排查）', /Bad Gateway/.test(err.detail || ''), (err.detail || '').slice(0, 30));
  }

  {
    // ---------- 200，但没有正文 ----------
    const f = makeFetch([fakeResponse({
      status: 200,
      body: jsonOf({ model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }),
    })]);
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: makeSleep() });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }

    check('回复没有正文 → bad_response', err && err.code === 'bad_response', err && err.code);
    check('  ★ 认出是"被长度截断"，给出对应的建议',
      /长度|DEEPSEEK_MAX_TOKENS/.test(err.message + err.hint), err.message.slice(0, 40));
  }

  {
    // ---------- 200，但 choices 是空的 ----------
    const f = makeFetch([fakeResponse({ status: 200, body: jsonOf({ model: 'x', choices: [] }) })]);
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: makeSleep() });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }
    check('choices 为空 → bad_response', err && err.code === 'bad_response', err && err.code);
  }

  {
    // ---------- 密钥擦除 ----------
    const KEY = 'sk-supersecretkey1234567890abcd';
    const f = makeFetch([fakeResponse({
      status: 401,
      // 恶劣情况：某个中转/网关在报错里把 Authorization 头原样回显了
      body: jsonOf({ error: { message: 'Invalid token: Bearer ' + KEY + ' is not recognized' } }),
    })]);
    const c = new DeepSeekClient({ apiKey: KEY, fetchImpl: f, sleepImpl: makeSleep() });
    let err = null; try { await c.chat(M); } catch (e) { err = e; }

    check('★★ 即使上游在报错里回显了密钥，detail 里也看不到它',
      !JSON.stringify(err.detail).includes(KEY), (err.detail || '').slice(0, 46) + '…');
    check('  回显的位置被打了码', /\*\*\*/.test(err.detail || ''));
    check('  但报错的有用信息还在', /Invalid token/.test(err.detail || ''));
  }

  {
    // ---------- 空 messages 要拦下来 ----------
    const f = makeFetch([fakeResponse({ body: OK_BODY })]);
    const c = new DeepSeekClient({ apiKey: 'sk-test-1234567890', fetchImpl: f, sleepImpl: makeSleep() });
    let err = null; try { await c.chat([]); } catch (e) { err = e; }
    check('空 messages → bad_request', err && err.code === 'bad_request', err && err.code);
    check('  也没浪费一次网络请求', f.calls.length === 0);
  }

  // ============================================================
  section('③ 讲棋提示词：数字必须准（纯函数）');
  // ============================================================

  {
    // ---------- swing 的方向：最容易搞反的地方 ----------
    const w = normalizeSwing({ beforeCp: 20, afterCp: -417 }, 'w');
    check('★ 白方走完之后白方视角大跌 → 白方亏了（负数）',
      w.forMover === -437, String(w.forMover));

    const b = normalizeSwing({ beforeCp: 20, afterCp: 417 }, 'b');
    check('★ 黑方走完之后白方视角大涨 → 黑方亏了（也是负数）',
      b.forMover === -397, String(b.forMover));

    const good = normalizeSwing({ beforeCp: 0, afterCp: 100 }, 'w');
    check('  走了好棋 → 是正的', good.forMover === 100, String(good.forMover));

    const blackGood = normalizeSwing({ beforeCp: 0, afterCp: -100 }, 'b');
    check('  黑方走了好棋（白方视角跌）→ 也是正的',
      blackGood.forMover === 100, String(blackGood.forMover));

    check('  小差值照样如实算出来',
      normalizeSwing({ beforeCp: 10, afterCp: 15 }, 'w').forMover === 5);
  }

  {
    // ---------- 前端塞进来的数字不算数 ----------
    const s = normalizeSwing({ beforeCp: 0, afterCp: 100, forMover: 999999 }, 'w');
    check('★★ 前端自称的 forMover 被无视，后端按两个原始评分自己重算',
      s.forMover === 100, String(s.forMover));
    check('  缺数据时返回 null（而不是瞎猜一个数）', normalizeSwing(null, 'w') === null);
    check('  只有一个评分时，forMover 是 null',
      normalizeSwing({ beforeCp: 20 }, 'w').forMover === null);
  }

  {
    check('评分转文字：正数带 +', scoreToText(417, null) === '+4.17', scoreToText(417, null));
    check('  负数带 -', scoreToText(-417, null) === '-4.17', scoreToText(-417, null));
    check('  大优势取整', scoreToText(1500, null) === '+15', scoreToText(1500, null));
    check('  将杀写成 M 几', scoreToText(null, 3) === '+M3', scoreToText(null, 3));
    check('  没数据写破折号', scoreToText(null, null) === '—');
  }

  {
    check('评分的口头说法：均势', describeEval(15, null) === '基本均势', describeEval(15, null));
    check('  小优', /白方稍好/.test(describeEval(50, null)), describeEval(50, null));
    check('  大优', /白方大优/.test(describeEval(350, null)), describeEval(350, null));
    check('  黑方优势也会说人话', /黑方/.test(describeEval(-350, null)), describeEval(-350, null));
    // ★ 回归：pov = 'b' 时文案必须跟着翻过来。
    //   传进来的 cp 是**白方视角**，函数先按 pov 翻成"提问方视角"，
    //   可后面点名时却一律写"白方" —— 那样黑方提问时整句话是反的。
    //   现在没有调用方传 'b'，但这个坑不该留着。
    check('★ 从黑方视角问：-3.50 是黑方好（不是白方）',
      /黑方大优/.test(describeEval(-350, null, 'b')), describeEval(-350, null, 'b'));
    check('  从黑方视角问：+3.50 如实说是白方好',
      /白方大优/.test(describeEval(350, null, 'b')), describeEval(350, null, 'b'));
    check('  均势那句话与视角无关', describeEval(15, null, 'b') === '基本均势');
    check('  将杀那两句只分「我能杀 / 我被杀」，也会跟着视角翻过来',
      describeEval(null, 1, 'b') === '已经能被算到将杀（1 步内）' &&
      describeEval(null, -1, 'b') === '已经能算到将杀（1 步内）',
      describeEval(null, 1, 'b') + ' / ' + describeEval(null, -1, 'b'));
  }

  {
    // ---------- 完整的提示词 ----------
    const { messages, meta } = buildExplainPrompt({
      fen: START_FEN,
      ply: 9,
      san: 'Qd2',
      color: 'w',
      engine: { scoreCp: -417, scoreMate: null, scoreText: '-4.17', bestMoveSan: 'Nf3', pvSan: ['Nf3', 'd5', 'd4'], depth: 10 },
      swing: normalizeSwing({ beforeCp: 20, afterCp: -417 }, 'w'),
      opening: ['e4', 'e5', 'Nf3'],
      history: ['Bc4', 'Nf6'],
      annotation: '[%eval -4.17] 这一手太急了',
    });

    check('是两条消息：system + user', messages.length === 2 &&
      messages[0].role === 'system' && messages[1].role === 'user');

    const sys = messages[0].content;
    const usr = messages[1].content;

    check('★ 系统提示词明令禁止模型自己产生数字',
      /绝对不要\*\*引入我没给的子、没给的格/.test(sys) &&
      /没给的着法、没给的数字/.test(sys));
    check('  也禁止它自作主张评判好坏', /不要自己判断/.test(sys));
    check('  规定了篇幅', /150 到 250 字/.test(sys));
    check('  规定了输出格式（前端只认这几种）', /不要标题、不要表格/.test(sys));

    // ---- 第四版新增：逐子走子规则（用户要的"大幅降低幻觉"）----
    check('★ system 里有逐子走子规则速查（兵 / 马 / 象 / 车 / 后 / 王）',
      /【第二条规矩：每提到一个子怎么走，先按规则核对】/.test(sys) &&
      /- \*\*兵\*\*/.test(sys) && /- \*\*马\*\*/.test(sys) && /- \*\*象\*\*/.test(sys) &&
      /- \*\*车\*\*/.test(sys) && /- \*\*后\*\*/.test(sys) && /- \*\*王\*\*/.test(sys));
    check('★★ 明令禁止"给兵让出退路"这类违反规则的描述',
      /给兵让出退路/.test(sys) && /全是错的/.test(sys),
      (sys.match(/⚠️ 所以[^\n]*/) || [''])[0].slice(0, 60));
    check('  说清了兵不能后退、斜走才是吃子、吃过路兵被吃的兵不在落点',
      /永远不能后退、不能横走/.test(sys) && /斜走一格才是吃子/.test(sys) &&
      /不在你落到的格子上/.test(sys));
    check('  说清了马是唯一能跳过子的（免得它自己"发明"一个挡马规则）',
      /唯一能跳过别的棋子/.test(sys));
    check('  说清了象/车/后中间不能有子、王不能走到的格',
      /中间不能有任何子挡着/.test(sys) && /不能走到对方能吃到的格子上/.test(sys));
    check('  说清了被将军只有三种应法、被牵住的子不能动',
      /只有三种应法/.test(sys) && /被牵住（钉住）的子不能动/.test(sys));

    // ---- 第四版新增：记谱歧义（用户报的那个"是哪一个马"）----
    check('★★ system 里点明了记谱在"只有一个合法"时不写是哪一个',
      /只写 Nc4，不说是哪一个/.test(sys),
      (sys.match(/但还有另一种情况[^\n]*/) || [''])[0]);
    check('★★ 并且要求以"括号里的起止格"为准、不许自己猜',
      /一律以括号里的起止格为准/.test(sys) && /不要去猜，也不要说成另一个子/.test(sys));
    check('  核对不了时只许说"某个马/某个兵"，不许编起止格',
      /绝对不要\*\*替它编一个起止格/.test(sys));

    // ---- 第四版新增：严格基于给定局面 + 允许说"看不出来" ----
    check('★★ system 里要求"没给的就说看不出来"，不许用"应该/大概"糊过去',
      /我看不出来/.test(sys) && /应该 \/ 大概 \/ 可能/.test(sys));
    check('  并且禁止自己补变化、禁止替对手想应着',
      /自己补一条变化/.test(sys) && /替对手想好他会怎么应/.test(sys));
    check('  还要求每条主张都能指回上面某一行', /都要能指回上面某一行/.test(sys));
    check('★ system 里说明了"先判意图、再看怎么应对"的用法',
      /先看走棋方想干什么，再看另一方怎么应对/.test(sys) &&
      /它想干什么"只能从下面三条里挑/.test(sys));

    // ---- 第五版新增：关于"谁盯着哪个格"的规矩（用户抓到的 d6 幻觉的正解）----
    check('★★ system 里点明了远程子的线会被**任何**子挡住、包括自己的子',
      /包括自己的子/.test(sys) && /挡在中间/.test(sys),
      (sys.match(/远程子[\s\S]{0,60}/) || [''])[0].replace(/\s+/g, ' '));
    check('★★ 并且规定：只说那个子到得了的格子，别处不许提',
      /只说它到得了的格子/.test(sys) && /不要点出具体格子/.test(sys));
    check('  说法和单子里那一行对得上（"能去哪"）', /能去哪儿/.test(sys));

    // ---- 第五版之二：不许对着单子念（用户抓到的第二种空话）----
    // 用户原话："不要再让他给出'按给出的表''但注意：它没有攻击黑方任何子 ——
    //   表里"能吃到对方的子"一栏是空的'这种空话。"
    check('★★ system 里禁止向读者描述这份材料本身',
      /不要向读者描述这份材料本身/.test(sys) && /这一栏是空的/.test(sys),
      (sys.match(/不要向读者描述[^\n]*/) || [''])[0]);
    check('★ 而且不再教它说"这一点上面没有给"（那正是对着单子念的源头）',
      !/这一点上面没有给/.test(sys) && /这一点我看不出来/.test(sys));
    check('  空着的那一项也不许替它做总结',
      /不要写"它没有攻击任何一个子"/.test(sys));

    // ---- 第六版：把"变化线"读成"眼下的威胁"（用户在样例第 9 步抓到的）----
    // 模型把引擎变化线里的**第 5 手** Ne4 讲成了"现在就能踩过去"的威胁。
    // 根因之一是那一串后续着法从来没被定义过"这是假想线、只有第 1 手是现在能走的"。
    check('★★ system 里写清了"后续那几手"是假想线、只有 [1] 是现在能走的',
      /只有 \[1\] 是现在就能走的/.test(sys) && /假想线/.test(sys),
      (sys.match(/【"后续那几手"[^\n]*/) || [''])[0]);
    check('★★ 并且明令不许把后面的着法说成"他现在威胁要…"',
      /绝对不要\*\*把 \[2\] 以后的着法说成/.test(sys));
    check('  要求提后面的着法时必须说清它在第几手',
      /这条线走到第 3 手才是/.test(sys));
    check('  也说了别把后面那几手里的子说成"正盯着某个格"',
      /假想局面里的事/.test(sys));
    check('★ 指出"现在真正成立的威胁"只写在"现在能白吃 / 一步将杀"那几行里',
      /现在能白吃 \/ 一步将杀/.test(sys));

    // ---- 第六版：线关系（牵制 / 穿刺）只能从那一段里引用 ----
    check('★★ system 里规定牵制/穿刺的话只能引用材料里列出来的线',
      /这类话\*\*只能引用那里列出来的\*\*/.test(sys) &&
      /和谁在一条线上/.test(sys),
      (sys.match(/材料里会单独列出[^\n]*/) || [''])[0]);

    // ---- 第七版：把"意图"变成选择题，并堵死两条歪路（用户报的 19...Kd8）----
    // 用户原话："这一步棋本质是想用王去守护 c7 格的象……但模型对这一步棋的想法
    //   描述的不知所云。"（模型讲成了"王去 d8 是为了把 d8 让给车，还躲开了 c 线的压力"。）
    check('★★ system 里把"这步棋想干什么"限定成三选一（守住了谁 / 盯上了谁 / 让出了什么）',
      /它守住了谁/.test(sys) && /它盯上了谁/.test(sys) && /它让出了什么/.test(sys),
      (sys.match(/⚠️ \*\*"它想干什么"[\s\S]{0,80}/) || [''])[0].replace(/\n/g, ' '));
    check('★★ 并且指明了"守住了谁"就去看那一段"给谁补了保护"的材料',
      /这一步给谁补了保护/.test(sys) && /★ 补了保护/.test(sys));
    check('★★ 挑不出来时允许它老实说"看不出来"', /我看不出来/.test(sys) &&
      /这是允许的老实回答/.test(sys));
    check('★★ 禁止拿引擎候选倒推意图（"另一个子走同一个格"更不许讲成让位）',
      /不许拿"引擎的候选"倒推它想干什么/.test(sys) && /占住/.test(sys) && /妨碍/.test(sys));
    check('★★ 禁止编"躲开了谁的压力 / 摆脱了牵制"',
      /不许说某一步"躲开了谁的压力""摆脱了牵制"/.test(sys));
    check('★★ 引用【线关系】必须点出两边的子，不许挪到第三个子头上',
      /必须把两边的子都点出来/.test(sys) && /不许\*\*把它挪到第三个子头上/.test(sys));

    // ---- 第八版：两条被用户当场抓到的毛病 ----
    // ① 模型把"代价立刻写在【线关系】里"这种话说进正文（对着材料念）。
    // ② 模型说"给 g1 的王补上了保护" —— 方向正好反了（王是守人的那一方）。
    check('★★ system 里把"材料里的段名/行首标记不许写进正文"钉死了',
      /正文里一个字都不许出现/.test(sys) && /代价立刻写在【线关系】里/.test(sys),
      (sys.match(/⚠️ \*\*我这份材料里的段名[\s\S]{0,60}/) || [''])[0].replace(/\n/g, ' '));
    check('★ 并且给了正例：事实要直接讲出来', /马一让开，a5 的后就能吃到它/.test(sys));
    check('★★ system 里点明了"守它的子是王"时的方向（是王在守别人）',
      /这只王在守别人/.test(sys) && /主语是守人的那一方/.test(sys));
    check('★★ 并且明令不许说"给某只王补上了保护"',
      /给 g1 的王补上了保护/.test(sys) && /王永远不出现在"被守 \/ 被补保护 \/ 没人守"这一侧/.test(sys));

    check('★ 用户提示词里带着鳕鱼的真实评分', /\-4\.17/.test(usr));
    check('  带着走这一步之前的评分（0.20）', /\+0\.20/.test(usr), '');
    check('  ★ 把"亏了多少"替它算好了', /亏了约 4\.37/.test(usr));
    check('  带着引擎认为该走的那步', /Nf3/.test(usr));
    // 后续变化不再是一行裸着法，而是"谁走 + 该步之后的完整局面"；
    // 第四版起又多了「动手的子 + 起止格」那个锚点（防"是哪个子"的幻觉）。
    check('  带着引擎预想的变化（一步步、每步都带局面 + 起止格锚点）',
      /白方 Nf3（马 g1→f3） → {2}\S+ \S+ \S+ \S+ \S+ \S+/.test(usr) &&
      /黑方 d5（兵 d7→d5） → {2}\S+ \S+ \S+ \S+ \S+ \S+/.test(usr),
      (usr.match(/ {4}\[\d+\] (白方|黑方) [^\n]*/) || [''])[0]);
    // ---- 第六版：变化线每一步带上序号；并明说这是假想线（治"把第 5 手当眼下威胁"）----
    check('★★ 变化线每一步前面都有 [序号]（模型才分得清哪一手是现在的）',
      /\[1\] 白方 Nf3/.test(usr) && /\[2\] 黑方 /.test(usr),
      (usr.match(/ {4}\[\d+\][^\n]*/g) || []).slice(0, 2).join(' ｜ '));
    check('★★ 并且紧跟一句"只有 [1] 是现在就能走的"',
      /⚠️ 这是假想线：只有 \[1\] 是现在就能走的/.test(usr));
    check('  带着搜索深度', /第 10 层/.test(usr));
    check('  带着棋谱原本的评注', /这一手太急了/.test(usr));
    check('  ★ 明说棋谱评注只是参考、可能和引擎不一致',
      /仅供参考/.test(usr) && /不一致/.test(usr));
    check('  带上了开局背景', /e4 e5 Nf3/.test(usr));
    check('  带上了刚才几步', /Bc4 Nf6/.test(usr));
    check('  明确要求讲"错在哪"', /问题出在哪里/.test(usr));

    check('meta 记录了步数和走法', meta.ply === 9 && meta.san === 'Qd2');
    check('meta 标出了这份单子里有鳕鱼数据', meta.hasEngineData === true);
    check('meta 标出了有前后对比', meta.hasSwing === true);
  }

  {
    // ---------- 「轮到谁」必须说清楚，外加"本该走的那一步" ----------
    // 这是接上真 DeepSeek 之后第一次实调暴露出来的：
    // 早先那句是「引擎认为这个局面本该走的是：Nc6」—— 主谓宾全靠猜，
    // 而引擎分析的是**刚走完那一步之后**的局面，它建议的其实是**对手**该走什么。
    // 实测模型把 Nc6（黑方的着法）安到了刚走棋的白方头上，
    // 然后写了一整段自相矛盾的话。
    const { messages } = buildExplainPrompt({
      // 黑方该走
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
      ply: 2, san: 'Nf3', color: 'w',
      engine: {
        scoreCp: 30, scoreText: '+0.30',
        bestMoveSan: 'Nc6', bestMoveBeforeSan: 'Nc3',
        pvSan: ['Nc6'], depth: 14,
      },
    });
    const usr = messages[1].content;

    check('★★ 明说了现在轮到谁走（黑方），不会让人把建议安到白方头上',
      /轮到黑方走/.test(usr),
      (usr.match(/引擎对[^\n]*/) || [''])[0]);
    check('★★ 单独给了"本该走的那一步"（白方走了 Nf3，引擎说该走 Nc3）',
      /引擎建议白方走的是：Nc3/.test(usr),
      (usr.match(/（对照）[^\n]*/) || [''])[0]);
    check('  并且说清楚了那一步没有被走', /没有被走/.test(usr));
    check('  还要求模型结合这一条来解释', /为什么更好/.test(usr));
  }

  {
    // 拿不到"本该走的那一步"时，那一行不该出现 —— 更不能让模型去对比一个不存在的东西
    const { messages } = buildExplainPrompt({
      fen: START_FEN, ply: 1, san: 'e4', color: 'w',
      engine: { scoreCp: 20, bestMoveSan: 'e5' },
    });
    const usr = messages[1].content;
    check('  没有对照数据时，"本该走的那一步"那行不出现（不编）',
      !/没有被走/.test(usr));
    check('  ★ 也不会要求模型去对比一个不存在的东西', !/为什么更好/.test(usr));
    check('  仍然照常问"这一步问题出在哪里"', /问题出在哪里/.test(usr));
  }

  {
    // ---------- 他走的正好是引擎首选：不能把它写成"另有一个建议" ----------
    // 真机联调第二处发现：棋谱里黑方走的 1...e5 正是引擎的首选，
    // 可那一行原本照写「引擎建议黑方走的是：e5（这一步没有被走）」——
    // 读起来像是引擎提了别的建议，模型于是转头去挑一步好棋的毛病。
    const { messages } = buildExplainPrompt({
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      ply: 2, san: 'e5', color: 'b',
      engine: { scoreCp: 25, bestMoveSan: 'Nf3', bestMoveBeforeSan: 'e5', depth: 14 },
      swing: normalizeSwing({ beforeCp: 25, afterCp: 25 }, 'b'),
    });
    const usr = messages[1].content;

    check('★★ 走的正是引擎首选时，明说"这一步本身没有问题"',
      /这一步本身没有问题/.test(usr),
      (usr.match(/（对照）[^\n]*/) || [''])[0]);
    check('  不会把它写成"没有走的那一步"', !/没有被走/.test(usr));
    check('  提问也跟着换了，不再问"问题出在哪里"', !/问题出在哪里/.test(usr));
    check('  改成问"它好在哪里"', /它好在哪里|正是引擎的首选/.test(usr),
      (usr.match(/1\.[^\n]*/) || [''])[0]);
  }

  {
    // ---------- 没有引擎数据时不能硬编 ----------
    const { messages } = buildExplainPrompt({
      fen: START_FEN, ply: 1, san: 'e4', color: 'w',
      engine: null, swing: null, opening: [], history: [],
    });
    const usr = messages[1].content;
    check('★ 没有鳕鱼数据时，整张单子里不出现任何评分', !/评分/.test(usr));
    check('  依然能生成一份完整的单子', usr.includes('【请讲】'));
    check('★ 也不会凭空捏造"亏了多少"', !/[亏赚]了/.test(usr));
  }

  {
    // ---------- 将杀局面：引擎只给 mate，不给 cp ----------
    // 这是写这个文件时真踩到的坑：如果只认 scoreCp，
    // "白方两步内将杀"这条**最关键**的结论会被整行跳过 ——
    // 而它正是用户最想知道的那句话。
    const { messages } = buildExplainPrompt({
      fen: START_FEN, ply: 6, san: 'Nf6', color: 'b',
      engine: { scoreCp: null, scoreMate: 2, scoreText: '+M2', bestMoveSan: 'g6' },
      swing: null,
    });
    const usr = messages[1].content;
    check('★★ 只有将杀分数、没有厘兵分数时，结论照样写进单子',
      /走这步之后的局面评分/.test(usr) && /将杀/.test(usr),
      (usr.match(/走这步之后的[^\n]*/) || [''])[0]);
    check('  说清楚了是几步行杀', /2 步内/.test(usr));
    check('  不会把它误报成"没算出来"', !/没算出来/.test(usr));
  }

  {
    // ---------- 还没走出下一步 ----------
    const { messages } = buildExplainPrompt({
      fen: START_FEN, ply: 0, san: '', color: 'w',
      engine: { scoreCp: 20, bestMoveSan: 'e4', pvSan: ['e4'], depth: 12 },
    });
    const usr = messages[1].content;
    check('★ 还没走棋时，问题的问法改成"形势如何"', /形势大致如何/.test(usr));
    check('  不再问"这一步问题出在哪里"', !/问题出在哪里/.test(usr));
  }

  {
    // ---------- 终局 ----------
    const { messages } = buildExplainPrompt({
      fen: START_FEN, ply: 10, san: 'Qh4#', color: 'b',
      engine: { scoreMate: 0 }, gameOver: true,
    });
    const usr = messages[1].content;
    check('★ 终局时的提问改成"总结这盘棋"', /总结/.test(usr) && /转折/.test(usr));
    check('  也明说了这盘棋结束了', /已经结束/.test(usr));
  }

  {
    // ---------- 自由提问要把原问题带进去 ----------
    const { messages } = buildExplainPrompt({
      fen: START_FEN, ply: 3, san: 'Nf3', color: 'w',
      engine: { scoreCp: 30, bestMoveSan: 'Nf3' },
      question: '这盘棋白方的计划是什么？',
    });
    check('用户自己的问题会被原样带进去',
      /白方的计划是什么/.test(messages[1].content));
  }

  // ============================================================
  section('③.5 【新】多路线 / 逐步局面 / 战术参考');
  // ============================================================
  //
  // 用户提的"提示词明显不足"三条，全在这一节里守：
  //   ① 前后两个局面都给 FEN，后续每一步的 FEN 也一起给；
  //   ② 不止一条主变化，给前三条候选 —— 这才答得出"是真好棋还是不得已"；
  //   ③ "这一步亏了多少"在将杀局面下不再整行消失（原来是个洞）。
  //
  // ⚠️ 这一节大量依赖 chess.js 复算。测试里凡是"应该算出来的东西"，
  //    都顺手用 chess.js 自己验一遍（比如把提示词里的 FEN 抓出来重新解析），
  //    不然测试只是把实现又抄了一遍。

  // 学者将杀：黑方第 3 回合走 Nf6，一步走成被将杀。这一步正是最该讲清楚的那类。
  const SCH_BEF = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
  const SCH_AFT = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

  const SCH_BEF_ENG = {
    scoreCp: -17, scoreMate: null, scoreText: '-0.17',
    bestMoveSan: 'g6', pvSan: ['g6', 'Qf3', 'Nf6', 'Ne2'], depth: 16,
    alternatives: [
      { rank: 2, firstMoveSan: 'Qe7', scoreCp: 6, scoreMate: null, pvSan: ['Qe7', 'd3'] },
      { rank: 3, firstMoveSan: 'Qf6', scoreCp: 16, scoreMate: null, pvSan: ['Qf6', 'Nc3'] },
    ],
  };
  const SCH_AFT_ENG = {
    scoreCp: null, scoreMate: 1, scoreText: '+M1',
    bestMoveSan: 'Qxf7#', pvSan: ['Qxf7#'], depth: 16,
    alternatives: [
      { rank: 2, firstMoveSan: 'Qd1', scoreCp: -221, scoreMate: null, pvSan: ['Qd1', 'Nxe4'] },
      { rank: 3, firstMoveSan: 'Qg5', scoreCp: -278, scoreMate: null, pvSan: ['Qg5', 'h6'] },
    ],
  };

  {
    // ---------- ① 确定性事实：这一步到底干了什么 ----------
    const nf = P.moveFacts(SCH_BEF, 'Nf6');
    check('★ 从走之前的局面重放出"这一步干了什么"（不用模型猜）',
      nf && nf.pieceCn === '马' && nf.from === 'g8' && nf.to === 'f6',
      nf ? nf.pieceCn + ' ' + nf.from + '→' + nf.to : 'null');
    check('  没吃子就说没吃子', nf && nf.isCapture === false);
    check('  合法着法数由规则给出（28 个）', nf && nf.legalCount === 28, String(nf && nf.legalCount));
    check('  28 个可选的时候不说"被迫"', nf && nf.isForced === false);
    check('  它也自己算出了"走完之后"的局面',
      nf && P.samePosition(nf.fenAfter, SCH_AFT));

    const cap = P.moveFacts('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'exd5');
    check('  吃子会被指出来（exd5 → 吃掉对方一个兵）',
      cap && cap.isCapture && cap.capturedCn === '兵', cap && cap.capturedCn);

    const cast = P.moveFacts('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5', 'O-O');
    check('  王车易位会被指出来，还分得出哪一侧',
      cast && cast.isCastle === true && /短易位/.test(cast.castleSide || ''),
      cast && cast.castleSide);

    const mate = P.moveFacts(SCH_AFT, 'Qxf7#');
    check('  将杀会被指出来（不用从 # 号去猜）',
      mate && mate.isCheckmate === true && mate.givesCheck === true);

    check('  走不动的着法返回 null（不猜）',
      P.moveFacts(SCH_BEF, 'Qxf7#') === null);

    // 只有一步合法着法 —— "不得已只能这样走"的字面情形
    const forced = P.moveFacts('7k/8/8/8/8/8/6q1/7K w - - 0 1', 'Kxg2');
    check('★★ 字面意义上的"只能这样走"：只有 1 个合法着法',
      forced && forced.legalCount === 1 && forced.isForced === true,
      forced ? forced.legalCount + ' 个' : 'null');
  }

  {
    // ---------- ① 每一步之后的局面：把 FEN 一路推出来 ----------
    const trail = P.sanTrail(SCH_AFT, ['Qxf7#'], 8);
    check('★ 后续每一步之后的局面都能推出来',
      trail.length === 1 && !!trail[0].fen, JSON.stringify(trail[0] && trail[0].fen));
    check('  这一步是将杀，推到这里就到底了（后面没有着法了）',
      trail[0].isMate === true);
    const trail3 = P.sanTrail(SCH_BEF, ['g6', 'Qf3', 'Nf6'], 8);
    check('★ 谁走这一步也标出来了（黑、白、黑 轮着来）',
      trail3.map((t) => t.mover).join('') === 'bwb',
      trail3.map((t) => t.mover).join(''));
    check('  三步就有三个不同的局面',
      new Set(trail3.map((t) => t.fen)).size === 3);
    check('  每一步的 FEN 都是真实可解析的局面',
      trail3.every((t) => { try { new Chess(t.fen); return true; } catch { return false; } }));

    check('  走不通就停在那里（半条真的线，好过一条编的线）',
      P.sanTrail('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        ['e4', 'Bxh7', 'Nf3'], 8).length === 1);
    check('  空数组不报错', P.sanTrail(SCH_BEF, [], 8).length === 0);
    check('  给个假局面的 FEN 也不炸', P.sanTrail('不是局面', ['e4'], 8).length === 0);
  }

  {
    // ---------- 「这条线里他到底亏了多少子」：弃子判定的地基 ----------
    //
    // ★ 这一组是回归用：早先这里取的是"中途亏得最深的那一下"，
    //   于是**任何一次等价交换**（吃→吃回）中途都会短暂亏空，
    //   被判成"他弃了 3 个兵"，`isSacrifice` 几乎恒真，
    //   弃子类的战术参考和经典对局就被硬塞进每一次讲解里。
    //   现在改成算**净变化**（走完整条线他还亏着多少），兑子归零、真弃子还在。
    const TRADE_FEN = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
    const trade = P.lineMaterialDrop(TRADE_FEN, ['a6', 'Bxc6', 'dxc6'], 'b', 8);
    check('★★ 等价交换（吃→吃回）不算弃子：净亏是 0',
      trade.drop === 0, JSON.stringify(trade));
    check('  但中途亏得最深的那一下如实留着（只作排查用）',
      trade.peak === 3 && trade.at === 'Bxc6', JSON.stringify(trade));

    // 真的弃子：Bxh7+ Kxh7 —— 一个象换一个兵，净亏 2，没人还他
    const SAC_FEN = 'r1bq1rk1/pppn1ppp/3bpn2/3p4/2PP4/2NBPN2/PP3PPP/R1BQK2R w KQ - 0 1';
    const sac = P.lineMaterialDrop(SAC_FEN, ['Bxh7+', 'Kxh7'], 'w', 8);
    check('★★ 真弃子照样认得出来（象换兵，净亏 2）',
      sac.drop === 2, JSON.stringify(sac));

    check('  走不通 / 空线 → 一分没亏',
      P.lineMaterialDrop(TRADE_FEN, [], 'b', 8).drop === 0 &&
      P.lineMaterialDrop('不是局面', ['a6'], 'b', 8).drop === 0);
    check('  他反而赚了子 → 记 0，不记负数',
      P.lineMaterialDrop(TRADE_FEN, ['Nxe5', 'Nxe5', 'd4'], 'w', 8).drop >= 0);
  }

  {
    // ---------- 「动手的是哪个子、从哪到哪」这个锚点 ----------
    //
    // ★ 这是用户报的那个幻觉的正解：两个同类子**看起来**都能到同一格、
    //   实际只有一个合法（另一个走了会送将）时，记谱**只写着法名、不写是哪一个**。
    //   模型看到光秃秃一个 Nc4 就只能猜 —— 所以凡是进提示词的着法都要带起止格。
    const A = P.moveAnchor;
    check('★ 锚点：普通着法说清是哪个子、从哪到哪',
      A(SCH_BEF, 'Nf6') === '马 g8→f6', A(SCH_BEF, 'Nf6'));
    check('  吃子用 ×', A('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'exd5') === '兵 e4×d5',
      A('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'exd5'));
    check('  易位把车也写出来（不然像"王凭空挪了两格"）',
      A('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5', 'O-O') ===
        '王 e1→g1，短易位，车 h1→f1',
      A('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5', 'O-O'));
    check('  长易位也一样',
      /长易位，车 a1→d1/.test(A('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'O-O-O')));
    check('  升变说清变成了什么',
      A('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a8=Q+') === '兵 a7→a8，升变为后',
      A('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a8=Q+'));
    check('  走不出来 / 局面不认 → 空串（宁可没锚点，也不给个错的）',
      A('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'Qh5') === '' &&
      A('不是局面', 'e4') === '' && A(SCH_BEF, '') === '');
    check('  带上修饰符（Nf6!?）也认得出来', A(SCH_BEF, 'Nf6!?') === '马 g8→f6');
    check('  sanTrail 每一步都带锚点', P.sanTrail(START_FEN, ['e4', 'e5'])
      .every((s) => !!s.anchor && !!s.from && !!s.to && s.pieceCn === '兵'));
  }

  {
    // ---------- ★ 用户报的那个具体场景，端到端走一遍提示词 ----------
    //
    // 白 Kd1、Nb2、Nd2，黑 Qd8：d2 那个马被后牵住，一动白王就暴露 → 它走不了。
    // 于是"两个马都能到 c4"实际只有 b2 那个合法，记谱只写 Nc4。
    const PIN = '3qk3/8/8/8/8/8/1N1N4/3K4 w - - 0 1';
    const pinGame = new Chess(PIN);
    const toC4 = pinGame.moves({ verbose: true }).filter((m) => m.to === 'c4');
    check('★ 前置：这种局面下记谱确实不带区分（只有一个合法着法）',
      toC4.length === 1 && toC4[0].san === 'Nc4' && toC4[0].from === 'b2',
      JSON.stringify(toC4.map((m) => m.from + '→' + m.to + ' = ' + m.san)));

    const pinAfter = P.moveFacts(PIN, 'Nc4').fenAfter;
    const pinOut = buildExplainPrompt({
      fen: pinAfter, beforeFen: PIN, ply: 1, san: 'Nc4', color: 'w',
      engine: { scoreCp: 30, scoreMate: null, bestMoveSan: 'Kd7', pvSan: ['Kd7', 'Kc2'] },
      engineBefore: {
        scoreCp: 20, scoreMate: null, bestMoveSan: 'Nc4', depth: 16, pvSan: ['Nc4', 'Kd7'],
        alternatives: [{ rank: 2, firstMoveSan: 'Kd7', scoreCp: 10, pvSan: ['Kd7'] }],
      },
      swing: normalizeSwing({ beforeCp: 20, afterCp: 30 }, 'w'),
    });
    const pinUsr = pinOut.messages[1].content;
    check('★★ 提示词把"是哪个马"写死了（模型不用猜）',
      /Nc4（马 b2→c4）/.test(pinUsr) && /马 从 b2 走到 c4/.test(pinUsr),
      (pinUsr.match(/本次要讲的是[^\n]*/) || [''])[0]);
    check('★★ 引擎的候选那一行也带锚点', /① Nc4（马 b2→c4）/.test(pinUsr));
    check('★★ 逐步局面每一行也带锚点',
      /白方 Nc4（马 b2→c4） → {2}\S+ \S+ \S+ \S+ \S+ \S+/.test(pinUsr));
    check('  引擎在现在这个局面的建议同样带锚点',
      /最佳着法：Kd7（王 e8→d7）/.test(pinUsr),
      (pinUsr.match(/最佳着法[^\n]*/) || [''])[0]);
    check('  meta 里也留了锚点，方便排查', pinOut.meta.playedAnchor === '马 b2→c4');

    // ★ 顺序：先判意图，再评这一步，最后才是"该怎么应对"
    check('★★ 第一问是"这一步想干什么"（意图）',
      /1\. 先判断白方刚走的 Nc4（马 b2→c4）想干什么/.test(pinUsr),
      (pinUsr.match(/1\. 先判断[^\n]*/) || [''])[0].slice(0, 80));
    check('  并且要求指名道姓说威胁了哪个子、哪个格', /威胁了黑方的哪个子、哪个格/.test(pinUsr));
    check('  还要求分清进攻还是防守', /是进攻（要吃、要打、要攻王）还是防守/.test(pinUsr));
    check('★★ 最后问的是"现在轮到对方，该怎么应对"',
      /3\. 现在轮到黑方走。引擎对这个局面给出的最佳着法是 Kd7（王 e8→d7）/.test(pinUsr),
      (pinUsr.match(/3\. 现在轮到[^\n]*/) || [''])[0].slice(0, 80));
    check('  而且明确禁止它另想别的招', /不要另想别的招/.test(pinUsr));
  }

  {
    // ---------- 第四版：战场一览（威胁 / 防守 / 为什么是将杀）----------
    //
    // 用户的原话："这个项目里 deepseek 似乎没有威胁和防守的概念，很多时候就是
    // 照着鳕鱼的分析读一遍"。根因是**单子里根本没有这两个词的实体** ——
    // 要讲威胁，它手上只有几个 FEN，而"读 FEN 推攻击关系"正是我们禁止它做的事。
    // 这一组就是这个洞的锁：所有威胁/防守事实都必须是**算出来的**。
    const CHECKMATE_AFTER = 'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';

    // ① 走 Nf6 之前（轮到黑方）：引擎该走 g6，它在**防**什么
    const defOut = buildExplainPrompt({
      fen: SCH_BEF, beforeFen: SCH_BEF, ply: 6, san: 'Nf6', color: 'b',
      engine: { scoreCp: -26, scoreMate: null, bestMoveSan: 'g6', pvSan: ['g6'] },
    }).messages[1].content;
    check('★★ 单子里有「战场一览」这一段', /【战场一览/.test(defOut));
    check('★★ 它列出了"威胁"（算出来的，不是猜的）',
      /的威胁/.test(defOut) && /一步将杀/.test(defOut),
      (defOut.match(/· ★ \*\*[^\n]*/) || [''])[0].slice(0, 70));
    check('★★ 也说清了引擎那一手挡掉了什么 —— "防守"终于有实体了',
      /【引擎推荐的那一手在干什么】/.test(defOut) && /挡掉了/.test(defOut),
      (defOut.match(/· 它把对方的威胁[^\n]*/) || [''])[0].slice(0, 70));
    check('  还列了没人保护的子', /没人保护的子/.test(defOut));

    // ② 将杀局面：为什么是将杀
    const mateOut = buildExplainPrompt({
      fen: CHECKMATE_AFTER, beforeFen: SCH_AFT, ply: 7, san: 'Qxf7#', color: 'w',
      engine: { scoreCp: null, scoreMate: 1, bestMoveSan: null, pvSan: [] },
    }).messages[1].content;
    check('★★ 将杀时给出"为什么这是将杀"', /【为什么这是将杀/.test(mateOut),
      (mateOut.match(/· [^\n]*/g) || []).slice(0, 2).join(' | ').slice(0, 90));
    check('  说清了"一个合法着法都没有"（将杀的定义）',
      /一个合法着法都没有/.test(mateOut));

    // ③ 直接调事实层，逐条核对算得对不对（不经过提示词）
    const th = P.immediateThreats(SCH_AFT);
    check('★ 事实层：Nf6 之后白方有一步将杀 Qxf7#',
      th.mates.length === 1 && th.mates[0].san === 'Qxf7#',
      JSON.stringify(th.mates.map((m) => m.san)));
    check('★ 事实层：f7 那个兵"没人保护"（被象盯着、吃回来不合法）',
      P.loosePieces(SCH_AFT, 'b').some((x) => x.square === 'f7'),
      JSON.stringify(P.loosePieces(SCH_AFT, 'b').map((x) => x.square)));
    check('★ 事实层：Nf6 之后 f6 的马盯着 h5 的后',
      P.attacksFrom(SCH_AFT, 'f6').some((x) => x.square === 'h5'),
      JSON.stringify(P.attacksFrom(SCH_AFT, 'f6').map((x) => x.square)));

    const effG6 = P.engineEffect(SCH_BEF, 'g6');
    check('★★ 事实层：g6 挡掉了 Qxf7#（这就是"防守"）',
      effG6.stoppedMates.some((m) => m.san === 'Qxf7#'),
      JSON.stringify(effG6.stoppedMates.map((m) => m.san)));
    const effNf6 = P.engineEffect(SCH_BEF, 'Nf6');
    check('★★ 事实层：对照 —— Nf6 什么威胁都没挡掉',
      effNf6.stoppedMates.length === 0 && effNf6.stoppedWins.length === 0);

    const mr = P.mateReason(CHECKMATE_AFTER);
    check('★★ 事实层：为什么 Qxf7# 是将杀（王无路可走 + 将军的子被保护）',
      !!mr && mr.kingFlightCount === 0 && mr.checkerGuarded && mr.checkers.length === 1,
      JSON.stringify(mr && { flights: mr.kingFlightCount, guarded: mr.checkerGuarded }));

    // ④ 被将军时不谈"对方的威胁"（那种时候谈威胁只会误导）
    check('  被将军时 foeThreats 老实返回 null',
      P.foeThreats('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3') === null);
  }

  {
    // ---------- 第五版：一个子"到底能去哪" ----------
    //
    // 用户抓到的幻觉（样例第 9 步 Qd2）：模型说
    // "d2 的后和 f4 的象一起盯住了 d6 格" —— 而 d 线往上第一个子就是
    // **d4 自己的兵**，后根本看不到 d6。
    //
    // 挖下去发现根因不在"喂错了"，而在这种**安静局面**上我们什么都没喂
    // （没人一步将杀、没人悬着 → 【战场一览】整段为空），
    // 模型只好自己去 FEN 上推格子关系，然后推错。
    // 所以补了这张"去向表"，并且明说：表是完整的，表外的格子不许说。
    const QD2_AFTER = 'r3kb1r/p3pppp/p1p2n2/q2p1b2/3P1B2/1PN1P3/P1PQ1PPP/R3K1NR b KQkq - 2 9';
    const QD2_BEFORE = 'r3kb1r/p3pppp/p1p2n2/q2p1b2/3P1B2/1PN1P3/P1P2PPP/R2QK1NR w KQkq - 1 9';

    const qm = P.pieceMap(QD2_AFTER, 'd2');
    const qSquares = [...qm.attacks, ...qm.defends, ...qm.controls].map((x) => x.square);
    check('★★ 后 d2 的去向表里**没有 d6**（它被 d4 上自己的兵挡住）',
      !qSquares.includes('d6'), JSON.stringify({ 吃到: qm.attacks.map((x) => x.square), 护住: qm.defends.map((x) => x.square), 空格: qm.controls.map((x) => x.square) }));
    check('★ 而没人打得着的子不进"护着谁"那一行（d4 没人盯，所以不列 —— 免得给出一串假保护）',
      !qSquares.includes('d4'), JSON.stringify(qm.defends.map((x) => x.square)));
    check('  被牵住的子：去向表是空的（它现在哪儿也去不了）',
      P.pieceMap('3qk3/8/8/8/8/8/1N1N4/3K4 w - - 0 1', 'd2').controls.length === 0);
    const qOut = buildExplainPrompt({
      fen: QD2_AFTER, beforeFen: QD2_BEFORE, ply: 17, san: 'Qd2', color: 'w',
      engine: { scoreCp: -417, scoreMate: null, bestMoveSan: 'e5', pvSan: ['e5'] },
    }).messages[1].content;
    check('★★ 单子里给了「这一步动过的那个子能去哪」',
      /这一步动过的那个子/.test(qOut) && /能去哪（按规则算的）/.test(qOut));
    const qBlock = (qOut.match(/【这一步动过的那个子[\s\S]*?）\n/) || [''])[0];
    check('★★ 那张落点里根本没出现 d6（这就是那个幻觉的正解）',
      qBlock.length > 0 && !qBlock.includes('d6'),
      qBlock.split('\n').slice(0, 4).join(' ｜ '));
    check('★★ 而且明说"上面就是全部，一个不漏"',
      /上面就是全部，一个不漏/.test(qOut) && /别的格子它到不了/.test(qOut));

    // ★ 第二种空话：不许对着单子念"某一栏是空的"
    check('★★ 空着的那一项**不写出来**（不留给模型念表格的机会）',
      !/能吃到对方的子：没有/.test(qOut) && !/能护住自己的子：没有/.test(qOut),
      qBlock.replace(/\n/g, ' ｜ ').slice(0, 100));
    check('★ 但落点那一行永远在（它是防幻觉的那道闸）',
      /能落到的空格：/.test(qBlock));
    check('  守卫句里也不许提"表""栏"（免得模型跟着念结构）',
      !/一栏|这张表/.test(qBlock), qBlock.replace(/\n/g, ' ｜ ').slice(0, 100));
  }

  {
    // ---------- 第六版：线关系（牵制 / 穿刺） ----------
    //
    // 用户在样例第 9 步抓到的第二处费解：模型写"黑方 Ne4 直接踩到 d2 后和
    // c3 马共处的这条线上"，把引擎变化线里的**第 5 手**讲成了眼下的威胁。
    //
    // 但它想指的那个机制**是真的**：黑后 a5 沿 a5-b4-c3-d2 盯着 c3 的马，
    // 而马后面紧挨着就是白后 d2。这块事实我们从来没算过，它只好自己编。
    const QD2_AFTER = 'r3kb1r/p3pppp/p1p2n2/q2p1b2/3P1B2/1PN1P3/P1PQ1PPP/R3K1NR b KQkq - 2 9';
    const QD2_BEFORE = 'r3kb1r/p3pppp/p1p2n2/q2p1b2/3P1B2/1PN1P3/P1P2PPP/R2QK1NR w KQkq - 1 9';

    const lines = P.lineTactics(QD2_AFTER, 'w');
    const pin = lines.find((x) => x.square === 'c3');
    check('★★ lineTactics 找到了模型想指的那条线（a5 的后盯着 c3 的马，马后面是 d2 的后）',
      !!pin && pin.attacker === 'a5' && pin.behind === 'd2' && pin.toKing === false,
      JSON.stringify(pin));
    check('  也算了 a 线：a5 的后盯着 a2 的兵，兵后面是 a1 的车',
      lines.some((x) => x.square === 'a2' && x.attacker === 'a5' && x.behind === 'a1'));

    // 后面是王 → 这才是"钉住"（绝对不能动），必须和"穿刺"分开说
    const pinKing = P.lineTactics('3qk3/8/8/8/8/8/1N1N4/3K4 w - - 0 1', 'w')[0];
    check('★ 后面是王的时候标成 toKing（材料里说的是"钉住、它不能动"）',
      !!pinKing && pinKing.toKing === true && pinKing.behind === 'd1',
      JSON.stringify(pinKing));

    // ⚠️ attackers() 是看几何的，它不知道牵制：一个自己被钉住的子几何上照样"盯着"别人，
    //    但它根本不敢吃。假线索正是我们要挡掉的东西，所以拿合法着法表筛过。
    const PINNED_ATK = '4k3/Q3r3/8/8/8/8/8/K3R3 w - - 0 1';
    check('★★ 自己被钉住的子不算"盯着"（e7 的车被 e1 的车钉着，吃 a7 的后是违规的）',
      P.lineTactics(PINNED_ATK, 'w').length === 0,
      JSON.stringify(P.lineTactics(PINNED_ATK, 'w')));
    check('  但同一局面反过来是对的：e7 的车确实被 e1 的车钉住',
      (P.lineTactics(PINNED_ATK, 'b')[0] || {}).toKing === true);

    const qOut2 = buildExplainPrompt({
      fen: QD2_AFTER, beforeFen: QD2_BEFORE, ply: 17, san: 'Qd2', color: 'w',
      engine: { scoreCp: -447, scoreMate: null, bestMoveSan: 'e5', pvSan: ['e5'] },
    }).messages[1].content;
    check('★★ 单子里给了【线关系】那一段', /【线关系/.test(qOut2));
    check('★★ 里面点名 a5 → c3 → d2 这条线（模型不用再自己编"共处一条线"）',
      /马 c3[\s\S]{0,80}a5[\s\S]{0,80}d2/.test(qOut2),
      (qOut2.match(/· 白方的马 c3[^\n]*/) || [''])[0].slice(0, 90));
    check('★ 并且规定"上面没提到的子不许说它被谁盯着"',
      /上面没提到的子，就不要说它被谁盯着/.test(qOut2));
    check('  没有线的时候整段不出现（不占篇幅）',
      !/【线关系/.test(buildExplainPrompt({
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ply: 1, color: 'w',
      }).messages[1].content));
  }

  {
    // ---------- 第七版：一步棋的"意图"（前后对比）----------
    //
    // 用户报的样例第 19 步（19...Kd8）："这一步棋本质是想用王去守护 c7 格的象，
    // 这样象就有两个子共同守护……但模型对这一步棋的想法描述的不知所云。"
    //
    // 查下来：材料里关于意图**是空的**（王被排除在"护住"之外），模型只好去候选表里
    // 抓了一条最像的（候选 Rd8、实际 Kd8，同一个落点），还讲反了方向。
    //
    // 而意图本来就是一句前后对比：这一步改变了谁的保护？
    const KD8_AFTER = '2rk3r/p1bn1ppp/p1R1p3/3pN3/1P1Pb3/P3P3/5PPP/2R3K1 w - - 5 20';
    const KD8_BEFORE = '2r1k2r/p1bn1ppp/p1R1p3/3pN3/1P1Pb3/P3P3/5PPP/2R3K1 b k - 4 19';

    // 引擎判决（真跑过）：王在 e8 时白方 Rxc7 是首选、走完基本均势；
    // 王在 d8 时白方 Rxc7 掉到 -7.33 —— 也就是"王确实把 c7 那格补厚了"。
    const d = P.protectionDelta({ beforeFen: KD8_BEFORE, fen: KD8_AFTER, color: 'b', from: 'e8', to: 'd8' });
    const g = d.gained.find((x) => x.square === 'c7');
    check('★★ 前后对比算出了"这一步给 c7 的象补了保护"（这就是 Kd8 的意图）',
      !!g && g.defBefore.length === 1 && g.defBefore[0].square === 'c8' &&
      g.defNow.some((x) => x.square === 'd8'),
      JSON.stringify(g && { 之前: g.defBefore.map((x) => x.square), 现在: g.defNow.map((x) => x.square) }));
    check('★★ 并且算出了"这一步让 f7 的兵没人守了"（这就是代价）',
      d.lost.some((x) => x.square === 'f7' && x.defBefore.some((y) => y.square === 'e8') && x.defNow.length === 0),
      JSON.stringify(d.lost.map((x) => x.square)));
    check('★ 同一个子的新旧两格不该被误报（王从 e8 到 d8，d7 的马前后都是"王在守"）',
      !d.gained.some((x) => x.square === 'd7') && !d.lost.some((x) => x.square === 'd7'));
    check('  没人打它的子不进这张表（不占篇幅）',
      !d.gained.concat(d.lost).some((x) => x.square === 'c8'));
    check('  没给"走之前"的局面就老实返回空', (() => {
      const e = P.protectionDelta({ fen: KD8_AFTER, color: 'b', from: 'e8', to: 'd8' });
      return e.gained.length === 0 && e.lost.length === 0;
    })());

    // ---- 王不再被排除在"护住"之外 ----
    // 老代码里 `mine.type === 'k'` 直接 return false —— 于是"王守着某个子"这类事实
    // 永远出不来，而 Kd8 的意图正好是这一类。
    check('★★ 王守着某个子现在算得出来了（不再被硬排除）',
      P.pieceMap(KD8_AFTER, 'd8').defends.some((x) => x.square === 'd7'),
      JSON.stringify(P.pieceMap(KD8_AFTER, 'd8').defends));
    check('  但"王守 c7"没被吹出来：白方吃上来之后王立刻吃回是不合法的',
      !P.pieceMap(KD8_AFTER, 'd8').defends.some((x) => x.square === 'c7'));
    check('★ 对方吃不进来的子不再算"护着"（治的正是"王护着 f2、g2、h2、车 f1"那一串假保护）',
      P.pieceMap('2kr1bnr/ppp1pppp/2n5/3P4/2P5/4BB2/Pq3PPP/RN1Q1RK1 b - - 1 10', 'g1')
        .defends.map((x) => x.square).join(',') === 'f2');

    // ---- 材料里真的给出了这两条 ----
    const kOut = buildExplainPrompt({
      fen: KD8_AFTER, beforeFen: KD8_BEFORE, ply: 38, san: 'Kd8', color: 'b',
      engine: { scoreCp: 143, bestMoveSan: 'Nxf7+', pvSan: ['Nxf7+', 'Ke7', 'Nxh8'] },
    }).messages[1].content;
    check('★★ 单子里给了【这一步给谁补了保护 / 让谁没人守了】',
      /【这一步给谁补了保护 \/ 让谁没人守了/.test(kOut));
    check('★★ 里面点名了 c7 的象、并写出"走之前只有 c8 的车一个人"',
      /象 c7[\s\S]{0,60}走之前只有 c8 的车一个人/.test(kOut),
      (kOut.match(/· ★ 补了保护[^\n]*/) || [''])[0]);
    check('★★ 也点名了 f7 的兵"这一走开，就没人守它了"',
      /兵 f7[\s\S]{0,60}就没人守它了/.test(kOut),
      (kOut.match(/· ★ 失去了保护[^\n]*/) || [''])[0]);
    check('★ 口径写明是"够得着"，不是"吃了能立刻吃回"',
      /"它的走子范围够得着这一格"/.test(kOut) && /不是\*\*"对方吃上来它就能立刻吃回"/.test(kOut));
    check('  没有这句话的局面不出现这一段（不占篇幅）',
      !/【这一步给谁补了保护/.test(buildExplainPrompt({
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        beforeFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        ply: 1, san: 'e4', color: 'w',
      }).messages[1].content));

    // ---- 第八版：受保护的一定是"上面点名的那个子"，王只在守人那一侧 ----
    // 用户报的：模型说"给 g1 的王补上了保护" —— 方向反了。
    check('★★ 句子写成了名单式（"守它的子：走之前…现在又多了…"），读不出反向',
      /守它的子：走之前只有 c8 的车一个人，现在又多了 d8 的王/.test(kOut),
      (kOut.match(/· ★ 补了保护[^\n]*/) || [''])[0]);
    check('★★ 守人的是王时额外标了方向（"是这只王来守它，不是反过来"）',
      /是这只王来守它/.test(kOut));
    check('★★ 口径里写明王不会出现在"被守"的那一侧',
      /王不会出现在"被守"的那一侧/.test(kOut));
    check('  任何一条"补了保护 / 失去了保护"的前面都不会是王（王不能被吃）', (() => {
      const lines = kOut.split('\n').filter((l) => /★ (补了保护|失去了保护)：/.test(l));
      return lines.length === 2 && !lines.some((l) => /★ (补了保护|失去了保护)：王 /.test(l));
    })());

    // ---- 第八版之二：把"王被补了保护"这类话在全样本上钉死 ----
    // 这一条不是针对某一个局面，而是**把内置的几盘棋全走一遍**，
    // 逐个局面拼出材料，检查有没有哪一行把王放到了"被守/被补保护/没人守"那一侧，
    // 或者把王当成牵制线里"挡在前面的那个子"。
    // （王不当"被守"的一侧是规则决定的：王不能被吃，所以这类事实永远不该出现。）
    {
      const fs = require('fs');
      const movesOf = (pgn) => {
        let t = String(pgn).replace(/\{[^}]*\}/g, ' ');
        let flat = '', d = 0;
        for (const ch of t) {
          if (ch === '(') d++;
          else if (ch === ')') d = Math.max(0, d - 1);
          else if (!d) flat += ch;
        }
        return flat.replace(/\[[^\]]*\]/g, ' ').split(/\s+/)
          .filter((s) => s && !/^\d+\.+$/.test(s) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(s) && !/^\$\d+$/.test(s))
          .map((s) => s.replace(/[?!]+$/, '')).filter((s) => /^[KQRBNOa-h]/.test(s));
      };
      const games = [
        movesOf('1. f3 e5 2. g4 Qh4#'),
        movesOf('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#'),
        movesOf(`1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5
          6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5
          11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6
          15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8#`),
        movesOf(fs.readFileSync(path.join(__dirname, 'public', 'samples', 'sample1.pgn'), 'utf8')),
      ];
      const BAD = [
        [/★ (补了保护|失去了保护)：王 /, '王被补了保护'],
        [/能护住自己的子：[^\n]*王 [a-h][1-8]/, '"能护住自己的子"里有王'],
        [/没人保护的子：[^\n]*王 [a-h][1-8]/, '"没人保护的子"里有王'],
        [/王 [a-h][1-8] 被 [^\n]*盯着，而它后面/, '把王当成了牵制线里挡在前面的那个子'],
      ];
      let seen = 0;
      const bad = [];
      for (const sans of games) {
        const g = new Chess();
        const fens = [g.fen()];
        const done = [];
        for (const s of sans) { try { g.move(s); } catch { break; } done.push(s); fens.push(g.fen()); }
        for (let ply = 1; ply < fens.length; ply++) {
          let u;
          try {
            u = buildExplainPrompt({
              fen: fens[ply], beforeFen: fens[ply - 1], ply, san: done[ply - 1],
              color: ply % 2 ? 'w' : 'b',
            }).messages[1].content;
          } catch { continue; }
          seen++;
          for (const [re, label] of BAD) if (re.test(u)) bad.push(ply + ':' + done[ply - 1] + ' → ' + label);
        }
      }
      check('★★ 四盘样本棋逐局面扫一遍：材料里从来没有"王被守/王被补保护"这种行',
        seen >= 60 && bad.length === 0, seen + ' 个局面，' + (bad.join(' | ') || '没有命中'));
    }

    // ---- 第八版之三：材料的标签和守卫句（用户报的"给 g1 的王补上了保护"）----
    // 那一盘是用户另外给的：白方第 10 手短易位。
    const OO_AFTER = '2kr1bnr/ppp1pppp/2n5/3P4/2P5/4BB2/Pq3PPP/RN1Q1RK1 b - - 1 10';
    const OO_BEFORE = '2kr1bnr/ppp1pppp/2n5/3P4/2P5/4BB2/Pq3PPP/RN1QK2R w KQ - 0 10';
    const oOut = buildExplainPrompt({
      fen: OO_AFTER, beforeFen: OO_BEFORE, ply: 19, san: 'O-O', color: 'w',
    }).messages[1].content;
    check('★★ 标签让主语显形（"它护着这些子"），不再用会被读反的"能护住自己的子"',
      /它护着这些子（对方吃它们时，它能吃回来）：兵 f2/.test(oOut),
      (oOut.match(/· 它护着这些子[^\n]*/) || [''])[0]);
    check('  那一行不再有"g2、h2、车 f1"这种对方根本吃不到的对象',
      !/它护着这些子[^\n]*g2/.test(oOut) && !/它护着这些子[^\n]*f1/.test(oOut));
    check('★★ 守卫句把整块兜住，并点破方向',
      /上面就是全部，一个不漏/.test(oOut) && /都是"这只子能对别人做什么"/.test(oOut));

    // ---- 第八版之五：王吃不了紧挨着它的、被保护的子（样例三 · 50.Kh5）----
    // 用户报的：材料只写了"能落到的空格：g6、h4、g4"，紧挨着王的 h6 兵一个字没提
    //（它被 g7 的兵守着，吃上去等于送将，所以不在合法着法里）——
    // 模型于是补了一句"白王就能 Kxh6 吃掉 h6 的兵，进而再 Kxg5"。
    // 和"d2 的后盯住了 d6"同源：**看着能做的事，材料沉默，它就替你做了。**
    const KH5_AFTER = '8/6p1/4p2p/1k1p3K/3P4/5P1P/1P4P1/8 b - - 1 50';
    const KH5_BEFORE = '8/6p1/4p2p/1k1p4/3P2K1/5P1P/1P4P1/8 w - - 0 50';

    const kh5Map = P.pieceMap(KH5_AFTER, 'h5');
    check('★★ 王 h5 的"吃不了"里写着 h6 的兵，连谁守着都写了',
      (kh5Map.blockedCaptures || []).some((x) =>
        x.square === 'h6' && x.byKing && x.guards.some((g) => g.square === 'g7')),
      JSON.stringify(kh5Map.blockedCaptures));
    check('  它没有把 h6 混进"能吃到对方的子"里（规则上王吃不了）',
      !kh5Map.attacks.some((x) => x.square === 'h6'));

    const kh5Out = buildExplainPrompt({
      fen: KH5_AFTER, beforeFen: KH5_BEFORE, ply: 99, san: 'Kh5', color: 'w',
    }).messages[1].content;
    check('★★ 材料里出现了"它吃不了的对方子：兵 h6（那一格被 g7 的兵守着）"',
      /它\*\*吃不了\*\*的对方子[\s\S]{0,40}兵 h6（那一格被 g7 的兵守着/.test(kh5Out),
      (kh5Out.match(/· ★ 它\*\*吃不了\*\*[^\n]*/) || [''])[0]);
    check('★ 守卫句点明了"能吃那一行没提到的子就是吃不了"',
      /"能吃到对方的子"里没提到的子，就是\*\*吃不了\*\*/.test(kh5Out));
    check('★ 系统提示词里明令不许说某只王能吃掉某个子（除非写在"能吃到"那一行里）',
      /不许说某只王（或任何子）能吃掉某个子，除非它就写在"能吃到对方的子"那一行里/.test(
        buildExplainPrompt({ fen: KH5_AFTER, ply: 99, san: 'Kh5', color: 'w' }).messages[0].content));
    // 不该到处冒出来：只有"够得着却吃不了"时才写这一行
    check('  别的局面不会长出这一行（样例一的 Qd2 就没有）',
      !/吃不了\*\*的对方子/.test(buildExplainPrompt({
        fen: 'r3kb1r/p3pppp/p1p2n2/q2p1b2/3P1B2/1PN1P3/P1PQ1PPP/R3K1NR b KQkq - 2 9',
        beforeFen: 'r3kb1r/p3pppp/p1p2n2/q2p1b2/3P1B2/1PN1P3/P1P2PPP/R2QK1NR w KQkq - 1 9',
        ply: 17, san: 'Qd2', color: 'w',
      }).messages[1].content));

    // ---- 第九版：拿"另一条路"做对照（哪怕他走的就是引擎首选）----
    // 用户报的这盘棋里，引擎首选本来就是 O-O；真正该讲清楚的对照是
    // "另一条路 Nd2 会让 d1 的后守住 a1" —— 也就是这一步放弃了什么。
    const oContrast = buildExplainPrompt({
      fen: OO_AFTER, beforeFen: OO_BEFORE, ply: 19, san: 'O-O', color: 'w',
      engineBefore: {
        scoreCp: 343, bestMoveSan: 'O-O',
        alternatives: [
          { rank: 1, firstMoveSan: 'O-O', scoreCp: 343 },
          { rank: 2, firstMoveSan: 'Nd2', scoreCp: 327 },
        ],
      },
    }).messages[1].content;
    check('★★ 他走的就是首选时，照样给"另一条路"的保护对照',
      /【另一条路（Nd2）会改变谁的保护/.test(oContrast));
    check('★★ 而且点出了那个关键事实：Nd2 之后 d1 的后才守得到 a1',
      /车 a1[\s\S]{0,80}现在多了 d1 的后/.test(oContrast),
      (oContrast.match(/· ★ 多了一个保护者[^\n]*/) || [''])[0]);
    check('  走的那条在候选表里就地标了出来（别的那条不标）',
      /O-O（[^）]*）[\s\S]{0,80}← \*\*他实际走的就是这一条\*\*/.test(oContrast) &&
      !/Nd2（[^）]*）[\s\S]{0,80}← \*\*他实际走的就是这一条\*\*/.test(oContrast));

    // ---- 第十版：没分量的"保护变化"不再喂给模型 ----
    // 用户抓到的第三种空话：材料说"易位给 f2 的兵多添了一层保护" ——
    // 可 f2 本来就有象和王两个子守着，黑方只有一个后在打它，多一个车守着毫无影响。
    // 现在只报**这一步之前守得不够**（守它的子 ≤ 打它的子 - 1）或者只守着一个子的情形。
    const dOO = P.protectionDelta({ beforeFen: OO_BEFORE, fen: OO_AFTER, color: 'w', from: 'e1', to: 'g1' });
    check('★★ 守得好好的子，不再报"多了一个保护者"（f2 本来就有两个子守着）',
      ![...dOO.gained, ...dOO.opened].some((x) => x.square === 'f2'),
      JSON.stringify([...dOO.gained, ...dOO.opened].map((x) => x.square)));
    check('★★ 但"本来没人守/只守着一个"的照样报（Nd2 给 a1 补上 d1 的后）',
      P.protectionDelta({
        beforeFen: OO_BEFORE,
        fen: '2kr1bnr/ppp1pppp/2n5/3P4/2P5/4BB2/Pq1N1PPP/R2QK2R b KQ - 1 10',
        color: 'w', from: 'b1', to: 'd2',
      }).opened.some((x) => x.square === 'a1'));
    check('★★ Kd8 那两条（1 守 1 攻 → 王来补厚 / 王走开没人守）也没被误杀',
      P.protectionDelta({
        beforeFen: '2r1k2r/p1bn1ppp/p1R1p3/3pN3/1P1Pb3/P3P3/5PPP/2R3K1 b k - 4 19',
        fen: '2rk3r/p1bn1ppp/p1R1p3/3pN3/1P1Pb3/P3P3/5PPP/2R3K1 w - - 5 20',
        color: 'b', from: 'e8', to: 'd8',
      }).gained.some((x) => x.square === 'c7') &&
      P.protectionDelta({
        beforeFen: '2r1k2r/p1bn1ppp/p1R1p3/3pN3/1P1Pb3/P3P3/5PPP/2R3K1 b k - 4 19',
        fen: '2rk3r/p1bn1ppp/p1R1p3/3pN3/1P1Pb3/P3P3/5PPP/2R3K1 w - - 5 20',
        color: 'b', from: 'e8', to: 'd8',
      }).lost.some((x) => x.square === 'f7'));

    // ---- 第十版之二：他没走首选、但这一步其实一样好时，材料必须明说 ----
    // 引擎在两个几乎同分的着法之间来回翻（实测同一局面会给出不同的第一名），
    // 于是"引擎建议的是 Nd2（这一步没有被走）"这种行会反复出现 ——
    // 光有它就够模型把一步好棋讲成败着了（用户报的正是这个）。
    const oClose = buildExplainPrompt({
      fen: OO_AFTER, beforeFen: OO_BEFORE, ply: 19, san: 'O-O', color: 'w',
      engineBefore: {
        scoreCp: 343, bestMoveSan: 'Nd2',
        alternatives: [
          { rank: 1, firstMoveSan: 'Nd2', scoreCp: 343 },
          { rank: 2, firstMoveSan: 'Qb3', scoreCp: 129 },
        ],
      },
      // 走 O-O 比走首选只差 0.05 个兵
      swing: normalizeSwing({ beforeCp: 343, beforeMate: null, afterCp: 338, afterMate: null }, 'w'),
    }).messages[1].content;
    check('★★ 材料会明说"这一步和首选几乎一样好"，并禁止讲成漏着',
      /★ 注意：引擎的首选虽然不是这一步，但\*\*这一步和首选几乎一样好\*\*/.test(oClose) &&
      /只差约 0\.05 个兵/.test(oClose) &&
      /不许\*\*把它讲成漏着/.test(oClose),
      (oClose.match(/★ 注意：[^\n]*/) || [''])[0].slice(0, 80));
    check('★★ 对照块里也改成了"这只是取舍"（默认就是中性措辞）',
      /这只是\*\*取舍\*\*/.test(oClose) &&
      /但\*\*这一步并不比它差\*\*/.test(oClose),
      (oClose.match(/  （另一条路做了上面这件事[^\n]*/) || [''])[0].slice(0, 70));
    check('  差得远的时候（>0.20 个兵）仍然照实说"没有做上面这件事"',
      /⚠️ 他实际走的 O-O \*\*没有\*\*做上面这件事/.test(buildExplainPrompt({
        fen: OO_AFTER, beforeFen: OO_BEFORE, ply: 19, san: 'O-O', color: 'w',
        engineBefore: {
          scoreCp: 343, bestMoveSan: 'Nd2',
          alternatives: [{ rank: 1, firstMoveSan: 'Nd2', scoreCp: 343 }],
        },
        swing: normalizeSwing({ beforeCp: 343, beforeMate: null, afterCp: 200, afterMate: null }, 'w'),
      }).messages[1].content));
    check('★ 系统提示词里写下了总原则：没分量的话不说，讲不出就留白',
      /没分量的话不要说/.test(buildExplainPrompt({ fen: OO_AFTER, ply: 19, san: 'O-O', color: 'w' })
        .messages[0].content) &&
      /留白比编一个理由强/.test(buildExplainPrompt({ fen: OO_AFTER, ply: 19, san: 'O-O', color: 'w' })
        .messages[0].content));

    // ---- 第八版之四：两步之后会怎样（叉子这类组合）----
    // 引擎 PV：Nxf7+（白）Ke7（黑）—— 这两步走完，白方就能吃 h8 的车。
    // 在此之前，材料里只有一条 PV 的文字，没有任何"叉子"的实体。
    const fu = P.followUp(KD8_AFTER, ['Nxf7+', 'Ke7', 'Nxh8', 'Bd3']);
    check('★★ followUp 把两步重放出来（第 1 步、对方几个合法着法、第 2 步）',
      !!fu && fu.first === 'Nxf7+' && fu.reply === 'Ke7' && fu.replyCount === 2,
      JSON.stringify(fu && { first: fu.first, n: fu.replyCount, reply: fu.reply }));
    check('★★ 并且算出"这两步之后白方能吃 h8 的车"（叉子的实体）',
      !!fu && !!fu.menu && fu.menu.list[0] && fu.menu.list[0].san === 'Nxh8' &&
      fu.menu.list[0].recaptureBy.some((r) => r.square === 'c8'),
      JSON.stringify(fu && fu.menu && fu.menu.list[0]));
    check('  走不出来的 PV 老实返回 null（不编）',
      P.followUp(KD8_AFTER, ['Qh9']) === null && P.followUp(null, ['e4']) === null);

    const twoOut = buildExplainPrompt({
      fen: KD8_AFTER, ply: 38, san: 'Kd8', color: 'b',
      engine: { scoreCp: 141, bestMoveSan: 'Nxf7+', pvSan: ['Nxf7+', 'Ke7', 'Nxh8'] },
    }).messages[1].content;
    check('★★ 单子里给了【顺着引擎那条线走两步】那一段',
      /【顺着引擎那条线走两步/.test(twoOut));
    check('★★ 里面写着 Nxf7+、对方 2 个合法着法、Ke7、以及"他能吃 h8 的车"',
      /第 \[1\] 步（就是现在能走的）：Nxf7\+/.test(twoOut) &&
      /对方这时一共有 2 个合法着法/.test(twoOut) &&
      /第 \[2\] 步（引擎选的应手）：Ke7/.test(twoOut) &&
      /他能吃 h8 的车/.test(twoOut),
      (twoOut.match(/· 这两步走完[^\n]*/) || [''])[0]);
    check('★ 系统提示词里也写了"N>1 时第 [2] 步不是必走"',
      /N>1 时第 \[2\] 步只是引擎挑的一个应手/.test(
        buildExplainPrompt({ fen: KD8_AFTER, ply: 38, san: 'Kd8', color: 'b' }).messages[0].content));
    check('  没有 PV 时整段不出现（不占篇幅）',
      !/【顺着引擎那条线走两步/.test(buildExplainPrompt({
        fen: KD8_AFTER, ply: 38, san: 'Kd8', color: 'b',
        engine: { scoreCp: 141, bestMoveSan: 'Nxf7+' },
      }).messages[1].content));

    // ---- 第九版：多轮记忆（方法 B —— 模型自己写一行【要点】，前端收起来下次带上）----
    const withRecap = buildExplainPrompt({
      fen: KD8_AFTER, beforeFen: KD8_BEFORE, ply: 38, san: 'Kd8', color: 'b',
      recap: [
        { ply: 35, san: 'Ne5', text: 'e5 的马盯上了 f7 那个没人管的兵' },
        { ply: 37, san: 'Rac1', text: '车压到 c6，c7 的象被盯上了' },
      ],
    }).messages[1].content;
    check('★★ 单子里给了"这盘棋之前几手讲过什么"',
      /【这盘棋之前几手讲过什么/.test(withRecap));
    check('★★ 里面每一句都带着步数和着法，而且写明"只是提醒、不要照抄"',
      /第 18 回合 Ne5：e5 的马盯上了 f7 那个没人管的兵/.test(withRecap) &&
      /不要照抄/.test(withRecap) && /以材料为准/.test(withRecap),
      (withRecap.match(/- 第 18 回合[^\n]*/) || [''])[0]);
    check('  没给 recap 时整段不出现（不占篇幅）',
      !/【这盘棋之前几手讲过什么/.test(buildExplainPrompt({
        fen: KD8_AFTER, ply: 38, san: 'Kd8', color: 'b',
      }).messages[1].content));
    check('  脏数据进来也不崩（只留能用的那几条）',
      buildExplainPrompt({
        fen: KD8_AFTER, ply: 38, san: 'Kd8', color: 'b',
        recap: [null, { text: '' }, { ply: 'x', san: '!!!', text: '   ' }, { ply: 3, san: 'e4', text: 'ok' }],
      }).messages[1].content.includes('ok'));
    check('★ 系统提示词里要求正文末尾多写一行【要点】（30 字以内）',
      /`【要点】`/.test(buildExplainPrompt({ fen: KD8_AFTER, ply: 38, san: 'Kd8', color: 'b' })
        .messages[0].content));

    // ---- 顺带：没意义的"线关系"不该占篇幅 ----
    // 原来会输出"黑方的象 c7 盯着 白方的马 e5，后面是白方的兵 h2" —— 后面那个子更便宜，
    // 这条线没有任何战术含义。
    check('★ 后面那个子不比前面值钱的"线关系"被过滤掉了',
      !P.lineTactics(KD8_AFTER, 'w').some((x) => x.square === 'e5' && x.behind === 'h2'),
      JSON.stringify(P.lineTactics(KD8_AFTER, 'w')));
    check('  该留的还留着（c6 的车 → c7 的象 → c8 的车）',
      P.lineTactics(KD8_AFTER, 'b').some((x) => x.square === 'c7' && x.behind === 'c8'));
  }

  {
    // ---------- 前后局面"对得上"这件事 ----------
    check('★ 局面核对：棋盘一样就算一样（记账的那两位不管）',
      P.samePosition('8/8/8/8/8/8/8/K6k w - - 0 1', '8/8/8/8/8/8/8/K6k w - - 9 40') === true);
    check('  轮到谁走不一样，就是不一样',
      P.samePosition('8/8/8/8/8/8/8/K6k w - - 0 1', '8/8/8/8/8/8/8/K6k b - - 0 1') === false);
    check('  给空值不崩', P.samePosition(null, SCH_AFT) === false);
  }

  {
    // ---------- 候选之间的差距 = 是不是"唯一解" ----------
    const eq = P.choiceVerdict([{ scoreCp: 20 }, { scoreCp: 10 }], 'w');
    check('★ 两条候选差 0.10 → 这个局面有好几条路', eq.kind === 'equal', eq.kind);
    check('  差 0.35 → 略好一点', P.choiceVerdict([{ scoreCp: 35 }, { scoreCp: 0 }], 'w').kind === 'slight');
    check('  差 1.00 → 明显更好', P.choiceVerdict([{ scoreCp: 100 }, { scoreCp: 0 }], 'w').kind === 'clear');
    check('★ 差 3.00 → 这才是"唯一能撑住的一步"',
      P.choiceVerdict([{ scoreCp: 300 }, { scoreCp: 0 }], 'w').kind === 'only');
    check('  黑方走的时候要翻过来算（同一份评分，视角反过来）',
      P.choiceVerdict([{ scoreCp: -300 }, { scoreCp: 0 }], 'b').kind === 'only');
    check('  首选就是杀棋 → 单独归一类', P.choiceVerdict([{ scoreMate: 2 }, { scoreCp: -100 }], 'w').kind === 'mate');
    check('  只有一条候选 → 老实说不知道', P.choiceVerdict([{ scoreCp: 20 }], 'w').kind === 'unknown');
    check('  两条都没分 → 也不知道', P.choiceVerdict([{ scoreCp: null }, { scoreCp: null }], 'w').kind === 'unknown');
    check('  将杀分比任何普通分都大（不然没法排序）',
      P.comparableScore(null, 3) > P.comparableScore(2000, null));
  }

  {
    // ---------- 候选表怎么拼 ----------
    const list = candidatesOf({
      scoreCp: 10, scoreMate: null, bestMoveSan: 'Nf3',
      pvSan: ['Nf3'],
      alternatives: [
        { rank: 2, firstMoveSan: 'Nc3', scoreCp: 5 },
        { rank: 3, firstMoveSan: 'Nf3', scoreCp: 3 },      // 和首选重复，该被丢掉
        { rank: 4, scoreCp: -50 },                          // 没着法名，该被丢掉
      ],
    });
    check('候选表：主变化排第一，重复的丢掉，没着法名的也丢掉',
      list.length === 2 && list[0].firstMoveSan === 'Nf3' && list[1].firstMoveSan === 'Nc3',
      list.map((c) => c.firstMoveSan).join(','));
    check('  最多只留三条',
      candidatesOf({
        scoreCp: 1, bestMoveSan: 'a3',
        alternatives: [{ firstMoveSan: 'b3' }, { firstMoveSan: 'c3' }, { firstMoveSan: 'd3' }],
      }).length === 3);
    check('  没有引擎数据 → 空表（不编）', candidatesOf(null).length === 0);
  }

  {
    // ---------- 拼出来的单子长什么样 ----------
    const { messages, meta } = buildExplainPrompt({
      fen: SCH_AFT, beforeFen: SCH_BEF, ply: 6, san: 'Nf6', color: 'b',
      engine: SCH_AFT_ENG, engineBefore: SCH_BEF_ENG,
      swing: normalizeSwing({ beforeCp: -17, beforeMate: null, afterCp: null, afterMate: 1 }, 'b'),
      opening: ['e4', 'e5', 'Bc4', 'Nc6'], history: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5'],
    });
    const usr = messages[1].content;

    check('★★ 走之前那个局面也给了（模型不用再倒着走一步）',
      usr.includes(SCH_BEF), (usr.match(/走这一步\*\*之前\*\*[^\n]*/) || [''])[0].slice(0, 60));
    check('★★ 走之后那个局面也给了', usr.includes(SCH_AFT));
    check('  FEN 的六个字段还顺手解释了一句（省得它猜）',
      /FEN 六个字段/.test(usr));
    check('★★ 这一步实际干了什么，写成了陈述句（只写发生过的事）',
      /马 从 g8 走到 f6/.test(usr) && !/没有吃子|没有将军/.test(usr) &&
      /安静的一步/.test(usr),
      (usr.match(/这一步实际发生的事[^\n]*/) || [''])[0]);

    // ⚠️ 这一条是"去掉空话"那个改动的锁：
    //    以前这里会拼出"没有吃子；没有将军"这种否定清单，用户原话是
    //    "不要出现什么'这步没有将军，没有吃子'这种空话"。
    //    现在什么都不沾的时候只说一句"安静的一步"（给它一个概念，而不是一串否定）。
    check('★★ 不是"没有吃子、没有将军"那种否定清单',
      !/没有吃子/.test(usr) && !/没有将军/.test(usr) && Boolean(usr), '');
    check('  但"安静的一步"这个说法在（模型能顺着它讲这步在准备什么）',
      /安静的一步/.test(usr));

    // 真有吃子的时候，要如实说吃了什么
    const capUsr = buildExplainPrompt({
      fen: 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2',
      beforeFen: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      ply: 2, san: 'exd5', color: 'w',
      engine: { scoreCp: 20, scoreMate: null, bestMoveSan: 'Nf3', pvSan: ['Nf3'] },
    }).messages[1].content;
    check('  吃子时如实说吃了什么', /吃掉了对方一个兵/.test(capUsr),
      (capUsr.match(/这一步实际发生的事[^\n]*/) || [''])[0]);
    check('  吃子时也不会再多说一句"没有将军"', !/没有将军/.test(capUsr));
    check('  还说清了它当时有多少个着法可选', /28 个合法着法/.test(usr));

    check('★★ 给了"走这一步之前"那个局面的候选（前三条）',
      /① g6/.test(usr) && /② Qe7/.test(usr) && /③ Qf6/.test(usr));
    check('★★ 候选之间的差距被翻译成人话（回答问题：是不是唯一解）',
      /首选和次选几乎一样好|首选比次选略好/.test(usr),
      (usr.match(/→ 首选和次选[^\n]*|→ 首选比次选[^\n]*/) || [''])[0]);
    check('★★ 还说了他走的那一步排在第几（不在候选里就直说）',
      /不在\*\*上面这几条里|不在这/.test(usr),
      (usr.match(/→ 他实际走的[^\n]*/) || [''])[0]);

    check('★★ 主变化是一步步给的：每一步后面都跟着走完那一步的局面',
      (usr.match(/ → {2}/g) || []).length >= 4,
      (usr.match(/ → {2}/g) || []).length + ' 行');
    check('★★ 次优解也各自给了一段后续', /如果走次选 Qe7/.test(usr) && /如果走次选 Qf6/.test(usr));
    check('  走完之后那个局面同样有候选（②③ 说明别的着法都输）',
      /① Qxf7#/.test(usr) && /② Qd1/.test(usr) && /③ Qg5/.test(usr));

    // 【最硬的一条】把提示词里所有"某步 → 某局面"的 FEN 抓出来，逐个解析。
    // 拼错一个字段、多一个空格，这里就会挂 —— 而这正是模型最容易读错的地方。
    const fenRe = /→ {2}(\S+ \S+ \S+ \S+ \S+ \S+)/g;
    const found = [];
    let m;
    while ((m = fenRe.exec(usr))) found.push(m[1]);
    check('★ 提示词里的每个逐步局面都是合法的 FEN（' + found.length + ' 个）',
      found.length >= 6 && found.every((f) => {
        try { new Chess(f); return true; } catch { return false; }
      }),
      found.length + ' 个');

    check('★ 这一段的知识库明确标了"不是对这盘棋的判断"',
      /【战术参考/.test(usr) && /不是对这盘棋的判断/.test(usr));
    check('  也明说了对不上就别硬套', /对不上就别硬套/.test(usr));
    check('  这个局面（有杀棋、王没易位）配到了战术母题',
      meta.knowledge.motifs.length > 0, meta.knowledge.motifs.join('、'));
    check('  还配到了经典对局样例', meta.knowledge.games.length > 0, meta.knowledge.games.join('、'));
    check('  样例里带着那几步关键着法（供类比）',
      /Nxb5|Qd8\+|Bf5\+|Nxe5|Be6/.test(usr));

    check('  提问还是照常问"问题出在哪里"', /问题出在哪里/.test(usr));
    check('  并且要求它结合"本该走的那一步"', /为什么更好/.test(usr));

    // ---------- meta ----------
    check('★★ meta 标出"前后局面核对通过"', meta.moveVerified === true);
    check('  也标出了这次带了多路线', meta.hasAlternatives === true);
    check('  没被逼着走就说不是被迫的', meta.isForced === false);
    check('  他走的不是引擎首选，也如实标出', meta.playedIsTop === false);
    check('  真拿到了引擎结论 → hasEngineData 为真', meta.hasEngineData === true);

    // ★ 回归：hasEngineData 不能用 `engine.scoreCp !== undefined` 判断 ——
    //   前端固定会带上这个键，值可能是 null（引擎对这个局面没给出分数），
    //   那样写会恒为 true，"有没有引擎数据"这个账就永远是"有"。
    const noEng = buildExplainPrompt({
      fen: SCH_AFT,
      engine: { scoreCp: null, scoreMate: null, bestMoveSan: null, pvSan: [] },
    });
    check('★ 分数和着法都是空的 → hasEngineData 是 false（不是"键在就算有"）',
      noEng.meta.hasEngineData === false);
  }

  {
    // ---------- 「再往前一手」那一层：意图推理的起点 ----------
    // 用户要的是"先判断对手上一步想干什么，再推理我方怎么应对"。
    // 那一步改了什么，只能从"它走之前的局面"和"它走之后的局面"的差别里读出来 ——
    // 所以这一层必须真的进提示词，而且要按时间顺序排好、带上是哪一方走的。
    const PREV = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3';  // 3.Qh5 之前
    const { messages, meta } = buildExplainPrompt({
      fen: SCH_AFT, beforeFen: SCH_BEF, prevFen: PREV, prevSan: 'Qh5',
      ply: 6, san: 'Nf6', color: 'b',
      engine: SCH_AFT_ENG, engineBefore: SCH_BEF_ENG,
    });
    const usr = messages[1].content;
    check('★★ 提示词里带了「再往前一手」的局面', usr.includes(PREV), (usr.match(/① [^\n]*/) || [''])[0].slice(0, 50));
    check('  也带了那一手走的是什么 + 起止格锚点',
      /白方走了 Qh5（后 d1→h5）/.test(usr),
      (usr.match(/白方走了 Qh5[^\n]*/) || [''])[0]);
    check('★★ 三个局面按时间顺序排好、标了编号',
      /【局面（按时间顺序，最后一行是现在）】/.test(usr) &&
      /① 再往前一手/.test(usr) && /② 走这一步\*\*之前\*\*/.test(usr) && /③ 现在/.test(usr));
    check('  每个局面都写明了轮到谁走', (usr.match(/轮到[黑白]方走/g) || []).length >= 3);
    check('  meta 标出这次给了"再往前一手"', meta.hasPrev === true);
  }

  {
    // ---------- 没给 prevFen 时不许凭空出现那一层 ----------
    const { messages, meta } = buildExplainPrompt({
      fen: SCH_AFT, beforeFen: SCH_BEF, ply: 6, san: 'Nf6', color: 'b',
      engine: SCH_AFT_ENG, engineBefore: SCH_BEF_ENG,
    });
    const usr = messages[1].content;
    check('  没有 prevFen → 不出现"再往前一手"那一行（不编一层出来）',
      !/再往前一手/.test(usr) && meta.hasPrev === false);
    check('  编号也跟着退化成 ①②', /① 走这一步\*\*之前\*\*/.test(usr) && /② 现在/.test(usr));
  }

  {
    // ---------- 没被核对的 beforeFen：所有依赖它的事实一律不许出现 ----------
    // 这是"不盲信前端"的具体体现：送错了宁可少讲，不能拿别人的局面讲一整套。
    const { messages, meta } = buildExplainPrompt({
      fen: SCH_AFT,
      beforeFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',  // 送错了
      ply: 6, san: 'Nf6', color: 'b',
      engine: SCH_AFT_ENG, engineBefore: SCH_BEF_ENG,
    });
    const usr = messages[1].content;
    check('★★ beforeFen 对不上 → 不说"这一步实际发生了什么"',
      !/这一步实际发生的事/.test(usr));
    check('  也不说"他有多少个合法着法"', !/合法着法可选|只有 . 个合法着法/.test(usr));
    check('  但引擎给的数据照旧用（那些不依赖 beforeFen）',
      usr.includes(SCH_AFT) && /① Qxf7#/.test(usr));
    check('  meta 如实标出没核对上', meta.moveVerified === false);
  }

  {
    // ---------- 他走的正好是引擎首选：不能反过来去挑毛病 ----------
    const { messages, meta } = buildExplainPrompt({
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      beforeFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      ply: 2, san: 'e5', color: 'b',
      engine: { scoreCp: 25, bestMoveSan: 'Nf3', pvSan: ['Nf3'] },
      engineBefore: {
        scoreCp: 20, bestMoveSan: 'e5', depth: 16, pvSan: ['e5', 'Nf3', 'Nc6'],
        alternatives: [
          { rank: 2, firstMoveSan: 'd5', scoreCp: 10, pvSan: ['d5', 'exd5'] },
          { rank: 3, firstMoveSan: 'd6', scoreCp: 5, pvSan: ['d6', 'd4'] },
        ],
      },
      swing: normalizeSwing({ beforeCp: 20, afterCp: 25 }, 'b'),
    });
    const usr = messages[1].content;
    check('★★ 走的正是首选 → 明说"这一步本身没有问题"',
      /这一步本身没有问题/.test(usr));
    check('  还告诉他"这个局面不止一条路"（这次确实不止）',
      /不存在"唯一解"/.test(usr),
      (usr.match(/→ 首选和次选[^\n]*/) || [''])[0]);
    check('  提问改成"它好在哪里"，不问"问题出在哪里"',
      /它好在哪里/.test(usr) && !/问题出在哪里/.test(usr));
    check('  meta 标出"走的正是首选"', meta.playedIsTop === true);
  }

  {
    // ---------- 「不得已只能这样走」的两条路：算式说"唯一"，规则说"只有一步" ----------

    // (1) 规则：这个局面只有 1 个合法着法
    const { messages } = buildExplainPrompt({
      fen: '7k/8/8/8/8/8/6K1/8 b - - 0 1',           // 走完之后：黑王对白王
      beforeFen: '7k/8/8/8/8/8/6q1/7K w - - 0 1',     // 走之前：白方被将，合法的只有 Kxg2
      ply: 2, san: 'Kxg2', color: 'w',
      engine: { scoreCp: 0, bestMoveSan: 'Kg8', pvSan: ['Kg8'] },
    });
    const usr = messages[1].content;
    check('★★ 只有一步合法着法 → 明说这是字面意义上的"不得已"',
      /只有 1 个合法着法/.test(usr) && /只能这样走/.test(usr),
      (usr.match(/★ 这个局面他只有[^\n]*/) || [''])[0]);
    check('★★ 这种局面下不问"问题出在哪里"（问了就是无的放矢）',
      !/问题出在哪里/.test(usr));
    check('  改成问"是怎么被逼到这一步的"', /被逼到这一步|怎么被逼到这里/.test(usr));
  }

  {
    // (2) 算式：候选之间的差距很大，而且他走的不是首选
    const { messages, meta } = buildExplainPrompt({
      fen: SCH_AFT, beforeFen: SCH_BEF, ply: 6, san: 'Nf6', color: 'b',
      // 注意符号：评分是白方视角，而这一步是黑方走。
      // 黑方要"差 3 个兵"，白方视角就得**多 3 个兵**（-0.17 → +2.83）。
      engineBefore: {
        scoreCp: -17, bestMoveSan: 'g6', depth: 16, pvSan: ['g6', 'Qf3'],
        alternatives: [
          { rank: 2, firstMoveSan: 'Qe7', scoreCp: 283, pvSan: ['Qe7', 'd3'] },
        ],
      },
    });
    const usr = messages[1].content;
    check('★★ 候选差 3 个兵 → 说"这是唯一能撑住的一步"',
      /唯一能撑住的一步/.test(usr),
      (usr.match(/→ 首选比次选[^\n]*/) || [''])[0]);
    check('  而且提醒了"这通常说明局面本身已经很紧张"（不是他选错）',
      /不是他选择失误|局面本身/.test(usr));
    check('  meta 里也带着这一批选中的知识', !!meta.knowledge && Array.isArray(meta.knowledge.motifs));
  }

  {
    // ---------- 只有一条候选时，不许编出"还有别的选择" ----------
    const { messages, meta } = buildExplainPrompt({
      fen: SCH_AFT, beforeFen: SCH_BEF, ply: 6, san: 'Nf6', color: 'b',
      engine: { scoreCp: null, scoreMate: 1, scoreText: '+M1', bestMoveSan: 'Qxf7#', pvSan: ['Qxf7#'] },
      engineBefore: { scoreCp: -17, bestMoveSan: 'g6', depth: 16, pvSan: ['g6'] },
    });
    const usr = messages[1].content;
    check('★ 只有一条候选 → 不出现候选表', !/① g6/.test(usr));
    check('★ 也不说"不止一条路"（没有依据就别下这个结论）',
      !/不存在"唯一解"/.test(usr) && !/唯一能撑住的一步/.test(usr));
    check('  但明说了引擎这次只给了一条线', /只给了一条线/.test(usr));
    check('  主变化照旧一步步给', /黑方 g6/.test(usr));
    check('  meta 如实标出这次没有多路线', meta.hasAlternatives === false);
  }

  {
    // ---------- 将杀局面下"亏了多少"不再整行消失（原来是这么个洞） ----------
    // 旧实现只在前后**都是 cp 分**时才算得出差值，一旦某侧是 mate 就整段跳过 ——
    // 而"一步走成被将杀"恰恰全落在这一支上。
    const { messages } = buildExplainPrompt({
      fen: SCH_AFT, beforeFen: SCH_BEF, ply: 6, san: 'Nf6', color: 'b',
      engine: SCH_AFT_ENG, engineBefore: SCH_BEF_ENG,
      swing: normalizeSwing({ beforeCp: -17, beforeMate: null, afterCp: null, afterMate: 1 }, 'b'),
    });
    const usr = messages[1].content;
    check('★★ 前后一侧是将杀分时，不再整行静默消失',
      /→ 也就是说：/.test(usr),
      (usr.match(/→ 也就是说：[^\n]*/) || [''])[0].slice(0, 70));
    check('  改成定性的说法：从什么变成了什么',
      /由「/.test(usr) && /变成了/.test(usr));
    check('  并且明确要求它重点讲这一步是怎么发生的', /重点讲清楚/.test(usr));
  }

  {
    // ---------- 没有引擎数据时，知识库可以给，但绝不许出现数字 ----------
    const ko = K.buildKnowledge({ phase: 'opening' });
    check('★ 知识库文本里没有任何评分数字（它是纯知识）',
      !/评分/.test(ko.text) && !/[亏赚]了/.test(ko.text));
    check('  也没有 markdown 加粗残留（纯文本给模型看）', !/\*\*/.test(ko.text));
    check('  相似局面挑出来的东西是稳定的（可复现）',
      K.buildKnowledge({ phase: 'opening' }).motifs.join(',') === ko.motifs.join(','));
    check('  平淡局面少给一点，别用泛泛的信息稀释', K.buildKnowledge({}).motifs.length <= 2);
    check('  有具体特征的场面才把额度用足',
      K.buildKnowledge({ phase: 'middlegame', hasMate: true, isSacrifice: true }).motifs.length > 2);
  }

  {
    // ---------- ★ 回归：没有将杀的局面，不许附「关于杀棋」 ----------
    //
    // 这里踩过的坑很典型：判断"有没有将杀"时用了 hasScore()，
    // 而它的意思是"**cp 或 mate 有一个就算有**"（= 有没有分数）。
    // 于是只要引擎给了任何一个普通评分，就一路被当成"有将杀"，
    // 一段毫无杀棋的平淡开局也会被塞进杀棋套路和 mate 类母题。
    // 现在只看 mate 字段本身。
    const QUIET_BEF = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
    const QUIET_AFT = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
    const { messages, meta } = buildExplainPrompt({
      fen: QUIET_AFT, beforeFen: QUIET_BEF, ply: 5, san: 'Bb5', color: 'w',
      engine: { scoreCp: 20, scoreMate: null, bestMoveSan: 'a6', pvSan: ['a6', 'Bxc6', 'dxc6'] },
      engineBefore: {
        scoreCp: 15, bestMoveSan: 'e4', depth: 16, pvSan: ['e4', 'e5'],
        alternatives: [{ rank: 2, firstMoveSan: 'Nf3', scoreCp: 12, pvSan: ['Nf3'] }],
      },
      swing: normalizeSwing({ beforeCp: 15, afterCp: 20 }, 'w'),
    });
    const usr = messages[1].content;
    check('★★ 只有普通评分、没有将杀 → 不出现「关于杀棋」那一段',
      !/关于杀棋/.test(usr), (usr.match(/关于杀棋[^\n]*/) || [''])[0]);
    check('★★ 也不再由 mate 标签带进杀棋类母题（引入 / 双将 / 底线杀…）',
      !meta.knowledge.motifs.includes('引入') &&
      !meta.knowledge.motifs.includes('双将') &&
      !meta.knowledge.motifs.includes('底线杀'),
      meta.knowledge.motifs.join('、'));
    check('  知识预算不再被 mate 顶满（只剩这个局面真配得上的那两条）',
      meta.knowledge.motifs.length <= 2 && meta.knowledge.motifs.length >= 1,
      meta.knowledge.motifs.join('、'));
    check('  这个局面真正相关的知识照样给（不算一刀切砍掉）',
      meta.knowledge.motifs.includes('牵制'), meta.knowledge.motifs.join('、'));

    // 反方向：真有将杀时，那一段必须还在（别修成"永远不给"）
    const mate = buildExplainPrompt({
      fen: SCH_AFT, beforeFen: SCH_BEF, ply: 6, san: 'Nf6', color: 'b',
      engine: SCH_AFT_ENG, engineBefore: SCH_BEF_ENG,
      swing: normalizeSwing({ beforeCp: -17, beforeMate: null, afterCp: null, afterMate: 1 }, 'b'),
    });
    check('★ 真有将杀时，「关于杀棋」照旧会给（不是一刀切砍掉）',
      /关于杀棋/.test(mate.messages[1].content),
      mate.meta.knowledge.motifs.join('、'));
  }

  // ============================================================
  section('④ 端到端：真起服务器 + 假 DeepSeek（仍然不需要真密钥）');
  // ============================================================

  const FAKE_KEY = 'sk-fake-for-test-1234567890abcdef';
  const MOCK_PORT = await freePort();
  // ⚠️ 这两个端口要等真正把后端起起来之后才算数：
  //    freePort() 只是"探测此刻空闲"，探测完就把端口放掉了，
  //    到 startServer 真正绑上去之前有一小段窗口期，被别人抢走是可能的。
  //    Windows 上偶尔就会踩到，表现为"探活空等 20 秒"。
  //    遇到这种情况换一组端口重来即可（见下面 startPair），不该记成代码错。
  let PORT = 0;
  let PORT_NO_KEY = 0;

  // 这个"假 DeepSeek"长得和真的接口一模一样（OpenAI 兼容格式）。
  // 因此它验证的是真东西：请求真的发出来了、格式对不对、响应真的被解析了。
  let mockMode = 'ok';
  let mockHits = [];
  const mockServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      mockHits.push({
        url: req.url,
        method: req.method,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      });

      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (mockMode === 'ok') {
        send(200, {
          id: 'chatcmpl-mock', object: 'chat.completion', model: 'deepseek-chat',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '**这一步是败着。**\n\n- 你漏看了对手的牵制\n- 王翼因此露出破绽' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 210, completion_tokens: 140, total_tokens: 350 },
        });
      } else if (mockMode === '401') {
        send(401, { error: { message: 'Authentication Fails', type: 'authentication_error' } });
      } else {
        send(500, { error: { message: 'Internal Error' } });
      }
    });
  });

  await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));
  console.log('  假 DeepSeek 已在 127.0.0.1:' + MOCK_PORT + ' 上等着');

  /** 起一个后端，返回 { child, out } */
  function startServer(port, extraEnv) {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port),
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + MOCK_PORT,
        DEEPSEEK_MAX_RETRIES: '0',
        DEEPSEEK_TIMEOUT_MS: '8000',
      }, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const state = { child, out: '', err: '' };
    child.stdout.on('data', (d) => { state.out += d.toString(); });
    child.stderr.on('data', (d) => { state.err += d.toString(); });
    return state;
  }

  async function waitHealth(port, timeoutMs = 20000) {
    const t0 = Date.now();
    // 把"最后一次探活到底发生了什么"记下来。
    // 否则超时只会说一句"服务器没起来"，而真正的原因（连不上 / 端口被占 /
    // 回了个 500 / 回的不是 JSON）全被吞掉 —— 排查时只能靠猜。
    let last = '（一次都没发出去）';
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/api/health');
        if (r.ok) return await r.json();
        last = 'HTTP ' + r.status;
      } catch (e) {
        last = e.message + (e.cause && e.cause.code ? '（' + e.cause.code + '）' : '');
      }
      await sleep(200);
    }
    throw new Error('服务器在 ' + timeoutMs + 'ms 内没起来（端口 ' + port + '，最后一次探活：' + last + '）');
  }

  let serverA = null;        // 配了密钥那个
  let serverB = null;        // 故意不配那个
  let BASE = '';
  let BASE_NK = '';

  /** 起一对后端，并等它们都真的活过来 */
  async function startPair() {
    PORT = await freePort();
    PORT_NO_KEY = await freePort();
    serverA = startServer(PORT, { DEEPSEEK_API_KEY: FAKE_KEY });       // 配了密钥
    serverB = startServer(PORT_NO_KEY, { DEEPSEEK_API_KEY: '' });      // 故意不配
    BASE = 'http://127.0.0.1:' + PORT;
    BASE_NK = 'http://127.0.0.1:' + PORT_NO_KEY;
    await waitHealth(PORT, 15000);
    await waitHealth(PORT_NO_KEY, 15000);
  }

  async function killPair() {
    for (const s of [serverA, serverB]) {
      try { if (s) s.child.kill(); } catch { /* 已经退出了 */ }
    }
  }

  let startErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await startPair();
      startErr = null;
      break;
    } catch (err) {
      startErr = err;
      await killPair();
      if (attempt === 1) console.log('  ⚠️ 第一次起后端没成功（' + err.message + '），换一组端口重试…');
      await sleep(400);
    }
  }

  try {
    if (startErr) throw startErr;
    console.log('  两个后端都起来了：' + PORT + '（有密钥） / ' + PORT_NO_KEY + '（无密钥）');

    // ---------- 4.1 状态查询 ----------
    const health = await (await fetch(BASE + '/api/health')).json();
    check('/api/health 报告了讲棋可用', health.llm && health.llm.configured === true);
    check('  ★ health 响应里没有密钥', !JSON.stringify(health).includes(FAKE_KEY));

    const st = await (await fetch(BASE + '/api/llm')).json();
    check('/api/llm 报告已配置', st.ok === true && st.configured === true && st.available === true);
    check('  给出了模型名', st.model === 'deepseek-chat', st.model);
    check('★★ /api/llm 的响应里没有密钥', !JSON.stringify(st).includes(FAKE_KEY));
    check('  只给了打码预览', /\*{4}/.test(st.keyPreview || ''), st.keyPreview);
    check('  没让 probe 的时候不会去请求上游', mockHits.length === 0, mockHits.length + ' 次');

    // ---------- 4.2 probe：真去验一次密钥 ----------
    mockHits = [];
    const probed = await (await fetch(BASE + '/api/llm?probe=1')).json();
    check('probe 真的发了一次请求', mockHits.length === 1, mockHits.length + ' 次');
    check('  probe 的结果是成功', probed.probe && probed.probe.ok === true);
    check('  probe 很省（回复长度限制得很小）',
      mockHits[0].body.max_tokens <= 16, String(mockHits[0].body.max_tokens));
    check('  ★ probe 的 Authorization 头带的就是我们配的那个密钥',
      mockHits[0].auth === 'Bearer ' + FAKE_KEY);

    // ---------- 4.3 无密钥的服务器 ----------
    const nk = await (await fetch(BASE_NK + '/api/llm')).json();
    check('无密钥时 /api/llm 报告未配置', nk.configured === false && nk.available === false);
    check('  给出空白的打码预览', nk.keyPreview === '', JSON.stringify(nk.keyPreview));

    mockHits = [];
    const nkExplain = await fetch(BASE_NK + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({ fen: START_FEN }),
    });
    const nkBody = await nkExplain.json();
    check('★ 无密钥时讲棋返回 503', nkExplain.status === 503, String(nkExplain.status));
    check('  错误码是 no_key', nkBody.code === 'no_key', nkBody.code);
    check('  ★ 本地就拦下了，没去骚扰上游', mockHits.length === 0);
    check('  提示指向 .env', /\.env/.test(nkBody.hint || ''));

    // ---------- 4.4 讲棋：正常一次 ----------
    // 一盘真实的学者将杀：1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#
    // 黑方第 3 回合的 Nf6 是败着（第 6 个半回合），就让 DeepSeek 讲这一步。
    mockHits = [];
    const fen1 = fenAfter('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6');
    const r1 = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({
        fen: fen1,
        ply: 6, san: 'Nf6', color: 'b',
        // 走之前白方稍好（+0.60），走完之后白方大优（+6.00）—— 黑方亏了
        engine: { scoreCp: 600, scoreMate: null, scoreText: '+6.00', bestMoveSan: 'g6', pvSan: ['g6', 'Qf3'], depth: 14 },
        swing: { beforeCp: 60, afterCp: 600 },
        opening: ['e4', 'e5', 'Bc4', 'Nc6'],
        history: ['Bc4', 'Nc6'],
        annotation: '[%eval 6.00] 太快了',
      }),
    });
    const d1 = await r1.json();

    check('讲棋接口返回成功', r1.status === 200 && d1.ok === true, 'HTTP ' + r1.status);
    check('  拿回了讲解正文', /败着/.test(d1.text || ''), String(d1.text || '').slice(0, 20) + '…');
    check('  Markdown 原样带回（渲染是前端的事）', /\*\*/.test(d1.text || ''));
    check('★★ 响应里没有密钥', !JSON.stringify(d1).includes(FAKE_KEY));
    check('  带回了 token 用量', d1.usage && d1.usage.total_tokens === 350);
    check('  带回了耗时', typeof d1.elapsedMs === 'number' && d1.elapsedMs >= 0, d1.elapsedMs + 'ms');
    check('  meta 记录了这是第几步', d1.meta && d1.meta.ply === 6);

    // ---------- 4.5 上游到底收到了什么 ----------
    check('★ 上游只被打了一次', mockHits.length === 1, mockHits.length + ' 次');
    check('  请求打在 /chat/completions 上', mockHits[0].url === '/chat/completions', mockHits[0].url);
    check('  content-type 是 JSON', /application\/json/.test(mockHits[0].contentType || ''));
    check('  上游收到的是标准 OpenAI 格式',
      mockHits[0].body.model === 'deepseek-chat' && Array.isArray(mockHits[0].body.messages));

    const sysSent = mockHits[0].body.messages[0];
    const usrSent = mockHits[0].body.messages[1];
    check('★ 上游收到的是 system + user 两条', mockHits[0].body.messages.length === 2);
    check('  system 里带着"不许自己编数字"的规矩',
      /没给的着法、没给的数字/.test(sysSent.content));
    check('★★ 鳕鱼的评分真的传到了上游', /\+6\.00/.test(usrSent.content));
    check('★★ 后端替模型算好的"亏了多少"也传到了', /亏了约 5\.40/.test(usrSent.content),
      (usrSent.content.match(/[亏赚]了约 [\d.]+/) || [''])[0]);
    check('  棋谱原本的评注也传过去了', /太快了/.test(usrSent.content));
    check('★ 走棋方是谁判断对了（这一步是黑走的）', /黑方走了 Nf6/.test(usrSent.content),
      (usrSent.content.match(/第 \d+ 回合，[^\n]*/) || [''])[0]);
    check('  不在回合编号上出错（第 6 个半回合 = 第 3 回合）',
      /第 3 回合/.test(usrSent.content));

    // ---------- 4.6 坏局面要拦下来，别浪费钱 ----------
    mockHits = [];
    const bad = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({ fen: '这根本不是 FEN', ply: 3, san: 'e4' }),
    });
    const badBody = await bad.json();
    check('★ 坏局面返回 400', bad.status === 400, String(bad.status));
    check('  错误码是 bad_request', badBody.code === 'bad_request', badBody.code);
    check('★★ 坏局面时一次上游请求都没发（不花钱）', mockHits.length === 0, mockHits.length + ' 次');

    const noFen = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: jsonOf({}),
    });
    check('  完全没给 fen 也返回 400', noFen.status === 400, String(noFen.status));

    // ---------- 4.6b 局面不许被"截断"（这一节是补的 —— 真漏过一次） ----------
    //
    // 漏洞长这样：服务端给每个请求字段都设了长度上限，而 FEN 用了个默认值。
    //   开局 FEN 只有 56 字符，中局随便一个就 65~70 —— 于是中局以后的局面
    //   被静默切掉尾巴："...RNB1K1NR w KQkq - 4 4" → "...RNB1K1NR w KQk"。
    //   最阴的是 chess.js 对残缺 FEN **不报错**（缺的字段它自己补默认值），
    //   所以 `new Chess(切过的 FEN)` 照样构造成功，只是局面悄悄变了样。
    //   连锁反应：讲棋那边"把 beforeFen 走出 san 应该等于 fen"核对不上，
    //   于是整段"走这一步之前是什么局面"被当不可信丢掉，模型只拿到半个 FEN。
    //   全程没有任何一处抛错，日志也干干净净。
    //
    // ⚠️ 为什么原来 800 多条断言全绿却没发现：
    //    纯函数那一大批用例直接调 buildExplainPrompt，**绕过了服务端的字段清洗**；
    //    而端到端这边只用了 START_FEN，它正好比上限短。
    //    ——**测试数据比真实数据小，就测不出上限问题。**
    //    所以这一节专门拿真实长度的局面走完整 HTTP。
    const LONG_AFT = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4'; // 67
    const LONG_BEF = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';   // 65

    for (const f of [LONG_AFT, LONG_BEF, START_FEN]) {
      const r = await fetch(BASE + '/api/explain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: jsonOf({ fen: f, ply: 6, san: 'Nf6', color: 'b', dryRun: true }),
      });
      const b = await r.json();
      check('★★ 局面原样进了提示词，没被截断（' + f.length + ' 字符）',
        r.status === 200 && typeof b.user === 'string' && b.user.includes(f),
        r.status + ' / 提示词里有没有整条：' + (typeof b.user === 'string' && b.user.includes(f)));
    }

    // 前后两个局面都在、而且核对通过 —— 这正是被截断时最先塌掉的东西
    const rich = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({ fen: LONG_AFT, beforeFen: LONG_BEF, ply: 6, san: 'Nf6', color: 'b', dryRun: true }),
    });
    const richBody = await rich.json();
    check('★★ 走之前那个局面也进了提示词（截断时它会被整段丢掉）',
      typeof richBody.user === 'string' && richBody.user.includes(LONG_BEF),
      JSON.stringify(((richBody.user || '').match(/走这一步\*\*之前\*\*[^\n]*/) || ['（没有这一行）'])[0].slice(0, 70)));
    check('★★ 前后局面核对通过（moveVerified）—— 被截断时这里必定是 false',
      richBody.meta && richBody.meta.moveVerified === true,
      String(richBody.meta && richBody.meta.moveVerified));

    // ---------- 「再往前一手」那一层也要自证，同一把尺子 ----------
    // 它是前端送上来的，所以照样要求它自己证明自己：prevFen 走出 prevSan
    // 必须正好得到 beforeFen。对不上就整段丢掉 —— 宁可少给一层，不给错的一层。
    const PREV_OK = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3'; // 3.Qh5 之前
    const prevOk = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({
        fen: LONG_AFT, beforeFen: LONG_BEF, prevFen: PREV_OK, prevSan: 'Qh5',
        ply: 6, san: 'Nf6', color: 'b', dryRun: true,
      }),
    });
    const prevOkBody = await prevOk.json();
    check('★★ 两头接得上 → 「再往前一手」进提示词',
      prevOkBody.meta && prevOkBody.meta.hasPrev === true &&
      typeof prevOkBody.user === 'string' && prevOkBody.user.includes(PREV_OK),
      String(prevOkBody.meta && prevOkBody.meta.hasPrev));

    const prevBad = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({
        fen: LONG_AFT, beforeFen: LONG_BEF,
        prevFen: START_FEN,            // 送错了：它根本走不出 Qh5 得到 beforeFen
        prevSan: 'Qh5',
        ply: 6, san: 'Nf6', color: 'b', dryRun: true,
      }),
    });
    const prevBadBody = await prevBad.json();
    check('★★ 送错了（走不出来）→ 那一层整段丢掉，绝不带着它上路',
      prevBadBody.meta && prevBadBody.meta.hasPrev === false &&
      !String(prevBadBody.user).includes('再往前一手'),
      String(prevBadBody.meta && prevBadBody.meta.hasPrev));

    const prevSanBad = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({
        fen: LONG_AFT, beforeFen: LONG_BEF, prevFen: PREV_OK,
        prevSan: 'e4',                 // 局面是对的，着法写错了 —— 一样要拦
        ply: 6, san: 'Nf6', color: 'b', dryRun: true,
      }),
    });
    const prevSanBadBody = await prevSanBad.json();
    check('  着法名对不上也一样丢掉（不是只核对局面长度）',
      prevSanBadBody.meta && prevSanBadBody.meta.hasPrev === false);

    // 字段不全的 FEN 要当场拒掉，而不是带着一个"悄悄变了样"的局面上路
    const clipped = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({
        fen: LONG_AFT.split(' ').slice(0, 5).join(' '),   // 少一个字段
        ply: 6, san: 'Nf6', color: 'b', dryRun: true,
      }),
    });
    check('★★ 只有 5 个字段的残缺 FEN 直接返回 400（不许它悄悄补默认值）',
      clipped.status === 400, String(clipped.status));

    // ---------- 4.7 上游认证失败要透传成人话 ----------
    mockMode = '401';
    const authFail = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({ fen: START_FEN, ply: 1, san: 'e4', color: 'w' }),
    });
    const authBody = await authFail.json();
    check('上游 401 → 后端返回 502', authFail.status === 502, String(authFail.status));
    check('  错误码是 auth', authBody.code === 'auth', authBody.code);
    check('  把"该去改密钥"的提示透传给了界面', /密钥/.test(authBody.hint || ''));
    check('★ 这一步的响应里同样没有密钥', !JSON.stringify(authBody).includes(FAKE_KEY));

    // ---------- 4.8 上游挂了 ----------
    mockMode = '500';
    const srvFail = await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({ fen: START_FEN, ply: 1, san: 'e4', color: 'w' }),
    });
    const srvBody = await srvFail.json();
    check('上游 500 → 错误码 server', srvBody.code === 'server', srvBody.code);
    check('  提示说清楚这是对方的锅', /不是你的/.test(srvBody.hint || ''));

    mockMode = 'ok';

    // ---------- 4.9 输入长度要有上限（防止一个坏请求把 token 撑爆）----------
    mockHits = [];
    await fetch(BASE + '/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: jsonOf({
        fen: START_FEN, ply: 1, san: 'e4', color: 'w',
        engine: { pvSan: new Array(500).fill('XyZzz') },   // 塞一大堆后续变化
        history: new Array(500).fill('aVeryLongMoveName'),
        annotation: 'x'.repeat(5000),
      }),
    });
    const sentUser = mockHits[0].body.messages[1].content;
    check('★ 超长的候选变化被截断（不会把 prompt 撑爆）',
      !/XyZzz.*XyZzz.*XyZzz.*XyZzz.*XyZzz.*XyZzz.*XyZzz.*XyZzz.*XyZzz/.test(sentUser));
    check('  超长的棋谱评注也被截断', sentUser.length < 3000, sentUser.length + ' 字');
  } catch (err) {
    check('端到端测试跑完', false, err.message);
    // 子进程是活着但没响应，还是压根已经死了？这两件事的排查方向完全不同，
    // 所以把退出状态一并打出来，别再让人对着一句"没起来"发愣。
    const diag = (s) => s ? ('exitCode=' + s.child.exitCode + '  signal=' + s.child.signalCode) : '（没起起来）';
    console.log('\n  serverA：' + diag(serverA));
    console.log('  serverB：' + diag(serverB));
    console.log('\n  服务器输出（stdout）:\n' + ((serverA && serverA.out) || '').split('\n').slice(-12).join('\n'));
    console.log('  服务器输出（stderr）:\n' + (((serverA && serverA.err) || '') + ((serverB && serverB.err) || '')).split('\n').slice(-12).join('\n'));
  } finally {
    await killPair();
    await new Promise((r) => mockServer.close(r));
  }

  // ============================================================
  console.log('\n' + '═'.repeat(64));
  const total = pass + fail;
  if (fail === 0) {
    console.log('🎉 全部通过：' + total + ' 项断言，0 失败');
  } else {
    console.log('共 ' + total + ' 项，通过 ' + pass + '，失败 ' + fail);
    console.log('\n失败的项：');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log('═'.repeat(64) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();
