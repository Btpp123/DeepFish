// ============================================================
// position.js —— 把局面变成「确定的事实」，一个字都不交给模型去推
//
// 【为什么单独有一层做这件事】
// 模型拿到的是「走完之后的棋盘 + 走了哪一步」，它要讲清这步棋，
// 就得在自己脑子里**倒着走一步**才能还原走之前的局面。
// Nf6 到底是哪个马动的？exd5 吃的是什么？Rae1 是哪个车？
// 吃过路兵、升变、王车易位这些更是一推就错。
//
// 这类活儿的共同点：**用代码做是 100% 确定的，用模型做是概率的。**
// 所以凡是 chess.js 能算出来的，一律由这一层算好，用陈述句写进提示词：
//
//     "马 从 g8 走到 f6；没有吃子；没有将军"          ← 不劳模型推
//     "把上一个局面走出 Nf6，正好得到现在这个局面"      ← 顺便自证前后一致
//
// 提示词里每多一句这样的事实，模型就少一个可以编错的地方。
//
// 【这一层只做「事实」，不做「评价」】
// 它不说这步棋好不好 —— 那是引擎评分的活。
// 它只说这步棋是什么。两件事分开，是 coach.js 开头那条规矩的具体落实。
// ============================================================

const { Chess } = require('chess.js');

// 子力价值（单位：兵）。只用来做「这步是不是送子」这种粗判断和局面画像，
// 不参与任何评分 —— 评分只信引擎。
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_CN = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };

/** 着法名归一化：去掉 + # ! ? 这些装饰，只留骨架，好用来比对 */
function normSan(san) {
  if (typeof san !== 'string') return '';
  return san.replace(/[+#!?]/g, '').trim();
}

// ============================================================
// 战场一览：谁盯着谁、谁没人保护、轮走方有什么一步就能得手的
//
// 【为什么必须有这一层】
// 提示词里一直在问模型"这一步威胁了谁的哪个子""你该怎么应对"，
// 但在此之前，它手上关于"威胁"的全部材料只有几个 FEN ——
// 而"从 FEN 里看出攻击关系"恰恰是这个项目一开始就认定模型做不好的事。
// 于是它只能泛泛地说"施加压力"，或者照读引擎评分。
//
// 这些全是规则给的、可复算的事实，一个字都不用模型去推：
//   · 谁在攻击谁      → chess.js 的 attackers()（公开接口）
//   · 谁没人保护      → 同一格上"自己这一方能不能合法吃回来"
//   · 一步就能得手    → 枚举轮走方的每个合法着法
// ============================================================

/**
 * 把 FEN 里的走棋方翻过来。
 *
 * 【为什么要这么干】chess.js 的 `moves()` **只给轮走的那一方生成着法** ——
 * 想算"对方能吃什么"，就必须先造一个"轮到对方走"的局面。
 * 翻面只影响一个字段（过路兵那格会变得对不上），
 * 而它只关系到"能不能吃过路兵"这一条极罕见的判断，不值得为它绕大圈。
 */
function flipTurn(fen) {
  const p = String(fen || '').split(/\s+/);
  if (p.length < 2) return fen;
  p[1] = p[1] === 'w' ? 'b' : 'w';
  return p.join(' ');
}

/** 让 FEN 的走棋方正好是 color（已经是了就不动） */
function turnFor(fen, color) {
  return (String(fen || '').split(/\s+/)[1] === color) ? fen : flipTurn(fen);
}

/**
 * 某一方在**这个局面**下的全部合法着法 —— 不管现在轮到谁。
 * 想拿不轮走那一方的着法时，它内部会把走棋方翻过来（见 flipTurn）。
 */
function movesFor(fen, color) {
  try {
    return new Chess(turnFor(fen, color)).moves({ verbose: true });
  } catch {
    return [];
  }
}

/**
 * 谁没人保护 —— "战场一览"里最有用的一条，也是"威胁"这个词的实体。
 *
 * 判据两条，都是规则给的：
 *   · 被攻击：对方**合法**能吃它
 *   · 没人保护：对方最便宜的那个吃子吃下去之后，自己这一方**吃回来不合法**
 *
 * ⚠️ 这里踩过一个坑，写下来免得再犯：
 *    一开始我判断"有没有保护"用的是"自己这一方有没有子能吃到这一格"——
 *    可那一格上站着的就是自己的子，**吃自己的子永远不合法**，
 *    于是每一个被攻击的子都会被报成"没人保护"（假警报满天飞）。
 *    正确的问法是："他吃掉它**之后**，我还能不能吃回那一格" ——
 *    所以这里把对方那一手先在棋盘上走出来，再看我自己的合法着法。
 *
 * 第二条的"合法"顺带给出一个很有用的结论：王"守"着某个子，
 * 但那个子被对方保护着 —— 王其实吃不了，于是这个子按定义就是悬的。
 * 业余棋手最容易在这儿看走眼。
 *
 * @returns {Array<{square,piece,pieceCn,value,capturedBy,attackerText}>} 价值高的排前面
 */
function loosePieces(fen, color, max = 4) {
  const foe = color === 'w' ? 'b' : 'w';
  const caps = movesFor(fen, foe).filter((m) => m.captured);
  if (!caps.length) return [];

  // 同一格可能有好几个子盯着，取最便宜的那个来试（他多半也就用它吃）
  const cheapest = new Map();
  for (const m of caps) {
    const prev = cheapest.get(m.to);
    if (!prev || (VALUE[m.piece] || 0) < (VALUE[prev.piece] || 0)) cheapest.set(m.to, m);
  }

  const out = [];
  for (const [to, cap] of cheapest) {
    let game;
    try {
      game = new Chess(turnFor(fen, foe));
      game.move({ from: cap.from, to: cap.to, promotion: cap.promotion });
    } catch {
      continue;
    }
    // 他吃完了，现在轮到我：我吃得回来吗？
    const canRecapture = game.moves({ verbose: true }).some((m) => m.to === to);
    if (canRecapture) continue;

    const victim = new Chess(fen).get(to);
    if (!victim) continue;
    out.push({
      square: to, piece: victim.type, pieceCn: PIECE_CN[victim.type],
      value: VALUE[victim.type] || 0,
      capturedBy: cap.from,
      attackerText: '用 ' + cap.from + ' 的' + (PIECE_CN[cap.piece] || '子'),
    });
  }
  return out.sort((a, b) => b.value - a.value).slice(0, max);
}

/**
 * 轮走方**一步**就能得手的东西：一步将杀 / 白吃。
 *
 * 这是"这步棋被放住了"的那种东西 —— 引擎的最优解往往就是在防它，
 * 而在此之前单子里一个字都没提过。
 *
 * ⚠️ 只报**确定**的：
 *    · 将杀 —— 走完 isCheckmate() 为真
 *    · 白吃 —— 吃掉之后，对方**所有合法着法里没有一步能吃回这一格**，
 *      而且换到的东西不比送出去的便宜（象换兵那种"吃子"不算白吃）
 *      （故意不做 SEE 那套：宁可少报几个"其实也赚"的，也不报一个假的）
 *
 * 「一步将军」刻意不列：将军本身不是威胁，列出来只会稀释注意力。
 */
function immediateThreats(fen, maxEach = 3) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  const mover = game.turn();
  const mates = [];
  const wins = [];

  for (const m of game.moves({ verbose: true })) {
    let played;
    try {
      played = game.move({ from: m.from, to: m.to, promotion: m.promotion });
    } catch {
      continue;
    }
    if (!played) continue;
    try {
      if (game.isCheckmate()) {
        mates.push({ san: m.san, from: m.from, to: m.to, pieceCn: PIECE_CN[m.piece] || '子' });
      } else if (m.captured) {
        const gain = (VALUE[m.captured] || 0) - (VALUE[m.piece] || 0);
        if (gain < 0) continue;                       // 亏着换的，不叫白吃
        const canRecapture = game.moves({ verbose: true }).some((r) => r.to === m.to);
        if (!canRecapture) {
          wins.push({
            san: m.san, from: m.from, to: m.to,
            pieceCn: PIECE_CN[m.piece] || '子',
            capturedCn: PIECE_CN[m.captured] || '子',
            gain,
          });
        }
      }
    } finally {
      game.undo();
    }
  }

  return {
    turn: mover,
    mates: mates.slice(0, maxEach),
    wins: wins.slice(0, maxEach).sort((a, b) => b.gain - a.gain),
  };
}

/**
 * 轮走方**吃得到**的子，外带"对方能不能吃回来、用谁吃回来"。
 *
 * 比 immediateThreats 的"白吃"宽一档：那个只报"吃了对方吃不回来"的，
 * 而这里只报事实、不评价划不划算 —— 用来讲"他接着能干什么"（比如叉子那一手）。
 */
function captureMenu(fen, max = 2) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  const mover = game.turn();
  const found = [];

  for (const m of game.moves({ verbose: true })) {
    if (!m.captured) continue;
    let played;
    try {
      played = game.move({ from: m.from, to: m.to, promotion: m.promotion });
    } catch {
      continue;
    }
    if (!played) continue;
    try {
      // 他吃回来没？用谁吃回来？（真走出来再查，和 loosePieces 一个口径）
      const back = [...new Set(game.moves({ verbose: true }).filter((r) => r.to === m.to).map((r) => r.from))];
      found.push({
        san: m.san, from: m.from, to: m.to,
        pieceCn: PIECE_CN[m.piece] || '子',
        capturedCn: PIECE_CN[m.captured] || '子',
        value: VALUE[m.captured] || 0,
        attackerValue: VALUE[m.piece] || 0,
        recaptureBy: back.slice(0, 3).map((sq) => {
          const p = game.get(sq);
          return { square: sq, pieceCn: p ? (PIECE_CN[p.type] || '子') : '子' };
        }),
      });
    } finally {
      game.undo();
    }
  }

  // 同一个落点只留一条（吃的是同一个子，就写最便宜的那种吃法）
  const best = new Map();
  for (const x of found) {
    const prev = best.get(x.to);
    if (!prev || x.attackerValue < prev.attackerValue) best.set(x.to, x);
  }

  return {
    turn: mover,
    list: [...best.values()].sort((a, b) => b.value - a.value).slice(0, max),
  };
}

