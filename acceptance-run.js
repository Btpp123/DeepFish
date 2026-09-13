// ============================================================
// acceptance-run.js —— 一次性验收：真让 DeepSeek 讲一步棋
//
// 和 probe-prompt.js 的区别：它只拼提示词（dryRun，不花钱），
// 这里**真的发一次** —— 因为要确认的是"换了厚提示词之后，
// 模型讲出来的东西有没有变好"。跑一次几厘钱，值。
//
// 用学者将杀第 6 个半回合（黑方 Nf6??）当考题：
//   正确讲法应该点出 g6/Qe7 能守、以及 f7 上的杀。
// ============================================================

const BASE = process.env.BASE || 'http://localhost:3000';
const DEPTH = 18, MULTIPV = 3;

// 学者将杀：1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#
const PGN = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'];
const PLY = 6;                                  // 黑方走 Nf6 之后
const SAN = 'Nf6';
const { Chess } = require('chess.js');

function fenAt(n) {                             // 走了 n 个半回合之后的局面
  const c = new Chess();
  for (let i = 0; i < n; i++) c.move(PGN[i]);
  return c.fen();
}

async function analyze(fen) {
  const res = await fetch(BASE + '/api/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen, depth: DEPTH, multipv: MULTIPV, timeoutMs: 8000 }),
  });
  const d = await res.json();
  if (!res.ok || !d.ok) throw new Error('analyze: ' + (d.error || res.status));
  return d;
}

function pack(o) {
  return (o.alternatives || []).map((a) => ({
    rank: a.rank, firstMoveSan: a.firstMoveSan, scoreCp: a.scoreCp,
    scoreMate: a.scoreMate, scoreText: a.scoreText, pvSan: a.pvSan || [],
  }));
}

(async () => {
  const fen = fenAt(PLY);
  const beforeFen = fenAt(PLY - 1);

  console.log('考题：学者将杀，黑方走 Nf6??（第 3 回合）');
  console.log('before: ' + beforeFen);
  console.log('after : ' + fen);
  console.log('');

  console.log('问鳕鱼（depth=' + DEPTH + ' multipv=' + MULTIPV + '，两个局面）…');
  const now = await analyze(fen);
  const before = await analyze(beforeFen);
  console.log('  走之前：首选 ' + before.bestMoveSan + ' ' + before.scoreText
    + '，候选 ' + (before.alternatives || []).map((a) => a.firstMoveSan).join('/'));
  console.log('  走之后：首选 ' + now.bestMoveSan + ' ' + now.scoreText
    + '，候选 ' + (now.alternatives || []).map((a) => a.firstMoveSan).join('/'));
  console.log('');

  console.log('请 DeepSeek 讲…');
  const res = await fetch(BASE + '/api/explain', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fen, beforeFen, ply: PLY, san: SAN, color: 'b',
      engine: {
        scoreCp: now.scoreCp, scoreMate: now.scoreMate, scoreText: now.scoreText,
        bestMoveSan: now.bestMoveSan, pvSan: now.pvSan || [],
        alternatives: pack(now), depth: now.depth,
      },
      engineBefore: {
        scoreCp: before.scoreCp, scoreMate: before.scoreMate, scoreText: before.scoreText,
        bestMoveSan: before.bestMoveSan, pvSan: before.pvSan || [],
        alternatives: pack(before), depth: before.depth,
      },
      swing: {
        beforeCp: before.scoreCp, beforeMate: before.scoreMate,
        afterCp: now.scoreCp, afterMate: now.scoreMate,
      },
      history: PGN.slice(Math.max(0, PLY - 7), Math.max(0, PLY - 1)),
      opening: PGN.slice(0, 6),
    }),
  });
  const d = await res.json();
  if (!res.ok || !d.ok) throw new Error('explain: ' + (d.error || res.status));

  console.log('');
  console.log('════════════ DeepSeek 的讲解 ════════════');
  console.log(d.text);
  console.log('═════════════════════════════════════════');
  console.log('meta: ' + JSON.stringify(d.meta));
  console.log('用量: ' + JSON.stringify(d.usage));
})().catch((e) => { console.error('崩了：' + e.message); process.exit(1); });
