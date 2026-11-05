// T280 · 召回覆盖率归因的单测（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecall, episodeHasClaims, signalHasCue } from '../scripts/recall-coverage.mjs';

test('T280 四类判定：A > D > C > B 的优先级', () => {
  assert.equal(classifyRecall({ strict: true, hasGoods: true, hasSignal: true }), 'A');
  assert.equal(classifyRecall({ strict: true, hasGoods: false, hasSignal: false }), 'A', '命中优先于一切');
  assert.equal(classifyRecall({ strict: false, hasGoods: true, hasSignal: false }), 'D', '无判别性优先于有货');
  assert.equal(classifyRecall({ strict: false, hasGoods: false, hasSignal: true }), 'C', '有信号但没货 ⇒ 覆盖不足');
  assert.equal(classifyRecall({ strict: false, hasGoods: true, hasSignal: true }), 'B', '有货没取到 ⇒ 真召回缺陷');
});

test('T280 episodeHasClaims：按 support[].episode 判有货', () => {
  const byEp = new Map([['ep-a', ['c-1', 'c-2']], ['ep-b', []]]);
  assert.equal(episodeHasClaims(byEp, 'ep-a'), true);
  assert.equal(episodeHasClaims(byEp, 'ep-b'), false, '空数组不算有货');
  assert.equal(episodeHasClaims(byEp, 'ep-z'), false);
  assert.equal(episodeHasClaims(null, 'ep-a'), false);
});

test('T280 signalHasCue：判别词 ≥2 或 ≥1 硬实体才算有线索', () => {
  assert.equal(signalHasCue('处理一下'), false, '短中文无实体');
  assert.equal(signalHasCue('看下 dsh-ui/internal/uiplugins 的测试'), true, '含硬实体');
  assert.equal(signalHasCue('cannot edit file changed since it was read'), true, '判别词 ≥2');
  assert.equal(signalHasCue(''), false);
});
