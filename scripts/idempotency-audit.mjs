#!/usr/bin/env node
// T303 · 归档幂等性审计（只读真库；所有写只发生 tmp/ 副本）。
//
// 问题（知识库 66 未确认项）：若 `recordedAt` / `generatedAt` / 目录遍历顺序参与内容比较，
// 那"重放两次同结果"就是假的。
//
// 做法：把真库**复制**到 tmp/ 副本 → 在副本上连跑两次归档 → **逐字节**比较 manifest 的
// `checksums`（sha256 全表）以及每个条目的原始文件 → 不同就报出**是哪个文件、哪个字段**。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/** 读 manifest 的 checksums 表（文件相对路径 → sha256）。 */
export function readManifest(root) {
  const p = path.join(root, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  const json = JSON.parse(raw);
  return { json, checksums: json.checksums ?? {}, raw };
}

/** 比较两次 manifest 的 checksums：返回差异清单。 */
export function diffChecksums(a = {}, b = {}) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out = { same: [], changed: [], onlyA: [], onlyB: [] };
  for (const k of keys) {
    if (!(k in a)) out.onlyB.push(k);
    else if (!(k in b)) out.onlyA.push(k);
    else if (a[k] === b[k]) out.same.push(k);
    else out.changed.push(k);
  }
  return out;
}

/** 逐字节找第一个不同处（用于定位"哪个字段"）。 */
export function firstByteDiff(fileA, fileB) {
  const a = fs.readFileSync(fileA);
  const b = fs.readFileSync(fileB);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      const ctxA = a.slice(Math.max(0, i - 40), i + 60).toString('utf8');
      const ctxB = b.slice(Math.max(0, i - 40), i + 60).toString('utf8');
      return { offset: i, a: ctxA, b: ctxB };
    }
  }
  if (a.length !== b.length) return { offset: n, a: `<len ${a.length}>`, b: `<len ${b.length}>` };
  return null;
}

/** 从差异上下文里猜是哪个字段（recordedAt / generatedAt / ...）。 */
export function guessField(ctx) {
  const m = String(ctx).match(/"(recordedAt|generatedAt|createdAt|updatedAt|at|staleSince|staleMarkedAt)"\s*:\s*(\d+)/);
  return m ? { field: m[1], value: Number(m[2]) } : null;
}

function runArchive({ home, store, repo }) {
  const res = spawnSync(process.execPath, [path.join(repo, 'scripts', 'archive.mjs'), '--root', home, '--store', store], {
    cwd: repo, encoding: 'utf8', timeout: 900000, maxBuffer: 128 * 1024 * 1024,
  });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/**
 * 主流程：复制 → 跑两遍 → 比 sha256 全表。
 * @returns {{ok:boolean, rounds:Array, diff:object, details:Array}}
 */
export function auditIdempotency({ home = defaultHome(), repo = REPO, work = path.join(REPO, 'tmp', 't303-copy'), keep = true } = {}) {
  const real = path.join(home, 'memory-context');
  if (!fs.existsSync(real)) throw new Error(`真库不存在：${real}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(work), { recursive: true });
  fs.cpSync(real, work, { recursive: true });

  const rounds = [];
  rounds.push(runArchive({ home, store: work, repo }));
  const m1 = readManifest(work);
  const snap = `${work}-run1`; // 第一遍之后留底，用于逐字节定位差异字段
  fs.rmSync(snap, { recursive: true, force: true });
  fs.cpSync(work, snap, { recursive: true });
  rounds.push(runArchive({ home, store: work, repo }));
  const m2 = readManifest(work);

  const diff = diffChecksums(m1?.checksums ?? {}, m2?.checksums ?? {});
  const details = [];
  for (const rel of diff.changed) {
    const a = path.join(snap, rel);
    const b = path.join(work, rel);
    if (!fs.existsSync(a) || !fs.existsSync(b)) { details.push({ rel, note: 'file-missing' }); continue; }
    const d = firstByteDiff(a, b);
    const g = d ? guessField(d.a) ?? guessField(d.b) : null;
    details.push({ rel, ...(d ?? {}), field: g });
  }
  fs.rmSync(snap, { recursive: true, force: true });
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
  return { ok: diff.changed.length === 0 && diff.onlyA.length === 0 && diff.onlyB.length === 0, rounds, diff, details };
}

export function formatReport(r) {
  const lines = [];
  const d = r.diff;
  lines.push(`归档幂等审计（副本：tmp/t303-copy）`);
  lines.push(`  两次 archive 退出码：${r.rounds.map((x) => x.status).join(' / ')}`);
  lines.push(`  manifest checksums：相同 ${d.same.length} · 不同 ${d.changed.length} · 只在第一次 ${d.onlyA.length} · 只在第二次 ${d.onlyB.length}`);
  for (const rel of d.changed.slice(0, 10)) lines.push(`    ✗ ${rel}`);
  for (const rel of d.onlyA.slice(0, 5)) lines.push(`    − ${rel}（第二次消失）`);
  for (const rel of d.onlyB.slice(0, 5)) lines.push(`    + ${rel}（第二次新增）`);
  for (const x of r.details.slice(0, 5)) {
    if (x.offset !== undefined) lines.push(`    ↳ ${x.rel} @byte ${x.offset}\n      A: ${x.a}\n      B: ${x.b}`);
  }
  lines.push(`结论：${r.ok ? '幂等（两次 manifest sha256 全表一致）' : '**不幂等**'}`);
  return lines.join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) return { code: 0, stdout: 'node scripts/idempotency-audit.mjs [--json] [--home <dir>]' };
  const json = argv.includes('--json');
  const homeIdx = argv.indexOf('--home');
  const home = homeIdx >= 0 ? path.resolve(argv[homeIdx + 1]) : defaultHome();
  const r = auditIdempotency({ home });
  return { code: r.ok ? 0 : 1, stdout: json ? JSON.stringify({ ok: r.ok, diff: r.diff, details: r.details }, null, 2) : formatReport(r) };
}

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
