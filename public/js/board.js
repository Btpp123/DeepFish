// ============================================================
// board.js —— 棋盘
//
// 【和最早那版最大的区别：棋子不再"删掉重画"】
//
// 最早每次刷新都是 container.innerHTML = ''，把 64 格和 32 个棋子全扔掉重画。
// 那样棋子是"闪"一下换位置，浏览器无从知道"这个兵就是那个兵"，
// 也就没法做补间动画。
//
// 现在分三层，而且**只建一次，之后只改属性**：
//
//   .board
//     ├── .board-squares  64 个格子 + 边缘坐标
//     ├── .board-pieces   棋子（永不重建，只改 transform）
//     └── .board-arrows   箭头层
//
// 棋子用「绝对定位 + transform: translate」移动。
// 关键技巧：棋子自身宽高是棋盘的 12.5%，所以 translate 里的百分比
// 正好是一格 —— 移到第 3 列就是 translate(300%, ...)，不用去算像素。
// 有了 transform 和 CSS transition，浏览器自己就把它补成滑动。
//
// 【翻转棋盘】
// setFlipped(true) 之后黑方在屏幕下方。做法不是把整个棋盘转 180°
// （那样棋子和坐标标签会跟着倒过来，很难看），而是把「格子 → 屏幕位置」
// 这层映射镜像一下：屏幕第 row 行对应哪一格，反过来推一遍。
// ============================================================

import { drawArrows } from './arrows.js';
import { squareToRowCol } from './timeline.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILES = 'abcdefgh';

// 棋子的字形。♟♞♝♜♛♚ 是「实心」的字形，
// 白棋黑棋都用它，靠 CSS 改颜色来区分，比空心的好看。
// （吃掉的那一栏也用同一份字形，所以导出出去 —— 别在两处各写一份，改字体时会漏。）
export const PIECE_GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const GLYPH = PIECE_GLYPH;

/**
 * 反函数：屏幕上的第 row 行、第 col 列，是哪一格？
 * squareToRowCol 的反向推导，翻转的时候两边一起镜像就抵消了。
 */
function rowColToSquare(row, col, flipped) {
  if (flipped) { row = 7 - row; col = 7 - col; }
  return FILES[col] + (8 - row);
}

/**
 * 建一个棋盘控制器
 * @param {HTMLElement} container
 * @returns {{show:Function, reset:Function, setFlipped:Function, isFlipped:Function, debug:Function, squares:Map}}
 */
