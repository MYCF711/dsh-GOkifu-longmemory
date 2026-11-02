import test from 'node:test';
import assert from 'node:assert/strict';
import { setFromReport } from '../scripts/a2b-set.mjs';

const SPLIT = 1000;

test('a2b-set: 只收切点后、有当年先例的签名；同域标记正确', () => {
  const report = {
    primary: {
      rows: [
        { episode: 'ep-old', startedAt: 500, scopeKey: 'w:a', repeatSignatures: [], novelSignatures: ['sig-1'] },
        { episode: 'ep-new1', startedAt: 1100, scopeKey: 'w:a', repeatSignatures: ['sig-1'], novelSignatures: [] },
        { episode: 'ep-new2', startedAt: 1200, scopeKey: 'w:b', repeatSignatures: ['sig-1', 'sig-2'], novelSignatures: [] },
      ],
    },
  };
  const set = setFromReport(report, SPLIT);
  // sig-1：ep-new1（同域 w:a）+ ep-new2（跨域 w:b）；sig-2 没有先例，不收
  assert.equal(set.count, 2);
  const same = set.items.filter((i) => i.sig === 'sig-1').map((i) => i.sameScope).sort();
  assert.deepEqual(same, [false, true]);
  assert.ok(set.items.every((i) => i.prior.includes('ep-old')));
});

test('a2b-set: 输出稳定排序（sig, episode）', () => {
  const rows = [
    { episode: 'ep-old', startedAt: 1, scopeKey: 'w:a', repeatSignatures: [], novelSignatures: ['b-sig', 'a-sig'] },
    { episode: 'ep-n1', startedAt: 2000, scopeKey: 'w:a', repeatSignatures: ['b-sig', 'a-sig'], novelSignatures: [] },
  ];
  const set = setFromReport({ primary: { rows } }, SPLIT);
  assert.deepEqual(set.items.map((i) => i.sig), ['a-sig', 'b-sig']);
});
