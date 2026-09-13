// ============================================================
// coach.js —— 把「鳕鱼算出来的事实」组装成「给 DeepSeek 的讲棋订单」
//
// 【这一层最核心的一个判断：数字由谁负责】
//
// 大语言模型不会下棋。它没有搜索树、不算变化，你问它"这步棋几分"，
// 它会给你编一个有零有整、语气笃定的数字 —— 而且编得很像真的。
// 这是它最危险的地方：不是它答不上来，是它答得比真的还像。
//
// 所以分工必须划死：
//
//     🐟 鳕鱼  负责「是什么」—— 该走哪步、局面前后几分、后续怎么走
//     🤖 DeepSeek 负责「为什么」—— 这步错在哪、对手想干什么、该记住什么
//
// 具体落到代码上就是两件事：
//   1. 这张「订单」里所有的数字都是我们从鳕鱼的输出里搬过来的原文；
//   2. 系统提示词里明写：不许自己产生任何数字。
//
// 【第二版补的三件事】（用户提的"提示词明显不足"）
//
//   ① 前后两个局面都给 FEN，后续每一步的 FEN 也一起给。
//      模型原来的处境是：只拿到"走完之后的棋盘 + 走了哪一步"，
//      得自己在脑子里**倒着走一步**才能还原走之前的局面 ——
//      Nf6 是哪个马动的、exd5 吃的是什么、吃过路兵怎么算，全在这里翻车。
//      现在它不需要推了，看就行。
//
//   ② 不止给一条主变化，给前三条候选（MultiPV）。
//      只报"本该走 g6"这一个答案，模型就没法说"g6 或者 Qe7 都守得住"。
//      更重要的是：候选之间的**分差**能回答一个原来根本答不了的问题 ——
//      这一步到底是真正的好棋，还是不得已只能这样走。
//
//   ③ 顺便把"这一步亏了多少"的将杀分支补上。
//      原来只在前后**都是 cp 分**时才算得出差值，一旦某侧是 mate，
//      整行就静默消失了 —— 偏偏"一步走成被将杀"这种最该讲清的局面全落在这一支。
//      现在算不出数字就给一句定性的话，不让整行缺席。
//
// 【第四版补的四件事】（用户提的"继续完善提示词 + 大幅降低幻觉"）
//
//   ① 局面给**三层**，按时间顺序排：再往前一手 / 走这一步之前 / 现在。
//      用户要的是"先判断对手上一步想干什么（威胁了我方哪个子、意在进攻还是防守），
//      再据此推理我方该怎么应对" —— 那一步改了什么，只能从"它走之前的局面"和
//      "它走之后的局面"的差别里读出来。所以提问顺序也改了：
//      第 1 问是意图，第 2 问才是这一步本身好不好，第 3 问落到"现在轮到谁、该怎么应对"
//      （引擎在**现在这个局面**给的最佳着法，正好就是给这一方的）。
//
//   ② 逐子走子规则写进 system。模型自己"发明"规则（最典型的是"给兵让出退路"——
//      兵根本不能后退）是这类讲解里最伤的一类错：它读起来像那么回事，而且完全无法察觉。
//      所以 system 里明写兵/马/象/车/后/王各自怎么走、被将军只有三种应法、
//      被牵住的子不能动，并且点名列了禁止说法。
//
//   ③ 每一个进提示词的着法都带**起止格锚点**（`Nc4（马 b2→c4）`）。
//      起因是一个真 bug：两个同类子"看起来"都能到同一格、实际只有一个合法
//      （另一个走了会送将）时，记谱**只写着法名、不写是哪一个**。
//      光给一个 Nc4，模型只能猜是哪个马 —— 猜错就是一次严重的幻觉。
//      现在锚点由 chess.js 按规则复算，模型不需要猜（见 position.js 的 anchorOf）。
//
//   ④ 严格接地：只能用给过的棋子/格子/着法/评分；没给的就说"看不出来"，
//      不许用"应该/大概"糊、不许自己补变化、不许替对手想应着。
//      "再往前一手"那一层同样要自证（prevFen 走出 prevSan 必须得到 beforeFen），
//      接不上就整段丢掉 —— 见 server.js。
//
// 第五版补的两件事（用户："把能改的地方改好" + 样例第 9 步抓到的两处幻觉）
//
//   ① 空的项不再写出来：早先渲染器会打印"能吃到对方的子：没有"，
//      模型就照着念"表里这一栏是空的" —— 用户管这叫空话。
//      现在没有的行就不存在，守卫句也不提"表""栏"。
//
//   ② 每个动过的子附一张**按规则算出来的去向表**（pieceMap）：
//      "d2 的后盯着 d6"这种幻觉的根因是安静局面下我们什么都没喂，
//      模型只好自己去推格子关系。表里没有的格就是走不到，它没得推。
//
// 第六版补的两件事（用户：修复"把引擎第 5 手说成眼下威胁"）
//
//   ① 变化线每一步带上 **[序号]** 和一句"这是假想线，只有 [1] 是现在能走的"，
//      系统提示词里也写清 [2] 以后要等前面走完才轮得到。见 renderTrail。
//   ② 新增【线关系】（牵制 / 穿刺，见 position.js 的 lineTactics）：
//      模型当时想指的 a5-c3-d2 那条线是**真实存在**的，
//      但它没这个事实，只好编成"d2 后和 c3 马共处一条线"。现在给它现成的。
//
// 第七版补的两件事（用户：样例第 19 步 19...Kd8，"对这一步棋的想法描述得不知所云"）
//
//   ① 【这一步给谁补了保护 / 让谁没人守了】—— 见 position.js 的 protectionDelta。
//      "这步棋想干什么"其实是一句**前后对比**：走之前守着 c7 的象的只有 c8 的车，
//      走之后多了 d8 的王（这就是意图）；走之前守着 f7 的兵的是 e8 的王，
//      走之后没人了（这就是代价）。两条都能纯算出来。
//      在此之前，材料里关于"意图"是空的 —— 王被排除在"护住"之外，安静局面下战场一览也为空，
//      模型只好去候选表里抓了一条最像的（候选 Rd8 vs 实际 Kd8，同一个落点），还讲反了方向。
//   ② 提示词里把"意图"变成**三选一**（守住了谁 / 盯上了谁 / 让出了什么），
//      并堵死两条歪路：不许拿候选倒推意图（尤其"另一个子走同一个格"）；
//      引用【线关系】必须点出两边的子，不许把那条线挪到第三个子头上。
//
// 所有这些推导都在代码里做完（幂等、可复算），模型只负责把结论讲成人话。
// 具体的事实提取见 position.js，战术知识见 knowledge/。
// ============================================================

const {
  moveFacts, sanTrail, moveAnchor, positionProfile, samePosition, lineMaterialDrop,
  choiceVerdict, normSan, PIECE_CN,
  // 战场一览（第四版）：威胁 / 防守 / 为什么是将杀
  loosePieces, immediateThreats, foeThreats, engineEffect, mateReason,
  // 第五版：一个子"到底能去哪"（治"d2 的后盯着 d6"那类幻觉）
  pieceMap,
  // 第六版：线关系（牵制 / 穿刺）—— 治"那是第 5 手的着法，却说成眼下的威胁"
  lineTactics,
  // 第七版：一步棋的"意图"（给谁补了保护 / 让谁没人守了）
  protectionDelta,
  // 第八版：两步之后会怎样（叉子这类组合）
  followUp,
} = require('./position');
const { buildKnowledge } = require('./knowledge');

// ---------- 提示词的篇幅预算 ----------
// 这些数字是"给模型看多少"的闸门。它们直接影响每次讲棋的 token 开销，
// 也影响模型会不会被淹掉。调大之前先想清楚：多给它三行，真的能多讲对一句吗？
const MAX_CANDIDATES = 3;   // 每个局面最多列前三条候选
const TRAIL_MAIN = 8;       // 主变化往下推几步（带每步之后的 FEN）
const TRAIL_ALT = 4;        // 次优解往下推几步（它有主变化就够，别抢戏）

/**
 * 这组评分里到底有没有东西？
 * cp（厘兵差）和 mate（几步行杀）任意一个有值就算有 ——
 * 将杀局面下引擎只给 mate，这时候不能因为"没有 cp"就当成没数据。
 */
function hasScore(cp, mate) {
  return (cp !== null && cp !== undefined) || (mate !== null && mate !== undefined);
}

/**
 * 引擎评分的口头说法。和前端 eval.js 的那套是两回事，各服务各的展示。
 *
 * ⚠️ 关于 mate 的措辞：只说"能算到将杀"，**不说是谁将杀谁**。
 *    因为视角是调用方给的（pov），而"谁将杀谁"在这句话里靠 pov 反推很容易讲反。
 *    要指名道姓的地方（比如"黑方这一步亏了多少"），由调用方在外面把话说全。
 */
function describeEval(cp, mate, pov = 'w') {
  const sign = pov === 'b' ? -1 : 1;   // 统一翻成「提问方的视角」

  if (mate !== null && mate !== undefined && mate !== 0) {
    const m = mate * sign;
    return m > 0
      ? '已经能算到将杀（' + Math.abs(mate) + ' 步内）'
      : '已经能被算到将杀（' + Math.abs(mate) + ' 步内）';
  }
  if (mate === 0) return '已经将杀';
  if (cp === null || cp === undefined) return '没算出来';

  const p = (cp * sign) / 100;
  const a = Math.abs(p);
  // ⚠️ p 已经翻成「提问方视角」了，所以 p > 0 表示**提问方**占优，
  //    不能一律写成"白方"：pov='b' 时那样整句话会反。
  //    （mate 那两句刻意不点名是谁将杀谁，就是为了避开这个问题。）
  const better = pov === 'b' ? '黑方' : '白方';
  const worse = pov === 'b' ? '白方' : '黑方';
  const who = p > 0 ? better : worse;
  const amount = a >= 10 ? Math.round(a) + ' 个兵' : a.toFixed(2) + ' 个兵';

  if (a < 0.3) return '基本均势';
  if (a < 1.0) return who + '稍好一点（约 ' + amount + '）';
  if (a < 2.0) return who + '明显占优（约 ' + amount + '）';
  if (a < 5.0) return who + '大优（约 ' + amount + '）';
  return who + '胜势（约 ' + amount + '）';
}

/** 把 -417 变成 "-4.17" */
function scoreToText(cp, mate) {
  if (mate !== null && mate !== undefined) {
    if (mate === 0) return '#';
    return (mate > 0 ? '+' : '-') + 'M' + Math.abs(mate);
  }
  if (cp === null || cp === undefined) return '—';
  const pawns = cp / 100;
  const shown = Math.abs(pawns) >= 10 ? Math.round(pawns) : pawns.toFixed(2);
  return (pawns > 0 ? '+' : '') + shown;
}

/** 走棋方是谁 → "执白" / "执黑" */
function whoName(color) {
  return color === 'b' ? '黑方' : '白方';
}

/** 从 FEN 里读「轮到谁走」 */
function turnOf(fen) {
  return (String(fen || '').split(/\s+/)[1] === 'b') ? 'b' : 'w';
}

// ============================================================
// 系统提示词
// ============================================================

