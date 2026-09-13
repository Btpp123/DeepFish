// ============================================================
// llm.js —— DeepSeek 的调用封装
//
// 【这一层存在的唯一理由：密钥不能进浏览器】
//
// 前端那份 JS 是"发给全世界看的"东西 —— 任何人按 F12 都能读到源码。
// 所以密钥一旦写进 app.js，等于贴在网上公告栏里，几分钟内就会被爬虫
// 捞去刷爆你的账户。这类事故每天都在发生。
//
// 于是链路必须是这样：
//
//     浏览器 ──► 我们自己的后端 ──(HTTPS + Authorization 头)──► api.deepseek.com
//                 ↑ 密钥只在这台机器上、只存在于这个进程的内存里
//
// 浏览器从头到尾没见过密钥，它只跟 localhost 说话。
//
// 【第二件事：把失败讲清楚】
//
// 调外部接口会失败，而且失败的原因天差地别：密钥抄错了、余额花完了、
// 被限流了、人家服务器挂了、网线断了……这些对用户来说是完全不同的
// 处理方式（去改配置 / 去充值 / 等一会儿 / 检查网络）。
// 一律抛一句"请求失败"等于没帮上忙。
//
// 所以这里把错误分成若干种，每种带一句「接下来该干什么」：
//     err.code   机器看的（程序据此决定要不要重试）
//     err.hint   人看的（直接显示给用户）
// ============================================================

const fs = require('fs');
const path = require('path');

// 显式指定 .env 的位置，不用 cwd。
// 理由和 server.js 里静态目录一样：从哪个目录敲启动命令都不该影响结果。
const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * 读 .env。
 *
 * 【为什么要盯着文件的修改时间，而不是启动时读一次就完事】
 * 启动时读一次是 dotenv 的默认姿势，也是最容易让人白折腾半天的坑：
 * 用户刚申请到密钥、填进 .env、保存、刷新页面 —— 一切看起来都对，
 * 可程序还在用进程启动那一刻的内存快照，于是"填了密钥却用不了"。
 * 他没有任何线索能看出问题在这个环节上。
 *
 * 所以这里每次都看一眼 .env 的修改时间：
 *   - 文件变了 → 允许覆盖已有的环境变量（用户就是要换掉旧的）
 *   - 文件没变 → 沿用 dotenv 的默认规矩「已存在的环境变量优先」
 *     （部署时用真·环境变量喂进来的配置，不该被一个随手的 .env 顶掉）
 *
 * 结果是：改完 .env 保存，下一次请求就生效，不用重启。
 */
let envStamp = null;

function loadEnvFile() {
  let stamp;
  try {
    stamp = fs.statSync(ENV_PATH).mtimeMs;
  } catch {
    return false;   // 没有 .env 是正常情况，不是错误
  }

  // 第一次读还不算"变了" —— 那会儿内存里什么都没有，用默认规矩即可
  const changed = envStamp !== null && stamp !== envStamp;
  envStamp = stamp;

  try {
    require('dotenv').config({ path: ENV_PATH, override: changed });
    return true;
  } catch {
    /* 没有 dotenv 也能跑 —— 那就只能靠外部传进来的环境变量 */
    return false;
  }
}

loadEnvFile();

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1200;

// ============================================================
// 错误：每一种都带一句「接下来该干什么」
// ============================================================

/**
 * @property {string} code      机器码，程序据此判断该不该重试
 * @property {number|null} status HTTP 状态码（本地就失败的场合是 null）
 * @property {boolean} retryable 重试有没有意义
 * @property {number} retryAfterMs 对方要求的等待时间（来自 Retry-After 头）
 * @property {string} hint      给人看的一句话：现在该去做什么
 * @property {string} detail    接口原样吐回来的内容（截断过），排查用
 */
class LlmError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = opts.status ?? null;
    this.retryable = !!opts.retryable;
    this.retryAfterMs = opts.retryAfterMs || 0;
    this.hint = opts.hint || '';
    this.detail = opts.detail || '';
  }

  /** 给前端用的形状。注意：这里不可能泄漏密钥 —— 它压根不在这条信息流上 */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      status: this.status,
      retryable: this.retryable,
      detail: this.detail,
    };
  }
}

