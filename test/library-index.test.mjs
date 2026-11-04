// T144 的 tombstone test：删掉 scripts/build-library-index.mjs ⇒ 本文件整片红
// （第一行 import 就失败，之后所有断言都不存在）。
//
// 覆盖任务书的五条：
//   ① 跳过 00 索引；② title / firstLine 截断规则；③ 同一主题出现两次 ⇒ 2 条边；
//   ④ maxNotes 夹紧并标 clamped；⑤ 生产者不写盘、可复算（同输入同输出）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildLibraryIndex,
  readSystemNames,
  titleOf,
  firstLineOf,
  collectTopics,
  listNotes,
  clipChars,
  parseArgs,
  main,
  createTopicResolver,
  LIBRARY_ID,
  EDGE_KIND,
  INDEX_NOTE,
  MAX_FIRST_LINE,
} from '../scripts/build-library-index.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const LONG = '长'.repeat(200);

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-library-'));
  const docs = path.join(root, 'notes');
  mkdirSync(docs, { recursive: true });

  writeFileSync(path.join(docs, INDEX_NOTE), [
    '# 调研索引与机制对照',
    '',
    '| # | 系统 | 机制 |',
    '|---|---|---|',
    '| 07 | Letta | 记忆块 |',
    '| 16 | Mem0 v3 | 抽取整合 |',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(docs, '01-Mem0-2026-01-02.md'), [
    '# Mem0 的记忆管线',
    '',
    '- 来源：某处（2026-01-02 采集）',
    '- 第二行不该被取用',
    '',
  ].join('\n'), 'utf8');

  // 没有 `# ` 标题 ⇒ 用文件名（去 .md、去 -日期 后缀）
  writeFileSync(path.join(docs, '02-Letta-2026-01-03.md'), '正文第一段：没有标题的笔记。\n', 'utf8');

  // 长 firstLine + 书名号专名 + 与 01 共享 mem0
  writeFileSync(path.join(docs, '03-long-2026-01-04.md'), [
    '# 《上下文压缩》与 Mem0',
    '',
    LONG,
    '',
  ].join('\n'), 'utf8');

  return { root, docs };
}

let fixture;
test.before(() => { fixture = makeFixture(); });
test.after(() => { if (fixture?.root) rmSync(fixture.root, { recursive: true, force: true }); });

test('T144: 生产者文件存在且导出 buildLibraryIndex（删掉它 → 本文件红）', () => {
  const file = path.join(import.meta.dirname, '..', 'scripts', 'build-library-index.mjs');
  assert.ok(existsSync(file), 'scripts/build-library-index.mjs 必须存在');
  assert.equal(typeof buildLibraryIndex, 'function');
});

test('T144-①: 只扫笔记，跳过 00 索引', () => {
  const files = listNotes(fixture.docs);
  assert.deepEqual(files, ['01-Mem0-2026-01-02.md', '02-Letta-2026-01-03.md', '03-long-2026-01-04.md']);
  assert.ok(!files.includes(INDEX_NOTE));

  const result = buildLibraryIndex({ docsDir: fixture.docs });
  assert.equal(result.notes.length, 3);
  assert.ok(result.notes.every((n) => !n.id.includes('00-') && !n.path.includes('00-')));
  assert.equal(result.node.kind, 'library');
  assert.equal(result.node.id, LIBRARY_ID);
  assert.equal(result.node.label, '调研知识库（3 篇）');
  assert.equal(result.node.count, 3);
});

test('T144-②: title —— 第一条 `# ` 行；没有就用文件名（去 .md 与 -日期）', () => {
  assert.equal(titleOf('# 真标题\n\n正文', 'x-2026-01-01.md'), '真标题');
  assert.equal(titleOf('## 二级标题\n\n# 一级标题', 'x.md'), '一级标题');
  assert.equal(titleOf('没有标题', '07-Letta-2026-11-02.md'), '07-Letta');

  const result = buildLibraryIndex({ docsDir: fixture.docs });
  assert.deepEqual(result.notes.map((n) => n.title), [
    'Mem0 的记忆管线',
    '02-Letta',
    '《上下文压缩》与 Mem0',
  ]);
  assert.ok(result.notes[0].id.startsWith('note:') && result.notes[0].id.endsWith('01-Mem0-2026-01-02.md'));
});

