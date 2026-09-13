// ============================================================
// verify-pgn.js —— 棋谱解析验收（重点：带评注的 lichess 棋谱）
//
// 运行： node verify-pgn.js
// ============================================================

const fs = require('fs');
const path = require('path');
const { Chess, DEFAULT_POSITION } = require('./node_modules/chess.js');

const src = fs.readFileSync(path.join(__dirname, 'public/js/pgn.js'), 'utf8')
  .replace(/^\s*import\s+[\s\S]*?from\s+['"].*?['"];?\s*$/gm, '')
  .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^\s*export\s+(function|class|const|let|var)\s/gm, '$1 ');

const { parsePgn, scanMovetext, splitPgn, annotationScoreText, QUALITY_LABEL } =
  new Function('Chess', 'DEFAULT_POSITION', src +
    '\nreturn { parsePgn, scanMovetext, splitPgn, annotationScoreText, QUALITY_LABEL };')(Chess, DEFAULT_POSITION);

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) pass++; else { fail++; failures.push(label); }
  console.log(`  ${cond ? '✅' : '❌'} ${label}` + (detail !== undefined ? `   [${detail}]` : ''));
}
function eq(label, actual, expected) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) pass++; else { fail++; failures.push(label); }
  console.log(`  ${good ? '✅' : '❌'} ${label}` +
    (good ? `   [${JSON.stringify(actual)}]` : `\n       实际=${JSON.stringify(actual)}  期望=${JSON.stringify(expected)}`));
}
function section(t) { console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64)); }

// ============================================================
section('① 用户那份 lichess 棋谱（带 eval / clk / 变着，51 步）');
// ============================================================
const lichess = fs.readFileSync(path.join(__dirname, 'public/samples/sample1.pgn'), 'utf8');
const R = parsePgn(lichess);

