// T-15 / P1-1 双时态失效（`invalidAt` / `expiredAt`）的 tombstone test。
//
// 墓碑自证（实测：删掉哪一处，哪几条红）：
//   · 删掉判据本体（`src/rooms/claim.mjs` 的 `applyTemporalInvalidation` 直接返回原样）
//     ⇒ **12 条里 7 条红**：F2/F3、F6、F8/F9、F10、库级「新值到达」、A2b、归档端到端
//     （F4/F5/F7 是"不该判"的负向断言，删掉逻辑反而恒绿 —— 正向证据在 F2/F3 与库级两条）；
//   · 只删写入侧接线（`src/rooms/persist.mjs` 的 `putMany` → `planClaimExpiry`）
//     ⇒ **3 条红**：库级「新值到达」、A2b、归档端到端（纯函数 9 条仍绿 —— 分层是分开的）；
//   · 把判据从「严格更晚」放宽成「更晚或同刻」⇒ F5 红；
//   · 去掉「同值不算新证据」⇒ F4 与库级「同值重放」红。
//
// 上游依据：Graphiti `graphiti_core/utils/maintenance/edge_operations.py#_apply_temporal_invalidation`
//   —— 旧边 `invalid_at = 新边.valid_at`、`expired_at = now()`，**打区间不删行**；检索默认不排除已失效边。
// 本仓判据：`docs/数据契约.md` §9.1（F1–F10）。
//
// 覆盖：
//   ① 主体+属性键（F1）：version 取包名、裸版本/无 expect 的 file 事实不判、跨作用域不判（F7）
//   ② 互斥取值 + 严格更晚（F2/F3）：`invalidAt` = 最早那根压倒它的新证据的 occurredAt
//   ③ 同值重放不置位（F4）、同刻不同值不判（F5）、supersedes 链（F6）、无时间/无判定时刻不判（F8/F9）
//   ④ 库级（R15）：新值到达 ⇒ 旧行 `expiredAt` 置位**且仍可查**，正文/证据/state 一字不改（F10）
//   ⑤ 幂等：重放不改口（`expiredAt` 首次判定为准）、库文件逐字节不变
//   ⑥ 注入内容不因新增字段改变（A2b：卡片文本逐位相同）
//   ⑦ 归档端到端：一局里旧的版本事实被更晚的一局顶掉
//
// 夹具全在 os.tmpdir；不写 <DSH_HOME>；零模型调用；不启动服务；不新增依赖。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  applyTemporalInvalidation,
  temporalSubjectOf,
  temporalValueOf,
} from '../src/rooms/claim.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { buildMemoryCard } from '../src/rooms/inject.mjs';
import { runArchive } from '../scripts/archive.mjs';

const T0 = 1_700_000_000_000;
const SCOPE = 'w:d:/work/demo';
const OTHER = 'w:e:/other/ws';

let tmp;
test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-t15-'));
});
test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** 一条带 validity 的 claim（其余字段照 R09 的产出形状，够用就行）。 */
const claimOf = ({ id, validity, occurredAt, scopeKey = SCOPE, kind = 'fact', text = 'x', state = 'observed' }) => ({
  id,
  kind,
  text,
  scopeKey,
  threadIds: [],
  state,
  support: [{ episode: 'ep-aaaaaaaa', threadId: null, nodeId: null, edgeId: null, seq: 1, quote: text, occurredAt }],
  counter: [],
  validity,
  preconditions: [],
  occurredAt,
  recordedAt: T0,
  validFrom: occurredAt,
  validTo: null,
  counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
  supersedes: null,
});

const versionClaim = (id, value, occurredAt, scopeKey = SCOPE) => claimOf({
  id, occurredAt, scopeKey, validity: { type: 'version', value }, text: `版本 ${value}`,
});
const fileClaim = (id, value, expect, occurredAt) => claimOf({
  id, occurredAt, validity: { type: 'file', value, ...(expect ? { expect } : {}) }, text: `路径 ${value}`,
});

const newStore = () => {
  const root = mkdtempSync(path.join(tmp, 'store-'));
  const store = createStore({ root, now: T0 });
  store.ensureDirs();
  return { root, store };
};

// ---------------------------------------------------------------------------
// ① 主体+属性键（F1）：能不能判，取决于有没有机械主体
// ---------------------------------------------------------------------------

