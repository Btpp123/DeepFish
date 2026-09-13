// ============================================================
// pgn.js —— 棋谱解析（专治带评注的 PGN）
//
// 【为什么需要自己写一层】
//
// chess.js 的 loadPgn 很好用，但它在"一个着法后面跟了两个连续评注"时会直接报错：
//
//     1. d4 { a } d5          ✅ 能解析
//     1. d4 { a } { b } d5    ❌ Expected end of input ... but "{" found
//
// 而 lichess 导出的棋谱**每一处判评都是这种双注释**：
//   { (-0.50 → 0.35) Inaccuracy. Qxa6 was best. }   ← 讲质量
//   { [%eval 0.35] [%clk 0:14:29] }                 ← 讲引擎分和时钟
//
// 一盘棋里二十多处，所以整篇必挂。
//
// 【所以这里的活儿分两件】
//   1. 把评注/变着/NAG 从正文里挑出来，拼一份干净的正文喂给 chess.js
//      （注意是"挑出来"而不是"扔掉" —— 评注里带着 lichess 的引擎评分，
//        那是白送的分析数据，扔掉太可惜）
//   2. 把挑出来的评注整理成结构化数据，和每一步一一对应
//
// 我们只走主线：圆括号里的变着分支整段丢弃。
// ============================================================

import { Chess, DEFAULT_POSITION } from './chess.js';

// ---------- 第一步：把头部和正文分开 ----------
export function splitPgn(text) {
  const lines = String(text || '').split(/\r?\n/);
  const headerLines = [];
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;              // 头部之间的空行不算正文开始
    if (/^\[/.test(line)) { headerLines.push(line); continue; }
    break;                                   // 遇到第一行非头部，正文从这里开始
  }

  return {
    headerBlock: headerLines.join('\n'),
    movetext: lines.slice(i).join('\n'),
  };
}

/** 从头部里读 [Tag "Value"] */
export function parseHeaders(headerBlock) {
  const headers = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = re.exec(headerBlock))) headers[m[1]] = m[2];
  return headers;
}

