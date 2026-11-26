#!/usr/bin/env node
/**
 * dump-contracts.mjs —— **三张对外面的形状快照生成器**（重构 D 期 / M3 契约先行）。
 *
 * 为什么要有它：契约的"当前形状"不能手抄进 golden（手抄的那份会先于代码过期，且抄错也没人发现）。
 * 这里直接**调用真实模块**造一份固定夹具，把跑出来的对象的**字段路径 + 类型**导成 `test/golden/*.json`；
 * `test/contract-snapshot.test.mjs` 只负责"再跑一遍 + 逐字节比对"。
 *   ⇒ 字段增删 / 改名 / 改类型 ⇒ 快照与现形状不一致 ⇒ 测试红。
 *   ⇒ 要合法改契约：改代码 → 跑本脚本重生成 → diff 进评审（CHANGELOG 标"破坏性"）。
 *
 * 三张面：
 *   ① `memoryGraph`（`src/rooms/graphread.mjs` 的 `loadGraphAt`）—— 基线 `graph.json` + delta 回放后的形状
 *   ② `injectSlotLedger`（`src/rooms/inject-slot.mjs`）—— sidecar `inject-slots.json` 文件与读回对象的形状
 *   ③ `manifest`（`src/rooms/persist.mjs` 的 `writeManifest` / `readManifest` / `verify`）—— `manifest.json` 的形状
 *
 * 输出的是**形状**不是内容：每条一行 `<路径>: <类型>`，类型 ∈ string|integer|number|boolean|null|array|object。
 * 只有版本类字面量（version / schemaVersion / schema / pathPolicy / user）作为 `invariants` 固定下来 ——
 * 那是契约本身，不是"某个夹具的巧合"。
 *
 * 用法：
 *   node scripts/dump-contracts.mjs            # 重新生成 test/golden/*.json
 *   node scripts/dump-contracts.mjs --check    # 只比对，不一致 ⇒ 打印首个差异行并退出 1
 *
 * 确定性纪律：夹具时钟/会话 id/内容 hash 全部写死；临时目录用完即删；不读 `<DSH_HOME>` 真库、
 * 不联网、不依赖执行顺序（三个 dump 互不共享状态）。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  loadGraphAt,
  baseHashOf,
  checksum31,
  DELTA_SCALARS,
  DELTA_VERSION,
  GRAPH_SCHEMA_SUPPORTED,
  GRAPH_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION_LEGACY,
  GRAPH_VERSION,
} from '../src/rooms/graphread.mjs';
import {
  emptySlotLedger,
  lookupSlot,
  planSlotWrite,
  readSlotLedger,
  slotContentHash,
  writeSlotLedger,
  INJECT_SLOT_ID,
  INJECT_SLOT_IDEMPOTENT_ENV,
  INJECT_SLOT_LEDGER_FILE,
  INJECT_SLOT_LEDGER_VERSION,
  SLOT_LEDGER_MAX,
} from '../src/rooms/inject-slot.mjs';
import {
  createStore,
  DEFAULT_USER,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_SUPPORTED,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION_LEGACY,
  PATH_POLICY,
  STORE_SCHEMA,
  STORE_VERSION,
} from '../src/rooms/persist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const GOLDEN_DIR = path.join(ROOT, 'test', 'golden');

/** 夹具里所有时钟都用这个值（写死 ⇒ golden 不随真实时间漂）。 */
const FIXED_AT = 1_700_000_000_000;
const FIXTURE_SESSION = 'session-fixture';

/* ── 形状描述器 ─────────────────────────────────────────────── */

/** JSON 值 → 类型名（整数与浮点分开：`seq: 1` 变 `1.0` 也算改类型）。 */
export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * 递归展开成 `路径: 类型` 行（对象键排序、数组按下标）—— 这是快照的最小可比单元。
 * @param {*} value
 * @param {string} [path]
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function describe(value, path = '$', out = []) {
  const t = typeOf(value);
  out.push(`${path}: ${t}`);
  if (t === 'object') {
    for (const key of Object.keys(value).sort()) describe(value[key], `${path}.${key}`, out);
  } else if (t === 'array') {
    for (let i = 0; i < value.length; i += 1) describe(value[i], `${path}[${i}]`, out);
  }
  return out;
}

/** 只看一层：用来描述"函数返回对象"的对外表面（子树形状另有 describe 负责，避免同一信息记两遍）。 */
export function shallowShape(value, path = '$') {
  const t = typeOf(value);
  if (t !== 'object') return describe(value, path);
  const out = [];
  for (const key of Object.keys(value).sort()) out.push(`${path}.${key}: ${typeOf(value[key])}`);
  return out;
}

