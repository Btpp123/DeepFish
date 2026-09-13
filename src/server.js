// ============================================================
// server.js —— 后端
//
// 它干三件事：
//   1. 把 public 文件夹里的网页端给浏览器
//   2. 提供接口，让网页能"点菜"：把局面发给鳕鱼，拿回分析结果
//   3. 提供一个接口，让网页能请 DeepSeek 讲棋
//
// 【第 3 件事为什么非要经过我们自己的后端】
// 因为密钥。浏览器里的 JS 是公开的，谁按 F12 都能读。
// 密钥必须留在这台机器上，浏览器只跟 localhost 说话，绝不直接碰 DeepSeek。
// 详见 llm.js 开头。
//
// 启动：  node src/server.js      然后浏览器开 http://localhost:3000
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Chess } = require('chess.js');

// .env 的位置和加载逻辑统一放在 llm.js 里，这里只是调用它 —— 规则只写一处。
// ⚠️ 必须在 require('./engine') 之前调用：engine.js 是在**模块加载时**
//    就去读 SF_THREADS / SF_HASH 的，晚一步就来不及了。
const { getLlm, LlmError, loadEnvFile } = require('./llm');
loadEnvFile();

const { getEngine, ENGINE_PATH } = require('./engine');
const { buildExplainPrompt, normalizeSwing } = require('./coach');
const { samePosition } = require('./position');

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// FEN 最长能有多长
//
// ⚠️ 这个常量是踩过坑才有的，别删。
//
// `str()` 的默认上限是 60 —— 对大多数短字段（着法名、模型名）正合适。
// 但**开局局面的 FEN 只有 56 字符，中局随便一个就 65~70**。
// 于是 `str(body.fen)` 会静默把中局以后的局面切掉尾巴：
//
//   ...RNB1K1NR w KQkq - 4 4   ← 原样
//   ...RNB1K1NR w KQk            ← 被切成这样
//
// 最阴的地方在于 chess.js **不报错** —— 字段不全时它自己补默认值，
// 所以 `new Chess(切过的 FEN)` 照样构造成功，只是局面悄悄变了。
// 连锁反应是"讲棋"那边核对前后局面时对不上，于是整段
// "走这一步之前是什么局面"被当成不可信数据丢掉，模型只拿到半个 FEN。
// 全程没有任何一处报错。
//
// 现在：FEN 用这个上限，并且下面**硬校验必须是 6 个字段**，
// 宁可回一个 400，也不许带着残局面上路。
// ------------------------------------------------------------
const MAX_FEN = 120;   // 棋局本身最宽 ~71，加 " w KQkq - 0 1" 约 90；留足余量

app.use(express.json({ limit: '1mb' }));

// 把 public 文件夹里的东西直接"端"给浏览器。
// 注意：这里用的是 __dirname（当前文件所在目录），
// 所以不管你在哪个目录敲启动命令，都能正确找到 public。
app.use(express.static(path.join(__dirname, '..', 'public')));

