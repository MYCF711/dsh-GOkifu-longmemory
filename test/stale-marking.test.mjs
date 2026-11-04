// T159 的 tombstone test：删掉 `scripts/mark-stale.mjs`（或 claim.mjs 的路径归一）⇒ 本文件整片红。
//
// 覆盖：
//   A. 写侧路径归一（src/rooms/claim.mjs）
//      - `/tmp/x` → 本机临时目录下的绝对 Windows 路径（**不再**被读侧解析成 `D:\tmp\x`）
//      - `/d/x` / `/c/...` → `d:/x`；`C:\x` → `c:/x`；无法还原的 POSIX 路径打 `pathFlavor:'posix'`
//      - ENOENT 派生的 fact 写 `expect:'missing'`（方向位），preconditions 与 validity 同值
//   B. 降级标记（scripts/mark-stale.mjs）
//      - 只标真 stale：`version-mismatch`、`file-appeared`
//      - `unverified`（读不到包）不标；`posix-ambiguous`（老 `/tmp` 路径）不标；`fresh` 不标
//      - 默认 dry-run **一个字节都不写**；`--apply` 才写，写后 verify OK
//      - 幂等：再跑一次是 no-op；`--revert --apply` 原样回退（只增不改、可逆）
//      - 只动 state 与 stale* 字段：正文 / supersedes / support / occurredAt 不变
//      - 真探针可用时走真探针（`expectedExistenceOf` 存在 ⇒ probeKind='gates'）
//
// 夹具全部在 os.tmpdir；不写 <DSH_HOME>；零模型调用；不新增依赖。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  normalizeEvidencePath, classifyPathFlavor, promoteClaim,
} from '../src/rooms/claim.mjs';
import { resolveValidityPath, workspaceOf } from '../src/rooms/gates.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import {
  runMarkStale, classifyClaim, buildMarked, buildReverted, isMarked, resolveProbe,
  shimProbeValidity, expectedExistenceOf, parseArgs, runCli, MARKER,
} from '../scripts/mark-stale.mjs';

const T0 = 1_700_000_000_000;
const AT = 1_709_000_000_000;
const ARCHIVE_AT = 1_709_500_000_000;

let tmp;
test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-t159-'));
});
test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A · 写侧路径归一
// ---------------------------------------------------------------------------

test('T159: 路径方言与归一 —— /tmp 与 /d 不再落到盘根', () => {
  assert.equal(classifyPathFlavor('/tmp/x.json'), 'msys-tmp');
  assert.equal(classifyPathFlavor('/d/work/x'), 'msys-drive');
  assert.equal(classifyPathFlavor('/c/Users/Administrator/x'), 'msys-drive');
  assert.equal(classifyPathFlavor('C:\\work\\a.json'), 'windows');
  assert.equal(classifyPathFlavor('\\\\host\\share\\a'), 'unc');
  assert.equal(classifyPathFlavor('/主工作区/x'), 'posix');
  assert.equal(classifyPathFlavor('tmp/rel.json'), 'relative');

  const msysTmp = normalizeEvidencePath('/tmp/foo.json');
  assert.equal(msysTmp.pathFlavor, 'msys-tmp');
  assert.equal(msysTmp.rawValue, '/tmp/foo.json', '保留原文便于追溯');
  assert.ok(path.isAbsolute(msysTmp.value), '归一后是绝对路径');
  assert.ok(!msysTmp.value.startsWith('/'), '归一后不是 POSIX 字符串');
  assert.equal(msysTmp.value.toLowerCase().endsWith('/temp/foo.json'), true, `应当落在临时目录下：${msysTmp.value}`);
  assert.notEqual(resolveValidityPath(msysTmp.value, null).toLowerCase(), resolveValidityPath('/tmp/foo.json', null).toLowerCase(),
    '不能再和"盘根"解析结果相同');

  const drive = normalizeEvidencePath('/d/work/demo/cfg.json');
  assert.equal(drive.value, 'd:/work/demo/cfg.json', 'Git Bash 盘符挂载可无损还原');
  assert.equal(normalizeEvidencePath('D:\\work\\a.json').value, 'd:/work/a.json', '盘符小写 + 正斜杠');
  assert.equal(normalizeEvidencePath('C:/x').value, 'c:/x');

  const posix = normalizeEvidencePath('/主工作区/x');
  assert.equal(posix.value, '/主工作区/x', '无法还原的 POSIX 路径原样保留');
  assert.equal(posix.pathFlavor, 'posix', '靠 pathFlavor 让读侧知道"核不了"，而不是解析到盘根');

  assert.equal(normalizeEvidencePath('tmp/rel.json').pathFlavor, 'relative');
  assert.equal(normalizeEvidencePath('').value, '');
});

