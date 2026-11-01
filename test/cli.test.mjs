// R14 cli 的 tombstone test：删掉 src/rooms/cli.mjs 或 scripts/cli.mjs ⇒ 本文件整片红。
//
// 用 --root 指向临时夹具（os.tmpdir），**不扫真实 $DSH_HOME**：
//   <root>/sessions/<scope>/<sid>/session.v4.jsonl.zstd   （多帧 zstd：首帧 header + 事件帧）
//   <root>/chess-context/sessions/<sid>/graph.json        （version 1）
// 断言：stats 的真实口径、dump 的 episode JSON、walk 的指针、index 的声明、以及「全程只读」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import { runCli, parseArgs, listSessionLogs, listGraphs, fallbackEpisode, readHeaderOnly } from '../src/rooms/cli.mjs';

const execFileAsync = promisify(execFile);
const SID = 'session-1234abcd-0000-4000-8000-000000000000';
const SCOPE = '--D-work-demo--';
const CWD = 'D:\\work\\demo';

const userEvent = {
  type: 'user/message',
  seq: 1,
  time: 1_700_000_001_000,
  data: { content: [{ type: 'text', text: '你的任务：实现统计命令（task-3）。记忆系统的索引要从棋谱派生。' }] },
};
const toolCall = {
  type: 'tool/call',
  seq: 2,
  time: 1_700_000_002_000,
  data: {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'bash',
    arguments: JSON.stringify({ command: 'git clone https://github.com/MYCF711/dsh-kifuin.git && npm add yaml' }),
  },
};
const toolResult = {
  type: 'tool/result',
  seq: 3,
  time: 1_700_000_003_000,
  data: {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: "[exit code: 1]\nError: Cannot find module 'yaml'" }] },
  },
};

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function buildFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-cli-'));
  const sessionDir = path.join(root, 'sessions', SCOPE, SID);
  mkdirSync(sessionDir, { recursive: true });

  const header = {
    type: 'session',
    version: 4,
    id: SID,
    createdAt: 1_700_000_000_000,
    cwd: CWD,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  };
  const log = Buffer.concat([
    frame(`${JSON.stringify(header)}\n`),
    frame(`${[userEvent, toolCall, toolResult].map((e) => JSON.stringify(e)).join('\n')}\n`),
  ]);
  writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), log);

  const graphDir = path.join(root, 'chess-context', 'sessions', SID);
  mkdirSync(graphDir, { recursive: true });
  const graph = {
    version: 1,
    sessionId: SID,
    cwd: 'D:\\DeepSeek Harness\\home\\profiles\\desktop',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
    nextNode: 3,
    nextEdge: 2,
    nodes: {
      n1: { id: 'n1', kind: 'user', seq: 1, text: '你的任务：实现统计命令（task-3）。', ts: 1_700_000_001_000 },
      n2: { id: 'n2', kind: 'agent', seq: 2, turn: 1, ts: 1_700_000_002_000 },
    },
    edges: {
      e1: {
        id: 'e1',
        from: 'n1',
        to: 'n2',
        action: 'bash(command=cd "D:/work/demo"; node scripts/cli.mjs stats)',
        result: 'failure',
        errorSnippet: "Error: Cannot find module 'yaml'",
        ts: 1_700_000_004_000,
      },
    },
    order: ['n1', 'n2'],
    stateIndex: {},
    rootUserNodeIds: ['n1'],
    checkpointSeq: 3,
    foldCount: 0,
  };
  writeFileSync(path.join(graphDir, 'graph.json'), JSON.stringify(graph, null, 2));
  return { root, sessionDir, graphDir };
}

function hashTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(`${path.relative(root, full)}:${st.size}:${createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 12)}`);
    }
  };
  walk(root);
  return out.sort().join('|');
}

let fixture;
test.before(() => { fixture = buildFixture(); });
test.after(() => { if (fixture?.root) rmSync(fixture.root, { recursive: true, force: true }); });