// ------------------------------------------------------------
// 引擎在不在？
//
// ⚠️ 这个检查是给"刚把项目拷到另一台机器"的人准备的：
//    stockfish/ 是 **gitignore** 的（约 100MB 的二进制不进版本库），
//    所以新机器上**一定**没有引擎文件。以前的表现是：
//    服务器照常起来、界面照常打开，直到你点"让鳕鱼分析"才报一个看不懂的错。
//    现在启动时就说清楚，并给出下载地址。
// ------------------------------------------------------------
function engineFileReady() {
  try {
    return fs.existsSync(ENGINE_PATH);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// 体检接口：确认服务器活着
// ------------------------------------------------------------
app.get('/api/health', (req, res) => {
  const llm = getLlm();
  res.json({
    ok: true,
    message: '服务器活着',
    stockfish: ENGINE_PATH,
    // 有没有这个文件（前端/自检脚本据此提示"引擎没装"）
    stockfishReady: engineFileReady(),
    // 只说"配没配"，不会有密钥
    llm: { configured: llm.configured, model: llm.model },
    time: new Date().toISOString(),
  });
});

// ------------------------------------------------------------
// 引擎信息：确认鳕鱼能启动、是什么版本
// ------------------------------------------------------------
app.get('/api/engine', async (req, res) => {
  try {
    const engine = getEngine();
    await engine.ensureStarted();
    res.json({
      ok: true,
      available: true,
      path: ENGINE_PATH,
      name: engine.identity.name,
      author: engine.identity.author,
      threads: Number(process.env.SF_THREADS || 2),
      hashMb: Number(process.env.SF_HASH || 128),
      analyzeCount: engine.analyzeCount,
      optionCount: engine.identity.options.length,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      available: false,
      path: ENGINE_PATH,
      error: err.message,
      hint: '确认 stockfish 文件夹里有 stockfish-windows-x86-64-universal.exe',
    });
  }
});

// ------------------------------------------------------------
// 核心接口：分析一个局面
//   收到 { fen, depth }，交回引擎的推荐着法、评分、后续变化
//
//   ⚠️ 关于评分的一个关键约定：
//   鳕鱼原生给的分是「走棋方视角」——轮到黑走时 +1 表示黑好。
//   这非常容易把评估曲线看反，而且看反了还挺像那么回事。
//   所以我们在 engine.js 里统一翻转成「正数 = 白方占优」，
//   前端拿到的 scoreCp 永远是白方视角。
//
//   ⚠️ timeoutMs 是给「讲棋」那条链路准备的护栏，不是常规参数。
//      讲棋要的是**多路线**（multipv=3），而 MultiPV 的开销极度依赖局面：
//      实测同一台机器上，开局 0.8 秒、中局 2.6 秒、一边倒的战术局面要 16.6 秒。
//      只靠"层数"根本控制不住上限，所以多给一个墙钟上限：
//      到点就让引擎把手上的活收尾（发 stop），**返回已经算出来的那几条**。
//      宁可拿一份深度稍浅但及时的结论，也不要让用户对着转圈等十几秒。
// ------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  const body = req.body || {};
  const fen = body.fen;
  const depth = body.depth;
  const multipv = body.multipv;
  const timeoutMs = body.timeoutMs;

  if (typeof fen !== 'string' || !fen.trim()) {
    return res.status(400).json({ ok: false, error: '没收到局面（fen）' });
  }

  // 先用 chess.js 验一下这个局面认不认识，免得把垃圾喂给引擎
  let turn;
  try {
    const probe = new Chess(fen.trim());
    turn = probe.turn();
  } catch (err) {
    return res.status(400).json({ ok: false, error: '这个局面看不懂：' + err.message });
  }

  const t0 = Date.now();
  try {
    const engine = getEngine();
    const result = await engine.analyze(fen.trim(), { depth, multipv, timeoutMs });
    res.json(Object.assign({ ok: true, wallMs: Date.now() - t0, requestedDepth: Number(depth) || 16 }, result));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, turn, wallMs: Date.now() - t0 });
  }
});

