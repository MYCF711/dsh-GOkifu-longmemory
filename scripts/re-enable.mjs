#!/usr/bin/env node
// 重新启用 dsh-gokifu-longmemory（安全版，2026-11-03）。
// 目标：即使失败，也绝不让 DSH 起不来：运行中拒绝、先备份、原子写、写后校验、失败回滚。
// 用法：node scripts/re-enable.mjs [--dry-run] [--force]（--force 仅测试用）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = 'dsh-gokifu-longmemory';
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

export function stripDisableBlock(text, pkgName = name) {
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
  return { text: out.join(LF), removed: removedEntries + removedComments.length, removedEntries, removedComments: removedComments.length, disabledLeft };
}

export function dshRunning() {
  try {
    const out = execFileSync('tasklist', [], { encoding: 'utf8', windowsHide: true });
    return out.includes('DeepSeek Harness.exe');
  } catch {
    return true;
  }
}

export function validatePatch(before, after, expectedRemoved, pkgName = name) {
  const errors = [];
  const countEntries = (t) => String(t).split(LF).filter((l) => l.trimStart().startsWith('- id:')).length;
  const beforeCount = countEntries(before);
  const afterCount = countEntries(after);
  if (afterCount !== beforeCount - expectedRemoved) {
    errors.push('块数不对：before=' + beforeCount + ' removed=' + expectedRemoved + ' after=' + afterCount);
  }
  const lines = String(after).split(LF);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trimStart().startsWith('- id:')) continue;
    let end = i + 1;
    while (end < lines.length && !lines[end].trimStart().startsWith('- id:')) end += 1;
    const body = lines.slice(i, end).join(LF);
    if (body.includes(pkgName) && body.includes('disabled: true')) errors.push('仍有禁用块（第 ' + (i + 1) + ' 行起）');
    i = end - 1;
  }
  if (after.length > 0 && !after.endsWith(LF)) errors.push('文件结尾没有换行');
  return errors;
}

function writeAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(file);
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw error;
    }
  }
}

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const force = args.includes('--force');
const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const profile = path.join(home, 'profiles', 'desktop');
const pkgFile = path.join(profile, 'package.json');
const patchFile = path.join(profile, 'cordis.patch.yml');
const spec = 'link:' + REPO.split(String.fromCharCode(92)).join('/');
const log = (...a) => console.log(...a);
const die = (m, code = 1) => { console.error(m); process.exit(code); };

const invokedDirectly = process.argv[1]
  ? import.meta.url === new URL('file://' + path.resolve(process.argv[1]).split(String.fromCharCode(92)).join('/')).href
  : false;

if (invokedDirectly) {
  if (!fs.existsSync(pkgFile)) die('找不到 profile：' + profile);

  if (!force && dshRunning()) {
    log('DSH 正在运行 —— 已拒绝执行，未修改任何文件。');
    log('请先完全退出 DSH（不是刷新页面），再双击「开启长期记忆.cmd」。');
    process.exit(2);
  }

  const beforePatch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  let beforePkg;
  try { beforePkg = fs.readFileSync(pkgFile, 'utf8'); } catch (error) { die('读不到 package.json：' + error.message); }
  let pkg;
  try { pkg = JSON.parse(beforePkg); } catch (error) { die('package.json 不是合法 JSON，已中止（未写入）：' + error.message); }

  const stripped = stripDisableBlock(beforePatch, name);
  const afterPatch = stripped.text;
  const patchChanged = stripped.removed > 0;
  const patchErrors = patchChanged ? validatePatch(beforePatch, afterPatch, stripped.removedEntries, name) : [];
  if (patchErrors.length) die('patch 结构校验失败，已中止（未写入）：' + patchErrors.join('；'));

  const nextPkg = JSON.parse(beforePkg);
  let pkgChanged = false;
  if (!nextPkg.dependencies || nextPkg.dependencies[name] !== spec) {
    nextPkg.dependencies = { ...(nextPkg.dependencies || {}), [name]: spec };
    pkgChanged = true;
  }
  const bundles = (nextPkg.dsh && nextPkg.dsh.profile && nextPkg.dsh.profile.bundles) || [];
  if (!bundles.includes(name)) {
    nextPkg.dsh = nextPkg.dsh || {};
    nextPkg.dsh.profile = { ...(nextPkg.dsh.profile || {}), bundles: [...bundles, name] };
    pkgChanged = true;
  }
  const afterPkg = JSON.stringify(nextPkg, null, 2) + LF;

  log('profile: ' + profile);
  log('依赖: ' + spec);
  log('bundle: ' + (bundles.includes(name) ? '已有' : '将补'));
  log('禁用条目: 摘除 ' + stripped.removed + ' 条' + (stripped.disabledLeft ? ' · 仍启用 ' + stripped.disabledLeft + ' 条（不带 disabled）' : ''));
  const noop = !patchChanged && !pkgChanged;
  if (dry) {
    log('[dry-run] patch 将改: ' + patchChanged + ' · package.json 将改: ' + pkgChanged);
    process.exit(0);
  }
  if (noop) {
    log('已是启用状态，无需改动。直接重新打开 DSH，然后跑 node scripts/install-doctor.mjs 验收。');
    process.exit(0);
  }

  const stamp = Date.now();
  const pkgBak = pkgFile + '.bak-reenable-' + stamp;
  const patchBak = fs.existsSync(patchFile) ? patchFile + '.bak-reenable-' + stamp : null;
  fs.copyFileSync(pkgFile, pkgBak);
  if (patchBak) fs.copyFileSync(patchFile, patchBak);
  log('已备份：' + path.basename(pkgBak) + (patchBak ? ' / ' + path.basename(patchBak) : ''));

  const rollback = (reason) => {
    try { fs.copyFileSync(pkgBak, pkgFile); } catch { /* ignore */ }
    if (patchBak) { try { fs.copyFileSync(patchBak, patchFile); } catch { /* ignore */ } }
    console.error(reason);
    console.error('已回滚到备份 —— DSH 配置与执行前一致，重新打开 DSH 不受影响。');
    process.exit(1);
  };

  try {
    if (patchChanged) writeAtomic(patchFile, afterPatch);
    if (pkgChanged) writeAtomic(pkgFile, afterPkg);
  } catch (error) {
    rollback('写入失败：' + String((error && error.message) || error));
  }

  try {
    const diskPatch = fs.readFileSync(patchFile, 'utf8');
    const diskPkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const errs = [];
    if (patchChanged && /dsh-gokifu-longmemory[\s\S]{0,120}disabled:\s*true/.test(diskPatch)) errs.push('磁盘上仍有禁用块');
    if (pkgChanged && (!diskPkg.dependencies || diskPkg.dependencies[name] !== spec)) errs.push('磁盘上依赖没写进去');
    if (errs.length) rollback('写后校验失败：' + errs.join('；'));
  } catch (error) {
    rollback('写后读回失败：' + String((error && error.message) || error));
  }

  if (pkgChanged || !fs.existsSync(path.join(profile, 'node_modules'))) {
    const pnpm = spawnSync('pnpm', ['install', '--prefer-offline'], { cwd: profile, stdio: 'inherit', shell: process.platform === 'win32' });
    if (pnpm.status !== 0) rollback('pnpm install 失败');
  } else {
    log('依赖已就绪，跳过 pnpm install');
  }

  log('完成。可以重新打开 DSH；随后运行 node scripts/install-doctor.mjs 验收。');
}
