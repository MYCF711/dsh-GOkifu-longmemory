// R00 · episode 墓碑测试（tombstone：删掉 src/rooms/episode.mjs 就红）
//
// 覆盖：会话 → 棋谱（作用域、双时钟、闭包、信号占位、时间缺失回退、子代理归并字段）
// 真实语料：$DSH_HOME/sessions 最大日志走 R01 读、R00 建谱，断言时间窗与闭包。
// 语料缺席时真实断言 skip；合成夹具零依赖仍跑。
// 契约：docs/数据契约.md §2（timeSource ∈ event|inferred；recordedAt 可为 null；endedAt=最后事件 time）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseEvents, readFrames } from '../src/rooms/logread.mjs';
import { EpisodeError, buildEpisode, normalizeWorkspace, shortSessionId } from '../src/rooms/episode.mjs';

const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-1e82afca-8be2-42f9-8186-2bd274e30342',
  createdAt: 1793513948708,
  cwd: 'E:\\Documents\\deepseek-harness\\default-workspace',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
};
const EVENTS = [
  { type: 'permission/preset', seq: 0, time: 1793513948710, data: {} },
  { type: 'turn/start', seq: 1, time: 1793530000000, data: {} },
  { type: 'turn/end', seq: 2, time: 1793558504769, data: {} },
];

function sessionLogs() {
  const home = process.env.DSH_HOME;
  if (!home) return [];
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.jsonl.zstd')) out.push({ path: p, size: statSync(p).size });
    }
  };
  walk(join(home, 'sessions'));
  return out.sort((a, b) => b.size - a.size);
}

test('R00 墓碑：导出面存在（删掉房间即红）', () => {
  assert.equal(typeof buildEpisode, 'function');
  assert.equal(typeof shortSessionId, 'function');
  assert.equal(typeof normalizeWorkspace, 'function');
  assert.equal(typeof EpisodeError, 'function');
});

test('构建：字段形状与数据契约 §2 一致', () => {
  const episode = buildEpisode({ header: HEADER, events: EVENTS, logPath: 'L', graphPath: 'G', now: 1793600000000 });

  assert.equal(episode.id, 'ep-1e82afca');
  assert.equal(episode.sessionId, HEADER.id);
  assert.equal(episode.scopeKey, 'w:e:/Documents/deepseek-harness/default-workspace');
  assert.equal(episode.startedAt, HEADER.createdAt);
  assert.equal(episode.endedAt, 1793558504769, 'endedAt = 最后事件 time');
  assert.equal(episode.firstEventAt, 1793513948710);
  assert.equal(episode.lastEventAt, 1793558504769);
  assert.equal(episode.recordedAt, 1793600000000);
  assert.equal(episode.timeSource, 'event');
  assert.equal(episode.eventsWithoutTime, 0);
  assert.equal(episode.agentPreset, 'standard');
  assert.equal(episode.delegationDepth, 0);
  assert.equal(episode.parentSessionId, null, '根会话没有父局');
  assert.equal(episode.origin, null);
  assert.deepEqual(episode.closure, {
    logPath: 'L',
    graphPath: 'G',
    seqFrom: 0,
    seqTo: 2,
    eventCount: 3,
    nodeIds: [],
    edgeIds: [],
  });
  assert.equal(episode.l0, '');
  assert.equal(episode.l1, '');
  assert.deepEqual(episode.signals, { failures: 0, successes: 0, unsettled: 0, constraints: 0, tools: [] });
  assert.deepEqual(episode.threadIds, []);
  assert.equal(episode.state, 'archived');
  assert.ok(episode.firstEventAt <= episode.lastEventAt, 'firstEventAt<=lastEventAt');
});

test('双时钟：不传 now ⇒ recordedAt:null（M1 不入馆，不拿 Date.now() 冒充）', () => {
  const before = Date.now();
  const episode = buildEpisode({ header: HEADER, events: EVENTS });
  const after = Date.now();
  assert.equal(episode.recordedAt, null);
  assert.ok(episode.recordedAt === null || (episode.recordedAt >= before && episode.recordedAt <= after));
  assert.notEqual(episode.recordedAt, episode.lastEventAt, '二时钟不同源');
  // 别名 recordedAt 仍接受（过渡期兼容）
  assert.equal(buildEpisode({ header: HEADER, events: EVENTS, recordedAt: 42 }).recordedAt, 42);
  assert.equal(buildEpisode({ header: HEADER, events: EVENTS, now: 7, recordedAt: 42 }).recordedAt, 7, 'now 优先');
});

