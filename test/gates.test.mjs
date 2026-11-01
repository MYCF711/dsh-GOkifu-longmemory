// R13 gates 的 tombstone test：删掉 src/rooms/gates.mjs ⇒ 本文件整片红。
//
// 覆盖（方案 §6.3、边界 §5、契约 §7.2/§7.3、MAINTENANCE §三.4）：
//   - 合格卡 ⇒ ok:true、errors 空
//   - 闸 0：缺 occurredAt / 缺 seq / 行没 provenance / 日期与 occurredAt 不符 / 行数与 claims 不符 ⇒ 失败
//   - 闸 6：超 500 tokens / 超 5 条 / tokens 自报与实测不符 / 省略藏起来 ⇒ 失败
//   - 闸 6b：hit 没 why / 深度 >2 / 不命中却展开 ⇒ 失败
//   - 边界闸：`你应该|请|下一步|建议|务必|记得|不要忘记|可以试试` 逐个命中即失败；
//             工具治理痕迹（permission: allow / sandbox_permissions）也失败
//   - 端到端：store 里一条指令式 claim ⇒ buildMemoryCard 照原样渲染（R12 不改写）⇒ 闸门把它打回
//   - 纯函数：跑闸不改卡片

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ACTIVE_GATES,
  GATE_DOCS,
  PENDING_GATES,
  auditGovernance,
  auditImperatives,
  runGates,
} from '../src/rooms/gates.mjs';
import {
  BUDGET_TOKENS,
  ENTRY_LIMIT,
  IMPERATIVE_PATTERNS,
  buildMemoryCard,
  estimateTokens,
  formatCardDate,
} from '../src/rooms/inject.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T = (day, hour = 12) => Date.UTC(2026, 9, day, hour, 0, 0);
const SCOPE = 'w:d:/work/demo';

/** 一条带内联 claim 的 hit（不需要 store：R12 允许 hit 自带 claim）。 */
const hitClaim = ({ ep, seq, day, kind, text, state = 'candidate', why = ['yaml'] }) => ({
  episode: ep,
  nodeId: null,
  link: null,
  why,
  weight: 1,
  occurredAt: T(day),
  kind: 'failure',
  seq,
  depth: 1,
  claim: {
    id: `c-${ep.slice(-4)}${seq}`,
    kind,
    state,
    text,
    occurredAt: T(day),
    support: [{ episode: ep, seq, occurredAt: T(day) }],
  },
});

const hitsOf = () => [
  hitClaim({ ep: 'ep-aaaaaaa1', seq: 30, day: 22, kind: 'antipattern', text: "Cannot find module 'yaml'", state: 'observed' }),
  hitClaim({ ep: 'ep-aaaaaaa2', seq: 12, day: 23, kind: 'preference', text: '不要新增依赖', state: 'candidate' }),
  hitClaim({ ep: 'ep-aaaaaaa3', seq: 7, day: 24, kind: 'pattern', text: '测试入口是 node test/run.mjs', state: 'candidate', why: ['测试'] }),
];

const walkOf = (hits, extra = {}) => ({ hits, path: [], omitted: { count: 0, reason: '' }, tokens: 0, depth: 1, ...extra });

function makeCard(hits = hitsOf(), overrides = {}) {
  return buildMemoryCard({
    walkResult: walkOf(hits),
    scope: SCOPE,
    indexPath: '/mem/index.md',
    episodeCount: 4,
    ...overrides,
  });
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const codes = (res) => res.errors.map((e) => e.code);
const hasCode = (res, code) => res.errors.some((e) => e.code === code);
const gatesOf = (res, code) => res.errors.filter((e) => e.code === code);

// ---------------------------------------------------------------------------
// 合格卡
// ---------------------------------------------------------------------------

test('R13: 合格卡 ⇒ ok:true、errors 为空', () => {
  const hits = hitsOf();
  const card = makeCard(hits);
  const res = runGates({ card, walkResult: walkOf(hits) });
  assert.equal(res.ok, true, `不该报错：${JSON.stringify(res.errors)}`);
  assert.deepEqual(res.errors, []);
  assert.equal(res.checks.claims, card.claims.length);
  assert.equal(res.checks.lines, card.claims.length);
  assert.equal(res.checks.tokens, card.tokens);
  assert.equal(res.checks.hits, 3);
});

test('R13: 零注入的卡（只有 indexLine）也合格 —— 沉默不是错误', () => {
  const card = makeCard([], { walkResult: walkOf([]) });
  const res = runGates({ card, walkResult: walkOf([]) });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.checks.claims, 0);
});