/**
 * 「他吃掉这一格之后，我能不能用 fromSquare 吃回来」的通用问法。
 *
 * ⚠️ 不能直接查合法着法：这一格上站着的是**自己的子**，
 *    而"吃自己的子"永远不合法 —— 于是每个子都会被判成"没人保护"
 *    （这个坑在 loosePieces 里已经记过一次）。要问，就得先让"他吃上来"。
 *
 * 【以前是"凭空摆一个子"，2026-09 改成"真把对方那一手走出来"】
 * 老写法是：把那一格上的自己的子**换**成一个同类型的对方的子，再问我能不能吃到那儿。
 * 它有两个毛病，第二个正好在样例第 19 步（Kd8）上翻了车：
 *   ① 摆上去的那个子的**类型是随便定的**（照抄被吃子的类型），现实中对方可能用别的子吃；
 *   ② 更致命的是，**原来那个吃上来的子还留在原地**。白方是 c6 的车吃 c7，
 *      老写法没让那辆车离开 c6 —— 而它本身就盯着 c7，于是"王吃回 c7"被判成非法。
 * 现在改成：枚举对方**真的**能吃上来的每一种着法，逐个走出来，再问 fromSquare 能不能吃回；
 * 每一种都要能接上才算守得住（宁可少说守得住，也不要说一个假的）。
 * 对方**根本吃不进来**的时候直接算"没在守" —— 见函数末尾那段说明。
 *
 * 另外，王不再被排除在外了 —— "王守着某个子"是最常见的一种保护，
 * 老代码把 `mine.type === 'k'` 直接 return false，导致这类事实永远出不来
 * （Kd8 那步棋的意图正是"王去守 c7 的象"，材料里却一个字都没有）。
 *
 * @param {object} game 原局面的 Chess 实例（只读，用来读格子上的子）
 */
function canRecaptureAt(game, fen, fromSquare, targetSquare) {
  const mine = game.get(fromSquare);
  const victim = game.get(targetSquare);
  if (!mine || !victim) return false;
  // 王那一格不参与：把它换成别的子，FEN 就缺王了
  if (victim.type === 'k') return false;

  const foe = mine.color === 'w' ? 'b' : 'w';

  let caps;
  try {
    caps = new Chess(turnFor(fen, foe)).moves({ verbose: true })
      .filter((m) => m.captured && m.to === targetSquare);
  } catch {
    return false;
  }

  // 对方真的吃得进来 → 用"真走出来"的严格问法（见函数头那段说明）
  if (caps.length) {
    for (const cap of caps) {
      let probe;
      try {
        probe = new Chess(turnFor(fen, foe));
        probe.move({ from: cap.from, to: cap.to, promotion: cap.promotion });
      } catch {
        return false;
      }
      if (!probe.moves({ verbose: true }).some((m) => m.from === fromSquare && m.to === targetSquare)) {
        return false;
      }
    }
    return true;
  }

  // 对方根本吃不进来 → 这一格"现在"没人在打它。
  // ⚠️ 这里曾经退回到"假如有个敌子在这一格，我能不能吃它"的老问法（为了保住
  //    "后 d2 护着 d4 的兵"这类话）。**2026-09 又改掉了**，因为它在用户报的另一盘棋里
  //    造出了一串假保护：白方短易位之后，材料写着
  //    "王 g1 能护住自己的子：兵 f2、兵 g2、兵 h2、车 f1" —— 后三项黑方根本吃不到，
  //    是"假如"出来的；模型照抄了这个名单，还把它读反成了"给 g1 的王补上了保护"。
  //    现在只报**对方真的吃得着**的子：那才是"它在护着谁"这句人话成立的地方。
  //    （"这一步新给谁补了保护"由 protectionDelta 单独负责，不受影响。）
  return false;
}

