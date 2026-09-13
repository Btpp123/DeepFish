// ============================================================
// app.js —— 主逻辑
//
//   1. 把 PGN 棋谱解析成一串着法
//   2. 把棋盘画出来，能一步步往前、往后翻
//   3. 把当前局面发给后端，让鳕鱼分析，并显示结果
// ============================================================

import { Chess, DEFAULT_POSITION } from './chess.js';
import { createBoard, PIECE_GLYPH } from './board.js';
import { buildTimeline, verifyTimeline, captureLedger } from './timeline.js';
import { parsePgn, annotationScoreText, annotationSide, QUALITY_LABEL } from './pgn.js';
import {
  createEvalBar, createEvalCurve,
  normFromScore, compactScore, sideOf, terminalScore, gapVsBest,
} from './eval.js';

// ---------- 页面上要用到的元素 ----------
const boardEl      = document.getElementById('board');
const movesBody    = document.getElementById('movesBody');
const movesWrapEl  = document.getElementById('movesWrap');
const pgnInput     = document.getElementById('pgnInput');
const statusEl     = document.getElementById('status');
const msgEl        = document.getElementById('message');
const moveCounter  = document.getElementById('moveCounter');
const moveNoteEl   = document.getElementById('moveNote');
const ledgerEl     = document.getElementById('ledger');
const btnAnalyze   = document.getElementById('btnAnalyze');
const depthSelect  = document.getElementById('depthSelect');
const engineTag    = document.getElementById('engineTag');
const analysisBody = document.getElementById('analysisBody');
const evalPanelEl  = document.getElementById('evalPanel');
const evalBarEl    = document.getElementById('evalBar');
const evalProgEl   = document.getElementById('evalProgress');
const optCurve     = document.getElementById('optCurve');
const optBar       = document.getElementById('optBar');
const optMoveEval  = document.getElementById('optMoveEval');
const optArrow     = document.getElementById('optArrow');
const scanDepthSel = document.getElementById('scanDepthSelect');
const btnFlip      = document.getElementById('btnFlip');
const btnExplain   = document.getElementById('btnExplain');
const llmTag       = document.getElementById('llmTag');
const coachBody    = document.getElementById('coachBody');
const subtitleEl   = document.getElementById('subtitle');

// ---------- 直接在棋盘上走棋、以及"你走的支线"要用到的元素 ----------
const playHintEl     = document.getElementById('playHint');
const promoPickerEl  = document.getElementById('promoPicker');
const branchBlockEl  = document.getElementById('branchBlock');
const branchListEl   = document.getElementById('branchList');
const exportPanelEl  = document.getElementById('exportPanel');
const exportTextEl   = document.getElementById('exportText');
const loadGuardEl    = document.getElementById('loadGuard');

// 局势条和评估曲线。这两个是「画布」，建一次，之后只改里面的内容。
const evalBar   = createEvalBar(evalBarEl);
const evalCurve = createEvalCurve(document.getElementById('evalCurve'));

// 曲线上第 k 个点是「第 k 步走完之后」，所以点它要跳到第 k-1 步
evalCurve.onPick((ply) => goTo(ply - 1));

// ---------- 几个「示例棋谱」----------
const SAMPLES = {
  fool:    { pgn: '1. f3 e5 2. g4 Qh4#' },
  scholar: { pgn: '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#' },
  opera: {
    pgn: `1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5
          6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5
          11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6
          15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8#`,
  },
  // ---------- 三个"大"样例：开发和验收时一直用它们 ----------
  //
  // 从文件读，不塞进代码里：它们是真棋谱，放文件里改起来方便。
  // 界面上的按钮就叫「样例一 / 样例二 / 样例三」（不写平台名，要看来源就把鼠标停上去）。
  //
  // 【样例一】51 步。每一步都带 [%eval] 引擎评分和 [%clk] 剩余时间，还有 20 多处变着分支
  //   —— "带评注的棋谱"的典型样本。项目里很多次排错用的它
  //   （"d2 的后盯住 d6"、"把第 5 手当成眼下的威胁"都是在这一盘上抓到的）。
  // 【样例二】31 步，短兵相接，没有任何评注。
  //   第 10 手白方短易位是个**取舍**（引擎给分和另一手几乎相同）——
  //   用来试"讲棋会不会把取舍说成漏着"最合适；最后一步还是升变成马将杀。
  // 【样例三】102 步的残局拉锯（一盘 rapid）。最后 20 步几乎全是王兵残局，
  //   第 50 手 50.Kh5 是那类"看着能吃、其实吃不了"的典型
  //   （王旁边的 h6 兵被 g7 守着）—— 用来试残局讲解和"王不能吃被保护的子"这条规则。
  sample1: { file: 'samples/sample1.pgn' },
  sample2: { file: 'samples/sample2.pgn' },
  sample3: { file: 'samples/sample3.pgn' },
};

// ---------- 棋盘（只建一次，之后只改它的属性）----------
const board = createBoard(boardEl);

// ---------- 程序的状态 ----------
let moves = [];                  // 解析出来的所有着法，每个都自带「走前/走后」的 FEN
let annotations = [];            // 和 moves 一一对应的评注（评分 / 时钟 / 质量 / 原文）
let startFen = DEFAULT_POSITION; // 开局局面（万一棋谱是从中局开始的，这个会不一样）
let gameResult = '*';            // 棋谱自己写的胜负标记（'*' = 没写）
let cursor = -1;                 // 现在停在第几步。-1 表示还没开始走

// 时间线：frames[k] 是「第 k-1 步走完之后」所有棋子的位置，frames[0] 是开局。
// 它记着每个棋子的身份，动画全靠它。详见 timeline.js。
let timeline = buildTimeline(DEFAULT_POSITION, []);
let animationOk = true;          // 时间线自检没通过时会关掉动画（宁可不动，不可动错）

// ============================================================
// 直接走棋 与 「你走的支线」
// ============================================================
//
// 【为什么支线要单独存，而不是往 moves 里塞】
// 上面这一整套（moves / annotations / timeline / 曲线用的 evals）都建立在
// "一条直线"的假设上：fenAt(i)、frameAt(i)、evals[k] 全按步数索引。
// 要既保住原棋谱、又记下你自己走的棋，最省事也最不容易出错的办法是：
// **原棋谱一个字节都不改**，你走的棋另存成支线。
//
// 每条支线：{ id, atPly, moves: [...chess.js verbose move...], timeline: [...] }
//   atPly = 从主线"第 atPly 步走完之后"那个局面接出去（-1 = 从开局接出去）
//   timeline = 这条支线自己的动画帧（从它的起点局面算起）
//
// 在棋盘上走一步时，走哪儿去由**当前所在的位置**决定：
//   · 在主线中间走   → 开一条新支线（原棋谱后面那几步原样留着）
//   · 在主线末尾走   → 也是新支线（等价于"接着往下下"，导出时同样是一条变着）
//   · 在支线末尾走   → 接着这条支线往下走
//   · 在支线中间走   → 从这一步起改写这条支线（后面的截掉）
// 支线之间**不能互相嵌套**（那需要真·变着树，这一版不做）。
//
// 曲线、局势条、着法列表里的评分仍然只画**原棋谱主线**（evals 是按主线步数扫的），
// 所以支线不掺进曲线 —— 两盘棋的分数混在一条线上没有任何意义。
let branches = [];               // 所有支线（平行的，互不嵌套）
let activeBranchId = null;       // 现在看的是哪条支线；null = 在原棋谱主线上
let branchSeq = 0;               // 支线编号（只增不减，界面上的"支线 1/2/3"）
let branchesExported = true;     // 支线动过之后置 false —— 用来决定要不要提醒保存
let loadedHeaders = {};          // 原棋谱的头部（导出时原样带过去）

// 棋盘上"选中的子 → 它能合法走到的格子"。全部由 chess.js 过滤过，
// 所以根本走不出非法棋 —— 兵不会后退、马不会走错、走完不会把自己王暴露。
let selectedSquare = null;
let legalTargets = [];
let pendingPromotion = null;     // 兵到底线时先记下来，等用户选升变成什么

// 换盘前那道拦截：先把它记下来，用户点"仍然载入"再真的载入
let pendingLoadText = null;

let analysis = null;             // 当前要显示的分析结果
let analyzing = false;           // 正在算？
let analysisError = null;        // 上一次分析失败的原因
let engineReady = false;         // 引擎是否可用

// 缓存的键是「局面 + 深度」。同一个局面同样深度算过一次就不必再算。
// 注意：鳕鱼自己的置换表也有缓存，所以重复分析本来就快；
// 我们这层缓存省掉的是网络来回和进程通信。
const analysisCache = new Map();

// ---------- 「让 DeepSeek 讲讲」这条链路专用的引擎参数 ----------
//
// ⚠️ 它和左栏那个「深度」下拉框是两回事，别混在一起看：
//    下拉框管的是**你按「让鳕鱼分析」**时要算多深；
//    下面这三个管的是**我们替你备料**（点「讲讲」时）要算多深、要不要多路线。
//
// 为什么要分开：讲棋要把战术讲准，需要的不是"和看曲线一样深"，而是
//   ① 更深一点 —— 战术常常在第 2～4 步才显形，浅了看不见；
//   ② 同时要几条候选 —— 只看"该走哪步"这一个答案，讲不出
//      "这一步是真正的好棋，还是不得已只能这样走"。
// 这两件事都会让搜索变慢，而慢的代价不该由别的按钮一起承担。
//
// EXPLAIN_BUDGET_MS 是墙钟上限，不是"愿意等多久"：
// MultiPV 的开销极度依赖局面 —— 实测同一台机器上，开局 0.8 秒、中局 2.6 秒、
// 一边倒的战术局面要 16.6 秒。只靠层数控制不住，所以加一道时间闸：
// 到点就让鳕鱼收尾，交回**已经算出来的那几条**（详见 engine.js 的说明）。
// 宁可深度浅一点但及时，也不要让你对着转圈等十几秒。
const EXPLAIN_DEPTH = 18;
const EXPLAIN_MULTIPV = 3;
const EXPLAIN_BUDGET_MS = 5000;

// ---------- 「让鳕鱼分析」这条链路的参数 ----------
//
// 它也要**多路线**：面板上要摊开"引擎认为的次优选和它的后续着法"。
// 只给"该走这一步"一个答案，用户没法判断这一步是真好棋还是不得已只能这样走 ——
// 候选之间的分差才回答那个问题，而且这和讲棋订单用的是同一份数据（都是 MultiPV）。
//
// ⚠️ MultiPV 的开销随局面爆炸（实测同一台机器上，一边倒的战术局面
//    在 depth18/multipv3 下要 16.6 秒）。所以这里给它和讲棋同一道墙钟闸：
//    到点让引擎把手上的活收尾，**交回已经算出来的那几条**（见 engine.js）。
//    宁可深度浅一点、及时出结果，也不要让用户对着按钮等十几秒。
//    （面板上会显示"这是引擎搜到第几层的结论"，所以交回来的深度是诚实的。）
const ANALYZE_MULTIPV = 3;
const ANALYZE_BUDGET_MS = EXPLAIN_BUDGET_MS;

// ---------- 整盘棋的评估数据（曲线和局势条都靠它）----------
//
// evals[k] = 第 k 步走完之后那个局面的评分；evals[0] 是开局。
// 里面每一项长这样：
//   { index, fen, norm, scoreCp, scoreMate, scoreText, bestMove, bestMoveSan,
//     turn, source: 'engine' | 'terminal', done }
//
// 【重要】这份数据只由鳕鱼算出来，跟棋谱里有没有评注完全无关 ——
// 因为棋谱不一定带评注，我们不能把曲线建立在别人的注释上。
let evals = [];
let evalRunning = false;
let evalRunId = 0;       // 每开一轮新评估就 +1，用来作废还没跑完的旧一轮
let gameId = 0;          // 每载入一盘棋 +1
let evalForGame = -1;    // 已经为哪一盘棋跑过评估了（避免重复启动）

let flipped = false;     // 棋盘翻过来了吗（黑方在屏幕下方）

// 现在是「手动模式」吗（曲线和局势条都关了）。
// 只用来判断提示消息该不该再弹一次 —— 见 onDisplaySettingChange。
let manualMode = false;

// ---------- DeepSeek 讲解 ----------
//
// 【和鳕鱼那一套完全独立】
// 讲棋功能挂了、密钥没配、DeepSeek 宕机 —— 算棋和复盘一切照常。
// 两者只有一处交汇：讲解要拿鳕鱼算出来的数字当"事实"。
//
// 密钥不在这里，也不可能在这里 —— 它在服务器上，浏览器全程见不着。
let llmReady = false;        // 后端配好密钥了吗
let llmInfo = null;          // 后端报回来的状态（里面没有密钥，见 llm.js 的 info()）
let explaining = false;      // 正在请它讲？
let explainRecord = null;    // 最近一次的结果，形如 { fen, text, facts } 或 { fen, error }
let explainRunId = 0;        // 每点一次 +1，用来作废还没回来的旧请求

// 正在讲的这一步，鳕鱼的结论是什么。
// 单独放一份，是为了在"先让鳕鱼算"的那几秒里就能把事实显示出来 ——
// 那几秒里用户最想知道的就是「它到底在算什么」。
let pendingFacts = null;

// 同一个局面讲过就存着，再点不重复花钱。值是 explainRecord 的形状。
const explainCache = new Map();

// 一轮扫描一次发给后端多少个局面。
// 太大 → 中间看不到进度；太小 → 白白多出几十次网络往返。
const SCAN_BATCH = 8;

// 推荐走法箭头的颜色（暖橙）。
// 不管数据来自手动分析还是后台扫描，都用同一个颜色 —— 箭头只表达一件事：
// 「引擎认为这里该走这一步」。数据来源的差别体现在精度上，不体现在配色上。
// 留着常量是为了改配色时只改一处。
const BEST_MOVE_ARROW_COLOR = '#e8933a';

// ============================================================
// 第一部分：载入棋谱
// ============================================================
/**
 * 用户按下「载入棋谱」/点了示例按钮时走这里 —— 只是**先拦一下**。
 *
 * 棋盘上还有没导出的支线时，不直接把它冲掉，而是先弹一条页内提示：
 * 「先去导出」或者「仍然载入（放弃支线）」。
 * （用页内提示而不是浏览器原生 confirm：一是能写清会丢什么，
 *   二是 jsdom 里 confirm 压根没实现，页内提示才测得了。）
 */
function requestLoad(text) {
  const raw = (text || '').trim();
  if (!raw || !hasUnsavedBranches()) {
    loadPgn(text);
    return;
  }
  pendingLoadText = text;
  loadGuardEl.hidden = false;
  showMessage('你在棋盘上走过支线，还没导出 —— 载入新棋谱会把它们丢掉。', 'warn');
}

/** 有支线、而且支线动过之后还没导出过 —— 这时候才需要提醒保存 */
function hasUnsavedBranches() {
  return branches.length > 0 && !branchesExported;
}

