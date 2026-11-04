// M5 六轴报告的 tombstone test：删掉 scripts/m5-report.mjs ⇒ 本文件整片红。
//
// 覆盖（task-13 验收 / 方案 §8.2 / docs/对标-Hindsight.md §2）：
//   - 六轴齐全，每轴都有 `{value, unit, n, status}`，status ∈ measured|not-live|not-consumed
//   - A6 provenance 覆盖率 = 100%（渲染行都带 `ep-…` + 日期 + `seq`）
//   - A5 crossScope 越界 = 0（三重计数：walk 自拒 / 卡内计数 / 独立反查 ep 的 scope）
//   - A1 无 validity ⇒ `not-consumed` 且 value=null（**不写 0**）；有注入且 validity 被覆盖 ⇒ measured
//   - A2 无数据根 ⇒ not-consumed；有数据根 ⇒ measured（1σ 近似）
//   - A3 = not-live（读插件默认配置与单测条数，不跑宿主）
//   - A4 = 实际跑的 run 数（n）+ p50/p90/p95/max + tokens p50
//   - 空 store 不抛；只读（跑前跑后 store 的 sha256 不变）
//   - CLI：`--json` 结构 + `--evidence` 写 markdown（写到 tmp，不写仓库）
//
// 夹具全部在 os.tmpdir；不写 <DSH_HOME>；不新增依赖；零模型调用。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  runM5, measureA1, measureA3, measureA2b, runPipeline, buildSignalTexts, formatM5Report, renderM5Markdown,
  parseArgs, runCli, AXIS_IDS, AXIS_STATUSES,
} from '../scripts/m5-report.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { scopeKeyFromPath } from '../src/rooms/inject.mjs';
import { runH1, runEval } from '../scripts/eval.mjs';

const T0 = 1_700_000_000_000;
const ARCHIVE_TS = 1_709_000_000_000;
const TOPIC_KEY = 'src/rooms/x.mjs';

let tmp;
test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-m5-'));
});
test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具：真 store + 真日志 + 真棋谱
// ---------------------------------------------------------------------------

function zframe(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function writeSessionLog(root, { sid, events }) {
  const dir = path.join(root, 'sessions', '--D-work-demo--', sid);
  mkdirSync(dir, { recursive: true });
  const header = { type: 'session', version: 4, id: sid, createdAt: T0, cwd: 'D:\\work\\demo', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat([zframe(`${JSON.stringify(header)}\n`), zframe(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)]),
  );
  return `sessions/--D-work-demo--/${sid}/session.v4.jsonl.zstd`;
}

function writeGraph(root, { sid, failures }) {
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
      errorSnippet: f,
      evidence: { start: i + 1 },
      ts: T0 + (i + 1) * 1_000,
    };
  });
  writeFileSync(path.join(dir, 'graph.json'), `${JSON.stringify({
    version: 1, sessionId: sid, createdAt: T0, updatedAt: T0 + 9_000, nextNode: 3, nextEdge: failures.length + 1,
    nodes: { n1: { id: 'n1', kind: 'user', seq: 1, text: '跑一下', ts: T0 + 1_000 }, n2: { id: 'n2', kind: 'agent', seq: 2, turn: 1, ts: T0 + 2_000 } },
    edges, order: ['n1', 'n2'], stateIndex: {}, rootUserNodeIds: ['n1'], checkpointSeq: 2, foldCount: 0,
  }, null, 2)}\n`);
  return `chess-context/sessions/${sid}/graph.json`;
}

function putEpisode(storeRoot, { id, startedAt, scopeKey, logPath, graphPath }) {
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS });
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
    signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: ['bash'] },
    threadIds: [],
    state: 'archived',
    sourceRoot: 'DSH_HOME',
    sourceStatus: 'present',
    topics: [{
      id: 't:file:11111111',
      kind: 'file',
      key: TOPIC_KEY,
      count: 1,
      occurrences: [{ seq: 3, quote: `node ${TOPIC_KEY}`, occurredAt: startedAt + 3_000 }],
    }],
  }, { at: ARCHIVE_TS });
}

function putTopic(storeRoot, scopeKey) {
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS });
  store.put('topics', {
    id: 't:file:11111111',
    kind: 'file',
    key: TOPIC_KEY,
    df: 2,
    firstSeenAt: T0,
    lastSeenAt: T0 + 10_000,
    scopeKey,
  }, { at: ARCHIVE_TS });
}

