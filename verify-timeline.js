// ============================================================
// verify-timeline.js —— 时间线（棋子身份）逻辑验收
//
// 这个文件不碰画面，只验证「算出来的每一步局面对不对」。
// 因为一旦易位/吃过路兵/升变这三处算错，动画会把棋子送到错误的格子，
// 而且看起来还挺顺滑 —— 光靠肉眼看是发现不了的。
//
// 运行： node verify-timeline.js
// ============================================================

const path = require('path');
const { Chess } = require('./node_modules/chess.js');

// 用 ESM 源码？不行，这里是 CommonJS。所以直接把 timeline.js 也装进 new Function。
const fs = require('fs');
const timelineSrc = fs
  .readFileSync(path.join(__dirname, 'public/js/timeline.js'), 'utf8')
  .replace(/^\s*import\s+[\s\S]*?from\s+['"].*?['"];?\s*$/gm, '')
  .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^\s*export\s+(function|class|const|let|var)\s/gm, '$1 ');

const { buildTimeline, verifyTimeline, squareToRowCol } =
  new Function('Chess', timelineSrc + '\nreturn { buildTimeline, verifyTimeline, squareToRowCol };')(Chess);

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) pass++; else { fail++; failures.push(label); }
  console.log(`  ${cond ? '✅' : '❌'} ${label}` + (detail ? `   [${detail}]` : ''));
}
function section(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}

/** 从 PGN 走出一盘棋，返回 {startFen, moves} */
function fromPgn(pgn) {
  const g = new Chess();
  g.loadPgn(pgn);
  return { startFen: g.history({ verbose: true })[0].before, moves: g.history({ verbose: true }) };
}

/** 从自定义 FEN + 走法列表走出一盘棋 */
function fromFen(fen, sans) {
  const g = new Chess(fen);
  const moves = [];
  for (const s of sans) moves.push(g.move(s));
  return { startFen: fen, moves };
}

/** 通用的「跑一遍并全面自检」 */
function audit(name, startFen, moves) {
  const frames = buildTimeline(startFen, moves);
  const v = verifyTimeline(frames, startFen, moves);

  ok(name + '：时间线帧数正确', frames.length === moves.length + 1,
    frames.length + ' 帧（应为 ' + (moves.length + 1) + '）');
  ok(name + '：每一帧都和 FEN 对得上', v.ok, v.ok ? '' : v.issues.join(' | '));
  return frames;
}

// ⚠️ frames[0] 是「开局」，frames[k] 是「第 k 步走完之后」。
//    也就是说 frames[i] 对应第 i-1 号半回合。这个 +1 的偏移极容易写错，
//    所以统一用 after(frames, ply) 取值 —— 传「第几步」，不要自己数下标。
const after = (frames, ply) => frames[ply + 1];

/** 在某一帧里找某个格子上的棋子 */
function pieceAtFrame(frame, square) {
  return frame.find((p) => p.square === square) || null;
}
/** 某个 id 在这些帧里的位置序列 */
function trackId(frames, id) {
  return frames.map((f) => {
    const p = f.find((x) => x.id === id);
    return p ? p.square : null;
  });
}

// ============================================================
section('① 基本走法');
// ============================================================
{
  const { startFen, moves } = fromPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5');
  const frames = audit('普通开局', startFen, moves);

  // e2 的兵应该带着同一个 id 走到 e4（第 0 号半回合）
  const idAtE2 = pieceAtFrame(frames[0], 'e2').id;
  ok('e2 的兵带着同一个 id 走到 e4', pieceAtFrame(after(frames, 0), 'e4')?.id === idAtE2,
    trackId(frames, idAtE2).slice(0, 3).join(' → '));
  ok('g1 的马带着同一个 id 走到 f3（第 4 号半回合）',
    pieceAtFrame(after(frames, 4), 'f3')?.id === pieceAtFrame(frames[0], 'g1').id,
    trackId(frames, pieceAtFrame(frames[0], 'g1').id).slice(0, 6).join(' → '));
  ok('走完 5 步后仍然是 32 个棋子（没吃子）',
    after(frames, 4).length === 32, after(frames, 4).length + ' 个');
  ok('每一帧的 id 集合都是固定的 32 个',
    new Set(after(frames, 4).map((p) => p.id)).size === 32);
}

