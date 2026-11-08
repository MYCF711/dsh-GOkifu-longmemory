// T53 · A1.redundant 的窗口必须跟着「当前在跑的那份代码」走（tombstone test）。
//
// 为什么（2026-11-09）：`fixAt` 原来是一个**写死的常量**（上一次修判据的时点）。于是新一版修法上线后，
// 窗口里仍然混着**旧代码**注入的那批 ⇒ 修好了也照样红满 24 小时，看起来像"没修好"。
// 改成 `max(常量, 当前宿主 pid 的首条心跳)`：宿主一重启，窗口自动推进，不用人工改常量。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  A1_REDUNDANT_FIX_AT,
  A1_REDUNDANT_AXIS_ID,
  currentRunStartAt,
  measureA1Redundant,
} from '../scripts/m5-report.mjs';

const NL = String.fromCharCode(10);
const T0 = Date.UTC(2026, 10, 9, 0, 0, 0);
const HOUR = 3_600_000;

const row = (at, pid, over = {}) => ({ at, pid, src: 'index.js', kind: 'pre-step', action: 'inject', ...over });

function writeLive(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't53-store-'));
  fs.writeFileSync(path.join(dir, 'live-stats.jsonl'), rows.map((r) => JSON.stringify(r)).join(NL) + NL);
  return dir;
}

test('T53 ①: currentRunStartAt = **最后一条**心跳那个 pid 的首条心跳（不是全库最早，也不是最早那个 pid）', () => {
  const dir = writeLive([
    row(T0 + 1 * HOUR, 111),      // 上一个宿主
    row(T0 + 2 * HOUR, 111),
    row(T0 + 5 * HOUR, 222),      // 当前宿主
    row(T0 + 9 * HOUR, 222),      // 最后一条心跳
  ]);
  try {
    assert.equal(currentRunStartAt(dir), T0 + 5 * HOUR);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T53 ②: 不是宿主写的行（src 非 index.js）不参与判定', () => {
  const dir = writeLive([
    row(T0 + 1 * HOUR, 111, { src: 'host-sim.mjs' }),
    row(T0 + 3 * HOUR, 222),
    row(T0 + 4 * HOUR, 222),
  ]);
  try {
    assert.equal(currentRunStartAt(dir), T0 + 3 * HOUR, '仿真行不能当"当前宿主"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T53 ③: 没有 live-stats ⇒ null（不编造一个 start）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't53-empty-'));
  try {
    assert.equal(currentRunStartAt(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T53 ④: measureA1Redundant 用 runStartAt 当窗口下限（旧代码那批注入不计入）', () => {
  const now = T0 + 20 * HOUR;
  const runStartAt = T0 + 10 * HOUR;
  // 同一会话同一 digest 投两次：一次在 runStartAt 之前（旧代码），一次之后
  const sessions = [{
    sessionId: 's-1',
    compactionAt: [],
    injections: [
      { at: T0 + 2 * HOUR, seq: 1, digest: 'd1', tokens: 1000 },
      { at: T0 + 12 * HOUR, seq: 2, digest: 'd1', tokens: 1000 },
    ],
  }];
  const scan = { sessions, sessionsDir: '/x', missingSessionsDir: false, files: 1, parsed: 1, skipped: [] };
  const out = measureA1Redundant({ dataRoot: '/x', now, runStartAt, scan, env: {} });
  assert.equal(out.detail.axis, A1_REDUNDANT_AXIS_ID);
  assert.equal(out.detail.runStartAt, runStartAt);
  assert.equal(out.detail.windowStart, runStartAt, '窗口下限必须是当前代码起跑时点（比常量晚）');
  assert.equal(out.detail.injections, 1, '旧代码那次注入落在窗口外，不计入分母');
  assert.equal(out.detail.redundantWastePairs, 0, '窗口内只有一次注入 ⇒ 没有"重复"可算');
});

test('T53 ⑤: 常量比 runStartAt 晚时取常量（不因为重启就把判据本身的修复时点吞掉）', () => {
  // now 贴着常量取，否则 `now−24h` 会盖过常量（那是另一个下限，不是这条要测的）
  const now = A1_REDUNDANT_FIX_AT + 10 * HOUR;
  const scan = { sessions: [], sessionsDir: '/x', missingSessionsDir: false, files: 0, parsed: 0, skipped: [] };
  const out = measureA1Redundant({ dataRoot: '/x', now, runStartAt: A1_REDUNDANT_FIX_AT - HOUR, scan, env: {} });
  assert.equal(out.detail.windowStart, A1_REDUNDANT_FIX_AT);
  assert.equal(out.detail.declaredFixAt, A1_REDUNDANT_FIX_AT);
});

test('T53 ⑥: 换口径不藏读数 —— reference 按旧窗口（跨代码版本）再算一遍，只报不判', () => {
  const now = T0 + 20 * HOUR;
  const runStartAt = T0 + 10 * HOUR;
  const sessions = [{
    sessionId: 's-1',
    compactionAt: [],
    injections: [
      { at: T0 + 2 * HOUR, seq: 1, digest: 'd1', tokens: 1000 },
      { at: T0 + 3 * HOUR, seq: 2, digest: 'd1', tokens: 1000 },   // 旧代码那批：一次真重复
      { at: T0 + 12 * HOUR, seq: 3, digest: 'd1', tokens: 1000 },
    ],
  }];
  const scan = { sessions, sessionsDir: '/x', missingSessionsDir: false, files: 1, parsed: 1, skipped: [] };
  const out = measureA1Redundant({ dataRoot: '/x', now, runStartAt, scan, env: {} });
  assert.equal(out.detail.injections, 1, '判据只看当前代码版本');
  assert.equal(out.detail.reference.injections, 3, '参考值看旧窗口（含旧代码那两次）');
  assert.ok(out.detail.reference.redundantWaste > out.detail.redundantWaste, '旧代码那批有重复 ⇒ 参考值更高');
  assert.match(out.caveat, /参考（跨代码版本，不参与 exit code）/);
});
