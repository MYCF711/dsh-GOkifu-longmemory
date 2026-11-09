#!/usr/bin/env node
// T161 · 合流写路径 CLI（S3）：**源库只读 → 影子库**
// T170 · `--all`：影子库**完整镜像**（claims + episodes + topics + links + threads + joseki + adjudications
//        + index.md + manifest），不再只是 claim 层 —— 这是"敢写真库"的前提之一。
//
// 用法：
//   node scripts/consolidate-apply.mjs --store <src> [--scope <s>] [--out <dst>] [--all] [--dry-run]
//
// 语义：
//   · 不带 `--out`（或显式 `--dry-run`）⇒ 只读预览，不写盘（默认 dry-run）。
//   · 带 `--out <dst>` ⇒ 把源库 claim 层复制到 dst（不存在则初始化），再追加合并节点；
//     **源库一个字节都不动**，`--out` 等于/位于源库内会直接报错。
//   · 带 `--all` ⇒ 在 claim 层之上把**其余六个 kind、index.md、manifest** 一并镜像过去，
//     结束时用 `store.verify()` 证明影库自洽，并逐 kind 对比源库条数。
//
// 幂等：同一 dst 连跑两次，第二次 `merged added 0`（合并节点 id 由成员决定、内容由成员派生）；
//       `--all` 的其余 kind 第二次 `written 0`（同内容不重写）。
//
// 退出码：0 成功；2 参数/库不存在；3 合流冲突（不覆盖既有真 claim）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore, ENTRY_KINDS } from '../src/rooms/persist.mjs';
import { consolidate, ConsolidateError } from '../src/rooms/consolidate.mjs';

const USAGE = `用法：node scripts/consolidate-apply.mjs --store <src> [--scope <s>] [--out <dst>] [--all] [--dry-run]

  --store <src>   源库目录（只读；如 <DSH_HOME>/memory-context）
  --out <dst>     影子库目录（给了才落盘；不存在则初始化）
  --scope <s>     只合某个 scopeKey（默认全库）
  --all           影子库完整镜像（其余六个 kind + index.md + manifest + verify）
  --dry-run       强制只读预览（即使给了 --out 也不写）`;

export function parseArgs(argv) {
  const out = { store: null, outDir: null, scope: null, all: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--store') out.store = argv[++i] ?? null;
    else if (arg === '--out') out.outDir = argv[++i] ?? null;
    else if (arg === '--scope') out.scope = argv[++i] ?? null;
    else return { error: `未知参数：${arg}` };
  }
  return out;
}

function pct(x) {
  return `${(Number(x) * 100).toFixed(2)}%`;
}

const ms = (n) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);

/**
 * `--all`：把源库**完整**镜像到影库（claims 已由 `consolidate` 复制，这里补齐其余 kind + index + manifest）。
 * 只写 dst；源库只读（`src.list()` 是纯读）。
 * @param {{src:object, dst:object, at:number}} p
 */
