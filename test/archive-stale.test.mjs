// T159b 的 tombstone test：删掉 `scripts/archive.mjs` 里 `carryStaleMarking` 的保留逻辑 ⇒ 本文件红。
//
// 背景：archive 每轮都从棋谱**重算** claim（`state` 由 R09 重给）。如果没有这层保留，
// T159 的降级标记（`state:'stale'` + `stale*`）只能活到下一次归档 —— 标一次 = 维护一辈子。
//
// 覆盖（任务书 T159b）：
//   ① 已标 stale（带 staleMarkedBy）的 claim → 跑归档 → state 与全部 stale* 字段**仍在**，其他字段按归档重算
//   ② 未标的 claim → 归档后与现在逐字节一致（回归：不带 staleMarkedBy 就什么都不加）
//   ③ 归档两次幂等：第二次/第三次不重写已标记录（writes.claims.written === 0）
//   ④ 只有 state:'stale' 但没有 staleMarkedBy ⇒ **不**保留（守卫判据是 staleMarkedBy，不是 state）
//
// 夹具全部在 os.tmpdir；不写 <DSH_HOME>；零模型调用；不新增依赖。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { runArchive } from '../scripts/archive.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { buildMarked, MARKER } from '../scripts/mark-stale.mjs';

const T0 = 1_700_000_000_000;
const SID = 'session-11111111-1111-4111-8111-111111111111';
const SCOPE_DIR = '--D-work-demo--';

let tmp;
test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-t159b-'));
});
test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function zframe(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

/** 一局会话：一条命令失败（Cannot find module）⇒ R09 会产出一条 antipattern claim。 */
function buildCorpus(root) {
  const dir = path.join(root, 'sessions', SCOPE_DIR, SID);
  mkdirSync(dir, { recursive: true });
  const header = {
    type: 'session', version: 4, id: SID, createdAt: T0, cwd: 'D:\\work\\demo',
    isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  };
  const events = [
    { type: 'user/message', seq: 1, time: T0 + 1_000, data: { content: [{ type: 'text', text: '跑一下测试' }] } },
    { type: 'tool/call', seq: 2, time: T0 + 2_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"node scripts/x.mjs"}' } },
    { type: 'tool/result', seq: 3, time: T0 + 3_000, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: "[exit code: 1]\nError: Cannot find module 'yaml'" }] } } },
  ];
  writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat([zframe(`${JSON.stringify(header)}\n`), zframe(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)]),
  );

  const gdir = path.join(root, 'chess-context', 'sessions', SID);
  mkdirSync(gdir, { recursive: true });
  writeFileSync(path.join(gdir, 'graph.json'), `${JSON.stringify({
    version: 1, sessionId: SID, createdAt: T0, updatedAt: T0 + 9_000, nextNode: 3, nextEdge: 2,
    nodes: {
      n1: { id: 'n1', kind: 'user', seq: 1, text: '跑一下测试', ts: T0 + 1_000 },
      n2: { id: 'n2', kind: 'agent', seq: 2, turn: 1, ts: T0 + 2_000 },
    },
    edges: {
      e1: {
        id: 'e1', from: 'n1', to: 'n2', action: 'bash(command=node scripts/x.mjs)',
        result: 'failure', errorSnippet: "Error: Cannot find module 'yaml'", evidence: { start: 3 }, ts: T0 + 3_000,
      },
    },
    order: ['n1', 'n2'], stateIndex: {}, rootUserNodeIds: ['n1'], checkpointSeq: 3, foldCount: 0,
  }, null, 2)}\n`);
  return { root, storeRoot: path.join(root, 'memory-context') };
}

const stripStore = (record) => {
  const out = { ...record };
  delete out._store;
  delete out.updatedAt;
  return out;
};

async function runOnce(fixture, at) {
  return runArchive({ dataRoot: fixture.root, storeRoot: fixture.storeRoot, now: at });
}

