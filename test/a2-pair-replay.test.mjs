// R00 A2 配对重放（T114）：协议与成本先钉住；**真跑必须显式批准**
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPairSet, estimateCost, TOKENS_PER_SESSION, DEFAULT_SPLIT } from '../scripts/a2-pair-replay.mjs';

const T0 = Date.parse('2026-11-01T00:00:00Z');
const SIG = 'json decode error expecting value line 1';

test('a2-pair: 只挑"切点之后、且切点前有先例"的签名当任务', () => {
  const report = {
    primary: {
      rows: [
        { episode: 'ep-before1', scopeKey: 'w:d:/a', startedAt: T0, repeatSignatures: [], novelSignatures: [SIG] },
        { episode: 'ep-after1', scopeKey: 'w:d:/a', startedAt: T0 + 86400_000, repeatSignatures: [SIG], novelSignatures: [] },
      ],
    },
  };
  const set = buildPairSet({ report, splitAt: Date.parse('2026-11-01T12:00:00Z'), limit: 10 });
  assert.equal(set.count, 1);
  assert.equal(set.items[0].episode, 'ep-after1');
  assert.deepEqual(set.items[0].prior, ['ep-before1']);
  assert.equal(set.splitAt, Date.parse('2026-11-01T12:00:00Z'));
});

test('a2-pair: 切点之后第一次出现的签名不进任务集（没先例 ⇒ 无记忆可注入）', () => {
  const report = {
    primary: { rows: [{ episode: 'ep-novel', scopeKey: 'w:d:/a', startedAt: T0 + 86400_000, repeatSignatures: [], novelSignatures: ['brand new failure'] }] },
  };
  const set = buildPairSet({ report, splitAt: Date.parse('2026-11-01T12:00:00Z'), limit: 10 });
  assert.equal(set.count, 0);
});

test('a2-pair: 同一签名只保留一条任务（否则配对集被同一个坑灌满）', () => {
  const report = {
    primary: {
      rows: [
        { episode: 'ep-before1', scopeKey: 'w:d:/a', startedAt: T0, repeatSignatures: [], novelSignatures: [SIG] },
        { episode: 'ep-after1', scopeKey: 'w:d:/a', startedAt: T0 + 86400_000, repeatSignatures: [SIG], novelSignatures: [] },
        { episode: 'ep-after2', scopeKey: 'w:d:/a', startedAt: T0 + 2 * 86400_000, repeatSignatures: [SIG], novelSignatures: [] },
      ],
    },
  };
  const set = buildPairSet({ report, splitAt: Date.parse('2026-11-01T12:00:00Z'), limit: 10 });
  assert.equal(set.count, 1);
});

test('a2-pair: limit 生效且默认切点与 a2b 考卷一致', () => {
  assert.equal(DEFAULT_SPLIT, Date.parse('2026-11-02T00:00:00Z'));
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push({ episode: `ep-b${i}`, scopeKey: 'w:d:/a', startedAt: T0, repeatSignatures: [], novelSignatures: [`sig-${i}`] });
  for (let i = 0; i < 5; i += 1) rows.push({ episode: `ep-a${i}`, scopeKey: 'w:d:/a', startedAt: T0 + 86400_000, repeatSignatures: [`sig-${i}`], novelSignatures: [] });
  const set = buildPairSet({ report: { primary: { rows } }, splitAt: Date.parse('2026-11-01T12:00:00Z'), limit: 3 });
  assert.equal(set.count, 3);
});

test('a2-pair: 成本估算 = 对数 × 每对两次会话（与协议 §2 同算式）', () => {
  assert.equal(TOKENS_PER_SESSION, 120_000);
  const c = estimateCost({ pairs: 20 });
  assert.equal(c.perPair, 240_000);
  assert.equal(c.total, 4_800_000, 'n=20 对 ≈ 4.8M tokens（与文档一致）');
  const big = estimateCost({ pairs: 80 });
  assert.equal(big.total, 19_200_000, 'n=80 对 ≈ 19M tokens（与文档一致）');
  assert.equal(estimateCost({ pairs: 0 }).total, 0);
  assert.equal(estimateCost({}).total, 0);
});
