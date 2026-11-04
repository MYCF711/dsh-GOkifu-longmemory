// T166 的 tombstone test：删掉 `scripts/stale-pass.mjs` ⇒ 本文件整片红。
//
// 覆盖（任务书 T166）：
//   - 一条命令跑通「复制 → 归档 → 标 stale → 再归档 → 数存活」，打印 claims/标记数/存活数/存活率/耗时
//   - **默认只读源库**：跑前跑后源库 sha256 树指纹完全不变
//   - `--apply` 缺 `--yes` ⇒ 退出码 2、零写入（非交互确认）
//   - 副本安全：`--work` 在源库内 / 等于源库 / 已存在且不像库 ⇒ 拒绝且不删任何东西
//   - 存活率：夹具里造一条真 `version-mismatch` claim ⇒ 标记 1 条、存活 1 条、存活率 100%
//   - `--json` / `--evidence` 输出
//
// 夹具全部在 os.tmpdir；不写 <DSH_HOME>；零模型调用；不新增依赖。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  runStalePass, runThreeSteps, validateWorkDir, copyStore, formatReport, renderMarkdown,
  parseArgs, runCli,
} from '../scripts/stale-pass.mjs';
import { runArchive } from '../scripts/archive.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T0 = 1_700_000_000_000;
const AT = 1_709_000_000_000;
const SID = 'session-11111111-1111-4111-8111-111111111111';
const SCOPE_DIR = '--D-work-demo--';

