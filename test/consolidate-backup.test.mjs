// T170 的 tombstone test：删掉 `scripts/consolidate-backup.mjs`（或 apply 的 `--all`）⇒ 本文件红。
//
// 覆盖（任务书 T170 验收）：
//   ① 备份 → 改动 → 回滚 → `store.verify()` 通过（内容逐字节回到备份点）
//   ② 回滚两次结果相同（幂等；整体替换，不做增量合并）
//   ③ `--all` 镜像的 kind 集合与源库一致（7 个 kind 条数逐项相等 + 影库 verify OK）
//   ④ 可校验备份：改一个字节 ⇒ `verifyBackup` 当场红（不是裸 cp）
//   ⑤ 安全边界：备份目录在源库内被拒；回滚目标 = 真库被拒（要 --force-real-store）
//
// 夹具全部在 os.tmpdir；不写 <DSH_HOME>；零模型调用；不新增依赖。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createStore, ENTRY_KINDS } from '../src/rooms/persist.mjs';
import { createBackup, verifyBackup, restoreBackup, walkFiles, META_FILE, STORE_DIR } from '../scripts/consolidate-backup.mjs';
import { runApply, parseArgs } from '../scripts/consolidate-apply.mjs';

const T0 = 1_700_000_000_000;

let tmp;
test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-t170-'));
});
test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const kindRecord = (kind, index) => {
  const id = `${kind === 'episodes' ? 'ep' : kind === 'claims' ? 'c' : kind === 'topics' ? 't:' : kind === 'links' ? 'l' : kind === 'threads' ? 'th' : kind === 'joseki' ? 'j' : 'ad'}-${String(index).padStart(4, '0')}`;
  const base = { id, recordedAt: T0, createdAt: T0 };
  if (kind === 'episodes') return { ...base, sessionId: `session-${index}`, scopeKey: 'w:d:/work/demo', startedAt: T0, endedAt: T0 + 1000, l0: 'x', l1: 'x'.repeat(40), state: 'archived' };
  if (kind === 'claims') return { ...base, kind: 'fact', text: `claim ${index} 的唯一正文`, scopeKey: 'w:d:/work/demo', state: 'observed', support: [{ episode: 'ep-0001', seq: index, quote: `q${index}`, occurredAt: T0 }], counter: [], validity: { type: 'none', value: null }, preconditions: [], occurredAt: T0, counters: { support: 1, counter: 0 } };
  if (kind === 'topics') return { ...base, kind: 'repo', key: `repo-${index}` };
  if (kind === 'links') return { ...base, kind: 'shared-topic', a: { episode: 'ep-0001' }, b: { episode: 'ep-0002' }, why: 'shared' };
  if (kind === 'threads') return { ...base, title: `卷 ${index}`, topics: [], kifus: ['ep-0001'], state: 'open' };
  if (kind === 'joseki') return { ...base, title: `定式 ${index}`, steps: [], support: ['ep-0001'], counter: [], state: 'candidate' };
  return { ...base, target: 'c-0001', level: 'L2-multi-member', votes: [], decision: 'promote', at: T0 };
};

function buildStore(root, { perKind = 3, index = true } = {}) {
  const store = createStore({ root });
  store.ensureDirs();
  for (const kind of ENTRY_KINDS) {
    const records = [];
    for (let i = 1; i <= perKind; i += 1) records.push(kindRecord(kind, i));
    store.putMany(kind, records, { at: T0 });
  }
  if (index) store.writeIndex('# 索引\n\n- demo\n', { at: T0 });
  store.writeManifest(T0);
  return store;
}

function hashTree(dir) {
  return walkFiles(dir).map((f) => `${f.rel}:${createHash('sha256').update(readFileSync(f.abs)).digest('hex')}`).join('|');
}

// ---------------------------------------------------------------------------
// ① 备份 → 改动 → 回滚 → verify
// ---------------------------------------------------------------------------

