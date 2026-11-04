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
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ACTIVE_GATES,
  GATE_DOCS,
  PENDING_GATES,
  allowedMarkersAfterDowngrade,
  allowedStates,
  auditGovernance,
  auditImperatives,
  downgradeState,
  isScopeVisible,
  normalizeScope,
  runGates,
  runValidityCheck,
} from '../src/rooms/gates.mjs';
import {
  BUDGET_TOKENS,
  ENTRY_LIMIT,
  IMPERATIVE_PATTERNS,
  buildMemoryCard,
  estimateTokens,
  formatCardDate,
} from '../src/rooms/inject.mjs';
import { adjudicate } from '../src/rooms/adjudicate.mjs';
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

const wsDirs = [];
function wsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kifuin-gates-ws-'));
  wsDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of wsDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

const clone = (x) => JSON.parse(JSON.stringify(x));
const codes = (res) => res.errors.map((e) => e.code);
const hasCode = (res, code) => res.errors.some((e) => e.code === code);
const gatesOf = (res, code) => res.errors.filter((e) => e.code === code);
/** 手改了 section 之后按 R12 的同一口径重算 tokens（否则闸 6 会抓到自报不符）。 */
const retoken = (card) => {
  card.tokens = estimateTokens(card.indexLine) + estimateTokens(card.section ?? '');
  return card;
};

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