test('T144-②: firstLine —— 去掉标题后的第一条非空行，剥列表标记，截 120 字 + …', () => {
  assert.equal(firstLineOf('# 标题\n\n- 来源：某处\n'), '来源：某处');
  assert.equal(firstLineOf('# 标题\n\n\n> 引用正文\n'), '引用正文');
  assert.equal(firstLineOf('# 仅有标题\n'), '');

  const clipped = firstLineOf(`# T\n\n${LONG}\n`);
  assert.equal(clipped.length, MAX_FIRST_LINE + 1, '120 字 + 省略号');
  assert.ok(clipped.endsWith('…'));
  assert.equal(clipped.slice(0, -1), LONG.slice(0, MAX_FIRST_LINE));

  const result = buildLibraryIndex({ docsDir: fixture.docs });
  assert.equal(result.notes[0].firstLine, '来源：某处（2026-01-02 采集）', '只取第一条非空行，不改写');
  assert.equal(result.notes[1].firstLine, '正文第一段：没有标题的笔记。');
  assert.equal(result.notes[2].firstLine.length, MAX_FIRST_LINE + 1);
});

test('T144-④: topics —— 英文标识符小写、大写缩写保留、书名号专名、索引表里的系统名', () => {
  const topics = collectTopics('37-AWS-AgentCore-Memory-TTL与巩固\n《上下文压缩》', new Set(['Mem0 v3']));
  assert.ok(topics.includes('aws-agentcore-memory-ttl'), '连字符标识符整体保留（小写）');
  assert.ok(topics.includes('agentcore'), '连字符拆出的子词');
  assert.ok(topics.includes('TTL'), '全大写子词按缩写保留（不留 ttl 重复）');
  assert.ok(topics.includes('上下文压缩'), '书名号里的中文专名照抄');
  assert.ok(!topics.includes('Mem0 v3'), '未出现在文本里的系统名不硬塞');

  const abbr = collectTopics('AWS TTL 与 AgentCore', new Set());
  assert.ok(abbr.includes('AWS'), '大写缩写保留原样');
  assert.ok(!abbr.includes('aws'), '已有大写缩写时不再留小写重复项');

  const indexText = readSystemNames(path.join(fixture.docs, INDEX_NOTE));
  assert.ok(indexText.has('Letta') && indexText.has('Mem0 v3'), '从 00 索引表读系统名');

  const result = buildLibraryIndex({ docsDir: fixture.docs });
  assert.ok(result.notes[0].topics.includes('mem0'), '文件名/标题里的 mem0');
  assert.ok(result.notes[2].topics.includes('上下文压缩'), '书名号专名');
});

test('T144-③: edges —— 一条边一个主题；同一主题在 N 篇出现就 N 条边', () => {
  const result = buildLibraryIndex({ docsDir: fixture.docs });
  const mem0 = result.edges.filter((e) => e.to === 't:mem0');
  assert.equal(mem0.length, 2, '01 与 03 都提到 mem0 ⇒ 2 条边');
  assert.deepEqual(mem0.map((e) => e.from), [LIBRARY_ID, LIBRARY_ID]);
  assert.deepEqual(mem0.map((e) => e.why), ['第 1 篇 · Mem0 的记忆管线', '第 3 篇 · 《上下文压缩》与 Mem0']);

  for (const edge of result.edges) {
    assert.equal(edge.kind, 'library-mentions-topic');
    assert.match(edge.to, /^t:.+$/);
    assert.match(edge.why, /^第 \d+ 篇 · .{1,20}$/, 'why = 第 n 篇 · title 前 20 字');
  }
  // 每篇每个主题只计一次边（同篇内去重）
  const pairs = result.edges.map((e) => `${e.to}|${e.why}`);
  assert.equal(new Set(pairs).size, pairs.length);
});