test('F1：主体键 = (作用域, validity.type, 主体)；裸版本与无 expect 的 file 事实不判', () => {
  assert.equal(
    temporalSubjectOf(versionClaim('c-00000001', 'yaml@2.4.1', T0)),
    `${SCOPE}\u0000version\u0000yaml`,
    'version：主体 = 包名',
  );
  assert.equal(
    temporalSubjectOf(versionClaim('c-00000002', '@scope/pkg@1.2.3', T0)),
    `${SCOPE}\u0000version\u0000@scope/pkg`,
    'scoped 包名要整段留下（不能把 @scope/pkg 切成 pkg）',
  );
  assert.equal(
    temporalSubjectOf(versionClaim('c-00000003', '1.2.3', T0)),
    null,
    '裸版本（`version=1.2.3` 没写包名）没有主体 ⇒ 不判',
  );
  assert.equal(
    temporalSubjectOf(fileClaim('c-00000004', 'd:/x/cfg.json', 'missing', T0)),
    `${SCOPE}\u0000file\u0000d:/x/cfg.json`,
    'file：主体 = 归一后的路径',
  );
  assert.equal(
    temporalSubjectOf(fileClaim('c-00000005', 'd:/x/cfg.json', null, T0)),
    null,
    '没写 expect 的 file 事实语义不明 ⇒ 不判',
  );
  assert.equal(temporalSubjectOf(claimOf({ id: 'c-00000006', validity: { type: 'none', value: null }, occurredAt: T0 })), null);
  assert.equal(temporalSubjectOf(claimOf({ id: 'c-00000007', validity: { type: 'version', value: 'yaml@1.0.0' }, occurredAt: T0, scopeKey: '' })), null);
  assert.equal(temporalSubjectOf(null), null);
  // 取值就是"被互斥比较的那一位"
  assert.equal(temporalValueOf(versionClaim('c-00000008', 'yaml@2.4.1', T0)), '2.4.1');
  assert.equal(temporalValueOf(fileClaim('c-00000009', 'd:/x/cfg.json', 'missing', T0)), 'missing');
});

// ---------------------------------------------------------------------------
// ② 互斥取值 + 严格更晚（F2/F3）
// ---------------------------------------------------------------------------

test('F2/F3：同键不同值 ⇒ 旧值置位；invalidAt = 最早那根更晚的新证据', () => {
  const a = versionClaim('c-aaaaaaa1', 'yaml@1.0.0', T0);          // 最旧
  const b = versionClaim('c-bbbbbbb1', 'yaml@2.0.0', T0 + 30_000); // 中间
  const c = versionClaim('c-ccccccc1', 'yaml@3.0.0', T0 + 90_000); // 最新
  const { claims, expired, stats } = applyTemporalInvalidation({ claims: [a, b, c], now: T0 + 500_000 });

  assert.equal(stats.expired, 2, '只有两条旧值被判失效（最新那条不会失效）');
  const byId = new Map(claims.map((x) => [x.id, x]));
  assert.equal(byId.get('c-aaaaaaa1').invalidAt, T0 + 30_000, '最早那根新证据 = 30s 那条（不是 90s）');
  assert.equal(byId.get('c-aaaaaaa1').expiredAt, T0 + 500_000, 'expiredAt = 判定时刻');
  assert.equal(byId.get('c-bbbbbbb1').invalidAt, T0 + 90_000);
  assert.equal(byId.get('c-ccccccc1').invalidAt, undefined, '最新值不带失效标注');
  assert.equal(byId.get('c-ccccccc1').expiredAt, undefined);
  assert.equal(expired.filter((r) => r.changed).length, 2);
  // 纯函数：不改入参
  assert.equal(a.invalidAt, undefined, '入参不许被就地改');
});

test('F4：同值重放 ⇒ 不置位（幂等）', () => {
  const a = versionClaim('c-aaaaaaa1', 'yaml@2.4.1', T0);
  const same = versionClaim('c-bbbbbbb1', 'yaml@2.4.1', T0 + 30_000); // 同一件事实再记一次
  const { claims, stats } = applyTemporalInvalidation({ claims: [a, same], now: T0 + 500_000 });
  assert.equal(stats.expired, 0);
  for (const c of claims) {
    assert.equal(c.invalidAt, undefined);
    assert.equal(c.expiredAt, undefined);
  }
});

test('F5：同刻（occurredAt 相等）不同值 ⇒ 不判（分不出先后就不编）', () => {
  const a = versionClaim('c-aaaaaaa1', 'yaml@1.0.0', T0 + 30_000);
  const b = versionClaim('c-bbbbbbb1', 'yaml@2.0.0', T0 + 30_000);
  const { claims, stats } = applyTemporalInvalidation({ claims: [a, b], now: T0 + 500_000 });
  assert.equal(stats.expired, 0);
  assert.deepEqual(claims.map((c) => c.invalidAt), [undefined, undefined]);
});

