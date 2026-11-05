import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLedger, compare, fullCheck } from '../scripts/ledger-check.mjs';

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

test('ledger-check: 任一项不一致都要报出来（版本/语料变少）', () => {
  const l = parseLedger(TEXT);
  // 2026-11-04（0.143.0）：语料判据改成单向（只查变少 / 台账过旧），所以这里用**变少**来触发
  const bad = compare(l, { version: '0.60.0', tests: { total: 389, pass: 385, fail: 0, skip: 4 }, claim: 300, threads: 130 });
  assert.ok(bad.some((x) => x.startsWith('版本')));
  assert.ok(bad.some((x) => x.startsWith('claim')));
  assert.ok(bad.some((x) => x.startsWith('卷')));
});

// ── T172：测试数改成**单向**判（只查变少）────────────────────────────────────
test('ledger-check T172: 实测 > 台账 ⇒ 不报（新加测试是正常进展），只记 note', () => {
  const l = parseLedger(TEXT); // 台账 389/385/0/4
  const notes = [];
  const bad = compare(l, { version: '0.59.0', tests: { total: 397, pass: 393, fail: 0, skip: 4 }, claim: 322, threads: 143 }, { notes });
  assert.deepEqual(bad, [], '新增测试不许判红');
  assert.ok(notes.some((x) => x.includes('测试 total') && x.includes('单向放行')), `notes 里要能看到：${JSON.stringify(notes)}`);
  assert.ok(notes.some((x) => x.includes('测试 pass')));
});

test('ledger-check T172: 实测 < 台账 ⇒ 必须报（测试被删/被跳过才是真信号）', () => {
  const l = parseLedger(TEXT);
  const notes = [];
  const bad = compare(l, { version: '0.59.0', tests: { total: 380, pass: 376, fail: 0, skip: 4 }, claim: 322, threads: 143 }, { notes });
  assert.ok(bad.some((x) => x.includes('测试 total') && x.includes('变少')), JSON.stringify(bad));
  assert.ok(bad.some((x) => x.includes('测试 pass')));
  assert.deepEqual(notes, [], '变少是 bad，不是 note');
});

test('ledger-check T172: 持平 ⇒ 通过，且既无 bad 也无 note', () => {
  const l = parseLedger(TEXT);
  const notes = [];
  const bad = compare(l, { version: '0.59.0', tests: { total: 389, pass: 385, fail: 0, skip: 4 }, claim: 322, threads: 143 }, { notes });
  assert.deepEqual(bad, []);
  assert.deepEqual(notes, []);
});

test('ledger-check T172: 每一维各自单向（total 涨但 pass 跌 ⇒ 只报跌的那一维）', () => {
  const l = parseLedger(TEXT);
  const notes = [];
  const bad = compare(l, { version: '0.59.0', tests: { total: 390, pass: 380, fail: 0, skip: 4 }, claim: 322, threads: 143 }, { notes });
  assert.ok(bad.some((x) => x.includes('测试 pass')), 'pass 变少要报');
  assert.ok(!bad.some((x) => x.includes('测试 total')), 'total 变多不许报');
  assert.ok(notes.some((x) => x.includes('测试 total')));
});

test('ledger-check: 缺字段时不误报（只核对能解析的项）', () => {
  const l = parseLedger('branch main = 1.0.0');
  const bad = compare(l, { version: '1.0.0', tests: null, claim: 5, threads: 6 });
  assert.deepEqual(bad, []);
});

test('ledger-check --full: 缺测点/缺 A2/A4/时点过旧都要报', () => {
  const l = parseLedger(TEXT); // 无 [本] 时点、无 A2/A4
  const fresh = fullCheck(l, [], { now: Date.parse('2026-11-02T22:00:00') });
  assert.ok(fresh.some((x) => x.includes('时点')));
  assert.ok(fresh.some((x) => x.includes('A2/A4')));
  const noCorpus = { ...l, episodes: null };
  assert.ok(fullCheck(noCorpus, [], { now: Date.parse('2026-11-02T22:00:00') }).some((x) => x.includes('局数')));

  const stale = { ...l, stamp: '2026-11-02 12:00', a2: 26.6, a4: 2.1, episodes: 117, tests: l.tests };
  const bad = fullCheck(stale, [], { now: Date.parse('2026-11-02T22:00:00') });
  assert.ok(bad.some((x) => x.includes('过旧')), '过旧必须报');

  const good = { ...stale, stamp: '2026-11-02 19:55' };
  assert.deepEqual(fullCheck(good, [], { now: Date.parse('2026-11-02T22:00:00') }), []);
});

