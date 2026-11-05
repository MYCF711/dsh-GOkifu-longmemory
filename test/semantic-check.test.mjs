// T262 · 语义不变量（SI）校验器 tombstone 测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSemanticChecks, buildTimeIndex, episodeWindow, runCli } from '../scripts/semantic-check.mjs';

const T = (seq, time) => ({ seq, time });
const claims = (support, extra = {}) => [{ id: 'c-1', occurredAt: 0, support, ...extra }];
const idx = (events) => () => buildTimeIndex(events);

test('T262 ②: SI-1 一致 ⇒ pass', () => {
  const events = [T(10, 1_000), T(14, 2_000)];
  const r = runSemanticChecks({ claims: claims([{ episode: 'ep-1', seq: 14, occurredAt: 2_000 }]), timeIndexOf: idx(events) });
  assert.equal(r.fail, 0);
  assert.equal(r.pass, 1);
});

test('T262 ①: SI-1 不一致 ⇒ fail（按类型分桶）', () => {
  const events = [T(10, 1_000), T(14, 2_000)];
  const r = runSemanticChecks({ claims: claims([{ episode: 'ep-1', seq: 14, occurredAt: 1_000 }]), timeIndexOf: idx(events) });
  assert.equal(r.fail, 1);
  assert.equal(r.buckets['SI-1-time-mismatch'], 1);
});

test('T262 ⑤: tombstone —— 把 seq 改 +4 而不改 occurredAt ⇒ 必须红', () => {
  const events = [T(10, 1_000), T(14, 2_000)];
  const good = runSemanticChecks({ claims: claims([{ episode: 'ep-1', seq: 10, occurredAt: 1_000 }]), timeIndexOf: idx(events) });
  assert.equal(good.fail, 0, '原状必须是绿的');
  const broken = runSemanticChecks({ claims: claims([{ episode: 'ep-1', seq: 14, occurredAt: 1_000 }]), timeIndexOf: idx(events) });
  assert.ok(broken.fail > 0, 'seq 改 +4 不同步日期 ⇒ 必须红');
});

test('T262 ③: SI-5 缺 toOccurredAt ⇒ fail', () => {
  const events = [T(14, 2_000)];
  const r = runSemanticChecks({
    claims: claims([{ episode: 'ep-1', seq: 14, occurredAt: 2_000 }], { provenanceRepair: [{ fixes: [{ index: 0, from: 10, to: 14 }] }] }),
    timeIndexOf: idx(events),
  });
  assert.equal(r.buckets['SI-5-missing-toOccurredAt'], 1);
  assert.ok(r.fail > 0);
});

test('T262 ④: 读不到局 ⇒ unverified 单列（不判绿也不判红）', () => {
  const r = runSemanticChecks({ claims: claims([{ episode: 'ep-missing', seq: 14, occurredAt: 2_000 }]), timeIndexOf: () => null });
  assert.equal(r.unverified, 1);
  assert.equal(r.fail, 0);
  assert.equal(r.pass, 0);
});

test('T262: SI-2 序号越窗 / SI-4 时间越窗 / episodeWindow', () => {
  const events = [T(10, 1_000), T(14, 2_000)];
  assert.deepEqual(episodeWindow(buildTimeIndex(events)), { minSeq: 10, maxSeq: 14, minTime: 1_000, maxTime: 2_000 });
  const r = runSemanticChecks({ claims: claims([{ episode: 'ep-1', seq: 999, occurredAt: 1_000 }]), timeIndexOf: idx(events) });
  assert.equal(r.buckets['SI-2-seq-out-of-window'], 1);
  const r4 = runSemanticChecks({ claims: [{ id: 'c-2', occurredAt: 1_500, support: [{ episode: 'ep-1', seq: 10, occurredAt: 9_999 }] }], timeIndexOf: idx(events) });
  assert.equal(r4.buckets['SI-4-support-time-out-of-window'], 1, 'support 时间真落局外 ⇒ 仍红');
});

test('T262: 只读闸 —— --apply 一律拒绝', () => {
  const r = runCli(['--apply']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /只读/);
});

// ── T272：SI-4 改成 support 级（跨局 claim 不再误报）──────────────────────────
const D1 = Date.UTC(2026, 10, 1, 13, 31, 16);
const D3 = Date.UTC(2026, 10, 3, 10, 0, 0);

test('T272 ①: 跨局 claim（首发生于 11-01、support 引到 11-03 的局）⇒ **不误报**', () => {
  const events = [{ seq: 50, time: D3 }, { seq: 51, time: D3 + 1000 }];
  const r = runSemanticChecks({
    claims: [{ id: 'c-cross', occurredAt: D1, support: [{ episode: 'ep-1103', seq: 50, occurredAt: D3 }] }],
    timeIndexOf: idx(events),
  });
  assert.equal(r.buckets['SI-4-support-time-out-of-window'], undefined, '旧判据会误报，新判据不许');
  assert.equal(r.pass, 1);
});

test('T272 ②: tombstone —— support 的时间真落在它自己那一局外 ⇒ 仍红', () => {
  const events = [{ seq: 50, time: D3 }, { seq: 51, time: D3 + 1000 }];
  const r = runSemanticChecks({
    claims: [{ id: 'c-bad', occurredAt: D1, support: [{ episode: 'ep-1103', seq: 50, occurredAt: D1 }] }],
    timeIndexOf: idx(events),
  });
  assert.equal(r.buckets['SI-4-support-time-out-of-window'], 1);
});

test('T272 ③: claim.occurredAt 晚于所有 support ⇒ 红（首次发生不可能晚于证据）', () => {
  const events = [{ seq: 50, time: D3 }];
  const r = runSemanticChecks({
    claims: [{ id: 'c-late', occurredAt: D3 + 999_999, support: [{ episode: 'ep-1103', seq: 50, occurredAt: D3 }] }],
    timeIndexOf: idx(events),
  });
  assert.equal(r.buckets['SI-4b-claim-after-support'], 1);
});