test('时间：事件全无 time ⇒ 回退 header.createdAt 并标 timeSource:inferred', () => {
  const events = EVENTS.map(({ time, ...rest }) => rest);
  const episode = buildEpisode({ header: HEADER, events, now: null });
  assert.equal(episode.timeSource, 'inferred');
  assert.equal(episode.eventsWithoutTime, 3);
  assert.equal(episode.firstEventAt, HEADER.createdAt);
  assert.equal(episode.lastEventAt, HEADER.createdAt);
  assert.equal(episode.startedAt, HEADER.createdAt);
  assert.equal(episode.endedAt, HEADER.createdAt);
  assert.equal(episode.firstEventAt, episode.lastEventAt);
});

test('时间：部分事件缺 time ⇒ inferred（冻结枚举只有两值），窗口只按有 time 的事件算', () => {
  const events = [EVENTS[0], { ...EVENTS[1], time: undefined }, EVENTS[2]];
  const episode = buildEpisode({ header: HEADER, events, now: null });
  assert.equal(episode.timeSource, 'inferred', '只要缺 time 就不许自称 event');
  assert.equal(episode.eventsWithoutTime, 1);
  assert.equal(episode.firstEventAt, EVENTS[0].time);
  assert.equal(episode.lastEventAt, EVENTS[2].time);
});

test('时间：无事件 ⇒ 窗口退化到 createdAt，seq 闭包为 null', () => {
  const episode = buildEpisode({ header: HEADER, events: [], now: null });
  assert.equal(episode.timeSource, 'inferred');
  assert.equal(episode.firstEventAt, HEADER.createdAt);
  assert.equal(episode.lastEventAt, HEADER.createdAt);
  assert.equal(episode.endedAt, HEADER.createdAt);
  assert.equal(episode.closure.seqFrom, null);
  assert.equal(episode.closure.seqTo, null);
  assert.equal(episode.closure.eventCount, 0);
});

test('时间：事件早于 createdAt（补录/时钟偏移）⇒ 原值照留，不偷偷改写', () => {
  const episode = buildEpisode({
    header: { ...HEADER, createdAt: 1793600000000 },
    events: [{ type: 'x', seq: 0, time: 1793000000000 }],
    now: null,
  });
  assert.equal(episode.startedAt, 1793600000000);
  assert.equal(episode.firstEventAt, 1793000000000);
  assert.equal(episode.lastEventAt, 1793000000000);
  assert.equal(episode.endedAt, 1793000000000, '契约 §2：endedAt = 最后事件 time（原值照留）');
  assert.ok(episode.endedAt < episode.startedAt, '偏移是事实，交给下游闸门判，R00 不掩盖');
});

test('seq：闭包取 min/max（乱序事件也正确），不按首尾', () => {
  const episode = buildEpisode({
    header: HEADER,
    events: [
      { type: 'a', seq: 5, time: 1793513950000 },
      { type: 'b', seq: 2, time: 1793513951000 },
      { type: 'c', seq: 9, time: 1793513952000 },
    ],
    now: null,
  });
  assert.equal(episode.closure.seqFrom, 2);
  assert.equal(episode.closure.seqTo, 9);
});

test('作用域：scopeKey 用 header.cwd 规范化（反斜杠/盘符/尾斜杠）', () => {
  assert.equal(normalizeWorkspace('E:\\Documents\\deepseek-harness\\default-workspace'), 'e:/Documents/deepseek-harness/default-workspace');
  assert.equal(normalizeWorkspace('d:/Work/W/'), 'd:/Work/W');
  assert.equal(normalizeWorkspace('E:'), 'e:');
  assert.equal(normalizeWorkspace(''), '');
  assert.equal(normalizeWorkspace(undefined), '');
  // 棋谱里的 cwd（profiles\desktop）不是工作区：作用域只认 header.cwd
  assert.equal(
    buildEpisode({ header: { ...HEADER, cwd: 'D:\\DeepSeek Harness\\home\\profiles\\desktop' }, events: EVENTS, now: null }).scopeKey,
    'w:d:/DeepSeek Harness/home/profiles/desktop',
  );
  // 缺 cwd：显式标 unknown，不假装有作用域
  const missing = buildEpisode({ header: { ...HEADER, cwd: undefined }, events: EVENTS, now: null });
  assert.equal(missing.scopeKey, 'w:unknown');
  assert.equal(missing.scopeSource, 'unknown');
});

test('id：shortSessionId 去前缀取前 8（缺前缀/非字符串也稳）', () => {
  assert.equal(shortSessionId('session-1e82afca-8be2-42f9-8186-2bd274e30342'), '1e82afca');
  assert.equal(shortSessionId('5c4bf5c6-8ee2-4b31-bf91-07134464215e'), '5c4bf5c6');
  assert.equal(shortSessionId(undefined), 'unknown');
  assert.equal(shortSessionId(''), 'unknown');
  assert.equal(buildEpisode({ header: { ...HEADER, id: '5c4bf5c6-aaaa' }, events: [], now: null }).id, 'ep-5c4bf5c6');
});

