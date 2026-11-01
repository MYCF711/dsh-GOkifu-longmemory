// R13/闸 3 · scripts/gates-check.mjs 的 tombstone test：删掉那个脚本（或 probeValidity）⇒ 本文件整片红。
//
// 覆盖（task-12 验收）：
//   file：存在 / 缺失 / sha256 匹配与不匹配 / mtime 匹配与不匹配
//   version：匹配 / 不匹配 / `pkg@version` 形态（node_modules）/ 包不存在
//   commit：真实仓库 HEAD 通过 / 假 sha 不通过（没有 git 时自动跳过这两条）
//   坏路径（含 NUL）不抛；`none` 跳过；summary 计数；results 的键是 `claims:<id>`
//   每条按**自己的 scopeKey** 解析工作区（不同 scope 的记录互不串味）
//   CLI：`--json` 结构、缺库不抛
//
// 夹具全部在 os.tmpdir；只读 store 与工作区；不写 <DSH_HOME>；不新增依赖。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadValidityRecords,
  parseArgs,
  runCli,
  runGatesCheck,
} from '../scripts/gates-check.mjs';
import {
  parsePackageAtVersion,
  probeValidity,
  resolveValidityPath,
  runValidityCheck,
  validityKeyOf,
  workspaceOf,
} from '../src/rooms/gates.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T = Date.UTC(2026, 9, 20, 12, 0, 0);

let tmp;
const cleanups = [];

test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-gc-'));
});
test.after(() => {
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function freshDir(prefix = 'ws-') {
  const dir = mkdtempSync(path.join(tmpdir(), `kifuin-gc-${prefix}`));
  cleanups.push(dir);
  return dir;
}

function claimWith({ id, validity, scopeKey = null }) {
  return {
    id,
    kind: 'fact',
    text: `claim ${id}`,
    ...(scopeKey ? { scopeKey } : {}),
    threadIds: [],
    state: 'observed',
    support: [{ episode: 'ep-aaaaaaa1', seq: 10, quote: 'q' }],
    counter: [],
    validity,
    preconditions: [],
    occurredAt: T,
    recordedAt: T,
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
  };
}

function storeWith(claims, joseki = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-gc-store-'));
  cleanups.push(root);
  const store = createStore({ root, now: T });
  store.ensureDirs();
  if (claims.length) store.putMany('claims', claims);
  if (joseki.length) store.putMany('joseki', joseki);
  return { root, store };
}

// ---------------------------------------------------------------------------
// 纯函数：路径与包名
// ---------------------------------------------------------------------------

test('R13/闸3: resolveValidityPath 认三种历史写法（Windows / Git Bash / 相对）', () => {
  const ws = 'D:\\work\\demo';
  assert.equal(resolveValidityPath('/d/work/demo/a.mjs', ws), path.normalize('d:/work/demo/a.mjs'));
  assert.equal(resolveValidityPath('d:/work/demo/a.mjs', ws), path.normalize('d:/work/demo/a.mjs'));
  assert.equal(resolveValidityPath('src/a.mjs', ws), path.resolve(ws, 'src/a.mjs'));
  assert.equal(resolveValidityPath('', ws), '');
});

test('R13/闸3: parsePackageAtVersion 只认 `pkg@x.y.z` 形态', () => {
  assert.deepEqual(parsePackageAtVersion('dsh-gokifu-compact@1.16.0'), { name: 'dsh-gokifu-compact', version: '1.16.0' });
  assert.deepEqual(parsePackageAtVersion('@scope/pkg@2.0.0'), { name: '@scope/pkg', version: '2.0.0' });
  assert.equal(parsePackageAtVersion('1.16.0'), null);
  assert.equal(parsePackageAtVersion('dsh-gokifu-compact'), null);
  assert.equal(parsePackageAtVersion(''), null);
});

test('R13/闸3: workspaceOf 取记录自己的 scopeKey，没有才用 fallback', () => {
  assert.equal(workspaceOf({ scopeKey: 'w:d:/work/demo' }, 'D:/other'), path.normalize('d:/work/demo'));
  assert.equal(workspaceOf({}, 'D:/other'), path.resolve('D:/other'));
  assert.equal(workspaceOf({ scopeKey: 'w:<unknown>' }, null), null);
  assert.equal(workspaceOf({}, null), null);
});

// ---------------------------------------------------------------------------
// file
// ---------------------------------------------------------------------------

test('R13/闸3: file 存在 ⇒ ok；缺失 ⇒ file-missing（不抛）', () => {
  const ws = freshDir();
  writeFileSync(path.join(ws, 'a.txt'), 'hello');
  const ok = probeValidity(claimWith({ id: 'c-1', validity: { type: 'file', value: 'a.txt' } }), { workspace: ws, now: T });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, null);
  assert.equal(ok.checkedAt, T);

  const miss = probeValidity(claimWith({ id: 'c-2', validity: { type: 'file', value: 'nope.txt' } }), { workspace: ws, now: T });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'file-missing');
});