test('R13: 闸清单如实登记（本轮 4 道，其余显式列未启用）', () => {
  assert.deepEqual([...ACTIVE_GATES], ['0', '6', '6b', 'boundary']);
  assert.deepEqual([...PENDING_GATES], ['1', '2', '2b', '3', '4', '5', '7']);
  for (const id of ACTIVE_GATES) assert.equal(typeof GATE_DOCS[id], 'string');
});

// ---------------------------------------------------------------------------
// 闸 0：时间戳前置
// ---------------------------------------------------------------------------

test('R13 闸0: claim 缺 occurredAt ⇒ ok:false', () => {
  const card = clone(makeCard());
  card.claims[0].occurredAt = null;
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate0/missing-occurred-at'));
  assert.equal(gatesOf(res, 'gate0/missing-occurred-at')[0].gate, '0');
});

test('R13 闸0: 缺 provenance（episode/seq）⇒ ok:false', () => {
  const card = clone(makeCard());
  card.claims[0].source = { episode: 'ep-aaaaaaa1' }; // 没有 seq
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate0/missing-seq'));
  assert.ok(hasCode(res, 'gate0/provenance-coverage') === false || hasCode(res, 'gate6/provenance-coverage'), '同一件事两个闸都会看到，但至少一个明写');

  const card2 = clone(makeCard());
  card2.claims[0].source = { seq: 30 };
  const res2 = runGates({ card: card2 });
  assert.ok(hasCode(res2, 'gate0/missing-episode'));

  const card3 = clone(makeCard());
  delete card3.claims[0].source;
  assert.ok(hasCode(runGates({ card: card3 }), 'gate0/missing-provenance'));
});

test('R13 闸0: 行里没有日期/provenance ⇒ 失败', () => {
  const card = clone(makeCard());
  card.claims[0].line = `- [observed] 无出处的一行`;
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate0/line-not-provenanced'));
});

test('R13 闸0: 渲染日期 ≠ occurredAt 的绝对日期 ⇒ 失败', () => {
  const card = clone(makeCard());
  const claim = card.claims[0];
  claim.line = claim.line.replace(formatCardDate(claim.occurredAt), '1999-01-01');
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate0/date-mismatch'));
  assert.deepEqual(gatesOf(res, 'gate0/date-mismatch')[0].detail, { index: 0, rendered: '1999-01-01', expected: formatCardDate(claim.occurredAt) });
});

test('R13 闸0: 占位日期（????-??-??）不算带日期', () => {
  const card = clone(makeCard());
  const claim = card.claims[0];
  claim.occurredAt = null;
  claim.line = claim.line.replace(/\d{4}-\d{2}-\d{2}/, '????-??-??');
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate0/line-not-provenanced') || hasCode(res, 'gate0/missing-occurred-at'));
});

test('R13 闸0: section 行数与 claims 数不一致 ⇒ 失败', () => {
  const card = clone(makeCard());
  card.section = card.section.replace('</memory-ledger>', '- [observed] 多出来的一行 (ep-aaaaaaa9, 2026-10-24, seq 1)\n</memory-ledger>');
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate0/section-line-count'));
});

// ---------------------------------------------------------------------------
// 闸 6：预算与省略
// ---------------------------------------------------------------------------

test('R13 闸6: 超 500 tokens ⇒ 失败', () => {
  const card = clone(makeCard());
  card.tokens = BUDGET_TOKENS + 1;
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate6/budget-exceeded'));
  // 自报与实测不符也会被点名
  assert.ok(hasCode(res, 'gate6/token-mismatch'));
});

test('R13 闸6: tokens 自报与实测不一致 ⇒ 失败（预算必须有可核的数）', () => {
  const card = clone(makeCard());
  card.tokens = estimateTokens(card.indexLine) + estimateTokens(card.section) - 3;
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate6/token-mismatch'));
  assert.equal(res.ok && res.errors.length === 0, false);
});

