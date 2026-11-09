// T62 · 单文件 bundle 的 tombstone test：删掉 src/rooms/walkbundle.mjs ⇒ 本文件整片红。
//
// 它要保证三件事：① 读到的记录与逐文件读**完全一致**；② 失效判据真的会失效（不许拿旧数据当新数据）；
// ③ 任何异常都退回慢路径（缓存永远不许拖垮主路径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import {
  KIND_BUNDLE_VERSION,
  KIND_MEMO_MS,
  dropKindBundles,
  dropKindMemo,
  kindBundleStamp,
  readKindBundle,
  readKindBundleCached,
  writeKindBundle,
} from '../src/rooms/walkbundle.mjs';

const NL = String.fromCharCode(10);

function makeStore({ manifest = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't62-store-'));
  const store = createStore({ root, now: Date.UTC(2026, 10, 9) });
  store.ensureDirs();
  store.putMany('topics', [
    { id: 't:term:t620001', kind: 'term', key: 'alpha', df: 1, idfNorm: 0.5, firstSeenAt: 1, lastSeenAt: 1, episodes: ['ep-1'] },
    { id: 't:term:t620002', kind: 'term', key: 'beta', df: 1, idfNorm: 0.5, firstSeenAt: 1, lastSeenAt: 1, episodes: ['ep-1'] },
  ]);
  if (manifest) {
    // 真实 store 每次变更都会重写 manifest.json；夹具里显式造一个，用来验证失效判据
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: 1, updatedAt: Date.now(), counts: {} }), 'utf8');
  }
  return { root, store };
}

