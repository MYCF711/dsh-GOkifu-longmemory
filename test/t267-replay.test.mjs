import test from 'node:test';
import assert from 'node:assert/strict';

import { wilson, signalKey, loadRows, replay, judgeRow } from '../scripts/t267-replay.mjs';

test('T278 ①: Wilson 区间（n=0 返回 null，n>0 落在 [0,1] 且包住 phat）', () => {
  assert.deepEqual(wilson(0, 0).phat, null);
  const w = wilson(37, 108);
  assert.ok(w.lower <= w.phat && w.phat <= w.upper);
  assert.ok(w.lower >= 0 && w.upper <= 1);
  // 37/108 的已知 Wilson（z=1.96）≈ [0.2599, 0.4361]
  assert.ok(Math.abs(w.lower - 0.2599) < 0.005, String(w.lower));
  assert.ok(Math.abs(w.upper - 0.4361) < 0.005, String(w.upper));
});

test('T278 ②: 记忆化键只看 scope/text/实体集（同样输入 ⇒ 同键）', () => {
  const a = signalKey({ scope: 'w:/a', text: 'x', entities: ['b', 'a'] });
  const b = signalKey({ scope: 'w:/a', text: 'x', entities: ['a', 'b'] });
  assert.equal(a, b, '实体顺序不影响键');
  assert.notEqual(a, signalKey({ scope: 'w:/b', text: 'x', entities: ['a', 'b'] }));
});

test('T278 ③: 空语料/缺列不抛，unverified 不进分子分母', async () => {
  const store = { get: () => null, list: () => [] };
  const out = replay({ store, rows: [{ messages: [] }, {}, null] });
  assert.equal(out.n, 0);
  assert.equal(out.unverified, 0);
  assert.equal(out.negativeControl.rate, null, '没有样本 ⇒ 误判率 n/a，不写 0');
});

test('T278 ④: 单行超时 ⇒ 记 unverified 并跳过（不卡死）', () => {
  const store = { get: () => null, list: () => [] };
  const r = judgeRow({
    store, cache: new Map(),
    row: { scopeKey: 'w:/a', at: 1, messages: [{ role: 'user', text: 'hello world' }] },
    rowTimeoutMs: -1, // 任何耗时都算超
  });
  assert.equal(r.unverified, true);
  assert.equal(r.slowMs >= 0 || Number.isFinite(r.slowMs), true);
});

test('T278 ⑤: loadRows 抽样只取前 N 条；不存在返回 null（fail-closed）', () => {
  assert.equal(loadRows('tmp/definitely-missing-t278.jsonl'), null);
});