function loadPgn(text) {
  const raw = (text || '').trim();
  if (!raw) {
    showMessage('先把棋谱粘贴到左边，或者点下面那三个示例按钮试试。', 'warn');
    return;
  }

  // 解析这一层是自己写的（public/js/pgn.js）：
  // chess.js 的 loadPgn 顶不住「一个着法后面跟两个连续评注」，
  // 而 lichess 导出的棋谱每一处判评都是那样写的 —— 所以整篇必挂。
  const result = parsePgn(raw);
  if (!result.ok) {
    showMessage('这段棋谱看不懂：' + result.error, 'error');
    return;
  }

  moves = result.moves;
  annotations = result.annotations;
  startFen = result.startFen;
  gameResult = result.result || '*';
  loadedHeaders = result.headers || {};

  // 换棋谱 = 上一盘的支线全部作废（它们挂的是上一盘的局面）
  branches = [];
  activeBranchId = null;
  branchSeq = 0;
  branchesExported = true;
  selectedSquare = null;
  legalTargets = [];
  pendingPromotion = null;
  promoPickerEl.hidden = true;
  loadGuardEl.hidden = true;
  pendingLoadText = null;
  exportPanelEl.hidden = true;

  // 上一盘棋的手动分析结果作废
  analysis = null;
  analysisError = null;

  // 上一盘棋的"讲过什么"也一起作废 —— 换棋谱之后带着旧记忆，
  // 它会讲出另一盘棋里的事。
  mainRecap = [];
  explainCache.clear();

  // 直接跳到结尾：粘一盘自己下的棋进来，第一眼最想知道的
  // 就是「这盘谁赢了」，而终局的将杀局面正好能立刻确认整盘棋都解析对了。
  cursor = moves.length - 1;

  // ---------- 算时间线，并且自检 ----------
  // 易位/吃过路兵/升变只要有一处算错，棋子就会被送到错误的格子上，
  // 而且动起来还挺顺滑，肉眼极难发现。所以每次都拿引擎给的 FEN 对一遍。
  timeline = buildTimeline(startFen, moves);
  const check = verifyTimeline(timeline, startFen, moves);
  animationOk = check.ok;
  if (!check.ok) {
    console.warn('[时间线自检未通过] 已关闭动画。问题：', check.issues);
  }

  board.reset();     // 换棋局了，旧棋子的 id 全部作废
  gameId++;

  // 换棋局 = 上一盘棋的评估数据全部作废。
  // evalRunId++ 会让还在跑的那一轮在下一个回调处安静地退出，不会串台。
  evalRunId++;
  evalRunning = false;
  evals = [];
  evalForGame = -1;

  buildMoveList();
  render({ animate: false });

  const problems = [...result.warnings];
  if (!check.ok) problems.push('动画已自动关闭：' + check.issues[0]);

  showMessage(describeGame(result), problems.length ? 'warn' : 'ok');

  // 让鳕鱼把整盘棋过一遍。用户在设置里把曲线和局势条都关掉的话，这里不会做任何事。
  startEval();
}

/** 载入成功后那一行说明：谁跟谁下、什么结果、解析出多少评注 */
function describeGame(result) {
  const h = result.headers || {};
  const s = result.stats || {};
  const bits = [];

  const white = h.White ? h.White + (h.WhiteElo ? '（' + h.WhiteElo + '）' : '') : null;
  const black = h.Black ? h.Black + (h.BlackElo ? '（' + h.BlackElo + '）' : '') : null;
  if (white || black) bits.push((white || '白方') + ' 对 ' + (black || '黑方'));

  bits.push('共 ' + moves.length + ' 步');
  bits.push(describeResult());

  if (s.annotated > 0) {
    const marks = [];
    if (s.blunders) marks.push('漏着 ' + s.blunders);
    if (s.mistakes) marks.push('错着 ' + s.mistakes);
    if (s.inaccuracies) marks.push('不精确 ' + s.inaccuracies);
    bits.push('读到 ' + s.annotated + ' 条评注' + (marks.length ? '（' + marks.join(' / ') + '）' : ''));
    if (s.droppedVariations) bits.push('另丢弃 ' + s.droppedVariations + ' 处变着分支');
  } else if (s.strippedComments) {
    bits.push('剥掉 ' + s.strippedComments + ' 条无评分的注释');
  }

  return bits.join(' · ');
}

/** 说出这盘棋的最终结果。评注里写了「认输」的话优先采信它。 */
function describeResult() {
  // ① 评注里明写了认输 / 和棋 —— 最具体，优先（lichess 导出的棋谱就是这种）
  const last = annotations[moves.length - 1];
  const note = (last && last.comment) || '';
  if (/black\s+resigns/i.test(note)) return '黑方认输';
  if (/white\s+resigns/i.test(note)) return '白方认输';
  if (/draw|agreed to a draw/i.test(note)) return '和棋';

  // ② 棋盘上已经结束了 —— 由局面本身说话，这比任何标记都硬。
  //    ⚠️ 用 mainFenAt 而不是 fenAt：这一句说的是**原棋谱**的结局，
  //    哪怕你现在正站在自己走的支线上，也不该拿支线的局面去描述这盘棋。
  const g = new Chess(mainFenAt(moves.length - 1));
  if (g.isCheckmate()) return g.turn() === 'w' ? '黑方将杀获胜' : '白方将杀获胜';
  if (g.isStalemate()) return '逼和（和棋）';
  if (g.isDraw())      return '和棋';

  // ③ 棋盘上还没结束 —— 那就听棋谱自己写的胜负标记。
  //    认输、协议和棋这两类结局在棋盘上一点痕迹都没有（棋子还在原处、轮次也没变），
  //    只有这个标记说得清。以前这里不看它，于是整盘棋只写着 "1-0" 的棋谱
  //    会被显示成"这盘棋还没下完"。
  if (gameResult === '1-0') return '白方获胜（棋谱标记 1-0）';
  if (gameResult === '0-1') return '黑方获胜（棋谱标记 0-1）';
  if (gameResult === '1/2-1/2') return '和棋（棋谱标记 1/2-1/2）';

  return '这盘棋还没下完';
}

// ============================================================
// 第二部分：生成着法列表
// ============================================================
function buildMoveList() {
  movesBody.innerHTML = '';

  // 一行 = 一个回合：左格白方、右格黑方。
  //
  // ⚠️ 但"第一个着法"不一定是白方走的。棋谱可以用 [FEN "..."] 从**中局**摆起，
  //    而那个局面完全可能轮到黑方走（解析层支持这件事，见 verify-pgn 第 ④ 节）。
  //    早先这里写死了"第 i 个是白方、第 i+1 个是黑方"（i 每次 +2），
  //    于是这类棋谱把黑方的着法画进了"白"那一列，回合号也整体错了一位。
  //    现在按**起始局面的走棋方**决定：黑先走时，第一行只放黑方那一格。
  const firstIsBlack = !!(moves[0] && moves[0].color === 'b');
  const offset = firstIsBlack ? 1 : 0;   // 第 0 个着法前面要不要空出白方那一格

  // 回合号也照棋谱自己的来 —— 从中局摆起的棋谱可能是从第 20 回合开始的，
  // 拿 startFen 的第 6 个字段（fullmove）当起点，别一律从 1 数。
  const firstMoveNo = Number((startFen.split(/\s+/)[5] || '1')) || 1;

  for (let row = 0; row * 2 < moves.length + offset; row++) {
    const tr = document.createElement('tr');

    // 白方那一格：黑先走时第一行的这一格是空的（PGN 里写成 "1..."）
    const whiteIdx = row * 2 - offset;
    const blackIdx = whiteIdx + 1;

    const noCell = document.createElement('td');
    noCell.className = 'move-no';
    noCell.textContent = (firstMoveNo + row) + (row === 0 && firstIsBlack ? '…' : '');
    tr.appendChild(noCell);

    tr.appendChild(moves[whiteIdx] ? makeMoveCell(moves[whiteIdx], whiteIdx) : makeEmptyCell());
    tr.appendChild(moves[blackIdx] ? makeMoveCell(moves[blackIdx], blackIdx) : makeEmptyCell());

    movesBody.appendChild(tr);
  }
}

function makeEmptyCell() {
  const td = document.createElement('td');
  td.className = 'move-cell';
  return td;
}

function makeMoveCell(move, index) {
  const ann = annotations[index];

  const td = document.createElement('td');
  td.className = 'move-cell';
  td.dataset.index = index;
  td.dataset.line = 'main';
  // 点主线的格子 = 回到原棋谱这条线上来看这一步（哪怕刚才在支线上）
  td.addEventListener('click', () => { activeBranchId = null; goTo(index); });

  // 这一步的判评质量（漏着/错着/不精确）—— 左边那个小圆点就是它
  if (ann && ann.quality) {
    td.classList.add('q-' + ann.quality);
    td.title = (QUALITY_LABEL[ann.quality] || ann.quality) +
               (ann.comment ? '：' + ann.comment : '');
  } else if (ann && ann.comment) {
    td.title = ann.comment;
  }

  const san = document.createElement('span');
  san.className = 'san';
  san.textContent = move.san;   // san 就是标准记谱，比如 Nf3、O-O、Qxf7#
  td.appendChild(san);

  // 这一步的评分。先建个空位子，内容由 fillMoveEval 填 ——
  // 因为鳕鱼的扫描是边算边出来的，得能随时回填。
  const ev = document.createElement('span');
  ev.className = 'mv-eval';
  ev.hidden = true;
  td.appendChild(ev);
  fillMoveEval(ev, index);

  return td;
}

// ============================================================
// 第二部分之二：把你走的支线画出来
// ============================================================

/**
 * 把一条支线的着法按回合排成行。
 *
 * 和主线同一个道理，但起点是**绝对半回合号**（b.atPly + 1）：
 * 一条支线可能从黑方那一步接出去，也可能从第 20 回合接出去 ——
 * 列位（白格还是黑格）和回合号都得照它自己的绝对位置算，
 * 不能一律按"白先、第 1 回合"数。
 */
function branchRows(b) {
  const off = startFen.split(/\s+/)[1] === 'b' ? 1 : 0;
  const rows = [];
  b.moves.forEach((mv, j) => {
    const ply = b.atPly + 1 + j;
    const no = moveNumberAt(ply);
    const isWhite = (off + ply) % 2 === 0;
    let row = rows[rows.length - 1];
    if (!row || row.no !== no) {
      row = { no, white: null, black: null, whiteIdx: -1, blackIdx: -1 };
      rows.push(row);
    }
    if (isWhite) { row.white = mv; row.whiteIdx = j; } else { row.black = mv; row.blackIdx = j; }
  });
  return rows;
}

/** 支线表里的一格。点它 = 切到这条支线、并跳到那一步 */
function makeBranchCell(b, mv, index) {
  const td = document.createElement('td');
  td.className = 'move-cell';
  td.dataset.index = index;
  td.dataset.branch = b.id;
  td.dataset.line = 'branch';
  td.addEventListener('click', () => {
    activeBranchId = b.id;
    goTo(index);
  });

  const san = document.createElement('span');
  san.className = 'san';
  san.textContent = mv.san;
  td.appendChild(san);

  // 这一步的分数。走完一步会自动算一次（或你在这一步点过「让鳕鱼分析」），
  // 算过才显示 —— 没算过就空着，不硬凑。
  const ev = document.createElement('span');
  ev.className = 'mv-eval';
  ev.hidden = true;
  const eng = mv.engine;
  if (eng) {
    ev.textContent = compactScore(eng.scoreCp, eng.scoreMate);
    ev.className = 'mv-eval own ' + sideOf(eng.scoreCp, eng.scoreMate);
    ev.title = '鳕鱼实时计算：' + (eng.scoreText || '—') +
      (eng.bestMoveSan ? '，推荐 ' + eng.bestMoveSan : '');
    ev.hidden = false;
  }
  td.appendChild(ev);
  return td;
}

/** 一条支线那一块（标题 + 表格） */
function buildBranchItem(b) {
  const item = document.createElement('div');
  item.className = 'branch-item' + (b.id === activeBranchId ? ' active' : '');
  item.dataset.branch = b.id;

  const startSide = mainFenAt(b.atPly).split(/\s+/)[1] === 'b' ? '黑方' : '白方';
  const head = document.createElement('div');
  head.className = 'branch-head';
  head.textContent = '支线 ' + b.id + ' —— 从' +
    (b.atPly < 0 ? '开局' : '第 ' + moveNumberAt(b.atPly) + ' 回合（' + startSide + '待走）') +
    '接出去 · 共 ' + b.moves.length + ' 步（点着法可以跳过去）';

  const table = document.createElement('table');
  table.className = 'moves branch-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  ['#', '白', '黑'].forEach((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of branchRows(b)) {
    const tr = document.createElement('tr');
    const noCell = document.createElement('td');
    noCell.className = 'move-no';
    noCell.textContent = row.no;
    tr.appendChild(noCell);
    tr.appendChild(row.white ? makeBranchCell(b, row.white, row.whiteIdx) : makeEmptyCell());
    tr.appendChild(row.black ? makeBranchCell(b, row.black, row.blackIdx) : makeEmptyCell());
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  item.append(head, table);
  return item;
}

/** 把「你走的支线」那一块整个重画一遍（没支线就藏起来） */
function renderBranchBlock() {
  branchBlockEl.hidden = branches.length === 0;
  branchListEl.innerHTML = '';
  if (!branches.length) return;

  for (const b of branches) branchListEl.appendChild(buildBranchItem(b));

  // 主线上"有支线从这里接出去"的小圆点
  movesBody.querySelectorAll('.move-cell').forEach((td) => td.classList.remove('has-branch'));
  for (const b of branches) {
    if (b.atPly < 0) continue;
    const td = movesBody.querySelector('.move-cell[data-index="' + b.atPly + '"]');
    if (td) td.classList.add('has-branch');
  }

  document.getElementById('btnUndoMove').disabled = !activeBranch();
}

// ============================================================
// 第二部分之三：在棋盘上直接走棋
//
// 【为什么不可能走出非法棋】
// 落点不是我们自己算的，是 `chess.js.moves({square})` 给的**合法着法**。
// 所以"兵后退""马走错""走完把自己的王暴露（送将）"这些根本进不来 ——
// 规则由 chess.js 兜着，和引擎、和讲棋用的是同一套规则。
// ============================================================

/** 现在这个局面：chess.js 实例 + 轮到谁走 */
function boardTurnInfo() {
  let game;
  try { game = new Chess(fenAt(cursor)); } catch { return null; }
  return { game, turn: game.turn() };
}

/** 重建一条支线的动画时间线，并且自检（和载入棋谱时对主线做的是同一件事） */
function rebuildBranchTimeline(b) {
  const from = mainFenAt(b.atPly);
  // ⚠️ 第三个参数是**这条支线自己的棋子号段**（b.id * 64）。
  //    不这么做的话，支线会从 1 开始重新编号，和主线撞号 ——
  //    board.show 按 id 复用 DOM 元素，于是两条线里不同的子被当成同一颗，
  //    棋盘上就会出现"白子变黑子"（症状是偶尔发生、很难复现）。
  //    详见 timeline.js 里 buildTimeline 的说明。
  b.timeline = buildTimeline(from, b.moves, b.id * 64);
  const check = verifyTimeline(b.timeline, from, b.moves);
  b.timelineOk = check.ok;
  if (!check.ok) {
    console.warn('[支线时间线自检未通过] 已关掉这条支线的动画。问题：', check.issues);
    showMessage('这条支线的动画自检没通过，已关掉动画（棋盘上的局面本身是对的）。' +
      check.issues[0], 'warn');
  }
}