test('T170 ①: 备份 → 改动 → 回滚 → verify 通过', () => {
  const root = mkdtempSync(path.join(tmp, 'b1-'));
  const storeRoot = path.join(root, 'store');
  buildStore(storeRoot);
  const before = hashTree(storeRoot);

  const backup = createBackup({ storeRoot, backupDir: path.join(root, 'backup'), now: T0 + 1000 });
  assert.ok(backup.files >= 20, `备份文件数 ${backup.files}`);
  assert.equal(backup.verifyOk, true);
  const check = verifyBackup({ backupDir: backup.backupDir });
  assert.equal(check.ok, true, JSON.stringify(check.failures));

  // 改动目标库：加一条、删一条、动 index
  const store = createStore({ root: storeRoot });
  store.put('claims', { ...kindRecord('claims', 99), text: '备份之后新增的' }, { at: T0 + 2000 });
  rmSync(path.join(storeRoot, 'topics'), { recursive: true, force: true });
  store.writeIndex('# 被改坏了\n', { at: T0 + 2000 });
  assert.notEqual(hashTree(storeRoot), before, '改动必须真的生效');

  const restored = restoreBackup({ backupDir: backup.backupDir, targetRoot: storeRoot, now: T0 + 3000, realStoreRoot: path.join(root, 'real-store-that-does-not-exist') });
  assert.equal(restored.verifyOk, true, JSON.stringify(restored.verifyErrors));
  assert.equal(restored.counts.claims, 3, '回滚后 claims 回到备份点');
  assert.equal(hashTree(storeRoot), before, '回滚后逐字节等于备份点');
});

// ---------------------------------------------------------------------------
// ② 回滚两次结果相同
// ---------------------------------------------------------------------------

test('T170 ②: 回滚两次结果相同（幂等）', () => {
  const root = mkdtempSync(path.join(tmp, 'b2-'));
  const storeRoot = path.join(root, 'store');
  buildStore(storeRoot);
  const backup = createBackup({ storeRoot, backupDir: path.join(root, 'backup'), now: T0 + 1000 });

  const target = path.join(root, 'restored');
  const realStoreRoot = path.join(root, 'not-real');
  const first = restoreBackup({ backupDir: backup.backupDir, targetRoot: target, realStoreRoot });
  const hash1 = hashTree(target);
  const second = restoreBackup({ backupDir: backup.backupDir, targetRoot: target, now: T0 + 5000, realStoreRoot });
  const hash2 = hashTree(target);

  assert.equal(first.verifyOk, true);
  assert.equal(second.verifyOk, true);
  assert.equal(hash1, hash2, '两次回滚必须逐字节相同');
  assert.equal(first.files, second.files);
  assert.deepEqual(first.counts, second.counts);
});

// ---------------------------------------------------------------------------
// ③ --all 镜像
// ---------------------------------------------------------------------------

test('T170 ③: --all 镜像的 kind 集合与源库一致', () => {
  const root = mkdtempSync(path.join(tmp, 'all-'));
  const src = path.join(root, 'source');
  buildStore(src, { perKind: 4 });
  const out = path.join(root, 'shadow');

  const res = runApply(['--store', src, '--out', out, '--all']);
  assert.equal(res.code, 0, res.error);
  const report = res.report;
  assert.ok(report.mirror, '必须跑出镜像结果');
  assert.equal(report.mirror.mirrorOk, true, `kind 不一致：${report.mirror.mismatches.join(',')}`);
  assert.equal(report.verify.ok, true, JSON.stringify(report.verify.errors));

  const sourceCounts = createStore({ root: src }).counts();
  const shadowCounts = createStore({ root: out }).counts();
  for (const kind of ENTRY_KINDS) {
    assert.equal(shadowCounts[kind], sourceCounts[kind], `${kind} 条数不一致`);
  }
  assert.equal(readFileSync(path.join(out, 'index.md'), 'utf8'), readFileSync(path.join(src, 'index.md'), 'utf8'), 'index.md 必须逐字节镜像');

  // 幂等：再跑一次，其余 kind 不重写
  const again = runApply(['--store', src, '--out', out, '--all']);
  assert.equal(again.code, 0);
  const written = ENTRY_KINDS.filter((k) => k !== 'claims').map((k) => again.report.mirror.kinds[k].written);
  assert.deepEqual(written, [0, 0, 0, 0, 0, 0], `第二次镜像不应重写：${JSON.stringify(written)}`);
});

