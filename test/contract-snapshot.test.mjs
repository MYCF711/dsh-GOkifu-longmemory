// contract-snapshot —— 三张对外面的**契约快照**（重构 D 期 / M3 契约先行）
//
// 这三张面是对外承诺：`graph.json`（memoryGraph，R02 读侧）、注入槽位账本（`inject-slots.json`）、
// `manifest.json`（R15 存储侧）。字段增删 / 改名 / 改类型会**静默**破坏下游与搬库能力，所以这里把
// **当前形状**固化成 `test/golden/*.json`，并逐字节比对：
//   · golden 由 `node scripts/dump-contracts.mjs` **生成**（不是手写 —— 手抄的那份会先于代码过期）；
//   · 形状 = `<路径>: <类型>` 行（对象键排序 + 数组下标），另加版本类不变量字面量；
//   · 要合法改契约：改代码 → 重跑 dump 脚本 → golden diff 进评审 → CHANGELOG 标"破坏性"。
//
// 另有一半是**拒绝语义**（规格 §2.3：不认识的版本必须显式报错，不许静默降级）：
//   三张面各自「未知 schemaVersion ⇒ 抛」+「老文件缺版本字段 ⇒ 按 legacy 接受」两条都在这里钉住。
//
// 墓碑自证：把 `writeManifest` 里的 `schemaVersion` 一行删掉（或改 golden 某一行），本文件必红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FACES, GOLDEN_DIR, dumpContracts, serialize } from '../scripts/dump-contracts.mjs';
import {
  loadGraphAt,
  baseHashOf,
  checksum31,
  GRAPH_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION_LEGACY,
  GRAPH_VERSION,
  DELTA_VERSION,
} from '../src/rooms/graphread.mjs';
import {
  emptySlotLedger,
  planSlotWrite,
  readSlotLedger,
  INJECT_SLOT_LEDGER_FILE,
  INJECT_SLOT_LEDGER_VERSION,
  SlotLedgerError,
} from '../src/rooms/inject-slot.mjs';
import {
  createStore,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION_LEGACY,
} from '../src/rooms/persist.mjs';

/* ── 工具 ─────────────────────────────────────────────────── */

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(dir, name, value, indent = 1) {
  const target = path.join(dir, name);
  const text = JSON.stringify(value, null, indent);
  writeFileSync(target, text, 'utf8');
  return { path: target, text, baseHash: baseHashOf(text).slice(0, 16) };
}

const episode = (id = 'ep-1234abcd') => ({ id, kind: 'episode', l0: 'fixture', state: 'archived' });

/* ── 一、三张面的形状快照 ─────────────────────────────────── */

test('契约快照：三张对外面的形状 == test/golden/*.json（字段增删/改名/改类型即红）', () => {
  assert.equal(FACES.length, 3, '三张面：memoryGraph / injectSlotLedger / manifest');
  const actual = dumpContracts();
  for (const { face, file } of FACES) {
    const goldenPath = path.join(GOLDEN_DIR, file);
    assert.ok(
      existsSync(goldenPath),
      `缺 golden：test/golden/${file}（跑 node scripts/dump-contracts.mjs 生成）`,
    );
    const expected = readFileSync(goldenPath, 'utf8');
    assert.equal(
      serialize(actual[face]),
      expected,
      `${face} 的对外形状与 test/golden/${file} 不一致 —— 契约变更是显式动作：`
        + '确认是有意的，再跑 node scripts/dump-contracts.mjs 重生成 golden，并在 CHANGELOG 写"破坏性"',
    );
  }
});

