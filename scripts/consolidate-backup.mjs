#!/usr/bin/env node
// T170 · 合流写库前的**可校验备份 + 一条命令回滚**
//
// 为什么不是裸 `cp -r`：备份要能**自证完整性**——写完逐个文件算 sha256 存进
// `backup-meta.json`，`--verify` 重算比对（任何字节、任何文件缺失都当场红）。
// 回滚也先验备份、再整体替换目标、最后用 `store.verify()`（manifest checksums）证明目标库自洽。
//
// 用法：
//   node scripts/consolidate-backup.mjs --store <src> --backup <dir>              # 备份
//   node scripts/consolidate-backup.mjs --verify <dir>                            # 校验备份
//   node scripts/consolidate-backup.mjs --restore <dir> --target <dir>            # 回滚（幂等）
//
// 硬边界：
//   · 备份目录不能位于源库内（反之亦然）；回滚目标不能位于备份内。
//   · 默认**拒绝**把回滚目标写成真库 `<DSH_HOME>/memory-context`；
//     真要上线才加 `--force-real-store`（本任务的演练不会用到）。
//   · 回滚幂等：同一备份回滚两次，目标库逐字节相同（整体替换，不做增量合并）。
//
// 退出码：0 成功；2 参数/安全校验失败；3 备份校验不通过；1 运行失败。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';

export const BACKUP_VERSION = 1;
export const META_FILE = 'backup-meta.json';
export const STORE_DIR = 'store';

const ms = (n) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);

export function defaultRealStoreRoot(env = process.env) {
  const home = env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home');
  return path.resolve(path.join(home, 'memory-context'));
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 遍历目录，返回相对路径 → 文件信息。 */
export function walkFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ rel: path.relative(root, full).split(path.sep).join('/'), abs: full, size: fs.statSync(full).size });
    }
  };
  walk(root);
  return out;
}

function looksLikeStore(dir) {
  try {
    return fs.existsSync(path.join(dir, 'manifest.json')) || fs.existsSync(path.join(dir, 'episodes'));
  } catch {
    return false;
  }
}

/**
 * 备份：整体复制 + 逐文件 sha256 快照 + counts。
 * @param {{storeRoot:string, backupDir:string, now?:number, deps?:object}} p
 */
export function createBackup({ storeRoot, backupDir, now = Date.now(), deps = {} } = {}) {
  const src = path.resolve(String(storeRoot ?? ''));
  const dst = path.resolve(String(backupDir ?? ''));
  if (!storeRoot || !backupDir) throw new Error('createBackup: 需要 storeRoot 与 backupDir');
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  if (!fs.existsSync(src) || !looksLikeStore(src)) fail('backup/store-missing', `源库不存在或不像库：${src}`);
  if (dst === src) fail('backup/dir-is-store', '备份目录不能是源库本身');
  if (isInside(dst, src)) fail('backup/dir-inside-store', `备份目录不能位于源库内：${dst} ⊂ ${src}`);
  if (isInside(src, dst)) fail('backup/store-inside-dir', `源库不能位于备份目录内（清空时会连源库一起删）：${src} ⊂ ${dst}`);
  if (fs.existsSync(dst) && !fs.statSync(dst).isDirectory()) fail('backup/dir-not-directory', `备份路径已存在且不是目录：${dst}`);
  if (fs.existsSync(dst)) {
    const entries = fs.readdirSync(dst);
    const ours = entries.every((name) => name === STORE_DIR || name === META_FILE);
    if (entries.length > 0 && !ours) fail('backup/dir-not-empty', `备份目录已存在且不是本工具的备份（${entries.length} 个条目）：${dst}`);
  }

  const started = Date.now();
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const storeDir = path.join(dst, STORE_DIR);
  fs.cpSync(src, storeDir, { recursive: true, force: true });

  const files = walkFiles(storeDir).map((f) => ({ rel: f.rel, size: f.size, sha256: sha256File(f.abs) }));
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const store = (deps.makeStore ?? createStore)({ root: storeDir });
  const verify = store.verify();
  const meta = {
    version: BACKUP_VERSION,
    createdAt: now,
    createdAtIso: new Date(now).toISOString(),
    sourceRoot: src,
    counts: store.counts(),
    files: Object.fromEntries(files.map((f) => [f.rel, { size: f.size, sha256: f.sha256 }])),
    fileCount: files.length,
    bytes,
    storeVerifyOk: Boolean(verify.ok),
    storeVerifyErrors: verify.errors ?? [],
  };
  const metaPath = path.join(dst, META_FILE);
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { backupDir: dst, storeDir, metaPath, files: files.length, bytes, counts: meta.counts, verifyOk: meta.storeVerifyOk, elapsedMs: Date.now() - started };
}