/**
 * 「顺着引擎那条线走两步之后会怎样」—— 两步版的事实。
 *
 * 【为什么需要它】
 * 我们只算过"现在这一步能得手什么"（一步将杀 / 白吃）。
 * 像**叉子**那种"我这步走完，他只能这么应，然后我再吃掉另一个"的组合，
 * 材料里一个字都没有 —— 模型只能复述引擎的变化线，讲不出因果。
 *
 * 做法全部是重放 + 复算，没有搜索：
 *   ① 第 1 步（引擎给的那一手）走上去；
 *   ② 数一数对方这时一共有几个合法着法（=1 就是字面意义的"只能这么应"）；
 *   ③ 第 2 步（引擎给的应手）再走上去；
 *   ④ 这时又轮到第 1 步那一方 —— 直接问他"一步能得手什么"（复用 immediateThreats）。
 * 于是"叉子"就现形了：Nxf7+ →（他只能）Ke7 → 白方这时能白吃 h8 的车。
 *
 * ⚠️ 第 2 步是**引擎选的**应手，不是唯一应手（除非 ② 算出来就是 1）——
 *    渲染时必须把这句话说清楚，不然又是一次"把假设讲成必然"。
 */
function followUp(fen, pvSan) {
  if (!fen || !Array.isArray(pvSan) || !pvSan.length) return null;

  let first;
  let g1;
  try {
    g1 = new Chess(fen);
    first = g1.move(pvSan[0]);
  } catch {
    return null;
  }
  const afterFirst = g1.fen();

  let replies = [];
  try {
    replies = movesFor(afterFirst, afterFirst.split(/\s+/)[1]);
  } catch { /* 没着法表就当数不出来 */ }

  const replySan = pvSan[1] || null;
  let reply = null;
  let afterSecond = null;
  let gains = null;
  if (replySan) {
    try {
      const g2 = new Chess(afterFirst);
      reply = g2.move(replySan);
      afterSecond = g2.fen();
      gains = immediateThreats(afterSecond);
    } catch {
      reply = null;
      afterSecond = null;
      gains = null;
    }
  }

  return {
    first: first.san,
    firstAnchor: moveAnchor(fen, first.san) || '',
    firstFen: afterFirst,
    replyCount: replies.length,
    onlyReply: replies.length === 1 ? replies[0].san : null,
    reply: reply ? reply.san : null,
    replyAnchor: reply ? (moveAnchor(afterFirst, reply.san) || '') : '',
    afterSecond,
    gains,
    // 这两步走完之后，轮到的一方"吃得到什么"（比"白吃"宽一档，用来讲叉子这类组合）
    menu: afterSecond ? captureMenu(afterSecond, 2) : null,
  };
}

/** 这一格上"够得着它"的自己人（几何口径，含王，不判"吃了能不能吃回"） */
function guardsOf(game, square, color) {
  return game.attackers(square, color)
    .filter((s) => s !== square)
    .map((s) => {
      const p = game.get(s);
      return { square: s, pieceCn: p ? (PIECE_CN[p.type] || '子') : '子' };
    });
}

/**
 * a 到 b **中间**第一个有子的格子（不含两端）；不是一条直线就返回 null。
 *
 * 用途：讲清"为什么这个子原来守不到那一格" —— 十有八九是中间挡着一个自己的子。
 * 用户报的短易位那盘，模型就是在这里编了一句"王离开 e1 之后 d1 的后不再被王挡着"
 * （王根本不在那条线上，真正挡着的是 b1 的马）。把真话算给它，它就不用编了。
 */
function blockerBetween(game, a, b) {
  const F = 'abcdefgh';
  const df = F.indexOf(b[0]) - F.indexOf(a[0]);
  const dr = Number(b[1]) - Number(a[1]);
  if (!df && !dr) return null;
  if (df && dr && Math.abs(df) !== Math.abs(dr)) return null;   // 不在一条线上
  const sf = Math.sign(df);
  const sr = Math.sign(dr);
  let f = F.indexOf(a[0]) + sf;
  let r = Number(a[1]) + sr;
  while (f >= 0 && f < 8 && r >= 1 && r <= 8) {
    const name = F[f] + r;
    if (name === b) return null;        // 中间没子
    if (game.get(name)) return name;
    f += sf;
    r += sr;
  }
  return null;
}

/**
 * 「这一步给谁补了保护 / 让谁没人守了」—— 一步棋的**意图**，唯一算得出来的实体。
 *
 * 【为什么需要它】用户在样例第 19 步（19...Kd8）上报：
 * "这一步棋本质是想用王去守护 c7 格的象……但模型对这一步棋的想法描述的不知所云。"
 *
 * 查下来材料里关于"意图"是空的（王被排除在"护住"之外，而且安静局面下战场一览也是空的），
 * 模型只好去候选表里抓了一条最像的（候选里有 Rd8，而实际走的是 Kd8，同一个落点），
 * 讲成了"王去 d8 是为了把 d8 让给车" —— 方向正好反了：王占了 d8，车反而去不了。
 *
 * 而"意图"其实是一个**前后对比**的问题：这一步改变了谁的保护？
 *   · 走之前守着 c7 的象的：只有 c8 的车；走之后：c8 的车 + d8 的王  ← 这就是意图
 *   · 走之前守着 f7 的兵的：e8 的王；走之后：没人了                    ← 这就是代价
 * 两条都能纯算出来，不需要搜索。（引擎也证实：王在 e8 时白方 Rxc7 是首选、
 * 走完基本均势；王在 d8 时白方 Rxc7 掉到 -7.33。王确实把那格补厚了。）
 *
 * ⚠️ 口径写明：这里的"守着"是**几何**的（它的走子范围够得着这一格），
 *    不是"对方吃上来它就能立刻吃回"。后者对王常常不成立（本例王就要等两个车换完才吃得回），
 *    所以我们不让材料去说那件事。
 */