export function createBoard(container) {
  container.classList.add('board');
  container.innerHTML = '';

  const squaresLayer = document.createElement('div');
  squaresLayer.className = 'board-squares';

  const piecesLayer = document.createElement('div');
  piecesLayer.className = 'board-pieces';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'board-arrows');

  container.append(squaresLayer, piecesLayer, svg);

  const squareEls = new Map(); // 格子名 → 那个 div
  const pieceEls = new Map();  // 棋子 id → 那个 wrap

  let flipped = false;         // 黑方在下面吗？
  let lastPieces = [];         // 最近一次显示的棋子（翻转时要重排它们）
  let lastOpts = { animate: false, from: null, to: null, arrows: [] };

  // ---------- 格子：只建一次（翻转时才重建） ----------
  function buildSquares() {
    while (squaresLayer.firstChild) squaresLayer.removeChild(squaresLayer.firstChild);
    squareEls.clear();

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const square = rowColToSquare(row, col, flipped);

        // a8 是浅色。找到这一格的「真实坐标」再判断颜色，
        // 这样翻不翻转，每格的颜色都一样。
        const realCol = FILES.indexOf(square[0]);
        const realRow = 8 - Number(square[1]);

        const div = document.createElement('div');
        div.className = 'sq ' + ((realRow + realCol) % 2 === 0 ? 'light' : 'dark');
        div.dataset.square = square;

        // 边缘坐标。哪一边是「列」、哪一边是「行」，看的是屏幕位置，
        // 内容则跟着格子走 —— 所以翻过来之后会自动变成 h~a、8~1，不用特意写。
        if (col === 0) {
          const label = document.createElement('span');
          label.className = 'coord coord-rank';
          label.textContent = square[1];
          div.appendChild(label);
        }
        if (row === 7) {
          const label = document.createElement('span');
          label.className = 'coord coord-file';
          label.textContent = square[0];
          div.appendChild(label);
        }

        squaresLayer.appendChild(div);
        squareEls.set(square, div);
      }
    }
  }

  buildSquares();

  // ---------- 动画开关 ----------
  // 跨多步跳转、或者翻棋盘时不希望棋子满盘乱飞，那就把过渡关掉。
  //
  // 【这里踩过一个坑，值得记下来】
  // 最初写的是"关掉 → 过一会儿用 setTimeout 再打开"。结果留下一个
  // 十几毫秒的窗口：用户在这个窗口里又点了一步，那一步就不会动。
  // 测试里"点开局 → 立刻点下一步"正好撞上，才暴露出来。
  //
  // 改成完全同步：每次 show 开始时，按需要把开关调到正确状态，
  // 并且强制回流一次，让浏览器先把上一次的位移"结算"掉。
  // 这样这次的过渡一定是从「现在这个位置」开始，不依赖任何定时器。
  function setLayerAnimation(enabled) {
    const isOff = piecesLayer.classList.contains('no-anim');
    if (enabled && isOff) {
      piecesLayer.classList.remove('no-anim');
      void piecesLayer.offsetWidth;   // 结算掉"关闭期间"发生的位移
    } else if (!enabled && !isOff) {
      piecesLayer.classList.add('no-anim');
      void piecesLayer.offsetWidth;   // 先把"关掉动画"这个状态落实
    }
  }

  // ---------- 造一个棋子 ----------
  function createPieceEl(p) {
    const wrap = document.createElement('div');
    wrap.className = 'piece-wrap';
    wrap.dataset.type = p.type;
    wrap.dataset.color = p.color;
    wrap.dataset.square = p.square;

    const span = document.createElement('span');
    span.className = 'piece ' + p.color;
    span.textContent = GLYPH[p.type];
    wrap.appendChild(span);

    // 先摆好位置再插进文档，浏览器会把"出生位置"当成初始样式，
    // 于是它不会从 (0,0) 滑过来。
    place(wrap, p.square);
    return wrap;
  }

  function place(wrap, square) {
    const { row, col } = squareToRowCol(square, flipped);
    // 百分比是相对棋子自身尺寸的，而棋子恰好是棋盘的一格宽，
    // 所以 col=3 就写 300%，正好移三格。
    wrap.style.transform = 'translate(' + (col * 100) + '%, ' + (row * 100) + '%)';
  }

  // ---------- 对外：显示某一帧 ----------
  /**
   * @param {Array<{id:number,color:string,type:string,square:string}>} pieces 要显示的棋子
   * @param {object} [opts]
   * @param {boolean} [opts.animate]   是否做滑动动画
   * @param {string}  [opts.from]      高亮起点
   * @param {string}  [opts.to]        高亮终点
   * @param {Array}   [opts.arrows]    要画的箭头
   */
  function show(pieces, opts = {}) {
    const { animate = false, from = null, to = null, arrows = [] } = opts;

    lastPieces = pieces;
    lastOpts = { animate, from, to, arrows };

    // 棋盘刚翻过的话，即使格子的「名字」没变，屏幕坐标也全变了，
    // 所以要把每个棋子都重新摆一遍。
    const flipChanged = piecesLayer.dataset.flipped !== String(flipped);
    piecesLayer.dataset.flipped = String(flipped);

    // ---- 1. 高亮（改 class，不重建）----
    for (const el of squareEls.values()) el.classList.remove('hl-from', 'hl-to');
    if (from && squareEls.has(from)) squareEls.get(from).classList.add('hl-from');
    if (to && squareEls.has(to)) squareEls.get(to).classList.add('hl-to');

    // ---- 2. 棋子 ----
    setLayerAnimation(animate);

    const wanted = new Set();
    for (const p of pieces) {
      wanted.add(p.id);

      let el = pieceEls.get(p.id);
      let isNew = false;
      if (!el) {
        el = createPieceEl(p);
        pieceEls.set(p.id, el);
        piecesLayer.appendChild(el);
        isNew = true;
      }

      const prevSquare = el.dataset.square;
      const moved = !isNew && prevSquare !== p.square;

      // 只有真的换了格子（或者棋盘翻了）才去改 transform。
      // 没动过的棋子绝对不碰它的 style —— 碰了就会触发一次多余的过渡。
      if (moved || isNew || flipChanged) place(el, p.square);

      el.dataset.square = p.square;

      // 升变：同一个棋子换字形（不是换一个棋子）
      if (el.dataset.type !== p.type) {
        el.firstChild.textContent = GLYPH[p.type];
        el.dataset.type = p.type;
      }

      // ⚠️ 颜色也要同步，别只同步字形（这里踩过一个真 bug）。
      //
      // 棋子的 id 是"身份"，但身份只在**同一条线内部**成立：
      // 支线是从某个中局局面摆起的，它那条时间线自己从头编号，
      // 与主线撞号时，同一个 id 可能从"黑车"变成"白兵"。
      // 元素被复用、却只改了字形不改颜色 —— 于是棋盘上会出现
      // **白子变黑子 / 黑子变白子**（.piece.w 是白色描边、.piece.b 是深色）。
      // 症状是"偶尔颜色变了、还不容易复现"，正是这个原因：
      // 撞不撞、撞到哪种颜色，取决于当时那两条线各自的编号。
      //
      // 两条防线都留着：
      //   ① 这里：同一个元素被复用时，颜色跟着走（不管 id 是谁的）；
      //   ② timeline.js 的 idBase：每条线有自己的号段，从根上不撞号。
      if (el.dataset.color !== p.color) {
        el.firstChild.className = 'piece ' + p.color;
        el.dataset.color = p.color;
      }

      // 被吃掉的棋子会带着 gone 退场，这里要让它回来（往后翻的时候）
      el.classList.remove('gone');

      // 正在移动的棋子抬到最上层，免得被别的棋子压住
      el.style.zIndex = moved ? '5' : '';
    }

    // 这一帧里没有的棋子 → 退场（淡出缩小，不是"啪"一下没）
    for (const [id, el] of pieceEls) {
      if (!wanted.has(id)) el.classList.add('gone');
    }

    // ---- 3. 箭头 ----
    drawArrows(svg, arrows, { flipped });
  }

  /** 换一盘棋的时候用：把所有棋子清掉（因为 id 会从头开始编号） */
  function reset() {
    piecesLayer.querySelectorAll('.piece-wrap').forEach((el) => el.remove());
    pieceEls.clear();
  }

  /**
   * 翻转棋盘。
   * 不做动画 —— 翻棋盘时棋子"飞过半个屏幕"会很晕，
   * 而且方向感是瞬间建立的，本来也不需要过渡。
   */
  function setFlipped(value) {
    const next = !!value;
    if (next === flipped) return false;
    flipped = next;

    buildSquares();                                        // 格子换向（连带坐标标签）
    show(lastPieces, Object.assign({}, lastOpts, { animate: false })); // 棋子重排 + 重画箭头
    return true;
  }

  /** 只用来给测试和调试看的 */
  function debug() {
    return {
      flipped,
      pieceCount: piecesLayer.querySelectorAll('.piece-wrap:not(.gone)').length,
      totalEls: pieceEls.size,
      moving: [...pieceEls.entries()]
        .filter(([, el]) => el.style.zIndex === '5')
        .map(([id]) => id),
    };
  }

  return {
    show,
    reset,
    setFlipped,
    isFlipped: () => flipped,
    debug,
    squares: squareEls,
  };
}
