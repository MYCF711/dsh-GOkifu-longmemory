// R09 claim 的 tombstone test：删掉 src/rooms/claim.mjs ⇒ 本文件整片红。
//
// 覆盖（契约 AGENTS §4.8 / 方案 §4.8、§5.1、§5.2、§5.3、§4.10）：
//   - 失败边 → antipattern（按归一的错误原文归并；support≥2 且独立 ⇒ candidate，否则 observed）
//   - 用户约束句 → preference（逐字 quote，保留 hard/soft）
//   - ENOENT 类失败 → fact + validity{type:"file"}（读侧能机械核）
//   - 动作原文里字面写着的版本 → fact + validity{type:"version"}
//   - 无 quote / 无 seq ⇒ 不产出（无源不入）；每条都带 occurredAt 与 support.quote
//   - 反例优先：更晚的成功边触到同一路径 ⇒ 文件事实记 counter、不升 candidate
//   - 跨 ≥2 工作区独立印证 ⇒ 升 u:<user> 层（方案 §4.10）
//   - 计数不是打分：counters 只记可数事实，没有分数字段；纯函数同输入同输出

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  promoteClaim,
  errorKeyOf,
  classifyErrorClass,
  ERROR_CLASS_NAMES,
  extractPaths,
  extractVersionLiterals,
  ClaimError,
} from '../src/rooms/claim.mjs';

const T0 = 1_700_000_000_000;
const SCOPE = 'w:d:/work/demo';
const OTHER = 'w:e:/other/ws';

const ep = (id, sessionId, scopeKey = SCOPE, startedAt = T0) => ({ id, sessionId, scopeKey, startedAt });
const failure = (seq, quote, at = T0 + seq * 1000) => ({
  seq, quote, nodeId: `n${seq}`, edgeId: `e${seq}`, occurredAt: at, result: 'failure', verifyKind: 'exit',
});
const success = (seq, quote, at = T0 + seq * 1000) => ({
  seq, quote, nodeId: `n${seq}`, edgeId: `e${seq}`, occurredAt: at, result: 'success', verifyKind: 'exit',
});
const constraint = (seq, quote, level = 'hard', at = T0 + seq * 1000) => ({
  seq, quote, level, matched: ['不要'], nodeId: null, edgeId: null, occurredAt: at,
});
const signalsOf = ({ failures = [], successes = [], constraints = [], unsettled = [], facts = [], tools = [] } = {}) => ({
  failures, successes, constraints, unsettled, facts, tools,
});

const YAML_ERROR = "Error: Cannot find module 'yaml'";
const PREF = '不要新增依赖。';
const CFG_ENOENT = "Error: ENOENT: no such file or directory, open 'D:\\work\\demo\\cfg.json'";

function fixture() {
  const episodes = [
    ep('ep-aaaaaaaa', 'session-a'),
    ep('ep-bbbbbbbb', 'session-b', SCOPE, T0 + 100_000),
    ep('ep-cccccccc', 'session-c', SCOPE, T0 + 200_000),
    ep('ep-dddddddd', 'session-d', OTHER, T0 + 300_000),
  ];
  const signals = new Map([
    ['ep-aaaaaaaa', signalsOf({
      failures: [failure(30, YAML_ERROR)],
      constraints: [constraint(5, PREF)],
      successes: [success(40, 'bash(command=pnpm add yaml@2.4.1)')],
    })],
    ['ep-bbbbbbbb', signalsOf({
      failures: [failure(12, YAML_ERROR)],
      constraints: [constraint(3, PREF)],
      successes: [success(8, 'read(file_path=d:/work/demo/out.txt)')],
    })],
    ['ep-cccccccc', signalsOf({ failures: [failure(7, CFG_ENOENT)] })],
    ['ep-dddddddd', signalsOf({ constraints: [constraint(2, PREF)] })],
  ]);
  return { episodes, signals };
}

const find = (claims, pred) => claims.filter(pred);

