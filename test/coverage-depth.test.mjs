// T379：覆盖率必须**分层报**（根局 / 子代理局），且无 claim 抽样只从根局抽。
//
// 为什么钉：分母混算过一次真实事故 —— 4079 个子代理局被算进分母，覆盖率被压成 5.30%，
// 据此还得出了"归并没实现导致覆盖率低"的错误结论（实测归并收益为 0）。
// 这些数字决定了工程方向，一旦悄悄退回"混算"，下一个人会再次走错路。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { audit } from '../scripts/coverage-audit.mjs';

function fakeStore(episodes, claims) {
  const kinds = { episodes, claims, topics: [], links: [] };
  return { list: (kind) => (kinds[kind] ?? []).map((record) => ({ record })) };
}

test('T379: audit 必须返回 byDepth（根局/子代理分层），且 rate 只按根局算', () => {
  const episodes = [
    { id: 'ep-root1', delegationDepth: 0, signals: { failures: 1 } },
    { id: 'ep-root2', delegationDepth: 0, signals: { failures: 0 } },
    { id: 'ep-sub1', delegationDepth: 1, signals: { failures: 3 } },
  ];
  const claims = [{ id: 'c-1', support: [{ episode: 'ep-root1' }] }];
  const r = audit({ store: fakeStore(episodes, claims), home: os.tmpdir(), sample: 10 });
  assert.ok(r.byDepth, 'must expose byDepth');
  assert.equal(r.byDepth.root.episodes, 2);
  assert.equal(r.byDepth.root.withClaims, 1);
  assert.equal(r.byDepth.root.rate, 0.5, '根局覆盖率 = 1/2；子代理局不进分母');
  assert.equal(r.byDepth.subagent.episodes, 1);
  assert.ok(!r.samples.some((s) => String(s.id).startsWith('ep-sub')), '无 claim 抽样不许混进子代理局');
});