test('契约快照：golden 不是空壳（每张面都有 shape 段 + 整数 schemaVersion）', () => {
  for (const { face, file } of FACES) {
    const doc = JSON.parse(readFileSync(path.join(GOLDEN_DIR, file), 'utf8'));
    assert.equal(doc.face, face, `${file} 的 face 字段必须自报家门`);
    assert.equal(Number.isInteger(doc.schemaVersion), true, `${file} 必须声明整数 schemaVersion`);
    const shapeKeys = Object.keys(doc).filter((k) => /Shape$/.test(k));
    assert.ok(shapeKeys.length >= 3, `${file} 至少 3 段形状（实际 ${shapeKeys.join(', ')}）`);
    for (const key of shapeKeys) {
      assert.ok(Array.isArray(doc[key]) && doc[key].length > 0, `${file} 的 ${key} 不能是空数组`);
    }
  }
});

/* ── 二、memoryGraph：版本闸 + 老基线兼容 ─────────────────── */

function minimalBaseline(overrides = {}) {
  return { version: GRAPH_VERSION, createdAt: 1, updatedAt: 1, nextNode: 1, nextEdge: 1, ...overrides };
}

test('memoryGraph：schemaVersion 不认识 ⇒ 抛（不静默降级）', (t) => {
  const dir = tempDir(t, 'kifuin-contract-graph-');
  const { path: basePath } = writeJson(dir, 'graph.json', minimalBaseline({ schemaVersion: 2 }));
  assert.throws(() => loadGraphAt({ basePath }), /graphread: unsupported schemaVersion 2/);
});

test('memoryGraph：schemaVersion 类型不对（"1"）⇒ 抛，不做类型宽容', (t) => {
  const dir = tempDir(t, 'kifuin-contract-graph-');
  const { path: basePath } = writeJson(dir, 'graph.json', minimalBaseline({ schemaVersion: '1' }));
  assert.throws(() => loadGraphAt({ basePath }), /graphread: unsupported schemaVersion "1"/);
});

test('memoryGraph：老基线缺 schemaVersion ⇒ 按 legacy 解释并把 nodes/edges/order 补成空集合', (t) => {
  const dir = tempDir(t, 'kifuin-contract-graph-');
  const { path: basePath } = writeJson(dir, 'graph.json', minimalBaseline());
  const r = loadGraphAt({ basePath });
  assert.equal(r.schemaVersion, GRAPH_SCHEMA_VERSION_LEGACY);
  assert.deepEqual(r.graph.nodes, {});
  assert.deepEqual(r.graph.edges, {});
  assert.deepEqual(r.graph.order, []);
});

test('memoryGraph：当前 schemaVersion ⇒ 原样回报（并回放 delta 帧）', (t) => {
  const dir = tempDir(t, 'kifuin-contract-graph-');
  const base = writeJson(dir, 'graph.json', minimalBaseline({ schemaVersion: GRAPH_SCHEMA_VERSION, nodes: {}, edges: {}, order: [] }));
  const frame = JSON.stringify({ v: DELTA_VERSION, nodes: { n1: { id: 'n1', kind: 'agent', seq: 1, worldHash: 'w', constraintHash: 'c', via: null, ts: 1 } }, orderAppend: ['n1'] });
  writeFileSync(`${base.path}.delta.jsonl`, `${base.baseHash}\t${checksum31(frame)}\t${frame}\n`, 'utf8');
  const r = loadGraphAt({ basePath: base.path });
  assert.equal(r.schemaVersion, GRAPH_SCHEMA_VERSION);
  assert.equal(r.frames, 1);
  assert.equal(Object.keys(r.graph.nodes).length, 1);
});

/* ── 三、注入槽位账本：版本闸 + 首次运行 ──────────────────── */

test('注入账本：未知 version ⇒ 抛 slot/unsupported-version（不许静默降级）', (t) => {
  const dir = tempDir(t, 'kifuin-contract-slot-');
  writeFileSync(path.join(dir, INJECT_SLOT_LEDGER_FILE), JSON.stringify({ version: 2, slots: {} }), 'utf8');
  assert.throws(
    () => readSlotLedger({ storeRoot: dir }),
    (err) => err instanceof SlotLedgerError && err.code === 'slot/unsupported-version',
  );
});