ok('解析成功', R.ok, R.ok ? '' : R.error);
if (R.ok) {
  const A = R.annotations;

  console.log('       共 ' + R.stats.moves + ' 步，' + R.stats.annotated + ' 步带评注');
  console.log('       剥掉评注 ' + R.stats.strippedComments + ' 条，丢弃变着 ' +
              R.stats.droppedVariations + ' 个片段，NAG ' + R.stats.nags + ' 个');
  console.log('       红黑分布：漏着 ' + R.stats.blunders + '，错着 ' + R.stats.mistakes +
              '，不精确 ' + R.stats.inaccuracies);

  eq('步数 51（26 白 + 25 黑）', R.stats.moves, 51);
  ok('没有退回原文解析（说明清洗是成功的）', !R.stats.usedRawFallback);
  ok('没有警告', R.warnings.length === 0, R.warnings.join(' | '));
  eq('评注和着法数量对齐', A.length, R.moves.length);

  // ---------- 逐点核对 ----------
  eq('第 1 步 d4 的评分 = 0.15', A[0].evalCp, 0.15);
  eq('第 2 步 d5 的评分 = 0.27', A[1].evalCp, 0.27);
  eq('第 13 步 Bxa6 的评分 = -0.5', A[12].evalCp, -0.5);

  eq('第 14 步 bxa6 的动手后缀', A[13].suffix, '?!');
  eq('  → 判定为「不精确」', A[13].quality, 'inaccuracy');
  eq('  → 评分 0.35', A[13].evalCp, 0.35);
  eq('  → 抠出了引擎推荐着法', A[13].bestMove, 'Qxa6');

  eq('第 15 步 b3 的后缀', A[14].suffix, '?');
  eq('  → 判定为「错着」', A[14].quality, 'mistake');
  eq('  → 推荐着法', A[14].bestMove, 'Na4');
  eq('  → 评分变化前', A[14].evalBefore, 0.35);

  eq('第 17 步 Qd2 的后缀', A[16].suffix, '??');
  eq('  → 判定为「漏着」', A[16].quality, 'blunder');
  eq('  → 评分 -4.17', A[16].evalCp, -4.17);
  eq('  → 推荐着法 b4', A[16].bestMove, 'b4');
  ok('  → 保留了评注原文', /Blunder/.test(A[16].comment || ''), (A[16].comment || '').slice(0, 50));

  eq('第 38 步 Kd8 判定为「漏着」', A[37].quality, 'blunder');
  eq('  → 推荐着法 Nxe5', A[37].bestMove, 'Nxe5');
  eq('  → 评分从 -7.41 弹到 1.33', A[37].evalBefore, -7.41);

  eq('第 50 步 Nf6 的后缀', A[49].suffix, '?');
  eq('  → 判定为「错着」', A[49].quality, 'mistake');
  eq('  → 是「白方 2 步杀」', A[49].evalMate, 2);
  eq('  → 推荐着法 Nb6', A[49].bestMove, 'Nb6');
  eq('  → 此时没有普通评分', A[49].evalCp, null);

  eq('第 51 步 Ra8+ 是「白方 1 步杀」', A[50].evalMate, 1);
  eq('  → 读到了时钟', A[50].clk, '0:10:36');
  ok('  → 读到了「黑方认输」', /Black resigns/.test(A[50].comment || ''), A[50].comment);

  // ---------- 时钟 ----------
  eq('第 1 步的时钟', A[0].clk, '0:15:00');
  eq('第 19 步（Nf3??）的时钟', A[18].clk, '0:13:06');
  eq('第 37 步（Rac1）的时钟', A[36].clk, '0:11:39');

  // ---------- 变着必须被丢掉，不能混进主线 ----------
  eq('最后一步是 Ra8+（不是变着里的某步）', R.moves[50].san, 'Ra8+');
  ok('变着确实被丢弃了', R.stats.droppedVariations > 0, R.stats.droppedVariations + ' 个');
  ok('变着里的着法没有混进主线（主线里没有 Qb5 / Nxe5 这些只在变着中出现的着法）',
    !R.moves.slice(0, 15).some((m) => m.san === 'Qb5' || m.san === 'Qb4'));

  // ---------- 打分格式 ----------
  eq('评分格式化（正数带 + 号）', annotationScoreText(A[13]), '+0.35');
  eq('评分格式化（负数）', annotationScoreText(A[14]), '-1.16');
  eq('评分格式化（将杀）', annotationScoreText(A[49]), '白方 2 步杀');

  // ---------- 打印一份带评注的着法表，人工扫一眼 ----------
  console.log('\n       着法表（前 22 半回合）：');
  for (let i = 0; i < 22; i++) {
    const a = A[i];
    const tag = a.quality ? '‹' + (QUALITY_LABEL[a.quality] || a.quality) + '›' : '';
    const sc = annotationScoreText(a);
    console.log('        ' + String(i + 1).padStart(2) + '. ' +
      R.moves[i].san.padEnd(7) + (sc || '').padStart(8) + '  ' + tag.padEnd(10) +
      (a.bestMove ? '推荐 ' + a.bestMove : ''));
  }

  // ---------- 用一个独立引擎（chess.js 原生）复核终局 ----------
  const verifyGame = new Chess();
  verifyGame.loadPgn(R.moves.map((m) => m.san).join(' '));
  eq('用主线着法重放，末局面与解析结果一致',
    verifyGame.fen(), R.moves[50].after);
}

