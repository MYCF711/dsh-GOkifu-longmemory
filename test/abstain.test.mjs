import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRelevantClaim, abstainEntities } from '../src/rooms/abstain.mjs';

test('T366 相关性判据：共享硬实体（ENOENT）⇒ 相关', () => {
  const card = { claims: [{ text: 'Error: ENOENT: no such file or directory: assets/cover-1.png' }] };
  assert.equal(hasRelevantClaim(card, '读一下文件，报了个 ENOENT'), true);
});

test('T366 相关性判据：**有判别内容但确实不相关** ⇒ 拒绝', () => {
  const card = { claims: [{ text: 'Error: ENOENT: no such file or directory: assets/cover-1.png' }] };
  // 信号里**有**可判别内容（中文段"天气预报"），但与卡上的 ENOENT **完全无关** ⇒ 该拒
  assert.equal(hasRelevantClaim(card, '帮我查一下明天的天气预报和气温变化情况'), false);
});

test('T366 **短指令 ⇒ 不拒绝**（判据不可用，保守不误杀）', () => {
  const card = { claims: [{ text: 'Error: ENOENT: no such file or directory: assets/cover-1.png' }] };
  // "处理一下" / "今天天气怎么样" 都是**短指令**：没有可判别内容 ⇒ **不拒绝**（保持现状）
  assert.equal(hasRelevantClaim(card, '处理一下'), true, '短指令不该被拿去拒');
  assert.equal(hasRelevantClaim(card, '继续'), true);
  assert.equal(hasRelevantClaim(card, '今天天气怎么样'), true, '<10 字符的短句判据不可用 ⇒ 不拒绝');
});

test('T366 相关性判据：共享 ≥2 判别词 ⇒ 相关（不需要硬实体）', () => {
  const card = { claims: [{ text: '然后再优化一下模型目录获取，不要获取用不了的模型' }] };
  // 英文判别词路径（token 判据只认 [a-z] 起的 token，中文靠实体）
  const card2 = { claims: [{ text: 'optimize the model directory listing and skip unavailable models' }] };
  assert.equal(hasRelevantClaim(card2, 'model directory listing please'), true);
});

test('T366 空卡 ⇒ false（走既有 no-hit，不走 abstain）', () => {
  assert.equal(hasRelevantClaim({ claims: [] }, '任何信号'), false);
  assert.equal(hasRelevantClaim({}, '任何信号'), false);
  assert.equal(hasRelevantClaim(null, '任何信号'), false);
});

test('T366 abstainEntities：抽出文件路径 / 扩展名 / 错误码', () => {
  const e = abstainEntities('看一下 E:/Documents/dsh-go/HANDOFF.md 然后修 ENOENT');
  assert.ok([...e].some((x) => x.includes('handoff.md')), '要抽到 HANDOFF.md');
  assert.ok(e.has('ENOENT'), '要抽到 ENOENT');
});

test('T366c 方向判据：用户要"关掉"、claim 建议"更频繁" ⇒ opposite', async () => {
  const { detectPolarity } = await import('../src/rooms/abstain.mjs');
  assert.equal(detectPolarity('为什么这个报错要一直推送到我的邮箱，能不能关掉？被我自己的信息刷爆邮箱了',
    '还有一个就是，能不能让邮箱接收信息并刷新，再通知这条链条更频繁一点？'), 'opposite');
});

test('T366c 方向判据：用户要"关掉"、claim 也是"关闭" ⇒ same（同向）', async () => {
  const { detectPolarity } = await import('../src/rooms/abstain.mjs');
  assert.equal(detectPolarity('能不能关掉这个通知？', '把这个通知的开关关闭即可'), 'same');
});

test('T366c 方向判据：没有方向 ⇒ unclear（不许硬判）', async () => {
  const { detectPolarity } = await import('../src/rooms/abstain.mjs');
  assert.equal(detectPolarity('读一下 HANDOFF.md 然后写方案', 'Error: failed to push some refs'), 'unclear');
});

test('知识库 83：**任何"率"都必须同时报可判率**，可判率太低 ⇒ 不可用于决策', async () => {
  const { polarityReport } = await import('../src/rooms/abstain.mjs');
  const r = polarityReport({ same: 5, opposite: 2, unclear: 183 });
  assert.equal(r.total, 190);
  assert.equal(r.decidable, 7);
  assert.ok(Math.abs(r.decidability - 7 / 190) < 1e-9, '可判率 = 7/190');
  assert.equal(r.usableForDecision, false, '可判率 3.7% ⇒ **不可用于决策**');
  assert.ok(r.text.includes('可判率'), '报告里必须带可判率（省略 = 误导）');
  assert.ok(r.text.includes('不可用于决策'), '必须显式标注"不可用于决策"');
  // 可判率高 ⇒ 才可用于决策
  const ok = polarityReport({ same: 60, opposite: 10, unclear: 30 });
  assert.equal(ok.usableForDecision, true, '可判率 70% ⇒ 可用于决策');
});

