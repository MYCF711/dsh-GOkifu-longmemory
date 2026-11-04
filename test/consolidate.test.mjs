// R17 · consolidate 的 tombstone test（删掉 src/rooms/consolidate.mjs ⇒ 本文件整片红）
//
// 覆盖（契约 `docs/合流-契约.md` §2.3/§2.4/§4.2/§6）：
//   ① Tier 0（同证据写重）与 Tier 1（≥2 口径命中）各自被识别
//   ② 只命中 1 个口径的相似对**不在** groups 里（单口径禁止）
//   ③ T1：组内 `mergedText` 逐字等于 `representative.quote`，且 representative 的 `(episode, seq)` 在并集里
//   ④ 确定性：同一库两次调用 deepEqual（含 groups 顺序）
//   ⑤ 只读：`dryRun` 期间库文件 sha256 全部不变；`dryRun:false` 直接抛错（真写是 S3）
//   ⑥ 否决项 V3–V8 各自把对应的对挡在 groups 外（计入 stats.blocked）
//
// 夹具：真 store（os.tmpdir 下的临时库），每个场景一个独立 scope ⇒ 分桶隔离，互不串味。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import { consolidate, judgePair, ConsolidateError, TIERS } from '../src/rooms/consolidate.mjs';

const T0 = 1_790_000_000_000;
const SCOPE = (name) => `w:test/${name}`;

const claim = (id, text, { scope = SCOPE('bucket'), episode = 'ep-aaaaaaaa', seq = 10, at = T0, ...rest } = {}) => ({
  id,
  kind: 'antipattern',
  scopeKey: scope,
  state: 'observed',
  text,
  support: [{ episode, seq, quote: text, occurredAt: at }],
  counter: [],
  validity: { type: 'none', value: null },
  preconditions: [{ check: 'scope', value: scope, why: 'fixture' }],
  occurredAt: at,
  threadIds: [],
  ...rest,
});

/** 临时库 + 写夹具；返回 { root, store, cleanup }。 */
function makeStore(claims) {
  const root = mkdtempSync(join(tmpdir(), 'kifuin-consolidate-'));
  const store = createStore({ root });
  for (const record of claims) store.put('claims', record);
  return { root, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 目录下所有文件的 (相对路径, sha256)。 */
function snapshot(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else out.push([rel, createHash('sha256').update(readFileSync(abs)).digest('hex')]);
    }
  };
  walk(root, '');
  return out;
}