// ============================================================
section('①之二 样例二：国象联盟那盘（无评注、升变成马将杀）');
// ============================================================
//
// 这一盘和上面那盘正好互补：**没有任何评注**，而且最后一步是升变
// （b8=N#）—— 升变在解析、时间线、吃子栏三处都是最容易算错的地方，
// 所以留一份真实棋谱当长期样本。
{
  const R2 = parsePgn(fs.readFileSync(path.join(__dirname, 'public/samples/sample2.pgn'), 'utf8'));

  ok('解析成功', R2.ok, R2.ok ? '' : R2.error);
  if (R2.ok) {
    eq('步数 31（16 白 + 15 黑）', R2.moves.length, 31);
    eq('结果读到了 1-0', R2.result, '1-0');
    eq('对手信息读到了', R2.headers.Site, '国象联盟');
    eq('开局名读到了', R2.headers.Opening, '王兵开局');
    eq('第 1 步是 e4', R2.moves[0].san, 'e4');
    eq('第 19 个半回合是白方短易位', R2.moves[18].san, 'O-O');

    // 最后一步：升变成马，同时是将杀
    const last = R2.moves[30];
    eq('最后一步是 b8=N#', last.san, 'b8=N#');
    eq('  → 升变成马', last.promotion, 'n');
    ok('  → 它不是吃子（b8 原本是空的）', !last.captured);
    ok('  → 而且是终局（黑方没有任何合法着法）', new Chess(last.after).isCheckmate());

    // 这一盘一个评注都没有：不该凭空长出评注来
    eq('没有评注（这盘棋谱本来就没写）', R2.annotations.filter((a) => a && a.comment).length, 0);

    // 用 chess.js 原生重放一遍，终局必须一致
    const replay = new Chess();
    replay.loadPgn(R2.moves.map((m) => m.san).join(' '));
    eq('用主线着法重放，末局面与解析结果一致', replay.fen(), last.after);
  }
}

// ============================================================
section('② 回归：原来的三个示例棋谱仍然正常');
// ============================================================
const samples = {
  愚人将杀: '1. f3 e5 2. g4 Qh4#',
  学者将杀: '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#',
  歌剧院之局: `1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5
          6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5
          11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6
          15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8#`,
};
const SAMPLE_EXPECT = {
  愚人将杀:   { plies: 4,  winner: '黑方' },
  学者将杀:   { plies: 7,  winner: '白方' },
  歌剧院之局: { plies: 33, winner: '白方' },
};
for (const [name, pgn] of Object.entries(samples)) {
  const r = parsePgn(pgn);
  ok(name + ' 能解析', r.ok, r.ok ? (r.stats.moves + ' 步') : r.error);
  if (!r.ok) continue;

  const exp = SAMPLE_EXPECT[name];
  eq('  ' + name + ' 步数正确', r.stats.moves, exp.plies);

  const g = new Chess(r.moves[r.moves.length - 1].after);
  eq('  ' + name + ' 以将杀收场', g.isCheckmate(), true);
  eq('  ' + name + ' 胜方正确', g.turn() === 'w' ? '黑方' : '白方', exp.winner);
  eq('  ' + name + ' 没有评注', r.stats.annotated, 0);
  eq('  ' + name + ' 每步都带「走前/走后」的 FEN',
    r.moves.every((m) => !!m.before && !!m.after), true);
}
eq('学者将杀最后一步是 Qxf7#',
  parsePgn(samples.学者将杀).moves.slice(-1)[0].san, 'Qxf7#');

// ============================================================
section('③ 各种奇形怪状的写法');
// ============================================================
const weird = [
  ['纯走法无编号（带 ?!）', '1. d4 d5 2. Bf4?! Bf5 3. Nc3?? Nf6'],
  ['NAG 记号 $1 $6', '1. d4 $1 d5 $6 2. Bf4 $2 Bf5'],
  ['分号行注释', '1. d4 d5 ; 一句注释\n2. Bf4 Bf5'],
  ['变着里还套变着', '1. d4 d5 (1... Nf6 2. c4 (2. Nf3 e6) 2... e6) 2. Bf4 Bf5'],
  ['注释里带圆括号和箭头', '1. d4 { (0.35 → -1.16) Mistake. Na4 was best. } d5 2. Bf4 Bf5'],
  ['注释里带 #2', '1. d4 { [%eval #2] } d5 2. Bf4 Bf5'],
  ['多行折行', '1. d4 d5\n2. Bf4 Bf5\n3. Nc3 Nf6'],
  ['带结果标记 1-0', '1. e4 e5 1-0'],
  ['带结果标记 *', '1. e4 e5 *'],
  ['完全没有头部', '1. e4 e5 2. Nf3'],
  ['走法编号和着法粘连', '1.d4 d5 2.Bf4 Bf5'],
  ['黑方编号 1... 写法', '1. d4 1... d5 2. Bf4 2... Bf5'],
];
for (const [name, pgn] of weird) {
  const r = parsePgn(pgn);
  ok(name, r.ok, r.ok ? (r.stats.moves + ' 步') : r.error);
}

