#!/usr/bin/env node
// T166 · 一条命令跑通「重归档 → 标 stale → 再归档验证」的副本演练
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// T159b 让归档**保留**已标 stale 的记录（`carryStaleMarking`），但"保留"这件事必须能一条命令复算：
// 复制一份库 → 归档 → 标 stale → 再归档 → 数一数标记还在不在。默认**全程只读源库**，
// 只有显式 `--apply --yes` 才对源库本身跑同样三步。
//
// ── 契约 ────────────────────────────────────────────────────────────────────
// 入口：`runStalePass({storeRoot, workRoot, dataRoot, apply, yes, now})` → report
// 步骤：
//   1. 把 `--store` **复制**到 `--work`（源库只读；副本目录先做安全校验再清空）
//   2. 在副本上 `runArchive`（复用 `scripts/archive.mjs` 的导出，不改其行为）
//   3. 在副本上 `runMarkStale --apply`（复用 `scripts/mark-stale.mjs`）
//   4. 再 `runArchive` 一次，数「标记存活数」（应等于第 3 步标记数）
//   5. 打印表：claims / 标记数 / 存活数 / 存活率 / 耗时
// 写库边界：默认**不碰** `--store`；`--apply` 时先打印"将要写哪些文件（计数）"，**必须同时给 `--yes`**，
//           否则退出码 2（非交互：不做任何写入）。
// 副本安全：
//   · `--work` 必须是绝对路径、不能是盘根/家目录、**不能等于或位于源库内**（也不允许把源库嵌进副本）
//   · 已存在的副本必须是"看起来像库"（有 manifest.json 或 episodes/）才允许清空 —— 防误删别人的目录
// 允许依赖：`scripts/archive.mjs`、`scripts/mark-stale.mjs`（只读复用）、node 内置。零第三方依赖。
//
// 用法：
//   node scripts/stale-pass.mjs --store <srcStore> --work <copyDir> [--root <dataRoot>] [--json] [--evidence <path>]
//   node scripts/stale-pass.mjs --store <srcStore> --work <copyDir> --apply --yes
//
// 退出码：0 成功；2 参数/安全校验失败（什么都没写）；1 运行失败。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runArchive } from './archive.mjs';
import { runMarkStale } from './mark-stale.mjs';

export const STALE_PASS_VERSION = 1;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function looksLikeStore(dir) {
  if (!dir) return false;
  try {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return true;
    return fs.existsSync(path.join(dir, 'episodes'));
  } catch {
    return false;
  }
}

function walk(dir, out = { files: 0, bytes: 0 }) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of names) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) {
      out.files += 1;
      try {
        out.bytes += fs.statSync(full).size;
      } catch {
        /* 并发删除：忽略 */
      }
    }
  }
  return out;
}

function countMarks(storeRoot) {
  const dir = path.join(storeRoot, 'claims');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { claims: 0, marked: 0, survived: 0, reasons: {} };
  }
  let claims = 0;
  let marked = 0;
  let survived = 0;
  const reasons = {};
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    claims += 1;
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (typeof record?.staleMarkedBy !== 'string' || record.staleMarkedBy === '') continue;
    marked += 1;
    if (record.state === 'stale') survived += 1;
    const reason = String(record.staleReason ?? 'unknown');
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { claims, marked, survived, reasons };
}