test('F6：supersedes 链同样打区间', () => {
  const oldOne = versionClaim('c-aaaaaaa1', 'yaml@1.0.0', T0);
  const newOne = { ...versionClaim('c-bbbbbbb1', 'yaml@2.0.0', T0 + 30_000), supersedes: 'c-aaaaaaa1' };
  const { claims, stats } = applyTemporalInvalidation({ claims: [oldOne, newOne], now: T0 + 500_000 });
  const byId = new Map(claims.map((x) => [x.id, x]));
  assert.equal(stats.expired, 1);
  assert.equal(byId.get('c-aaaaaaa1').invalidAt, T0 + 30_000);
  assert.equal(byId.get('c-aaaaaaa1').expiredAt, T0 + 500_000);
});

test('F7：跨作用域不互相失效', () => {
  const a = versionClaim('c-aaaaaaa1', 'yaml@1.0.0', T0, SCOPE);
  const b = versionClaim('c-bbbbbbb1', 'yaml@2.0.0', T0 + 30_000, OTHER);
  const { stats } = applyTemporalInvalidation({ claims: [a, b], now: T0 + 500_000 });
  assert.equal(stats.expired, 0, 'w:a 的版本不许杀掉 w:b 的版本（方案 §4.10）');
});

test('F8/F9：缺 occurredAt 或缺判定时刻 ⇒ 不判', () => {
  const a = versionClaim('c-aaaaaaa1', 'yaml@1.0.0', null);
  const b = versionClaim('c-bbbbbbb1', 'yaml@2.0.0', T0 + 30_000);
  const noTime = applyTemporalInvalidation({ claims: [a, b], now: T0 + 500_000 });
  assert.equal(noTime.stats.expired, 0, '无时不入');
  assert.equal(noTime.stats.skippedNoTime, 1);

  // 两条都有时间 ⇒ 判定会发生，但没给判定时刻 ⇒ 落不了 expiredAt（不许拿 Date.now() 冒充）
  const a2 = versionClaim('c-aaaaaaa2', 'yaml@1.0.0', T0);
  const noClock = applyTemporalInvalidation({ claims: [a2, b], now: null });
  assert.equal(noClock.stats.expired, 1, '判定发生了……');
  assert.equal(noClock.stats.skippedNoClock, 1, '……但判定时刻缺失 ⇒ 不落字段');
  assert.ok(noClock.claims.every((c) => c.expiredAt === undefined));
});

test('F10：只增不改 —— 正文/证据/state 一字不改，只多两个时间字段', () => {
  const a = versionClaim('c-aaaaaaa1', 'yaml@1.0.0', T0);
  const b = versionClaim('c-bbbbbbb1', 'yaml@2.0.0', T0 + 30_000);
  const before = JSON.stringify({ text: a.text, support: a.support, state: a.state, counter: a.counter });
  const { claims } = applyTemporalInvalidation({ claims: [a, b], now: T0 + 500_000 });
  const after = claims.find((c) => c.id === 'c-aaaaaaa1');
  assert.equal(JSON.stringify({ text: after.text, support: after.support, state: after.state, counter: after.counter }), before);
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(a), 'expiredAt', 'invalidAt'].sort(), '只多两个字段');
  // 已判定过的：expiredAt 不搬家，invalidAt 取更早
  const again = applyTemporalInvalidation({ claims, now: T0 + 900_000 });
  const same = again.claims.find((c) => c.id === 'c-aaaaaaa1');
  assert.equal(same.expiredAt, T0 + 500_000, '首次判定为准，重放不改口');
  assert.equal(same.invalidAt, T0 + 30_000);
});

// ---------------------------------------------------------------------------
// ④⑤ 库级（R15 写入侧）
// ---------------------------------------------------------------------------

