// R06 thread 的 tombstone test：删掉 src/rooms/thread.mjs ⇒ 本文件整片红。
//
// 覆盖（契约 AGENTS §4.4 / 方案 §4.5 / §4.10）：
//   - 成卷：同 scope + 共享**判别性**主题（df≥2 且过 R05 的 linkEligible 阈值）
//   - 一局可属多卷（多对多）；没有主题的局不单独成卷；通用主题（df=N）不成卷
//   - 跨 scope 不混卷（w: 层不跨工作区）
//   - kifus 按 occurredAt 升序；id 形如 th-<hash8>；parentThreadId=null；state="open"
//   - 纯函数：同输入两次同输出；不改写入参
//   - links 只作计数（intra-thread shared-topic 边数），不决定成员

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildThreads, episodeOccurredAt, ThreadError } from '../src/rooms/thread.mjs';
import { buildLinks } from '../src/rooms/link.mjs';

const T0 = 1_700_000_000_000;
const SCOPE_A = 'w:d:/work/demo';
const SCOPE_B = 'w:e:/other/ws';

const topic = (kind, key, n) => ({ id: `t:${kind}:seed${n}`, kind, key });
const ep = (id, scopeKey, startedAt, topics, extra = {}) => ({
  id,
  sessionId: `session-${id.slice(3)}`,
  scopeKey,
  startedAt,
  topics,
  ...extra,
});

const TA = topic('repo', 'mycf711/dsh-kifuin', 1);
const TY = topic('file', 'src/rooms/link.mjs', 2);
const TB = topic('dependency', 'yaml', 3);
const TX = topic('term', '跨域主题', 4);
const TU = topic('tool', 'bash', 5);

function corpus() {
  return [
    ep('ep-aaaaaaaa', SCOPE_A, T0, [TA, TY, TX, TU]),
    ep('ep-bbbbbbbb', SCOPE_A, T0 + 2000, [TA, TY, TU]),
    // TX 只在「每边一个」出现：df=2 但两个工作区各 1 局 ⇒ 任何一边都不成卷
    ep('ep-cccccccc', SCOPE_B, T0 + 1000, [TB, TX, TU]),
    ep('ep-dddddddd', SCOPE_B, T0 + 3000, [TB, TX, TU]),
    ep('ep-eeeeeeee', SCOPE_A, T0 + 4000, []),
  ];
}

test('R06: 同 scope + 判别性主题 ⇒ 成卷；一局可属多卷（多对多）', () => {
  const { threads, assignments, stats } = buildThreads({ episodes: corpus() });

  assert.deepEqual(threads.map((t) => t.title).sort(), ['mycf711/dsh-kifuin', 'src/rooms/link.mjs', 'yaml'].sort(),
    '只有同 scope 内 ≥2 局的判别性主题成卷');

  const ta = threads.find((t) => t.title === 'mycf711/dsh-kifuin');
  const ty = threads.find((t) => t.title === 'src/rooms/link.mjs');
  assert.ok(ta && ty, 'TA/TY 各成一卷');

  const a = assignments.find((x) => x.episode === 'ep-aaaaaaaa');
  assert.equal(a.threadIds.length, 2, '一局可属多卷（多对多）');
  assert.deepEqual([...a.threadIds].sort(), [ta.id, ty.id].sort());

  assert.equal(stats.multiMembership, 2, 'ep-a/ep-b 各属 2 卷');
  assert.equal(stats.episodesInThreads, 4);
  assert.equal(stats.episodesWithoutThread, 1);
});

test('R06: 通用主题（df=N）与无主题的局不成卷', () => {
  const { threads, assignments } = buildThreads({ episodes: corpus() });
  assert.ok(!threads.some((t) => t.title === 'bash'), 'df=N 的主题不成卷（否则退回「全体一册」）');
  const e = assignments.find((x) => x.episode === 'ep-eeeeeeee');
  assert.deepEqual(e.threadIds, [], '没有主题的局不单独成卷');
});