function protectionDelta({ beforeFen, fen, color, from, to, max = 3 }) {
  const empty = { gained: [], lost: [] };
  if (!beforeFen || !fen || !from || !to || !color) return empty;

  let was, now;
  try {
    was = new Chess(beforeFen);
    now = new Chess(fen);
  } catch {
    return empty;
  }
  const foe = color === 'w' ? 'b' : 'w';

  const gained = [];
  const opened = [];
  const lost = [];

  for (const row of now.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== color || cell.type === 'k') continue;
      const sq = cell.square;
      // 走到的那一格不算"被保护的对象"：那上面的子就是刚走过来的那个，
      // 它前后根本不是同一个角色（不然会冒出"马 d2 失去了保护"这种废话）。
      if (sq === to) continue;
      const defBefore = guardsOf(was, sq, color);
      const defNow = guardsOf(now, sq, color);
      const atkBefore = was.attackers(sq, foe).length;
      const atkNow = now.attackers(sq, foe).length;
      // 只报**正被对方盯着**的子 —— 不然"c8 的车多了一个人守"这种废话也会列进来
      if (!atkBefore && !atkNow) continue;

      const wasSquares = defBefore.map((x) => x.square);
      const nowSquares = defNow.map((x) => x.square);
      const moverPiece = now.get(to);
      const leftPiece = was.get(from);
      const base = {
        square: sq, pieceCn: PIECE_CN[cell.type] || '子',
        value: VALUE[cell.type] || 0,
        defBefore, defNow,
        // 走到的那个子 / 走开的那个子（渲染"现在 X 也守上了"要用）
        mover: { square: to, pieceCn: moverPiece ? (PIECE_CN[moverPiece.type] || '子') : '子' },
        left: { square: from, pieceCn: leftPiece ? (PIECE_CN[leftPiece.type] || '子') : '子' },
        attackedBy: atkNow ? guardsOf(now, sq, foe) : guardsOf(was, sq, foe),
      };

      // ⚠️ 只报**有意义**的保护变化（用户抓到的第三种空话：
      //    "易位给 f2 的兵多添了一层保护" —— 而 f2 本来就有象和王两个子守着，
      //    对方只有一个后在打它。多一个车守着，对局面毫无影响，纯属凑字。）
      //    判据：这一步之前，这个子是不是**守得不够** ——
      //      · 守它的子 ≤ 打它的子 - 1（本来就少一个），或者只守着一个子（对上一个攻击者刚好持平）；
      //    这样 c7 那种"1 守 1 攻、王来补厚"仍然会报（引擎证实它有意义），
      //    而"2 守 1 攻再多一个"就会被丢掉。
      const thinBefore = defBefore.length <= Math.max(1, atkBefore - 1);
      // 失去保护同理：只有走完之后**真的守不住**了才算数。
      const thinNow = defNow.length < atkNow;

      // 新来的保护者是"这一步走到的那个子"。
      // ⚠️ 判据要拿**同一个子的新旧两格**比：王从 e8 走到 d8，d7 的马前后都是"王在守" ——
      //    只是换了只王，等于没变，两边都不该报（写成 !wasSquares.includes(to) 就会误报）。
      if (thinBefore && nowSquares.includes(to) && !wasSquares.includes(from)) gained.push(base);
      // 走掉的保护者是"这一步离开的那个子"
      if (thinNow && wasSquares.includes(from) && !nowSquares.includes(to)) lost.push(base);
      // ★ "让开之后，别的子也能守到它了" —— 用户报的短易位那盘就缺这一条：
      //    实际走的 O-O 让 a1 的车继续悬着；而引擎建议的 Nd2 把 b1 让开之后，
      //    **d1 的后**才够得着 a1（车里原来被自己的马堵着）—— 两条线的真正差别在这儿。
      //    这种保护者不是走动的那个子，光看"谁走上来"永远算不出来。
      const joinedOthers = nowSquares.filter((s) => s !== to && !wasSquares.includes(s));
      if (thinBefore && joinedOthers.length) {
        opened.push({
          ...base,
          joinedBy: joinedOthers.map((s) => {
            const p = now.get(s);
            // 它原来为什么守不到？多半是中间挡着一个自己的子（就是刚走开的那个）。
            const blockedBy = blockerBetween(was, s, sq);
            return {
              square: s, pieceCn: p ? (PIECE_CN[p.type] || '子') : '子',
              wasBlockedByFrom: blockedBy === from,
            };
          }),
        });
      }
    }
  }

  const byValue = (a, b) => b.value - a.value;
  return {
    gained: gained.sort(byValue).slice(0, max),
    opened: opened.sort(byValue).slice(0, max),
    lost: lost.sort(byValue).slice(0, max),
  };
}

/**
 * 一个子"到底能去哪" —— 吃谁、护谁、还能落到哪些空格。
 *
 * 【为什么非要有这个】
 * 用户在样例第 9 步（Qd2）上抓到一个幻觉：模型说"d2 的后和 f4 的象一起盯住了 d6 格"。
 * 而 d 线往上第一个子就是 **d4 自己的兵** —— 后根本看不到 d6。
 *
 * 挖下去发现根因不在"我们喂错了"，而在这种**安静局面**上我们**什么都没喂**：
 * Qd2 这步没人一步将杀、也没人悬着，于是【战场一览】整段为空 ——
 * 模型手上又只剩 FEN，只能自己去推格子关系，然后推错了。
 *
 * 所以这里给它一张**按规则算出来的**去向表：
 *   · 能吃到对方的子 → 用**合法**着法（被牵住的子吃不到，就不该说它吃得到）
 *   · 能护住自己的子 → 用 canRecaptureAt 的问法（见上）
 *   · 还能落到的空格   → 用**合法**着法（被挡住的格不会出现在表里）
 * 表里没有的格子，就是它真的去不了。
 */
function pieceMap(fen, square, caps = {}) {
  const capA = caps.attacks || 4;
  const capD = caps.defends || 4;
  const capC = caps.controls || 8;

  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  const piece = game.get(square);
  if (!piece) return null;

  const attacks = [];
  const controls = [];
  for (const m of movesFor(fen, piece.color)) {
    if (m.from !== square) continue;
    const target = game.get(m.to);
    if (!target) controls.push({ square: m.to, san: m.san });
    else if (target.color !== piece.color) {
      attacks.push({
        square: m.to, san: m.san, pieceCn: PIECE_CN[target.type] || '子',
        value: VALUE[target.type] || 0,
      });
    }
  }
  attacks.sort((a, b) => b.value - a.value);

  // 护住谁：先用 attackers() 捞候选（便宜），再逐个用"他吃掉它我能不能吃回来"复核
  const defends = [];
  for (const row of game.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== piece.color || cell.square === square) continue;
      if (cell.type === 'k') continue;
      if (!game.attackers(cell.square, piece.color).includes(square)) continue;
      if (canRecaptureAt(game, fen, square, cell.square)) {
        defends.push({ square: cell.square, pieceCn: PIECE_CN[cell.type] || '子' });
      }
    }
  }

  // ------------------------------------------------------------
  // 「看着够得着、规则上却吃不了」的对方子
  //
  // 【为什么非要有这一行】用户报的 bug（一盘 rapid 的第 50 手 50.Kh5）：
  //   王走到 h5，紧挨着的 h6 上有一个黑兵。材料里只写了"能落到的空格：g6、h4、g4"——
  //   h6 一个字没提（它被 g7 的兵守着，王吃上去等于送将，所以不在合法着法里）。
  //   模型于是自己补了一句"它盯上了 h6 的兵……白王就能 Kxh6，进而再 Kxg5"。
  //   和"d2 的后盯住了 d6"是同一类病：**看起来能做的事，材料沉默，它就替你做了。**
  //
  //   所以这里把"够得着但吃不了"的子**连原因一起**写出来。这不是空话：
  //   它指名道姓、还带着"谁守着那一格"，正好是残局里最容易看走眼的地方。
  // ------------------------------------------------------------
  const legalTargets = new Set(
    movesFor(fen, piece.color).filter((m) => m.from === square).map((m) => m.to)
  );
  const foe = piece.color === 'w' ? 'b' : 'w';
  let sideInCheck = false;
  try {
    sideInCheck = new Chess(turnFor(fen, piece.color)).isCheck();
  } catch { /* 构造不出来就当作没被将军 */ }

  const blockedCaptures = [];
  for (const row of game.board()) {
    for (const cell of row) {
      if (!cell || cell.color === piece.color || cell.type === 'k') continue;
      if (legalTargets.has(cell.square)) continue;                        // 吃得掉 → 已经在上面那行里了
      if (!game.attackers(cell.square, piece.color).includes(square)) continue;  // 几何上都够不着 → 不提
      blockedCaptures.push({
        square: cell.square,
        pieceCn: PIECE_CN[cell.type] || '子',
        value: VALUE[cell.type] || 0,
        // 为什么吃不了：王是"会被吃回来"，别的子多半是"走不开（被牵住 / 必须先应将）"
        byKing: piece.type === 'k',
        guards: guardsOf(game, cell.square, foe),
        becauseCheck: piece.type !== 'k' && sideInCheck,
      });
    }
  }
  blockedCaptures.sort((a, b) => b.value - a.value);

  return {
    square, pieceCn: PIECE_CN[piece.type] || '子', color: piece.color,
    attacks: attacks.slice(0, capA), defends: defends.slice(0, capD), controls: controls.slice(0, capC),
    blockedCaptures: blockedCaptures.slice(0, 3),
    attacksTotal: attacks.length, defendsTotal: defends.length, controlsTotal: controls.length,
  };
}

