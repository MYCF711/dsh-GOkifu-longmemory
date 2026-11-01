// R15 archive 管线的 tombstone test：删掉 scripts/archive.mjs（或 src/rooms/persist.mjs）⇒ 本文件整片红。
//
// 覆盖（AGENTS §11 R15、方案 §4.11、docs/数据契约.md §6）：
//   - 只读上游：入档前后 sessions/ + chess-context/ 的 sha256 完全不变
//   - 入库内容：episodes/manifest/index.md/派生目录；子代理会话 folded-into 父局、不参与建网
//   - 可搬迁：条目里没有绝对路径（来源路径相对 DSH_HOME）、manifest.pathPolicy=relative
//   - 幂等：连跑两次 ⇒ 第二次 0 新增 / 0 变更、checksums 与 manifest 字节完全相同
//   - dry-run：只统计不写盘（连目录都不创建）
//   - 原件缺失：sourceStatus:"missing"，条目仍在、state 不变（不失效）
//   - 崩溃恢复：journal 尾行截断 ⇒ rebuild 仍可跑、verify 仍绿
//   - CLI：node scripts/archive.mjs --root ... --dry-run --json（真实子进程）
//
// 夹具放 os.tmpdir（**不碰真实 $DSH_HOME**）；不新增依赖。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, unlinkSync, appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runArchive, formatSummary, parseArgs } from '../scripts/archive.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { STORE_DIRS } from '../src/rooms/persist.mjs';

const execFileAsync = promisify(execFile);
const ARCHIVE_SCRIPT = fileURLToPath(new URL('../scripts/archive.mjs', import.meta.url));

const T0 = 1_700_000_000_000; // 夹具事件时间（固定的过去）
const T_ARCHIVE = 1_709_000_000_000; // 入档时钟（固定，便于断言幂等）

const S1 = 'session-11111111-1111-4111-8111-111111111111';
const S2 = 'session-22222222-2222-4222-8222-222222222222';
const S3 = 'session-33333333-3333-4333-8333-333333333333';
const S4 = 'session-99999999-9999-4999-8999-999999999999'; // 子代理会话（父局 = S1）
const REPO = 'MYCF711/dsh-kifuin';
const SCOPE = '--D-work-demo--';

function zframe(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function events(repo) {
  return [
    {
      type: 'user/message',
      seq: 1,
      time: T0 + 1_000,
      data: { content: [{ type: 'text', text: `你的任务：把 ${repo} 的记忆索引修好；不要忘了时间戳（occurredAt）。` }] },
    },
    {
      type: 'tool/call',
      seq: 2,
      time: T0 + 2_000,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'bash',
        arguments: JSON.stringify({ command: `git clone https://github.com/${repo}.git && npm add yaml` }),
      },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: T0 + 3_000,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: "[exit code: 1]\nError: Cannot find module 'yaml'" }] },
      },
    },
  ];
}

function writeSession(root, { sid, repo = REPO, cwd = 'D:\\work\\demo', parent = null, depth = 0 }) {
  const dir = path.join(root, 'sessions', SCOPE, sid);
  mkdirSync(dir, { recursive: true });
  const header = {
    type: 'session',
    version: 4,
    id: sid,
    createdAt: T0,
    cwd,
    isSeeded: false,
    delegationDepth: depth,
    agentPreset: 'standard',
    ...(parent ? { parentSession: parent, origin: 'subagent' } : {}),
  };
  const body = events(repo);
  writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat([zframe(`${JSON.stringify(header)}\n`), zframe(`${body.map((e) => JSON.stringify(e)).join('\n')}\n`)]),
  );
  return { sid, dir, logPath: path.join(dir, 'session.v4.jsonl.zstd') };
}