function putClaim(storeRoot, scopeKey, { validity = null, id = 'c-11111111' } = {}) {
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS });
  store.put('claims', {
    id,
    kind: 'antipattern',
    text: `${TOPIC_KEY} 在干净环境会报 Cannot find module`,
    scopeKey,
    threadIds: [],
    state: 'observed',
    support: [{ episode: 'ep-aaaaaaa1', seq: 3, quote: 'Cannot find module', occurredAt: T0 + 3_000 }],
    counter: [],
    validity: validity ?? { type: 'none', value: null },
    preconditions: [],
    occurredAt: T0 + 3_000,
    recordedAt: ARCHIVE_TS,
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
  }, { at: ARCHIVE_TS });
}

function buildFixture({ withValidity = false, withClaims = true } = {}) {
  const root = mkdtempSync(path.join(tmp, 'corpus-'));
  const storeRoot = path.join(root, 'memory-context');
  const scopeKey = scopeKeyFromPath(root);
  const sids = ['session-aaaaaaa1-0000-4000-8000-000000000001', 'session-bbbbbbb2-0000-4000-8000-000000000002'];
  const events = [
    { type: 'user/message', seq: 1, time: T0 + 1_000, data: { content: [{ type: 'text', text: '跑一下测试' }] } },
    { type: 'tool/call', seq: 2, time: T0 + 2_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"node scripts/x.mjs"}' } },
    { type: 'tool/result', seq: 3, time: T0 + 3_000, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
  ];
  const log1 = writeSessionLog(root, { sid: sids[0], events });
  const log2 = writeSessionLog(root, { sid: sids[1], events });
  const graph1 = writeGraph(root, { sid: sids[0], failures: ["Error: Cannot find module 'yaml'"] });
  const graph2 = writeGraph(root, { sid: sids[1], failures: ["Error: Cannot find module 'yaml'", "Error: EPERM: operation not permitted"] });

  putEpisode(storeRoot, { id: 'ep-aaaaaaa1', startedAt: T0 + 10_000, scopeKey, logPath: log1, graphPath: graph1 });
  putEpisode(storeRoot, { id: 'ep-bbbbbbb2', startedAt: T0 + 20_000, scopeKey, logPath: log2, graphPath: graph2 });
  putTopic(storeRoot, scopeKey);
  if (withClaims) {
    putClaim(storeRoot, scopeKey, {
      validity: withValidity ? { type: 'file', value: 'docs/not-there.md' } : null,
      id: 'c-11111111',
    });
  }
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS });
  store.writeManifest({ at: ARCHIVE_TS });
  return { root, storeRoot, scopeKey };
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

function assertAxisShape(axis, id) {
  assert.ok(axis, `${id} 缺失`);
  for (const key of ['value', 'unit', 'n', 'status', 'caveat']) {
    assert.ok(key in axis, `${id} 缺字段 ${key}`);
  }
  assert.ok(AXIS_STATUSES.includes(axis.status), `${id} 状态非法：${axis.status}`);
  assert.ok(Number.isFinite(axis.n) && axis.n >= 0, `${id} n 非法`);
  if (axis.status === 'measured') assert.ok(axis.value !== null, `${id} measured 必须有值`);
}

// ---------------------------------------------------------------------------
// 六轴
// ---------------------------------------------------------------------------

