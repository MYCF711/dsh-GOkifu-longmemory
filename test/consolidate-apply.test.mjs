// T161 · 合流写路径（影子库）的 tombstone test：删掉 scripts/consolidate-apply.mjs 或
// `src/rooms/consolidate.mjs` 的 applyToShadow ⇒ 本文件整片红。
//
// 覆盖（契约 §4.1/§5.2 + T161 任务书）：
//   ① 源库 sha256 全程不变（只读源库）
//   ② 影子库多出合并节点、且成员一个不少
//   ③ 幂等：同一影子库连跑两次，第二次新增 0 条
//   ④ T1 逐字：合并节点 `text` ⊆ `representative.quote`
//   ⑤ 缺省 `outStoreDir` ⇒ 抛 `consolidate/need-out-dir`
//   ⑥ `outStoreDir` 在源库内 ⇒ 抛 `consolidate/out-inside-source`（防误写真库）
//   ⑦ CLI `main()`：dry-run 不落盘；`--out` 落盘并打印 stats

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import { consolidate, ConsolidateError } from '../src/rooms/consolidate.mjs';
import { main as cliMain } from '../scripts/consolidate-apply.mjs';

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

function makeSource() {
  const root = mkdtempSync(join(tmpdir(), 'kifuin-apply-src-'));
  const store = createStore({ root });
  const claims = [
    // Tier 0：同 (episode, seq) 同一句话写了两遍
    claim('c-same-01', "Error: ENOENT: no such file or directory, open 'cfg.json'", { scope: SCOPE('t0'), episode: 'ep-t0', seq: 100 }),
    claim('c-same-02', "Error: ENOENT: no such file or directory, open 'cfg.json'", { scope: SCOPE('t0'), episode: 'ep-t0', seq: 100 }),
    // Tier 1：跨局 + A/C 两口径命中
    claim('c-crit-01', "Error: Cannot find module 'yaml' at require (node:internal/modules/cjs/loader:1)", { scope: SCOPE('t1'), episode: 'ep-t1a', seq: 11 }),
    claim('c-crit-02', "Error: Cannot find module 'yaml' at require (node:internal/modules/cjs/loader:2)", { scope: SCOPE('t1'), episode: 'ep-t1b', seq: 12 }),
    // 单口径：不该被合
    claim('c-one-01', 'alpha beta gamma delta epsilon zeta', { scope: SCOPE('one'), episode: 'ep-one-a', seq: 21 }),
    claim('c-one-02', 'alpha beta gamma delta epsilon eta', { scope: SCOPE('one'), episode: 'ep-one-b', seq: 22 }),
    // 一条独立 claim（拷贝会不会漏掉它）
    claim('c-solo-01', 'Error: standalone failure with a distinct shape', { scope: SCOPE('solo'), episode: 'ep-solo', seq: 31 }),
  ];
  for (const record of claims) store.put('claims', record);
  return { root, store, claims, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function snapshot(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else out.push([rel, createHash('sha256').update(readFileSync(abs)).digest('hex')]);
    }
  };
  walk(root, '');
  return out;
}

