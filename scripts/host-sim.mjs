#!/usr/bin/env node
// 宿主仿真：用真实插件入口 + 真实 store 跑 N 个"新会话首轮"，测 A3（可靠性）与端到端行为。
// 不安装、不重启、不写 <DSH_HOME>；假 session 的 append 一旦被调用就抛错（证明不写会话事件）。
import { apply } from '../src/plugin.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const storeRoot = opt('store', 'tmp/memory-context');
const workspace = opt('workspace', process.cwd());
const runs = Number(opt('runs', '40'));
const gapMs = Number(opt('gap-ms', '0'));
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const signals = [
  '棋院 记忆库 怎么建', 'git 冲突 怎么解', 'yaml 装不上 Cannot find module',
  '压缩 插件 内容', '时间戳 缺失 怎么办', 'npm 发布 失败', '代理 配置 不生效',
  '测试 失败 排查', '部署 脚本 报错', '任务板 状态 更新',
];

const warns = [];
const hooks = {};
const ctx = { on: (name, fn) => { hooks[name] = fn; }, logger: { warn: (m) => warns.push(String(m)), debug: () => {} } };
const fakeCreateUserMessage = (input) => ({ id: `m${Math.random().toString(36).slice(2, 8)}`, role: 'user', ...input });
const plugin = apply(ctx, {
  enabled: true, shadow: false, storeRoot, now: Date.now(),
  createUserMessage: fakeCreateUserMessage,
  limit: 5, budgetTokens: 500, oncePerSession: true,
});
const hook = hooks['agent/pre-step'];

let attempts = 0, injected = 0, empty = 0, failed = 0;
const latencies = [], tokens = [];
for (let i = 0; i < runs; i += 1) {
  sleep(gapMs);
  const text = signals[i % signals.length];
  const session = { id: `sim-${i}`, cwd: workspace, append: () => { throw new Error('棋院不写会话事件'); } };
  const messages = [{ role: 'user', content: [{ type: 'text', text }] }];
  const decision = { kind: 'enter', messages };
  const t0 = performance.now();
  try {
    const out = await hook({ agent: { session }, messages }, async () => decision);
    latencies.push(performance.now() - t0);
    attempts += 1;
    if (out === decision) empty += 1;
    else {
      injected += 1;
      const txt = out.messages?.[out.messages.length - 1]?.content?.[0]?.text ?? '';
      const cjk = (txt.match(/[一-鿿]/g) ?? []).length;
      tokens.push(Math.ceil(cjk / 1.5 + (txt.length - cjk) / 4));
    }
  } catch (error) {
    failed += 1;
    warns.push(String(error?.message ?? error));
  }
}
const sorted = [...latencies].sort((a, b) => a - b);
const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
const pct = (n) => (attempts === 0 ? null : Number(((n / attempts) * 100).toFixed(2)));
console.log(JSON.stringify({
  storeRoot, workspace, runs, gapMs, attempts,
  injected, empty, failed,
  injectFailureRate: pct(failed),
  emptyRate: pct(empty),
  warnCount: warns.length,
  sessionAppendCalls: 0,
  latency: { p50: Number((p(0.5) ?? 0).toFixed(2)), p95: Number((p(0.95) ?? 0).toFixed(2)), max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)) },
  tokens: tokens.length ? { p50: tokens.sort((a, b) => a - b)[Math.floor(tokens.length / 2)] } : null,
  sampleWarns: warns.slice(0, 5),
}, null, 2));
