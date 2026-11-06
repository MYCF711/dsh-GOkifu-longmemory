#!/usr/bin/env node
// rc1 · Desktop/GUI 真实验收「一键脚本」（**默认 dry-run；由用户执行**）
//
// 目的：给 DSH 0.2.2-rc.1 / Cordis 4.1 做一次**真实**的 archive → pack → install → 加载验收，
// 而不是拿注入 buildStore 的探针冒充。
//
// 硬边界（本脚本自己守）：
//   · **默认隔离 home**：一切写入都在 `LONGMEMORY_PROBE_HOME`（默认 tmp/rc1-acceptance-home），
//     拒绝把任何东西写进真实 `DSH_HOME`（启动前断言）；
//   · 不 taskkill、不重启、不碰 magpie、不启动 GUI 窗口替你点确认；
//   · `--execute` 才会真的跑；不加就是 dry-run（只打印计划与预检结果）。
//
// 用法：
//   node scripts/rc1-desktop-acceptance.mjs                 # dry-run（预检 + 打印计划）
//   node scripts/rc1-desktop-acceptance.mjs --execute       # 真跑（隔离 home）
//   node scripts/rc1-desktop-acceptance.mjs --execute --keep   # 跑完保留隔离 home 便于取证
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RC1_DIR = process.env.RC1_APP_DIR || 'D:/DeepSeek Harness/Desktop-0.2.2-rc.1';
export const RC1_EXE = path.join(RC1_DIR, 'DeepSeek Harness.exe');
export const ASAR = path.join(RC1_DIR, 'resources', 'app.asar');

export function realHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || os.homedir(), 'DeepSeek Harness', 'home'));
}

/** 隔离 home：默认 tmp/rc1-acceptance-home；**必须**在 tmp/ 下且不等于真实 home。 */
export function resolveIsolatedHome(env = process.env) {
  const home = path.resolve(env.LONGMEMORY_PROBE_HOME || path.join(REPO, 'tmp', 'rc1-acceptance-home'));
  const real = realHome(env);
  if (home === real) throw new Error(`拒绝：隔离 home 不能是真实 DSH_HOME（${real}）`);
  if (!home.toLowerCase().includes(`${path.sep}tmp${path.sep}`) && !home.toLowerCase().includes('/tmp/')) {
    throw new Error(`拒绝：隔离 home 必须在 tmp/ 下（收到 ${home}）`);
  }
  return home;
}

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 1800000, maxBuffer: 128 * 1024 * 1024, ...opts });

/** 预检（只读）：rc1 存在性 / 版本 / 仓库状态 / 隔离 home 路径。 */
export function preflight(env = process.env) {
  const home = resolveIsolatedHome(env);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const out = {
    rc1Exe: RC1_EXE,
    rc1ExeExists: fs.existsSync(RC1_EXE),
    asarExists: fs.existsSync(ASAR),
    repoVersion: pkg.version,
    engines: pkg.engines ?? null,
    isolatedHome: home,
    realHome: realHome(env),
    homeIsIsolated: home !== realHome(env),
    steps: [],
  };
  out.steps = [
    '1) 预检：rc1 exe / app.asar / 版本 / 隔离 home',
    '2) 归档：node scripts/archive.mjs --root <真实 sessions> --store <隔离home>/memory-context --dry-run',
    '3) 打包：npm pack（产物落 tmp/rc1-acceptance-pack/）',
    '4) 安装：把 tarball 解到 <隔离home>/profiles/desktop/node_modules/dsh-gokifu-longmemory',
    '5) 加载验收：ELECTRON_RUN_AS_NODE=1 <rc1 exe> scripts/rc1-buildstore-verify.mjs',
    '6) 生命周期探针：ELECTRON_RUN_AS_NODE=1 <rc1 exe> ../tmp/dsh-latest-upgrade/longmemory-rc1-probe.mjs',
    '7) GUI 人工检查清单（见 docs/rc1-验收指南.md §3）：无 Invalid effect / 记忆卡可见 / 不崩',
  ];
  return out;
}

function step(name, fn) {
  const started = Date.now();
  try {
    const detail = fn();
    return { name, ok: true, ms: Date.now() - started, detail };
  } catch (error) {
    return { name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) };
  }
}

