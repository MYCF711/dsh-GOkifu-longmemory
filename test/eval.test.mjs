// R15/M5 eval 的 tombstone test：删掉 scripts/eval.mjs ⇒ 本文件整片红。
//
// 覆盖（方案 §2.2 V1 / §8.2、task-11 验收）：
//   - 签名规范化：去绝对路径/行号/时间戳/十六进制；同错不同路径 ⇒ 同签名；不同错 ⇒ 不同签名
//   - LOO（纯函数）：E1(A) / E2(A+B) / E3(B) ⇒ E2 的 A=repeat、B=novel；E3 的 B=repeat
//   - 时间顺序：future 局不泄给更早的局（严格 startedAt <）；同一时刻互不可见
//   - 空 store：不抛、rate=null、coverage=null（不编造 0）
//   - 端到端：store + 日志 + 棋谱（R01/R02/R03 真跑）→ 逐局 repeat/novel 与 memorySize
//   - 事件侧兜底：没有棋谱的局用 `[exit code ≠ 0]` 取失败
//   - 只读：跑前跑后 store 与 dataRoot 的 sha256 完全不变
//   - CLI：--json 结构、--evidence 写 markdown（写到 tmp，不写仓库）
//
// 夹具全部在 os.tmpdir；不写 <DSH_HOME>；不新增依赖；不调用模型。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  runEval, evaluateLoo, normalizeErrorSignature, isDegenerateSignature, pickErrorLine,
  eventFailureSignals, parseArgs, runCli, renderEvidenceMarkdown, formatReport,
} from '../scripts/eval.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T0 = 1_700_000_000_000;
const ARCHIVE_TS = 1_709_000_000_000;

let tmp;
let seq = 0;

test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-eval-'));
});
test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 纯函数：签名规范化
// ---------------------------------------------------------------------------

test('eval: 签名规范化 —— 去路径/行号/时间戳/十六进制', () => {
  const a = normalizeErrorSignature("Error: Cannot find module 'yaml'\n    at D:\\work\\a.js:12:5");
  const b = normalizeErrorSignature("Error: Cannot find module 'yaml'\n    at E:/other/place/b.js:480:91");
  assert.equal(a, b, '同错不同路径/行号 ⇒ 同签名');
  assert.ok(!a.includes('d:\\work'), '绝对路径被抹掉');
  assert.ok(a.includes('<path>'));
  assert.ok(a.includes('<line>'));

  const c = normalizeErrorSignature('2026-11-02T03:10:00.123Z ERROR commit deadbeefcafe failed (pid 1793559833867)');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(c), 'ISO 时间戳被抹掉');
  assert.ok(!c.includes('deadbeefcafe'), '长十六进制被抹掉');
  assert.ok(!c.includes('1793559833867'), 'epoch ms 被抹掉');
  assert.ok(c.includes('<ts>') && c.includes('<hex>'));

  assert.notEqual(
    normalizeErrorSignature("Error: Cannot find module 'yaml'"),
    normalizeErrorSignature("Error: EPERM: operation not permitted, open 'x.txt'"),
    '不同的错误原文 ⇒ 不同签名',
  );
  assert.equal(normalizeErrorSignature(''), '');
  assert.equal(normalizeErrorSignature(null), '');
  assert.equal(normalizeErrorSignature('ERROR   A'), normalizeErrorSignature('error a'), '大小写/空白归一');
});

test('eval: 退化签名不算"坑"（避免 repeat 虚高）', () => {
  for (const sig of ['', '(no output)', 'no output', 'traceback (most recent call last):', '<path>', 'a']) {
    assert.equal(isDegenerateSignature(sig), true, `应判退化：${JSON.stringify(sig)}`);
  }
  assert.equal(isDegenerateSignature('error: cannot find module \'yaml\''), false);
});

