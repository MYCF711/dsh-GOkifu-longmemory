#!/usr/bin/env node
// scripts/gates-check.mjs —— 闸 3 的真核验（validity probes）
//
// ── 契约（方案 §5.3、闸 3；docs/数据契约.md §4.8 `validity`）────────────────
// 职责：只读 store 里**带 validity 的** claims / joseki，按类型逐个核，产出
//       `{results: {"claims:<id>": {ok, reason, checkedAt}}, summary}`。
//   file     路径存在（+ 可选 `validity.sha256` / `validity.mtimeMs` 与记录里写的一致）
//   version  读 `<workspace>/package.json`（或 `validity.file` 指定的 json）比 `version`
//   commit   `git cat-file -e <sha>^{commit}`（在 `--workspace` 内跑；只读命令）
//   none     跳过（不核）
// 纪律：
//   · **只读**：不写 store、不写会话日志、不写 <DSH_HOME>；唯一副作用是 git/fs 的只读调用。
//   · **不抛**：单条失败只记 `reason`（一个坏 claim 不该让整次核验失败）。
//   · 核验结果喂给 `runGates({validityResults})`；没喂的条目仍记 unverified（不假绿）。
//
// 用法：
//   node scripts/gates-check.mjs --store tmp/memory-context --workspace . --json
//   node scripts/gates-check.mjs --store "$DSH_HOME/memory-context" --workspace "<repo>"
//
// 退出码：0 = 跑完（哪怕有条目核不过，那是数据的事不是脚本的错）；2 = 参数/库不存在。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { runValidityCheck, VALIDITY_TYPES } from '../src/rooms/gates.mjs';

export const GATES_CHECK_VERSION = 1;

export const USAGE = `棋院 gates-check（闸 3 真核验，只读）

用法：
  node scripts/gates-check.mjs [--store <dir>] [--workspace <dir>] [--now <ms>] [--json]
  node scripts/gates-check.mjs --store tmp/memory-context --workspace . --json

选项：
  --store <dir>      记忆库根（默认 <DSH_HOME>/memory-context）
  --workspace <dir>  核验基准目录（默认当前工作目录）：file/version 相对它解析，commit 在它里面跑 git
  --now <ms>         checkedAt 固定值（回放/测试用）
  --json             输出 JSON（{results, summary}）
  -h, --help         本帮助

口径：
  file     存在（可选 sha256 / mtimeMs 与记录里的一致）
  version  读 package.json（或 validity.file）比 version
  commit   git cat-file -e <sha>^{commit}（只读）
  none     跳过
`;

/** 只读地取出要核验的记录（claims + joseki）。 */
export function loadValidityRecords({ storeRoot = null } = {}) {
  const root = storeRoot ? path.resolve(storeRoot) : null;
  if (!root || !fs.existsSync(root)) return { ok: false, reason: `记忆库不存在：${root ?? '(空)'}`, claims: [], joseki: [] };
  let store;
  try {
    store = createStore({ root });
  } catch (error) {
    return { ok: false, reason: `打不开记忆库：${String(error?.message ?? error)}`, claims: [], joseki: [] };
  }
  const list = (kind) => {
    try {
      return store.list(kind).map((x) => x?.record).filter((r) => r && typeof r === 'object');
    } catch {
      return [];
    }
  };
  return { ok: true, reason: null, claims: list('claims'), joseki: list('joseki') };
}

/**
 * 跑一次核验（CLI 与测试共用）。
 * @param {{storeRoot?:string, workspace?:string, now?:number, probe?:object}} opts
 * @returns {{ok:boolean, reason:string|null, storeRoot:string, workspace:string, results:object, summary:object}}
 */
export function runGatesCheck({ storeRoot = null, workspace = null, now = null, probe = null } = {}) {
  const storePath = storeRoot ? path.resolve(storeRoot) : null;
  const workspacePath = path.resolve(workspace ?? process.cwd());
  const loaded = loadValidityRecords({ storeRoot: storePath });
  if (!loaded.ok) {
    return {
      ok: false,
      reason: loaded.reason,
      storeRoot: storePath,
      workspace: workspacePath,
      results: {},
      summary: { total: 0, checked: 0, ok: 0, failed: 0, skipped: 0, byType: {}, failures: [] },
    };
  }
  const { results, summary } = runValidityCheck({ records: { claims: loaded.claims, joseki: loaded.joseki }, workspace: workspacePath, now, probe });
  return {
    ok: true,
    reason: null,
    version: GATES_CHECK_VERSION,
    storeRoot: storePath,
    workspace: workspacePath,
    results,
    summary,
    checkedAt: Number.isFinite(now) ? Number(now) : Date.now(),
  };
}

