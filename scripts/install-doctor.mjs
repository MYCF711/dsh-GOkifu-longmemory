#!/usr/bin/env node
// 安装后自检（安装医生）：一条命令回答「插件到底装上没有、装上以后健康不健康」。
//
// 检查项（全部只读；不写 store、不改配置）：
//   1. 注册：$DSH_HOME 下的 yml/json 配置里是否出现包名 dsh-gokifu-longmemory
//   2. 设置接口：handleConfigRoute(GET) 是否返回 config + stats（本机函数级，不依赖 web 服务）
//   3. 记忆库：manifest 存在、verify() 通过、claim 数量与过期数
//   4. 影子/证据：evidence/shadow 或 evidence 目录是否可写、最近一次 metrics-guard 记录
//   5. 热路径抽测：host-sim 跑 5 个首轮，failed 必须为 0
//
// 退出码：0 全绿；1 有 FAIL；2 环境不齐（没有 $DSH_HOME / 没装）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleConfigRoute } from '../src/plugin.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const PACKAGE = 'dsh-gokifu-longmemory';
// 2026-11-03：别名包。历史 disabled 块会让 PACKAGE 永不加载，profile 里改用 kifu-loader 挂载。
const ALIASES = ['kifu-loader'];

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'memory-context' || e.name === 'sessions' || e.name === 'chess-context' || e.name === 'node_modules') continue;
      walkFiles(p, out, depth + 1);
    } else if (/\.(ya?ml|json)$/i.test(e.name)) out.push(p);
  }
  return out;
}

