import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRelevantClaim, abstainEntities } from '../src/rooms/abstain.mjs';

test('T366 相关性判据：共享硬实体（ENOENT）⇒ 相关', () => {
  const card = { claims: [{ text: 'Error: ENOENT: no such file or directory: assets/cover-1.png' }] };
  assert.equal(hasRelevantClaim(card, '读一下文件，报了个 ENOENT'), true);
});

test('T366 相关性判据：完全不同 ⇒ 不相关（该沉默）', () => {
  const card = { claims: [{ text: 'Error: ENOENT: no such file or directory: assets/cover-1.png' }] };
  assert.equal(hasRelevantClaim(card, '今天天气怎么样'), false);
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