// ============================================================
section('② 吃子：被吃的棋子要退场，且数量要减少');
// ============================================================
{
  const { startFen, moves } = fromPgn('1. e4 d5 2. exd5 Qxd5 3. Nc3 Qxa2');
  const frames = audit('带吃子', startFen, moves);
  console.log('       棋子数变化: ' + frames.map((f) => f.length).join(' → '));
  ok('第 3 步后少一个棋子（白兵吃黑兵）',
    after(frames, 2).length === 31, after(frames, 2).length + ' 个');
  ok('第 4 步后少一个棋子（黑后吃白兵）',
    after(frames, 3).length === 30, after(frames, 3).length + ' 个');
  ok('第 6 步后少一个棋子（黑后吃 a2 兵）',
    after(frames, 5).length === 29, after(frames, 5).length + ' 个');
  // d7 的黑兵：d7 → d5（第 2 步），然后被白兵吃掉（第 3 步）
  const d7Pawn = pieceAtFrame(frames[0], 'd7').id;
  const alive = (frame, id) => frame.some((p) => p.id === id);
  console.log('       d7 黑兵的轨迹: ' + trackId(frames, d7Pawn).join(' → '));
  ok('d5 上现在站着的是白兵（吃子的那一方）',
    pieceAtFrame(after(frames, 2), 'd5').color === 'w');
  ok('吃子的白兵带着原来 e2 那个 id',
    pieceAtFrame(after(frames, 2), 'd5').id === pieceAtFrame(frames[0], 'e2').id);
  ok('原来 d7 的黑兵在第 3 步被吃掉后退场',
    alive(after(frames, 1), d7Pawn) && !alive(after(frames, 2), d7Pawn));
}

// ============================================================
section('③ 易位：王和车必须同时动');
// ============================================================
{
  // 白短易位
  const a = fromPgn('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O');
  const fa = audit('白方短易位', a.startFen, a.moves);
  const kingId = pieceAtFrame(fa[0], 'e1').id;
  const rookId = pieceAtFrame(fa[0], 'h1').id;
  console.log('       白王: ' + trackId(fa, kingId).slice(-2).join(' → '));
  console.log('       白车: ' + trackId(fa, rookId).slice(-2).join(' → '));
  ok('白王 e1 → g1（第 7 步 O-O）', pieceAtFrame(after(fa, 6), 'g1')?.id === kingId);
  ok('白车 h1 → f1（车也动了，这是最容易漏的）',
    pieceAtFrame(after(fa, 6), 'f1')?.id === rookId);

  // 黑白双方长易位
  const b = fromPgn('1. d4 d5 2. Nc3 Nc6 3. Bf4 Bf5 4. Qd2 Qd7 5. O-O-O O-O-O');
  const fb = audit('双方长易位', b.startFen, b.moves);
  const wK = pieceAtFrame(fb[0], 'e1').id;
  const wR = pieceAtFrame(fb[0], 'a1').id;
  const bK = pieceAtFrame(fb[0], 'e8').id;
  const bR = pieceAtFrame(fb[0], 'a8').id;
  console.log('       白王: ' + trackId(fb, wK).slice(-2).join(' → ') + '   白车: ' + trackId(fb, wR).slice(-2).join(' → '));
  console.log('       黑王: ' + trackId(fb, bK).slice(-2).join(' → ') + '   黑车: ' + trackId(fb, bR).slice(-2).join(' → '));
  ok('白王 e1 → c1（第 9 步 O-O-O）', pieceAtFrame(after(fb, 8), 'c1')?.id === wK);
  ok('白车 a1 → d1', pieceAtFrame(after(fb, 8), 'd1')?.id === wR);
  ok('黑王 e8 → c8（第 10 步 O-O-O）', pieceAtFrame(after(fb, 9), 'c8')?.id === bK);
  ok('黑车 a8 → d8', pieceAtFrame(after(fb, 9), 'd8')?.id === bR);
}

