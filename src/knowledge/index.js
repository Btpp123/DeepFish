// ============================================================
// knowledge/index.js —— 按局面挑「这次该给它看哪些战术知识」
//
// 【为什么必须挑，不能全给】
// 全给有三个毛病：
//   1. 贵 —— 每次讲棋都付一遍几千 token；
//   2. 稀释 —— 一次给二十条母题，模型反而抓不住哪条相关；
//   3. 最要命的一条：**它会开始硬套**。
//      把"世纪之战"的弃后剧情摆在面前，它就会在当前这盘业余对局里
//      找出一模一样的剧情来。给得越多，编得越起劲。
//
// 所以这里只做一件事：**用局面特征筛**。
// 特征全部来自 position.js 的确定性计算，选择过程没有任何模型参与，
// 同样的局面必然挑出同样的知识 —— 可复现，可测试。
// ============================================================

const { MOTIFS, OPENING, ENDGAME, MATING } = require('./tactics');
const { GAMES } = require('./games');

/** 一次最多发几条母题 / 几个样例（控提示词长度，也控"硬套"的空间） */
const MAX_MOTIFS = 4;
const MAX_GAMES = 2;
const MAX_PRINCIPLES = 3;
const MAX_MATING = 2;

/**
 * 「稀有特征」清单。命中其中任何一个，说明这个局面确实有点具体的东西可讲，
 * 这时候才把预算给足；一个都没命中（就是盘平平淡淡的中局），
 * 就少给一点 —— 泛泛的局面配一堆泛泛的母题，只会稀释真正有用的信息。
 */
const SPECIFIC_TAGS = ['mate', 'sacrifice', 'promotion', 'forced', 'uncastledKing', 'sharpswing'];

/**
 * 把「局面特征」翻译成「标签集合」。
 * 每一种标签都对应 position.js 里一条可以复算的事实，不掺主观。
 *
 * @param {object} ctx 见 buildKnowledge 的说明
 * @returns {Set<string>}
 */
function tagSetOf(ctx = {}) {
  const tags = new Set();
  const phase = ctx.phase === 'opening' ? 'opening'
    : ctx.phase === 'endgame' ? 'endgame' : 'middlegame';
  tags.add(phase);

  if (ctx.hasMate) tags.add('mate');
  if (ctx.isCapture) tags.add('capture');
  if (ctx.givesCheck) tags.add('check');
  if (ctx.isPromotion) tags.add('promotion');
  if (ctx.isSacrifice) tags.add('sacrifice');
  if (ctx.uncastledKing) tags.add('uncastledKing');
  if (ctx.isForced) tags.add('forced');
  // 评分掉了 1.5 个兵以上 —— 这种局面里往往真有一个战术没看见
  if (typeof ctx.swingForMover === 'number' && ctx.swingForMover <= -150) tags.add('sharpswing');
  // 一边领先 2 个兵以上，或者已经算出杀棋：局面已经失衡
  if (Math.abs(Number(ctx.materialDiff) || 0) >= 2 || ctx.hasMate) tags.add('sharpswing');

  return tags;
}

/**
 * 标签的分量不同，不能一视同仁地数个数。
 *
 * 「这一步是吃子」「现在是中局」几乎盘盘成立，光靠它们选不出有用的东西；
 * 而「这一步像弃子」「他只有一步可走」「对方王没易位」是**稀有的、具体的**特征 ——
 * 命中它们的母题才是这次真正该讲的。
 *
 * 所以给稀有特征加权重。否则会出现这种事：一盘明明有弃子的棋，
 * 选出来的四条母题全是"捉双/穿刺"这类泛泛的东西，因为它们在表里排得更靠前。
 */
const TAG_WEIGHT = {
  sacrifice: 2,
  promotion: 2,
  forced: 2,
  mate: 1.5,
  uncastledKing: 1.5,
  capture: 1,
  check: 1,
  sharpswing: 1,
  opening: 1,
  middlegame: 1,
  endgame: 1,
};

/**
 * 按标签重合度排序选条目。同分时保持原表顺序 ——
 * 这样"同样的局面必然选出同样的东西"，测试才写得出来。
 */
function pickByTags(list, tags, max) {
  const scored = list.map((item, i) => {
    const own = Array.isArray(item.tags) ? item.tags : [];
    const hit = own.filter((t) => tags.has(t)).length;
    const score = own.reduce((sum, t) => sum + (tags.has(t) ? (TAG_WEIGHT[t] || 1) : 0), 0);
    return { item, hit, score, i };
  });
  return scored
    .filter((s) => s.hit > 0)
    .sort((a, b) => (b.score - a.score) || (b.hit - a.hit) || (a.i - b.i))
    .slice(0, max)
    .map((s) => s.item);
}