test('知识库 84：**方向相反 ⇒ 以 `[disputed]` 渲染**（不以"建议"出现）', async () => {
  const { markerWithPolarity } = await import('../src/rooms/abstain.mjs');
  // 方向相反 ⇒ 必须标 disputed（哪怕它原本是 semantic/candidate）
  assert.equal(markerWithPolarity({ kind: 'fact', state: 'semantic' }, 'opposite'), 'disputed');
  assert.equal(markerWithPolarity({ kind: 'fact', state: 'candidate' }, 'opposite'), 'disputed');
  // 同向 / 判不了 ⇒ 保持原标记（行为不变）
  assert.equal(markerWithPolarity({ kind: 'fact', state: 'semantic' }, 'same'), 'semantic');
  assert.equal(markerWithPolarity({ kind: 'fact', state: 'candidate' }, 'unclear'), 'candidate');
  assert.equal(markerWithPolarity({ kind: 'antipattern' }, 'same'), 'antipattern');
});

test('知识库 84 **渲染接线**：传了 signalText 时，方向相反的 claim 标 [disputed]', async () => {
  const { detectPolarity, markerWithPolarity } = await import('../src/rooms/abstain.mjs');
  // 模拟渲染路径：信号要"关掉"，claim 建议"更频繁" ⇒ opposite ⇒ disputed
  const signal = '为什么这个报错要一直推送到我的邮箱，能不能关掉？被我自己的信息刷爆邮箱了';
  const claimText = '能不能让邮箱接收信息并刷新，再通知这条链条更频繁一点？';
  const pol = detectPolarity(signal, claimText);
  assert.equal(pol, 'opposite', '这条必须被判为方向相反');
  const marker = markerWithPolarity({ kind: 'fact', state: 'semantic' }, pol);
  assert.equal(marker, 'disputed', '渲染时必须是 [disputed]，不是 [semantic]（建议）');
  // 不传 signalText ⇒ 走 stateTokenOf（保持原标记，向后兼容）
  const src = await import('node:fs').then((m) => m.readFileSync('src/rooms/inject.mjs', 'utf8'));
  assert.ok(src.includes('options?.signalText'), '渲染路径必须支持可选的 signalText');
  assert.ok(src.includes('signalText: signal?.text'), 'buildMemoryCard 必须把信号原文传下去');
});

test('知识库 87 **精化适用条件**：含硬实体 ⇒ 启用；短指令 ⇒ 不启用（不一刀切）', async () => {
  const { hasReliableHandle } = await import('../src/rooms/abstain.mjs');
  // 含硬实体（文件路径/错误码）⇒ 判据可靠 ⇒ 启用（这部分不该被"默认关"埋掉）
  assert.equal(hasReliableHandle('读 E:/Documents/dsh-go/HANDOFF.md 然后写方案'), true, '有文件路径 ⇒ 可靠');
  assert.equal(hasReliableHandle('报了个 ENOENT，帮我看看'), true, '有错误码 ⇒ 可靠');
  // 英文判别词 ≥2 ⇒ 可靠
  assert.equal(hasReliableHandle('optimize the model directory listing please'), true, '≥2 英文判别词 ⇒ 可靠');
  // 短指令 ⇒ 不可靠 ⇒ 不启用（保守，不误杀）
  assert.equal(hasReliableHandle('处理一下'), false, '短指令 ⇒ 不可靠');
  assert.equal(hasReliableHandle('继续'), false);
  // 纯通用中文长句（没有硬实体/英文判别词）⇒ 不可靠
  assert.equal(hasReliableHandle('帮我看看这个东西现在是什么情况'), false, '通用中文 ⇒ 不可靠');
});

test('T366d **跨语言失败映射**：中文"安装失败" + 英文"tool call aborted" ⇒ 相关（不误杀）', async () => {
  const { hasRelevantClaim, isCrossLingualFailureMatch } = await import('../src/rooms/abstain.mjs');
  // 这是 ep-75e7347e 的真实误杀案例
  const card = { claims: [{ text: 'Error: tool call aborted' }] };
  const signal = '安装失败 @tencent-connect/dsh-qqbot@latest 帮我装一下';
  assert.equal(isCrossLingualFailureMatch(signal, 'Error: tool call aborted'), true, '中文"安装失败" + 英文"aborted" ⇒ 跨语言相关');
  assert.equal(hasRelevantClaim(card, signal), true, '不能再把这条误判为"不相关"（误杀）');
  // 但"中文失败" + "英文无关内容" ⇒ 不该误判为相关
  assert.equal(isCrossLingualFailureMatch('安装失败帮我看看', '今天天气不错，适合出去散步'), false, '英文里没有失败信号 ⇒ 不算相关');
});

test('T5 **跨语言成功映射**：中文"跑通了" + 英文 `PASS` / `[exit code: 0]` ⇒ 相关（不误杀）', async () => {
  const { hasRelevantClaim, isCrossLingualSuccessMatch, hasChineseSuccessSignal, hasEnglishSuccessSignal } = await import('../src/rooms/abstain.mjs');

  // ① 中文"成功" + 英文"成功" ⇒ 相关
  assert.equal(isCrossLingualSuccessMatch('测试跑通了', 'all tests passed'), true, '中文"跑通" + 英文"passed" ⇒ 跨语言相关');
  assert.equal(isCrossLingualSuccessMatch('装好了', '[exit code: 0]'), true, 'exit code 0 也是成功信号');
  assert.equal(hasChineseSuccessSignal('这次终于成功了'), true);
  assert.equal(hasEnglishSuccessSignal('Build success'), true);

  // ② **不误判**：中文"成功" + 英文**无关内容** ⇒ 不算相关
  assert.equal(isCrossLingualSuccessMatch('成功了', '今天天气不错，适合出去散步'), false, '英文里没有成功信号 ⇒ 不算相关');
  assert.equal(isCrossLingualSuccessMatch('成功了', 'Error: tool call aborted'), false, '英文是**失败**信号 ⇒ 不是成功相关');

  // ③ **故意排除的词**（这条是 tombstone 的反面）：`通过` 兼作介词，单用不算成功信号
  assert.equal(hasChineseSuccessSignal('通过代理访问这个地址'), false, '"通过"单独不算成功信号（兼作介词，会误判）');
  assert.equal(hasChineseSuccessSignal('测试通过'), true, '但"测试通过"这种完成语义明确的算');

  // ④ 端到端：接进 hasRelevantClaim 之后不再误杀
  const card = { claims: [{ text: 'all tests passed (green)' }] };
  assert.equal(hasRelevantClaim(card, '测试跑通了，帮我记一下'), true, '成功类跨语言配对不能被判成不相关');
});

