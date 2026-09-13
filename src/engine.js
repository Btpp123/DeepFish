// ============================================================
// engine.js —— 鳕鱼（Stockfish）的驱动程序
//
// 【这一层最容易翻车的地方，先说清楚】
//
// 鳕鱼不是「问一句答一句」的函数，它是个要一直陪着走的对话过程。
// 一次完整的分析长这样：
//
//     我们 → position fen ..........     （摆好局面）
//     我们 → go depth 16                 （开始算，注意：这不是"命令"，是"发车"）
//     鳕鱼 → info depth 1  score cp 20 ... pv e2e4      ← 过程播报，会来几十上百条
//     鳕鱼 → info depth 2  score cp 18 ... pv e2e4 e7e5
//     鳕鱼 → ...
//     鳕鱼 → bestmove e2e4 ponder c7c5  ← 【只有这一行才代表"算完了"】
//
// 所以在收到 bestmove 之前，绝对不能发新的 position —— 那属于未定义行为，
// 结果会串台（拿上一盘棋的分析回答这一盘）。
//
// 我们的对策：
//   1. 所有分析请求排成一队，一次只放一个进去（_queue）
//   2. 收到 bestmove 才 resolve 这个 Promise，队列才放行下一个
//   3. 万一引擎卡住，超时后发 stop 并兜底，避免整个服务僵死
// ============================================================

const { spawn } = require('child_process');
const path = require('path');
const { Chess } = require('chess.js');

// 引擎文件位置。可以用环境变量 STOCKFISH_PATH 覆盖
const ENGINE_PATH = process.env.STOCKFISH_PATH
  || path.join(__dirname, '..', 'stockfish', 'stockfish-windows-x86-64-universal.exe');

// 思考用几个线程、多少内存。你自己一个人用，2 线程 128MB 已经很快了。
// 想算得更快可以调大，但会和别的程序抢 CPU。
const THREADS = Number(process.env.SF_THREADS || 2);
const HASH_MB = Number(process.env.SF_HASH || 128);

// 一次分析最长等多久（毫秒）。超过就发 stop 强制收工。
//
// ⚠️ 这里说的"强制收工"是**收尾**，不是**失败**：
//    发 stop 之后，鳕鱼会把手上的搜索停下并照常吐出 bestmove ——
//    于是本次分析带着"已经算到的那几条线"正常返回（见 _onBestMove）。
//    所以 timeoutMs 实际上是个**软上限**：到点就交卷，
//    拿回来的 depth 会比要求的浅，但结论是能用的。
//    只有连 bestmove 都等不到（引擎真的僵住）才会走 reject 那条路。
//
//    这个语义正是"讲棋要多路线"所需要的那道护栏 —— 见 server.js 的 /api/analyze。
const DEFAULT_TIMEOUT = Number(process.env.SF_TIMEOUT || 30000);

// ---------- 小工具：把 UCI 着法串转成人看得懂的记谱 ----------
// 鳕鱼说的是 e2e4 / g1f3 / e7e8q 这种"机器话"，
// 我们用 chess.js 在脑子里把这盘棋重走一遍，换成 e4 / Nf3 / e8=Q。
function uciMovesToSan(fen, uciMoves) {
  const game = new Chess(fen);
  const sans = [];
  for (const uci of uciMoves) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) break; // 不是合法形状就别猜了
    const move = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    if (uci.length === 5) move.promotion = uci[4];
    try {
      const played = game.move(move);
      if (!played) break;
      sans.push(played.san);
    } catch {
      break; // 走不通就停在这里，能转多少算多少
    }
  }
  return sans;
}

/** 从 FEN 里读出「现在轮到谁走」 */
function turnOf(fen) {
  const parts = fen.trim().split(/\s+/);
  return parts[1] === 'b' ? 'b' : 'w';
}

// ============================================================
// 引擎本体
// ============================================================
class StockfishEngine {
  constructor(exePath = ENGINE_PATH) {
    this.exePath = exePath;

    this.proc = null;        // 子进程
    this.outBuf = '';        // stdout 的粘包缓冲
    this.errBuf = '';

    this.identity = { name: null, author: null, options: [] };
    this.starting = null;    // 启动中的 Promise（保证只启动一次）
    this.readyWaiters = [];  // 等 readyok 的人
    this.uciWaiters = [];    // 等 uciok 的人

    this.current = null;     // 正在进行的这次分析
    this.queue = Promise.resolve(); // 请求串行队列
    this.lastError = null;

    this.analyzeCount = 0;
  }

  // ---------- 启动 ----------
  ensureStarted() {
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.lastError = err.message;
        this._teardown();
        reject(err);
      };