/**
 * 从 from 朝 to 的方向再往前走，返回**第一个有子的格子**（没有就 null）。
 * 只处理"同一条直线/斜线"的情形（马那种 L 形返回 null）。
 */
function firstPieceBeyond(game, from, to) {
  const F = 'abcdefgh';
  const df = F.indexOf(to[0]) - F.indexOf(from[0]);
  const dr = Number(to[1]) - Number(from[1]);
  if (!df && !dr) return null;
  if (df && dr && Math.abs(df) !== Math.abs(dr)) return null;   // 不在一条线上
  const sf = Math.sign(df);
  const sr = Math.sign(dr);
  let f = F.indexOf(to[0]) + sf;
  let r = Number(to[1]) + sr;
  while (f >= 0 && f < 8 && r >= 1 && r <= 8) {
    const name = F[f] + r;
    if (game.get(name)) return name;
    f += sf;
    r += sr;
  }
  return null;
}

/**
 * 「线关系」—— 牵制 / 穿刺的实体。
 *
 * 【为什么需要它】用户在样例第 9 步（Qd2）上报的第二处费解：模型说
 * "黑方 Ne4 直接踩到 d2 后和 c3 马共处的这条线上"，
 * 把引擎后续线**第 5 手**的着法讲成了眼下的威胁（那一步现在走是送子）。
 *
 * 但同时看出来：它想指的那个机制**是真实存在的** ——
 * 黑后 a5 沿 a5-b4-c3-d2 这条斜线盯着 c3 的马，而**马后面就是白后 d2**。
 * 这就是「牵制 / 串」，也正是我们没算、它只好自己编的那块空白。
 *
 * 判据全部可复算：
 *   · 谁盯着谁 → chess.js 的 attackers()（它已经算过"中间有没有挡子"）
 *   · 只看远程子（后/车/象）—— 线关系才有意义
 *   · 被盯的那个子后面紧挨着还有没有自己的子 → 有，才叫"挡着谁"
 */
function lineTactics(fen, color, max = 3) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return [];
  }
  const foe = color === 'w' ? 'b' : 'w';
  const out = [];

  // ⚠️ attackers() 是"看几何"的，它不知道牵制：一个自己被钉住的子，几何上照样"盯着"别人，
  //    但它根本不敢吃（吃了自己的王就没了）。这类假线索正是我们要挡掉的东西，
  //    所以拿对手的**合法着法表**再筛一遍：这一吃必须在表里，否则丢掉。
  const foeMoves = movesFor(fen, foe).filter((m) => m.captured);
  const canReallyCapture = (from, to) =>
    foeMoves.some((m) => m.from === from && m.to === to);

  for (const row of game.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== color) continue;
      const sq = cell.square;
      // 王不当"被挡在前面的那个子"：被将军的王不是牵制/穿刺能讲的东西，
      // 而且 VALUE[王]=0 会让下面那条"后面得比前面值钱"的过滤形同虚设。
      if (cell.type === 'k') continue;
      for (const from of game.attackers(sq, foe)) {
        const slider = game.get(from);
        if (!slider || 'brq'.indexOf(slider.type) < 0) continue;   // 只看远程子
        if (!canReallyCapture(from, sq)) continue;                 // 它自己动不了 → 不是真线索
        const behind = firstPieceBeyond(game, from, sq);
        const tail = behind ? game.get(behind) : null;
        if (!tail || tail.color !== color) continue;               // 后面没自己的子 → 不算挡着谁
        // ⚠️ 后面那个子**得比前面这个值钱**，这条线才值得说。
        //    不然会冒出一堆没用的对齐（样例里就有"象 c7 盯着马 e5、后面是兵 h2"这种），
        //    既占篇幅又把模型的注意力引偏。牵制到自己王的另算（下面 toKing 那条）。
        if (tail.type !== 'k' && (VALUE[tail.type] || 0) <= (VALUE[cell.type] || 0)) continue;
        out.push({
          square: sq, pieceCn: PIECE_CN[cell.type] || '子', value: VALUE[cell.type] || 0,
          attacker: from, attackerCn: PIECE_CN[slider.type] || '子',
          behind, behindCn: PIECE_CN[tail.type] || '子', behindValue: VALUE[tail.type] || 0,
          toKing: tail.type === 'k',
        });
      }
    }
  }

  // 牵到自己王的排前面（最硬），其余按被挡住的那个子的价值排
  out.sort((a, b) => ((b.toKing ? 1 : 0) - (a.toKing ? 1 : 0)) || (b.value - a.value));
  return out.slice(0, max);
}

/**
 * 「对手的威胁」—— 把走棋方翻过来问一句"如果轮到他走，他能干什么"。
 *
 * 这就是人和教练嘴里的"他威胁 Qxf7#"的**确切含义**：
 * 不是我不管的话他会怎么走（那要两层搜索），而是"这个局面站在他手里，
 * 他一步就能得手" —— 一层，可算。
 *
 * ⚠️ 只在**我方没被将军**时算。被将军的时候谈"他的威胁"没有意义
 *    （我必须先应将，局面马上就变了），给出来只会误导。
 */
function foeThreats(fen) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  if (game.isCheck()) return null;
  const foe = game.turn() === 'w' ? 'b' : 'w';
  return immediateThreats(turnFor(fen, foe));
}

/**
 * 「引擎推荐的那一手在干什么」—— 把"防守"变成一句有据可查的事实。
 *
 * 三段，全部可复算：
 *   ① 它本身就是那个机会吗（引擎直接一步将杀 / 一步白吃）
 *   ② 对手原来的威胁，被这一手消掉了哪些（防守）
 *   ③ 轮走方自己的悬子，被这一手救回来哪些（也还是防守）
 *
 * ②的比法是干净的：比较的是**同一个人**（对手）在两边的能力 ——
 * 翻面问"如果轮到他走他能干什么"（走之前），对真实局面问"轮到他走他能干什么"（走之后）。
 *
 * @param {string} fen 现在这个局面（引擎推荐的是给轮走方的）
 * @param {string} san 引擎推荐的那一手
 * @param {object} [ownOpportunities] 轮走方现在能得手的（不给就自己算一遍）
 */
