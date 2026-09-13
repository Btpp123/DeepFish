// ============================================================
// eval.js —— 评估曲线 与 局势条
//
// 【这个文件解决的核心问题：把「厘兵」翻译成「画面上的高度」】
//
// 鳕鱼给的分数是「厘兵」（cp），100 = 一个兵的优势。这个数字能到 ±3000，
// 但你不可能把 +3000 按比例画成 3000 倍高 —— 那图就没法看了。
//
// 所以要压缩。这里用的是双曲正切：
//
//     norm = tanh(cp / 400)
//
// 效果是：小优势（±100）看得清楚，大优势（±1000）自动压扁，
// 永远不会冲出画面。几个参考值：
//
//     cp =   0  →  0        （均势，曲线压在中线上）
//     cp = 100  →  0.245    （多一个兵）
//     cp = 400  →  0.762    （多一个车左右，已经明显倾斜）
//     cp = 1000 →  0.987    （基本顶格）
//
// 【一个必须守住的约定】
// 正数永远代表「白方占优」——不管现在轮到谁走。
// 这件事在 engine.js 里已经统一翻转过了，这里不再翻转，只做压缩。
// 万一哪天真看反了，整条曲线会上下颠倒，而且看起来还挺像那么回事。
// ============================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 曲线画布的「逻辑高度」。真实像素高度由 CSS 决定，跟这个数字无关。 */
const VIEW_H = 100;

/** 上下各留一点空，免得 +∞ 的线贴着画面边缘 */
const VIEW_PAD = 8;

// ============================================================
// 第一部分：分数的数学
// ============================================================

/**
 * 把引擎分数压到 -1 ~ +1 之间。正数 = 白方占优。
 * @returns {number|null} null 表示「这个局面没有分数」（还没算，或者算不出来）
 */
export function normFromScore(scoreCp, scoreMate) {
  // 将杀是绝对结果，直接顶格，不用参与压缩
  if (scoreMate !== null && scoreMate !== undefined) {
    if (scoreMate === 0) return 0;          // 和棋
    return scoreMate > 0 ? 1 : -1;
  }
  if (scoreCp === null || scoreCp === undefined) return null;
  return Math.tanh(scoreCp / 400);
}

/** 白方占了多少（0 ~ 1）。局势条就是按这个数字填色的。 */
export function whiteFraction(norm) {
  if (norm === null || norm === undefined) return 0.5;
  const clamped = Math.max(-1, Math.min(1, norm));
  return (clamped + 1) / 2;
}

/**
 * 短评分，给窄地方用（比如局势条上）。
 *   +1.3  白方多 1.3 个兵
 *   -0.6  黑方多 0.6 个兵
 *   ±0.0  基本均势
 *   #5    白方 5 步内将杀
 *   #-3   黑方 3 步内将杀
 *   =     和棋
 */
export function compactScore(scoreCp, scoreMate) {
  if (scoreMate !== null && scoreMate !== undefined) {
    if (scoreMate === 0) return '=';
    return '#' + scoreMate;
  }
  if (scoreCp === null || scoreCp === undefined) return '…';

  const pawns = scoreCp / 100;
  const abs = Math.abs(pawns);
  const shown = abs >= 10 ? String(Math.round(abs)) : abs.toFixed(1);
  const sign = pawns > 0.05 ? '+' : pawns < -0.05 ? '-' : '±';
  return sign + shown;
}

/**
 * 终局局面没法交给引擎算（它没有着法可走），但谁赢是确定的，本地判就行。
 * @param {object} game  chess.js 实例
 * @returns {?{scoreCp:?number, scoreMate:?number, scoreText:string}} null 表示还没结束
 */
export function terminalScore(game) {
  if (!game.isGameOver()) return null;

  if (game.isCheckmate()) {
    // 轮到谁走，就是谁被将杀
    const whiteWins = game.turn() === 'b';
    return {
      scoreCp: null,
      // 这里用 ±1 只是表示「白胜 / 黑胜」，不是真的「还有 1 步」。
      // 反正 normFromScore 看到 mate 就顶格，具体数字不影响画面。
      scoreMate: whiteWins ? 1 : -1,
      scoreText: whiteWins ? '白方将杀获胜' : '黑方将杀获胜',
    };
  }
  if (game.isStalemate()) return { scoreCp: 0, scoreMate: null, scoreText: '逼和（和棋）' };
  if (game.isThreefoldRepetition()) return { scoreCp: 0, scoreMate: null, scoreText: '三次重复（和棋）' };
  if (game.isInsufficientMaterial()) return { scoreCp: 0, scoreMate: null, scoreText: '子力不足（和棋）' };
  return { scoreCp: 0, scoreMate: null, scoreText: '和棋（50 回合规则）' };
}

// ============================================================
// 第二部分：局势条（棋盘左边那根竖条）
// ============================================================
/**
 * @param {HTMLElement} container
 * @returns {{update:Function, clear:Function, reset:Function}}
 */
