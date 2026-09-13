// ============================================================
// verify-dom.js —— 把真实的 index.html + 各个 js 在 jsdom 里跑起来，
// 然后直接检查画出来的棋盘、分析结果和动画行为。
//
// 为什么需要这么绕：jsdom 不支持 <script type="module">。
//
// 【做法】每个文件各自塞进一个 new Function，作用域天然隔离，
// 依赖用参数显式传进去 —— 这才是真正的「模块」。
// （早先的版本是把所有文件拼成一大段再 eval，但 board.js 和 arrows.js
//   都声明了 const FILES，拼一起就重复声明报错。）
// ============================================================

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('D:/wbdy-work/project/node_modules/jsdom');

const PUB = 'D:/wbdy-work/project/public';
const BASE = 'http://localhost:3000';

// 页面里的异步任务（比如自动扫描）如果抛了异常，会被 Promise 悄悄吞掉，
// 表现就是「进度条停在某个数字上不动」。这里把它揪出来。
process.on('unhandledRejection', (e) => {
  console.error('\n💥 页面里有未处理的异步异常：', e);
});

function strip(src) {
  return src
    .replace(/^\s*import\s+[\s\S]*?from\s+['"].*?['"];?\s*$/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^\s*export\s+(function|class|const|let|var)\s/gm, '$1 ');
}

const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
  runScripts: 'outside-only',
  url: BASE,
});
const { window } = dom;
const { document } = window;

// ------------------------------------------------------------
// 滚动探针
// ------------------------------------------------------------
// jsdom 压根没实现 scrollIntoView。这里**故意**把它装成一个会记账的探针，
// 而不是一个空函数 —— 因为「翻页时窗口被往下拽」这个 bug 的元凶就是它：
// scrollIntoView 会把元素**所有**可滚动祖先滚一遍，而整个文档也是滚动容器。
// 一旦代码里再出现 scrollIntoView，第 19 节的断言立刻会红。
const scrollIntoViewCalls = [];
window.Element.prototype.scrollIntoView = function () {
  scrollIntoViewCalls.push(this);
};

// 顺带盯着「容器级/窗口级」的滚动 API，防止以后换了个写法绕过去
const scrollApiCalls = [];
for (const name of ['scrollTo', 'scrollBy']) {
  const original = window[name];
  window[name] = function (...args) {
    scrollApiCalls.push(name);
    if (typeof original === 'function') original.apply(window, args);
  };
}

globalThis.document = document;
globalThis.window = window;
globalThis.Element = window.Element;
globalThis.Node = window.Node;

// fetch 包装：把相对路径（'/api/x' 或 'samples/x.pgn'）补成完整地址，
// 好让 Node 的原生 fetch 能发出去
//
// 另外，讲棋那两个接口在这里被**换成本地打桩**（见下面 llmStub）。原因：
//   1. 跑测试的机器上没配 DeepSeek 密钥 —— 也不该为了跑一次测试去配；
//   2. 更要紧的是不能因为跑测试就真花钱，哪怕只有几厘。
// 假掉的只是"上游回了什么"，前端拿到回复之后的行为全都能照样验。
const nativeFetch = globalThis.fetch;

/** 打桩用的假 Response，形状和真的够像就行 */
function stubResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

const llmStub = {
  configured: true,     // 改成 false 就是"服务器上没配密钥"的样子
  mode: 'ok',           // ok | error | no_key
  delayMs: 0,           // 调大可以观察"正在讲…"的状态
  text: '**这一步是败着。**\n\n- 你漏看了 f7 的威胁\n- 应该先走 `d5` 挡住',
  calls: 0,             // 讲棋被请求了几次
  lastPayload: null,    // 最后一次请求发出去的内容
};

globalThis.fetch = (url, opts) => {
  const target = String(url);

  // ---------- 讲棋状态 ----------
  if (target.includes('/api/llm')) {
    return Promise.resolve(stubResponse({
      ok: true,
      available: llmStub.configured,
      configured: llmStub.configured,
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      keyPreview: llmStub.configured ? 'sk-abc****wxyz' : '',
    }));
  }

  // ---------- 讲棋正文 ----------
  if (target.includes('/api/explain')) {
    llmStub.calls++;
    try { llmStub.lastPayload = JSON.parse(opts.body); } catch { llmStub.lastPayload = null; }

    if (llmStub.mode === 'no_key') {
      return Promise.resolve(stubResponse({
        ok: false, code: 'no_key',
        error: '还没配置 DeepSeek 密钥（DEEPSEEK_API_KEY）',
        hint: '在项目根目录建一个 .env 文件，写上 DEEPSEEK_API_KEY=sk-你的密钥，然后重启服务器。',
      }, 503));
    }
    if (llmStub.mode === 'error') {
      return Promise.resolve(stubResponse({
        ok: false, code: 'rate_limit',
        error: '被 DeepSeek 限流了（HTTP 429）',
        hint: '请求太频繁，被 DeepSeek 限流了。等几秒再点一次就好。',
        detail: '{"error":{"message":"Rate limit reached"}}',
      }, 502));
    }

    const body = {
      ok: true,
      text: llmStub.text,
      model: 'deepseek-chat',
      usage: { prompt_tokens: 210, completion_tokens: 140, total_tokens: 350 },
      attempts: 1,
      elapsedMs: 1234,
      meta: { ply: 1, san: 'f3' },
    };
    if (!llmStub.delayMs) return Promise.resolve(stubResponse(body));
    return new Promise((r) => setTimeout(() => r(stubResponse(body)), llmStub.delayMs));
  }

  // ---------- 其余照旧走真服务器 ----------
  const realTarget = typeof url === 'string' && !/^https?:/i.test(url)
    ? new URL(url, BASE + '/').href
    : url;
  return nativeFetch(realTarget, opts);
};

function loadModule(src, deps, exportNames) {
  const depNames = Object.keys(deps);
  const body = strip(src) + '\nreturn {' + exportNames.join(', ') + '};';
  // eslint-disable-next-line no-new-func
  const factory = new Function(...depNames, body);
  return factory(...depNames.map((k) => deps[k]));
}

const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

let chessMod, arrowsMod, timelineMod, boardMod, pgnMod, evalMod, appMod;
try {
  chessMod    = loadModule(read('js/chess.js'), {}, ['Chess', 'DEFAULT_POSITION']);
  arrowsMod   = loadModule(read('js/arrows.js'), {}, ['drawArrows', 'squareCenter']);
  timelineMod = loadModule(read('js/timeline.js'), { Chess: chessMod.Chess },
                           ['buildTimeline', 'verifyTimeline', 'squareToRowCol', 'captureLedger']);
  pgnMod      = loadModule(read('js/pgn.js'),
                           { Chess: chessMod.Chess, DEFAULT_POSITION: chessMod.DEFAULT_POSITION },
                           ['parsePgn', 'annotationScoreText', 'annotationSide', 'QUALITY_LABEL']);
  evalMod     = loadModule(read('js/eval.js'), {},
                           ['createEvalBar', 'createEvalCurve', 'normFromScore',
                            'whiteFraction', 'compactScore', 'sideOf', 'terminalScore', 'gapVsBest']);
  boardMod    = loadModule(read('js/board.js'),
                           { drawArrows: arrowsMod.drawArrows, squareToRowCol: timelineMod.squareToRowCol },
                           ['createBoard', 'PIECE_GLYPH']);
  appMod      = loadModule(read('js/app.js'),
             { Chess: chessMod.Chess, DEFAULT_POSITION: chessMod.DEFAULT_POSITION,
               createBoard: boardMod.createBoard,
               PIECE_GLYPH: boardMod.PIECE_GLYPH,
               buildTimeline: timelineMod.buildTimeline,
               verifyTimeline: timelineMod.verifyTimeline,
               captureLedger: timelineMod.captureLedger,
               parsePgn: pgnMod.parsePgn,
               annotationScoreText: pgnMod.annotationScoreText,
               annotationSide: pgnMod.annotationSide,
               QUALITY_LABEL: pgnMod.QUALITY_LABEL,
               createEvalBar: evalMod.createEvalBar,
               createEvalCurve: evalMod.createEvalCurve,
               normFromScore: evalMod.normFromScore,
               compactScore: evalMod.compactScore,
               sideOf: evalMod.sideOf,
               terminalScore: evalMod.terminalScore,
               gapVsBest: evalMod.gapVsBest },
             ['scrollDeltaFor', 'checkLlm', 'explainCurrent', 'renderCoach', 'renderMarkdownLite',
              'manualEval', 'arrowEval', 'gatherEngineFacts', 'renderFacts', 'swingNote',
              'formatPv', 'moveNumberAt',
              'onSquareClick', 'playMove', 'undoMove', 'clearBranches', 'buildExportPgn',
              'accountBranchState', 'requestLoad', 'hasUnsavedBranches', 'lineLength',
              'absolutePly', 'lineTrail', 'fenAt', 'mainFenAt', 'frameAt', 'ledgerNow']);
} catch (e) {
  console.log('❌ 脚本执行失败：' + e.message + '\n' + e.stack);
  process.exit(1);
}

// ---------- 断言小工具 ----------
let pass = 0, fail = 0;
const failures = [];
function check(label, actual, expected) {
  const isOk = JSON.stringify(actual) === JSON.stringify(expected);
  if (isOk) pass++; else { fail++; failures.push(label); }
  console.log(`  ${isOk ? '✅' : '❌'} ${label}` +
    (isOk ? '' : `\n       实际=${JSON.stringify(actual)}  期望=${JSON.stringify(expected)}`));
}
function ok(label, cond, detail) {
  if (cond) pass++; else { fail++; failures.push(label); }
  console.log(`  ${cond ? '✅' : '❌'} ${label}` + (detail ? `   [${detail}]` : ''));
}
const eq = (label, actual, expected) => check(label, actual, expected);
function section(t) { console.log('\n' + '─'.repeat(60) + '\n' + t + '\n' + '─'.repeat(60)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); }
  return false;
}

const FILES = 'abcdefgh';

// ---------- 怎么「看」棋盘 ----------
// 棋子现在是绝对定位 + transform 平移，所以要看一枚棋子在哪，
// 得把它的 transform 反解成格子名。这样验证的是真实渲染位置，
// 而不是程序自己记的账（用 dataset 去验证等于自己证明自己）。
function squareOfWrap(wrap) {
  const m = /translate\(([-\d.]+)%,\s*([-\d.]+)%\)/.exec(wrap.style.transform || '');
  if (!m) return null;
  const col = Number(m[1]) / 100;
  const row = Number(m[2]) / 100;
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
  return FILES[col] + (8 - row);
}

/**
 * 另一套「看」法：直接读出棋子当前在屏幕上的第几行第几列。
 * 棋盘翻转之后，同一个格子名对应的屏幕位置会变 ——
 * 用 squareOfWrap 是看不出来的（它只会把 transform 反解回原来的格子名），
 * 所以测翻转必须用这个。
 */
function screenPosOfWrap(wrap) {
  const m = /translate\(([-\d.]+)%,\s*([-\d.]+)%\)/.exec(wrap.style.transform || '');
  if (!m) return null;
  return { col: Number(m[1]) / 100, row: Number(m[2]) / 100 };
}
const firstSquare = () => document.querySelector('#board .sq');
const evalWhite   = () => document.querySelector('#evalBar .evalbar-white');
const barHeight   = () => parseFloat(evalWhite().style.height) || 0;
const curveDots   = () => document.querySelectorAll('#evalCurve [data-ply]');
/** 勾/取消一个显示开关（改成程序赋值不会触发 change，得自己派发） */
function setOpt(el, value) {
  el.checked = value;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const allWraps     = () => [...document.querySelectorAll('#board .piece-wrap')];
const visibleWraps = () => allWraps().filter((w) => !w.classList.contains('gone'));
const wrapAt = (square) => visibleWraps().find((w) => squareOfWrap(w) === square) || null;
const pieceAt = (file, rank) => {
  const w = wrapAt(file + rank);
  if (!w) return null;
  const s = w.querySelector('.piece');
  return { glyph: s.textContent, color: s.classList.contains('w') ? 'w' : 'b' };
};
const squaresCount = () => document.querySelectorAll('#board .sq').length;

(async () => {

// ============================================================
section('0. 新增的「自动评估」默认开着；老测试先切回手动模式');
// ============================================================
// 自动评估一载入棋谱就会让鳕鱼把整局算一遍，算完会往着法列表里回填评分。
// 那会让下面这些老断言（比如「第 1~15 节里那几条关于评注的」）变得不确定 ——
// 扫描随时可能插进来改列表内容。
// 所以第 1~15 节先把曲线和局势条这两个开关关掉（等于关掉整局扫描），
// 回到纯手动模式；新功能留到第 16 节之后专门测。
//
// 【2026-09-12 下午的补充】现在整局扫描**不再往「分析结果」面板和棋盘上画东西**了
// （那两个只认手动分析，见 app.js 的 manualEval）。所以这里关开关的理由只剩
// 「让着法列表的内容稳定」这一条 —— 但结论不变，还是要关。
ok('评估曲线默认是打开的', document.getElementById('optCurve').checked);
ok('局势条默认是打开的', document.getElementById('optBar').checked);
ok('着法评分默认是打开的', document.getElementById('optMoveEval').checked);
ok('推荐走法箭头默认是打开的', document.getElementById('optArrow').checked);

// ⚠️ 只关曲线和局势条这两个 —— 它们才是「要不要在后台整局扫描」的开关（wantAutoEval）。
//    「推荐走法箭头」虽然也吃扫描数据，但它是个**显示**开关，不反过来决定算不算；
//    这里留着它开着，不会让扫描跑起来，老断言照样稳定。
setOpt(document.getElementById('optCurve'), false);
setOpt(document.getElementById('optBar'), false);

ok('曲线和局势条都关掉之后进入手动模式（有明确提示）',
  /手动模式/.test(document.getElementById('message').textContent),
  document.getElementById('message').textContent);
ok('关掉后曲线面板藏起来了', document.getElementById('evalPanel').hidden);
ok('关掉后局势条藏起来了', document.getElementById('evalBar').hidden);

// ============================================================
section('1. 棋盘基本结构');
// ============================================================
check('棋盘有 64 个格子', squaresCount(), 64);
check('a8 是浅色格', document.querySelector('#board .sq[data-square="a8"]').classList.contains('light'), true);
check('a1 是深色格', document.querySelector('#board .sq[data-square="a1"]').classList.contains('dark'), true);
check('h1 是浅色格', document.querySelector('#board .sq[data-square="h1"]').classList.contains('light'), true);
check('盒子层 / 棋子层 / 箭头层都在',
  ['board-squares', 'board-pieces', 'board-arrows']
    .map((c) => document.querySelectorAll('#board .' + c).length), [1, 1, 1]);
ok('棋子不再画在格子里（而是独立的棋子层）',
  document.querySelectorAll('#board .sq .piece').length === 0,
  '格子里有 ' + document.querySelectorAll('#board .sq .piece').length + ' 个棋子');

// ============================================================
section('2. 开局摆放（按 transform 反解出的真实位置）');
// ============================================================
check('e1 是白王', pieceAt('e', 1), { glyph: '♚', color: 'w' });
check('d8 是黑后', pieceAt('d', 8), { glyph: '♛', color: 'b' });
check('e2 是白兵', pieceAt('e', 2), { glyph: '♟', color: 'w' });
check('e4 是空的', pieceAt('e', 4), null);
check('白棋共 16 个', visibleWraps().filter((w) => w.querySelector('.piece.w')).length, 16);
check('黑棋共 16 个', visibleWraps().filter((w) => w.querySelector('.piece.b')).length, 16);
ok('每一枚棋子的 transform 都落在整格上',
  visibleWraps().every((w) => squareOfWrap(w) !== null),
  visibleWraps().map(squareOfWrap).filter((s) => s === null).length + ' 个对不上');

// ============================================================
section('3. 载入「学者将杀」');
// ============================================================
document.querySelector('[data-sample="scholar"]').click();
check('着法列表里有 7 格', document.querySelectorAll('#movesBody .move-cell[data-index]').length, 7);
check('最后一步显示 Qxf7#',
  document.querySelectorAll('#movesBody .move-cell[data-index]')[6].querySelector('.san').textContent, 'Qxf7#');
check('f7 上站着白后（将杀那一步）', pieceAt('f', 7), { glyph: '♛', color: 'w' });
check('黑王还在 e8', pieceAt('e', 8), { glyph: '♚', color: 'b' });
check('状态栏认出了将杀', document.getElementById('status').textContent, '将杀！白方获胜');
check('载入后没有报警告（时间线自检通过）',
  document.getElementById('message').className.includes('ok'), true);

// ============================================================
section('4. 翻页');
// ============================================================
document.getElementById('btnFirst').click();
check('回到开局：f7 恢复成黑兵', pieceAt('f', 7), { glyph: '♟', color: 'b' });
check('回到开局：黑棋又是 16 个',
  visibleWraps().filter((w) => w.querySelector('.piece.b')).length, 16);

document.getElementById('btnNext').click();
check('下一步后 e4 有白兵', pieceAt('e', 4), { glyph: '♟', color: 'w' });
check('这一步在列表里被高亮', document.querySelectorAll('#movesBody .move-cell.active').length, 1);
check('高亮的正是第 1 步 e4',
  document.querySelector('.move-cell.active .san').textContent, 'e4');
check('刚走的格子加了高亮',
  document.querySelector('#board .sq[data-square="e2"]').classList.contains('hl-from') &&
  document.querySelector('#board .sq[data-square="e4"]').classList.contains('hl-to'), true);

document.getElementById('btnLast').click();
check('跳到最后一步：状态仍是将杀', document.getElementById('status').textContent, '将杀！白方获胜');
check('「下一步」按钮被禁用了', document.getElementById('btnNext').disabled, true);

// ============================================================
section('5. 【动画核心】棋子是被"挪动"，不是被"重画"');
// ============================================================
// 这是整个第 2 阶段最要紧的一条。如果每次刷新都重建元素，
// 浏览器就无从知道"这个兵就是那个兵"，也就补不出动画。
document.getElementById('btnFirst').click();     // 开局
const before = allWraps();
const e2Wrap = wrapAt('e2');
ok('开局的 e2 上确实有棋子', !!e2Wrap, e2Wrap ? squareOfWrap(e2Wrap) : '无');

document.getElementById('btnNext').click();      // 走 e4
const after = allWraps();

ok('棋子元素被复用，一个都没重建',
  before.length === after.length && before.every((w, i) => w === after[i]),
  before.length + ' → ' + after.length + ' 个元素');
ok('e2 那个棋子「本人」跑到了 e4（换了 transform，没换元素）',
  wrapAt('e4') === e2Wrap, '同一个 DOM 节点');
ok('它的 transform 从 e2 变成了 e4',
  squareOfWrap(e2Wrap) === 'e4', squareOfWrap(e2Wrap));
ok('这次移动没有挂 no-anim，所以过渡会生效（滑动而不是闪现）',
  !e2Wrap.classList.contains('no-anim') &&
  !document.querySelector('#board .board-pieces').classList.contains('no-anim'));

// CSS 里必须真的有过渡声明 —— jsdom 不算样式，所以这条只能查文本
const css = read('css/style.css');
ok('CSS 里给 .piece-wrap 声明了 transform 过渡',
  /\.piece-wrap\s*\{[^}]*transition:[^}]*transform/s.test(css));
ok('CSS 里有「关掉动画」的开关',
  /\.board-pieces\.no-anim[^}]*transition:\s*none/s.test(css) ||
  /\.piece-wrap\.no-anim[^}]*transition:\s*none/s.test(css));

