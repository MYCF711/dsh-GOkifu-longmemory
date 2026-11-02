import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLedger, compare } from '../scripts/ledger-check.mjs';

const TEXT = `
分支         main = 0.59.0
| 测试 | **389 条**（385 pass / 0 fail / 4 skip） |
| 语料 | 116 局 / **143 卷** / **claim 322**（有效期已止 25） |
`;

test('ledger-check: 能解析出版本/测试/claim/卷', () => {
  const l = parseLedger(TEXT);
  assert.equal(l.version, '0.59.0');
  assert.deepEqual(l.tests, { total: 389, pass: 385, fail: 0, skip: 4 });
  assert.equal(l.claim, 322);
  assert.equal(l.threads, 143);
});

test('ledger-check: 完全一致 ⇒ 无差异', () => {
  const l = parseLedger(TEXT);
  const bad = compare(l, { version: '0.59.0', tests: { total: 389, pass: 385, fail: 0, skip: 4 }, claim: 322, threads: 143 });
  assert.deepEqual(bad, []);
});

test('ledger-check: 任一项不一致都要报出来（含测试四个分量）', () => {
  const l = parseLedger(TEXT);
  const bad = compare(l, { version: '0.60.0', tests: { total: 390, pass: 385, fail: 0, skip: 5 }, claim: 323, threads: 144 });
  assert.ok(bad.some((x) => x.startsWith('版本')));
  assert.ok(bad.some((x) => x.includes('测试 total')));
  assert.ok(bad.some((x) => x.includes('测试 skip')));
  assert.ok(bad.some((x) => x.startsWith('claim')));
  assert.ok(bad.some((x) => x.startsWith('卷')));
});

test('ledger-check: 缺字段时不误报（只核对能解析的项）', () => {
  const l = parseLedger('branch main = 1.0.0');
  const bad = compare(l, { version: '1.0.0', tests: null, claim: 5, threads: 6 });
  assert.deepEqual(bad, []);
});
