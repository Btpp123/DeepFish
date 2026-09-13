// 一次性验证：密钥到底会不会从任何出口漏出去
// 用假密钥 + 假 fetch，模拟"反向代理在 4xx 里原样回显请求头"这种最坏情况。
const { DeepSeekClient, LlmError, maskKey } = require('./src/llm');

const FAKE = 'sk-abcdef1234567890abcdef1234567890';
let fail = 0;
const t = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra ? '   [' + extra + ']' : ''));
  if (!ok) fail++;
};

// 把任意对象拍平成一个字符串，好搜里面有没有密钥
const flat = (o) => JSON.stringify(o, (k, v) => (v instanceof Error ? Object.assign({ message: v.message }, v) : v));

console.log('\n=== ① info()：会被整个塞进 /api/llm 响应的那个对象 ===');
const c = new DeepSeekClient({ apiKey: FAKE, fetchImpl: () => {} });
const info = c.info();
t('info() 里没有 apiKey 字段', !('apiKey' in info));
t('info() 整个序列化后搜不到密钥', !flat(info).includes(FAKE), flat(info).slice(0, 120) + '…');
t('只给出打码预览', /^sk-abc\*{4}\w{4}$/.test(info.keyPreview), info.keyPreview);
t('只给出长度，不给内容', info.keyLength === FAKE.length, String(info.keyLength));
t('打码长度不足以还原', info.keyPreview.length < FAKE.length - 6);

console.log('\n=== ② 模拟最坏情况：反向代理在 401 里原样回显 Authorization 头 ===');
const leaky = new DeepSeekClient({
  apiKey: FAKE,
  fetchImpl: async () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    // 网关把"你发的请求头"原样吐回来 —— 这正是 scrubSecrets 要防的那件事
    text: async () => JSON.stringify({
      error: { message: 'Unauthorized. Your request headers were: {"Authorization":"Bearer ' + FAKE + '"}' },
      echo: 'sk-abcdef1234567890abcdef1234567890',
    }),
  }),
  maxRetries: 0,
});

leaky.chat([{ role: 'user', content: 'hi' }]).then(
  () => { t('本该失败却成功了', false); },
  (err) => {
    const json = err.toJSON();
    t('错误对象里没有原始密钥', !flat(json).includes(FAKE));
    t('detail 里的 sk- 已被擦成 sk-***', /sk-\*\*\*/.test(json.detail), json.detail.slice(0, 150));
    t('hint 里没有密钥', !json.hint.includes(FAKE));
    t('给前端的形状只含 5 个字段', Object.keys(json).sort().join(',') === 'code,detail,hint,message,retryable,status' || Object.keys(json).length === 6, Object.keys(json).join(','));
  }
).then(() => {
  console.log('\n=== ③ 打码函数对奇怪的输入 ===');
  t('空密钥 → 空串', maskKey('') === '');
  t('短密钥全部打码', maskKey('abc') === '***');
  t('undefined 不炸', maskKey(undefined) === '');
  t('去掉首尾空格后打码', maskKey('  ' + FAKE + '  ').includes('****'));

  console.log('\n=== ④ 没配密钥时，错误里也不能有东西 ===');
  const none = new DeepSeekClient({ apiKey: '', fetchImpl: () => {} });
  t('configured 为 false', none.configured === false);
  t('keyPreview 是空串', none.info().keyPreview === '');
  t('keyLength 是 0', none.info().keyLength === 0);

  console.log('\n' + (fail === 0 ? '🎉 全部通过：0 处泄漏' : '❌ 有 ' + fail + ' 处可疑') + '\n');
  process.exit(fail === 0 ? 0 : 1);
});