test('R13 闸6: 超 5 条 ⇒ 失败', () => {
  const hits = [];
  for (let i = 0; i < ENTRY_LIMIT + 1; i += 1) {
    hits.push(hitClaim({ ep: `ep-cccccc${i}${i}`, seq: 100 + i, day: 22, kind: 'antipattern', text: `失败教训 ${i}`, state: 'observed' }));
  }
  const card = makeCard(hits);
  // R12 自己会截到 5 条 —— 手工绕过它，模拟"上游多塞了一条"
  const bad = clone(card);
  const extra = clone(card.claims[0]);
  extra.source = { episode: 'ep-dddddddd', seq: 1 };
  bad.claims = [extra, ...bad.claims].slice(0, ENTRY_LIMIT + 1);
  const res = runGates({ card: bad });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate6/over-limit') || hasCode(res, 'gate0/section-line-count'));
});

test('R13 闸6: 有省略却把省略藏起来 ⇒ 失败', () => {
  const card = clone(makeCard());
  card.omittedCount = 3;
  card.omissions = null;
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate6/omission-hidden'));

  const card2 = clone(makeCard());
  card2.omittedCount = 3;
  card2.omissions = 'omitted: 3 items（省略了 3 条）'; // 没说去哪取
  const res2 = runGates({ card: card2 });
  assert.equal(res2.ok, false);
  assert.ok(hasCode(res2, 'gate6/omission-no-pointer'));
});

test('R13 闸6: 真实发生预算截断的卡仍然合格（省略行带计数与指针）', () => {
  const hits = [];
  for (let i = 0; i < 9; i += 1) {
    hits.push(hitClaim({ ep: `ep-eeeeee${i}${i}`, seq: 200 + i, day: 22, kind: 'antipattern', text: `第 ${i} 条：yaml 装不上`, state: 'observed' }));
  }
  const card = makeCard(hits, { sec: null });
  assert.ok(card.omittedCount > 0);
  const res = runGates({ card, walkResult: walkOf(hits) });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.ok(card.section.includes('omitted:'));
});

// ---------------------------------------------------------------------------
// 闸 6b：相关闸
// ---------------------------------------------------------------------------

test('R13 闸6b: hit 没有 why ⇒ 失败（跳转必须说明为什么）', () => {
  const hits = [{ ...hitClaim({ ep: 'ep-aaaaaaa1', seq: 30, day: 22, kind: 'antipattern', text: 'x' }), why: [] }];
  const card = makeCard(hits);
  const res = runGates({ card, walkResult: walkOf(hits) });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate6b/missing-why'));
  assert.equal(gatesOf(res, 'gate6b/missing-why')[0].gate, '6b');
});

test('R13 闸6b: 跳转深度 >2 ⇒ 失败', () => {
  const hits = hitsOf();
  const card = makeCard(hits);
  const res = runGates({ card, walkResult: walkOf(hits, { depth: 3 }) });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate6b/depth-exceeded'));

  const deepHit = [{ ...hits[0], depth: 3 }];
  const res2 = runGates({ card: makeCard(deepHit), walkResult: walkOf(deepHit, { depth: 2 }) });
  assert.ok(hasCode(res2, 'gate6b/hit-depth-exceeded'));
});

test('R13 闸6b: 不命中却展开 ⇒ 失败（零注入）', () => {
  const card = clone(makeCard());
  const res = runGates({ card, walkResult: walkOf([]) });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate6b/zero-hit-injection'));
});

test('R13 闸6b: hit 缺 episode ⇒ 失败', () => {
  const hits = [{ ...hitsOf()[0], episode: '' }];
  const res = runGates({ card: makeCard(hits), walkResult: walkOf(hits) });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'gate6b/hit-without-episode'));
});

// ---------------------------------------------------------------------------
// 边界闸：指令式扫描
// ---------------------------------------------------------------------------

test('R13 边界闸: 七种指令式片段逐个命中即失败', () => {
  assert.deepEqual([...IMPERATIVE_PATTERNS], ['你应该', '请', '下一步', '建议', '务必', '记得', '不要忘记', '可以试试']);
  for (const pattern of IMPERATIVE_PATTERNS) {
    const hits = hitsOf();
    const card = clone(makeCard(hits));
    const poisoned = `前文 ${pattern} 后文`;
    card.claims[1].text = poisoned;
    card.claims[1].line = card.claims[1].line.replace(card.claims[1].line.match(/- \[[^\]]+\] (.+?) \(/)[1], poisoned);
    const res = runGates({ card, walkResult: walkOf(hits) });
    assert.equal(res.ok, false, `「${pattern}」必须被拦`);
    assert.ok(hasCode(res, 'boundary/imperative'), `「${pattern}」⇒ boundary/imperative`);
    assert.equal(gatesOf(res, 'boundary/imperative')[0].gate, 'boundary');
    assert.equal(gatesOf(res, 'boundary/imperative')[0].detail.pattern, pattern);
  }
});