/** 当前这条线能不能做动画（支线各有一份自检结果） */
function lineAnimOk() {
  const b = activeBranch();
  return b ? b.timelineOk !== false : true;
}

/**
 * 真的走一步。
 *
 * ⚠️ 走哪儿去由**当前所在的位置**决定，见文件上方"支线"那一段：
 *    主线中间/末尾 → 开新支线；支线末尾 → 接着走；支线中间 → 从那一步起改写。
 */
function playMove(from, to, promotion) {
  const info = boardTurnInfo();
  if (!info) return false;

  let played = null;
  try { played = info.game.move({ from, to, promotion }); } catch { played = null; }
  if (!played) {
    showMessage('这一步走不了（不合规则）。', 'warn');
    return false;
  }

  const b = activeBranch();
  if (b) {
    if (cursor < b.moves.length - 1) b.moves = b.moves.slice(0, cursor + 1);
    b.moves.push(played);
    rebuildBranchTimeline(b);
  } else {
    const nb = { id: ++branchSeq, atPly: cursor, moves: [played], timeline: [] };
    rebuildBranchTimeline(nb);
    branches.push(nb);
    activeBranchId = nb.id;
  }

  branchesExported = false;
  cursor = lineLength() - 1;
  selectedSquare = null;
  legalTargets = [];
  showMessage('这一步记在支线 ' + activeBranch().id + ' 里了（原棋谱没动）。', '');
  render({ animate: true });
  // 顺手把"现在这个局面"算一遍：局势条 / 分数 / 推荐走法箭头就和主线一个体验了。
  // 不 await —— 棋盘先动起来，分数后到（见 autoAnalyzeBranchHere 的三条边界）。
  autoAnalyzeBranchHere();
  return true;
}

/** 悔棋：只悔你走的支线 —— 原棋谱是别人写好的，我们不改它 */
function undoMove() {
  const b = activeBranch();
  if (!b) {
    showMessage('原棋谱不改动，所以主线不能悔棋 —— 只有你在棋盘上走的支线可以。', 'warn');
    return;
  }
  b.moves.pop();
  if (!b.moves.length) {
    branches = branches.filter((x) => x.id !== b.id);
    activeBranchId = null;
    cursor = Math.min(b.atPly, moves.length - 1);
  } else {
    rebuildBranchTimeline(b);
    cursor = b.moves.length - 1;
  }
  branchesExported = false;
  selectedSquare = null;
  legalTargets = [];
  render({ animate: false });
}

/** 清空全部支线（原棋谱依旧不动） */
function clearBranches() {
  if (!branches.length) return;
  branches = [];
  activeBranchId = null;
  selectedSquare = null;
  legalTargets = [];
  cursor = Math.max(-1, Math.min(cursor, moves.length - 1));
  branchesExported = true;
  render({ animate: false });
  showMessage('支线清空了，原棋谱一步没动。', '');
}

/** 兵到底线了：先问升变成什么，不选就没法确定这一步是什么 */
function openPromotion(from, to) {
  pendingPromotion = { from, to };
  promoPickerEl.hidden = false;
  updatePlayHint();
}

function cancelPromotion() {
  pendingPromotion = null;
  promoPickerEl.hidden = true;
  render({ animate: false });
}

/**
 * 点了一下棋盘上的某个格子。三种情况，按顺序判：
 *   ① 点的是"已选中那个子"的合法落点 → 走这一步
 *   ② 点的是自己的子（而且轮到它走）→ 选中它，把它能走的格子都算出来
 *   ③ 其他 → 取消选中
 */
function onSquareClick(square) {
  if (pendingPromotion) return;
  const info = boardTurnInfo();
  if (!info) return;
  const { game } = info;

  const target = legalTargets.find((m) => m.to === square);
  if (target) {
    if (target.promotion) { openPromotion(target.from, target.to); return; }
    playMove(target.from, target.to);
    return;
  }

  const piece = game.get(square);
  if (piece && piece.color === game.turn()) {
    const targets = game.moves({ square, verbose: true });
    selectedSquare = square;
    legalTargets = targets;
    if (!targets.length) showMessage('这个子现在一步也走不了（被堵住 / 被牵住 / 会让自己的王被将军）。', 'warn');
    render({ animate: false });
    return;
  }

  selectedSquare = null;
  legalTargets = [];
  render({ animate: false });
}

/** 棋盘下面那行提示：轮到谁走 / 选中了谁 / 能走到哪 */
function updatePlayHint() {
  const b = activeBranch();
  if (pendingPromotion) {
    playHintEl.textContent = '这个兵到底线了 —— 先选升变成什么。';
    playHintEl.className = 'play-hint';
    return;
  }
  const info = boardTurnInfo();
  if (!info) { playHintEl.textContent = ''; return; }

  if (info.game.isGameOver()) {
    playHintEl.textContent = '这个局面已经结束了，没有着法可走。' + onLineNote(b);
    playHintEl.className = 'play-hint';
    return;
  }
  if (selectedSquare) {
    playHintEl.textContent = '选中了 ' + selectedSquare + '，它能走到 ' +
      legalTargets.length + ' 个格子（绿色圆点）。再点一个绿点就落子；点别处取消。' + onLineNote(b);
  } else {
    const side = info.turn === 'w' ? '白方' : '黑方';
    playHintEl.textContent = '轮到' + side + '走。点一个' + side +
      '的子，再点目标格 —— 直接在棋盘上走棋。走的棋会记成支线，原棋谱不动。' + onLineNote(b);
  }
  playHintEl.className = 'play-hint';
}

/** 站在支线上时提醒一句"你在支线上、怎么回去"——不然容易以为自己卡住了。
 *  ⚠️ 这句话必须短。它是棋盘下面那一行的文字，写长了会把左边这一栏撑宽、
 *     把右边的界面挤扁（CSS 那边也上了锁，但文案本身也别给自己找麻烦）。
 *     完整的解释放在「↩ 回到主线」按钮的 title 里。 */
function onLineNote(b) {
  return b ? '（支线 ' + b.id + ' · 点「↩ 回到主线」回去）' : '';
}

/**
 * 往着法格子里填评分。
 *
 * 【优先用我们自己算的】
 * 棋谱里可能带着 lichess 写的 [%eval]，但那不是我们要依赖的东西 ——
 * 随便一盘棋谱往往是没有任何评注的。所以顺序是：
 *   1. 鳕鱼刚才实时算出来的（带 own 标记，亮一点）
 *   2. 实在没有，才退回棋谱自带的那一条（暗一点，鼠标停上去会说明来源）
 *
 * 【设置里的「着法评分」开关】
 * 关掉它 —— 这里一律填空，不管是鳕鱼算的还是棋谱自带的，都不显示。
 * 注意是「填空」而不是「跳过」：每个格子里那个 span 是载入棋谱时就建好的，
 * 必须把 hidden 设回去，否则开关一关，上一轮留下的分数会赖在列表里不走。
 */
function fillMoveEval(el, index) {
  if (!optMoveEval.checked) {
    el.textContent = '';
    el.className = 'mv-eval';
    el.hidden = true;
    return;
  }

  const own = evals[index + 1];
  if (own && own.done && own.scoreText && own.source !== 'failed') {
    el.textContent = compactScore(own.scoreCp, own.scoreMate);
    el.className = 'mv-eval own ' + sideOf(own.scoreCp, own.scoreMate);
    el.title = '鳕鱼实时计算：' + own.scoreText;
    el.hidden = false;
    return;
  }

  const ann = annotations[index];
  const text = annotationScoreText(ann);
  if (text) {
    el.textContent = text;
    el.className = 'mv-eval ' + annotationSide(ann);
    el.title = '来自棋谱自带的评注（不是本程序算的）';
    el.hidden = false;
    return;
  }

  el.textContent = '';
  el.className = 'mv-eval';
  el.hidden = true;
}

/** 扫描出一批结果之后，把着法列表里的评分整体刷一遍 */
function updateMoveEvals() {
  movesBody.querySelectorAll('.move-cell[data-index]').forEach((td) => {
    const ev = td.querySelector('.mv-eval');
    if (ev) fillMoveEval(ev, Number(td.dataset.index));
  });
}

/**
 * 当前这一步的评注详情，显示在棋盘下面。
 * 这是"带评注的棋谱"最实用的部分：翻到哪一步，就知道当时引擎怎么判、还剩多少时间。
 */
function describeAnnotation(index) {
  // ⚠️ 用 annotationAt：站在支线上时下面这几条评注不属于这条线（评注是棋谱自带的，
  //    只和原棋谱主线对应），拿错索引会把别人的话贴到这一步上。
  const ann = annotationAt(index);
  if (!ann || !ann.has) return '';

  const bits = [];

  const score = annotationScoreText(ann);
  if (score) bits.push('评分 ' + score);

  if (ann.evalBefore !== null && ann.evalBefore !== undefined && ann.evalCp !== null) {
    bits.push('（从 ' + (ann.evalBefore > 0 ? '+' : '') + ann.evalBefore + ' 变化到 ' +
              (ann.evalCp > 0 ? '+' : '') + ann.evalCp + '）');
  }

  if (ann.quality) bits.push('‹' + (QUALITY_LABEL[ann.quality] || ann.quality) + '›');
  if (ann.bestMove) bits.push('引擎建议 ' + ann.bestMove);
  if (ann.clk) bits.push('剩余 ' + ann.clk);

  return bits.join('　');
}

// ============================================================
// 第三部分：画面刷新
// ============================================================

/** 现在所在的那条支线（null = 原棋谱主线） */
function activeBranch() {
  return activeBranchId === null ? null : (branches.find((b) => b.id === activeBranchId) || null);
}

/**
 * 取出「第 i 步走完之后」的局面（FEN 字符串，给引擎和状态栏用）。
 *
 * ⚠️ 它是**按当前所在的线**取的：在看支线时，取的是支线上第 i 步之后。
 *    i < 0 一律表示"这条线的起点"（支线的起点 = 主线在某一步之后的局面）。
 *    要看主线本身（比如描述原棋谱的结局），用 mainFenAt()。
 */
function fenAt(i) {
  const b = activeBranch();
  if (!b) return mainFenAt(i);
  if (i < 0) return mainFenAt(b.atPly);
  const mv = b.moves[i];
  return mv ? mv.after : mainFenAt(b.atPly);
}

/** 原棋谱主线第 i 步之后的局面。支线的起点要用它 —— 别写成 fenAt，会跟着当前线跑偏 */
function mainFenAt(i) {
  return i < 0 ? startFen : moves[i].after;
}

/** 取出「第 i 步走完之后」所有棋子的位置（给棋盘画动画用） */
function frameAt(i) {
  // frames[0] 是起点，所以第 i 步对应 frames[i + 1]
  const frames = activeBranch() ? activeBranch().timeline : timeline;
  return frames[Math.min(Math.max(i + 1, 0), frames.length - 1)] || [];
}

/** 当前这条线上第 i 步走的是什么（chess.js 的 verbose move） */
function moveAt(i) {
  const b = activeBranch();
  return b ? b.moves[i] : moves[i];
}

/** 当前这条线上第 i 步的棋谱评注（只有原棋谱主线才有评注） */
function annotationAt(i) {
  return activeBranch() ? null : annotations[i];
}

// ============================================================
// 「双方已经吃掉了什么」—— 纯子力账
//
// 【它不是什么】
//   它**不**看鳕鱼的评分，也**不**经过 DeepSeek。就是"走了这几步，棋盘上少了哪些子"，
//   走一步数一步，翻到哪一步就显示到哪一步。
//
// 【为什么值得单独做一栏】
//   复盘时最先想知道的往往是"现在子力谁多"—— 而局势条给的是引擎的判断（还带着位置因素），
//   两回事。这里给的是明面上的账：吃掉了哪些子、谁赚了几分。
//
// 【算在哪儿】
//   用时间线里的**棋子身份**（id）而不是数棋子：升变会让棋盘上凭空多一个后，
//   按"少了什么"数会把账算错。细节见 timeline.js 的 captureLedger。
// ============================================================

/** 当前局面下的吃子账（给渲染用，也给测试用） */
function ledgerNow() {
  const frames = activeBranch() ? activeBranch().timeline : timeline;
  return captureLedger(frames, cursor + 1);
}

/** 棋子的中文名，只用在鼠标悬停的提示上 */
const PIECE_NAME_CN = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };

/**
 * 一行的内容：标签 + 一排棋子字形 + （赚了的话）分差。
 * @param {string} color 这一行里棋子的颜色（白方那行显示的是黑子，所以是 'b'）
 */
function ledgerRow(tag, captured, plus, color) {
  const row = document.createElement('div');
  row.className = 'ledger-row';

  const tagEl = document.createElement('span');
  tagEl.className = 'ledger-tag';
  tagEl.textContent = tag;
  row.appendChild(tagEl);

  const box = document.createElement('span');
  box.className = 'ledger-pieces';
  if (!captured.length) {
    const dash = document.createElement('span');
    dash.className = 'ledger-empty';
    dash.textContent = '—';
    box.appendChild(dash);
  } else {
    for (const type of captured) {
      const span = document.createElement('span');
      // 字形和棋盘上那份是同一个；颜色规则也共用（.cap.w / .cap.b）
      span.className = 'cap ' + color;
      span.textContent = PIECE_GLYPH[type] || '';
      span.title = PIECE_NAME_CN[type] || '';
      box.appendChild(span);
    }
  }
  row.appendChild(box);

  if (plus > 0) {
    const p = document.createElement('span');
    p.className = 'ledger-plus';
    p.textContent = '+' + plus;
    p.title = '吃子净赚 ' + plus + ' 分（兵 1、马/象 3、车 5、后 9）';
    row.appendChild(p);
  }
  return row;
}

/** 把那一栏重画一遍（每次 render 都会调到，所以它必须便宜） */
function renderLedger() {
  if (!ledgerEl) return;
  const led = ledgerNow();

  // 白方吃子那一行，显示的是**白方吃掉的黑子**，所以字形用黑棋的颜色
  const diff = led.diff;
  ledgerEl.textContent = '';
  ledgerEl.appendChild(ledgerRow('白方吃子', led.byWhite, diff > 0 ? diff : 0, 'b'));
  ledgerEl.appendChild(ledgerRow('黑方吃子', led.byBlack, diff < 0 ? -diff : 0, 'w'));
}

/** 当前这条线一共多少步 */
function lineLength() {
  const b = activeBranch();
  return b ? b.moves.length : moves.length;
}

/**
 * 现在这一步在**整盘棋**里是第几个半回合（从开局算起）。
 *
 * ⚠️ 算回合号必须用它，不能用 cursor + 1：在支线上 cursor 是"支线内部的第几步"，
 *    直接拿去当 ply，讲棋提示词里就会把第 3 回合的棋说成第 1 回合。
 */
function absolutePly() {
  const b = activeBranch();
  return (b ? b.atPly + 1 : 0) + (cursor + 1);
}