const SYSTEM_PROMPT = [
  '你是一位面向业余爱好者的国际象棋教练，正在陪学生复盘一盘棋。',
  '',
  '【第一条规矩：只依据我给的东西说话】',
  '下面给你的局面、评分、着法，都是 Stockfish（世界顶级引擎）搜出来的硬数据，或者是我按',
  '规则逐格复算的事实。你负责**解释**，不负责搜索、不负责摆棋盘、也不负责替双方想招。',
  '',
  '- 只用我给过的棋子、格子、着法、评分。**绝对不要**引入我没给的子、没给的格、',
  '  没给的着法、没给的数字。',
  '- 不要自己判断"这步棋好不好"、也不要自己给局面打分 —— 好坏的依据只有上面给的',
  '  评分前后变化，你负责讲**为什么**会变成这个结果。',
  '- **没给的就是没有。** 哪一点材料里没写，就直接说"这一点我看不出来"，然后讲下一件',
  '  说得清的事。**不许**用"应该 / 大概 / 可能"含糊过去，**不许**自己补一条变化，',
  '  **不许**替对手想好他会怎么应，也不要为了讲圆而编。',
  '- 每说一个具体主张，都要能指回上面某一行（哪个局面、哪条评分、哪条候选）；',
  '  指不回去的就别说。',
  '- **不要向读者描述这份材料本身。** "按上面给出的表""单子里没有给""这一栏是空的"',
  '  这类话读者无从理解 —— 你是教练，不是在解释你的资料。',
  '  ⚠️ 材料里的**段名、行首标记、"我看了哪一行"这类话，正文里一个字都不许出现**：',
  '  不写"写在【某某】里""★ 那一行说""上面写着"。事实要**直接讲出来** ——',
  '  不是"代价立刻写在【线关系】里"，而是"c3 的马后面就是 d2 的后，马一让开，a5 的后就能吃到它"。',
  '',
  '【第二条规矩：每提到一个子怎么走，先按规则核对】',
  '国际象棋的走子规则很硬，说错一句整段讲解就废了。要说"某个子能走到某个格"，',
  '先核对三件事：那个格上是不是自己的子（不能吃自己的子）；中间有没有挡子；',
  '走完之后自己的王会不会被将军（会的话这一步**规则上根本不允许**）。规则速查：',
  '',
  '- **兵**：只往自己前方走（白兵往上、黑兵往下），**永远不能后退、不能横走**。第一步可以',
  '  一次走两格（中间那格必须空）。**斜走一格才是吃子**，直着走不能吃子、斜着不吃也不行，',
  '  到底线必须升变。吃过路兵：对方的兵刚一步走两格、和你的兵并排时才能吃，被吃的那个兵',
  '  **不在你落到的格子上**。⚠️ 所以"给兵让出退路""把兵往后撤"这类说法**全是错的**。',
  '- **马**：走"日"字（一直一斜）。它是**唯一能跳过别的棋子**的子 —— 只要落脚格不是',
  '  自己的子就能走，四周被围死也照样能跳。',
  '- **象**：只斜着走，距离不限，**中间不能有任何子挡着**；一辈子只在自己那种颜色的格上活动。',
  '- **车**：只横着或竖着走，距离不限，**中间不能有任何子挡着**。',
  '- **后**：横、竖、斜都行，距离不限，同样**中间不能有子**。它就是车 + 象的合体。',
  '- **王**：一次只走一格（横竖斜都行），**不能走到对方能吃到的格子上**（等于送将），两个王',
  '  也不能贴在一起。易位：王和那个车都得从没动过、中间两格全空、王现在没被将军、王经过和',
  '  落到的格子都不能被攻击。',
  '- **被将军时只有三种应法**：吃掉将军的子、垫一个子在中间、把王挪开；别的着法都不合法。',
  '- **被牵住（钉住）的子不能动**：它一动，后面的王就被将军了。这种"看起来能走、其实走不了"',
  '  的子最容易搞错 —— 说某个子能去某个格之前，先确认它没有被牵住。',
  '',
  '拿不准就别下结论。可以说"这一步的合法性我没法从上面的材料确认"，但不要编一个走法出来。',
  '',
  '【单子里的局面怎么用：先看走棋方想干什么，再看另一方怎么应对】',
  '单子会按时间顺序给你局面（可能有三层：再往前一手 / 走这一步之前 / 现在），以及这一步',
  '到底是哪个子从哪一格走到哪一格。请**先判断走棋方这一步的意图**，再谈别的。',
  '',
  '⚠️ **"它想干什么"只能从下面三条里挑，都要指名道姓**（哪个子、哪一格）：',
  '1. **它守住了谁** —— 材料里有一段专门写"这一步给谁补了保护 / 让谁没人守了"，',
  '   其中"★ 补了保护"那行通常就是答案（"王挪到 d8，是去补那个被车盯着的象"），',
  '   而"★ 失去了保护"那行是这步棋**付出的代价**，往往正是它错在哪。',
  '2. **它盯上了谁** —— 看"这一步动过的那个子能去哪"里"能吃到对方的子"那一行，',
  '   或者"现在能白吃 / 一步将杀"那几行。',
  '   ⚠️ **不许说某只王（或任何子）能吃掉某个子，除非它就写在"能吃到对方的子"那一行里。**',
  '   材料里专门有一行标着"吃不了的对方子"，连谁守着那一格都写了 —— 那才是真话。',
  '   看着挨得近就以为能吃、以为王能吃掉身边被保护的兵，是最典型的一种编'
    + '（残局里尤其容易）。',
  '3. **它让出了什么** —— 它从哪一格走开的（只有材料明写了的时候才能讲）。',
  '',
  '三条一条都对不上、或者材料里没有那一段，就**直接写"这步棋有什么具体目的，我看不出来"**，',
  '然后只讲后果。**这是允许的老实回答，不算空话** —— 比替它编一个故事好一百倍。',
  '',
  '⚠️ **没分量的话不要说**：一个子**本来就有子守着**、再加一个守着，不算"补强"；',
  '局面里摆着的悬子，也不等于就是这一步造成的。讲不出这一步的道理时，',
  '宁可写"这步的道理比较深，从材料里看不出来" —— **留白比编一个理由强**。',
  '',
  '⚠️ 材料里"**没人保护的子**""**对方的威胁**"那几行说的是**这个局面本身的状况**',
  '（可能已经悬了好几手），**不等于**这一步造成的。**不许**说这一步"顺手补上了"某个漏洞、',
  '也不许说某个悬子是被这一步弄丢的 —— 要讲"这一步改变了谁的保护"，只能引用专门写那个的',
  '那一段（"补了保护 / 失去了保护"）。',
  '',
  '⚠️ **"守着谁"这块最容易弄反方向，记牢：**',
  '- 材料写"守它的子：……现在又多了 d8 的王"，**意思是这只王在守别人**（被守的是那一行',
  '  开头点名的那个子），**不是**"王被守住了"。主语是守人的那一方。',
  '- **王永远不出现在"被守 / 被补保护 / 没人守"这一侧**（王不能被吃，材料里不会有这种事实）。',
  '  **绝对不许**说"给 g1 的王补上了保护""王没人守了"。想说"这只王这一手没事了"，',
  '  只能落到具体事实上：**挡住了哪一步**（材料写了"把某某威胁挡掉了"才算），',
  '  或者**守住了哪个子**。',
  '- ❌ **不许拿"引擎的候选"倒推它想干什么。** 候选是"他**没有**走的路"，只能用来做对照',
  '  （"本该走的是 X"）。尤其候选里是**另一个子**走到**同一个格**时（候选 Rd8、实际 Kd8）：',
  '  一个子**占住**那一格只会**妨碍**那一步，**绝对不许**说成"他把这一格让给那个车"。',
  '- ❌ **不许说某一步"躲开了谁的压力""摆脱了牵制""让开了某条线"**，除非材料里明写了',
  '  那个子正盯着它。',
  '- 对方现在有什么现成的应手或反击？只能在材料给了的着法/候选里找，没给就别编。',
  '',
  '【记谱（SAN）有一个坑，务必照我说的做】',
  '两个同类棋子都能走到同一格时，记谱才会写成 Nbd2 / N1d2 这种带区分的写法。',
  '但还有另一种情况：两个同类子**看起来**都能去那个格，实际只有**一个合法**',
  '（另一个走了会把自己的王暴露 = 送将）。这时候记谱**只写 Nc4，不说是哪一个**。',
  '',
  '- 我给引擎的每一条建议、每一步变化，后面都用括号标明了动手的子、从哪到哪，',
  '  例如 `Nc4（马 b2→c4）`、`exd5（兵 e4×d5）`（× 表示吃子）。',
  '  **一律以括号里的起止格为准**：不要去猜，也不要说成另一个子。',
  '- "这一步实际发生的事"那一行是我按规则复算出来的原话，直接用它的说法。',
  '- 万一某一步只有光秃秃一个着法名、没有起止格：只说"某个马 / 某个兵"，',
  '  **绝对不要**替它编一个起止格。',
  '',
  '【候选着法怎么用】',
  '同一个局面下引擎排出来的前几条选择，带评分。**它们之间的分差才是关键**：',
  '分差很小，说明这个局面本来就有好几条路都能走；分差很大，才说明"只能这样走"。',
  '所以**不要**在好几条路都行的时候讲成"错过了一步好棋"，也**不要**在引擎只留了',
  '一条路的时候硬说"其实还有别的选择"。',
  '',
  '【"后续那几手"是假想线，不是现在的威胁 —— 这里最容易讲错】',
  '材料里"接下来大概是…"那一串是引擎顺着一条线往下推的**假想走势**（每行都有 [1][2][3] 序号），',
  '还有一段"顺着引擎那条线走两步"是同一件事算得更细：',
  '- **只有 [1] 是现在就能走的**。从 [2] 起，都要先假设前面那几步都按这条线走过了。',
  '  所以**绝对不要**把 [2] 以后的着法说成"他现在威胁要…""他下一步就…"；',
  '  要提就得说清位置，比如"这条线走到第 3 手才是 X"。',
  '- 也别把后面那几手里的子说成"正盯着某个格"—— 那是假想局面里的事。',
  '  现在真正成立的威胁只写在"现在能白吃 / 一步将杀"那几行里。',
  '- 材料写了"对方一共有 N 个合法着法"时：N=1 才是字面意义的"他只能这样走"，',
  '  N>1 时第 [2] 步只是引擎挑的一个应手，**不许**讲成必走。',
  '- 不要给这条线添着法，也不要从里面挑一手出来说"他应该这样走"。',
'',
'【怎么讲】',
  '- 听众懂规则、看得懂记谱，但没有系统学过棋理。术语可以用，用了顺手解释一句。',
  '- 说具体的东西：哪个棋子、哪条线、哪个格子、什么威胁；不要写"要注意王的安全"这种',
  '  放到哪盘棋都成立的空话。如果评分变化很大，那说明有东西被漏掉了 —— 把它找出来讲清楚。',
  '- 单子末尾可能附一小段「战术参考」，那是通用知识，不是对这盘棋的判断：只有当你能在上面',
  '  的事实里指出对应的着法时才提它，对不上就别硬套 —— 叫错一个战术名字比不叫更糟。',
  '- 不要开场白、不要"希望对你有帮助"之类的结尾，直接讲棋。',
  '- 篇幅 150 到 250 字。宁可把两点讲准，不要含糊地讲五点。',
  '  （候选有几条，最多用一句话交代它们的差距，不要逐条点评。）',
  '',
  '【三条硬禁令 —— 这是最容易犯、也最没价值的三种写法】',
  '1. **不许罗列"没发生的事"**："这一步没有吃子、没有将军""它没有直接打黑方哪个子"',
  '   这种否定清单信息量为零。要表达"这是一步安静的准备着"，就写"安静的一步"，',
  '   然后讲它准备做什么。同理，某条事实没给你时，不要写"它没有攻击任何一个子"',
  '   "这条线上没有威胁"这种替"空"做总结的话。',
  '   ⚠️ 悬着的子也**不许一笔带过**（"先搁着""先不管它""留着后面再说"）：',
  '   要么指名道姓说清"哪个子被谁盯着、吃完能不能吃回"，要么干脆不提。',
  '2. **不许复述评分**：正文里不出现任何评分数字，也不写"引擎认为""评分显示"',
  '   "分数从…变成…"—— 那些数字界面上已经单列了，你要讲的是**为什么**。',
  '3. **每一句话里至少要有一个具体的子或者格子**（"f7 的兵""c4 的象"这样）。',
  '   写不出具体子/格的句子就是空话，删掉。',
  '',
  '【关于"谁盯着哪个格"—— 这里最容易编，规矩最严】',
  '远程子（后、车、象）的线路会被**任何**子挡住，**包括自己的子** —— 所以"后和象一起盯着',
  'd6"这种话，只要那条线上有一个自己的兵就是错的，而 FEN 看不出**挡在中间**的是谁。所以：',
  '· 材料说过的"它现在能去哪儿"，那份落点就是**一个不漏**的 —— 上面没提到的格子，',
  '  那个子就是到不了。**只说它到得了的格子**，不要提别处的格子。',
  '· 材料没说它能去哪的子，就不要对它做"盯着某个格""护住某个格"这种断言；',
  '  那时候把话说粗一点（"这一带"），**绝对不要点出具体格子**。',
  '· 材料里会单独列出"谁挡在谁前面"的那种线（牵制 / 穿刺）。这类话**只能引用那里列出来的**：',
  '  它没提到的子，就不许说它被谁盯着，也不许替它编"挡在谁前面""和谁在一条线上"。',
  '  引用时**必须把两边的子都点出来**（"c6 的车盯着 c7 的象"）—— 那条线讲的是**那两个子**',
  '  之间的事，**不许**把它挪到第三个子头上。',
  '',
  '【示范：一手棋的好讲评长什么样】',
  '（下面这是**另一盘棋**的局面，只学它怎么用事实，不要把内容抄进这盘棋。）',
  '',
  '事实（节选）：黑方走了 Nf6（马 g8→f6）；f7 的兵没人保护（被 c4 的象盯着）；',
  '白方的威胁是一步将杀 Qxf7#；引擎本该走 g6 —— 它挡掉了 Qxf7#，也把 f7 救了回来。',
  '',
  '讲评：',
  '这一步走错了方向。它确实盯上了 h5 的后和 e4 的兵，但白方根本不用管它 —— f7 那个兵本来',
  '就悬着，白方**直接吃上去就是将杀**（Qxf7#），黑方连一个合法着法都没有；为什么王吃不了',
  '那个后？因为 c4 的象在后面看着它。该走的是 g6：既挡掉这个将杀，也把 f7 救回来 ——',
  '两者差在**有没有管 f7**。',
  '',
  '【格式】',
  '用 Markdown，但只允许这几种：短段落、**加粗**、以 "- " 开头的列表项。',
  '不要标题、不要表格、不要代码块、不要引用块。',
  '⚠️ **正文写完之后，最后另起一行，写一行"要点"**，格式固定为：',
  '`【要点】` 后面接**一句话、30 字以内**，写"这一手最该记住的是什么"',
  '（例如"【要点】补了 c3 的马，但把后放进了 a5 的线"）。',
  '这一行会被单独收起来当这盘棋的记忆，**不要把它写进正文的句子里**，也不要写成两句。',
  '⚠️ 正文末尾**不要再另写一段"总结/要点"** —— 那件事交给最后这一行，写两遍就是废话。',
  '如果材料里这一手确实没什么可说的，就写"【要点】这手看不出明确目的"，不要编。',
  '',
  '【材料里可能带一段"之前几手讲过什么"】',
  '那是这盘棋**前几手**的结论（不是这一手的），带着它只是让你讲得有脉络。',
  '- 可以呼应它（"前面说过的 f7 那个漏，这里正是它兑现的时候"），但**不许照抄**，',
  '  也不许把它当成这一手的事实（比如把上一手说过的话再讲一遍当成本手的情况）。',
  '  两者冲突时，**一律以这一手的新材料为准**。',
].join('\n');