test('T4 **可解释的拒绝**：abstain 的 reason 按判据分类，不是单一字符串', async () => {
  const { classifyAbstainReason } = await import('../src/plugin.mjs');

  // ① 跨作用域：walk 命中过，但全被挡掉
  assert.equal(
    classifyAbstainReason({ card: { claims: [{ state: 'observed', decay: 1 }] }, walkResult: { crossScope: 3 } }),
    'cross-scope',
    '跨域命中过 ⇒ 该说"去别的项目查"',
  );

  // ② 陈旧：卡上每一行都衰减到 0.5 以下
  assert.equal(
    classifyAbstainReason({ card: { claims: [{ state: 'semantic', decay: 0.2 }, { state: 'semantic', decay: 0.4 }] }, walkResult: {} }),
    'stale',
    '全部超过半衰期 ⇒ 陈旧',
  );

  // ③ 低置信：卡上每一行都是单局 [observed]
  assert.equal(
    classifyAbstainReason({ card: { claims: [{ state: 'observed', decay: 0.9 }, { state: 'observed', decay: 1 }] }, walkResult: {} }),
    'low-confidence',
    '只有 1 局支撑 ⇒ 拿不准',
  );

  // ④ 兜底
  assert.equal(
    classifyAbstainReason({ card: { claims: [{ state: 'semantic', decay: 1 }] }, walkResult: {} }),
    'no-relevant-claim',
    '有分量但不相关的行 ⇒ 兜底',
  );

  // ⑤ **向后兼容**：没有卡/没有 walkResult 也不炸，且仍给得出一个合法 reason
  const legal = ['cross-scope', 'stale', 'low-confidence', 'no-relevant-claim'];
  assert.ok(legal.includes(classifyAbstainReason({})), '空输入也必须返回合法分类');
  assert.ok(legal.includes(classifyAbstainReason({ card: null, walkResult: null })));

  // ⑥ **不改默认行为**：只有一行是 observed（其余不是）⇒ 不算 low-confidence（every 不是 some）
  assert.equal(
    classifyAbstainReason({ card: { claims: [{ state: 'observed', decay: 1 }, { state: 'semantic', decay: 1 }] }, walkResult: {} }),
    'no-relevant-claim',
    '混合状态不算低置信（判据是 every 不是 some）',
  );
});

// ── T2：**精确率优先**（宁可少判，不许错判）────────────────────────────────
// 背景：T1 在 135 对人工标注上实测 v1 判据的 `opposite` 精确率只有 20%（4/20）。
// 误触发**全部来自词面**（`别` / `要不要` / `应该` / 只共享方向词的无关内容），不是语义。
// 下面每一条都是 **tombstone**：把对应的收窄条件删掉，这条测试必须红。

test('T2 词面边界：`别` 不是否定祈使（别的/别人/识别/别路由组）⇒ 不判 opposite', async () => {
  const { detectPolarity } = await import('../src/rooms/abstain.mjs');
  // 吃鸡方案信号里的「抢夺别人的初始apikey，或者别人手里的key」——
  // v1 的 NEGATE 含 1 字「别」，把它当成了「别做」⇒ 和 claim 的「应该」拼成 opposite（本集 7 条难负例之一）。
  const signal = '做一个各种模型一起参与的吃鸡：抢夺别人的初始apikey，或者别人手里的key；如果模型的key被抢走就直接死了';
  const claim = '如果一个功能有明确收益，损失在可控范围内，应该默认打开，且不提供开关';
  assert.notEqual(detectPolarity(signal, claim), 'opposite', '「别人」不是否定祈使，不得判 opposite');
  assert.equal(detectPolarity(signal, claim), 'unclear', '没有收缩方向 ⇒ 判不了');

  // 「别的软件」同理（本集 pair 20 的误触发来源）
  assert.notEqual(
    detectPolarity('是不是别的软件都能重写解决内存占用问题，只有浏览器必须要用webview？',
      '落后就应该实现最新，而不是一直落后'),
    'opposite',
  );
  // 「识别」「类别」等复合词里的「别」也不是否定祈使
  assert.notEqual(detectPolarity('我截图发送的图片会被识别成 user 文字', '最好关闭原生看图走回退'), 'opposite');
});