function pct(x) {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(2)}%`;
}

function ms(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

// ---------------------------------------------------------------------------
// 安全校验
// ---------------------------------------------------------------------------

/**
 * 校验副本目录是否安全（可以清空）。
 * @returns {{ok:boolean, code?:string, message?:string}}
 */
export function validateWorkDir({ storeRoot, workRoot }) {
  const rawWork = String(workRoot ?? '');
  const rawStore = String(storeRoot ?? '');
  if (rawStore === '' || rawWork === '') return { ok: false, code: 'missing-arg', message: '需要 --store 与 --work' };
  if (!path.isAbsolute(rawWork)) return { ok: false, code: 'work-not-absolute', message: `--work 必须是绝对路径：${rawWork}` };
  const store = path.resolve(rawStore);
  const work = path.resolve(rawWork);
  if (work === path.parse(work).root) return { ok: false, code: 'work-is-root', message: `--work 不能是盘根：${work}` };
  if (work === path.resolve(os.homedir())) return { ok: false, code: 'work-is-home', message: `--work 不能是家目录：${work}` };
  if (work === store) return { ok: false, code: 'work-equals-store', message: '--work 不能等于 --store（副本必须另开目录）' };
  if (isInside(work, store)) return { ok: false, code: 'work-inside-store', message: `--work 不能位于源库内：${work} ⊂ ${store}` };
  if (isInside(store, work)) return { ok: false, code: 'store-inside-work', message: `源库不能位于副本内（会连源库一起删）：${store} ⊂ ${work}` };
  if (!fs.existsSync(store)) return { ok: false, code: 'store-missing', message: `源库不存在：${store}` };
  if (!looksLikeStore(store)) return { ok: false, code: 'store-not-a-store', message: `源库既没有 manifest.json 也没有 episodes/：${store}` };
  if (fs.existsSync(work)) {
    if (!fs.statSync(work).isDirectory()) return { ok: false, code: 'work-not-dir', message: `--work 已存在且不是目录：${work}` };
    if (!looksLikeStore(work)) {
      const entries = fs.readdirSync(work);
      if (entries.length > 0) {
        return { ok: false, code: 'work-not-empty', message: `--work 已存在且不像库（有 ${entries.length} 个条目）—— 拒绝清空，换个目录或手动清空：${work}` };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 复制
// ---------------------------------------------------------------------------

export function copyStore(storeRoot, workRoot) {
  const started = Date.now();
  if (fs.existsSync(workRoot)) fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(workRoot), { recursive: true });
  fs.cpSync(storeRoot, workRoot, { recursive: true, errorOnExist: false, force: true });
  const size = walk(workRoot);
  return { workRoot, files: size.files, bytes: size.bytes, elapsedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// 三步（归档 → 标 stale → 再归档）
// ---------------------------------------------------------------------------

/**
 * 在一个库上跑「归档 → 标 stale → 再归档 → 数存活」。
 * @param {{storeRoot:string, dataRoot:string, now:number, deps?:{archive?:Function, markStale?:Function}}} p
 */
export async function runThreeSteps({ storeRoot, dataRoot, now, deps = {} }) {
  const archive = deps.archive ?? runArchive;
  const markStale = deps.markStale ?? runMarkStale;

  const t0 = Date.now();
  const archive1 = await archive({ dataRoot, storeRoot, now });
  const t1 = Date.now();
  const mark = await markStale({ storeRoot, workspace: dataRoot, apply: true, now: now + 1 });
  const t2 = Date.now();
  const archive2 = await archive({ dataRoot, storeRoot, now: now + 2 });
  const t3 = Date.now();
  const survival = countMarks(storeRoot);

  return {
    archive1: {
      ms: t1 - t0,
      episodes: archive1?.counts?.episodes ?? archive1?.episodes?.total ?? null,
      claims: archive1?.counts?.claims ?? null,
      verifyOk: Boolean(archive1?.verify?.ok),
      written: archive1?.added ?? null,
    },
    mark: {
      ms: t2 - t1,
      marked: mark?.counts?.mark ?? 0,
      already: mark?.counts?.already ?? 0,
      skipped: mark?.counts?.skip ?? 0,
      byReason: mark?.byReason ?? {},
      verifyOk: mark?.verify?.ok ?? null,
    },
    archive2: {
      ms: t3 - t2,
      claimsWritten: archive2?.writes?.claims?.written ?? null,
      verifyOk: Boolean(archive2?.verify?.ok),
    },
    survival: {
      ...survival,
      rate: survival.marked === 0 ? null : survival.survived / survival.marked,
    },
    elapsedMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

/**
 * 跑一次完整 pass：默认只在副本上跑；`apply && yes` 才额外对源库跑同样三步。
 * @param {{storeRoot:string, workRoot:string, dataRoot?:string|null, apply?:boolean, yes?:boolean, now?:number,
 *          deps?:object}} opts
 */
export async function runStalePass(opts = {}) {
  const started = Date.now();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const dataRoot = opts.dataRoot === null ? null : path.resolve(opts.dataRoot ?? process.env.DSH_HOME ?? '');
  const storeRoot = path.resolve(String(opts.storeRoot ?? ''));
  const workRoot = path.resolve(String(opts.workRoot ?? ''));
  const apply = Boolean(opts.apply);
  const yes = Boolean(opts.yes);

  const check = validateWorkDir({ storeRoot, workRoot });
  const report = {
    version: STALE_PASS_VERSION,
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    storeRoot,
    workRoot,
    dataRoot,
    apply,
    yes,
    validation: { ok: check.ok, code: check.code ?? null, message: check.message ?? null },
    copy: null,
    copyPass: null,
    sourcePass: null,
    confirm: null,
    elapsedMs: 0,
  };
  if (!check.ok) return report;
  if (!dataRoot || !fs.existsSync(dataRoot)) {
    report.validation = { ok: false, code: 'data-root-missing', message: `数据根不存在：${dataRoot ?? '(空)'}` };
    return report;
  }

  // ---- 1. 复制（源库只读）----
  report.copy = copyStore(storeRoot, workRoot);

  // ---- 2–4. 在副本上跑三步 ----
  report.copyPass = await runThreeSteps({ storeRoot: workRoot, dataRoot, now, deps: opts.deps });

  // ---- 5. --apply：先报"将写什么"，再要求 --yes ----
  if (apply) {
    const before = report.copyPass.survival;
    report.confirm = {
      willWriteClaims: before.marked,
      willRewriteManifest: true,
      target: storeRoot,
      requires: '--yes',
    };
    if (yes) {
      report.sourcePass = await runThreeSteps({ storeRoot, dataRoot, now: now + 10, deps: opts.deps });
    }
  }

  report.elapsedMs = Date.now() - started;
  return report;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export function formatReport(report) {
  const lines = [];
  const v = report.validation;
  if (!v.ok) {
    lines.push(`棋院 stale-pass · 参数/安全校验失败（${v.code}）`);
    lines.push(v.message ?? '');
    return lines.join('\n');
  }
  lines.push('棋院 stale-pass · 重归档 → 标 stale → 再归档验证');
  lines.push(`源库（只读）：${report.storeRoot}`);
  lines.push(`副本：${report.workRoot}`);
  lines.push(`数据根（只读）：${report.dataRoot}`);
  lines.push(`模式：${report.apply && report.yes ? 'APPLY（源库会被写）' : (report.apply ? 'APPLY 待确认（还没写源库）' : '只读演练（不碰源库）')}`);
  lines.push('');
  const row = (label, pass) => {
    if (!pass) return `| ${label} | - | - | - | - | - |`;
    const s = pass.survival;
    return `| ${label} | ${s.claims} | ${pass.mark.marked} | ${s.survived} | ${pct(s.rate)} | ${ms(pass.elapsedMs)} |`;
  };
  lines.push('| 库 | claims | 标记数 | 存活数 | 存活率 | 耗时 |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(row('副本', report.copyPass));
  if (report.sourcePass) lines.push(row('源库', report.sourcePass));
  lines.push('');
  if (report.copy) {
    lines.push(`复制：${report.copy.files} 个文件 / ${(report.copy.bytes / 1048576).toFixed(2)} MiB / ${ms(report.copy.elapsedMs)}`);
  }
  const p = report.copyPass;
  if (p) {
    lines.push(`副本三步：归档 ${ms(p.archive1.ms)}（claims ${p.archive1.claims ?? '?'}）· 标记 ${ms(p.mark.ms)}（${p.mark.marked} 条：${Object.entries(p.mark.byReason).map(([k, n]) => `${k} ${n}`).join(' / ') || '无'}）· 再归档 ${ms(p.archive2.ms)}（claims 写入 ${p.archive2.claimsWritten ?? '?'}）`);
    lines.push(`verify：归档① ${p.archive1.verifyOk ? 'OK' : '失败'} · 标记 ${p.mark.verifyOk === null ? 'n/a' : (p.mark.verifyOk ? 'OK' : '失败')} · 归档② ${p.archive2.verifyOk ? 'OK' : '失败'}`);
    lines.push(`存活：${p.survival.survived} / ${p.survival.marked}（${pct(p.survival.rate)}）${Object.keys(p.survival.reasons).length ? ` · 原因：${Object.entries(p.survival.reasons).map(([k, n]) => `${k} ${n}`).join(' · ')}` : ''}`);
  }
  if (report.apply && !report.yes) {
    lines.push('');
    lines.push('⚠ 还没有写源库。确认副本结果后，加 `--yes` 才会对源库执行同样三步：');
    lines.push(`   将写：claims ${report.confirm?.willWriteClaims ?? 0} 条 + 重写 manifest.json（目录 ${report.storeRoot}）`);
    lines.push('   回退：node scripts/mark-stale.mjs --store <源库> --revert --apply');
  }
  if (report.sourcePass) {
    lines.push('');
    lines.push(`源库三步：归档 ${ms(report.sourcePass.archive1.ms)} · 标记 ${report.sourcePass.mark.marked} 条 · 再归档 ${ms(report.sourcePass.archive2.ms)} · 存活 ${report.sourcePass.survival.survived}/${report.sourcePass.survival.marked}（${pct(report.sourcePass.survival.rate)}）`);
  }
  lines.push('');
  lines.push(`总耗时 ${ms(report.elapsedMs)}`);
  return lines.join('\n');
}

export function renderMarkdown(report) {
  const lines = [];
  const v = report.validation;
  lines.push('# T166 · 重归档 → 标 stale → 再归档验证（副本演练）');
  lines.push('');
  lines.push(`> 生成：\`node scripts/stale-pass.mjs --store <srcStore> --work <copyDir>${report.apply && report.yes ? ' --apply --yes' : ''} --evidence evidence/T166-stale-pass.md\``);
  lines.push(`> 运行时刻：${report.generatedAtIso}（UTC；epoch ms ${report.generatedAt}）· 版本 stale-pass v${report.version} · 总耗时 ${ms(report.elapsedMs)}`);
  lines.push('');
  if (!v.ok) {
    lines.push(`**校验失败**：\`${v.code}\` —— ${v.message ?? ''}`);
    lines.push('');
    return lines.join('\n');
  }
  lines.push('## 1 · 口径');
  lines.push('');
  lines.push('| 项 | 定义 |');
  lines.push('|---|---|');
  lines.push('| 副本 | `--work` 下的源库**拷贝**；源库全程只读（除 `--apply --yes`） |');
  lines.push('| 三步 | ① `archive` 重归档 → ② `mark-stale --apply` 标真 stale → ③ 再 `archive` |');
  lines.push('| 标记数 | 第 ② 步实际写入的降级标记（`staleMarkedBy` 非空）条数 |');
  lines.push('| 存活数 | 第 ③ 步归档之后，库里仍带 `staleMarkedBy` 且 `state === \'stale\'` 的条数 |');
  lines.push('| 存活率 | 存活数 ÷ 标记数（标记数为 0 ⇒ `null`，不写 0） |');
  lines.push('');
  lines.push('## 2 · 结果');
  lines.push('');
  lines.push('| 库 | claims | 标记数 | 存活数 | 存活率 | 耗时 |');
  lines.push('|---|---|---|---|---|---|');
  const row = (label, pass) => {
    if (!pass) return null;
    const s = pass.survival;
    return `| ${label} | ${s.claims} | ${pass.mark.marked} | ${s.survived} | **${pct(s.rate)}** | ${ms(pass.elapsedMs)} |`;
  };
  const r1 = row('副本', report.copyPass);
  if (r1) lines.push(r1);
  const r2 = row('源库', report.sourcePass);
  if (r2) lines.push(r2);
  if (!report.sourcePass) lines.push('| 源库 | - | - | - | - | 未执行（缺 `--yes` 或未 `--apply`） |');
  lines.push('');
  if (report.copy) {
    lines.push(`- 复制：${report.copy.files} 个文件 / ${(report.copy.bytes / 1048576).toFixed(2)} MiB / ${ms(report.copy.elapsedMs)}`);
  }
  const p = report.copyPass;
  if (p) {
    lines.push(`- 副本三步：归档 ${ms(p.archive1.ms)}（episodes ${p.archive1.episodes ?? '?'} / claims ${p.archive1.claims ?? '?'}）· 标记 ${ms(p.mark.ms)}（${p.mark.marked} 条${Object.keys(p.mark.byReason).length ? `：${Object.entries(p.mark.byReason).map(([k, n]) => `\`${k}\` ${n}`).join(' · ')}` : ''}）· 再归档 ${ms(p.archive2.ms)}`);
    lines.push(`- verify：归档① ${p.archive1.verifyOk ? 'OK' : '失败'} · 标记 ${p.mark.verifyOk === null ? 'n/a' : (p.mark.verifyOk ? 'OK' : '失败')} · 归档② ${p.archive2.verifyOk ? 'OK' : '失败'}`);
    lines.push(`- 存活：**${p.survival.survived} / ${p.survival.marked}**（${pct(p.survival.rate)}）`);
  }
  lines.push('');
  lines.push('## 3 · 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"');
  lines.push('node scripts/stale-pass.mjs --store "$DSH_HOME/memory-context" --work tmp/t166-copy          # 只读演练');
  lines.push('node scripts/stale-pass.mjs --store "$DSH_HOME/memory-context" --work tmp/t166-copy --apply # 打印将写内容，需 --yes');
  lines.push('node --test test/stale-pass.test.mjs');
  lines.push('```');
  lines.push('');
  lines.push('## 4 · 风险与边界');
  lines.push('');
  lines.push('1. **默认不碰源库**：只有 `--apply --yes` 才写；`--apply` 单独跑会在打印"将写 claims N 条 + 重写 manifest"后以退出码 2 结束，零写入。');
  lines.push('2. **副本安全**：`--work` 必须是绝对路径、不能是盘根/家目录、不能等于或位于源库内；已存在的副本必须"看起来像库"（manifest.json 或 episodes/）才允许清空。');
  lines.push('3. **活语料下"再归档写入数"不会是 0**：两次归档之间会话仍在追加事件，claim 的 support/counters 会被重算——这是设计如此；**存活率**才是本脚本的判据（冻结语料下归档两次 0 重写由 `test/archive-stale.test.mjs` 证明）。');
  lines.push('4. **耗时**主要在两遍归档（真实语料每遍约 2–3 分钟）；副本复制 15 MiB 级库约 1 秒。');
  lines.push('5. 本脚本**只做编排**，不改 `archive.mjs` / `mark-stale.mjs` 的行为；标记的语义与回退方式见 `scripts/mark-stale.mjs` 的 `--revert --apply`。');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `棋院 stale-pass（T166：重归档 → 标 stale → 再归档验证）

用法：
  node scripts/stale-pass.mjs --store <srcStore> --work <copyDir> [--root <dataRoot>] [--json] [--evidence <path>]
  node scripts/stale-pass.mjs --store <srcStore> --work <copyDir> --apply --yes

选项：
  --store <dir>     源库（默认只读）
  --work <dir>      副本目录（绝对路径；必须与源库不同、且不在源库内）
  --root <dir>      数据根（默认 $DSH_HOME）：归档要读的会话日志/棋谱
  --apply           对源库本身跑同样三步（需同时给 --yes，否则只打印计划、退出码 2）
  --yes             确认写源库
  --json            输出 JSON
  --evidence <p>    写 markdown 证据
  --now <ms>        固定时钟（测试/复算用）
  -h, --help        本帮助
`;