test('R13/闸3: file + sha256 —— 一致通过，不一致 file-hash-changed', () => {
  const ws = freshDir();
  const file = path.join(ws, 'a.txt');
  writeFileSync(file, 'hello');
  const hash = createHash('sha256').update('hello').digest('hex');

  const ok = probeValidity(claimWith({ id: 'c-1', validity: { type: 'file', value: 'a.txt', sha256: hash } }), { workspace: ws, now: T });
  assert.equal(ok.ok, true);

  const bad = probeValidity(claimWith({ id: 'c-2', validity: { type: 'file', value: 'a.txt', sha256: 'deadbeef' } }), { workspace: ws, now: T });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'file-hash-changed');
  assert.equal(bad.actual, hash);
});

test('R13/闸3: file + mtimeMs —— 一致通过，不一致 file-mtime-changed', () => {
  const ws = freshDir();
  const file = path.join(ws, 'a.txt');
  writeFileSync(file, 'hello');
  const mtime = statSync(file).mtimeMs;

  const ok = probeValidity(claimWith({ id: 'c-1', validity: { type: 'file', value: 'a.txt', mtimeMs: mtime } }), { workspace: ws, now: T });
  assert.equal(ok.ok, true);

  const bad = probeValidity(claimWith({ id: 'c-2', validity: { type: 'file', value: 'a.txt', mtimeMs: mtime - 5000 } }), { workspace: ws, now: T });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'file-mtime-changed');
});

test('R13/闸3: 坏路径（含 NUL）不抛，落成 ok:false', () => {
  const ws = freshDir();
  const bad = probeValidity(claimWith({ id: 'c-1', validity: { type: 'file', value: 'a\u0000b' } }), { workspace: ws, now: T });
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.reason, 'string');
  assert.ok(bad.reason.length > 0);
});

test('R13/闸3: 未知 validity 类型 ⇒ ok:false（不静默当通过）', () => {
  const r = probeValidity(claimWith({ id: 'c-1', validity: { type: 'skynet', value: 'x' } }), { workspace: freshDir(), now: T });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown-validity-type/);
});

test('R13/闸3: none ⇒ ok（跳过）', () => {
  const r = probeValidity(claimWith({ id: 'c-1', validity: { type: 'none', value: null } }), { workspace: freshDir(), now: T });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'none');
});

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

test('R13/闸3: version 匹配 ⇒ ok；不匹配 ⇒ version-mismatch', () => {
  const ws = freshDir();
  writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }));

  const ok = probeValidity(claimWith({ id: 'c-1', validity: { type: 'version', value: '1.2.3' } }), { workspace: ws, now: T });
  assert.equal(ok.ok, true);
  assert.equal(ok.actual, '1.2.3');

  const bad = probeValidity(claimWith({ id: 'c-2', validity: { type: 'version', value: '9.9.9' } }), { workspace: ws, now: T });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'version-mismatch');
  assert.equal(bad.expected, '9.9.9');
  assert.equal(bad.actual, '1.2.3');
});