export function mirrorAll({ src, dst, at = Date.now(), extraClaims = 0 } = {}) {
  if (!src || !dst) throw new Error('mirror-all: 需要 src/dst store');
  const started = Date.now();
  // T368（2026-11-09）：**先拍一张源库快照**。
  // 真事：宿主还在跑、会话一结束就归档，一次 --all 要 200 秒 —— 期间源库从 1654 局长到 1908 局。
  // 旧实现只在**结束时**读 `src.counts()` 去比影库，于是必然报「逐 kind 不一致」——
  // 可那个「不一致」其实是「源库变了」，不是「镜像漏了」。现在把三个数分开：
  //   · before：开始时快照（**影库对应的就是它**）
  //   · after ：结束时快照
  //   · drift ：两者不同的 kind ⇒ 明确写「源库在镜像期间变化」，不再冒充不一致
  const beforeCounts = typeof src.counts === 'function' ? { ...src.counts() } : null;
  const kinds = {};
  for (const kind of ENTRY_KINDS) {
    const records = src.list(kind).map((entry) => entry?.record).filter(Boolean);
    if (kind === 'claims') {
      // claims 已由 consolidate 复制（含 scope 过滤）；--all 时补齐全量，保证"镜像 = 源库"
      const res = dst.putMany(kind, records, { at });
      kinds[kind] = { source: records.length, written: res.written, unchanged: res.unchanged };
      continue;
    }
    const t0 = Date.now();
    const res = dst.putMany(kind, records, { at });
    kinds[kind] = { source: records.length, written: res.written, unchanged: res.unchanged, ms: Date.now() - t0 };
  }

  // index.md：派生视图，按源库字节镜像（重算需要 R07 的 renderIndex，不在本脚本职责内）
  let index = null;
  try {
    const text = fs.readFileSync(path.join(src.root, 'index.md'), 'utf8');
    const res = dst.writeIndex(text, { at });
    index = { bytes: Buffer.byteLength(text, 'utf8'), changed: res.changed };
  } catch {
    index = { bytes: 0, changed: false, missing: true };
  }

  const manifest = dst.writeManifest(at);
  const elapsedMs = Date.now() - started;
  const sourceCounts = src.counts();
  const shadowCounts = dst.counts();
  // T368：一致性以**开始时的快照**为准（影库镜像的就是那个状态）；结束时的数只用来判「源库有没有动」
  const baseCounts = beforeCounts ?? sourceCounts;
  const drift = beforeCounts
    ? ENTRY_KINDS.filter((kind) => Number(beforeCounts[kind] ?? 0) !== Number(sourceCounts[kind] ?? 0))
      .map((kind) => ({ kind, before: beforeCounts[kind], after: sourceCounts[kind] }))
    : [];
  // claims 会多出本次新增的合并节点（`merged added`）—— 那不是"镜像不全"，是合流的产出
  const expected = { ...baseCounts };
  expected.claims = baseCounts.claims + Math.max(0, Number(extraClaims) || 0);
  const mismatches = ENTRY_KINDS.filter((kind) => expected[kind] !== shadowCounts[kind]);
  return {
    kinds,
    index,
    manifest: { changed: Boolean(manifest?.changed), files: manifest?.manifest?.files ?? null },
    sourceCounts,
    beforeCounts: baseCounts,
    shadowCounts,
    drift,
    expected,
    extraClaims: Math.max(0, Number(extraClaims) || 0),
    mismatches,
    mirrorOk: mismatches.length === 0,
    elapsedMs,
  };
}

/**
 * 主流程（可注入 store 工厂，便于测试）。
 * @returns {{code:number, report?:object, error?:string}}
 */
export function runApply(argv = process.argv.slice(2), { makeStore = createStore } = {}) {
  const args = parseArgs(argv);
  if (args.error) return { code: 2, error: args.error };
  if (args.help) return { code: 0, report: { help: true } };
  if (!args.store) return { code: 2, error: '缺少 --store' };
  const storeRoot = path.resolve(args.store);
  if (!fs.existsSync(storeRoot)) return { code: 2, error: `源库不存在：${storeRoot}` };

  // 有 --out 才写；--dry-run 强制预览
  const dryRun = args.dryRun || !args.outDir;
  const outDir = args.outDir ? path.resolve(args.outDir) : null;

  const store = makeStore({ root: storeRoot });
  let report;
  const t0 = Date.now();
  try {
    report = consolidate({ store, scope: args.scope, dryRun, outStoreDir: outDir });
  } catch (error) {
    if (error instanceof ConsolidateError) return { code: 2, error: `consolidate-apply: ${error.code}: ${error.message}` };
    throw error;
  }
  const consolidateMs = Date.now() - t0;

  const out = { storeRoot, scope: args.scope, dryRun, outDir, consolidateMs, report, mirror: null, verify: null };
  if (!dryRun && args.all) {
    const dst = makeStore({ root: outDir });
    dst.ensureDirs();
    out.mirror = mirrorAll({ src: store, dst, at: Date.now(), extraClaims: out.report?.apply?.mergedAdded ?? 0 });
    out.verify = dst.verify();
  } else if (!dryRun && !args.all) {
    // 不镜像时也让影库自洽（manifest/verify 由 applyToShadow 之外补一次）
    const dst = makeStore({ root: outDir });
    dst.ensureDirs();
    dst.writeManifest(Date.now());
    out.verify = dst.verify();
  }
  out.elapsedMs = Date.now() - t0;
  if (out.report?.apply?.conflicts > 0) return { code: 3, report: out };
  return { code: 0, report: out };
}

