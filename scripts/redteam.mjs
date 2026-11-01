#!/usr/bin/env node
// M5 负迁移防线演练：把"坏记忆"逐条喂给 R12/R13，验证闸门确实拦住（而不是靠语料运气好）。
// 只读/纯函数，零模型调用；退出码 0 = 全部被拦住。
import { buildMemoryCard, estimateTokens } from '../src/rooms/inject.mjs';
import { runGates } from '../src/rooms/gates.mjs';

const T = (d, h = 12) => Date.UTC(2026, 9, d, h);
const SCOPE = 'w:d:/work/demo';
const hit = (over = {}) => ({
  episode: 'ep-aaaaaaa1', nodeId: null, link: null, why: ['yaml'], weight: 1,
  occurredAt: T(22), kind: 'failure', seq: 30, depth: 1,
  claim: {
    id: 'c-demo1', kind: 'antipattern', state: 'observed', text: "Cannot find module 'yaml'",
    occurredAt: T(22), scopeKey: SCOPE,
    support: [{ episode: 'ep-aaaaaaa1', seq: 30, occurredAt: T(22), quote: "Cannot find module 'yaml'" }],
    ...over.claim,
  },
  ...over,
});
const cardOf = (hits = [hit()]) => buildMemoryCard({ walkResult: { hits, path: [], omitted: { count: 0, reason: '' }, tokens: 0, depth: 1 }, scope: SCOPE, indexPath: '/mem/index.md', episodeCount: 1 });
const recordsOf = (claimOver = {}) => {
  const c = { id: 'c-demo1', kind: 'antipattern', state: 'observed', text: "Cannot find module 'yaml'", scopeKey: SCOPE, occurredAt: T(22), support: [{ episode: 'ep-aaaaaaa1', seq: 30, quote: "Cannot find module 'yaml'" }], counter: [], validity: { type: 'none', value: null }, ...claimOver };
  return { claims: { 'c-demo1': c }, episodes: { 'ep-aaaaaaa1': { id: 'ep-aaaaaaa1', scopeKey: SCOPE } } };
};
const retoken = (card) => { card.tokens = estimateTokens(card.indexLine) + estimateTokens(card.section ?? ''); return card; };
const codes = (r) => r.errors.map((e) => e.code);
const first = (r, prefix) => codes(r).find((c) => c.startsWith(prefix)) ?? null;

const cases = [];
const run = (name, expect, fn) => {
  let result;
  try { result = fn(); } catch (error) { cases.push({ name, expect, got: `throw:${error?.message}`, ok: false }); return; }
  const code = first(result, expect.split('/')[0]);
  const match = code === expect || (expect.endsWith('/') && typeof code === 'string' && code.startsWith(expect));
  cases.push({ name, expect, got: code ?? (result.ok ? 'PASS(leak)' : codes(result).join(',')), ok: match });
};

// 0. 基线：合格卡必须过
run('baseline（合格卡）', 'GATE0_PASS', () => {
  const r = runGates({ card: cardOf(), walkResult: { hits: [hit()], path: [], depth: 1 }, records: recordsOf(), scope: SCOPE });
  return { ok: r.ok, errors: r.ok ? [{ code: 'GATE0_PASS' }] : r.errors };
});
// 1. 闸 0：缺 occurredAt
run('缺时间戳', 'gate0/missing-occurred-at', () => {
  const card = cardOf(); delete card.claims[0].occurredAt;
  return runGates({ card, walkResult: { hits: [hit()], path: [], depth: 1 }, records: recordsOf(), scope: SCOPE });
});
// 2. 闸 0：日期与 occurredAt 不符
run('日期被改', 'gate0/date-mismatch', () => {
  const card = cardOf(); card.claims[0].occurredAt = T(25);
  return runGates({ card, walkResult: { hits: [hit()], path: [], depth: 1 }, records: recordsOf(), scope: SCOPE });
});
// 3. 闸 1：跨作用域
run('跨作用域条目', 'gate1/scope-mismatch', () => {
  const card = cardOf();
  return runGates({ card, walkResult: { hits: [hit()], path: [], depth: 1 }, records: recordsOf({ scopeKey: 'w:d:/other' }), scope: SCOPE });
});
// 4. 闸 2：candidate 只 1 条支撑
run('支撑不足却标 candidate', 'gate2/state-over-claim', () => {
  const rec = recordsOf({ state: 'candidate', support: [{ episode: 'ep-aaaaaaa1', seq: 30, quote: "Cannot find module 'yaml'" }] });
  const h2 = hit(); h2.claim.state = 'candidate';
  const card = cardOf([h2]);
  return runGates({ card, walkResult: { hits: [h2], path: [], depth: 1 }, records: rec, scope: SCOPE });
});
// 5. 闸 3：validity 核不过却没降级
run('过期记忆未标 stale', 'gate3/stale-not-marked', () => {
  const rec = recordsOf({ validity: { type: 'file', value: 'src/nope.mjs' } });
  const card = cardOf();
  return runGates({ card, walkResult: { hits: [hit()], path: [], depth: 1 }, records: rec, scope: SCOPE, validityResults: { 'claims:c-demo1': { ok: false, reason: 'file-missing' } } });
});
// 6. 闸 4：被覆盖条目仍按正文渲染
run('已覆盖仍渲染', 'gate4/', () => {
  const rec = recordsOf({ supersedes: 'c-old', supersededBy: 'c-new', state: 'observed' });
  const card = cardOf();
  return runGates({ card, walkResult: { hits: [hit()], path: [], depth: 1 }, records: rec, scope: SCOPE });
});
// 7. 闸 5：quote 缺失
run('无原文引用', 'gate5/missing-quote', () => {
  const rec = recordsOf({ support: [{ episode: 'ep-aaaaaaa1', seq: 30 }] });
  const card = cardOf();
  return runGates({ card, walkResult: { hits: [hit()], path: [], depth: 1 }, records: rec, scope: SCOPE });
});
// 8. 闸 5：摘要当源
run('摘要当源', 'gate5/summary-source', () => {
  const rec = recordsOf({ support: [{ episode: 'ep-aaaaaaa1', seq: 30, quote: '<compacted-summary> 摘要内容' }] });
  const card = cardOf();
  return runGates({ card, walkResult: { hits: [hit()], path: [], depth: 1 }, records: rec, scope: SCOPE });
});
// 9. 边界：祈使句
run('祈使句', 'boundary/imperative', () => {
  const card = cardOf();
  card.section = card.section.replace(/- \[[a-z]+\] .*?\(/, '- [antipattern] 你应该先运行测试 (');
  retoken(card);
  return runGates({ card, walkResult: { hits: [hit()], path: [], depth: 1 }, records: recordsOf(), scope: SCOPE });
});
// 10. 闸 6：超预算
run('超预算', 'gate6/budget-exceeded', () => {
  const card = cardOf();
  return runGates({ card, walkResult: { hits: [hit()], path: [], depth: 1 }, records: recordsOf(), scope: SCOPE, budgetTokens: 1 });
});

const bad = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ cases, total: cases.length, blocked: cases.length - bad.length, leaked: bad.length }, null, 2));
process.exitCode = bad.length === 0 ? 0 : 1;
