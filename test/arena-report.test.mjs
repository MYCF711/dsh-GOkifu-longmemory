// R00 擂台报告（0.123.0）的判定闸：**不许把"不可比"说成"我们更强"**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { quantile, summarizeHindsight, summarizeOurs, compareAxes } from '../scripts/arena-report.mjs';

const theirs = summarizeHindsight({
  usage: [
    { ts: '2026-10-01T00:00:00Z', session: 's1', bank: 'coding-agent::default-workspace', credited: true },
    { ts: '2026-10-01T00:10:00Z', session: 's1', bank: 'coding-agent::default-workspace', credited: false },
    { ts: '2026-10-01T00:20:00Z', session: 's2', bank: 'coding-agent::other', credited: false },
    { ts: '2026-10-01T00:30:00Z', session: 's3', bank: 'archive', credited: false },
  ],
  diag: [
    { ts: '2026-10-01T00:00:00Z', event: 'inject_recall', ms: 5000 },
    { ts: '2026-10-01T00:01:00Z', event: 'inject_recall', ms: 7000 },
    { ts: '2026-10-01T00:02:00Z', event: 'inject_recall_failed', ms: 10000 },
    { ts: '2026-10-01T00:03:00Z', event: 'retain_ok', ms: 200 },
    { ts: '2026-10-01T00:04:00Z', event: 'retain_failed', ms: 10000 },
    { ts: '2026-10-01T00:05:00Z', event: 'pages_ok', ms: 100 },
    { ts: '2026-10-01T00:06:00Z', event: 'inject_empty' },
  ],
});

test('arena: Hindsight 侧统计只用它自己的日志算（含失败率/分位/bank/credit）', () => {
  assert.equal(theirs.recall.attempts, 3);
  assert.equal(theirs.recall.failed, 1);
  assert.ok(Math.abs(theirs.recall.failureRate - 1 / 3) < 1e-9);
  assert.equal(theirs.retain.failed, 1);
  assert.equal(theirs.pages.failureRate, 0);
  assert.equal(theirs.recall.empty, 1);
  // 分位口径与 m5 的 percentile 一致（floor(q*n) 截断到 n-1）：n=2 时 p50 落在第 2 个
  assert.equal(theirs.latency.injectRecall.p50, 7000);
  assert.equal(theirs.banks.count, 3, '三块 bank 都要数出来');
  assert.equal(theirs.banks.topProject, 'coding-agent::default-workspace');
  assert.equal(theirs.banks.archiveTurns, 1);
  assert.equal(theirs.sessions.total, 3);
  assert.equal(theirs.sessions.spanningMultipleBanks, 0);
  assert.equal(theirs.credited.turns, 1);
});

test('arena: quantile 取的是实数分位（空数组 ⇒ null，不抛）', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([5, 1, 3], 0.5), 3, '口径同 m5 percentile：floor(0.5*3)=1 ⇒ 3');
  assert.equal(quantile([5, 1, 3], 0.9), 5);
});

test('arena: 我方侧在没给 guard 时不编数字', () => {
  const ours = summarizeOurs({ guard: null, liveStatsFile: null });
  assert.equal(ours.axes, null);
  assert.deepEqual(ours.live, { injections: null, failed: null });
});

test('arena: A3/A4/A5 三条按机械判据判 win；A1/A2/A6 必须留在 incomparable', () => {
  const ours = { axes: { a1: 0, a1Coverage: 0.97, a5: 0, a6: 1, p50: 9, a2bStrict: 0.84, a2bCover: 1, a2bN: 19 }, live: { injections: 79, failed: 0 } };
  const rows = compareAxes({ ours, theirs });
  const by = Object.fromEntries(rows.map((r) => [r.axis.slice(0, 2), r.verdict]));
  assert.equal(by.A3, 'win');
  assert.equal(by.A4, 'win');
  assert.equal(by.A5, 'win');
  assert.equal(by.A1, 'incomparable', '对方没量过 ⇒ 不许判 win');
  assert.equal(by.A2, 'incomparable', '主判据没有同口径读数 ⇒ 不许判 win');
  assert.equal(by.A6, 'incomparable');
  assert.ok(rows.find((r) => r.axis.startsWith('A2')).theirs.includes('不'), 'A2 行要写明为什么不可比');
});

test('arena: 我方真出过注入失败时 A3 不再判 win（判据跟着数据走）', () => {
  const ours = { axes: { a1: 0, a5: 0, a6: 1, p50: 9, a2bStrict: 0.84, a2bCover: 1, a2bN: 19 }, live: { injections: 79, failed: 2 } };
  const rows = compareAxes({ ours, theirs });
  assert.equal(rows.find((r) => r.axis.startsWith('A3')).verdict, 'incomparable');
});

test('arena: 我方延迟比对方高时不判 win', () => {
  const ours = { axes: { a1: 0, a5: 0, a6: 1, p50: 9000, a2bStrict: 0.84, a2bCover: 1, a2bN: 19 }, live: { injections: 79, failed: 0 } };
  const rows = compareAxes({ ours, theirs });
  assert.equal(rows.find((r) => r.axis.startsWith('A4')).verdict, 'incomparable');
});