test('T2 词面边界：`不要` 是否定**任意谓词**（方向随谓词翻转）⇒ 不单独作收缩证据', async () => {
  const { detectPolarity, polarityDirection } = await import('../src/rooms/abstain.mjs');
  // 「不要自己去干活」= **扩张授权**（多派活），不是收缩。v1 把它当收缩 ⇒ 与 claim 的「打开」拼成 opposite。
  const signal = '团队模式总是约束lead不要自己去干活，让成员和子代理去干活';
  const claim = '打开了子代理的子代理功能，你应该让他们和你一样';
  assert.equal(polarityDirection(signal), 'none', '「不要 + 谓词」本身没有方向（方向在谓词上）');
  assert.equal(detectPolarity(signal, claim), 'unclear', '没有收缩方向 ⇒ 判不了（v1 会判 opposite）');
  // 「要不要…？」是**自问**，同样不是否定祈使
  assert.equal(detectPolarity('我们要不要把这个能力做成插件？', '这个插件应该默认打开'), 'unclear');
  // 真正的**直接抑制动词**仍然判得出来（收窄不是「全关」）
  assert.equal(
    detectPolarity('这个功能太吵了，能不能关掉？', '这个功能应该默认打开'),
    'opposite',
    '「关掉」是直接抑制动词 ⇒ 与「打开」反向',
  );
});

test('T2 单一方向：一段话同时出现扩张与收缩 ⇒ 没有单一方向 ⇒ unclear（不猜）', async () => {
  const { detectPolarity, polarityDirection } = await import('../src/rooms/abstain.mjs');
  const multiTopic = '开启superagent模式，做好定时任务，写好goal，不要粉色大象；顺便把定时推送关掉';
  assert.equal(polarityDirection(multiTopic), 'both', '多议题长消息天然没有单一方向');
  assert.equal(
    detectPolarity(multiTopic, '你现在应该让他们和你一样，要会发包独立任务'),
    'unclear',
    '两个方向都有 ⇒ 不拿其中任意一个去判反向',
  );
});

test('T2 对象锚定：只共享方向词、不同议题 ⇒ unclear（不拿「关掉」当同一对象）', async () => {
  const { detectPolarity, polarityAnchored } = await import('../src/rooms/abstain.mjs');
  // 本集 pair 76/77/80：信号讲邮箱通知要关掉，claim 讲 TUI 光标 / pwsh / 分支保护 —— 不同对象
  const signal = '为什么这个报错要一直推送到我的邮箱，能不能关掉？被我自己的信息刷爆邮箱了';
  assert.equal(polarityAnchored(signal, '行，我把pwsh直接关掉跑一个小时看看数据'), false, '只共享「关掉」不算同一对象');
  assert.equal(detectPolarity(signal, '行，我把pwsh直接关掉跑一个小时看看数据'), 'unclear');
  // 同一对象（邮箱）时仍然判得出来
  assert.equal(polarityAnchored(signal, '还有一个就是，能不能让邮箱接收信息并刷新，再通知这条链条更频繁一点？'), true);
  assert.equal(
    detectPolarity(signal, '还有一个就是，能不能让邮箱接收信息并刷新，再通知这条链条更频繁一点？'),
    'opposite',
    '真反向（邮箱通知链条）必须保留',
  );
});

test('T2 回归：`evidence/label-set.json` 上 8 条「不得判 opposite」+ 12 条「必须退回 unclear」', async (t) => {
  const { detectPolarity } = await import('../src/rooms/abstain.mjs');
  const { readFileSync, existsSync } = await import('node:fs');
  const path = 'evidence/label-set.json';
  if (!existsSync(path)) {
    t.skip(`缺少 ${path}（T1 标注集），跳过回归`);
    return;
  }
  const set = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(set.pairs.length, 135, '标注集必须是 135 对');

  // ① 8 条「同向被误判成反向」：一条都不许再判 opposite
  const mustNotOpposite = set.pairs.filter((p) => p.stratum === 'dir' && p.polarityHuman === 'same');
  assert.ok(mustNotOpposite.length >= 8, `dir/same 至少 8 条，实际 ${mustNotOpposite.length}`);
  for (const p of mustNotOpposite) {
    assert.notEqual(detectPolarity(p.signalText, p.claimText), 'opposite',
      `pair ${p.pairId} 人工判 same，不得判 opposite（${p.why}）`);
  }

  // ② 12 条「机械判成可判、人工判 irrelevant」：必须全部退回 unclear
  const mustBeUnclear = set.pairs.filter((p) => p.verdict === 'irrelevant' && p.polarity !== 'unclear');
  assert.ok(mustBeUnclear.length >= 12, `误判清单至少 12 条，实际 ${mustBeUnclear.length}`);
  for (const p of mustBeUnclear) {
    assert.equal(detectPolarity(p.signalText, p.claimText), 'unclear',
      `pair ${p.pairId} 人工判 irrelevant，必须退回 unclear（不得拿词面重合当方向）`);
  }

  // ③ 真反向（人工判 opposite）里，直接抑制动词那几条必须保留
  const trueOpposite = set.pairs.filter((p) => p.stratum === 'dir' && p.polarityHuman === 'opposite');
  const kept = trueOpposite.filter((p) => detectPolarity(p.signalText, p.claimText) === 'opposite');
  assert.ok(kept.length >= 2, `真反向至少保留 2 条，实际 ${kept.length}：${kept.map((p) => p.pairId)}`);
  for (const p of kept) assert.equal(detectPolarity(p.signalText, p.claimText), 'opposite');
});

