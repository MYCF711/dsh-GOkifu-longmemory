#!/usr/bin/env node
// 重新启用 dsh-gokifu-longmemory（0.42.0 起改为「精准摘除」）。用法：
//   1) 完全退出 DSH（不是刷新页面）
//   2) node scripts/re-enable.mjs [--dry-run]
//   3) 重新打开 DSH
// 做的事：① 从 cordis.patch.yml 里精准删掉本插件的「临时禁用」条目（保留其它条目与文件其余内容）；
//        ② 把 link 依赖与 bundle 条目补回 profile（已有则不重复）；
//        ③ 跑一次 pnpm install；④ 打印结果。所有写入前先备份。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = 'dsh-gokifu-longmemory';

/**
 * 精准摘除本插件的禁用条目；返回 { text, removed, disabledLeft }。
 * 处理形态：
 *   - id: <id>
 *     name: dsh-gokifu-longmemory
 *     disabled: true
 * 以及前面的说明注释行（`# === 临时禁用：...`）。其它条目原样保留。
 */
export function stripDisableBlock(text, pkgName = name) {
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const rawLines = String(text ?? '').split(LF).map((l) => l.split(CR).join(''));
  const isComment = (line) => line.trimStart().startsWith('#');
  const isEntryStart = (line) => line.trimStart().startsWith('- id:');
  const removedComments = [];
  const kept = [];
  for (const line of rawLines) {
    if (isComment(line) && line.includes(pkgName) && line.includes('临时禁用')) { removedComments.push(line); continue; }
    kept.push(line);
  }
  const out = [];
  let removedEntries = 0;
  let disabledLeft = 0;
  for (let i = 0; i < kept.length; i += 1) {
    const line = kept[i];
    if (!isEntryStart(line)) { out.push(line); continue; }
    let end = i + 1;
    while (end < kept.length && !isEntryStart(kept[end])) end += 1;
    const block = kept.slice(i, end);
    const body = block.join(LF);
    if (body.includes(pkgName)) {
      if (body.includes('disabled: true')) { removedEntries += 1; } else { disabledLeft += 1; out.push(...block); }
    } else {
      out.push(...block);
    }
    i = end - 1;
  }
  return { text: out.join(LF), removed: removedEntries + removedComments.length, disabledLeft };
}

const dry = process.argv.includes('--dry-run');
const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const profile = path.join(home, 'profiles', 'desktop');
const pkgFile = path.join(profile, 'package.json');
const patchFile = path.join(profile, 'cordis.patch.yml');
const spec = `link:${REPO.split(String.fromCharCode(92)).join('/')}`;

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

const invokedDirectly = process.argv[1] ? import.meta.url === new URL(`file://${path.resolve(process.argv[1]).split(String.fromCharCode(92)).join('/')}`).href : false;
if (invokedDirectly) {
  if (!fs.existsSync(pkgFile)) die(`找不到 profile：${profile}`);

  let patch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const stripped = stripDisableBlock(patch, name);
  patch = stripped.text;
  const patchChanged = stripped.removed > 0;

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
  log(`禁用条目: 摘除 ${stripped.removed} 条${stripped.disabledLeft ? ` · 仍启用 ${stripped.disabledLeft} 条（不带 disabled）` : ''}`);
  const noop = !patchChanged && !pkgChanged;
  if (dry) {
    log(`[dry-run] patch 将改: ${patchChanged} · package.json 将改: ${pkgChanged}`);
    process.exit(0);
  }
  // 2026-11-03：已是启用状态就别再写 patch/package.json（避免无谓改动与备份噪音）。
  if (noop) {
    log('已是启用状态，无需改动。直接重新打开 DSH，然后跑 node scripts/install-doctor.mjs 验收。');
    process.exit(0);
  }

  const stamp = Date.now();
  fs.copyFileSync(pkgFile, `${pkgFile}.bak-reenable-${stamp}`);
  if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, `${patchFile}.bak-reenable-${stamp}`);
  if (patchChanged) fs.writeFileSync(patchFile, patch, 'utf8');
  if (pkgChanged) fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`已备份并写入（备份后缀 .bak-reenable-${stamp}）`);

  const pnpm = spawnSync('pnpm', ['install', '--prefer-offline'], { cwd: profile, stdio: 'inherit', shell: process.platform === 'win32' });
  if (pnpm.status !== 0) die('pnpm install 失败；用备份回滚后重试');
  log('完成。重新打开 DSH，然后跑 node scripts/install-doctor.mjs 验收。');
}