test('eval: 事件侧失败 —— 只认以 [exit code: N≠0] 结尾的 tool/result', () => {
  const events = [
    { type: 'tool/result', seq: 3, time: T0 + 1, data: { message: { content: [{ type: 'text', text: "boom\nError: Cannot find module 'yaml'\n[exit code: 1]" }] } } },
    { type: 'tool/result', seq: 4, time: T0 + 2, data: { message: { content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] } } },
    // 中间出现 exit code（引用文件内容）不算失败：必须**结尾**
    { type: 'tool/result', seq: 5, time: T0 + 3, data: { message: { content: [{ type: 'text', text: 'const x = "[exit code: 1]"\n[exit code: 0]' }] } } },
    { type: 'user/message', seq: 6, time: T0 + 4, data: { message: { content: [{ type: 'text', text: '[exit code: 1]' }] } } },
    // 没有退出码标记的工具结果（read 之类）——不算失败，只计入 dropped
    { type: 'tool/result', seq: 7, time: T0 + 5, data: { message: { content: [{ type: 'text', text: 'file contents, no exit marker' }] } } },
  ];
  const { signals, dropped } = eventFailureSignals(events);
  assert.equal(signals.length, 1, '只有第一条是失败');
  assert.equal(signals[0].seq, 3);
  assert.ok(signals[0].signature.includes('cannot find module'));
  assert.equal(signals[0].source, 'event');
  assert.equal(dropped.noExitCode, 1, '不带退出码的结果计入 dropped');

  assert.equal(pickErrorLine('ls output\nError: bad\nmore'), 'Error: bad');
  assert.equal(pickErrorLine('line1\nline2'), 'line2', '没有错误词时取最后一行');
});

// ---------------------------------------------------------------------------
// 纯函数：LOO
// ---------------------------------------------------------------------------

const SIG_A = "error: cannot find module 'yaml'";
const SIG_B = 'error: eperm: operation not permitted';

test('eval: LOO —— E1(A) / E2(A+B) / E3(B)', () => {
  const report = evaluateLoo([
    { id: 'ep-1', startedAt: T0 + 3_000, scopeKey: 'w:a', signatures: ['B'] },
    { id: 'ep-2', startedAt: T0 + 2_000, scopeKey: 'w:a', signatures: ['A', 'B'] },
    { id: 'ep-3', startedAt: T0 + 1_000, scopeKey: 'w:a', signatures: ['A'] },
  ]);
  const byId = new Map(report.rows.map((r) => [r.episode, r]));

  assert.deepEqual(report.rows.map((r) => r.episode), ['ep-3', 'ep-2', 'ep-1'], '按 startedAt 升序');
  assert.equal(byId.get('ep-3').repeat, 0, '最早的一局只能 novel');
  assert.equal(byId.get('ep-3').memorySize, 0);
  assert.equal(byId.get('ep-2').repeat, 1, 'A 已在更早的局出现 ⇒ repeat');
  assert.equal(byId.get('ep-2').novel, 1, 'B 是新坑 ⇒ novel');
  assert.deepEqual(byId.get('ep-2').repeatSignatures, ['A']);
  assert.deepEqual(byId.get('ep-2').novelSignatures, ['B']);
  assert.equal(byId.get('ep-1').repeat, 1, 'B 已在更早的局出现 ⇒ repeat');
  assert.equal(byId.get('ep-1').rate, 1);

  assert.equal(report.totals.repeat, 2);
  assert.equal(report.totals.novel, 2);
  assert.equal(report.totals.rate, 0.5, 'repeat ÷ (repeat+novel)');
  assert.equal(report.totals.distinctSignatures, 2);
  assert.equal(report.coverage.evaluated, 3);
  assert.equal(report.coverage.ratio, 1);
});

test('eval: LOO —— 时间顺序反转时不算 repeat（不用未来信息）', () => {
  // 同一签名，先出现的是"更晚"的那局 ⇒ 更早的局不能拿它当 memory
  const report = evaluateLoo([
    { id: 'ep-early', startedAt: T0 + 1_000, signatures: ['A'] },
    { id: 'ep-late', startedAt: T0 + 2_000, signatures: ['A'] },
  ]);
  const [early, late] = report.rows;
  assert.equal(early.episode, 'ep-early');
  assert.equal(early.repeat, 0, '未来局不算 memory');
  assert.equal(early.novel, 1);
  assert.equal(late.repeat, 1, '更早的局出现过 ⇒ repeat');
  assert.equal(late.memorySize, 1);

  // 同一时刻：严格 `<` ⇒ 互不可见，两边都 novel
  const same = evaluateLoo([
    { id: 'ep-x', startedAt: T0, signatures: ['A'] },
    { id: 'ep-y', startedAt: T0, signatures: ['A'] },
  ]);
  assert.deepEqual(same.rows.map((r) => r.repeat), [0, 0], '同一时刻互不可见');
  assert.equal(same.totals.rate, 0);
});