function writeGraph(root, sid, file = 'src/rooms/persist.mjs') {
  const dir = path.join(root, 'chess-context', 'sessions', sid);
  mkdirSync(dir, { recursive: true });
  const graph = {
    version: 1,
    sessionId: sid,
    cwd: 'D:\\DeepSeek Harness\\home\\profiles\\desktop',
    createdAt: T0,
    updatedAt: T0 + 5_000,
    nextNode: 3,
    nextEdge: 2,
    nodes: {
      n1: { id: 'n1', kind: 'user', seq: 1, text: '你的任务：把索引修好', ts: T0 + 1_000 },
      n2: { id: 'n2', kind: 'agent', seq: 2, turn: 1, ts: T0 + 2_000 },
    },
    edges: {
      e1: {
        id: 'e1',
        from: 'n1',
        to: 'n2',
        action: `bash(command=node --test test/persist.test.mjs # ${file})`,
        result: 'failure',
        errorSnippet: "Error: Cannot find module 'yaml'",
        ts: T0 + 4_000,
      },
    },
    order: ['n1', 'n2'],
    stateIndex: {},
    rootUserNodeIds: ['n1'],
    checkpointSeq: 3,
    foldCount: 0,
  };
  writeFileSync(path.join(dir, 'graph.json'), `${JSON.stringify(graph, null, 2)}\n`);
  return { sid, graphPath: path.join(dir, 'graph.json'), deltaPath: path.join(dir, 'graph.json.delta.jsonl') };
}