test('T159: ENOENT 派生的 claim 写 expect:missing + 归一后的路径', () => {
  const scope = 'w:d:/work/demo';
  const episodes = [{ id: 'ep-aaaaaaaa', sessionId: 'session-a', scopeKey: scope, startedAt: T0 }];
  const signals = new Map([['ep-aaaaaaaa', {
    failures: [{ seq: 7, quote: "cp: cannot stat '/tmp/pr1-comment.json': No such file or directory", nodeId: 'n7', edgeId: 'e7', occurredAt: T0 + 7000, result: 'failure' }],
    successes: [],
    constraints: [],
    unsettled: [],
    facts: [],
    tools: [],
  }]]);
  const { claims } = promoteClaim({ episodes, signals });
  const fact = claims.find((c) => c.kind === 'fact' && c.validity?.type === 'file');
  assert.ok(fact, '必须产出 file fact');
  assert.equal(fact.validity.expect, 'missing', '方向位：证据是"当时不存在"');
  assert.equal(fact.validity.pathFlavor, 'msys-tmp');
  assert.equal(fact.validity.rawValue, '/tmp/pr1-comment.json');
  assert.ok(path.isAbsolute(fact.validity.value), '归一后是绝对路径');
  assert.equal(fact.preconditions[0].value, fact.validity.value, 'preconditions 与 validity 同值（方向位可推断）');
  assert.equal(expectedExistenceOf(fact), 'missing', '读侧能机械推断出 missing');

  // 判据（task）：同一份 claim 重建后，resolveValidityPath 不再把 /tmp/x 解析成盘根
  const resolved = resolveValidityPath(fact.validity.value, workspaceOf(fact, null));
  const driveRootAlias = resolveValidityPath('/tmp/pr1-comment.json', workspaceOf(fact, null));
  assert.notEqual(resolved.toLowerCase(), driveRootAlias.toLowerCase());
  assert.ok(!resolved.toLowerCase().startsWith(path.normalize('d:\\tmp').toLowerCase()));
});

// ---------------------------------------------------------------------------
// B · 降级标记
// ---------------------------------------------------------------------------

function claimRecord(over = {}) {
  return {
    id: 'c-11111111',
    kind: 'fact',
    text: 'dsh-gokifu-compact@1.16.0 是当时的版本',
    scopeKey: 'w:d:/work/demo',
    threadIds: [],
    state: 'observed',
    support: [{ episode: 'ep-aaaaaaaa', seq: 3, quote: 'dsh-gokifu-compact@1.16.0', occurredAt: T0 + 3000 }],
    counter: [],
    validity: { type: 'version', value: 'dsh-gokifu-compact@1.16.0' },
    preconditions: [],
    occurredAt: T0 + 3000,
    recordedAt: AT,
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
    ...over,
  };
}