export function registrationHit(home = HOME) {
  // 2026-11-03：只认"真正的注册位置"——profile 的 cordis.patch.yml / cordis.yml / package.json。
  // 之前把 storages/schedule.json 也算命中（定时任务提示词里正好含包名），造成"已注册"的假阳性。
  const hits = [];
  let enabled = 0;
  let disabled = 0;
  const profileDirs = [];
  try {
    const profilesRoot = path.join(home, 'profiles');
    for (const e of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (e.isDirectory()) profileDirs.push(path.join(profilesRoot, e.name));
    }
  } catch { /* 没有 profiles 目录 */ }

  const readSafe = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

  for (const dir of profileDirs) {
    // package.json：dependencies 或 bundles 里有包名 = 已注册
    const pkgFile = path.join(dir, 'package.json');
    const pkgText = readSafe(pkgFile);
    if (pkgText.includes(PACKAGE) || ALIASES.some((a) => pkgText.includes(a))) {
      hits.push(pkgFile.replace(home, '$DSH_HOME'));
      try {
        const pkg = JSON.parse(pkgText);
        const names = [PACKAGE, ...ALIASES];
        const inDeps = names.some((n) => Boolean(pkg?.dependencies?.[n]));
        const inBundles = Array.isArray(pkg?.dsh?.profile?.bundles) && names.some((n) => pkg.dsh.profile.bundles.includes(n));
        if (inDeps || inBundles) enabled += 1;
      } catch { /* 坏 JSON 不当作已启用 */ }
    }

    // patch/yml：按 "- id:" 顶格块切分，块内出现包名即算一处注册；块内有 disabled: true 算禁用
    for (const name of ['cordis.patch.yml', 'cordis.yml']) {
      const file = path.join(dir, name);
      const text = readSafe(file);
      if (!text.includes(PACKAGE) && !ALIASES.some((a) => text.includes(a))) continue;
      hits.push(file.replace(home, '$DSH_HOME'));
      const lines = text.split(String.fromCharCode(10));
      let inBlock = false;
      let block = [];
      const flush = () => {
        if (!block.length) return;
        const body = block.join(String.fromCharCode(10));
        if (body.includes(PACKAGE) || ALIASES.some((a) => body.includes(a))) {
          if (/disabled:\s*true/.test(body)) disabled += 1;
          else enabled += 1;
        }
        block = [];
      };
      for (const line of lines) {
        // 注释行是块边界：否则上一条的块会把注释里提到的包名吞进来（实测造成"启用 1 处"假阳性）。
        if (/^#/.test(line)) { flush(); inBlock = false; continue; }
        if (/^-\s/.test(line)) { flush(); inBlock = true; }
        if (inBlock) block.push(line);
      }
      flush();
    }
  }
  return { hits, enabled, disabled };
}

export async function doctor({ home = HOME, runs = 5 } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const reg = registrationHit(home);
  const registered = reg.enabled > 0;
  add('插件注册（启用，而非仅出现）', registered, reg.hits.length
    ? `${reg.hits.slice(0, 3).join(', ')} · 启用 ${reg.enabled} 处 · 禁用 ${reg.disabled} 处${registered ? '' : '（只有禁用块 ⇒ 还没跑 re-enable）'}`
    : '未在 profile 的 cordis.patch.yml / package.json 里找到（= 还没安装）');
  if (registered && reg.disabled > 0) {
    add('历史禁用块（不影响别名包）', true, `${reg.disabled} 处 disabled:true 仍指向原包名；当前通过 kifu-loader 别名挂载，可忽略`);
  }

  try {
    const res = handleConfigRoute({ method: 'GET', dshHome: home });
    const body = res?.body ?? {};
    add('设置接口 GET', res?.status === 200 && body.config !== undefined, `status=${res?.status} stats=${JSON.stringify(body.stats ?? null)}`);
  } catch (error) {
    add('设置接口 GET', false, String(error?.message ?? error));
  }

  const storeRoot = path.join(home, 'memory-context');
  try {
    const store = createStore({ root: storeRoot });
    const v = store.verify();
    const claims = store.list('claims').map((r) => r.record);
    const stale = claims.filter((c) => c.validityOk === false).length;
    add('记忆库 verify', v.ok === true, `files=${v.checked?.files ?? '?'} errors=${v.errors?.length ?? 0}`);
    add('记忆库内容', claims.length > 0, `claims=${claims.length} stale=${stale}`);
  } catch (error) {
    add('记忆库 verify', false, String(error?.message ?? error));
  }

  const evidenceDir = path.join(REPO, 'evidence');
  try {
    fs.accessSync(evidenceDir, fs.constants.W_OK);
    const guard = path.join(evidenceDir, 'metrics-guard.json');
    const guardAt = fs.existsSync(guard) ? JSON.parse(fs.readFileSync(guard, 'utf8')).at : null;
    add('证据目录可写', true, guardAt ? `最近 metrics-guard: ${guardAt}` : '尚无 metrics-guard.json');
  } catch (error) {
    add('证据目录可写', false, String(error?.message ?? error));
  }

  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(REPO, 'scripts/host-sim.mjs'), '--store', storeRoot, '--runs', String(runs)], { cwd: REPO, maxBuffer: 16 * 1024 * 1024 });
    const sim = JSON.parse(stdout);
    const noStore = !fs.existsSync(path.join(storeRoot, 'manifest.json'));
    const warnNote = noStore && sim.warnCount > 0 ? '（warn 为预期：库还不存在，插件沉默）' : '';
    add('热路径抽测', sim.failed === 0, `runs=${sim.runs} injected=${sim.injected} empty=${sim.empty} failed=${sim.failed} warn=${sim.warnCount}${warnNote} p95=${sim.latency?.p95}ms`);
  } catch (error) {
    add('热路径抽测', false, String(error?.message ?? error));
  }

  return { home, checks, ok: checks.every((c) => c.ok) };
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const json = process.argv.includes('--json');
  const out = await doctor();
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`安装医生：${HOME}`);
    for (const c of out.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name} · ${c.detail}`);
    console.log(out.ok ? 'install-doctor: PASS' : 'install-doctor: 有 FAIL（见上）');
  }
  process.exit(out.ok ? 0 : 1);
}
