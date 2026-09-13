// ============================================================
// arrows.js —— 在棋盘上画箭头（用来标出引擎推荐的着法）
//
// 做法：在棋盘上面盖一层 SVG，坐标系直接设成「8×8 的格子单位」。
// 这样我们就能用 a1=0.5,0.5 这种直观的格子坐标来画，
// 不用去算像素 —— 棋盘怎么缩放箭头都跟着对。
// ============================================================

const FILES = 'abcdefgh';

/**
 * 格子的中心点，单位是「格」。
 *   正常摆放：a1 的中心是 x=0.5, y=7.5（在左下角）
 *   翻过棋盘：a1 跑到右上角，坐标也要跟着镜像
 */
export function squareCenter(square, flipped = false) {
  const fileIdx = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  let x = fileIdx + 0.5;
  let y = (8 - rank) + 0.5; // 第 8 横线在最上面，所以 y 要翻过来
  if (flipped) {
    // SVG 的坐标系是 8×8，转 180° 就是拿 8 去减
    x = 8 - x;
    y = 8 - y;
  }
  return { x, y };
}

// 箭头的形状参数（单位同样是「格」）
const HEAD_LEN = 0.36;    // 箭头的长度
const HEAD_HALF_W = 0.20; // 箭头底部半宽
const SHAFT_W = 0.15;     // 箭杆粗细

/**
 * 画一批箭头
 * @param {SVGElement} svg    棋盘上那层 SVG
 * @param {Array<{from:string,to:string,color?:string}>} arrows
 * @param {{flipped?:boolean}} [opts]  棋盘翻了的话，箭头也要跟着翻
 */
export function drawArrows(svg, arrows, opts = {}) {
  const flipped = !!opts.flipped;

  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = '';

  if (!arrows || !arrows.length) return;

  for (const a of arrows) {
    if (!a || !a.from || !a.to || a.from === a.to) continue;
    const color = a.color || '#e8933a';
    svg.appendChild(makeArrow(a.from, a.to, color, flipped));
  }
}

function makeArrow(from, to, color, flipped) {
  const p0 = squareCenter(from, flipped);
  const p1 = squareCenter(to, flipped);

  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  // 箭杆不要盖住箭头本身，所以提前收住
  const shaftEnd = { x: p1.x - ux * HEAD_LEN * 0.92, y: p1.y - uy * HEAD_LEN * 0.92 };

  // 箭头三角形的三个角：尖端 + 左右两个后角
  const tip = { x: p1.x, y: p1.y };
  const base = { x: p1.x - ux * HEAD_LEN, y: p1.y - uy * HEAD_LEN };
  const left = { x: base.x - uy * HEAD_HALF_W, y: base.y + ux * HEAD_HALF_W };
  const right = { x: base.x + uy * HEAD_HALF_W, y: base.y - ux * HEAD_HALF_W };

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

  // 深色描边打底：这样在浅格和深格上都看得清
  g.appendChild(makeLine(p0, shaftEnd, color, SHAFT_W + 0.09, 0.45));
  g.appendChild(makeTriangle(tip, left, right, color, 0.45));

  // 本色盖上去
  g.appendChild(makeLine(p0, shaftEnd, color, SHAFT_W, 0.92));
  g.appendChild(makeTriangle(tip, left, right, color, 0.92));

  return g;
}

function makeLine(p0, p1, color, width, opacity) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  el.setAttribute('x1', p0.x);
  el.setAttribute('y1', p0.y);
  el.setAttribute('x2', p1.x);
  el.setAttribute('y2', p1.y);
  el.setAttribute('stroke', color);
  el.setAttribute('stroke-width', width);
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('opacity', opacity);
  return el;
}

function makeTriangle(a, b, c, color, opacity) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  el.setAttribute('points', `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}`);
  el.setAttribute('fill', color);
  el.setAttribute('opacity', opacity);
  el.setAttribute('stroke', color);
  el.setAttribute('stroke-width', 0.06);
  el.setAttribute('stroke-linejoin', 'round');
  return el;
}