test('T144-④: maxNotes 夹紧并标 clamped', () => {
  const full = buildLibraryIndex({ docsDir: fixture.docs });
  assert.equal(full.clamped, false);

  const cut = buildLibraryIndex({ docsDir: fixture.docs, maxNotes: 2 });
  assert.equal(cut.clamped, true);
  assert.equal(cut.notes.length, 2);
  assert.equal(cut.node.count, 2);
  assert.equal(cut.node.label, '调研知识库（2 篇）');
  assert.ok(cut.edges.every((e) => !e.why.startsWith('第 3 篇')), '被夹掉的笔记不产边');
});

test('T144: 可复算 —— 同输入两次同输出；不写盘', () => {
  const before = readdirSync(fixture.docs).sort();
  const a = buildLibraryIndex({ docsDir: fixture.docs });
  const b = buildLibraryIndex({ docsDir: fixture.docs });
  assert.deepEqual(a, b);
  assert.deepEqual(readdirSync(fixture.docs).sort(), before, '生产者不产生文件');
  assert.equal(readFileSync(path.join(fixture.docs, '01-Mem0-2026-01-02.md'), 'utf8').includes('# Mem0 的记忆管线'), true);
});

test('T144: CLI —— 默认打印摘要，--json 打印完整结构；目录不存在 ⇒ 非零', () => {
  assert.deepEqual(parseArgs(['--json', '--docs', 'x']), { json: true, docs: 'x', store: null });
  assert.deepEqual(parseArgs(['--docs=y']), { json: false, docs: 'y', store: null });
  assert.deepEqual(parseArgs(['--store', 's']), { json: false, docs: null, store: 's' });
  assert.deepEqual(parseArgs(['--store=s2']), { json: false, docs: null, store: 's2' });

  const out = [];
  const errs = [];
  const code = main(['--docs', fixture.docs], {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => errs.push(s) },
  });
  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /篇数：3/);
  assert.match(text, /主题数：\d+/);
  assert.match(text, /边数：\d+/);
  assert.match(text, /clamped：否/);

  const jsonOut = [];
  const jsonCode = main(['--json', '--docs', fixture.docs], {
    stdout: { write: (s) => jsonOut.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(jsonCode, 0);
  const parsed = JSON.parse(jsonOut.join(''));
  assert.equal(parsed.node.id, LIBRARY_ID);
  assert.equal(parsed.notes.length, 3);

  const missing = main(['--docs', path.join(fixture.root, 'nope')], {
    stdout: { write: () => {} },
    stderr: { write: (s) => errs.push(s) },
  });
  assert.equal(missing, 2);
  assert.match(errs.join(''), /读取失败/);
});

test('T150: resolveTopic 注入后 —— 边指向真实 topic id，未解析进 orphans，counts 恒等式成立', () => {
  const real = new Map([
    ['mem0', 't:term:939ed81a'],
    ['agent', 't:tool:1c423785'],
  ]);
  const resolveTopic = (name) => real.get(name) ?? null;

  const result = buildLibraryIndex({ docsDir: fixture.docs, resolveTopic });
  const mem0 = result.edges.filter((e) => e.topicName === 'mem0');
  assert.equal(mem0.length, 2, '01 与 03 都提到 mem0');
  assert.deepEqual(new Set(mem0.map((e) => e.to)), new Set(['t:term:939ed81a']), 'to 是真实 topic id');
  assert.equal(mem0[0].kind, EDGE_KIND);
  assert.equal(mem0[0].from, LIBRARY_ID);

  // 未解析的主题**不建边**（不许编造节点），只进 orphans
  const unresolvedNames = new Set(result.orphans.map((o) => o.name));
  assert.ok(result.orphans.length > 0);
  assert.ok(!result.edges.some((e) => e.to === 't:letta'), '解析不到 ⇒ 不产生 t:letta 这种假节点');
  for (const orphan of result.orphans) {
    assert.ok(orphan.name && typeof orphan.why === 'string' && orphan.why.length > 0);
    assert.ok(!result.edges.some((e) => e.topicName === orphan.name), '同一主题不能既解析又孤儿');
  }

  const { counts } = result;
  assert.equal(counts.notes, 3);
  assert.equal(counts.resolvedEdges, result.edges.length);
  assert.equal(counts.orphans, result.orphans.length);
  assert.equal(counts.edges, counts.resolvedEdges + counts.orphans, 'edges = resolvedEdges + orphans');
  assert.ok(counts.orphans > 0 && unresolvedNames.size > 0);
});

test('T150: 不传 resolveTopic —— 行为与 T144 完全一致（向后兼容）', () => {
  const legacy = buildLibraryIndex({ docsDir: fixture.docs });
  assert.deepEqual(legacy.edges.map((e) => e.to), legacy.edges.map((e) => `t:${e.topicName}`));
  assert.deepEqual(legacy.orphans, []);
  assert.equal(legacy.counts.resolvedEdges, legacy.counts.edges);
  assert.equal(legacy.counts.orphans, 0);

  const explicitNull = buildLibraryIndex({ docsDir: fixture.docs, resolveTopic: null });
  assert.deepEqual(explicitNull, legacy);
});

test('T150: CLI --store —— 用 sidecar 的 topics 解析，只读；缺目录 ⇒ 非零', () => {
  const storeDir = path.join(fixture.root, 'memory-context');
  mkdirSync(storeDir, { recursive: true });
  const store = createStore({ root: storeDir });
  store.ensureDirs();
  store.put('topics', { id: 't:term:939ed81a', kind: 'term', key: 'Mem0', df: 2 });
  store.put('topics', { id: 't:tool:1c423785', kind: 'tool', key: 'agent', df: 1 });

  // 只读：跑完 store 目录里文件一个都不多
  const before = readdirSync(path.join(storeDir, 'topics')).sort();

  const out = [];
  const errs = [];
  const code = main(['--store', storeDir, '--docs', fixture.docs], {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => errs.push(s) },
  });
  assert.equal(code, 0, errs.join(''));
  const text = out.join('');
  assert.match(text, /主题库：.*（只读）/);
  assert.match(text, /边数：\d+ = resolvedEdges \d+ \+ orphans \d+/);

  const jsonOut = [];
  main(['--store', storeDir, '--docs', fixture.docs, '--json'], {
    stdout: { write: (s) => jsonOut.push(s) },
    stderr: { write: () => {} },
  });
  const parsed = JSON.parse(jsonOut.join(''));
  assert.ok(parsed.edges.some((e) => e.to === 't:term:939ed81a'), 'key 大小写不敏感（Mem0 → mem0）');
  assert.equal(parsed.counts.edges, parsed.counts.resolvedEdges + parsed.counts.orphans);
  assert.ok(parsed.counts.resolvedEdges >= 2);

  assert.deepEqual(readdirSync(path.join(storeDir, 'topics')).sort(), before, '只读：不写库');

  const missing = main(['--store', path.join(fixture.root, 'no-store'), '--docs', fixture.docs], {
    stdout: { write: () => {} },
    stderr: { write: (s) => errs.push(s) },
  });
  assert.equal(missing, 2);
  assert.match(errs.join(''), /--store 目录不存在/);
});

test('T144: 截断工具按「字」算（emoji/代理对不会被切半）', () => {
  assert.equal(clipChars('abc', 5), 'abc');
  assert.equal(clipChars('abcdef', 3), 'abc…');
  assert.equal(Array.from(clipChars('😀😀😀', 2)).join(''), '😀😀…');
});
