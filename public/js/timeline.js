// ============================================================
// timeline.js —— 给每个棋子发一张「身份证」，并算出它每一步在哪
//
// 【为什么需要这个文件】
// 想做出"棋子滑过去"的效果，光有每一格的 FEN 是不够的。
// 因为我们只知道「e4 现在有个白兵」，不知道「这个兵就是刚才 e2 那个兵」。
// 没有身份，就没法告诉浏览器"让它从这个坐标动到那个坐标"，
// 只能把棋子删掉再画一个 —— 那就是一闪。
//
// 所以这里的活儿是：
//   从开局开始，一步步走完这盘棋，
//   给每个棋子一个永不改变的 id，记录它每一步站在哪。
//   棋子被吃掉 = 这个 id 退场；升变 = 同一个 id 换了个字形（这才是对的，
//   因为那个兵确实"变成了后"，不是换了个棋子）。
//
// 算出来的结果叫「时间线」：frames[k] 表示第 k-1 步走完之后所有棋子的位置。
//   frames[0]      → 开局（还没走）
//   frames[1]      → 第 1 步走完
//   frames[cursor+1] → 当前这一步
// ============================================================

import { Chess } from './chess.js';

const FILES = 'abcdefgh';

/**
 * 算出整盘棋的时间线
 * @param {string} startFen  起点局面
 * @param {Array}  moves     chess.js 的 history({verbose:true})，每个含 from/to/flags/promotion
 * @param {number} [idBase]  棋子编号从哪个数开始发（默认 0 → 编号 1、2、3…）
 *
 * ⚠️ idBase 是给**支线**用的，别删。
 *    棋子的 id 是"身份"，但它的有效期只在**同一条线内部**：
 *    支线是从某个中局局面摆起的，如果它也老老实实从 1 开始编号，
 *    就会和主线撞号 —— 撞号之后 board.show 会按 id 复用 DOM 元素，
 *    把两条线里完全不同的两颗子当成同一颗（最直接的表现就是**颜色串了**：
 *    白子渲染成黑的）。所以每条线给一个自己的号段，从根上不撞。
 *    主线仍然从 1 开始（idBase = 0），老行为一字不变。
 *
 * @returns {Array<Array<{id:number,color:string,type:string,square:string}>>}
 */
export function buildTimeline(startFen, moves, idBase = 0) {
  const pieces = new Map();  // id → {id, color, type, square}
  const occ = new Map();     // 格子 → id
  let nextId = idBase + 1;

  // ---------- 起始局面：给 32 个棋子发身份证 ----------
  for (const row of new Chess(startFen).board()) {
    for (const cell of row) {
      if (!cell) continue;
      const id = nextId++;
      pieces.set(id, { id, color: cell.color, type: cell.type, square: cell.square });
      occ.set(cell.square, id);
    }
  }

  const frames = [snapshot()];

  for (const mv of moves) {
    applyMove(mv);
    frames.push(snapshot());
  }

  return frames;

  // ---------- 内部函数 ----------

  function snapshot() {
    return [...pieces.values()]
      .filter((p) => p.square)
      .map((p) => ({ id: p.id, color: p.color, type: p.type, square: p.square }));
  }

  function removeAt(square) {
    const id = occ.get(square);
    if (id === undefined) return;
    occ.delete(square);
    const p = pieces.get(id);
    if (p) p.square = null;   // 退场
  }

  function moveFromTo(from, to) {
    const id = occ.get(from);
    if (id === undefined) return;
    occ.delete(from);
    occ.set(to, id);
    const p = pieces.get(id);
    if (p) p.square = to;
  }

  function applyMove(mv) {
    const rank = mv.from[1];                       // 第几横线（易位、吃过路兵都要用）
    const flags = mv.flags || '';

    // 1. 先处理「有东西没了」
    //    目标格上有棋子 → 被吃掉
    removeAt(mv.to);
    //    吃过路兵：被吃的兵不在目标格上，而在目标格的同一横线上（比如 exd6 吃的是 d5 的兵）
    if (flags.includes('e')) removeAt(mv.to[0] + rank);

    // 2. 走棋（同一个 id 挪过去，这就是"身份证"的意义）
    moveFromTo(mv.from, mv.to);

    // 3. 升变：同一个 id 换字形
    if (flags.includes('p') && mv.promotion) {
      const id = occ.get(mv.to);
      const p = id !== undefined ? pieces.get(id) : null;
      if (p) p.type = mv.promotion;
    }

    // 4. 易位：王走了，车也得跟着走（这是最难做对的一处）
    if (flags.includes('k')) moveFromTo('h' + rank, 'f' + rank);  // 短易位：h → f
    if (flags.includes('q')) moveFromTo('a' + rank, 'd' + rank);  // 长易位：a → d
  }
}

/**
 * 自检：算出来的每一帧，是不是真的和引擎给的 FEN 一模一样？
 *
 * 这个检查非常值钱 —— 易位、吃过路兵、升变这三处只要有一处算错，
 * 动画就会把棋子送到错误的格子上，而且看起来"还挺顺滑"，极难发现。
 * 所以每次载入棋谱都跑一遍，对不上就自动关掉动画（宁可不动，不可动错）。
 *
 * @returns {{ok:boolean, issues:string[]}}
 */
