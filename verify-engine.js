// ============================================================
// verify-engine.js —— 引擎层验收测试
//
// 直接调用 src/engine.js，不经过网络。
// 运行： node verify-engine.js
// ============================================================

const { getEngine, ENGINE_PATH } = require('./src/engine');
const { Chess } = require('chess.js');

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

/** 从一串着法算出最终 FEN。数组或 "1. e4 e5 2. Nf3" 整串都行。 */
function fenAfter(moves) {
  const text = (Array.isArray(moves) ? moves.join(' ') : String(moves))
    .replace(/\d+\.(\.\.)?/g, ' ')   // 去掉 1. / 1... 这类编号
    .trim();
  const list = text ? text.split(/\s+/).filter(Boolean) : [];
  const g = new Chess();
  for (const m of list) g.move(m);
  return g.fen();
}

(async () => {
  const engine = getEngine();

  // ------------------------------------------------------------
  section('① 启动与握手');
  // ------------------------------------------------------------
  const t0 = Date.now();
  try {
    await engine.ensureStarted();
    console.log('  引擎: ' + engine.identity.name + '  （启动耗时 ' + (Date.now() - t0) + 'ms）');
    check('引擎能启动', !!engine.identity.name);
    check('引擎名包含 Stockfish', /stockfish/i.test(engine.identity.name || ''), engine.identity.name);
    check('读到了可调参数列表', engine.identity.options.length > 10, engine.identity.options.length + ' 个');
    check('线程数参数存在', engine.identity.options.some((o) => o.name === 'Threads'));
  } catch (err) {
    check('引擎能启动', false, err.message);
    console.log('\n引擎起不来，后面的测试没法做。路径: ' + ENGINE_PATH);
    process.exit(1);
  }

  // ------------------------------------------------------------
  section('② 黄金测试：初始局面');
  // ------------------------------------------------------------
  const r1 = await engine.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 12 });
  console.log('  最佳着法: ' + r1.bestMove + ' (' + r1.bestMoveSan + ')   评分: ' + r1.scoreText);
  console.log('  后续变化: ' + r1.pvSan.slice(0, 6).join(' '));

  const GOOD_OPENINGS = ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'e2e3', 'd2d3', 'g2g3', 'b2b3', 'b1c3'];
  check('给出的是合理开局着法', GOOD_OPENINGS.includes(r1.bestMove),
    r1.bestMove + ' — 绝不能是 a2a3 那种');
  check('深度达到 12', r1.depth >= 12, 'depth=' + r1.depth);
  check('评分在合理范围（开局 |分| < 1.5）', Math.abs(r1.scoreCp) < 150, r1.scoreCp + ' 厘兵');
  check('最佳着法转成了标准记谱', /^[a-h]/.test(r1.bestMoveSan || ''), r1.bestMoveSan);
  check('PV 第一步和 bestMove 一致',
    r1.pv[0] === r1.bestMove,
    r1.pv[0] + ' vs ' + r1.bestMove);
  check('PV 的 SAN 数量等于 PV 长度', r1.pvSan.length === r1.pv.length,
    r1.pvSan.length + '/' + r1.pv.length);
  check('轮次识别为白方', r1.turn === 'w');

  // ------------------------------------------------------------
  section('③ 分数视角翻转（最容易看反的地方）');
  // ------------------------------------------------------------
  // 一个正常开局的局面（白方走）
  const balanced = fenAfter('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5');
  const rW = await engine.analyze(balanced, { depth: 12 });
  console.log('  势均力敌局面: ' + rW.scoreText + '  (turn=' + rW.turn + ')');
  check('白方走时得分符号方向正常', typeof rW.scoreCp === 'number');
  check('势均局面评分的绝对值很小', Math.abs(rW.scoreCp) < 200, rW.scoreCp + ' 厘兵');

  // 黑方大优：白后送掉，只吃回一个兵（1.e4 e5 2.Qh5 Nc6 3.Qxe5+ Nxe5 4.Nf3）
  const blackAhead = fenAfter('1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 4. Nf3');
  const rB = await engine.analyze(blackAhead, { depth: 12 });
  console.log('  黑方大优局面: ' + rB.scoreText + '  (turn=' + rB.turn + ')');
  check('黑方大优时评分为负数（白方视角）', rB.scoreCp !== null && rB.scoreCp < -500,
    'scoreCp=' + rB.scoreCp);
  check('该局面轮次识别为黑方', rB.turn === 'b');

  // ------------------------------------------------------------
  section('④ 将杀分数');
  // ------------------------------------------------------------
  // 学者将杀：3... Nf6 之后，白方 Qxf7#，所以这里应该是「白方 1 步内将杀」
  const mateIn1 = fenAfter(['1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6']);
  const rM = await engine.analyze(mateIn1, { depth: 12 });
  console.log('  局面: ' + mateIn1);
  console.log('  评分: ' + rM.scoreText + '  bestmove=' + rM.bestMove + '(' + rM.bestMoveSan + ')');
  check('识别出将杀分数', rM.scoreMate !== null, 'scoreMate=' + rM.scoreMate);
  check('将杀方向为白方取胜（正数）', rM.scoreMate > 0, 'scoreMate=' + rM.scoreMate);
  check('将杀步数为 1', rM.scoreMate === 1, 'scoreMate=' + rM.scoreMate);
  check('推荐着法是 Qxf7#', rM.bestMoveSan === 'Qxf7#', rM.bestMoveSan);

  // 黑方将被杀的对称局面：愚人将杀之后（白方已被将杀）
  const rM2 = await engine.analyze(fenAfter(['1. f3 e5 2. g4']), { depth: 12 });
  console.log('  愚人将杀前一步: ' + rM2.scoreText + '  bestmove=' + rM2.bestMoveSan);
  check('黑方将杀时分数为负', rM2.scoreMate !== null && rM2.scoreMate < 0, 'scoreMate=' + rM2.scoreMate);
  check('黑方能找到 Qh4#', rM2.bestMoveSan === 'Qh4#', rM2.bestMoveSan);

  // ------------------------------------------------------------
  section('⑤ 队列：连续多个请求不串台');
  // ------------------------------------------------------------
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',   // 白方
    fenAfter(['1. e4 e5 2. Nf3 Nc6']),                              // 白方
    fenAfter(['1. e4 e5 2. Nf3 Nc6 3. Bb5']),                       // 黑方
  ];
  const tq = Date.now();
  const many = await Promise.all(fens.map((f) => engine.analyze(f, { depth: 10 })));
  console.log('  三个请求总耗时 ' + (Date.now() - tq) + 'ms（串行排队）');
  console.log('  首着依次为: ' + many.map((r) => r.bestMoveSan).join(' / '));
  check('三个请求全部返回', many.every((r) => r.bestMove), many.map((r) => r.bestMoveSan).join(' / '));
  check('每个请求都真的算到了指定深度', many.every((r) => r.depth >= 10),
    many.map((r) => r.depth).join(','));
  check('每个请求都有分数（不是空壳）', many.every((r) => r.scoreCp !== null || r.scoreMate !== null));
  check('每个结果绑定的是自己那个局面',
    many.every((r, i) => r.fen === fens[i]),
    '全部匹配');
  check('三个不同局面给出各自的分析（没串台）',
    new Set(many.map((r) => r.bestMove)).size === 3,
    new Set(many.map((r) => r.bestMoveSan)).size + ' 种不同首着');
  check('第三个请求识别出黑方走棋', many[2].turn === 'b', 'turn=' + many[2].turn);

  // ------------------------------------------------------------
  section('⑥ 并发压测：10 个请求');
  // ------------------------------------------------------------
  // 注意：同一个局面反复算，鳕鱼会直接命中它自己的置换表，
  // 第二次开始只要 1~2ms（节点数从 4000 掉到 1000）。
  // 所以这一节验证的是「并发安全」，不是「算得快不快」。
  const t10 = Date.now();
  const ten = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      engine.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 8 }))
  );
  check('10 个并发请求全部成功', ten.every((r) => r.bestMove),
    (Date.now() - t10) + 'ms');
  check('10 次结果完全一致（无串台）',
    new Set(ten.map((r) => r.bestMove)).size === 1,
    ten[0].bestMove);
  check('10 次都真的算到了 depth 8', ten.every((r) => r.depth >= 8),
    '最少 depth=' + Math.min(...ten.map((r) => r.depth)));
  check('10 次都带回了 PV 变化', ten.every((r) => r.pv.length > 0),
    '最短 PV 长度 ' + Math.min(...ten.map((r) => r.pv.length)));

  // ------------------------------------------------------------
  section('⑦ 非法输入兜底');
  // ------------------------------------------------------------
  let threw = false;
  try {
    await engine.analyze('这不是一个 FEN', { depth: 8 });
  } catch (e) {
    threw = true;
  }
  check('非法 FEN 会抛错而不是静默乱答', threw);

  // ------------------------------------------------------------
  console.log('\n' + '═'.repeat(64));
  console.log('  引擎验收：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) console.log('  失败项：\n    - ' + failures.join('\n    - '));
  console.log('═'.repeat(64) + '\n');

  getEngine()._teardown();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n💥 测试崩了：', err);
  process.exit(1);
});