test('T2 记分卡：可判率 + 精确率一起报（`polarityHuman` 当金标）', async () => {
  const { polarityScorecard } = await import('../src/rooms/abstain.mjs');
  const { readFileSync, existsSync } = await import('node:fs');
  const path = 'evidence/label-set.json';
  if (!existsSync(path)) return;
  const set = JSON.parse(readFileSync(path, 'utf8'));
  const { counts, report } = polarityScorecard(set.pairs);
  assert.equal(counts.same + counts.opposite + counts.unclear, 135, '分母 = 135（全部标注对）');
  assert.equal(report.total, 135);
  assert.equal(report.decidable, counts.same + counts.opposite, '可判 = same + opposite');
  assert.ok(Math.abs(report.decidability - report.decidable / 135) < 1e-9, '可判率 = 可判/135');
  // 精确率：判成 opposite 的必须**都是**人工判 opposite 的
  assert.equal(report.precision.opposite, 1, `opposite 精确率必须 100%，实际 ${report.precision.opposite}`);
  assert.equal(report.precision.falsePositives, 0, '反向里不许有误判');
  assert.ok(report.text.includes('精确率'), '报告文本里必须出现精确率（只报可判率 = 把误判当成绩）');
  // **口径警告必须能被读到**：本集是分层集，19.3% 不能外推成线上可判率
  assert.equal(report.usableForDecision, false, '可判率 < 30% ⇒ 不可用于决策（不粉饰）');
});

test('T2 `polarityReport` 精确率：有金标才算，没金标不拿「没标注」冒充「全对」', async () => {
  const { polarityReport } = await import('../src/rooms/abstain.mjs');
  // 没有金标 ⇒ 不输出 precision（向后兼容 v1 的三件套）
  const plain = polarityReport({ same: 5, opposite: 2, unclear: 183 });
  assert.equal(plain.precision, undefined, '没给金标就不报精确率');
  assert.equal(plain.usableForDecision, false);
  // 有金标 ⇒ 精确率 = tp / opposite
  const withGold = polarityReport({ same: 10, opposite: 4, unclear: 86 }, { gold: { oppositeTrue: 4 } });
  assert.equal(withGold.precision.opposite, 1);
  assert.equal(withGold.precision.truePositives, 4);
  assert.equal(withGold.precision.falsePositives, 0);
  assert.ok(withGold.text.includes('100.0%（4/4）'), withGold.text);
  // 精确率不足 ⇒ 即使可判率过线也**不可用于决策**
  const bad = polarityReport({ same: 60, opposite: 10, unclear: 30 }, { gold: { oppositeTrue: 2 } });
  assert.equal(bad.precision.opposite, 0.2, '20% 精确率');
  assert.equal(bad.usableForDecision, false, '可判率 70% 但精确率 20% ⇒ 仍不可用于决策');
});

test('知识库 90 **冷却**：距最后注入 >30 天 ⇒ 冷却；最近被调用 ⇒ 不冷却', async () => {
  const { isCold } = await import('../src/rooms/abstain.mjs');
  const now = Date.now();
  const day = 86400000;
  // 40 天前被注入过 ⇒ 冷却
  assert.equal(isCold({ counters: { lastInjectedAt: now - 40 * day } }, now), true, '40 天没被调用 ⇒ 冷却');
  // 5 天前被注入过 ⇒ 不冷却
  assert.equal(isCold({ counters: { lastInjectedAt: now - 5 * day } }, now), false, '5 天前被调用过 ⇒ 不冷却');
  // 没有 lastInjectedAt ⇒ 用 recordedAt 兜底
  assert.equal(isCold({ recordedAt: now - 40 * day }, now), true, 'recordedAt 距今 40 天 ⇒ 冷却');
  // 没有时间 ⇒ 判不了 ⇒ 不冷却（保守，不误杀）
  assert.equal(isCold({}, now), false, '没有时间 ⇒ 不冷却（保守）');
  // **不按 `injections === 0` 判**：那可能是"被调用了但没被记录"
  assert.equal(isCold({ counters: { injections: 0, lastInjectedAt: now - 5 * day } }, now), false,
    '`injections === 0` 但**最近被调用过** ⇒ **不冷却**（不按 `=== 0` 杀）');
});

// ═══════════════════════════════════════════════════════════════════════════
// T12 · 修线上误杀（T11 实测 77.3%）+ 两个结构性 bug
//
// 数据来源：`evidence/T11-abstain-live.md`（79 判定点 / 33 条真实拒绝，逐条核：
// 强误杀 5 · 弱误杀 12 · 正确拒绝 5 · 无害 11）。下面的信号/claim 都是**线上原文**。
// 每个桥各有一条 tombstone：删掉对应的桥（`fileBasenames` / `TOOL_FAMILIES` / `PIT_CLASS_APPLIES`），
// 它自己的那条必须红；5 条负样本必须**一直**是 false（负样本丢了 = 把 abstain 关掉了，不算修好）。
// ═══════════════════════════════════════════════════════════════════════════

