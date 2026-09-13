// ============================================================
// probe-prompt.js —— 把「实际发给 DeepSeek 的那段提示词」原样打印出来
//
// 【为什么需要这个工具】
// 讲棋讲得不对时，光看后端日志没用 —— 日志里只有「讲成功没、几毫秒」，
// 没有正文。而问题往往出在提示词里：某条事实没写、某个主语含糊、
// 或者模型被字面意思带偏了。
//
// 【它走的是真链路，不是另拼一份】
// 它先问真鳕鱼（多路线），把结果打成 /api/explain 的请求体，
// 然后带 `dryRun:true` 发过去 —— 后端会**拼好提示词但不调用 DeepSeek**。
// 所以打出来的就是线上那一份，一字不差，而且不花钱。
//
// 用法（服务器要在跑，因为要现问鳕鱼）：
//     node probe-prompt.js                  # 默认：学者将杀，黑方第 3 回合走 Nf6 那一步
//     node probe-prompt.js 4                # 换成第 4 个半回合
//     node probe-prompt.js --multipv=1      # 只看单路线时长什么样
//     node probe-prompt.js --no-engine      # 不连服务器，只看没有引擎数据时长什么样
//     node probe-prompt.js --brief          # 只打长度、meta 和"给了多少/送了多少"
//
// ⚠️ 它**不会**调用 DeepSeek —— 只拼提示词，不花钱。
// ============================================================

const { Chess } = require('chess.js');

const BASE = process.env.BASE || 'http://localhost:3000';

// 学者将杀：1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#
// 第 3 回合黑方走 Nf6 是个典型的败着 —— 正好用来检查
// 「模型能不能看出 g6 才是该走的、以及 f7 上的杀」。
// 它同时是"一步走成被将杀"的样本：前后两个局面的量纲一个 cp 一个 mate。
const PGN_MOVES = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'];

