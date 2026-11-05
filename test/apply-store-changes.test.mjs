// T201/T204 的 tombstone test：删掉 `scripts/apply-store-changes.mjs` ⇒ 本文件红。
//
// T204 教训：上一版把 `findStaleTargets` 整个桩掉，于是"字段名写错（判 `verdict.ok` 而
// `classifyClaim` 返回的是 `action`）⇒ 恒返回 0 条"这条接缝**没有测试**。现在改成
// **真的 classifyClaim + 真的探针**（shim）跑端到端，三条 claim 分别是
// version-mismatch / file-appeared / fresh。
//
// 覆盖：
//   ① dry-run 一个字节都不写
//   ② 备份失败 ⇒ 不执行、不修改、退出非 0
//   ③ 幂等：连跑两次，第二次 0 变更
//   ④ 中途失败（合流抛错）⇒ 打印回滚命令且退出非 0
//   ⑤ **T204 回归**：action==='mark' 的两条被选中、fresh 那条不被选（字段名不许再猜）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createStore } from '../src/rooms/persist.mjs';
import { runApplyChanges, findStaleTargets, formatReport, parseArgs } from '../scripts/apply-store-changes.mjs';
import { isMarked } from '../scripts/mark-stale.mjs';

const T0 = 1_700_000_000_000;
let tmp;
test.before(() => { tmp = mkdtempSync(path.join(tmpdir(), 'kifu-t204-')); });
test.after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const claim = (id, validity, extra = {}) => ({
  id,
  kind: 'fact',
  text: `${id} 的正文`,
  scopeKey: 'u:demo', // 非 w: ⇒ workspaceOf 回落到显式 workspace
  state: 'observed',
  support: [{ episode: 'ep-0001', seq: 1, quote: `q-${id}`, occurredAt: T0 }],
  counter: [],
  validity,
  preconditions: [],
  occurredAt: T0,
  recordedAt: T0,
  counters: { support: 1, counter: 0 },
  ...extra,
});

/**
 * 造一个"有 workspace 的库"：
 *   · c-version-mismatch：声明 demo-pkg@9.9.9，workspace/package.json 是 1.0.0
 *   · c-file-appeared   ：声明 docs/added.md 应为 missing，实际存在
 *   · c-fresh           ：声明 demo-pkg@1.0.0，与 workspace 一致
 */
function makeStoreWithClaims(root, workspace) {
  mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '1.0.0' }, null, 2));
  writeFileSync(path.join(workspace, 'docs', 'added.md'), '# appeared\n');
  const store = createStore({ root });
  store.ensureDirs();
  store.putMany('claims', [
    claim('c-version-mismatch', { type: 'version', value: 'demo-pkg@9.9.9' }),
    claim('c-file-appeared', { type: 'file', value: 'docs/added.md', expect: 'missing' }),
    claim('c-fresh', { type: 'version', value: 'demo-pkg@1.0.0' }),
  ], { at: T0 });
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

const fixture = (tag) => {
  const dir = mkdtempSync(path.join(tmp, tag));
  const root = path.join(dir, 'store');
  const workspace = path.join(dir, 'workspace');
  makeStoreWithClaims(root, workspace);
  return { dir, root, workspace };
};

// ⑤ T204 回归：字段名
test('T204 ⑤: 真 classifyClaim —— action==="mark" 的才被选中（version-mismatch / file-appeared）', () => {
  const { root, workspace } = fixture('classify-');
  const store = createStore({ root });
  const found = findStaleTargets({ store, workspace, now: T0 + 1000 });
  assert.deepEqual(found.targets.map((t) => t.id).sort(), ['c-file-appeared', 'c-version-mismatch'], '两条真失效必须被选中');
  assert.deepEqual(found.targets.map((t) => t.reason).sort(), ['file-appeared', 'version-mismatch']);
  assert.ok(!found.targets.some((t) => t.id === 'c-fresh'), 'fresh 不许被选中');
  assert.equal(found.scanned, 3);
  // 回归点：旧实现判 `verdict.ok !== false` ⇒ 恒 0 条
  assert.notEqual(found.targets.length, 0, 'findStaleTargets 不许再恒返回 0 条');
});