test('R09: 失败边 → antipattern（support≥2 独立局 ⇒ candidate，text 逐字）', () => {
  const { episodes, signals } = fixture();
  const { claims, stats } = promoteClaim({ episodes, signals });

  const anti = find(claims, (c) => c.kind === 'antipattern' && c.text.includes('Cannot find module'));
  assert.equal(anti.length, 1, '同一归一错误原文只成一条');
  const c = anti[0];
  assert.match(c.id, /^c-[0-9a-f]{8}$/);
  assert.equal(c.state, 'candidate', '2 局独立支撑 ⇒ candidate');
  // 2026-11-02 审计 P1-2：类级映射的 claim 文本必须带 `class:<name> · ` 前缀
  assert.ok(c.text.endsWith(YAML_ERROR), 'text 以最早支撑局的错误原文结尾（逐字）');
  {
    const key = String(errorKeyOf(c.text));
    if (key.startsWith('class:')) assert.ok(c.text.startsWith(key), `命中错误类时正文必须以 ${key} 开头`);
  }
  assert.deepEqual(c.support.map((s) => s.episode), ['ep-aaaaaaaa', 'ep-bbbbbbbb']);
  assert.equal(c.counters.support, 2);
  assert.equal(c.counters.counter, 0);
  assert.equal(c.validity.type, 'none');
  assert.equal(c.scopeKey, SCOPE);
  assert.equal(c.occurredAt, T0 + 12_000, 'occurredAt = 最早支撑证据的发生时间');
  assert.equal(c.recordedAt, null, 'recordedAt 只取入参 now');
  assert.equal(c.supersedes, null);
  assert.deepEqual(c.threadIds, []);
  assert.equal(c.validFrom, c.occurredAt, 'validFrom = occurredAt（2026-11-02 审计 P1-1 落地）');
  assert.equal(c.validTo, null);
  for (const s of c.support) {
    assert.ok(s.quote.length > 0, 'support 必须带 quote（无 quote 不产出）');
    assert.ok(Number.isFinite(s.seq));
    assert.ok(s.edgeId, 'edgeId 回指棋谱边（动作侧证据）');
    assert.ok(Number.isFinite(s.occurredAt));
    assert.equal(s.threadId, null);
  }
  assert.ok(stats.byState.candidate >= 1);
});

test('R09: 单局失败只到 observed（support=1 不升 candidate）', () => {
  const { claims } = promoteClaim({
    episodes: [ep('ep-cccccccc', 'session-c')],
    signals: new Map([['ep-cccccccc', signalsOf({ failures: [failure(7, CFG_ENOENT)] })]]),
  });
  const anti = find(claims, (c) => c.kind === 'antipattern');
  assert.equal(anti.length, 1);
  assert.equal(anti[0].state, 'observed');
  assert.equal(anti[0].counters.support, 1);
});

test('R09: 用户约束句 → preference（逐字、保留 hard/soft、跨工作区升 u: 层）', () => {
  const { episodes, signals } = fixture();
  const { claims, stats } = promoteClaim({ episodes, signals });

  const prefs = find(claims, (c) => c.kind === 'preference');
  assert.equal(prefs.length, 1, '同一句话跨作用域合并成一条');
  const p = prefs[0];
  assert.equal(p.text, PREF, 'text = 用户原话（逐字）');
  assert.equal(p.level, 'hard');
  assert.deepEqual(p.support.map((s) => s.episode), ['ep-aaaaaaaa', 'ep-bbbbbbbb', 'ep-dddddddd']);
  assert.equal(p.state, 'candidate');
  assert.equal(p.scopeKey, 'u:owner', '跨 ≥2 工作区独立印证 ⇒ 用户层（方案 §4.10）');
  assert.ok(p.preconditions.some((x) => x.check === 'scope' && x.value === 'u:owner'));
  assert.equal(p.validity.type, 'none');
  assert.equal(stats.promotedToUser, 1);
});

