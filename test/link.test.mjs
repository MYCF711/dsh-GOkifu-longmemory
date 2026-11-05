// R05 link 的 tombstone test：删掉 src/rooms/link.mjs ⇒ 本文件整片红。
//
// 覆盖（契约 §4 / 方案 §4.2–§4.3 / §4.6）：
//   - 棋谱↔主题（mention）：每条带 from/topic/seq/quote/weight/occurredAt
//   - 棋谱↔棋谱：共享 ≥1 硬主题（weight=1），或 ≥2 判别性软主题（weight=0.5×IDF 归一）
//   - 通用主题（df = N）不建边（否则 N 局两两全连）
//   - 节点↔节点：same-error（同一 error 原文）/ same-file（同一文件 + 同一错误），带 edgeId
//   - 每条 link 必有非空 why + 数字 weight + 非空 topics

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTopics, computeDf } from '../src/rooms/topic.mjs';
import { buildLinks, idfNorm, LINK_KIND_ORDER } from '../src/rooms/link.mjs';

const SCOPE = 'w:d:/work/demo';
const T0 = 1_700_000_000_000;
const ERROR_TEXT = "Error: Cannot find module 'yaml'";

const toolCall = (seq, name, args) => ({
  type: 'tool/call',
  seq,
  time: T0 + seq * 1000,
  data: { turn: 1, step: 1, callId: `c${seq}`, name, arguments: JSON.stringify(args) },
});
const userMessage = (seq, text) => ({
  type: 'user/message',
  seq,
  time: T0 + seq * 1000,
  data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text }] },
});
const failureEdge = (id, filePath, errorSnippet = ERROR_TEXT, ts = T0 + 500) => ({
  id,
  from: 'n1',
  to: 'n2',
  action: `edit(file_path=${filePath})`,
  result: 'failure',
  errorSnippet,
  ts,
});

function mkEpisode({ id, start, events = [], edges = {} }) {
  const epSeed = { id, scopeKey: SCOPE, startedAt: start };
  const topics = extractTopics({
    episode: epSeed,
    events,
    graph: Object.keys(edges).length ? { version: 1, nodes: {}, edges } : null,
  });
  return { ...epSeed, endedAt: start + 10_000, signals: { failures: Object.keys(edges).length }, topics };
}

function corpus() {
  const clone = (seq) => toolCall(seq, 'bash', { command: 'git clone https://github.com/MYCF711/dsh-kifuin.git' });
  const ls = (seq) => toolCall(seq, 'bash', { command: 'ls -la' });
  const terms = '记忆系统的主题抽取要机械；不要模型判断。';
  const e1 = mkEpisode({
    id: 'ep-00000001',
    start: T0,
    events: [userMessage(1, terms), clone(2)],
    edges: { e9: failureEdge('e9', 'D:/work/demo/src/a.mjs') },
  });
  const e2 = mkEpisode({
    id: 'ep-00000002',
    start: T0 + 100_000,
    events: [userMessage(1, '部署与回滚要写进交接文档。'), clone(2)],
    edges: { e1: failureEdge('e1', 'D:/work/demo/src/a.mjs') },
  });
  const e3 = mkEpisode({
    id: 'ep-00000003',
    start: T0 + 200_000,
    events: [userMessage(1, '日志与时间戳要能复算。'), ls(2)],
    edges: { e7: failureEdge('e7', 'D:/work/demo/src/b.mjs') },
  });
  const e4 = mkEpisode({
    id: 'ep-00000004',
    start: T0 + 300_000,
    events: [ls(1)],
  });
  // e5：只有 bash + 软主题词，用来验证「软边单独成立」的路径
  const e5 = mkEpisode({
    id: 'ep-00000005',
    start: T0 + 400_000,
    events: [userMessage(1, terms), ls(2)],
  });
  return [e1, e2, e3, e4, e5];
}

function build(episodes) {
  const table = computeDf(episodes.map((e) => ({ episodeId: e.id, topics: e.topics })));
  return { table, ...buildLinks({ episodes, topics: table }) };
}

const findLink = (links, pred) => links.filter(pred);

test('R05: mention —— 棋谱↔主题，带 from/topic/seq/quote/weight', () => {
  const { mentions } = build(corpus());
  assert.ok(mentions.length > 0);
  for (const m of mentions) {
    assert.match(m.topic, /^t:(repo|scaffold|dependency|tool|file|domain|error|term|goal):[0-9a-f]{8}$/, 'topic id 契约 §4');
    assert.ok(m.from && typeof m.from.episode === 'string' && m.from.episode.startsWith('ep-'));
    assert.ok(typeof m.quote === 'string' && m.quote.length > 0, 'mention 必须带 quote（无源不入）');
    assert.ok(Number.isFinite(m.weight) && m.weight > 0 && m.weight <= 1);
    // provenance：seq 来自事件；棋谱边只有 edgeId，同样可溯源
    assert.ok(Number.isFinite(m.seq) || m.from.edgeId || m.from.nodeId, 'mention 必须可溯源');
    assert.ok(Number.isFinite(m.occurredAt), 'occurredAt 必填（无时不入）');
  }
  // 硬主题 mention 权重 = 1；软主题 = 0.5×IDF 归一
  const hard = mentions.find((m) => m.topic.startsWith('t:repo:'));
  assert.equal(hard.weight, 1);
  const soft = mentions.find((m) => m.topic.startsWith('t:term:'));
  assert.ok(soft.weight > 0 && soft.weight <= 0.5, '软主题权重 ≤ 0.5');
});