// ── 线上原文（T11 §四 逐条表；编号即 T11 的重放序号）──────────────────────────
// #16（D 桶）：插件 `AGENTS.md` 指令；卡上是**另一个插件目录**下的 `AGENTS.md` 不存在。
const SIG_16 = "<system-reminder>\nAdditional instructions from: projects\\dsh\\plugins\\dsh-agent-teams-preset\\AGENTS.md\n\nThese instructions apply to work under `projects\\dsh\\plugins\\dsh-agent-teams-preset`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.\n\n# Project maintenance skills\n\nBefore using a DSH plugin lifecycle skill in this r";
const CL_16 = ["FileNotFoundError: [Errno 2] No such file or directory: 'D:/DeepSeek Harness/home/profiles/desktop/cordis.patch.yml.bak-before-compress-20261105-022716'", "Error: cannot read \"/d/DeepSeek Harness/default-workspace/projects/dsh/plugins/ptc-domain-presets/AGENTS.md\": not found", "FileNotFoundError: [Errno 2] No such file or directory: 'D:/DeepSeek Harness/home/profiles/desktop/cordis.patch.yml.bak-before-compress-20261105-022716'"];
// #18（A 桶）：AgentTeams 任务分配；卡上是 AgentTeams 的 `plan` 契约报错。
const SIG_18 = "<chess-ledger>\nROOT USER (verbatim): AgentTeams automatic task assignment from the shared task list. You are executing as configured member \"model-defaults\"…\nCONSTRAINTS: 9\n# path: n1 → n2\nUNVERIFIED: 1 unproven\nNO_FAILED_ATTEMPTS_YET\n</chess-ledger>";
const CL_18 = ["Error: invalid arguments: missing required property \"plan.members\"; missing required property \"plan.tasks\""];
// #5（B 桶）：release 任务；卡上是 `gh release` 的 push 失败。
const SIG_5 = "<chess-ledger>\nROOT USER (verbatim): AgentTeams automatic task assignment from the shared task list. You are executing as configured member \"release-dev\". D…\nGOAL: 我先领取任务，并阅读任务要求。\nCONSTRAINTS: 9\n# path: n1 → n2\nUNVERIFIED: 2 unproven\nNO_FAILED_ATTEMPTS_YET\n</chess-ledger>";
const CL_5 = ["error: failed to push some refs to 'https://github.com/MYCF711/dsh-GOkifu-longmemory.git' https://github.com/MYCF711/dsh-GOkifu-longmemory/releases/tag/v0.2.41…"];
// #33（B 桶）：查仓库状态；卡上是 git 远端读不到。
const SIG_33 = "<chess-ledger>\nROOT USER (verbatim): AgentTeams automatic task assignment from the shared task list. You are executing as configured member \"evidence\". Do n…\nGOAL: I'll first claim the task, then check the repo state.\nCONSTRAINTS: 9\n# path: n1 → n2\nUNVERIFIED: 2 unproven\nNO_FAILED_ATTEMPTS_YET\n</chess-ledger>";
const CL_33 = ["fatal: Could not read from remote repository. Please make sure you have the correct access rights"];
// #13（C 桶）：要写 evidence 文件；卡上是"写前没读"的类级教训（换了文件名）。
const SIG_13 = "<chess-ledger>\nROOT USER (verbatim): AgentTeams automatic task assignment from the shared task list. You are executing as configured member \"label-reviewer\"…\nGOAL: I'll claim the task first, then read the T13 requirements.\nCONSTRAINTS: 8\n# path: n1 → n2\nUNVERIFIED: 1 unproven\nNO_FAILED_ATTEMPTS_YET\n</chess-ledger>";
const CL_13 = ["class:fs-read-before-write · Error: cannot write \"/d/DeepSeek Harness/default-workspace/长期记忆系统/scripts/re-enable.mjs\": file no longer exists — re-read the…"];
// #1（C 桶，全量任务分配）的**真实片段**：写 evidence 文件。
const WRITE_TASK_SNIPPET = '只写 evidence/T11-abstain-live.md，不改代码。';

// ── 负样本：T11 #3 / #7 / #10 / #21 / #26（**正确拒绝**，一条都不许变成"相关"）──
const SIG_3 = "<chess-ledger>\nROOT USER (verbatim): AgentTeams automatic task assignment from the shared task list. You are executing as configured member \"live-analyst\". …\nGOAL: I'll start by claiming the task and reading the requirements.\nCONSTRAINTS: 8\n# path: n1 → n2\nUNVERIFIED: 2 unproven\nNO_FAILED_ATTEMPTS_YET\n</chess-ledger>";
const CL_3 = ["MISS \"const DANGER = /(>>|\\\\btee\\\\b|\\\\bgh\\\\s+(pr|release|api)\\\\b|\\\\bnpm\\\\s+publish\\\\b|\\\\bmagpie\\\\b|\\\\btaskkill\\\\b|Stop-Process|Start-Process|\\\\brm\\\\s+-rf\\\\b|\\\\…"];
const SIG_7 = "<chess-ledger>\nROOT USER (verbatim): AgentTeams automatic task assignment from the shared task list. You are executing as configured member \"ablation-runner…\nGOAL: I'll start by claiming the task and reading the task requirements.\nCONSTRAINTS: 9\n# path: n1 → n2\nUNVERIFIED: 2 unproven\nNO_FAILED_ATTEMPTS_YET\n</chess-ledger>";
const CL_7 = ["MISS \"const DANGER = /(>>|\\\\btee\\\\b|\\\\bgh\\\\s+(pr|release|api)\\\\b|\\\\bnpm\\\\s+publish\\\\b|\\\\bmagpie\\\\b|\\\\btaskkill\\\\b|Stop-Process|Start-Process|\\\\brm\\\\s+-rf\\\\b|\\\\…"];
const SIG_10 = "<chess-ledger>\nROOT USER (verbatim): AgentTeams automatic task assignment from the shared task list. You are executing as configured member \"plugin-dev\". Do…\nGOAL: I'll claim the task first.\nCONSTRAINTS: 9\n# path: n1 → n2\nUNVERIFIED: 1 unproven\nNO_FAILED_ATTEMPTS_YET\n</chess-ledger>";
const CL_10 = ["371:test('N1: promoteClaim 输出 validFrom，validTo 初始为 null；人纠错写 validTo', async () => { 376: if (sample) { 0"];
const SIG_21 = "<chess-ledger>\nROOT USER (verbatim): AgentTeams message from captain: 基线提醒：本项目无 test 脚本，pnpm test 空跑不算通过。测试门禁用 pnpm verify。写单测后跑 pnpm verify 验收。\nGOAL: I'll start by checking the team state and my assigned task.\nCONSTRAINTS: 0\n# path: n1 → n2\nUNVERIFIED: 1 unproven\nNO_FAILED_ATTEMPTS_YET\n</chess-ledger>";
const CL_21 = ["代表 5 条 · 详见 c-ec0fcd25 · Error: glob search failed (exit 2): rg: /d/DeepSeek Harness/default-workspace/tmp/dsh-upgrade-0.2.2-rc.1/production/rollback-test: IO…"];
const SIG_26 = "AgentTeams message from captain for task t2, attempt_id 064ff4d3-1593-4141-b128-c4f943735675:\n\n基线已绿。技术确认：0.2.1-rc.2 的 startActivation 同样接受 agentPreset（subagent/lib/index.js:348,374-377 已核实），两版本都可行。修改点 spawnMember(src/members.ts:1039-1059) request 加 agentPreset；managed 分支 harness-compat.ts:22 ...request 透传无需改签名。测试用 pnpm verify（无 test 脚本）。";
const CL_26 = ["Error: glob search failed (exit 2): rg: /d/DeepSeek Harness/default-workspace/tmp/dsh-latest-upgrade/node_modules: IO error for operation on /d/DeepSeek…"];

