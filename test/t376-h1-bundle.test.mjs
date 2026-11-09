// T376 · H1 的 store 必须走生产那条路径（`bundle: true`），且**读数逐项不变**。
//
// 真库实测（2026-11-10，signals=12）：bundle 关 **32.5s** → 开 **11.9s**，
// 而 `postGateInjected/Stale/Unverified` 三项**完全相同**（306 / 0 / 8）。
// 依据：`bundle` 只换"怎么读"，不改任何一条记录（T62/T65 的判据就是"结果逐条一致"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import { runH1 } from '../scripts/eval.mjs';

const T = (d) => Date.UTC(2026, 10, d, 9, 0, 0);
const SCOPE = 'w:d:/proj';

function makeStore() {
  const home = mkdtempSync(path.join(tmpdir(), 'kifu-h1-bundle-'));
  const root = path.join(home, 'memory-context');
  mkdirSync(root, { recursive: true });
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('topics', [
    { id: 't:alpha', kind: 'term', key: 'alpha-module', df: 2, firstSeenAt: T(20), lastSeenAt: T(21) },
  ]);
  store.putMany('episodes', [{
    id: 'ep-h1h1h1h1', sessionId: 's-1', scopeKey: SCOPE, startedAt: T(20), endedAt: T(21),
    firstEventAt: T(20), lastEventAt: T(21), recordedAt: T(21), agentPreset: null, delegationDepth: 0,
    closure: { logPath: 'sessions/demo/x/session.v4.jsonl.zstd', graphPath: 'graphs/x/graph.json', seqFrom: 1, seqTo: 9 },
    l0: '', l1: '', signals: { failures: 0, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    threadIds: [], state: 'archived',
  }]);
  store.putMany('claims', [{
    id: 'c-h1h1h1h1', kind: 'antipattern', text: 'alpha-module 会崩', scopeKey: SCOPE, threadIds: [],
    state: 'observed', support: [{ episode: 'ep-h1h1h1h1', seq: 3, quote: 'alpha-module 会崩', occurredAt: T(20) }],
    counter: [], validity: { type: 'none', value: null }, preconditions: [],
    occurredAt: T(20), recordedAt: T(20), validFrom: null, validTo: null,
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
  }]);
  return { home, root };
}

const pick = (r) => ({
  injected: r.postGateInjected, stale: r.postGateStale, unverified: r.postGateUnverified,
  zeroInjection: r.zeroInjection, gateFailures: r.gateFailures,
});

test('T376 ①: bundle 开/关，H1 的读数逐项相同（bundle 只换读法）', async () => {
  const { home, root } = makeStore();
  const base = { storeRoot: root, workspace: home, signals: 3, limit: 5, budgetTokens: 500, now: T(22), probe: null };
  const off = await runH1({ ...base, bundle: false });
  const on = await runH1({ ...base, bundle: true });
  assert.deepEqual(pick(on), pick(off), 'bundle 不许改变任何读数');
});

test('T376 ②: 默认就走 bundle（生产同款），显式 false 才回退旧路径', async () => {
  const { home, root } = makeStore();
  const base = { storeRoot: root, workspace: home, signals: 3, limit: 5, budgetTokens: 500, now: T(22), probe: null };
  const dflt = await runH1({ ...base });
  const on = await runH1({ ...base, bundle: true });
  assert.deepEqual(pick(dflt), pick(on), '不传 bundle 时行为必须等于 bundle:true');
});