// ① dry-run
test('T201 ①: dry-run 一个字节都不写', () => {
  const { root, workspace } = fixture('dry-');
  const before = hashTree(root);
  const res = runApplyChanges({ storeRoot: root, workspace, doStale: true, apply: false, now: T0 + 1000 });
  assert.equal(res.code, 0, res.error ?? '');
  assert.equal(res.dryRun, true);
  assert.equal(res.stale.targets, 2, '预览能算出 2 条');
  assert.equal(res.stale.written, 0, 'dry-run 不写');
  assert.equal(hashTree(root), before, '库逐字节未变');
});

// ② 备份失败
test('T201 ②: 备份失败 ⇒ 不执行、不修改、退出非 0', () => {
  const { root, workspace } = fixture('bakfail-');
  const before = hashTree(root);
  const res = runApplyChanges({
    storeRoot: root,
    workspace,
    doStale: true,
    apply: true,
    now: T0 + 1000,
    deps: { createBackup: () => { throw new Error('disk full'); } },
  });
  assert.equal(res.code, 1);
  assert.match(res.error, /备份失败/);
  assert.equal(hashTree(root), before, '备份失败时库必须原样');
});

// ③ 幂等
test('T201 ③: 幂等 —— 连跑两次，第二次 0 变更', () => {
  const { root, workspace } = fixture('idem-');
  const first = runApplyChanges({ storeRoot: root, backupDir: path.join(tmp, 'idem-b1'), workspace, doStale: true, apply: true, now: T0 + 1000 });
  assert.equal(first.code, 0, first.error ?? '');
  assert.equal(first.stale.written, 2);
  const afterFirst = hashTree(root);

  const second = runApplyChanges({ storeRoot: root, backupDir: path.join(tmp, 'idem-b2'), workspace, doStale: true, apply: true, now: T0 + 2000 });
  assert.equal(second.code, 0, second.error ?? '');
  assert.equal(second.stale.targets, 0, '已标过的不会再标');
  assert.equal(second.stale.written, 0);
  assert.equal(hashTree(root), afterFirst, '第二次不改库');

  const store = createStore({ root });
  const marked = store.list('claims').map((e) => e.record).filter((c) => isMarked(c));
  assert.equal(marked.length, 2);
  assert.equal(marked[0].state, 'stale', '状态改成 stale');
  assert.ok(marked[0].staleReason, '带 staleReason 字段');
  assert.match(marked[0].text, /^c-[\w-]+ 的正文$/, '正文不许改');
});

// ④ 中途失败
test('T201 ④: 中途失败 ⇒ 打印回滚命令且退出非 0', () => {
  const { root, workspace } = fixture('midfail-');
  const res = runApplyChanges({
    storeRoot: root,
    backupDir: path.join(tmp, 'midfail-b'),
    workspace,
    doStale: true,
    doMerge: true,
    apply: true,
    now: T0 + 1000,
    deps: { runApply: () => { throw new Error('merge exploded'); } },
  });
  assert.equal(res.code, 1);
  assert.match(res.error, /合流异常/);
  assert.ok(res.rollback && res.rollback.includes('--restore'), `必须打印回滚命令，实际 ${res.rollback}`);
  assert.match(formatReport(res), /回滚：/);
});

test('T201: 摘要把 29 条/四条闸门的位置写清楚 + 参数解析', () => {
  const { root, workspace } = fixture('fmt-');
  const res = runApplyChanges({ storeRoot: root, workspace, doStale: true, apply: false, now: T0 });
  const text = formatReport(res);
  assert.match(text, /stale：扫描 \d+ 条/);
  assert.match(text, /dry-run/);
  assert.equal(parseArgs(['--both']).stale && parseArgs(['--both']).merge, true);
  assert.equal(parseArgs(['--stale', '--apply']).apply, true);
  assert.equal(parseArgs(['--expect', '29']).expect, 29);
});
