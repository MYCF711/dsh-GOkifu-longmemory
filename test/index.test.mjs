// R07 index 的 tombstone test：删掉 src/rooms/index.mjs ⇒ 本文件整片红。
//
// 覆盖（契约 §5）：
//   - 按 scope 分节
//   - 每局一行：`- <YYYY-MM-DD> <ep-id> · <l0≤60字> · fail=<n> · topics=<top3> · links=<n>`
//   - 必含声明「未列出 ≠ 不存在；完整清单见 index.md 树」
//   - 派生且可复算：同输入两次同输出（不读时钟）

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderIndex, formatDay, pickTopTopics } from '../src/rooms/index.mjs';
import { computeDf, topicId } from '../src/rooms/topic.mjs';

const DECLARATION = '未列出 ≠ 不存在；完整清单见 index.md 树';

const topic = (kind, key, count = 1) => ({
  id: topicId(kind, key),
  kind,
  key,
  count,
  occurrences: Array.from({ length: count }, (_, i) => ({ seq: i + 1, quote: key, occurredAt: 1_700_000_000_000 + i })),
});

function fixture() {
  const e1 = {
    id: 'ep-11111111',
    scopeKey: 'w:d:/work/a',
    startedAt: Date.UTC(2026, 9, 20, 3, 0, 0),
    endedAt: Date.UTC(2026, 9, 20, 4, 0, 0),
    l0: '把反代插件的脚手架统一到 magpie-plugin-*，并验证热切换后工具面不丢',
    signals: { failures: 3 },
    topics: [
      topic('repo', 'magpie/plugin-alpha'),
      topic('tool', 'bash', 4),
      topic('file', 'src/rooms/index.mjs', 2),
      topic('term', '上下文压缩', 2),
      topic('term', '反代插件', 2),
    ],
  };
  const e2 = {
    id: 'ep-22222222',
    scopeKey: 'w:d:/work/a',
    startedAt: Date.UTC(2026, 9, 21, 3, 0, 0),
    endedAt: Date.UTC(2026, 9, 21, 4, 0, 0),
    l0: '',
    signals: { failures: 0 },
    topics: [topic('repo', 'magpie/plugin-beta'), topic('tool', 'bash', 3), topic('term', '反代插件', 1)],
  };
  const e3 = {
    id: 'ep-33333333',
    scopeKey: 'w:d:/work/b',
    startedAt: Date.UTC(2026, 8, 30, 3, 0, 0),
    endedAt: Date.UTC(2026, 8, 30, 5, 0, 0),
    l0: '棋谱入馆与相关边的第一版',
    signals: { failures: 1 },
    topics: [topic('dependency', 'yaml'), topic('file', 'src/rooms/topic.mjs')],
  };
  const episodes = [e1, e2, e3];
  const links = [
    { a: { episode: e1.id }, b: { episode: e2.id }, kind: 'shared-topic', topics: [topic('term', '反代插件').id], why: '反代插件', weight: 0.09, occurredAt: 1 },
    { a: { episode: e1.id }, b: { episode: e3.id }, kind: 'same-error', topics: [], why: 'exit code 1', weight: 1, occurredAt: 2 },
    { a: { episode: e1.id }, b: { episode: e3.id }, kind: 'same-file', topics: [], why: 'x', weight: 1, occurredAt: 3 },
    { a: { episode: e2.id }, b: { episode: e3.id }, kind: 'shared-topic', topics: [], why: 'yaml', weight: 0.04, occurredAt: 4 },
  ];
  const table = computeDf(episodes.map((e) => ({ episodeId: e.id, topics: e.topics })));
  return { episodes, links, table };
}

test('R07: 按 scope 分节，每局一行且字段齐全（契约 §5 行格式）', () => {
  const { episodes, links, table } = fixture();
  const md = renderIndex({ episodes, links, topics: table });

  const lines = md.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 3, '三局 ⇒ 三行');

  const lineRe = /^- \d{4}-\d{2}-\d{2} ep-[A-Za-z0-9]+ · .+ · fail=\d+ · topics=.* · links=\d+$/;
  for (const line of lines) assert.match(line, lineRe, `行格式：${line}`);

  const scopes = md.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(scopes, ['## w:d:/work/a', '## w:d:/work/b'], '按 scope 分节且稳定排序');
  assert.match(md, /共 2 局/, '分节内给出局数');
});