// ============================================================
// 第二步：扫正文，一边产出「干净正文」，一边产出「评注表」
// ============================================================
export function scanMovetext(movetext) {
  const kept = [];                // 留给 chess.js 的文本片段
  const annotations = [];         // 与主线着法一一对应
  const preamble = [];            // 出现在第一步之前的评注（很少见）
  let moveCount = 0;
  let variationDepth = 0;         // 圆括号嵌套层数
  let i = 0;
  let strippedComments = 0;
  let droppedVariations = 0;
  let nags = 0;
  // 棋谱自己写的胜负标记：1-0 / 0-1 / 1/2-1/2 / *（=不知道）
  // 它非记不可 —— "黑方认输"这种结局，棋盘上根本看不出来，只有这里有。
  let result = null;

  const n = movetext.length;

  function slot() {
    while (annotations.length < moveCount) annotations.push(makeAnnotation());
    return annotations[moveCount - 1];
  }

  function readUntil(stopChars) {
    // 读到 stopChars 里任意一个字符为止（不含）
    let j = i;
    while (j < n && stopChars.indexOf(movetext[j]) < 0) j++;
    return j;
  }

  while (i < n) {
    const ch = movetext[i];

    // ---------- 花括号评注 ----------
    if (ch === '{') {
      const end = movetext.indexOf('}', i + 1);
      const body = movetext.slice(i + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
      strippedComments++;
      if (variationDepth === 0) {
        if (moveCount > 0) mergeComment(slot(), body);
        else preamble.push(body.trim());
      }
      continue;
    }

    // ---------- 分号行注释 ----------
    if (ch === ';') {
      let end = movetext.indexOf('\n', i);
      if (end < 0) end = n;
      const body = movetext.slice(i + 1, end);
      i = end + 1;
      strippedComments++;
      if (variationDepth === 0 && moveCount > 0) mergeComment(slot(), body);
      continue;
    }

    // ---------- 变着的开始 / 结束 ----------
    if (ch === '(') { variationDepth++; i++; continue; }
    if (ch === ')') { if (variationDepth > 0) variationDepth--; i++; continue; }

    // ---------- 以 % 开头的整行转义（PGN 规范里的"给程序看的一行"）----------
    if (ch === '%' && (i === 0 || movetext[i - 1] === '\n')) {
      let end = movetext.indexOf('\n', i);
      if (end < 0) end = n;
      i = end + 1;
      continue;
    }

    // ---------- 空白 ----------
    if (/\s/.test(ch)) { i++; continue; }

    // ---------- 取一个"词" ----------
    const j = readUntil(' \t\r\n{}();');
    const word = movetext.slice(i, j);
    i = j;

    // 变着里的东西一律丢掉（包括里面的评注和着法）
    if (variationDepth > 0) { droppedVariations++; continue; }

    // NAG，比如 $1 $2
    if (/^\$\d+$/.test(word)) { nags++; continue; }

    // 结果标记。
    // 它有两个用处：① 送进干净正文，chess.js 要靠它认这盘棋结束了；
    //               ② 我们自己留一份 —— 认输 / 协议和棋在棋盘上没有任何痕迹，
    //                  只有这个标记说得清谁赢了。以前这里只做①，
    //                  于是"1. e4 e5 2. Nf3 Nc6 1-0"会被显示成"这盘棋还没下完"。
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(word)) {
      kept.push(word);
      result = word;              // 取最后一个：正文末尾那个才是真的
      continue;
    }

    // 着法编号，单独出现：1.  1...  26.
    if (/^\d+\.+$/.test(word)) { kept.push(word); continue; }

    // 编号和着法粘在一起：26.Ra8+  1...d5
    const glued = /^(\d+\.+)(.+)$/.exec(word);
    if (glued) {
      kept.push(glued[1]);
      addMove(glued[2]);
      continue;
    }

    addMove(word);
  }

  function addMove(rawToken) {
    // 把动手后缀（?! ?? ! ?）从着法上切下来
    const m = /^(.*?)([!?]+)$/.exec(rawToken);
    const san = m ? m[1] : rawToken;
    const suffix = m ? m[2] : '';

    // 万一遇到一个孤零零的 "?"（着法和后缀之间被空格分开了），
    // 那它算不上一个着法，别把它当成一步
    if (!san) {
      if (moveCount > 0) {
        const s = slot();
        if (!s.suffix) { s.suffix = suffix; s.quality = s.quality || qualityFromSuffix(suffix); }
      }
      return;
    }

    moveCount++;
    kept.push(san);
    if (suffix) {
      const s = slot();
      s.suffix = suffix;
      if (!s.quality) s.quality = qualityFromSuffix(suffix);
    }
  }

  // ⚠️ 这里必须补齐！
  // slot() 是"用到才建"的，所以没评注的着法根本不占位 ——
  // 结果 annotations.length 只等于「最后一条有评注的着法序号 + 1」，
  // 而不是总步数。后面那道"数量对不对得上"的自检就会误判成错位，
  // 把整盘评注白白丢掉。
  // （这个坑在 lichess 那盘棋上刚好藏住了：它每一步都有评注，所以没有尾巴。）
  while (annotations.length < moveCount) annotations.push(makeAnnotation());

  return {
    movetext: kept.join(' '),
    annotations,
    preamble,
    result,
    // 不管有没有评注，annotations 现在一定和主线着法一一对应、长度相等
    stats: { strippedComments, droppedVariations, nags, moveTokens: moveCount },
  };
}

function makeAnnotation() {
  return {
    evalCp: null,       // 白方视角的兵值（lichess 的 [%eval] 就是白方视角）
    evalMate: null,     // 白方视角的 N 步将杀
    clk: null,          // 剩余时间，形如 "0:14:29"
    suffix: null,       // ?! ?? 这类动手后缀
    quality: null,      // blunder / mistake / inaccuracy / good / brilliant / interesting
    comment: null,      // 评注原文（去掉 [%…] 标记后）
    bestMove: null,     // 从"Qxa6 was best."里抠出来的推荐着法
    evalBefore: null,   // 从"(0.35 → -1.16)"里抠出来的变化前

    // 计算属性，渲染时用
    get has() { return this.evalCp !== null || this.evalMate !== null || this.clk || this.comment; },
  };
}

