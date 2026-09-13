// ============================================================
// bench-depth.js —— 临时基准：多路线 + 深搜索到底要花多久
//
// 为什么要有这个：用户要"让鳕鱼多算几步、并且给几条次优解"。
// 但 MultiPV=3 意味着引擎要把三条线都搜到同样深度，
// 成本远不止 ×3（同一层的节点数会因为候选更多而膨胀）。
// 这台机器只有 2 个线程，必须实测，不能拍脑袋定默认值。
//
// 用法： node bench-depth.js
// ============================================================

const { Chess } = require('chess.js');

const BASE = 'http://localhost:3000';

// 从歌剧院之局里取三个不同性质的局面：开局 / 中局 / 战术性局面
const OPERA = '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 ' +
  '6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 ' +
  '11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6';

function fenAfter(plies, pgnMoves) {
  const g = new Chess();
  for (let i = 0; i < plies; i++) g.move(pgnMoves[i]);
  return g.fen();
}

async function analyze(fen, depth, multipv) {
  const t0 = Date.now();
  const res = await fetch(BASE + '/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen, depth, multipv }),
  });
  const data = await res.json();
  return { ms: Date.now() - t0, data };
}

(async () => {
  const g = new Chess();
  g.loadPgn(OPERA);
  const sans = g.history();
  const cases = [
    { name: '开局 ply=6',  fen: fenAfter(6, sans) },
    { name: '中局 ply=20', fen: fenAfter(20, sans) },
    { name: '战术 ply=28', fen: fenAfter(28, sans) },
  ];

  console.log('');
  console.log('深度 × 多路线 实测（这台机器 2 线程）');
  console.log('─'.repeat(62));

  for (const c of cases) {
    console.log('');
    console.log('【' + c.name + '】');
    for (const depth of [12, 16, 18, 20]) {
      const one = await analyze(c.fen, depth, 1);
      const three = await analyze(c.fen, depth, 3);
      const alts = (three.data.alternatives || []).length;
      console.log('  depth ' + String(depth).padStart(2) + '  ' +
        'multipv1 ' + String(one.ms).padStart(5) + 'ms   ' +
        'multipv3 ' + String(three.ms).padStart(6) + 'ms   ' +
        '(alt ' + alts + ', 主分 ' + (three.data.scoreText || '—') + ')');
    }
  }
  console.log('');
})();