test('T62 ①: 有 manifest 才启用；stamp 变了 / 版本不对 / 文件坏了 一律返回 null（退回慢路径）', () => {
  const { root } = makeStore({ manifest: false });
  try {
    assert.equal(kindBundleStamp(root, 'topics'), null, '没有 manifest ⇒ 不启用 bundle（测试夹具走慢路径）');
    fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":1}', 'utf8');
    const stamp = kindBundleStamp(root, 'topics');
    assert.ok(typeof stamp === 'string' && stamp.includes('topics:2'), `stamp 必须含该 kind 的条目数：${stamp}`);
    assert.ok(writeKindBundle(root, 'topics', [{ id: 'x' }], { stamp }));
    assert.deepEqual(readKindBundle(root, 'topics'), [{ id: 'x' }]);
    // manifest 变了 ⇒ 判据失效
    fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":1,"n":2}', 'utf8');
    assert.equal(readKindBundle(root, 'topics'), null, 'manifest 变了必须失效');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T62 ②: 条目数变了也失效（绕过 store 直接往目录里丢文件）', () => {
  const { root } = makeStore();
  try {
    const stamp = kindBundleStamp(root, 'topics');
    assert.ok(writeKindBundle(root, 'topics', [{ id: 'a' }], { stamp }));
    assert.deepEqual(readKindBundle(root, 'topics'), [{ id: 'a' }]);
    const existing = fs.readdirSync(path.join(root, 'topics')).filter((n) => n.endsWith('.json'))[0];
    fs.writeFileSync(path.join(root, 'topics', existing.replace(/\.json$/, 'x.json')), '{}', 'utf8');
    assert.equal(readKindBundle(root, 'topics'), null, '条目数变了必须失效');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T62 ③: 坏文件 / 错版本 ⇒ null（不许把坏缓存当数据）', () => {
  const { root } = makeStore();
  try {
    const stamp = kindBundleStamp(root, 'topics');
    const file = path.join(root, '.cache', 'topics.bundle.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json', 'utf8');
    assert.equal(readKindBundle(root, 'topics'), null);
    fs.writeFileSync(file, JSON.stringify({ version: KIND_BUNDLE_VERSION + 1, kind: 'topics', stamp, records: [] }), 'utf8');
    assert.equal(readKindBundle(root, 'topics'), null, '版本不符必须当没有');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T62 ④: store.list({bundle:true}) 与慢路径读数**逐条一致**（换读法不改数据）', () => {
  const { root } = makeStore();
  try {
    dropKindBundles(root);
    const slow = createStore({ root }).list('topics').map((x) => x.record);
    const fastStore = createStore({ root, bundle: true });
    const first = fastStore.list('topics').map((x) => x.record); // 冷：走慢路径并写 bundle
    const second = fastStore.list('topics').map((x) => x.record); // 热：读 bundle
    assert.equal(JSON.stringify(second), JSON.stringify(slow), '热路径必须与慢路径逐字节一致');
    assert.equal(JSON.stringify(first), JSON.stringify(slow), '冷路径也不许变');
    assert.ok(fs.existsSync(path.join(root, '.cache', 'topics.bundle.json')), '慢路径之后应当落下 bundle');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T62 ⑤: bundle 是纯派生 —— 删掉它读数一字不变', () => {
  const { root } = makeStore();
  try {
    const withBundle = createStore({ root, bundle: true }).list('topics').map((x) => x.record);
    dropKindBundles(root);
    const withoutBundle = createStore({ root, bundle: true }).list('topics').map((x) => x.record);
    assert.equal(JSON.stringify(withoutBundle), JSON.stringify(withBundle));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// T63（2026-11-09）：把「归档后第一次查询要等 6 秒」挪到归档之后 —— 预热脚本。
test('T63: warm-bundles 预热四类；已新鲜就跳过；没有 manifest 就跳过（不建垃圾）', async () => {
  const { warmBundles } = await import('../scripts/warm-bundles.mjs');
  const withManifest = makeStore();
  const withoutManifest = makeStore({ manifest: false });
  try {
    const first = warmBundles({ root: withManifest.root });
    assert.equal(first.ok, true);
    assert.equal(first.kinds.topics.status, 'built', '第一次应当真建');
    assert.ok(fs.existsSync(path.join(withManifest.root, '.cache', 'topics.bundle.json')));

    const second = warmBundles({ root: withManifest.root });
    assert.equal(second.ok, true);
    assert.equal(second.kinds.topics.status, 'fresh', '第二次应当命中，不重复建');

    const skipped = warmBundles({ root: withoutManifest.root });
    assert.equal(skipped.skipped, 'no-manifest', '没有 manifest（测试夹具）⇒ 直接跳过');
  } finally {
    fs.rmSync(withManifest.root, { recursive: true, force: true });
    fs.rmSync(withoutManifest.root, { recursive: true, force: true });
  }
});

// T65（2026-11-09）：一次建卡里 `list()` 会被调多次，每次 `JSON.parse` 十几 MB 是白花钱。
// 加了一层极短命的内存 memo —— 这里钉住"真的省了"和"真的会失效"。
test('T65 ①: memo 命中 ⇒ 返回**同一个数组**（没有重复解析）', () => {
  const { root } = makeStore();
  try {
    dropKindMemo(root);
    assert.ok(writeKindBundle(root, 'topics', [{ id: 'a' }]));
    const first = readKindBundleCached(root, 'topics');
    const second = readKindBundleCached(root, 'topics');
    assert.deepEqual(first, [{ id: 'a' }]);
    assert.equal(first, second, 'TTL 内必须是同一份内存数组（否则等于没 memo）');
  } finally {
    dropKindMemo(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T65 ②: 过期 / 换 stamp / 手动清 之后都必须重新读盘', () => {
  const { root } = makeStore();
  try {
    dropKindMemo(root);
    assert.ok(writeKindBundle(root, 'topics', [{ id: 'a' }]));
    const t0 = Date.now();
    const first = readKindBundleCached(root, 'topics', { now: t0 });
    // 过期：显式给一个超过 TTL 的时间
    const later = readKindBundleCached(root, 'topics', { now: t0 + KIND_MEMO_MS + 1 });
    assert.deepEqual(later, [{ id: 'a' }]);
    assert.notEqual(later, first, '过了 TTL 必须重新解析');

    // 换 stamp（库变了）⇒ 即使 TTL 内也不许用旧的
    fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":1,"n":2}', 'utf8');
    const afterChange = readKindBundleCached(root, 'topics', { now: t0 });
    assert.equal(afterChange, null, 'stamp 变了 ⇒ bundle 本身失效，返回 null');

    // 手动清
    dropKindMemo(root);
    assert.deepEqual(readKindBundleCached(root, 'topics'), null, '清过之后要重新读（此时 bundle 已失效）');
  } finally {
    dropKindMemo(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