function buildFixture() {
  const root = mkdtempSync(path.join(tmp, 'fix-'));
  const storeRoot = path.join(root, 'memory-context');
  const ws = path.join(root, 'work');
  const other = path.join(root, 'other');
  mkdirSync(ws, { recursive: true });
  mkdirSync(other, { recursive: true });
  // 版本 claim 的工作区：声明 1.16.0，实际 1.17.6 ⇒ version-mismatch
  writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'dsh-gokifu-compact', version: '1.17.6' }, null, 2));
  // 真出现的文件：claim 说"当时不存在"，现在存在 ⇒ file-appeared
  const appeared = path.join(ws, 'appeared.json');
  writeFileSync(appeared, '{}');
  // 读不到包的版本 claim ⇒ unverified（不标）
  const missingPkg = 'w:' + other.replace(/\\/g, '/').toLowerCase();

  const store = createStore({ root: storeRoot, now: AT });
  store.ensureDirs();
  const scope = 'w:' + ws.replace(/\\/g, '/').toLowerCase();
  const versionClaim = claimRecord({ id: 'c-11111111', scopeKey: scope });
  const fileClaim = claimRecord({
    id: 'c-22222222',
    scopeKey: scope,
    kind: 'antipattern',
    text: 'cp: cannot stat appeared.json',
    validity: { type: 'file', value: appeared.replace(/\\/g, '/'), expect: 'missing', pathFlavor: 'windows' },
  });
  const posixClaim = claimRecord({
    id: 'c-33333333',
    scopeKey: scope,
    validity: { type: 'file', value: '/tmp/pr1-comment.json' }, // 老 writer：没有 pathFlavor
  });
  const unverifiedClaim = claimRecord({
    id: 'c-44444444',
    scopeKey: missingPkg,
    validity: { type: 'version', value: 'not-installed-anywhere@9.9.9' },
  });
  const freshClaim = claimRecord({
    id: 'c-55555555',
    scopeKey: scope,
    validity: { type: 'file', value: path.join(ws, 'package.json').replace(/\\/g, '/'), expect: 'exists' },
  });

  const all = [versionClaim, fileClaim, posixClaim, unverifiedClaim, freshClaim];
  store.putMany('claims', all, { at: ARCHIVE_AT });
  store.writeManifest({ at: ARCHIVE_AT });
  return { root, storeRoot, ws, all };
}

function hashTree(dir) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      const full = path.join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.sort().join('|');
}

test('T159: classifyClaim —— 只标真 stale；unverified / posix-ambiguous / fresh 都不标', () => {
  const pass = { probe: () => ({ ok: true, reason: null }) };
  const staleVersion = { probe: () => ({ ok: false, reason: 'version-mismatch', expected: '1.16.0', actual: '1.17.6' }) };
  const staleFile = { probe: () => ({ ok: false, reason: 'file-appeared', expected: 'missing', actual: 'present' }) };
  const unverified = { probe: () => ({ ok: false, unverified: true, reason: 'version-file-unreadable' }) };

  assert.equal(classifyClaim(claimRecord(), { ...pass }).action, 'skip', '核验通过 ⇒ 不标');
  assert.equal(classifyClaim(claimRecord(), { ...pass }).reason, 'fresh');
  assert.equal(classifyClaim(claimRecord(), { ...unverified }).reason, 'unverified', '核不了 ≠ 失效');

  const mark = classifyClaim(claimRecord(), { ...staleVersion });
  assert.equal(mark.action, 'mark');
  assert.equal(mark.reason, 'version-mismatch');
  assert.equal(mark.detail.expected, '1.16.0');
  assert.equal(mark.detail.actual, '1.17.6');

  const fileMark = classifyClaim(claimRecord({
    validity: { type: 'file', value: 'd:/work/appeared.json', expect: 'missing', pathFlavor: 'windows' },
  }), { ...staleFile, workspace: 'd:/work' });
  assert.equal(fileMark.action, 'mark');
  assert.equal(fileMark.reason, 'file-appeared');

  // 老 writer 的 POSIX 路径：读侧会解析到盘根 ⇒ 假阳性风险 ⇒ 不标
  const posix = classifyClaim(claimRecord({ validity: { type: 'file', value: '/tmp/pr1-comment.json' } }), { ...staleFile });
  assert.equal(posix.action, 'skip');
  assert.equal(posix.reason, 'posix-ambiguous');

  // 已经 invalidated / superseded：状态更重，不再补 stale
  assert.equal(classifyClaim(claimRecord({ state: 'invalidated' }), { ...staleVersion }).reason, 'already-inactive');
  assert.equal(classifyClaim(claimRecord({ validity: { type: 'none', value: null } }), { ...staleVersion }).reason, 'no-validity');
});

