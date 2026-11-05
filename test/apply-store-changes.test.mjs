// T201 的 tombstone test：删掉 `scripts/apply-store-changes.mjs` ⇒ 本文件红。
//
// 覆盖：
//   ① dry-run 一个字节都不写
//   ② 备份失败 ⇒ 不执行、不修改、退出非 0
//   ③ 幂等：连跑两次，第二次 0 变更
//   ④ 中途失败（合流抛错）⇒ 打印回滚命令且退出非 0
//
// 全部用 tmp 下的假库 + 注入依赖（不碰真库、不跑合流、不起进程）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createStore } from '../src/rooms/persist.mjs';
import { runApplyChanges, findStaleTargets, formatReport, parseArgs } from '../scripts/apply-store-changes.mjs';
import { buildMarked, isMarked } from '../scripts/mark-stale.mjs';

const T0 = 1_700_000_000_000;
let tmp;
test.before(() => { tmp = mkdtempSync(path.join(tmpdir(), 'kifu-t201-')); });
test.after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function makeStoreWithClaims(root, n = 3) {
  const store = createStore({ root });
  store.ensureDirs();
  const claims = [];
  for (let i = 1; i <= n; i += 1) {
    claims.push({
      id: `c-${String(i).padStart(8, '0')}`,
      kind: 'fact',
      text: `claim ${i} 的正文`,
      scopeKey: 'w:d:/work/demo',
      state: 'observed',
      support: [{ episode: 'ep-0001', seq: i, quote: `q${i}`, occurredAt: T0 }],
      counter: [],
      validity: { type: 'file', value: `docs/missing-${i}.md` },
      preconditions: [],
      occurredAt: T0,
      recordedAt: T0,
      counters: { support: 1, counter: 0 },
    });
  }
  store.putMany('claims', claims, { at: T0 });
  store.writeManifest(T0);
  return store;
}

const hashTree = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else out.push(`${path.relative(root, full)}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(root);
  return out.join('|');
};

/** 注入"这两条是真 stale"，其余判定交给真实 classify（会判不了 ⇒ 不计）。 */
function fakeFindStale({ store }) {
  const claims = store.list('claims').map((e) => e.record).filter(Boolean).filter((c) => !isMarked(c));
  const WANTED = new Set(['c-00000001', 'c-00000002']);
  const targets = claims.filter((c) => WANTED.has(c.id)).map((record) => ({ id: record.id, reason: 'file-appeared', mark: buildMarked(record, { at: T0 + 1000, reason: 'file-appeared', detail: {} }) }));
  return { targets, already: 0, scanned: claims.length, unjudgeable: 0 };
}

test('T201 ①: dry-run 一个字节都不写', () => {
  const root = path.join(mkdtempSync(path.join(tmp, 'dry-')), 'store');
  makeStoreWithClaims(root);
  const before = hashTree(root);
  const res = runApplyChanges({ storeRoot: root, doStale: true, apply: false, now: T0 + 1000, deps: { findStaleTargets: fakeFindStale } });
  assert.equal(res.code, 0);
  assert.equal(res.dryRun, true);
  assert.equal(res.stale.targets, 2, '预览能算出 2 条');
  assert.equal(res.stale.written, 0, 'dry-run 不写');
  assert.equal(hashTree(root), before, '库逐字节未变');
});

test('T201 ②: 备份失败 ⇒ 不执行、不修改、退出非 0', () => {
  const root = path.join(mkdtempSync(path.join(tmp, 'bakfail-')), 'store');
  makeStoreWithClaims(root);
  const before = hashTree(root);
  const res = runApplyChanges({
    storeRoot: root,
    doStale: true,
    apply: true,
    now: T0 + 1000,
    deps: { findStaleTargets: fakeFindStale, createBackup: () => { throw new Error('disk full'); } },
  });
  assert.equal(res.code, 1);
  assert.match(res.error, /备份失败/);
  assert.equal(hashTree(root), before, '备份失败时库必须原样');
});

test('T201 ③: 幂等 —— 连跑两次，第二次 0 变更', () => {
  const root = path.join(mkdtempSync(path.join(tmp, 'idem-')), 'store');
  makeStoreWithClaims(root);
  const backupDir = path.join(tmp, 'idem-backup');
  const deps = { findStaleTargets: fakeFindStale };
  const first = runApplyChanges({ storeRoot: root, backupDir, doStale: true, apply: true, now: T0 + 1000, deps });
  assert.equal(first.code, 0, first.error ?? '');
  assert.equal(first.stale.written, 2);
  const afterFirst = hashTree(root);

  const second = runApplyChanges({ storeRoot: root, backupDir: path.join(tmp, 'idem-backup-2'), doStale: true, apply: true, now: T0 + 2000, deps });
  assert.equal(second.code, 0, second.error ?? '');
  assert.equal(second.stale.targets, 0, '已标过的不会再标');
  assert.equal(second.stale.written, 0);
  assert.equal(hashTree(root), afterFirst, '第二次不改库');

  // 真 stale 记录确实带了标记字段
  const store = createStore({ root });
  const marked = store.list('claims').map((e) => e.record).filter((c) => isMarked(c));
  assert.equal(marked.length, 2);
  assert.equal(marked[0].state, 'stale', '状态改成 stale（T201 要求）');
  assert.match(marked[0].text, /^claim \d+ 的正文$/, '正文不许改');
  assert.ok(marked[0].staleReason, '带 staleReason 字段');
});

test('T201 ④: 中途失败 ⇒ 打印回滚命令且退出非 0', () => {
  const root = path.join(mkdtempSync(path.join(tmp, 'midfail-')), 'store');
  makeStoreWithClaims(root);
  const res = runApplyChanges({
    storeRoot: root,
    backupDir: path.join(tmp, 'midfail-backup'),
    doStale: true,
    doMerge: true,
    apply: true,
    now: T0 + 1000,
    deps: {
      findStaleTargets: fakeFindStale,
      runApply: () => { throw new Error('merge exploded'); },
    },
  });
  assert.equal(res.code, 1);
  assert.match(res.error, /合流异常/);
  assert.ok(res.rollback && res.rollback.includes('--restore'), `必须打印回滚命令，实际 ${res.rollback}`);
  assert.match(formatReport(res), /回滚：/);
});

test('T201: dry-run 摘要能被人读懂（29 条/四条闸门的位置）', () => {
  const root = path.join(mkdtempSync(path.join(tmp, 'fmt-')), 'store');
  makeStoreWithClaims(root);
  const res = runApplyChanges({ storeRoot: root, doStale: true, apply: false, now: T0, deps: { findStaleTargets: fakeFindStale } });
  const text = formatReport(res);
  assert.match(text, /stale：扫描 \d+ 条/);
  assert.match(text, /dry-run/);
  assert.equal(parseArgs(['--both']).stale && parseArgs(['--both']).merge, true);
  assert.equal(parseArgs(['--stale', '--apply']).apply, true);
  writeFileSync(path.join(tmp, 'fmt.txt'), text);
});