export function createEvalBar(container) {
  container.classList.add('evalbar');
  container.innerHTML = '';

  // 白色那块。它有多高 = 白方有多大优势。
  const whiteBlock = document.createElement('div');
  whiteBlock.className = 'evalbar-white';

  // 中线，表示「完全均势」的位置
  const midline = document.createElement('div');
  midline.className = 'evalbar-mid';

  // 分数标签，固定在条的底部
  const scoreLabel = document.createElement('div');
  scoreLabel.className = 'evalbar-score';
  scoreLabel.textContent = '—';

  container.append(whiteBlock, midline, scoreLabel);

  /**
   * @param {?number} scoreCp
   * @param {?number} scoreMate
   * @param {boolean} [flipped] 棋盘是不是翻过来了（黑方在下）
   */
  function update(scoreCp, scoreMate, flipped = false) {
    const norm = normFromScore(scoreCp, scoreMate);
    const frac = whiteFraction(norm);

    // 白色块永远贴在「白棋所在的那一侧」。
    // 正常摆放时白棋在下 → 贴底；翻过棋盘后白棋在上 → 贴顶。
    whiteBlock.style.top = flipped ? '0' : 'auto';
    whiteBlock.style.bottom = flipped ? 'auto' : '0';
    whiteBlock.style.height = (frac * 100).toFixed(2) + '%';

    scoreLabel.textContent = compactScore(scoreCp, scoreMate);
    scoreLabel.dataset.side = sideOf(scoreCp, scoreMate);
  }

  /** 还没算出来 / 没载入棋谱时的样子 */
  function clear() {
    whiteBlock.style.top = 'auto';
    whiteBlock.style.bottom = '0';
    whiteBlock.style.height = '50%';
    scoreLabel.textContent = '—';
    scoreLabel.dataset.side = 'eq';
  }

  return { update, clear, reset: clear };
}

/**
 * 谁占优：'w' | 'b' | 'eq'。判断门槛和 app.js 里保持一致（0.8 个兵）
 */
export function sideOf(scoreCp, scoreMate) {
  if (scoreMate !== null && scoreMate !== undefined) {
    return scoreMate > 0 ? 'w' : scoreMate < 0 ? 'b' : 'eq';
  }
  if (scoreCp === null || scoreCp === undefined) return 'eq';
  if (scoreCp > 80) return 'w';
  if (scoreCp < -80) return 'b';
  return 'eq';
}

/**
 * 次优选比首选差多少 —— 这句话回答的是"这一步到底是真好棋，还是不得已只能这样走"。
 *
 * ⚠️ 两个都是**普通分**时才算得出"差多少兵"；只要有一边是杀棋分，
 *    量纲就不一样了（杀棋压过任何分数），这时候宁可少说一句，也不给个假数字。
 *    视角上取绝对值：引擎给的首选本来就是对**走棋那一方**最好的，
 *    所以差值对谁走都一样，不用再翻。
 *
 * @returns {string} 说法，或者空串（说不清就不说）
 */
export function gapVsBest(best, alt) {
  const bm = best && best.scoreMate;
  const am = alt && alt.scoreMate;
  if (bm !== null && bm !== undefined) return '首选就是杀棋，这里没法比';
  if (am !== null && am !== undefined) return '';
  const b = best ? best.scoreCp : null;
  const a = alt ? alt.scoreCp : null;
  if (b === null || b === undefined || a === null || a === undefined) return '';
  const d = Math.abs(b - a) / 100;
  if (d < 0.01) return '和首选基本一样';
  return '比首选差约 ' + d.toFixed(2) + ' 个兵';
}

// ============================================================
// 第三部分：评估曲线
//
// 横轴 = 半回合数（第 0 个点是开局，第 k 个点是第 k 步走完之后）
// 纵轴 = 上面那套压缩过的分数
//
// 用 SVG 手画，不引 Chart.js。理由：
//   1. 少一个外部依赖，也就不用操心 CDN 挂掉
//   2. 每个点可以直接挂点击事件，跳转做得干净
//   3. 测试里能用 jsdom 数出「曲线上有几个点」，不依赖 canvas 渲染
// ============================================================
/**
 * @param {HTMLElement} container
 * @returns {{update:Function, onPick:Function, clear:Function}}
 */