/** 当前这条线从头到「现在这一步」的全部着法（讲棋订单的 opening / history 要用） */
function lineTrail() {
  const b = activeBranch();
  if (!b) return moves.slice(0, cursor + 1);
  const prefix = b.atPly >= 0 ? moves.slice(0, b.atPly + 1) : [];
  return prefix.concat(b.moves.slice(0, cursor + 1));
}

/** 现在是不是停在"原棋谱这条线"上 */
function onMainLine() {
  return activeBranch() === null;
}

/** 当前显示的分析结果，是不是就是现在这个局面的？ */
function analysisIsFresh() {
  return !!analysis && analysis.fen === fenAt(cursor);
}

/**
 * ============================================================
 * 让当前这一步滚进视野 —— 但**只动着法列表自己**
 * ============================================================
 *
 * 【为什么不能用 scrollIntoView】
 * 原来这里是一句 `td.scrollIntoView({ block: 'nearest' })`。
 * scrollIntoView 会把这个元素**所有**可滚动祖先挨个滚一遍，
 * 而整个网页文档本身就是一个滚动容器。
 *
 * 于是当着法面板本身就落在窗口下方时（棋谱后段、列表又长），
 * 浏览器为了「让这一行可见」，会顺手把**整页往下拽** ——
 * 表现就是每点一次「下一步」，窗口就往下跳一下。
 *
 * 对策：自己算该滚多少，只写 `movesWrap.scrollTop`，
 * 从头到尾不碰文档的滚动位置。
 */

/**
 * 纯计算：要让纵向范围 [rowTop, rowBottom] 的这一行出现在
 * [viewTop, viewBottom] 这段可视区里，容器需要滚多少。
 * 返回 null 表示「本来就看得见，不用动」。
 *
 * 拆成纯函数是为了能直接用数字测 —— 浏览器之外没有真实排版，
 * 拿不到真实坐标，但这段判断逻辑才是真正容易写错的部分。
 */
export function scrollDeltaFor(rowTop, rowBottom, viewTop, viewBottom) {
  const rowHeight = rowBottom - rowTop;
  const viewHeight = viewBottom - viewTop;

  // 一行比整个可视区还高（现在不会发生，但以后要是给每步加一条备注就可能）。
  // 这种情况只能照顾开头 —— 为了露出尾巴而把开头推出去会更难用。
  if (rowHeight >= viewHeight) {
    return rowTop === viewTop ? null : rowTop - viewTop;
  }

  if (rowTop < viewTop) return rowTop - viewTop;              // 落在视野上方 → 负增量
  if (rowBottom > viewBottom) return rowBottom - viewBottom;  // 落在视野下方 → 正增量
  return null;                                                // 已经在视野里，别动
}

/** 把一个着法单元格滚进视野（只滚着法列表，不滚页面） */
function keepActiveRowVisible(td) {
  const wrap = movesWrapEl;
  if (!wrap || !td) return;

  // clientHeight 为 0 = 还没排版（或者列表被藏起来了），这时没什么好滚的
  const viewHeight = wrap.clientHeight;
  if (!viewHeight) return;

  // 这一行在「列表内容」里的位置：
  // 先量它和外层的矩形差，再加上已经滚掉的量。
  // 不用 offsetTop —— 那个取决于 offsetParent 是谁，在表格里很容易踩坑。
  // 减去 clientTop 是为了把外层那圈边框排除掉。
  const wrapTop = wrap.getBoundingClientRect().top + wrap.clientTop;
  const cellRect = td.getBoundingClientRect();
  const viewTop = wrap.scrollTop;
  const rowTop = cellRect.top - wrapTop + viewTop;
  const rowBottom = rowTop + cellRect.height;

  const delta = scrollDeltaFor(rowTop, rowBottom, viewTop, viewTop + viewHeight);
  if (delta !== null) wrap.scrollTop = viewTop + delta;
}

function render(opts = {}) {
  // 1. 画棋盘（高亮刚走的那一步；再画一支「这里该走哪一步」的推荐箭头）
  const cur = cursor >= 0 ? moveAt(cursor) : null;
  const hl = cur ? { from: cur.from, to: cur.to } : {};
  const arrows = [];

  // 箭头 =「鳕鱼推荐的最优走法」。由「显示设置」里的开关 optArrow 管着，
  // 数据可能是手动分析来的、也可能是后台扫描来的 —— 取哪一份见 arrowEval()。
  // 开关关掉时 arrowEval() 返回 null，这里自然就不画了；
  // 而 board.show 每次都会把箭头层清空重画，所以关掉开关会当场把已有的箭头擦掉。
  const shown = arrowEval();
  if (shown && shown.bestMove) {
    arrows.push({
      from: shown.bestMove.slice(0, 2),
      to: shown.bestMove.slice(2, 4),
      color: BEST_MOVE_ARROW_COLOR,
    });
  }

  board.show(frameAt(cursor), {
    // 只有「一步之内的移动」才做动画。
    // 一口气跳十步的话所有棋子会同时乱飞，反而看不清发生了什么。
    // lineAnimOk()：支线各自有一份时间线自检结果，没通过就只关这条线的动画。
    animate: !!opts.animate && animationOk && lineAnimOk(),
    from: hl.from,
    to: hl.to,
    arrows,
  });

  // 1.5 棋盘下方那一栏「双方已经吃掉了什么」。
  //     纯子力账（走一步数一步），和鳕鱼、DeepSeek 都没有关系 —— 翻页时跟着变。
  renderLedger();

  // 2. 着法列表里高亮当前这一步
  //
  // ⚠️ 主线那份列表只在「现在就在主线上」时高亮：支线的下标是**支线内部**的序号，
  //    和主线下标会撞车（都从 0 开始），不判一下就会在两处同时亮。
  const onMain = onMainLine();  movesBody.querySelectorAll('.move-cell').forEach((td) => {
    const isActive = onMain && Number(td.dataset.index) === cursor;
    td.classList.toggle('active', isActive);
    if (isActive) keepActiveRowVisible(td);
  });

  // 退回到开局时列表里没有「当前这一步」，把它卷回顶部 ——
  // 否则列表会停在中间，和棋盘上的开局完全对不上。
  if (cursor < 0 && onMain && movesWrapEl) movesWrapEl.scrollTop = 0;

  // 2.5 棋盘上的选中高亮 + 可落点（每次重画都要重来一遍：
  //     翻棋盘会把格子重建，之前挂的 class 全没了）
  for (const el of board.squares.values()) el.classList.remove('sel-src', 'sel-target');
  if (selectedSquare && board.squares.has(selectedSquare)) {
    board.squares.get(selectedSquare).classList.add('sel-src');
  }
  for (const m of legalTargets) {
    const el = board.squares.get(m.to);
    if (el) el.classList.add('sel-target');
  }

  // 3. 状态文字
  statusEl.textContent = describePosition(fenAt(cursor));
  moveCounter.textContent = counterText();

  // 3.5 这一步的评注（棋谱自带的话）
  const note = cursor >= 0 ? describeAnnotation(cursor) : '';
  moveNoteEl.textContent = note;
  moveNoteEl.classList.toggle('empty', !note);

  // 4. 到头的按钮就禁用掉（按**当前这条线**的长度算）
  const last = lineLength() - 1;
  document.getElementById('btnFirst').disabled = cursor === -1;
  document.getElementById('btnPrev').disabled  = cursor === -1;
  document.getElementById('btnNext').disabled  = cursor >= last;
  document.getElementById('btnLast').disabled  = cursor >= last;

  // 5. 局势条 + 评估曲线
  renderEvalUi();

  // 6. 着法列表里的评分。
  //    这一步不能少 —— 列表是载入棋谱时一次性建好的，那时候扫描还没开始，
  //    所以每批结果回来之后都得回填一次（顺便也覆盖翻页的情况）。
  updateMoveEvals();

  // 6.5 「你走的支线」那一块 + 棋盘下面那行提示
  renderBranchBlock();
  // ⚠️ 支线表里的高亮必须放在 renderBranchBlock **之后** ——
  //    它每次都会把那张表整个重建，先挂 class 会被冲掉。
  branchListEl.querySelectorAll('.move-cell[data-branch]').forEach((td) => {
    td.classList.toggle('active',
      !onMain && Number(td.dataset.branch) === activeBranchId &&
      Number(td.dataset.index) === cursor);
  });
  updatePlayHint();

  // 7. 引擎面板
  renderAnalysis();

  // 8. 讲解面板。
  //    它也得在这里刷 —— 翻页之后，上一段讲解讲的是别的局面，
  //    面板必须立刻回到"这一步还没讲"的样子，不能赖着不走。
  renderCoach();
}

/**
 * 「第 N 步 / 共 M 步」那一行。
 * ⚠️ 主线那半边**一个字都不能改**（测试和用户都认这个格式），
 *    支线才另写一套 —— 支线的步数是它自己的，和整盘棋的步数不是一回事。
 */
function counterText() {
  const b = activeBranch();
  if (!b) {
    return cursor < 0
      ? '开局 · 共 ' + moves.length + ' 步'
      : '第 ' + (cursor + 1) + ' 步 / 共 ' + moves.length + ' 步';
  }
  return cursor < 0
    ? '支线 ' + b.id + ' · 起点 / 共 ' + b.moves.length + ' 步'
    : '支线 ' + b.id + ' · 第 ' + (cursor + 1) + ' 步 / 共 ' + b.moves.length + ' 步';
}

/** 说出当前局面是什么情况 */
function describePosition(fen) {
  const g = new Chess(fen);
  if (g.isCheckmate()) return '将杀！' + (g.turn() === 'w' ? '黑方获胜' : '白方获胜');
  if (g.isStalemate()) return '逼和（和棋）';
  if (g.isDraw())      return '和棋';

  let text = g.turn() === 'w' ? '轮到白方走' : '轮到黑方走';
  if (g.isCheck()) text += ' · 将军！';
  return text;
}

// ============================================================
// 第四部分：翻页
// ============================================================
function goTo(index) {
  const next = Math.max(-1, Math.min(index, lineLength() - 1));
  // 相邻的一步才做滑动动画；跳转（点列表、按 Home/End）直接切过去
  const adjacent = Math.abs(next - cursor) === 1;
  cursor = next;
  // 换了一步就取消选中 —— 否则"选中 e4"的绿点会跟着飘到别的局面上
  selectedSquare = null;
  legalTargets = [];
  pendingPromotion = null;
  promoPickerEl.hidden = true;
  render({ animate: adjacent });
  // 翻到支线上还没算过的某一步时，也补算一下 —— 主线上"翻到哪步就有哪步的数据"
  // 是整局扫描给的，支线得自己补（已经算过的会直接返回，不会重复问引擎）。
  if (activeBranch()) autoAnalyzeBranchHere();
}

// ============================================================
// 第五部分：局势条 与 评估曲线
// ============================================================

/**
 * 自动评估开着吗？两个显示开关任意一个开着就算开着。
 *
 * 【注意「着法评分」不在这个判断里】
 * 它是纯粹的显示开关 —— 只管着法列表里那串小数字画不画，
 * 不管鳕鱼算不算。理由有两条：
 *   1. 少了整局扫描的时候，列表里剩下的那点评分是**棋谱自带的**
 *      （lichess 导出的对局里有），那是棋谱文件的内容，不该被"要不要后台算"牵连；
 *   2. 「手动模式」这个概念在用户心里就是「你别在后台偷着算」，
 *      它跟"列表里画不画数字"是两件事，混在一起反而说不清。
 */
function wantAutoEval() {
  return optCurve.checked || optBar.checked;
}

/**
 * 当前局面的**手动分析结果** —— 只有它才有资格画到「分析结果」面板里。
 *
 * 【为什么整局扫描的结果不算数】
 * 后台那一轮扫描是给**曲线、局势条、着法评分**这些「显示」用的：用户打开那两个
 * 开关，就是默许了"你可以在后台把整盘棋过一遍"。但「分析结果」是另一码事 ——
 * 它对应棋盘下方那个按钮，用户按了才是"我要看这一步的结论"。
 *
 * 早先这里写的是「手动结果优先，没有就用扫描的」，看着更"充实"，实际后果是：
 *   1. 载入棋谱后什么都没点，"鳕鱼建议走"自己冒出来了，那个按钮显得多余；
 *   2. 把三个开关全关掉之后，它还不走 —— 因为扫描数据还在内存里。
 * 用户报的两个问题，其实是同一个根。
 *
 * 现在分工写死：扫描只喂那几样「显示」，不往「分析结果」面板里写字。
 *
 * ⚠️ 棋盘上的箭头**不归这条规矩管**：它是「显示设置」里的一个独立开关
 * （optArrow），数据可以来自扫描。见下面的 arrowEval()。
 */
function manualEval() {
  return analysisIsFresh() ? Object.assign({ source: 'manual' }, analysis) : null;
}

/**
 * 棋盘上那支箭头该指向哪一步 —— 也就是「鳕鱼推荐的最优走法」。
 *
 * 【数据从哪来】两处，按可信度排：
 *   1. 手动分析（用户点「让鳕鱼分析」要来的那份）—— 有就先用它，
 *      因为它是用户点名要的，用的深度也更高（默认 16，扫描默认 10）；
 *   2. 后台整局扫描 —— 免费，翻到哪一步就有哪一步。
 * 两处都没有就什么都不画。宁可空着，也不拿别的局面的结论凑数。
 *
 * 【为什么手动的那份优先，而面板反过来只认手动】
 * 「分析结果」面板上写着具体数字，用户会照着数字去理解这步棋，
 * 所以它必须是他自己按出来的那一次；箭头只是"这里该走这儿"的一个提示，
 * 精度差一点不影响它的作用，能用免费的就用免费的。
 *
 * 【开关】
 * optArrow 关掉就一律不画。
 * ⚠️ 它和「着法评分」是同一类开关：只决定「画不画」，管不着「算不算」——
 *    后台那一轮扫描跑不跑，由「评估曲线」和「局势条」决定（见 wantAutoEval）。
 *    所以在手动模式下（那两个都关了）它没有扫描数据可用，
 *    只有在用户点过「让鳕鱼分析」之后才会出现。
 */
function arrowEval() {
  if (!optArrow.checked) return null;

  // 手动分析优先。它对**任何**局面都有效（包括你走的支线）——
  // 因为在支线上点「让鳕鱼分析」算的就是眼前这个局面。
  const manual = manualEval();
  if (manual && manual.bestMove) return manual;

  if (onMainLine()) {
    // 主线：整局扫描那一格。evals[k] 是「主线第 k 步走完之后」那个局面。
    const scanned = evals[cursor + 1];
    if (scanned && scanned.done && scanned.bestMove && scanned.source !== 'failed') {
      return scanned;
    }
    return null;
  }

  // 支线：用它自己存的那一份（走完一步自动算的，或者手点分析存的）。
  // 起点那一格是主线上的局面，借扫描的数据。
  const own = branchEngineAt(cursor);
  if (own && own.bestMove) return own;

  return null;
}

