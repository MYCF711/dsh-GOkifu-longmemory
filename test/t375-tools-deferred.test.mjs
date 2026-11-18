// T375 · 工具面**两条注册路径**：能直接读就直连，读不到就 `ctx.inject` 延迟注册。
//
// 真事（2026-11-10 02:00）：重启到 `Desktop-0.2.2-rc.1`（pid 23364）后，凭据写成
//   `via: tools-plugin-none · ctxHasRegister: false · count: 0` —— 六个 kifu_* 工具全没进去；
// 而同一天更早一次启动（另一个 home）写的是 `count: 6 · ctxHasRegister: true`。
// ⇒ 「apply 那一刻 ctx.tools 是否就绪」不能假设。宿主自己的官方插件用的是
// `ctx.inject(['tools'], (c) => c.tools… )` 延迟获取，所以这里补上同一条路。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply } from '../src/tools-plugin.mjs';

function withHome(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-tools-deferred-'));
  const home = path.dirname(root);
  const store = path.join(home, 'memory-context');
  mkdirSync(store, { recursive: true });
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return fn(store); } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
}

const credOf = (store) => JSON.parse(readFileSync(path.join(store, 'tools-registered.json'), 'utf8'));

test('T375 ①: 老路优先 —— ctx.tools.register 在就直接注册（一个字节的行为都不变）', () => {
  withHome((store) => {
    const names = [];
    const out = apply({ tools: { register: (t) => names.push(t.name) }, logger: { warn: () => {} } });
    assert.equal(out.via, 'tools-plugin', '直连路径的 via 与改动前逐字一致');
    assert.equal(out.registered, 7);
    assert.equal(credOf(store).via, 'tools-plugin', '凭据口径不变（老消费者不受影响）');
    assert.equal(credOf(store).ctxHasRegister, true);
  });
});

test('T388 ②: 读不到工具面时**不许**登记 waiting 子插件（会把"注册不上"升级成"启动失败"）', () => {
  withHome((store) => {
    let injectCalls = 0;
    const ctx = {
      logger: { warn: () => {} },
      inject: () => { injectCalls += 1; },   // 若被调用 ⇒ 派生一个等待 tools 的子插件
    };
    const out = apply(ctx);
    assert.equal(injectCalls, 0, '没有 tools 服务时绝不能 ctx.inject —— 那会留下永远 PENDING 的 entry');
    assert.equal(out.registered, 0);
    const cred = credOf(store);
    assert.equal(cred.count, 0);
    assert.equal(cred.via, 'tools-plugin-none');
    assert.equal(cred.ctxHasRegister, false);
  });
});

test('T375 ③: 既没有 tools 也没有 inject ⇒ 如实记一条"没拿到工具面"（不抛、不装成功）', () => {
  withHome((store) => {
    const out = apply({ logger: { warn: () => {} } });
    assert.equal(out.registered, 0);
    assert.equal(out.deferred, undefined);
    const cred = credOf(store);
    assert.equal(cred.count, 0);
    assert.equal(cred.via, 'tools-plugin-none');
    assert.equal(cred.ctxHasRegister, false);
    assert.ok(existsSync(path.join(store, 'tools-registered.json')));
  });
});