/** 抓一次预期内的抛错（把"错误码/错误消息"也钉进快照 —— 拒绝语义是对外面的一部分）。 */
export function catchError(fn) {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    return {
      threw: true,
      name: String(error?.name ?? 'Error'),
      code: error?.code ?? null,
      message: String(error?.message ?? error),
    };
  }
}

/* ── ① memoryGraph ──────────────────────────────────────────── */

function graphFixture() {
  return {
    version: GRAPH_VERSION,
    schemaVersion: GRAPH_SCHEMA_VERSION,
    sessionId: 'session-00000000-0000-4000-8000-000000000000',
    cwd: '/fixture',
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT,
    nextNode: 3,
    nextEdge: 2,
    nodes: { n1: graphNode('n1') },
    edges: {},
    order: ['n1'],
    stateIndex: {},
    rootUserNodeIds: ['n1'],
    checkpointSeq: null,
    foldCount: 0,
    lastFoldTotalTokens: 0,
    foldMarks: [],
    lastFoldUsage: null,
  };
}

/** 老基线：早期 `graph.json` 没有 `schemaVersion`，也没有 nodes/edges/order 三项集合。 */
function legacyGraphFixture() {
  return {
    version: GRAPH_VERSION,
    sessionId: 'session-00000000-0000-4000-8000-000000000000',
    cwd: '/fixture',
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT,
    nextNode: 1,
    nextEdge: 1,
    foldCount: 0,
  };
}

const graphNode = (id, extra = {}) => ({
  id,
  kind: 'agent',
  seq: 1,
  worldHash: `w-${id}`,
  constraintHash: `c-${id}`,
  via: null,
  ts: FIXED_AT,
  ...extra,
});

const graphEdge = (id) => ({
  id,
  from: 'n1',
  to: 'n2',
  intent: 'fixture',
  action: 'bash(command=fixture)',
  result: 'untested',
  evidence: { start: 1, end: 1 },
  ts: FIXED_AT,
});

/** 一局棋谱的形状（节点/边/派生索引的键归一成 `*`；缺席的键不补，保持"老基线没有 stateIndex"这个事实）。 */
function graphShapeOf(graph) {
  const copy = { ...graph };
  for (const key of ['nodes', 'edges', 'stateIndex']) {
    const v = copy[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) copy[key] = collapseMap(v);
  }
  return describe(copy);
}

function graphDeltaFixture() {
  return {
    v: DELTA_VERSION,
    nodes: { n2: graphNode('n2') },
    edges: { e1: graphEdge('e1') },
    scalars: { nextNode: 4, nextEdge: 2, updatedAt: FIXED_AT + 1 },
    orderAppend: ['n2'],
  };
}

/** 写一份基线并返回路径（`overrides` 用来造"版本不对"的坏基线）。 */
function writeGraphFixture(dir, name, overrides = {}) {
  const text = JSON.stringify({ ...graphFixture(), ...overrides }, null, 1);
  const target = path.join(dir, name);
  writeFileSync(target, text, 'utf8');
  return { path: target, text, baseHash: baseHashOf(text).slice(0, 16) };
}

/**
 * 面 ①：棋谱基线 + 回放的对外形状。
 * 覆盖：正常读（含 delta 回放）、老基线（无 schemaVersion）、三条拒绝语义（version / schemaVersion / delta version）。
 * @returns {object}
 */