test('T159: dry-run —— 默认不写一个字节，只给计划', async () => {
  const fixture = buildFixture();
  const before = hashTree(fixture.storeRoot);
  const report = await runMarkStale({ storeRoot: fixture.storeRoot, workspace: fixture.ws, now: AT + 1000 });
  assert.equal(report.apply, false);
  assert.equal(report.counts.mark, 2, `应标 2 条（version-mismatch + file-appeared）：${JSON.stringify(report.byReason)}`);
  assert.equal(report.byReason['version-mismatch'], 1);
  assert.equal(report.byReason['file-appeared'], 1);
  // 老 /tmp 路径**绝不标**：若盘根上恰有同名文件会是 posix-ambiguous，否则是 fresh
  const posixRow = report.rows.find((r) => r.id === 'c-33333333');
  assert.equal(posixRow.action, 'skip');
  assert.ok(['fresh', 'posix-ambiguous'].includes(posixRow.reason), `老 /tmp 路径必须跳过：${posixRow.reason}`);
  assert.equal(report.skippedByReason['unverified'], 1, '读不到包不标');
  assert.equal(report.writes, null);
  assert.equal(hashTree(fixture.storeRoot), before, 'dry-run 必须零写入');
});

test('T159: --apply 写入降级指针（只增不改），再跑幂等，verify OK', async () => {
  const fixture = buildFixture();
  const report = await runMarkStale({ storeRoot: fixture.storeRoot, workspace: fixture.ws, apply: true, now: AT + 2000 });
  assert.equal(report.counts.mark, 2);
  assert.equal(report.writes.marked, 2);
  assert.equal(report.writes.written, 2);
  assert.equal(report.verify.ok, true, JSON.stringify(report.verify.errors));

  const store = createStore({ root: fixture.storeRoot });
  const byId = (id) => store.get('claims', id);
  const v = byId('c-11111111');
  assert.equal(v.state, 'stale');
  assert.equal(v.staleFrom, 'observed', '原状态可回退');
  assert.equal(v.staleReason, 'version-mismatch');
  assert.equal(v.staleMarkedBy, MARKER);
  assert.equal(v.staleSince, AT + 2000);
  assert.deepEqual(v.staleProbe, { type: 'version', value: 'dsh-gokifu-compact@1.16.0', path: v.staleProbe.path, expected: '1.16.0', actual: '1.17.6', workspace: v.staleProbe.workspace });
  // 只增不改：正文 / support / supersedes / occurredAt 原样
  assert.equal(v.text, 'dsh-gokifu-compact@1.16.0 是当时的版本');
  assert.equal(v.supersedes, null);
  assert.deepEqual(v.support, [{ episode: 'ep-aaaaaaaa', seq: 3, quote: 'dsh-gokifu-compact@1.16.0', occurredAt: T0 + 3000 }]);
  assert.equal(v.occurredAt, T0 + 3000);
  assert.equal(v.validity.value, 'dsh-gokifu-compact@1.16.0', 'validity 本身不改（改的是 state + 指针）');

  assert.equal(byId('c-22222222').state, 'stale');
  assert.equal(byId('c-22222222').staleReason, 'file-appeared');
  assert.equal(byId('c-33333333').state, 'observed', 'posix-ambiguous 不标');
  assert.equal(byId('c-44444444').state, 'observed', 'unverified 不标');
  assert.equal(byId('c-55555555').state, 'observed', 'fresh 不标');

  // 幂等：再跑一次 0 新写、0 变更
  const again = await runMarkStale({ storeRoot: fixture.storeRoot, workspace: fixture.ws, apply: true, now: AT + 3000 });
  assert.equal(again.counts.mark, 0);
  assert.equal(again.counts.already, 2);
  assert.equal(again.writes.written, 0, '已标的不重写');
  assert.equal(again.verify.ok, true);
});