export function formatReport(report) {
  const lines = [];
  lines.push('棋院 gates-check · 闸 3 真核验（只读）');
  lines.push(`记忆库：${report.storeRoot ?? '(未配置)'}`);
  lines.push(`核验基准：${report.workspace}`);
  if (!report.ok) {
    lines.push(`结果：跳过 —— ${report.reason}`);
    return lines.join('\n');
  }
  const s = report.summary;
  lines.push(`记录：带 validity ${s.total} 条（file/version/commit 见 byType）· 跳过 none ${s.skipped} 条`);
  lines.push(`核验：通过 ${s.ok} · 不过 ${s.failed} · 类型 ${JSON.stringify(s.byType)}`);
  if (s.failures.length) {
    lines.push('');
    for (const f of s.failures.slice(0, 20)) lines.push(`  × ${f.key} [${f.type}] ${f.reason}${f.expected !== null ? `（期望 ${f.expected}，实际 ${f.actual}）` : ''}`);
    if (s.failures.length > 20) lines.push(`  … 另有 ${s.failures.length - 20} 条`);
  }
  lines.push('');
  lines.push('下一步：把 results 传给 runGates({validityResults})；核不过的条目必须 state=stale 且只渲染指针。');
  lines.push('写入：0（只读；不写 store / 不写 <DSH_HOME>）');
  return lines.join('\n');
}

export function parseArgs(argv = []) {
  const args = [...argv];
  const flags = {};
  while (args.length) {
    const a = args.shift();
    if (a === '--json') flags.json = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--store') flags.store = args.shift();
    else if (a.startsWith('--store=')) flags.store = a.slice('--store='.length);
    else if (a === '--workspace') flags.workspace = args.shift();
    else if (a.startsWith('--workspace=')) flags.workspace = a.slice('--workspace='.length);
    else if (a === '--now') flags.now = Number(args.shift());
    else if (a.startsWith('--now=')) flags.now = Number(a.slice('--now='.length));
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
  }
  return { flags };
}

export async function runCli(argv = []) {
  const { flags } = parseArgs(argv);
  if (flags.help) return { code: 0, stdout: USAGE, stderr: '' };
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME : '';
  const storeRoot = flags.store ? path.resolve(flags.store) : (home ? path.join(home, 'memory-context') : null);
  if (!storeRoot) return { code: 2, stdout: '', stderr: `需要 --store <dir> 或 $DSH_HOME\n\n${USAGE}` };
  const report = runGatesCheck({ storeRoot, workspace: flags.workspace ?? process.cwd(), now: Number.isFinite(flags.now) ? flags.now : null });
  if (!report.ok) return { code: 2, stdout: flags.json ? JSON.stringify({ ok: false, reason: report.reason, results: {}, summary: report.summary }, null, 2) : '', stderr: report.reason ?? '核验失败' };
  if (flags.json) {
    return {
      code: 0,
      stdout: JSON.stringify({ ok: report.ok, reason: report.reason, storeRoot: report.storeRoot, workspace: report.workspace, results: report.results, summary: report.summary }, null, 2),
      stderr: '',
    };
  }
  return { code: 0, stdout: formatReport(report), stderr: '' };
}

export async function main(argv = [], io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const res = await runCli(argv);
  if (res.stdout) out.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
  if (res.stderr) err.write(res.stderr.endsWith('\n') ? res.stderr : `${res.stderr}\n`);
  return res.code;
}

export const VALIDITY_TYPES_SUPPORTED = VALIDITY_TYPES;

export default {
  GATES_CHECK_VERSION,
  USAGE,
  loadValidityRecords,
  runGatesCheck,
  formatReport,
  parseArgs,
  runCli,
  main,
};

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