/** 刷新局势条、曲线和进度文字 */
function renderEvalUi() {
  // ⚠️ 局势条、曲线、以及后台那轮整局扫描**都只认原棋谱主线**（evals 是按主线步数
  //    索引的）。站在自己走的支线上时，主线那一格的数据和眼前这个局面根本不是一回事 ——
  //    宁可不显示，也不能把别的局面的分数摆在现在的棋盘旁边。
  const b = activeBranch();

  // ---- 局势条 ----
  // 主线上用整局扫描的那一格；支线上用支线自己存的那一份
  // （走完一步就自动算 / 手点「让鳕鱼分析」也会存进去，见 branchEngineAt）。
  // 支线的**起点**是主线上的一个局面，所以那一格直接借扫描的数据。
  const barOn = optBar.checked && (moves.length > 0 || branches.length > 0);
  evalBarEl.hidden = !barOn;
  if (barOn) {
    const p = b ? branchEngineAt(cursor) : evals[cursor + 1];
    if (p && (p.done === undefined || p.done)) evalBar.update(p.scoreCp, p.scoreMate, flipped);
    else evalBar.clear();
  }

  // ---- 曲线 ----
  // 支线不掺进曲线（两盘棋的分数混在一条线上没有意义）。站在支线上时，
  // 曲线照旧画主线，只是把游标停在"支线是从哪一步接出去的"那一格上。
  const curveOn = optCurve.checked && evals.length > 1;
  evalPanelEl.hidden = !curveOn;
  if (curveOn) evalCurve.update(evals, b ? b.atPly + 1 : cursor + 1);
  else evalCurve.clear();

  // ---- 进度 ----
  // 只在「正在算」的时候有内容，算完就无条件清空。
  // （早先这里写的是「文字以『鳕鱼正在算』开头才清空」，但实际文字开头是 🐟 这个表情，
  //   indexOf 返回 2 而不是 0，于是进度条永远停在 52/52 上不下来。）
  if (evalRunning) {
    const done = evals.filter((p) => p && p.done).length;
    evalProgEl.textContent = '🐟 鳕鱼正在算 ' + done + '/' + evals.length + ' …';
  } else {
    evalProgEl.textContent = '';
  }
}

/**
 * 让鳕鱼把整盘棋的每个局面都过一遍。
 *
 * 【为什么要分批】
 * 整局 50 步 = 51 个局面。一次全发出去，用户要对着白屏等十几秒，
 * 而且中间连"算到哪儿了"都不知道。分成每批 8 个，回来一批画一段，
 * 曲线是长出来的，进度条也在动 —— 等待感完全不一样。
 *
 * 【为什么要有 runId】
 * 用户可能在扫描途中换一盘棋、或者把开关关掉。这时候在途的那几批
 * 回来之后就不能再往画面上写了（会串台）。每开一轮就 ++evalRunId，
 * 回调里对不上号就安静退出。
 */
async function startEval() {
  if (!wantAutoEval() || !engineReady || !moves.length) {
    renderEvalUi();
    return;
  }
  if (evalForGame === gameId) {   // 这盘棋已经跑过一轮了，不重复算
    renderEvalUi();
    return;
  }

  const runId = ++evalRunId;
  evalForGame = gameId;
  const depth = Number(scanDepthSel.value) || 10;
  const total = moves.length + 1;

  // 先铺好所有位子，顺手把「已经结束、不用问引擎」的那些本地判掉
  const points = [];
  const pending = [];
  for (let k = 0; k < total; k++) {
    // ⚠️ 用 mainFenAt 而不是 fenAt：这是"把原棋谱过一遍"，索引 k 也是主线步数。
    //    要是用户正站在支线上，fenAt 会给出支线的局面 —— 曲线就串台了。
    const fen = mainFenAt(k - 1);
    const p = {
      index: k, fen, done: false, source: null,
      norm: null, scoreCp: null, scoreMate: null, scoreText: null,
      bestMove: null, bestMoveSan: null, turn: null, depth: null,
    };
    points.push(p);

    const game = new Chess(fen);
    const term = terminalScore(game);
    if (term) {
      // 终局没有着法可走，引擎问不出东西。但谁赢是确定的，本地判就行。
      p.done = true;
      p.source = 'terminal';
      p.scoreCp = term.scoreCp;
      p.scoreMate = term.scoreMate;
      p.scoreText = term.scoreText;
      p.turn = game.turn();
      p.norm = normFromScore(term.scoreCp, term.scoreMate);
    } else {
      pending.push(p);
    }
  }

  evals = points;
  evalRunning = pending.length > 0;
  renderEvalUi();

  for (let i = 0; i < pending.length; i += SCAN_BATCH) {
    if (runId !== evalRunId) return;   // 这一轮已经作废了，安静退出

    const batch = pending.slice(i, i + SCAN_BATCH);
    let data;
    try {
      const res = await fetch('/api/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fens: batch.map((p) => p.fen), depth }),
      });
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ('服务器返回 ' + res.status));
    } catch (err) {
      if (runId !== evalRunId) return;
      evalRunning = false;
      showMessage('评估中断了：' + err.message + '（曲线会停在已经算到的位置）', 'error');
      render();
      return;
    }

    if (runId !== evalRunId) return;

    data.results.forEach((r, j) => {
      const p = batch[j];
      if (!p) return;
      p.done = true;

      if (r.ok && (r.scoreCp !== null && r.scoreCp !== undefined ||
                   r.scoreMate !== null && r.scoreMate !== undefined)) {
        p.source = 'engine';
        p.scoreCp = r.scoreCp;
        p.scoreMate = r.scoreMate;
        p.scoreText = r.scoreText;
        p.bestMove = r.bestMove;
        p.bestMoveSan = r.bestMoveSan;
        p.turn = r.turn;
        p.depth = r.depth;
        p.norm = normFromScore(r.scoreCp, r.scoreMate);
      } else {
        // 引擎对这个局面没话可说（很罕见）。标出来，曲线在这里就断了，
        // 不要拿一个假分数去接。
        p.source = 'failed';
        p.scoreText = r.error || '引擎没给出结果';
      }
    });

    render();   // 顺便把棋盘上的推荐箭头和着法列表的评分也刷新
  }

  if (runId !== evalRunId) return;
  evalRunning = false;
  render();
}

/** 设置项变动时怎么办 */
function onDisplaySettingChange() {
  const manual = !wantAutoEval();

  if (manual) {
    // 曲线和局势条都关了 = 用户要手动模式。
    // 作废正在跑的那一轮，之后只在用户点按钮时才算。
    evalRunId++;
    evalRunning = false;
    // 只在「刚切进来」的那一下提示一次 —— 否则在手动模式里勾一下「着法评分」
    // 也会再弹一遍「已切到手动模式」，看着像是出了什么事。
    if (!manualMode) {
      showMessage('已切到手动模式：后台不再整局扫描，需要时点「🐟 让鳕鱼分析」单独算当前这一步。', '');
    }
  } else {
    // 切回自动模式：把刚才那句撤掉 —— 它已经不成立了。
    // 【用户报的 bug】以前这里什么都不做，于是"已切到手动模式……"会一直挂在页面上，
    // 即使曲线和局势条早就重新打开了。
    // ⚠️ 只撤这一句：别的提示（比如"读到 51 条评注"）不该被开关拨动顺手清掉。
    if (msgEl.textContent.indexOf('已切到手动模式') === 0) showMessage('', '');
    if (moves.length) startEval();   // 没算过就补上；算过的话 startEval 自己会跳过
  }

  manualMode = manual;
  render();
}

// ============================================================
// 第六部分：让鳕鱼分析
// ============================================================

/** 页面打开时先问一下后端：鳕鱼在不在 */
async function checkEngine() {
  try {
    const res = await fetch('/api/engine');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '引擎不可用');
    engineReady = true;
    engineTag.textContent = data.name || '鳕鱼';
    engineTag.classList.add('ok');
    btnAnalyze.disabled = false;

    // 有可能用户手快，在引擎就绪之前就已经把棋谱载进去了。
    // 那时候 startEval 只能干瞪眼，这里补一脚。
    startEval();
  } catch (err) {
    engineReady = false;
    engineTag.textContent = '引擎不可用';
    engineTag.classList.add('bad');
    btnAnalyze.disabled = true;
    analysisError = '鳕鱼没能启动：' + err.message;
    renderAnalysis();
  }
}

/**
 * 拿到某个局面的引擎分析（带缓存）。
 *
 * 它不碰任何界面状态 —— 谁需要，谁自己决定拿到之后往哪儿画。
 * 这一点很要紧：「算一步棋」现在有两个入口（用户点按钮、或者点「讲讲」时
 * 我们替他补算），但"算完之后画到哪"只有用户点按钮那一种。
 * 混在一起写就会出问题：点「讲讲」会顺手往「分析结果」面板里写字。
 */
async function fetchEval(fen, depth, multipv = 1, timeoutMs) {
  const key = evalKey(fen, depth, multipv);
  if (analysisCache.has(key)) return analysisCache.get(key);

  const body = { fen, depth };
  if (multipv > 1) body.multipv = multipv;
  if (timeoutMs) body.timeoutMs = timeoutMs;

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || ('服务器返回 ' + res.status));

  analysisCache.set(key, data);
  return data;
}

/**
 * 缓存的键：局面 + 深度 + 要几条线。
 *
 * ⚠️ 必须把 multipv 也算进去。同一个局面，用 1 条线和 3 条线算出来的是**两份不同的东西**
 *    （后者多了次优解，而且因为要多搜几条分支，深度可能反而浅一点）。
 *    要是共用一个键，"讲讲"用 3 条线算完之后，你再按「让鳕鱼分析」就会拿到那份
 *    "为了照顾三条线而搜得更浅"的结果 —— 屏幕上什么都不会说，数字却悄悄变了。
 */
function evalKey(fen, depth, multipv = 1) {
  return fen + '|' + depth + '|' + multipv;
}

async function analyzeCurrent() {
  if (!engineReady || analyzing) return;

  const fen = fenAt(cursor);
  const depth = Number(depthSelect.value);
  // 多路线：面板要显示次优选和它的后续（见上面 ANALYZE_MULTIPV 的说明）。
  // 缓存键必须带上 multipv，否则和讲棋那份（也是 3 条、深度不同）会互相串。
  const key = evalKey(fen, depth, ANALYZE_MULTIPV);

  // 算过的直接拿
  if (analysisCache.has(key)) {
    analysis = analysisCache.get(key);
    analysisError = null;
    render();
    return;
  }

  analyzing = true;
  analysisError = null;
  renderAnalysis();

  try {
    analysis = await fetchEval(fen, depth, ANALYZE_MULTIPV, ANALYZE_BUDGET_MS);
    stashBranchEngine(activeBranch(), cursor, fen, analysis);
  } catch (err) {
    analysis = null;
    analysisError = err.message;
  } finally {
    analyzing = false;
    render();
  }
}

/**
 * 走支线时，自动把"现在这个局面"算一遍 —— 这样局势条、分数、推荐走法箭头
 * 和主线上是同一个体验（主线上是后台整局扫描给的，支线不在那条扫描里）。
 *
 * ⚠️ 三条边界，都写死在这里：
 *   1. 只在**自动评估开着**（曲线或局势条任一打开）时才算 —— 手动模式就是
 *      "你别在后台偷着算"，这条规矩不能因为支线破例；
 *   2. 只喂局势条 / 分数 / 箭头，**不往「分析结果」面板里写字** ——
 *      那个面板永远只认手动按钮（在支线上点「让鳕鱼分析」照样有效，走的是另一条路）；
 *   3. 结果按局面缓存在 analysisCache 里，来回翻页不会反复问引擎。
 */
let branchAutoBusy = false;

async function autoAnalyzeBranchHere() {
  if (branchAutoBusy || !engineReady || !wantAutoEval()) return;
  const b = activeBranch();
  if (!b || cursor < 0) return;                 // 起点那份借主线的扫描数据，不用算
  const mv = b.moves[cursor];
  if (!mv || mv.engine) return;                 // 已经算过了

  const depth = Number(scanDepthSel.value) || 10;   // 和整局扫描同一个深度
  const fen = fenAt(cursor);
  const branch = b;
  const index = cursor;
  branchAutoBusy = true;
  try {
    const r = await fetchEval(fen, depth);
    if (stashBranchEngine(branch, index, fen, r)) render();
  } catch {
    /* 算不出来就算了：这一格空着，不硬凑一个分数 */
  } finally {
    branchAutoBusy = false;
  }
}

/**
 * 把一个引擎结果挂到支线的某一步上。
 *
 * 【为什么支线要自己存一份】
 * 主线的分数、局势条、箭头全都来自后台那轮**整局扫描**（`evals`，按主线步数索引）。
 * 支线的局面不在那条线上，扫描里没有它们 —— 所以支线这一份要自己算、自己存：
 * 存的是"走完这一步之后那个局面"的评估，正好就是局势条要显示的那一格，
 * 里面的 bestMove 又正好是箭头要的那一手。
 *
 * 存进去的有两种来源，形状一样：走完一步自动算的、以及手点「让鳕鱼分析」的。
 *
 * ⚠️ 只有支线才挂：主线那套索引一旦被塞进别的东西，曲线迟早串台。
 */
function stashBranchEngine(branch, index, fen, result) {
  if (!branch || index < 0 || !branch.moves[index]) return false;
  // 算的过程中用户可能翻页/悔棋了 —— 所以按"当初那一步"核对，而不是按当前 cursor
  if (branch.moves[index].after !== fen) return false;
  if (!result) return false;
  if (!result.bestMove && result.scoreCp === null && result.scoreMate === null) return false;
  branch.moves[index].engine = {
    scoreCp: result.scoreCp, scoreMate: result.scoreMate, scoreText: result.scoreText,
    bestMove: result.bestMove || null, bestMoveSan: result.bestMoveSan || null,
    turn: result.turn || null, depth: result.depth || null,
  };
  return true;
}

/**
 * 支线上第 i 步走完之后那个局面的引擎结果（没有就 null）。
 *
 * i < 0 = 这条线的起点，也就是主线上的某个局面 —— 那一份数据在整局扫描里，
 * 直接借来用，不用再问一次引擎。
 */
function branchEngineAt(i) {
  const b = activeBranch();
  if (!b) return null;
  if (i < 0) {
    const p = evals[b.atPly + 1];
    return (p && p.done && p.bestMove && p.source !== 'failed') ? p : null;
  }
  const mv = b.moves[i];
  return (mv && mv.engine) || null;
}