      try {
        this.proc = spawn(this.exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        return fail(new Error('启动鳕鱼失败：' + err.message));
      }

      this.proc.on('error', (err) => {
        fail(new Error('鳕鱼进程出错：' + err.message + '（文件在不在？路径对不对？）'));
      });

      this.proc.on('exit', (code) => {
        if (this.current) {
          const c = this.current;
          this.current = null;
          c.reject(new Error('鳕鱼进程退出了（code ' + code + '）'));
        }
        this.starting = null;
        this.proc = null;
      });

      this.proc.stdout.on('data', (chunk) => this._onData(chunk.toString('utf8')));
      this.proc.stderr.on('data', (chunk) => { this.errBuf += chunk.toString('utf8'); });

      // 开始握手：先问它是谁、支持哪些参数
      this.uciWaiters.push(() => {
        // 知道有哪些参数之后，先调教好它
        this._send('setoption name Threads value ' + THREADS);
        this._send('setoption name Hash value ' + HASH_MB);
        this._send('isready');
        this.readyWaiters.push(() => {
          if (settled) return;
          settled = true;
          resolve(this);
        });
      });

      this._send('uci');

      // 万一引擎根本没反应（文件损坏、被防火墙拦了）
      setTimeout(() => fail(new Error('鳕鱼启动超时，10 秒内没收到 uciok。检查 ' + this.exePath)), 10000).unref?.();
    });

    // 启动失败的话，下次调用要能重试
    this.starting.catch(() => { this.starting = null; });

    return this.starting;
  }

  _teardown() {
    try { this.proc?.stdin.end(); } catch {}
    try { this.proc?.kill(); } catch {}
    this.proc = null;
    this.outBuf = '';
  }

  _send(cmd) {
    if (!this.proc) return;
    this.proc.stdin.write(cmd + '\n');
  }

  /** stdout 是按块来的，一行可能被切成两半，所以要缓存着拼回去 */
  _onData(text) {
    this.outBuf += text;
    let idx;
    while ((idx = this.outBuf.indexOf('\n')) >= 0) {
      const line = this.outBuf.slice(0, idx).replace(/\r$/, '');
      this.outBuf = this.outBuf.slice(idx + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    if (!line) return;

    if (line.startsWith('id name ')) {
      this.identity.name = line.slice(8).trim();
    } else if (line.startsWith('id author ')) {
      this.identity.author = line.slice(10).trim();
    } else if (line.startsWith('option name ')) {
      const m = line.match(/^option name (.+?) type (\w+)/);
      if (m) this.identity.options.push({ name: m[1], type: m[2] });
    } else if (line === 'uciok') {
      const waiters = this.uciWaiters;
      this.uciWaiters = [];
      waiters.forEach((fn) => fn());
    } else if (line === 'readyok') {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      waiters.forEach((fn) => fn());
    } else if (line.startsWith('info ')) {
      this._onInfo(line);
    } else if (line.startsWith('bestmove')) {
      this._onBestMove(line);
    }
  }

  /** 过程播报。我们只留「每个深度上最好的一条」，其余丢掉 */
  _onInfo(line) {
    if (!this.current) return;
    // lowerbound / upperbound 是「还只是上下界，没算准」，不算数
    if (line.includes(' lowerbound') || line.includes(' upperbound')) return;

    const pvMatch = line.match(/ pv (.+)$/);
    if (!pvMatch) return; // 只有 currmove 之类的进度行，没价值

    const depth = Number((line.match(/ depth (\d+)/) || [])[1] || 0);
    const multipv = Number((line.match(/ multipv (\d+)/) || [])[1] || 1);
    const scoreMatch = line.match(/ score (cp|mate) (-?\d+)/);
    if (!scoreMatch) return;

    const entry = {
      depth,
      multipv,
      scoreType: scoreMatch[1],
      scoreValue: Number(scoreMatch[2]),
      pv: pvMatch[1].trim().split(/\s+/),
      seldepth: Number((line.match(/ seldepth (\d+)/) || [])[1] || 0),
      nodes: Number((line.match(/ nodes (\d+)/) || [])[1] || 0),
      nps: Number((line.match(/ nps (\d+)/) || [])[1] || 0),
      timeMs: Number((line.match(/ time (\d+)/) || [])[1] || 0),
    };

    // 同一个 multipv 只有更深的才覆盖
    const prev = this.current.lines.get(multipv);
    if (!prev || entry.depth >= prev.depth) {
      this.current.lines.set(multipv, entry);
    }
    this.current.anyInfo = true;
  }

  _onBestMove(line) {
    const c = this.current;
    if (!c) return;
    this.current = null;
    clearTimeout(c.timer);

    const parts = line.split(/\s+/);
    const bestMove = parts[1] || null;
    const ponder = parts[3] || null; // 形如 "bestmove e2e4 ponder c7c5"

    c.raw = { bestMove, ponder, lines: [...c.lines.values()] };
    c.resolve(c.raw);
  }

  // ============================================================
  // 对外唯一入口：给一个局面，拿回分析结果
  // ============================================================
  analyze(fen, options = {}) {
    const depth = Math.min(Math.max(Number(options.depth) || 16, 4), 30);
    const multipv = Math.min(Math.max(Number(options.multipv) || 1, 1), 3);
    const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT;

    // 排到队尾。前面的人做完，才轮到我们。
    const run = () => this._analyzeNow(fen, depth, multipv, timeoutMs);
    const result = this.queue.then(run, run); // 前面失败也要继续排队
    // 队列只关心「做完了」，不关心成功失败，避免一次错误卡死后面所有人
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  async _analyzeNow(fen, depth, multipv, timeoutMs) {
    await this.ensureStarted();
    this.analyzeCount++;

    const raw = await new Promise((resolve, reject) => {
      const search = { lines: new Map(), resolve, reject, anyInfo: false };

      // 超时兜底：发 stop 让引擎把手上的活收尾
      search.timer = setTimeout(() => {
        this._send('stop');
        setTimeout(() => {
          if (this.current === search) {
            this.current = null;
            reject(new Error('鳕鱼分析超时（' + Math.round(timeoutMs / 1000) + ' 秒还没算完），已中止这次分析。'));
          }
        }, 3000);
      }, timeoutMs);

      this.current = search;

      if (multipv > 1) this._send('setoption name MultiPV value ' + multipv);
      this._send('position fen ' + fen);
      this._send('go depth ' + depth);
    });

    // 把队列留给下一个之前，先把 MultiPV 复位
    if (multipv > 1) {
      this._send('setoption name MultiPV value 1');
      this._send('isready');
    }

    return this._shape(fen, raw, depth);
  }

  /** 把引擎的原始输出整成前端好用的结构 */
  _shape(fen, raw, requestedDepth) {
    const turn = turnOf(fen);
    const sign = turn === 'b' ? -1 : 1; // UCI 是「走棋方视角」，我们要「白方视角」

    // ---------- 主分析（multipv 1）----------
    const main = raw.lines.find((l) => l.multipv === 1) || raw.lines[0] || null;

    let scoreCp = null;
    let scoreMate = null;
    if (main) {
      if (main.scoreType === 'cp') scoreCp = main.scoreValue * sign;
      else if (main.scoreType === 'mate') scoreMate = main.scoreValue * sign;
    }

    const bestMove = raw.bestMove && raw.bestMove !== '(none)' ? raw.bestMove : null;
    const bestMoveSan = bestMove ? (uciMovesToSan(fen, [bestMove])[0] || null) : null;
    const pv = main ? main.pv : [];
    const pvSan = pv.length ? uciMovesToSan(fen, pv) : [];

    // ---------- 多路线（如果开了 MultiPV）----------
    const alternatives = raw.lines
      .filter((l) => l.multipv > 1)
      .sort((a, b) => a.multipv - b.multipv)
      .map((l) => ({
        rank: l.multipv,
        scoreCp: l.scoreType === 'cp' ? l.scoreValue * sign : null,
        scoreMate: l.scoreType === 'mate' ? l.scoreValue * sign : null,
        scoreText: scoreText(l.scoreType === 'cp' ? l.scoreValue * sign : null,
                            l.scoreType === 'mate' ? l.scoreValue * sign : null),
        pv: l.pv,
        pvSan: uciMovesToSan(fen, l.pv),
        firstMoveSan: uciMovesToSan(fen, [l.pv[0]])[0] || null,
      }));

    return {
      fen,
      turn,
      depth: main ? main.depth : requestedDepth,
      seldepth: main ? main.seldepth : null,
      bestMove,
      bestMoveSan,
      ponder: raw.ponder || null,
      scoreCp,
      scoreMate,
      scoreText: scoreText(scoreCp, scoreMate),
      pv,
      pvSan,
      alternatives,
      nodes: main ? main.nodes : null,
      nps: main ? main.nps : null,
      timeMs: main ? main.timeMs : null,
    };
  }
}

/** 把分数说成人话。cp 是「厘兵」，100 = 1 个兵的优势 */
function scoreText(cp, mate) {
  if (mate !== null && mate !== undefined) {
    if (mate === 0) return '已经将杀';
    return mate > 0 ? '白方 ' + mate + ' 步内将杀' : '黑方 ' + Math.abs(mate) + ' 步内将杀';
  }
  if (cp === null || cp === undefined) return '—';
  const pawns = cp / 100;
  const shown = (Math.abs(pawns) >= 10 ? Math.round(pawns) : pawns.toFixed(2));
  const signStr = pawns > 0 ? '+' : pawns < 0 ? '' : '±';
  return signStr + shown;
}

// ---------- 全局单例：一个进程服务所有请求 ----------
let singleton = null;
function getEngine() {
  if (!singleton) singleton = new StockfishEngine();
  return singleton;
}

module.exports = { getEngine, StockfishEngine, ENGINE_PATH, uciMovesToSan };
