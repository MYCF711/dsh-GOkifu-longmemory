/**
 * R02 tombstone test —— 删掉 graphread（基线 + delta 回放）会让这些断言全红：
 * 只读 `graph.json` 会少一回合（基线边数 < 回放边数）、坏尾会把半帧当最新、版本不认识会静默降级。
 *
 * 数据来源：真实 `$DSH_HOME/chess-context/sessions/<sid>/graph.json`（只读；不写 <DSH_HOME>）。
 * 真实样本 3 张（2026-11-02 02:45 实测，均为已冻结棋谱：目录 mtime 停在 2026-11-01 22:xx–22:30）：
 *   A = session-1286ce28-…   基线 141 节点 / 155 边，delta 43 帧 → 172 节点 / 188 边，failure 边 6
 *   B = 3a50f4d2-…           基线 1 节点 / 0 边，   delta 41 帧 → 23 节点 / 26 边，failure 边 1
 *   C = fa84bf69-…           基线 51 节点 / 77 边，delta 0 帧（纯基线对照），failure 边 4
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadGraphAt,
  applyDelta,
  decodeDeltaFrames,
  checksum31,
  baseHashOf,
  rebuildStateIndex,
  GRAPH_VERSION,
} from '../src/rooms/graphread.mjs';

const HOME = process.env.DSH_HOME ?? '';
const CORPUS = HOME ? join(HOME, 'chess-context', 'sessions') : '';
const SAMPLE_A = 'session-00000003-0000-4000-8000-000000000003';
const SAMPLE_B = '3a50f4d2-8df2-4fc6-9a1d-6f69d16e594c';
const SAMPLE_C = 'fa84bf69-0e4b-422c-aed9-85b8c2462359';

const graphPath = (sid) => join(CORPUS, sid, 'graph.json');
const hasSample = (sid) => Boolean(CORPUS) && existsSync(graphPath(sid));

/* ── 夹具：合成基线 + 合法帧 ─────────────────────────────── */

function minimalGraph(overrides = {}) {
  return {
    version: 1,
    sessionId: 'fixture',
    cwd: '/fixture',
    createdAt: 1,
    updatedAt: 1,
    nextNode: 1,
    nextEdge: 1,
    nodes: {},
    edges: {},
    order: [],
    stateIndex: {},
    rootUserNodeIds: [],
    checkpointSeq: null,
    foldCount: 0,
    lastFoldTotalTokens: 0,
    foldMarks: [],
    lastFoldUsage: null,
    ...overrides,
  };
}

function encodeFrame(baseHash, delta) {
  const body = JSON.stringify(delta);
  return `${baseHash}\t${checksum31(body)}\t${body}\n`;
}