function engineEffect(fen, san, ownOpportunities) {
  const clean = String(san == null ? '' : san).replace(/[!?]/g, '').trim();
  if (!fen || !clean) return null;

  const side = (String(fen).split(/\s+/)[1] === 'b') ? 'b' : 'w';
  const own = ownOpportunities || immediateThreats(fen);
  const foeBefore = foeThreats(fen);
  const looseBefore = loosePieces(fen, side);

  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  let played;
  try {
    played = game.move(clean);
  } catch {
    return null;
  }
  if (!played) return null;

  const afterFen = game.fen();
  const foeAfter = immediateThreats(afterFen);       // 走完之后真的轮到他了
  const looseAfter = loosePieces(afterFen, side);
  const has = (list, to) => (list || []).some((x) => x.to === to);

  return {
    san: played.san,
    anchor: anchorOf(played),
    ownOpportunities: own,
    selfIsMate: !!(own && own.mates.some((m) => m.to === played.to)),
    selfIsWin: !!(own && own.wins.some((w) => w.to === played.to)),
    foeThreatsBefore: foeBefore,
    foeThreatsAfter: foeAfter,
    // 被他这一手消掉的威胁（防守）
    stoppedMates: foeBefore ? foeBefore.mates.filter((m) => !has(foeAfter ? foeAfter.mates : [], m.to)) : [],
    stoppedWins: foeBefore ? foeBefore.wins.filter((w) => !has(foeAfter ? foeAfter.wins : [], w.to)) : [],
    // 他走完之后，对方还剩下什么一步就能得手的
    leftMates: foeAfter ? foeAfter.mates : [],
    leftWins: foeAfter ? foeAfter.wins : [],
    looseBefore,
    looseAfter,
    looseFixed: looseBefore.filter((a) => !looseAfter.some((b) => b.square === a.square)),
    looseLeft: looseAfter,
  };
}

/**
 * 站在 square 上的子，现在**合法**盯着对方哪些子 —— 用来讲"这一步盯上了谁"。
 *
 * 直接翻出它那一方的吃子着法再按起点筛，没有转弯：
 * "Nf6 盯上了 h5 的后"就是这么来的（而那一步之所以坏，是因为对方根本不用管它）。
 */
function attacksFrom(fen, square, max = 4) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return [];
  }
  const piece = game.get(square);
  if (!piece) return [];
  return movesFor(fen, piece.color)
    .filter((m) => m.from === square && m.captured)
    .map((m) => ({
      square: m.to, pieceCn: PIECE_CN[m.captured] || '子',
      value: VALUE[m.captured] || 0, san: m.san,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, max);
}

/**
 * 「为什么这是将杀」—— 将杀局面下算三件事，全是规则给的。
 *
 * 这三句拼起来本身就是一段像样的讲评；而在此之前，模型只能看着 +M1 说
 * "白方有一步将杀" —— 讲不出为什么。
 *
 * （"垫不了"其实是多余的：这一步已经是将杀，意味着轮到的一方
 *   **一个合法着法都没有**，垫子自然也在其中。）
 */
function mateReason(fen) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  if (!game.isCheckmate()) return null;

  const mated = game.turn();                 // 被将杀的一方
  const winner = mated === 'w' ? 'b' : 'w';
  const board = game.board().flat();
  const kingCell = board.find((c) => c && c.type === 'k' && c.color === mated);
  const kingSq = kingCell ? kingCell.square : null;

  // 将军的子：这里用不问牵制的 attackers() 是对的 ——
  // 能将杀的一方，其将军子必然是"真的在将军"，不存在被钉住还将军的情形。
  const checkers = kingSq ? game.attackers(kingSq, winner) : [];
  const kingMoves = kingSq ? game.moves({ square: kingSq, verbose: true }) : [];
  const checkerType = checkers.length ? (game.get(checkers[0]) || {}).type : null;
  const guards = checkers.length
    ? game.attackers(checkers[0], winner).filter((s) => s !== checkers[0])
    : [];

  return {
    mated, winner, kingSquare: kingSq,
    checkers,
    checkersText: checkers.map((s) => {
      const p = game.get(s);
      return (PIECE_CN[p.type] || '子') + '（' + s + '）';
    }).join('、'),
    kingFlightCount: kingMoves.length,           // 将杀时必然是 0
    // 将军的子旁边有没有自己人看着 —— 有的话，王吃下去会被吃回来
    checkerGuarded: guards.length > 0,
    guardsText: guards.map((s) => {
      const p = game.get(s);
      return (PIECE_CN[p.type] || '子') + '（' + s + '）';
    }).join('、'),
    checkerIsKnight: checkerType === 'n',
  };
}

/**
 * 这一步到底干了什么 —— 全部是从"走之前的局面 + 着法名"重放出来的。
 *
 * @param {string} beforeFen 走这一步**之前**的局面
 * @param {string} san 走的是哪一步（标准记谱）
 * @returns {object|null} 走不了就返回 null（宁可不说，也不猜）
 */
function moveFacts(beforeFen, san) {
  let game;
  try {
    game = new Chess(beforeFen);
  } catch {
    return null;
  }

  // 合法着法总数。「不得已只能这样走」有时候是字面意思 ——
  // 这个数字由规则给出，比任何推测都硬。
  let legalCount = 0;
  try {
    legalCount = game.moves().length;
  } catch {
    legalCount = 0;
  }

  let played;
  try {
    played = game.move(san);   // chess.js 1.x 走不动会抛异常
  } catch {
    return null;
  }
  if (!played) return null;

  const flags = String(played.flags || '');

  let givesCheck = false;
  let isCheckmate = false;
  let isStalemate = false;
  try {
    givesCheck = game.isCheck();
    isCheckmate = game.isCheckmate();
    isStalemate = game.isStalemate();
  } catch { /* 老版本没有这些方法就当作不知道 */ }

  return {
    san: played.san,
    color: played.color,
    pieceCn: PIECE_CN[played.piece] || '子',
    piece: played.piece,
    from: played.from,
    to: played.to,
    capturedCn: played.captured ? (PIECE_CN[played.captured] || '子') : null,
    captured: played.captured || null,
    isCapture: !!played.captured,
    // 吃过路兵：记谱上写着 exd6，但 d6 原本是空的 —— 最容易讲错的一种
    isEnPassant: flags.includes('e'),
    isCastle: flags.includes('k') || flags.includes('q'),
    castleSide: flags.includes('k') ? '短易位（王翼）' : flags.includes('q') ? '长易位（后翼）' : null,
    isPromotion: !!played.promotion,
    promotionTo: played.promotion || null,
    // 动的这个子值多少、吃掉的子值多少。
    // 给出去是为了让"这步是不是大子换小子"有据可依 —— 判断留给模型，数字我们来。
    movedPieceValue: VALUE[played.piece] || 0,
    capturedValue: played.captured ? (VALUE[played.captured] || 0) : 0,
    givesCheck,
    isCheckmate,
    isStalemate,
    fenAfter: game.fen(),
    legalCount,
    isForced: legalCount === 1,
  };
}

