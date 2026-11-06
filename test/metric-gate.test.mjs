// T313 · 指标上线门（G1–G5）测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMetric, auditMetrics } from '../scripts/metric-gate.mjs';

const full = {
  id: 'demo',
  title: '示例指标',
  spec: { numerator: 'n', denominator: 'd', asOf: 't', tree: '工作树' },
  negativeControl: '改坏必红',
  recompute: '第二实现一致',
  buckets: 'worst-bucket 已报',
  tombstoneTest: 'test/x.test.mjs',
};
const exists = () => true;

test('T313 ③: 五道全过 ⇒ 可进验收面（accept，过 5 道）', () => {
  const r = evaluateMetric(full, { fileExists: exists });
  assert.equal(r.passed, 5);
  assert.deepEqual(r.missing, []);
  assert.equal(r.verdict, 'accept');
});

test('T313 ①: 缺口径（G1）⇒ 红，只能观察', () => {
  const r = evaluateMetric({ ...full, spec: { numerator: 'n', denominator: 'd' } }, { fileExists: exists });
  assert.equal(r.gates.G1, 'fail');
  assert.ok(r.missing.includes('G1'));
  assert.equal(r.verdict, 'observe');
  assert.equal(r.passed, 4);
});

test('T313 ②: 缺负向对照（G2）⇒ 红', () => {
  const r = evaluateMetric({ ...full, negativeControl: '' }, { fileExists: exists });
  assert.equal(r.gates.G2, 'fail');
  assert.equal(r.verdict, 'observe');
});

test('T313: 缺复算（G3）⇒ 未验证（单列，不判绿也不判红），仍只能观察', () => {
  const r = evaluateMetric({ ...full, recompute: '' }, { fileExists: exists });
  assert.equal(r.gates.G3, 'unverified');
  assert.ok(r.missing.includes('G3'));
  assert.equal(r.verdict, 'observe');
});

test('T313: 只报 overall（缺 G4 分桶）⇒ 红', () => {
  const r = evaluateMetric({ ...full, buckets: '' }, { fileExists: exists });
  assert.equal(r.gates.G4, 'fail');
});

test('T313: tombstone 文件不存在（G5）⇒ 红', () => {
  const r = evaluateMetric(full, { fileExists: () => false });
  assert.equal(r.gates.G5, 'fail');
  assert.equal(r.verdict, 'observe');
});

test('T313: 批量统计 —— 缺得最多的是 G3（复算）', () => {
  const rows = auditMetrics([full, { ...full, id: 'm2', recompute: '' }, { ...full, id: 'm3', recompute: '' }], { fileExists: exists });
  assert.equal(rows.filter((r) => r.verdict === 'accept').length, 1);
  const g3 = rows.filter((r) => r.missing.includes('G3')).length;
  assert.equal(g3, 2);
});