export function parseArgs(argv = []) {
  const args = [...argv];
  const flags = {};
  const positional = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--apply') flags.apply = true;
    else if (a === '--yes') flags.yes = true;
    else if (a === '--json') flags.json = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--store') flags.store = args.shift();
    else if (a.startsWith('--store=')) flags.store = a.slice('--store='.length);
    else if (a === '--work') flags.work = args.shift();
    else if (a.startsWith('--work=')) flags.work = a.slice('--work='.length);
    else if (a === '--root') flags.root = args.shift();
    else if (a.startsWith('--root=')) flags.root = a.slice('--root='.length);
    else if (a === '--evidence') flags.evidence = args.shift();
    else if (a.startsWith('--evidence=')) flags.evidence = a.slice('--evidence='.length);
    else if (a === '--now') flags.now = Number(args.shift());
    else if (a.startsWith('--now=')) flags.now = Number(a.slice('--now='.length));
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

export async function runCli(argv = []) {
  const { flags } = parseArgs(argv);
  if (flags.help) return { code: 0, stdout: USAGE, stderr: '' };
  try {
    const report = await runStalePass({
      storeRoot: flags.store,
      workRoot: flags.work,
      dataRoot: flags.root ? path.resolve(flags.root) : (process.env.DSH_HOME ?? ''),
      apply: Boolean(flags.apply),
      yes: Boolean(flags.yes) && Boolean(flags.apply),
      now: flags.now,
    });
    let evidence = null;
    if (typeof flags.evidence === 'string' && flags.evidence !== '') {
      const abs = path.resolve(flags.evidence);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, renderMarkdown(report));
      evidence = abs;
    }
    const text = `${formatReport(report)}${evidence ? `\n证据已写：${evidence}` : ''}`;
    if (!report.validation.ok) return { code: 2, stdout: text, stderr: report.validation.message ?? '校验失败' };
    if (report.apply && !report.yes) return { code: 2, stdout: text, stderr: '需要 --yes 才会写源库（本次零写入）' };
    if (flags.json) return { code: 0, stdout: JSON.stringify({ ...report, evidence }, null, 2), stderr: '' };
    return { code: 0, stdout: text, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `stale-pass 失败：${String(err?.stack ?? err)}` };
  }
}

export async function main(argv = [], io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const res = await runCli(argv);
  if (res.stdout) out.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
  if (res.stderr) err.write(res.stderr.endsWith('\n') ? res.stderr : `${res.stderr}\n`);
  return res.code;
}

export default {
  runStalePass,
  runThreeSteps,
  copyStore,
  validateWorkDir,
  formatReport,
  renderMarkdown,
  parseArgs,
  runCli,
  main,
  STALE_PASS_VERSION,
};

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