test('R13: 闸清单如实登记（M4：十道全开，PENDING 为空）', () => {
  assert.deepEqual([...ACTIVE_GATES], ['0', '1', '2', '2b', '3', '4', '5', '6', '6b', '7', 'boundary']);
  assert.deepEqual([...PENDING_GATES], [], '十道都在位，不再有"未启用"的闸');
  for (const id of ACTIVE_GATES) assert.equal(typeof GATE_DOCS[id], 'string', `闸 ${id} 必须有判据说明`);
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

    // 2026-11-04（0.138.0）契约变更：R12 现在**按行**丢掉含祈使句的条目（而不是把整张卡送进闸门被判死）。
    // 规则不变（注入内容不许有祈使句），粒度从「卡」改成「行」—— 线上实测有一次整张卡因此没注入。
    assert.ok(!String(card.section ?? '').includes('你应该'), '含祈使句的行不许出现在卡上');
    assert.match(String(card.omissions ?? ''), /含指令式片段未纳入 1 条/, '省略必须如实记数（不许静默丢）');
    // 闸门仍然兜底：外部拼出来的卡带祈使句 ⇒ 照样打回（defense in depth）
    const forged = { section: '- [antipattern] 你应该先 git status（ep-aaaaaaa1, 2026-10-22, seq 9）', claims: [{ claimId: 'c-x' }], tokens: 20 };
    const res = runGates({ card: forged, walkResult: walkOf(hits) });
    assert.equal(res.ok, false, '闸门必须把外来卡里的祈使句打回');
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

// ===========================================================================
// M4 七闸（1 / 2 / 2b / 3 / 4 / 5 / 7）
//
// 这些闸要判"记录本身合不合规"，所以必须把条目记录喂进来（`records`）。
// 判不了时不假装合规：非 strict 记进 `checks.unverified`，strict 才当失败。
// ===========================================================================

const CLAIM_ID = 'c-aaaa0001';
const supportEntry = (episode, seq, quote = 'Error: boom') => ({ episode, seq, quote });

/** 一条结构完整的 claim 记录（可覆盖任意字段）。 */
function rec(over = {}) {
  return {
    id: CLAIM_ID,
    kind: 'fact',
    text: 'node --test 先跑本房间',
    scopeKey: SCOPE,
    state: 'candidate',
    support: [supportEntry('ep-aaaaaaa1', 30), supportEntry('ep-aaaaaaa2', 12, 'ERR yaml')],
    counter: [],
    validity: { type: 'none', value: null },
    preconditions: [],
    occurredAt: T(22),
    supersedes: null,
    ...over,
  };
}

/** 让 R12 渲染出一行引用 record.id 的卡片（source 取 record.support[0]）。 */
function cardFrom({ record = rec(), extraHits = [] } = {}) {
  const support = record.support.length ? record.support : [supportEntry('ep-aaaaaaa1', 30)];
  const first = support[0];
  const hits = [
    {
      episode: first.episode,
      why: ['yaml'],
      kind: 'failure',
      occurredAt: record.occurredAt ?? T(22),
      seq: first.seq,
      depth: 1,
      claim: {
        id: record.id,
        kind: record.kind,
        state: record.state,
        text: record.text,
        occurredAt: record.occurredAt ?? T(22),
        support: support.map((s) => ({ episode: s.episode, seq: s.seq })),
      },
    },
    ...extraHits,
  ];
  const card = buildMemoryCard({ walkResult: walkOf(hits), scope: SCOPE, indexPath: '/mem/index.md', episodeCount: 3 });
  return { card, hits, records: { claims: { [record.id]: record } } };
}

/** 跑闸的常用组合：默认带 scope + records（这样 1/2/4/5 都能真判）。 */
function runWith({ card, records, hits = null, ...rest }) {
  return runGates({ card, records, scope: SCOPE, walkResult: hits ? walkOf(hits) : undefined, ...rest });
}

// ---------------------------------------------------------------- 闸 1 作用域

test('R13 闸1: 作用域工具 —— 同域可见、u: 层可见、子看父可见、父看子不可见', () => {
  const BS = String.fromCharCode(92); // 反斜杠：用码点构造，避开源码转义在跨工具传递时被吃掉
  const winPath = `D:${BS}Work${BS}Demo${BS}`;
  assert.equal(isScopeVisible('w:d:/work/demo', 'w:d:/work/demo'), true);
  assert.equal(isScopeVisible(winPath, 'w:d:/Work/Demo'), true, '反斜杠/尾斜杠同口径（与 R00 normalizeWorkspace 一致）');
  assert.equal(isScopeVisible('u:owner', 'w:d:/work/demo'), true, '用户层跨项目可见');
  assert.equal(isScopeVisible('w:d:/work', 'w:d:/work/demo'), true, '子作用域看得到祖先');
  assert.equal(isScopeVisible('w:d:/work/demo', 'w:d:/work'), false, '父作用域看不到子（默认不可见）');
  assert.equal(isScopeVisible('w:e:/other', 'w:d:/work/demo'), false);
  assert.equal(isScopeVisible('u:owner', 'u:owner'), true);
  assert.equal(isScopeVisible('', 'w:d:/work/demo'), false);
  assert.equal(normalizeScope(winPath), 'w:d:/Work/Demo', '与 R00 同口径：只小写盘符，不动路径大小写');
  assert.equal(isScopeVisible('w:d:/Work/Demo', 'w:d:/work/demo'), false, '大小写不同 = 不同作用域（跟 R00 一致）');
});

test('R13 闸1: 同域/祖先 ⇒ 过；父看子/异域 ⇒ gate1/scope-mismatch', () => {
  const { card, records } = cardFrom({ record: rec({ scopeKey: 'w:d:/work/demo' }) });
  assert.equal(runWith({ card, records }).ok, true, JSON.stringify(runWith({ card, records }).errors));

  const child = runGates({ card, records, scope: 'w:d:/work/demo/plugin' });
  assert.equal(child.ok, true, '子作用域看得到祖先的记忆');

  const parent = runGates({ card, records, scope: 'w:d:/work' });
  assert.equal(parent.ok, false);
  assert.ok(hasCode(parent, 'gate1/scope-mismatch'));

  const other = cardFrom({ record: rec({ scopeKey: 'w:e:/other' }) });
  assert.ok(hasCode(runWith(other), 'gate1/scope-mismatch'));

  const userLayer = cardFrom({ record: rec({ scopeKey: 'u:owner' }) });
  assert.equal(runWith(userLayer).ok, true, '用户层条目在任何工作区可见');
});

test('R13 闸1: 没给 scope ⇒ unverified（不假装合规）；strict 才失败', () => {
  const { card, records } = cardFrom();
  const loose = runGates({ card, records });
  assert.equal(loose.ok, true);
  assert.ok(loose.checks.unverified.some((u) => u.code === 'gate1/scope-unknown'));
  const strictRes = runGates({ card, records, strict: true });
  assert.equal(strictRes.ok, false);
  assert.ok(hasCode(strictRes, 'gate1/scope-unknown'));
});

// ---------------------------------------------------------------- 闸 2 支撑门槛

test('R13 闸2: 状态机 —— support<2 至多 observed；=2 至多 candidate；≥3 才 standard/semantic', () => {
  assert.deepEqual(allowedStates({ support: 1 }).allowed, ['observed', 'invalidated', 'stale']);
  assert.deepEqual(allowedStates({ support: 2 }).allowed, ['observed', 'candidate', 'invalidated', 'stale']);
  assert.deepEqual(allowedStates({ support: 3 }).allowed, ['observed', 'candidate', 'semantic', 'standard', 'invalidated', 'stale']);
  assert.equal(allowedStates({ support: 2, reused: true }).allowed.includes('semantic'), true, '2 局 + 一次复用可升');
  assert.deepEqual(allowedStates({ support: 3, counter: 1 }).allowed, ['disputed'], '有反例就只剩 disputed');
  assert.deepEqual(allowedStates({ support: 3, counter: 2 }).allowed, ['invalidated'], '反例 ≥2 ⇒ invalidated');
  assert.deepEqual(allowedStates({ support: 3, strongCounter: true }).allowed, ['invalidated'], '强反例 ⇒ invalidated');
  assert.deepEqual(allowedStates({ support: 2, kind: 'joseki' }).allowed, ['candidate', 'superseded']);
});

test('R13 闸2: 正例 —— candidate/2 局、semantic/3 局、disputed/1 反例 都过', () => {
  for (const record of [
    rec({ state: 'candidate', support: [supportEntry('ep-1', 1), supportEntry('ep-2', 2)] }),
    rec({ state: 'semantic', support: [supportEntry('ep-1', 1), supportEntry('ep-2', 2), supportEntry('ep-3', 3)] }),
    rec({ state: 'disputed', counter: [supportEntry('ep-9', 9)] }),
    rec({ state: 'invalidated', counter: [supportEntry('ep-9', 9), supportEntry('ep-8', 8)] }),
    rec({ state: 'observed', support: [supportEntry('ep-1', 1)] }),
  ]) {
    const { card, records } = cardFrom({ record });
    const res = runWith({ card, records });
    assert.equal(res.ok, true, `${record.state} 应该过：${JSON.stringify(res.errors)}`);
  }
});

test('R13 闸2: 负例 —— 单局 candidate / 两局 standard / 有反例还 promoted / 反例 2 次还 disputed', () => {
  const cases = [
    rec({ state: 'candidate', support: [supportEntry('ep-1', 1)] }),
    rec({ state: 'standard', support: [supportEntry('ep-1', 1), supportEntry('ep-2', 2)] }),
    rec({ state: 'candidate', counter: [supportEntry('ep-9', 9)] }),
    rec({ state: 'disputed', counter: [supportEntry('ep-9', 9), supportEntry('ep-8', 8)] }),
  ];
  for (const record of cases) {
    const { card, records } = cardFrom({ record });
    const res = runWith({ card, records });
    assert.equal(res.ok, false, `${record.state} 应该被打回`);
    assert.ok(hasCode(res, 'gate2/state-over-claim'), `${record.state} ⇒ gate2/state-over-claim`);
  }
  const unknown = cardFrom({ record: rec({ state: 'wat' }) });
  assert.ok(hasCode(runWith(unknown), 'gate2/unknown-state'));
});

test('R13 闸2: 没有 records ⇒ 记 unverified（不假装核过）', () => {
  const { card } = cardFrom();
  const res = runGates({ card, scope: SCOPE });
  assert.equal(res.ok, true);
  assert.ok(res.checks.unverified.some((u) => u.code === 'gate2/record-unresolved'));
});

// ---------------------------------------------------------------- 闸 2b 裁决独立性

test('R13 闸2b: 合规裁决记录 ⇒ 过；共享上下文/不可回放/阈值不足/单成员 promote ⇒ 打回', () => {
  const good = adjudicate({
    target: CLAIM_ID,
    votes: [
      { member: 'm-a', verdict: 'support', contextId: 'ctx-1', evidence: [{ episode: 'ep-1', seq: 1, quote: 'q' }] },
      { member: 'm-b', verdict: 'support', contextId: 'ctx-2', evidence: [{ episode: 'ep-2', seq: 2, quote: 'q' }] },
      { member: 'm-c', verdict: 'oppose', contextId: 'ctx-3', evidence: [{ episode: 'ep-3', seq: 3, quote: 'q' }] },
    ],
    now: 1,
  });
  const { card, records } = cardFrom();
  const goodRes = runWith({ card, records, adjudications: [good] });
  assert.equal(goodRes.ok, true, JSON.stringify(goodRes.errors));

  // 共享 contextId：两票塞进同一个上下文
  const shared = {
    ...good,
    votes: [
      { member: 'm-a', verdict: 'support', contextId: 'same', evidence: [{ episode: 'ep-1', seq: 1, quote: 'q' }] },
      { member: 'm-b', verdict: 'support', contextId: 'same', evidence: [{ episode: 'ep-2', seq: 2, quote: 'q' }] },
    ],
    n: 2,
    agreement: 1,
    decision: 'promote',
    dissent: [],
  };
  const sharedRes = runWith({ card, records, adjudications: [shared] });
  assert.equal(sharedRes.ok, false);
  assert.ok(hasCode(sharedRes, 'gate2b/shared-context'));

  // 篡改一票 ⇒ 回放对不上
  const tampered = clone(good);
  tampered.votes[2].verdict = 'support';
  const tamperedRes = runWith({ card, records, adjudications: [tampered] });
  assert.equal(tamperedRes.ok, false);
  assert.ok(hasCode(tamperedRes, 'gate2b/not-replayable'));

  // 一致度不足却 promote
  const lowAgreement = clone(good);
  lowAgreement.agreement = 0.5;
  const lowRes = runWith({ card, records, adjudications: [lowAgreement] });
  assert.equal(lowRes.ok, false);
  assert.ok(hasCode(lowRes, 'gate2b/threshold-violation'));

  // 单个成员 promote（1 票不构成"多成员"）
  const single = adjudicate({
    target: CLAIM_ID,
    votes: [{ member: 'm-a', verdict: 'support', evidence: [{ episode: 'ep-1', seq: 1, quote: 'q' }] }],
  });
  const singleRes = runWith({ card, records, adjudications: [single] });
  assert.equal(singleRes.ok, false);
  assert.ok(hasCode(singleRes, 'gate2b/single-member-promote'));

  // 形态坏掉的记录
  const broken = runWith({ card, records, adjudications: [{ id: 'ad-x', target: '', votes: [] }] });
  assert.ok(hasCode(broken, 'gate2b/invalid-record'));
});

// ---------------------------------------------------------------- 闸 3 有效性/适用条件

test('R13 闸3: validity 核过 ⇒ 过；核不过却展开正文 ⇒ gate3/stale-not-marked；只给指针 ⇒ 过', () => {
  const record = rec({ validity: { type: 'file', value: 'src/rooms/gates.mjs' } });
  const { card, records } = cardFrom({ record });

  assert.equal(runWith({ card, records, validityChecks: { [CLAIM_ID]: { ok: true } } }).ok, true);

  const failed = runWith({ card, records, validityChecks: { [CLAIM_ID]: { ok: false, reason: '文件已删除' } } });
  assert.equal(failed.ok, false);
  assert.ok(hasCode(failed, 'gate3/stale-not-marked'));

  // 降级成「条件已变」的指针行 ⇒ 合规
  const pointerCard = clone(card);
  pointerCard.claims[0].kind = 'pointer';
  pointerCard.claims[0].state = 'stale';
  pointerCard.claims[0].marker = 'stale';
  pointerCard.claims[0].line = pointerCard.claims[0].line.split('[candidate]').join('[stale]');
  pointerCard.section = pointerCard.section.split('[candidate]').join('[stale]');
  retoken(pointerCard);
  const pointerRes = runWith({ card: pointerCard, records, validityChecks: { [CLAIM_ID]: { ok: false } } });
  assert.equal(pointerRes.ok, true, JSON.stringify(pointerRes.errors));
});

test('R13 闸3: 没核过 ⇒ unverified；strict 当失败（不许"没查就算过"）', () => {
  const record = rec({ validity: { type: 'commit', value: 'abc1234' } });
  const { card, records } = cardFrom({ record });
  const loose = runWith({ card, records });
  assert.equal(loose.ok, true);
  assert.ok(loose.checks.unverified.some((u) => u.code === 'gate3/validity-unchecked'));
  const strictRes = runWith({ card, records, strict: true });
  assert.equal(strictRes.ok, false);
  assert.ok(hasCode(strictRes, 'gate3/validity-unchecked'));
});

test('R13 闸3: preconditions 未满足 ⇒ 不得展开正文', () => {
  const record = rec({ preconditions: [{ check: 'file-exists', value: 'pnpm-lock.yaml', why: '依赖没变' }] });
  const { card, records } = cardFrom({ record });
  const okCheck = runWith({ card, records, preconditionChecks: { [CLAIM_ID]: { ok: true } } });
  assert.equal(okCheck.ok, true);

  const bad = runWith({ card, records, preconditionChecks: { [CLAIM_ID]: { ok: false, failed: ['file-exists'] } } });
  assert.equal(bad.ok, false);
  assert.ok(hasCode(bad, 'gate3/precondition-failed'));
  assert.deepEqual(gatesOf(bad, 'gate3/precondition-failed')[0].detail.failed, ['file-exists']);
});

// ---------------------------------------------------------------- 闸 4 只增不改

test('R13 闸4: 正常条目 ⇒ 过；被覆盖却没标 seq / 悬挂覆盖 / 覆盖了还展开正文 ⇒ 打回', () => {
  const plain = cardFrom();
  assert.equal(runWith(plain).ok, true, JSON.stringify(runWith(plain).errors));

  const noSeq = cardFrom({ record: rec({ supersededBy: 'c-bbbb0002' }) });
  const noSeqRes = runWith(noSeq);
  assert.equal(noSeqRes.ok, false);
  assert.ok(hasCode(noSeqRes, 'gate4/missing-superseded-at'));

  const dangling = cardFrom({ record: rec({ supersedes: 'c-zzzz0009' }) });
  const danglingRes = runWith(dangling);
  assert.equal(danglingRes.ok, false);
  assert.ok(hasCode(danglingRes, 'gate4/dangling-supersedes'));

  const superseded = cardFrom({ record: rec({ supersededBy: 'c-bbbb0002', supersededAtSeq: 77 }) });
  const supersededRes = runWith(superseded);
  assert.equal(supersededRes.ok, false);
  assert.ok(hasCode(supersededRes, 'gate4/superseded-rendered'));
});

test('R13 闸4: 同文两条却没有覆盖链 ⇒ gate4/unsuperseded-duplicate；补上链就过', () => {
  const text = '同一句话写了两遍';
  const base = { kind: 'fact', text, scopeKey: SCOPE, state: 'candidate', counter: [], validity: { type: 'none' }, preconditions: [], occurredAt: T(22) };
  const a = { ...base, id: 'c-dup00001', support: [supportEntry('ep-aaaaaaa1', 30, 'q1'), supportEntry('ep-aaaaaaa2', 12, 'q2')] };
  const b = { ...base, id: 'c-dup00002', support: [supportEntry('ep-aaaaaaa3', 33, 'q3'), supportEntry('ep-aaaaaaa4', 44, 'q4')] };
  const inline = (record, day) => ({
    episode: record.support[0].episode,
    why: ['yaml'],
    kind: 'failure',
    occurredAt: T(day),
    seq: record.support[0].seq,
    depth: 1,
    claim: {
      id: record.id,
      kind: 'fact',
      state: 'candidate',
      text,
      occurredAt: T(day),
      support: record.support.map((s) => ({ episode: s.episode, seq: s.seq })),
    },
  });
  const hits = [inline(a, 22), inline(b, 23)];
  const card = buildMemoryCard({ walkResult: walkOf(hits), scope: SCOPE, indexPath: '/mem/index.md', episodeCount: 4 });
  assert.equal(card.claims.length, 2);

  const dupRes = runWith({ card, records: { claims: { [a.id]: a, [b.id]: b } } });
  assert.equal(dupRes.ok, false);
  assert.ok(hasCode(dupRes, 'gate4/unsuperseded-duplicate'));

  // 补上覆盖链（新条目 supersedes 旧条目，旧条目带 supersededAtSeq）⇒ 冲突不再算"没标"
  const chained = runWith({
    card,
    records: { claims: { [a.id]: { ...a, supersededBy: b.id, supersededAtSeq: 44 }, [b.id]: { ...b, supersedes: a.id } } },
  });
  assert.equal(hasCode(chained, 'gate4/unsuperseded-duplicate'), false, '有了覆盖链就不算冲突');
});

// ---------------------------------------------------------------- 闸 5 来源纪律

test('R13 闸5: 有 quote 且对得上 support ⇒ 过；缺 quote / 对不上 / 被篡改 / 来自摘要 ⇒ 打回', () => {
  const plain = cardFrom();
  assert.equal(runWith(plain).ok, true);
  assert.equal(runWith(plain).checks.provenanceChecked, 1);

  const missingQuote = cardFrom({ record: rec({ support: [supportEntry('ep-aaaaaaa1', 30, ''), supportEntry('ep-aaaaaaa2', 12, 'q')] }) });
  assert.ok(hasCode(runWith(missingQuote), 'gate5/missing-quote'));

  const notInSupport = cardFrom();
  const offSupport = clone(notInSupport.card);
  offSupport.claims[0].source = { episode: 'ep-aaaaaaa1', seq: 77 };
  offSupport.claims[0].line = offSupport.claims[0].line.replace(/seq 30\)$/, 'seq 77)');
  offSupport.section = offSupport.section.split('seq 30)').join('seq 77)');
  retoken(offSupport);
  const notRes = runWith({ card: offSupport, records: notInSupport.records });
  assert.equal(notRes.ok, false);
  assert.ok(hasCode(notRes, 'gate5/provenance-not-in-support'));

  const tampered = cardFrom();
  tampered.card.claims[0].source.quote = '这句原文里根本没有';
  assert.ok(hasCode(runWith(tampered), 'gate5/quote-tampered'));

  const summary = cardFrom({
    record: rec({ support: [supportEntry('ep-aaaaaaa1', 30, '<compacted-summary> 摘要里抄的'), supportEntry('ep-aaaaaaa2', 12, 'q')] }),
  });
  assert.ok(hasCode(runWith(summary), 'gate5/summary-source'));
});

test('R13 闸5: 手工卡（无 claimId、无 quote）⇒ gate5/missing-quote；指针行豁免', () => {
  const { card } = cardFrom();
  const hand = clone(card);
  delete hand.claims[0].claimId;
  assert.ok(hasCode(runGates({ card: hand, scope: SCOPE }), 'gate5/missing-quote'));

  const pointer = clone(card);
  pointer.claims[0].kind = 'pointer';
  assert.equal(hasCode(runGates({ card: pointer, scope: SCOPE }), 'gate5/missing-quote'), false, '指针行不主张断言');
});

// ---------------------------------------------------------------- 闸 7 事后降级

test('R13 闸7: 本局否定一次 ⇒ candidate 必须降成 observed；两次 ⇒ invalidated', () => {
  const neg = [{ claimId: CLAIM_ID, episode: 'ep-new', seq: 5, quote: '这条不成立' }];

  const candidate = cardFrom({ record: rec({ state: 'candidate', support: [supportEntry('ep-1', 1), supportEntry('ep-2', 2)] }) });
  const notDowngraded = runWith({ card: candidate.card, records: candidate.records, evidence: neg });
  assert.equal(notDowngraded.ok, false);
  assert.ok(hasCode(notDowngraded, 'gate7/not-downgraded'));
  assert.equal(gatesOf(notDowngraded, 'gate7/not-downgraded')[0].detail.expected, 'observed');

  // 降过级的卡（state=observed，2 局支撑仍然合法）⇒ 过
  const downgraded = cardFrom({ record: rec({ state: 'observed', support: [supportEntry('ep-1', 1), supportEntry('ep-2', 2)] }) });
  assert.equal(runWith({ card: downgraded.card, records: downgraded.records, evidence: neg }).ok, true);

  // 两次否定 ⇒ 必须 invalidated；仍以 disputed 出现就算没降到位
  const disputed = cardFrom({ record: rec({ state: 'disputed', counter: [supportEntry('ep-9', 9)] }) });
  const twice = [neg[0], { ...neg[0], seq: 6 }];
  const twiceRes = runWith({ card: disputed.card, records: disputed.records, evidence: twice });
  assert.ok(hasCode(twiceRes, 'gate7/not-downgraded'));
  assert.equal(gatesOf(twiceRes, 'gate7/not-downgraded')[0].detail.expected, 'invalidated');

  const invalidated = cardFrom({ record: rec({ state: 'invalidated', counter: [supportEntry('ep-9', 9), supportEntry('ep-8', 8)] }) });
  assert.equal(runWith({ card: invalidated.card, records: invalidated.records, evidence: twice }).ok, true);
});

test('R13 闸7: downgradeState 是机械映射（standard/semantic→disputed、candidate→observed、≥2→invalidated）', () => {
  assert.equal(downgradeState('standard', 1), 'disputed');
  assert.equal(downgradeState('semantic', 1), 'disputed');
  assert.equal(downgradeState('candidate', 1), 'observed');
  assert.equal(downgradeState('disputed', 1), 'invalidated');
  assert.equal(downgradeState('observed', 1), 'observed');
  assert.equal(downgradeState('candidate', 2), 'invalidated');
  assert.equal(downgradeState('candidate', 0), 'candidate');
  assert.deepEqual(allowedMarkersAfterDowngrade('disputed'), ['disputed', 'invalidated', 'stale']);
});

// ---------------------------------------------------------------- 全量绿：所有闸同时喂满

test('R13: 十道闸同时喂满 ⇒ ok:true 且没有 unverified（判得到就真判）', () => {
  const record = rec({ validity: { type: 'version', value: '1.17.0' }, preconditions: [{ check: 'scope', value: SCOPE, why: '同域才适用' }] });
  const { card, records, hits } = cardFrom({ record });
  const adjudication = adjudicate({
    target: record.id,
    votes: [
      { member: 'm-a', verdict: 'support', contextId: 'ctx-1', evidence: [{ episode: 'ep-1', seq: 1, quote: 'q' }] },
      { member: 'm-b', verdict: 'support', contextId: 'ctx-2', evidence: [{ episode: 'ep-2', seq: 2, quote: 'q' }] },
    ],
  });
  const res = runGates({
    card,
    walkResult: walkOf(hits),
    records,
    scope: SCOPE,
    adjudications: [adjudication],
    validityChecks: { [CLAIM_ID]: { ok: true } },
    preconditionChecks: { [CLAIM_ID]: { ok: true } },
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(res.checks.unverified, [], '全都判过了，不该有 unverified');
  assert.equal(res.checks.scopeChecked, 1);
  assert.equal(res.checks.supportChecked, 1);
  assert.equal(res.checks.validityChecked, 2, 'validity + preconditions 各核一次');
  assert.equal(res.checks.immutabilityChecked, 1);
  assert.equal(res.checks.provenanceChecked, 1);
  assert.equal(res.checks.adjudications, 1);
});

// ---------------------------------------------------------------- 闸 3 真核验（T12）

test('R13 闸3: validityResults（`claims:<id>` 键）—— 核过 ⇒ 过；核不过 ⇒ 必须 stale 且只给指针', () => {
  const record = rec({ validity: { type: 'file', value: 'src/rooms/gates.mjs' } });
  const { card, records } = cardFrom({ record });

  const ok = runWith({ card, records, validityResults: { [`claims:${CLAIM_ID}`]: { ok: true, reason: null, checkedAt: T(20) } } });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.checks.validityChecked, 1, '核验结果被真用上了（不是 unverified）');
  assert.equal(ok.checks.unverified.some((u) => u.code === 'gate3/validity-unchecked'), false);

  const failed = runWith({ card, records, validityResults: { [`claims:${CLAIM_ID}`]: { ok: false, reason: 'file-missing', checkedAt: T(20) } } });
  assert.equal(failed.ok, false);
  assert.ok(hasCode(failed, 'gate3/stale-not-marked'));
  assert.equal(failed.errors.find((e) => e.code === 'gate3/stale-not-marked').detail.reason, 'file-missing');

  // 降级成 stale 指针 ⇒ 合规
  const pointerCard = clone(card);
  pointerCard.claims[0].kind = 'pointer';
  pointerCard.claims[0].state = 'stale';
  pointerCard.claims[0].marker = 'stale';
  pointerCard.claims[0].line = pointerCard.claims[0].line.split('[candidate]').join('[stale]');
  pointerCard.section = pointerCard.section.split('[candidate]').join('[stale]');
  retoken(pointerCard);
  const pointerRes = runWith({ card: pointerCard, records, validityResults: { [`claims:${CLAIM_ID}`]: { ok: false } } });
  assert.equal(pointerRes.ok, true, JSON.stringify(pointerRes.errors));

  // 降级成 stale 但还在渲染正文 ⇒ gate3/stale-rendered
  const staleBody = clone(card);
  staleBody.claims[0].state = 'stale';
  staleBody.claims[0].marker = 'stale';
  staleBody.claims[0].line = staleBody.claims[0].line.split('[candidate]').join('[stale]');
  staleBody.section = staleBody.section.split('[candidate]').join('[stale]');
  retoken(staleBody);
  const staleBodyRes = runWith({ card: staleBody, records, validityResults: { [`claims:${CLAIM_ID}`]: { ok: false } } });
  assert.equal(staleBodyRes.ok, false);
  assert.ok(hasCode(staleBodyRes, 'gate3/stale-rendered'));
});

test('R13 闸3: validityResults 认扁平键 `{<id>: …}`；只给别人的结果仍算 unverified', () => {
  const record = rec({ validity: { type: 'file', value: 'a.mjs' } });
  const { card, records } = cardFrom({ record });

  const flat = runWith({ card, records, validityResults: { [CLAIM_ID]: { ok: false } } });
  assert.equal(flat.ok, false);
  assert.ok(hasCode(flat, 'gate3/stale-not-marked'), '扁平键也要认');

  const otherOnly = runWith({ card, records, validityResults: { 'claims:c-other999': { ok: true } } });
  assert.equal(otherOnly.ok, true);
  assert.ok(otherOnly.checks.unverified.some((u) => u.code === 'gate3/validity-unchecked'), '没核到就如实记 unverified');
  assert.equal(otherOnly.checks.validityChecked, 0);
});

test('R13 闸3: 真探针端到端 —— 文件在 ⇒ 过；文件不在 ⇒ 核不过 ⇒ stale 才合规', () => {
  const ws = wsDir();
  const file = path.join(ws, 'there.txt');
  writeFileSync(file, 'x');
  // 用绝对路径做 value：记录的 scopeKey 仍是卡片的 SCOPE（闸 1 才过），核验与作用域互不牵连
  const baseRecord = rec({ validity: { type: 'file', value: file, sha256: createHash('sha256').update('x').digest('hex') } });
  const okCheck = runValidityCheck({ records: { claims: [baseRecord] }, workspace: ws, now: T(20) });
  assert.equal(okCheck.results[`claims:${CLAIM_ID}`].ok, true);

  const okCard = cardFrom({ record: baseRecord });
  const okRes = runWith({ card: okCard.card, records: okCard.records, validityResults: okCheck.results });
  assert.equal(okRes.ok, true, JSON.stringify(okRes.errors));
  assert.equal(okRes.checks.validityChecked, 1);

  // 文件内容变了（hash 对不上）⇒ 核不过 ⇒ 必须 stale
  writeFileSync(file, 'changed');
  const badCheck = runValidityCheck({ records: { claims: [baseRecord] }, workspace: ws, now: T(20) });
  assert.equal(badCheck.results[`claims:${CLAIM_ID}`].ok, false);
  assert.equal(badCheck.results[`claims:${CLAIM_ID}`].reason, 'file-hash-changed');
  const badRes = runWith({ card: okCard.card, records: okCard.records, validityResults: badCheck.results });
  assert.equal(badRes.ok, false);
  assert.ok(hasCode(badRes, 'gate3/stale-not-marked'));
});

// ---------------------------------------------------------------- 闸 4 去重（T155）

test('R13 闸4 T155: 同一 id 渲染两次 ⇒ 不判"未标 supersedes 的重复"', () => {
  const record = rec({ text: '同一条断言（同一 id 两个出处）', state: 'observed' });
  const { card, records } = cardFrom({ record });

  // 修复前的 R12 产物：同一行出现两次（同一个 claimId、同一段文字）
  const dup = clone(card);
  dup.claims.push(clone(dup.claims[0]));
  dup.section = dup.section.replace('</memory-ledger>', `${dup.claims[0].line}\n</memory-ledger>`);
  retoken(dup);

  const res = runWith({ card: dup, records });
  assert.equal(res.ok, true, `同一 id 不该判重复：${JSON.stringify(res.errors)}`);
  assert.equal(res.errors.some((e) => e.code === 'gate4/unsuperseded-duplicate'), false);
});

test('R13 闸4 T155: 两个**不同** id 同文且无 supersedes ⇒ 仍然 gate4/unsuperseded-duplicate（且 detail.ids 去重）', () => {
  const a = rec({ id: 'c-aaaa0001', text: '同一段文字，两条不同 claim', state: 'observed' });
  const b = rec({ id: 'c-aaaa0002', text: '同一段文字，两条不同 claim', state: 'observed' });
  const { card, records } = cardFrom({ record: a });
  records.claims[b.id] = b;

  const two = clone(card);
  const rowB = { ...clone(two.claims[0]), claimId: b.id };
  two.claims.push(rowB);
  two.section = two.section.replace('</memory-ledger>', `${rowB.line}\n</memory-ledger>`);
  retoken(two);

  const res = runWith({ card: two, records });
  assert.equal(res.ok, false, '不同 id 同文仍必须报重复');
  const err = res.errors.find((e) => e.code === 'gate4/unsuperseded-duplicate');
  assert.ok(err, '应当报 gate4/unsuperseded-duplicate');
  assert.deepEqual([...err.detail.ids].sort(), ['c-aaaa0001', 'c-aaaa0002']);
  assert.equal(new Set(err.detail.ids).size, err.detail.ids.length, 'detail.ids 必须是去重后的唯一 id 列表');
});

test('R13 闸4 T155: [A, A, B] 同文 ⇒ 报重复，detail.ids 只有 A、B 两个', () => {
  const a = rec({ id: 'c-bbbb0001', text: '同文三行', state: 'observed' });
  const b = rec({ id: 'c-bbbb0002', text: '同文三行', state: 'observed' });
  const { card, records } = cardFrom({ record: a });
  records.claims[b.id] = b;

  const three = clone(card);
  three.claims.push(clone(three.claims[0])); // A 出现两次
  three.claims.push({ ...clone(three.claims[0]), claimId: b.id }); // 再加一条 B
  three.section = three.section.replace('</memory-ledger>', `${three.claims[0].line}\n${three.claims[0].line}\n${three.claims[0].line}\n</memory-ledger>`);
  retoken(three);

  const res = runWith({ card: three, records });
  assert.equal(res.ok, false);
  const err = res.errors.find((e) => e.code === 'gate4/unsuperseded-duplicate');
  assert.ok(err);
  assert.deepEqual([...err.detail.ids].sort(), ['c-bbbb0001', 'c-bbbb0002']);
  assert.equal(err.detail.ids.length, 2, '同一 id 出现两次只该计一次');
});

// ===========================================================================
// T158 · 闸 3 探针：file 的方向位 + version 的「读不到 ≠ 失效」
// ===========================================================================

test('T158a: expect:"missing" —— 文件仍不存在 ⇒ ok；文件出现 ⇒ file-appeared（stale）', () => {
  const ws = wsDir();
  const file = path.join(ws, 'gone.txt'); // 一开始就不存在
  const record = rec({ validity: { type: 'file', value: file, expect: 'missing' } });

  const okCheck = runValidityCheck({ records: { claims: [record] }, workspace: ws, now: T(20) });
  const okResult = okCheck.results[`claims:${CLAIM_ID}`];
  assert.equal(okResult.ok, true, '仍不存在 = 证据成立');
  assert.equal(okResult.exists, false);
  assert.equal(okResult.expect, 'missing');

  const okCard = cardFrom({ record });
  assert.equal(runWith({ card: okCard.card, records: okCard.records, validityResults: okCheck.results }).ok, true);

  writeFileSync(file, 'appeared'); // 文件出现 ⇒ 该记忆失效
  const appeared = runValidityCheck({ records: { claims: [record] }, workspace: ws, now: T(20) });
  const appearedResult = appeared.results[`claims:${CLAIM_ID}`];
  assert.equal(appearedResult.ok, false);
  assert.equal(appearedResult.reason, 'file-appeared');
  assert.equal(appearedResult.unverified, undefined, '这是真失效，不是"核不了"');
  const badRes = runWith({ card: okCard.card, records: okCard.records, validityResults: appeared.results });
  assert.equal(badRes.ok, false);
  assert.ok(hasCode(badRes, 'gate3/stale-not-marked'));
});

test('T158a: 缺省 expect 仍是 exists 语义（向后兼容）；旧记录靠 file-exists 前置条件推断 missing', () => {
  const ws = wsDir();
  const missing = path.join(ws, 'nope.txt');

  // 没有 expect、也没有 ENOENT 标记 ⇒ 默认 exists ⇒ 文件不在 = file-missing（旧行为不变）
  const plain = rec({ validity: { type: 'file', value: missing } });
  const plainCheck = runValidityCheck({ records: { claims: [plain] }, workspace: ws, now: T(20) });
  assert.equal(plainCheck.results[`claims:${CLAIM_ID}`].ok, false);
  assert.equal(plainCheck.results[`claims:${CLAIM_ID}`].reason, 'file-missing');
  assert.equal(plainCheck.results[`claims:${CLAIM_ID}`].expect, 'exists');

  // 旧记录（无 expect）+ claim.mjs 的 ENOENT 标记（file-exists 同路径）⇒ 推断 missing ⇒ 不存在 = ok
  const legacy = rec({
    validity: { type: 'file', value: missing },
    preconditions: [{ check: 'file-exists', value: missing, why: '该条记录的是证据时刻「此路径不存在」' }],
  });
  const legacyCheck = runValidityCheck({ records: { claims: [legacy] }, workspace: ws, now: T(20) });
  assert.equal(legacyCheck.results[`claims:${CLAIM_ID}`].expect, 'missing', '旧记录按 ENOENT 标记推断方向位');
  assert.equal(legacyCheck.results[`claims:${CLAIM_ID}`].ok, true);

  // 显式 expect 优先于推断
  const explicit = rec({
    validity: { type: 'file', value: missing, expect: 'exists' },
    preconditions: [{ check: 'file-exists', value: missing, why: 'fixture' }],
  });
  assert.equal(runValidityCheck({ records: { claims: [explicit] }, workspace: ws, now: T(20) }).results[`claims:${CLAIM_ID}`].reason, 'file-missing');
});

test('T158a: 非法 expect 值 ⇒ file-bad-expect（判红，不静默降级）', () => {
  const ws = wsDir();
  const record = rec({ validity: { type: 'file', value: path.join(ws, 'x.txt'), expect: 'sometimes' } });
  const check = runValidityCheck({ records: { claims: [record] }, workspace: ws, now: T(20) });
  assert.equal(check.results[`claims:${CLAIM_ID}`].ok, false);
  assert.equal(check.results[`claims:${CLAIM_ID}`].reason, 'file-bad-expect');
  const card = cardFrom({ record });
  const res = runWith({ card: card.card, records: card.records, validityResults: check.results });
  assert.ok(hasCode(res, 'gate3/stale-not-marked'), '坏记录照样挡注入');
});

test('T158b: version 读不到包 ⇒ unverified（不是 stale），summary 分开记数', () => {
  const ws = wsDir(); // 空工作区：一个 package.json 都没有
  const record = rec({ validity: { type: 'version', value: 'no-such-pkg-xyz@1.0.0' } });
  const check = runValidityCheck({ records: { claims: [record] }, workspace: ws, now: T(20), dshHome: path.join(ws, 'no-home') });
  const result = check.results[`claims:${CLAIM_ID}`];
  assert.equal(result.ok, false);
  assert.equal(result.unverified, true, '核不了 ≠ 失效');
  assert.equal(result.reason, 'version-file-unreadable');
  assert.equal(check.summary.unverified, 1);
  assert.equal(check.summary.failed, 0, 'unverified 不混进 failed');

  // 闸 3：不判红，但要如实记 unverified
  const card = cardFrom({ record });
  const res = runWith({ card: card.card, records: card.records, validityResults: check.results });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.ok(res.checks.unverified.some((u) => u.code === 'gate3/validity-unverified'), 'unverified 要有账');
  assert.equal(hasCode(res, 'gate3/stale-not-marked'), false);
});

test('T158b: version 查找面放宽到 <DSH_HOME>/profiles/*/node_modules/<name>/package.json', () => {
  const ws = wsDir();
  const home = path.join(ws, 'home');
  const pkgDir = path.join(home, 'profiles', 'desktop', 'node_modules', '@scope', 'pkg');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '2.0.0' }));

  const same = rec({ validity: { type: 'version', value: '@scope/pkg@2.0.0' } });
  const sameCheck = runValidityCheck({ records: { claims: [same] }, workspace: ws, now: T(20), dshHome: home });
  assert.equal(sameCheck.results[`claims:${CLAIM_ID}`].ok, true, 'profiles 里读到且版本一致');
  assert.equal(sameCheck.results[`claims:${CLAIM_ID}`].package, '@scope/pkg');

  const changed = rec({ validity: { type: 'version', value: '@scope/pkg@1.0.0' } });
  const changedCheck = runValidityCheck({ records: { claims: [changed] }, workspace: ws, now: T(20), dshHome: home });
  assert.equal(changedCheck.results[`claims:${CLAIM_ID}`].ok, false);
  assert.equal(changedCheck.results[`claims:${CLAIM_ID}`].reason, 'version-mismatch', '真读到且版本不符 ⇒ stale');
  assert.equal(changedCheck.summary.failed, 1);
});