export function createEvalCurve(container) {
  container.classList.add('eval-curve');
  container.innerHTML = '';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'eval-curve-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  container.appendChild(svg);

  let pickHandler = null;

  // 点击曲线 → 跳到那一步。用事件委托，免得给几十个点逐个挂钩子。
  svg.addEventListener('click', (ev) => {
    const t = ev.target;
    const holder = t && t.closest ? t.closest('[data-ply]') : null;
    if (holder && pickHandler) pickHandler(Number(holder.getAttribute('data-ply')));
  });

  /**
   * @param {Array<{norm:?number, scoreCp:?number, scoreMate:?number, scoreText:?string, done:boolean}>} points
   * @param {number} cursorIndex 当前停在第几个点（-1 表示不高亮）
   */
  function update(points, cursorIndex) {
    clearNode(svg);

    const n = points ? points.length : 0;
    if (n < 2) {
      svg.removeAttribute('viewBox');
      return;
    }

    const W = n - 1;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + VIEW_H);

    // 只画「从头开始，连续有分数」的那一段。
    // 后面的还没算完，画半截线会让人以为棋局就是这样。
    let end = -1;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (p && p.norm !== null && p.norm !== undefined) end = i;
      else break;
    }

    // 某一格分数 → 画面上的 y
    const yOf = (norm) => VIEW_H / 2 - norm * (VIEW_H / 2 - VIEW_PAD);

    // ---- 1. 打底：整个画面是深色，代表「黑方区域」 ----
    svg.appendChild(makeRect(0, 0, W, VIEW_H, '#1b1f24'));

    // ---- 2. 中线：完全均势的位置 ----
    svg.appendChild(makeLine(0, VIEW_H / 2, W, VIEW_H / 2, '#454d56', 1));

    if (end >= 0) {
      // ---- 3. 白方区域：曲线往下直到画面底部 ----
      // 于是「白色面积越大 = 白方越优」，一眼就能看出来。
      const area = [];
      for (let i = 0; i <= end; i++) {
        area.push((i === 0 ? 'M' : 'L') + i + ',' + yOf(points[i].norm).toFixed(2));
      }
      area.push('L' + end + ',' + VIEW_H, 'L0,' + VIEW_H, 'Z');
      svg.appendChild(makePath(area.join(' '), '#dfe4ea', 0.16));

      // ---- 4. 曲线本体。先画粗描边打底，再画本色，
      //         这样在浅色和深色背景上都看得清 ----
      const line = [];
      for (let i = 0; i <= end; i++) {
        line.push((i === 0 ? 'M' : 'L') + i + ',' + yOf(points[i].norm).toFixed(2));
      }
      const d = line.join(' ');
      svg.appendChild(makePath(d, 'none', 1, '#0f1216', 3));
      svg.appendChild(makePath(d, 'none', 1, '#7fd1b9', 1.7));
    }

    // ---- 5. 当前这一步：一条竖线 + 一个圆点 ----
    if (cursorIndex >= 0 && cursorIndex <= end) {
      const x = cursorIndex;
      const y = yOf(points[cursorIndex].norm);
      svg.appendChild(makeLine(x, 0, x, VIEW_H, '#f0d264', 1, 0.45));
      const dot = makeCircle(x, y, 3, '#f0d264');
      dot.setAttribute('stroke', '#0f1216');
      dot.setAttribute('stroke-width', '1.2');
      svg.appendChild(dot);
    }

    // ---- 6. 点击热区。每个半回合一条透明的竖条，铺满整个高度 ----
    for (let i = 0; i < n; i++) {
      const hit = makeRect(i - 0.5, 0, 1, VIEW_H, 'transparent');
      hit.setAttribute('data-ply', String(i));
      hit.setAttribute('pointer-events', 'all');
      hit.appendChild(makeTitle(labelOf(points, i)));
      svg.appendChild(hit);
    }
  }

  function clear() {
    clearNode(svg);
    svg.removeAttribute('viewBox');
  }

  /** 注册「点了曲线上第 k 个点」的回调 */
  function onPick(fn) {
    pickHandler = fn;
  }

  return { update, onPick, clear };
}

/** 鼠标停在某个点上时显示的原生提示 */
function labelOf(points, i) {
  const p = points[i];
  const where = i === 0 ? '开局' : '第 ' + i + ' 步之后';
  if (!p || p.norm === null || p.norm === undefined) return where + '：还没算';
  return where + '：' + (p.scoreText || '—');
}

// ============================================================
// 小工具：造 SVG 元素
// ============================================================
function makeRect(x, y, w, h, fill) {
  const el = document.createElementNS(SVG_NS, 'rect');
  el.setAttribute('x', x);
  el.setAttribute('y', y);
  el.setAttribute('width', w);
  el.setAttribute('height', h);
  el.setAttribute('fill', fill);
  return el;
}

function makeLine(x1, y1, x2, y2, stroke, width, opacity) {
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', x1);
  el.setAttribute('y1', y1);
  el.setAttribute('x2', x2);
  el.setAttribute('y2', y2);
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', width);
  // 曲线会被拉宽拉扁，这个属性保证线宽不被拉伸变形
  el.setAttribute('vector-effect', 'non-scaling-stroke');
  if (opacity !== undefined) el.setAttribute('opacity', opacity);
  return el;
}

function makePath(d, fill, fillOpacity, stroke, strokeWidth) {
  const el = document.createElementNS(SVG_NS, 'path');
  el.setAttribute('d', d);
  el.setAttribute('fill', fill);
  if (fillOpacity !== undefined && fill !== 'none') el.setAttribute('fill-opacity', fillOpacity);
  if (stroke) {
    el.setAttribute('stroke', stroke);
    el.setAttribute('stroke-width', strokeWidth);
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
  }
  return el;
}

function makeCircle(cx, cy, r, fill) {
  const el = document.createElementNS(SVG_NS, 'circle');
  el.setAttribute('cx', cx);
  el.setAttribute('cy', cy);
  el.setAttribute('r', r);
  el.setAttribute('fill', fill);
  return el;
}

function makeTitle(text) {
  const el = document.createElementNS(SVG_NS, 'title');
  el.textContent = text;
  return el;
}

function clearNode(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
