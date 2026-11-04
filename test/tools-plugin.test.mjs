// 工具面独立插件（0.141.0）：删掉 src/tools-plugin.mjs ⇒ 本文件整片红。
// 契约：模块必须声明 `inject = ['tools']`（否则宿主不给工具服务）；apply 只注册只读工具并留凭据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply, inject, name, storeRootOf } from '../src/tools-plugin.mjs';

test('tools-plugin: 模块声明 inject=[tools]（宿主据此交付工具服务）', () => {
  assert.deepEqual(inject, ['tools']);
  assert.equal(typeof name, 'string');
  assert.ok(name.includes('longmemory'));
  assert.equal(typeof apply, 'function');
});

test('tools-plugin: 有工具面 ⇒ 五个 kifu_* 全部注册', () => {
  const registered = [];
  const out = apply({ tools: { register: (t) => registered.push(t.name) }, logger: { warn: () => {} } });
  assert.deepEqual(registered, [
    'kifu_stats', 'kifu_search', 'kifu_card', 'kifu_recent_failures', 'kifu_get',
  ]);
  assert.equal(out.registered, 5);
});

test('tools-plugin: 没有工具面 ⇒ 注册 0 个，但**不抛**（插件不连累宿主）', () => {
  const out = apply({ logger: { warn: () => {} } });
  assert.equal(out.registered, 0);
});

test('tools-plugin: 凭据写明 via=tools-plugin（成功时）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-tools-plugin-'));
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.dirname(root); // storeRootOf() 会拼 memory-context
    const store = path.join(path.dirname(root), 'memory-context');
    assert.equal(storeRootOf(), path.resolve(store));
    // 让凭据目录存在
    mkdirSync(store, { recursive: true });
    apply({ tools: { register: () => {} }, logger: { warn: () => {} } });
    const back = JSON.parse(readFileSync(path.join(store, 'tools-registered.json'), 'utf8'));
    assert.equal(back.count, 5);
    assert.equal(back.via, 'tools-plugin');
    assert.equal(back.ctxHasRegister, true);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(root, { recursive: true, force: true });
    try { rmSync(path.join(path.dirname(root), 'memory-context'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