/**
 * 挑经典对局样例。
 *
 * 打分是两路相加，母题占大头：
 *   hitPicked —— 这盘棋的战术母题里，有几条正好是**这次选中的母题**（权重 2）
 *   hitTags   —— 这盘棋的主题标签里，有几个和当前局面特征对得上（权重 1）
 *
 * ⚠️ 门槛设在 2 分（等于"至少命中一条本次选中的母题"）。
 *    太低会把不相关的名局端上来，模型就会拿它的剧情硬套当前这盘棋 ——
 *    给经典样例这件事，最大的风险不是给少了，是**给错了还讲得很起劲**。
 */
function pickGames(tags, pickedMotifIds, max) {
  const wanted = new Set(pickedMotifIds);
  const scored = GAMES.map((g, i) => {
    const hitPicked = (g.motifs || []).filter((m) => wanted.has(m)).length;
    const hitTags = (g.tags || []).filter((t) => tags.has(t)).length;
    return { game: g, hitPicked, score: hitPicked * 2 + hitTags, i };
  });
  return scored
    .filter((s) => s.score >= 2)
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .slice(0, max)
    .map((s) => s.game);
}

/**
 * 【对外主入口】按局面挑知识，并拼成可直接进提示词的一段文字。
 *
 * @param {object} ctx
 *   phase          'opening' | 'middlegame' | 'endgame'
 *   hasMate        bool    引擎的分数里有没有将杀
 *   isCapture      bool    这一步是不是吃子
 *   givesCheck     bool    这一步是不是将军
 *   isPromotion    bool    这一步是不是升变
 *   isSacrifice    bool    这一步看起来像不像主动送子（大子吃小子 / 送子换杀）
 *   isForced       bool    这个局面只有一步合法着法
 *   uncastledKing  bool    走棋方一边的王还没易位
 *   materialDiff   number  白减黑的子力（兵为单位）
 *   swingForMover  number  走棋方这一步的得失（厘兵，负数=亏）
 * @returns {{text:string, tags:string[], motifs:string[], games:string[]}}
 */
function buildKnowledge(ctx = {}) {
  const tags = tagSetOf(ctx);
  const tagArr = [...tags];

  // 预算跟着"这个局面到底有没有具体的东西"走：命中了稀有特征才把额度用足。
  const specific = SPECIFIC_TAGS.filter((t) => tags.has(t)).length;
  const motifBudget = specific ? MAX_MOTIFS : 2;
  const gameBudget = specific ? MAX_GAMES : 1;

  const motifs = pickByTags(MOTIFS, tags, motifBudget);
  const games = pickGames(tags, motifs.map((m) => m.id), gameBudget);

  // 阶段原则：开局/残局各带两三条。中局不给 ——
  // 中局的"原则"其实就是上面那些母题，重复一遍只是占地方。
  const principles = tags.has('opening') ? OPENING.slice(0, MAX_PRINCIPLES)
    : tags.has('endgame') ? ENDGAME.slice(0, MAX_PRINCIPLES)
      : [];
  const mating = tags.has('mate') ? MATING.slice(0, MAX_MATING) : [];

  const lines = [];
  lines.push('【战术参考 · 通用知识，不是对这盘棋的判断】');
  lines.push('（这些只是"有这么个名字、这么个套路"。只有当你能在上面的事实里');
  lines.push('  指出对应的着法时才提它；对不上就别硬套 —— 叫错一个战术名字，');
  lines.push('  比不叫名字更糟。）');
  lines.push('');

  if (motifs.length) {
    lines.push('这个局面里可能用得上的：');
    for (const m of motifs) lines.push('- ' + m.name + '：' + m.text);
    lines.push('');
  }
  if (mating.length) {
    lines.push('关于杀棋：');
    for (const t of mating) lines.push('- ' + t);
    lines.push('');
  }
  if (principles.length) {
    lines.push(tags.has('opening') ? '开局原则：' : '残局原则：');
    for (const t of principles) lines.push('- ' + t);
    lines.push('');
  }
  if (games.length) {
    lines.push('经典对局里它们长什么样（供类比用，不要照搬）：');
    for (const g of games) {
      lines.push('- ' + g.name + '（' + g.players + '，' + g.event + '）');
      lines.push('  着法：' + g.line);
      lines.push('  要点：' + g.idea);
      lines.push('  怎么认出来：' + g.spot);
    }
    lines.push('');
  }

  return {
    text: lines.join('\n').replace(/\n+$/, ''),
    tags: tagArr,
    motifs: motifs.map((m) => m.name),
    games: games.map((g) => g.name),
  };
}

module.exports = { buildKnowledge, tagSetOf, MOTIFS, GAMES };