test('m5: 六轴齐全 —— 每轴 {value,unit,n,status,caveat}，状态合法', async () => {
  const fixture = buildFixture({ withValidity: true });
  const report = await runM5({ storeRoot: fixture.storeRoot, dataRoot: fixture.root, workspace: fixture.root, runs: 6, cards: 4, signals: 3, now: ARCHIVE_TS });

  assert.deepEqual(report.order, [...AXIS_IDS], '六轴顺序固定 A1–A6');
  for (const id of AXIS_IDS) assertAxisShape(report.axes[id], id);

  // A3 是唯一允许 not-live 的轴（能力在、没上线）
  assert.equal(report.axes.A3.status, 'not-live');
  assert.equal(report.axes.A3.value, 0);
  assert.ok(report.axes.A3.n > 0, 'A3 的 n = 单测条数');

  // A4 用真实跑的 run 数
  assert.equal(report.axes.A4.status, 'measured');
  assert.equal(report.axes.A4.n, 6);
  assert.ok(Number.isFinite(report.axes.A4.detail.p95));
  assert.ok(report.axes.A4.detail.tokensP50 >= 0);

  // 文本表 + markdown 都覆盖六轴
  const text = formatM5Report(report);
  for (const id of AXIS_IDS) assert.ok(text.includes(id), `文本表缺 ${id}`);
  const md = renderM5Markdown(report);
  assert.match(md, /## 1 · 六轴总表/);
  assert.match(md, /\| \*\*A6\*\*/);
  assert.match(md, /复现命令/);
});

test('m5: A6 provenance 覆盖率 100%（渲染行都带 ep-…+日期+seq）', async () => {
  const fixture = buildFixture({ withValidity: true });
  const report = await runM5({ storeRoot: fixture.storeRoot, dataRoot: fixture.root, workspace: fixture.root, runs: 6, cards: 4, signals: 3, now: ARCHIVE_TS });
  const a6 = report.axes.A6;
  assert.equal(a6.status, 'measured', a6.caveat);
  assert.ok(a6.n > 0, '必须真的渲染出卡片行（否则这条断言没意义）');
  assert.equal(a6.value, 1, `provenance 覆盖应为 100%：${a6.caveat}`);
  assert.equal(a6.detail.provenanced, a6.detail.renderedLines);
});

test('m5: A5 作用域——越界行 0（三重计数同时为 0）', async () => {
  const fixture = buildFixture({ withValidity: true });
  const report = await runM5({ storeRoot: fixture.storeRoot, dataRoot: fixture.root, workspace: fixture.root, runs: 6, cards: 4, signals: 3, now: ARCHIVE_TS });
  const a5 = report.axes.A5;
  assert.equal(a5.status, 'measured', a5.caveat);
  assert.equal(a5.value, 0, '同域跑卡不应出现越界行');
  assert.equal(a5.detail.leakLines, 0);
  assert.equal(a5.detail.cardCrossScope, 0, '卡内跨域计数应为 0（同域语料）');
});

test('m5: A2 —— 有数据根 ⇒ measured（LOO + 1σ）；无数据根 ⇒ not-consumed 且 value=null', async () => {
  const fixture = buildFixture();
  const withRoot = await runM5({ storeRoot: fixture.storeRoot, dataRoot: fixture.root, workspace: fixture.root, runs: 4, cards: 2, signals: 2, now: ARCHIVE_TS });
  const a2 = withRoot.axes.A2;
  assert.equal(a2.status, 'measured', a2.caveat);
  assert.ok(a2.n > 0);
  assert.ok(a2.value >= 0 && a2.value <= 1);
  assert.ok(a2.detail.sigma > 0, '必须给 1σ 近似');

  const withoutRoot = await runM5({ storeRoot: fixture.storeRoot, dataRoot: null, workspace: fixture.root, runs: 4, cards: 2, signals: 2, now: ARCHIVE_TS });
  assert.equal(withoutRoot.axes.A2.status, 'not-consumed');
  assert.equal(withoutRoot.axes.A2.value, null, '没数据时不许写 0');
});

test('m5: A1 —— 无 validity ⇒ not-consumed（value=null）；有覆盖 ⇒ measured', async () => {
  // ① 真跑：语料无 validity ⇒ not-consumed
  const fixture = buildFixture({ withValidity: false });
  const report = await runM5({ storeRoot: fixture.storeRoot, dataRoot: fixture.root, workspace: fixture.root, runs: 4, cards: 2, signals: 3, now: ARCHIVE_TS });
  const a1 = report.axes.A1;
  assert.equal(a1.status, 'not-consumed', `无 validity 时必须 not-consumed：${a1.caveat}`);
  assert.equal(a1.value, null, 'not-consumed 不许写 0');
  assert.equal(a1.detail.validityCoverage.withValidity, 0);

  // ② 已知答案（注入 h1 report，验证映射本身）：stale 1 / 注入 5 ⇒ 0.2，status=measured
  const mapped = await measureA1({
    storeRoot: fixture.storeRoot,
    workspace: fixture.root,
    crossScopeLeakRate: 0,
    h1Report: {
      staleTransferRate: 0.2,
      staleInjected: 1,
      injected: 5,
      postGateStaleRate: 0,
      validityCoverage: { withValidity: 2, rendered: 2 },
      signals: 2,
      cardsWithContent: 1,
      zeroInjection: 1,
    },
  });
  assert.equal(mapped.status, 'measured');
  // 2026-11-04（S16）：主值取闸门后 —— 这才是「错误记忆真的到了模型」；闸前的 0.2 仍留在 detail 里
  assert.equal(mapped.value, 0);
  assert.equal(mapped.detail.staleTransferRate, 0.2);
  assert.equal(mapped.n, 5, '没有 postGateInjected 时 n 退回注入条数');
  assert.equal(mapped.detail.validityCoverage.ratio, 1);
  assert.equal(mapped.detail.crossScopeLeakRate, 0);

  // ③ validity 覆盖率为 0 ⇒ 0% 是空转的，必须标出来
  const vacuous = await measureA1({
    storeRoot: fixture.storeRoot,
    workspace: fixture.root,
    crossScopeLeakRate: 0,
    h1Report: { staleTransferRate: 0, staleInjected: 0, injected: 9, validityCoverage: { withValidity: 8, rendered: 0 } },
  });
  assert.equal(vacuous.status, 'measured');
  assert.equal(vacuous.value, 0);
  assert.equal(vacuous.detail.vacuous, true);
  assert.match(vacuous.caveat, /空转/);

  // ④ 闸拦下的也算锻炼 ⇒ 不再空转，且 0% 应被解释为"闸有效"（2026-11-03）
  const blocked = await measureA1({
    storeRoot: fixture.storeRoot,
    workspace: fixture.root,
    crossScopeLeakRate: 0,
    h1Report: { staleTransferRate: 0, staleInjected: 0, injected: 9, validityCoverage: { withValidity: 8, rendered: 0, exercised: 8 } },
  });
  assert.equal(blocked.detail.vacuous, false);
  assert.equal(blocked.detail.validityCoverage.ratio, 1);
  assert.match(blocked.caveat, /闸拦下/);
});

test('m5: A3 —— 读插件事实（默认关 + 单测条数），不跑宿主', () => {
  const a3 = measureA3();
  assert.equal(a3.status, 'not-live');
  assert.equal(a3.value, 0);
  assert.equal(a3.unit, 'rate');
  assert.equal(a3.detail.enabledDefault, true, '零配置默认开启（2026-11-02 裁定）');
  assert.equal(a3.detail.shadowDefault, false);
  assert.ok(a3.detail.unitTests > 0, '必须数到单测条数');
  assert.match(a3.caveat, /not|未|单测/);
});

test('m5: 空 store —— 六轴都有状态、不抛、不写 0', async () => {
  const root = mkdtempSync(path.join(tmp, 'empty-'));
  const storeRoot = path.join(root, 'memory-context'); // 不存在
  const report = await runM5({ storeRoot, dataRoot: null, workspace: root, runs: 3, cards: 2, signals: 2, now: ARCHIVE_TS });
  assert.equal(report.storeFound, false);
  for (const id of AXIS_IDS) {
    const axis = report.axes[id];
    assertAxisShape(axis, id);
    if (axis.status === 'not-consumed') assert.equal(axis.value, null, `${id} not-consumed 不许写 0`);
  }
  assert.equal(report.axes.A1.status, 'not-consumed');
  assert.equal(report.axes.A2.status, 'not-consumed');
  assert.equal(report.axes.A5.status, 'not-consumed');
  assert.equal(report.axes.A6.status, 'not-consumed');
  assert.equal(readdirSync(root).includes('memory-context'), false, '不许创建 store 目录');
});

test('m5: 只读 —— 跑完 store 的 sha256 完全不变', async () => {
  const fixture = buildFixture({ withValidity: true });
  const before = hashTree(fixture.storeRoot);
  await runM5({ storeRoot: fixture.storeRoot, dataRoot: fixture.root, workspace: fixture.root, runs: 6, cards: 4, signals: 3, now: ARCHIVE_TS });
  assert.equal(hashTree(fixture.storeRoot), before, 'm5-report 不得写 store');
});

test('m5: 纯工具 —— 信号集来自主题库 df 降序；runPipeline 计数自洽', () => {
  const fixture = buildFixture();
  const store = createStore({ root: fixture.storeRoot });
  const texts = buildSignalTexts(store, 5);
  assert.equal(texts.length, 5);
  assert.equal(texts[0], TOPIC_KEY, 'df 最高的主题 key 排第一');

  const pipeline = runPipeline({ store, workspace: fixture.root, texts, runs: 3, now: ARCHIVE_TS });
  const empty = buildSignalTexts(createStore({ root: path.join(tmp, 'nope') }), 3);
  assert.equal(empty.length, 3, '空库也有兜底信号（保证 runs 次可跑）');
  const emptyPipeline = runPipeline({ store: createStore({ root: path.join(tmp, 'nope') }), workspace: fixture.root, texts: empty, runs: 2, now: ARCHIVE_TS });
  assert.equal(emptyPipeline.stats.n, 2);
  assert.equal(emptyPipeline.zeroInjection, 2, '空库 ⇒ 全部零注入');
  assert.equal(emptyPipeline.cards.every((c) => c.card.section === null), true);
  assert.equal(pipeline.walkCrossScope, 0, '同域语料不产生跨域拒绝');
});

test('m5: CLI —— --json 六轴结构 + --evidence 写 markdown + 参数解析', async () => {
  const fixture = buildFixture({ withValidity: true });
  const res = await runCli(['--store', fixture.storeRoot, '--root', fixture.root, '--workspace', fixture.root, '--runs', '4', '--cards', '2', '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  for (const id of AXIS_IDS) assertAxisShape(report.axes[id], id);

  const evidencePath = path.join(tmp, `evidence-${Date.now()}.md`);
  const res2 = await runCli(['--store', fixture.storeRoot, '--root', fixture.root, '--workspace', fixture.root, '--runs', '4', '--cards', '2', '--evidence', evidencePath]);
  assert.equal(res2.code, 0, res2.stderr);
  assert.ok(res2.stdout.includes(`证据已写：${evidencePath}`));
  const md = readFileSync(evidencePath, 'utf8');
  assert.match(md, /# M5 六轴报告/);
  assert.match(md, /A1·负迁移|A1 · 负迁移/);

  assert.deepEqual(parseArgs(['--store', 'a', '--root=b', '--workspace', 'c', '--runs=7', '--json']).flags, {
    store: 'a', root: 'b', workspace: 'c', runs: 7, json: true,
  });
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /六轴/);
});

test('m5: 复用口径 —— A2/A1 的底层入口和 eval.mjs 是同一个（不重写）', async () => {
  const fixture = buildFixture();
  const report = await runM5({ storeRoot: fixture.storeRoot, dataRoot: fixture.root, workspace: fixture.root, runs: 4, cards: 2, signals: 2, now: ARCHIVE_TS });
  const direct = await runEval({ dataRoot: fixture.root, storeRoot: fixture.storeRoot, source: 'both', now: ARCHIVE_TS });
  assert.equal(report.axes.A2.value, direct.primary.totals.rate, 'A2 必须等于 eval.mjs 的 LOO 结果');
  assert.equal(report.axes.A2.n, direct.primary.totals.signatures);

  const h1 = await runH1({ storeRoot: fixture.storeRoot, workspace: fixture.root, now: ARCHIVE_TS, signals: 3 });
  assert.ok(Number.isFinite(h1.injected), 'runH1 返回 injected');
});

test('m5: A2b 失分归因 —— 空库时全部记 notRetrieved（不把检索失败说成文本问题）', () => {
  const store = createStore({ root: path.join(tmp, 'empty-a2b') });
  store.ensureDirs();
  const SIG = 'json decode error expecting value line 1';
  const report = {
    primary: {
      rows: [
        { episode: 'ep-prior1', scopeKey: 'w:d:/x', startedAt: T0, repeatSignatures: [SIG], novelSignatures: [] },
        { episode: 'ep-later1', scopeKey: 'w:d:/x', startedAt: T0 + 1000, repeatSignatures: [SIG], novelSignatures: [] },
      ],
    },
  };
  const frozen = { items: [{ sig: SIG, scopeKey: 'w:d:/x', episode: 'ep-later1', prior: ['ep-prior1'], sameScope: true }] };
  const r = measureA2b({ store, report, splitAt: T0 + 500, frozen });
  assert.equal(r.n, 1);
  assert.equal(r.specificHits, 0, '空库里召回不到 ⇒ 严格 0');
  assert.deepEqual(r.missBy, { covered: 0, notRetrieved: 1 }, '要归因成"未检索到"，不能算成文本不匹配');
  assert.equal(typeof r.recallSpecific, 'number');
});