test('R07: 必含「未列出 ≠ 不存在」声明（页头 + 页脚）', () => {
  const { episodes, links, table } = fixture();
  const md = renderIndex({ episodes, links, topics: table });
  const hits = md.split(DECLARATION).length - 1;
  assert.ok(hits >= 2, `声明至少两处，实际 ${hits}`);
});

test('R07: 日期 / 失败数 / 链接数 / top3 主题的机械计算', () => {
  const { episodes, links, table } = fixture();
  const md = renderIndex({ episodes, links, topics: table });
  const line1 = md.split('\n').find((l) => l.includes('ep-11111111'));

  assert.match(line1, /^- 2026-10-20 /, 'UTC 日期');
  assert.match(line1, /fail=3/, 'fail 取 signals.failures');
  assert.match(line1, /links=3/, 'e1 关联 3 条边');
  assert.match(line1, /topics=[^·]+ \/ [^·]+ \/ [^·]+/, 'top3 用 / 分隔');
  const top = line1.split('topics=')[1].split(' · links=')[0].split(' / ');
  assert.equal(top.length, 3);
  assert.ok(top[0].includes('magpie/plugin-alpha') || top[0].includes('bash'), '硬主题排前');

  const line2 = md.split('\n').find((l) => l.includes('ep-22222222'));
  assert.match(line2, /links=2/, 'e2 关联 2 条边');
  assert.match(line2, /fail=0/);
});

test('R07: l0 截断到 60 字，空 l0 用占位符（索引只做指针）', () => {
  const long = 'x'.repeat(200);
  const { episodes, links, table } = fixture();
  const md = renderIndex({
    episodes: [{ ...episodes[1], l0: long }, episodes[0], episodes[2]],
    links,
    topics: table,
  });
  const line = md.split('\n').find((l) => l.includes('ep-22222222'));
  const l0 = line.split(' · ')[1];
  assert.ok(l0.length <= 60, `l0 ≤ 60 字，实际 ${l0.length}`);
  assert.ok(l0.endsWith('…'));

  assert.deepEqual(formatDay(Date.UTC(2026, 0, 2)), '2026-01-02');
  assert.equal(formatDay(null), '????-??-??');

  const noL0 = renderIndex({ episodes: [{ ...episodes[1], l0: '' }], links: [], topics: table });
  assert.match(noL0, /· — · fail=0/, '空 l0 用 — 占位');
});

test('R07: 派生可复算 —— 同输入同输出；不传 generatedAt 时无时钟字段', () => {
  const { episodes, links, table } = fixture();
  const a = renderIndex({ episodes, links, topics: table });
  const b = renderIndex({ episodes, links, topics: table });
  assert.equal(a, b);
  assert.ok(!a.includes('生成时间'), '不读时钟');
});

test('R07: 传 generatedAt 才渲染时间戳；空语料也能渲染', () => {
  const { episodes, links, table } = fixture();
  const md = renderIndex({ episodes, links, topics: table, generatedAt: Date.UTC(2026, 10, 2, 1, 2, 3) });
  assert.match(md, /> 生成时间：2026-11-02T01:02:03\.000Z/);

  const empty = renderIndex({});
  assert.match(empty, /（暂无棋谱）/);
  assert.ok(empty.includes(DECLARATION));
});

test('R07: pickTopTopics 硬主题优先、判别性优先', () => {
  const { episodes, table } = fixture();
  const picked = pickTopTopics(episodes[0].topics, new Map(table.topics.map((t) => [t.id, t])), 3);
  assert.equal(picked.length, 3);
  assert.ok(['repo', 'file'].includes(picked[0].kind), '硬主题排在前');
  assert.equal(picked[0].key, 'magpie/plugin-alpha', '同层里 df 更小（更判别）的排前');
});