test('T161: 源库只读 —— apply 前后源库 sha256 完全不变', () => {
  const src = makeSource();
  const outDir = `${src.root}-shadow`;
  try {
    const before = snapshot(src.root);
    const report = consolidate({ store: src.store, dryRun: false, outStoreDir: outDir });
    const after = snapshot(src.root);
    assert.deepEqual(after, before, '源库一个字节都不许动');
    assert.ok(report.apply, 'apply 结果要回传');
    assert.equal(report.apply.outStoreDir, outDir);
  } finally {
    src.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('T161: 影子库 = 源库全部 claim + 合并节点，成员一个不删', () => {
  const src = makeSource();
  const outDir = `${src.root}-shadow`;
  try {
    const report = consolidate({ store: src.store, dryRun: false, outStoreDir: outDir });
    const shadow = createStore({ root: outDir });
    const ids = new Set(shadow.ids('claims'));
    for (const record of src.claims) assert.ok(ids.has(record.id), `成员 ${record.id} 必须在影子库里`);
    assert.equal(ids.size, src.claims.length + report.apply.mergedAdded);
    assert.ok(report.apply.mergedAdded >= 2, 'Tier 0 + Tier 1 至少两条合并节点');

    // 合并节点形状（契约 §4.1）
    for (const id of report.apply.mergedIds) {
      const merged = shadow.get('claims', id);
      assert.ok(merged, `${id} 应已落盘`);
      assert.equal(merged.kind, 'antipattern');
      assert.equal(merged.supersedes, null);
      assert.equal(merged.counter.length, 0);
      assert.equal(merged.merge.version, 1);
      assert.ok(merged.merge.members.length >= 2);
      assert.ok(merged.support.length >= 1, 'support 并集非空');
      if (merged.merge.rule === 'multi-criteria') assert.ok(merged.support.length >= 2, '跨局组 support 并集至少两条');
      assert.equal(merged.counters.support, merged.support.length);
      assert.ok(['observed', 'candidate', 'semantic'].includes(merged.state));
      // 成员与 support 都在
      for (const memberId of merged.merge.members) assert.ok(ids.has(memberId));
    }
  } finally {
    src.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('T161: 幂等 —— 同一影子库连跑两次，第二次新增 0 条', () => {
  const src = makeSource();
  const outDir = `${src.root}-shadow`;
  try {
    const first = consolidate({ store: src.store, dryRun: false, outStoreDir: outDir });
    const shadowCount = createStore({ root: outDir }).ids('claims').length;
    const second = consolidate({ store: src.store, dryRun: false, outStoreDir: outDir });
    assert.equal(second.apply.mergedAdded, 0, '第二次不许再新增合并节点');
    assert.equal(second.apply.mergedRewritten, 0, '同内容重放不改写（时钟由成员派生）');
    assert.equal(createStore({ root: outDir }).ids('claims').length, shadowCount, '条数不叠加');
    assert.equal(second.apply.claimsCopiedChanged, 0, '源库拷贝也是幂等的');
    assert.deepEqual(second.apply.mergedIds, first.apply.mergedIds, '节点 id 集合稳定');
  } finally {
    src.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('T161: T1 逐字 —— 合并节点 text ⊆ representative.quote，且 (episode, seq) 在 support 里', () => {
  const src = makeSource();
  const outDir = `${src.root}-shadow`;
  try {
    const report = consolidate({ store: src.store, dryRun: false, outStoreDir: outDir });
    const shadow = createStore({ root: outDir });
    for (const id of report.apply.mergedIds) {
      const merged = shadow.get('claims', id);
      const rep = merged.merge.representative;
      assert.ok(rep.quote.includes(merged.text), 'text 必须是 representative.quote 的子串（逐字）');
      const keys = new Set(merged.support.map((s) => `${s.episode}#${s.seq}`));
      assert.ok(keys.has(`${rep.episode}#${rep.seq}`), 'representative 的 (episode, seq) 必须在 support 并集里');
    }
  } finally {
    src.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('T161: 缺省 outStoreDir ⇒ consolidate/need-out-dir（绝不默认写真库）', () => {
  const src = makeSource();
  try {
    for (const value of [undefined, null, '', '   ']) {
      assert.throws(
        () => consolidate({ store: src.store, dryRun: false, outStoreDir: value }),
        (error) => error instanceof ConsolidateError && error.code === 'consolidate/need-out-dir',
      );
    }
    // dryRun 默认 true 时不要求 outStoreDir
    assert.equal(consolidate({ store: src.store }).apply, null);
  } finally {
    src.cleanup();
  }
});

test('T161: outStoreDir 在源库内 ⇒ consolidate/out-inside-source（防把合并节点写回真库）', () => {
  const src = makeSource();
  try {
    assert.throws(
      () => consolidate({ store: src.store, dryRun: false, outStoreDir: join(src.root, 'shadow') }),
      (error) => error instanceof ConsolidateError && error.code === 'consolidate/out-inside-source',
    );
    assert.throws(
      () => consolidate({ store: src.store, dryRun: false, outStoreDir: src.root }),
      (error) => error instanceof ConsolidateError && error.code === 'consolidate/out-inside-source',
    );
    // 指向一个已存在的文件 ⇒ 明确报错（不是 ENOTDIR 崩溃）
    const file = join(`${src.root}-not-dir.txt`);
    writeFileSync(file, 'x');
    assert.throws(
      () => consolidate({ store: src.store, dryRun: false, outStoreDir: file }),
      (error) => error instanceof ConsolidateError && error.code === 'consolidate/out-not-directory',
    );
    rmSync(file, { force: true });
  } finally {
    src.cleanup();
  }
});

test('T161: CLI —— 默认 dry-run 不落盘；给 --out 才写并打印 stats', () => {
  const src = makeSource();
  const outDir = `${src.root}-cli-shadow`;
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  process.stderr.write = () => true;
  try {
    assert.equal(existsSync(outDir), false);
    const dry = cliMain(['--store', src.root]);
    assert.equal(dry, 0);
    assert.equal(existsSync(outDir), false, 'dry-run 不许建影子库');
    assert.match(lines.join(''), /dry-run/);

    const applied = cliMain(['--store', src.root, '--out', outDir]);
    assert.equal(applied, 0);
    const text = lines.join('');
    assert.match(text, /groups 2/);
    assert.match(text, /merged added 2/);
    assert.ok(existsSync(join(outDir, 'claims')), '影子库 claim 目录应存在');
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalErr;
    src.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  }
});