test('eval: LOO —— 局内去重、按 scope 分层、坑榜', () => {
  const report = evaluateLoo([
    { id: 'ep-1', startedAt: T0 + 1, scopeKey: 'w:a', signatures: ['A', 'A', 'B'] }, // 重复签名只算一次
    { id: 'ep-2', startedAt: T0 + 2, scopeKey: 'w:b', signatures: ['A'] },
    { id: 'ep-3', startedAt: T0 + 3, scopeKey: 'w:b', signatures: [] },
  ]);
  assert.equal(report.rows[0].signatures, 2, '局内签名去重');
  assert.equal(report.rows[2].rate, null, '没有失败装不进分母（不是 0%）');
  assert.equal(report.coverage.evaluated, 2);
  assert.equal(report.coverage.ratio, 2 / 3);

  const scopeB = report.byScope.find((s) => s.scopeKey === 'w:b');
  assert.equal(scopeB.episodes, 2);
  assert.equal(scopeB.evaluated, 1);
  assert.equal(scopeB.repeat, 1);
  assert.equal(scopeB.rate, 1);

  const top = report.topSignatures.find((t) => t.signature === 'A');
  assert.equal(top.episodes, 2, 'A 出现在两局 ⇒ 坑榜');
  assert.deepEqual(top.episodeIds, ['ep-1', 'ep-2']);
});

// ---------------------------------------------------------------------------
// 夹具：真 store + 真日志 + 真棋谱
// ---------------------------------------------------------------------------

function zframe(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function writeSessionLog(root, { sid, cwd = 'D:\\work\\demo', events }) {
  const dir = path.join(root, 'sessions', '--D-work-demo--', sid);
  mkdirSync(dir, { recursive: true });
  const header = { type: 'session', version: 4, id: sid, createdAt: T0, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat([zframe(`${JSON.stringify(header)}\n`), zframe(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)]),
  );
  return `sessions/--D-work-demo--/${sid}/session.v4.jsonl.zstd`;
}

function writeGraphFixture(root, { sid, failures }) {
  const dir = path.join(root, 'chess-context', 'sessions', sid);
  mkdirSync(dir, { recursive: true });
  const edges = {};
  failures.forEach((f, i) => {
    edges[`e${i + 1}`] = {
      id: `e${i + 1}`,
      from: 'n1',
      to: 'n2',
      action: 'bash(command=node scripts/x.mjs)',
      result: 'failure',
      errorSnippet: f.errorSnippet,
      evidence: { start: f.seq ?? i + 1 },
      ts: T0 + (f.seq ?? i + 1) * 1_000,
    };
  });
  const graph = {
    version: 1,
    sessionId: sid,
    createdAt: T0,
    updatedAt: T0 + 10_000,
    nextNode: 3,
    nextEdge: failures.length + 1,
    nodes: { n1: { id: 'n1', kind: 'user', seq: 1, text: '任务', ts: T0 + 1_000 }, n2: { id: 'n2', kind: 'agent', seq: 2, turn: 1, ts: T0 + 2_000 } },
    edges,
    order: ['n1', 'n2'],
    stateIndex: {},
    rootUserNodeIds: ['n1'],
    checkpointSeq: 2,
    foldCount: 0,
  };
  writeFileSync(path.join(dir, 'graph.json'), `${JSON.stringify(graph, null, 2)}\n`);
  return `chess-context/sessions/${sid}/graph.json`;
}

function putEpisode(storeRoot, { id, startedAt, scopeKey = 'w:d:/work/demo', logPath, graphPath }) {
  seq += 1;
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS + seq });
  store.ensureDirs();
  store.put('episodes', {
    id,
    sessionId: `session-${id.replace(/^ep-/, '')}-0000-4000-8000-000000000000`,
    scopeKey,
    startedAt,
    endedAt: startedAt + 600_000,
    firstEventAt: startedAt + 1_000,
    lastEventAt: startedAt + 500_000,
    recordedAt: ARCHIVE_TS,
    timeSource: 'event',
    delegationDepth: 0,
    closure: { logPath: logPath ?? null, graphPath: graphPath ?? null, seqFrom: 1, seqTo: 9, eventCount: 9, nodeIds: [], edgeIds: [] },
    l0: '',
    l1: '',
    signals: { failures: 0, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    threadIds: [],
    state: 'archived',
    sourceRoot: 'DSH_HOME',
    sourceStatus: 'present',
    topics: [],
  }, { at: ARCHIVE_TS + seq });
  store.writeManifest({ at: ARCHIVE_TS + seq });
}