/** 和前端 fetchEval 一样，只是这里由脚本直接问 */
async function analyze(fen, depth, multipv) {
  const res = await fetch(BASE + '/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 时间闸和 app.js 的 EXPLAIN_BUDGET_MS 保持一致
    body: JSON.stringify({ fen, depth, multipv, timeoutMs: 5000 }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function banner(t) {
  console.log('\n' + '='.repeat(66) + '\n' + t + '\n' + '='.repeat(66));
}

const packCandidates = (o) => (o && Array.isArray(o.alternatives) ? o.alternatives : []).map((a) => ({
  rank: a.rank,
  firstMoveSan: a.firstMoveSan,
  scoreCp: a.scoreCp,
  scoreMate: a.scoreMate,
  scoreText: a.scoreText,
  pvSan: a.pvSan || [],
}));

(async () => {
  const args = process.argv.slice(2);
  const noEngine = args.includes('--no-engine');
  const brief = args.includes('--brief');
  const plyArg = args.find((a) => /^\d+$/.test(a));
  const mpvArg = args.find((a) => a.startsWith('--multipv='));
  // 和前端的 EXPLAIN_* 保持一致：讲棋这条路是"更深 + 多路线"
  const multipv = mpvArg ? Number(mpvArg.split('=')[1]) : 3;
  const depth = Number(process.env.DEPTH || 18);

  // ---------- 1. 摆出这盘棋，取到「第 N 步走完之后」的局面 ----------
  const game = new Chess();
  const fens = [game.fen()];              // fens[k] = 第 k 步走完之后
  for (const san of PGN_MOVES) {
    game.move(san);
    fens.push(game.fen());
  }

  const ply = plyArg ? Number(plyArg) : 6;      // 默认第 6 个半回合 = 3...Nf6
  const fen = fens[ply];
  const beforeFen = fens[ply - 1];
  const san = PGN_MOVES[ply - 1];
  const color = beforeFen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
  // 再往前一手（对方上一手走之前的局面）—— 前端现在也会送这两个字段
  const prevFen = ply >= 2 ? fens[ply - 2] : '';
  const prevSan = ply >= 2 ? PGN_MOVES[ply - 2] : '';

  console.log('局面：' + PGN_MOVES.join(' '));
  console.log('这一步：第 ' + ply + ' 个半回合，' + (color === 'b' ? '黑方' : '白方') + '走了 ' + san);
  if (prevFen) console.log('再往前一手：' + prevSan + '   走之前的局面：' + prevFen);
  console.log('走之前的 FEN：' + beforeFen);
  console.log('走之后的 FEN：' + fen);
  console.log('（这次按 depth=' + depth + ' multipv=' + multipv + ' 问鳕鱼）');

  // ---------- 2. 问鳕鱼（两个局面都问，都要多路线）----------
  let engine = null;
  let engineBefore = null;
  let nowRaw = null;
  let beforeRaw = null;

  if (!noEngine) {
    try {
      const now = await analyze(fen, depth, multipv);
      const before = await analyze(beforeFen, depth, multipv);
      nowRaw = now;
      beforeRaw = before;
      engine = {
        scoreCp: now.scoreCp, scoreMate: now.scoreMate, scoreText: now.scoreText,
        bestMoveSan: now.bestMoveSan, pvSan: now.pvSan || [],
        alternatives: packCandidates(now), depth: now.depth,
      };
      engineBefore = {
        scoreCp: before.scoreCp, scoreMate: before.scoreMate, scoreText: before.scoreText,
        bestMoveSan: before.bestMoveSan, pvSan: before.pvSan || [],
        alternatives: packCandidates(before), depth: before.depth,
      };
    } catch (err) {
      console.log('\n⚠️  连不上服务器或引擎出错：' + err.message + '（改成无引擎模式继续）');
    }
  }

  // ---------- 3. 交给后端拼（dryRun = 只拼不发）----------
  const res = await fetch(BASE + '/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dryRun: true,
      fen,
      beforeFen,
      prevFen,
      prevSan,
      ply,
      san,
      color,
      engine,
      engineBefore,
      swing: beforeRaw ? {
        beforeCp: beforeRaw.scoreCp, beforeMate: beforeRaw.scoreMate,
        afterCp: nowRaw ? nowRaw.scoreCp : null, afterMate: nowRaw ? nowRaw.scoreMate : null,
      } : null,
      history: PGN_MOVES.slice(Math.max(0, ply - 7), Math.max(0, ply - 1)),
      opening: PGN_MOVES.slice(0, 6),
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));

  // ---------- 4. 原样打出来 ----------
  if (!brief) {
    banner('① SYSTEM（系统提示词，来自 coach.js 的 SYSTEM_PROMPT）');
    console.log(data.system);

    banner('② USER（这一手的事实单子，由 buildExplainPrompt 按真数据拼出来）');
    console.log(data.user);
  }

  // ---------- 5. 引擎给了多少 / 我们实际送出去多少 ----------
  banner('③ 引擎给了多少 / 实际送出去多少');
  if (nowRaw) {
    console.log('深度：走之后 ' + nowRaw.depth + '（seldepth ' + nowRaw.seldepth + '）' +
      '，走之前 ' + beforeRaw.depth);
    console.log('');
    console.log('走之后那个局面（轮对手走）：');
    console.log('   #1 ' + (nowRaw.bestMoveSan || '?') + '  评分 ' + nowRaw.scoreText);
    (nowRaw.alternatives || []).forEach((a) => {
      console.log('   #' + a.rank + ' ' + (a.firstMoveSan || '?') +
        '  评分 ' + a.scoreText + '  变化 ' + (a.pvSan || []).join(' '));
    });
    console.log('');
    console.log('走之前那个局面（他在这一步面临的选择）：');
    console.log('   #1 ' + (beforeRaw.bestMoveSan || '?') + '  评分 ' + beforeRaw.scoreText);
    (beforeRaw.alternatives || []).forEach((a) => {
      console.log('   #' + a.rank + ' ' + (a.firstMoveSan || '?') +
        '  评分 ' + a.scoreText + '  变化 ' + (a.pvSan || []).join(' '));
    });
  } else {
    console.log('（本次没连引擎）');
  }

  const u = data.user;
  const trailLines = (u.match(/ → {2}/g) || []).length;
  console.log('');
  console.log('提示词里有没有「再往前一手」那一层：' + (prevFen && u.includes(prevFen) ? '有' : '没有'));
  console.log('提示词里有没有「走之前那个局面」的 FEN：' + (u.includes(beforeFen) ? '有' : '没有'));
  console.log('提示词里有没有「走之后那个局面」的 FEN：' + (u.includes(fen) ? '有' : '没有'));
  console.log('逐步局面（"某步 → 某个完整 FEN"）行数：' + trailLines);
  console.log('提示词里有没有「这一步亏了多少」那一行：' + (/也就是说/.test(u) ? '有' : '**没有**'));
  console.log('提示词里有没有多路线对照：' + (/候选/.test(u) ? '有' : '没有'));
  console.log('着法有没有带上起止格锚点（"马 g8→f6"）：' +
    (/[兵马车象后王] [a-h][1-8][→×][a-h][1-8]/.test(u) ? '有' : '**没有**'));
  console.log('有没有先问"这一步想干什么"（意图）：' + (/想干什么/.test(u) ? '有' : '**没有**'));
  console.log('有没有问"该怎么应对"：' + (/该做的事|应对思路/.test(u) ? '有' : '**没有**'));
  console.log('有没有把"只依据给定局面 / 看不出来就说看不出来"写进 system：' +
    (/我看不出来/.test(data.system) ? '有' : '**没有**'));
  console.log('有没有逐子走子规则（兵不能后退等）：' +
    (/永远不能后退/.test(data.system) ? '有' : '**没有**'));
  console.log('提示词里有没有战术参考：' +
    (/【战术参考/.test(u) ? '有（' + (data.meta.knowledge || {}).motifs.join('、') + '）' : '没有'));

  // 粗略估个 token 数：中文大约 1 字 ≈ 1 token，英文/符号更省。够用来判断量级。
  const total = data.system.length + u.length;
  console.log('');
  console.log('提示词总长度：' + total + ' 字符' +
    '（system ' + data.system.length + ' + user ' + u.length + '，约 ' +
    Math.round(total / 2.2) + ' token）');
  console.log('meta：' + JSON.stringify(data.meta));
  console.log('');
})().catch((e) => {
  console.error('💥 出错了：', e.message);
  console.log('   （服务器在跑吗？在项目目录里 npm start 就能起来。）');
  process.exit(1);
});
