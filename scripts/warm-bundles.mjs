#!/usr/bin/env node
// T63（2026-11-09）· 预热 bundle：把「下一次查记忆要等 6 秒」挪到**归档之后**去做。
//
// 背景（T62）：`store.list()` 逐文件读很贵（真库 links 11083 个文件 3.4–5.1 秒），所以我们把每类记录
// 缓存成 `<root>/.cache/<kind>.bundle.json`。**库一变更，bundle 就失效** —— 于是"归档完的第一次查询"
// 还是要付一次冷路径。这个脚本就是给归档管线在**写完库之后**调一次，把冷路径搬到后台。
//
// 用法：
//   node scripts/warm-bundles.mjs                 # 预热默认库（$DSH_HOME/memory-context）
//   node scripts/warm-bundles.mjs --home <dir>    # 指定 DSH_HOME
//   node scripts/warm-bundles.mjs --root <dir>    # 直接指定 sidecar 根
//
// 退出码：0 = 全部 kind 已就绪（或本来就没有 manifest ⇒ 无需预热）；1 = 有 kind 失败。
// 只读库、只写 `.cache/`（纯派生，删掉即回到慢路径）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import { WALK_BUNDLE_KINDS, kindBundleStamp, readKindBundle } from '../src/rooms/walkbundle.mjs';

export function warmBundles({ root, log = () => {} }) {
  const out = {};
  if (!root || !fs.existsSync(path.join(root, 'manifest.json'))) {
    return { ok: true, skipped: 'no-manifest', kinds: out };
  }
  const store = createStore({ root, bundle: true });
  let ok = true;
  for (const kind of WALK_BUNDLE_KINDS) {
    const before = readKindBundle(root, kind);
    if (before) { out[kind] = { status: 'fresh', ms: 0, n: before.length }; log(`${kind}: 已新鲜，跳过`); continue; }
    const t0 = Date.now();
    try {
      const n = store.list(kind).length; // 慢路径 + 顺手写 bundle
      const ms = Date.now() - t0;
      const stamp = kindBundleStamp(root, kind);
      const written = Boolean(stamp) && Boolean(readKindBundle(root, kind));
      out[kind] = { status: written ? 'built' : 'not-written', ms, n };
      if (!written) ok = false;
      log(`${kind}: ${n} 条 · ${ms}ms · ${written ? '已写 bundle' : '没写成'}`);
    } catch (error) {
      ok = false;
      out[kind] = { status: 'error', ms: Date.now() - t0, error: String(error?.message ?? error) };
      log(`${kind}: 失败 ${String(error?.message ?? error)}`);
    }
  }
  return { ok, kinds: out };
}

function parseArgs(argv) {
  const out = { home: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') out.home = argv[++i];
    else if (argv[i] === '--root') out.root = argv[++i];
  }
  return out;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('warm-bundles.mjs');
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? path.join(args.home, 'memory-context');
  console.log(`warm-bundles · ${root}`);
  const r = warmBundles({ root, log: (line) => console.log(`  ${line}`) });
  if (r.skipped) console.log(`  跳过：${r.skipped}`);
  console.log(r.ok ? 'warm-bundles: PASS' : 'warm-bundles: FAIL');
  process.exitCode = r.ok ? 0 : 1;
}