function buildCorpus() {
  const root = mkdtempSync(path.join(tmp, 'corpus-'));
  const storeRoot = path.join(root, 'memory-context');
  const sids = ['session-aaaaaaa1-0000-4000-8000-000000000001', 'session-bbbbbbb2-0000-4000-8000-000000000002', 'session-ccccccc3-0000-4000-8000-000000000003'];

  const events = (sid) => [
    { type: 'user/message', seq: 1, time: T0 + 1_000, data: { content: [{ type: 'text', text: '跑一下测试' }] } },
    { type: 'tool/call', seq: 2, time: T0 + 2_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"node scripts/x.mjs"}' } },
    { type: 'tool/result', seq: 3, time: T0 + 3_000, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
  ];

  const log1 = writeSessionLog(root, { sid: sids[0], events: events(sids[0]) });
  const log2 = writeSessionLog(root, { sid: sids[1], events: events(sids[1]) });
  const log3 = writeSessionLog(root, { sid: sids[2], events: events(sids[2]) });

  const graph1 = writeGraphFixture(root, { sid: sids[0], failures: [{ errorSnippet: "Error: Cannot find module 'yaml'", seq: 3 }] });
  const graph2 = writeGraphFixture(root, {
    sid: sids[1],
    failures: [
      { errorSnippet: "Error: Cannot find module 'yaml'", seq: 3 },
      { errorSnippet: "Error: EPERM: operation not permitted, open 'D:\\x\\y.txt'", seq: 5 },
    ],
  });
  const graph3 = writeGraphFixture(root, { sid: sids[2], failures: [{ errorSnippet: "Error: EPERM: operation not permitted, open 'E:\\z\\w.txt'", seq: 4 }] });

  putEpisode(storeRoot, { id: 'ep-aaaaaaa1', startedAt: T0 + 10_000, logPath: log1, graphPath: graph1 });
  putEpisode(storeRoot, { id: 'ep-bbbbbbb2', startedAt: T0 + 20_000, logPath: log2, graphPath: graph2 });
  putEpisode(storeRoot, { id: 'ep-ccccccc3', startedAt: T0 + 30_000, logPath: log3, graphPath: graph3 });

  return { root, storeRoot, sids, log1, graph3, graph2 };
}

function hashTree(dir) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      const full = path.join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.sort().join('|');
}

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

test('eval: 端到端 —— store + 日志 + 棋谱（R01/R02/R03 真跑）→ 逐局 repeat/novel', async () => {
  const corpus = buildCorpus();
  const before = { store: hashTree(corpus.storeRoot), data: hashTree(corpus.root) };

  const report = await runEval({ dataRoot: corpus.root, storeRoot: corpus.storeRoot, now: ARCHIVE_TS });

  assert.equal(report.corpus.rootEpisodes, 3);
  const rows = new Map(report.primary.rows.map((r) => [r.episode, r]));
  assert.equal(rows.get('ep-aaaaaaa1').repeat, 0, '第一局没有更早的局');
  assert.equal(rows.get('ep-aaaaaaa1').memorySize, 0);
  assert.equal(rows.get('ep-bbbbbbb2').repeat, 1, "yaml 坑 ⇒ repeat");
  assert.equal(rows.get('ep-bbbbbbb2').novel, 1, 'EPERM 坑 ⇒ novel');
  assert.equal(rows.get('ep-ccccccc3').repeat, 1, 'EPERM（不同路径但同签名）⇒ repeat');
  assert.equal(rows.get('ep-ccccccc3').novel, 0);
  assert.equal(rows.get('ep-ccccccc3').rate, 1);

  assert.equal(report.primary.totals.repeat, 2);
  assert.equal(report.primary.totals.novel, 2);
  assert.equal(report.primary.totals.rate, 0.5);
  assert.equal(report.primary.coverage.ratio, 1);
  assert.equal(report.primary.rows[0].failureSource, 'edge', '有棋谱 ⇒ 走 R03 边失败');

  // 每局明细带 provenance（哪条源、多少次失败）
  const detail = report.perEpisode.find((p) => p.episode === 'ep-bbbbbbb2');
  assert.equal(detail.edgeFailures, 2);
  assert.equal(detail.signatures, 2);
  assert.equal(detail.graphPresent, true);
  assert.equal(detail.sourceStatus, 'present');

  // 只读：store 与 dataRoot 一个字节都没变
  assert.equal(hashTree(corpus.storeRoot), before.store, 'eval 不得写 store');
  assert.equal(hashTree(corpus.root), before.data, 'eval 不得写数据根（日志/棋谱）');

  // 文本表 + 证据 markdown
  const text = formatReport(report);
  assert.match(text, /repeatFailureRate/);
  assert.match(text, /repeat 2 \/ novel 2/);
  const md = renderEvidenceMarkdown(report);
  assert.match(md, /# M5 机械评测/);
  assert.match(md, /分子/);
  assert.match(md, /分母/);
  assert.match(md, /复现命令/);
  assert.ok(md.includes('| 1 |'), '逐局表');
});

test('eval: 没有棋谱的局 —— 事件侧 `[exit code ≠ 0]` 兜底', async () => {
  const root = mkdtempSync(path.join(tmp, 'corpus-event-'));
  const storeRoot = path.join(root, 'memory-context');
  const sid = 'session-ddddddd4-0000-4000-8000-000000000004';
  const logPath = writeSessionLog(root, {
    sid,
    events: [
      { type: 'user/message', seq: 1, time: T0 + 1_000, data: { content: [{ type: 'text', text: '跑一下' }] } },
      { type: 'tool/call', seq: 2, time: T0 + 2_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } },
      { type: 'tool/result', seq: 3, time: T0 + 3_000, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: "npm ERR!\nError: Cannot find module 'yaml'\n[exit code: 1]" }] } } },
    ],
  });
  putEpisode(storeRoot, { id: 'ep-ddddddd4', startedAt: T0 + 10_000, logPath, graphPath: null });

  const report = await runEval({ dataRoot: root, storeRoot, now: ARCHIVE_TS });
  assert.equal(report.corpus.rootEpisodes, 1);
  const row = report.primary.rows[0];
  assert.equal(row.failureSource, 'event', '没有棋谱 ⇒ 回退事件侧');
  assert.equal(row.signatures, 1);
  assert.ok(row.novelSignatures[0].includes('cannot find module'));
  assert.equal(report.perEpisode[0].graphPresent, false);
  assert.ok(report.perEpisode[0].reasons.includes('no-graph-path'));
});