// 每种错误对应的「人话」。抽成一张表，好读、好改、好测。
const HINTS = {
  no_key:
    '还没配置密钥。在项目根目录建一个 .env 文件（可以照着 .env.example 改），' +
    '写上一行 DEEPSEEK_API_KEY=sk-你的密钥，保存后刷新页面就行 —— 不用重启服务器。',
  auth:
    'DeepSeek 说这个密钥不认。（1）确认 .env 里那一行没有多余的空格或引号；' +
    '（2）去 platform.deepseek.com 看看这个 key 是不是已经被删了或过期；' +
    '（3）重新生成一个换上去，保存后刷新页面即可（不用重启）。',
  insufficient_balance:
    '账户余额不足。去 platform.deepseek.com 充值，然后重新点一次。' +
    '（讲棋每次消耗很少，充一点点就够用很久。）',
  rate_limit: '请求太频繁，被 DeepSeek 限流了。等几秒再点一次就好。',
  server:
    '这是 DeepSeek 那边的问题，不是你的配置问题。指数退避已经自动重试过了，' +
    '还是不行就过几分钟再试 —— 也可以去 status.deepseek.com 看看。',
  network:
    '连不上 DeepSeek。先确认这台机器能上外网；如果是公司网络或代理环境，' +
    '还要确认 api.deepseek.com 没有被拦。',
  timeout:
    '等太久了。模型正忙的时候会慢一点，再点一次通常就好；' +
    '总是超时的话，把 .env 里的 DEEPSEEK_TIMEOUT_MS 调大（单位毫秒）。',
  bad_request:
    '请求本身被拒了。这基本是程序这边的毛病，不是你做错了什么 —— ' +
    '把下面那段原始信息发出来就能定位。',
  bad_response:
    'DeepSeek 回了一句读不懂的话（不是预期的格式）。再试一次；一直这样' +
    '多半是 models 名字写错了 —— 检查 .env 里的 DEEPSEEK_MODEL。',
  aborted: '这次请求被取消了。',
};

function llmError(code, message, opts = {}) {
  // opts 里没写 hint 就套用这张表的默认说法；写了就用写的
  const hint = opts.hint || HINTS[code] || '';
  return new LlmError(code, message, Object.assign({}, opts, { hint }));
}

// ============================================================
// 小工具
// ============================================================

/**
 * 擦掉文本里任何长得像密钥的东西。
 *
 * 正常情况用不上：DeepSeek 的报错不会回显我们发过去的密钥。
 * 但"正常情况"是靠不住的 —— 一旦哪天 base_url 指向了某个反向代理、
 * 网关或自建中转，它在 4xx 的报错里原样回显请求头是完全可能的。
 * 而这段 detail 会被一路送到浏览器界面上。
 *
 * 这种保险平时看不出价值，出事那天价值极大 —— 所以在最靠里的地方做一次。
 */
function scrubSecrets(s) {
  return String(s == null ? '' : s)
    .replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{6,}/gi, '$1***');
}