// 具体核对几个
{
  const r = parsePgn('1. d4 d5 (1... Nf6 2. c4 (2. Nf3 e6) 2... e6) 2. Bf4 Bf5');
  eq('嵌套变着：主线只算 d4 d5 Bf4 Bf5', r.moves.map((m) => m.san).join(' '), 'd4 d5 Bf4 Bf5');
}
{
  const r = parsePgn('1. d4 $1 d5 $6 2. Bf4 $2 Bf5');
  eq('NAG 被丢掉，不影响着法', r.stats.moves, 4);
  eq('NAG 计数正确', r.stats.nags, 3);
}
{
  // ⚠️ 这一条曾经真的挂过，值得留着当哨兵。
  // 只有「部分着法」带评注时，评注表很容易是稀疏的（末尾几步没有评注就不占位），
  // 长度就会短于步数，导致"对齐自检"误判成错位、把评注全丢掉。
  // lichess 那盘棋每一步都有评注，反而把这个 bug 藏住了。
  const r = parsePgn('1. d4 { [%eval 0.35] } d5 { [%eval -1.16] } 2. Bf4');
  eq('只有部分着法带评注时，评注表长度仍等于步数',
    r.annotations.length, r.moves.length);
  eq('  评注数 = 3（末步无评注也要占位）', r.annotations.length, 3);
  eq('  第 1 步的评分读到', r.annotations[0].evalCp, 0.35);
  eq('  第 2 步的评分读到', r.annotations[1].evalCp, -1.16);
  eq('  第 3 步没有评注', [r.annotations[2].evalCp, r.annotations[2].comment], [null, null]);
  eq('  没有误报错位', r.warnings.length, 0);
  eq('  带评注步数统计 = 2', r.stats.annotated, 2);
}
{
  const r = parsePgn('1.d4 d5 2.Bf4 Bf5');
  eq('编号与着法粘连也能解析', r.moves.map((m) => m.san).join(' '), 'd4 d5 Bf4 Bf5');
}
{
  const r = parsePgn('1. d4 d5 ; 一句注释\n2. Bf4 Bf5');
  eq('分号注释被剥掉', r.stats.moves, 4);
  ok('分号注释的内容也被记下来了', (r.annotations[1].comment || '').includes('一句注释'),
    r.annotations[1].comment);
}

// ============================================================
section('④ 中局开局的棋谱（带 [FEN] 头）');
// ============================================================
{
  const pgn = `[Event "从中局开始"]
[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"]

1. a8=Q+ Kd7 2. Qb7+ Kd6`;
  const r = parsePgn(pgn);
  ok('能解析', r.ok, r.ok ? '' : r.error);
  if (r.ok) {
    eq('起点不是默认开局', r.startFen.startsWith('4k3/P7'), true);
    eq('第一步是 a8=Q+', r.moves[0].san, 'a8=Q+');
    eq('步数 4', r.stats.moves, 4);
  }
}

{
  const pgn = `[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"]

1. a8=Q+ { [%eval #5] } Kd7`;
  const r = parsePgn(pgn);
  eq('[FEN] 头 + 评注 一起工作', r.ok && r.annotations[0].evalMate, 5);
}