test('T170: parseArgs 认 --all / --scope / --dry-run', () => {
  assert.deepEqual(parseArgs(['--store', 'a', '--out', 'b', '--all']).all, true);
  assert.deepEqual(parseArgs(['--store', 'a', '--out', 'b', '--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--scope', 'w:x']).scope, 'w:x');
});

// ---------------------------------------------------------------------------
// ④ 可校验：改一个字节就红
// ---------------------------------------------------------------------------

test('T170 ④: 备份被改一个字节 ⇒ verifyBackup 红（不是裸 cp）', () => {
  const root = mkdtempSync(path.join(tmp, 'b4-'));
  const storeRoot = path.join(root, 'store');
  buildStore(storeRoot);
  const backup = createBackup({ storeRoot, backupDir: path.join(root, 'backup'), now: T0 + 1000 });
  assert.equal(verifyBackup({ backupDir: backup.backupDir }).ok, true);

  const victim = path.join(backup.backupDir, STORE_DIR, 'claims', 'c-0001.json');
  const text = readFileSync(victim, 'utf8');
  writeFileSync(victim, text.replace('claim 1', 'claim X'));
  const bad = verifyBackup({ backupDir: backup.backupDir });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((f) => f.reason === 'sha256-mismatch'), JSON.stringify(bad.failures));

  // 缺文件也红
  rmSync(victim);
  const missing = verifyBackup({ backupDir: backup.backupDir });
  assert.equal(missing.ok, false);
  assert.ok(missing.failures.some((f) => f.reason === 'missing-file'));
});

// ---------------------------------------------------------------------------
// ⑤ 安全边界
// ---------------------------------------------------------------------------

test('T170 ⑤: 备份目录在源库内 / 回滚目标是真库 ⇒ 都拒绝', () => {
  const root = mkdtempSync(path.join(tmp, 'b5-'));
  const storeRoot = path.join(root, 'store');
  buildStore(storeRoot);

  assert.throws(
    () => createBackup({ storeRoot, backupDir: path.join(storeRoot, 'backup-inside'), now: T0 }),
    (err) => err.code === 'backup/dir-inside-store',
  );

  const backup = createBackup({ storeRoot, backupDir: path.join(root, 'backup'), now: T0 + 1000 });
  const realRoot = path.join(root, 'memory-context');
  assert.throws(
    () => restoreBackup({ backupDir: backup.backupDir, targetRoot: realRoot, realStoreRoot: realRoot }),
    (err) => err.code === 'restore/target-is-real-store',
  );
  // 显式允许时才可写（本任务不这么做）
  const forced = restoreBackup({ backupDir: backup.backupDir, targetRoot: realRoot, realStoreRoot: realRoot, forceRealStore: true });
  assert.equal(forced.verifyOk, true);
});

test('T170: 回滚目标不像库且非空 ⇒ 拒绝（防误删别人的目录）', () => {
  const root = mkdtempSync(path.join(tmp, 'b6-'));
  const storeRoot = path.join(root, 'store');
  buildStore(storeRoot);
  const backup = createBackup({ storeRoot, backupDir: path.join(root, 'backup'), now: T0 + 1000 });
  const junk = path.join(root, 'junk');
  mkdirSync(junk, { recursive: true });
  writeFileSync(path.join(junk, 'important.txt'), 'do not delete');
  assert.throws(
    () => restoreBackup({ backupDir: backup.backupDir, targetRoot: junk, realStoreRoot: path.join(root, 'real') }),
    (err) => err.code === 'restore/target-not-empty',
  );
  assert.equal(statSync(path.join(junk, 'important.txt')).isFile(), true, '拒绝时不能删任何东西');
});