test('R09: 跨作用域合并可关闭 ⇒ 每个 w: 层各自成条', () => {
  const { episodes, signals } = fixture();
  const { claims } = promoteClaim({ episodes, signals, options: { crossScopePromotion: false } });
  const prefs = find(claims, (c) => c.kind === 'preference');
  assert.equal(prefs.length, 2, 'demo 一条、other 一条');
  assert.deepEqual(new Set(prefs.map((p) => p.scopeKey)), new Set([SCOPE, OTHER]));
});

test('R09: ENOENT 失败 → fact + validity{type:"file"}（preconditions 可核）', () => {
  const { episodes, signals } = fixture();
  const { claims } = promoteClaim({ episodes, signals });
  const facts = find(claims, (c) => c.kind === 'fact' && c.validity.type === 'file');
  assert.equal(facts.length, 1);
  const f = facts[0];
  assert.equal(f.validity.value, 'd:/work/demo/cfg.json', '路径归一（小写盘符、正斜杠）');
  assert.equal(f.state, 'observed', '单局证据只到 observed');
  assert.equal(f.preconditions[0].check, 'file-exists');
  assert.equal(f.preconditions[0].value, 'd:/work/demo/cfg.json');
  // T158a：ENOENT 派生的 fact 语义是「此刻该路径不存在」⇒ 方向位必须写 missing
  assert.equal(f.validity.expect, 'missing', 'file 的方向位 = missing（文件出现才 stale）');
  assert.match(f.text, /ENOENT/);
  assert.ok(f.support[0].quote.includes('cfg.json'));
});

test('R09: 动作原文里字面写着版本 → fact + validity{type:"version"}', () => {
  const { episodes, signals } = fixture();
  const { claims } = promoteClaim({ episodes, signals });
  const facts = find(claims, (c) => c.kind === 'fact' && c.validity.type === 'version');
  assert.equal(facts.length, 1);
  const f = facts[0];
  assert.equal(f.validity.value, 'yaml@2.4.1');
  assert.equal(f.text, 'yaml@2.4.1', 'text 是原文里的字面片段，不做推断');
  assert.equal(f.counters.support, 1);
});

test('R09: 反例优先 —— 更晚的成功边触到同一路径 ⇒ 文件事实记 counter、不升 candidate', () => {
  const episodes = [
    ep('ep-aaaaaaaa', 'session-a'),
    ep('ep-bbbbbbbb', 'session-b', SCOPE, T0 + 100_000),
    ep('ep-eeeeeeee', 'session-e', SCOPE, T0 + 500_000),
  ];
  const signals = new Map([
    ['ep-aaaaaaaa', signalsOf({ failures: [failure(7, CFG_ENOENT)] })],
    ['ep-bbbbbbbb', signalsOf({ failures: [failure(9, CFG_ENOENT)] })],
    ['ep-eeeeeeee', signalsOf({ successes: [success(3, 'write(file_path=D:/work/demo/cfg.json content=x)', T0 + 500_000)] })],
  ]);
  const { claims, stats } = promoteClaim({ episodes, signals });
  const fact = find(claims, (c) => c.kind === 'fact' && c.validity.type === 'file')[0];
  assert.equal(fact.counters.support, 2, '两局独立支撑');
  assert.equal(fact.counters.counter, 1, '更晚的成功边说明该路径已出现');
  assert.equal(fact.state, 'observed', '有反例不升 candidate（反例优先，方案 §5.2）');
  assert.equal(fact.counter[0].episode, 'ep-eeeeeeee');
  assert.equal(stats.withCounter, 1);
});

test('R09: 合成失败标记（exit code 1）不构成 antipattern（只说失败、不说错在哪）', () => {
  const episodes = [ep('ep-aaaaaaaa', 'session-a'), ep('ep-bbbbbbbb', 'session-b', SCOPE, T0 + 1000)];
  const signals = new Map([
    ['ep-aaaaaaaa', signalsOf({ failures: [failure(3, '(no output) [exit code: 1]')] })],
    ['ep-bbbbbbbb', signalsOf({ failures: [failure(4, '[exit code: 1]')] })],
  ]);
  const { claims, stats } = promoteClaim({ episodes, signals });
  assert.deepEqual(claims, [], '「退出码 1」不是反模式');
  assert.equal(stats.dropped.generic, 2);
});

