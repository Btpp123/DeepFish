// 第0阶段：用代码跟鳕鱼对话，验证「排队叫号」机制
const { spawn } = require('child_process');

const SF = 'D:\\wbdy-work\\project\\stockfish\\stockfish-windows-x86-64-universal.exe';
const sf = spawn(SF, [], { windowsHide: true });

const send = (cmd) => { console.log('  >>> ' + cmd); sf.stdin.write(cmd + '\n'); };

let bestMove = null;

sf.stdout.on('data', (buf) => {
  for (const line of buf.toString().split('\n')) {
    const t = line.trim();
    if (!t) continue;

    // 只显示每个深度的最终结论，避免刷屏
    const m = t.match(/^info depth (\d+) .*score (cp|mate) (-?\d+) .* pv (.+)$/);
    if (m) {
      const [, depth, type, val, pv] = m;
      const shown = type === 'cp' ? (val / 100).toFixed(2) : ('mate ' + val);
      console.log(`  [depth ${depth}] 分数=${shown}  最佳线=${pv.split(' ').slice(0, 6).join(' ')}`);
    }

    if (t.startsWith('bestmove')) {
      bestMove = t.split(' ')[1];
      console.log(`  <<< 这就是「上完菜」的信号：${t}`);
      console.log('');
      console.log(`=== 结论：鳕鱼给出最佳着法 = ${bestMove} ===`);
      sf.kill();
      process.exit(0);
    }
  }
});

sf.stderr.on('data', (d) => console.error('ERR: ' + d));

console.log('启动鳕鱼，开始对话：\n');
send('uci');            // 1. 打招呼，问它支持什么
send('isready');        // 2. 确认它准备好了
send('position startpos'); // 3. 摆好初始棋盘
send('go depth 12');    // 4. 开始算，深度12