function fixtureClaims() {
  const c = [];
  // Tier 0：同 (episode, seq) 同一句话写了两遍
  c.push(claim('c-same-01', "Error: ENOENT: no such file or directory, open 'cfg.json'", { scope: SCOPE('t0'), episode: 'ep-t0', seq: 100 }));
  c.push(claim('c-same-02', "Error: ENOENT: no such file or directory, open 'cfg.json'", { scope: SCOPE('t0'), episode: 'ep-t0', seq: 100 }));
  // Tier 1：不同局，命中 A（词集）+ C（错误类 + 前 40 码点）
  c.push(claim('c-crit-01', "Error: Cannot find module 'yaml' at require (node:internal/modules/cjs/loader:1)", { scope: SCOPE('t1'), episode: 'ep-t1a', seq: 11 }));
  c.push(claim('c-crit-02', "Error: Cannot find module 'yaml' at require (node:internal/modules/cjs/loader:2)", { scope: SCOPE('t1'), episode: 'ep-t1b', seq: 12 }));
  // 单口径：只命中 A（前缀不同 ⇒ C 不命中；无 CJK ⇒ B 不命中）
  c.push(claim('c-one-01', 'alpha beta gamma delta epsilon zeta', { scope: SCOPE('one'), episode: 'ep-one-a', seq: 21 }));
  c.push(claim('c-one-02', 'alpha beta gamma delta epsilon eta', { scope: SCOPE('one'), episode: 'ep-one-b', seq: 22 }));
  // V3：preconditions 不同
  c.push(claim('c-v3-01', 'Error: boom at startup', { scope: SCOPE('v3'), episode: 'ep-v3a', seq: 31 }));
  c.push(claim('c-v3-02', 'Error: boom at startup', {
    scope: SCOPE('v3'), episode: 'ep-v3b', seq: 32,
    preconditions: [{ check: 'scope', value: SCOPE('v3'), why: 'fixture' }, { check: 'file-exists', value: 'cfg.json', why: 'fixture' }],
  }));
  // V4：validity 不同
  c.push(claim('c-v4-01', 'version = "1.2.3"', { scope: SCOPE('v4'), episode: 'ep-v4a', seq: 41, validity: { type: 'version', value: '1.2.3' } }));
  c.push(claim('c-v4-02', 'version = "1.2.3"', { scope: SCOPE('v4'), episode: 'ep-v4b', seq: 42, validity: { type: 'version', value: '1.2.4' } }));
  // V5：counter 非空
  c.push(claim('c-v5-01', 'Error: flaky test failed', { scope: SCOPE('v5'), episode: 'ep-v5a', seq: 51 }));
  c.push(claim('c-v5-02', 'Error: flaky test failed', {
    scope: SCOPE('v5'), episode: 'ep-v5b', seq: 52,
    counter: [{ episode: 'ep-v5b', seq: 99, quote: '这次没有失败', occurredAt: T0 + 1 }],
  }));
  // V6：state = disputed
  c.push(claim('c-v6-01', 'Error: race condition on shutdown', { scope: SCOPE('v6'), episode: 'ep-v6a', seq: 61 }));
  c.push(claim('c-v6-02', 'Error: race condition on shutdown', { scope: SCOPE('v6'), episode: 'ep-v6b', seq: 62, state: 'disputed' }));
  // V7：class:* 类级章节
  c.push(claim('c-cls-01', "class:module-missing · Error: Cannot find module 'yaml'", { scope: SCOPE('v7'), episode: 'ep-v7a', seq: 71 }));
  c.push(claim('c-cls-02', "class:module-missing · Error: Cannot find module 'yaml'", { scope: SCOPE('v7'), episode: 'ep-v7b', seq: 72 }));
  // V8：输出噪声
  c.push(claim('c-noise-01', 'ℹ tests 10 ℹ pass 10 ℹ fail 0', { scope: SCOPE('v8'), episode: 'ep-v8a', seq: 81 }));
  c.push(claim('c-noise-02', 'ℹ tests 10 ℹ pass 10 ℹ fail 0', { scope: SCOPE('v8'), episode: 'ep-v8b', seq: 82 }));
  return c;
}

test('R17 consolidate: Tier 0 与 Tier 1 各自被识别', () => {
  const { store, cleanup } = makeStore(fixtureClaims());
  try {
    const report = consolidate({ store });
    const t0 = report.groups.filter((g) => g.scopeKey === SCOPE('t0'));
    const t1 = report.groups.filter((g) => g.scopeKey === SCOPE('t1'));
    assert.equal(t0.length, 1, '同证据写重应成 1 组');
    assert.equal(t1.length, 1, '≥2 口径命中应成 1 组');
    assert.equal(t0[0].tier, TIERS.SAME_EVIDENCE);
    assert.equal(t1[0].tier, TIERS.MULTI_CRITERIA);
    assert.deepEqual(t0[0].members, ['c-same-01', 'c-same-02']);
    assert.deepEqual(t1[0].members, ['c-crit-01', 'c-crit-02']);
    assert.equal(t0[0].supportEpisodes, 1);
    assert.equal(t1[0].supportEpisodes, 2, '跨局组要累计独立局数');
    assert.equal(report.stats.byTier[0], 1);
    assert.equal(report.stats.byTier[1], 1);
    assert.equal(report.stats.groups, 2);
  } finally {
    cleanup();
  }
});

test('R17 consolidate: 单口径禁止 —— 只命中 1 个口径的相似对不进 groups', () => {
  const { store, cleanup } = makeStore(fixtureClaims());
  try {
    const report = consolidate({ store });
    assert.equal(report.groups.filter((g) => g.scopeKey === SCOPE('one')).length, 0, '单口径组不许出现');
    assert.ok(report.stats.blocked.singleCriterion >= 1, '应计入 blocked.singleCriterion');
    // 判据函数本身可复算
    const a = claim('c-a', 'alpha beta gamma delta epsilon zeta');
    const b = claim('c-b', 'alpha beta gamma delta epsilon eta');
    const verdict = judgePair(a, b);
    assert.equal(verdict.qualified, false);
    assert.equal(verdict.reason, 'singleCriterion');
    assert.equal(verdict.criteria.hits, 1, 'A 命中、B/C 不命中');
  } finally {
    cleanup();
  }
});

