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
  const hits = [];
  let disabled = 0;
  for (const file of walkFiles(home)) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.includes(PACKAGE)) continue;
    hits.push(file.replace(home, '$DSH_HOME'));
    const lines = text.split(String.fromCharCode(10));
    lines.forEach((line, i) => {
      if (!line.includes(PACKAGE)) return;
      const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join(String.fromCharCode(10));
      if (/disabled:\s*true/.test(window)) disabled += 1;
    });
  }
  return { hits, disabled };
}

export async function doctor({ home = HOME, runs = 5 } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const reg = registrationHit(home);
  add('插件注册（配置里出现包名）', reg.hits.length > 0, reg.hits.length
    ? `${reg.hits.slice(0, 3).join(', ')}${reg.disabled > 0 ? ` · 其中 ${reg.disabled} 条 disabled:true（等 re-enable）` : ' · 未见 disabled'}`
    : '未在 $DSH_HOME 的 yml/json 里找到（= 还没安装）');

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
    add('热路径抽测', sim.failed === 0, `runs=${sim.runs} injected=${sim.injected} empty=${sim.empty} failed=${sim.failed} warn=${sim.warnCount} p95=${sim.latency?.p95}ms`);
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
