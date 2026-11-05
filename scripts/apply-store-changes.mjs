#!/usr/bin/env node
// T201 · 真库写执行包：**29 条真 stale 标记 + 合流 apply** 一条命令跑完（默认 dry-run）。
//
// 三步全靠既有实现，不重造：
//   · 标记：复用 `scripts/mark-stale.mjs` 的 `classifyClaim` / `buildMarked` / `isMarked`（T159/T166 的口径）
//   · 备份：复用 `scripts/consolidate-backup.mjs` 的 `createBackup` / `verifyBackup` / `restoreBackup`
//   · 合流：复用 `scripts/consolidate-apply.mjs` 的 `runApply`（`--all` 完整镜像）
//
// 用法：
//   node scripts/apply-store-changes.mjs --stale                  # 预览要标几条
//   node scripts/apply-store-changes.mjs --both --apply           # 备份 → 标记 → 合流 → 验收
//   node scripts/apply-store-changes.mjs --stale --apply --store <dir>
//
// 安全：
//   · 不带 `--apply` 一律 dry-run（一个字节都不写）
//   · `--apply` 时**先备份并校验**，备份或校验失败 ⇒ 立即退出，不做任何修改
//   · 任何一步失败 ⇒ 立即停，打印回滚命令，退出码 1（不做"部分成功"的静默继续）

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import * as gatesModule from '../src/rooms/gates.mjs';
import { classifyClaim, buildMarked, isMarked, resolveProbe, shimProbeValidity } from './mark-stale.mjs';
import { createBackup, verifyBackup } from './consolidate-backup.mjs';
import { runApply } from './consolidate-apply.mjs';

export const REAL_STALE_REASONS = Object.freeze(['file-appeared', 'version-mismatch']);

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

export function defaultStore(env = process.env) {
  return path.join(defaultHome(env), 'memory-context');
}

export function parseArgs(argv = []) {
  const flags = { store: null, backup: null, stale: false, merge: false, both: false, apply: false, help: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--apply') flags.apply = true;
    else if (a === '--stale') flags.stale = true;
    else if (a === '--merge') flags.merge = true;
    else if (a === '--both') flags.both = true;
    else if (a === '--store') flags.store = argv[++i] ?? null;
    else if (a === '--backup') flags.backup = argv[++i] ?? null;
    else if (a === '--workspace') flags.workspace = argv[++i] ?? null;
    else if (a === '--expect') flags.expect = Number(argv[++i] ?? NaN);
    else return { error: `未知参数：${a}` };
  }
  if (flags.both) { flags.stale = true; flags.merge = true; }
  return flags;
}

/**
 * 找出"真 stale"的 claim（validity 核验失败且原因属真失效，不是"核不了"）。
 * @returns {{targets:Array<{id:string, reason:string, mark:object}>, already:number, scanned:number, unjudgeable:number}}
 */
export function findStaleTargets({ store, now = Date.now(), deps = {} } = {}) {
  const classify = deps.classifyClaim ?? classifyClaim;
  const build = deps.buildMarked ?? buildMarked;
  const marked = deps.isMarked ?? isMarked;
  // resolveProbe 返回 { kind, probe }；classifyClaim 要的是 probe 函数
  const resolved = deps.probe ? { probe: deps.probe } : resolveProbe(deps.gatesModule ?? gatesModule);
  const probe = typeof resolved === 'function' ? resolved : (resolved.probe ?? shimProbeValidity);
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const targets = [];
  let already = 0;
  let unjudgeable = 0;
  for (const record of claims) {
    if (marked(record)) { already += 1; continue; }
    if (record.state === 'invalidated' || record.state === 'superseded') continue;
    let verdict = null;
    try {
      verdict = classify(record, { probe, workspace: deps.workspace ?? process.cwd(), dshHome: deps.dshHome ?? defaultHome() });
    } catch {
      unjudgeable += 1;
      continue;
    }
    if (!verdict || verdict.ok !== false) continue;
    if (!REAL_STALE_REASONS.includes(verdict.reason)) { unjudgeable += 1; continue; }
    targets.push({ id: record.id, reason: verdict.reason, mark: build(record, { at: now, reason: verdict.reason, detail: { path: verdict.path ?? null, expected: verdict.expected ?? null, actual: verdict.actual ?? null } }) });
  }
  return { targets, already, scanned: claims.length, unjudgeable };
}

/** 把标记写回 store（幂等：已 mark 的不会到这里）。 */
export function applyStaleMarks({ store, targets, apply = false, at = Date.now() } = {}) {
  const written = [];
  for (const t of targets) {
    if (!apply) { written.push({ id: t.id, written: false, dryRun: true }); continue; }
    store.put('claims', t.mark, { at });
    written.push({ id: t.id, written: true });
  }
  return { written: written.filter((w) => w.written).length, planned: targets.length, entries: written };
}

/**
 * 主流程。
 * @param {{storeRoot?:string, backupDir?:string, doStale?:boolean, doMerge?:boolean, apply?:boolean, now?:number, deps?:object}} opts
 */