test('R17 consolidate: 否决项 V3–V8 各自挡住对应的对', () => {
  const { store, cleanup } = makeStore(fixtureClaims());
  try {
    const report = consolidate({ store });
    for (const gate of ['v3', 'v4', 'v5', 'v6', 'v7', 'v8']) {
      assert.ok(report.stats.blocked[gate] >= 1, `${gate} 应有命中`);
    }
    for (const name of ['v3', 'v4', 'v5', 'v6', 'v7', 'v8']) {
      assert.equal(report.groups.filter((g) => g.scopeKey === SCOPE(name)).length, 0, `${name} 场景不许成组`);
    }
  } finally {
    cleanup();
  }
});

test('R17 consolidate: T1 —— mergedText 逐字来自 representative.quote，且 (episode, seq) 在并集里', () => {
  const { store, cleanup } = makeStore(fixtureClaims());
  try {
    const report = consolidate({ store });
    assert.ok(report.groups.length > 0);
    for (const group of report.groups) {
      assert.equal(group.mergedText, group.representative.quote, 'mergedText 就是 representative.quote（不拼接、不加前缀）');
      assert.ok(group.mergedText.length > 0);
      const keys = new Set();
      for (const id of group.members) {
        const record = store.get('claims', id);
        for (const s of record.support ?? []) keys.add(`${s.episode}#${s.seq}`);
      }
      assert.ok(keys.has(`${group.representative.episode}#${group.representative.seq}`), 'representative 的 (episode, seq) 必须在成员 support 并集里');
      assert.ok(group.members.includes(group.representative.claimId));
    }
    assert.equal(report.quality.t1, true);
    assert.equal(report.ok, true);
  } finally {
    cleanup();
  }
});

test('R17 consolidate: 确定性 —— 同一库两次调用 deepEqual（含 groups 顺序）', () => {
  const { store, cleanup } = makeStore(fixtureClaims());
  try {
    const a = consolidate({ store, now: T0 });
    const b = consolidate({ store, now: T0 });
    assert.deepEqual(a, b);
    assert.equal(a.quality.t4, true, '排序稳定');
  } finally {
    cleanup();
  }
});

test('R17 consolidate: 只读 —— dryRun 期间库文件 sha256 全部不变', () => {
  const { root, store, cleanup } = makeStore(fixtureClaims());
  try {
    const before = snapshot(root);
    consolidate({ store });
    consolidate({ store });
    const after = snapshot(root);
    assert.deepEqual(after, before, 'dryRun 不许写盘');
  } finally {
    cleanup();
  }
});

test('R17 consolidate: dryRun:false 直接抛错（真写是 S3）', () => {
  const { store, cleanup } = makeStore([claim('c-x', 'Error: x')]);
  try {
    assert.throws(() => consolidate({ store, dryRun: false }), (error) => error instanceof ConsolidateError && error.code === 'consolidate/dry-run-only');
  } finally {
    cleanup();
  }
});

test('R17 consolidate: 作用域过滤与统计口径', () => {
  const { store, cleanup } = makeStore(fixtureClaims());
  try {
    const only = consolidate({ store, scope: SCOPE('t0') });
    assert.equal(only.groups.length, 1);
    assert.equal(only.stats.claims, 2);
    const all = consolidate({ store });
    const merged = all.groups.reduce((acc, g) => acc + (g.members.length - 1), 0);
    assert.equal(all.stats.merged, merged);
    assert.equal(all.stats.reduction, merged / all.stats.claims);
    assert.equal(all.stats.candidates, all.stats.claims - all.stats.blocked.v7 - all.stats.blocked.v8);
    assert.equal(all.stats.blocked.t1, 0, '没有组因 T1 被丢弃');
  } finally {
    cleanup();
  }
});

test('R17 consolidate: 非法输入抛 ConsolidateError', () => {
  assert.throws(() => consolidate({ store: null }), (error) => error instanceof ConsolidateError && error.code === 'consolidate/missing-store');
  assert.throws(() => consolidate({ store: {} }), (error) => error instanceof ConsolidateError && error.code === 'consolidate/missing-store');
});
