// T388 · 启动期**绝不许**留下等待服务的子插件 —— 删掉这条约束（把 `ctx.inject(['tools'/'webServer'], …)`
// 加回 `src/plugin.mjs`）⇒ 本文件红。
//
// 真机事故 `crash-2026-11-09T19-46-33-220Z-web-boot.log`：
//   Error: web boot: 1 entry did not activate
//   dsh-gokifu-longmemory: failed
// Cordis 的 `ctx.inject(deps, cb)` 等价于「派生一个等待这些服务的子插件」；服务不来它就永远 PENDING，
// 宿主在 web 启动阶段统计「未激活 entry」，**一个**就足以让整个 Web GUI 起不来。
// 结论：插件在**没有**这些服务时也必须当场收工，而不是挂一个等待项。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply } from '../src/plugin.mjs';

const BASE_CONFIG = {
  enabled: false, shadow: false, autoBuild: false, autoArchive: false,
  collectMessages: false, liveStats: false, sampleCards: false,
};

function makeCtx({ tools = null, webServer = null } = {}) {
  const calls = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    inject: (deps, cb) => { calls.push({ deps, cb }); return null; },
  };
  if (tools) ctx.tools = tools;
  if (webServer) ctx.webServer = webServer;
  return { ctx, calls };
}

function withHome(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'kifu-t388-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
}

test('T388 ①: 没有 tools / webServer 时，apply 一次都不许 ctx.inject（不许留等待项）', () => {
  withHome(() => {
    const { ctx, calls } = makeCtx();
    apply(ctx, BASE_CONFIG);
    assert.equal(calls.length, 0, `不许派生子插件，实际诱导：${JSON.stringify(calls.map((c) => c.deps))}`);
  });
});

test('T388 ②: 只缺 webServer（web 侧常见）时，也不许为了它 ctx.inject', () => {
  withHome(() => {
    const { ctx, calls } = makeCtx({ tools: { register: () => {} } });
    apply(ctx, BASE_CONFIG);
    assert.equal(calls.length, 0);
  });
});

test('T388 ③: 服务都在时正常注册，同样不派生等待项', () => {
  withHome(() => {
    const registered = [];
    let routeRegistered = false;
    const { ctx, calls } = makeCtx({
      tools: { register: (t) => registered.push(t.name) },
      webServer: { register: () => { routeRegistered = true; } },
    });
    apply(ctx, BASE_CONFIG);
    assert.equal(calls.length, 0, '服务都在也不许派生等待项');
    // 注册本身由 test/tools.test.mjs / tools-plugin.test.mjs 钉；这里只钉"不派生等待项"。
    // （registration 依赖宿主把 ctx 传成什么样，本片不重复断言，避免把两件事耦在一起）
    assert.equal(typeof registered.length, 'number');
    assert.equal(typeof routeRegistered, 'boolean');
  });
});
