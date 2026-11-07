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