test('注入账本：文件不存在 ⇒ 空账本（首次运行不是错误），字段集合与快照一致', (t) => {
  const dir = tempDir(t, 'kifuin-contract-slot-');
  const empty = readSlotLedger({ storeRoot: dir });
  assert.equal(empty.version, INJECT_SLOT_LEDGER_VERSION);
  assert.deepEqual(empty.slots, {});
  // 写一条再读回：条目字段就是快照里那四项
  const plan = planSlotWrite(emptySlotLedger(), { sessionId: 's', contentHash: 'a'.repeat(64), at: 1 });
  writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(plan.ledger), 'utf8');
  const back = readSlotLedger({ storeRoot: dir, file: 'ledger.json' });
  const entry = Object.values(back.slots)[0];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'contentHash', 'seq', 'slotId']);
});

/* ── 四、manifest：版本闸 + 老库兼容 + 一次性升级 ─────────── */

function freshStore(t, opts = {}) {
  const dir = tempDir(t, 'kifuin-contract-manifest-');
  const store = createStore({ root: dir, now: 1_700_000_000_000, ...opts });
  store.ensureDirs();
  return store;
}

test('manifest：writeManifest 写入整数 schemaVersion，且写两次字节稳定', (t) => {
  const store = freshStore(t);
  store.put('episodes', episode(), { at: 1_700_000_000_000 });
  const first = store.writeManifest(1_700_000_000_000);
  assert.equal(first.changed, true);
  const onDisk = JSON.parse(readFileSync(path.join(store.root, MANIFEST_FILE), 'utf8'));
  assert.equal(onDisk.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(Number.isInteger(onDisk.schemaVersion), true);

  const before = readFileSync(path.join(store.root, MANIFEST_FILE), 'utf8');
  const second = store.writeManifest(1_700_000_000_000);
  assert.equal(second.changed, false, '无变更不重写');
  assert.equal(readFileSync(path.join(store.root, MANIFEST_FILE), 'utf8'), before, 'manifest 字节不变');
});

test('manifest：未知 schemaVersion ⇒ verify 报 manifest/unsupported-schema-version，写侧抛 store/unsupported-schema-version', (t) => {
  const store = freshStore(t);
  store.put('episodes', episode(), { at: 1_700_000_000_000 });
  store.writeManifest(1_700_000_000_000);
  const manifestPath = path.join(store.root, MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }, null, 2), 'utf8');

  const v = store.verify();
  assert.equal(v.ok, false);
  const err = v.errors.find((e) => e.code === 'manifest/unsupported-schema-version');
  assert.ok(err, JSON.stringify(v.errors));
  assert.match(String(err.message), /schemaVersion 2/);

  assert.throws(() => store.writeManifest(1_700_000_001_000), (e) => e.code === 'store/unsupported-schema-version');
  assert.throws(() => store.put('episodes', episode('ep-ffffffff'), { at: 1_700_000_001_000 }), (e) => e.code === 'store/unsupported-schema-version');
});

test('manifest：老库（无 schemaVersion）照常读；下一次 writeManifest 一次性补上，之后字节稳定', (t) => {
  const store = freshStore(t);
  store.put('episodes', episode(), { at: 1_700_000_000_000 });
  store.writeManifest(1_700_000_000_000);

  const manifestPath = path.join(store.root, MANIFEST_FILE);
  const legacy = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete legacy.schemaVersion;
  writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const v = store.verify();
  assert.equal(v.ok, true, `老库必须照常读：${JSON.stringify(v.errors)}`);
  assert.equal(v.manifest.schemaVersion, MANIFEST_SCHEMA_VERSION_LEGACY, '缺字段 ⇒ 回报 legacy 版本');

  const upgraded = store.writeManifest(1_700_000_001_000);
  assert.equal(upgraded.changed, true, '老库升级要写一次');
  const afterUpgrade = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(afterUpgrade.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(store.writeManifest(1_700_000_002_000).changed, false, '升级后字节稳定，不再漂');
});