/** 把一条评注合并进某一步的记录里（一步可能挂着两条评注） */
function mergeComment(ann, body) {
  if (!body) return;
  let rest = body;

  // [%eval 0.15] / [%eval #2] / [%eval #-3]
  const ev = /\[%eval\s+(#[+-]?\d+|[+-]?\d+(?:\.\d+)?)\s*\]/.exec(rest);
  if (ev) {
    const v = ev[1];
    if (v[0] === '#') ann.evalMate = Number(v.slice(1));
    else ann.evalCp = Number(v);
    rest = rest.replace(ev[0], ' ');
  }

  // [%clk 0:15:00]
  const ck = /\[%clk\s+([\d:.]+)\s*\]/.exec(rest);
  if (ck) {
    ann.clk = ck[1];
    rest = rest.replace(ck[0], ' ');
  }

  // 其它 [%xxx ...] 标记一律丢掉（比如 [%emt]）
  rest = rest.replace(/\[%\w+[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!rest) return;

  ann.comment = ann.comment ? ann.comment + ' ' + rest : rest;

  // "Qxa6 was best." → Qxa6
  if (!ann.bestMove) {
    const best = /([A-Za-z][A-Za-z0-9]*(?:=[QRBN])?[+#]?)\s+was best/.exec(rest);
    if (best) ann.bestMove = best[1];
  }

  // "(0.35 → -1.16)" 里的变化前数值
  if (ann.evalBefore === null) {
    const arrow = /\(([+-]?\d+\.?\d*)\s*→\s*([+-]?\d+\.?\d*)\)/.exec(rest);
    if (arrow) ann.evalBefore = Number(arrow[1]);
  }

  // 评注文字里的质量判断（只在后缀没给判断时用）
  if (!ann.quality) {
    const q = /(Blunder|Mistake|Inaccuracy|Best move|Excellent|Good move|Book|Miss|Checkmate is now unavoidable)/i.exec(rest);
    if (q) ann.quality = qualityFromText(q[1]);
  }
}

function qualityFromSuffix(suffix) {
  switch (suffix) {
    case '??': return 'blunder';
    case '?':  return 'mistake';
    case '?!': return 'inaccuracy';
    case '!!': return 'brilliant';
    case '!':  return 'good';
    case '!?': return 'interesting';
    default:   return null;
  }
}

function qualityFromText(text) {
  const t = text.toLowerCase();
  if (t.startsWith('blunder')) return 'blunder';
  if (t.startsWith('mistake')) return 'mistake';
  if (t.startsWith('inaccuracy')) return 'inaccuracy';
  if (t.startsWith('best')) return 'good';
  if (t.startsWith('excellent')) return 'good';
  if (t.startsWith('good')) return 'good';
  if (t.startsWith('book')) return 'book';
  if (t.startsWith('miss')) return 'mistake';
  if (t.startsWith('checkmate')) return 'blunder';
  return null;
}

// ============================================================
// 第三步：总入口
// ============================================================
/**
 * 解析一段 PGN（支持带评注的 lichess / chess.com 导出）
 * @returns {{ok:boolean, error?:string, moves?:Array, annotations?:Array, headers?:object,
 *            startFen?:string, result?:string, stats?:object, warnings?:string[]}}
 *   result 是棋谱自己写的胜负标记：'1-0' | '0-1' | '1/2-1/2' | '*'（'*' = 没写/没下完）
 */
export function parsePgn(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: '棋谱是空的' };

  const warnings = [];
  const { headerBlock, movetext } = splitPgn(raw);
  const headers = parseHeaders(headerBlock);

  // 有些棋谱不是从开局开始的，头部会写 [FEN "..."]
  let startFen = headers.FEN || DEFAULT_POSITION;

  // ---------- 先试「洗净后的正文」----------
  const scan = scanMovetext(movetext);

  // 有 [FEN] 就得补一个 [SetUp "1"]，否则 chess.js 不认
  let rebuiltHeaders = headerBlock;
  if (headers.FEN && !/\[SetUp\s/i.test(headerBlock)) {
    rebuiltHeaders = headerBlock + '\n[SetUp "1"]';
  }

  let game = tryLoad(rebuiltHeaders ? rebuiltHeaders + '\n\n' + scan.movetext : scan.movetext);

  // ---------- 万一我们洗坏了，退回原文再试一次 ----------
  // 宁可丢掉评注，也不能让一盘本来能读的棋谱读不出来。
  let usedRawFallback = false;
  if (!game) {
    game = tryLoad(raw);
    if (game) {
      usedRawFallback = true;
      warnings.push('清洗后的正文没能解析成功，已退回原文（这一步拿不到评注）');
    }
  }

  if (!game) {
    return { ok: false, error: lastError || '这段棋谱看不懂' };
  }

  const moves = game.history({ verbose: true });
  if (!moves.length) return { ok: false, error: '没能从这段文字里读出任何着法' };

  // 开局局面用第一步的「走之前」，它一定和着法链自洽
  if (moves[0] && moves[0].before) startFen = moves[0].before;

  // ---------- 把评注对齐到着法上 ----------
  // 自检：我们数出来的主线着法个数，必须和 chess.js 真正走出来的步数一致。
  // 不一致就说明清洗时把某一步弄丢或弄多了，那评注就会张冠李戴 ——
  // 张冠李戴比没有评注更糟，所以宁可全丢掉。
  let annotations = scan.annotations;
  const tokenMoves = scan.stats.moveTokens;

  if (tokenMoves !== moves.length) {
    warnings.push('清洗后数出 ' + tokenMoves + ' 步，但实际走出了 ' + moves.length +
                  ' 步，对不上，为避免评注张冠李戴，本次不显示评注');
    annotations = moves.map(() => makeAnnotation());
  }

  // 补齐长度（退回原文解析时这里一定用得上）
  while (annotations.length < moves.length) annotations.push(makeAnnotation());

  const stats = {
    ...scan.stats,
    moves: moves.length,
    annotated: annotations.filter((a) => a && (a.evalCp !== null || a.evalMate !== null ||
                                               a.quality || a.clk)).length,
    blunders: annotations.filter((a) => a && a.quality === 'blunder').length,
    mistakes: annotations.filter((a) => a && a.quality === 'mistake').length,
    inaccuracies: annotations.filter((a) => a && a.quality === 'inaccuracy').length,
    usedRawFallback,
  };

  // ---------- 这盘棋的结果是谁赢的 ----------
  // 两个来源：正文末尾的标记（1-0 / 0-1 / 1/2-1/2），以及头部的 [Result "..."]。
  // 正文那个更贴近实际（头部常常是导出工具的模板，忘了改），所以优先信它。
  // 两个都是 * 就是"不知道"：棋还没下完，或者棋谱压根没写。
  const result = (scan.result && scan.result !== '*') ? scan.result
    : (headers.Result && headers.Result !== '*' ? headers.Result : '*');

  return { ok: true, headers, startFen, moves, annotations, result, stats, warnings };
}

let lastError = '';
function tryLoad(pgnText) {
  const g = new Chess();
  try {
    g.loadPgn(pgnText);
    return g;
  } catch (err) {
    lastError = err.message;
    return null;
  }
}

// ============================================================
// 展示用的小工具
// ============================================================

/** 把评注里的评分说成人话（白方视角，正数=白优） */
export function annotationScoreText(ann) {
  if (!ann) return '';
  if (ann.evalMate !== null && ann.evalMate !== undefined) {
    if (ann.evalMate === 0) return '已经将杀';
    return ann.evalMate > 0 ? '白方 ' + ann.evalMate + ' 步杀' : '黑方 ' + Math.abs(ann.evalMate) + ' 步杀';
  }
  if (ann.evalCp === null || ann.evalCp === undefined) return '';
  const v = ann.evalCp;
  const shown = Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2);
  return (v > 0 ? '+' : '') + shown;
}

/** 评分是偏白还是偏黑，用来上色 */
export function annotationSide(ann) {
  if (!ann) return 'eq';
  if (ann.evalMate !== null && ann.evalMate !== undefined) return ann.evalMate > 0 ? 'w' : 'b';
  if (ann.evalCp === null || ann.evalCp === undefined) return 'eq';
  if (ann.evalCp > 0.8) return 'w';
  if (ann.evalCp < -0.8) return 'b';
  return 'eq';
}

export const QUALITY_LABEL = {
  blunder: '漏着',
  mistake: '错着',
  inaccuracy: '不精确',
  good: '好着',
  brilliant: '妙着',
  interesting: '有意思',
  book: '开局谱着',
};
