#!/usr/bin/env node
// T161 · 合流写路径 CLI（S3）：**源库只读 → 影子库**
//
// 用法：
//   node scripts/consolidate-apply.mjs --store <src> [--scope <s>] [--out <dst>] [--dry-run]
//
// 语义：
//   · 不带 `--out`（或显式 `--dry-run`）⇒ 只读预览，不写盘（默认 dry-run）。
//   · 带 `--out <dst>` ⇒ 把源库 claim 层复制到 dst（不存在则初始化），再追加合并节点；
//     **源库一个字节都不动**，`--out` 等于/位于源库内会直接报错。
//
// 幂等：同一 dst 连跑两次，第二次 `merged added 0`（合并节点 id 由成员决定、内容由成员派生）。
//
// 退出码：0 成功；2 参数/库不存在；3 合流冲突（不覆盖既有真 claim）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { consolidate, ConsolidateError } from '../src/rooms/consolidate.mjs';

const USAGE = `用法：node scripts/consolidate-apply.mjs --store <src> [--scope <s>] [--out <dst>] [--dry-run]

  --store <src>   源库目录（只读；如 <DSH_HOME>/memory-context）
  --out <dst>     影子库目录（给了才落盘；不存在则初始化）
  --scope <s>     只合某个 scopeKey（默认全库）
  --dry-run       强制只读预览（即使给了 --out 也不写）`;

function parseArgs(argv) {
  const out = { store: null, outDir: null, scope: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--dry-run') out.dryRun = true;
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

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n\n${USAGE}\n`);
    return 2;
  }
  if (!args.store) {
    process.stderr.write(`缺少 --store\n\n${USAGE}\n`);
    return 2;
  }
  const storeRoot = path.resolve(args.store);
  if (!fs.existsSync(storeRoot)) {
    process.stderr.write(`源库不存在：${storeRoot}\n`);
    return 2;
  }
  // 有 --out 才写；--dry-run 强制预览
  const dryRun = args.dryRun || !args.outDir;
  const outDir = args.outDir ? path.resolve(args.outDir) : null;

  const store = createStore({ root: storeRoot });
  let report;
  try {
    report = consolidate({ store, scope: args.scope, dryRun, outStoreDir: outDir });
  } catch (error) {
    if (error instanceof ConsolidateError) {
      process.stderr.write(`consolidate-apply: ${error.code}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const { stats, quality, apply } = report;
  process.stdout.write(`store=${storeRoot}\n`);
  if (args.scope) process.stdout.write(`scope=${args.scope}\n`);
  process.stdout.write(`mode=${dryRun ? 'dry-run（未写盘）' : `apply → ${outDir}`}\n`);
  process.stdout.write(`groups ${stats.groups} · tier0 ${stats.byTier[0]} · tier1 ${stats.byTier[1]} · merged ${stats.merged} · reduction ${pct(stats.reduction)}\n`);
  if (apply) {
    process.stdout.write(
      `apply: copied ${apply.claimsCopied}（changed ${apply.claimsCopiedChanged}）· merged added ${apply.mergedAdded} · rewritten ${apply.mergedRewritten} · conflicts ${apply.conflicts} · total claims ${apply.totalClaims}\n`,
    );
  }
  process.stdout.write(`quality ${JSON.stringify(quality)} · ok ${report.ok}\n`);
  if (apply && apply.conflicts > 0) {
    process.stderr.write(`有 ${apply.conflicts} 处冲突（既有真 claim 与合并节点 id 撞车，已跳过不覆盖）\n`);
    return 3;
  }
  return 0;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();

export { main, parseArgs };
