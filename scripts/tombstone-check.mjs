#!/usr/bin/env node
// T300 · 自动化 tombstone：**删掉实现必红**。
//
// 背景：`AGENTS.md` §11 要求每个房间都有 tombstone test（删掉实现文件，整个测试文件必须红），
// 但这条一直靠人工跑一次 —— 和 `mergedInto` 同病：**写在契约里但没人每次跑 = 没装**。
// 覆盖率只证明"跑过"，不证明"能检出错误"；这个工具验的是后者。
//
// 做法（**只碰源码树，且必须恢复**）：
//   1. `fs.renameSync(impl → tmp/tombstone/<basename>)`
//   2. 跑 `node --test <test>`
//   3. 断言 exit code ≠ 0（必红）
//   4. **finally 里无条件恢复**（即使测试报错/超时/进程异常）—— 硬要求
//
// 三态：valid（移走后红）· invalid（移走后仍绿 ⇒ 测试没覆盖这个房间）· unverified（测试缺失/跑不起来）
//
// 只读真库：不碰 `memory-context`，不改任何数据文件。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VAULT = path.join(REPO, 'tmp', 'tombstone');

/** 默认要验的房间（实现文件 → 测试文件）。 */
export const DEFAULT_PAIRS = [
  { impl: 'src/rooms/walk.mjs', test: 'test/walk.test.mjs' },
  { impl: 'src/rooms/claim.mjs', test: 'test/claim.test.mjs' },
  { impl: 'src/rooms/persist.mjs', test: 'test/persist.test.mjs' },
];

/**
 * 跑一次 tombstone 检查。
 * @returns {{impl:string,test:string,status:'valid'|'invalid'|'unverified',exitCode:number|null,reason:string|null,restored:boolean}}
 */
export function checkTombstone({ impl, test, repo = REPO, vault = VAULT, timeoutMs = 120000, exec = spawnSync } = {}) {
  const implAbs = path.join(repo, impl);
  const testAbs = path.join(repo, test);
  const base = { impl, test, exitCode: null, reason: null, restored: true };

  if (!fs.existsSync(testAbs)) return { ...base, status: 'unverified', reason: 'test-missing' };
  if (!fs.existsSync(implAbs)) return { ...base, status: 'unverified', reason: 'impl-missing' };

  fs.mkdirSync(vault, { recursive: true });
  const parked = path.join(vault, `${path.basename(impl)}.${process.pid}.bak`);
  let moved = false;
  let status = 'unverified';
  let exitCode = null;
  let reason = null;
  let restored = true;

  try {
    fs.renameSync(implAbs, parked);
    moved = true;
    // 子进程必须是**独立**的 node --test：若继承了 NODE_TEST_CONTEXT（外层 node --test 的 worker 协议），
    // 内层会把结果走 IPC 回父进程，导致 status 恒为 0 ⇒ tombstone 永远判「无效」。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const res = exec(process.execPath, ['--test', test], { cwd: repo, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env });
    exitCode = typeof res?.status === 'number' ? res.status : (res?.error ? null : 0);
    if (res?.error && exitCode === null) {
      // 超时/被杀：不算"红"，也不算绿 ⇒ 未验证
      status = 'unverified';
      reason = 'runner-error';
    } else if (exitCode === 0) {
      status = 'invalid'; // 实现没了测试还绿 ⇒ 测试没覆盖到这个房间
      reason = 'still-green';
    } else {
      status = 'valid'; // 移走后红 ⇒ 测试真的在测这个房间
    }
  } catch (error) {
    status = 'unverified';
    reason = `exception:${String(error?.code ?? error?.message ?? error).slice(0, 120)}`;
  } finally {
    // 硬要求：**无条件恢复**（测试报错、超时、进程被 kill 都要恢复）
    if (moved && fs.existsSync(parked)) {
      try {
        if (fs.existsSync(implAbs)) fs.rmSync(implAbs, { force: true });
        fs.renameSync(parked, implAbs);
      } catch {
        // 恢复失败必须抛出去，绝不静默 —— 否则源码树被毁
        restored = false;
      }
    }
    if (moved && !fs.existsSync(parked) && !fs.existsSync(implAbs)) restored = false;
  }

  return { impl, test, status, exitCode, reason, restored };
}

export function formatRow(r) {
  const tag = r.status === 'valid' ? '有效' : r.status === 'invalid' ? '**无效（测试没覆盖）**' : '未验证';
  return `| ${r.impl} → ${r.test} | ${tag} | exit ${r.exitCode ?? 'n/a'}${r.reason ? ` · ${r.reason}` : ''} |`;
}

export function parseArgs(argv = []) {
  const flags = { pairs: [], json: false, timeout: 120000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--timeout') flags.timeout = Number(argv[++i] ?? 120000) || 120000;
    else if (a === '--pair') {
      const v = String(argv[++i] ?? '');
      const [impl, test] = v.split('::');
      if (!impl || !test) return { error: `--pair 需要 impl::test，收到 ${v}` };
      flags.pairs.push({ impl, test });
    } else return { error: `未知参数：${a}` };
  }
  return flags;
}

export function runCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.error) return { code: 2, stdout: flags.error };
  if (flags.help) return { code: 0, stdout: USAGE };
  const pairs = flags.pairs.length ? flags.pairs : DEFAULT_PAIRS;
  const results = pairs.map((p) => checkTombstone({ ...p, timeoutMs: flags.timeout }));
  // 恢复失败 ⇒ 立即红且优先级最高（源码树可能被毁）
  const broken = results.filter((r) => r.restored === false);
  const invalid = results.filter((r) => r.status === 'invalid');
  const verdict = broken.length ? '恢复失败' : invalid.length ? '存在无效 tombstone' : '全部有效';
  if (flags.json) return { code: broken.length || invalid.length ? 1 : 0, stdout: JSON.stringify({ verdict, results }, null, 2) };
  const lines = ['# tombstone 检查（删掉实现必红）', '', '| 实现 → 测试 | 判定 | 读数 |', '|---|---|---|'];
  for (const r of results) lines.push(formatRow(r));
  lines.push('', `结论：${verdict}`);
  if (invalid.length) lines.push(`无效项（测试没覆盖到该房间）：${invalid.map((r) => `${r.impl}→${r.test}`).join(' , ')}`);
  return { code: broken.length || invalid.length ? 1 : 0, stdout: lines.join('\n') };
}

export const USAGE = `tombstone-check（只读，源码树临时移走再恢复）

  node scripts/tombstone-check.mjs                        # 默认三个房间
  node scripts/tombstone-check.mjs --pair src/rooms/walk.mjs::test/walk.test.mjs
  --json · --timeout 120000
`;

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

const invoked = process.argv[1]
  ? import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, '/')}`).href
  : false;
if (invoked) process.exitCode = main();