test('库级：新值到达 ⇒ 旧值 expiredAt 置位且仍可查；正文/证据/state 不变', () => {
  const { store } = newStore();
  const oldOne = versionClaim('c-old00001', 'yaml@1.16.0', T0);
  const newOne = versionClaim('c-new00001', 'yaml@1.17.6', T0 + 90_000);
  const before = store.putMany('claims', [oldOne], { at: T0 });
  assert.equal(before.written, 1);
  assert.equal('expired' in before, false, '没有失效发生时返回值不多出 expired 键（旧形状不变）');
  assert.equal(store.get('claims', 'c-old00001').expiredAt, undefined);

  const second = store.putMany('claims', [newOne], { at: T0 + 200_000 });
  assert.equal(second.written, 1);
  assert.equal(second.expired.count, 1);
  assert.equal(second.expired.written, 1, '既有条目被追加写了一条（只加两个字段）');
  assert.deepEqual(second.expired.ids, ['c-old00001']);

  const old = store.get('claims', 'c-old00001');
  assert.equal(old.invalidAt, T0 + 90_000, '失效起点 = 新证据的 occurredAt');
  assert.equal(old.expiredAt, T0 + 200_000, '判定时刻 = 本次写入的 at');
  // 旧行保留、可查、可读：正文/证据/state 一字不改
  assert.equal(old.text, oldOne.text);
  assert.deepEqual(old.support, oldOne.support);
  assert.equal(old.state, oldOne.state);
  assert.deepEqual(store.list('claims').map((x) => x.id).sort(), ['c-new00001', 'c-old00001']);
  // 新值本身不带失效标注
  const fresh = store.get('claims', 'c-new00001');
  assert.equal(fresh.invalidAt, undefined);
  assert.equal(fresh.expiredAt, undefined);
});

test('库级：同值重放 ⇒ 不置位；再跑一次 ⇒ 不改口、库文件逐字节不变', () => {
  const { store } = newStore();
  store.putMany('claims', [versionClaim('c-old00001', 'yaml@1.16.0', T0)], { at: T0 });
  const replay = store.putMany('claims', [versionClaim('c-old00001', 'yaml@1.16.0', T0)], { at: T0 + 50_000 });
  assert.equal(replay.written, 0, '同值重放 = 同内容，不重写');
  assert.equal('expired' in replay, false, '同值不是新证据 ⇒ 不置位');
  assert.equal(store.get('claims', 'c-old00001').expiredAt, undefined);

  store.putMany('claims', [versionClaim('c-new00001', 'yaml@1.17.6', T0 + 90_000)], { at: T0 + 200_000 });
  const snapshot = JSON.stringify(store.get('claims', 'c-old00001'));
  const third = store.putMany('claims', [versionClaim('c-new00001', 'yaml@1.17.6', T0 + 90_000)], { at: T0 + 900_000 });
  assert.equal(third.written, 0);
  assert.equal(third.expired, undefined, '已判定过的标注不重复写（幂等）');
  assert.equal(JSON.stringify(store.get('claims', 'c-old00001')), snapshot, 'expiredAt 不因重放搬家，文件逐字节不变');
});

// ---------------------------------------------------------------------------
// ⑥ 注入内容不因新增字段改变（A2b 逐位不变）
// ---------------------------------------------------------------------------

test('A2b：卡片文本在失效前后逐位相同（新增字段不改变注入内容）', () => {
  const { store } = newStore();
  const episode = {
    id: 'ep-aaaaaaa1',
    sessionId: 'session-aaaaaaaa',
    scopeKey: SCOPE,
    startedAt: T0,
    endedAt: T0 + 3_600_000,
    firstEventAt: T0,
    lastEventAt: T0 + 3_600_000,
    recordedAt: null,
    closure: { logPath: 'sessions/demo/x/session.v4.jsonl.zstd', graphPath: 'graphs/x/graph.json', seqFrom: 1, seqTo: 9 },
    l0: '',
    signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    threadIds: [],
    state: 'archived',
  };
  store.putMany('episodes', [episode], { at: T0 });
  store.putMany('claims', [versionClaim('c-old00001', 'yaml@1.16.0', T0)], { at: T0 });

  const walkResult = {
    hits: [{ episode: 'ep-aaaaaaa1', nodeId: null, link: null, why: ['yaml'], weight: 1, occurredAt: T0, kind: 'failure', seq: 1, depth: 1, claim: 'c-old00001' }],
    path: [],
    omitted: { count: 0, reason: '' },
    tokens: 0,
    depth: 1,
  };
  // 两次取卡用**同一个 now**：卡片里的 decay 是 (now - occurredAt) 的函数，与本改动无关。
  const BEFORE_NOW = T0 + 300_000;
  const before = buildMemoryCard({ walkResult, store, scope: SCOPE, now: BEFORE_NOW });
  assert.ok(before.section, '夹具必须真的展开出一个 section，否则这条测不到东西');

  store.putMany('claims', [versionClaim('c-new00001', 'yaml@1.17.6', T0 + 90_000)], { at: T0 + 200_000 });
  assert.equal(store.get('claims', 'c-old00001').expiredAt, T0 + 200_000, '旧行确实失效了');

  const after = buildMemoryCard({ walkResult, store, scope: SCOPE, now: BEFORE_NOW });
  assert.equal(after.indexLine, before.indexLine, 'INDEX 行逐位不变');
  assert.equal(after.section, before.section, '命中展开逐位不变');
  assert.equal(JSON.stringify(after.claims), JSON.stringify(before.claims));
  assert.equal(after.tokens, before.tokens);
});