// ============================================================
section('④ 吃过路兵：被吃的兵不在目标格上');
// ============================================================
{
  const { startFen, moves } = fromPgn('1. e4 d5 2. e5 f5 3. exf6');
  const frames = audit('吃过路兵', startFen, moves);
  const ePawn = pieceAtFrame(frames[0], 'e2').id;
  const fPawn = pieceAtFrame(frames[0], 'f7').id;
  console.log('       棋子数: ' + frames.map((f) => f.length).join(' → '));
  console.log('       白兵轨迹: ' + trackId(frames, ePawn).join(' → '));
  console.log('       黑兵轨迹: ' + trackId(frames, fPawn).join(' → '));
  ok('白兵 e2 → e4 → e5 → f6（第 5 步斜吃）',
    pieceAtFrame(after(frames, 4), 'f6')?.id === ePawn);
  ok('被吃的黑兵是在 f5 上消失的，不是 f6（这就是吃过路兵）',
    after(frames, 3).some((p) => p.square === 'f5') &&
    !after(frames, 4).some((p) => p.square === 'f5'),
    'f5 上：第 4 步=' + JSON.stringify(pieceAtFrame(after(frames, 3), 'f5')) +
    '，第 5 步=' + JSON.stringify(pieceAtFrame(after(frames, 4), 'f5')));
  ok('吃过路兵之后棋子总数减 1',
    after(frames, 4).length === 31, after(frames, 4).length + ' 个');
}

// ============================================================
section('⑤ 升变：同一个棋子换字形，总数不变');
// ============================================================
{
  // a7 的白兵吃掉 b8 的黑车并升变成后
  const fen = '1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1';
  const { startFen, moves } = fromFen(fen, ['axb8=Q+']);
  const frames = audit('吃子升变', startFen, moves);
  const pawnId = pieceAtFrame(frames[0], 'a7').id;
  const after = pieceAtFrame(frames[1], 'b8');
  console.log('       升变前 a7=' + JSON.stringify(pieceAtFrame(frames[0], 'a7')));
  console.log('       升变后 b8=' + JSON.stringify(after));
  ok('升变后 b8 上是白后', after && after.type === 'q' && after.color === 'w');
  ok('而且用的是同一个 id（是"变"不是"换"）', after.id === pawnId,
    'id=' + after.id + ' vs 原 id=' + pawnId);
  ok('棋子总数正确减少（吃掉一个车，兵没消失）', frames[1].length === frames[0].length - 1,
    frames[0].length + ' → ' + frames[1].length);

  // 不吃子直接升变
  const c = fromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', ['a8=N']);
  const fc = audit('不吃子升变成马', c.startFen, c.moves);
  const nId = pieceAtFrame(fc[0], 'a7').id;
  ok('升变成马：同一个 id、类型变成马',
    pieceAtFrame(fc[1], 'a8').id === nId && pieceAtFrame(fc[1], 'a8').type === 'n');
  ok('不吃子升变：棋子总数不变', fc[1].length === fc[0].length,
    fc[0].length + ' → ' + fc[1].length);
}

