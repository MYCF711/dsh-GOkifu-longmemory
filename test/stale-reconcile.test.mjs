// T203 · 真 stale 对账脚本的单测（构造夹具，不依赖真库）
//
// 覆盖：口径 A（runValidityCheck）/ 口径 B1（classifyClaim.action）/ 差集 / 逐条原因 /
//       **回归守卫：classifyClaim 返回 {action,...} 而不是 {ok,...}，任何 `verdict.ok !== false`
//       的过滤都会把全部记录跳过（T201 的 0 就是这么来的）**。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDiffGuard,
  diffStaleSets,
  explainDifference,
  pickStaleByAudit,
  pickStaleByT201,
  reconcile,
} from '../scripts/stale-reconcile.mjs';
import { classifyClaim } from '../scripts/mark-stale.mjs';
import { probeValidity } from '../src/rooms/gates.mjs';

const SCOPE = 'w:d:/work/demo';
const claim = (id, validity, over = {}) => ({
  id,
  kind: 'fact',
  text: `正文 ${id}`,
  scopeKey: SCOPE,
  state: 'observed',
  support: [{ episode: 'ep-a', seq: 1, quote: 'q' }],
  counter: [],
  validity,
  preconditions: [],
  occurredAt: Date.UTC(2026, 9, 22),
  ...over,
});

/** 假探针：appeared.txt 存在，其余不存在；任何 package.json 都读不到。 */
const fakeIo = {
  stat: (p) => (String(p).endsWith('appeared.txt') ? { isFile: () => true, mtimeMs: 0, size: 1 } : null),
  readJson: () => { throw new Error('ENOENT'); },
  sha256: () => 'deadbeef',
  gitHasCommit: () => false,
};
const fakeProbe = (record, ws, dshHome) => probeValidity(record, { workspace: ws, dshHome, probe: fakeIo });

const APPEARED = { type: 'file', value: 'C:/fake/appeared.txt', expect: 'missing' };
const ABSENT = { type: 'file', value: 'C:/fake/never.txt', expect: 'missing' };
const VERSION = { type: 'version', value: 'ghost-pkg@1.0.0' };

const fixtures = () => [
  claim('c-apex', APPEARED),
  claim('c-never', ABSENT),
  claim('c-ver', VERSION),
  claim('c-inactive', APPEARED, { state: 'invalidated' }),
];

/** `findStaleTargets` 只用到 store.list('claims')。 */
const fakeStore = (records) => ({ list: (kind) => (kind === 'claims' ? records.map((record) => ({ record })) : []) });

test('T203 口径 A：只收 ok:false 且非 unverified 的条目', () => {
  const a = pickStaleByAudit({ claims: fixtures(), now: Date.UTC(2026, 10, 5), dshHome: '/no-home', probe: fakeIo });
  assert.deepEqual(a.ids.sort(), ['c-apex', 'c-inactive'], 'appeared 的两条都算真 stale（A 不看 state）');
  assert.deepEqual(a.rows.map((r) => r.reason).sort(), ['file-appeared', 'file-appeared']);
  assert.equal(a.summary.unverified, 1, '读不到版本包的算 unverified');
});

test('T203 口径 B1：classifyClaim.action === "mark"（只有这两类真失效）', () => {
  const b1 = pickStaleByT201({ claims: fixtures(), probe: fakeProbe, dshHome: '/no-home', workspace: '/work' });
  assert.deepEqual(b1.ids, ['c-apex'], 'invalidated 不标；unverified 不标；fresh 不标');
  assert.equal(b1.skips['already-inactive'], 1);
  assert.equal(b1.skips.unverified, 1);
  assert.equal(b1.skips.fresh, 1);
  assert.equal(b1.skipsById['c-inactive'], 'already-inactive', '跳过原因要能按 id 取到');
});

test('T203 回归守卫：classifyClaim 返回 {action}，**没有 ok 字段**（`verdict.ok !== false` 会全跳过）', () => {
  const marked = classifyClaim(claim('c-x', APPEARED), { probe: fakeProbe, workspace: '/work', dshHome: '/no-home' });
  assert.equal(marked.action, 'mark');
  assert.equal(marked.reason, 'file-appeared');
  assert.equal(marked.ok, undefined, '这正是 T201 的缺陷来源：用 ok 过滤 ⇒ 永远 continue');
  const naiveFilterKeepsIt = marked.ok !== false; // 写执行包里的那段判断
  assert.equal(naiveFilterKeepsIt, true, '`ok !== false` 对 {action} 恒为 true ⇒ 每条都被跳过');
  assert.equal(classifyDiffGuard(marked), 't201-ok-field', '守卫函数必须识别这个形状');
});

test('T203 diffStaleSets：onlyA / onlyB / both', () => {
  const d = diffStaleSets(['c-1', 'c-2', 'c-3'], ['c-2', 'c-3', 'c-4']);
  assert.deepEqual(d.onlyA, ['c-1']);
  assert.deepEqual(d.onlyB, ['c-4']);
  assert.deepEqual(d.both, ['c-2', 'c-3']);
  assert.deepEqual(diffStaleSets([], []), { onlyA: [], onlyB: [], both: [] });
});

test('T203 explainDifference：四类差异各给一句可复核的理由', () => {
  assert.equal(explainDifference({ inA: true, inB0: false, inB1: true }).code, 't201-ok-field');
  assert.equal(explainDifference({ inA: true, inB0: false, inB1: false, b1Detail: { reason: 'already-inactive' } }).code, 'b1-skip:already-inactive');
  assert.equal(explainDifference({ inA: true, inB0: false, inB1: false, b1Detail: { reason: 'unverified' } }).why.includes('核不了'), true);
  assert.equal(explainDifference({ inA: true, inB0: true, inB1: true }).code, 'both');
  assert.equal(explainDifference({ inA: false, inB0: false, inB1: false }).code, 'neither');
});

test('T203 reconcile 端到端：A=2 / B0=0 / B1=1，差集逐条归因', () => {
  const records = fixtures();
  const r = reconcile({ store: fakeStore(records), claims: records, probe: fakeProbe, io: fakeIo, now: Date.UTC(2026, 10, 5), dshHome: '/no-home' });
  assert.equal(r.a.n, 2, 'A（audit-12 口径）');
  assert.equal(r.b0.n, 0, 'B0（T201 现状）—— 缺陷导致的 0');
  assert.equal(r.b1.n, 1, 'B1（T201 意图）');
  assert.deepEqual(r.diff.aVsB0.onlyA.sort(), ['c-apex', 'c-inactive']);
  assert.deepEqual(r.diff.aVsB1.onlyA, ['c-inactive'], 'A 收 invalidated、B1 不收 —— 这一条是口径差异不是缺陷');
  assert.deepEqual(r.diff.aVsB1.both, ['c-apex']);
  const byId = new Map(r.differences.map((d) => [d.id, d]));
  assert.equal(byId.get('c-apex').code, 't201-ok-field');
  assert.equal(byId.get('c-inactive').code, 'b1-skip:already-inactive');
  assert.match(r.verdict, /T201 的扫描有缺陷/);
});
