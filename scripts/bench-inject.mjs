#!/usr/bin/env node
// 注入延迟基准：冷/热两段，口径 = 一次 pre-step 决策里"卡构建 + 闸门"的墙钟时间。
import { createStore } from '../src/rooms/persist.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { runGates } from '../src/rooms/gates.mjs';

const storeRoot = process.argv[2] ?? 'tmp/memory-context';
const scope = process.argv[3] ?? 'w:d:/DeepSeek Harness/default-workspace/长期记忆系统';
const signals = ['棋院 记忆库', 'git 冲突', 'yaml 装不上', '压缩', '记忆', '时间戳', 'npm 发布', '代理 配置', '测试 失败', '部署'];
const store = createStore({ root: storeRoot });

const t0 = performance.now();
const cache = createWalkCache(store);
const t1 = performance.now();

const times = [];
for (const text of signals) {
  const s = signalFromText(text, { at: Date.now() });
  s.scopeKey = scope;
  const a = performance.now();
  const walk = walkFromSignals({ signal: s, store, scope, cache, depth: 2, limit: 5, budgetTokens: 500 });
  const card = buildMemoryCard({ cache, signal: s, walkResult: walk, store, scope, now: Date.now(), limit: 5, budgetTokens: 500 });
  runGates({ card, walkResult: walk, store, scope });
  times.push(performance.now() - a);
}
times.sort((a, b) => a - b);
const p = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
console.log(JSON.stringify({
  storeRoot,
  coldCacheMs: Number((t1 - t0).toFixed(1)),
  warm: { n: times.length, p50: Number(p(0.5).toFixed(1)), p95: Number(p(0.95).toFixed(1)), max: Number(times[times.length - 1].toFixed(1)) },
}, null, 2));