let tmp;
test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-t166-'));
});
test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function zframe(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

/** 语料：1 局会话 + 1 张棋谱；cwd 指向 `<root>/work`（里面有 package.json 声明 1.17.6）。 */
function buildCorpus() {
  const root = mkdtempSync(path.join(tmp, 'corpus-'));
  const ws = path.join(root, 'work');
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'dsh-gokifu-compact', version: '1.17.6' }, null, 2));

  const dir = path.join(root, 'sessions', SCOPE_DIR, SID);
  mkdirSync(dir, { recursive: true });
  const header = {
    type: 'session', version: 4, id: SID, createdAt: T0, cwd: ws,
    isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  };
  const events = [
    { type: 'user/message', seq: 1, time: T0 + 1_000, data: { content: [{ type: 'text', text: '跑一下测试' }] } },
    { type: 'tool/call', seq: 2, time: T0 + 2_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm view dsh-gokifu-compact@1.16.0"}' } },
    { type: 'tool/result', seq: 3, time: T0 + 3_000, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
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
        id: 'e1', from: 'n1', to: 'n2', action: 'bash(command=npm view dsh-gokifu-compact@1.16.0)',
        result: 'success', evidence: { start: 2 }, ts: T0 + 2_000,
      },
    },
    order: ['n1', 'n2'], stateIndex: {}, rootUserNodeIds: ['n1'], checkpointSeq: 3, foldCount: 0,
  }, null, 2)}\n`);
  return { root, ws, storeRoot: path.join(root, 'memory-context') };
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

/** 先把源库建出来（归档一次），再跑 stale-pass。 */
async function buildSourceStore() {
  const corpus = buildCorpus();
  await runArchive({ dataRoot: corpus.root, storeRoot: corpus.storeRoot, now: AT });
  const store = createStore({ root: corpus.storeRoot });
  const claims = store.list('claims').map((x) => x.record).filter(Boolean);
  assert.ok(claims.length >= 1, '夹具必须产出至少一条 claim');
  return { ...corpus, claims };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('T166: 副本目录安全校验 —— 源库内 / 等于源库 / 不像库都拒', () => {
  const root = mkdtempSync(path.join(tmp, 'safety-'));
  const storeRoot = path.join(root, 'memory-context');
  mkdirSync(path.join(storeRoot, 'episodes'), { recursive: true });
  writeFileSync(path.join(storeRoot, 'manifest.json'), '{}');

  assert.equal(validateWorkDir({ storeRoot, workRoot: path.join(storeRoot, 'copy') }).code, 'work-inside-store');
  assert.equal(validateWorkDir({ storeRoot, workRoot: storeRoot }).code, 'work-equals-store');
  assert.equal(validateWorkDir({ storeRoot, workRoot: path.dirname(storeRoot) }).code, 'store-inside-work');
  assert.equal(validateWorkDir({ storeRoot, workRoot: 'relative/dir' }).code, 'work-not-absolute');
  assert.equal(validateWorkDir({ storeRoot, workRoot: 'D:\\' }).code, 'work-is-root');
  assert.equal(validateWorkDir({ storeRoot, workRoot: path.resolve(os_home()) }).code, 'work-is-home');

  // 已存在且"不像库"的非空目录：拒绝清空
  const junk = path.join(root, 'junk');
  mkdirSync(junk, { recursive: true });
  writeFileSync(path.join(junk, 'important.txt'), 'do not delete');
  const res = validateWorkDir({ storeRoot, workRoot: junk });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'work-not-empty');
  assert.ok(existsSync(path.join(junk, 'important.txt')), '拒绝时不能删任何东西');

  // 合法的副本目录（不存在 / 空 / 看起来像库）
  assert.equal(validateWorkDir({ storeRoot, workRoot: path.join(root, 'fresh-copy') }).ok, true);
  const empty = path.join(root, 'empty');
  mkdirSync(empty);
  assert.equal(validateWorkDir({ storeRoot, workRoot: empty }).ok, true);
  const storeLike = path.join(root, 'store-like');
  mkdirSync(storeLike);
  writeFileSync(path.join(storeLike, 'manifest.json'), '{}');
  assert.equal(validateWorkDir({ storeRoot, workRoot: storeLike }).ok, true);

  // 源库不存在 / 不是库
  assert.equal(validateWorkDir({ storeRoot: path.join(root, 'nope'), workRoot: path.join(root, 'w1') }).code, 'store-missing');
});

function os_home() {
  return process.env.USERPROFILE ?? process.env.HOME ?? 'C:\\Users';
}

test('T166: copyStore 复制完整（源库只读，副本可清空重来）', async () => {
  const { storeRoot } = await buildSourceStore();
  const work = path.join(tmp, 'copy-test');
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'stale.txt'), 'old');
  const copied = copyStore(storeRoot, work);
  assert.ok(fs_exists(path.join(work, 'manifest.json')), '副本必须有 manifest');
  assert.equal(fs_exists(path.join(work, 'stale.txt')), false, '旧内容必须被清空');
  assert.ok(copied.files >= 2);
  assert.equal(hashTree(work), hashTree(storeRoot), '复制后副本与源库逐字节相同');
});

function fs_exists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

test('T166: 一条命令跑通三步 —— 标记存活率 100%，源库零写入', async () => {
  const corpus = await buildSourceStore();
  const before = hashTree(corpus.storeRoot);
  const work = path.join(tmp, 'pass-copy');

  const report = await runStalePass({ storeRoot: corpus.storeRoot, workRoot: work, dataRoot: corpus.root, now: AT + 1000 });
  assert.equal(report.validation.ok, true, report.validation.message);
  assert.ok(report.copyPass, '必须跑出副本三步结果');
  assert.equal(report.copy.files >= 2, true);

  const p = report.copyPass;
  assert.ok(p.mark.marked >= 1, `夹具里那条 version-mismatch 应被标：${JSON.stringify(p.mark)}`);
  assert.equal(p.survival.marked, p.mark.marked, '存活数 = 归档后仍带标记的条数');
  assert.equal(p.survival.survived, p.mark.marked, '再归档之后标记必须仍在（T159b 保留）');
  assert.equal(p.survival.rate, 1, '存活率应为 100%');
  assert.equal(p.archive1.verifyOk, true);
  assert.equal(p.archive2.verifyOk, true);
  assert.equal(p.mark.byReason['version-mismatch'] >= 1, true);

  // 默认只读：源库逐字节不变
  assert.equal(hashTree(corpus.storeRoot), before, '默认模式不得写源库');

  // 副本确实被写了（标记落在副本里，不在源库）
  const source = createStore({ root: corpus.storeRoot });
  assert.equal(source.list('claims').filter((x) => x.record?.staleMarkedBy).length, 0, '源库不应有标记');
  const copy = createStore({ root: work });
  assert.ok(copy.list('claims').filter((x) => x.record?.staleMarkedBy).length >= 1, '副本里应该有标记');

  // 表格：claims / 标记数 / 存活数 / 存活率 / 耗时
  const text = formatReport(report);
  assert.match(text, /\| 库 \| claims \| 标记数 \| 存活数 \| 存活率 \| 耗时 \|/);
  assert.match(text, /\| 副本 \|/);
  assert.match(text, /100\.00%/);
  const md = renderMarkdown(report);
  assert.match(md, /# T166 · 重归档 → 标 stale → 再归档验证/);
  assert.match(md, /\| \*\*100\.00%\*\* \|/);
});

test('T166: --apply 缺 --yes ⇒ 退出码 2、零写入', async () => {
  const corpus = await buildSourceStore();
  const before = hashTree(corpus.storeRoot);
  const res = await runCli(['--store', corpus.storeRoot, '--work', path.join(tmp, 'apply-no-yes'), '--root', corpus.root, '--apply']);
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stderr, /--yes/);
  assert.match(res.stdout, /还没有写源库/);
  assert.match(res.stdout, /将写：claims \d+ 条/);
  assert.equal(hashTree(corpus.storeRoot), before, '缺 --yes 时源库必须零写入');
});

test('T166: 副本在源库内 ⇒ 拒绝（退出码 2，不删任何东西）', async () => {
  const corpus = await buildSourceStore();
  const before = hashTree(corpus.storeRoot);
  const res = await runCli(['--store', corpus.storeRoot, '--work', path.join(corpus.storeRoot, 'inner-copy'), '--root', corpus.root]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /源库内/);
  assert.equal(hashTree(corpus.storeRoot), before);
  assert.equal(existsSync(path.join(corpus.storeRoot, 'inner-copy')), false, '拒绝时不能创建/删除任何东西');
});

test('T166: --json 与 --evidence 输出', async () => {
  const corpus = await buildSourceStore();
  const res = await runCli(['--store', corpus.storeRoot, '--work', path.join(tmp, 'json-copy'), '--root', corpus.root, '--now', String(AT + 2000), '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.validation.ok, true);
  assert.ok(report.copyPass.survival.rate >= 0);
  assert.ok(Array.isArray(Object.keys(report.copyPass.mark.byReason)));

  const evidencePath = path.join(tmp, `t166-${Date.now()}.md`);
  const res2 = await runCli(['--store', corpus.storeRoot, '--work', path.join(tmp, 'evidence-copy'), '--root', corpus.root, '--now', String(AT + 3000), '--evidence', evidencePath]);
  assert.equal(res2.code, 0, res2.stderr);
  assert.ok(res2.stdout.includes(`证据已写：${evidencePath}`));
  const md = readFileSync(evidencePath, 'utf8');
  assert.match(md, /## 2 · 结果/);
  assert.match(md, /## 4 · 风险与边界/);

  assert.deepEqual(parseArgs(['--store', 'a', '--work', 'b', '--apply', '--yes', '--json']).flags, {
    store: 'a', work: 'b', apply: true, yes: true, json: true,
  });
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /stale-pass/);
});

test('T166: runThreeSteps 可注入依赖（编排层单测）', async () => {
  const calls = [];
  const fakeArchive = async (opts) => {
    calls.push(['archive', opts.storeRoot]);
    return { counts: { episodes: 1, claims: 1 }, verify: { ok: true }, added: 0, writes: { claims: { written: 0 } } };
  };
  const fakeMark = async (opts) => {
    calls.push(['mark', opts.storeRoot, opts.apply]);
    return { counts: { mark: 2, already: 0, skip: 0 }, byReason: { 'version-mismatch': 2 }, verify: { ok: true } };
  };
  const storeRoot = mkdtempSync(path.join(tmp, 'inject-'));
  mkdirSync(path.join(storeRoot, 'claims'), { recursive: true });
  const rec = (id) => ({ id, state: 'stale', staleMarkedBy: 'mark-stale/v1', staleReason: 'version-mismatch' });
  writeFileSync(path.join(storeRoot, 'claims', 'a.json'), JSON.stringify(rec('a')));
  writeFileSync(path.join(storeRoot, 'claims', 'b.json'), JSON.stringify(rec('b')));

  const out = await runThreeSteps({ storeRoot, dataRoot: tmp, now: AT, deps: { archive: fakeArchive, markStale: fakeMark } });
  assert.deepEqual(calls.map((c) => c[0]), ['archive', 'mark', 'archive'], '顺序：归档 → 标记 → 再归档');
  assert.equal(calls[1][2], true, '标记步骤必须 apply');
  assert.equal(out.mark.marked, 2);
  assert.equal(out.survival.survived, 2);
  assert.equal(out.survival.rate, 1);
  assert.equal(out.archive2.claimsWritten, 0);
});