/** 把分析结果画到面板里 */
function renderAnalysis() {
  btnAnalyze.disabled = !engineReady || analyzing;
  btnAnalyze.textContent = analyzing ? '🐟 正在算…' : '🐟 让鳕鱼分析';

  if (analyzing) {
    analysisBody.innerHTML = '<p class="hint">🐟 鳕鱼正在算，稍等一下…</p>';
    return;
  }

  // 这一块只认手动分析的结果。整局扫描的数据一概不进这里 ——
  // 那是给曲线、局势条和着法评分用的，见 manualEval() 上面那段。
  const shown = manualEval();

  if (analysisError && !shown) {
    analysisBody.innerHTML = '<p class="msg-line bad">❌ ' + esc(analysisError) + '</p>';
    return;
  }

  if (!shown) {
    if (analysis && !analysisIsFresh()) {
      // 算过，但算的是别的局面（用户翻页了）。拿它充数就是在骗人。
      analysisBody.innerHTML = '<p class="hint">这个结果对应的是别的局面（你已经翻页了）。' +
        '点下面的「🐟 让鳕鱼分析」重新算这一步。</p>';
    } else {
      analysisBody.innerHTML = '<p class="hint">翻到某一步，点棋盘下方那个「🐟 让鳕鱼分析」，' +
        '鳕鱼会算出这个局面该走哪步、好坏多少。</p>';
    }
    return;
  }

  // 没有可走的着法。
  // 这里不能只看「引擎没给着法」就下结论 —— 得自己确认这局面是不是真的结束了，
  // 因为引擎对已经将杀的局面只会回一句 bestmove (none)，什么都不解释。
  if (!shown.bestMove) {
    const over = terminalScore(new Chess(shown.fen || fenAt(cursor)));
    if (over) {
      analysisBody.innerHTML =
        '<div class="best ended">' +
          '<div class="best-label">这盘棋已经结束</div>' +
          '<div class="best-move">' + esc(over.scoreText) + '</div>' +
        '</div>';
    } else {
      analysisBody.innerHTML =
        '<p class="msg-line">这个局面鳕鱼没给出着法：' + esc(shown.scoreText || '算不出来') + '</p>';
    }
    return;
  }

  // 走到这儿说明是手动细算的结果：有后续变化、有跑分、箭头是橙色的。
  const cls = sideOf(shown.scoreCp, shown.scoreMate);

  const evalHtml =
    '<div class="eval ' + cls + '">' +
      '<span class="eval-num">' + esc(shown.scoreText) + '</span>' +
      '<span class="eval-label">' + esc(evalLabel(shown)) + '</span>' +
    '</div>';

  const pvHtml = (shown.pvSan && shown.pvSan.length)
    ? '<div class="pv"><span class="pv-label">引擎预想的后续</span><code>' +
        esc(formatPv(shown.pvSan, moveNumberAt(absolutePly()), shown.turn)) + '</code></div>'
    : '';

  const altHtml = renderAlternatives(shown);

  const statsHtml =
    '<div class="stats">' +
      '<span>深度 ' + shown.depth + '</span>' +
      '<span>' + fmtNum(shown.nodes) + ' 个局面</span>' +
      (shown.timeMs ? '<span>' + (shown.timeMs / 1000).toFixed(2) + ' 秒</span>' : '') +
      '<span>刚花 ' + shown.wallMs + 'ms</span>' +
    '</div>';

  analysisBody.innerHTML =
    '<div class="best">' +
      '<div class="best-label">鳕鱼建议走</div>' +
      '<div class="best-move">' + esc(shown.bestMoveSan || shown.bestMove) + '</div>' +
      '<div class="best-uci">' + esc(shown.bestMove) + '　→　棋盘上橙色箭头就是它</div>' +
    '</div>' +
    evalHtml + pvHtml + altHtml + statsHtml;
}

/**
 * 「引擎认为的次优选」—— 首选之外，引擎排出来的其余候选，各自带后续着法。
 *
 * 【为什么值得单独摊开】只给"该走这一步"一个答案，用户没法判断这一步到底是
 * 真正的好棋，还是不得已只能这样走 —— 候选之间的**分差**才回答那个问题。
 * 这也是讲棋订单里"是不是唯一解"那一行的同一个数据源（MultiPV）。
 *
 * 每一条都给：序号 + 着法名 + 起止格 + 评分 + 与首选的分差 + 它自己的后续。
 */
function renderAlternatives(shown) {
  const alts = (Array.isArray(shown.alternatives) ? shown.alternatives : [])
    .filter((a) => a && a.firstMoveSan);
  if (!alts.length) return '';

  const best = { scoreCp: shown.scoreCp, scoreMate: shown.scoreMate };
  const items = alts.map((a) => {
    // 起止格：分析接口同时给了 UCI（pv[0]）和 SAN，用 UCI 切出 from→to 最稳
    const uci = (Array.isArray(a.pv) && a.pv[0]) ? String(a.pv[0]) : '';
    const anchor = uci.length >= 4
      ? uci.slice(0, 2) + '→' + uci.slice(2, 4)
      : '';
    const gap = gapVsBest(best, a);
    const pv = (Array.isArray(a.pvSan) && a.pvSan.length)
      ? '<div class="alt-pv"><span class="pv-label">后续</span><code>' +
        esc(formatPv(a.pvSan, moveNumberAt(absolutePly()), shown.turn)) + '</code></div>'
      : '';
    return '<li class="alt-item">' +
      '<div class="alt-line">' +
        '<span class="alt-rank">' + esc(String(a.rank || '?')) + '</span>' +
        '<span class="alt-move">' + esc(a.firstMoveSan) + '</span>' +
        (anchor ? '<span class="alt-anchor">' + esc(anchor) + '</span>' : '') +
        '<span class="alt-score ' + sideOf(a.scoreCp, a.scoreMate) + '">' +
          esc(a.scoreText || compactScore(a.scoreCp, a.scoreMate)) + '</span>' +
        (gap ? '<span class="alt-gap">' + esc(gap) + '</span>' : '') +
      '</div>' + pv +
    '</li>';
  }).join('');

  return '<div class="alts">' +
    '<div class="alts-head">引擎认为的次优选（同一局面下引擎排的另外几条）</div>' +
    '<ol class="alt-list">' + items + '</ol>' +
  '</div>';
}

function evalLabel(a) {
  if (a.scoreMate !== null && a.scoreMate > 0) return '白方胜势';
  if (a.scoreMate !== null && a.scoreMate < 0) return '黑方胜势';
  if (a.scoreCp === null) return '';
  if (a.scoreCp > 80) return '白方占优';
  if (a.scoreCp < -80) return '黑方占优';
  return '大致均势';
}

/**
 * 「第 p 个半回合」是第几回合。
 *
 * ⚠️ 不能一律用 `floor(p / 2) + 1`：那只在"棋谱从开局摆起、白方先走"时成立。
 *    用 [FEN "..."] 从**中局**摆起的棋谱，可能轮到黑方先走，也可能从第 20 回合开始。
 *    这里两个都照 startFen 自己的字段来（第 2 个字段=轮到谁，第 6 个字段=第几回合）。
 */
function moveNumberAt(ply) {
  const parts = String(startFen || '').split(/\s+/);
  const startFullmove = Number(parts[5] || '1') || 1;
  const startOffset = parts[1] === 'b' ? 1 : 0;   // 起始局面轮到黑方走 → 白方先欠一手
  return startFullmove + Math.floor((startOffset + ply) / 2);
}

/** 把 PV 排成 "4... Nf6 5. Nc3" 这样带编号的样子 */
function formatPv(sanList, firstMoveNo, nextTurn) {
  const out = [];
  let moveNo = firstMoveNo;          // 下一手的回合号
  let turn = nextTurn;               // 现在轮到谁
  for (const san of sanList.slice(0, 8)) {
    // ⚠️ 轮到黑方走时也要写编号（"4... Nf6"），不能只写着法名。
    //    早先这里写的是 `ply === 0 ? '1... ' + san : san` —— 只有开局那一手有编号，
    //    中局翻到黑方走时，这一行会变成 "… Nf6 5. Nc3"，前半截没有回合号，
    //    和本函数上面那句示例（"4... Nf6 5. Nc3"）也对不上。
    out.push(moveNo + (turn === 'w' ? '. ' : '... ') + san);
    if (turn === 'b') moveNo++;      // 黑方走完，回合数才 +1
    turn = turn === 'w' ? 'b' : 'w';
  }
  return out.join(' ');
}

