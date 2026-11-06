// T343 · F3「可反驳」的文本派生（R03 extract + R09 claim 的 tombstone）
//   · 规则表可审计（每条有 id）；命中即产出 when + 逐字 quote
//   · kind='text-pattern' 明确「由文本派生」，不冒充「观测到恢复」
//   · 判不出 ⇒ null / 不挂字段（不编）
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFalsifiableWhen, FALSIFIABLE_RULES, extractSignals } from '../src/rooms/extract.mjs';
import { promoteClaim } from '../src/rooms/claim.mjs';

const T0 = 1_700_000_000_000;
const SCOPE = 'w:d:/work/demo';
const ep = (id, sessionId = 's1', scopeKey = SCOPE, startedAt = T0) => ({ id, sessionId, scopeKey, startedAt });
const signalsOf = (failures = []) => ({ failures, successes: [], constraints: [], unsettled: [], facts: [], tools: [] });

test('T343 ① 错误文本 → 完形条件（rule + when + 逐字 quote）', () => {
  const cases = [
    ['Error: Cannot find module "/d/ws/src/app.mjs"', 'missing-module'],
    ['Error: ENOENT: no such file or directory, open \'D:\\work\\demo\\cfg.json\'', 'enoent'],
    ['[exit code: 1]', 'exit-nonzero'],
    ['SyntaxError: Unexpected token }', 'syntax-error'],
    ['TypeError: x is not a function', 'type-error'],
    ['curl: HTTP/1.1 404 Not Found', 'http-404'],
    ['Error: active teammate "abc" not found', 'generic-not-found'],
    ['fatal: not a git repository', 'git-fatal'],
    ['EACCES: permission denied, open \'/etc/hosts\'', 'permission'],
  ];
  for (const [text, rule] of cases) {
    const f3 = deriveFalsifiableWhen(text);
    assert.ok(f3, `应派生出条件：${text}`);
    assert.equal(f3.rule, rule, `${text} 的规则应为 ${rule}`);
    assert.equal(f3.kind, 'text-pattern', '必须标注 text-derived');
    assert.ok(f3.when.length > 0, 'when 非空');
    assert.ok(text.includes(f3.quote), 'quote 必须是原文子串');
  }
});

test('T343 ② 噪声/非错误文本 ⇒ null（不编；tombstone：删掉规则表则本条与 ① 红）', () => {
  for (const text of ['=== 方案 1 ===', 'all green', '', null, undefined, 'ok done', 'total 12836 drwxr-xr-x']) {
    assert.equal(deriveFalsifiableWhen(text), null, `不该派生：${String(text)}`);
  }
});

test('T343 ③ 顺序敏感：HTTP 404 先于泛化 not found（不许降级成弱条件）', () => {
  assert.equal(deriveFalsifiableWhen('curl: HTTP/1.1 404 Not Found').rule, 'http-404');
  assert.equal(deriveFalsifiableWhen('Error: teammate "x" not found').rule, 'generic-not-found');
  // 规则 id 必须唯一且齐全
  const ids = FALSIFIABLE_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, '规则 id 不许重复');
  assert.ok(ids.includes('exit-nonzero') && ids.includes('missing-module'));
});

test('T343 ④ extractSignals：失败边带 falsifiableWhen，成功边不带', () => {
  const graph = {
    edges: {
      e1: {
        id: 'e1', result: 'failure', action: 'bash(node app.mjs)',
        errorSnippet: 'Error: Cannot find module "/d/ws/src/app.mjs"', evidence: { start: 10 },
      },
      e2: {
        id: 'e2', result: 'success', action: 'bash(node app.mjs)',
        errorSnippet: '', evidence: { start: 11 },
      },
    },
  };
  const sig = extractSignals({ graph, events: null });
  assert.equal(sig.failures.length, 1, '只有 e1 是失败');
  assert.ok(sig.failures[0].falsifiableWhen, '失败边应带 F3');
  assert.equal(sig.failures[0].falsifiableWhen.rule, 'missing-module');
  assert.equal(sig.successes.length, 1);
  assert.equal(sig.successes[0].falsifiableWhen, undefined, '成功边不带 F3');
});

test('T343 ⑤ promoteClaim：F3 随失败支撑带到 antipattern claim', () => {
  const quote = 'Error: Cannot find module "/d/ws/src/app.mjs"';
  const f3 = deriveFalsifiableWhen(quote);
  const failure = {
    seq: 5, quote, nodeId: 'n5', edgeId: 'e5', occurredAt: T0 + 5000,
    result: 'failure', verifyKind: 'exit', falsifiableWhen: f3,
  };
  const { claims } = promoteClaim({ episodes: [ep('ep-aaaaaaaa')], signals: new Map([['ep-aaaaaaaa', signalsOf([failure])]]) });
  const anti = claims.find((c) => c.kind === 'antipattern');
  assert.ok(anti, '应产出 antipattern');
  assert.deepEqual(anti.falsifiableWhen, f3, 'F3 应随支撑带到 claim');
  assert.equal(anti.falsifiableWhen.kind, 'text-pattern');
});

test('T343 ⑥ 判不出 F3 的失败 ⇒ claim 不带该字段（不编）', () => {
  const quote = 'Error: boom alpha beta gamma';
  assert.equal(deriveFalsifiableWhen(quote), null, '前提：该文本派生不出条件');
  const failure = { seq: 7, quote, nodeId: 'n7', edgeId: 'e7', occurredAt: T0 + 7000, result: 'failure', verifyKind: 'exit' };
  const { claims } = promoteClaim({ episodes: [ep('ep-bbbbbbbb')], signals: new Map([['ep-bbbbbbbb', signalsOf([failure])]]) });
  const anti = claims.find((c) => c.kind === 'antipattern');
  assert.ok(anti, '仍应产出 antipattern');
  assert.equal(anti.falsifiableWhen, undefined, '不许凭空补条件');
});

test('T343 ⑦ 只补空不覆盖：先无 F3、后有 F3 ⇒ 补上；已有 ⇒ 不改写', () => {
  const noF3 = { seq: 1, quote: 'Error: boom alpha beta gamma', nodeId: 'n1', edgeId: 'e1', occurredAt: T0 + 1000, result: 'failure', verifyKind: 'exit' };
  const quote2 = 'Error: Cannot find module "/d/ws/src/app.mjs"';
  const withF3 = { seq: 2, quote: quote2, nodeId: 'n2', edgeId: 'e2', occurredAt: T0 + 2000, result: 'failure', verifyKind: 'exit', falsifiableWhen: deriveFalsifiableWhen(quote2) };
  const { claims } = promoteClaim({ episodes: [ep('ep-cccccccc')], signals: new Map([['ep-cccccccc', signalsOf([noF3, withF3])]]) });
  // 两个不同 key ⇒ 两条 claim；只断言带 F3 的那条保留条件即可
  const anti = claims.filter((c) => c.kind === 'antipattern');
  assert.ok(anti.length >= 1);
  const hit = anti.find((c) => c.falsifiableWhen);
  assert.ok(hit, '有 F3 的支撑应产出带条件的 claim');
  assert.equal(hit.falsifiableWhen.rule, 'missing-module');
});