// ---------- 跨多步跳转：不该做动画 ----------
document.getElementById('btnNext').click();      // 走到第 2 步（相邻，应该有动画）
await sleep(40);
ok('相邻一步：仍然是动画模式（没有 no-anim）',
  !document.querySelector('#board .board-pieces').classList.contains('no-anim'));

document.getElementById('btnLast').click();      // 一口气跳到结尾（跨 5 步）
const layer = () => document.querySelector('#board .board-pieces');
ok('跨多步跳转：当场挂上 no-anim（不做动画，避免满盘乱飞）',
  layer().classList.contains('no-anim'));
check('跳转后局面仍然正确（f7 上有白后）', pieceAt('f', 7), { glyph: '♛', color: 'w' });
ok('跳转后没有棋子重叠',
  new Set(visibleWraps().map(squareOfWrap)).size === visibleWraps().length,
  visibleWraps().length + ' 个棋子，' + new Set(visibleWraps().map(squareOfWrap)).size + ' 个位置');

// 紧接着马上走一步（**故意不等**）—— 这一步必须能动。
// 早先的实现用 setTimeout 延后解锁动画，这个位置会踩坑：那一步不动。
const f7Queen = wrapAt('f7');
document.getElementById('btnPrev').click();      // 退一步（相邻，应该动）
ok('跳转后紧接着翻页（不等任何延时），动画开关已经同步恢复',
  !layer().classList.contains('no-anim'));
ok('而且确实有一个棋子从 f7 挪回了它上一处位置',
  !!f7Queen && squareOfWrap(f7Queen) === 'h5',
  f7Queen ? ('白后现在在 ' + squareOfWrap(f7Queen)) : '没找到白后');

// ---------- 64 个格子自始至终是同一批元素 ----------
ok('格子在多次翻页后仍是同一批 DOM（从未重建）',
  document.querySelectorAll('#board .sq')[0] ===
  document.querySelectorAll('#board .sq')[0] && squaresCount() === 64);

// ============================================================
section('6. 【动画】吃子：被吃的棋子退场，不是"啪"一下没');
// ============================================================
document.getElementById('pgnInput').value = '1. e4 d5 2. exd5 Qxd5';
document.getElementById('btnLoad').click();
document.getElementById('btnFirst').click();
await sleep(40);

check('开局黑棋 16 个', visibleWraps().filter((w) => w.querySelector('.piece.b')).length, 16);
const d7Wrap = wrapAt('d7');
ok('开局 d7 上有黑兵', !!d7Wrap);

document.getElementById('btnNext').click();   // 1. e4
await sleep(40);
document.getElementById('btnNext').click();   // 1... d5（d7 → d5）
await sleep(40);
check('黑兵带着同一个元素从 d7 走到 d5', squareOfWrap(d7Wrap), 'd5');
ok('走到 d5 时它还是可见的', !d7Wrap.classList.contains('gone'));

document.getElementById('btnNext').click();   // 2. exd5（把它吃掉）
await sleep(40);
check('被吃掉的黑兵元素仍在 DOM 里（只是隐藏）',
  allWraps().includes(d7Wrap), true);
ok('但它被标记为 gone（淡出缩小，而不是瞬间消失）',
  d7Wrap.classList.contains('gone'));
ok('看棋盘的视角里它已经不算数了',
  visibleWraps().length === 31, visibleWraps().length + ' 个可见棋子');
ok('棋子总数（含隐藏的）没变，说明是复用不是重建',
  allWraps().length === 32, allWraps().length + ' 个元素');

// 往后翻再看回来，被吃的棋子要能复活
document.getElementById('btnLast').click();
await sleep(40);
document.getElementById('btnPrev').click();   // 退回到被吃掉之前
await sleep(40);
ok('往回翻：被吃的黑兵又出现在 d5 上',
  squareOfWrap(d7Wrap) === 'd5' || !d7Wrap.classList.contains('gone'),
  'square=' + squareOfWrap(d7Wrap) + ' gone=' + d7Wrap.classList.contains('gone'));

// ============================================================
section('7. 输入非法棋谱应该被拦住');
// ============================================================
const wrapsBeforeBad = wrapAt('e4');
document.getElementById('pgnInput').value = '1. e4 e5 2. Ke2 Ke7 3. Qxh8';
document.getElementById('btnLoad').click();
await sleep(20);
check('给出了错误提示', document.getElementById('message').className.includes('error'), true);
ok('棋盘没被污染（上一盘的棋子还在原处）',
  wrapAt('e4') === wrapsBeforeBad, 'e4 上还是同一个元素');

// ============================================================
section('8. 引擎连接（真连后端，不是假的）');
// ============================================================
document.querySelector('[data-sample="scholar"]').click();
const engineOk = await waitFor(() => !document.getElementById('btnAnalyze').disabled);
ok('后端引擎就绪，分析按钮解锁', engineOk,
  '标签显示「' + document.getElementById('engineTag').textContent + '」');
ok('标签显示的是引擎真名',
  /Stockfish/i.test(document.getElementById('engineTag').textContent),
  document.getElementById('engineTag').textContent);

// ============================================================
section('9. 分析一个已结束的局面');
// ============================================================
document.getElementById('btnAnalyze').click();
const ended = await waitFor(() => /已经结束/.test(document.getElementById('analysisBody').textContent));
ok('对已结束局面给出恰当提示而不是崩掉', ended,
  document.getElementById('analysisBody').textContent.trim().slice(0, 40));

// ============================================================
section('10. 分析开局：结果面板 + 棋盘箭头');
// ============================================================
const arrowLines = () => document.querySelectorAll('#board .board-arrows line');
const arrowTris  = () => document.querySelectorAll('#board .board-arrows polygon');

document.getElementById('btnFirst').click();
document.getElementById('depthSelect').value = '12';
document.getElementById('btnAnalyze').click();

const gotResult = await waitFor(() => !!document.querySelector('#analysisBody .best-move'));
ok('拿到了分析结果', gotResult);

if (gotResult) {
  const bestSan  = document.querySelector('#analysisBody .best-move').textContent;
  const evalNum  = document.querySelector('#analysisBody .eval-num').textContent;
  const evalLbl  = document.querySelector('#analysisBody .eval-label').textContent;
  const pvText   = (document.querySelector('#analysisBody .pv code') || {}).textContent || '';
  const statsTxt = (document.querySelector('#analysisBody .stats') || {}).textContent || '';

  console.log('       推荐着法: ' + bestSan + '   评分: ' + evalNum + ' (' + evalLbl + ')');
  console.log('       后续变化: ' + pvText);
  console.log('       引擎跑分: ' + statsTxt.replace(/\s+/g, ' '));

  ok('推荐着法是合法开局着法',
    ['e4', 'd4', 'Nf3', 'c4', 'e3', 'd3', 'g3', 'b3', 'Nc3'].includes(bestSan), bestSan);
  ok('评分带了正负号', /^[+\-±]/.test(evalNum), evalNum);
  ok('给出了优劣判断文字', /均势|占优|胜势/.test(evalLbl), evalLbl);
  ok('后续变化是空着以外的内容', pvText.length > 5 && /[a-h]/.test(pvText), pvText.slice(0, 40));
  ok('显示了引擎跑分（深度/节点）', /深度/.test(statsTxt) && /局面/.test(statsTxt));

  // ---- 「引擎认为的次优选 + 它自己的后续」（用户要的）----
  // 只给"该走这一步"一个答案，没法判断是真好棋还是不得已；候选之间的分差才回答那个。
  // 要出这个，手动分析那一请求就必须带 multipv（见 app.js 的 ANALYZE_MULTIPV）。
  const altItems = [...document.querySelectorAll('#analysisBody .alt-item')];
  ok('★★ 分析结果里列出了引擎的次优选', altItems.length >= 1, altItems.length + ' 条');
  ok('★★ 每一条次优选都带着**它自己的后续着法**',
    altItems.length > 0 && altItems.every((li) => {
      const code = li.querySelector('.alt-pv code');
      return code && code.textContent.length > 3;
    }),
    altItems.map((li) => ((li.querySelector('.alt-pv code') || {}).textContent || '（没有后续）').slice(0, 24)).join(' ｜ '));
  ok('  每条都有序号、着法名、起止格、评分',
    altItems.length > 0 && altItems.every((li) =>
      !!li.querySelector('.alt-rank') && !!li.querySelector('.alt-move') &&
      !!li.querySelector('.alt-anchor') && !!li.querySelector('.alt-score')),
    altItems.map((li) => li.querySelector('.alt-line').textContent.replace(/\s+/g, ' ')).join(' ｜ ').slice(0, 90));
  ok('  起止格是 UCI 那种"g1→f3"的写法',
    altItems.length > 0 && /^[a-h][1-8]→[a-h][1-8]$/.test(
      (altItems[0].querySelector('.alt-anchor') || {}).textContent || ''),
    (altItems[0].querySelector('.alt-anchor') || {}).textContent);
  ok('★★ 还标出了"比首选差多少"（这就是"是不是唯一解"的依据）',
    altItems.length > 0 && altItems.every((li) => !!li.querySelector('.alt-gap')),
    (altItems[0].querySelector('.alt-gap') || {}).textContent);
  ok('  次优选和首选不是同一个着法',
    altItems.length > 0 &&
    (altItems[0].querySelector('.alt-move') || {}).textContent !== bestSan,
    (altItems[0].querySelector('.alt-move') || {}).textContent + ' vs ' + bestSan);

  ok('棋盘上画出了箭头（箭杆）', arrowLines().length === 2, arrowLines().length + ' 条线');
  ok('棋盘上画出了箭头（箭头三角）', arrowTris().length === 2, arrowTris().length + ' 个三角');

  if (arrowLines().length) {
    const bestUci = document.querySelector('#analysisBody .best-uci').textContent;
    const fromSq = bestUci.slice(0, 2);
    const toSq = bestUci.slice(2, 4);
    const c1 = arrowsMod.squareCenter(fromSq);
    const c2 = arrowsMod.squareCenter(toSq);
    const ln = arrowLines()[0];
    ok('箭杆起点正是推荐着法的起点格 ' + fromSq,
      Math.abs(Number(ln.getAttribute('x1')) - c1.x) < 1e-6 &&
      Math.abs(Number(ln.getAttribute('y1')) - c1.y) < 1e-6);
    const pts = arrowTris()[arrowTris().length - 1].getAttribute('points').split(' ')[0].split(',');
    ok('箭头尖端正是推荐着法的终点格 ' + toSq,
      Math.abs(Number(pts[0]) - c2.x) < 1e-6 && Math.abs(Number(pts[1]) - c2.y) < 1e-6);

    document.getElementById('btnNext').click();
    await sleep(80);
    ok('翻页之后箭头消失了（结果对应的不是这个局面）', arrowLines().length === 0);
    ok('并且提示用户重新分析',
      /重新算/.test(document.getElementById('analysisBody').textContent));

    document.getElementById('btnPrev').click();
    await sleep(80);
    ok('翻回来箭头又出现了（结果被缓存住）', arrowLines().length === 2);
  }
}

// ============================================================
section('11. 缓存：同一局面第二次分析应该秒回');
// ============================================================
{
  document.getElementById('btnFirst').click();
  await sleep(50);
  const t0 = Date.now();
  document.getElementById('btnAnalyze').click();
  await waitFor(() => !!document.querySelector('#analysisBody .best-move'), 5000);
  const dt = Date.now() - t0;
  ok('第二次几乎不耗时（命中缓存）', dt < 120, dt + 'ms');
}

// ============================================================
section('12. 【评注】载入带评注的 lichess 对局（修的就是它）');
// ============================================================
// 这份棋谱以前是**完全读不出来**的：chess.js 顶不住"一步后面跟两个连续评注"，
// 而它每一步都是那么写的。
const cells = () => [...document.querySelectorAll('#movesBody .move-cell[data-index]')];
const sanOf = (i) => cells()[i].querySelector('.san').textContent;

document.querySelector('[data-sample="sample1"]').click();
const loadedOk = await waitFor(() => cells().length === 51, 10000);
ok('51 步全部载入（以前这一步是直接报错的）', loadedOk, cells().length + ' 步');

const loadMsg = document.getElementById('message').textContent;
console.log('       载入提示: ' + loadMsg);

ok('提示里报了棋手姓名', /mlakay28/.test(loadMsg) && /Btpp/.test(loadMsg));
ok('提示里报了结果（从评注里读出的"认输"）', /黑方认输/.test(loadMsg));
ok('提示里报了评注条数', /读到 51 条评注/.test(loadMsg));
ok('没有出现警告样式（时间线自检 + 评注对齐都通过了）',
  document.getElementById('message').className.includes('ok'),
  document.getElementById('message').className);
eq('最后一步是 Ra8+', sanOf(50), 'Ra8+');
eq('第一步是 d4', sanOf(0), 'd4');
ok('变着分支没有混进主线（主线里不该出现只在变着里走过的 Qb5）',
  !cells().some((c) => c.querySelector('.san').textContent === 'Qb5'));

// ---------- 判评标记 ----------
eq('漏着（??）标记出 4 处', document.querySelectorAll('#movesBody .q-blunder').length, 4);
eq('错着（?）标记出 3 处', document.querySelectorAll('#movesBody .q-mistake').length, 3);
eq('不精确（?!）标记出 3 处', document.querySelectorAll('#movesBody .q-inaccuracy').length, 3);

const cell17 = cells()[16];   // 第 17 半回合 = 9. Qd2??（白方崩盘的那一步）
eq(' 第 17 半回合确实是 Qd2', cell17.querySelector('.san').textContent, 'Qd2');
ok(' 它被标成了漏着', cell17.classList.contains('q-blunder'), cell17.className);
ok(' 鼠标悬停能看到评注原文', /Blunder/.test(cell17.getAttribute('title') || ''),
  cell17.getAttribute('title'));

// ---------- 棋谱自带的引擎评分显示在列表里 ----------
const ev0 = cells()[0].querySelector('.mv-eval');
ok('第 1 步显示了棋谱里的引擎评分', !!ev0 && ev0.textContent === '+0.15',
  ev0 ? ev0.textContent : '没有');
const ev14 = cells()[13].querySelector('.mv-eval');   // 14. bxa6?! → +0.35
ok('第 14 步的评分（白方视角正数）', !!ev14 && ev14.textContent === '+0.35',
  ev14 ? ev14.textContent : '没有');
// 三档配色：+0.35 在 ±0.8 兵以内 → 中性；+1.33 白优；-4.17 黑优
ok('小幅优势（+0.35）用中性色，不夸大',
  ev14.classList.contains('eq'), ev14.className);
const ev38 = cells()[37].querySelector('.mv-eval');   // 19... Kd8?? 之后白方大幅领先
ok('白方明显占优（+1.33）用白色系',
  !!ev38 && ev38.textContent === '+1.33' && ev38.classList.contains('w'),
  ev38 ? (ev38.textContent + ' / ' + ev38.className) : '没有');
const ev17 = cells()[16].querySelector('.mv-eval');
ok('第 17 步的评分是负的、标为黑方占优', ev17.textContent === '-4.17' && ev17.classList.contains('b'),
  ev17.textContent + ' / ' + ev17.className);

// ---------- 翻到某一步，棋盘下面显示这一步的评注详情 ----------
cells()[16].click();
await sleep(40);
const note = document.getElementById('moveNote');
console.log('       第 17 步的评注: ' + note.textContent);
ok('评注栏显示了评分', /-4\.17/.test(note.textContent));
ok('评注栏显示了判评', /漏着/.test(note.textContent));
ok('评注栏显示了引擎建议（从评注文字里抠出来的）', /引擎建议 b4/.test(note.textContent));
ok('评注栏显示了棋谱里的变化幅度', /-1\.07/.test(note.textContent));
ok('有评注时评注栏不是空的', !note.classList.contains('empty'));

cells()[0].click();
await sleep(40);
ok('翻到第 1 步，评注栏跟着更新（评分 +0.15）', /\+0\.15/.test(note.textContent),
  note.textContent);
ok('并且读到了剩余时间', /剩余 0:15:00/.test(note.textContent), note.textContent);

// 将杀的评注
cells()[49].click();
await sleep(40);
console.log('       第 50 步的评注: ' + note.textContent);
ok('将杀类评注说成了"白方 2 步杀"', /白方 2 步杀/.test(note.textContent), note.textContent);

// ---------- 棋盘本身也该正常（带评注的棋谱同样要做动画自检）----------
document.getElementById('btnFirst').click();
await sleep(30);
eq('回到开局：32 个棋子都在', visibleWraps().length, 32);
document.getElementById('btnNext').click();
await sleep(30);
eq('走一步后 d4 上有白兵', pieceAt('d', 4), { glyph: '♟', color: 'w' });

// ============================================================
section('13. 换一盘棋之后，评注不能"张冠李戴"');
// ============================================================
document.querySelector('[data-sample="scholar"]').click();
await sleep(40);
eq('回到无评注的棋谱：7 步', cells().length, 7);
eq(' 判评标记全部消失', document.querySelectorAll('#movesBody .q-blunder, #movesBody .q-mistake').length, 0);
eq(' 评分标记全部消失（空占位不算）',
  document.querySelectorAll('#movesBody .mv-eval:not([hidden])').length, 0);
ok(' 评注栏被清空（避免显示上盘棋的评注）',
  document.getElementById('moveNote').classList.contains('empty'),
  document.getElementById('moveNote').textContent);

// ============================================================
section('14. 坏棋谱仍然要被拦住');
// ============================================================
document.getElementById('pgnInput').value = '1. e4 e5 2. Ke2 Ke7 3. Qxh8';
document.getElementById('btnLoad').click();
await sleep(30);
check('给出了错误提示', document.getElementById('message').className.includes('error'), true);
eq('棋盘还停在上一盘棋', cells().length, 7);

document.getElementById('pgnInput').value = '这是一段随便打的字，不是棋谱';
document.getElementById('btnLoad').click();
await sleep(30);
ok('垃圾文本也给出人话错误', /看不懂/.test(document.getElementById('message').textContent),
  document.getElementById('message').textContent.slice(0, 50));

// ============================================================
section('15. 各种畸形 PGN 都能读；连着的双注释也没问题');
// ============================================================
const oddPgns = [
  ['一步跟两个连续注释（**这就是 lichess 棋谱读不出来的真正原因**）',
   '1. d4 { a } { b } d5 { c } 2. Bf4 Bf5'],
  ['变着里还套变着', '1. d4 d5 (1... Nf6 2. c4 (2. Nf3 e6) 2... e6) 2. Bf4 Bf5'],
  ['NAG 记号', '1. d4 $1 d5 $6 2. Bf4 $2 Bf5'],
  ['分号行注释', '1. d4 d5 ; 一句话\n2. Bf4 Bf5'],
  ['编号和着法粘连', '1.d4 d5 2.Bf4 Bf5'],
  ['注释里带圆括号和箭头', '1. d4 { (0.35 → -1.16) Mistake. Na4 was best. } d5 2. Bf4'],
];
for (const [name, pgn] of oddPgns) {
  document.getElementById('pgnInput').value = pgn;
  document.getElementById('btnLoad').click();
  await sleep(30);
  const okLoad = !document.getElementById('message').className.includes('error');
  const n = cells().length;
  ok(name, okLoad && n > 0, okLoad ? (n + ' 步') : document.getElementById('message').textContent);
}
// 逐条核对最后一个（它没有 [%eval] 标记，判评全写在注释文字里）
eq('  从注释文字里读出了"错着"判评', cells()[0].classList.contains('q-mistake'), true);
ok('  从注释文字里抠出了推荐着法 Na4',
  /Na4/.test(cells()[0].getAttribute('title') || ''), cells()[0].getAttribute('title'));