/**
 * 把一步棋说成「马 b2→c4」这种**带起止格**的写法（吃子用 ×）。
 *
 * 【为什么非要有这个东西】
 * 记谱（SAN）在"两个同类棋子都能走到同一格"时才会写成 Nbd2 / N1d2 这种带区分的写法。
 * 但还有一种情况：两个同类子**看起来**都能去那个格，实际只有**一个合法** ——
 * 另一个走了会把自己的王暴露给对方（= 送将）。这时候记谱**只写 Nc4，不说是哪一个**，
 * 因为规则上只有一个能走。
 *
 * 人（和模型）看到光秃秃一个 Nc4，就会自己去猜是哪个马 —— 而猜这一步最容易翻车。
 * 所以凡是提示词里出现的着法，都尽量带上这个锚点：动手的是哪个子、从哪一格到哪一格。
 * 模型不需要猜，也就不会编。
 */
function anchorOf(played) {
  const flags = String((played && played.flags) || '');
  const pieceCn = PIECE_CN[played.piece] || '子';
  const sep = played.captured ? '×' : '→';
  let s = pieceCn + ' ' + played.from + sep + played.to;
  // 易位：车也跟着动了，不写清楚最容易让人以为"王凭空挪了两格"。
  // 用逗号而不是再套一层括号 —— 锚点本身就已经在括号里了，嵌套读起来很乱。
  if (flags.includes('k')) s += '，短易位，车 ' + 'h' + played.from[1] + '→' + 'f' + played.from[1];
  else if (flags.includes('q')) s += '，长易位，车 ' + 'a' + played.from[1] + '→' + 'd' + played.from[1];
  if (played.promotion) s += '，升变为' + (PIECE_CN[played.promotion] || '后');
  return s;
}

/**
 * 在某个局面下走出 san，把这一步说成「马 b2→c4」。
 * 走不出来（着法名不合法、局面不认）就返回空串 —— 宁可没有锚点，也不给个错的。
 *
 * @returns {string} 例如 '马 b2→c4' / '兵 e4×d5' / '王 e1→g1（短易位，车 h1→f1）'
 */
function moveAnchor(fen, san) {
  const clean = String(san == null ? '' : san).replace(/[!?]/g, '').trim();
  if (!clean) return '';
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return '';
  }
  let played;
  try {
    played = game.move(clean);
  } catch {
    return '';
  }
  return played ? anchorOf(played) : '';
}

/**
 * 把一串着法走一遍，交出**每一步之后**的 FEN。
 *
 * 用户要的正是这个：让 DeepSeek 看见棋盘是怎么一步步变的，
 * 而不是只给它一个起点和一个终点，让它自己去推中间。
 *
 * ⚠️ 走不通就停在那里，能走到哪算哪 —— 半条真的线，好过一条编的线。
 *
 * @param {string} fen 起点局面
 * @param {string[]} sans 着法序列
 * @param {number} max 最多走几步（控提示词长度）
 * @returns {Array<{san:string, mover:'w'|'b', fen:string, givesCheck:boolean, isMate:boolean,
 *                  from:string, to:string, piece:string, pieceCn:string,
 *                  isCapture:boolean, anchor:string}>}
 */
function sanTrail(fen, sans, max = 8) {
  if (!Array.isArray(sans) || !sans.length) return [];

  let game;
  try {
    game = new Chess(fen);
  } catch {
    return [];
  }

  const out = [];
  for (const san of sans.slice(0, max)) {
    // 谁走的由**走之前**的 FEN 决定 —— 走完之后 turn 就翻过去了
    const mover = game.turn();

    let played;
    try {
      played = game.move(san);
    } catch {
      break;
    }
    if (!played) break;

    let givesCheck = false;
    let isMate = false;
    try {
      givesCheck = game.isCheck();
      isMate = game.isCheckmate();
    } catch { /* 不知道就不说 */ }

    out.push({
      san: played.san, mover, fen: game.fen(), givesCheck, isMate,
      // 起止格锚点：只给"Nc4"的话，读的人（和模型）得自己猜是哪个马 —— 见 anchorOf
      from: played.from, to: played.to,
      piece: played.piece, pieceCn: PIECE_CN[played.piece] || '子',
      isCapture: !!played.captured,
      anchor: anchorOf(played),
    });
    if (isMate) break;       // 已经结束了，后面的着法不存在
  }
  return out;
}

/**
 * 局面的画像 —— 粗粒度，用来挑「这盘棋该参考哪些战术母题」。
 * 只输出能从规则里确定读出来的东西，不含任何判断。
 */
function positionProfile(fen) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }

  const rows = game.board();
  let matWhite = 0;
  let matBlack = 0;
  let queensOn = 0;
  const kings = { w: null, b: null };

  for (const row of rows) {
    for (const sq of row) {
      if (!sq) continue;
      if (sq.type === 'k') { kings[sq.color] = sq.square; continue; }
      if (sq.type === 'q') queensOn++;
      if (sq.color === 'w') matWhite += VALUE[sq.type];
      else matBlack += VALUE[sq.type];
    }
  }

  const turn = game.turn();
  const total = matWhite + matBlack;
  const fullmove = Number((fen.split(/\s+/)[5] || '1')) || 1;

  // 王在不在起始格，是"有没有易位"最直接的证据（不依赖 FEN 的易位权字段）
  const castled = (sq) => sq === 'g1' || sq === 'c1' || sq === 'g8' || sq === 'c8';
  const homeKing = (sq) => sq === 'e1' || sq === 'e8';

  // 阶段怎么定：只用一个朴素但够用的尺子 —— 还剩多少子力 + 走到第几回合。
  // 不求精确，它只决定"该参考开局原则还是残局原则"，选错了也不至于讲错棋。
  let phase;
  if (total <= 20 || (queensOn === 0 && total <= 26)) phase = 'endgame';
  else if (fullmove <= 10 && total >= 30) phase = 'opening';
  else phase = 'middlegame';

  return {
    turn,
    fullmove,
    matWhite,
    matBlack,
    matDiff: matWhite - matBlack,
    totalMaterial: total,
    queensOn,
    phase,
    kingSquare: kings,
    // 轮走方那一侧的王有没有易位
    moverCastled: castled(kings[turn]),
    moverKingHome: homeKing(kings[turn]),
    // 双方都没易位 → 中心攻王的经典场景
    bothUncastled: homeKing(kings.w) && homeKing(kings.b),
  };
}

/**
 * 只比较局面的前四个字段（棋盘、轮到谁、易位权、过路兵），
 * 忽略后面的半步计数和回合数。
 *
 * 用途：核对"这一步是从 A 走到 B"到底对不对。
 * 计数那两位是记账用的，两边算出来可能差一，不该因为这点差别就判定局面不一致。
 */
function samePosition(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ka = a.trim().split(/\s+/).slice(0, 4).join(' ');
  const kb = b.trim().split(/\s+/).slice(0, 4).join(' ');
  return ka.length > 0 && ka === kb;
}

