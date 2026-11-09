// T367 · `kifu_consolidate` 工具（合流**预览**，只读）—— 删掉 tools.mjs 里那条定义 ⇒ 本片红。
//
// 为什么要是工具而不是"让模型自己调 consolidate"：契约 §S4 要求工具面能给**只读预览**，
// 而 `room/consolidate` 的写模式会产影子库（`dryRun:false` + `outStoreDir`）——
// 那是"改记忆"的动作，绝不该从代码块里发生。本测试钉住三条：
//   ① 工具面**没有** dryRun 参数（想写也传不进来）；
//   ② 输出有界（组数 limit、成员 ≤10、正文按 previewChars 截断）；
//   ③ 真跑一次**一个字节都不写**（整库 sha256 前后一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildMemoryTools } from '../src/tools.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T = (day) => Date.UTC(2026, 10, day, 9, 0, 0);
const SCOPE = 'w:d:/proj';

const claim = (id, text, day, seq) => ({
  id, kind: 'antipattern', text, scopeKey: SCOPE, threadIds: [], state: 'observed',
  support: [{ episode: 'ep-cccccc01', seq, quote: text, occurredAt: T(day) }],
  counter: [], validity: { type: 'none', value: null }, preconditions: [],
  occurredAt: T(day), recordedAt: T(day), validFrom: null, validTo: null,
  counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
});

const sha = (root) => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) files.push(`${path.relative(root, abs)}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(root);
  return files.sort().join('|');
};

function makeStore() {
  const dshHome = mkdtempSync(path.join(tmpdir(), 'kifuin-consolidate-'));
  const root = path.join(dshHome, 'memory-context');
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('claims', [
    claim('c-0000cc01', "Cannot find module 'yaml'", 21, 12),
    claim('c-0000cc02', "Cannot find module 'yaml'", 22, 33),
    claim('c-0000cc03', 'engines.node 是 >=23.8', 23, 7),
  ]);
  return { dshHome, root };
}

const toolOf = async (dshHome) => {
  const sdkModule = await import('../src/sdk.mjs');
  // 注意 spread 顺序：工具 execute 会传 `dshHome: null`，必须让测试的 home 胜出
  const tools = buildMemoryTools({ createSdk: (opts) => sdkModule.createMemorySdk({ ...opts, dshHome: opts?.dshHome || dshHome }) });
  return tools.find((t) => t.name === 'kifu_consolidate');
};

test('T367 ①: 工具存在，且**没有** dryRun 参数（想写也传不进来）', async () => {
  const tool = await toolOf(makeStore().dshHome);
  assert.ok(tool, 'kifu_consolidate 必须注册');
  const props = tool.parameters?.properties ?? {};
  assert.ok('scope' in props && 'limit' in props && 'previewChars' in props);
  assert.ok(!('dryRun' in props), '工具面不许暴露 dryRun —— 写模式只能走 CLI + 影子库');
  assert.equal(tool.isConcurrencySafe(), true, '只读工具必须并发安全');
});

test('T367 ②: 输出有界（limit 夹紧 + 成员 ≤10 + 正文按 previewChars 截断）', async () => {
  const { dshHome } = makeStore();
  const tool = await toolOf(dshHome);
  const value = await tool.execute({ limit: 1, previewChars: 40 });
  // 注意：`ok` 是**质量闸**（t1–t5）的合取，小夹具下 t5（reduction≤25%）必然 false —— 这是如实的，
  // 预览工具不该为了让测试好看而谎报 ok。这里只钉**输出有界**。
  assert.equal(typeof value.ok, 'boolean');
  assert.ok(value.quality && typeof value.quality.t5 === 'boolean');
  assert.ok(value.n <= 1, 'limit 必须夹紧');
  for (const g of value.groups) {
    assert.ok(g.members.length <= 10, '每组最多 10 个成员');
    assert.ok([...g.text].length <= 41, `正文必须截断（含省略号），实际 ${[...g.text].length}`);
  }
  // JSON 安全：能原样 stringify 回来
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
});

test('T367 ③: **一个字节都不写** —— 真跑一次，整库 sha256 前后一致', async () => {
  const { dshHome, root } = makeStore();
  const before = sha(root);
  const tool = await toolOf(dshHome);
  const value = await tool.execute({ scope: SCOPE, limit: 10 });
  assert.ok(value.total >= 1, `两条同文本 claim 应能合流成组，实际 total=${value.total}`);
  assert.equal(sha(root), before, '预览模式必须零写入');
});
