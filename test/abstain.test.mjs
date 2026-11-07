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
