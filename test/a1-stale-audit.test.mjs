// T205 · A1 归因脚本的单测（构造夹具，不依赖真库）
//
// 覆盖：四类机械分类（probe-gap / probe-wrong / probe-unverified / legit）、
//       逐行审计记录的字段映射（探针输入/结果、闸 3 判定）、汇总与 stale 分类计数、
//       "为什么漏过闸 3" 的四条固定话术。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAuditRow, classifyRow, summarize, whySlipped } from '../scripts/a1-stale-audit.mjs';

const claimWith = (validity) => ({ id: 'c-x', text: '正文', validity, state: 'observed' });

test('T205 classifyRow：四类机械分类', () => {
  assert.equal(classifyRow({ hasValidity: false, result: null }), 'probe-gap', '没有 validity ⇒ 探针没跑');
  assert.equal(classifyRow({ hasValidity: true, result: { ok: true, reason: null } }), 'legit', '核过');
  assert.equal(classifyRow({ hasValidity: true, result: { ok: false, unverified: true, reason: 'version-file-unreadable' } }), 'probe-unverified', '读不到');
  assert.equal(classifyRow({ hasValidity: true, result: { ok: false, reason: 'file-appeared' } }), 'probe-wrong', '判失效却到达模型');
  assert.equal(classifyRow({ hasValidity: true, result: null }), 'probe-gap', '没有核验结果 ⇒ 按未检查算');
});

test('T205 whySlipped：四条固定话术都要能落到具体原因', () => {
  const unverified = whySlipped({ category: 'probe-unverified', gate3: 'unverified', result: { reason: 'version-file-unreadable' } });
  assert.match(unverified, /version-file-unreadable/);
  assert.match(unverified, /ok === false/, '要点出 A1 分子谓词把 unverified 也算进去');
  assert.match(whySlipped({ category: 'probe-gap', gate3: 'ok' }), /没有 validity/);
  assert.match(whySlipped({ category: 'probe-wrong', gate3: 'ok', result: { reason: 'file-appeared' } }), /闸 3 漏判/);
  assert.match(whySlipped({ category: 'legit', gate3: 'ok' }), /A1 分子算错/);
  assert.match(whySlipped({ category: 'probe-wrong', gate3: 'failed' }), /口径实现不一致/, 'failed 的卡不该进 postGate');
});

test('T205 buildAuditRow：把渲染行 + 探针结果映射成审计记录', () => {
  const row = buildAuditRow({
    claimId: 'c-175d29e9',
    signalLabel: 'magpie-chatbox-ai@0.1.0',
    signalKind: 'validity',
    scope: 'w:d:/work/x',
    gatesOk: true,
    gateErrors: [],
    claim: claimWith({ type: 'version', value: 'magpie-chatbox-ai@0.1.0' }),
    result: { ok: false, unverified: true, reason: 'version-file-unreadable', path: 'C:/ws/package.json', expected: '0.1.0', actual: null },
  });
  assert.equal(row.type, 'version');
  assert.equal(row.stale, true, 'ok:false ⇒ 进 A1 分子');
  assert.equal(row.unverified, true);
  assert.equal(row.category, 'probe-unverified');
  assert.equal(row.gate3, 'unverified');
  assert.equal(row.probeReason, 'version-file-unreadable');

  const failed = buildAuditRow({ claimId: 'c-y', gatesOk: false, gateErrors: ['gate3/stale-not-marked', 'gate3/stale-not-marked'], claim: claimWith({ type: 'file', value: 'a' }), result: { ok: false, reason: 'file-appeared' } });
  assert.equal(failed.gate3, 'failed');
  assert.deepEqual(failed.gateErrors, ['gate3/stale-not-marked'], '错误码去重');

  const gap = buildAuditRow({ claimId: 'c-z', gatesOk: true, claim: claimWith({ type: 'none', value: null }), result: null });
  assert.equal(gap.category, 'probe-gap');
  assert.equal(gap.stale, false);
  assert.equal(gap.type, 'none');
});

test('T205 summarize：分子/分母与 stale 的分类计数', () => {
  const rows = [
    { claimId: 'a', stale: true, category: 'probe-unverified' },
    { claimId: 'b', stale: true, category: 'probe-unverified' },
    { claimId: 'c', stale: true, category: 'probe-wrong' },
    { claimId: 'd', stale: false, category: 'legit' },
    { claimId: 'e', stale: false, category: 'probe-gap' },
  ];
  const s = summarize(rows);
  assert.equal(s.injected, 5);
  assert.equal(s.stale, 3);
  assert.equal(s.rate, 3 / 5);
  assert.deepEqual(s.byCategory, { 'probe-unverified': 2, 'probe-wrong': 1, legit: 1, 'probe-gap': 1 });
  assert.deepEqual(s.staleByCategory, { 'probe-unverified': 2, 'probe-wrong': 1 });
  assert.deepEqual(s.staleIds, ['a', 'b', 'c']);
  assert.equal(summarize([]).rate, null, '零样本不写 0');
});