test('T159: --revert --apply 原样回退（可逆）', async () => {
  const fixture = buildFixture();
  await runMarkStale({ storeRoot: fixture.storeRoot, workspace: fixture.ws, apply: true, now: AT + 2000 });

  const report = await runMarkStale({ storeRoot: fixture.storeRoot, workspace: fixture.ws, apply: true, revert: true, now: AT + 4000 });
  assert.equal(report.counts.reverted, 2);
  assert.equal(report.writes.reverted, 2);
  assert.equal(report.verify.ok, true);
  assert.equal(report.verify.counts.claims, 5, '回退不删条目');

  const store = createStore({ root: fixture.storeRoot });
  const v = store.get('claims', 'c-11111111');
  assert.equal(v.state, 'observed', '回退到 staleFrom');
  for (const field of ['staleSince', 'staleReason', 'staleProbe', 'staleFrom', 'staleMarkedBy', 'staleMarkedAt']) {
    assert.equal(field in v, false, `回退必须删掉 ${field}`);
  }
  assert.equal(store.get('claims', 'c-22222222').state, 'observed');
});

test('T159: 探针选择 —— 真 gates 有方向位就走真探针', () => {
  const stub = {
    expectedExistenceOf: () => 'missing',
    probeValidity: () => ({ ok: false, reason: 'file-appeared' }),
  };
  const picked = resolveProbe(stub);
  assert.equal(picked.kind, 'gates');
  assert.equal(picked.probe({ validity: { type: 'file', value: 'x', expect: 'missing' } }, 'd:/w', null).reason, 'file-appeared');

  const none = resolveProbe(null);
  assert.equal(none.kind, 'shim');
  // 垫片的方向位：expect=missing 且文件存在 ⇒ file-appeared
  const rec = { validity: { type: 'file', value: path.join(tmp, 'exists.json'), expect: 'missing' } };
  writeFileSync(path.join(tmp, 'exists.json'), '{}');
  assert.equal(none.probe(rec, tmp, null).reason, 'file-appeared');
  assert.equal(none.probe({ validity: { type: 'file', value: path.join(tmp, 'nope.json'), expect: 'missing' } }, tmp, null).ok, true);
});

test('T159: buildMarked / buildReverted 是纯函数，字段集合固定', () => {
  const rec = claimRecord();
  const marked = buildMarked(rec, { at: AT, reason: 'version-mismatch', detail: { expected: '1.16.0' } });
  assert.equal(marked.state, 'stale');
  assert.equal(marked.staleFrom, 'observed');
  assert.equal(isMarked(marked), true);
  assert.equal(isMarked(rec), false);
  const back = buildReverted(marked);
  assert.deepEqual(back, rec, '回退后与原文逐字段相同');
  assert.equal(buildReverted({ ...rec, state: 'candidate' }).state, 'candidate', 'staleFrom 缺失时退回 observed');
});

test('T159: CLI —— --json 结构、--evidence 写 markdown、参数解析', async () => {
  const fixture = buildFixture();
  const res = await runCli(['--store', fixture.storeRoot, '--workspace', fixture.ws, '--now', String(AT + 5000), '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.apply, false);
  assert.equal(report.counts.mark, 2);
  assert.ok(Array.isArray(report.rows));

  const evidencePath = path.join(tmp, `t159-${Date.now()}.md`);
  const res2 = await runCli(['--store', fixture.storeRoot, '--workspace', fixture.ws, '--now', String(AT + 5000), '--evidence', evidencePath]);
  assert.equal(res2.code, 0, res2.stderr);
  assert.ok(res2.stdout.includes(`证据已写：${evidencePath}`));
  const md = readFileSync(evidencePath, 'utf8');
  assert.match(md, /T159 · 真 stale claim 的降级标记/);
  assert.match(md, /dry-run/);

  assert.deepEqual(parseArgs(['--store', 'a', '--apply', '--revert', '--json']).flags, { store: 'a', apply: true, revert: true, json: true });
  assert.equal(parseArgs(['--dry-run']).flags.dryRun, true);
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /mark-stale/);
});