// ------------------------------------------------------------
// 批量接口：一口气评估整盘棋的每一个局面
//   收到 { fens: [...], depth }，交回每条的评分
//
//   这是画评估曲线用的。和 /api/analyze 的区别是：
//   analyze 是「我现在盯着这一步，请仔细算」；
//   evaluate 是「把整盘棋都过一遍，快就行」——
//   所以曲线一般用更低的深度（默认 10），整局 50 步也就十几秒。
//
//   ⚠️ 为什么要一次性收一批，而不是各自发一个请求？
//      因为鳕鱼只能串行工作（见 engine.js 的队列）。前端一次发 50 个请求，
//      它们也只是在后端排队，反而白白多出 50 次网络往返。
//
//   ⚠️ 单条失败不会拖垮整批。终局局面（没法走棋）本来就会失败，
//      那条带 ok:false 返回，前端跳过它接着画。
// ------------------------------------------------------------
app.post('/api/evaluate', async (req, res) => {
  const body = req.body || {};
  const fens = Array.isArray(body.fens) ? body.fens : null;
  const depth = Math.min(Math.max(Number(body.depth) || 10, 4), 24);

  if (!fens || !fens.length) {
    return res.status(400).json({ ok: false, error: '没收到局面列表（fens）' });
  }
  if (fens.length > 40) {
    return res.status(400).json({ ok: false, error: '一次最多评估 40 个局面，请分批发送' });
  }

  const t0 = Date.now();
  const results = [];

  for (const fen of fens) {
    if (typeof fen !== 'string' || !fen.trim()) {
      results.push({ fen: String(fen == null ? '' : fen), ok: false, error: '局面是空的' });
      continue;
    }
    const clean = fen.trim();

    // 先用 chess.js 确认这局面认不认识，别把垃圾喂给引擎
    try {
      new Chess(clean);
    } catch (err) {
      results.push({ fen: clean, ok: false, error: '这个局面看不懂：' + err.message });
      continue;
    }

    try {
      const r = await getEngine().analyze(clean, { depth });
      results.push({
        fen: clean,
        ok: true,
        turn: r.turn,
        depth: r.depth,
        scoreCp: r.scoreCp,
        scoreMate: r.scoreMate,
        scoreText: r.scoreText,
        bestMove: r.bestMove,
        bestMoveSan: r.bestMoveSan,
      });
    } catch (err) {
      results.push({ fen: clean, ok: false, error: err.message });
    }
  }

  res.json({
    ok: true,
    depth,
    count: results.length,
    elapsedMs: Date.now() - t0,
    results,
  });
});

// ------------------------------------------------------------
// DeepSeek 状态：网页端打开时先问一句「讲棋功能能不能用」
//
// ⚠️ 这个响应会原样交给浏览器，所以里面**绝对不能有密钥**。
//    llm.info() 是专门为此写的：它只回答"配没配"和几个不敏感的参数，
//    密钥本身连字段都没有 —— 这是刻意的，不是忘了写。
//
//    加 ?probe=1 会真发一次极小的请求去验密钥。
//    花费几乎为零（几个 token），但能立刻告诉你 key 到底通不通，
//    比等到真讲棋的时候才发现"哦，抄错了一位"强得多。
// ------------------------------------------------------------
app.get('/api/llm', async (req, res) => {
  const llm = getLlm();

  // 没配密钥就别发请求了，本地就能回答
  if (req.query.probe !== '1' || !llm.configured) {
    const info = llm.info();
    return res.json(Object.assign({ ok: true, available: info.configured }, info));
  }

  const t0 = Date.now();
  let probe;
  try {
    const r = await llm.chat(
      [{ role: 'user', content: '只回复两个字：可以' }],
      { maxTokens: 8, temperature: 0, maxRetries: 0 }
    );
    probe = { ok: true, ms: Date.now() - t0, reply: String(r.text).slice(0, 20), model: r.model };
  } catch (err) {
    const e = (err instanceof LlmError) ? err : new LlmError('bad_response', err.message);
    probe = Object.assign({ ok: false, ms: Date.now() - t0 }, e.toJSON());
  }

  const info = llm.info();
  res.json(Object.assign({ ok: true, available: probe.ok, probe }, info));
});