// ============================================================
// 提示词里的各种「零件」
// ============================================================

/**
 * 把一个引擎结果拆成「候选列表」：第 1 条是主变化，后面接 MultiPV 的次优解。
 *
 * 只保留有着法名的 —— 没有着法名就画不出后续线，列出来只是一行数字，
 * 对这种"讲清每一步怎么走"的任务没有价值。
 */
function candidatesOf(eng) {
  if (!eng || typeof eng !== 'object') return [];

  const list = [];
  // ⚠️ 没有着法名的候选一律丢掉：画不出后续线、也没法跟他实际走的那一步比对，
  //    留在这里只会让"他走的排第几"算出一个错答案。
  if (eng.bestMoveSan) {
    list.push({
      rank: 1,
      firstMoveSan: eng.bestMoveSan,
      scoreCp: numOrNull(eng.scoreCp),
      scoreMate: numOrNull(eng.scoreMate),
      pvSan: Array.isArray(eng.pvSan) ? eng.pvSan : [],
    });
  }

  const alts = Array.isArray(eng.alternatives) ? eng.alternatives : [];
  for (const a of alts) {
    if (!a || typeof a !== 'object' || !a.firstMoveSan) continue;
    if (list.some((c) => normSan(c.firstMoveSan) === normSan(a.firstMoveSan))) continue;
    list.push({
      rank: Number(a.rank) || (list.length + 1),
      firstMoveSan: a.firstMoveSan,
      scoreCp: numOrNull(a.scoreCp),
      scoreMate: numOrNull(a.scoreMate),
      pvSan: Array.isArray(a.pvSan) ? a.pvSan : [],
    });
  }

  return list.slice(0, MAX_CANDIDATES);
}

/**
 * 候选表：① g6（马 g8→g6）   评分 -0.31（黑方稍好一点…）
 *
 * ⚠️ 括号里那个「动手的子 + 起止格」是**防幻觉的关键**，别删：
 *    记谱在"两个同类子看起来都能去那个格、实际只有一个合法"时是不写是哪一个的
 *    （见 anchorOf 的说明）。只给一个光秃秃的 `g6`，模型就可能把它说成另一个子 ——
 *    而这一步恰恰是它最容易编的地方。
 *
 * @param {Array} list candidatesOf() 的输出
 * @param {string} indent 前缀缩进
 * @param {string} fen 这些着法是在**哪个局面**下走的（算起止格要用它）
 */
function renderCandidates(list, indent = '  ', fen = '', playedSan = '') {
  const out = [];
  list.forEach((c, i) => {
    const seq = ['①', '②', '③'][i] || (i + 1) + '.';
    const score = scoreToText(c.scoreCp, c.scoreMate);
    const talk = hasScore(c.scoreCp, c.scoreMate)
      ? '（' + describeEval(c.scoreCp, c.scoreMate, 'w') + '）'
      : '';
    const anchor = (fen && c.firstMoveSan) ? moveAnchor(fen, c.firstMoveSan) : '';
    // ⚠️ 他实际走的那一条要**就地标出来**。
    //    用户抓到过一次：材料里明明写着"引擎建议的是 Nd2（这一步没有被走）",
    //    模型在正文里却说成了"这一步正是引擎的首选" —— 因为它看到自己那一步就在候选表里。
    //    在列表里直接打记号，比在别处再说一遍管用。
    const isPlayed = playedSan && c.firstMoveSan &&
      normSan(c.firstMoveSan) === normSan(playedSan);
    out.push(indent + seq + ' ' + (c.firstMoveSan || '（没说）') +
      (anchor ? '（' + anchor + '）' : '') + '   评分 ' + score + '  ' + talk +
      (isPlayed ? '   ← **他实际走的就是这一条**' : ''));
  });
  return out;
}

/**
 * 把「候选之间的分差」翻译成一句结论。
 * 这是整张单子里新加的、也是最能防住"硬批评一步好棋"的一句话。
 */
function verdictText(v, playedRank) {
  const pawn = (cp) => (cp / 100).toFixed(2) + ' 个兵';
  const out = [];

  if (v.kind === 'mate') {
    out.push('→ 引擎的首选就已经带着杀棋了 —— 到了这个地步，"选哪一步"已经不是重点。');
  } else if (v.kind === 'equal') {
    out.push('→ 首选和次选几乎一样好（只差约 ' + pawn(v.gapCp) + '）：' +
      '这个局面有好几条路都能走，**不存在"唯一解"**。');
  } else if (v.kind === 'slight') {
    out.push('→ 首选比次选略好一点（约 ' + pawn(v.gapCp) + '），但次选也走得。');
  } else if (v.kind === 'clear') {
    out.push('→ 首选比次选明显好（约 ' + pawn(v.gapCp) + '）—— 这个局面的选择是有讲究的。');
  } else if (v.kind === 'only') {
    out.push('→ 首选比次选好了约 ' + pawn(v.gapCp) + '：**这是唯一能撑住的一步**，' +
      '别的走法都要明显吃亏。（这通常说明局面本身已经很紧张，不是他选择失误。）');
  }

  if (playedRank === 0) {
    out.push('→ 他实际走的，正是引擎的首选。');
  } else if (playedRank > 0) {
    out.push('→ 他实际走的这一步，是引擎的第 ' + (playedRank + 1) + ' 选择。');
  } else if (playedRank === -1) {
    out.push('→ 他实际走的这一步**不在**上面这几条里。');
  }
  return out;
}

/** 一条变化线：每一步之后都给 FEN。
 * 用户要的"让模型看见棋盘怎么一步步变"就是这一段。
 *
 * ⚠️ 每一步都带上起止格（`Nf6（马 g8→f6）`）：变化线里的着法名同样是"看着像能走、
 *    实际只有一个合法"的重灾区，只给 Nf6 模型就可能说成另一个子。见 anchorOf。
 */
function renderTrail(fen, sans, max, label = '  引擎预想的后续') {
  const trail = sanTrail(fen, sans, max);
  if (!trail.length) return [];

  const out = [label + '（每行末尾就是这个局面走完这一步之后的完整 FEN）：'];
  if (trail.length > 1) {
    out.push('    ⚠️ 这是假想线：只有 [1] 是现在就能走的，[2] 以后都要先走完前面才轮得到。');
  }
  trail.forEach((t, i) => {
    out.push('    [' + (i + 1) + '] ' + whoName(t.mover) + ' ' + t.san +
      (t.anchor ? '（' + t.anchor + '）' : '') +
      (t.isMate ? '（将杀）' : '') + ' →  ' + t.fen);
  });
  return out;
}

// ============================================================
// 第四版新增的三段：战场一览 / 引擎这一手在干什么 / 为什么是将杀
//
// 【为什么非要有】
// 提示词里一直在问"这一步威胁了谁的哪个子""你该怎么应对"，
// 但在第四版之前，它手上关于"威胁"的全部材料只有几个 FEN ——
// 而"从 FEN 里看出攻击关系"恰恰是这个项目一开始就认定模型做不好的事。
// 结果它只能泛泛地说"施加压力"，或者干脆把引擎评分复述一遍。
//
// 这三段里的每一个字都是按规则复算出来的（见 position.js），
// 模型不需要推，照着引用就行。
// ============================================================

