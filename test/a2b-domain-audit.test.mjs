// T182 · A2b 域分析的单测（构造夹具，不依赖真库）
//
// 覆盖：机械三分类（in-domain-miss / cross-domain / absent）、覆盖 claim 查找、
//       A2b 逐样本行拼装（命中/失分、claim 归因）、汇总与"域校正后"口径、零分母守卫。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSamples,
  claimsCoveringPrior,
  classifyMiss,
  formatSummary,
  scopeIndex,
  summarize,
} from '../scripts/a2b-domain-audit.mjs';

const SCOPE_A = 'w:d:/work/a';
const SCOPE_B = 'w:e:/work/b';

const claim = (id, { text = 'boom', scopeKey = SCOPE_A, support = [] } = {}) => ({
  id,
  text,
  scopeKey,
  support: support.map((episode) => ({ episode, seq: 1, quote: 'q' })),
});

test('T182 classifyMiss: 三分类按 scopeKey 严格相等机械判定', () => {
  assert.equal(classifyMiss({ currentScope: SCOPE_A, coveringScopes: [] }), 'absent', '没有覆盖 claim ⇒ absent');
  assert.equal(classifyMiss({ currentScope: SCOPE_A, coveringScopes: [SCOPE_B] }), 'cross-domain', '覆盖 claim 全在别域');
  assert.equal(classifyMiss({ currentScope: SCOPE_A, coveringScopes: [SCOPE_A] }), 'in-domain-miss', '本域有覆盖 claim ⇒ 真失分');
  assert.equal(classifyMiss({ currentScope: SCOPE_A, coveringScopes: [SCOPE_B, SCOPE_A] }), 'in-domain-miss', '只要本域有一条就算真失分');
  assert.equal(classifyMiss({ currentScope: null, coveringScopes: [SCOPE_A] }), 'cross-domain', '当前 scope 未知 ⇒ 不能算本域');
  assert.equal(classifyMiss({}), 'absent', '空入参不抛');
});

test('T182 claimsCoveringPrior: 按 support 里的 episode 命中，空 prior 返回空', () => {
  const a = claim('c-1', { support: ['ep-a', 'ep-b'] });
  const b = claim('c-2', { support: ['ep-c'] });
  assert.deepEqual(claimsCoveringPrior([a, b], ['ep-b']).map((x) => x.id), ['c-1']);
  assert.deepEqual(claimsCoveringPrior([a, b], []), []);
  assert.deepEqual(claimsCoveringPrior([a, b], ['ep-zzz']), []);
  assert.deepEqual(claimsCoveringPrior([null, { id: 'c-x' }], ['ep-a']), [], '缺 support 的记录不算覆盖');
});

test('T182 scopeIndex: episode → scopeKey 投影（缺字段的条目跳过）', () => {
  const map = scopeIndex([
    { id: 'ep-1', scopeKey: SCOPE_A },
    { id: 'ep-2' },
    null,
    { id: 3, scopeKey: SCOPE_B },
  ]);
  assert.equal(map.get('ep-1'), SCOPE_A);
  assert.equal(map.has('ep-2'), false);
  assert.equal(map.has('3'), false, '非字符串 id 不收');
});