// ------------------------------------------------------------
// 核心接口：请 DeepSeek 讲一讲这一手
//   收到 { fen, beforeFen, ply, san, color, engine, engineBefore, swing, history, ... }
//   交回 { text } —— 一段给业余棋手看的讲解
//
//   ⚠️ 这里最容易搞错的一点：**数字不归模型管**。
//      所有评分、最佳着法都是前端从鳕鱼那儿搬来的原文，我们只是转个手。
//      模型负责解释"为什么会这样"，不负责产生数据。
//      详见 coach.js 开头那段。
//
//   ⚠️ 前端送来的东西要挑着信（上面的 verifyBeforeFen 就是干这个的）。
//      但**从这些原始材料里推出的事实是我们自己算的** ——
//      "这一步动了哪个子""后续每一步之后的棋盘""首选和次选差多少"，
//      全部由 chess.js 在这里复算一遍。这才叫"把确定性的事交给代码"：
//      不是让它算得更花哨，是让它算得**不依赖任何人说实话**。
// ------------------------------------------------------------
app.post('/api/explain', async (req, res) => {
  const body = req.body || {};
  // ⚠️ 上限必须显式给 MAX_FEN。用 str() 默认的 60 会把中局以后的局面切掉尾巴，
  //    而 chess.js 对残缺 FEN 不报错（自己补默认值），切了也看不出来 —— 见 MAX_FEN 的注释。
  const fen = str(body.fen, MAX_FEN);

  if (!fen) {
    return res.status(400).json({ ok: false, code: 'bad_request', error: '没收到局面（fen）' });
  }

  // FEN 必须是完整的 6 个字段。chess.js 对缺字段是"能构造但局面变样"，
  // 所以这里自己先卡死：字段不全就直接拒，别让它带着一个悄悄变了的局面上路。
  if (fen.split(/\s+/).length !== 6) {
    return res.status(400).json({
      ok: false, code: 'bad_request',
      error: '局面（fen）不完整：FEN 需要 6 个字段，收到 ' + fen.split(/\s+/).length + ' 个。',
      detail: fen,
    });
  }

  // 局面得是真的 —— 拿 chess.js 认一下，别把垃圾喂给模型
  let turn;
  try {
    turn = new Chess(fen).turn();
  } catch (err) {
    return res.status(400).json({
      ok: false, code: 'bad_request',
      error: '这个局面看不懂：' + err.message,
    });
  }

  // 走这一步的是谁。前端说了就信它，没说就从步数推。
  const color = body.color === 'b' ? 'b'
    : body.color === 'w' ? 'w'
      : (Number(body.ply) % 2 === 1 ? 'w' : 'b');

  const san = str(body.san, 20);

  // ---------- 「走这一步之前那个局面」不能照单全收 ----------
  // 有了它，我们才能把"这一步动了哪个子、吃的是什么、这个局面他一共有几步可走"
  // 这些事用 chess.js 算准了再写进提示词（见 coach.js 开头第 ① 条）。
  //
  // 但它是前端送上来的 —— 万一送错了（翻页时错位、或者哪天接口被别处调用），
  // 算出来的"事实"就会是别人的局面里的事，模型照着讲一整套都是错的。
  // 所以这里做一次**自证**：把 beforeFen 走出 san，得到的必须正好是我们收到的 fen。
  // 对不上就整段丢掉 —— 宁可少讲，不能讲错。
  const beforeFen = verifyBeforeFen(str(body.beforeFen, MAX_FEN), san, fen);

  // ---------- 「再往前一手」那个局面：同样的自证，同一把尺子 ----------
  // 有了它，模型才能看清"走这一步之前 → 现在"这一步到底改了什么
  // （用户要的"先判断对手那步棋的目的"就是从这里读出来的）。
  // 但它同样是前端送上来的，所以照样要求它自证：prevFen 走出 prevSan
  // 必须正好得到 beforeFen。对不上就整段丢掉 —— 宁可少给一层，不给错的一层。
  const prevSan = str(body.prevSan, 20);
  const prevFen = beforeFen
    ? verifyBeforeFen(str(body.prevFen, MAX_FEN), prevSan, beforeFen)
    : '';

  const { messages, meta } = buildExplainPrompt({
    fen,
    beforeFen,
    prevFen,
    prevSan,
    ply: numOrNull(body.ply),
    san,
    color,
    engine: sanitizeEngine(body.engine),
    // 走之前那个局面的引擎结果（多路线）。同样过筛子。
    engineBefore: sanitizeEngine(body.engineBefore),
    // swing 里只信两个原始评分，其余我们自己算 —— 见 normalizeSwing
    swing: normalizeSwing(body.swing, color),
    history: strArray(body.history, 12, 12),
    opening: strArray(body.opening, 20, 12),
    annotation: str(body.annotation, 400),
    // 多轮记忆（最近几手的"要点"）。它是模型自己写的，不是事实，所以只当提醒用。
    recap: sanitizeRecap(body.recap),
    question: str(body.question, 400),
    gameOver: !!body.gameOver,
  });

  // ---------- 只看不发的"预演"模式 ----------
  // 传 dryRun:true 就只把拼好的提示词原样还回来，**不调用 DeepSeek**（不花钱）。
  // 它的用处很实在：讲得不对时，你要看的是"到底送出去了什么"，
  // 而后端日志里只有"讲成功没、几毫秒"。有了这个，工具脚本（probe-prompt.js）
  // 就能拿到与线上**完全一致**的那份原文，而不是自己另拼一份近似的。
  if (body.dryRun) {
    return res.json({
      ok: true,
      dryRun: true,
      system: messages[0].content,
      user: messages[1].content,
      meta,
      note: '这是本来要发给 DeepSeek 的原文，dryRun 没有真的发出去。',
    });
  }

  const t0 = Date.now();
  try {
    const r = await getLlm().chat(messages);
    // 日志里只记"讲成功没、花了多久"，不记正文（讲棋正文没什么排查价值，还占地方）
    console.log('[explain] 讲好了：第 ' + (meta.ply || '?') + ' 步 ' + (meta.san || '') +
      '，' + r.text.length + ' 字，第 ' + r.attempts + ' 次尝试，共 ' + (Date.now() - t0) + 'ms' +
      '｜候选 ' + (meta.hasAlternatives ? '多路线' : '单线') +
      (meta.moveVerified ? '，前后局面已核对' : '（没能核对前后局面）') +
      (meta.isForced ? '，这一步是被迫的' : '') +
      (meta.knowledge && meta.knowledge.motifs.length
        ? '，附了战术参考 ' + meta.knowledge.motifs.join('/') : ''));
    res.json({
      ok: true,
      text: r.text,
      model: r.model,
      usage: r.usage,
      attempts: r.attempts,
      elapsedMs: Date.now() - t0,
      meta,
    });
  } catch (err) {
    const e = (err instanceof LlmError) ? err : new LlmError('bad_response', err.message);
    // ⚠️ 只打 code 和消息，永远不打密钥
    console.warn('[explain] 没讲成：' + e.code + ' — ' + e.message);
    res.status(statusForLlmError(e)).json(Object.assign(
      { ok: false, error: e.message, elapsedMs: Date.now() - t0 },
      e.toJSON()
    ));
  }
});