function fmtNum(n) {
  if (!n) return '0';
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// 第六部分之二：DeepSeek 讲解
//
// 【翻页竞态 —— 这段代码里最容易出错的地方】
//
// 用户点了「讲讲」，请求飞出去，模型要想好几秒。
// 这几秒里他很可能已经翻到下一步了。等那段讲解回来的时候，
// 它讲的是**上一步** —— 要是直接画到屏幕上，就是在骗人：
// 屏幕上明明是第 15 步，讲解说的是第 14 步的事，还挺像那么回事。
//
// 处理办法和鳕鱼那边一模一样：每段讲解都记着自己是给哪个局面的，
// 画之前先把局面比一遍（explainRecord.fen === fenAt(cursor)），
// 对不上就不画。
//
// 另外还有一个"先点后到"的问题：连点两次，第一次慢、第二次快，
// 快的先到、慢的后到，结果被慢的覆盖。用一个自增的 runId 解决 ——
// 交卷的时候先对号，对不上就直接扔掉。
// ============================================================

/** 页面打开时问一句后端：讲棋功能能不能用、用的哪个模型 */
async function checkLlm() {
  try {
    const res = await fetch('/api/llm');
    const data = await res.json();
    llmInfo = data;
    llmReady = !!data.configured;

    if (llmReady) {
      llmTag.textContent = data.model || 'DeepSeek';
      llmTag.className = 'tag ok';
      subtitleEl.textContent = '鳕鱼算棋 · DeepSeek 讲棋';
    } else {
      llmTag.textContent = '未配密钥';
      llmTag.className = 'tag bad';
      subtitleEl.textContent = '鳕鱼算棋 · DeepSeek 讲棋（还没配密钥）';
    }
  } catch {
    llmReady = false;
    llmTag.textContent = '连不上';
    llmTag.className = 'tag bad';
  }
  renderCoach();
}

/** 这份评分里到底有没有东西？（cp 和 mate 有一个就算有） */
function hasScore(o) {
  if (!o) return false;
  return (o.scoreCp !== null && o.scoreCp !== undefined) ||
         (o.scoreMate !== null && o.scoreMate !== undefined);
}

/**
 * 讲棋之前，先把「鳕鱼的事实」备齐。
 *
 * 【为什么必须现算，而不是等用户先去点「让鳕鱼分析」】
 * 用户按的是「讲讲」，不是「分析」。要他自己先点另一个按钮、再回来点这个，
 * 是两个动作换一个结果，而且很容易点完一头雾水 —— "怎么没反应？"
 * 既然讲解的意义就是"把鳕鱼算出来的东西讲成人话"，这一步由我们替他做掉，
 * 之后讲解上面还会把最佳走法和评分原样摆出来（用户要的就是这个对照）。
 *
 * 顺带也算上一步：有了前后两个评分，才谈得上"这一步亏了多少" ——
 * 那是整份提示词里最有用的一行。
 */
async function gatherEngineFacts() {
  const depth = EXPLAIN_DEPTH;
  const fen = fenAt(cursor);
  const beforeFen = fenAt(cursor - 1);

  // 现在这个局面：算得更深、而且要前三条候选（要它们才讲得出"是不是唯一解"）
  //
  // ⚠️ 这一次失败**不该把整份事实都带走**。它和下面那次是两次独立调用，
  //    任一次挂了，另一次的结果依然有价值（"他当时有哪些选择"照样能讲）。
  //    所以两次都各自兜住异常，谁挂谁自己变成 null。
  let now = null;
  try {
    now = await fetchEval(fen, depth, EXPLAIN_MULTIPV, EXPLAIN_BUDGET_MS);
  } catch {
    now = null;
  }

  // 走这一步之前那个局面：同样要候选。
  //
  // ⚠️ 这里**不再**挪用整局扫描算好的那份（以前会，省一次调用）。
  //    因为扫描是单线深度的，拿它来就没有次优解 —— 而"这一步是
  //    真正的好棋还是不得已只能这样走"这个判断，恰恰全靠走之前那个局面的候选。
  //    代价是多花几秒，换来的是讲解能回答用户真正在问的那个问题。
  let before = null;
  if (cursor >= 0) {
    try {
      before = await fetchEval(beforeFen, depth, EXPLAIN_MULTIPV, EXPLAIN_BUDGET_MS);
    } catch {
      before = null;   // 拿不到就算了：少一段"他有哪些选择"，讲解照样能讲
    }
  }

  // 走这一步的是谁。"亏了多少"要从他自己的角度看，
  // 同一份评分，白方亏了就是黑方赚了。
  const color = fenAt(cursor - 1).split(/\s+/)[1] === 'b' ? 'b' : 'w';

  // 他实际走的是哪一步。用来判断"引擎的首选"和"他走的"是不是同一个 ——
  // 是同一个的话，那句"本该走 X"会读起来像在批评一步好棋。
  // ⚠️ moveAt：站在支线上时这一步是支线上的着法，不是原棋谱同一位置的那一步。
  const playedSan = cursor >= 0 && moveAt(cursor) ? moveAt(cursor).san : '';

  return { now, before, color, playedSan, beforeFen };
}

/**
 * 只把一条候选里我们自己要用的字段挑出来（去掉一大堆前端用不上的东西）。
 * 不做校验 —— 校验是后端的活，它连"这个局面是不是真的"都会自己复核一遍。
 */
function packCandidates(o) {
  if (!o || !Array.isArray(o.alternatives)) return [];
  return o.alternatives.map((a) => ({
    rank: a.rank,
    firstMoveSan: a.firstMoveSan,
    scoreCp: a.scoreCp,
    scoreMate: a.scoreMate,
    scoreText: a.scoreText,
    // 后续变化带上，后端会拿它把**每一步之后的棋盘**一步步推出来
    pvSan: a.pvSan || [],
  }));
}

/**
 * 把这一步的情况打包好，准备发给后端。
 *
 * 数据全部来自现成的几份东西，一处都不重算：
 *   moves[cursor]        这一步走的是什么
 *   fenAt(cursor - 1)    走这一步之前的局面
 *   facts.now            鳕鱼对**现在**这个局面的判断（建议走哪步、后续变化、次优解）
 *   facts.before         鳕鱼对走之前那个局面的判断（他当时有哪些选择）
 *   annotations[cursor]  棋谱作者原本写的评注（如果有）
 *
 * ⚠️ 「这一步亏了多少」「哪一步动了哪个子」「后续每一步之后的棋盘」
 *    **都不在前端算**。这里只负责把原始材料送出去 ——
 *    后端会用 chess.js 自己复算一遍（见 coach.js / position.js）。
 *    这样即便某天前端算错了、或者接口被别处调用，讲出来的事实也不会跟着错。
 */
function buildExplainPayload(fen, facts) {
  // ⚠️ 一律用 moveAt / annotationAt / lineTrail（"当前这条线"上的东西）：
  //    站在你走的支线上时，原棋谱同一位置的那一步、那条评注、那段历史
  //    都不是眼前这盘棋的一部分，混进去讲出来的每一句都是错的。
  const move = cursor >= 0 ? moveAt(cursor) : null;

  // 走这一步之前轮到谁 —— 从 FEN 里读，比用步数奇偶去猜可靠
  // （棋谱有可能是从中局开始摆的）
  const beforeFen = fenAt(cursor - 1);
  const color = beforeFen.split(/\s+/)[1] === 'b' ? 'b' : 'w';

  const ann = cursor >= 0 ? annotationAt(cursor) : null;
  const now = (facts && facts.now) || null;
  const before = (facts && facts.before) || null;

  // 这条线上一共有哪些着法（主线前缀 + 支线），opening / history 都从它切
  const trail = lineTrail();

  return {
    fen,
    // 走这一步**之前**的局面。后端会核对"把它走出 san 是不是正好得到 fen"，
    // 对不上就整段丢掉 —— 所以这个字段宁可不送，也不要送个错的。
    beforeFen,
    // 再往前一手（对方上一手走之前）的局面 + 那一手的着法。
    // 用户要的"先判断对手上一步想干什么、再推理我方怎么应对"就靠这一层：
    // 有了它，模型才能看见那一步到底改了什么，而不是凭空猜意图。
    // 后端会再核一遍链条（prevFen 走出 prevSan 必须正好得到 beforeFen）。
    prevFen: cursor >= 1 ? fenAt(cursor - 2) : '',
    prevSan: cursor >= 1 && moveAt(cursor - 1) ? moveAt(cursor - 1).san : '',
    // ply 是**整盘棋**的半回合号（从开局算），不是"这条线内部的第几步" ——
    // 支线的第一步可能是第 3 回合黑方那一手，报成 1 的话讲解里回合号全错。
    ply: absolutePly(),
    san: move ? move.san : '',
    color,
    engine: now ? {
      scoreCp: now.scoreCp,
      scoreMate: now.scoreMate,
      scoreText: now.scoreText,
      bestMoveSan: now.bestMoveSan,
      // 走这一步**之前**那个局面，引擎建议走什么 —— 也就是"本该走的那一步"。
      // 这是整段讲解里最有对照价值的一条：他走了 Nf3，引擎说该走 Nc3。
      // 后端会把它单独写成一行，好让模型别把"现在的建议"和"刚才该走什么"搅在一起。
      bestMoveBeforeSan: before ? before.bestMoveSan : null,
      pvSan: now.pvSan || [],
      // 次优解。有了它，模型才能说"g6 和 Qe7 都守得住"，
      // 也才能判断这一步是真正的好棋还是不得已。
      alternatives: packCandidates(now),
      depth: now.depth,
    } : null,
    // 走之前那个局面的完整引擎结果（同样带次优解）——
    // 这一段专门用来回答"他当时还有别的路吗"。
    engineBefore: before ? {
      scoreCp: before.scoreCp,
      scoreMate: before.scoreMate,
      scoreText: before.scoreText,
      bestMoveSan: before.bestMoveSan,
      pvSan: before.pvSan || [],
      alternatives: packCandidates(before),
      depth: before.depth,
    } : null,
    // 前后两个原始评分。后端自己算差，不盲信我们。
    swing: hasScore(before) ? {
      beforeCp: before.scoreCp,
      beforeMate: before.scoreMate,
      afterCp: now ? now.scoreCp : null,
      afterMate: now ? now.scoreMate : null,
    } : null,
    opening: trail.slice(0, 6).map((m) => m.san),
    history: trail.slice(Math.max(0, trail.length - 7), Math.max(0, trail.length - 1))
      .map((m) => m.san),
    annotation: (ann && ann.comment) ? ann.comment : '',
    gameOver: !!terminalScore(new Chess(fen)),
    // 多轮记忆：这盘棋**之前几手**讲过什么（只有"要点"那一句）。
    // ⚠️ 只带**主线**的（支线不做记忆 —— 见 mainRecap 的说明）：
    //    站在支线上时带上主线的结论，会让它把另一条线的事讲成这条线的。
    recap: onMainLine() ? mainRecap : [],
  };
}

/**
 * ============================================================
 * 多轮记忆：把每次讲解结尾那一行「【要点】…」攒起来，下次带上
 * ============================================================
 * 【为什么这么做】
 * 没有它，每次讲棋都是失忆的：同一个漏洞讲三遍，甚至前后打架。
 *
 * 【为什么让模型自己写要点，而不是我们截正文】
 * 截头尾句经常截到一句废话，喂回去反而把后面的讲解带歪。
 * 让它在结尾多写一行 30 字以内的要点，只多花十几个 token，质量高得多。
 * 这一行**不显示给用户**（正文里会被剥掉），只当记忆用。
 *
 * 【为什么只记主线】
 * 支线各讲各的；把主线的结论带进支线（或者反过来），
 * 它会讲出"另一条线上才发生的事"，比失忆更糟。所以支线一律不带、也不记。
 */
let mainRecap = [];

/** 把讲解正文里那一行「【要点】…」剥出来 */
function splitRecap(text) {
  const src = String(text || '');
  const m = src.match(/^\s*【要点】\s*(.+?)\s*$/m);
  if (!m) return { text: src, point: '' };
  return {
    // 连同那一行所在的空行一起去掉，正文末尾不留空段
    text: src.replace(/^\s*【要点】[^\n]*\n?/m, '').replace(/\s+$/, ''),
    point: m[1].replace(/\s+/g, ' ').trim().slice(0, 40),
  };
}

/** 请 DeepSeek 讲一讲当前这一步 */
async function explainCurrent() {
  if (!llmReady || explaining) return;

  const fen = fenAt(cursor);

  // 这个局面讲过了 —— 直接拿出来，不重复花钱
  if (explainCache.has(fen)) {
    explainRecord = explainCache.get(fen);
    renderCoach();
    return;
  }

  const runId = ++explainRunId;
  explaining = true;
  explainRecord = null;
  pendingFacts = null;
  renderCoach();

  // ---------- 第一步：让鳕鱼把事实摆出来 ----------
  // 引擎没数据不是致命错误：讲解照样能讲，只是没有具体数字。
  // 那种情况下不会给它派数字，面板上也会如实说一句 ——
  // 宁可少说，也不许它自己编。
  let facts = null;
  try {
    facts = await gatherEngineFacts();
  } catch (err) {
    facts = null;
    if (runId === explainRunId) analysisError = '鳕鱼这一步没算出来：' + err.message;
  }

  if (runId !== explainRunId) return;   // 期间又点了一次，这次作废
  pendingFacts = facts;
  render();

  // ---------- 第二步：请它讲 ----------
  try {
    const res = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildExplainPayload(fen, facts)),
    });

    // 连 JSON 都不一定是 —— 服务器被打挂了、代理插了一页 HTML，
    // 都可能让 .json() 抛出来。这里不赌，解析失败就当没内容。
    let data = null;
    try { data = await res.json(); } catch { data = null; }

    if (runId !== explainRunId) return;   // 期间又点了一次，这次结果作废

    if (!res.ok || !data || !data.ok) {
      const code = (data && data.code) || '';
      explainRecord = {
        fen,
        facts,
        error: {
          message: (data && data.error) || ('服务器返回 HTTP ' + res.status),
          hint: (data && data.hint) || '',
          detail: (data && data.detail) || '',
          code,
        },
      };
      // 没配密钥这种事，光靠重试是解决不了的 —— 当场把按钮锁上，
      // 免得用户对着一个注定失败的按钮反复点。
      if (code === 'no_key') {
        llmReady = false;
        llmTag.textContent = '未配密钥';
        llmTag.className = 'tag bad';
      }
    } else {
      // 讲解结尾那一行「【要点】…」是给记忆用的，不显示给用户
      const parts = splitRecap(data.text);
      explainRecord = {
        fen,
        // 事实和讲解存在一起。这样以后翻回来直接读缓存时，
        // 上面的数字和下面的讲解仍然是同一次的 —— 不会新旧混着摆。
        facts,
        text: parts.text,
        point: parts.point,
        model: data.model,
        usage: data.usage,
        attempts: data.attempts,
        elapsedMs: data.elapsedMs,
      };
      explainCache.set(fen, explainRecord);

      // 攒进"这盘棋讲过什么"。只收主线上的讲解 —— 支线不做记忆。
      if (parts.point && onMainLine() && cursor >= 0) {
        mainRecap.push({ ply: absolutePly(), san: (moveAt(cursor) || {}).san || '', text: parts.point });
        if (mainRecap.length > 5) mainRecap = mainRecap.slice(-5);
      }
    }
  } catch (err) {
    if (runId !== explainRunId) return;
    explainRecord = {
      fen,
      facts,
      error: {
        message: '连不上本机服务器：' + err.message,
        hint: '后端还在跑吗？在项目目录里 npm start 就能起来。',
      },
    };
  } finally {
    // 只有"最新那次请求"才有资格把状态收尾 ——
    // 否则一次早该被作废的请求会把正在跑的那次给盖掉
    if (runId === explainRunId) {
      explaining = false;
      pendingFacts = null;
      render();
    }
  }
}

/**
 * 鳕鱼的事实条：建议走哪步、评分多少、这一步比上一步好还是坏。
 *
 * 它坐在讲解正文的**上面**，因为这正是用户要的对照 ——
 * 「鳕鱼算出这么个结论，你给我讲讲为什么」。数字在上、人话在下，
 * 和「分析结果」卡片里"鳕鱼在上、DeepSeek 在下"是同一个顺序。
 */
function renderFacts(facts) {
  if (!facts || !facts.now) return '';

  const now = facts.now;
  const swing = swingNote(facts);

  // 「本该走的那一步」。引擎对**现在**这个局面给的建议是给对手的，
  // 而这个才是"他刚才应该走什么" —— 用户最想看的往往是这一条。
  //
  // ⚠️ 他走的正好就是引擎首选时，别写成"本该走 X" —— 那读起来像在批评
  //    一步好棋。实测 1...e5 就撞上了：棋谱里走的 e5，事实条上写"本该走 e5"。
  const was = facts.before && facts.before.bestMoveSan;
  const wasIsPlayed = was && facts.playedSan && was === facts.playedSan;

  return '<div class="coach-facts">' +
      '<span class="cf-tag">🐟 鳕鱼建议</span>' +
      '<span class="cf-move">' + esc(now.bestMoveSan || now.bestMove || '—') + '</span>' +
      '<span class="cf-score ' + sideOf(now.scoreCp, now.scoreMate) + '">' +
        esc(now.scoreText || '—') + '</span>' +
      '<span class="cf-note">' + esc(evalLabel(now)) + '</span>' +
      (was ? '<span class="cf-was' + (wasIsPlayed ? ' same' : '') + '">' +
        (wasIsPlayed ? '走的正是引擎首选 ' : '本该走 ') +
        '<b>' + esc(was) + '</b></span>' : '') +
      (swing ? '<span class="cf-swing">' + esc(swing) + '</span>' : '') +
    '</div>';
}

/**
 * 「这一步亏了 / 赚了多少」。
 * 两个评分都是白方视角，而"亏赚"要从走棋方自己的角度看 ——
 * 同一份评分，白方亏了就是黑方赚了。
 */
function swingNote(facts) {
  const { before, now, color } = facts || {};
  if (!hasScore(before) || !hasScore(now)) return '';
  if (before.scoreCp === null || before.scoreCp === undefined) return '';
  if (now.scoreCp === null || now.scoreCp === undefined) return '';

  const sign = color === 'b' ? -1 : 1;
  const delta = (now.scoreCp - before.scoreCp) * sign;

  if (Math.abs(delta) < 30) return '基本没改变局势';
  return '这一步' + (delta < 0 ? '亏' : '赚') + '了约 ' +
    (Math.abs(delta) / 100).toFixed(2) + ' 个兵';
}

/** 把讲解画出来 */
function renderCoach() {
  const fen = fenAt(cursor);

  btnExplain.disabled = !llmReady || explaining;
  btnExplain.textContent = explaining ? '🤖 正在讲…' : '🤖 让 DeepSeek 讲讲';

  // 优先用「跟当前局面对得上」的那份记录，其次翻缓存
  const live = (explainRecord && explainRecord.fen === fen) ? explainRecord : null;
  const rec = (live && live.text) ? live : (explainCache.get(fen) || live);

  if (explaining) {
    coachBody.innerHTML =
      (pendingFacts ? renderFacts(pendingFacts) : '') +
      '<p class="hint">' + (pendingFacts
        ? '🐟 数字齐了，🤖 正在把它讲成人话，稍等几秒…'
        : '🐟 先让鳕鱼把这一步算清楚 —— 这次要算得更深、还要多算几条路线，' +
          '得等几秒，然后才轮到 DeepSeek 讲…') + '</p>';
    return;
  }

  if (rec && rec.text) {
    coachBody.innerHTML =
      (rec.facts
        ? renderFacts(rec.facts)
        : '<p class="hint coach-nofacts">这次没拿到鳕鱼的数据（引擎可能正忙），' +
          '所以下面这段讲解里不会有具体评分 —— 那是有意的：' +
          '宁可它少说，也不许它自己编数字。</p>') +
      '<div class="coach-text">' + renderMarkdownLite(rec.text) + '</div>' +
      '<div class="coach-foot">' +
        '<span>' + esc(rec.model || 'DeepSeek') + '</span>' +
        (rec.elapsedMs ? '<span>' + (rec.elapsedMs / 1000).toFixed(1) + ' 秒</span>' : '') +
        (rec.attempts > 1 ? '<span>重试了 ' + (rec.attempts - 1) + ' 次才成功</span>' : '') +
        (rec.usage && rec.usage.total_tokens ? '<span>' + rec.usage.total_tokens + ' tokens</span>' : '') +
        (explainRecord !== rec ? '<span>这一步之前讲过了（用的旧结果）</span>' : '') +
      '</div>';
    return;
  }

  if (live && live.error) {
    const e = live.error;
    coachBody.innerHTML =
      (live.facts ? renderFacts(live.facts) : '') +
      '<p class="msg-line bad">❌ ' + esc(e.message) + '</p>' +
      (e.hint ? '<p class="hint">' + esc(e.hint) + '</p>' : '') +
      (e.detail ? '<details class="coach-detail"><summary>技术细节</summary>' +
        '<code>' + esc(e.detail) + '</code></details>' : '') +
      (e.code !== 'no_key' && e.code !== 'auth' && e.code !== 'insufficient_balance'
        ? '<p class="hint">点上面的按钮可以再试一次。</p>' : '');
    return;
  }

  // 什么结果都没有 —— 告诉用户现在是个什么情况，以及该做什么
  if (!llmReady) {
    coachBody.innerHTML =
      '<p class="hint">想听讲解，需要在服务器上配一个 DeepSeek 密钥：' +
      '在项目根目录的 <code>.env</code> 里写上一行 ' +
      '<code>DEEPSEEK_API_KEY=sk-你的密钥</code>，保存后刷新页面就行' +
      '（改了 .env 不用重启服务器）。<br>' +
      '没配也不影响别的功能 —— 算棋、评估曲线、复盘都能照常玩，只是少了讲解。<br>' +
      '（密钥只留在你本机，不会进浏览器 —— 这也是为什么讲棋要绕一趟服务器。）</p>';
  } else if (!moves.length) {
    coachBody.innerHTML = '<p class="hint">先载入一盘棋谱，再让它讲。</p>';
  } else {
    coachBody.innerHTML =
      '<p class="hint">想知道这一步为什么好或不好？点上面的按钮 —— ' +
      '它会先让鳕鱼把这一步算清楚（最佳走法、评分、后续变化），' +
      '上面会把这些数字原样摆出来，下面才是讲给你听的人话。<br>' +
      '它负责解释，不负责编数字。</p>';
  }
}

/**
 * 把模型回的 Markdown 画成 HTML。
 *
 * ⚠️ 顺序不能反：**先去转义，再拼标签**。
 *
 * 模型回的内容本质上是外部输入 —— 虽然是我们请它写的，但它的输入里
 * 有 PGN、有棋谱评注，理论上可以被诱导着吐出 <script>。
 * 先 esc 一遍，`<` 全都变成 `&lt;`，然后我们只插入自己造的标签，
 * 注入就无从谈起。
 *
 * （这条规矩在哪儿都一样：只要一段文本要变成 HTML，就先转义，
 *   再往里加格式。顺序反了就是漏洞。）
 */
