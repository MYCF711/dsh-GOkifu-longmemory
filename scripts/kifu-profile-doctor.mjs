#!/usr/bin/env node
// T195 · 棋院插件在 profile 里的**只读体检**：配置说禁用、运行时却在注入，到底哪条在生效？
//
// 只读：不写任何文件、不改 profile、不重启宿主。
//
// 用法：node scripts/kifu-profile-doctor.mjs [--json] [--profile desktop]
//
// 输出：
//   1. 每个 profiles/*/cordis.patch.yml 里 id/name 含 kifu|gokifu 的条目（行号、disabled 值）
//   2. 重复 id / 同名条目互相矛盾（一条 enabled 一条 disabled）
//   3. 证据：profile bundles 列表、各包的 bundle patch 插了哪些 id、node_modules 是否 symlink、
//      tools-registered.json、心跳最后一行、宿主进程启动时间
//   4. 结论一句：**下次重启后记忆插件会不会加载**（能定就给判据；不能就写"无法确定 + 缺什么证据"）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 默认 DSH_HOME（与项目其它脚本同一口径）。 */
export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/**
 * 解析 cordis.patch.yml 的**顶层条目**（`- id:` 起始，列 0），收集其后的缩进键值。
 * 只做体检需要的浅解析：id / name / disabled（以及行号）。
 * @param {string} text
 * @returns {Array<{line:number,id:string|null,name:string|null,disabled:boolean|null,raw:string[]}>}
 */
