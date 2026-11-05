// T259 · 消歧修复副作用体检（tombstone：删掉 `scripts/repair-side-effects.mjs` ⇒ 本文件红）
//
// 覆盖：
//   ① 卡片 provenance 抽取（`(ep-xxxxxxxx, seq 123)` / 带日期的变体）
//   ② 逐卡对照：行数变化 + provenance 变化 + A5 跨域违规
//   ③ 日期一致性：容差内 ok、超容差记 mismatch、读不到记 unreadable
//   ④ 守卫：本工具只读（--apply 直接退出 1；--copy 与真库同目录也退出 1）

import test from 'node:test';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  extractCardRefs, cardLines, compareCardPair, buildTimeIndex, checkDateConsistency, runCli,
} from '../scripts/repair-side-effects.mjs';

test('T259 ①: 从卡片正文抽 provenance（两种渲染形态）', () => {
  const section = [
    '- [antipattern] fatal: x (ep-8cc34e32, seq 33143)',
    '- [semantic] y (ep-0000abcd, 2026-11-01, seq 1234)',
    'omitted: 3 items（超出上限）',
  ].join('\n');
  const refs = extractCardRefs(section);
  assert.deepEqual(refs, [
    { episode: 'ep-8cc34e32', seq: 33143 },
    { episode: 'ep-0000abcd', seq: 1234 },
  ]);
  assert.equal(cardLines(section).length, 2, 'omitted 行不算条目');
});

test('T259 ②: 逐卡对照 —— 行数/provenance/A5', () => {
  const before = '- [a] x (ep-11111111, seq 100)\n- [b] y (ep-11111111, seq 200)';
  const after = '- [a] x (ep-11111111, seq 104)';
  const r = compareCardPair({ before, after, beforeCross: 0, afterCross: 0 });
  assert.equal(r.linesBefore, 2);
  assert.equal(r.linesAfter, 1);
  assert.equal(r.linesDelta, -1);
  assert.equal(r.provenanceRemoved, 2, '100/200 消失');
  assert.equal(r.provenanceAdded, 1, '104 出现');
  assert.equal(r.provenanceChanged, 3);
  assert.equal(r.crossScopeOk, true);

  const bad = compareCardPair({ before, after, beforeCross: 0, afterCross: 2 });
  assert.equal(bad.crossScopeOk, false, 'A5 跨域必须被抓住');
});

test('T259 ③: 日期一致性 —— 容差内 ok / 超容差 mismatch / 读不到 unreadable', () => {
  const events = [{ seq: 104, time: 1_700_000_500_000 }];
  const times = buildTimeIndex(events);
  assert.equal(times.get(104), 1_700_000_500_000);

  const mk = (declared, episode = 'ep-11111111') => ({
    id: 'c-1',
    occurredAt: declared,
    support: [{ episode, seq: 104, occurredAt: declared }],
    provenanceRepair: [{ at: 1, fixes: [{ index: 0, from: 100, to: 104, eventType: 'tool/result' }] }],
  });

  const ok = checkDateConsistency({ claims: [mk(1_700_000_500_000)], loadEvents: () => events });
  assert.equal(ok.ok, 1);
  assert.equal(ok.mismatched.length, 0);

  const bad = checkDateConsistency({ claims: [mk(1_700_000_000_000)], loadEvents: () => events });
  assert.equal(bad.mismatched.length, 1);
  assert.equal(bad.mismatched[0].deltaMs, 500_000);

  const unread = checkDateConsistency({ claims: [mk(1)], loadEvents: () => null });
  assert.equal(unread.unreadable, 1);
});

test('T259 ④: 守卫 —— 只读工具拒绝 --apply，且拒绝 --copy 指向真库', () => {
  const applyRes = runCli(['--apply', '--copy', 'tmp/x']);
  assert.equal(applyRes.code, 1);
  assert.match(applyRes.stdout, /拒绝 --apply/);

  // 不用 process.env.DSH_HOME：CI 上它未设置 ⇒ 路径变成 "undefined/memory-context"，
  // 与真库根不相等 ⇒ 守卫不触发（Linux CI 红）。改成显式 --real，两侧同一根，确定可判。
  const real = 'tmp/definitely-not-the-real-store';
  const same = runCli(['--real', real, '--copy', real]);
  assert.equal(same.code, 1);
  assert.match(same.stdout, /同一个目录/);

  const missing = runCli([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stdout, /--copy/);
});