/** 把 [{san,pieceCn,from,to,...}] 说成"Qxf7#（后 h5×f7）"这种带起止格的样子 */
function moveListText(list, verb) {
  return list.map((m) => m.san + '（' + verb + ' ' + m.from + '×' + m.to + '）').join('、');
}

/** 把战场一览要用的东西一次算齐（算一次，渲染和后面复用同一份） */
function collectBattlefield(fen, color) {
  const empty = { own: null, ownLoose: [], foeLoose: [], foeTh: null, foe: color === 'b' ? 'w' : 'b' };
  if (!fen) return empty;
  try {
    return {
      own: immediateThreats(fen),
      ownLoose: loosePieces(fen, color),
      foeLoose: loosePieces(fen, color === 'b' ? 'w' : 'b'),
      foeTh: foeThreats(fen),
      foe: color === 'b' ? 'w' : 'b',
    };
  } catch {
    return empty;
  }
}

/**
 * 【战场一览】现在轮到谁、他能一步得手什么、对方威胁什么、谁的子悬着。
 */
function renderBattlefield({ fen, color }) {
  const out = [];
  if (!fen) return out;

  const bf = collectBattlefield(fen, color);
  const side = whoName(color);
  const { own, ownLoose, foeLoose, foeTh, foe } = bf;

  const ownGain = !!(own && (own.mates.length || own.wins.length));
  const foeGain = !!(foeTh && (foeTh.mates.length || foeTh.wins.length));
  if (!ownGain && !foeGain && !ownLoose.length && !foeLoose.length) return out;

  out.push('【战场一览（按规则复算出来的，不是猜的 —— 可以直接引用）】');
  out.push('现在轮到' + side + '走。');

  if (own && own.mates.length) {
    out.push('· ' + side + '现在有一步将杀：' + moveListText(own.mates, '将军的子走'));
  }
  if (own && own.wins.length) {
    out.push('· ' + side + '现在能白吃（吃了对方吃不回来）：' +
      own.wins.map((w) => w.san + '（用 ' + w.from + ' 的' + w.pieceCn +
        '吃 ' + w.to + ' 的' + w.capturedCn + '）').join('、'));
  }
  if (foeGain) {
    const bits = [];
    if (foeTh.mates.length) bits.push('一步将杀 ' + foeTh.mates.map((m) => m.san).join('、'));
    if (foeTh.wins.length) bits.push('白吃 ' + foeTh.wins.map((w) => w.san).join('、'));
    out.push('· ★ **' + whoName(foe) + '的威胁**（这个局面如果轮到他走，他一步就能得手）：' +
      bits.join('；'));
    // 轮到走的一方自己也有狠招时，提醒它先看谁：谁先动手谁说了算。
    // （不写死成"这是必须处理的"，因为白方有杀棋时那条威胁根本轮不到他走。）
    if (ownGain) {
      out.push('  （注意：上面' + side + '自己也有一步得手的 —— 谁先动手谁说了算，' +
        '先看' + side + '那一条；只有当' + side + '没有更狠的手段时，' +
        whoName(foe) + '这个威胁才是必须处理的。）');
    }
  }
  if (ownLoose.length) {
    out.push('· ' + side + '这边没人保护的子：' + ownLoose.map((x) =>
      x.pieceCn + ' ' + x.square + '（' + x.attackerText + '盯着，而自己这边吃回来不合法）').join('；'));
  }
  if (foeLoose.length) {
    out.push('· ' + whoName(foe) + '那边没人保护的子：' + foeLoose.map((x) =>
      x.pieceCn + ' ' + x.square + '（' + x.attackerText + '盯着）').join('；'));
  }
  out.push('（"没人保护"是按规则算的：他被吃之后，自己这一方**没有合法的着法**吃回来。）');
  out.push('');
  return out;
}

/**
 * 【引擎推荐的那一手在干什么】—— 把"防守"变成一句有据可查的事实。
 */
function renderEngineEffect(eff) {
  const out = [];
  if (!eff) return out;

  out.push('【引擎推荐的那一手在干什么】' + eff.san + '（' + eff.anchor + '）');
  if (eff.selfIsMate) {
    // 将杀就是终局：后面"挡掉了什么""还剩什么悬子"全都没意义了，别堆噪音。
    out.push('· 它**本身就是那一步将杀** —— 引擎直接动手，一步结束。');
    out.push('');
    return out;
  }
  if (eff.selfIsWin) {
    out.push('· 它**本身就是那一次白吃**（对方吃不回来）。');
  }

  const stopped = []
    .concat(eff.stoppedMates.map((m) => '一步将杀 ' + m.san))
    .concat(eff.stoppedWins.map((w) => '白吃 ' + w.san));
  if (stopped.length) {
    out.push('· 它把对方的威胁**挡掉了**：' + stopped.join('、') +
      ' —— 走完这一手之后，对方这些一步得手全都做不成了。');
  }

  const left = []
    .concat(eff.leftMates.map((m) => '一步将杀 ' + m.san))
    .concat(eff.leftWins.map((w) => '白吃 ' + w.san));
  if (left.length && !eff.selfIsWin) {
    out.push('· 注意：走完这一手之后，对方**照样**能：' + left.join('、') +
      ' —— 也就是说这一手没能挡住它（局面本身已经很难了，引擎只是在拖）。');
  }

  if (eff.looseFixed.length) {
    out.push('· 它把自己这边悬着的子救回来了：' +
      eff.looseFixed.map((x) => x.pieceCn + ' ' + x.square).join('、'));
  }
  if (eff.looseLeft.length) {
    out.push('· 走完它之后，自己这边仍然没人保护的子：' +
      eff.looseLeft.map((x) => x.pieceCn + ' ' + x.square).join('、'));
  }
  out.push('');
  return out;
}

/**
 * 【这一步动过的那个子能去哪】—— 吃谁、护谁、还能落到哪些空格。
 *
 * 【为什么必须有这一段】
 * 用户在样例第 9 步（Qd2）抓到一个幻觉：模型说"d2 的后和 f4 的象一起盯住了 d6 格"。
 * 而 d 线往上第一个子就是 d4 自己的兵，后根本看不到 d6。
 *
 * 根因不是"喂错了"，是这种**安静局面**上我们什么都没喂：
 * Qd2 这步没人一步将杀、也没人悬着，所以【战场一览】整段为空 ——
 * 模型手上又只剩 FEN，只能自己去推格子关系，然后推错。
 *
 * 所以这里给它一张**按规则算出来的**去向表。价值在于**表里没有的格就是走不到的**：
 * 被自己的子挡住的、被牵住的、规则上到不了的，都不会出现。
 * 模型再想说"它盯着 X"，就只能从这张表里挑。
 */
function renderPieceMap(fen, square, label) {
  if (!fen || !square) return [];
  const m = pieceMap(fen, square);
  if (!m) return [];

  const out = ['【' + label + '：' + m.pieceCn + ' ' + m.square + ' 能去哪（按规则算的）】'];

  // ⚠️ **空的那几行不要写出来**。
  //    用户抓到的第二种空话：模型会照着单子念"但注意：它没有攻击黑方任何子 ——
  //    表里'能吃到对方的子'一栏是空的"。那等于把我们的表格结构读给读者听，
  //    对读者毫无价值。所以只报**有内容**的项；没有的那一项，不存在的行就是它自己。
  if (m.attacks.length) {
    out.push('· 能吃到对方的子：' + m.attacks.map((x) => x.pieceCn + ' ' + x.square + '（' + x.san + '）').join('、'));
  }
  if (m.defends.length) {
    // ⚠️ 标签必须让**主语**显形。原来写的是"能护住自己的子"——
    //    用户抓到模型把它读反成"给 g1 的王补上了保护"（王是护人的那一方，不是被护的）。
    //    现在写成"它护着这些子"，并说清这个"护"是"对方吃它时它能吃回来"。
    out.push('· 它护着这些子（对方吃它们时，它能吃回来）：' +
      m.defends.map((x) => x.pieceCn + ' ' + x.square).join('、') +
      (m.defendsTotal > m.defends.length ? ' 等 ' + m.defendsTotal + ' 个' : ''));
  }
  // 「够得着、却吃不了」的对方子 —— 连原因一起给。
  // 用户报的 bug（50.Kh5）：王紧挨着 h6 的黑兵，而那个兵被 g7 守着、吃不得；
  // 材料当时只写了"能落到的空格"，h6 一字没提，模型就自己补了"王能吃 h6 的兵"。
  if ((m.blockedCaptures || []).length) {
    out.push('· ★ 它**吃不了**的对方子（够得着，但规则上不行）：' +
      m.blockedCaptures.map((x) => x.pieceCn + ' ' + x.square + '（' +
        (x.byKing
          ? '那一格被 ' + x.guards.map((g) => g.square + ' 的' + g.pieceCn).join('、') +
            '守着 —— 王吃上去等于送将'
          : (x.becauseCheck ? '现在必须先应将，抽不出这一手' : '它被牵住，一走开自己的王就要被将军')) +
        '）').join('、'));
  }
  // 落点这一行**永远写**：它是防幻觉的那道闸（表里没有的格就是走不到）
  out.push('· 能落到的空格：' + (m.controls.length
    ? m.controls.map((x) => x.square).join('、') +
      (m.controlsTotal > m.controls.length ? ' 等 ' + m.controlsTotal + ' 个' : '')
    : '一个都没有 —— 它现在哪儿也去不了（被挡住或被牵住）'));
  // 守卫句：只说"这些"，**不要提"表""栏"**，免得模型跟着念单子的结构。
  // 三行一起兜住：不许自己往里加，也不许自己往外拿。
  out.push('（⚠️ 上面就是全部，一个不漏，不许自己加也不许自己减。' +
    '"能吃到对方的子"里没提到的子，就是**吃不了**；标了"吃不了"的那一行连原因都写了。' +
    '别的格子它到不了。还有：**这些说的都是"这只子能对别人做什么"，不是"别人能对它做什么"**。）');
  out.push('');
  return out;
}

/**
 * 【这一步给谁补了保护 / 让谁没人守了】—— 一步棋的**意图**（前后对比算出来的）。
 *
 * 【为什么必须有这一段】
 * 用户在样例第 19 步（19...Kd8）上报：
 * "这一步棋本质是想用王去守护 c7 格的象……但模型对这一步棋的想法描述的不知所云。"
 *
 * 查下来："这一步动过的那个子"那张表上，关于意图是**空的**
 * （王被排除在"护住"之外，安静局面下战场一览也是空的），模型只好去候选表里抓：
 * 走之前引擎的次选正好是 `Rd8`，而实际走的是 `Kd8` —— 同一个落点。
 * 于是它讲成"王去 d8 是为了把 d8 让给车"。方向正好反了：王占了 d8，车反而去不了。
 *
 * 而"意图"本来就是一句**前后对比**：这一步改变了谁的保护？
 *   · 走之前守着 c7 的象的只有 c8 的车 → 走之后 c8 的车 + d8 的王  ← 这就是意图
 *   · 走之前守着 f7 的兵的是 e8 的王   → 走之后没人了                ← 这就是代价
 * 两条都纯算得出来，不需要搜索。
 */