function buildFixture(root) {
  const s1 = writeSession(root, { sid: S1 });
  const s2 = writeSession(root, { sid: S2 });
  const s3 = writeSession(root, { sid: S3, repo: 'other/another-repo' });
  const s4 = writeSession(root, { sid: S4, parent: S1, depth: 1 });
  writeGraph(root, S1);
  writeGraph(root, S2);
  return { root, s1, s2, s3, s4 };
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

function walkFiles(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of names) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

let fixture;
let storeRoot;

test.before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-archive-'));
  fixture = buildFixture(root);
  storeRoot = path.join(root, 'memory-context');
});
test.after(() => {
  if (fixture?.root) rmSync(fixture.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1 · 首次入档
// ---------------------------------------------------------------------------

test('archive: 首次入档 —— 只读上游、写 sidecar、manifest 可校验', async () => {
  const before = hashTree(path.join(fixture.root, 'sessions')) + hashTree(path.join(fixture.root, 'chess-context'));

  const summary = await runArchive({ dataRoot: fixture.root, storeRoot, now: T_ARCHIVE });

  assert.equal(summary.dryRun, false);
  assert.equal(summary.logs.total, 4, '四个会话日志');
  assert.equal(summary.episodes.total, 4, '四条棋谱（含子代理局）');
  assert.equal(summary.episodes.archived, 3, '独立成谱 3 局（S1/S2/S3）');
  assert.equal(summary.episodes.folded, 1, '子代理会话归并进父局');
  assert.equal(summary.graphs.loaded, 2, '两张棋谱读入');
  assert.ok(summary.derived.topics > 0, '抽出主题');
  assert.ok(summary.derived.links >= 1, 'S1/S2 共享 repo 主题 ⇒ 至少一条相关边');
  assert.equal(summary.verify.ok, true, JSON.stringify(summary.verify.errors));

  // 上游一个字节都没变（只读）
  const after = hashTree(path.join(fixture.root, 'sessions')) + hashTree(path.join(fixture.root, 'chess-context'));
  assert.equal(after, before, 'archive 不得改写会话日志/棋谱');

  // 目录 + manifest
  for (const dir of STORE_DIRS) assert.ok(existsSync(path.join(storeRoot, dir)), `${dir}/ 存在`);
  const manifest = JSON.parse(readFileSync(path.join(storeRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.user, 'owner');
  assert.equal(manifest.pathPolicy, 'relative');
  assert.equal(manifest.counts.episodes, 4);
  assert.equal(manifest.checksums['episodes/ep-11111111.json'] !== undefined, true, 'manifest 覆盖每个条目');
  assert.ok(manifest.files >= 4 + summary.derived.topics + summary.derived.links);

  // index.md 是派生索引，带"未列出 ≠ 不存在"声明
  const index = readFileSync(path.join(storeRoot, 'index.md'), 'utf8');
  assert.ok(index.includes('未列出 ≠ 不存在；完整清单见 index.md 树'));
  assert.match(index, /^- \d{4}-\d{2}-\d{2} ep-11111111 · .* · fail=\d+/m);
  assert.ok(!index.includes('ep-99999999'), '归并进父局的子代理局不进索引树');

  // 条目结构：可搬迁 + 原件状态
  const store = createStore({ root: storeRoot });
  const ep1 = store.get('episodes', 'ep-11111111');
  assert.equal(ep1.scopeKey, 'w:d:/work/demo');
  assert.equal(ep1.closure.logPath, `sessions/${SCOPE}/${S1}/session.v4.jsonl.zstd`, '来源路径相对 DSH_HOME');
  assert.equal(ep1.closure.graphPath, `chess-context/sessions/${S1}/graph.json`);
  assert.equal(ep1.sourceRoot, 'DSH_HOME');
  assert.equal(ep1.sourceStatus, 'present');
  assert.equal(ep1.recordedAt, T_ARCHIVE, 'recordedAt = 入档时钟（第二时钟）');
  assert.deepEqual(ep1.closure.nodeIds.sort(), ['n1', 'n2'], '闭包带棋谱节点 id');
  assert.ok(ep1.closure.seqFrom <= ep1.closure.seqTo);

  const folded = store.get('episodes', 'ep-99999999');
  assert.equal(folded.state, 'folded-into:ep-11111111', '子代理局 folded-into 父局');
  assert.equal(folded.delegationDepth, 1);
  assert.deepEqual(folded.topics, [], '归并局不参与建网（只收 depth=0）');

  // 全库没有绝对路径（搬库契约 §4.11 规则 2）
  const needle = path.resolve(fixture.root);
  for (const file of walkFiles(storeRoot)) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(needle), `${path.relative(storeRoot, file)} 里出现了本机绝对路径`);
  }
});

// ---------------------------------------------------------------------------
// 2 · 幂等
// ---------------------------------------------------------------------------

test('archive: 幂等 —— 连跑两次，第二次 0 新增、checksums 与 manifest 完全相同', async () => {
  const manifestPath = path.join(storeRoot, 'manifest.json');
  const journalPath = path.join(storeRoot, 'journal', 'archive.jsonl');
  const before = {
    manifest: readFileSync(manifestPath, 'utf8'),
    checksums: JSON.parse(readFileSync(manifestPath, 'utf8')).checksums,
    journalLines: readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).length,
    tree: hashTree(storeRoot),
  };

  const second = await runArchive({ dataRoot: fixture.root, storeRoot, now: T_ARCHIVE + 3_600_000 });

  assert.equal(second.added, 0, `第二次不得新增/变更条目：${JSON.stringify(second.writes)}`);
  assert.equal(second.manifest.changed, false, '无变更不重写 manifest');
  assert.equal(second.verify.ok, true);

  const after = {
    manifest: readFileSync(manifestPath, 'utf8'),
    checksums: JSON.parse(readFileSync(manifestPath, 'utf8')).checksums,
    journalLines: readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).length,
    tree: hashTree(storeRoot),
  };
  assert.deepEqual(after.checksums, before.checksums, 'checksums 必须完全相同');
  assert.equal(after.manifest, before.manifest, 'manifest 字节完全相同（updatedAt 不漂）');
  assert.equal(after.journalLines, before.journalLines, '无变更不追加 journal');
  assert.equal(after.tree, before.tree, '整个库逐字节不变（同输入重放同结果）');
  assert.equal(second.counts.episodes, 4);
});

// ---------------------------------------------------------------------------
// 3 · dry-run
// ---------------------------------------------------------------------------

test('archive: --dry-run 只统计不写盘（连目录都不创建）', async () => {
  const dryRoot = path.join(fixture.root, 'dry-store');
  const summary = await runArchive({ dataRoot: fixture.root, storeRoot: dryRoot, dryRun: true, now: T_ARCHIVE });

  assert.equal(summary.dryRun, true);
  assert.ok(summary.wouldWrite > 0, '预估应有写入量');
  assert.equal(summary.plan.episodes.added, 4);
  assert.ok(summary.plan.topics.added > 0);
  assert.equal(existsSync(dryRoot), false, 'dry-run 不得创建记忆库目录');
  assert.ok(!existsSync(path.join(dryRoot, 'manifest.json')));

  const text = formatSummary(summary);
  assert.ok(text.includes('dry-run'), '输出明确标注 dry-run');
  assert.ok(text.includes('预估写入'));
});

// ---------------------------------------------------------------------------
// 4 · 原件缺失不失效
// ---------------------------------------------------------------------------

test('archive: 原件被删 ⇒ sourceStatus:"missing"，条目仍在、state 不变', async () => {
  const logPath = path.join(fixture.root, 'sessions', SCOPE, S2, 'session.v4.jsonl.zstd');
  const backup = readFileSync(logPath);
  unlinkSync(logPath);
  try {
    const summary = await runArchive({ dataRoot: fixture.root, storeRoot, now: T_ARCHIVE + 7_200_000 });
    const store = createStore({ root: storeRoot });
    const ep2 = store.get('episodes', 'ep-22222222');
    assert.ok(ep2, '原件没了，条目仍在（记忆是记录，不是原件）');
    assert.equal(ep2.sourceStatus, 'missing');
    assert.equal(ep2.state, 'archived', 'missing ≠ invalidated');
    assert.equal(summary.verify.ok, true, '缺原件不影响校验');
    assert.ok(summary.episodes.total >= 3, '其他局照常入档');
  } finally {
    writeFileSync(logPath, backup);
  }
});

// ---------------------------------------------------------------------------
// 5 · 崩溃恢复
// ---------------------------------------------------------------------------

test('archive: journal 尾行被截断 ⇒ rebuild 仍可跑、verify 仍绿', async () => {
  // 先让库与本机原件一致（上一个用例删过日志又还原）
  await runArchive({ dataRoot: fixture.root, storeRoot, now: T_ARCHIVE + 9_000_000 });

  const journalPath = path.join(storeRoot, 'journal', 'archive.jsonl');
  appendFileSync(journalPath, '{"v":1,"op":"put","kind":"episodes","id":"ep-1111');

  const store = createStore({ root: storeRoot });
  const journal = store.readJournal();
  assert.equal(journal.dropped.partialTail, 1, '截断尾行被丢弃');

  const rb = await store.rebuild({ at: T_ARCHIVE + 10_000_000 });
  assert.ok(!rb.refused, 'journal 坏尾不该拒绝 rebuild');
  assert.equal(rb.episodes, 4);
  const v = store.verify();
  assert.equal(v.ok, true, JSON.stringify(v.errors));

  // rebuild 的派生产物与 archive 的完全相同 ⇒ 再入档 0 变更（同输入同输出）
  const again = await runArchive({ dataRoot: fixture.root, storeRoot, now: T_ARCHIVE + 10_000_001 });
  assert.equal(again.added, 0, `rebuild 与 archive 的派生产物必须一致：${JSON.stringify(again.writes)}`);
});

// ---------------------------------------------------------------------------
// 6 · CLI（真实子进程；--root 指向临时夹具，--store 指向临时目录）
// ---------------------------------------------------------------------------

test('archive: CLI --dry-run --json 退出 0 且不写盘', async () => {
  const storeCli = path.join(fixture.root, 'cli-dry-store');
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    ARCHIVE_SCRIPT, '--root', fixture.root, '--store', storeCli, '--dry-run', '--json',
  ]);
  assert.equal(stderr.trim(), '', stderr);
  const summary = JSON.parse(stdout);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.plan.episodes.added, 4);
  assert.equal(existsSync(storeCli), false, 'dry-run 不得写盘');
});

test('archive: CLI 真跑 + 默认 store 路径 + 参数解析', async () => {
  const cliStore = path.join(fixture.root, 'cli-store');
  const { stdout } = await execFileAsync(process.execPath, [
    ARCHIVE_SCRIPT, '--root', fixture.root, '--store', cliStore,
  ]);
  assert.ok(stdout.includes('verify：OK'), stdout);
  const store = createStore({ root: cliStore });
  assert.equal(store.verify().ok, true);
  assert.equal(store.counts().episodes, 4);

  assert.deepEqual(parseArgs(['--root', 'x', '--store=y', '--dry-run', '--json']).flags, {
    root: 'x', store: 'y', dryRun: true, json: true,
  });
  assert.equal(parseArgs([]).flags.dryRun, undefined);

  // 默认 store = <root>/memory-context
  const summary = await runArchive({ dataRoot: fixture.root, dryRun: true, now: T_ARCHIVE });
  assert.equal(summary.storeRoot, path.join(path.resolve(fixture.root), 'memory-context'));
});