test('R14: stats —— 扫真实目录结构，输出日志数/棋谱数/解析成功率/时间范围', async () => {
  const res = await runCli(['stats', '--root', fixture.root, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const s = JSON.parse(res.stdout);

  assert.equal(s.root, path.resolve(fixture.root));
  assert.equal(s.logs.total, 1, '日志数');
  assert.equal(s.logs.headerOk, 1);
  assert.equal(s.logs.headerParseRate, 1, '首帧 header 解析率');
  assert.ok(s.logs.fullParseRate === 1 || s.logs.fullParseRate === null, 'R01 存在时 100%，缺失时 n/a');
  assert.equal(s.graphs.total, 1, '棋谱数');
  assert.equal(s.graphs.ok, 1);
  assert.equal(s.graphs.nodes, 2);
  assert.equal(s.graphs.edges, 1);
  assert.equal(s.episodes, 1);
  assert.ok(s.topics.total > 0, '真实抽出主题');
  assert.ok(s.topics.byKind.repo >= 1);
  assert.ok(s.logs.timeRange.from && s.logs.timeRange.to, '时间范围');
  assert.equal(s.logs.timeRange.from, new Date(1_700_000_000_000).toISOString());
  assert.equal(s.logs.timeRange.to, new Date(1_700_000_003_000).toISOString());
  assert.ok(Array.isArray(s.warnings));
});

test('R14: dump <sid> —— 输出契约 §2 的 episode JSON 与主题', async () => {
  const res = await runCli(['dump', 'session-1234abcd', '--root', fixture.root]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);

  const ep = out.episode;
  assert.equal(ep.sessionId, SID);
  assert.equal(ep.id, 'ep-1234abcd', 'ep-<sid8>');
  assert.equal(ep.scopeKey, 'w:d:/work/demo', 'scopeKey 用 header.cwd 规范化');
  assert.equal(ep.startedAt, 1_700_000_000_000);
  assert.equal(ep.lastEventAt, 1_700_000_003_000);
  assert.ok(ep.closure.logPath.endsWith('session.v4.jsonl.zstd'));
  assert.ok(ep.closure.graphPath.endsWith('graph.json'));
  assert.deepEqual(ep.threadIds, []);
  assert.equal(ep.state, 'archived');

  assert.equal(out.summary.episodeId, 'ep-1234abcd');
  assert.ok(out.topics.some((t) => t.kind === 'repo' && t.key === 'mycf711/dsh-kifuin'));
  assert.ok(out.topics.some((t) => t.kind === 'dependency' && t.key === 'yaml'));
  assert.ok(out.topics.some((t) => t.kind === 'error'));
});

test('R14: walk <term> —— 命中主题与相关棋谱指针', async () => {
  const res = await runCli(['walk', 'kifuin', '--root', fixture.root, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.term, 'kifuin');
  assert.ok(out.topics.length >= 1, '命中主题');
  assert.ok(out.topics.some((t) => t.kind === 'repo' && t.key.includes('kifuin')));
  assert.equal(out.matches[0].pointers[0].episode, 'ep-1234abcd', '指针指回棋谱');
  assert.match(out.matches[0].pointers[0].date, /^\d{4}-\d{2}-\d{2}$/);

  // 词面未命中不编造：返回空指针而不报错
  const miss = await runCli(['walk', '不存在的词', '--root', fixture.root, '--json']);
  assert.equal(miss.code, 0);
  assert.equal(JSON.parse(miss.stdout).matches.length, 0);
});

test('R14: index —— 渲染 index.md（含声明与每局一行）', async () => {
  const res = await runCli(['index', '--root', fixture.root]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^# 棋馆索引/m);
  assert.ok(res.stdout.includes('未列出 ≠ 不存在；完整清单见 index.md 树'));
  assert.match(res.stdout, /^- \d{4}-\d{2}-\d{2} ep-1234abcd · .* · fail=\d+ · topics=.* · links=\d+$/m);
});

test('R14: scripts/cli.mjs 可执行（子进程跑 stats --json）', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(import.meta.dirname, '..', 'scripts', 'cli.mjs'),
    'stats', '--root', fixture.root, '--json',
  ], { encoding: 'utf8' });
  const s = JSON.parse(stdout);
  assert.equal(s.logs.total, 1);
  assert.equal(s.graphs.ok, 1);
});

test('R14: 只读 —— 跑完全部命令，夹具一个字节都没变', async () => {
  const before = hashTree(fixture.root);
  await runCli(['stats', '--root', fixture.root]);
  await runCli(['dump', SID, '--root', fixture.root]);
  await runCli(['walk', 'yaml', '--root', fixture.root]);
  await runCli(['index', '--root', fixture.root]);
  assert.equal(hashTree(fixture.root), before, 'CLI 不写数据根');
});

test('R14: 错误语义 —— 缺参 / 未知命令 / root 不存在都给非零退出码', async () => {
  assert.equal((await runCli(['dump'])).code, 2);
  assert.equal((await runCli(['walk'])).code, 2);
  assert.equal((await runCli(['nope', '--root', fixture.root])).code, 2);
  const missing = await runCli(['stats', '--root', path.join(fixture.root, 'nope')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /root 不存在/);
  const notFound = await runCli(['dump', 'zzz-not-here', '--root', fixture.root]);
  assert.equal(notFound.code, 1);
  assert.match(notFound.stderr, /未找到会话/);
});

test('R14: 降级要如实标注 —— 坏日志不抛，成功率按实际统计', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-cli-bad-'));
  try {
    const dir = path.join(root, 'sessions', SCOPE, 'session-badc0de-0000-4000-8000-000000000000');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame at all'));
    const res = await runCli(['stats', '--root', root, '--json']);
    assert.equal(res.code, 0, '坏日志不抛');
    const s = JSON.parse(res.stdout);
    assert.equal(s.logs.total, 1);
    assert.equal(s.logs.headerOk, 0);
    assert.equal(s.logs.headerParseRate, 0, '成功率不造假');
    assert.equal(s.graphs.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R14: 参数与扫描的单元口径', () => {
  assert.deepEqual(parseArgs(['stats', '--root', 'x', '--json']), { cmd: 'stats', positional: [], flags: { root: 'x', json: true } });
  assert.deepEqual(parseArgs(['walk', '记忆', '--limit', '3']), { cmd: 'walk', positional: ['记忆'], flags: { limit: 3 } });
  assert.deepEqual(parseArgs([]).cmd, '');

  const { root } = fixture;
  assert.equal(listSessionLogs(root).length, 1);
  assert.equal(listGraphs(root).length, 1);

  const headerOnly = readHeaderOnly(listSessionLogs(root)[0].path);
  assert.equal(headerOnly.source, 'header-only');
  assert.equal(headerOnly.header.id, SID, '首帧降级也能拿到 header');

  const ep = fallbackEpisode({
    header: { id: SID, createdAt: 1000, cwd: CWD, agentPreset: 'standard', delegationDepth: 0 },
    events: [{ seq: 2, time: 2000 }, { seq: 5, time: 1500 }],
    logPath: 'log.zstd',
    graphPath: 'graph.json',
  });
  assert.equal(ep.id, 'ep-1234abcd');
  assert.equal(ep.firstEventAt, 1500);
  assert.equal(ep.lastEventAt, 2000);
  assert.equal(ep.timeSource, 'event');
  assert.equal(ep.closure.seqFrom, 2);
  assert.equal(ep.closure.seqTo, 5);
  assert.ok(ep.degraded.length > 0, '降级必须标注，不假装是 R00');
});