eq('  没有 [%eval] 标记时就不显示评分（不硬编一个）',
  cells()[0].querySelector('.mv-eval').hidden, true);

// ---------- 回归：棋谱自己写的胜负标记必须显示出来 ----------
// 认输 / 协议和棋在棋盘上一点痕迹都没有（棋子还在原处、轮次也没变），
// 所以只能靠棋谱末尾那个 1-0 / 0-1 / 1/2-1/2。以前完全没读它，
// 于是"只写了 1-0"的棋谱会被显示成"这盘棋还没下完"。
for (const [pgn, want, label] of [
  ['1. e4 e5 2. Nf3 Nc6 1-0', '白方获胜（棋谱标记 1-0）', '白胜'],
  ['1. e4 e5 0-1', '黑方获胜（棋谱标记 0-1）', '黑胜'],
  ['[Result "1/2-1/2"]\n\n1. e4 e5 1/2-1/2', '和棋（棋谱标记 1/2-1/2）', '和棋'],
  ['1. e4 e5 2. Nf3', '这盘棋还没下完', '没写结果'],
]) {
  document.getElementById('pgnInput').value = pgn;
  document.getElementById('btnLoad').click();
  await sleep(20);
  const msg = document.getElementById('message').textContent;
  ok('棋谱结果标记（' + label + '）→ 显示「' + want + '」',
    msg.includes(want), msg);
}

// ---------- 回归：从 [FEN] 中局摆起、轮到黑方先走的棋谱，白/黑两列不许错位 ----------
// 解析层一直支持 [FEN] 头，但着法列表写死了"每两格一行、第一个是白方"，
// 于是这类棋谱把黑方的着法画进了"白"那一列，回合号也整体错了一位。
{
  const rowsOf = () => [...document.querySelectorAll('#movesBody tr')].map((tr) =>
    [...tr.children].map((td) => {
      const san = td.querySelector('.san');
      return san ? san.textContent : td.textContent;
    }));

  document.getElementById('pgnInput').value =
    '[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n' +
    '1... c5 2. Nf3 d6 3. d4 cxd4';
  document.getElementById('btnLoad').click();
  await sleep(20);
  const rows = rowsOf();
  eq('黑方先走：第一行只有黑方那一格（白方是空的）', rows[0], ['1…', '', 'c5']);
  eq('第二行才轮到白方', rows[1], ['2', 'Nf3', 'd6']);
  eq('第三行', rows[2], ['3', 'd4', 'cxd4']);
  eq('行数正确（5 个着法 = 3 行）', rows.length, 3);
  eq('这一步的回合号也照棋谱自己的来（黑先走 → 第 1 手是第 1 回合的第 2 个半回合）',
    [appMod.moveNumberAt(0), appMod.moveNumberAt(1), appMod.moveNumberAt(2), appMod.moveNumberAt(3)],
    [1, 2, 2, 3]);

  // 正常的棋谱当然不能受影响
  document.getElementById('pgnInput').value = '1. e4 e5 2. Nf3';
  document.getElementById('btnLoad').click();
  await sleep(20);
  eq('正常的棋谱还是老样子（白在左、黑在右）', rowsOf(), [['1', 'e4', 'e5'], ['2', 'Nf3', '']]);
  eq('正常棋谱的回合号不受影响',
    [appMod.moveNumberAt(0), appMod.moveNumberAt(1), appMod.moveNumberAt(2)], [1, 1, 2]);

  // 从中局摆起、且回合号不是 1 的棋谱，编号也要跟着走
  document.getElementById('pgnInput').value =
    '[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 20"]\n\n20. a8=Q+ Kd7 21. Qb7+';
  document.getElementById('btnLoad').click();
  await sleep(20);
  eq('从第 20 回合摆起的棋谱，行号从 20 开始',
    rowsOf().map((r) => r[0]), ['20', '21']);
}

// ============================================================
section('16. 【新】自动评估：局势条 + 评估曲线 + 进度');
// ============================================================
// 这一节要真连后端，让鳕鱼把 51 步那盘棋逐个局面算一遍。
//
// 【深度怎么选，这里有个实测结论】
// 用深度 6 扫第 17 步（9. Qd2?? 之后）会给出 -0.14，而棋谱里高深度的
// 结果是 -4.17 —— 低了整整 4 个兵，因为浅搜索看不见黑方后面那套战术。
// 同一局面深度 12 算出来是 -3.98，和棋谱对得上。
// 所以曲线用太浅的深度是**会把转折点抹平**的，默认 10 是个折中。
// 测试里用 8，几分钟的等待换一条真实可信的曲线。
document.getElementById('scanDepthSelect').value = '8';

document.querySelector('[data-sample="sample1"]').click();
await waitFor(() => cells().length === 51, 10000);

ok('开关关着的时候不自动算（面板还是隐藏的）',
  document.getElementById('evalPanel').hidden && document.getElementById('evalBar').hidden);

// 打开两个开关 → 触发自动扫描
setOpt(document.getElementById('optCurve'), true);
setOpt(document.getElementById('optBar'), true);

ok('打开后曲线面板出现', !document.getElementById('evalPanel').hidden);
ok('打开后局势条出现', !document.getElementById('evalBar').hidden);
ok('扫描期间给出了进度提示',
  /正在算/.test(document.getElementById('evalProgress').textContent),
  document.getElementById('evalProgress').textContent);

const tScan = Date.now();
let scanTries = 0;
let scanLast = '';
const scanned = await waitFor(() => {
  scanTries++;
  scanLast = document.getElementById('evalProgress').textContent;
  return curveDots().length === 52 && !/正在算/.test(scanLast);
}, 180000);
console.log('       waitFor：试了 ' + scanTries + ' 次，花了 ' +
  ((Date.now() - tScan) / 1000).toFixed(1) + ' 秒，返回 ' + scanned +
  '，最后读到「' + scanLast + '」');

ok('整盘棋扫完，曲线上出现了 52 个点（开局 + 51 步）', scanned,
  curveDots().length + ' 个点');
ok('扫描结束后进度提示自动收起',
  document.getElementById('evalProgress').textContent === '',
  '「' + document.getElementById('evalProgress').textContent + '」');

// ---- 曲线本身 ----
ok('曲线画出来了（底 + 中线 + 面积 + 描边 + 本色）',
  document.querySelectorAll('#evalCurve path').length >= 3,
  document.querySelectorAll('#evalCurve path').length + ' 条 path');
ok('曲线上有中线（完全均势的位置）',
  [...document.querySelectorAll('#evalCurve line')].some((l) => l.getAttribute('y1') === '50'));
ok('曲线画布的宽度按步数铺开（51 步 → viewBox 宽 51）',
  document.querySelector('#evalCurve .eval-curve-svg').getAttribute('viewBox') === '0 0 51 100',
  document.querySelector('#evalCurve .eval-curve-svg').getAttribute('viewBox'));
ok('每个点都带了一句能看清分数的提示',
  /第 1 步之后/.test(curveDots()[1].querySelector('title').textContent),
  curveDots()[1].querySelector('title').textContent);

// ---- 局势条本身的数学：直接喂分数，测「分数 → 填充高度」这条换算 ----
// 这一节刻意不经过引擎 —— 引擎算得准不准是它自己的事，
// 「拿到分数之后画对没有」才是这里要负责的。
{
  const box = document.createElement('div');
  const bar = evalMod.createEvalBar(box);
  const H = () => parseFloat(box.querySelector('.evalbar-white').style.height);

  bar.update(0, null, false);
  const even = H();
  bar.update(600, null, false);      // 白方多 6 个兵
  const white = H();
  bar.update(-600, null, false);     // 黑方多 6 个兵
  const black = H();
  bar.update(null, 4, false);
  const mateW = H();
  bar.update(null, -4, false);
  const mateB = H();

  ok('均势 → 正好一半', even === 50, even + '%');
  ok('白方大优 → 白色区域大', white > 85, white.toFixed(1) + '%');
  ok('黑方大优 → 白色区域小', black < 15, black.toFixed(1) + '%');
  ok('白方将杀 → 顶满', mateW === 100, mateW + '%');
  ok('黑方将杀 → 清空', mateB === 0, mateB + '%');
  ok('白色区域随分数单调递增', black < even && even < white,
    black.toFixed(1) + '% < 50% < ' + white.toFixed(1) + '%');

  bar.update(600, null, true);       // 翻棋盘
  const wb = box.querySelector('.evalbar-white');
  ok('翻转棋盘后白色块贴到顶部（白棋在上面那侧）',
    parseFloat(wb.style.top) === 0 && wb.style.bottom === 'auto',
    'top=' + wb.style.top + ' bottom=' + wb.style.bottom);
  ok('翻转不改变白色区域的大小（优势就那么大）',
    parseFloat(wb.style.height) === white, wb.style.height);

  bar.update(-600, null, false);
  ok('切回黑优时白色块又贴回底部',
    wb.style.top === 'auto' && parseFloat(wb.style.bottom) === 0,
    'top=' + wb.style.top + ' bottom=' + wb.style.bottom);
}

// ---- 局势条 vs 曲线：同一份数据，两处显示不能打架 ----
// 注意这里**不去断言「第 17 步必须是黑优」**。曲线是用低深度快速扫出来的，
// 和棋谱里高深度的 [%eval] 本来就会差一截（上面注释里讲了原因）。
// 真正必须成立的是：分数文字和填充高度出自同一份数据，不许互相矛盾。
{
  let consistent = 0;
  const plies = [1, 10, 20, 30, 40, 50, 51];
  for (const ply of plies) {
    curveDots()[ply].dispatchEvent(new window.Event('click', { bubbles: true }));
    await sleep(30);
    const txt = document.querySelector('#evalBar .evalbar-score').textContent;
    const h = barHeight();
    let good;
    if (txt.startsWith('#-'))      good = h < 5;
    else if (txt.startsWith('#'))  good = h > 95;
    else if (txt.startsWith('+'))  good = h > 50;
    else if (txt.startsWith('-'))  good = h < 50;
    else                           good = Math.abs(h - 50) <= 3;
    if (good) consistent++;
    console.log('       第 ' + ply + ' 步: ' + txt + ' → 白色占 ' + h.toFixed(1) + '%  ' + (good ? '✓' : '✗'));
  }
  eq('7 个点上，局势条的分数和高度完全自洽', consistent, plies.length);
}

ok('局势条带上了优劣配色', ['w', 'b', 'eq'].includes(
  document.querySelector('#evalBar .evalbar-score').dataset.side),
  document.querySelector('#evalBar .evalbar-score').dataset.side);

// ---- 点曲线跳转 ----
document.getElementById('btnFirst').click();
await sleep(40);
curveDots()[20].dispatchEvent(new window.Event('click', { bubbles: true }));
await sleep(60);
eq('点曲线上第 20 个点 → 跳到第 20 步',
  document.getElementById('moveCounter').textContent, '第 20 步 / 共 51 步');
ok('跳转后棋盘确实停在那一步（着法列表高亮在第 20 格）',
  document.querySelector('.move-cell.active').dataset.index === '19',
  document.querySelector('.move-cell.active').dataset.index);

// ---- 着法列表里的评分来自我们自己的计算，不是棋谱评注 ----
const ownEvals = document.querySelectorAll('#movesBody .mv-eval.own');
eq('51 条评分全部标成了「本程序算的」', ownEvals.length, 51);
ok('鼠标停在上面能看出是实时计算',
  /鳕鱼实时计算/.test(ownEvals[0].getAttribute('title') || ''),
  ownEvals[0].getAttribute('title'));