test('R09: 无 quote / 无 seq ⇒ 不产出（无源不入）', () => {
  const { claims, stats } = promoteClaim({
    episodes: [ep('ep-aaaaaaaa', 'session-a')],
    signals: new Map([['ep-aaaaaaaa', signalsOf({
      failures: [{ seq: 1, quote: '   ', occurredAt: T0 }],
      constraints: [constraint(2, ''), { seq: null, quote: '不要动 D:\\keys。', level: 'hard', occurredAt: T0 }],
    })]]),
  });
  assert.deepEqual(claims, []);
  assert.equal(stats.dropped.noQuote, 2);
  assert.equal(stats.dropped.noSeq, 1);
});

test('R09: 计数不是打分 —— 没有分数字段；counters 只有可数事实', () => {
  const { episodes, signals } = fixture();
  const { claims } = promoteClaim({ episodes, signals });
  assert.ok(claims.length > 0);
  for (const c of claims) {
    assert.deepEqual(Object.keys(c).filter((k) => /score|rank|rating|confidence/i.test(k)), []);
    assert.deepEqual(Object.keys(c.counters).sort(), ['counter', 'injections', 'lastInjectedAt', 'support']);
    assert.ok(Number.isFinite(c.occurredAt), 'occurredAt 必填（无时不入）');
    assert.ok(c.text.length > 0 && c.text.length <= 200);
  }
});

test('R09: 归一工具（错误键 / 路径 / 版本字面量）', () => {
  assert.equal(errorKeyOf("Error: ENOENT: no such file or directory, open 'D:\\a\\b.json'"),
    'Error: ENOENT: no such file or directory, open \'<path>\'');
  assert.deepEqual(extractPaths("open 'D:\\a\\b.json'"), ['d:/a/b.json']);
  assert.deepEqual(extractVersionLiterals('pnpm add yaml@2.4.1').map((v) => v.value), ['yaml@2.4.1']);
  assert.deepEqual(extractVersionLiterals('headroom(version=1.17.0)').map((v) => v.value), ['1.17.0']);
  assert.deepEqual(extractVersionLiterals('npm test'), []);
});

test('R09: 确定性 + 不改写入参 + 空输入/非法输入', () => {
  const { episodes, signals } = fixture();
  const snapshot = JSON.stringify([...signals]);
  const one = promoteClaim({ episodes, signals });
  const two = promoteClaim({ episodes, signals });
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify([...signals]), snapshot, '纯函数不改写入参');

  const withNow = promoteClaim({ episodes, signals, now: T0 + 7 });
  assert.ok(withNow.claims.every((c) => c.recordedAt === T0 + 7));

  const empty = promoteClaim({ episodes: [] });
  assert.deepEqual(empty.claims, []);
  assert.equal(empty.stats.claims, 0);

  assert.throws(() => promoteClaim({ episodes: null }), ClaimError);
});

// D2（2026-11-02）：同类协议错误合并
test('D2: 同类「读-改协议」错误归一到同一 key，跨局合并成一条 claim', async () => {
  const { errorKeyOf, classifyErrorClass } = await import('../src/rooms/claim.mjs');
  const a = 'Error: cannot modify "D:/a/PLAN.md": file has not been read — read the file, then retry';
  const b = 'Error: cannot edit "D:/b/x.mjs": file changed since it was read — re-read the file, then retry';
  assert.equal(classifyErrorClass(a), 'fs-read-before-write');
  assert.equal(classifyErrorClass(b), 'fs-read-before-write');
  assert.equal(errorKeyOf(a), 'class:fs-read-before-write');
  assert.equal(errorKeyOf(b), 'class:fs-read-before-write');
  assert.equal(errorKeyOf('Error: unknown tool "bash"'), 'class:tool-unavailable');
  assert.equal(errorKeyOf('Error: team member limit 8 reached'), 'class:sandbox-limit');
  assert.equal(errorKeyOf('Error: this goal operation requires a direct human turn on a top-level agent'), 'class:policy-human-turn');
  assert.equal(errorKeyOf('SyntaxError: missing ) after argument list').includes('class:'), false, '语法错误保留具体原文');
});