test('R05: 棋谱↔棋谱 —— 共享硬主题 weight=1 且 why 列出命中的 topic key', () => {
  const { links } = build(corpus());
  const e1e2 = findLink(links, (l) => l.kind === 'shared-topic'
    && l.a.episode === 'ep-00000001' && l.b.episode === 'ep-00000002');
  assert.equal(e1e2.length, 1, '共享 repo:mycf711/dsh-kifuin ⇒ 一条 shared-topic');
  const link = e1e2[0];
  assert.equal(link.weight, 1, '硬边 = 1');
  assert.ok(String(link.why).split(', ').includes('mycf711/dsh-kifuin'), 'why = 命中的 topic key 列表');
  assert.ok(!String(link.why).split(', ').includes('bash'), '通用主题不进 why');
  assert.ok(link.topics.length >= 1);
  assert.ok(Number.isFinite(link.occurredAt));
});

test('R05: 通用主题（df = N）不建边 —— bash 不把全部棋谱连成一团', () => {
  const { links, table } = build(corpus());
  const bashTopic = table.topics.find((t) => t.kind === 'tool' && t.key === 'bash');
  assert.equal(bashTopic.df, table.n, 'fixture 前提：bash 是通用主题');
  const bashLinks = links.filter((l) => String(l.why).split(', ').includes('bash'));
  assert.deepEqual(bashLinks, [], 'df=N 的主题只进 mention，不建棋谱↔棋谱边');
  assert.ok(links.length > 0, '其它边仍然建立');
});

test('R05: 判别性软主题 ≥2 ⇒ 软边 weight = 0.5×IDF 归一', () => {
  const { links, table } = build(corpus());
  const soft = findLink(links, (l) => l.kind === 'shared-topic'
    && l.a.episode === 'ep-00000001' && l.b.episode === 'ep-00000005');
  assert.equal(soft.length, 1, 'e1/e5 无共享硬主题，只共享多个判别性软主题 ⇒ 软边');
  const link = soft[0];
  assert.ok(link.topics.length >= 2, '两条以上判别性软主题才建软边');
  const df = table.byId.get(link.topics[0]).df;
  const expected = 0.5 * idfNorm(df, table.n);
  assert.ok(Math.abs(link.weight - Math.round(expected * 10000) / 10000) < 1e-9,
    `软边 = 0.5×IDF 归一（期望 ${expected}）`);
  assert.ok(link.weight > 0 && link.weight <= 0.5, '软边 ∈ (0,0.5]');
  assert.match(link.why, /记忆|系统/);
});

test('R05: 节点↔节点 —— same-error / same-file（带 edgeId 与双主题）', () => {
  const { links } = build(corpus());

  const sameError = findLink(links, (l) => l.kind === 'same-error'
    && l.a.episode === 'ep-00000001' && l.b.episode === 'ep-00000002');
  assert.equal(sameError.length, 1);
  assert.equal(sameError[0].weight, 1);
  assert.equal(sameError[0].why, ERROR_TEXT, '同一错误原文即 why');
  assert.equal(sameError[0].a.edgeId, 'e9', '节点级边要带 edgeId 才能溯源');
  assert.equal(sameError[0].b.edgeId, 'e1');

  const sameFile = findLink(links, (l) => l.kind === 'same-file'
    && l.a.episode === 'ep-00000001' && l.b.episode === 'ep-00000002');
  assert.equal(sameFile.length, 1, '同一文件 + 同一错误 ⇒ same-file');
  assert.equal(sameFile[0].weight, 1);
  assert.deepEqual(sameFile[0].topics.length, 2, 'topics = [file, error]');
  assert.match(sameFile[0].why, /src\/a\.mjs/);
  assert.match(sameFile[0].why, /Cannot find module/);

  // e1 与 e3 文件不同 ⇒ 只有 same-error，没有 same-file
  const crossFile = findLink(links, (l) => l.kind === 'same-file'
    && [l.a.episode, l.b.episode].includes('ep-00000003'));
  assert.deepEqual(crossFile, []);
});

test('R05: 每条边的形状约束（why 非空 / weight 数字 / topics 非空 / 不自连）', () => {
  const { links } = build(corpus());
  assert.ok(links.length > 0);
  for (const l of links) {
    assert.ok(LINK_KIND_ORDER.includes(l.kind), `未知 kind ${l.kind}`);
    assert.ok(typeof l.why === 'string' && l.why.trim().length > 0, '契约：空 why 的边不建');
    assert.ok(Number.isFinite(l.weight) && l.weight > 0 && l.weight <= 1);
    assert.ok(Array.isArray(l.topics) && l.topics.length > 0);
    assert.ok(l.a?.episode && l.b?.episode);
    assert.notEqual(l.a.episode, l.b.episode, '不建自连边');
  }
});

test('R05: 确定性 —— 同输入两次同输出；topic 表可省略', () => {
  const eps = corpus();
  const one = build(eps);
  const two = build(eps);
  assert.deepEqual(one.links, two.links);
  assert.deepEqual(one.mentions, two.mentions);

  const withoutTable = buildLinks({ episodes: eps });
  assert.equal(withoutTable.links.length, one.links.length, 'topics 缺省时用 episodes 里的 kind/key');
});

test('R05: 无棋谱 → 无边，不抛', () => {
  assert.deepEqual(buildLinks({ episodes: [] }), {
    mentions: [],
    links: [],
    stats: { episodes: 0, mentions: 0, links: 0, byKind: { 'shared-topic': 0, 'same-error': 0, 'same-file': 0 }, universalTopics: 0 },
  });
  const single = buildLinks({ episodes: [corpus()[0]] });
  assert.deepEqual(single.links, [], '单局不产生棋谱↔棋谱边');
});