// 错误类型 → HTTP 状态码。
// no_key 是"这项服务还没准备好"（503），bad_request 是"你发的请求有问题"（400），
// 其余全是上游 DeepSeek 那边的事（502）。前端主要看 code，状态码是给日志和工具看的。
function statusForLlmError(e) {
  if (e.code === 'no_key') return 503;
  if (e.code === 'bad_request') return 400;
  return 502;
}

// ---------- 收进来的东西，一律先过一遍筛子 ----------
// 前端送来的字段我们不照单全收：长度要掐、类型要正。
// 尤其是 PV 这类数组 —— 不限制的话，一个坏请求就能把 prompt 撑到几万 token。
function str(v, max = 60) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strArray(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string')
    .slice(0, maxItems)
    .map((x) => str(x, maxLen));
}

/**
 * 多轮记忆：前端把"之前几手讲过什么"的摘要送上来。
 *
 * 这些东西**不是**我们算出来的事实（是模型上一轮自己写的），所以照旧要过筛子：
 * 条数、长度、着法名的字符集都掐死，还顺手把材料里的段名标记（【】）剥掉 ——
 * 不然它可以被当成"指路的话"塞进正文，正是第二十轮刚治过的那种病。
 */
function sanitizeRecap(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(-5).map((r) => {
    if (!r || typeof r !== 'object') return null;
    const text = str(r.text, 60).replace(/[【】]/g, '');
    if (!text) return null;
    return {
      ply: numOrNull(r.ply),
      san: str(r.san, 12),
      text,
    };
  }).filter(Boolean);
}
/** 一个局面的引擎结果（主变化 + 若干次优解）过一遍筛子 */
function sanitizeEngine(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    scoreCp: numOrNull(e.scoreCp),
    scoreMate: numOrNull(e.scoreMate),
    scoreText: str(e.scoreText, 20),
    bestMoveSan: str(e.bestMoveSan, 12),
    // 走这一步**之前**那个局面，引擎建议走什么（也就是"本该走的那一步"）。
    // 前端从整局扫描或手动分析里顺手带来，这里只负责掐长度。
    bestMoveBeforeSan: str(e.bestMoveBeforeSan, 12),
    // 主变化放到 12 步：战术常常在第 2～4 步之间才显形（引离→叉子→杀），
    // 早先掐到 8 步会把最关键的那几手砍掉。
    pvSan: strArray(e.pvSan, 12, 12),
    // 次优解。前端要 multipv=3 才会有，拿不到就是空数组 —— 下游会自己跳过，
    // 不会因为"没有次优解"就编一个出来。
    alternatives: sanitizeAlternatives(e.alternatives),
    depth: numOrNull(e.depth),
  };
}

