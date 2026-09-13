// ============================================================
// verify-eval.js —— 评估曲线 / 局势条 的验收测试
//
// 分两半：
//   前半 = 纯粹的数学（不依赖任何环境，直接 import eval.js）
//   后半 = /api/evaluate 批量接口（需要服务器在跑）
//
// 运行： node verify-eval.js
// ============================================================

const path = require('path');
const { pathToFileURL } = require('url');
const { Chess } = require('chess.js');

const BASE = process.env.BASE || 'http://localhost:3000';

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

function close(a, b, tol) {
  return Math.abs(a - b) < (tol === undefined ? 0.01 : tol);
}

(async () => {
  // eval.js 是给浏览器写的 ES 模块，这里直接按文件路径 import。
  // 它顶层没有碰 document，所以 Node 里也能加载 —— 只有 createEvalBar /
  // createEvalCurve 那两个才需要浏览器环境，本次不测它们。
  const E = await import(pathToFileURL(path.join(__dirname, 'public', 'js', 'eval.js')).href);
  const { normFromScore, whiteFraction, compactScore, sideOf, terminalScore } = E;

  // ------------------------------------------------------------
  section('① 分数压缩：把「厘兵」变成 -1 ~ +1');
  // ------------------------------------------------------------
  check('均势 → 0', normFromScore(0, null) === 0, '0');
  check('正分 → 正数（白优）', normFromScore(100, null) > 0, normFromScore(100, null).toFixed(4));
  check('负分 → 负数（黑优）', normFromScore(-100, null) < 0, normFromScore(-100, null).toFixed(4));
  check('一个兵优势 ≈ 0.245', close(normFromScore(100, null), 0.245, 0.005),
    normFromScore(100, null).toFixed(4));
  check('永远不会超过 1', normFromScore(99999, null) <= 1, normFromScore(99999, null).toFixed(6));
  check('永远不会低于 -1', normFromScore(-99999, null) >= -1, normFromScore(-99999, null).toFixed(6));
  check('大优势被压扁（cp=1000 还没顶格）',
    normFromScore(1000, null) < 1 && normFromScore(1000, null) > 0.95,
    normFromScore(1000, null).toFixed(5));

  // 单调性：分数越大，压缩值一定越大。这是曲线不会画反的根本保证。
  let monotonic = true;
  let prev = -2;
  for (let cp = -2000; cp <= 2000; cp += 25) {
    const v = normFromScore(cp, null);
    if (v < prev) { monotonic = false; break; }
    prev = v;
  }
  check('分数越大压缩值越大（单调，曲线不会回头）', monotonic);

  check('mate 正值 → 顶到 +1', normFromScore(null, 3) === 1);
  check('mate 负值 → 顶到 -1', normFromScore(null, -3) === -1);
  check('mate 0（和棋）→ 0', normFromScore(null, 0) === 0);
  check('mate 优先于 cp（即使 cp 是负的）', normFromScore(-900, 5) === 1, '白方将杀就是白方赢');
  check('两个都没有 → null（表示「还没算」）', normFromScore(null, null) === null);
  check('undefined 也当没有', normFromScore(undefined, undefined) === null);

  // ------------------------------------------------------------
  section('② 局势条的填充比例');
  // ------------------------------------------------------------
  check('均势 → 一半白', whiteFraction(0) === 0.5);
  check('白方顶格 → 全白', whiteFraction(1) === 1);
  check('黑方顶格 → 全黑', whiteFraction(-1) === 0);
  check('没算出来 → 先按一半显示', whiteFraction(null) === 0.5);
  check('超出范围会被截住', whiteFraction(5) === 1 && whiteFraction(-5) === 0);
  check('一个兵优势 → 白方占 62%', close(whiteFraction(normFromScore(100, null)), 0.6225, 0.01),
    (whiteFraction(normFromScore(100, null)) * 100).toFixed(1) + '%');

  // ------------------------------------------------------------
  section('③ 短评分文字');
  // ------------------------------------------------------------
  check('+1.3', compactScore(130, null) === '+1.3', compactScore(130, null));
  check('-0.6', compactScore(-60, null) === '-0.6', compactScore(-60, null));
  check('接近 0 用 ±', compactScore(2, null) === '±0.0', compactScore(2, null));
  check('大分数取整（不留小数）', compactScore(2500, null) === '+25', compactScore(2500, null));
  check('白方将杀 #3', compactScore(null, 3) === '#3', compactScore(null, 3));
  check('黑方将杀 #-3', compactScore(null, -3) === '#-3', compactScore(null, -3));
  check('和棋 =', compactScore(null, 0) === '=', compactScore(null, 0));
  check('还没算 → …', compactScore(null, null) === '…', compactScore(null, null));

  // ------------------------------------------------------------
  section('④ 优劣判定（门槛 0.8 个兵）');
  // ------------------------------------------------------------
  check('+1.5 → 白优', sideOf(150, null) === 'w');
  check('-1.5 → 黑优', sideOf(-150, null) === 'b');
  check('+0.5 → 均势', sideOf(50, null) === 'eq');
  check('将杀按方向走', sideOf(null, 2) === 'w' && sideOf(null, -2) === 'b');
  check('没有数 → 均势', sideOf(null, null) === 'eq');

  // ------------------------------------------------------------
  section('⑤ 终局本地判定（这一步省掉了对引擎的请求）');
  // ------------------------------------------------------------
  {
    // 学者将杀的终局
    const g = new Chess();
    for (const m of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']) g.move(m);
    const t = terminalScore(g);
    check('将杀局面本程序自己就能判出来', !!t, JSON.stringify(t));
    check('判成白方获胜', t && t.scoreMate > 0, t && t.scoreText);
    check('文字写对了', t && t.scoreText === '白方将杀获胜', t && t.scoreText);
    check('不用再问引擎（没有 bestMove）', t && t.bestMove === undefined);
    check('曲线会顶到最上面', t && normFromScore(t.scoreCp, t.scoreMate) === 1);
  }
  {
    // 逼和：黑方无子可动但没被将军
    const g = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    const t = terminalScore(g);
    check('逼和判成和棋', t && t.scoreCp === 0 && t.scoreMate === null,
      t && t.scoreText);
    check('逼和分数落在中线', t && normFromScore(t.scoreCp, t.scoreMate) === 0);
  }
  {
    const g = new Chess();
    check('开局不是终局 → 得去问引擎', terminalScore(g) === null);
  }
  {
    const g = new Chess('8/8/8/4k3/8/8/4K3/8 w - - 0 1');
    const t = terminalScore(g);
    check('只剩两个王 → 判成子力不足和棋', !!t && t.scoreCp === 0, t && t.scoreText);
  }

  // ------------------------------------------------------------
  section('⑥ 后端批量接口 /api/evaluate');
  // ------------------------------------------------------------
  let serverUp = false;
  try {
    const r = await fetch(BASE + '/api/health');
    serverUp = r.ok;
  } catch { /* 服务器没跑 */ }

  if (!serverUp) {
    console.log('  ⚠️  服务器没在跑，跳过接口测试。');
    console.log('     先执行： npm start');
  } else {
    const FENS = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',   // 开局
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',  // 白走了 e4
      '8/8/8/4k3/8/8/4K3/8 w - - 0 1',                              // 只剩两个王
      '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',                             // 逼和：真的一步都走不了
    ];

    const t0 = Date.now();
    const res = await fetch(BASE + '/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fens: FENS, depth: 8 }),
    });
    const data = await res.json();
    console.log('  耗时 ' + (Date.now() - t0) + 'ms，返回 ' + (data.results || []).length + ' 条');

    check('接口返回 200', res.status === 200, 'status=' + res.status);
    check('整体 ok', data.ok === true);
    check('条目数量和请求的一致', data.results.length === 4, data.results.length + ' 条');
    check('每条都带回了自己那个局面',
      data.results.every((r, i) => r.fen === FENS[i]));

    const [opening, afterE4, bareKings, stalemate] = data.results;
    check('开局算出了评分', opening.ok && opening.scoreCp !== null,
      opening.scoreCp + ' 厘兵，推荐 ' + opening.bestMoveSan);
    check('开局推荐 e4/d4 一类（不是 a3）',
      ['e2e4', 'd2d4', 'g1f3', 'c2c4'].includes(opening.bestMove),
      opening.bestMove);
    check('第二条第 2 位是黑方走', afterE4.turn === 'b', 'turn=' + afterE4.turn);
    check('e4 之后白方小优（正数）', afterE4.scoreCp > 0,
      afterE4.scoreCp + ' 厘兵（引擎给的是黑方视角，翻转后应为正）');

    // 【一个反直觉但很重要的事实】
    // 「只剩两个王」在棋规上已经和棋了，可引擎并不知道这条规则 ——
    // 它照样会给你推荐 Ke3。所以「局面结束没有」必须由我们自己判，
    // 不能指望引擎告诉你。这正是 eval.js 里 terminalScore() 存在的理由。
    check('只剩两个王时引擎照样给得出着法（它不懂棋规）',
      bareKings.ok === true && !!bareKings.bestMove,
      'bestMove=' + bareKings.bestMove + ' → 所以终局必须本地判，否则曲线会画出一条假的中局');

    // 而「逼和」是真的没有任何合法着法，引擎只能交出 (none)
    check('逼和局面引擎一步都交不出来',
      stalemate.bestMove === null, 'bestMove=' + stalemate.bestMove);
    check('逼和这条也不会让整批失败', stalemate.ok === true, 'ok=' + stalemate.ok);

    // ---- 错误处理 ----
    const bad = await fetch(BASE + '/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fens: [] }),
    });
    check('空列表返回 400', bad.status === 400, 'status=' + bad.status);

    const tooMany = await fetch(BASE + '/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fens: Array.from({ length: 41 }, () => FENS[0]) }),
    });
    check('超过 40 个局面会拒绝', tooMany.status === 400, 'status=' + tooMany.status);

    const junk = await fetch(BASE + '/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fens: ['这根本不是 FEN'], depth: 8 }),
    });
    const junkData = await junk.json();
    check('非法局面不会让接口 500', junk.status === 200, 'status=' + junk.status);
    check('非法局面被单独标为失败', junkData.results[0].ok === false,
      junkData.results[0].error);

    // ---- 深度参数生效 ----
    const d4 = await (await fetch(BASE + '/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fens: [FENS[0]], depth: 4 }),
    })).json();
    const d12 = await (await fetch(BASE + '/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fens: [FENS[1]], depth: 12 }),
    })).json();
    check('深度参数透传下去了', d4.depth === 4 && d12.depth === 12,
      'd4=' + d4.depth + ' d12=' + d12.depth);
  }

  // ------------------------------------------------------------
  console.log('\n' + '─'.repeat(64));
  console.log('评估层：' + pass + ' 项通过，' + fail + ' 项失败');
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  ✗ ' + f));
  }
  console.log('─'.repeat(64));
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n💥 测试脚本自己崩了：', err);
  process.exit(1);
});