test('归并：子代理会话带出 parentSessionId/origin/depth，归并动作留给调用方', () => {
  const sub = {
    ...HEADER,
    id: '5c4bf5c6-8ee2-4b31-bf91-07134464215e',
    parentSession: 'session-8cc34e32-c35d-41c1-90f4-f658dc7244d2',
    origin: 'subagent',
    delegationDepth: 1,
  };
  const episode = buildEpisode({ header: sub, events: EVENTS, now: null });
  assert.equal(episode.id, 'ep-5c4bf5c6');
  assert.equal(episode.parentSessionId, 'session-8cc34e32-c35d-41c1-90f4-f658dc7244d2');
  assert.equal(episode.origin, 'subagent');
  assert.equal(episode.delegationDepth, 1);
  // R00 不改写归属：仍按自己的 cwd 出作用域，归并策略由调用方（§4.1「只收 depth=0」）决定
  assert.equal(episode.scopeKey, 'w:e:/Documents/deepseek-harness/default-workspace');
  assert.equal(episode.state, 'archived');
});

test('参数：缺 logPath/graphPath ⇒ null（原片可缺，不伪造路径）', () => {
  const episode = buildEpisode({ header: HEADER, events: EVENTS, now: null });
  assert.equal(episode.closure.logPath, null);
  assert.equal(episode.closure.graphPath, null);
});

test('错误语义：缺 id / 缺 createdAt / events 非数组 ⇒ EpisodeError', () => {
  assert.throws(() => buildEpisode({ header: { ...HEADER, id: undefined }, events: [], now: null }), (error) => {
    assert.ok(error instanceof EpisodeError);
    assert.equal(error.code, 'episode/missing-id');
    return true;
  });
  assert.throws(() => buildEpisode({ header: { ...HEADER, createdAt: undefined }, events: [], now: null }), (error) => {
    assert.equal(error.code, 'episode/missing-createdAt');
    return true;
  });
  assert.throws(() => buildEpisode({ header: HEADER, events: 'nope', now: null }), (error) => {
    assert.equal(error.code, 'episode/input');
    return true;
  });
  assert.throws(() => buildEpisode(null), EpisodeError);
});

test('纯函数：不改写输入，且同输入同输出（幂等）', () => {
  const header = JSON.parse(JSON.stringify(HEADER));
  const events = JSON.parse(JSON.stringify(EVENTS));
  const a = buildEpisode({ header, events, now: 123 });
  const b = buildEpisode({ header, events, now: 123 });
  assert.deepEqual(a, b);
  assert.deepEqual(header, HEADER, 'header 不得被改写');
  assert.deepEqual(events, EVENTS, 'events 不得被改写');
});

test('真实：最大会话日志 → 棋谱（时间窗/闭包/作用域 与事件一致）', (t) => {
  const corpus = sessionLogs();
  if (corpus.length === 0) {
    t.skip('DSH_HOME 未设置或没有会话日志：跳过真实语料断言');
    return;
  }
  const target = corpus[0];
  const parsed = parseEvents(readFrames(readFileSync(target.path)));
  const episode = buildEpisode({
    header: parsed.header,
    events: parsed.events,
    logPath: target.path,
    graphPath: null,
    now: parsed.events.at(-1).time + 60_000,
  });

  assert.equal(episode.sessionId, parsed.header.id);
  assert.match(episode.id, /^ep-[0-9a-z]{8}$/);
  assert.ok(episode.scopeKey.startsWith('w:') && episode.scopeKey.length > 2);
  assert.equal(episode.startedAt, parsed.header.createdAt);
  assert.ok(episode.firstEventAt <= episode.lastEventAt);
  assert.equal(episode.timeSource, 'event');
  assert.equal(episode.closure.eventCount, parsed.events.length);
  assert.equal(episode.closure.seqFrom, Math.min(...parsed.events.map((e) => e.seq)));
  assert.equal(episode.closure.seqTo, Math.max(...parsed.events.map((e) => e.seq)));
  assert.equal(episode.closure.seqFrom, 0);
  assert.equal(episode.delegationDepth, parsed.header.delegationDepth);
  assert.equal(episode.state, 'archived');
  assert.deepEqual(episode.signals.tools, []);
  assert.equal(episode.firstEventAt, Math.min(...parsed.events.map((e) => e.time)));
  assert.equal(episode.lastEventAt, Math.max(...parsed.events.map((e) => e.time)));
  assert.equal(episode.endedAt, episode.lastEventAt);

  // 双时钟：occurredAt 窗口与 recordedAt 不同源
  assert.ok(episode.recordedAt > episode.lastEventAt, '入馆时间晚于事件时间');

  console.log(`# 棋谱 ${episode.id} scope=${episode.scopeKey} events=${episode.closure.eventCount} seq=${episode.closure.seqFrom}..${episode.closure.seqTo}`);
});