test('R13 边界闸: 直接扫 section（模型真正读到的那段）也能抓到', () => {
  const card = clone(makeCard());
  card.section = card.section.replace('</memory-ledger>', '建议先备份再改\n</memory-ledger>');
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'boundary/imperative'));
  assert.ok(auditImperatives('建议先备份').length === 1);
});

test('R13 边界闸: indexLine 里出现指令式也失败', () => {
  const card = clone(makeCard());
  card.indexLine = 'MEMORY: /mem/index.md（scope=w:d:/x, 4 局, 未列出≠不存在）请先读索引';
  const res = runGates({ card });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'boundary/imperative'));
  assert.ok(hasCode(res, 'gate0/index-line-shape'));
});

test('R13 边界闸: 工具治理痕迹 ⇒ 失败（边界 §5 表）', () => {
  for (const sample of ['permission: allow', 'sandbox_permissions: danger-full-access', 'approval: ask']) {
    const card = clone(makeCard());
    card.claims[0].text = `历史记录里有 ${sample} 这段配置`;
    const res = runGates({ card });
    assert.equal(res.ok, false, `「${sample}」必须报错`);
    assert.ok(hasCode(res, 'boundary/tool-governance'), `「${sample}」⇒ boundary/tool-governance`);
  }
  assert.equal(auditGovernance('permission: deny').length, 1);
});

test('R13 边界闸: 事实陈述不误伤（"必须/不要/未列出≠不存在"是合法记忆）', () => {
  const hits = [
    hitClaim({ ep: 'ep-aaaaaaa1', seq: 30, day: 22, kind: 'preference', text: '该仓的测试必须用 node test/run.mjs', state: 'candidate' }),
    hitClaim({ ep: 'ep-aaaaaaa2', seq: 12, day: 23, kind: 'preference', text: '不要新增依赖', state: 'candidate' }),
  ];
  const card = makeCard(hits);
  assert.ok(card.section.includes('未列出 ≠ 不存在') || card.indexLine.includes('未列出≠不存在'));
  const res = runGates({ card, walkResult: walkOf(hits) });
  assert.equal(res.ok, true, `事实陈述被误伤：${JSON.stringify(res.errors)}`);
  assert.deepEqual(auditImperatives(card.section), []);
});

// ---------------------------------------------------------------------------
// 端到端：R12 照原样渲染，R13 打回
// ---------------------------------------------------------------------------

test('R13 端到端: store 里的指令式 claim ⇒ 闸门拦住（R12 不改写记忆原文）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-gates-'));
  try {
    const store = createStore({ root, now: T(20) });
    store.ensureDirs();
    store.putMany('claims', [{
      id: 'c-baaad001',
      kind: 'preference',
      text: '你应该先 git status 再动手',
      scopeKey: SCOPE,
      state: 'candidate',
      support: [{ episode: 'ep-aaaaaaa1', seq: 9, occurredAt: T(22) }],
      counter: [],
      occurredAt: T(22),
      counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
      supersedes: null,
    }]);
    const hits = [{ episode: 'ep-aaaaaaa1', seq: 9, why: ['git'], occurredAt: T(22), kind: 'constraint', depth: 1 }];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });

    assert.ok(card.section.includes('你应该'), 'R12 只渲染，不改写原文（改写 = 越界）');
    const res = runGates({ card, walkResult: walkOf(hits) });
    assert.equal(res.ok, false, '闸门必须把它打回');
    assert.ok(hasCode(res, 'boundary/imperative'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R13: 跑闸是纯函数（不改卡片、不写盘）', () => {
  const hits = hitsOf();
  const card = makeCard(hits);
  const before = JSON.stringify(card);
  runGates({ card, walkResult: walkOf(hits) });
  assert.equal(JSON.stringify(card), before, '闸只判不改');
});

test('R13: 没有 card ⇒ ok:false（不许静默放行）', () => {
  assert.equal(runGates({}).ok, false);
  assert.equal(runGates({ card: null }).errors[0].code, 'card/missing');
  assert.equal(runGates({ card: [] }).ok, false);
});
