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
  assert.equal(c.text, YAML_ERROR, 'text 逐字取最早支撑局的错误原文');
  assert.deepEqual(c.support.map((s) => s.episode), ['ep-aaaaaaaa', 'ep-bbbbbbbb']);
  assert.equal(c.counters.support, 2);
  assert.equal(c.counters.counter, 0);
  assert.equal(c.validity.type, 'none');
  assert.equal(c.scopeKey, SCOPE);
  assert.equal(c.occurredAt, T0 + 12_000, 'occurredAt = 最早支撑证据的发生时间');
  assert.equal(c.recordedAt, null, 'recordedAt 只取入参 now');
  assert.equal(c.supersedes, null);
  assert.deepEqual(c.threadIds, []);
  assert.equal(c.validFrom, null);
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
