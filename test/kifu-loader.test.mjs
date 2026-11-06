// T283 · kifu-loader 相对导入断裂修复（tombstone）
//
// 旧实现 `export * from '../../src/plugin.mjs'` 只在仓库内成立；包实体化到独立 home 后
// `../../src/plugin.mjs` 指向不存在的路径 ⇒ 加载即炸（实测 ERR_MODULE_NOT_FOUND …\AppData\Local\src\plugin.mjs）。
// 本测试把包**复制到仓库外的临时目录**再 import，证明它已自包含。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'packages', 'kifu-loader', 'index.mjs');

test('T283 ①: 仓库内可以直接 import（宿主只要 name/inject/apply）', async () => {
  const m = await import(pathToFileURL(PKG).href);
  assert.equal(m.name, 'dsh-gokifu-longmemory-tools');
  assert.deepEqual(m.inject, ['tools']);
  assert.equal(typeof m.apply, 'function');
  assert.equal(typeof m.loadCore, 'function');
});

test('T283 ②: tombstone —— 复制到仓库外仍能加载（旧实现必炸）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-t283-'));
  const dst = path.join(dir, 'index.mjs');
  fs.copyFileSync(PKG, dst);
  assert.ok(!dir.startsWith(REPO), '临时目录必须在仓库外');
  const m = await import(pathToFileURL(dst).href);
  assert.equal(typeof m.apply, 'function');
  assert.equal(m.name, 'dsh-gokifu-longmemory-tools');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T283 ③: coreCandidates 顺序 —— 环境变量优先，相对路径兜底', async () => {
  const m = await import(pathToFileURL(PKG).href);
  const prev = process.env.KIFU_CORE_PATH;
  process.env.KIFU_CORE_PATH = path.join(REPO, 'src', 'plugin.mjs');
  try {
    const c = m.coreCandidates();
    assert.equal(c[0], process.env.KIFU_CORE_PATH, 'KIFU_CORE_PATH 必须第一');
    assert.ok(c.includes('dsh-gokifu-longmemory/plugin'), '要优先走包名 exports ./plugin');
    assert.ok(c.includes('../../src/plugin.mjs'), '仓库内相对路径作为最后兜底');
  } finally {
    if (prev === undefined) delete process.env.KIFU_CORE_PATH; else process.env.KIFU_CORE_PATH = prev;
  }
});

test('T283 ④: loadCore 能解析到真正的核心插件（有 apply）', async () => {
  const m = await import(pathToFileURL(PKG).href);
  const prev = process.env.KIFU_CORE_PATH;
  process.env.KIFU_CORE_PATH = path.join(REPO, 'src', 'plugin.mjs');
  try {
    const { mod, spec } = await m.loadCore();
    assert.equal(typeof mod.apply, 'function');
    assert.ok(spec.includes('plugin.mjs'), `解析到的 spec 应指向 plugin.mjs，实际 ${spec}`);
  } finally {
    if (prev === undefined) delete process.env.KIFU_CORE_PATH; else process.env.KIFU_CORE_PATH = prev;
  }
});

test('T283 ⑤: 解析不到时抛**明确错误**（不在加载期炸树）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-t283-bad-'));
  const dst = path.join(dir, 'index.mjs');
  fs.copyFileSync(PKG, dst);
  const m = await import(pathToFileURL(dst).href);
  const prev = process.env.KIFU_CORE_PATH;
  delete process.env.KIFU_CORE_PATH;
  try {
    await assert.rejects(() => m.loadCore(), /解析不到核心插件/);
  } finally {
    if (prev !== undefined) process.env.KIFU_CORE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T362: loader 真实核心链路返回 Cordis disposer，而非诊断对象/coreSpec', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-t362-core-'));
  const m = await import(pathToFileURL(PKG).href);
  const previousCore = process.env.KIFU_CORE_PATH;
  const previousHome = process.env.DSH_HOME;
  process.env.KIFU_CORE_PATH = path.join(REPO, 'src', 'plugin.mjs');
  process.env.DSH_HOME = dir;
  const hooks = {};
  const ctx = {
    logger: { warn: () => {} },
    on(event, handler) {
      hooks[event] = handler;
      return () => { delete hooks[event]; };
    },
  };
  let effect;
  try {
    effect = await m.apply(ctx, {
      enabled: false,
      shadow: false,
      autoBuild: false,
      autoArchive: false,
      collectMessages: false,
      liveStats: false,
      sampleCards: false,
      storeRoot: path.join(dir, 'memory-context'),
    });
    assert.equal(typeof effect, 'function');
    assert.equal(effect.coreSpec, undefined, '诊断信息不能混入 effect');
    assert.equal(effect.registered, true);
    await effect();
    assert.deepEqual(hooks, {});
  } finally {
    if (typeof effect === 'function') await effect();
    if (previousCore === undefined) delete process.env.KIFU_CORE_PATH; else process.env.KIFU_CORE_PATH = previousCore;
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T362: 独立 node_modules 布局经包名解析，并原样转发核心 disposer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-t362-installed-'));
  try {
    const loaderDir = path.join(dir, 'node_modules', 'kifu-loader');
    const coreDir = path.join(dir, 'node_modules', 'dsh-gokifu-longmemory');
    fs.mkdirSync(loaderDir, { recursive: true });
    fs.mkdirSync(coreDir, { recursive: true });
    fs.copyFileSync(PKG, path.join(loaderDir, 'index.mjs'));
    fs.writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({
      name: 'dsh-gokifu-longmemory',
      type: 'module',
      exports: { './plugin': './plugin.mjs' },
    }));
    fs.writeFileSync(path.join(coreDir, 'plugin.mjs'), 'export function apply() { return () => "disposed"; }');
    const m = await import(pathToFileURL(path.join(loaderDir, 'index.mjs')).href);
    const { spec } = await m.loadCore();
    assert.equal(spec, 'dsh-gokifu-longmemory/plugin');
    const effect = await m.apply({}, {});
    assert.equal(typeof effect, 'function');
    assert.equal(effect(), 'disposed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