/**
 * 校验备份：sha256 逐个比对 + 备份内 store 的 manifest verify。
 * @param {{backupDir:string}} p
 */
export function verifyBackup({ backupDir } = {}) {
  const dir = path.resolve(String(backupDir ?? ''));
  const metaPath = path.join(dir, META_FILE);
  const storeDir = path.join(dir, STORE_DIR);
  const result = { backupDir: dir, ok: false, checked: 0, failures: [], meta: null, verify: null };
  if (!fs.existsSync(metaPath)) {
    result.failures.push({ reason: 'meta-missing', path: metaPath });
    return result;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (error) {
    result.failures.push({ reason: 'meta-invalid', message: String(error?.message ?? error) });
    return result;
  }
  result.meta = meta;
  if (meta.version !== BACKUP_VERSION) result.failures.push({ reason: 'meta-version', found: meta.version, expected: BACKUP_VERSION });
  if (!fs.existsSync(storeDir)) result.failures.push({ reason: 'store-missing', path: storeDir });

  const onDisk = fs.existsSync(storeDir) ? walkFiles(storeDir) : [];
  const seen = new Set();
  for (const file of onDisk) {
    seen.add(file.rel);
    const want = meta.files?.[file.rel];
    if (!want) {
      result.failures.push({ reason: 'extra-file', path: file.rel });
      continue;
    }
    result.checked += 1;
    const actual = sha256File(file.abs);
    if (actual !== want.sha256) result.failures.push({ reason: 'sha256-mismatch', path: file.rel, expected: want.sha256, actual });
  }
  for (const rel of Object.keys(meta.files ?? {})) {
    if (!seen.has(rel)) result.failures.push({ reason: 'missing-file', path: rel });
  }
  if (fs.existsSync(storeDir)) {
    const store = createStore({ root: storeDir });
    result.verify = store.verify();
    if (!result.verify.ok) result.failures.push({ reason: 'store-verify', errors: result.verify.errors });
  }
  result.ok = result.failures.length === 0;
  return result;
}

/**
 * 回滚：验备份 → 整体替换目标 → `store.verify()`。幂等（整体替换，不做增量）。
 * @param {{backupDir:string, targetRoot:string, now?:number, forceRealStore?:boolean, realStoreRoot?:string}} p
 */
export function restoreBackup({ backupDir, targetRoot, now = Date.now(), forceRealStore = false, realStoreRoot = null } = {}) {
  const dir = path.resolve(String(backupDir ?? ''));
  const target = path.resolve(String(targetRoot ?? ''));
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  if (!backupDir || !targetRoot) fail('restore/missing-arg', '需要 backupDir 与 targetRoot');
  if (target === dir) fail('restore/target-is-backup', '回滚目标不能是备份目录本身');
  if (isInside(target, dir)) fail('restore/target-inside-backup', `回滚目标不能位于备份目录内：${target} ⊂ ${dir}`);
  if (isInside(dir, target)) fail('restore/backup-inside-target', `备份不能位于回滚目标内（替换目标时会连备份一起删）：${dir} ⊂ ${target}`);
  const realRoot = realStoreRoot ? path.resolve(realStoreRoot) : defaultRealStoreRoot();
  if (!forceRealStore && target === realRoot) {
    fail('restore/target-is-real-store', `拒绝把回滚目标写成真库：${target}（真要上线才加 --force-real-store）`);
  }
  if (target === path.parse(target).root) fail('restore/target-is-root', `回滚目标不能是盘根：${target}`);

  const check = verifyBackup({ backupDir: dir });
  if (!check.ok) {
    const error = new Error(`备份校验不通过（${check.failures.length} 处）：${check.failures.slice(0, 3).map((f) => f.reason).join(', ')}`);
    error.code = 'restore/backup-invalid';
    error.failures = check.failures;
    throw error;
  }

  const started = Date.now();
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) fail('restore/target-not-directory', `回滚目标已存在且不是目录：${target}`);
    if (!looksLikeStore(target) && fs.readdirSync(target).length > 0) {
      fail('restore/target-not-empty', `回滚目标已存在且不像库（有 ${fs.readdirSync(target).length} 个条目）：${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(dir, STORE_DIR), target, { recursive: true, force: true });

  const store = createStore({ root: target });
  const verify = store.verify();
  const files = walkFiles(target).length;
  return {
    target,
    files,
    counts: store.counts(),
    verifyOk: Boolean(verify.ok),
    verifyErrors: verify.errors ?? [],
    verified: check.failures.length === 0,
    elapsedMs: Date.now() - started,
    at: now,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `棋院 consolidate-backup（T170：可校验备份 + 一条命令回滚）

用法：
  node scripts/consolidate-backup.mjs --store <src> --backup <dir>          # 备份
  node scripts/consolidate-backup.mjs --verify <dir>                        # 校验备份（sha256 逐文件）
  node scripts/consolidate-backup.mjs --restore <dir> --target <dir>        # 回滚（幂等；默认拒绝写真库）

选项：
  --store <dir>        源库（只读）
  --backup <dir>       备份目录（写成 <dir>/store + <dir>/backup-meta.json）
  --verify <dir>       校验一个备份
  --restore <dir>      从一个备份回滚
  --target <dir>       回滚目标库
  --force-real-store   允许回滚目标 = <DSH_HOME>/memory-context（默认拒绝）
  --json               机器可读输出
  -h, --help
`;

export function parseArgs(argv = []) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--force-real-store') flags.forceRealStore = true;
    else if (arg === '--store') flags.store = argv[++i] ?? null;
    else if (arg === '--backup') flags.backup = argv[++i] ?? null;
    else if (arg === '--verify') flags.verify = argv[++i] ?? null;
    else if (arg === '--restore') flags.restore = argv[++i] ?? null;
    else if (arg === '--target') flags.target = argv[++i] ?? null;
    else return { error: `未知参数：${arg}` };
  }
  return flags;
}

export function runBackupCli(argv = process.argv.slice(2), { deps = {} } = {}) {
  const flags = parseArgs(argv);
  if (flags.error) return { code: 2, stderr: flags.error };
  if (flags.help) return { code: 0, stdout: USAGE };
  if (flags.verify) {
    const res = verifyBackup({ backupDir: flags.verify });
    const text = `备份：${res.backupDir}\n校验：${res.ok ? 'OK' : '失败'} · ${res.checked} 个文件${res.meta ? ` · 备份于 ${res.meta.createdAtIso} · 源库 ${res.meta.sourceRoot}` : ''}${res.failures.length ? `\n失败 ${res.failures.length} 处：${res.failures.slice(0, 5).map((f) => `${f.reason}${f.path ? `(${f.path})` : ''}`).join(' · ')}` : ''}`;
    return { code: res.ok ? 0 : 3, stdout: flags.json ? JSON.stringify(res, null, 2) : text };
  }
  if (flags.restore) {
    try {
      const res = restoreBackup({ backupDir: flags.restore, targetRoot: flags.target, forceRealStore: Boolean(flags.forceRealStore) });
      const text = `回滚：${res.target}\n文件 ${res.files} · claims ${res.counts.claims} · verify ${res.verifyOk ? 'OK' : '失败'} · 耗时 ${ms(res.elapsedMs)}`;
      return { code: res.verifyOk ? 0 : 1, stdout: flags.json ? JSON.stringify(res, null, 2) : text };
    } catch (error) {
      return { code: 2, stderr: `consolidate-backup: ${error.code ?? 'restore/error'}: ${error.message}` };
    }
  }
  if (!flags.store || !flags.backup) return { code: 2, stderr: '需要 --store 与 --backup（或 --verify / --restore）' };
  try {
    const res = createBackup({ storeRoot: flags.store, backupDir: flags.backup, deps });
    const text = `备份：${res.backupDir}\n文件 ${res.files} · ${(res.bytes / 1048576).toFixed(2)} MiB · claims ${res.counts.claims} · 备份内 verify ${res.verifyOk ? 'OK' : '失败'} · 耗时 ${ms(res.elapsedMs)}\n校验：node scripts/consolidate-backup.mjs --verify "${res.backupDir}"`;
    return { code: 0, stdout: flags.json ? JSON.stringify(res, null, 2) : text };
  } catch (error) {
    return { code: 2, stderr: `consolidate-backup: ${error.code ?? 'backup/error'}: ${error.message}` };
  }
}

export function main(argv = process.argv.slice(2)) {
  const res = runBackupCli(argv);
  if (res.stdout) process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
  if (res.stderr) process.stderr.write(res.stderr.endsWith('\n') ? res.stderr : `${res.stderr}\n`);
  return res.code;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();