const cardOf = (texts) => ({ claims: texts.map((text) => ({ text })) });

test('T12 桥①（D 桶，同名文件）：两个插件目录下的 AGENTS.md ⇒ 相关（不再因目录不同误杀）', async () => {
  const { hasRelevantClaim, abstainEntities, fileBasenames } = await import('../src/rooms/abstain.mjs');
  // 误杀根因：硬实体是**完整路径**，两个 AGENTS.md 分属不同插件目录 ⇒ 字面零重合。
  const shared = [...abstainEntities(SIG_16)].filter((e) => abstainEntities(CL_16.join('\n')).has(e));
  assert.deepEqual(shared, [], '字面判据在这条上确实零重合（否则这条测的不是桥）');
  assert.ok(fileBasenames(SIG_16).has('agents.md'), '信号侧要抽到文件名 AGENTS.md');
  assert.equal(hasRelevantClaim(cardOf(CL_16), SIG_16), true, '同坑类（插件 AGENTS.md 路径不存在）⇒ 必须算相关');
});

test('T12 桥①单元：`cordis.patch.yml.bak-…` 取到扩展名前的完整文件名（不是 `patch.yml`）', async () => {
  const { fileBasenames } = await import('../src/rooms/abstain.mjs');
  assert.deepEqual([...fileBasenames("'/D:/x/desktop/cordis.patch.yml.bak-before-compress-20261105-022716'")], ['cordis.patch.yml']);
});

test('T12 桥②（A 桶，工具族）：AgentTeams 任务分配 + `plan.members` 契约报错 ⇒ 相关', async () => {
  const { hasRelevantClaim } = await import('../src/rooms/abstain.mjs');
  assert.equal(hasRelevantClaim(cardOf(CL_18), SIG_18), true, '同一工具族（AgentTeams plan 契约）⇒ 相关');
});

test('T12 桥②（B 桶，工具族）：release 任务 + push 失败 / 查仓库 + 远端读不到 ⇒ 相关', async () => {
  const { hasRelevantClaim } = await import('../src/rooms/abstain.mjs');
  assert.equal(hasRelevantClaim(cardOf(CL_5), SIG_5), true, 'release 就是这条任务的活儿 ⇒ 相关');
  assert.equal(hasRelevantClaim(cardOf(CL_33), SIG_33), true, '查仓库状态 + 远端读不到 ⇒ 相关');
  // **不误扩**：claim 侧只认这一族的具体报错签名 —— 只有 "release" 字样不算（T11 #3 的负样本就是它）。
  assert.equal(hasRelevantClaim(cardOf(['the guard regex rejects gh release and npm publish']), SIG_5), false,
    'claim 里出现 release 字样 ≠ release 族报错实例');
});

test('T12 桥③（C 桶，坑类）：`class:fs-read-before-write` + 文件工作类请求 ⇒ 相关', async () => {
  const { hasRelevantClaim } = await import('../src/rooms/abstain.mjs');
  // 误杀根因：坑类是"写文件前先读"，判据只看**完整路径**（换了文件名就判不相关）。
  assert.equal(hasRelevantClaim(cardOf(CL_13), SIG_13), true, '任务要写文件 ⇒ 该坑类适用');
  assert.equal(hasRelevantClaim(cardOf(CL_13), WRITE_TASK_SNIPPET), true, '全量任务分配里"只写 …，不改代码"同样适用');
  // **适用面要收住**：跟"动文件"无关的闲聊，不拿这条坑类去兜底（否则等于"什么都注入"）
  assert.equal(hasRelevantClaim(cardOf(CL_13), '帮我查一下明天的天气预报和气温变化情况'), false,
    '坑类只在文件工作类请求上有适用性');
});