// ---------------------------------------------------------------------------
// ⑦ 归档端到端（runArchive → putMany 接线）
// ---------------------------------------------------------------------------

const SCOPE_DIR = '--D-work-demo--';
const zframe = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));

/** 一局会话：一条成功的 `pnpm add <pkg>@<ver>` 命令 ⇒ R09 产出一条 version fact。 */
function buildCorpus(root, { sid, version, base }) {
  const dir = path.join(root, 'sessions', SCOPE_DIR, sid);
  mkdirSync(dir, { recursive: true });
  const header = {
    type: 'session', version: 4, id: sid, createdAt: base, cwd: 'D:\\work\\demo',
    isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  };
  const action = `bash(command=pnpm add yaml@${version})`;
  const events = [
    { type: 'user/message', seq: 1, time: base + 1_000, data: { content: [{ type: 'text', text: '装一下 yaml' }] } },
    { type: 'tool/call', seq: 2, time: base + 2_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: `pnpm add yaml@${version}` }) } },
    { type: 'tool/result', seq: 3, time: base + 3_000, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '[exit code: 0]' }] } } },
  ];
  writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat([zframe(`${JSON.stringify(header)}\n`), zframe(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)]),
  );

  const gdir = path.join(root, 'chess-context', 'sessions', sid);
  mkdirSync(gdir, { recursive: true });
  writeFileSync(path.join(gdir, 'graph.json'), `${JSON.stringify({
    version: 1, sessionId: sid, createdAt: base, updatedAt: base + 9_000, nextNode: 3, nextEdge: 2,
    nodes: {
      n1: { id: 'n1', kind: 'user', seq: 1, text: '装一下 yaml', ts: base + 1_000 },
      n2: { id: 'n2', kind: 'agent', seq: 2, turn: 1, ts: base + 2_000 },
    },
    edges: {
      e1: {
        id: 'e1', from: 'n1', to: 'n2', action,
        result: 'success', evidence: { start: 3 }, ts: base + 3_000,
      },
    },
    order: ['n1', 'n2'], stateIndex: {}, rootUserNodeIds: ['n1'], checkpointSeq: 3, foldCount: 0,
  }, null, 2)}\n`);
  return { root, storeRoot: path.join(root, 'memory-context') };
}

test('归档端到端：更晚的一局写了新版本 ⇒ 上一局的旧版本 claim 被置失效（仍可查）', async () => {
  const root = mkdtempSync(path.join(tmp, 'corpus-'));
  const fixture = buildCorpus(root, { sid: 'session-11111111-1111-4111-8111-111111111111', version: '1.16.0', base: T0 });
  buildCorpus(root, { sid: 'session-22222222-2222-4222-8222-222222222222', version: '1.17.6', base: T0 + 100_000 });

  const now = T0 + 500_000;
  await runArchive({ dataRoot: fixture.root, storeRoot: fixture.storeRoot, now });

  const store = createStore({ root: fixture.storeRoot });
  const claims = store.list('claims').map((x) => x.record).filter(Boolean);
  const versions = claims.filter((c) => c.validity?.type === 'version');
  assert.equal(versions.length, 2, `两局两个版本字面量 ⇒ 两条 fact（实际 ${versions.length}）`);
  const older = versions.find((c) => c.validity.value === 'yaml@1.16.0');
  const newer = versions.find((c) => c.validity.value === 'yaml@1.17.6');
  assert.ok(older && newer, '两条都要在库里（只增不改）');
  assert.equal(older.invalidAt, newer.occurredAt, '旧值失效起点 = 新证据的 occurredAt');
  assert.equal(older.expiredAt, now, '判定时刻 = 本次归档的 now');
  assert.equal(newer.invalidAt, undefined);
  // 旧行仍可查、正文与证据仍在
  assert.ok(older.text.includes('yaml@1.16.0'));
  assert.ok(Array.isArray(older.support) && older.support.length >= 1);
  assert.equal(older.state, 'observed');
});
