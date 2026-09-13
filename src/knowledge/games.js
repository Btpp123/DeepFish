// ============================================================
// knowledge/games.js —— 经典对局「复盘要点」样例库
//
// 【为什么是"要点"而不是整盘棋】
// 把整盘棋塞进提示词，一是太贵（一次几千 token，每次讲棋都要付），
// 二是**有害**：模型会拿着"不朽之局"的剧情去套当前这盘业余对局。
// 所以每条只留三样东西：
//   1. 决定性那几步（着法原文，不留解释性废话）
//   2. 这几步在讲什么道理（一句话）
//   3. 怎么在实战里认出来（一句话）
//
// 【它的定位】
// 这是给模型"见过世面"用的：让它知道"引离 + 底线杀"长什么样，
// 而不是让它照着背。提示词里明写：对不上当前局面就不要提。
//
// 【两个字段的分工】
//   motifs —— 这盘棋示范了哪些战术母题（和 tactics.js 的 id 对得上）
//   tags   —— 这盘棋适合在什么局面下被端出来（阶段、有没有将杀、是不是吃子…）
// 选哪一盘由 knowledge/index.js 按当前局面的特征算，见那里的说明。
//
// 【着法来源】
// 均为有公开记载的历史对局，着法序列取自公开棋谱（多个来源交叉核对）。
// 描述部分是本项目自己写的复盘要点，力求准确、简短、可验证。
// ============================================================