function sanitizeAlternatives(alts) {
  if (!Array.isArray(alts)) return [];
  return alts
    .filter((a) => a && typeof a === 'object' && str(a.firstMoveSan, 12))
    .slice(0, 3)
    .map((a) => ({
      rank: numOrNull(a.rank),
      firstMoveSan: str(a.firstMoveSan, 12),
      scoreCp: numOrNull(a.scoreCp),
      scoreMate: numOrNull(a.scoreMate),
      scoreText: str(a.scoreText, 20),
      pvSan: strArray(a.pvSan, 12, 12),
    }));
}

/**
 * 核对"走这一步之前那个局面"是不是真的。
 *
 * 判据只有一条：把 beforeFen 走出 san，得到的是不是我们收到的 fen。
 * 对得上，这个 beforeFen 就**必然是**那个局面的真实前身 —— 这不是"相信前端"，
 * 是它自己证明了自己。对不上就返回空串，下游会跳过所有依赖它的事实。
 *
 * ⚠️ 只比前四个字段（棋盘/轮到谁/易位权/过路兵），忽略半步计数和回合数 ——
 *    那两位是记账用的，两边算出来可能差一，不该因此否定整个局面。
 */
function verifyBeforeFen(beforeFen, san, fen) {
  if (!beforeFen || !san) return '';
  // 记谱里可能带着 !? 之类的装饰，先去掉再走 —— chess.js 不认这些
  const clean = san.replace(/[!?]/g, '');
  try {
    const game = new Chess(beforeFen);
    game.move(clean);
    return samePosition(game.fen(), fen) ? beforeFen : '';
  } catch {
    return '';
  }
}

// ------------------------------------------------------------
// 启动
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅ 服务器已启动');
  console.log('  👉 请在浏览器打开: http://localhost:' + PORT);
  console.log('  🐟 引擎路径: ' + ENGINE_PATH);
  if (engineFileReady()) {
    console.log('     （第一次分析时才真正启动鳕鱼，会等一两秒）');
  } else {
    // 最常见的"第一次跑不起来"就是这一条：stockfish/ 不进版本库，新机器上一定没有。
    console.log('');
    console.log('  ⚠️  没找到引擎文件 —— 算棋那部分现在用不了（讲棋、看棋谱不受影响）。');
    console.log('      下载地址: https://stockfishchess.org/download/  （Windows x86-64）');
    console.log('      把它解压出来的 exe 放到: ' + path.dirname(ENGINE_PATH));
    console.log('      文件名保持 stockfish-windows-x86-64-universal.exe，然后重启服务器。');
    console.log('      （或者用环境变量 STOCKFISH_PATH 指向你自己的引擎。）');
    console.log('');
  }

  const llm = getLlm();
  console.log(llm.configured
    ? '  🤖 讲棋: 已配置（' + llm.model + '）'
    : '  🤖 讲棋: 未配置 —— 在项目根目录的 .env 里写上 DEEPSEEK_API_KEY，保存后刷新页面即可');
  console.log('     （改了 .env 不用重启 —— 下一次请求就会读到新的）');
  console.log('');
});

// 退出时顺手把引擎进程收掉，别留孤儿进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { getEngine()._teardown(); } catch {}
    process.exit(0);
  });
}