// N10（2026-11-02）：人纠错（L4）回填 —— 只加 counter + state=disputed，不改原文
test('N10: L4 人纠错回填到目标 claim；非 L4 / 非 correct 不动', async () => {
  const { applyAdjudications } = await import('../src/rooms/claim.mjs');
  const claims = [
    { id: 'c-1', kind: 'antipattern', text: '原文不许改', state: 'observed', support: [{ episode: 'ep-a', seq: 1, quote: 'q' }], counter: [] },
    { id: 'c-2', kind: 'fact', text: 'other', state: 'observed', support: [], counter: [] },
  ];
  const adjudications = [
    { id: 'ad-l4', target: 'c-1', level: 'L4-human-correction', decision: 'correct', at: 123, votes: [{ member: 'human:owner', human: true, verdict: 'oppose', evidence: [{ quote: '这条已经过时' }] }] },
    { id: 'ad-l2', target: 'c-2', level: 'L2-multi-member', decision: 'correct', at: 124, votes: [] },
    { id: 'ad-hold', target: 'c-2', level: 'L4-human-correction', decision: 'hold-disputed', at: 125, votes: [] },
  ];
  const out = applyAdjudications({ claims, adjudications });
  assert.deepEqual(out.applied, ['c-1']);
  const c1 = claims.find((c) => c.id === 'c-1');
  assert.equal(c1.text, '原文不许改', '原文绝不改写');
  assert.equal(c1.state, 'disputed');
  assert.equal(c1.counter.length, 1);
  assert.equal(c1.counter[0].episode, 'human:owner');
  assert.equal(c1.counter[0].quote, '这条已经过时');
  assert.equal(c1.correctedAt, 123);
  assert.equal(claims.find((c) => c.id === 'c-2').state, 'observed', 'L2 / hold 不动 claim');

  // 幂等：同一纠错重放两次不重复加 counter
  applyAdjudications({ claims, adjudications });
  assert.equal(claims.find((c) => c.id === 'c-1').counter.length, 1);
});

// 2026-11-02：类级章节自愈 —— 多局支撑但缺类级 claim 时补一条；幂等
test('ensureClassClaims: 补出缺失的类级章节，且重复调用不再加', async () => {
  const { ensureClassClaims } = await import('../src/rooms/claim.mjs');
  const claims = [
    { id: 'c-m1', kind: 'antipattern', text: "Error: Cannot find module './a.json'", scopeKey: 'w:d:/x', state: 'observed', support: [{ episode: 'ep-a', seq: 1, quote: "Error: Cannot find module './a.json'", occurredAt: 10 }], counter: [] },
    { id: 'c-m2', kind: 'antipattern', text: "Error: Cannot find module './b.json'", scopeKey: 'w:d:/x', state: 'observed', support: [{ episode: 'ep-b', seq: 2, quote: "Error: Cannot find module './b.json'", occurredAt: 20 }], counter: [] },
    { id: 'c-ok', kind: 'antipattern', text: 'class:fs-read-before-write · file has not been read', scopeKey: 'w:d:/x', state: 'candidate', support: [{ episode: 'ep-c', seq: 3, quote: 'x', occurredAt: 30 }], counter: [] },
  ];
  const first = ensureClassClaims({ claims });
  assert.equal(first.added.length, 1, 'module-missing 缺类级章节 ⇒ 补 1 条');
  assert.match(first.added[0].text, /^class:module-missing · /);
  assert.equal(first.added[0].support.length, 2, '支撑来自两局');
  assert.equal(first.added[0].scopeKey, 'w:d:/x');

  const withAdded = [...claims, ...first.added];
  const second = ensureClassClaims({ claims: withAdded });
  assert.equal(second.added.length, 0, '已有类级章节 ⇒ 幂等，不再加');
});