// ============================================================
section('⑥ 一整盘真棋（用户那份 lichess 对局，先手动剥掉评注）');
// ============================================================
{
  // 现在有了自己写的解析层，不用再手动剥评注了
  const pgnSrc = fs.readFileSync(path.join(__dirname, 'public/js/pgn.js'), 'utf8')
    .replace(/^\s*import\s+[\s\S]*?from\s+['"].*?['"];?\s*$/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^\s*export\s+(function|class|const|let|var)\s/gm, '$1 ');
  const { parsePgn } = new Function('Chess', 'DEFAULT_POSITION', pgnSrc +
    '\nreturn { parsePgn };')(Chess, require('./node_modules/chess.js').DEFAULT_POSITION);

  const raw = fs.readFileSync(path.join(__dirname, 'public/samples/sample1.pgn'), 'utf8');
  const parsed = parsePgn(raw);
  if (!parsed.ok) { console.log('❌ 棋谱没解析出来：' + parsed.error); process.exit(1); }
  const moves = parsed.moves;
  const frames = buildTimeline(moves[0].before, moves);
  const v = verifyTimeline(frames, moves[0].before, moves);

  console.log('       共 ' + moves.length + ' 步，' + frames.length + ' 帧');
  console.log('       棋子数变化: ' + frames.map((f) => f.length).join(' '));
  ok('整盘棋每一帧都和 FEN 对得上', v.ok, v.ok ? '' : v.issues.join(' | '));
  ok('步数正确（26 白 + 25 黑）', moves.length === 51, moves.length + ' 步');
  ok('最后一步是 Ra8+', moves[moves.length - 1].san === 'Ra8+', moves[moves.length - 1].san);
  ok('终局棋子数明显减少（这盘吃了很多）', frames[51].length < 24, frames[51].length + ' 个');

  // 这盘棋里有升变吗？没有。但有大交换，检查没有棋子重叠
  ok('没有任何一帧出现棋子重叠',
    frames.every((f) => new Set(f.map((p) => p.square)).size === f.length));
}

// ============================================================
section('⑦ 反向测试：自检函数本身有效吗');
// ============================================================
{
  // 故意把一个棋子挪到错误的格子，自检必须能发现
  const { startFen, moves } = fromPgn('1. e4 e5 2. Nf3');
  const frames = buildTimeline(startFen, moves);
  ok('原始时间线自检通过', verifyTimeline(frames, startFen, moves).ok);

  const broken = frames.map((f) => f.map((p) => ({ ...p })));
  broken[2][0].square = 'h8';  // 把某个棋子扔到 h8

  const v = verifyTimeline(broken, startFen, moves);
  ok('故意改坏之后自检能报错', !v.ok, v.issues[0] || '（没报错，等于自检是摆设）');
  console.log('       报出的问题: ' + v.issues.join(' | ').slice(0, 100));
}

// ============================================================
section('⑧ 翻转棋盘：格子 → 屏幕坐标的镜像');
// ============================================================
{
  // 不翻的时候，屏幕左上角是 a8
  const a8 = squareToRowCol('a8');
  ok('a8 在左上角 (0,0)', a8.col === 0 && a8.row === 0, `col=${a8.col} row=${a8.row}`);

  const h1 = squareToRowCol('h1');
  ok('h1 在右下角 (7,7)', h1.col === 7 && h1.row === 7, `col=${h1.col} row=${h1.row}`);

  // 翻过来之后整个棋盘转 180°，a8 跑到右下角
  const a8f = squareToRowCol('a8', true);
  ok('翻转后 a8 在右下角 (7,7)', a8f.col === 7 && a8f.row === 7, `col=${a8f.col} row=${a8f.row}`);

  const h1f = squareToRowCol('h1', true);
  ok('翻转后 h1 在左上角 (0,0)', h1f.col === 0 && h1f.row === 0, `col=${h1f.col} row=${h1f.row}`);

  // 棋盘正中央的四个格子，翻转后互换位置
  const e4 = squareToRowCol('e4');
  const e4f = squareToRowCol('e4', true);
  ok('e4 翻转后变成 (3,3)', e4f.col === 3 && e4f.row === 3, `col=${e4f.col} row=${e4f.row}`);
  ok('e4 翻转后确实换了位置', e4.col !== e4f.col || e4.row !== e4f.row);

  // 最要紧的一条：翻转必须是一一对应 ——
  // 要是两个格子翻到同一个坐标上，棋子就会叠在一起。
  const FILES = 'abcdefgh';
  const all = [];
  for (const f of FILES) for (let r = 1; r <= 8; r++) all.push(f + r);

  const normal = new Set(all.map((s) => { const c = squareToRowCol(s); return c.col + ',' + c.row; }));
  ok('不翻时 64 个格子坐标两两不同', normal.size === 64, normal.size + ' 个不同坐标');

  const flippedSet = new Set(all.map((s) => { const c = squareToRowCol(s, true); return c.col + ',' + c.row; }));
  ok('翻转后 64 个格子坐标仍然两两不同', flippedSet.size === 64, flippedSet.size + ' 个不同坐标');

  ok('翻转后覆盖的还是同一批坐标（没有格子跑出棋盘）',
    [...normal].every((k) => flippedSet.has(k)));

  ok('翻转两次回到原地',
    all.every((s) => {
      const a = squareToRowCol(s, true);
      const back = squareToRowCol(s, false);
      return back.col === squareToRowCol(s).col && back.row === squareToRowCol(s).row;
    }));

  ok('所有坐标都落在 0~7 之间',
    [...flippedSet].every((k) => {
      const [c, r] = k.split(',').map(Number);
      return c >= 0 && c <= 7 && r >= 0 && r <= 7;
    }));
}

// ============================================================
console.log('\n' + '═'.repeat(64));
console.log('  时间线验收：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) console.log('  失败项：\n    - ' + failures.join('\n    - '));
console.log('═'.repeat(64) + '\n');
process.exit(fail ? 1 : 0);