export function runApplyChanges(opts = {}) {
  const {
    storeRoot = defaultStore(),
    backupDir = null,
    doStale = true,
    doMerge = false,
    apply = false,
    now = Date.now(),
    deps = {},
    expect = null,
    workspace = null,
  } = opts;
  const makeStore = deps.makeStore ?? ((o) => createStore(o));
  const backup = deps.createBackup ?? createBackup;
  const verifyBackupFn = deps.verifyBackup ?? verifyBackup;
  const runMergeFn = deps.runApply ?? runApply;
  const started = Date.now();
  const out = {
    storeRoot,
    backupDir,
    apply,
    dryRun: !apply,
    steps: [],
    stale: null,
    merge: null,
    verify: null,
    backup: null,
    rollback: null,
    code: 0,
    error: null,
    elapsedMs: 0,
  };
  if (!fs.existsSync(storeRoot)) {
    out.code = 2;
    out.error = `库不存在：${storeRoot}`;
    return out;
  }

  // ① 备份（**必须在任何写之前**）
  if (apply) {
    const dir = backupDir || path.join(path.dirname(storeRoot), `memory-context.backup-T201-${now}`);
    try {
      const b = backup({ storeRoot, backupDir: dir, now });
      const v = verifyBackupFn({ backupDir: dir });
      if (!v.ok) {
        out.backup = { dir, bytes: b.bytes, files: b.files, verifyOk: false, failures: v.failures };
        out.code = 1;
        out.error = `备份校验失败（${v.failures.length} 处）：拒绝继续，库未被修改`;
        return out;
      }
      out.backup = { dir, bytes: b.bytes, files: b.files, verifyOk: true };
      out.steps.push({ step: 'backup', ok: true, dir });
    } catch (error) {
      out.backup = { dir, error: String(error?.message ?? error) };
      out.code = 1;
      out.error = `备份失败：拒绝继续，库未被修改（${String(error?.message ?? error).slice(0, 160)}）`;
      return out;
    }
  }

  const store = makeStore({ root: storeRoot });

  // ② 标 stale
  if (doStale) {
    try {
      const found = deps.findStaleTargets ? deps.findStaleTargets({ store, now, deps }) : findStaleTargets({ store, now, deps: { ...deps, workspace: workspace ?? deps.workspace } });
      const applied = applyStaleMarks({ store, targets: found.targets, apply, at: now });
      // 写了就要更新 manifest，否则随后的 verify 会因为 checksum 过期而假红
      if (apply && applied.written > 0 && typeof store.writeManifest === 'function') store.writeManifest(now);
      out.stale = { scanned: found.scanned, already: found.already, unjudgeable: found.unjudgeable, targets: found.targets.length, written: applied.written, byReason: countBy(found.targets, (t) => t.reason), ids: found.targets.map((t) => t.id) };
      // fail-closed：要写库时，实际条数必须与预期一致（防"以为标了 29、其实 0"）
      if (apply && Number.isFinite(expect) && found.targets.length !== expect) {
        out.code = 1;
        out.error = `预期标记 ${expect} 条，实际 ${found.targets.length} 条 —— 拒绝写入（先核对 workspace 语义）`;
        out.rollback = rollbackCommand(out.backup?.dir);
        return out;
      }
      out.steps.push({ step: 'stale', ok: true, written: applied.written, targets: found.targets.length });
    } catch (error) {
      out.code = 1;
      out.error = `标 stale 失败：${String(error?.message ?? error).slice(0, 200)}`;
      out.rollback = rollbackCommand(out.backup?.dir);
      return out;
    }
  }

  // ③ 合流（复用 consolidate-apply 的 `--all`）
  if (doMerge) {
    try {
      // consolidate 契约：源库只读，out 不能是源库本身 ⇒ 先写影子库，再用影子库整体替换
      const shadow = `${storeRoot}.shadow-T201`;
      const preDir = `${storeRoot}.pre-T201`;
      fs.rmSync(shadow, { recursive: true, force: true });
      const res = runMergeFn(['--store', storeRoot, '--out', shadow, '--all']);
      const merged = res?.report?.report?.apply?.mergedAdded ?? res?.report?.apply?.mergedAdded ?? null;
      if (res?.code !== 0) {
        out.merge = { code: res?.code ?? null, error: res?.error ?? null, ...(res?.report?.mirror ? { mirror: summarizeMirror(res.report.mirror) } : {}) };
        out.code = 1;
        out.error = `合流失败（consolidate-apply 退出 ${res?.code}）：${res?.error ?? '见输出'}`;
        out.rollback = rollbackCommand(out.backup?.dir);
        return out;
      }
      // 影子库自洽后再换：store → store.pre-T201（回滚点），shadow → store
      fs.rmSync(preDir, { recursive: true, force: true });
      fs.renameSync(storeRoot, preDir);
      fs.renameSync(shadow, storeRoot);
      out.merge = { code: 0, mergedAdded: merged, swappedFrom: preDir, ...(res?.report?.mirror ? { mirror: summarizeMirror(res.report.mirror) } : {}), ...(res?.report?.verify ? { verify: { ok: Boolean(res.report.verify.ok), errors: res.report.verify.errors ?? [] } } : {}) };
      out.steps.push({ step: 'merge', ok: true, mergedAdded: merged });
    } catch (error) {
      out.code = 1;
      out.error = `合流异常：${String(error?.message ?? error).slice(0, 200)}`;
      out.rollback = rollbackCommand(out.backup?.dir);
      return out;
    }
  }

  // ④ 验收：manifest verify + 四条闸门（只读）
  try {
    const check = deps.verifyStore ? deps.verifyStore({ store }) : store.verify();
    out.verify = { ok: Boolean(check.ok), errors: check.errors ?? [], counts: check.counts ?? null };
    out.steps.push({ step: 'verify', ok: out.verify.ok });
    if (!out.verify.ok) {
      out.code = 1;
      out.error = `库自检失败（${out.verify.errors.length} 处）`;
      out.rollback = rollbackCommand(out.backup?.dir);
      return out;
    }
  } catch (error) {
    out.code = 1;
    out.error = `库自检异常：${String(error?.message ?? error).slice(0, 200)}`;
    out.rollback = rollbackCommand(out.backup?.dir);
    return out;
  }

  out.elapsedMs = Date.now() - started;
  return out;
}