test('ledger-check compare: 局数/A2/A4 不一致（超容差）要报', () => {
  const l = { ...parseLedger(TEXT), episodes: 117, a2: 26.6, a4: 2.1 };
  // A2 用 >2pp 的差（线上整库增长时容差是 2pp，真实退化仍要报）
  const bad = compare(l, { version: '0.59.0', tests: { total: 389, pass: 385, fail: 0, skip: 4 }, claim: 322, threads: 143, episodes: 116, a2: 30.0, a4: 9.0 });
  assert.ok(bad.some((x) => x.startsWith('局数')));
  assert.ok(bad.some((x) => x.startsWith('A2')));
  // T225：A4 改成**量级**判据（延迟是统计量，不能按绝对相等卡）。
  // 台账 2.1 vs 实测 9.0 ⇒ 上限 max(18, 29) = 29 ⇒ 在量级内，**不报**（这是抖动，不是漂移）。
  assert.ok(!bad.some((x) => x.startsWith('A4')), 'A4 在量级内不再假红');
  // 但"台账落后到量级不同"仍要报（这条才是真信号：台账陈旧/读数不可信）
  const staleLedger = compare({ ...l, a4: 100 }, { version: '0.59.0', tests: { total: 389, pass: 385, fail: 0, skip: 4 }, claim: 322, threads: 143, episodes: 117, a2: 26.6, a4: 9.0 });
  assert.ok(staleLedger.some((x) => x.startsWith('A4')), '台账比实测高一个量级要报');
  const within = compare(l, { version: '0.59.0', tests: { total: 389, pass: 385, fail: 0, skip: 4 }, claim: 322, threads: 143, episodes: 117, a2: 26.9, a4: 2.5 });
  assert.deepEqual(within, [], '容差内不报');
});

test('ledger-check: m5 采集失败时不许伪装成「台账缺 A2/A4」', () => {
  const l = parseLedger([
    'main = 0.59.0',
    '**389 条**（385 pass / 0 fail / 4 skip）',
    '[本] 2026-11-02 21:00',
  ].join('\n'));
  const bad = fullCheck(l, [], { now: Date.parse('2026-11-02T22:00:00'), m5CollectFailed: 'exit=1 · stderr: boom' });
  assert.ok(bad.some((x) => x.includes('m5 采集失败')), '要报采集失败');
  assert.ok(bad.some((x) => x.includes('boom')), '要带上 m5 的 stderr 尾巴');
  assert.ok(!bad.some((x) => x.includes('台账缺 A2/A4')), '不许把采集失败说成台账缺值');
  // 没有采集失败时，缺 A2/A4 仍按原口径报
  const plain = fullCheck(l, [], { now: Date.parse('2026-11-02T22:00:00') });
  assert.ok(plain.some((x) => x.includes('台账缺 A2/A4')));
});


test('ledger-check: 能读到 store 时按单向判 —— 增长放行、变少必报（心跳空闲也一样）', () => {
  const l = parseLedger(TEXT);
  const base = { version: '0.59.0', tests: { total: 389, pass: 385, fail: 0, skip: 4 }, threads: 143, episodes: 116 };
  // 增长：台账 322 → 实测 400，心跳不新鲜（live:false）也必须放行
  assert.deepEqual(compare(l, { ...base, claim: 400 }, { live: false }), []);
  // 变少：322 → 300，必须报
  assert.ok(compare(l, { ...base, claim: 300 }, { live: false }).some((x) => x.startsWith('claim')));
  // 根本没测到 store（干净克隆）⇒ 不比较语料
  assert.deepEqual(compare(l, { ...base, claim: null, episodes: null }, { live: false }), []);
});