test('T159b: 已标 stale 的 claim —— 归档后 state 与 stale* 字段仍在', async () => {
  const fixture = buildCorpus(mkdtempSync(path.join(tmp, 'keep-')));
  await runOnce(fixture, 1_700_100_000_000);

  const store = createStore({ root: fixture.storeRoot });
  const claims = store.list('claims').map((x) => x.record).filter(Boolean);
  assert.ok(claims.length >= 1, '归档必须产出至少一条 claim');
  const target = claims[0];
  const marked = buildMarked(target, {
    at: 1_700_200_000_000,
    reason: 'version-mismatch',
    detail: { type: 'version', value: target.validity?.value ?? null, expected: '1.16.0', actual: '1.17.6', path: null, workspace: 'd:/work/demo' },
  });
  store.put('claims', marked, { at: 1_700_200_000_000 });
  store.writeManifest(1_700_200_000_000);

  // 归档跑一次：重算 claim（state 会被 R09 重给成 observed），但保留层必须把标记带回来
  const second = await runOnce(fixture, 1_700_300_000_000);
  assert.equal(second.verify.ok, true, JSON.stringify(second.verify.errors));

  const after = createStore({ root: fixture.storeRoot }).get('claims', target.id);
  assert.equal(after.state, 'stale', 'state 必须保留');
  assert.equal(after.staleMarkedBy, MARKER);
  assert.equal(after.staleFrom, marked.staleFrom);
  assert.equal(after.staleSince, marked.staleSince);
  assert.equal(after.staleReason, 'version-mismatch', 'staleReason 必须保留');
  assert.deepEqual(after.staleProbe, marked.staleProbe, 'staleProbe 必须逐字段保留');
  assert.equal(after.staleMarkedAt, marked.staleMarkedAt);

  // 其他字段仍按归档重算（时钟保留旧值，正文/support 由归档给出）
  assert.equal(after.text, target.text, '正文来自重算（同一语料 ⇒ 同文）');
  assert.equal(after.recordedAt, target.recordedAt ?? after.recordedAt);
  assert.deepEqual(after.support, target.support);
});

test('T159b: 未标的 claim —— 归档后与旧行为逐字节一致（回归）', async () => {
  const fixture = buildCorpus(mkdtempSync(path.join(tmp, 'plain-')));
  await runOnce(fixture, 1_700_100_000_000);
  const store = createStore({ root: fixture.storeRoot });
  const target = store.list('claims').map((x) => x.record).filter(Boolean)[0];
  assert.equal(target.staleMarkedBy, undefined, '夹具里本来没有标记');
  const before = JSON.stringify(stripStore(target));

  await runOnce(fixture, 1_700_300_000_000);
  const after = createStore({ root: fixture.storeRoot }).get('claims', target.id);
  assert.equal(JSON.stringify(stripStore(after)), before, '没有 staleMarkedBy ⇒ 不加任何字段、不改 state');
  for (const field of ['staleFrom', 'staleSince', 'staleReason', 'staleProbe', 'staleMarkedBy', 'staleMarkedAt']) {
    assert.equal(field in after, false, `不得凭空出现 ${field}`);
  }
});

test('T159b: 归档两次幂等 —— 已标记录不再被重写', async () => {
  const fixture = buildCorpus(mkdtempSync(path.join(tmp, 'idem-')));
  await runOnce(fixture, 1_700_100_000_000);
  const store = createStore({ root: fixture.storeRoot });
  const target = store.list('claims').map((x) => x.record).filter(Boolean)[0];
  store.put('claims', buildMarked(target, { at: 1_700_200_000_000, reason: 'file-appeared', detail: { expected: 'missing', actual: 'present' } }), { at: 1_700_200_000_000 });
  store.writeManifest(1_700_200_000_000);

  const second = await runOnce(fixture, 1_700_300_000_000);
  assert.equal(second.writes.claims.written, 0, '第二次归档不应重写已标记录');
  assert.equal(second.writes.claims.unchanged >= 1, true);

  const snapshot = JSON.stringify(createStore({ root: fixture.storeRoot }).get('claims', target.id));
  const third = await runOnce(fixture, 1_700_400_000_000);
  assert.equal(third.writes.claims.written, 0, '第三次归档同样不重写');
  assert.equal(JSON.stringify(createStore({ root: fixture.storeRoot }).get('claims', target.id)), snapshot, '三次归档后记录逐字节不变');
});

test('T159b: 守卫判据是 staleMarkedBy —— 只有 state:stale 不算', async () => {
  const fixture = buildCorpus(mkdtempSync(path.join(tmp, 'guard-')));
  await runOnce(fixture, 1_700_100_000_000);
  const store = createStore({ root: fixture.storeRoot });
  const target = store.list('claims').map((x) => x.record).filter(Boolean)[0];
  // 手改 state 但没有 staleMarkedBy：归档应把它按重算结果改回去（旧行为）
  store.put('claims', { ...target, state: 'stale' }, { at: 1_700_200_000_000 });
  store.writeManifest(1_700_200_000_000);

  await runOnce(fixture, 1_700_300_000_000);
  const after = createStore({ root: fixture.storeRoot }).get('claims', target.id);
  assert.notEqual(after.state, 'stale', '没有 staleMarkedBy ⇒ 不保留（状态仍由归档决定）');
  assert.equal(after.staleReason, undefined);
});
