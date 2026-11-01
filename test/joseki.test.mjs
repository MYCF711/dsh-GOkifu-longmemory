// R08 joseki 的 tombstone test：删掉 src/rooms/joseki.mjs ⇒ 本文件整片红。
//
// 覆盖（契约 AGENTS §4.6 / 方案 §4.7、§5.1b、Q5）：
//   - 成功边序列签名（同局按 seq）跨 ≥2 独立局 ⇒ candidate
//   - 每招必须有 source（episode/nodeId/edgeId/seq/quote），缺任一项整条不产出
//   - 单局 / 父子会话 / 跨 scope ⇒ 不成候选
//   - 反例（同一线路窗口内夹失败边）⇒ 不产出（「无反例」是候选的准入条件）
//   - 3 连招只留最长线（2 招子窗口去冗余）
//   - M2 只到 candidate，永不 standard；shares-joseki 边把支撑局连起来
//   - 纯函数：同输入两次同输出、不改写入参、recordedAt 只取入参 now

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  promoteJoseki,
  stepSignature,
  normalizeActionText,
  isIndependentEpisode,
  JosekiError,
} from '../src/rooms/joseki.mjs';

const T0 = 1_700_000_000_000;
const SCOPE = 'w:d:/work/demo';
const OTHER = 'w:e:/other/ws';

const ep = (id, sessionId, startedAt, scopeKey = SCOPE, extra = {}) => ({ id, sessionId, scopeKey, startedAt, ...extra });
const ok = (base, seq, quote, extra = {}) => ({
  seq,
  quote,
  nodeId: `n${seq}`,
  edgeId: `e${seq}`,
  result: 'success',
  verifyKind: 'exit',
  occurredAt: base + seq * 1000,
  ...extra,
});
const bad = (base, seq, quote, extra = {}) => ({ ...ok(base, seq, quote), result: 'failure', ...extra });
const signalsOf = ({ successes = [], failures = [], unsettled = [], constraints = [], tools = [] } = {}) => ({
  successes, failures, unsettled, constraints, tools,
});

const CMD = 'bash(command=npm test)';
const WRITE_A = 'write(file_path=D:\\work\\demo\\out\\result.json content={"a":1})';
const WRITE_B = "write(file_path='D:/work/demo/out/result.json' content={\"b\":2})";

const lineA = (base) => signalsOf({ successes: [ok(base, 10, CMD), ok(base, 20, WRITE_A)] });
const lineB = (base) => signalsOf({ successes: [ok(base, 5, CMD), ok(base, 9, WRITE_B)] });

function fixture() {
  const a = ep('ep-aaaaaaaa', 'session-a', T0);
  const b = ep('ep-bbbbbbbb', 'session-b', T0 + 100_000);
  return { episodes: [a, b], signals: new Map([['ep-aaaaaaaa', lineA(T0)], ['ep-bbbbbbbb', lineB(T0 + 100_000)]]) };
}

test('R08: 同一成功序列跨 2 独立局 ⇒ candidate，每招都有 source', () => {
  const { episodes, signals } = fixture();
  const { joseki, links, stats } = promoteJoseki({ episodes, signals });

  assert.equal(joseki.length, 1, '只有这一条跨局重复的成功线');
  const j = joseki[0];
  assert.match(j.id, /^j-[0-9a-f]{8}$/);
  assert.equal(j.version, 1);
  assert.equal(j.state, 'candidate', 'M2 只到 candidate（Q5：standard 由 M4 的机械规则触发）');
  assert.equal(j.supersedes, null);
  assert.deepEqual(j.counter, []);
  assert.deepEqual(j.assumptions, []);
  assert.equal(j.steps.length, 2);
  assert.deepEqual(j.support, ['ep-aaaaaaaa', 'ep-bbbbbbbb']);
  assert.deepEqual(j.preconditions.map((p) => p.check), ['scope']);
  assert.equal(j.preconditions[0].value, SCOPE, 'preconditions 可核：scope');
  assert.equal(j.recordedAt, null, 'recordedAt 只取入参 now，不拿 Date.now() 冒充');

  // 每招必须有 source，且指回源头棋谱
  for (const step of j.steps) {
    assert.ok(Number.isFinite(step.n) && step.n >= 1);
    assert.ok(typeof step.action === 'string' && step.action.length > 0);
    assert.match(step.expect, /^success/);
    const src = step.source;
    assert.equal(src.episode, 'ep-aaaaaaaa', 'source 取最早支撑局');
    assert.ok(Number.isFinite(src.seq), 'source.seq');
    assert.ok(typeof src.quote === 'string' && src.quote.length > 0, 'source.quote（无源不入）');
    assert.ok(typeof src.nodeId === 'string' && typeof src.edgeId === 'string', 'source 回指棋谱节点/边');
    assert.ok(Number.isFinite(step.occurredAt), '每招带 occurredAt');
  }
  assert.equal(j.steps[0].source.seq, 10);
  assert.equal(j.steps[1].source.seq, 20);
  assert.equal(j.steps[0].action, 'bash:command=npm test', '签名 = 工具 + 主参数（write 不取 content）');
  assert.equal(j.steps[1].action, 'write:file_path=/out/result.json', '工作区根被抹掉 ⇒ 跨局可比');

  // 连接组织：shares-joseki 边
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'shares-joseki');
  assert.equal(links[0].why, j.id);
  assert.deepEqual([links[0].a.episode, links[0].b.episode], ['ep-aaaaaaaa', 'ep-bbbbbbbb']);
  assert.ok(Number.isFinite(links[0].occurredAt));

  assert.equal(stats.candidates, 1);
  assert.equal(stats.successEdges, 4);
});