const GAMES = [
  {
    id: 'opera',
    name: '歌剧院之局',
    players: 'Paul Morphy 对 布伦瑞克公爵与伊苏阿尔伯爵',
    event: '巴黎歌剧院，1858 年',
    line: '10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7! Rxd7 ' +
      '14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+! Nxb8 17. Rd8#',
    idea: 'Morphy 在 10 回合内把所有的子都调到了战场上，而对手在反复动同一个子。' +
      '收尾是一串连弃（车、象、后），每一次弃子都不是为了赚子，' +
      '而是为了把防守方的子引到特定格子上去，最后车在底线成杀。',
    spot: '对手的王没易位、停在中心；你的车已经叠在半开放的 d 线上；' +
      '对方的子互相挤在一起、自己堵住自己的退路 —— 这时候就去找"先弃一个把挡路的引开"的路子。',
    motifs: ['deflection', 'backRank', 'sacrifice', 'quiet'],
    tags: ['mate', 'capture', 'sacrifice', 'sharpswing', 'uncastledKing', 'opening'],
  },
  {
    id: 'immortal',
    name: '不朽之局',
    players: 'Adolf Anderssen 对 Lionel Kieseritzky',
    event: '伦敦，1851 年',
    line: '18. Bd6! Bxg1 19. e5! Qxa1+ 20. Ke2 Na6 21. Nxg7+ Kd8 ' +
      '22. Qf6+! Nxf6 23. Be7#',
    idea: '白方把两个车、一个象、最后连后都送了出去，只为了换一件事：' +
      '让黑王无处可去。最后成杀的是象和马，一兵一卒都不剩的残兵。' +
      '它说明"子力价值表"是工具不是教条 —— 换来的若是将杀，多大都值。',
    spot: '对方的王在中心、四周的格子都被它自己的子占着；' +
      '你还有两个轻子能调动 —— 这时候去数"我有几条线能将军"，而不是数"我少了几个子"。',
    motifs: ['sacrifice', 'clearance', 'mate', 'quiet'],
    tags: ['mate', 'check', 'sacrifice', 'sharpswing', 'middlegame'],
  },
  {
    id: 'evergreen',
    name: '常青局',
    players: 'Adolf Anderssen 对 Jean Dufresne',
    event: '柏林，1852 年（埃文斯弃兵开局）',
    line: '19. Rad1 Qxf3 20. Rxe7+! Nxe7 21. Qxd7+! Kxd7 22. Bf5+（双将）Ke8 ' +
      '23. Bd7+ Kf8 24. Bxe7#',
    idea: '黑方吃掉 f3 的马，以为白方会回吃；白方却先弃车、再弃后，' +
      '把黑王从 e8 一路赶到 f8，最后用象吃掉 e7 的子成杀。' +
      '中间的 Bf5+ 是双将：两子同将，黑方只有动王一条路。',
    spot: '对方的王没能易位、停在中心；你手上有两个远程子能对着它；' +
      '这时候弃一个子把王"赶出来"，比多守一个兵划算得多。',
    motifs: ['sacrifice', 'doublecheck', 'decoy', 'mate'],
    tags: ['mate', 'check', 'sacrifice', 'sharpswing', 'uncastledKing', 'middlegame'],
  },
  {
    id: 'legal',
    name: '莱加尔杀（陷阱型）',
    players: '源自 Sire de Légal 的著名陷阱，后世反复出现',
    event: '巴黎，18 世纪',
    line: '1. e4 e5 2. Nf3 d6 3. Bc4 Bg4?! 4. Nc3 g6?? 5. Nxe5! Bxd1 ' +
      '6. Bxf7+ Ke7 7. Nd5#',
    idea: '白方把王后直接送到对方象的嘴上让它吃掉（Bxd1），看着像白送一个后；' +
      '但接下来两步就把黑王闷死在中间：Bxf7+ 逼王上前，Nd5 成杀。' +
      '这是业余对局里出现频率最高的陷阱，两个马就能把王关死。',
    spot: '对方在开局就用象到 g4 牵制你的马、同时又走了 g6 或 e6 这类"给王开了个洞"的步子 —— ' +
      '这时候 Nxe5 值得算一遍。',
    motifs: ['sacrifice', 'pin', 'fork', 'mate'],
    tags: ['mate', 'check', 'capture', 'sacrifice', 'opening', 'uncastledKing'],
  },
  {
    id: 'century',
    name: '世纪之战',
    players: 'Donald Byrne 对 Robert Fischer（当时 13 岁）',
    event: '纽约，1956 年',
    line: '16. Bc5 Rfe8+ 17. Kf1 Be6!!（送后）18. Bxb6 Bxc4+ 19. Kg1 Ne2+ ' +
      '20. Kf1 Nxd4+ 21. Kg1 Ne2+ 22. Kf1 Nc3+ 23. Kg1 axb6',
    idea: '17...Be6 把后直接摆在对方象的嘴里。黑方算的不是"这一下亏多少"，' +
      '而是"我的子会以什么顺序反复将军、吃的顺序怎样最赚"。' +
      '白方吃掉后之后，黑方用一连串将军把子一个个收回来，最后反而多子。',
    spot: '你的子力已经全部压到对方王附近、而且每次将军都能提高下一手的收益时，' +
      '不要被"吃掉这个子我就亏了"挡住 —— 先按顺序把将军走一遍再算账。',
    motifs: ['sacrifice', 'zwischenzug', 'discovered', 'sharpswing'],
    tags: ['check', 'capture', 'sacrifice', 'sharpswing', 'middlegame'],
  },
  {
    id: 'reti',
    name: '雷蒂的弃后',
    players: 'Richard Réti 对 Savielly Tartakower',
    event: '维也纳，1910 年',
    line: '8. O-O-O Nxe4 9. Qd8+!! Kxd8 10. Bg5+（双将）Kc7 11. Bd8#',
    idea: '白方把后送到 d8 让黑王吃掉，为的是把王从 e8 骗到 d8，' +
      '好让 g5 的象打出一个双将；黑王被迫走出来之后，象在 d8 收尾。' +
      '这是"引入"教科书式的一手 —— 弃子的作用只是让对方的王挪一格。',
    spot: '对方的王在中心、你有一个象能用将军逼它动、而且它一动就撞进另一个子的射程 —— ' +
      '这时候去看那一格的坐标，而不是看子力表。',
    motifs: ['decoy', 'doublecheck', 'sacrifice', 'mate'],
    tags: ['mate', 'check', 'sacrifice', 'sharpswing', 'middlegame'],
  },
];

module.exports = { GAMES };