// N1（2026-11-02）：双时态字段 —— claim 出生即带 validFrom（审计 P1-1 修正后的真断言）
test('N1: 每条 claim 的 validFrom 等于 occurredAt；人纠错写 validTo', async () => {
  const { promoteClaim, applyAdjudications } = await import('../src/rooms/claim.mjs');
  const { episodes, signals } = fixture();
  const out = promoteClaim({ episodes, signals, now: 1000 });
  assert.ok(out.claims.length > 0, 'fixture 必须产出 claim');
  for (const claim of out.claims) {
    if (Number.isFinite(claim.occurredAt)) {
      assert.equal(claim.validFrom, claim.occurredAt, `validFrom 必须等于 occurredAt（${claim.id}）`);
    } else {
      assert.equal(claim.validFrom, null);
    }
    assert.equal(claim.validTo, null);
  }
  const claims = [{ id: 'c-t', kind: 'antipattern', text: 'x', state: 'observed', support: [], counter: [], validFrom: 100, validTo: null }];
  applyAdjudications({ claims, adjudications: [{ id: 'ad', target: 'c-t', level: 'L4-human-correction', decision: 'correct', at: 200, votes: [] }] });
  assert.equal(claims[0].validTo, 200);
  assert.ok(claims[0].validFrom <= claims[0].validTo, 'validFrom ≤ validTo');
});

// 审计 P1-2：同一组证据、不同输入顺序 ⇒ 代表文本一致（class: 前缀不能丢）
test('P1-2: 输入顺序不影响代表文本，class: 前缀不丢失', async () => {
  const { promoteClaim } = await import('../src/rooms/claim.mjs');
  const { episodes, signals } = fixture();
  const asc = promoteClaim({ episodes, signals });
  const revEpisodes = [...episodes].reverse();
  const desc = promoteClaim({ episodes: revEpisodes, signals });
  const pick = (out, label) => out.claims
    .filter((c) => c.kind === 'antipattern' && c.text.includes('Cannot find module'))
    .map((c) => `${label}:${c.text}`).sort();
  const a = pick(asc);
  const d = pick(desc);
  assert.equal(a.length, 1);
  assert.deepEqual(d.map((x) => x.split(':')[1]), a.map((x) => x.split(':')[1]), '两种顺序必须得到同一文本');
  assert.match(a[0], /class:.*Cannot find module/, '类级映射必须带 class: 前缀');
});

// 2026-11-02：类级章节自愈 —— 多局支撑但缺类级 claim 时补一条；幂等
test('ensureClassClaims: 补出缺失的类级章节，且重复调用不再加', async () => {
  const { ensureClassClaims } = await import('../src/rooms/claim.mjs');
  const claims = [
    { id: 'c-m1', kind: 'antipattern', text: "Error: Cannot find module './a.json'", scopeKey: 'w:d:/x', state: 'observed', support: [{ episode: 'ep-a', seq: 1, quote: "Error: Cannot find module './a.json'", occurredAt: 10 }], counter: [] },
    { id: 'c-m2', kind: 'antipattern', text: "Error: Cannot find module './b.json'", scopeKey: 'w:d:/x', state: 'observed', support: [{ episode: 'ep-b', seq: 2, quote: "Error: Cannot find module './b.json'", occurredAt: 20 }], counter: [] },
    { id: 'c-ok', kind: 'antipattern', text: 'class:fs-read-before-write · file has not been read', scopeKey: 'w:d:/x', state: 'candidate', support: [{ episode: 'ep-c', seq: 3, quote: 'x', occurredAt: 30 }], counter: [] },
  ];
  const first = ensureClassClaims({ claims });
  assert.equal(first.added.length, 1, 'module-missing 缺类级章节 ⇒ 补 1 条');
  assert.match(first.added[0].text, /^class:module-missing · /);
  assert.equal(first.added[0].support.length, 2, '支撑来自两局');
  assert.equal(first.added[0].scopeKey, 'w:d:/x');

  const withAdded = [...claims, ...first.added];
  const second = ensureClassClaims({ claims: withAdded });
  assert.equal(second.added.length, 0, '已有类级章节 ⇒ 幂等，不再加');
});


