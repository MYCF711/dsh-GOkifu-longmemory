// T335 · 耦合强度的单测（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { coupling } from '../scripts/cost-independence.mjs';

test('T335 耦合强度 = 联合 / 边际积', () => {
  assert.ok(Math.abs(coupling({ pBoth: 0.2, pCost: 0.5, pRel: 0.4 }) - 1) < 1e-9, '0.2/(0.5*0.4)=1 ⇒ 独立');
  assert.ok(Math.abs(coupling({ pBoth: 0.4, pCost: 0.5, pRel: 0.4 }) - 2) < 1e-9, '2 ⇒ 正耦合');
  assert.ok(Math.abs(coupling({ pBoth: 0.1, pCost: 0.5, pRel: 0.4 }) - 0.5) < 1e-9, '0.5 ⇒ 负耦合');
});

test('T335 边际为 0 ⇒ 不可计算（n/a），不许伪造 0 或 1', () => {
  assert.equal(coupling({ pBoth: 0, pCost: 0, pRel: 0.4 }), null);
  assert.equal(coupling({ pBoth: 0, pCost: 0.5, pRel: 0 }), null);
  assert.equal(coupling({ pBoth: 0, pCost: 0, pRel: 0 }), null);
});