/** 把可能很长的响应体截短，免得一大坨 HTML 灌进日志和界面 */
function truncate(s, n = 300) {
  const t = scrubSecrets(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 接口地址。约定 DEEPSEEK_BASE_URL 是「根」，我们负责接上 /chat/completions。
 *
 * 官方两种写法都有效，所以这里不用做任何聪明处理：
 *     https://api.deepseek.com      → .../chat/completions
 *     https://api.deepseek.com/v1   → .../v1/chat/completions
 * 自建的 OpenAI 兼容服务（vLLM、Ollama、公司内网代理）填到 /v1 为止就行。
 */
function resolveEndpoint(baseUrl, explicitEndpoint) {
  if (explicitEndpoint) return explicitEndpoint;
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') + '/chat/completions';
}

/** 从接口的报错体里挖出它想说的话 */
function apiMessageOf(data) {
  if (!data || typeof data !== 'object') return '';
  const e = data.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return e.message || e.type || e.code || '';
  return data.message || '';
}

/** HTTP 状态码 → 我们的错误分类 */
function classifyHttp(status, data, rawText, retryAfterMs) {
  const detail = truncate(apiMessageOf(data) || rawText);
  const base = { status, detail };

  if (status === 401 || status === 403) {
    // 密钥不对。重试一百次也还是不对。
    return llmError('auth', 'DeepSeek 拒绝了这次请求：密钥无效（HTTP ' + status + '）', base);
  }
  if (status === 402) {
    return llmError('insufficient_balance', 'DeepSeek 账户余额不足（HTTP 402）', base);
  }
  if (status === 429) {
    return llmError('rate_limit', '被 DeepSeek 限流了（HTTP 429）',
      Object.assign({ retryable: true, retryAfterMs }, base));
  }
  if (status === 400 || status === 422) {
    return llmError('bad_request', 'DeepSeek 说这个请求不合法（HTTP ' + status + '）', base);
  }
  if (status >= 500) {
    return llmError('server', 'DeepSeek 服务器出错（HTTP ' + status + '）',
      Object.assign({ retryable: true }, base));
  }
  return llmError('bad_request', 'DeepSeek 返回了意料之外的 HTTP ' + status, base);
}

// ============================================================
// 客户端
// ============================================================

class DeepSeekClient {
  /**
   * 所有参数都可以显式传进来（测试用），不传就从环境变量读。
   *
   *   DEEPSEEK_API_KEY      密钥（必填，没有就只用不了讲棋功能，其余照常）
   *   DEEPSEEK_BASE_URL     接口根地址
   *   DEEPSEEK_MODEL        模型名
   *   DEEPSEEK_TIMEOUT_MS   单次请求最多等多久
   *   DEEPSEEK_MAX_RETRIES  可重试错误最多重试几次
   *   DEEPSEEK_TEMPERATURE  发挥程度（0=死板，1=活泼）
   *   DEEPSEEK_MAX_TOKENS   回复长度上限
   */
  constructor(options = {}) {
    // 可注入 —— 测试时换成假的，就能在没有网络、没有密钥的情况下
    // 把「401 会怎样」「429 会重试几次」这些分支全部走一遍。
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.sleepImpl = options.sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // 记录最近一次真实调用的一些数字，给 /api/llm 用
    this.lastCall = null;

    this.refreshFromEnv();

    // 显式传进来的参数压过环境变量（测试就是这么用的）
    if (options.apiKey !== undefined) this.apiKey = options.apiKey;
    if (options.baseUrl) this.baseUrl = options.baseUrl;
    if (options.model) this.model = options.model;
    if (options.endpoint !== undefined) this.endpoint = resolveEndpoint(this.baseUrl, options.endpoint);
    if (options.timeoutMs !== undefined) {
      this.timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    }
    if (options.maxRetries !== undefined) {
      this.maxRetries = Number(options.maxRetries);
      if (!Number.isFinite(this.maxRetries) || this.maxRetries < 0) this.maxRetries = DEFAULT_MAX_RETRIES;
    }
    if (options.temperature !== undefined) this.temperature = Number(options.temperature);
    if (options.maxTokens !== undefined) this.maxTokens = Number(options.maxTokens);
  }

  /**
   * 把配置重新从环境变量里读一遍。
   *
   * 构造函数调它，getLlm() 每次也调它 —— 这就是"改完 .env 保存、
   * 刷新页面就能用"的实现方式。踩过的坑：原来只在进程启动时读一次，
   * 于是用户填好密钥之后怎么刷新都不生效，而屏幕上一点提示都没有。
   */
  refreshFromEnv() {
    const env = process.env;

    this.apiKey = env.DEEPSEEK_API_KEY || '';

    const baseUrl = env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL;
    this.baseUrl = baseUrl;
    this.model = env.DEEPSEEK_MODEL || DEFAULT_MODEL;
    this.endpoint = resolveEndpoint(baseUrl, env.DEEPSEEK_ENDPOINT);

    this.timeoutMs = Number(env.DEEPSEEK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    this.maxRetries = env.DEEPSEEK_MAX_RETRIES !== undefined
      ? Number(env.DEEPSEEK_MAX_RETRIES) : DEFAULT_MAX_RETRIES;
    if (!Number.isFinite(this.maxRetries) || this.maxRetries < 0) this.maxRetries = DEFAULT_MAX_RETRIES;

    this.temperature = Number(env.DEEPSEEK_TEMPERATURE || DEFAULT_TEMPERATURE);
    this.maxTokens = Number(env.DEEPSEEK_MAX_TOKENS || DEFAULT_MAX_TOKENS);

    return this;
  }

  /** 配好密钥了吗？没配就不必发请求，本地就能下结论 */
  get configured() {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0;
  }

  /**
   * 给外面看的自我介绍。
   * ⚠️ 这里**故意**没有 apiKey 字段 —— 这个对象会被整个塞进 HTTP 响应，
   *    多一个字段就是一次泄漏。这不是疏忽，是刻意的。
   */
  info() {
    return {
      configured: this.configured,
      model: this.model,
      baseUrl: this.baseUrl,
      endpoint: this.endpoint,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      // 只暴露"有没有"和长度，不暴露内容
      keyLength: this.configured ? this.apiKey.trim().length : 0,
      keyPreview: this.configured ? maskKey(this.apiKey) : '',
      lastCall: this.lastCall,
    };
  }

  /**
   * 发一次对话请求，拿回模型的回复。
   *
   * @param {Array<{role:string,content:string}>} messages
   * @returns {Promise<{text:string, reasoning:string, model:string, usage:object, wallMs:number, attempts:number}>}
   */
  async chat(messages, options = {}) {
    if (!this.configured) {
      throw llmError('no_key', '还没配置 DeepSeek 密钥（DEEPSEEK_API_KEY）');
    }
    if (!Array.isArray(messages) || !messages.length) {
      throw llmError('bad_request', '没给对话内容（messages 是空的）');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw llmError('bad_request', '这个 Node 没有可用的 fetch（需要 Node 18 以上）');
    }

    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : this.maxRetries;
    const t0 = Date.now();
    let attempt = 0;
    let lastError = null;

    for (attempt = 0; attempt <= maxRetries; attempt++) {
      // 第 0 次直接发；之后每重试一次，等的时间翻倍（指数退避）。
      // 为什么不一失败就立刻重发？因为如果是限流或对方过载，
      // 立刻重发只会让情况更糟 —— 等一会儿才有意义。
      if (attempt > 0) {
        const wait = backoffDelay(attempt, lastError && lastError.retryAfterMs);
        await this.sleepImpl(wait);
      }
      try {
        const result = await this._once(messages, options);
        result.attempts = attempt + 1;
        result.totalMs = Date.now() - t0;
        this.lastCall = { ok: true, at: new Date().toISOString(), attempts: result.attempts, totalMs: result.totalMs };
        return result;
      } catch (err) {
        lastError = err;
        if (!(err instanceof LlmError)) {
          // 意料之外的异常：包一层，但保留原始信息，别把它吞了
          lastError = llmError('bad_response', '调用 DeepSeek 时出了意外：' + err.message, {
            detail: truncate(err.stack || '', 400),
          });
        }
        if (!lastError.retryable || attempt === maxRetries) {
          this.lastCall = {
            ok: false, at: new Date().toISOString(),
            attempts: attempt + 1, code: lastError.code, totalMs: Date.now() - t0,
          };
          throw lastError;
        }
      }
    }

    throw lastError || llmError('bad_response', '调用 DeepSeek 失败');
  }

  /** 真的发一次。成功返回结果，失败抛 LlmError（可能可重试） */
  async _once(messages, options) {
    const body = {
      model: options.model || this.model,
      messages,
      stream: false,               // 一次性拿完，省去处理分片的复杂度
      temperature: options.temperature !== undefined ? options.temperature : this.temperature,
      max_tokens: options.maxTokens !== undefined ? options.maxTokens : this.maxTokens,
    };

    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    const t0 = Date.now();
    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 密钥只在这一行出现 —— 从服务器到 DeepSeek 的加密连接里
          Authorization: 'Bearer ' + this.apiKey.trim(),
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
        throw llmError('timeout',
          '等了 ' + Math.round(timeoutMs / 1000) + ' 秒还没等到 DeepSeek 回复');
      }
      // 连 DNS 都解析不了、连接被拒、TLS 握手失败都会走到这里
      throw llmError('network', '连不上 DeepSeek：' + (err && err.message ? err.message : '网络错误'), {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const wallMs = Date.now() - t0;

    // 读响应体也可能失败（连接中途断掉），所以也要包起来。
    // 而且**必须先拿到文本再 JSON.parse** —— 出错的响应常常是 HTML
    // （网关返回的页面），直接 .json() 会抛一个跟真实原因毫不相干的错。
    let rawText = '';
    try {
      rawText = await res.text();
    } catch (err) {
      throw llmError('network', '读 DeepSeek 的回复时连接断了：' + err.message, { retryable: true });
    }

    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      throw classifyHttp(res.status, data, rawText, parseRetryAfter(res.headers));
    }

    if (!data || typeof data !== 'object') {
      // 消息保持短，原始片段放 detail —— 界面上错误消息一行能读完，
      // 想深究的人再展开"技术细节"
      throw llmError('bad_response', 'DeepSeek 的回复不是 JSON（多半是中间有代理插了一页 HTML）', {
        detail: truncate(rawText, 200),
      });
    }

    // OpenAI 兼容格式：choices[0].message.content
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const message = choice && choice.message ? choice.message : null;
    const content = message && typeof message.content === 'string' ? message.content.trim() : '';

    if (!content) {
      // 有一种正经情况会走到这：模型把长度全花在"思考"上了。
      // 分开说，比笼统来一句"格式不对"有用。
      const reason = choice && choice.finish_reason;
      const why = reason === 'length'
        ? '（它的话被长度上限截断了，把 DEEPSEEK_MAX_TOKENS 调大试试）'
        : '';
      throw llmError('bad_response', 'DeepSeek 回复里没有正文' + why, {
        detail: truncate(rawText, 200),
      });
    }

    return {
      text: content,
      // deepseek-reasoner 会额外给一段思考过程。现在不展示，但留着，
      // 以后想做"显示它的思考"不用回头改这里。
      reasoning: (message && message.reasoning_content) || '',
      model: data.model || body.model,
      usage: data.usage || null,
      finishReason: choice ? choice.finish_reason || null : null,
      wallMs,
    };
  }
}

/** 退避时长：800ms、1.6s、3.2s…… 但限流方明确说了等多久就听它的 */
function backoffDelay(attempt, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 10000);
  const base = 800 * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 200;   // 加一点随机，避免多个请求同时醒过来
  return Math.min(base + jitter, 10000);
}

/** 解析 Retry-After 响应头（可能是秒数，也可能是日期） */
function parseRetryAfter(headers) {
  try {
    const v = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
    if (!v) return 0;
    const sec = Number(v);
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
    const when = Date.parse(v);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
    return 0;
  } catch {
    return 0;
  }
}

/**
 * 把密钥打成 sk-abcd****wxyz，好让人确认"填的是哪一个"，
 * 又不足以被人拿去用。
 */
function maskKey(key) {
  const k = String(key || '').trim();
  if (k.length <= 10) return '*'.repeat(k.length);
  return k.slice(0, 6) + '****' + k.slice(-4);
}

// ---------- 全局单例：和引擎对称的写法 ----------
let singleton = null;

/**
 * 拿客户端。
 *
 * ⚠️ 每次都要重新看一眼 .env。
 * 因为这个函数是每个请求都会走的路 —— 用户在编辑 .env 存好密钥之后，
 * 下一个请求（也就是他刷新页面那一下）就该读到新的密钥。
 * 只在进程启动时读一次的后果，我们真踩过：填了密钥却一直用不了，
 * 界面上还什么都不说，完全看不出问题在哪。
 */
function getLlm() {
  loadEnvFile();
  if (!singleton) singleton = new DeepSeekClient();
  else singleton.refreshFromEnv();
  return singleton;
}

module.exports = {
  DeepSeekClient,
  LlmError,
  getLlm,
  loadEnvFile,
  ENV_PATH,
  resolveEndpoint,
  maskKey,
  backoffDelay,
  HINTS,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
};