test('T12 负样本 5 条（T11 #3/#7/#10/#21/#26）必须**仍然拒绝**', async () => {
  const { hasRelevantClaim, hasReliableHandle } = await import('../src/rooms/abstain.mjs');
  const negatives = [
    [3, SIG_3, CL_3], [7, SIG_7, CL_7], [10, SIG_10, CL_10], [21, SIG_21, CL_21], [26, SIG_26, CL_26],
  ];
  for (const [n, signal, claims] of negatives) {
    assert.equal(hasReliableHandle(signal), true, `#${n} 判据可靠（否则这条测不到相关性判据）`);
    assert.equal(hasRelevantClaim(cardOf(claims), signal), false, `#${n} 是 T11 的正确拒绝，不许被桥拉成相关`);
  }
});

// ── 结构 bug ①：`crossScopeWalk`（整库跨域丢弃总数，恒 200–1000）不许参与本次拒绝的归因 ──
test('T12 tombstone ① `cross-scope` 只看**本次**是否全被挡掉，不看整库的 `crossScopeWalk`', async () => {
  const { classifyAbstainReason } = await import('../src/plugin.mjs');
  const card = { claims: [{ kind: 'antipattern', state: 'candidate', decay: 1, text: 'x' }] };
  // T11 实测：卡上有行（hits 非空）、本次 crossScope/unknownScope 全 0，而整库 crossScopeWalk=649。
  // 旧判据把 649 加进 cross ⇒ `cross > 0` 恒真 ⇒ 33/33 全塌成 cross-scope。
  assert.equal(
    classifyAbstainReason({ card, walkResult: { hits: [{}], crossScope: 0, unknownScope: 0, crossScopeWalk: 649 } }),
    'no-relevant-claim',
    '卡上有行 + 本次零跨域丢弃 ⇒ 不是 cross-scope',
  );
  // 真正"库里有、只是不属于本项目"：本次命中**全**被挡掉（hits 空）且有跨域丢弃 ⇒ cross-scope
  assert.equal(
    classifyAbstainReason({ card: { claims: [] }, walkResult: { hits: [], crossScope: 3, crossScopeWalk: 649 } }),
    'cross-scope',
    '本次命中全被作用域挡掉 ⇒ 才是 cross-scope',
  );
  // 本次没有任何丢弃 ⇒ 也不是 cross-scope（不能靠整库计数凑出来）
  assert.equal(
    classifyAbstainReason({ card, walkResult: { hits: [], crossScope: 0, unknownScope: 0, crossScopeWalk: 649 } }),
    'no-relevant-claim',
  );
});

// ── 结构 bug ②：`card.claims` 投影必须带 `decay`，否则 `stale` 是死码（T11 实测 95 行全 null）──
test('T12 tombstone ② `buildMemoryCard` 的 claims 投影带 decay ⇒ `stale` 能被返回', async () => {
  const { buildMemoryCard, signalFromText } = await import('../src/rooms/inject.mjs');
  const { createStore } = await import('../src/rooms/persist.mjs');
  const { classifyAbstainReason } = await import('../src/plugin.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const root = mkdtempSync(pathMod.join(tmpdir(), 'kifuin-t12-stale-'));
  const SCOPE_T12 = 'w:d:/work/demo';
  const OLD = Date.UTC(2026, 6, 1, 12, 0, 0);   // 2026-07-01
  const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);  // 2026-11-08（≈130 天，半衰期 30 天 ⇒ decay ≈ 0.05）
  const store = createStore({ root, now: NOW });
  store.ensureDirs();
  store.putMany('episodes', [{
    id: 'ep-t12aaa1', sessionId: 's-t12aaa1', scopeKey: SCOPE_T12,
    startedAt: OLD, endedAt: OLD + 1000, firstEventAt: OLD, lastEventAt: OLD + 1000, recordedAt: null,
    closure: { logPath: 'x', graphPath: 'y', seqFrom: 1, seqTo: 2 }, l0: '',
    signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: [] }, threadIds: [], state: 'archived',
  }]);
  store.putMany('claims', [{
    id: 'c-t12aaa1', kind: 'antipattern', text: 'Error: months-old lesson that has not been injected since',
    scopeKey: SCOPE_T12, threadIds: [], state: 'candidate',
    support: [{ episode: 'ep-t12aaa1', seq: 1, quote: 'Error: months-old lesson that has not been injected since', occurredAt: OLD }],
    counter: [], validity: { type: 'none', value: null }, preconditions: [],
    occurredAt: OLD, recordedAt: OLD, validFrom: null, validTo: null,
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
  }]);
  try {
    const card = buildMemoryCard({
      signal: signalFromText('读一下这个文件'),
      walkResult: { hits: [{ episode: 'ep-t12aaa1', seq: 1, kind: 'failure', weight: 1, why: ['x'], depth: 1 }] },
      store, scope: SCOPE_T12, now: NOW, pointerTier: false,
    });
    assert.equal(card.claims.length, 1, '夹具要先真的渲染出一行');
    assert.ok(Number.isFinite(card.claims[0].decay), 'claims 投影必须带 decay（缺 = 消费方只能拿到 undefined）');
    assert.ok(card.claims[0].decay < 0.5, `超过半衰期的行权重必须 < 0.5，实际 ${card.claims[0].decay}`);
    assert.equal(classifyAbstainReason({ card, walkResult: { hits: [{}] } }), 'stale',
      '投影缺 decay ⇒ Number(undefined ?? 1) 恒 1 ⇒ 这条reason永远是死码');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});