// ---------------------------------------------------------------------------
// T38 · 坑类扩类（来自真库实际分布；每类都有机械判据）
// ---------------------------------------------------------------------------
test('T38 ①: 11 个新类各有机械判据（真库样本逐类命中）', () => {
  const cases = [
    ['agent-not-found', 'Error: active teammate "build-bot" not found'],
    ['agent-not-found', 'Error: task space not found: 42 at resolveTaskSpace'],
    ['file-not-found', 'FileNotFoundError: [Errno 2] No such file or directory: /tmp/x'],
    ['file-not-found', 'Error: ENOENT: no such file or directory, open a.txt'],
    ['syntax-error', 'SyntaxError: Unexpected token }'],
    ['syntax-error', 'bash: -c: line 1: syntax error near unexpected token'],
    ['search-io-error', 'Error: grep search failed (exit 2): rg: /repo: io error for operation'],
    ['search-io-error', 'Error: glob search failed (exit 2): io error for operation on /repo'],
    ['network', "fatal: unable to access 'https://github.com/x': failed to connect to github.com:443"],
    ['network', 'Error: url hostname "example.invalid" resolves to a non-public ip address'],
    ['type-error', "TypeError: Cannot read properties of undefined (reading 'x')"],
    ['arg-out-of-range', 'Error: offset 840 is out of range for "/tmp/a.mjs" (748 lines)'],
    ['git-not-repo', 'fatal: not a git repository (or any of the parent directories): .git'],
    ['path-not-directory', 'cd: /a/b: not a directory'],
    ['regex-error', 're.PatternError: unterminated character set at position 3'],
    ['regex-error', 'rg: regex parse error: (?:x'],
    ['python-exception', "AttributeError: 'NoneType' object has no attribute 'x'"],
    ['python-exception', "KeyError: 'items'"],
    ['python-exception', "UnicodeEncodeError: 'gbk' codec can't encode character"],
  ];
  for (const [expected, text] of cases) assert.equal(classifyErrorClass(text, { extended: true }), expected, text);
});

test('T38 ②: 旧 8 类优先（扩类不抢旧类的命中）', () => {
  assert.equal(classifyErrorClass('Error: Cannot find module yaml'), 'module-missing');
  assert.equal(classifyErrorClass('Error: file changed since it was read'), 'fs-read-before-write');
  assert.equal(classifyErrorClass('Error: permission denied'), 'permission-denied');
  assert.equal(classifyErrorClass('Error: timed out after 30s'), 'sandbox-limit');
});

test('T38 ③: tombstone —— 默认（不开扩类）与扩类前逐字节一致（新类样本 ⇒ null，旧类照旧）', () => {
  const newSamples = [
    'Error: active teammate "x" not found',
    'Error: ENOENT: no such file or directory',
    'SyntaxError: Unexpected token',
    'TypeError: x is not a function',
  ];
  for (const text of newSamples) assert.equal(classifyErrorClass(text), null, text);
  assert.equal(classifyErrorClass('Error: Cannot find module y'), 'module-missing');
  assert.equal(classifyErrorClass('Error: file changed since it was read'), 'fs-read-before-write');
  // 合并路径（errorKeyOf）也不受扩类影响
  assert.ok(!errorKeyOf('Error: ENOENT: no such file or directory, open x').startsWith('class:'), '合并路径不参与扩类');
});

test('T38 ④: 名单是单一来源（19 类 = 原 8 + 扩 11，无重名）', () => {
  assert.equal(ERROR_CLASS_NAMES.length, 19);
  assert.equal(new Set(ERROR_CLASS_NAMES).size, 19);
  assert.ok(ERROR_CLASS_NAMES.includes('fs-read-before-write'));
  assert.ok(ERROR_CLASS_NAMES.includes('syntax-error'));
  assert.ok(!classifyErrorClass('完全无关的一段话'));
});