/** 写一个夹具目录；`lines` 里放 delta 对象（自动编码）或已拼好的原始行字符串（用于造坏尾）。 */
function fixture(t, { graph = minimalGraph(), lines = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kifuin-t2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const basePath = join(dir, 'graph.json');
  const deltaPath = `${basePath}.delta.jsonl`;
  const text = JSON.stringify(graph, null, 1);
  writeFileSync(basePath, text, 'utf8');
  const baseHash = baseHashOf(text).slice(0, 16);
  if (lines.length > 0) {
    writeFileSync(deltaPath, lines.map((l) => (typeof l === 'string' ? l : encodeFrame(baseHash, l))).join(''), 'utf8');
  }
  return { dir, basePath, deltaPath, baseHash };
}

const node = (id, extra = {}) => ({ id, kind: 'agent', seq: 1, worldHash: `w${id}`, constraintHash: `c${id}`, via: null, ts: 10, ...extra });
const edge = (id, extra = {}) => ({ id, from: null, to: null, intent: '', action: `bash(command=${id})`, result: 'untested', evidence: { start: 1, end: 1 }, ts: 10, ...extra });

/* ── 真实样本 ─────────────────────────────────────────────── */

test('真实样本 A：43 帧回放后节点/边 ≥ 基线，且基线之外真的长出了节点与边', { skip: !hasSample(SAMPLE_A) }, () => {
  const baseText = readFileSync(graphPath(SAMPLE_A), 'utf8');
  const base = JSON.parse(baseText);
  const r = loadGraphAt({ basePath: graphPath(SAMPLE_A) });

  assert.ok(r.graph, '棋谱必须读出来');
  assert.equal(r.corrupt, false);
  assert.equal(r.missing, false);
  assert.equal(r.graph.version, GRAPH_VERSION);
  assert.equal(r.baseHash, baseHashOf(baseText).slice(0, 16), 'baseHash 必须是基线 sha256 前 16 位');
  assert.ok(r.frames >= 1, `至少要回放一帧，实际 ${r.frames}`);
  assert.equal(r.truncated, false, '已冻结棋谱不应有坏尾');

  const baseNodes = Object.keys(base.nodes ?? {}).length;
  const baseEdges = Object.keys(base.edges ?? {}).length;
  const nodes = Object.keys(r.graph.nodes ?? {}).length;
  const edges = Object.keys(r.graph.edges ?? {}).length;
  assert.ok(nodes >= baseNodes, `节点数 ${nodes} 不得少于基线 ${baseNodes}`);
  assert.ok(edges >= baseEdges, `边数 ${edges} 不得少于基线 ${baseEdges}`);
  // 只 JSON.parse 基线 = 少一回合；回放必须比基线严格更多。
  assert.ok(edges > baseEdges, `delta 未回放：${edges} 条边 未超过基线 ${baseEdges}`);

  // 失败边确实存在（R03 的真实素材，见 extract.test.mjs）
  const failures = Object.values(r.graph.edges ?? {}).filter((e) => e.result === 'failure');
  assert.ok(failures.length >= 1, '该棋谱应含 failure 边');
});

test('真实样本 B：基线 0 条边 → 回放后长出边（"直接 JSON.parse 少一回合"的极端样本）', { skip: !hasSample(SAMPLE_B) }, () => {
  const base = JSON.parse(readFileSync(graphPath(SAMPLE_B), 'utf8'));
  const r = loadGraphAt({ basePath: graphPath(SAMPLE_B) });
  assert.equal(r.truncated, false);
  assert.ok(r.frames >= 1, `至少要回放一帧，实际 ${r.frames}`);
  const baseEdges = Object.keys(base.edges ?? {}).length;
  const edges = Object.keys(r.graph.edges ?? {}).length;
  assert.equal(baseEdges, 0, `该基线应无边，实际 ${baseEdges}`);
  assert.ok(edges > 0, '回放后必须有边');
  assert.ok(Object.keys(r.graph.nodes ?? {}).length > Object.keys(base.nodes ?? {}).length, '回放后节点必须多于基线');
});

test('真实样本 C：没有 delta（0 字节）时只读基线，结果与基线逐字一致', { skip: !hasSample(SAMPLE_C) }, () => {
  const base = JSON.parse(readFileSync(graphPath(SAMPLE_C), 'utf8'));
  const r = loadGraphAt({ basePath: graphPath(SAMPLE_C) });
  assert.equal(r.frames, 0);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.graph.edges, base.edges, '无 delta 时不得改动基线');
  assert.deepEqual(r.graph.nodes, base.nodes);
});

test('真实样本：回放幂等（同一批帧再应用一次，图不变）', { skip: !hasSample(SAMPLE_A) || !hasSample(SAMPLE_B) }, () => {
  for (const sid of [SAMPLE_A, SAMPLE_B]) {
    const basePath = graphPath(sid);
    const r = loadGraphAt({ basePath });
    const deltaText = readFileSync(`${basePath}.delta.jsonl`, 'utf8');
    const { frames, truncated } = decodeDeltaFrames(deltaText, r.baseHash);
    assert.equal(truncated, false);
    assert.equal(frames.length, r.frames, '两次解码帧数必须一致');
    const again = structuredClone(r.graph);
    for (const f of frames) applyDelta(again, f);
    assert.deepEqual(again, r.graph, `${sid}: 再回放一次必须得到同一张图`);
  }
});

/* ── 合成夹具：语义 ───────────────────────────────────────── */