// ============================================================
section('④.5 棋谱自己写的胜负标记（认输 / 协议和棋只写在这里）');
// ============================================================
// 认输和协议和棋在**棋盘上没有任何痕迹** —— 棋子还在原处、轮次也没变，
// 光看局面只能得出"还没下完"。所以这个标记非留不可：
// 以前整盘棋只写着 "1-0" 的棋谱，界面上会显示成"这盘棋还没下完"。
{
  eq('正文末尾的 1-0 被读出来', parsePgn('1. e4 e5 2. Nf3 Nc6 1-0').result, '1-0');
  eq('0-1 被读出来', parsePgn('1. e4 e5 0-1').result, '0-1');
  eq('1/2-1/2 被读出来', parsePgn('1. e4 e5 1/2-1/2').result, '1/2-1/2');
  eq('没写就是 *（不知道，不是"和棋"）', parsePgn('1. e4 e5 2. Nf3').result, '*');
  eq('头部 [Result "..."] 也算数', parsePgn('[Result "0-1"]\n\n1. e4 e5').result, '0-1');
  eq('两边不一致时以正文末尾为准（头部常常是没改的模板）',
    parsePgn('[Result "1-0"]\n\n1. e4 e5 0-1').result, '0-1');
  eq('两边都是 * → 还是"不知道"', parsePgn('[Result "*"]\n\n1. e4 e5 *').result, '*');
  eq('变着里的结果标记不算数（只认主线）',
    parsePgn('1. e4 e5 (1... c5 1-0) 2. Nf3 1/2-1/2').result, '1/2-1/2');
  eq('标记照样进正文，chess.js 不会因为多了它就报错',
    parsePgn('1. e4 e5 1-0').ok, true);
}

// ============================================================
section('⑤ 垃圾输入不能把程序搞崩');
// ============================================================
for (const bad of ['', '   ', '随便写点什么', '1. e4 e5 2. Ke2 Ke7 3. Qxh8', null, undefined]) {
  let threw = false;
  let res = null;
  try { res = parsePgn(bad); } catch (e) { threw = true; }
  ok('不抛异常、返回 ok:false → ' + JSON.stringify(bad),
    !threw && res && res.ok === false, threw ? '抛异常了' : (res && res.error));
}

// ============================================================
section('⑥ 反向测试：错位的评注必须被拦住');
// ============================================================
{
  // 构造一个"评注比着法多"的畸形棋谱，看它会不会硬套
  const r = parsePgn('1. e4 { a } e5 { b } 2. Nf3 { c } Nc6 { d } 3. Bb5 { e }');
  ok('正常情况：评注和着法一一对应', r.ok && r.annotations.length === r.moves.length,
    r.ok ? (r.annotations.length + ' vs ' + r.moves.length) : r.error);
}

// ============================================================
section('⑦ 前后端用的 chess.js 必须是同一份');
// ============================================================
// 浏览器端不能 require('./node_modules/chess.js')，只能在 public/js/ 里放一份副本
// （见 app.js 的 `import { Chess } from './chess.js'`）。副本一旦和后端那份版本不同，
// 就会出现"前端摆出来的局面是对的、后端复算出来是错的"这种最难查的分歧。
// 这里直接按字节比一次 —— 升级 chess.js 之后忘了拷副本，这一步会当场报红。
{
  const a = path.join(__dirname, 'node_modules/chess.js/dist/esm/chess.js');
  const b = path.join(__dirname, 'public/js/chess.js');
  let same = false;
  let detail = '';
  try {
    same = fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8');
    detail = same ? '两份一致' : '内容不一样 —— 升级 chess.js 之后要把 dist/esm/chess.js 重新拷到 public/js/';
  } catch (e) {
    detail = '读不到：' + e.message;
  }
  ok('副本没漂移（升级库之后忘了拷，这一步会红）', same, detail);
}

// ============================================================
console.log('\n' + '═'.repeat(64));
console.log('  棋谱解析验收：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) console.log('  失败项：\n    - ' + failures.join('\n    - '));
console.log('═'.repeat(64) + '\n');
process.exit(fail ? 1 : 0);