test('R08: 只有 1 局 ⇒ 不成候选（support=1 只到 observed 的东西不属于定式）', () => {
  const episode = ep('ep-aaaaaaaa', 'session-a', T0);
  const { joseki, stats } = promoteJoseki({
    episodes: [episode],
    signals: new Map([['ep-aaaaaaaa', lineA(T0)]]),
  });
  assert.deepEqual(joseki, []);
  assert.ok(stats.dropped.singleSupport >= 1);
});

test('R08: 父子会话不算独立局 ⇒ 不成候选', () => {
  const parent = ep('ep-aaaaaaaa', 'session-a', T0);
  const child = ep('ep-bbbbbbbb', 'session-b', T0 + 1000, SCOPE, { parentSessionId: 'session-a', delegationDepth: 1 });
  assert.equal(isIndependentEpisode(parent, child), false);

  const { joseki, stats } = promoteJoseki({
    episodes: [parent, child],
    signals: new Map([['ep-aaaaaaaa', lineA(T0)], ['ep-bbbbbbbb', lineB(T0 + 1000)]]),
  });
  assert.deepEqual(joseki, [], '子代理局归并到父局，不凑独立支撑');
  assert.ok(stats.dropped.notIndependent >= 1);
});

test('R08: 跨 scope 不配对（preconditions 的 scope 必须可核）', () => {
  const a = ep('ep-aaaaaaaa', 'session-a', T0, SCOPE);
  const b = ep('ep-bbbbbbbb', 'session-b', T0 + 1000, OTHER);
  const { joseki } = promoteJoseki({
    episodes: [a, b],
    signals: new Map([['ep-aaaaaaaa', lineA(T0)], ['ep-bbbbbbbb', lineB(T0 + 1000)]]),
  });
  assert.deepEqual(joseki, []);
});

test('R08: 反例优先 —— 同一线路窗口内夹失败边 ⇒ 不产出', () => {
  const a = ep('ep-aaaaaaaa', 'session-a', T0);
  const b = ep('ep-bbbbbbbb', 'session-b', T0 + 100_000);
  const c = ep('ep-cccccccc', 'session-c', T0 + 200_000);
  const lineC = signalsOf({
    successes: [ok(T0 + 200_000, 10, CMD), ok(T0 + 200_000, 20, WRITE_A)],
    failures: [bad(T0 + 200_000, 15, "Error: ENOENT: no such file or directory, open 'D:\\work\\demo\\out'")],
  });
  const { joseki, stats } = promoteJoseki({
    episodes: [a, b, c],
    signals: new Map([
      ['ep-aaaaaaaa', lineA(T0)],
      ['ep-bbbbbbbb', lineB(T0 + 100_000)],
      ['ep-cccccccc', lineC],
    ]),
  });
  assert.deepEqual(joseki, [], '有反例就不满足「无反例」准入');
  assert.ok(stats.dropped.countered >= 1);
});