function renderMarkdownLite(text) {
  const safe = esc(text);
  const out = [];

  for (const block of safe.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // 整块都是 "- xxx" 这种，就当列表
    if (lines.every((l) => /^([-*+]|\d+\.)\s+/.test(l))) {
      out.push('<ul>' + lines
        .map((l) => '<li>' + inlineMd(l.replace(/^([-*+]|\d+\.)\s+/, '')) + '</li>')
        .join('') + '</ul>');
      continue;
    }

    // 其余当段落。模型偶尔不听话写标题，把 # 去掉就行。
    out.push('<p>' + lines
      .map((l) => inlineMd(l.replace(/^#{1,6}\s+/, '')))
      .join('<br>') + '</p>');
  }

  return out.join('');
}

/** 行内格式：**加粗** 和 `代码`。传进来的字符串已经转义过了 */
function inlineMd(s) {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

// ============================================================
// 第八部分：导出棋谱（主线 + 你走的支线）
//
// 【支线写成什么】
// 写成**标准 PGN 变着**（圆括号），插在它替换掉的那一步旁边：
//
//     1. e4 1... e5 { 下面这些是你在棋盘上走的支线 } ( 2. Nc6 2... Bb5 ) 2. Nf3 ...
//
// 任何棋软（lichess / Arena / ChessBase）打开都能当变着看。
//
// ⚠️ 为什么不用 chess.js 的 pgn()：它只输出主线，会把变着整个丢掉
//    （我们自己的 pgn.js 读的时候也只走主线，见那边的说明）。
//    所以 movetext 自己拼 —— 拼法短、确定、而且能拿 parsePgn 反过来验。
// ============================================================

/** 绝对半回合号 → "12. " 或 "12... "（白方那一手用点，黑方那一手用三个点） */
function plyPrefix(p) {
  const parts = String(startFen || '').split(/\s+/);
  const off = parts[1] === 'b' ? 1 : 0;
  return moveNumberAt(p) + (((off + p) % 2 === 0) ? '. ' : '... ');
}

/** 一条支线写成 PGN 变着：( 3... Nf6 4. Bxc6 ) */
function variationText(b) {
  const body = b.moves
    .map((mv, j) => plyPrefix(b.atPly + 1 + j) + mv.san)
    .join(' ');
  return '{ 你在棋盘上走的支线 ' + b.id + ' } ( ' + body + ' )';
}

/** 把主线 + 全部支线拼成一段完整 PGN */
function buildExportPgn() {
  // ⚠️ PGN 的规矩：变着要写在**它替换掉的那一步之后**
  //    （规范原话是"an alternative to the move immediately preceding it"），
  //    不是之前。所以 atPly = k 的支线替换的是主线第 k+1 步，那个圆括号
  //    要跟在主线第 k+1 步后面。
  //
  //    这一点是实测出来的：写在前面（movetext 一开头就是 `( ... )`）
  //    chess.js 直接拒收 —— "Expected brace comment, end of input, ..."。
  //    注释也一样：`{ 注释 } ( 变着 )` 可以，`( { 注释 } 变着 )` 不行。
  const afterPly = new Map();
  for (const b of branches) {
    const at = b.atPly + 1;
    if (!afterPly.has(at)) afterPly.set(at, []);
    afterPly.get(at).push(b);
  }

  const body = [];
  moves.forEach((mv, i) => {
    body.push(plyPrefix(i) + mv.san);
    for (const b of (afterPly.get(i) || [])) body.push(variationText(b));
  });
  // 接在主线末尾之后的支线（atPly + 1 已经越过主线长度）—— 直接排在最后
  for (const b of branches) {
    if (b.atPly + 1 >= moves.length) body.push(variationText(b));
  }
  body.push(gameResult && gameResult !== '*' ? gameResult : '*');

  // 头部：原棋谱的照抄（含 [FEN]/[SetUp]，不然中局摆起的棋谱重放不出来），
  // 缺 White/Black 就补上 —— 别的软件读到空头部会不认。
  const headers = Object.assign({}, loadedHeaders);
  if (!headers.White) headers.White = '?';
  if (!headers.Black) headers.Black = '?';
  headers.Result = (gameResult && gameResult !== '*') ? gameResult : '*';
  if (branches.length) headers.Annotator = 'DeepFish（含棋盘上自己走的支线）';

  const head = Object.keys(headers)
    .map((k) => '[' + k + ' "' + String(headers[k]).replace(/"/g, "'") + '"]')
    .join('\n');

  return head + '\n\n' + body.join(' ') + '\n';
}

/** 打开导出面板：把拼好的 PGN 放进可复制的文本框里，并记成"已导出" */
function openExportPanel() {
  exportTextEl.value = buildExportPgn();
  exportPanelEl.hidden = false;
  // 只要用户看过/复制过这份原文，就不再拦着关页面了 ——
  // 宁可少提醒一次，也不要每次都拦（拦多了用户会直接忽略）
  branchesExported = true;
  loadGuardEl.hidden = true;
  renderBranchBlock();
  showMessage('棋谱导出了（上面那个框里就是完整 PGN，可以复制走）。', '');
}

/** 下载成 .pgn 文件 */
function downloadPgn() {
  const text = exportTextEl.value || buildExportPgn();
  try {
    const blob = new Blob([text], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (loadedHeaders.White && loadedHeaders.Black
      ? loadedHeaders.White + '-' + loadedHeaders.Black : 'deepfish') + '.pgn';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 1000);
    branchesExported = true;
    showMessage('已下载棋谱文件。', '');
  } catch (err) {
    // jsdom / 老浏览器没有 createObjectURL —— 退回到"自己复制"
    showMessage('这个环境不支持直接下载，请在上面的框里全选复制。', 'warn');
  }
}

/** 复制到剪贴板 */
async function copyPgn() {
  const text = exportTextEl.value || buildExportPgn();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      branchesExported = true;
      showMessage('棋谱已复制到剪贴板。', '');
      return;
    }
    throw new Error('没有剪贴板接口');
  } catch {
    // 退回到"选中让用户自己按 Ctrl+C"
    try {
      exportTextEl.focus();
      exportTextEl.select();
    } catch { /* 选不中就选不中 */ }
    showMessage('已经帮你全选好了，按 Ctrl+C 复制。', 'warn');
  }
}

// 给测试用的出口。页面自己不需要导出这些 ——
// 但 verify-dom.js 是在 jsdom 里把这些函数单独装起来的，
// 没有出口就够不着「讲棋」这条线（它不像棋盘那样一加载就能从 DOM 上看出结果）。
export { checkLlm, explainCurrent, renderCoach, renderMarkdownLite,
         manualEval, arrowEval, gatherEngineFacts, renderFacts, swingNote,
         formatPv, moveNumberAt, renderAlternatives,
         // 直接走棋 / 支线 这一套
         onSquareClick, playMove, undoMove, clearBranches, buildExportPgn,
         accountBranchState, requestLoad, hasUnsavedBranches,
         activeBranch, lineLength, absolutePly, lineTrail, branchRows, fenAt, mainFenAt,
         // 给测试用：棋盘这一帧"应该"长什么样（board.show 收到的就是它）
         frameAt,
         // 给测试用：吃子账（这一栏是纯子力，和引擎无关，所以能单独验）
         ledgerNow };

/** 只给测试用：把内部状态照出来看（不然 jsdom 里只能靠 DOM 猜） */
function accountBranchState() {
  return {
    branches: branches.map((b) => ({
      id: b.id, atPly: b.atPly, moves: b.moves.map((m) => m.san),
      timelineOk: b.timelineOk !== false,
    })),
    activeBranchId,
    cursor,
    selectedSquare,
    legalTargets: legalTargets.map((m) => m.to),
    pendingPromotion: pendingPromotion ? Object.assign({}, pendingPromotion) : null,
    unsaved: hasUnsavedBranches(),
    lineLength: lineLength(),
    absolutePly: absolutePly(),
    fen: fenAt(cursor),
    counter: counterText(),
  };
}

// ============================================================
// 第七部分：按钮和键盘
// ============================================================
document.getElementById('btnLoad').addEventListener('click', () => requestLoad(pgnInput.value));

document.getElementById('btnFirst').addEventListener('click', () => goTo(-1));
document.getElementById('btnPrev').addEventListener('click',  () => goTo(cursor - 1));
document.getElementById('btnNext').addEventListener('click',  () => goTo(cursor + 1));
document.getElementById('btnLast').addEventListener('click',  () => goTo(lineLength() - 1));

// ---------- 换盘前那道拦截 ----------
document.getElementById('btnGuardExport').addEventListener('click', () => {
  loadGuardEl.hidden = true;
  openExportPanel();
});
document.getElementById('btnGuardDiscard').addEventListener('click', () => {
  const text = pendingLoadText;
  pendingLoadText = null;
  loadGuardEl.hidden = true;
  loadPgn(text);
});

// ---------- 直接在棋盘上走棋 ----------
// 一件幸运的事：棋子层和箭头层都是 pointer-events:none，所以点击本来就落在
// 带 data-square 的格子上 —— 一个委托监听就够了。
boardEl.addEventListener('click', (ev) => {
  const sq = ev.target && ev.target.closest ? ev.target.closest('.sq') : null;
  if (!sq || !sq.dataset.square) return;
  onSquareClick(sq.dataset.square);
});

// 升变：不选就没法确定这个兵变成什么
promoPickerEl.addEventListener('click', (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest('[data-promo]') : null;
  if (!btn) return;
  const pending = pendingPromotion;
  if (!pending) return;
  pendingPromotion = null;
  promoPickerEl.hidden = true;
  playMove(pending.from, pending.to, btn.dataset.promo);
});
document.getElementById('btnCancelPromo').addEventListener('click', cancelPromotion);

// ---------- 支线那几个按钮 ----------
document.getElementById('btnUndoMove').addEventListener('click', undoMove);
document.getElementById('btnClearBranches').addEventListener('click', clearBranches);
document.getElementById('btnExportPgn').addEventListener('click', openExportPanel);

// 「回到主线」：翻页按钮（⏮◀▶⏭ 和键盘）只在**当前这条线**里走，所以必须给一个出口。
// 落点选在"这条支线是从哪一步接出去的"，也就是你离开主线的那一步 —— 顺着看回去最自然。
document.getElementById('btnBackToMain').addEventListener('click', () => {
  const b = activeBranch();
  if (!b) { showMessage('现在就在原棋谱主线上。', ''); return; }
  activeBranchId = null;
  cursor = Math.max(-1, Math.min(b.atPly, moves.length - 1));
  selectedSquare = null;
  legalTargets = [];
  render({ animate: false });
  showMessage('回到原棋谱主线了（第 ' + (cursor + 1) + ' 步）。', '');
});

// ---------- 导出面板 ----------
document.getElementById('btnCloseExport').addEventListener('click', () => {
  exportPanelEl.hidden = true;
});
document.getElementById('btnDownloadPgn').addEventListener('click', downloadPgn);
document.getElementById('btnCopyPgn').addEventListener('click', copyPgn);

// ---------- 关掉 / 刷新页面时提醒 ----------
// ⚠️ 浏览器只允许弹**它自带**的那句"离开此网站吗？"，文案改不了，
//    也没法做到"先保存再走"。所以真正的落地手段是那个「导出棋谱」按钮，
//    这里只是最后一道防线：有没导出的支线时才拦。
window.addEventListener('beforeunload', (ev) => {
  if (!hasUnsavedBranches()) return;
  ev.preventDefault();
  ev.returnValue = '';     // 现代浏览器只认这个（老浏览器要一个字符串）
});

btnAnalyze.addEventListener('click', analyzeCurrent);

// 讲棋。它和鳕鱼那条线是分开的两条腿：
// 鳕鱼负责把局面算明白，DeepSeek 负责把算出来的东西讲成人话。
btnExplain.addEventListener('click', explainCurrent);

// ---------- 翻转棋盘 ----------
// 棋盘朝向是「看棋的人」的习惯问题：执黑的时候把黑方放在下面更顺眼。
function toggleFlip() {
  flipped = !flipped;
  board.setFlipped(flipped);
  render({ animate: false });   // 重画高亮、箭头，并让局势条跟着换方向
}
btnFlip.addEventListener('click', toggleFlip);

// ---------- 显示设置 ----------
// 四个开关走同一套逻辑：变的是「画不画」，不变的是「算出来的那份数据」。
// （只有前两个额外决定「要不要在后台整局扫描」，见 wantAutoEval）
optCurve.addEventListener('change', onDisplaySettingChange);
optBar.addEventListener('change', onDisplaySettingChange);
optMoveEval.addEventListener('change', onDisplaySettingChange);
optArrow.addEventListener('change', onDisplaySettingChange);

// 扫描深度换了 → 之前那一轮的结论就作废了，重算
scanDepthSel.addEventListener('change', () => {
  evalRunId++;
  evalRunning = false;
  evals = [];
  evalForGame = -1;
  startEval();
  render();
});

// 换深度之后，把旧结果的提示刷新一下
depthSelect.addEventListener('change', () => {
  if (analysis && analysis.requestedDepth !== Number(depthSelect.value)) {
    renderAnalysis();
  }
});

// 示例按钮
document.querySelectorAll('[data-sample]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const sample = SAMPLES[btn.dataset.sample];
    if (!sample) return;

    let pgn = sample.pgn;

    // 有些示例太大，放在单独的文件里，点了才去取
    if (sample.file) {
      btn.disabled = true;
      try {
        const res = await fetch(sample.file);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        pgn = await res.text();
      } catch (err) {
        showMessage('这个示例棋谱读不出来：' + err.message, 'error');
        return;
      } finally {
        btn.disabled = false;
      }
    }

    pgnInput.value = pgn;
    requestLoad(pgn);
  });
});

// 键盘左右键翻棋 —— 对下棋的人来说最顺手
document.addEventListener('keydown', (e) => {
  if (document.activeElement === pgnInput) return; // 正在输入框里打字就别抢按键
  if (e.key === 'ArrowLeft')  { goTo(cursor - 1); e.preventDefault(); }
  if (e.key === 'ArrowRight') { goTo(cursor + 1); e.preventDefault(); }
  if (e.key === 'Home')       { goTo(-1); e.preventDefault(); }
  if (e.key === 'End')        { goTo(lineLength() - 1); e.preventDefault(); }
  if (e.key === 'f' || e.key === 'F') { toggleFlip(); e.preventDefault(); }
  if (e.key === 'Escape')     { cancelPromotion(); }
  if (e.key === 'Enter' && document.activeElement !== depthSelect) { analyzeCurrent(); }
});

// ============================================================
// 第七部分：给用户看的提示消息
// ============================================================
function showMessage(text, type) {
  msgEl.textContent = text;
  msgEl.className = 'message ' + (type || '');
}

// ---------- 页面打开时 ----------
board.show(frameAt(-1), { animate: false });
renderEvalUi();
renderBranchBlock();
updatePlayHint();
showMessage('选一个示例棋谱，或者把你自己的 PGN 粘贴到左边，然后点「载入棋谱」。', '');
renderAnalysis();
renderCoach();
checkEngine();
checkLlm();