export function verifyTimeline(frames, startFen, moves) {
  const issues = [];

  const compare = (plyLabel, frame, fen) => {
    const board = new Chess(fen).board();
    const expected = new Map(); // 格子 → "白兵" 这样的描述
    for (const row of board) {
      for (const cell of row) {
        if (cell) expected.set(cell.square, cell.color + cell.type);
      }
    }
    const actual = new Map();
    for (const p of frame) actual.set(p.square, p.color + p.type);

    if (expected.size !== actual.size) {
      issues.push(plyLabel + '：棋子个数对不上（应为 ' + expected.size + '，实为 ' + actual.size + '）');
      return;
    }
    for (const [sq, desc] of expected) {
      if (actual.get(sq) !== desc) {
        issues.push(plyLabel + '：' + sq + ' 应该是 ' + desc + '，实际是 ' + (actual.get(sq) || '空的'));
      }
    }
    // 一帧里不能有两个棋子站在同一格
    if (actual.size !== frame.length) {
      issues.push(plyLabel + '：有棋子重叠在同一格上');
    }
  };

  compare('开局', frames[0], startFen);
  for (let i = 0; i < moves.length; i++) {
    compare('第 ' + (i + 1) + ' 步（' + moves[i].san + '）', frames[i + 1], moves[i].after);
  }

  return { ok: issues.length === 0, issues: issues.slice(0, 5) };
}

/**
 * 格子在棋盘上的行列（0,0 是屏幕左上角那一格）
 *
 * @param {string} square  比如 'e4'
 * @param {boolean} [flipped]  棋盘是不是翻过来了（黑方在屏幕下方）
 *
 * 不翻的时候左上角是 a8；翻过来之后左上角变成 h1，
 * 行列都镜像一下就行 —— 一个 8×8 的方阵，转 180° 就是 (col,row) → (7-col,7-row)。
 */
export function squareToRowCol(square, flipped = false) {
  const col = FILES.indexOf(square[0]);
  const row = 8 - Number(square[1]);
  if (!flipped) return { col, row };
  return { col: 7 - col, row: 7 - row };
}

/** 兵 1、马/象 3、车 5、后 9 —— 只用来算"吃子谁赚了"，和引擎的评分完全无关 */
export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/**
 * 「双方各吃掉了对方什么」—— 纯子力账，一眼能看明白的那种。
 *
 * 【为什么不用 FEN 数棋子】
 * 升变会让棋子"凭空多出来"：白兵到底线变成后，棋盘上就多了一个 9 分的子。
 * 如果按"少了什么"去数，那个兵还在，什么也看不出来；按"多了什么"去数又会把它算成
 * 对方丢的子。所以这里走的是**身份**那条线（时间线里的 id）：
 *   一个 id 从某一帧开始不见了 = 它被吃了，而且**被吃时是什么子**就从上一帧读。
 * 于是"升变过的兵后来被吃"也能记成"一个后"，账不会错。
 *
 * ⚠️ 这个函数和鳕鱼、DeepSeek 都没有关系 —— 它只是把棋盘上发生过的事记下来。
 *
 * @param {Array<Array<{id:number,color:string,type:string}>>} frames buildTimeline 的结果
 * @param {number} index  看到第几步（frames[index]，0 = 开局）
 * @returns {{byWhite:Array<string>, byBlack:Array<string>, whiteValue:number, blackValue:number, diff:number}}
 *   byWhite = **白方吃掉的子**（也就是黑方丢的子）；diff > 0 表示白方吃子赚了 diff 分
 */
export function captureLedger(frames, index) {
  const upto = Math.min(Math.max(Number(index) || 0, 0), (frames ? frames.length : 1) - 1);
  const byWhite = [];
  const byBlack = [];

  const lost = (frame, next) => {
    const alive = new Set((next || []).map((p) => p.id));
    const out = [];
    for (const p of (frame || [])) {
      if (alive.has(p.id)) continue;
      out.push({ color: p.color, type: p.type });   // 被吃时是什么子，以**上一帧**为准
    }
    return out;
  };

  for (let k = 0; k < upto; k++) {
    for (const p of lost(frames[k], frames[k + 1])) {
      (p.color === 'b' ? byWhite : byBlack).push(p.type);
    }
  }

  // 排一下：值钱的放前面（后、车、象、马、兵），一眼看得出吃了什么大子
  const order = { q: 0, r: 1, b: 2, n: 3, p: 4, k: 5 };
  const sortFn = (a, b) => (order[a] ?? 9) - (order[b] ?? 9);
  byWhite.sort(sortFn);
  byBlack.sort(sortFn);

  const sum = (list) => list.reduce((n, t) => n + (PIECE_VALUE[t] || 0), 0);
  const whiteValue = sum(byWhite);
  const blackValue = sum(byBlack);

  return { byWhite, byBlack, whiteValue, blackValue, diff: whiteValue - blackValue };
}