/** 数一数盘面上双方各剩多少子力（兵为单位，白减黑） */
function materialOf(fen) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return 0;
  }
  let diff = 0;
  for (const row of game.board()) {
    for (const sq of row) {
      if (!sq || sq.type === 'k') continue;
      diff += (sq.color === 'w' ? 1 : -1) * (VALUE[sq.type] || 0);
    }
  }
  return diff;
}

/**
 * 沿一条变化线走一遍，看**某一方的子力最后净亏了多少**。
 *
 * 这是"这条线里有没有弃子"的确定性证据：
 * 引擎自己算出来的最佳线路里，如果一方走完这条线**净**少了 2 个兵以上的子力、
 * 评分却还是他好 —— 那基本就是弃子换来的东西。
 *
 * ⚠️ 为什么算**净变化**，而不是"中途亏得最深的那一下"：
 *    一次再普通不过的等价交换（他吃我一个马、我下一步吃回一个象），
 *    中途也会短暂亏空 3 个兵 —— 但那是兑子，不是弃子。
 *    早先这里取的是"中途最深"，于是**任何一条带兑子的主线**都会被判成
 *    "他弃了 3 个兵"，`isSacrifice` 几乎恒真，弃子类的战术母题和经典对局
 *    就被硬塞进每一次讲解里（正是 knowledge/index.js 开头最想避免的"硬套"）。
 *    取净变化才对得上"他最后确实少了子"这件事。
 *
 * 它不猜"这步是不是弃子"，只如实报告"这条线走完他还亏着多少子"。
 *
 * @returns {{drop:number, at:string|null, peak:number}}
 *   drop 净损失（兵为单位，正数；没亏就是 0）
 *   at   中途亏得最深的那一步（只作排查用）
 *   peak 那个最深的值（同上）
 */
function lineMaterialDrop(fen, sans, color, max = 8) {
  const trail = sanTrail(fen, sans, max);
  if (!trail.length) return { drop: 0, at: null, peak: 0 };

  const start = materialOf(fen);
  const sign = color === 'b' ? -1 : 1;
  let peak = 0;
  let at = null;
  let last = 0;

  for (const step of trail) {
    const now = materialOf(step.fen);
    // 以 color 自己的视角看：他掉了多少
    const drop = (start - now) * sign;
    if (drop > peak) { peak = drop; at = step.san; }
    last = drop;          // 最后一步的净值 = 走完整条线他还亏着多少
  }
  return { drop: Math.max(0, last), at, peak };
}

// ============================================================
// 把引擎的 (cp, mate) 变成「能相减的数」—— 只为算差距，不为展示
// ============================================================

const MATE_BASE = 100000;

/**
 * cp（厘兵）和 mate（几步行杀）本来是两种量纲，没法直接相减。
 * 但在「首选比次选好多少」这个问题上，它们必须是同一种东西 ——
 * 不然"首选 M2、次选 +0.5"这两条就没法排序。
 *
 * 换算规则：看到杀棋就压过任何普通分数，杀得越快越极端。
 * ⚠️ 这个数字**只用来比较和排序**，永远不会出现在提示词里 ——
 *    提示词里永远是引擎原样的 "+M2" / "-0.31"。
 *
 * 视角：传进来的 cp/mate 都是「白方视角」（engine.js 已经翻过），
 * 所以这里是绝对视角。谁问谁自己按颜色翻。
 */
function comparableScore(cp, mate) {
  const hasMate = mate !== null && mate !== undefined && Number.isFinite(mate);
  if (hasMate) {
    if (mate === 0) return -MATE_BASE;              // 已经被将杀了
    const v = MATE_BASE - Math.abs(mate) * 100;     // 越早将杀越极端
    return mate > 0 ? v : -v;
  }
  if (cp === null || cp === undefined || !Number.isFinite(cp)) return null;
  return cp;
}

/** 换算成「走棋方自己的视角」：同一个分数，白方 +1 就是黑方 -1 */
function forMover(score, color) {
  if (score === null) return null;
  return color === 'b' ? -score : score;
}

/**
 * 前几条候选到底差多少 —— 这是回答"是不是不得已只能这样走"的**算式**，
 * 不交给模型去感觉。
 *
 * 用「唯一解」这种结论是要有代价的：说错了比不说更坏。
 * 所以这里只在数据够（至少两条都有分）时才下结论，否则老实说不知道。
 *
 * @param {Array<{scoreCp:number|null, scoreMate:number|null}>} lines 从好到差
 * @param {'w'|'b'} color 谁在选择（走棋方）
 */
function choiceVerdict(lines, color) {
  // 先翻成"走棋方视角"，再从好到差排一遍。
  //
  // ⚠️ 排序不是多此一举：引擎给的候选理应已经排好了，但这条函数也接
  //    测试和别处拼出来的数据。一旦顺序颠倒，算出来的差会是负数，
  //    而负数会掉进"几乎一样好"那一支 —— 屏幕上就会把"唯一一步"
  //    说成"好几条路都行"。这种错法一点都不显眼，所以在这里堵死。
  const vals = (lines || [])
    .map((l) => forMover(comparableScore(l.scoreCp, l.scoreMate), color))
    .filter((v) => v !== null)
    .sort((a, b) => b - a);

  if (vals.length < 2) return { gapCp: null, kind: 'unknown' };

  const best = vals[0];
  const second = vals[1];
  const gap = best - second;      // 排过序了，所以这里 ≥ 0

  // 首选就是杀棋 —— 这时候"选哪一步"已经不是问题了
  if (best >= MATE_BASE - 10000) {
    return { gapCp: gap, kind: 'mate', best: vals, second };
  }

  // 引擎给的分几乎一样 → 这个局面确实有好几条路
  if (gap <= 20) return { gapCp: gap, kind: 'equal', second };
  if (gap <= 50) return { gapCp: gap, kind: 'slight', second };
  if (gap <= 150) return { gapCp: gap, kind: 'clear', second };

  // 次选差了一大截 —— 这才是"不得已只能这样走"的硬证据
  return { gapCp: gap, kind: 'only', second };
}

module.exports = {
  moveFacts,
  sanTrail,
  moveAnchor,
  positionProfile,
  samePosition,
  materialOf,
  lineMaterialDrop,
  comparableScore,
  forMover,
  choiceVerdict,
  normSan,
  // 战场一览（第四版新增）：威胁 / 防守 / 为什么是将杀
  flipTurn,
  turnFor,
  movesFor,
  loosePieces,
  immediateThreats,
  foeThreats,
  engineEffect,
  attacksFrom,
  pieceMap,
  // 第五版之二：线关系（牵制 / 穿刺）
  firstPieceBeyond,
  lineTactics,
  // 第六版之二：一步棋的"意图"（给谁补了保护 / 让谁没人守了）
  guardsOf,
  protectionDelta,
  // 第八版：两步之后会怎样（叉子这类组合）
  followUp,
  captureMenu,
  mateReason,
  MATE_BASE,
  PIECE_CN,
  VALUE,
};