test('T158b: version 查找面兜底到 <DSH_HOME>/profiles/*/workspace/package.json', () => {
  const ws = wsDir();
  const home = path.join(ws, 'home');
  const wsDirInProfile = path.join(home, 'profiles', 'desktop', 'workspace');
  mkdirSync(wsDirInProfile, { recursive: true });
  writeFileSync(path.join(wsDirInProfile, 'package.json'), JSON.stringify({ name: 'workspace-pkg', version: '3.1.4' }));

  const record = rec({ validity: { type: 'version', value: 'workspace-pkg@3.1.4' } });
  const check = runValidityCheck({ records: { claims: [record] }, workspace: ws, now: T(20), dshHome: home });
  assert.equal(check.results[`claims:${CLAIM_ID}`].ok, true);
});

test('T158b: 读过但同名包不存在 ⇒ unverified（不是 version-mismatch）', () => {
  const ws = wsDir();
  writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'other-pkg', version: '9.9.9' }));
  // 让记录自己的 scopeKey 指向这个临时工作区（probe 按记录自己的作用域核）
  const record = rec({ scopeKey: 'w:' + ws.split(path.sep).join('/'), validity: { type: 'version', value: 'wanted-pkg@1.0.0' } });
  const check = runValidityCheck({ records: { claims: [record] }, workspace: ws, now: T(20), dshHome: path.join(ws, 'no-home') });
  const result = check.results[`claims:${CLAIM_ID}`];
  assert.equal(result.ok, false);
  assert.equal(result.unverified, true);
  assert.equal(result.reason, 'version-package-not-found');
  assert.equal(check.summary.failed, 0);
});
