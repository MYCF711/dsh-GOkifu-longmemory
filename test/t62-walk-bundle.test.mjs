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
  dropKindBundles,
  kindBundleStamp,
  readKindBundle,
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