test('R08: 无 source 不产出（缺 seq / 缺 quote）', () => {
  const a = ep('ep-aaaaaaaa', 'session-a', T0);
  const b = ep('ep-bbbbbbbb', 'session-b', T0 + 1000);
  const noSeq = signalsOf({ successes: [{ seq: null, quote: CMD, occurredAt: T0 }, ok(T0, 20, WRITE_A)] });
  const noQuote = signalsOf({ successes: [ok(T0 + 1000, 5, CMD), ok(T0 + 1000, 9, '')] });
  const { joseki, stats } = promoteJoseki({
    episodes: [a, b],
    signals: new Map([['ep-aaaaaaaa', noSeq], ['ep-bbbbbbbb', noQuote]]),
  });
  assert.deepEqual(joseki, [], '缺 seq/quote 的边不构成招');
  assert.equal(stats.dropped.noSource, 1);
  assert.equal(stats.dropped.noQuote, 1);
});

test('R08: 3 连招只留最长线（2 招子窗口去冗余）', () => {
  const base = T0 + 500_000;
  const line3 = (t) => signalsOf({
    successes: [ok(t, 10, 'bash(command=npm ci)'), ok(t, 20, 'bash(command=npm test)'), ok(t, 30, 'bash(command=npm run build)')],
  });
  const { joseki, stats } = promoteJoseki({
    episodes: [ep('ep-aaaaaaaa', 'session-a', base), ep('ep-bbbbbbbb', 'session-b', base + 1000)],
    signals: new Map([['ep-aaaaaaaa', line3(base)], ['ep-bbbbbbbb', line3(base + 1000)]]),
  });
  assert.equal(joseki.length, 1);
  assert.equal(joseki[0].steps.length, 3);
  assert.deepEqual(joseki[0].signature, ['bash:command=npm ci', 'bash:command=npm test', 'bash:command=npm run build']);
  assert.equal(stats.dropped.subWindow, 2, '两个 2 招子窗口被更长的同支撑线覆盖');
});

test('R08: signals 的四种入口形态等价（Map / 对象 / 数组 / 挂在 episodes 上）', () => {
  const { episodes, signals } = fixture();
  const one = promoteJoseki({ episodes, signals });

  const asObject = promoteJoseki({ episodes, signals: Object.fromEntries(signals) });
  const asArray = promoteJoseki({
    episodes,
    signals: [...signals.entries()].map(([episode, sig]) => ({ episode, ...sig })),
  });
  const onEpisodes = promoteJoseki({
    episodes: episodes.map((e) => ({ ...e, signals: signals.get(e.id) })),
  });
  assert.deepEqual(asObject.joseki, one.joseki);
  assert.deepEqual(asArray.joseki, one.joseki);
  assert.deepEqual(onEpisodes.joseki, one.joseki);
});

test('R08: 签名归一（工作区根、空白、长 id）', () => {
  assert.equal(normalizeActionText('write(file_path=D:\\work\\demo\\a.mjs content=x)', SCOPE), 'write(file_path=/a.mjs content=x)');
  assert.equal(stepSignature('bash(command=  npm   test )', { scopeKey: SCOPE }).text, 'bash:command=npm test');
  assert.equal(stepSignature('', { scopeKey: SCOPE }).text, '');
  assert.equal(stepSignature('plain text', { scopeKey: SCOPE }).text, 'plain text');
  const hex = stepSignature(`bash(command=rm -f ${'a'.repeat(32)}.tmp)`, { scopeKey: SCOPE }).text;
  assert.match(hex, /<id>/);
});

test('R08: 确定性 + 不改写入参 + now 落 recordedAt', () => {
  const { episodes, signals } = fixture();
  const snapshot = JSON.stringify([...signals]);
  const one = promoteJoseki({ episodes, signals, now: T0 + 999 });
  const two = promoteJoseki({ episodes, signals, now: T0 + 999 });
  assert.deepEqual(one, two);
  assert.equal(one.joseki[0].recordedAt, T0 + 999);
  assert.equal(JSON.stringify([...signals]), snapshot, '纯函数不改写入参');

  const empty = promoteJoseki({ episodes: [] });
  assert.deepEqual(empty.joseki, []);
  assert.deepEqual(empty.links, []);
  assert.equal(empty.stats.candidates, 0);

  assert.throws(() => promoteJoseki({ episodes: null }), JosekiError);
});