test('T182 buildSamples: 命中/失分逐条归因（claim 文本前缀 + 覆盖域）', () => {
  const sig = 'error: url hostname "raw.githubusercontent.com" resolves to a non-public ip address';
  const sampled = [
    // 命中（严格）：bestText 对应一条 claim
    // bestText 是 claim 文本的 120 字前缀（与 measureA2b 的 `String(record.text).slice(0, 120)` 同口径）
    { sig: sig.slice(0, 60), prior: ['ep-1'], hit: true, specific: true, bestOverlap: 3, bestText: 'target-text with more', bucket: 'multiHop' },
    // 失分：本域有覆盖 claim ⇒ in-domain-miss
    { sig: 'sig-two', prior: ['ep-2'], hit: false, specific: false, bestOverlap: 1, bestText: '', bucket: 'openDomain' },
    // 失分：覆盖 claim 只在别域 ⇒ cross-domain
    { sig: 'sig-three', prior: ['ep-3'], hit: false, specific: false, bestOverlap: 0, bestText: '', bucket: 'openDomain' },
    // 失分：库里没有覆盖 claim ⇒ absent
    { sig: 'sig-four', prior: ['ep-9'], hit: false, specific: false, bestOverlap: 0, bestText: '', bucket: 'singleHop' },
  ];
  const frozenItems = [
    { sig: sig.slice(0, 60), scopeKey: SCOPE_A, episode: 'ep-a1', prior: ['ep-1'] },
    { sig: 'sig-two', scopeKey: SCOPE_A, episode: 'ep-a2', prior: ['ep-2'] },
    { sig: 'sig-three', scopeKey: SCOPE_A, episode: 'ep-a3', prior: ['ep-3'] },
    { sig: 'sig-four', scopeKey: SCOPE_A, episode: 'ep-a4', prior: ['ep-9'] },
  ];
  const claims = [
    claim('c-hit', { text: 'target-text with more', support: ['ep-1'] }),
    claim('c-in', { text: 'in domain', scopeKey: SCOPE_A, support: ['ep-2'] }),
    claim('c-out', { text: 'out of domain', scopeKey: SCOPE_B, support: ['ep-3'] }),
  ];
  const scopeByEpisode = new Map([['ep-1', SCOPE_A], ['ep-2', SCOPE_A], ['ep-3', SCOPE_B], ['ep-9', SCOPE_A]]);

  const rows = buildSamples({ sampled, frozenItems, claims, scopeByEpisode });
  assert.equal(rows.length, 4);

  assert.equal(rows[0].strictHit, true);
  assert.equal(rows[0].verdict, 'hit');
  assert.equal(rows[0].matchedClaimId, 'c-hit');
  assert.deepEqual(rows[0].priorScopes, [SCOPE_A]);

  assert.equal(rows[1].verdict, 'in-domain-miss');
  assert.deepEqual(rows[1].coveringScopes, [SCOPE_A]);
  assert.equal(rows[1].coveringClaims, 1);

  assert.equal(rows[2].verdict, 'cross-domain');
  assert.deepEqual(rows[2].coveringScopes, [SCOPE_B]);

  assert.equal(rows[3].verdict, 'absent');
  assert.equal(rows[3].coveringClaims, 0);
  assert.deepEqual(rows[3].coveringScopes, []);
});

test('T182 buildSamples: frozen 里没有该 sig 时退回 A2b 的 prior 切片；空入参不抛', () => {
  const rows = buildSamples({
    sampled: [{ sig: 'orphan-sig', prior: ['ep-7', 'ep-8'], hit: false, specific: false, bestOverlap: 0, bestText: '' }],
    frozenItems: [],
    claims: [],
    scopeByEpisode: new Map([['ep-7', SCOPE_A]]),
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].prior, ['ep-7', 'ep-8']);
  assert.deepEqual(rows[0].priorScopes, [SCOPE_A]);
  assert.equal(rows[0].scope, null);
  assert.equal(rows[0].verdict, 'absent');
  assert.deepEqual(buildSamples({}), []);
});

test('T182 summarize: 严格率 + 三分类计数 + 域校正后口径（只展示，不改口径）', () => {
  const rows = [
    { strictHit: true, looseHit: true, verdict: 'hit' },
    { strictHit: true, looseHit: true, verdict: 'hit' },
    { strictHit: false, looseHit: true, verdict: 'cross-domain' },
    { strictHit: false, looseHit: false, verdict: 'in-domain-miss' },
    { strictHit: false, looseHit: false, verdict: 'absent' },
  ];
  const s = summarize(rows);
  assert.equal(s.n, 5);
  assert.equal(s.strictHits, 2);
  assert.equal(s.looseHits, 3);
  assert.equal(s.strict, 2 / 5);
  assert.equal(s.inDomainMiss, 1);
  assert.equal(s.crossDomain, 1);
  assert.equal(s.absent, 1);
  assert.equal(s.correctedDenominator, 4, 'cross-domain 从分母里去掉');
  assert.equal(s.correctedStrict, 2 / 4);
  assert.equal(summarize([]).strict, null, '零样本不写 0');
  assert.equal(summarize([]).correctedStrict, null, '零分母不写 0');
});

test('T182 formatSummary: 一行里同时给出严格率与域校正后口径', () => {
  const line = formatSummary(summarize([
    { strictHit: true, verdict: 'hit' },
    { strictHit: false, verdict: 'cross-domain' },
  ]));
  assert.match(line, /A2b 严格 = 1\/2（50\.00%）/);
  assert.match(line, /cross-domain 1/);
  assert.match(line, /域校正后 = 1\/1（100\.00%）/);
});
