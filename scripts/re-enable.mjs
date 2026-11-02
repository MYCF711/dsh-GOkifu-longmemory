#!/usr/bin/env node
// 重新启用 dsh-gokifu-longmemory（0.17.2+）。用法：
//   1) 完全退出 DSH（不是刷新页面）
//   2) node scripts/re-enable.mjs [--dry-run]
//   3) 重新打开 DSH
// 做的事：① 删掉 cordis.patch.yml 末尾的临时禁用块；② 把 link 依赖与 bundle 条目加回 profile；
//        ③ 跑一次 pnpm install；④ 打印结果。全部改动前先备份。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry-run');
const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const profile = path.join(home, 'profiles', 'desktop');
const pkgFile = path.join(profile, 'package.json');
const patchFile = path.join(profile, 'cordis.patch.yml');
const name = 'dsh-gokifu-longmemory';
const spec = `link:${REPO.split(String.fromCharCode(92)).join('/')}`;

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

if (!fs.existsSync(pkgFile)) die(`找不到 profile：${profile}`);

// ① cordis.patch.yml：删掉禁用块（从标记注释到两个 disabled 条目结束）
let patchChanged = false;
let patch = fs.readFileSync(patchFile, 'utf8');
const marker = patch.indexOf('# === 临时禁用：dsh-gokifu-longmemory');
if (marker >= 0) {
  const before = patch.slice(0, marker).replace(/\n+$/, '\n');
  patch = `${before}`;
  patchChanged = true;
  if (dry) log('[dry-run] 会删除 cordis.patch.yml 末尾的临时禁用块');
}

// ② package.json：补 link 依赖与 bundle 条目
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
let pkgChanged = false;
if (pkg.dependencies?.[name] !== spec) {
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: spec };
  pkgChanged = true;
}
const bundles = pkg.dsh?.profile?.bundles ?? [];
if (!bundles.includes(name)) {
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = { ...(pkg.dsh.profile ?? {}), bundles: [...bundles, name] };
  pkgChanged = true;
}

log(`profile: ${profile}`);
log(`依赖: ${spec}`);
log(`bundle: ${bundles.includes(name) ? '已有' : '将补'}`);
if (dry) {
  log(`[dry-run] patch 将改: ${patchChanged} · package.json 将改: ${pkgChanged}`);
  process.exit(0);
}

const stamp = Date.now();
fs.copyFileSync(pkgFile, `${pkgFile}.bak-reenable-${stamp}`);
fs.copyFileSync(patchFile, `${patchFile}.bak-reenable-${stamp}`);
if (patchChanged) fs.writeFileSync(patchFile, patch, 'utf8');
if (pkgChanged) fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
log(`已备份并写入（备份后缀 .bak-reenable-${stamp}）`);

const pnpm = spawnSync('pnpm', ['install', '--prefer-offline'], { cwd: profile, stdio: 'inherit', shell: process.platform === 'win32' });
if (pnpm.status !== 0) die('pnpm install 失败；用备份回滚后重试');
log('完成。重新打开 DSH，设置里应出现「长期记忆（棋院）」。');