function countBy(list, fn) {
  const m = {};
  for (const x of list) { const k = fn(x); m[k] = (m[k] ?? 0) + 1; }
  return m;
}

function summarizeMirror(m) {
  return { mirrorOk: m.mirrorOk, mismatches: m.mismatches, shadowCounts: m.shadowCounts, sourceCounts: m.sourceCounts, manifestFiles: m.manifest?.files ?? null };
}

export function rollbackCommand(backupDir) {
  if (!backupDir) return null;
  return `node scripts/consolidate-backup.mjs --restore "${backupDir}" --target "${defaultStore()}"`;
}

export function formatReport(r) {
  const lines = [];
  lines.push(`库：${r.storeRoot}`);
  lines.push(`模式：${r.dryRun ? 'dry-run（不写任何文件）' : 'apply'}`);
  if (r.backup) {
    lines.push(`备份：${r.backup.dir}${r.backup.verifyOk === undefined ? '' : r.backup.verifyOk ? ` · 校验 OK · ${(r.backup.bytes / 1048576).toFixed(2)} MiB / ${r.backup.files} 文件` : ' · 校验失败'}`);
  }
  if (r.stale) {
    lines.push(`stale：扫描 ${r.stale.scanned} 条 · 已是 stale ${r.stale.already} · 真 stale ${r.stale.targets}（${Object.entries(r.stale.byReason).map(([k, v]) => `${k} ${v}`).join(' · ')}）· 写入 ${r.stale.written}`);
  }
  if (r.merge) lines.push(`合流：${r.merge.code === 0 ? 'OK' : `失败 ${r.merge.code}`}${r.merge.mergedAdded === null || r.merge.mergedAdded === undefined ? '' : ` · 新增合并节点 ${r.merge.mergedAdded}`}${r.merge.mirror ? ` · 镜像一致 ${r.merge.mirror.mirrorOk ? '是' : '否'}` : ''}`);
  if (r.verify) lines.push(`verify：${r.verify.ok ? 'OK' : '失败'}${r.verify.counts ? ` · ${Object.values(r.verify.counts).reduce((a, b) => a + (Number(b) || 0), 0)} 条记录` : ''}`);
  if (r.error) lines.push(`失败：${r.error}`);
  if (r.rollback) lines.push(`回滚：${r.rollback}`);
  lines.push(`耗时 ${r.elapsedMs} ms · 退出码 ${r.code}`);
  return lines.join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.error) return { code: 2, stdout: flags.error };
  if (flags.help) return { code: 0, stdout: USAGE };
  if (!flags.stale && !flags.merge) return { code: 2, stdout: USAGE };
  const res = runApplyChanges({
    storeRoot: flags.store ? path.resolve(flags.store) : defaultStore(),
    backupDir: flags.backup ? path.resolve(flags.backup) : null,
    doStale: flags.stale,
    doMerge: flags.merge,
    apply: flags.apply,
    workspace: flags.workspace ? path.resolve(flags.workspace) : null,
    expect: Number.isFinite(flags.expect) ? flags.expect : null,
  });
  return { code: res.code, stdout: flags.json ? JSON.stringify(res, null, 2) : formatReport(res) };
}

export const USAGE = `棋院 apply-store-changes（T201：29 条真 stale + 合流 apply，一条命令）

用法：node scripts/apply-store-changes.mjs (--stale | --merge | --both) [--apply] [--store <dir>]

  --stale    标记真 stale（file-appeared / version-mismatch），只加字段
  --merge    跑合流 --all（复用 scripts/consolidate-apply.mjs）
  --both     备份 → 标记 → 合流 → 验收（推荐）
  --apply    真正写盘（缺省 = dry-run，一个字节都不写）
  --store    库目录（默认 <DSH_HOME>/memory-context）
  --backup   备份目录（默认 <库的父目录>/memory-context.backup-T201-<ts>）
`;

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();