function renderProtection({ beforeFen, fen, color, from, to, title }) {
  const d = protectionDelta({ beforeFen, fen, color, from, to });
  if (!d.gained.length && !d.lost.length && !(d.opened || []).length) return [];

  const at = (x) => x.square + ' 的' + x.pieceCn;
  const many = (list) => list.map(at).join('、');
  // 带连接词，直接接在"走之前"后面：没人 / 只有 X 一个人 / 有 X、Y
  const guardText = (list) => (list.length === 0 ? '没人'
    : list.length === 1 ? '只有 ' + at(list[0]) + '一个人'
      : '有 ' + many(list));

  const out = [title || '【这一步给谁补了保护 / 让谁没人守了（按规则复算 —— 这就是这步棋的意图）】'];
  // ⚠️ 写法定死成"守它的子：走之前 A，现在 B"这种**名单式**的句子。
  //    原来是"……现在 d8 的王也守上了"，主语容易被读反 ——
  //    用户就抓到过模型说成"给 g1 的王补上了保护"（王根本不是被守的那一方）。
  for (const x of d.gained) {
    // 守人的是王的时候，额外点一句方向 —— 用户抓到过模型把这句话读反，
    // 说成"给 g1 的王补上了保护"（王的角色正好是反的）。
    const kingGuard = x.mover.pieceCn === '王';
    out.push('· ★ 补了保护：' + x.pieceCn + ' ' + x.square +
      '（正盯着它的是 ' + many(x.attackedBy) + '）—— 守它的子：走之前' +
      guardText(x.defBefore) + '，现在又多了 ' + at(x.mover) +
      (kingGuard ? '（**是这只王来守它**，不是反过来）' : '') + '。');
  }
  for (const x of d.lost) {
    out.push('· ★ 失去了保护：' + x.pieceCn + ' ' + x.square +
      '（正盯着它的是 ' + many(x.attackedBy) + '）—— 守它的子：走之前' +
      guardText(x.defBefore) + '，' + at(x.left) + '这一走开，' + (x.defNow.length
        ? (x.defNow.length === 1 ? '只剩 ' + at(x.defNow[0]) + '一个人守着' : '还剩 ' + many(x.defNow) + ' 守着')
        : '就没人守它了') + '。');
  }
  // "多了一个保护者" —— 新出现的守护者**不是**走动的那个子（多半是它让开了某条线）。
  // 用户报的短易位那盘缺的就是这一条：引擎建议的 Nd2 把 b1 让开，d1 的后才够得着 a1。
  // 措辞只讲"名单变了"，不编"为什么变" —— 易位这种事两个子一起动，硬讲因果会讲错。
  for (const x of (d.opened || [])) {
    // "它原来为什么守不到" —— 挡着的就是刚走开的那个子时，把这句话写出来。
    // （不然模型会自己编一个原因：用户抓到过"王离开 e1 之后 d1 的后不再被王挡着"，
    //   而王根本不在那条线上，真正挡着的是 b1 的马。）
    const wasBlocked = x.joinedBy.some((j) => j.wasBlockedByFrom);
    out.push('· ★ 多了一个保护者：' + x.pieceCn + ' ' + x.square +
      '（正盯着它的是 ' + many(x.attackedBy) + '）—— 守它的子：走之前' +
      guardText(x.defBefore) + '，现在多了 ' + x.joinedBy.map(at).join('、') +
      (wasBlocked ? '（它原来是被 ' + at(x.left) + '挡住的）' : '') + '。');
  }
  // 口径必须写明：这是"够得着"，不是"吃了能立刻吃回" ——
  // 王尤其如此（Kd8 那盘里，王要等两个车换完才吃得回 c7）。
  // 对比用的那一段（title 传了进来）不重复写一遍，省篇幅。
  if (!title) {
    out.push('（⚠️ 两条口径：① "守着"是指"它的走子范围够得着这一格"，' +
      '**不是**"对方吃上来它就能立刻吃回"；② 被守的一定是上面点名的那个子，' +
      '写"某某王也守上了"是说**那只王在守别人** —— 王不会出现在"被守"的那一侧。）');
  }
  out.push('');
  return out;
}

/**
 * 【这盘棋之前几手讲过什么】—— 多轮记忆（方法 B：让同一次讲解在结尾多写一行"要点"）。
 *
 * 这一段不是新事实，是**之前几手的结论**。带上它的唯一目的，是让讲评有脉络
 * （"前面说过的 f7 那个漏，这一手正是它兑现的时候"），并减少重复和自相矛盾。
 * 所以措辞必须写成"只是提醒"：这一手该讲什么，仍然只看上面那些刚算出来的材料。
 */