test('eval: 空 store —— 不抛，rate/coverage 为 null（不编造 0）', async () => {
  const root = mkdtempSync(path.join(tmp, 'corpus-empty-'));
  const storeRoot = path.join(root, 'memory-context'); // 不存在
  const report = await runEval({ dataRoot: root, storeRoot, now: ARCHIVE_TS });
  assert.equal(report.corpus.rootEpisodes, 0);
  assert.deepEqual(report.primary.rows, []);
  assert.equal(report.primary.totals.rate, null);
  assert.equal(report.primary.coverage.ratio, null);
  assert.equal(report.primary.totals.repeat, 0);
  assert.equal(report.storeFound, false);
  assert.match(formatReport(report), /n\/a/, '文本表把 null 写成 n/a，不写 0');

  // 没有 store 目录时也不许创建目录（只读）
  await runEval({ dataRoot: root, storeRoot, now: ARCHIVE_TS });
  assert.equal(readdirSync(root).includes('memory-context'), false, 'eval 不得创建 store');
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('eval: CLI —— --json 结构 + --evidence 写 markdown + 参数解析', async () => {
  const corpus = buildCorpus();
  const res = await runCli(['--root', corpus.root, '--store', corpus.storeRoot, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.primary.source, 'both');
  assert.equal(report.primary.totals.rate, 0.5);
  assert.ok(report.corpus.variants.edge && report.corpus.variants.event && report.corpus.variants.both, '三口径全给');
  assert.equal(report.perEpisode.length, 3);
  assert.equal(report.definition.episodeClock, 'startedAt（会话 header.createdAt，epoch ms）');

  const evidencePath = path.join(tmp, `evidence-${Date.now()}.md`);
  const res2 = await runCli(['--root', corpus.root, '--store', corpus.storeRoot, '--source', 'edge', '--evidence', evidencePath]);
  assert.equal(res2.code, 0, res2.stderr);
  assert.ok(res2.stdout.includes(`证据已写：${evidencePath}`));
  const md = readFileSync(evidencePath, 'utf8');
  assert.match(md, /LOO repeatFailureRate/);
  assert.match(md, /\| `edge` \|/);

  assert.deepEqual(parseArgs(['--root', 'a', '--store=b', '--source', 'event', '--json']).flags, {
    root: 'a', store: 'b', source: 'event', json: true,
  });
  assert.equal(parseArgs([]).flags.source, undefined);

  const bad = await runCli(['--root', corpus.root, '--source', 'nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--source/);

  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /零模型调用/);
});