export function dumpMemoryGraph() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kifuin-contract-graph-'));
  try {
    const base = writeGraphFixture(dir, 'graph.json');
    const frame = JSON.stringify(graphDeltaFixture());
    const deltaPath = `${base.path}.delta.jsonl`;
    writeFileSync(deltaPath, `${base.baseHash}\t${checksum31(frame)}\t${frame}\n`, 'utf8');
    const loaded = loadGraphAt({ basePath: base.path, deltaPath });

    // 老基线：没有 schemaVersion ⇒ 读侧按 legacy(0) 解释，并把 nodes/edges/order 补成空集合
    const legacyPath = path.join(dir, 'legacy.json');
    writeFileSync(legacyPath, JSON.stringify(legacyGraphFixture(), null, 1), 'utf8');
    const legacy = loadGraphAt({ basePath: legacyPath });
    // deltaPath 是临时目录里的绝对路径 ⇒ 快照里换成固定标签（形状不变，内容不漂）
    const loadedShape = { ...loaded, deltaPath: '<deltaPath>' };

    // 拒绝语义（每条都必须抛，不许静默降级）
    const badVersion = writeGraphFixture(dir, 'bad-version.json', { version: 2 });
    const badSchema = writeGraphFixture(dir, 'bad-schema.json', { schemaVersion: 2 });
    const badSchemaType = writeGraphFixture(dir, 'bad-schema-type.json', { schemaVersion: '1' });
    const badDeltaBody = JSON.stringify({ ...graphDeltaFixture(), v: 2 });
    const badDeltaPath = path.join(dir, 'bad-delta.jsonl');
    writeFileSync(badDeltaPath, `${base.baseHash}\t${checksum31(badDeltaBody)}\t${badDeltaBody}\n`, 'utf8');

    return {
      face: 'memoryGraph',
      source: 'src/rooms/graphread.mjs',
      entry: 'loadGraphAt',
      file: 'graph.json + graph.json.delta.jsonl',
      schemaVersion: GRAPH_SCHEMA_VERSION,
      legacySchemaVersion: GRAPH_SCHEMA_VERSION_LEGACY,
      supportedSchemaVersions: [...GRAPH_SCHEMA_SUPPORTED],
      constants: {
        graphVersion: GRAPH_VERSION,
        deltaVersion: DELTA_VERSION,
        deltaScalars: [...DELTA_SCALARS],
      },
      resolved: { current: loaded.schemaVersion, legacy: legacy.schemaVersion },
      // 读出来的一局：回放后的图（含 delta 新增的节点/边）
      read: {
        frames: loaded.frames,
        truncated: loaded.truncated,
        missing: loaded.missing,
        corrupt: loaded.corrupt,
        graphCounts: {
          nodes: Object.keys(loaded.graph.nodes).length,
          edges: Object.keys(loaded.graph.edges).length,
          order: loaded.graph.order.length,
        },
      },
      resultShape: shallowShape(loadedShape),
      graphShape: graphShapeOf(loaded.graph),
      legacyGraphShape: graphShapeOf(legacy.graph),
      errorCodes: {
        baselineVersion: catchError(() => loadGraphAt({ basePath: badVersion.path })),
        schemaVersion: catchError(() => loadGraphAt({ basePath: badSchema.path })),
        schemaVersionType: catchError(() => loadGraphAt({ basePath: badSchemaType.path })),
        deltaVersion: catchError(() => loadGraphAt({ basePath: base.path, deltaPath: badDeltaPath })),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── ② 注入槽位账本 ─────────────────────────────────────────── */

/** 槽位键含会话 id（`\u001f` 分隔）⇒ 快照里归一成 `*`，只固定"槽条目长什么样"。 */
function normalizeSlotKeys(slots) {
  const entries = Object.entries(slots ?? {});
  const out = {};
  entries.forEach(([, value], i) => {
    out[i === 0 ? '*' : `*${i + 1}`] = value;
  });
  return out;
}

/**
 * 动态键的映射（节点/边/派生索引/checksums/slots）⇒ 只留**一个代表值**，键归一成 `*`。
 * 为什么：这些键是夹具 id / 会话 id / 文件路径，不是契约；契约是"一个条目长什么样 + 是不是映射"。
 * @param {Record<string, *>} map
 * @returns {Record<string, *>}
 */
function collapseMap(map) {
  const keys = Object.keys(map ?? {}).sort();
  return keys.length === 0 ? {} : { '*': map[keys[0]] };
}

/**
 * 面 ②：`inject-slots.json` 的文件形状 + 读回形状 + 拒绝语义。
 * 注：这一面用 `version` 单字段承载格式版本（B 期已落地，`readSlotLedger` 对未知 version 抛
 * `slot/unsupported-version`）——本仓不改 `src/rooms/inject*.mjs`，快照把这份语义钉住。
 * @returns {object}
 */
export function dumpInjectSlotLedger() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kifuin-contract-slot-'));
  try {
    const hash = slotContentHash('contract fixture body');
    const created = planSlotWrite(emptySlotLedger(), { sessionId: FIXTURE_SESSION, contentHash: hash, at: FIXED_AT });
    const unchanged = planSlotWrite(created.ledger, { sessionId: FIXTURE_SESSION, contentHash: hash, at: FIXED_AT + 1 });
    const overwritten = planSlotWrite(created.ledger, {
      sessionId: FIXTURE_SESSION,
      contentHash: slotContentHash('contract fixture body (changed)'),
      at: FIXED_AT + 2,
    });

    writeSlotLedger({ storeRoot: dir, ledger: overwritten.ledger });
    const file = JSON.parse(readFileSync(path.join(dir, INJECT_SLOT_LEDGER_FILE), 'utf8'));
    const readBack = readSlotLedger({ storeRoot: dir });
    const entry = lookupSlot(readBack, FIXTURE_SESSION);

    // 未知版本 ⇒ 必须抛 slot/unsupported-version
    writeFileSync(path.join(dir, 'slot-v2.json'), JSON.stringify({ version: 2, slots: {} }), 'utf8');

    return {
      face: 'injectSlotLedger',
      source: 'src/rooms/inject-slot.mjs',
      file: INJECT_SLOT_LEDGER_FILE,
      // 该面的格式版本字段名就是 `version`（= 契约版本），语义与另两面的 schemaVersion 一致
      schemaVersionField: 'version',
      schemaVersion: INJECT_SLOT_LEDGER_VERSION,
      constants: {
        slotId: INJECT_SLOT_ID,
        idempotentEnv: INJECT_SLOT_IDEMPOTENT_ENV,
        maxSlots: SLOT_LEDGER_MAX,
      },
      planReasons: {
        created: created.reason,
        unchanged: unchanged.reason,
        overwritten: overwritten.reason,
        noSession: planSlotWrite(emptySlotLedger(), { sessionId: '', contentHash: hash }).reason,
        noHash: planSlotWrite(emptySlotLedger(), { sessionId: FIXTURE_SESSION, contentHash: '' }).reason,
      },
      seqAfterOverwrite: overwritten.entry?.seq ?? null,
      fileShape: describe({ ...file, slots: normalizeSlotKeys(file.slots) }),
      readShape: describe({ ...readBack, slots: normalizeSlotKeys(readBack.slots) }),
      entryShape: describe(entry),
      errorCodes: {
        unsupportedVersion: catchError(() => readSlotLedger({ storeRoot: dir, file: 'slot-v2.json' })),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── ③ manifest.json ───────────────────────────────────────── */

/** `checksums` 的键是条目相对路径（夹具决定）⇒ 归一成 `*`，把"一个文件对应一条 sha256"钉住。 */
function normalizeChecksums(checksums) {
  const values = Object.entries(checksums ?? {});
  const out = {};
  values.forEach(([, v], i) => {
    out[i === 0 ? '*' : `*${i + 1}`] = v;
  });
  return out;
}

/**
 * 面 ③：`manifest.json` 的形状 + 三条读写入口的对外表面 + 拒绝语义 + 老库兼容。
 * @returns {object}
 */
export function dumpManifest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kifuin-contract-manifest-'));
  try {
    const store = createStore({ root: dir, now: FIXED_AT });
    store.ensureDirs();
    const put = store.put('episodes', { id: 'ep-1234abcd', kind: 'episode', l0: 'contract fixture', state: 'archived' }, { at: FIXED_AT });
    const write = store.writeManifest(FIXED_AT);
    const again = store.writeManifest(FIXED_AT);
    const readBack = store.readManifest();
    const verified = store.verify();

    const manifestPath = path.join(dir, MANIFEST_FILE);
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8'));

    // 老库：删掉 schemaVersion 字段 ⇒ 读侧按 legacy(0) 接受；下一次 writeManifest 一次性补上
    const legacyManifest = { ...onDisk };
    delete legacyManifest.schemaVersion;
    writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8');
    const legacyVerify = store.verify();
    const legacyWrite = store.writeManifest(FIXED_AT + 1000);
    const afterUpgrade = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const upgradedAgain = store.writeManifest(FIXED_AT + 2000);

    // 未知 schemaVersion（version 正确、schemaVersion=2）⇒ verify 报错、写入侧拒绝
    writeFileSync(manifestPath, `${JSON.stringify({ ...onDisk, schemaVersion: 2 }, null, 2)}\n`, 'utf8');
    const badSchemaVerify = store.verify();
    const badSchemaWrite = catchError(() => store.writeManifest(FIXED_AT + 3000));
    const badSchemaPut = catchError(() => store.put('episodes', { id: 'ep-ffffffff', kind: 'episode' }, { at: FIXED_AT + 3000 }));

    return {
      face: 'manifest',
      source: 'src/rooms/persist.mjs',
      entry: 'writeManifest / readManifest / ensureCompatible / verify',
      file: MANIFEST_FILE,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      legacySchemaVersion: MANIFEST_SCHEMA_VERSION_LEGACY,
      supportedSchemaVersions: [...MANIFEST_SCHEMA_SUPPORTED],
      invariants: {
        version: onDisk.version,
        schemaVersion: onDisk.schemaVersion,
        schema: onDisk.schema,
        user: onDisk.user,
        pathPolicy: onDisk.pathPolicy,
        storeVersion: STORE_VERSION,
        storeSchema: STORE_SCHEMA,
        defaultUser: DEFAULT_USER,
        pathPolicyConstant: PATH_POLICY,
      },
      lifecycle: {
        firstWriteChanged: write.changed,
        secondWriteChanged: again.changed,
        legacyAccepted: legacyVerify.ok,
        legacyResolvedSchemaVersion: legacyVerify.manifest?.schemaVersion ?? null,
        legacyUpgradeWrote: legacyWrite.changed,
        upgradedSchemaVersion: afterUpgrade.schemaVersion,
        upgradedAgainChanged: upgradedAgain.changed,
        putChanged: put.changed,
        verifiedOk: verified.ok,
      },
      manifestShape: describe({ ...onDisk, checksums: normalizeChecksums(onDisk.checksums) }),
      writeResultShape: shallowShape({ changed: write.changed, manifest: onDisk }),
      readManifestResultShape: shallowShape(readBack),
      verifyResultShape: shallowShape(verified),
      verifyManifestShape: describe({ ...verified.manifest, counts: verified.manifest.counts }),
      errorCodes: {
        unsupportedSchemaVersion: badSchemaWrite,
        unsupportedSchemaVersionVerify: badSchemaVerify.errors.filter((e) => e.code === 'manifest/unsupported-schema-version'),
        unsupportedSchemaVersionPut: badSchemaPut,
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 汇总 / CLI ─────────────────────────────────────────────── */

/** 三张面（顺序固定；golden 文件名固定）。 */
export const FACES = Object.freeze([
  { face: 'memoryGraph', file: 'memory-graph.json', dump: dumpMemoryGraph },
  { face: 'injectSlotLedger', file: 'inject-slot-ledger.json', dump: dumpInjectSlotLedger },
  { face: 'manifest', file: 'manifest.json', dump: dumpManifest },
]);

/**
 * 现形状（三张面一次算完）。测试与脚本共用同一份生成器 —— 形状逻辑只有一处，不会两边漂。
 * @returns {Record<string, object>}
 */
export function dumpContracts() {
  const out = {};
  for (const { face, dump } of FACES) out[face] = dump();
  return out;
}

/** 序列化口径（golden 文件与比对都走它）。 */
export function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function firstDiffLine(expected, actual) {
  const a = String(expected ?? '').split('\n');
  const b = String(actual ?? '').split('\n');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return { line: i + 1, golden: a[i] ?? '<缺行>', actual: b[i] ?? '<缺行>' };
  }
  return null;
}

/**
 * CLI。
 * @param {string[]} argv
 * @returns {number} 退出码（0 成功 / 1 --check 发现漂移 / 2 参数错）
 */
export function main(argv = []) {
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(' ')}\n用法：node scripts/dump-contracts.mjs [--check]`);
    return 2;
  }
  const check = argv.includes('--check');
  const docs = dumpContracts();
  let drift = 0;
  for (const { face, file } of FACES) {
    const text = serialize(docs[face]);
    const target = path.join(GOLDEN_DIR, file);
    if (!check) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(target, text, 'utf8');
      console.log(`wrote ${path.relative(ROOT, target).split(path.sep).join('/')} · ${text.split('\n').length - 1} 行`);
      continue;
    }
    let golden = null;
    try {
      golden = readFileSync(target, 'utf8');
    } catch {
      drift += 1;
      console.error(`✗ ${file}：缺 golden（跑 node scripts/dump-contracts.mjs 生成）`);
      continue;
    }
    if (golden === text) {
      console.log(`✓ ${file}`);
      continue;
    }
    drift += 1;
    const diff = firstDiffLine(golden, text);
    console.error(`✗ ${file}：形状漂移（第 ${diff?.line ?? '?'} 行）`);
    if (diff) {
      console.error(`    golden: ${diff.golden}`);
      console.error(`    现形状: ${diff.actual}`);
    }
  }
  if (check) {
    console.log(drift === 0 ? '契约快照：3/3 一致' : `契约快照：${FACES.length - drift}/${FACES.length} 一致`);
    return drift === 0 ? 0 : 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}