export function parsePatchEntries(text) {
  const lines = String(text ?? '').split('\n');
  const entries = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^- /.test(line)) {
      if (current) entries.push(current);
      current = { line: i + 1, id: null, name: null, disabled: null, raw: [line] };
      const inline = /^-\s+id:\s*(.+)$/.exec(line);
      if (inline) current.id = inline[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (!current) continue;
    current.raw.push(line);
    const kv = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'id') current.id = String(value).trim().replace(/^['"]|['"]$/g, '');
    else if (key === 'name') current.name = String(value).trim().replace(/^['"]|['"]$/g, '');
    else if (key === 'disabled') current.disabled = String(value).trim() === 'true';
  }
  if (current) entries.push(current);
  return entries;
}

const KIFU_RE = /kifu|gokifu/i;

/**
 * 收集一份 YAML 里**所有** id（含 `- insert:` 下面缩进的 `- id:`）——
 * bundle patch 的条目长这样，用顶层解析会漏。
 * @param {string} text
 */
export function collectIds(text) {
  const ids = [];
  for (const line of String(text ?? '').split(String.fromCharCode(10))) {
    const m = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (m) ids.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  return ids;
}

/** 只留与棋院相关的条目。 */
export function findKifuEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((e) => KIFU_RE.test(String(e?.id ?? '')) || KIFU_RE.test(String(e?.name ?? '')));
}

/**
 * 一致性分析：重复 id、同名条目互相矛盾。
 * @param {Array} entries
 */
export function analyzeEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const kifu = findKifuEntries(list);
  const byId = new Map();
  for (const e of list) {
    if (!e?.id) continue;
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const duplicateIds = [...byId.entries()].filter(([, v]) => v.length > 1).map(([id, v]) => ({ id, lines: v.map((x) => x.line), entries: v }));
  const byName = new Map();
  for (const e of kifu) {
    if (!e?.name) continue;
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push(e);
  }
  const contradictions = [];
  for (const [name, v] of byName) {
    const disabled = v.filter((e) => e.disabled === true);
    const enabled = v.filter((e) => e.disabled !== true);
    if (disabled.length && enabled.length) contradictions.push({ name, enabled: enabled.map((e) => ({ line: e.line, id: e.id })), disabled: disabled.map((e) => ({ line: e.line, id: e.id })) });
  }
  return {
    total: list.length,
    kifu,
    duplicateIds,
    contradictions,
    enabled: kifu.filter((e) => e.disabled !== true),
    disabled: kifu.filter((e) => e.disabled === true),
  };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function tailJsonl(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch {
    return null;
  }
}

/** 宿主进程启动时间（只读，best-effort；拿不到就 null）。 */
export function processStartTime(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).StartTime.ToString('o')`], { encoding: 'utf8' });
    const iso = out.trim();
    return iso ? { iso, ms: Date.parse(iso) } : null;
  } catch {
    return null;
  }
}

/**
 * 体检一个 profile。
 * @param {{home?:string, profile?:string}} opts
 */
export function diagnose({ home = defaultHome(), profile = 'desktop' } = {}) {
  const profileDir = path.join(home, 'profiles', profile);
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const report = {
    home,
    profile,
    profileDir,
    patchPath,
    patchExists: fs.existsSync(patchPath),
    patchMtime: null,
    analysis: null,
    bundles: [],
    packages: [],
    loaders: [],
    tools: null,
    heartbeat: null,
    process: null,
    verdict: { loads: null, reason: '', missing: [] },
  };
  if (!report.patchExists) {
    report.verdict = { loads: null, reason: `找不到 profile patch：${patchPath}`, missing: ['cordis.patch.yml'] };
    return report;
  }
  report.patchMtime = new Date(fs.statSync(patchPath).mtimeMs).toISOString();
  const text = fs.readFileSync(patchPath, 'utf8');
  report.analysis = analyzeEntries(parsePatchEntries(text));

  // profile 的 bundles（决定哪些包自己的 bundle patch 会参与拼树）
  const pkg = readJsonSafe(path.join(profileDir, 'package.json'));
  report.bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];

  // 各 kifu 包：真实路径 + 自己的 bundle patch 插了哪些 id
  for (const name of ['dsh-gokifu-longmemory', 'kifu-loader']) {
    const dir = path.join(profileDir, 'node_modules', name);
    if (!fs.existsSync(dir)) continue;
    const entry = { name, dir, realPath: null, isSymlink: false, version: null, bundlePatchIds: [], bundlePatchPath: null, main: null, mainExists: null };
    try {
      entry.realPath = fs.realpathSync(dir);
      entry.isSymlink = fs.lstatSync(dir).isSymbolicLink();
    } catch { /* ignore */ }
    const p = readJsonSafe(path.join(dir, 'package.json'));
    entry.version = p?.version ?? null;
    entry.main = p?.main ?? null;
    if (entry.main) entry.mainExists = fs.existsSync(path.join(dir, entry.main));
    const patchRel = p?.dsh?.bundle?.patch;
    if (patchRel) {
      const bp = path.join(dir, patchRel);
      entry.bundlePatchPath = bp;
      if (fs.existsSync(bp)) entry.bundlePatchIds = collectIds(fs.readFileSync(bp, 'utf8'));
    }
    report.packages.push(entry);
  }
  // 哪些 id 来自"在 bundles 里"的包
  for (const entry of report.packages) {
    const inBundles = report.bundles.includes(entry.name);
    report.loaders.push({ name: entry.name, inBundles, ids: entry.bundlePatchIds, mainExists: entry.mainExists });
  }

  report.tools = readJsonSafe(path.join(home, 'memory-context', 'tools-registered.json'));
  report.heartbeat = tailJsonl(path.join(home, 'memory-context', 'live-stats.jsonl'));
  if (report.heartbeat?.pid) report.process = processStartTime(report.heartbeat.pid);

  // ── 结论 ───────────────────────────────────────────────────────────────
  const disabledIds = new Set(report.analysis.disabled.map((e) => e.id).filter(Boolean));
  const disabledNames = new Set(report.analysis.disabled.map((e) => e.name).filter(Boolean));
  const bundlesInPlay = report.loaders.filter((l) => l.inBundles);
  const loadedVia = bundlesInPlay.flatMap((l) => l.ids.map((id) => ({ id, via: l.name }))).filter((x) => !disabledIds.has(x.id));
  if (loadedVia.length > 0) {
    report.verdict = {
      loads: true,
      reason: `下次重启会加载：${loadedVia.map((x) => `id=${x.id}（来自 ${x.via} 的 bundle patch，且 profile bundles 里含 ${x.via}）`).join(' · ')}；`
        + `profile patch 里的 disabled 命中的是 ${[...disabledIds].join(' / ') || '(无)'}，不在这个 id 上 ⇒ 空靶`,
      missing: [],
    };
  } else if (bundlesInPlay.length === 0) {
    report.verdict = {
      loads: null,
      reason: '无法确定：既没有"在 bundles 里"的棋院包，也没找到别的加载路径',
      missing: ['profile package.json 的 dsh.profile.bundles 里没有任何 kifu 包', '启动日志里该插件的加载/跳过记录'],
    };
  } else {
    report.verdict = {
      loads: false,
      reason: `下次重启不会加载：${bundlesInPlay.map((l) => `${l.name} 的 bundle patch id 全被 disabled 命中`).join(' · ')}`,
      missing: [],
    };
  }
  return report;
}

export function formatReport(r) {
  const lines = [];
  lines.push(`棋院 profile 体检 · profile=${r.profile}`);
  lines.push(`patch：${r.patchPath}（mtime ${r.patchMtime ?? 'n/a'}）`);
  if (!r.analysis) {
    lines.push(`结论：无法确定 —— ${r.verdict.reason}`);
    return lines.join('\n');
  }
  const a = r.analysis;
  lines.push('');
  lines.push(`条目：共 ${a.total} 条；棋院相关 ${a.kifu.length} 条（enabled ${a.enabled.length} / disabled ${a.disabled.length}）`);
  for (const e of a.kifu) {
    lines.push(`  L${e.line}  id=${e.id ?? '(无)'}  name=${e.name ?? '(无)'}  disabled=${e.disabled === null ? '(未写)' : e.disabled}`);
  }
  lines.push(`重复 id：${a.duplicateIds.length ? a.duplicateIds.map((d) => `${d.id}（行 ${d.lines.join(',')}）`).join(' · ') : '无'}`);
  lines.push(`同名矛盾：${a.contradictions.length ? a.contradictions.map((c) => `${c.name}（enabled 行 ${c.enabled.map((x) => x.line).join(',')} / disabled 行 ${c.disabled.map((x) => x.line).join(',')}）`).join(' · ') : '无'}`);
  lines.push('');
  lines.push(`profile bundles 含棋院包：${r.bundles.filter((b) => KIFU_RE.test(b)).join(' · ') || '（无）'}`);
  for (const l of r.loaders) {
    lines.push(`  ${l.name}：${l.inBundles ? '在 bundles 里' : '不在 bundles'} · bundle patch 插入 id=${l.ids.join(',') || '(无)'} · 入口存在=${l.mainExists}`);
  }
  lines.push(`运行时：tools-registered via=${r.tools?.via ?? 'n/a'} count=${r.tools?.count ?? 'n/a'} · 心跳 pid=${r.heartbeat?.pid ?? 'n/a'} at=${r.heartbeat?.at ? new Date(r.heartbeat.at).toISOString() : 'n/a'} action=${r.heartbeat?.action ?? 'n/a'}`);
  lines.push(`宿主启动：${r.process?.iso ?? 'n/a'}${r.process?.ms && r.patchMtime ? `（patch 之后启动？${r.process.ms > Date.parse(r.patchMtime) ? '是' : '否'}）` : ''}`);
  lines.push('');
  lines.push(`结论：${r.verdict.loads === true ? '会加载' : r.verdict.loads === false ? '不会加载' : '无法确定'} —— ${r.verdict.reason}`);
  return lines.join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const pi = argv.indexOf('--profile');
  const profile = pi >= 0 ? argv[pi + 1] : 'desktop';
  const report = diagnose({ profile });
  return { code: 0, stdout: json ? JSON.stringify(report, null, 2) : formatReport(report) };
}

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();