function renderRecap(recap) {
  const rows = (Array.isArray(recap) ? recap : [])
    .filter((r) => r && typeof r.text === 'string' && r.text.trim())
    .map((r) => ({
      ply: Number(r.ply) || 0,
      san: String(r.san || '').replace(/[^\w+#=xOoKQRBNa-h1-8-]/g, ''),
      text: String(r.text).replace(/\s+/g, ' ').trim().slice(0, 60),
    }))
    .filter((r) => r.text);
  if (!rows.length) return [];

  const out = ['【这盘棋之前几手讲过什么（只是提醒，**不要照抄** —— ' +
    '这一手该讲什么，只看上面刚给的材料）】'];
  for (const r of rows.slice(-5)) {
    out.push('- ' + (r.ply ? '第 ' + Math.ceil(r.ply / 2) + ' 回合 ' : '') +
      (r.san ? r.san + '：' : '') + r.text);
  }
  out.push('（⚠️ 这些是**之前几手**的结论，对现在这个局面可能已经过期；' +
    '这一手的事实以材料为准，两者冲突时以材料为准。）');
  out.push('');
  return out;
}

/**
 * 【顺着引擎那条线走两步】—— 讲"这步是为了下一步"靠它。
 *
 * 【为什么需要它】
 * 我们只算过"现在这一步能得手什么"（一步将杀 / 白吃）。
 * 像**叉子**那种"我这步走完，他只能这么应，然后我再吃掉另一个"的组合，
 * 材料里一个字都没有 —— 模型只能复述引擎的变化线，讲不出因果。
 *
 * 这一段的每一个字都是重放出来的：第 1 步、对方当时有几个合法着法、
 * 第 2 步、以及"这两步之后轮到谁、他能吃到什么"。见 position.js 的 followUp。
 */
function renderFollowUp(fu) {
  if (!fu) return [];

  const out = ['【顺着引擎那条线走两步（每一步都按规则重放核对过，不是猜的）】'];
  out.push('· 第 [1] 步（就是现在能走的）：' + fu.first +
    (fu.firstAnchor ? '（' + fu.firstAnchor + '）' : '') + '。');
  out.push('· 走完它轮到另一方，对方这时一共有 ' + fu.replyCount + ' 个合法着法' +
    (fu.replyCount === 1 ? ' —— **字面意义上的只有一步可走**' : '') + '。');
  if (fu.reply) {
    out.push('· 第 [2] 步（引擎选的应手）：' + fu.reply +
      (fu.replyAnchor ? '（' + fu.replyAnchor + '）' : '') + '。');
  }

  const g = fu.gains;
  const menu = (fu.menu && fu.menu.list) || [];
  if (g && (g.mates.length || g.wins.length)) {
    const bits = [];
    if (g.mates.length) bits.push('一步将杀 ' + g.mates.map((m) => m.san).join('、'));
    if (g.wins.length) {
      bits.push('白吃 ' + g.wins.map((w) => w.san + '（用 ' + w.from + ' 的' + w.pieceCn +
        '吃 ' + w.to + ' 的' + w.capturedCn + '）').join('、'));
    }
    out.push('· ★ 这两步走完，又轮到' + whoName(g.turn) + '：他能一步得手 —— ' + bits.join('；') + '。');
  } else if (fu.reply && menu.length) {
    const x = menu[0];
    out.push('· 这两步走完，又轮到' + whoName(fu.menu.turn) + '：他能吃 ' + x.to + ' 的' + x.capturedCn +
      '（用 ' + x.from + ' 的' + x.pieceCn + '吃）；' + (x.recaptureBy.length
        ? '对方吃得回来 —— ' + x.recaptureBy.map((r) => r.square + ' 的' + r.pieceCn).join('、') + '能吃到 ' + x.to + '。'
        : '对方吃不回来。'));
  }

  out.push('（⚠️ 第 [2] 步是**引擎选的**应手，不是唯一应手 —— 上面没写"只有一步可走"时，' +
    '不许讲成"他只能这样走"。）');
  out.push('');
  return out;
}

/**
 * 【线关系（谁挡在谁前面）】—— 牵制 / 穿刺。
 *
 * 【为什么必须有这一段】
 * 用户在样例第 9 步（Qd2）抓到的第二处费解是模型写了：
 * "黑方 Ne4 直接踩到 d2 后和 c3 马共处的这条线上"。
 * 而 Ne4 是引擎变化线里的**第 5 手**，现在就走等于送子（它把引擎的后续读成了眼下的威胁）。
 *
 * 但它想指的那个机制**是真的**：黑后 a5 沿 a5-b4-c3-d2 盯着 c3 的马，
 * 而马后面紧挨着就是白后 d2 —— 这正是"线关系"，也正好是我们从来没算过、
 * 它只好自己编（编成了"共处一条线"）的那块空白。
 *
 * 所以这里把线关系按规则复算出来，让它有现成的说法可用：
 *   · 后面是王 → 钉住（这个子根本不能动）
 *   · 后面是别的子 → 穿刺（这个子一让开，后面那个就会被吃）
 */
function renderLineTactics(fen) {
  if (!fen) return [];
  const rows = []
    .concat(lineTactics(fen, 'w').map((x) => ({ ...x, side: 'w' })))
    .concat(lineTactics(fen, 'b').map((x) => ({ ...x, side: 'b' })));
  if (!rows.length) return [];

  const out = ['【线关系（谁挡在谁前面 —— 按规则复算，可以直接引用）】'];
  for (const x of rows) {
    const side = whoName(x.side);
    const foe = whoName(x.side === 'w' ? 'b' : 'w');
    // 攻击方一律写成"黑方的后 a5"：省略"的"读起来是"黑方后"，容易看漏。
    const atk = foe + '的' + x.attackerCn + ' ' + x.attacker;
    if (x.toKing) {
      out.push('· ' + side + '的' + x.pieceCn + ' ' + x.square + ' 被 ' + atk +
        ' **钉住了**：' + x.attacker + ' 顺着这条线盯着它，它后面紧挨着的就是' + side +
        '的王 ' + x.behind + '。它一动，王就直接暴露在' + atk + ' 面前 —— 按规则**它实际上不能动**。');
    } else {
      out.push('· ' + side + '的' + x.pieceCn + ' ' + x.square + ' 被 ' + atk +
        ' 盯着，而它后面紧挨着的是' + side + '的' + x.behindCn + ' ' + x.behind +
        ' —— 这个' + x.pieceCn + '一让开，' + x.attacker + ' 就能吃到 ' + x.behind +
        ' 的' + x.behindCn + '。');
    }
  }
  out.push('（⚠️ 上面没提到的子，就不要说它被谁盯着、也不要替它编"挡着谁" —— 这种线只能引用上面的，不能自己找。）');
  out.push('');
  return out;
}

/** 【为什么这是将杀】—— 三句全是规则给的，拼起来就是一段能用的讲评 */
function renderMateReason(mr) {
  if (!mr) return [];
  const out = ['【为什么这是将杀（按规则复算）】'];
  out.push('· ' + whoName(mr.mated) + '**一个合法着法都没有** —— 这就是将杀的定义。');
  out.push('· 王在 ' + (mr.kingSquare || '?') + '，一个能走的格都没有。');
  out.push('· 将军的是 ' + mr.checkersText +
    (mr.checkerGuarded
      ? '，而且它被 ' + mr.guardsText + ' 看着 —— 王吃下去会被吃回来。'
      : '。'));
  out.push('');
  return out;
}

/** "这一步实际发生的事" —— 全部由 chess.js 重放得出，不让模型猜 */
function describeMoveText(nf) {
  const bits = [];
  if (nf.isCastle) {
    bits.push(nf.pieceCn + ' 走了' + nf.castleSide + '（' + nf.from + '→' + nf.to + '）');
  } else {
    bits.push(nf.pieceCn + ' 从 ' + nf.from + ' 走到 ' + nf.to);
  }
  if (nf.isPromotion) bits.push('并升变成' + (PIECE_CN[nf.promotionTo] || '后'));

  // ⚠️ **只写发生过的事**，不许罗列否定。
  //
  // 早先这里无条件拼出"没有吃子；没有将军"—— 用户的原话是
  // "不要出现什么'这步没有将军，没有吃子'这种空话"。
  // 那种句子的信息量是零，而且会把模型的注意力引到"报告没发生的事"上，
  // 于是整段讲评就变成了一串否定句。
  //
  // 什么都不沾的时候，给它**一个概念**（安静的一步），而不是一串"没有"：
  // 这样模型会去讲"这步安静的手是在准备什么"，而不是复述三个否定。
  if (nf.isEnPassant) {
    bits.push('吃掉对方一个兵，而且是**吃过路兵** —— 被吃的兵不在落点上，' +
      '记谱写成 x 但那个格原本是空的');
  } else if (nf.isCapture) {
    bits.push('吃掉了对方一个' + nf.capturedCn);
  }
  if (nf.isCheckmate) bits.push('这一步直接将杀');
  else if (nf.givesCheck) bits.push('这一步将军');

  const quiet = !nf.isCapture && !nf.givesCheck && !nf.isPromotion && !nf.isCastle;
  if (quiet) {
    bits.push('这是**安静的一步** —— 它的价值不在吃了什么、将了谁，而在它准备做什么');
  }

  return bits.join('；') + '。';
}

// ============================================================
// 用户提示词：把事实摆成一张单子
// ============================================================

/**
 * @param {object} input 前端送上来的这一手的情况，字段都可缺省
 *   fen          走这一步**之后**的局面（必填）
 *   beforeFen    走这一步**之前**的局面（有它才能把这一步讲实）
 *   engine       走完之后那个局面的引擎结果（含 alternatives）
 *   engineBefore 走之前那个局面的引擎结果（含 alternatives）
 * @returns {{messages: Array, meta: object}}
 */
function buildExplainPrompt(input = {}) {
  const {
    fen, beforeFen, prevFen, prevSan, ply, san, color,
    engine, engineBefore, swing, history, opening,
    annotation, question, gameOver, recap,
  } = input;

  const mover = whoName(color);
  const opponent = whoName(color === 'b' ? 'w' : 'b');
  const moveNo = ply ? Math.ceil(ply / 2) : null;

  // ---------- 先把确定性的事实算出来 ----------
  // nf：这一步到底干了什么（从走之前的局面重放）
  const nf = (beforeFen && san) ? moveFacts(beforeFen, san) : null;

  // verified：前后两个局面**是对得上的**
  // 把 beforeFen 走出 san，得到的是不是就是 fen？
  // 对得上才敢用这些事实 —— 前端送来的东西不盲信（见 server.js 的说明）。
  const verified = !!(nf && fen && samePosition(nf.fenAfter, fen));

  // 这一步动手的是哪个子、从哪一格到哪一格。
  // ⚠️ 这个锚点必须写死进提示词：记谱在"两个同类子看起来都能去那个格、实际只有一个
  //    合法（另一个走了会送将）"时**只写着法名、不写是哪一个**。
  //    光给一个 Nc4，模型就得自己猜是哪个马 —— 那正是它最容易编的地方（见 anchorOf）。
  const playedAnchor = verified ? (moveAnchor(beforeFen, san) || '') : '';

  // 再往前一手的锚点（上一个回合，另一方走的）
  const prevAnchor = (prevFen && prevSan) ? (moveAnchor(prevFen, prevSan) || '') : '';

  // 他走的这一步，是不是引擎在「走之前那个局面」的首选？
  // 这个判断在下面两处都要用（写对照那一行、决定提问的口吻），
  // 所以先在函数作用域里落定，别困在 if 的花括号里。
  let playedIsTop = false;

  const profile = positionProfile(fen || beforeFen || '');
  const nowTurn = turnOf(fen);

  const lines = [];

  // ---------- 1. 这是什么局面 ----------
  // 按**时间顺序**摆：再往前一手 → 走这一步之前 → 现在。
  // 用户要的是"先判断对手上一步想干什么，再推理这边怎么应对"，
  // 那就得让他看得见"走这一步之前"的棋盘长什么样 —— 那一步改了什么是推理的起点。
  lines.push('【局面（按时间顺序，最后一行是现在）】');
  if (prevFen && prevSan) {
    lines.push('① 再往前一手（轮到' + whoName(turnOf(prevFen)) + '走）：' + prevFen);
    lines.push('   ' + whoName(turnOf(prevFen)) + '走了 ' + prevSan +
      (prevAnchor ? '（' + prevAnchor + '）' : ''));
  }
  if (beforeFen) {
    lines.push((prevFen && prevSan ? '②' : '①') + ' 走这一步**之前**（轮到' +
      whoName(turnOf(beforeFen)) + '走）：' + beforeFen);
  }
  if (fen) {
    lines.push((beforeFen ? (prevFen && prevSan ? '③' : '②') : '①') +
      ' 现在（轮到' + whoName(nowTurn) + '走）：' + fen);
  }
  lines.push('（FEN 六个字段依次是：棋子摆在哪、轮到谁走（w=白/b=黑）、还能不能易位、' +
    '能不能吃过路兵、半步计数、第几回合。）');
  if (ply && san) {
    lines.push('本次要讲的是：第 ' + Math.ceil(ply / 2) + ' 回合，' + mover + '走了 ' + san +
      (playedAnchor ? '（' + playedAnchor + '）' : '') + '。');
  } else if (san) {
    lines.push('本次要讲的是：' + mover + '走了 ' + san +
      (playedAnchor ? '（' + playedAnchor + '）' : '') + '。');
  } else {
    lines.push('现在轮到' + mover + '走，还没有走出下一步。');
  }

  if (verified) {
    lines.push('这一步实际发生的事：' + describeMoveText(nf));
    if (nf.isForced) {
      // 「不得已只能这样走」有时候是字面意思。这是规则给的，不是推测。
      lines.push('★ 这个局面他只有 ' + nf.legalCount + ' 个合法着法 —— 字面意义上的' +
        '"不得已，只能这样走"。');
    } else {
      lines.push('（这个局面他一共有 ' + nf.legalCount + ' 个合法着法可选。）');
    }

    // 这一步之后，动过的那个子到底能去哪 —— 吃谁、护谁、还能落到哪些空格。
    // 用户要的"先判断对手那步棋的目的"靠它，而"d2 的后盯着 d6"那类幻觉也靠它挡。
    if (fen && nf.to) {
      lines.push(...renderPieceMap(fen, nf.to, '这一步动过的那个子'));
      // 紧接着给"前后对比"：这一步给谁补了保护、让谁没人守了。
      // 这是"这步棋想干什么"唯一算得出来的实体 —— 见 renderProtection。
      lines.push(...renderProtection({
        beforeFen, fen, color: nf.color, from: nf.from, to: nf.to,
      }));
    }
  }
  if (gameOver) lines.push('这盘棋已经结束了。');
  lines.push('');

  // ---------- 2.5 战场一览 ----------
  // 谁盯着谁、谁悬着、轮到的一方有什么一步就能得手的、对方威胁什么。
  // 这一段是第四版新增的 —— 在此之前，"威胁"和"防守"这两个词在单子里没有实体。
  lines.push(...renderBattlefield({ fen, color: nowTurn }));

  // ---------- 2.6 线关系（牵制 / 穿刺） ----------
  // 用户抓到的"把第 5 手的着法说成眼下威胁"那个 bug，一半的原因是
  // 它想指的那条 a5-c3-d2 线我们从来没给过。现在给它。
  lines.push(...renderLineTactics(fen));

  // ---------- 2. 走这一步之前：他有哪些选择 ----------
  // 这一段回答的是用户最想知道的那个问题：
  // 这一步到底是真正的好棋，还是不得已只能这样走。
  //
  // 数据来源有两个可能：engineBefore（这次的正式来源，带多路线），
  // 或者只从 engine.bestMoveBeforeSan 蹭到一条（老路径，仍然支持）。
  const beforeEng = (engineBefore && typeof engineBefore === 'object') ? engineBefore : null;
  const topBeforeSan = (beforeEng && beforeEng.bestMoveSan)
    || (engine && engine.bestMoveBeforeSan) || null;

  const beforeScoreCp = beforeEng ? numOrNull(beforeEng.scoreCp)
    : (swing ? numOrNull(swing.beforeCp) : null);
  const beforeScoreMate = beforeEng ? numOrNull(beforeEng.scoreMate)
    : (swing ? numOrNull(swing.beforeMate) : null);

  // 走之前那个局面的评分有没有已经写出来 —— 免得下面重复一次
  let beforeScorePrinted = false;

  if (beforeEng || topBeforeSan) {
    lines.push('【引擎怎么看"走这一步之前的局面"】');
    lines.push('（这一段回答的是：这一步到底是真正的好棋，还是不得已只能这样走。）');

    const bCands = beforeEng ? candidatesOf(beforeEng) : [];

    if (hasScore(beforeScoreCp, beforeScoreMate)) {
      lines.push('走这步之前的局面评分：' + scoreToText(beforeScoreCp, beforeScoreMate) +
        '（' + describeEval(beforeScoreCp, beforeScoreMate, 'w') + '）');
      beforeScorePrinted = true;
    }

    // （对照）—— 他走了 A，引擎说该走 B。整张单子里最有对照价值的一条。
    //
    // ⚠️ 他走的正好就是引擎首选时，必须明说"这一步本身没有问题"。
    //    不然这一行会被读成"引擎给了另一个建议"，模型就会去挑一步好棋的毛病。
    playedIsTop = !!(topBeforeSan && san && normSan(topBeforeSan) === normSan(san));
    if (topBeforeSan) {
      const topBeforeAnchor = beforeFen ? (moveAnchor(beforeFen, topBeforeSan) || '') : '';
      if (playedIsTop) {
        lines.push('（对照）走这一步之前那个局面，引擎的首选着法就是' + mover +
          '实际走的 ' + san + (playedAnchor ? '（' + playedAnchor + '）' : '') +
          ' —— 所以这一步本身没有问题，问题（如果有）在别处。');
      } else {
        lines.push('（对照）' + (san ? '在他走 ' + san + ' 之前那个局面，' : '上一个局面，') +
          '引擎建议' + mover + '走的是：' + topBeforeSan +
          (topBeforeAnchor ? '（' + topBeforeAnchor + '）' : '') + '（这一步没有被走）。');
      }
    }

    // 走之前那个局面的"选择有没有讲究"—— 后面几处都要用它，先算出来
    let beforeVerdict = null;

    if (bCands.length > 1) {
      lines.push('引擎在那个局面给出的候选（评分都是白方视角，正数=白方好；' +
        '括号里是动手的子、从哪到哪）：');
      lines.push(...renderCandidates(bCands, '  ', beforeFen, san));

      const playedRank = san
        ? bCands.findIndex((c) => normSan(c.firstMoveSan) === normSan(san))
        : -2;   // -2 = 没有可比较的着法，不提"排第几"

      const v = choiceVerdict(bCands, color);
      beforeVerdict = v;
      lines.push(...verdictText(v, bCands.length > 1 ? playedRank : -2));
    } else if (bCands.length === 1 && beforeEng && beforeEng.depth) {
      lines.push('（引擎这次只给了一条线 —— 它搜到第 ' + beforeEng.depth +
        ' 层，没有再给出别的候选。）');
    }

    // ★ 他没走首选、但**这一步其实和首选一样好**时，必须明写出来。
    //
    // 用户报的那盘短易位就是这种情况：引擎算 Nd2 第一、O-O 第二（或反过来），
    // 两者分差只有 0.05 个兵 —— 而模型拿到的是"引擎建议的是 Nd2（这一步没有被走）",
    // 于是把它讲成了"他漏了/他没管/这步很烂"，把一步有想象力的好棋说成了败着。
    //
    // 判据用的是**前后两个局面的评分差**（swing.forMover）：它量的正是
    // "走这一步而不是首选，亏了多少"。亏得可以忽略，就不许讲成错。
    const lostBy = (swing && typeof swing.forMover === 'number') ? -swing.forMover : null;
    if (!playedIsTop && lostBy !== null && lostBy <= 20) {
      lines.push('★ 注意：引擎的首选虽然不是这一步，但**这一步和首选几乎一样好**' +
        '（走它比走首选只差约 ' + (lostBy / 100).toFixed(2) + ' 个兵）。' +
        '也就是说引擎认为两条路都行 —— **不许**把它讲成漏着、失误、' +
        '"他忽略了什么"；讲不出它好在哪，就写"这里本来就有好几条路，他选了这一条"。');
    }

    // 拿"另一条路"来做对照 —— 引擎首选，或者（他走的就是首选时）候选里的下一条。
    // ⚠️ 不能只在"他没走首选"时才给：用户报的短易位那盘，引擎首选本来就是 O-O，
    //    而真正该讲清楚的对照是"另一条路 Nd2 会让 d1 的后守住 a1"——
    //    少了它，模型就只能围着"a1 的车悬着"打转，讲不出这步棋放弃了什么。
    const contrast = bCands.find((c) => c.firstMoveSan &&
      !(san && normSan(c.firstMoveSan) === normSan(san)));
    if (beforeFen && contrast) {
      const cFacts = moveFacts(beforeFen, contrast.firstMoveSan);
      if (cFacts && cFacts.to && cFacts.fenAfter) {
        const cDelta = protectionDelta({
          beforeFen, fen: cFacts.fenAfter, color: cFacts.color, from: cFacts.from, to: cFacts.to,
        });
        const rows = renderProtection({
          beforeFen, fen: cFacts.fenAfter, color: cFacts.color,
          from: cFacts.from, to: cFacts.to,
          title: '【另一条路（' + contrast.firstMoveSan + '）会改变谁的保护 —— 拿来和他实际走的对比】',
        });
        if (rows.length) {
          // 另一条路做了、而**实际走的那一步没做**的那几件事 —— 这就是这一步放弃了什么。
          // 用户报的短易位那盘正缺这一句："Nd2 会让 d1 的后守住 a1，而他走的 O-O 没有"。
          if (nf && nf.to) {
            const mine = protectionDelta({
              beforeFen, fen, color: nf.color, from: nf.from, to: nf.to,
            });
            const covered = new Set([...(mine.gained || []), ...(mine.opened || [])].map((x) => x.square));
            const missed = [...(cDelta.gained || []), ...(cDelta.opened || [])]
              .filter((x) => !covered.has(x.square));
            if (missed.length) {
              // ⚠️ 措辞分两档，而且**默认是中性**的那一档 ——
              //    "他没做这件事"这种话，只有在**有证据**（前后评分差告诉我们这一步确实亏了）
              //    时才说。用户报的那盘就是栽在这里：两条路只差 0.05 个兵，
              //    材料却写"他没做上面这件事"，模型于是把一步有想象力的好棋讲成了败着。
              //    宁可不说，也不要乱指。
              const gap = beforeVerdict ? beforeVerdict.gapCp : null;
              const knownWorse = lostBy !== null && lostBy > 20;
              const body = missed.map((x) => x.pieceCn + ' ' + x.square +
                '（' + x.attackedBy.map((y) => y.square + ' 的' + y.pieceCn).join('、') + '盯着它）').join('、');
              rows.splice(rows.length - 1, 0,      // 插在末尾那个空行之前，别让段落断开
                knownWorse
                  ? '  ⚠️ 他实际走的 ' + (san || '这一步') + ' **没有**做上面这件事：' +
                    body + '现在还是没人保护。'
                  : '  （另一条路做了上面这件事，他选的这条没做 —— 但**这一步并不比它差**' +
                    (lostBy !== null ? '（只差约 ' + (lostBy / 100).toFixed(2) + ' 个兵）'
                      : gap !== null ? '（候选之间的分差也很小）' : '') +
                    '，所以这只是**取舍**。讲不出他为什么这么选，就别硬解释。）');
            }
          }
          lines.push(...rows);
        }
      }
    }

    // 首选那条线，往下推几步。用户要的"读懂战术意图"主要靠这一段。
    if (beforeEng && bCands.length && beforeFen) {
      lines.push(...renderTrail(beforeFen, bCands[0].pvSan || [], TRAIL_MAIN,
        '  如果他按引擎的首选走，接下来大概是这样'));
      // 次优解也各给一小段：让模型能比较"另一条路能走成什么样"
      for (let i = 1; i < bCands.length; i++) {
        const c = bCands[i];
        if (!(c.pvSan || []).length) continue;
        lines.push(...renderTrail(beforeFen, c.pvSan, TRAIL_ALT,
          '  如果走次选 ' + c.firstMoveSan + '，大概是'));
      }
    }
    lines.push('');
  }

  // ---------- 3. 走这一步之后：现在这个局面 ----------
  const e = engine || {};
  const engineHasScore = hasScore(e.scoreCp, e.scoreMate);
  const afterCp = engineHasScore ? e.scoreCp : (swing ? swing.afterCp : null);
  const afterMate = engineHasScore ? e.scoreMate : (swing ? swing.afterMate : null);

  if (engine) {
    lines.push('【引擎怎么看"走这一步之后的局面"（也就是现在这个局面）】');
    lines.push('现在轮到' + whoName(nowTurn) + '走。');
    // 给引擎的每一手都带上起止格 —— 只给 Nc4 的话模型可能说成另一个马（见 anchorOf）
    const afterBestAnchor = (fen && e.bestMoveSan) ? (moveAnchor(fen, e.bestMoveSan) || '') : '';
    if (e.bestMoveSan) {
      lines.push('引擎对这个局面给出的最佳着法：' + e.bestMoveSan +
        (afterBestAnchor ? '（' + afterBestAnchor + '）' : '') + '。');
    }

    const aCands = candidatesOf(engine);
    if (aCands.length > 1) {
      lines.push('引擎对这个局面给出的候选（评分都是白方视角，正数=白方好；' +
        '括号里是动手的子、从哪到哪）：');
      lines.push(...renderCandidates(aCands, '  ', fen));
    }

    if (hasScore(afterCp, afterMate)) {
      lines.push('走这步之后的局面评分：' + scoreToText(afterCp, afterMate) +
        '（' + describeEval(afterCp, afterMate, 'w') + '）');
    }

    if (e.depth) lines.push('（这是引擎搜到第 ' + e.depth + ' 层的结论）');

    if (fen && aCands.length && (aCands[0].pvSan || []).length) {
      lines.push(...renderTrail(fen, aCands[0].pvSan, TRAIL_MAIN));
      for (let i = 1; i < aCands.length; i++) {
        const c = aCands[i];
        if (!(c.pvSan || []).length) continue;
        lines.push(...renderTrail(fen, c.pvSan, TRAIL_ALT,
          '  如果走次选 ' + c.firstMoveSan + '，大概是'));
      }
      // 只对**主变化**再算一次"两步之后会怎样"：叉子这类组合只有靠它才讲得出来。
      lines.push(...renderFollowUp(followUp(fen, aCands[0].pvSan)));
    }
    lines.push('');
  }

  // ---------- 3.2 引擎推荐的那一手在干什么（防守 / 直接动手）----------
  // 第四版新增。把"这一手挡掉了什么"变成事实 —— 在此之前单子里完全没有"防守"。
  // 复用战场一览里已经算好的"轮走方现在能得手什么"，不重复算一遍。
  if (fen && e.bestMoveSan) {
    const bf = collectBattlefield(fen, nowTurn);
    const eff = engineEffect(fen, e.bestMoveSan, bf.own);
    lines.push(...renderEngineEffect(eff));
  }

  // ---------- 3.3 为什么这是将杀 ----------
  // 只在真的将杀时才有内容（三段全是规则给的）。
  lines.push(...renderMateReason(mateReason(fen)));

  // ---------- 3.5 这一步的得失 ----------
  // 这是整张单子里最有价值的一行：它把"讲棋"从模糊的判断题变成了算术题。
  // 用手算而不是让模型算 —— 它算不对，而这种减法我们算得又快又准。
  if (swing && hasScore(swing.beforeCp, swing.beforeMate) &&
      hasScore(swing.afterCp, swing.afterMate)) {
    // 前面那段没写过"走之前的评分"，就在这里补一句。
    // 少了它，模型只看到一个差值、看不到两个原始分 —— 而"从哪儿掉到哪儿"是要它讲的东西。
    if (!beforeScorePrinted) {
      lines.push('走这步之前的局面评分：' + scoreToText(swing.beforeCp, swing.beforeMate) +
        '（' + describeEval(swing.beforeCp, swing.beforeMate, 'w') + '）');
    }
    if (typeof swing.forMover === 'number') {
      const v = swing.forMover;
      if (Math.abs(v) < 30) {
        lines.push('→ 也就是说：这一步基本没有改变局势。');
      } else if (v < 0) {
        lines.push('→ 也就是说：' + mover + '这一步亏了约 ' +
          (Math.abs(v) / 100).toFixed(2) + ' 个兵的价值。');
      } else {
        lines.push('→ 也就是说：' + mover + '这一步赚了约 ' +
          (v / 100).toFixed(2) + ' 个兵的价值。');
      }
    } else {
      // 【原来这里是个洞】前后有一侧是 mate 分数时，减不出数字，
      // 于是整行静默消失 —— 偏偏"一步走成被将杀"这种最该讲清的局面全落在这一支。
      // 现在算不出数字就给一句定性的：从什么变成了什么。
      lines.push('→ 也就是说：局面由「' +
        describeEval(swing.beforeCp, swing.beforeMate, 'w') + '」变成了「' +
        describeEval(swing.afterCp, swing.afterMate, 'w') + '」——' +
        '这一下是**一步之内发生的变化**，请重点讲清楚它是怎么发生的。');
    }
    lines.push('');
  }

  // ---------- 4. 来龙去脉 ----------
  if (opening || (history && history.length)) {
    lines.push('【这盘棋的来龙去脉】');
    if (opening && opening.length) lines.push('开局走的是：' + opening.join(' '));
    if (history && history.length) lines.push('刚才几步是：' + history.join(' '));
    lines.push('');
  }

  // ---------- 5. 棋谱作者自己写的话 ----------
  // 注意：这只是"参考"，而且是别人写的，可能跟引擎结论不同。
  // 明确告诉模型这件事，免得它把两者混为一谈。
  if (annotation) {
    lines.push('【棋谱里原本写的评注（别人加的，仅供参考，可能和引擎结论不一致）】');
    lines.push(annotation);
    lines.push('');
  }

  // ---------- 5.5 这盘棋之前几手讲过什么（多轮记忆）----------
  // 只带"之前几手"的结论，且明确写成"只是提醒" —— 见 renderRecap。
  lines.push(...renderRecap(recap));

  // ---------- 6. 战术参考 ----------
  // 用局面特征确定性筛选，与本次的引擎结果无关的那部分知识不会进来。
  // 详见 knowledge/index.js。
  //
  // ⚠️ 「有没有将杀」必须只看 **mate 字段本身**，不能图省事写成
  //    `hasScore(afterCp, afterMate) || hasScore(beforeScoreCp, beforeScoreMate)` ——
  //    hasScore() 的意思是"**cp 或 mate 有一个就算有**"，也就是"有没有分数"。
  //    写成那样的话，只要引擎给了任何一个普通评分（-0.24 这种），
  //    这里就恒为 true，一路传下去变成 knowledge 的 mate 标签：
  //      · 每盘棋都附上「关于杀棋」那两段（后加王的收尾、车加王的收尾…）；
  //      · mate 类母题（弃子 / 引入 / 炮台 / 闪击…）被优先挑中；
  //      · mate 属于 SPECIFIC_TAGS，"命中了几个稀有特征"永远 ≥1 → 知识预算永远拉满。
  //    一段毫无杀棋的平淡开局也被塞满杀棋知识 —— 正是 knowledge/index.js
  //    开头最想避免的"硬套"，而且每次讲棋都白付这段 token。
  const hasMateAnywhere =
    (afterMate !== null && afterMate !== undefined) ||
    (beforeScoreMate !== null && beforeScoreMate !== undefined);
  // 「这条线里有没有弃子」——引擎自己的最佳线路里，他走完这条线**净**亏了
  // 2 个兵以上还照样好，那就是弃子换来的。这是算出来的，不是猜的。
  //
  // ⚠️ 两处都必须量「走棋方自己」（color）掉了多少：
  //    dropBefore 从走之前的局面出发，那条线的第一手就是他自己的；
  //    dropAfter  从走之后的局面出发，虽然轮到对手走，但量的仍然是**他**在这条线上
  //    最后亏了多少 —— 早先这里传的是 nowTurn（对手），于是"这一步是不是弃子"
  //    实际衡量成了"对手是不是弃子"，视角正好反了。
  const dropAfter = (fen && engine && (engine.pvSan || []).length)
    ? lineMaterialDrop(fen, engine.pvSan, color, TRAIL_MAIN) : { drop: 0 };
  const dropBefore = (beforeFen && beforeEng && (beforeEng.pvSan || []).length)
    ? lineMaterialDrop(beforeFen, beforeEng.pvSan, color, TRAIL_MAIN) : { drop: 0 };
  const investedMaterial = (nf && nf.isCapture && nf.capturedValue < nf.movedPieceValue) ||
    dropAfter.drop >= 2 || dropBefore.drop >= 2;

  const knowledge = buildKnowledge({
    phase: profile ? profile.phase : 'middlegame',
    hasMate: hasMateAnywhere,
    isCapture: !!(nf && nf.isCapture),
    givesCheck: !!(nf && nf.givesCheck),
    isPromotion: !!(nf && nf.isPromotion),
    isSacrifice: investedMaterial,
    isForced: !!(nf && nf.isForced),
    uncastledKing: !!(profile && (profile.moverKingHome || profile.bothUncastled)),
    materialDiff: profile ? profile.matDiff : 0,
    swingForMover: (swing && typeof swing.forMover === 'number') ? swing.forMover : null,
  });

  if (knowledge.text) {
    lines.push(knowledge.text);
    lines.push('');
  }

  // ---------- 7. 请它干什么 ----------
  //
  // 顺序是刻意的（用户明确要求过这个顺序）：
  //   ① 先判断走棋方这一步**想干什么**（威胁了谁、进攻还是防守）——
  //      这是从"走之前 / 现在"两个局面的差别里读出来的，不是猜的；
  //   ② 再评这一步本身好不好（沿用原来的几种口吻）；
  //   ③ 最后才是"轮到另一方了，该怎么应对" —— 引擎在**现在这个局面**给的最佳着法
  //      正好就是给这一方的，这一条把"讲解"和"我该怎么下"接上了。
  lines.push('【请讲】');

  // 现在这个局面引擎给的那一手（就是给"该应对的那一方"的），带起止格锚点
  const afterBestSan = e.bestMoveSan || null;
  const afterBestAnchor = (fen && afterBestSan) ? (moveAnchor(fen, afterBestSan) || '') : '';
  const playedRef = san
    ? san + (playedAnchor ? '（' + playedAnchor + '）' : '')
    : '这一步';

  if (question) {
    lines.push(question);
  } else if (gameOver) {
    lines.push('这盘棋到这里就结束了。请用几句话总结：胜负是怎么定下来的，');
    lines.push('转折发生在哪一步。');
  } else if (!san) {
    // 还没走出下一步 —— 这时候没什么"错在哪"可讲，改成讲形势
    lines.push('现在轮到' + mover + '走。请讲：');
    lines.push('1. 这个局面的形势大致如何？双方的棋子各自在做什么？');
    lines.push('2. 接下来这段时间，双方各自该争取什么？');
    lines.push('3. 给一个具体的、业余棋手能照着做的方向。');
  } else {
    // ① 意图
    lines.push('1. 先判断' + mover + '刚走的 ' + playedRef + '想干什么：' +
      '拿上面「走这一步**之前**」和「现在」那两个局面的差别说话 —— ' +
      '它威胁了' + opponent + '的哪个子、哪个格？是进攻（要吃、要打、要攻王）还是防守' +
      '（补漏、护子、挡线、兑子解围）？还是在为下一步做准备？');

    // ② 这一步本身好不好（沿用原来的几种口吻）
    if (nf && nf.isForced) {
      // 只有一步合法着法 —— 这一步没有"选择"可言，问"错在哪"是无的放矢
      lines.push('2. 这个局面他只有一步合法着法（上面写了），所以这一步谈不上选择对错。' +
        '请讲：局面是怎么被逼到这一步的？是哪一步或哪几步把他推到了这里？');
    } else if (playedIsTop) {
      // 他走的正好是引擎的首选 —— 这时候问"问题出在哪里"就是先入为主了。
      // 实测过：问错了模型就会硬找毛病，把一步好棋批一顿。
      lines.push('2. 刚走的这一步正是引擎的首选。它好在哪里？具体到棋子、格子、线路。');
      if (beforeEng && (beforeEng.alternatives || []).length) {
        lines.push('   顺便说一句：上面那几条候选里，有没有跟它差不多的？' +
          '有的话就说明这个局面不止一条路。');
      }
    } else {
      lines.push('2. 刚走的这一步，问题出在哪里？具体到棋子、格子、线路。' +
        (topBeforeSan
          ? '请结合上面那条「本该走的那一步」，说明它为什么更好。'
          : ''));
    }

    // ③ 应对
    if (afterBestSan) {
      lines.push('3. 现在轮到' + opponent + '走。引擎对这个局面给出的最佳着法是 ' +
        afterBestSan + (afterBestAnchor ? '（' + afterBestAnchor + '）' : '') +
        '。请说明它为什么是此刻该做的事 —— 它怎么化解上面那个威胁，' +
        '或者怎么利用对手这一步留下的弱点。（只讲这一手和上面给过的变化，不要另想别的招。）');
    } else {
      lines.push('3. 现在轮到' + opponent + '走。上面**没有**给引擎在这个局面的建议，' +
        '所以不要编一个具体着法出来 —— 只讲你能从局面上看出来的应对思路' +
        '（哪个子该动、哪条线要守），拿不准就直说看不出来。');
    }

    lines.push('4. 如果有一个要点值得记住，那是什么？');
  }

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: lines.join('\n') },
    ],
    meta: {
      ply: ply || null,
      san: san || null,
      color: color || null,
      moveNo,
      // 只用来判断"这次到底有没有拿到引擎结论"。⚠️ 不能用
      // `engine.scoreCp !== undefined` —— 前端固定会带上这个键，
      // 值可能是 null（引擎对这个局面没给出分数），那样恒为 true。
      hasEngineData: !!(engine && (engine.bestMoveSan || hasScore(engine.scoreCp, engine.scoreMate))),
      hasSwing: !!(swing && typeof swing.forMover === 'number'),
      // ---- 第二版新增，给测试和排查用 ----
      moveVerified: verified,                                     // 前后局面核对通过
      isForced: !!(nf && nf.isForced),                              // 只有一步合法着法
      playedIsTop: playedIsTop,                                     // 走的正是引擎首选
      hasAlternatives: candidatesOf(engine).length > 1,             // 这次带了次优解
      // ---- 第三版新增：防幻觉两条 ----
      hasPrev: !!(prevFen && prevSan),                              // 给了"再往前一手"那层
      playedAnchor: playedAnchor || null,                           // 这一步的起止格锚点
      afterBestAnchor: afterBestAnchor || null,                      // 引擎应对那手的锚点
      knowledge: { motifs: knowledge.motifs, games: knowledge.games },
    },
  };
}