test('夹具：upsert 覆盖 + del* 删除 + order 追加去重 + scalars 白名单', (t) => {
  const { basePath } = fixture(t, {
    graph: minimalGraph({ nodes: { n1: node('n1') }, edges: { e1: edge('e1') }, order: ['n1'] }),
    lines: [
      {
        v: 1,
        nodes: { n2: node('n2') },
        edges: { e1: edge('e1', { result: 'failure', errorSnippet: 'boom' }) },
        delNodes: [],
        delEdges: [],
        orderAppend: ['n2', 'n2'],
        orderDrop: [],
        scalars: { updatedAt: 99, nextNode: 3, nextEdge: 2, foldCount: 1, sessionId: '不许改' },
      },
      { v: 1, nodes: {}, edges: {}, delNodes: ['n1'], delEdges: [], orderAppend: [], orderDrop: ['n1'], scalars: {} },
    ],
  });
  const r = loadGraphAt({ basePath });
  assert.equal(r.frames, 2);
  assert.equal(r.graph.nodes.n1, undefined, 'delNodes 必须删掉节点');
  assert.equal(r.graph.nodes.n2.id, 'n2');
  assert.equal(r.graph.edges.e1.result, 'failure');
  assert.deepEqual(r.graph.order, ['n2'], 'orderAppend 去重 + orderDrop 生效');
  assert.equal(r.graph.updatedAt, 99);
  assert.equal(r.graph.nextNode, 3);
  assert.equal(r.graph.foldCount, 1);
  assert.equal(r.graph.sessionId, 'fixture', '帧不得改白名单之外的字段');
});

test('夹具：stateIndex 是派生数据，按 order 重建（同哈希取首现、pending 跳过）', (t) => {
  const { basePath } = fixture(t, {
    graph: minimalGraph({ nodes: { n1: node('n1', { worldHash: 'W', constraintHash: 'C' }) }, order: ['n1'] }),
    lines: [
      {
        v: 1,
        nodes: {
          n2: node('n2', { worldHash: 'W', constraintHash: 'C' }),
          n3: node('n3', { worldHash: 'pending', constraintHash: 'C' }),
        },
        edges: {},
        orderAppend: ['n2', 'n3'],
        scalars: {},
      },
    ],
  });
  const r = loadGraphAt({ basePath });
  assert.deepEqual(r.graph.stateIndex, { 'W/C': 'n1' });
  const g = structuredClone(r.graph);
  rebuildStateIndex(g);
  assert.deepEqual(g.stateIndex, r.graph.stateIndex, '重建必须幂等');
});

test('夹具：回放幂等（同一帧应用两次 == 一次）', (t) => {
  const { basePath } = fixture(t, {
    graph: minimalGraph(),
    lines: [{ v: 1, nodes: { n1: node('n1') }, edges: { e1: edge('e1') }, orderAppend: ['n1'], scalars: { updatedAt: 5 } }],
  });
  const r = loadGraphAt({ basePath });
  const g = structuredClone(r.graph);
  applyDelta(g, decodeDeltaFrames(readFileSync(`${basePath}.delta.jsonl`, 'utf8'), r.baseHash).frames[0]);
  assert.deepEqual(g, r.graph);
});

/* ── 坏尾：就地截断，不把半帧当最新 ───────────────────────── */

test('坏尾：半写行（没有两个制表符）→ 返回前缀 + truncated/malformed-frame', (t) => {
  const { basePath } = fixture(t, {
    graph: minimalGraph(),
    lines: [
      { v: 1, nodes: { n1: node('n1') }, edges: {}, orderAppend: ['n1'], scalars: {} },
      'garbage-without-tabs\n',
    ],
  });
  const r = loadGraphAt({ basePath });
  assert.equal(r.truncated, true);
  assert.equal(r.reason, 'malformed-frame');
  assert.equal(r.frames, 1, '只回放成功的前缀');
  assert.equal(Object.keys(r.graph.nodes).length, 1);
});