test('R13/闸3: version `pkg@x.y.z` ⇒ 找 node_modules/<pkg>/package.json 并比名字', () => {
  const ws = freshDir();
  const pkgDir = path.join(ws, 'node_modules', 'demo-pkg');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '0.4.0' }));
  writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'host', version: '0.6.2' }));

  const ok = probeValidity(claimWith({ id: 'c-1', validity: { type: 'version', value: 'demo-pkg@0.4.0' } }), { workspace: ws, now: T });
  assert.equal(ok.ok, true);
  assert.equal(ok.package, 'demo-pkg');

  const bad = probeValidity(claimWith({ id: 'c-2', validity: { type: 'version', value: 'demo-pkg@0.5.0' } }), { workspace: ws, now: T });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'version-mismatch');

  const missing = probeValidity(claimWith({ id: 'c-3', validity: { type: 'version', value: 'ghost-pkg@1.0.0' } }), { workspace: ws, now: T });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'version-package-not-found');
});

test('R13/闸3: version 在没法读的 workspace ⇒ 落 reason 而不是抛', () => {
  const r = probeValidity(claimWith({ id: 'c-1', validity: { type: 'version', value: '1.0.0' } }), { workspace: path.join(tmp, 'no-such-ws'), now: T });
  assert.equal(r.ok, false);
  assert.match(r.reason, /version-(file-unreadable|needs-workspace)/);
});

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('R13/闸3: commit —— 真实仓库 HEAD 通过，假 sha 不通过', { skip: !gitAvailable() && '本机没有 git' }, () => {
  const ws = freshDir();
  execFileSync('git', ['init', '-q'], { cwd: ws, stdio: 'ignore' });
  writeFileSync(path.join(ws, 'a.txt'), 'hello');
  execFileSync('git', ['add', 'a.txt'], { cwd: ws, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: ws, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' }).trim();

  const ok = probeValidity(claimWith({ id: 'c-1', validity: { type: 'commit', value: head } }), { workspace: ws, now: T });
  assert.equal(ok.ok, true, JSON.stringify(ok));

  const bad = probeValidity(claimWith({ id: 'c-2', validity: { type: 'commit', value: 'deadbeefdeadbeef' } }), { workspace: ws, now: T });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'commit-not-found');
});

test('R13/闸3: commit 的坏 sha / 缺 workspace ⇒ 记 reason 不抛', () => {
  const a = probeValidity(claimWith({ id: 'c-1', validity: { type: 'commit', value: 'not-a-sha' } }), { workspace: freshDir(), now: T });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'commit-bad-sha');

  const b = probeValidity(claimWith({ id: 'c-2', validity: { type: 'commit', value: 'abcdef1' } }), { workspace: null, now: T });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'commit-needs-workspace');
});

// ---------------------------------------------------------------------------
// 批量：runValidityCheck / runGatesCheck / CLI
// ---------------------------------------------------------------------------

test('R13/闸3: runValidityCheck —— 结果键 `claims:<id>`、summary 计数、none 跳过', () => {
  const ws = freshDir();
  writeFileSync(path.join(ws, 'exists.txt'), 'x');
  const records = [
    claimWith({ id: 'c-aaa00001', validity: { type: 'file', value: 'exists.txt' } }),
    claimWith({ id: 'c-aaa00002', validity: { type: 'file', value: 'gone.txt' } }),
    claimWith({ id: 'c-aaa00003', validity: { type: 'none', value: null } }),
    claimWith({ id: 'c-aaa00004', validity: { type: 'version', value: '9.9.9' } }),
  ];
  const { results, summary } = runValidityCheck({ records: { claims: records }, workspace: ws, now: T });
  assert.equal(summary.total, 3, 'none 不算进来');
  assert.equal(summary.skipped, 1);
  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 2);
  assert.deepEqual(Object.keys(results).sort(), ['claims:c-aaa00001', 'claims:c-aaa00002', 'claims:c-aaa00004']);
  assert.equal(results['claims:c-aaa00001'].ok, true);
  assert.equal(results['claims:c-aaa00002'].reason, 'file-missing');
  assert.equal(validityKeyOf({ id: 'j-0001' }), 'joseki:j-0001');
});