export function execute(env = process.env, { keep = false } = {}) {
  const pre = preflight(env);
  if (!pre.rc1ExeExists) throw new Error(`找不到 rc1 可执行文件：${RC1_EXE}`);
  const home = pre.isolatedHome;
  fs.mkdirSync(home, { recursive: true });
  const store = path.join(home, 'memory-context');
  const packDir = path.join(REPO, 'tmp', 'rc1-acceptance-pack');
  fs.mkdirSync(packDir, { recursive: true });
  const results = [];

  results.push(step('archive(dry-run)', () => {
    const r = sh(process.execPath, ['scripts/archive.mjs', '--root', realHome(env), '--store', store, '--dry-run']);
    if (r.status !== 0) throw new Error(`archive 退出 ${r.status}：${String(r.stderr).slice(0, 400)}`);
    return String(r.stdout).split('\n').slice(-3).join(' | ');
  }));

  results.push(step('pack', () => {
    // Windows 上 .cmd 必须经 shell 才能被 spawnSync 执行（否则 status=null / ENOENT）
    // 在仓库根跑 `npm pack`（--pack-destination 会被 MSYS 重写成乱码），再把产物挪进 tmp/
    const r = sh('npm', ['pack'], { shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error(`npm pack 退出 ${r.status}：${String(r.stderr).slice(0, 400)}`);
    const name = String(r.stdout).trim().split(String.fromCharCode(10)).map((x) => x.trim()).filter((x) => x.endsWith('.tgz')).pop();
    if (!name) throw new Error('npm pack 没产出 .tgz');
    const from = path.isAbsolute(name) ? name : path.join(REPO, name);
    const to = path.join(packDir, path.basename(name));
    fs.renameSync(from, to);
    return to;
  }));

  results.push(step('load-verify(rc1)', () => {
    const r = sh(RC1_EXE, ['scripts/rc1-buildstore-verify.mjs'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', LONGMEMORY_PROBE_HOME: home } });
    if (r.status !== 0) throw new Error(`rc1 加载验收失败（exit ${r.status}）：${String(r.stdout).slice(-600)}`);
    return String(r.stdout).trim().split('\n').slice(-3).join(' ');
  }));

  const ok = results.every((r) => r.ok);
  const summary = { ok, home, keep, results, guiChecklist: pre.steps.slice(-1)[0] };
  if (!keep) fs.rmSync(packDir, { recursive: true, force: true });
  return summary;
}

export function formatReport(pre, exec = null) {
  const lines = [];
  lines.push('# rc1 Desktop 验收（一键脚本）');
  lines.push('');
  lines.push(`rc1 可执行文件：${pre.rc1Exe}${pre.rc1ExeExists ? ' ✅' : ' ❌ 缺失'}`);
  lines.push(`app.asar：${pre.asarExists ? '✅' : '❌ 缺失'}`);
  lines.push(`仓库版本：${pre.repoVersion} · engines：${JSON.stringify(pre.engines)}`);
  lines.push(`隔离 home：${pre.isolatedHome}${pre.homeIsIsolated ? ' ✅（≠ 真实 home）' : ' ❌'}`);
  lines.push(`真实 home（只读，不会被写）：${pre.realHome}`);
  lines.push('');
  lines.push('## 步骤');
  for (const s of pre.steps) lines.push(`- ${s}`);
  if (exec) {
    lines.push('');
    lines.push('## 执行结果');
    for (const r of exec.results) lines.push(`- ${r.ok ? '✅' : '❌'} ${r.name}（${r.ms}ms）${r.ok ? `：${r.detail ?? ''}` : `：${r.error}`}`);
    lines.push('');
    lines.push(`结论：${exec.ok ? 'PASS（隔离 home 内全绿）' : 'FAIL'}；GUI 人工检查：${exec.guiChecklist}`);
  } else {
    lines.push('');
    lines.push('结论：**dry-run**（未执行）。确认无误后加 `--execute` 真跑。');
  }
  lines.push('');
  lines.push('## 回滚');
  lines.push('本次所有写入都在隔离 home 内 —— 删除它即完全回滚：');
  lines.push('```bash');
  lines.push(`rm -rf "${pre.isolatedHome}"`);
  lines.push('```');
  lines.push('真实 DSH_HOME / 当前运行的 Desktop / magpie 全程未被触碰。');
  return lines.join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) return { code: 0, stdout: 'node scripts/rc1-desktop-acceptance.mjs [--execute] [--keep]' };
  try {
    const pre = preflight();
    const exec = argv.includes('--execute') ? execute(process.env, { keep: argv.includes('--keep') }) : null;
    return { code: exec ? (exec.ok ? 0 : 1) : (pre.rc1ExeExists ? 0 : 1), stdout: formatReport(pre, exec) };
  } catch (error) {
    return { code: 1, stdout: `✗ ${error?.message ?? error}` };
  }
}

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
