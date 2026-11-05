// 巡检汇总脚本（0.142.0）：删掉 scripts/patrol.mjs ⇒ 本文件整片红。
// 钉住三件事：心跳行解析（gates-failed 在「原因」行）、审计摘要解析、判定规则（A5/A6/日期）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveStats, parseAudit, verdictOf, semanticRowOf } from '../scripts/patrol.mjs';

const LIVE = [
  '共 100 行 · 2026/11/4 10:00 → 2026/11/4 23:00 · shadow 0 行',
  '宿主行 90 · 仿真行 0',
  '动作：skip=88 · inject=12',
  '原因：no-signal=80 · no-hit=5 · gates-failed=3',
].join(String.fromCharCode(10));

const AUDIT_OK = [
  '样本 26 张 · 引用 67 条 · at-seq 67 · elsewhere 0 · missing 0 · joined 0 · 日期一致 67/67 （--current ⇒ 宿主 pid=4532）',
  '（引用层：可回溯 67/67（100.0%，弱判据）· 同作用域 67 · 跨作用域 0 · window=±10）',
].join(String.fromCharCode(10));
const AUDIT_BAD = [
  '样本 26 张 · 引用 67 条 · at-seq 60 · elsewhere 3 · missing 4 · joined 0 · 日期一致 65/67 （--current ⇒ 宿主 pid=4532）',
  '（引用层：可回溯 67/67（100.0%，弱判据）· 同作用域 65 · 跨作用域 2 · window=±10）',
].join(String.fromCharCode(10));

test('patrol: 心跳解析 —— gates-failed 在「原因」行（踩过：写成动作行一直是 ?）', () => {
  const s = parseLiveStats(LIVE);
  assert.equal(s.inject, 12);
  assert.equal(s.skip, 88);
  assert.equal(s.gatesFailed, 3);
});

test('patrol: 审计摘要解析 —— 七项都取到，pid 也取到', () => {
  const a = parseAudit(AUDIT_OK);
  assert.deepEqual(
    { samples: a.samples, refs: a.refs, atSeq: a.atSeq, missing: a.missing, dateOk: a.dateOk, crossScope: a.crossScope, pid: a.pid },
    { samples: 26, refs: 67, atSeq: 67, missing: 0, dateOk: 67, crossScope: 0, pid: 4532 },
  );
});

test('patrol: 判定 —— 全绿时没问题；跨作用域/ missing / 日期不一致都要报出来', () => {
  assert.deepEqual(verdictOf(parseAudit(AUDIT_OK)), { ok: true, problems: [] });
  const bad = verdictOf(parseAudit(AUDIT_BAD));
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes('跨作用域')));
  assert.ok(bad.problems.some((p) => p.includes('missing')));
  assert.ok(bad.problems.some((p) => p.includes('日期')));
});

test('patrol: 空输入不炸（没装 store 的机器上也能跑）', () => {
  assert.deepEqual(parseLiveStats(''), { inject: null, skip: null, gatesFailed: null });
  const empty = parseAudit('');
  assert.equal(empty.refs, null);
});

// ---------------------------------------------------------------- T250（主判据进巡检）
//
// 巡检以前没有 A2b 行 —— 主人改判后它是**第一验收面**，看不到就等于没有。
// 数据只读 `metrics-guard --json` 的结果（阈值/红绿/样本来源全不由 patrol 决定）。

import { a2bRowOf } from '../scripts/patrol.mjs';

test('T250 ①: 正常 JSON ⇒ 一行主判据（带 n 与 sampleSource）', () => {
  const row = a2bRowOf(JSON.stringify({ ok: true, values: { a2bStrict: 0.3426, a2bCover: 0.6852, a2bN: 108, sampleSource: 'holdout' } }));
  assert.equal(row.ok, true);
  assert.match(row.text, /^\| 主判据 A2b \| /);
  assert.match(row.text, /n=108/);
  assert.match(row.text, /holdout/);
  assert.match(row.text, /34\.3%/);
  assert.match(row.text, /68\.5%/);
});

test('T250 ②: metrics-guard 判红 ⇒ patrol 该行也红，并带原因（不重写阈值）', () => {
  const row = a2bRowOf(JSON.stringify({ ok: false, fails: ['A2b 严格 0.3 < 0.3426（sampleSource=holdout n=108）'], values: { a2bStrict: 0.3, a2bCover: 0.5, a2bN: 108, sampleSource: 'holdout' } }));
  assert.equal(row.ok, false);
  assert.match(row.text, /\*\*要看\*\*/);
  assert.match(row.text, /A2b 严格 0\.3/, '原因要原样带出来');
});

test('T250 ③: 拿不到 JSON ⇒ fail-closed（显示 **要看**，不静默略过）', () => {
  for (const bad of ['', 'not json', null, undefined]) {
    const row = a2bRowOf(bad);
    assert.equal(row.ok, false, `输入 ${String(bad)} 必须 fail-closed`);
    assert.match(row.text, /\*\*要看\*\*/);
    assert.match(row.text, /fail-closed/);
  }
});

// ── T269：语义不变量（SI）接进巡检 ───────────────────────────────────────────
test('T269 ①: pass ⇒ 通过（带 pass/fail/unverified 三项计数）', () => {
  const r = semanticRowOf(JSON.stringify({ pass: 38, fail: 0, unverified: 0, buckets: {}, samples: [] }), 0);
  assert.equal(r.ok, true);
  assert.match(r.text, /语义不变量/);
  assert.match(r.text, /pass 38 · fail 0 · unverified 0/);
  assert.match(r.text, /通过/);
});

test('T269 ②: fail ⇒ **要看** 且带 SI 类型与首例 claimId', () => {
  const payload = { pass: 36, fail: 2, unverified: 0, buckets: { 'SI-5-missing-toOccurredAt': 1, 'SI-4-claim-time-out-of-window': 1 }, samples: [{ claimId: 'c-00a2178a', kind: 'SI-5-missing-toOccurredAt' }] };
  const r = semanticRowOf(JSON.stringify(payload), 1);
  assert.equal(r.ok, false);
  assert.match(r.text, /\*\*要看\*\*/);
  assert.match(r.text, /SI-5-missing-toOccurredAt 1/);
  assert.match(r.text, /c-00a2178a/);
});

test('T269 ③: unverified > 0 ⇒ 也要看（fail-closed）', () => {
  const r = semanticRowOf(JSON.stringify({ pass: 0, fail: 0, unverified: 3, buckets: {}, samples: [] }), 1);
  assert.equal(r.ok, false);
  assert.match(r.text, /unverified 3/);
});

test('T269 ④: 超时/杀进程（exitCode=null）⇒ **要看** 且写明超时', () => {
  const r = semanticRowOf('', null);
  assert.equal(r.ok, false);
  assert.match(r.text, /超时/);
  assert.match(r.text, /\*\*要看\*\*/);
});

test('T269 ⑤: 输出不是 JSON ⇒ 红（绝不静默略过）', () => {
  const r = semanticRowOf('boom', 2);
  assert.equal(r.ok, false);
  assert.match(r.text, /拿不到 semantic-check 的输出/);
});