test('R13/闸3: 每条按自己的 scopeKey 解析（两条不同工作区的记录互不串味）', () => {
  const wsA = freshDir('a-');
  const wsB = freshDir('b-');
  writeFileSync(path.join(wsA, 'only-a.txt'), 'a');
  const records = [
    claimWith({ id: 'c-aaa00001', validity: { type: 'file', value: 'only-a.txt' }, scopeKey: `w:${wsA.replace(/\\/g, '/')}` }),
    claimWith({ id: 'c-aaa00002', validity: { type: 'file', value: 'only-a.txt' }, scopeKey: `w:${wsB.replace(/\\/g, '/')}` }),
  ];
  const { results } = runValidityCheck({ records: { claims: records }, workspace: wsB, now: T });
  assert.equal(results['claims:c-aaa00001'].ok, true, 'A 工作区里存在');
  assert.equal(results['claims:c-aaa00002'].ok, false, 'B 工作区里不存在');
});

test('R13/闸3: runGatesCheck —— 只读跑一遍，缺库不抛', () => {
  const ws = freshDir();
  writeFileSync(path.join(ws, 'exists.txt'), 'x');
  const { root } = storeWith([
    claimWith({ id: 'c-aaa00001', validity: { type: 'file', value: 'exists.txt' }, scopeKey: `w:${ws.replace(/\\/g, '/')}` }),
    claimWith({ id: 'c-aaa00002', validity: { type: 'file', value: 'gone.txt' }, scopeKey: `w:${ws.replace(/\\/g, '/')}` }),
    claimWith({ id: 'c-aaa00003', validity: { type: 'none', value: null } }),
  ]);
  const report = runGatesCheck({ storeRoot: root, workspace: ws, now: T });
  assert.equal(report.ok, true);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.ok, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.results['claims:c-aaa00002'].reason, 'file-missing');

  const missing = runGatesCheck({ storeRoot: path.join(tmp, 'nope-store'), workspace: ws, now: T });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /记忆库不存在/);
  assert.deepEqual(missing.results, {});
});

test('R13/闸3: loadValidityRecords 只读地把 claims/joseki 取出来', () => {
  const { root } = storeWith([claimWith({ id: 'c-aaa00001', validity: { type: 'none', value: null } })], [
    { id: 'j-0001', state: 'candidate', validity: { type: 'file', value: 'a.txt' } },
  ]);
  const loaded = loadValidityRecords({ storeRoot: root });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.claims.length, 1);
  assert.equal(loaded.joseki.length, 1);
});

test('R13/闸3: CLI --json 结构（{results, summary}），缺 --store 报 2', async () => {
  const ws = freshDir();
  writeFileSync(path.join(ws, 'exists.txt'), 'x');
  const { root } = storeWith([claimWith({ id: 'c-aaa00001', validity: { type: 'file', value: 'exists.txt' }, scopeKey: `w:${ws.replace(/\\/g, '/')}` })]);
  const res = await runCli(['--store', root, '--workspace', ws, '--json', '--now', String(T)]);
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.total, 1);
  assert.equal(parsed.summary.ok, 1);
  assert.equal(parsed.checkedAt, undefined, 'runCli 的 JSON 不带 checkedAt');
  assert.equal(typeof parsed.results['claims:c-aaa00001'].checkedAt, 'number');

  const text = await runCli(['--store', root, '--workspace', ws, '--now', String(T)]);
  assert.match(text.stdout, /闸 3 真核验/);
  assert.match(text.stdout, /写入：0/);

  const bad = await runCli(['--store', path.join(tmp, 'nope-store'), '--json']);
  assert.equal(bad.code, 2);
  assert.match(JSON.parse(bad.stdout).reason, /记忆库不存在/);
});

test('R13/闸3: parseArgs 认 --store/--workspace/--now/--json', () => {
  const { flags } = parseArgs(['--store', 'a', '--workspace=b', '--now', '5', '--json']);
  assert.equal(flags.store, 'a');
  assert.equal(flags.workspace, 'b');
  assert.equal(flags.now, 5);
  assert.equal(flags.json, true);
});