/**
 * 前端送上来的 swing 字段都信吗？—— 不。
 *
 * 这个接口对 localhost 开放，风险不高；但"前端算的东西后端直接当真"
 * 是个坏习惯：一旦哪天它被别处调用，就会变成漏洞。
 * 所以 forMover 我们自己重算一遍，只信两个原始评分。
 *
 * @returns {{beforeCp,afterCp,forMover,beforeMate,afterMate}|null}
 */
function normalizeSwing(swing, color) {
  if (!swing || typeof swing !== 'object') return null;
  const before = numOrNull(swing.beforeCp);
  const after = numOrNull(swing.afterCp);
  const bMate = numOrNull(swing.beforeMate);
  const aMate = numOrNull(swing.afterMate);
  if (before === null && after === null && bMate === null && aMate === null) return null;

  let forMover = null;
  if (before !== null && after !== null) {
    // 两个评分都是「白方视角」。从走棋方自己的角度看，
    // 白走的这步就看白方涨了没有，黑走的这步反过来看。
    const sign = color === 'b' ? -1 : 1;
    forMover = (after - before) * sign;
  }

  return {
    beforeCp: before, afterCp: after,
    beforeMate: bMate, afterMate: aMate,
    forMover,
  };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  buildExplainPrompt,
  normalizeSwing,
  describeEval,
  scoreToText,
  candidatesOf,
  SYSTEM_PROMPT,
};