test('R06: 跨 scope 不混卷（同主题在两个工作区各一局 ⇒ 都不成卷）', () => {
  const eps = corpus();
  const { threads } = buildThreads({ episodes: eps });
  assert.ok(!threads.some((t) => t.title === '跨域主题'), 'w: 层不跨工作区（方案 §4.10）');

  const scopeOf = new Map(eps.map((e) => [e.id, e.scopeKey]));
  assert.equal(new Set(threads.map((t) => t.scopeKey)).size, 2, '两个工作区各成自己的卷');
  for (const t of threads) {
    const scopes = new Set(t.kifus.map((k) => scopeOf.get(k)));
    assert.deepEqual([...scopes], [t.scopeKey], '同一卷内不许跨 scope');
  }
});

test('R06: 卷的形状（id/title/state/parentThreadId/kifus 升序/createdAt）', () => {
  const { threads } = buildThreads({ episodes: corpus() });
  const ta = threads.find((t) => t.title === 'mycf711/dsh-kifuin');
  assert.match(ta.id, /^th-[0-9a-f]{8}$/);
  assert.equal(ta.parentThreadId, null);
  assert.equal(ta.state, 'open');
  assert.equal(ta.kind, 'repo');
  assert.deepEqual(ta.topics, [TA.id]);
  assert.deepEqual(ta.kifus, ['ep-aaaaaaaa', 'ep-bbbbbbbb'], 'kifus 按 occurredAt 升序');
  assert.equal(ta.createdAt, T0);
  assert.equal(ta.updatedAt, T0 + 2000);
  assert.equal(ta.kifuCount, 2);
  assert.equal(typeof ta.links, 'number');
  for (const t of threads) {
    assert.ok(t.title.length > 0 && t.title.length <= 80);
    assert.ok(Number.isFinite(t.createdAt), 'createdAt 由棋谱时间派生（无时不入）');
  }
});

test('R06: topics 表可省略（title 退化为 topic id），也可补 kind/key', () => {
  const bare = corpus().map((e) => ({ ...e, topics: e.topics.map((t) => ({ id: t.id })) }));

  const withoutTable = buildThreads({ episodes: bare });
  assert.equal(withoutTable.threads.length, 3, '成员只看 df，不看标题');
  const byId = withoutTable.threads.find((t) => t.topics[0] === TA.id);
  assert.equal(byId.title, TA.id, '没有 key 时 title 退化为 topic id（不猜词）');

  const table = { byId: new Map([TA, TY, TB, TX, TU].map((t) => [t.id, t])) };
  const withTable = buildThreads({ episodes: bare, topics: table });
  const ta = withTable.threads.find((t) => t.topics[0] === TA.id);
  assert.equal(ta.title, TA.key, 'topics 表补回 kind/key 后 title 逐字取 key');
  assert.equal(ta.kind, 'repo');
});

test('R06: links 只作计数 —— 卷内 shared-topic 边数可审计，不决定成员', () => {
  const eps = corpus();
  const { links } = buildLinks({ episodes: eps });
  const withLinks = buildThreads({ episodes: eps, links });
  const withoutLinks = buildThreads({ episodes: eps });
  assert.deepEqual(withLinks.threads.map((t) => t.kifus), withoutLinks.threads.map((t) => t.kifus),
    '成员不受 links 影响');
  const total = withLinks.threads.reduce((s, t) => s + t.links, 0);
  assert.ok(total >= 1, 'fixture 里 ep-a/ep-b 共享判别性硬主题 ⇒ 卷内应有 shared-topic 边');
});

test('R06: 确定性 + 不改写入参', () => {
  const eps = corpus();
  const snapshot = JSON.stringify(eps);
  const one = buildThreads({ episodes: eps });
  const two = buildThreads({ episodes: eps });
  assert.deepEqual(one, two, '同输入两次同输出');
  assert.equal(JSON.stringify(eps), snapshot, '纯函数不改写入参');

  const reversed = buildThreads({ episodes: [...eps].reverse() });
  assert.deepEqual(reversed.threads.map((t) => [t.id, t.kifus]), one.threads.map((t) => [t.id, t.kifus]),
    '入参顺序变化不改变卷内容');
});

test('R06: 空输入与非法输入', () => {
  const empty = buildThreads({ episodes: [] });
  assert.deepEqual(empty.threads, []);
  assert.deepEqual(empty.assignments, []);
  assert.equal(empty.stats.threads, 0);

  assert.throws(() => buildThreads({ episodes: null }), ThreadError);
  assert.equal(episodeOccurredAt({ startedAt: 5 }), 5);
  assert.equal(episodeOccurredAt({}), null);
});