export function formatReport(out) {
  const lines = [];
  const { storeRoot, scope, dryRun, outDir } = out;
  const { stats, quality, apply } = out.report;
  lines.push(`store=${storeRoot}`);
  if (scope) lines.push(`scope=${scope}`);
  lines.push(`mode=${dryRun ? 'dry-run（未写盘）' : `apply → ${outDir}`}`);
  lines.push(`groups ${stats.groups} · tier0 ${stats.byTier[0]} · tier1 ${stats.byTier[1]} · merged ${stats.merged} · reduction ${pct(stats.reduction)}`);
  if (apply) {
    lines.push(
      `apply: copied ${apply.claimsCopied}（changed ${apply.claimsCopiedChanged}）· merged added ${apply.mergedAdded} · rewritten ${apply.mergedRewritten} · conflicts ${apply.conflicts} · total claims ${apply.totalClaims}`,
    );
  }
  if (out.mirror) {
    const m = out.mirror;
    lines.push('');
    lines.push('镜像（--all）：');
    lines.push('| kind | 源库 | 影库 | 写入 | 未变 |');
    lines.push('|---|---|---|---|---|');
    for (const kind of Object.keys(m.kinds)) {
      const k = m.kinds[kind];
      const expect = m.expected?.[kind] ?? k.source;
      const mark = m.mismatches.includes(kind) ? ' ❌' : '';
      lines.push(`| ${kind} | ${expect === k.source ? k.source : `${k.source}+${m.extraClaims}`} | ${m.shadowCounts[kind]}${mark} | ${k.written} | ${k.unchanged} |`);
    }
    lines.push(`index.md ${m.index.missing ? '缺失' : `${m.index.bytes} B${m.index.changed ? '（已更新）' : ''}`} · manifest ${m.manifest.files ?? '?'} 个文件${m.manifest.changed ? '（已更新）' : ''}`);
    lines.push(`逐 kind 一致：${m.mirrorOk ? '是' : `否（不一致：${m.mismatches.join(', ')}）`} · 镜像耗时 ${ms(m.elapsedMs)}`);
    if (Array.isArray(m.drift) && m.drift.length) {
      // T368：源库在镜像期间变了 —— 这一行比「不一致」准确得多
      lines.push(`⚠ 源库在镜像期间变化（影库对应的是开始时快照）：${m.drift.map((d) => `${d.kind} ${d.before}→${d.after}`).join(' · ')}`);
    }
  }
  if (out.verify) {
    const total = Object.values(out.verify.counts ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
    lines.push(`影库 verify：${out.verify.ok ? 'OK' : '失败'} · ${total} 条记录${out.verify.ok ? '' : ` · 错误 ${JSON.stringify(out.verify.errors).slice(0, 200)}`}`);
  }
  lines.push(`quality ${JSON.stringify(quality)} · ok ${out.report.ok}`);
  lines.push(`总耗时 ${ms(out.elapsedMs)}（合流 ${ms(out.consolidateMs)}）`);
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const res = runApply(argv);
  if (res.report?.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (res.error) {
    process.stderr.write(`${res.error}${res.code === 2 && !res.error.startsWith('consolidate-apply') ? `\n\n${USAGE}` : ''}\n`);
    return res.code;
  }
  process.stdout.write(`${formatReport(res.report)}\n`);
  if (res.code === 3) process.stderr.write(`有 ${res.report.report.apply.conflicts} 处冲突（既有真 claim 与合并节点 id 撞车，已跳过不覆盖）\n`);
  return res.code;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();

export { USAGE };