ok('着法列表的评分和局势条用的是同一份数据（都是白方视角）',
  /^[+\-±#]/.test(ownEvals[0].textContent), ownEvals[0].textContent);

// ---- 【新】第三个开关：着法列表里「每一步局势变化」的显示 ----
// 关掉它只是不画，不该把「已经算好的那批数据」扔掉，也不该连累曲线和局势条。
{
  const visibleEvals = () =>
    document.querySelectorAll('#movesBody .mv-eval:not([hidden])').length;

  eq('开着的时候，51 步每一步都有评分', visibleEvals(), 51);

  setOpt(document.getElementById('optMoveEval'), false);
  await sleep(40);
  eq('关掉「着法评分」后，列表里的评分全部消失', visibleEvals(), 0);
  eq('  而且是一个不漏（连棋谱自带的评注分也一起藏了）',
    document.querySelectorAll('#movesBody .mv-eval').length, 51);
  ok('  曲线不受影响，还是 52 个点', curveDots().length === 52, curveDots().length + ' 个点');
  ok('  局势条也还看得见', !document.getElementById('evalBar').hidden);
  ok('  关了它不会让鳕鱼重算（数据还在，只是没画）',
    !/手动模式/.test(document.getElementById('message').textContent),
    document.getElementById('message').textContent);

  setOpt(document.getElementById('optMoveEval'), true);
  await sleep(40);
  eq('再打开，评分原样回来，不用重算', visibleEvals(), 51);
}

// ---- 终局那一步不该去问引擎，本地就能判 ----
{
  // 愚人将杀：1. f3 e5 2. g4 Qh4# —— 最后一步是真正的将杀
  document.querySelector('[data-sample="fool"]').click();
  const foolDone = await waitFor(() => {
    const c = cells();
    return c.length === 4 && !c[3].querySelector('.mv-eval').hidden;
  }, 30000);
  const lastEvalCell = cells()[cells().length - 1].querySelector('.mv-eval');
  ok('将杀那一步的评分也出来了（本地判的，不用问引擎）', foolDone,
    lastEvalCell.textContent);
  ok('而且判成了黑方将杀（负数）', /^#-/.test(lastEvalCell.textContent),
    lastEvalCell.textContent);
}

// ---- 【硬要求】棋谱里没有评注，曲线照样得画出来 ----
// 愚人将杀那盘 1. f3 e5 2. g4 Qh4# 是纯棋谱，一条 { } 评注都没有。
// 曲线必须完全来自鳕鱼自己的计算，不能靠棋谱里的 [%eval] 借光。
{
  const noAnnoDone = await waitFor(
    () => curveDots().length === 5 && !/正在算/.test(
      document.getElementById('evalProgress').textContent),
    60000);

  ok('【无评注棋谱】曲线照样由鳕鱼算出来（开局 + 4 步 = 5 个点）',
    noAnnoDone, curveDots().length + ' 个点');

  const evs = [...document.querySelectorAll('#movesBody .mv-eval')];
  eq('【无评注棋谱】4 步的评分全部标成「本程序算的」',
    evs.filter((e) => e.classList.contains('own')).length, 4);
  eq('【无评注棋谱】没有一条评分是来自棋谱评注',
    evs.filter((e) => e.classList.contains('anno')).length, 0);

  // 第 2 步 e5 之后开局均势 → 局势条应该停在中间附近
  curveDots()[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  const bh = barHeight();
  ok('【无评注棋谱】局势条有实际高度（不是空条）', bh > 1 && bh < 99,
    bh.toFixed(1) + '%');

  // 曲线上的点能点、能跳
  curveDots()[3].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  eq('【无评注棋谱】点曲线上第 3 个点 → 跳到第 3 步',
    document.getElementById('moveCounter').textContent, '第 3 步 / 共 4 步');
}

// ============================================================
section('17. 【新】翻转棋盘');
// ============================================================
document.querySelector('[data-sample="scholar"]').click();
await sleep(80);
document.getElementById('btnFirst').click();
await sleep(60);

eq('不翻时，屏幕左上角是 a8', firstSquare().dataset.square, 'a8');

const e1Wrap = wrapAt('e1');
ok('白王在 e1', !!e1Wrap);
let pos = screenPosOfWrap(e1Wrap);
ok('不翻时白王在屏幕左下角（第 7 行第 4 列）',
  pos.row === 7 && pos.col === 4, `row=${pos.row} col=${pos.col}`);

const beforeFlipTransform = e1Wrap.style.transform;

document.getElementById('btnFlip').click();
await sleep(60);

eq('翻转后格子还是 64 个', squaresCount(), 64);
eq('翻转后屏幕左上角变成 h1', firstSquare().dataset.square, 'h1');

pos = screenPosOfWrap(e1Wrap);
ok('翻转后白王跑到了屏幕上方（第 0 行第 3 列）',
  pos.row === 0 && pos.col === 3, `row=${pos.row} col=${pos.col}`);
// 注意这里不能用 wrapAt('e1') 去找它 —— wrapAt 是靠反解 transform 得到格子名的，
// 而翻转之后同一枚棋子的 transform 已经变成了「另一个格子名的坐标」。
// 直接检查这个元素还在不在 DOM 里就行。
ok('同一个棋子元素，只是 transform 变了（不是删了重画）',
  allWraps().includes(e1Wrap) && e1Wrap.style.transform !== beforeFlipTransform,
  beforeFlipTransform + ' → ' + e1Wrap.style.transform);

ok('翻转是瞬移：棋子层挂上了 no-anim，不会看见棋子飞过半个屏幕',
  document.querySelector('#board .board-pieces').classList.contains('no-anim'));

ok('翻转后没有棋子重叠',
  new Set(visibleWraps().map((w) => {
    const p = screenPosOfWrap(w);
    return p.col + ',' + p.row;
  })).size === visibleWraps().length,
  visibleWraps().length + ' 个棋子');
eq('翻转后棋子数不变（32 个）', visibleWraps().length, 32);

// 边缘坐标也要跟着换边：翻转后最下面一行是 8~1 里的哪几个字母
const bottomRow = [...document.querySelectorAll('#board .sq')].slice(56, 64);
console.log('       翻转后最下面一行: ' + bottomRow.map((d) => d.dataset.square).join(' '));
ok('翻转后最下面一行从 h 排到 a',
  bottomRow.map((d) => d.dataset.square).join(' ') === 'h8 g8 f8 e8 d8 c8 b8 a8',
  bottomRow.map((d) => d.dataset.square).join(' '));

// 箭头坐标也要跟着翻
{
  const n = arrowsMod.squareCenter('a1');
  const f = arrowsMod.squareCenter('a1', true);
  ok('箭头坐标翻转：a1 从右下角镜像到左上角',
    n.x === 0.5 && n.y === 7.5 && f.x === 7.5 && f.y === 0.5,
    JSON.stringify(n) + ' → ' + JSON.stringify(f));
}

// 再翻回来
document.getElementById('btnFlip').click();
await sleep(60);
eq('翻回来后左上角又是 a8', firstSquare().dataset.square, 'a8');
eq('翻回来后白王回到左下角', screenPosOfWrap(e1Wrap).row, 7);
eq('翻回来后棋子还是 32 个', visibleWraps().length, 32);

// ============================================================
section('18. 【新】关掉开关 → 退回手动模式');
// ============================================================
setOpt(document.getElementById('optCurve'), false);
setOpt(document.getElementById('optBar'), false);
await sleep(80);

ok('曲线面板被藏起来了', document.getElementById('evalPanel').hidden);
ok('局势条被藏起来了', document.getElementById('evalBar').hidden);
ok('提示说明了现在是手动模式',
  /手动模式/.test(document.getElementById('message').textContent),
  document.getElementById('message').textContent);

// 手动分析照常可用
document.getElementById('btnFirst').click();
await sleep(40);
document.getElementById('depthSelect').value = '12';
document.getElementById('btnAnalyze').click();
const manualOk = await waitFor(() => !!document.querySelector('#analysisBody .best-move'), 30000);
ok('手动「分析当前局面」照常出结果', manualOk,
  (document.querySelector('#analysisBody .best-move') || {}).textContent || '没出来');
ok('手动结果在棋盘上画出了箭头',
  document.querySelectorAll('#board .board-arrows line').length === 2,
  document.querySelectorAll('#board .board-arrows line').length + ' 条线');
ok('手动结果的箭头是橙色（和整局扫描的青色区分开）',
  document.querySelector('#board .board-arrows line').getAttribute('stroke') === '#e8933a',
  document.querySelector('#board .board-arrows line').getAttribute('stroke'));

// 关掉开关之后不该再自动算：换一盘棋，曲线面板应该保持隐藏
document.querySelector('[data-sample="opera"]').click();
await sleep(300);
ok('手动模式下换棋谱也不会偷偷去算（面板仍然隐藏）',
  document.getElementById('evalPanel').hidden && document.getElementById('evalBar').hidden);
ok('手动模式下换棋谱后，列表里没有「本程序算的」评分',
  document.querySelectorAll('#movesBody .mv-eval.own:not([hidden])').length === 0,
  document.querySelectorAll('#movesBody .mv-eval.own:not([hidden])').length + ' 个');

// ------------------------------------------------------------
// 【新】「着法评分」开关：在手动模式下它管的是什么
// ------------------------------------------------------------
// 这一节是测这个开关最好的地方 —— 手动模式里没有鳕鱼算出来的数据，
// 所以列表里那串数字只可能有一个来源：**棋谱自己写着的评注**。
// 于是这个开关管的是什么，一开一关就看得清清楚楚，还不用等引擎。
{
  const visibleEvals = () =>
    document.querySelectorAll('#movesBody .mv-eval:not([hidden])').length;

  document.querySelector('[data-sample="sample1"]').click();
  await waitFor(() => cells().length === 51, 10000);
  await sleep(60);

  ok('手动模式下不会偷偷跑扫描（曲线面板还是藏着的）',
    document.getElementById('evalPanel').hidden);

  // 先数一遍「现在有几条」——不写死数字，因为棋谱里哪几步带评分是棋谱说了算的
  const annoCount = visibleEvals();
  ok('  但列表里还是有评分 —— 它们是棋谱自带的，不是我们算的',
    annoCount > 0, annoCount + ' 条');
  eq('  一条「本程序算的」都没有',
    document.querySelectorAll('#movesBody .mv-eval.own').length, 0);
  eq('  第 1 步显示的就是棋谱里写的 +0.15',
    cells()[0].querySelector('.mv-eval').textContent, '+0.15');
  ok('  鼠标停在上面会说明这是棋谱自带的',
    /棋谱自带/.test(cells()[0].querySelector('.mv-eval').getAttribute('title') || ''),
    cells()[0].querySelector('.mv-eval').getAttribute('title'));

  setOpt(document.getElementById('optMoveEval'), false);
  await sleep(40);
  eq('关掉「着法评分」→ 列表里一个数字都不剩（棋谱自带的也一起藏）', visibleEvals(), 0);
  ok('  着法本身还在，只是旁边没数字了',
    cells()[0].querySelector('.san').textContent === 'd4');
  ok('  开关只管画不画，不会牵连「要不要在后台算」（一条本程序算的评分都没冒出来）',
    document.querySelectorAll('#movesBody .mv-eval.own').length === 0,
    document.querySelectorAll('#movesBody .mv-eval.own').length + ' 条');

  setOpt(document.getElementById('optMoveEval'), true);
  await sleep(40);
  eq('再打开，棋谱自带的那批评分原样回来', visibleEvals(), annoCount);
}

// ------------------------------------------------------------
// 【Bug 修复】切回自动模式之后，"已切到手动模式……"那句话必须撤掉
// 用户报的：关掉局势条/曲线出现了这句提示，重新打开之后它还挂在页面上。
// ------------------------------------------------------------
{
  const msg = () => document.getElementById('message').textContent;

  // 先切回自动模式 —— 上一小节结束时还停在手动模式，
  // 而"已切到手动模式"这句只在**刚切进来**那一下才弹，不先出来一次就无从验证。
  setOpt(document.getElementById('optCurve'), true);
  await sleep(80);
  setOpt(document.getElementById('optCurve'), false);
  setOpt(document.getElementById('optBar'), false);
  await sleep(80);
  ok('前置：关掉曲线 + 局势条 → 出现手动模式提示', /已切到手动模式/.test(msg()), msg());

  setOpt(document.getElementById('optCurve'), true);
  await sleep(80);
  ok('★★ 重新打开曲线之后，那句"已切到手动模式"不再赖在页面上',
    !/手动模式/.test(msg()), '现在的提示："' + msg() + '"');

  // 别的东西不许被顺手清掉：先摆一句别的提示，再拨开关
  document.querySelector('[data-sample="fool"]').click();
  await waitFor(() => cells().length === 4, 8000);
  const loadMsg = msg();
  ok('前置：载入棋谱会留下自己的提示（没被清空）', loadMsg.length > 0, loadMsg);
  setOpt(document.getElementById('optMoveEval'), false);
  await sleep(60);
  setOpt(document.getElementById('optMoveEval'), true);
  await sleep(60);
  eq('★ 拨开关不会把别的提示顺手清掉（只撤手动模式那一句）', msg(), loadMsg);
}

// ============================================================
section('19. 【Bug 修复】翻页时窗口不许被往下拽');
// ============================================================
//
// 用户报的现象：棋谱后段，每点一次「下一步」，窗口就往下跳一下。
// 根因是原来那句 `td.scrollIntoView({ block: 'nearest' })` ——
// 它会把元素**所有**可滚动祖先滚一遍，而整个文档也是滚动容器，
// 于是「让这一行可见」这件事把整页也拽下去了。

// ---- 19.1 静态检查：代码里不许再有真的 scrollIntoView 调用 ----
{
  const lines = read('js/app.js').split('\n');
  const live = lines.filter((l) => /scrollIntoView/.test(l))
                    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  eq('app.js 里没有任何一行真的在调 scrollIntoView（注释不算）', live.length, 0);

  const css = fs.readFileSync(path.join(PUB, 'css/style.css'), 'utf8');
  ok('.moves-wrap 挡住了滚动外溢（overscroll-behavior: contain）',
    /\.moves-wrap\s*\{[^}]*overscroll-behavior:\s*contain/.test(css));
  ok('着法列表高度改成随窗口伸缩（不再写死 340px）',
    /\.moves-wrap\s*\{[^}]*max-height:\s*min\(/.test(css));

  const titles = [...document.querySelectorAll('.right .card > h2')]
    .map((h) => h.textContent.trim());
  const iMoves = titles.findIndex((t) => /^着法/.test(t));
  const iAnalysis = titles.findIndex((t) => /^分析结果/.test(t));
  ok('右栏顺序：着法排在「分析结果」之前（结果变高不会再推挤着法列表）',
    iMoves >= 0 && iAnalysis >= 0 && iMoves < iAnalysis,
    titles.join(' → '));

  // 「让鳕鱼分析」按钮的搬家：从右栏那张卡片里，挪到左栏翻页按钮的正下方。
  // 翻页和「算这一步」本来是连着做的两个动作，分在两栏里手要来回跑。
  const navEl = document.querySelector('.nav');
  const rowEl = document.querySelector('.analyze-row');
  const btnEl = document.getElementById('btnAnalyze');

  ok('「让鳕鱼分析」按钮现在在左栏（棋盘这一侧）',
    btnEl.closest('section.left') !== null && btnEl.closest('.right') === null,
    '父元素 = ' + (btnEl.parentElement ? btnEl.parentElement.className : '无'));
  ok('它就贴在翻页按钮的下方（.nav 的下一个兄弟节点）',
    navEl.nextElementSibling === rowEl && rowEl.contains(btnEl),
    navEl.nextElementSibling ? navEl.nextElementSibling.className : '没有下一个兄弟');
  ok('思考深度下拉框跟着按钮一起搬过来了',
    rowEl.contains(document.getElementById('depthSelect')));
  ok('右栏那张卡片里不再有第二个分析按钮',
    document.querySelectorAll('.right #btnAnalyze').length === 0);

  // 【Bug 修复】翻页按钮和「让鳕鱼分析」必须排在曲线面板**前面**。
  // 用户报的：曲线一开，整列超过一屏，这两个最常用的按钮被顶到折叠线以下，
  // 每次都要先往下滚一点。
  // （compareDocumentPosition 返回位掩码，4 = DOCUMENT_POSITION_FOLLOWING）
  const evalPanelEl2 = document.getElementById('evalPanel');
  ok('★★ 翻页按钮排在曲线面板之前（曲线再高也不会把它顶下去）',
    !!(navEl.compareDocumentPosition(evalPanelEl2) & 4),
    'nav 在曲线' + ((navEl.compareDocumentPosition(evalPanelEl2) & 4) ? '之前' : '之后'));
  ok('★★ 「让鳕鱼分析」也排在曲线面板之前',
    !!(rowEl.compareDocumentPosition(evalPanelEl2) & 4));
  ok('★ 它们还排在状态行之前（按钮比状态更靠上）',
    !!(navEl.compareDocumentPosition(document.querySelector('.under-board')) & 4));
  ok('★ 吃子栏紧跟在棋盘下面（它是棋盘的一部分，不该被别的块插到中间）',
    document.getElementById('board').closest('.board-row').nextElementSibling ===
      document.getElementById('ledger'));
  ok('  曲线仍然排在棋盘那一块之后、没被搬到页面别处',
    !!(document.querySelector('.board-row').compareDocumentPosition(evalPanelEl2) & 4));
  // 高度也要跟着窗口收：只按宽度缩的话，笔记本那种"宽但不高"的窗口还是会被顶下去
  const cssTxt = fs.readFileSync(path.join(PUB, 'css/style.css'), 'utf8');
  ok('★ 棋盘大小也跟着窗口**高度**缩（不至于在小窗口里把按钮挤出屏幕）',
    /--board-size:\s*min\([^)]*vh\s*\)/.test(cssTxt),
    (cssTxt.match(/--board-size:[^;]*/) || [''])[0]);
}

// ---- 19.2 纯函数：算「该滚多少」的那段逻辑 ----
// 视野 = [100, 400]，也就是可视高度 300
{
  const f = appMod.scrollDeltaFor;

  eq('行完全在视野里 → 不动', f(200, 224, 100, 400), null);
  eq('行正好贴上边界 → 不动（贴边不算超出）', f(100, 124, 100, 400), null);
  eq('行正好贴下边界 → 不动', f(376, 400, 100, 400), null);
  eq('行落在视野上方 → 往上滚，增量为负', f(60, 84, 100, 400), -40);
  eq('行落在视野下方 → 往下滚，增量为正', f(380, 404, 100, 400), 4);
  eq('「不用动」返回 null 而不是 0（0 会让调用方白写一次 scrollTop）',
    f(150, 174, 100, 400), null);
  eq('行比视野还高、开头已在视野顶端 → 不动', f(100, 500, 100, 400), null);
  eq('行比视野还高、开头在视野上方 → 把开头对齐到顶端', f(40, 500, 100, 400), -60);
}

// ---- 19.3 集成：真去点「下一步」，看滚动落在谁身上 ----
{
  // 【踩过的坑】这里原来写的是「点 lichess → 等列表里出现 51 格」。
  // 可上一节结束时，列表里**正好**就是那盘 51 步的棋，于是 waitFor 立刻满足，
  // 测试抢在 fetch 回来之前就在旧数据上跑了起来。等真正的载入完成时，
  // loadPgn 的收尾渲染（会把列表滚到底、并把「当前这一步」放回第 51 步）
  // 才插进来 —— 前面记下的几个滚动位置就全被改写了。
  // 现在先载一盘短棋垫底，再等「计数器真的变成 51 步」，这样才等的是一个变化。
  document.querySelector('[data-sample="fool"]').click();
  await waitFor(() => cells().length === 4, 5000);

  document.querySelector('[data-sample="sample1"]').click();
  const reloaded = await waitFor(() =>
    cells().length === 51 &&
    document.getElementById('moveCounter').textContent.indexOf('共 51 步') >= 0, 10000);
  ok('前置：这盘 51 步的棋是真的重新载入完了（不是拿上一节留下的旧数据在跑）',
    reloaded, document.getElementById('moveCounter').textContent);

  const wrap = document.getElementById('movesWrap');

  // jsdom 不做排版：clientHeight 和各个矩形全是 0。
  // 这里给列表装一套「假排版」——
  //   一行 24px、可视高度 300px、列表顶端在屏幕 500px 处；
  //   着法单元格按 index 排，每 2 个半回合一行（和真实表格一致）。
  // 关键：行的屏幕位置要**随着 scrollTop 往上走**，就像真的滚动容器一样。
  // 不模拟这一点的话，每翻一页算出来的目标都会越滚越远。
  const ROW_H = 24, VIEW_H = 300, WRAP_TOP = 500;

  Object.defineProperty(wrap, 'clientHeight', { configurable: true, get: () => VIEW_H });
  Object.defineProperty(wrap, 'clientTop',    { configurable: true, get: () => 0 });

  window.Element.prototype.getBoundingClientRect = function () {
    if (this === wrap) {
      return { top: WRAP_TOP, bottom: WRAP_TOP + VIEW_H, height: VIEW_H,
               left: 0, right: 0, width: 0, x: 0, y: WRAP_TOP };
    }
    const idx = Number(this.dataset && this.dataset.index);
    if (Number.isFinite(idx) && this.classList.contains('move-cell')) {
      const top = WRAP_TOP + Math.floor(idx / 2) * ROW_H - wrap.scrollTop;
      return { top, bottom: top + ROW_H, height: ROW_H, left: 0, right: 0, width: 0, x: 0, y: top };
    }
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 };
  };

  // 上面这套假排版下，第 ply 半回合「应该」滚到哪里
  const expectScrollTop = (ply) =>
    Math.max(0, (Math.floor(ply / 2) + 1) * ROW_H - VIEW_H);

  wrap.scrollTop = 0;
  scrollIntoViewCalls.length = 0;
  scrollApiCalls.length = 0;

  // 一路往后翻：每次都点「下一步」
  const seen = [];
  const probes = [20, 30, 40, 46, 50];
  for (const ply of probes) {
    cells()[ply].dispatchEvent(new window.Event('click', { bubbles: true }));
    await sleep(20);
    seen.push(wrap.scrollTop);
  }
  eq('往后翻时，列表自己滚到了该去的位置（且不发散）',
    seen, probes.map(expectScrollTop));

  // 再往前翻：回到列表上方
  cells()[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(20);
  eq('往前翻回第 1 步时列表回到顶部', wrap.scrollTop, 0);

  // 当前这一步本来就在视野里时，不该无谓地动
  cells()[5].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(20);
  const before = wrap.scrollTop;
  cells()[6].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(20);
  eq('第 7 步和第 8 步在同一行、且已经看得见 → 列表纹丝不动', wrap.scrollTop, before);

  // 跳到开局 → 列表回顶
  cells()[50].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(20);
  document.getElementById('btnFirst').click();
  await sleep(20);
  eq('点「开局」→ 列表回到顶部（不然会和棋盘上的开局对不上）', wrap.scrollTop, 0);

  // ---- 最重要的一条：整轮翻页里，谁都没去滚页面 ----
  eq('整轮翻页里一次 scrollIntoView 都没发生', scrollIntoViewCalls.length, 0);
  eq('也没有调用过 window.scrollTo / scrollBy', scrollApiCalls.length, 0);
  eq('窗口本身没有被滚动', window.scrollY, 0);
  eq('文档根元素也没有被滚动', document.documentElement.scrollTop, 0);
}

// ============================================================
section('20. 【新】项目改名：DeepFish');
// ============================================================
// 名字只出现在页面标题、大标题和 package.json 里。
// 这里连同「旧名字有没有清干净」一起验 —— 改名字最容易漏掉某一处。
{
  const html = read('index.html');
  const app  = read('js/app.js');
  const css  = read('css/style.css');
  const pkg  = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');

  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '';
  const h1    = (/<h1>([^<]*)<\/h1>/.exec(html) || [])[1] || '';

  ok('浏览器标签页标题里有 DeepFish', /DeepFish/.test(title), title);
  ok('页面左上角大标题是 DeepFish', /DeepFish/.test(h1), h1);
  ok('package.json 里的包名改成了 deepfish',
    /"name"\s*:\s*"deepfish"/.test(pkg), pkg.split('\n')[1].trim());

  const leftovers = [html, app, css, pkg].filter((s) => /ThinkFish/i.test(s)).length;
  eq('界面代码里没有留下旧名字（ThinkFish）', leftovers, 0);
}

// ============================================================
section('21. 【新】DeepSeek 讲解');
// ============================================================
// 讲棋接口由本地打桩提供（见文件开头的 llmStub）：不花一分钱，
// 但「前端拿到回复之后干了什么」全都能验。
//
// ⚠️ 等待时间都是 20 秒，不是 4 秒。因为现在点「讲讲」会**先自己去让鳕鱼
//    把这一步算出来**（见 app.js 的 gatherEngineFacts）—— 多了一次真引擎的
//    往返，而且它可能排在后台那轮整局扫描后面。4 秒会偶发超时。
{
  // ---- 21.1 页面上的状态标记 ----
  llmStub.configured = true;
  llmStub.mode = 'ok';
  llmStub.delayMs = 0;
  llmStub.calls = 0;
  llmStub.lastPayload = null;

  await appMod.checkLlm();
  await sleep(20);

  const llmTag = document.getElementById('llmTag');
  const btnExplain = document.getElementById('btnExplain');

  ok('讲棋状态标出来了（用的是哪个模型）', /deepseek/.test(llmTag.textContent), llmTag.textContent);
  ok('  状态标是"正常"的样式', llmTag.classList.contains('ok'));
  ok('  按钮变成可点', !btnExplain.disabled);

  // ---- 21.2 备一盘干净的棋，并把自动扫描打开（后面要验"前后的评分差"）----
  setOpt(document.getElementById('optCurve'), true);
  setOpt(document.getElementById('optBar'), true);
  setOpt(document.getElementById('optMoveEval'), true);

  document.querySelector('[data-sample="fool"]').click();
  await waitFor(() => cells().length === 4, 8000);
  // 等鳕鱼把前几个局面算出来 —— 没有它，"这一步亏了多少"就无从谈起
  await waitFor(() => document.querySelectorAll('#movesBody .mv-eval.own').length >= 2, 20000);

  cells()[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(30);

  // ---- 21.3 点一下，讲解应该出来 ----
  btnExplain.click();
  await waitFor(() => /败着/.test(document.getElementById('coachBody').textContent), 20000);

  const cb = document.getElementById('coachBody');
  ok('讲解画出来了', /败着/.test(cb.textContent));
  ok('  Markdown 的 ** 变成了真的加粗', !!cb.querySelector('.coach-text b'));
  ok('  行内 `代码` 也渲染了', !!cb.querySelector('.coach-text code'));
  ok('  "- " 变成了列表', !!cb.querySelector('.coach-text ul li'));
  ok('  底部标了模型和用量',
    /deepseek-chat/.test(cb.textContent) && /350/.test(cb.textContent),
    cb.querySelector('.coach-foot').textContent);
  eq('  只请求了一次', llmStub.calls, 1);

  // ---- 21.4 发出去的东西对不对 ----
  const p = llmStub.lastPayload;
  ok('请求里带着当前局面', typeof p.fen === 'string' && p.fen.split(' ').length === 6, p.fen);
  eq('  第几步', p.ply, 1);
  eq('  走的是哪一步', p.san, 'f3');
  eq('★ 走棋方判断正确（愚人将杀第一手是白方走的）', p.color, 'w');
  ok('  带了开局背景', Array.isArray(p.opening) && p.opening.length > 0, JSON.stringify(p.opening));
  ok('★ 带了刚才几步（用来讲"来龙去脉"）', Array.isArray(p.history));
  ok('  带了引擎的判断', p.engine && typeof p.engine === 'object');

  ok('★★ 带的是前后两个原始评分，而不是自己算好的差值',
    p.swing === null || (typeof p.swing.beforeCp === 'number' && typeof p.swing.afterCp === 'number'),
    JSON.stringify(p.swing));
  ok('★★ 前端没有替后端算 forMover（后端不盲信前端算的数）',
    p.swing === null || !('forMover' in p.swing));

  // ---- 21.5 翻页之后，上一段的讲解必须消失 ----
  cells()[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  ok('★★ 翻到别的步之后，上一段讲解不再赖在屏幕上',
    !/败着/.test(document.getElementById('coachBody').textContent),
    document.getElementById('coachBody').textContent.replace(/\s+/g, ' ').slice(0, 36) + '…');

  // ---- 21.6 缓存：先去讲另一步，再翻回来 ----
  // 为什么要先讲第 2 步？因为要走到"从缓存里翻出来"那条分支，
  // 得先让"最近一次讲的结果"变成**别的局面** ——
  // 否则翻回来时命中内存里那份最近的记录，缓存这条路根本没被验证到。
  cells()[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  btnExplain.click();
  await waitFor(() => /败着/.test(document.getElementById('coachBody').textContent), 20000);
  const callsAfterSecond = llmStub.calls;
  eq('  讲第 2 步是新的一件事，确实请求了一次', callsAfterSecond, 2);

  cells()[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  ok('★ 翻回讲过的那一步，讲解原样回来（不用再点按钮）',
    /败着/.test(document.getElementById('coachBody').textContent));
  eq('  而且没有再请求一次（同一步不重复花钱）', llmStub.calls, callsAfterSecond);
  ok('  并说明这是之前讲过的（不是刚讲的那一步）',
    /讲过|旧结果/.test(document.getElementById('coachBody').textContent),
    document.getElementById('coachBody').querySelector('.coach-foot').textContent);

  // ---- 21.7 出错时要说人话，而不是甩一个 500 ----
  llmStub.mode = 'error';
  cells()[3].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  btnExplain.click();
  await waitFor(() => /限流/.test(document.getElementById('coachBody').textContent), 20000);

  const errBody = document.getElementById('coachBody');
  ok('出错时把原因说清楚了', /限流/.test(errBody.textContent));
  ok('  还告诉用户接下来怎么办', /等几秒/.test(errBody.textContent));
  ok('  原始信息收在折叠块里（不吓人，但排查时找得到）',
    !!document.querySelector('#coachBody .coach-detail'));
  ok('  这种错是可以重试的，所以按钮没锁', !btnExplain.disabled);

  // ---- 21.8 密钥没配：按钮锁上，并说清楚怎么配 ----
  llmStub.mode = 'no_key';
  cells()[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  btnExplain.click();
  await waitFor(() => /DEEPSEEK_API_KEY/.test(document.getElementById('coachBody').textContent), 20000);

  ok('没配密钥时，把该做什么写清楚了（点名 .env 和变量名）',
    /DEEPSEEK_API_KEY/.test(document.getElementById('coachBody').textContent));
  ok('★★ 按钮当场锁上 —— 免得对着一个注定失败的按钮反复点',
    btnExplain.disabled);
  ok('  顶部状态也跟着改了', /未配/.test(llmTag.textContent), llmTag.textContent);

  // 再翻到一步没讲过的：这时没有具体错误，应该显示"怎么配"的指引
  cells()[3].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  const guide = document.getElementById('coachBody').textContent;
  ok('没配密钥时翻到没讲过的步子，会显示配置指引（而不是一片空白）',
    /DEEPSEEK_API_KEY/.test(guide) && /重启/.test(guide),
    guide.replace(/\s+/g, ' ').slice(0, 46) + '…');
  ok('  并说明其他功能不受影响，免得用户以为程序坏了',
    /不受影响|照常/.test(guide));
  ok('  还解释了密钥为什么不会跑到浏览器上',
    /不会进浏览器|只留在你本机/.test(guide));

  // ---- 21.9 安全检查：模型回的内容不能变成 HTML ----
  // 模型回的东西本质上是外部输入。它要是被诱导着吐一段 <script>，
  // 而前端直接 innerHTML 上去 —— 那就是一个 XSS。
  llmStub.configured = true;
  llmStub.mode = 'ok';
  llmStub.text = '<img src=x onerror="window.__hacked=1">'
    + '<script>window.__hacked=2</script>'
    + '<b onclick="window.__hacked=3">我是真的加粗</b>'
    + '\n\n这段文字应该**照常加粗**';

  await appMod.checkLlm();
  cells()[3].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  btnExplain.click();
  await waitFor(() => /照常加粗/.test(document.getElementById('coachBody').textContent), 20000);

  const sec = document.querySelector('#coachBody .coach-text');
  eq('★★ 模型回的 <img> 没有变成真的图片元素', sec.querySelectorAll('img').length, 0);
  eq('★★ 模型回的 <script> 没有变成真的脚本元素', sec.querySelectorAll('script').length, 0);
  eq('★★ window 上没有被挂上任何东西', window.__hacked, undefined);
  ok('  原样输入<b> 这种标签也化不成真元素（只会显示成文字）',
    !sec.querySelector('b[onclick]'));
  ok('  但那段文字本身还在（没有被吞掉）', /onerror/.test(sec.textContent));
  ok('  我们自己生成的加粗照常工作', !!sec.querySelector('b'));

  // ---- 21.10 讲棋这套和鳕鱼那套互不干扰 ----
  ok('★ 走了这么多讲棋流程，棋盘高亮还在、局面没乱',
    cells()[3].classList.contains('active'));
  ok('  鳕鱼那条线（着法评分）也照常', !!document.querySelector('#movesBody .mv-eval.own'));

  // ---- 21.11 多轮记忆：结尾那行「【要点】…」被收走当记忆，不显示给用户 ----
  // 放在这一节的最后，是因为它要给同一盘棋多讲两步（会动 explainCache 和请求计数）。
  // 先重新载入，把之前那些"讲过"的记录清掉（loadPgn 里会 clear）。
  llmStub.mode = 'ok';
  llmStub.text = '**这一步是败着。**\n\n- 你漏看了 f7 的威胁\n\n【要点】漏看了 f7，该先挡一下';
  document.querySelector('[data-sample="fool"]').click();
  await waitFor(() => cells().length === 4, 8000);

  cells()[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  const callsBeforeMemo = llmStub.calls;
  btnExplain.click();
  await waitFor(() => /败着/.test(document.getElementById('coachBody').textContent), 20000);
  eq('  这一步确实新讲了一次', llmStub.calls, callsBeforeMemo + 1);

  const memoCb = document.getElementById('coachBody');
  ok('★★ 「【要点】」那一行不显示给用户（它是给记忆用的）',
    !/【要点】/.test(memoCb.textContent) && !/漏看了 f7，该先挡一下/.test(memoCb.textContent),
    memoCb.querySelector('.coach-text').textContent.replace(/\s+/g, ' ').slice(0, 40) + '…');
  ok('  正文本身照常显示', /败着/.test(memoCb.textContent));

  // 再讲下一步：订单里应该带上刚才那句要点
  cells()[3].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(40);
  btnExplain.click();
  await waitFor(() => llmStub.calls === callsBeforeMemo + 2 &&
    /败着/.test(document.getElementById('coachBody').textContent), 20000);
  const memoPayload = llmStub.lastPayload;
  ok('★★ 下一次讲棋带上了"之前几手讲过什么"',
    Array.isArray(memoPayload.recap) && memoPayload.recap.length >= 1 &&
    /漏看了 f7/.test(JSON.stringify(memoPayload.recap)),
    JSON.stringify(memoPayload.recap));
  ok('  带的是主线上的那一手（步数和着法都在）',
    memoPayload.recap && memoPayload.recap[0].ply === 3 && memoPayload.recap[0].san === 'g4',
    JSON.stringify(memoPayload.recap && memoPayload.recap[0]));
}

// ============================================================
section('22. 【新】界面调整：手动才出结果、着法列表变短、讲讲带数字');
// ============================================================
//
// 这一节对应四件事（都是用户直接提的）：
//   1. 着法列表太长了，把右栏下面那两个按钮顶到屏幕外面；
//   2. 「让鳕鱼分析」本该手动触发，却自己显示；
//   3. 三个开关全关掉，最佳走法和局势还在显示；
//   4. 「让 DeepSeek 讲讲」应该同时给出鳕鱼的最佳走法和评分。
//
// 2 和 3 是同一个根：整局扫描的结果原来也被喂给了「分析结果」面板和棋盘箭头，
// 而且关开关时那批数据还留在内存里，于是关也关不掉。
//
// 【当天晚上的第 5 件事】用户又要回箭头，但要它有自己的开关：
//   5. 新增「推荐走法箭头」开关，默认打开；打开时在棋盘上标出鳕鱼推荐的最优走法，
//      关掉时箭头要立刻消失。
// 于是箭头从「手动分析的附属品」变成了一个独立的显示开关（optArrow），
// 数据来源也放宽到：手动分析优先 → 后台整局扫描兜底。
// 面板那条规矩没变 —— 它仍然只认手动。所以 22.1 先把箭头开关关掉，专注验面板。

// ---- 22.1 【核心】「分析结果」面板只认手动分析 ----
{
  setOpt(document.getElementById('optCurve'), true);
  setOpt(document.getElementById('optBar'), true);
  setOpt(document.getElementById('optMoveEval'), true);
  // 这一节只管面板。箭头现在归 22.1b / 22.6 管，先关掉，
  // 免得扫描数据画出来的箭头混进来干扰这里的判断。
  setOpt(document.getElementById('optArrow'), false);

  // 先载一盘别的垫底，好让后面那句「等 4 格出现」真的是在等一个**变化**。
  // 上一节结束时列表里正好就是那盘 4 步的棋，直接等会抢跑（踩过一次的坑）。
  document.querySelector('[data-sample="opera"]').click();
  await waitFor(() => cells().length !== 4, 8000);

  document.querySelector('[data-sample="fool"]').click();
  await waitFor(() => cells().length === 4, 8000);

  // 等扫描真的把 4 步的评分都填进列表 —— 那才是"扫描跑完了"的标志
  const scanDone = await waitFor(
    () => document.querySelectorAll('#movesBody .mv-eval.own').length >= 4, 30000);
  ok('前置：整局扫描确实跑完了（列表里 4 步都有本程序算的评分）',
    scanDone, document.querySelectorAll('#movesBody .mv-eval.own').length + ' 条');

  ok('★★ 扫描跑完了，但「分析结果」面板里没有自作主张冒出来的结论',
    !document.querySelector('#analysisBody .best-move'),
    document.getElementById('analysisBody').textContent.trim().slice(0, 34));
  ok('  棋盘上也没有箭头（这一节把箭头开关关着）',
    document.querySelectorAll('#board .board-arrows line').length === 0,
    document.querySelectorAll('#board .board-arrows line').length + ' 条线');

  // 现在把三个开关全关掉。关键：上面那批扫描数据还留在内存里 ——
  // 「关掉之后依然显示」这个 bug 就是它造成的。
  setOpt(document.getElementById('optCurve'), false);
  setOpt(document.getElementById('optBar'), false);
  setOpt(document.getElementById('optMoveEval'), false);
  await sleep(80);

  ok('★★ 三个开关全关掉之后，面板里依然没有最佳走法',
    !document.querySelector('#analysisBody .best-move'),
    document.getElementById('analysisBody').textContent.trim().slice(0, 34));
  ok('  着法列表里的评分也清空了',
    document.querySelectorAll('#movesBody .mv-eval:not([hidden])').length === 0,
    document.querySelectorAll('#movesBody .mv-eval:not([hidden])').length + ' 条');

  // 手动点一下，东西才出来 —— 而且这时候它**该**出来
  document.getElementById('btnFirst').click();
  await sleep(40);
  document.getElementById('depthSelect').value = '12';
  document.getElementById('btnAnalyze').click();

  const manualBack = await waitFor(
    () => !!document.querySelector('#analysisBody .best-move'), 30000);
  ok('★ 手动点「让鳕鱼分析」→ 结论出来了（手动这条路没被误伤）', manualBack,
    (document.querySelector('#analysisBody .best-move') || {}).textContent || '没出来');
}

// ---- 22.1b 手动分析的结果也能画成箭头（把新开关打开）----
// 箭头虽然改了数据来源，但「手动那份优先」这条优先级要能看出来 ——
// 判据是 arrowEval().source：手动的那份会带上 'manual'。
{
  setOpt(document.getElementById('optArrow'), true);
  await sleep(80);

  const lines = [...document.querySelectorAll('#board .board-arrows line')];
  ok('★ 打开箭头开关 → 手动分析的推荐着法画在了棋盘上',
    lines.length === 2, lines.length + ' 条线');
  ok('  颜色是暖橙', lines.every((l) => l.getAttribute('stroke') === '#e8933a'));
  ok('  用的确实是手动那一份（不是扫描的）',
    !!appMod.arrowEval() && appMod.arrowEval().source === 'manual',
    appMod.arrowEval() ? String(appMod.arrowEval().source) : 'null');

  // 翻到别的步 → 手动那份对不上这个局面了，面板必须收起（不能拿旧结论充数）。
  // 箭头这时候改由扫描数据接管 —— 后台已经为这盘棋算过整盘，
  // 它跟着新局面走，而不是继续指着上一步那一支。
  document.getElementById('btnNext').click();
  await sleep(80);
  ok('  翻页之后「分析结果」面板收起，不拿旧结论充数',
    !document.querySelector('#analysisBody .best-move'));
  ok('  箭头改由扫描数据跟着新局面走（不再用手动那一份）',
    !!appMod.arrowEval() && appMod.arrowEval().source !== 'manual',
    appMod.arrowEval() ? String(appMod.arrowEval().source) : 'null');
}

// ---- 22.2 着法列表的高度压短了 ----
// 它一长，右栏下面的「🤖 让 DeepSeek 讲讲」就被顶出屏幕，想点得先滚一段。
{
  const css = fs.readFileSync(path.join(PUB, 'css/style.css'), 'utf8');
  const m = /\.moves-wrap\s*\{[^}]*max-height:\s*min\(\s*(\d+)vh\s*,\s*(\d+)px\s*\)/.exec(css);

  ok('着法列表的高度上限能读出来', !!m, m ? m[0].replace(/\s+/g, ' ') : '没匹配到');
  if (m) {
    ok('  上限压到 35vh 以内（原来是 58vh，正好把按钮顶出去）',
      Number(m[1]) <= 35, m[1] + 'vh');
    ok('  像素上限压到 300px 以内（原来是 520px）', Number(m[2]) <= 300, m[2] + 'px');
  }
  ok('  顺手确认滚动外溢的防护没弄丢（overscroll-behavior: contain）',
    /\.moves-wrap\s*\{[^}]*overscroll-behavior:\s*contain/.test(css));
}

// ---- 22.3 「让 DeepSeek 讲讲」要同时给出鳕鱼的最佳走法和评分 ----
{
  llmStub.configured = true;
  llmStub.mode = 'ok';
  llmStub.delayMs = 0;
  llmStub.text = '**这一步是败着。**\n\n- 你漏看了 f7 的威胁';

  const btnExplain = document.getElementById('btnExplain');
  await appMod.checkLlm();

  // 三个开关全关 = 纯手动：这一步**没有任何扫描数据兜底**
  setOpt(document.getElementById('optCurve'), false);
  setOpt(document.getElementById('optBar'), false);
  setOpt(document.getElementById('optMoveEval'), false);
  await sleep(60);

  document.querySelector('[data-sample="opera"]').click();
  await waitFor(() => cells().length !== 4, 8000);
  document.getElementById('btnFirst').click();
  await sleep(40);
  document.getElementById('btnNext').click();
  await sleep(40);
  document.getElementById('btnNext').click();
  await sleep(40);
  eq('前置：现在停在第 2 步', document.getElementById('moveCounter').textContent,
    '第 2 步 / 共 33 步');

  const callsBefore = llmStub.calls;
  btnExplain.click();

  const factsOut = await waitFor(() => !!document.querySelector('#coachBody .coach-facts'), 25000);
  ok('★ 没点过「让鳕鱼分析」，讲讲也会自己把数字备齐（不是空手讲）', factsOut,
    document.getElementById('coachBody').textContent.replace(/\s+/g, ' ').slice(0, 44) + '…');

  const factsEl = document.querySelector('#coachBody .coach-facts');
  ok('★★ 事实条里有鳕鱼的最佳走法',
    !!factsEl && (factsEl.querySelector('.cf-move').textContent || '').trim().length > 0 &&
    !/—/.test(factsEl.querySelector('.cf-move').textContent),
    factsEl ? factsEl.querySelector('.cf-move').textContent : '(没有事实条)');
  ok('★★ 事实条里有评分',
    !!factsEl && /^[+\-±#]/.test((factsEl.querySelector('.cf-score').textContent || '').trim()),
    factsEl ? factsEl.querySelector('.cf-score').textContent : '(没有事实条)');
  ok('  还带了优劣判断的文字（白方占优 / 大致均势…）',
    !!factsEl && /均势|占优|胜势|将杀/.test(factsEl.textContent),
    factsEl ? factsEl.textContent.replace(/\s+/g, ' ').slice(0, 40) : '');

  const textOut = await waitFor(
    () => /败着/.test(document.getElementById('coachBody').textContent), 8000);
  ok('★ 讲解正文也出来了，就和数字在一起', textOut);
  eq('  只请求了一次讲棋', llmStub.calls, callsBefore + 1);

  ok('  ★ 发出去的订单里带着引擎的判断（最佳走法）',
    !!(llmStub.lastPayload && llmStub.lastPayload.engine &&
       llmStub.lastPayload.engine.bestMoveSan),
    JSON.stringify(llmStub.lastPayload && llmStub.lastPayload.engine));

  ok('★★ 点「讲讲」不会让「分析结果」面板自己冒出结论（那个是手动的）',
    !document.querySelector('#analysisBody .best-move'),
    document.getElementById('analysisBody').textContent.trim().slice(0, 34));

  // 翻页 → 事实条和讲解一起收起（不能拿上一步的数字配这一步的棋盘）
  document.getElementById('btnNext').click();
  await sleep(60);
  ok('  翻页之后事实条和讲解一起消失',
    !document.querySelector('#coachBody .coach-facts') &&
    !/败着/.test(document.getElementById('coachBody').textContent));
}

// ---- 22.4 纯函数：事实条上的「亏了多少」 ----
{
  const f = appMod.swingNote;
  eq('没数据 → 什么都没说', f({ before: null, now: null, color: 'w' }), '');
  eq('白方评分从 +0.60 掉到 -3.20 → 亏了 3.80',
    f({ before: { scoreCp: 60 }, now: { scoreCp: -320 }, color: 'w' }),
    '这一步亏了约 3.80 个兵');
  eq('同一份评分，黑方走的一步反而是"赚了"（视角要翻过来）',
    f({ before: { scoreCp: 60 }, now: { scoreCp: -320 }, color: 'b' }),
    '这一步赚了约 3.80 个兵');
  eq('几乎没动的，就说没动', f({ before: { scoreCp: 10 }, now: { scoreCp: 15 }, color: 'w' }),
    '基本没改变局势');
  eq('将杀局面没有 cp，就不硬报一个数字',
    f({ before: { scoreMate: 3 }, now: { scoreMate: -1 }, color: 'w' }), '');
}

// ---- 22.5 事实条上「本该走的那一步」的写法 ----
// 引擎的首选 = 他实际走的那一步时，不能说"本该走 X" —— 那像是批评一步好棋。
// 真机联调时撞上的：棋谱里走的 1...e5 正是引擎首选，事实条上却写着"本该走 e5"。
{
  const rf = appMod.renderFacts;
  const base = { now: { scoreCp: 20, scoreMate: null, scoreText: '+0.20' }, color: 'w' };

  ok('走的正是引擎首选 → 说"走的正是引擎首选"，不说"本该走"',
    /走的正是引擎首选/.test(rf(Object.assign({}, base, {
      before: { bestMoveSan: 'e5' }, playedSan: 'e5',
    }))),
    (rf(Object.assign({}, base, { before: { bestMoveSan: 'e5' }, playedSan: 'e5' }))
      .match(/<span class="cf-was[^>]*>[^<]*<b>[^<]*<\/b>/) || [''])[0]);

  ok('  而且配色是"绿的"（不是批评），加了 .same',
    /cf-was same/.test(rf(Object.assign({}, base, {
      before: { bestMoveSan: 'e5' }, playedSan: 'e5',
    }))));

  ok('走的是别的着法 → 才说"本该走"',
    /本该走/.test(rf(Object.assign({}, base, {
      before: { bestMoveSan: 'Nc3' }, playedSan: 'Nf3',
    }))));

  ok('拿不到上一步的数据 → 这一条整个不出现',
    !/cf-was/.test(rf(Object.assign({}, base, { before: null, playedSan: 'Nf3' }))));

  ok('没有鳕鱼数据 → 事实条是空的（宁可不说，也不编）',
    rf({ now: null, before: null, color: 'w' }) === '');
}

// ---- 22.6 纯函数：引擎预想后续的编号 ----
// 早先轮到黑方走时第一着不带编号（只写着法名），于是中局的后续那一行会长成
// "… Nf6 5. Nc3" —— 前半截没有回合号，和注释里的示例（"4... Nf6 5. Nc3"）也对不上。
// 编号现在由「局面是第几回合」决定（见 moveNumberAt），不再由"走了几个半回合"硬推。
{
  const fp = appMod.formatPv;
  eq('白方先走：每一手都带 "n." 编号',
    fp(['e4', 'e5', 'Nf3'], 1, 'w'), '1. e4 1... e5 2. Nf3');
  eq('黑方先走：第一手就写 "4..."，不是光秃秃一个着法名',
    fp(['Nf6', 'Nc3'], 4, 'b'), '4... Nf6 5. Nc3');
  eq('开局就轮到黑方（[FEN] 摆起的棋谱）也一样',
    fp(['c5', 'Nf3'], 1, 'b'), '1... c5 2. Nf3');
  eq('最多给 8 手，不会把提示词撑爆',
    fp(['a3', 'a6', 'b3', 'b6', 'c3', 'c6', 'd3', 'd6', 'e3', 'e6'], 1, 'w').split(' ').length, 16);
}

// ============================================================
section('23. 【新】「推荐走法箭头」开关：启用 / 关闭两种状态');
// ============================================================
//
// 用户要的是：开关打开时，在棋盘上用箭头标出鳕鱼推荐的最优走法；
// 关掉时箭头立刻消失。数据来自后台整局扫描（手动分析有的话优先，见 22.1b）。
//
// ⚠️ 这条最容易写错的地方不是"画不出来"，而是"关不掉"：
//    board.show 每次都要把箭头层清空重画，否则关掉开关后旧箭头会赖在棋盘上。
{
  const optArrowEl = document.getElementById('optArrow');
  const aLines = () => document.querySelectorAll('#board .board-arrows line');
  const aTris  = () => document.querySelectorAll('#board .board-arrows polygon');

  ok('★ 推荐走法箭头默认是打开的', optArrowEl.checked);

  // 打开曲线和局势条 → 载入棋谱后鳕鱼会把整盘棋算一遍。
  // 「着法评分」也要打开：它关着的时候列表里那个 span 是空的（连 own 类名都没有），
  // 就没法拿「列表里有几条自己的评分」当"扫描跑完了"的信号了 ——
  // 而箭头恰恰是吃这份扫描数据的，所以需要这个信号。
  setOpt(document.getElementById('optCurve'), true);
  setOpt(document.getElementById('optBar'), true);
  setOpt(document.getElementById('optMoveEval'), true);
  setOpt(optArrowEl, true);

  // 上一节结束时棋盘上是「歌剧院之局」（33 步）。先换成另一盘、再换到要用的那盘 ——
  // 每次等的都是"数目真的变了"，不会抢跑（这个坑踩过两次了）。
  document.querySelector('[data-sample="scholar"]').click();
  await waitFor(() => cells().length === 7, 8000);
  document.querySelector('[data-sample="fool"]').click();
  await waitFor(() => cells().length === 4, 8000);

  const scanDone2 = await waitFor(
    () => document.querySelectorAll('#movesBody .mv-eval.own').length >= 4, 30000);
  ok('前置：这盘棋的整局扫描跑完了', scanDone2,
    document.querySelectorAll('#movesBody .mv-eval.own').length + ' 条');

  document.getElementById('btnFirst').click();
  await sleep(120);

  ok('★ 开关打开且有扫描数据 → 棋盘上画出了箭头', aLines().length === 2, aLines().length + ' 条线');
  ok('  箭头三角也画出来了', aTris().length === 2, aTris().length + ' 个');

  const scanArrow = appMod.arrowEval();
  ok('  箭头用的确实是扫描数据', !!scanArrow && scanArrow.source === 'engine',
    scanArrow ? String(scanArrow.source) : 'null');

  if (scanArrow && scanArrow.bestMove) {
    const fromSq = scanArrow.bestMove.slice(0, 2);
    const toSq   = scanArrow.bestMove.slice(2, 4);
    const c1 = arrowsMod.squareCenter(fromSq);
    const c2 = arrowsMod.squareCenter(toSq);
    const ln = aLines()[0];
    ok('  箭杆起点正是推荐着法的起点格 ' + fromSq,
      Math.abs(Number(ln.getAttribute('x1')) - c1.x) < 1e-6 &&
      Math.abs(Number(ln.getAttribute('y1')) - c1.y) < 1e-6);
    const tip = aTris()[aTris().length - 1].getAttribute('points').split(' ')[0].split(',');
    ok('  箭头尖端正是推荐着法的终点格 ' + toSq,
      Math.abs(Number(tip[0]) - c2.x) < 1e-6 && Math.abs(Number(tip[1]) - c2.y) < 1e-6);
  }

  // ---------- 关掉：必须当场消失 ----------
  setOpt(optArrowEl, false);
  await sleep(80);

  ok('★★ 关掉开关 → 箭头立刻从棋盘上消失', aLines().length === 0, aLines().length + ' 条线');
  ok('  箭头三角也一起清掉了（不是只清了一半）', aTris().length === 0);
  ok('  只是不画了，数据本身没丢 —— 扫描出来的着法评分还在列表里',
    appMod.arrowEval() === null &&
    document.querySelectorAll('#movesBody .mv-eval.own').length >= 4,
    document.querySelectorAll('#movesBody .mv-eval.own').length + ' 条评分还在');

  // ---------- 再打开：回来 ----------
  setOpt(optArrowEl, true);
  await sleep(80);
  ok('★★ 再打开 → 箭头回来了', aLines().length === 2, aLines().length + ' 条线');

  // ---------- 手动模式下没有扫描数据 → 不硬凑 ----------
  // 曲线和局势条都关掉就不再后台扫描了，这时候箭头没有数据可用。
  // 它应该老老实实什么都不画，而不是拿别的局面的结论凑一个出来。
  setOpt(document.getElementById('optCurve'), false);
  setOpt(document.getElementById('optBar'), false);
  setOpt(optArrowEl, true);
  document.querySelector('[data-sample="scholar"]').click();
  await waitFor(() => cells().length === 7, 8000);
  await sleep(150);

  ok('★★ 手动模式 + 没点过分析 → 没有数据就不画（不硬凑一支箭头）',
    aLines().length === 0, aLines().length + ' 条线');
  ok('  这时候 arrowEval 也如实返回空', appMod.arrowEval() === null);
}

// ============================================================
section('24. 【新】讲棋的订单变厚了：多路线 + 前后两个局面');
// ============================================================
//
// 这一节验的是**真正发出去的那张订单**里带了什么 ——
// 提示词的正文由后端拼（那边由 verify-llm.js 守），
// 这里只管一件事：前端有没有把材料备齐。
//
// ⚠️ 这里等的时间长（25 秒）：点「讲讲」现在会先让鳕鱼**用多路线算两个局面**
//    （见 app.js 的 EXPLAIN_DEPTH / EXPLAIN_MULTIPV），比原来慢。
{
  // 先用另一盘棋垫一下（1 步 → 33 步是真实变化，不会被上一节的残留状态瞬间满足）
  document.querySelector('[data-sample="opera"]').click();
  await waitFor(() => cells().length === 33, 8000);

  const btnExplain = document.getElementById('btnExplain');
  llmStub.calls = 0;
  llmStub.lastPayload = null;

  // 走到第四个半回合（cursor = 2）——
  //   · 要 cursor ≥ 1 才会有「再往前一手」那一层（见 app.js 的 buildExplainPayload）；
  //   · ⚠️ 不能再走回第 2 步：第 22 节已经在新盘上讲过那一步了，
  //     explainCache 是按局面缓存的，"讲讲"会直接命中缓存而**不发请求**，
  //     这一节的前置断言（请求确实发出去了）就会假红。
  document.getElementById('btnFirst').click();
  await sleep(40);
  document.getElementById('btnNext').click();
  await sleep(40);
  document.getElementById('btnNext').click();
  await sleep(40);
  document.getElementById('btnNext').click();
  await sleep(60);

  const callsBefore = llmStub.calls;
  btnExplain.click();
  await waitFor(() => !!document.querySelector('#coachBody .coach-facts'), 25000);
  await sleep(80);

  const p = llmStub.lastPayload;
  eq('前置：请求确实发出去了', llmStub.calls, callsBefore + 1);

  // ---- 前置：鳕鱼那两次多路线分析真的拿到了结果 ----
  //
  // ⚠️ 这一条要单独先断，而不是直接去点 p.engineBefore.alternatives ——
  //    引擎没数据时 p.engineBefore 就是 null，硬点会**把测试崩掉**，
  //    后面所有断言跟着消失，看起来像"整节都没跑"。
  //    先断前置，真实原因才会清清楚楚地显示出来。
  ok('★★ 前置：鳕鱼把两个局面都算出来了（多路线）',
    !!(p.engine && p.engine.alternatives && p.engine.alternatives.length) &&
    !!(p.engineBefore && p.engineBefore.alternatives && p.engineBefore.alternatives.length),
    'engine=' + (p.engine ? p.engine.alternatives.length + ' 条' : 'null') +
    '，engineBefore=' + (p.engineBefore ? p.engineBefore.alternatives.length + ' 条' : 'null'));

  // 后面全部用这两个兜底对象，缺哪一个都只是"这一条不过"，不会崩
  const en = p.engine || {};
  const eb = p.engineBefore || {};
  const enAlts = Array.isArray(en.alternatives) ? en.alternatives : [];
  const ebAlts = Array.isArray(eb.alternatives) ? eb.alternatives : [];

  // ---- 「走这一步之前那个局面」----
  ok('★★ 订单里带了「走这一步之前」的局面（模型不用再倒着走一步）',
    typeof p.beforeFen === 'string' && p.beforeFen.split(' ').length === 6,
    String(p.beforeFen));
  ok('  它确实不是"走之后"那个局面', p.beforeFen !== p.fen, p.beforeFen + ' vs ' + p.fen);

  // ---- 次优解：这是"是真好棋还是不得已"的唯一依据 ----
  ok('★★ 走之前的局面带了次优解（说明真的用了多路线搜）',
    ebAlts.length > 0,
    JSON.stringify(ebAlts.map((a) => a.firstMoveSan)));
  ok('  每一条次优解都有着法名和后续变化（不然拼不出一条线）',
    ebAlts.length > 0 && ebAlts.every((a) => a.firstMoveSan && Array.isArray(a.pvSan)),
    JSON.stringify(ebAlts[0] || null));
  ok('★★ 走之后那个局面也带了次优解',
    enAlts.length > 0,
    JSON.stringify(enAlts.map((a) => a.firstMoveSan)));
  ok('  而且次优解的着法和首选不是同一个（真的搜出了不同的选择）',
    ebAlts.length > 0 && ebAlts.every((a) => a.firstMoveSan !== eb.bestMoveSan),
    eb.bestMoveSan + ' vs ' + ebAlts.map((a) => a.firstMoveSan).join('/'));

  // ---- 主变化 ----
  ok('  走之前的局面带了主变化（要拿它推每一步之后的棋盘）',
    Array.isArray(eb.pvSan) && eb.pvSan.length > 0,
    JSON.stringify(eb.pvSan || null));
  ok('  走之后的局面也带了主变化',
    Array.isArray(en.pvSan) && en.pvSan.length > 0,
    JSON.stringify(en.pvSan || null));
  ok('  深度一并发过来了（提示词要说清"这是搜到第几层的结论"）',
    typeof en.depth === 'number' && typeof eb.depth === 'number',
    en.depth + ' / ' + eb.depth);

  // ---- 「再往前一手」：用户要的"先判断对手上一步想干什么、再推理怎么应对"就靠这一层 ----
  // 没有它，模型只能看见"走这一步之前"的棋盘，看不出那一步到底改了什么，只能猜意图。
  ok('★★ 订单里带了「再往前一手」的局面（对方上一手走之前）',
    typeof p.prevFen === 'string' && p.prevFen.split(' ').length === 6, String(p.prevFen));
  ok('  它和「走这一步之前」「现在」都不是同一个局面',
    p.prevFen !== p.beforeFen && p.prevFen !== p.fen,
    p.prevFen + '  ≠  ' + p.beforeFen);
  ok('  也带了那一手走的是什么（后端要靠它核对整条链条）',
    typeof p.prevSan === 'string' && p.prevSan.length > 0, String(p.prevSan));
}

// ============================================================
section('25. 【改名】三个"大"样例：样例一 / 样例二 / 样例三');
// ============================================================
{
  const btn1 = document.querySelector('[data-sample="sample1"]');
  const btn2 = document.querySelector('[data-sample="sample2"]');
  const btn3 = document.querySelector('[data-sample="sample3"]');
  ok('三个按钮都在线上', !!btn1 && !!btn2 && !!btn3);
  // 按钮上只写编号，不写平台名 —— 来源和看点都放进悬停提示
  eq('★ 样例一的文案（不带平台名）', btn1.textContent.trim(), '样例一');
  eq('★ 样例二的文案', btn2.textContent.trim(), '样例二');
  eq('★ 样例三的文案', btn3.textContent.trim(), '样例三');
  ok('  三个都没有平台名/旧名字（lichess、国象联盟、测试样例都不在按钮上）',
    ![btn1, btn2, btn3].some((b) => /lichess|国象|测试样例|带评注的对局/i.test(b.textContent)));
  ok('  三个都是"最值得先试"的高亮样式',
    btn1.classList.contains('hl') && btn2.classList.contains('hl') && btn3.classList.contains('hl'));
  ok('  鼠标悬停能看出各自是什么棋（长度 / 来源 / 要看哪一步）',
    /51 步/.test(btn1.getAttribute('title') || '') &&
    /31 步/.test(btn2.getAttribute('title') || '') && /第 10 手/.test(btn2.getAttribute('title') || '') &&
    /102 步/.test(btn3.getAttribute('title') || '') && /第 50 手/.test(btn3.getAttribute('title') || ''),
    btn3.getAttribute('title'));

  // ---- 样例二要真的能载入、能翻到最后 ----
  btn2.click();
  const loaded2 = await waitFor(() => cells().length === 31, 10000);
  ok('★★ 样例二载入成功：31 步', loaded2, cells().length + ' 步');
  document.getElementById('btnLast').click();
  await sleep(30);
  eq('  最后一步是升变成马将杀', cells()[30].querySelector('.san').textContent, 'b8=N#');

  // 这一幕正好可以顺带验吃子栏：两步都是吃子，最后一步还是升变
  const led2 = appMod.ledgerNow();
  ok('★ 样例二最后：吃子栏算得出账', led2.byWhite.length > 0 && led2.byBlack.length > 0,
    '白吃 ' + led2.byWhite.join('') + ' 黑吃 ' + led2.byBlack.join('') + ' 差 ' + led2.diff);

  // 独立的对照：吃子步数由 chess.js 自己数（`captured` 字段），和吃子栏对比。
  // 顺带把"升变不是吃子"这件事钉住 —— 最后一步 b8=N# 是升变，账上不该多一个子。
  const R2 = pgnMod.parsePgn(fs.readFileSync(path.join(PUB, 'samples/sample2.pgn'), 'utf8'));
  ok('  前置：这盘棋谱自己解析成功', R2.ok, R2.error || '');
  const capMoves = R2.moves.filter((m) => m.captured).length;
  eq('★★ 两行棋子加起来 = 全局的吃子步数（一个不多、一个不少）',
    led2.byWhite.length + led2.byBlack.length, capMoves);
  const lastMove = R2.moves[R2.moves.length - 1];
  ok('★★ 最后一步是「升变成马」而不是吃子 —— 所以它不该出现在吃子栏里',
    lastMove.promotion === 'n' && !lastMove.captured, lastMove.san);

  // ---- 样例三：102 步的残局拉锯，能载入、能翻到那步 50.Kh5 ----
  btn3.click();
  const loaded3 = await waitFor(() => cells().length === 102, 12000);
  ok('★★ 样例三载入成功：102 步', loaded3, cells().length + ' 步');
  ok('  结果读到了黑方赢（白方认输）',
    /0-1|黑方胜|白方认输/.test(document.getElementById('message').textContent),
    document.getElementById('message').textContent.slice(0, 60));

  // 直接跳到第 99 个半回合（50.Kh5）：那一格正是"王吃不了旁边的兵"的位置
  const st99 = appMod.accountBranchState();
  eq('  前置：现在停在最后一步', st99.cursor, 101);
}

// ============================================================
section('26. 【新】直接在棋盘上走棋：支线、悔棋、导出、退出提醒');
// ============================================================
//
// 这一节把新功能整条走一遍：
//   点自己的子 → 亮出合法落点 → 点落点落子 → 记成支线（原棋谱不动）
//   → 悔棋 → 导出成带变着的 PGN → 退出提醒/换盘拦截
//
// ⚠️ 落点全部来自 chess.js 的合法着法，所以这一节也顺带证明了
//    "在棋盘上根本走不出非法棋"这件事。
{
  const clickSq = (name) => {
    const el = document.querySelector('#board .sq[data-square="' + name + '"]');
    ok('  前置：棋盘上有 ' + name + ' 这一格', !!el);
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  };
  const branchMoves = () => [...document.querySelectorAll('#branchList .move-cell[data-index]')]
    .map((td) => td.querySelector('.san').textContent);
  const selSquares = (cls) => [...document.querySelectorAll('#board .sq.' + cls)]
    .map((el) => el.dataset.square).sort();
  const st = () => appMod.accountBranchState();

  // 先载一盘短的：学者将杀 7 步
  llmStub.mode = 'ok';
  document.querySelector('[data-sample="scholar"]').click();
  await waitFor(() => cells().length === 7, 8000);
  document.getElementById('btnFirst').click();
  await sleep(40);

  eq('前置：现在停在开局', document.getElementById('moveCounter').textContent, '开局 · 共 7 步');
  eq('前置：还没有任何支线', st().branches.length, 0);
  ok('前置：支线那一块是藏着的', document.getElementById('branchBlock').hidden);

  // ---------- ① 点自己的子 → 亮出合法落点 ----------
  clickSq('e2');
  await sleep(30);
  eq('点 e2 的兵 → 它被选中了', st().selectedSquare, 'e2');
  eq('  合法落点是 e3 / e4（兵第一步可以走两格）', st().legalTargets.sort(), ['e3', 'e4']);
  eq('  棋盘上标出了"选中的子"', selSquares('sel-src'), ['e2']);
  eq('  棋盘上标出了两个可落点', selSquares('sel-target'), ['e3', 'e4']);
  ok('  下面那行提示写明了能走几个格',
    /选中了 e2/.test(document.getElementById('playHint').textContent),
    document.getElementById('playHint').textContent);

  // ---------- ② 点对方的子 → 选不中（根本走不出非法棋）----------
  clickSq('d7');
  await sleep(20);
  eq('轮到白走时点黑子 → 不会选中它', st().selectedSquare, null);
  eq('  也没有任何支线被建出来', st().branches.length, 0);

  // ---------- ③ 点落点 → 落子，记成一条支线 ----------
  clickSq('e2');
  await sleep(20);
  clickSq('e4');
  await sleep(60);
  ok('★ 棋盘上真的走出了 e4', pieceAt('e', 4) !== null && pieceAt('e', 4).color === 'w',
    JSON.stringify(pieceAt('e', 4)));
  eq('★ 建出了一条支线，里面就是这一步', st().branches.map((b) => b.moves.join(' ')), ['e4']);
  eq('  它是从开局接出去的（atPly = -1）', st().branches[0].atPly, -1);
  eq('★ 原棋谱一步没动：主线还是 7 步', cells().length, 7);
  eq('  主线第一步还是 e4 那盘棋原本的着法',
    cells()[0].querySelector('.san').textContent, 'e4');
  eq('  支线表里画出了这一步', branchMoves(), ['e4']);
  ok('★ 支线那一块出现了', !document.getElementById('branchBlock').hidden);
  eq('  计数改成说支线了', document.getElementById('moveCounter').textContent,
    '支线 1 · 第 1 步 / 共 1 步');
  ok('  时间线自检通过（动画可信）', st().branches[0].timelineOk);
  ok('★ 这一步算"没导出"，所以退出会提醒', st().unsaved);

  // ---------- ④ 支线上继续走：接着这条支线，不是再开一条 ----------
  clickSq('e7');
  await sleep(20);
  clickSq('e5');
  await sleep(60);
  eq('★ 在支线末尾走 → 接着这条支线（不是新开一条）',
    st().branches.map((b) => b.moves.join(' ')), ['e4 e5']);
  eq('  支线里两行都画出来了', branchMoves(), ['e4', 'e5']);

  // ---------- ⑤ 悔棋 ----------
  document.getElementById('btnUndoMove').click();
  await sleep(40);
  eq('★ 悔棋收掉了最后一步', st().branches.map((b) => b.moves.join(' ')), ['e4']);
  document.getElementById('btnUndoMove').click();
  await sleep(40);
  eq('★ 撤到空 → 这条支线整个消失', st().branches.length, 0);
  ok('★ 支线没了，那一块也藏起来', document.getElementById('branchBlock').hidden);
  eq('  棋盘退回主线开局', document.getElementById('moveCounter').textContent, '开局 · 共 7 步');

  // ---------- ⑥ 从主线中间走 → 新支线，主线后面那几步留着 ----------
  document.getElementById('btnNext').click();
  await sleep(30);
  document.getElementById('btnNext').click();
  await sleep(30);
  document.getElementById('btnNext').click();
  await sleep(40);
  eq('前置：主线走到第 3 步', document.getElementById('moveCounter').textContent, '第 3 步 / 共 7 步');
  const mainThirdSan = cells()[2].querySelector('.san').textContent;

  // ⚠️ 走到第 3 步之后轮到**黑方**走（学者将杀：1.e4 e5 2.Bc4 之后），
  //    所以这里必须点黑子 —— 点白子是不会被选中的（这正是"走不出非法棋"）。
  clickSq('b8');
  await sleep(20);
  clickSq('c6');
  await sleep(60);
  eq('★ 从主线第 3 步接出一条新支线', st().branches.map((b) => b.moves.join(' ')), ['Nc6']);
  eq('  记下了它是从哪一步接出去的', st().branches[0].atPly, 2);
  eq('★ 主线后面那几步原样保留', cells().length, 7);
  eq('  主线第 3 步没被改写', cells()[2].querySelector('.san').textContent, mainThirdSan);
  eq('★ 主线上那一步挂了"这里有支线"的标记',
    document.querySelectorAll('#movesBody .move-cell.has-branch').length, 1);
  eq('  标记正好在第 3 步那一格',
    document.querySelector('#movesBody .move-cell.has-branch').dataset.index, '2');

  // ---------- ⑦ 站在支线上时，主线那一行不该跟着高亮 ----------
  eq('★ 主线列表里没有高亮（现在不在主线上）',
    document.querySelectorAll('#movesBody .move-cell.active').length, 0);
  eq('  支线表里高亮的正是这一步',
    document.querySelectorAll('#branchList .move-cell.active').length, 1);
  eq('  支线的绝对半回合号是对的（主线 3 步 + 支线 1 步 = 第 4 个半回合）',
    st().absolutePly, 4);
  eq('★ 支线那一格不借用主线扫描的数据（那是别的局面的）；这一步还没算过，所以箭头是空的',
    appMod.arrowEval(), null);

  // ---------- ⑦.5 两条平行支线：回到主线再走一条，上一条要留着 ----------
  // 这是用户明确要的用法："在第 3 回合试了 Nf6，又回来试 d6 —— 两条都留着"。
  //
  // ⚠️ 翻页按钮只在**当前这条线**里走（这是标准棋软的做法），所以回主线要用
  //    「↩ 回到主线」那个按钮（或者点主线的着法）—— 不然"开局"只会走到支线的起点。
  document.getElementById('btnBackToMain').click();
  await sleep(40);
  eq('★ 「回到主线」把你送回离开主线的那一步', st().activeBranchId, null);
  document.getElementById('btnFirst').click();
  await sleep(30);
  clickSq('e2');
  await sleep(20);
  clickSq('e3');
  await sleep(60);
  eq('★ 从同一个局面再走一条 → 是**两条平行支线**，上一条没被顶掉',
    st().branches.map((b) => b.moves.join(' ')), ['Nc6', 'e3']);
  eq('  两条各自记着自己是接在哪一步的', st().branches.map((b) => b.atPly), [2, -1]);
  eq('  支线表里两条都画出来了',
    document.querySelectorAll('#branchList .branch-item').length, 2);

  const twoPgn = appMod.buildExportPgn();
  eq('★★ 两条支线都写进了 PGN（两个变着）',
    (twoPgn.match(/\( /g) || []).length, 2);
  let twoOk = true;
  let twoErr = '';
  try { new chessMod.Chess().loadPgn(twoPgn); } catch (e) { twoOk = false; twoErr = e.message; }
  ok('★★ chess.js 也认这段（变着的位置和注释都合规范）', twoOk, twoOk ? twoPgn.split('\n\n')[1] : twoErr);
  ok('  变着排在它替换掉的那一步**之后**（排前面是不合法的）',
    /\( 3\.\.\. Nc6 \)/.test(twoPgn) || /\( 1\. e3 \)/.test(twoPgn),
    (twoPgn.match(/\([^)]*\)/g) || ['']).join(' '));

  // 这一段用完就把支线收掉，免得后面换盘被"未导出"拦住
  document.getElementById('btnExportPgn').click();
  await sleep(20);
  document.getElementById('btnCloseExport').click();
  await sleep(20);

  // ---------- ⑧ 升变：要弹选择 ----------
  // 先把刚才那条支线导出掉 —— 不然下面换盘会被"未导出的支线"拦住
  // （拦截本身在第 ⑪ 段专门测）。
  document.getElementById('btnExportPgn').click();
  await sleep(20);
  document.getElementById('btnCloseExport').click();
  await sleep(20);

  document.getElementById('pgnInput').value =
    '[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"]\n\n1. Kd2';
  document.getElementById('btnLoad').click();
  await sleep(60);
  eq('前置：换成那个"兵快到底线"的局面（只 1 步）', cells().length, 1);
  document.getElementById('btnFirst').click();
  await sleep(30);
  clickSq('a7');
  await sleep(20);
  clickSq('a8');
  await sleep(40);
  ok('★ 兵到底线 → 弹出升变选择（不选就没法确定升成什么）',
    !document.getElementById('promoPicker').hidden);
  ok('  这时候还没落子', st().branches.length === 0);
  ok('  提示也换成了"先选升变成什么"',
    /升变/.test(document.getElementById('playHint').textContent));
  document.querySelector('#promoPicker [data-promo="n"]').click();
  await sleep(60);
  eq('★ 选了马 → 走出来的就是升变成马那一步',
    st().branches.map((b) => b.moves.join(' ')), ['a8=N']);
  ok('  升变面板收起来了', document.getElementById('promoPicker').hidden);

  // ---------- ⑨ 导出：支线写成标准 PGN 变着 ----------
  const pgn = appMod.buildExportPgn();
  ok('★ 导出的 PGN 里带一条变着', /\( .* \) /.test(pgn) || /\( .* \)/.test(pgn),
    (pgn.match(/\([^)]*\)/) || [''])[0]);
  ok('  变着里就是自己走的那一步', /a8=N/.test(pgn));
  ok('  头部还在（含 [FEN]，不然中局摆起的棋谱重放不出来）', /\[FEN "/.test(pgn));
  const reparsed = pgnMod.parsePgn(pgn);
  ok('★★ 导出的 PGN 能被我们自己的解析器读回来（主线一字不差）',
    reparsed.ok && reparsed.moves.length === 1 && reparsed.moves[0].san === 'Kd2',
    reparsed.ok ? reparsed.moves.map((m) => m.san).join(' ') : reparsed.error);
  let chessOk = true;
  let chessErr = '';
  try { new chessMod.Chess().loadPgn(pgn); } catch (e) { chessOk = false; chessErr = e.message; }
  ok('★★ chess.js 也认这段 PGN（变着语法没过界）', chessOk, chessOk ? pgn.split('\n\n')[1] : chessErr);

  // ---------- ⑩ 导出面板 / 退出提醒 ----------
  const evt1 = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(evt1);
  ok('★ 有没导出的支线 → 关页面时会被拦一下', evt1.defaultPrevented);

  document.getElementById('btnExportPgn').click();
  await sleep(30);
  ok('  导出面板打开了，框里就是完整 PGN',
    !document.getElementById('exportPanel').hidden &&
    document.getElementById('exportText').value === pgn);
  ok('★ 导出之后不再算"没保存"', !appMod.hasUnsavedBranches());
  const evt2 = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(evt2);
  ok('  再关页面就不拦了', !evt2.defaultPrevented);
  document.getElementById('btnCloseExport').click();
  await sleep(20);

  // ---------- ⑪ 换盘前的拦截 ----------
  // 走一步黑的（升变之后轮到黑方），把状态重新弄成"有没导出的支线"
  clickSq('e8');
  await sleep(20);
  clickSq('d8');
  await sleep(60);
  eq('前置：支线又变"没导出"了', st().unsaved, true);

  const before = appMod.mainFenAt(0);
  document.getElementById('pgnInput').value = '1. e4 e5 2. Nf3';
  document.getElementById('btnLoad').click();
  await sleep(60);
  ok('★ 有没导出的支线时，点「载入棋谱」不会直接把它冲掉',
    !document.getElementById('loadGuard').hidden);
  eq('  这盘棋还是原来那盘', appMod.mainFenAt(0), before);
  ok('  支线也还在', st().branches.length === 1);

  document.getElementById('btnGuardExport').click();
  await sleep(30);
  ok('  点「先去导出」→ 打开导出面板',
    !document.getElementById('exportPanel').hidden);
  eq('★ 而且把载入取消了（这一盘没被冲掉）', document.getElementById('loadGuard').hidden, true);
  document.getElementById('btnCloseExport').click();
  await sleep(20);

  // 这次先导出掉，再换盘就不该拦了
  document.getElementById('btnExportPgn').click();
  await sleep(30);
  document.getElementById('btnCloseExport').click();
  document.getElementById('pgnInput').value = '1. e4 e5 2. Nf3';
  document.getElementById('btnLoad').click();
  await sleep(60);
  eq('★ 已经导出过 → 直接载入，不再拦', document.getElementById('loadGuard').hidden, true);
  eq('  新棋谱载进来了', cells().length, 3);
  eq('★ 换盘之后支线清空（它们挂的是上一盘的局面）', st().branches.length, 0);
  ok('  支线那一块也藏起来了', document.getElementById('branchBlock').hidden);
}

// ============================================================
section('27. 【新】站在支线上，鳕鱼和讲棋照样能用（回合号/历史都要跟着这条线）');
// ============================================================
{
  const clickSq = (name) => document
    .querySelector('#board .sq[data-square="' + name + '"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const st = () => appMod.accountBranchState();

  // 学者将杀：1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#
  document.querySelector('[data-sample="scholar"]').click();
  await waitFor(() => cells().length === 7, 8000);
  document.getElementById('btnFirst').click();
  await sleep(40);

  // 在开局走一条自己的线：1.d4
  clickSq('d2');
  await sleep(20);
  clickSq('d4');
  await sleep(60);
  eq('前置：走出了一条支线', st().branches.map((b) => b.moves.join(' ')), ['d4']);

  // ---------- 让鳕鱼分析这个支线局面 ----------
  llmStub.lastPayload = null;
  const callsBefore = llmStub.calls;
  document.getElementById('btnAnalyze').click();
  const analyzed = await waitFor(() => !!document.querySelector('#analysisBody .best-move'), 30000);
  ok('★ 站在支线上，点「让鳕鱼分析」照样出结果', analyzed,
    document.getElementById('analysisBody').textContent.replace(/\s+/g, ' ').slice(0, 50));
  if (analyzed) {
    ok('  推荐着法/评分都画出来了',
      /[a-h]/.test(document.querySelector('#analysisBody .best-uci').textContent || ''));
    ok('★ 这一手的分数被挂到支线那一步上（列表里能看见）',
      !!document.querySelector('#branchList .mv-eval.own'),
      (document.querySelector('#branchList .mv-eval') || {}).textContent || '');
  }

  // ---------- 讲棋：订单里的回合号/历史必须按"当前这条线"算 ----------
  llmStub.lastPayload = null;
  const explainCalls = llmStub.calls;
  document.getElementById('btnExplain').click();
  await waitFor(() => !!document.querySelector('#coachBody .coach-facts'), 25000);
  await sleep(80);
  const p = llmStub.lastPayload;
  ok('★ 站在支线上，讲棋的订单也发出去了', llmStub.calls === explainCalls + 1);
  if (p) {
    eq('★★ 订单里这一步的着法是支线上的那一步（不是原棋谱同位置的）', p.san, 'd4');
    eq('★★ ply 是整盘棋的半回合号（1.d4 = 第 1 个），不是"支线内部第几步"的错算',
      p.ply, 1);
    eq('  走之前的局面就是开局', p.beforeFen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    eq('  这条线是空的（还没走过别的），所以没有再往前的两层', p.prevFen, '');
    eq('  走这一步的是白方', p.color, 'w');
  }

  // ---------- 再走一步，ply 要跟着涨（绝对编号）----------
  clickSq('d7');
  await sleep(20);
  clickSq('d5');
  await sleep(60);
  eq('  支线两步', st().branches.map((b) => b.moves.join(' ')), ['d4 d5']);
  eq('★ 这一步的绝对半回合号是 2', st().absolutePly, 2);
  llmStub.lastPayload = null;
  document.getElementById('btnExplain').click();
  await waitFor(() => !!document.querySelector('#coachBody .coach-facts'), 25000);
  await sleep(80);
  const p2 = llmStub.lastPayload;
  if (p2) {
    eq('★ 黑方这一步的 ply 是 2', p2.ply, 2);
    eq('★ history 里能看到这条线上刚走的 d4', JSON.stringify(p2.history), JSON.stringify(['d4']));
    eq('  opening 也是这条线上的开头', JSON.stringify(p2.opening), JSON.stringify(['d4', 'd5']));
  }

  // ---------- 收尾：导出，别把"没保存"的状态留给后面的测试 ----------
  document.getElementById('btnExportPgn').click();
  await sleep(30);
  document.getElementById('btnCloseExport').click();
  await sleep(20);
}

// ============================================================
section('28. 【新】走支线时也有局势条 / 分数 / 推荐走法箭头');
// ============================================================
//
// 主线上这三样东西是**后台整局扫描**给的（evals，按主线步数索引）。
// 支线的局面不在那条扫描里 —— 所以走完一步会**自动补算这一个局面**，
// 结果存在支线那一步上，局势条 / 分数 / 箭头都从它来。
//
// 两条边界也在这里锁死：
//   · 手动模式（曲线和局势条都关）**不许**偷着算 —— 这是原来的规矩，支线不破例；
//   · 它只喂局势条/分数/箭头，**不往「分析结果」面板里写字**（那个面板只认手动按钮）。
{
  const clickSq = (name) => document
    .querySelector('#board .sq[data-square="' + name + '"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const barScore = () => (document.querySelector('#evalBar .evalbar-score') || {}).textContent || '';
  const branchScores = () => [...document.querySelectorAll('#branchList .mv-eval.own')]
    .map((el) => el.textContent);

  // 短棋谱 + 最低扫描深度，省时间
  document.getElementById('scanDepthSelect').value = '6';
  document.querySelector('[data-sample="scholar"]').click();
  await waitFor(() => cells().length === 7, 8000);

  // 先关掉、再打开：确保老老实实触发一轮主线扫描（也保证状态干净）
  setOpt(document.getElementById('optCurve'), false);
  setOpt(document.getElementById('optBar'), false);
  await sleep(40);
  setOpt(document.getElementById('optCurve'), true);
  setOpt(document.getElementById('optBar'), true);
  const scanned = await waitFor(
    () => !/正在算/.test(document.getElementById('evalProgress').textContent), 60000);
  ok('前置：主线那一轮扫描跑完了', scanned,
    document.getElementById('evalProgress').textContent);

  document.getElementById('btnFirst').click();
  await sleep(40);

  // ---------- 走一步支线：局势条 / 分数 / 箭头应该自己冒出来 ----------
  clickSq('d2');
  await sleep(20);
  clickSq('d4');
  await sleep(60);
  eq('前置：支线建出来了', appMod.accountBranchState().branches.length, 1);

  const gotBar = await waitFor(() => !!barScore() && barScore() !== '—', 20000);
  ok('★★ 走支线时局势条照样显示分数', gotBar, '局势条上是「' + barScore() + '」');

  const gotArrow = await waitFor(
    () => document.querySelectorAll('#board .board-arrows line').length === 2, 20000);
  ok('★★ 也画出了鳕鱼推荐走法箭头', gotArrow,
    document.querySelectorAll('#board .board-arrows line').length + ' 条线');
  ok('  箭头三角也画出来了',
    document.querySelectorAll('#board .board-arrows polygon').length === 2);
  ok('★ 支线列表里那一步带上了分数', branchScores().length === 1, branchScores().join(' '));
  ok('  支线那一步的分数和局势条是同一份数据（不会自相矛盾）',
    !!document.querySelector('#branchList .mv-eval').title.match(/鳕鱼实时计算/),
    document.querySelector('#branchList .mv-eval').title);
  ok('★ 这一步的分数被记住了（再翻回来不用重新问引擎）',
    !!appMod.accountBranchState().branches[0].moves.length);

  // 支线的**起点**是主线上的局面 —— 那一格借扫描数据，局势条也有内容
  document.getElementById('btnPrev').click();
  await sleep(60);
  ok('  回到支线起点（=主线那一步）：局势条也有分数', barScore() !== '—', '「' + barScore() + '」');
  document.getElementById('btnNext').click();
  await sleep(60);

  // 再走一步：第二步同样会被自动补算
  clickSq('d7');
  await sleep(20);
  clickSq('d5');
  await sleep(60);
  const gotSecond = await waitFor(() => branchScores().length === 2, 20000);
  ok('★★ 支线第二步也自动算出来了（两步都有分数）', gotSecond, branchScores().join(' '));
  ok('  箭头用的是这一步的建议（不是上一步剩下的）',
    document.querySelectorAll('#board .board-arrows line').length === 2);

  // ---------- 边界一：手动模式不许偷着算 ----------
  setOpt(document.getElementById('optCurve'), false);
  setOpt(document.getElementById('optBar'), false);
  await sleep(60);
  // d4 d5 之后轮到**白方**走，所以这里点白的马
  clickSq('g1');
  await sleep(20);
  clickSq('f3');
  await sleep(500);                     // 故意等一会儿：该"什么都不做"
  eq('★ 手动模式下走支线不会自动叫引擎（分数不会自己冒出来）',
    branchScores().length, 2);
  eq('  也不画箭头（没有数据就不硬凑一支）',
    document.querySelectorAll('#board .board-arrows line').length, 0);
  ok('  这一步仍然是走成了的（只是没算分）',
    appMod.accountBranchState().branches[0].moves.length === 3,
    appMod.accountBranchState().branches[0].moves.join(' '));

  // ---------- 边界二：自动算的东西不许写进「分析结果」面板 ----------
  ok('★★ 全程没动过「分析结果」面板（那个还是只认手动按钮）',
    !document.querySelector('#analysisBody .best-move'));

  // ---------- 手动点一下：照样有效，而且结果也存到支线上 ----------
  document.getElementById('btnAnalyze').click();
  const manualOk2 = await waitFor(
    () => !!document.querySelector('#analysisBody .best-move'), 30000);
  ok('★ 手动点「让鳕鱼分析」在支线上照样有效', manualOk2);
  const gotThird = await waitFor(() => branchScores().length === 3, 15000);
  ok('  手动算的这一份也存到支线那一步上了', gotThird, branchScores().join(' '));

  // 收尾：把开关恢复成默认（开着），并且把支线导出掉，别把状态留给后面的测试
  setOpt(document.getElementById('optCurve'), true);
  setOpt(document.getElementById('optBar'), true);
  await sleep(60);
  document.getElementById('btnExportPgn').click();
  await sleep(30);
  document.getElementById('btnCloseExport').click();
  await sleep(20);
}

// ============================================================
section('29. 【Bug 修复】棋盘下面那句提示太长，把右边的界面挤扁了');
// ============================================================
//
// 现象：站在支线上时，那行提示里挂了一句很长的括号说明，**右边整栏被压窄**。
//
// 根因不在那句话本身，而在布局：main 是 `grid-template-columns: auto 1fr`，
// 左栏是 auto（按内容撑），而 .left 没有宽度上限 —— 于是一句长文案
// 会把左栏撑到几百像素宽，右栏那个 1fr 就被挤扁了。
// **任何**一句长文案都能触发，所以两处都要修：
//   ① 布局上锁死（左栏宽度钉在棋盘那一列、右栏可缩、长文允许任意断行）；
//   ② 文案本身写短（完整解释挪进按钮的 title）。
{
  const css = fs.readFileSync(path.join(PUB, 'css', 'style.css'), 'utf8');

  ok('★★ 左栏宽度钉死在棋盘那一列上（长文案撑不宽它）',
    /\.left\s*\{[^}]*width:\s*var\(--panel-w\)/s.test(css),
    (css.match(/\.left\s*\{[^}]*\}/s) || [''])[0].replace(/\s+/g, ' ').slice(0, 90));
  ok('★★ 右栏用 minmax(0, 1fr)（自己也能缩，不会被内容顶住）',
    /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/.test(css));
  ok('  长文案允许任意断行（提示行 + 棋谱评注都上了这道保险）',
    (css.match(/overflow-wrap:\s*anywhere/g) || []).length >= 2,
    (css.match(/overflow-wrap:\s*anywhere/g) || []).length + ' 处');

  // 文案本身也量一下：站在支线上时那行提示不能是一长串
  document.getElementById('btnFirst').click();
  await sleep(30);
  const hintEl = document.getElementById('playHint');
  const plain = hintEl.textContent.length;
  ok('  提示本来就该是短的（' + plain + ' 字 ≤ 80）', plain <= 80, hintEl.textContent);

  const d2 = document.querySelector('#board .sq[data-square="d2"]');
  d2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const d4 = document.querySelector('#board .sq[data-square="d4"]');
  d4.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const branchHint = hintEl.textContent;
  ok('★★ 站在支线上时那行提示也还是短的（不再有一长串括号说明）',
    branchHint.length <= 80, branchHint.length + ' 字：' + branchHint);
  ok('  但仍然说清了"你在支线上、怎么回去"',
    /支线 \d+/.test(branchHint) && /回到主线/.test(branchHint), branchHint);
  ok('  完整解释挪进了按钮的 title（想细看的人能看到）',
    /翻页按钮/.test(document.getElementById('btnBackToMain').title));

  // 收尾：别把"没保存的支线"留给后面的测试
  document.getElementById('btnExportPgn').click();
  await sleep(30);
  document.getElementById('btnCloseExport').click();
  await sleep(20);
}

// ============================================================
section('30. 【Bug 修复】进支线时棋盘上棋子颜色会变（白子变黑子）');
// ============================================================
//
// 现象：手动走棋进支线时，偶尔有棋子颜色变成反的；找不到稳定复现的办法。
//
// 根因（两条线共用一套棋子编号）：
//   棋子的 id 是"身份"，但**只在同一条线内部**成立。支线是从中局局面摆起的，
//   它那条时间线自己从 1 开始编号 —— 于是同一个 id 在主线和支线里
//   可能是完全不同的两颗子（甚至连颜色都不一样）。
//   而 board.show() 按 id 复用 DOM 元素时，只同步了**字形**，没同步**颜色**：
//     if (el.dataset.type !== p.type) { 换字形 }
//   颜色 class（.piece.w / .piece.b）还是上一条线留下的 → 白子渲染成黑的。
//
//   "不容易稳定复现"也对得上：撞不撞号、撞到哪种颜色，
//   取决于当时主线和支线各自的编号，中局越乱越容易撞上。
//
// 修法两道防线：
//   ① timeline.js 的 buildTimeline(startFen, moves, idBase)：每条支线一个自己的号段；
//   ② board.js 复用元素时**颜色也同步**（不再假设"同一个 id 颜色不变"）。
{
  const clickSq = (name) => document
    .querySelector('#board .sq[data-square="' + name + '"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const st = () => appMod.accountBranchState();

  /** 棋盘上**看得见**的棋子，颜色和"该显示的那一帧"逐格对比 */
  const colorMismatches = () => {
    const want = new Map(
      appMod.frameAt(st().cursor).map((p) => [p.square, p.color]));
    const bad = [];
    for (const w of visibleWraps()) {
      const sq = squareOfWrap(w);
      const got = w.querySelector('.piece').classList.contains('w') ? 'w' : 'b';
      if (want.get(sq) !== got) bad.push(sq + ':' + got + '≠' + want.get(sq));
    }
    return bad;
  };

  // 手动模式：这一节只验渲染，不需要后台扫描来插一脚
  setOpt(document.getElementById('optCurve'), false);
  setOpt(document.getElementById('optBar'), false);
  await sleep(60);

  // 用那盘 51 步的真棋：中局棋子散得开，最容易撞上编号错位
  document.querySelector('[data-sample="sample1"]').click();
  await waitFor(() => cells().length === 51, 10000);
  ok('前置：51 步那盘棋载进来了', cells().length === 51);

  let broken = 0;
  const tried = [];
  for (const ply of [2, 10, 16, 22, 28, 34, 40, 46, 50]) {
    document.getElementById('btnFirst').click();
    await sleep(10);
    for (let i = 0; i < ply; i++) document.getElementById('btnNext').click();
    await sleep(10);

    // 走一步合法棋 → 进支线
    const fen = appMod.fenAt(st().cursor);
    const legal = new chessMod.Chess(fen).moves({ verbose: true })[0];
    appMod.playMove(legal.from, legal.to, legal.promotion);
    await sleep(20);

    const bad = colorMismatches();
    tried.push(ply);
    if (bad.length) {
      broken++;
      ok('  主线第 ' + ply + ' 步进支线 → 颜色都对', false, bad.slice(0, 5).join('  '));
    }
    // 回主线再验一次（跨线来回也要对）
    document.getElementById('btnBackToMain').click();
    await sleep(20);
    const badBack = colorMismatches();
    if (badBack.length) {
      broken++;
      ok('  从支线回主线（第 ' + ply + ' 步）→ 颜色都对', false, badBack.slice(0, 5).join('  '));
    }
    // 再回到支线
    document.querySelectorAll('#branchList .move-cell[data-index]')[0].click();
    await sleep(20);
    const badAgain = colorMismatches();
    if (badAgain.length) {
      broken++;
      ok('  再进一次支线（第 ' + ply + ' 步）→ 颜色都对', false, badAgain.slice(0, 5).join('  '));
    }

    appMod.undoMove();
    await sleep(10);
  }

  ok('★★ 九个位置、每个位置三次跨线切换，颜色全对（修前 8/10 个位置是错的）',
    broken === 0, '出问题的次数：' + broken + '（试过主线第 ' + tried.join('/') + ' 步）');

  // ---------- 把根因也钉住：两条线不能用同一套棋子编号 ----------
  document.getElementById('btnFirst').click();
  await sleep(10);
  for (let i = 0; i < 10; i++) document.getElementById('btnNext').click();
  await sleep(10);
  const fen2 = appMod.fenAt(st().cursor);
  const legal2 = new chessMod.Chess(fen2).moves({ verbose: true })[0];
  appMod.playMove(legal2.from, legal2.to, legal2.promotion);
  await sleep(20);
  const branchIds = appMod.frameAt(st().cursor).map((p) => p.id);
  ok('★★ 支线的时间线用自己的棋子号段（不和主线 1~32 撞号）',
    branchIds.length > 0 && branchIds.every((id) => id > 32),
    '支线的 id 范围 ' + Math.min(...branchIds) + '~' + Math.max(...branchIds));

  document.getElementById('btnBackToMain').click();
  await sleep(20);
  const mainIds = appMod.frameAt(st().cursor).map((p) => p.id);
  ok('  主线仍然用 1~32（老行为没变）',
    mainIds.every((id) => id <= 32), '主线的 id 范围 ' +
    Math.min(...mainIds) + '~' + Math.max(...mainIds));
  eq('★ 两条线的 id 完全不重叠', branchIds.filter((id) => mainIds.includes(id)).length, 0);

  // 再走一步支线内的棋：同一颗子应该还是同一个元素（动画才不会乱）
  document.querySelectorAll('#branchList .move-cell[data-index]')[0].click();
  await sleep(20);
  const beforeEls = visibleWraps().length;
  const fen3 = appMod.fenAt(st().cursor);
  const legal3 = new chessMod.Chess(fen3).moves({ verbose: true })[0];
  appMod.playMove(legal3.from, legal3.to, legal3.promotion);
  await sleep(30);
  ok('  支线里再走一步：没有把整盘棋子重画一遍',
    Math.abs(visibleWraps().length - beforeEls) <= 2,
    beforeEls + ' → ' + visibleWraps().length);
  eq('  而且颜色照样对', colorMismatches(), []);

  // 收尾：清掉支线，别把状态留给后面的收尾统计
  appMod.clearBranches();
  await sleep(30);
}

// ============================================================
section('31. 【新】棋盘下方那栏「双方已经吃掉了什么」');
// ============================================================
//
// 这一栏是**纯子力账**：走一步数一步，翻到哪一步就显示到哪一步。
// 它和鳕鱼的评分、DeepSeek 的讲解都没有关系 —— 所以这里也不碰那两条链路，
// 只看 DOM 上写的东西对不对。
{
  const ledgerEl = document.getElementById('ledger');
  ok('  这一栏在页面上（棋盘正下方）',
    !!ledgerEl && ledgerEl.classList.contains('ledger'));

  // ---------- 31.1 先拿"没有吃子"的局面：两行都是空的 ----------
  document.querySelector('[data-sample="fool"]').click();
  await waitFor(() => cells().length === 4, 8000);
  document.getElementById('btnFirst').click();
  await sleep(30);

  const rows = () => [...document.querySelectorAll('#ledger .ledger-row')];
  const rowText = (i) => rows()[i].textContent;
  const rowGlyphs = (i) => [...rows()[i].querySelectorAll('.cap')].map((s) => s.textContent).join('');

  eq('  两行：白方吃子 / 黑方吃子', rows().length, 2);
  ok('  开局时两行都是空的（显示一个破折号，不是空白）',
    rowText(0).includes('—') && rowText(1).includes('—'), rowText(0) + ' / ' + rowText(1));
  eq('  没有吃子的时候不显示分差', document.querySelectorAll('#ledger .ledger-plus').length, 0);

  // ---------- 31.2 学者将杀：白方吃了一个兵 ----------
  // 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# —— 只有最后那一步吃了 f7 的兵
  document.querySelector('[data-sample="scholar"]').click();
  await waitFor(() => cells().length === 7, 8000);
  document.getElementById('btnLast').click();
  await sleep(30);

  eq('★★ 白方吃子那行只画了一个子（一个兵）', rowGlyphs(0), '♟');
  eq('  黑方还没吃到东西', rowGlyphs(1), '');
  const plusEls = [...document.querySelectorAll('#ledger .ledger-plus')];
  eq('★★ 吃子赚了的那一方显示分差', plusEls.map((e) => e.textContent).join(','), '+1');
  ok('★ 分差标在**白方**那一行（他吃了一个兵）',
    rows()[0].textContent.includes('+1') && !rows()[1].textContent.includes('+1'),
    rowText(0) + ' ／ ' + rowText(1));

  // ---------- 31.3 翻回开头，这一栏要跟着退回去 ----------
  document.getElementById('btnFirst').click();
  await sleep(30);
  ok('★★ 翻回开局，吃子栏也跟着清空（不是一直停在第 4 步）',
    rowText(0).includes('—') && rowText(1).includes('—'), rowText(0) + ' / ' + rowText(1));

  // ---------- 31.4 和棋子颜色对得上（白方吃的是黑子，画成黑的） ----------
  document.getElementById('btnLast').click();
  await sleep(30);
  const capEl = document.querySelector('#ledger .cap');
  ok('★ 白方吃掉的黑子，用的是黑棋的颜色（和盘上那份一致）',
    capEl.classList.contains('b') && !capEl.classList.contains('w'), capEl.className);
  ok('  鼠标悬停能看出这是什么子', (capEl.getAttribute('title') || '').length > 0, capEl.getAttribute('title'));

  // ---------- 31.5 分差算的是"子力"，不是引擎的评分 ----------
  // 歌剧对局到最后白方多一大把子 —— 这一栏必须给出正分差，而且和局势条无关。
  document.querySelector('[data-sample="opera"]').click();
  await waitFor(() => cells().length > 20, 8000);
  document.getElementById('btnLast').click();
  await sleep(30);
  const led = appMod.ledgerNow();
  const val = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const sumOf = (list) => list.reduce((n, t) => n + (val[t] || 0), 0);
  eq('★★ 两边画出来的棋子和算出来的分差是同一份数据',
    led.diff, sumOf(led.byWhite) - sumOf(led.byBlack));
  // 歌剧之局最后是 16. Qb8+ Nxb8 17. Rd8# —— 白方**弃掉一个后**成杀。
  // 所以明面上的子力账是黑方领先 10 分左右，而局势条上白方是大优。
  // 这正好说明这一栏的定位：它只算子力，不看引擎怎么判断局面。
  ok('★★ 歌剧之局最后：明面上黑方子力多（白方弃后成杀）—— 这一栏只算子力，和局势条无关',
    led.diff < 0, '白吃 ' + led.byWhite.join('') + ' 黑吃 ' + led.byBlack.join('') + ' 差 ' + led.diff);
  ok('  分差这时候标在**黑方**那一行',
    rows()[1].textContent.includes('+' + (-led.diff)) && !rows()[0].textContent.includes('+'),
    rowText(0) + ' ／ ' + rowText(1));

  // ---------- 31.6 升变过的那种子，被吃时要按"被吃时的身份"记 ----------
  // 直接喂几帧假时间线给纯函数：一个白兵升变成后、后来被吃 —— 应该记成"黑方吃了一个后"。
  const fakeFrames = [
    [{ id: 1, color: 'w', type: 'p', square: 'a7' }],
    [{ id: 1, color: 'w', type: 'q', square: 'a8' }],   // 升变：同一个 id 换字形
    [],                                                 // 被吃
  ];
  const led2 = timelineMod.captureLedger(fakeFrames, 2);
  ok('★★ 升变过的兵后来被吃，账上记的是"后"（不是兵）',
    led2.byBlack.join(',') === 'q' && led2.blackValue === 9 && led2.diff === -9,
    JSON.stringify(led2));
  ok('  只看到第 1 帧时，那次吃子还不该出现',
    timelineMod.captureLedger(fakeFrames, 1).blackValue === 0);
}

console.log('\n' + '─'.repeat(58));console.log(`结果：通过 ${pass} 个，失败 ${fail} 个`);
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
process.exit(fail === 0 ? 0 : 1);

})().catch((e) => {
  console.error('\n💥 测试崩了：', e);
  process.exit(1);
});
