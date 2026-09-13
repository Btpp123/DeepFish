// ============================================================
// verify-live.js —— 拿真密钥打一次真的 DeepSeek
//
// 前面那套 verify-llm.js 用假的服务器验证了"链路对不对"，
// 但它不知道你的密钥是不是真的能用。这个脚本补上最后这一环。
//
// 【没配密钥怎么办】
// 不算失败，会打印怎么做，然后正常退出。所以放进自动化流程里也没问题。
//
// 运行： node verify-live.js        （或者 npm run verify:live）
// ============================================================

const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const ROOT = __dirname;
const KEY = (process.env.DEEPSEEK_API_KEY || '').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function line(s = '') { console.log(s); }

function hint() {
  line('');
  line('  ⚠️  还没配置 DeepSeek 密钥（DEEPSEEK_API_KEY 是空的）');
  line('');
  line('  怎么配：');
  line('    1. 去 https://platform.deepseek.com/api_keys 申请一个密钥');
  line('    2. 打开项目根目录的 .env 文件，找到这一行：');
  line('         DEEPSEEK_API_KEY=');
  line('       在等号后面贴上你的密钥（只要 sk- 后面那一整串，不加引号、不留空格）');
  line('    3. 保存，重新跑一次这个命令');
  line('');
  line('  其余功能不受影响：鳕鱼算棋、曲线、复盘都能照常用。');
  line('');
}

if (!KEY) {
  hint();
  process.exit(0);
}

if (!/^sk-/.test(KEY)) {
  line('');
  line('  ⚠️  密钥看起来不太对：通常是 sk- 开头的一大串。');
  line('      现在读到的是 ' + KEY.slice(0, 4) + '…（共 ' + KEY.length + ' 个字符）');
  line('      检查一下 .env 里那一行有没有多写引号或空格。');
  line('');
  process.exit(1);
}

line('');
line('🐟🤖 DeepFish —— 真实联调');
line('═'.repeat(64));
line('  密钥：' + KEY.slice(0, 6) + '****' + KEY.slice(-4) + '（' + KEY.length + ' 个字符）');
line('  地址：' + (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'));
line('  模型：' + (process.env.DEEPSEEK_MODEL || 'deepseek-chat'));
line('');

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

(async () => {
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  try {
    // ---------- 1. 等服务器起来 ----------
    let health = null;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.ok) { health = await r.json(); break; }
      } catch { /* 还没起来 */ }
      await sleep(200);
    }
    if (!health) throw new Error('服务器没能启动');

    line('① 服务器起来了');
    line('   /api/health → 讲棋' + (health.llm && health.llm.configured ? '已配置 ✅' : '未配置 ❌'));
    if (!health.llm || !health.llm.configured) {
      line('   但是服务器读到的密钥是空的 —— .env 没读进去？');
      line('   （看看 .env 是不是存在、有没有存成 .env.txt）');
      throw new Error('服务器没读到密钥');
    }

    // ---------- 2. probe：花几个 token 验一下密钥是不是真的能用 ----------
    line('');
    line('② 用密钥验一次（只花几个 token）…');
    const t1 = Date.now();
    const probe = await (await fetch(BASE + '/api/llm?probe=1')).json();
    const probeMs = Date.now() - t1;

    if (!probe.probe || !probe.probe.ok) {
      line('');
      line('   ❌ 密钥没通过验证（' + probeMs + 'ms）');
      line('      错误码：' + ((probe.probe && probe.probe.code) || '未知'));
      line('      说明：' + ((probe.probe && probe.probe.message) || ''));
      line('      怎么办：' + ((probe.probe && probe.probe.hint) || ''));
      line('');
      throw new Error('密钥验证失败');
    }
    line('   ✅ 密钥可用（' + probeMs + 'ms），模型回了：' + JSON.stringify(probe.probe.reply));

    // ---------- 3. 真讲一步棋 ----------
    line('');
    line('③ 请它讲一步真实的败着…');
    line('   （学者将杀：1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7# —— 讲黑方第 3 回合的 Nf6）');
    line('');

    const t2 = Date.now();
    const res = await fetch(BASE + '/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 5 4',
        ply: 6,
        san: 'Nf6',
        color: 'b',
        engine: {
          scoreCp: 600, scoreMate: null, scoreText: '+6.00',
          bestMoveSan: 'g6', pvSan: ['g6', 'Qf3', 'Nd4', 'Qd1'], depth: 14,
        },
        swing: { beforeCp: 60, afterCp: 600 },
        opening: ['e4', 'e5', 'Bc4', 'Nc6'],
        history: ['Bc4', 'Nc6'],
      }),
    });
    const data = await res.json();
    const totalMs = Date.now() - t2;

    if (!res.ok || !data.ok) {
      line('   ❌ 讲棋失败');
      line('      HTTP ' + res.status + '　错误码：' + (data.code || '未知'));
      line('      说明：' + (data.error || ''));
      line('      怎么办：' + (data.hint || ''));
      if (data.detail) line('      原始信息：' + data.detail);
      line('');
      throw new Error('讲棋失败');
    }

    line('   ✅ 讲好了（第 ' + data.attempts + ' 次尝试，共 ' + (totalMs / 1000).toFixed(1) + ' 秒）');
    line('   模型：' + data.model);
    if (data.usage) {
      line('   用量：输入 ' + data.usage.prompt_tokens + ' + 输出 ' +
        data.usage.completion_tokens + ' = ' + data.usage.total_tokens + ' tokens');
    }
    line('');
    line('─'.repeat(64));
    line(data.text);
    line('─'.repeat(64));

    // ---------- 4. 顺便确认密钥没跑到浏览器那边去 ----------
    line('');
    line('④ 安全检查：密钥有没有可能漏给浏览器？');
    const llmResp = await (await fetch(BASE + '/api/llm')).text();
    const explainResp = JSON.stringify(data);
    const frontEnd = await (await fetch(BASE + '/js/app.js')).text();

    const leaked = [
      ['/api/llm 的响应', llmResp],
      ['/api/explain 的响应', explainResp],
      ['发给浏览器的 app.js', frontEnd],
    ].filter(([, body]) => body.includes(KEY));

    if (leaked.length) {
      line('   ❌ 发现泄漏：' + leaked.map(([n]) => n).join('、'));
      throw new Error('密钥泄漏');
    }
    line('   ✅ /api/llm 响应、/api/explain 响应、前端 app.js —— 都找不到密钥');
    line('      （这是接入方案的底线：密钥只留在服务器上）');

    line('');
    line('═'.repeat(64));
    line('🎉 真实联调通过。现在打开页面点「🤖 让 DeepSeek 讲讲」就能用了。');
    line('═'.repeat(64));
    line('');
  } catch (err) {
    line('');
    line('❌ 联调没通过：' + err.message);
    line('');
    if (out.trim()) {
      line('服务器输出：');
      line(out.split('\n').slice(-15).join('\n'));
    }
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch { /* 已经退出了 */ }
    await sleep(150);
  }
})();
