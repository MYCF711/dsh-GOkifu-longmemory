// 巡检汇总脚本（0.142.0）：删掉 scripts/patrol.mjs ⇒ 本文件整片红。
// 钉住三件事：心跳行解析（gates-failed 在「原因」行）、审计摘要解析、判定规则（A5/A6/日期）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveStats, parseAudit, verdictOf } from '../scripts/patrol.mjs';

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