test('坏尾：校验不合（帧体被改）→ truncated/checksum', (t) => {
  const { basePath, baseHash } = fixture(t, { graph: minimalGraph(), lines: [{ v: 1, nodes: { n1: node('n1') }, edges: {}, scalars: {} }] });
  const tampered = `${baseHash}\t0\t{"v":1,"nodes":{"n9":{}}}\n`;
  writeFileSync(`${basePath}.delta.jsonl`, tampered, 'utf8');
  const r = loadGraphAt({ basePath });
  assert.equal(r.truncated, true);
  assert.equal(r.reason, 'checksum');
  assert.equal(r.frames, 0);
  assert.equal(r.graph.nodes.n9, undefined, '校验不过的帧一条都不许进图');
});

test('坏尾：基线哈希不匹配（旧基线留下的帧）→ 整段忽略 + truncated/base-mismatch', (t) => {
  const { basePath } = fixture(t, {
    graph: minimalGraph(),
    lines: [
      { v: 1, nodes: { n1: node('n1') }, edges: {}, orderAppend: ['n1'], scalars: {} },
      '0123456789abcdef\t0\t{"v":1,"nodes":{}}\n',
    ],
  });
  const r = loadGraphAt({ basePath });
  assert.equal(r.truncated, true);
  assert.equal(r.reason, 'base-mismatch');
  assert.equal(r.frames, 1, '前缀帧仍然有效');
  assert.equal(Object.keys(r.graph.nodes).length, 1);
});

test('坏尾：帧 JSON 断掉 → truncated/bad-json', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kifuin-t2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const basePath = join(dir, 'graph.json');
  const text = JSON.stringify(minimalGraph(), null, 1);
  writeFileSync(basePath, text, 'utf8');
  const baseHash = baseHashOf(text).slice(0, 16);
  const body = '{"v":1,"nodes":{'; // 断在这里
  writeFileSync(`${basePath}.delta.jsonl`, `${baseHash}\t${checksum31(body)}\t${body}\n`, 'utf8');
  const r = loadGraphAt({ basePath });
  assert.equal(r.truncated, true);
  assert.equal(r.reason, 'bad-json');
  assert.equal(r.frames, 0);
});

test('坏尾：truncated 为真时 reason 必须非空（不许"静默截断"）', (t) => {
  const { basePath } = fixture(t, { graph: minimalGraph(), lines: ['broken\n'] });
  const r = loadGraphAt({ basePath });
  assert.equal(r.truncated, true);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

/* ── 版本与缺失 ───────────────────────────────────────────── */

test('版本未知：基线 version=2 → 抛 graphread: unsupported version（fail-closed）', (t) => {
  const { basePath } = fixture(t, { graph: minimalGraph({ version: 2 }) });
  assert.throws(() => loadGraphAt({ basePath }), /graphread: unsupported version 2/);
});

test('版本未知：delta 帧 v=2 → 抛 graphread: unsupported delta version', (t) => {
  const { basePath } = fixture(t, {
    graph: minimalGraph(),
    lines: [{ v: 1, nodes: {}, edges: {}, scalars: {} }, { v: 2, nodes: {}, edges: {}, scalars: {} }],
  });
  assert.throws(() => loadGraphAt({ basePath }), /graphread: unsupported delta version 2/);
});

test('基线缺失 → {graph:null, missing:true}，不抛（库扫描时"没棋谱"是常态）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kifuin-t2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = loadGraphAt({ basePath: join(dir, 'nope', 'graph.json') });
  assert.equal(r.graph, null);
  assert.equal(r.missing, true);
  assert.equal(r.reason, 'missing-base');
  assert.equal(r.truncated, false);
});

test('基线损坏 → {graph:null, corrupt:true}，不抛但必须立旗（不许降级成空图）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kifuin-t2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 's'), { recursive: true });
  const basePath = join(dir, 's', 'graph.json');
  writeFileSync(basePath, '{ not json', 'utf8');
  const r = loadGraphAt({ basePath });
  assert.equal(r.graph, null);
  assert.equal(r.corrupt, true);
  assert.equal(r.reason, 'bad-baseline');
  assert.ok(r.error, '必须带上错误原因');
});
