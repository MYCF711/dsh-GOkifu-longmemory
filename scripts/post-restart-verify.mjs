#!/usr/bin/env node
// T42 · 重启验证一键脚本：把 `docs/重启验证清单.md` 变成**可跑的机械判据**。
//
// 用法：
//   node scripts/post-restart-verify.mjs                 # 人类可读
//   node scripts/post-restart-verify.mjs --json          # 机器可读（含逐项 status/evidence）
//   node scripts/post-restart-verify.mjs --store <dir>   # 记忆库根（默认 <DSH_HOME>/memory-context）
//   node scripts/post-restart-verify.mjs --timeout-ms N  # 子命令超时（默认 600000）
//
// 退出码（任务书 T42 口径）：
//   0 = 没有 FAIL（全部 PASS，或 PASS + NO-SAMPLE）
//   1 = 至少一项 FAIL
//   2 = **全部** NO-SAMPLE（一个样本都没有，什么都判不了）
//
// 七项判据（全部机械，不编造；样本不足一律 NO-SAMPLE，不许硬算过）：
//   ① 新代码已加载：instance-status 的包版本 ≥ 本仓 package.json，**且** 当前宿主 pid 的首条心跳
//      晚于「最新发版时点」（package.json / CHANGELOG.md 的 mtime 取最大）。
//      —— 只看版本号不够：宿主没重启时，包版本永远是新的（软链直读源码），但跑的还是旧进程。
//   ② T12：当前宿主 pid 的 `abstain` 行里，reason **不再全塌 `cross-scope`**（出现任何非 cross-scope 即过）。
//   ③ T10：当前 pid 最近 30 条 `card-samples` 里 `signalPreview` 长度 >160 的比例 **> 30%**。
//   ④ T25：当前 pid 的 `(scope,digest)` 注入重复率 **低于 T24 基线 36.23%**（T24 §二：471/1300）。
//      注：live-stats 没有 session id，这条是**scope 级**代理口径（T25 修的是会话级，跨会话合法重复仍在）。
//   ⑤ T28/T31：`inject --shadow` 的卡上出现 ` · 恢复` 尾注（T37 会在「恢复」后插 `（class:…）`，所以不写死冒号）。
//   ⑥ T16/T18/T20：`src/plugin.mjs` 里三个 cap 常量都 = 64MB。
//   ⑦ T27：`metrics-guard.mjs` 输出含 `A1 三轴`。
//
// 只读：不写记忆库、不改代码；唯一副作用是 ⑤ 的 `inject --shadow` 会追加 evidence/shadow/shadow.jsonl（T42 清单要求）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const DEFAULT_STORE = path.join(HOME, 'memory-context');

/** T24 §二 的 scope 级重复率基线（多余注入 471 / 总注入 1300）。 */
export const T24_SCOPE_DUP_BASELINE = 471 / 1300;

/** T16/T18/T20 的上限常量必须都是这个值。 */
export const EXPECTED_CAP_BYTES = 64 * 1024 * 1024;
const CAP_CONSTANTS = ['CARD_SAMPLE_CAP_BYTES', 'LIVE_STATS_CAP_BYTES', 'MESSAGE_CORPUS_CAP_BYTES'];

/** T10 判据：最近 N 条卡样本里 signalPreview > 160 字符的比例门槛。 */
export const SIGNAL_RECENT_N = 30;
export const SIGNAL_GT160_RATIO = 0.30;
/** 样本太少时判不了：卡样本 < 5 条、注入行 < 20 条 ⇒ NO-SAMPLE。 */
export const MIN_SIGNAL_SAMPLES = 5;
export const MIN_INJECT_ROWS = 20;

const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', NO_SAMPLE: 'NO-SAMPLE' });
const item = (id, title, status, evidence) => ({ id, title, status, evidence });

// ---------------------------------------------------------------------------
// 纯函数（可单测；不碰文件系统）
// ---------------------------------------------------------------------------

/** 版本号比较：只比数字段（`0.8.76` vs `0.8.65`）；非数字后缀忽略。 */
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '').split('-')[0].split('.').map((x) => Number.parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 解析 `scripts/instance-status.mjs` 的文本输出。 */
export function parseInstanceStatus(text) {
  const raw = String(text ?? '');
  const ver = /^(OK|FAIL)\s+包版本\s+\S+?@(\S+)\s*$/m.exec(raw);
  const link = /^(OK|FAIL)\s+软链\s+(.*)$/m.exec(raw);
  return {
    version: ver ? ver[2] : null,
    versionOk: ver ? ver[1] === 'OK' : false,
    linkOk: link ? link[1] === 'OK' : false,
    linkDetail: link ? link[2].trim() : null,
  };
}

/**
 * ① 新代码已加载。
 * @param {{instanceText?:string, localVersion?:string, hostFirstAt?:number|null, releaseAt?:number|null}} input
 */
export function judgeNewCode({ instanceText = '', localVersion = '', hostFirstAt = null, releaseAt = null } = {}) {
  const parsed = parseInstanceStatus(instanceText);
  if (!Number.isFinite(hostFirstAt)) {
    return item('new-code', '新代码已加载（instance-status + 宿主启动时间）', STATUS.NO_SAMPLE,
      `没有宿主心跳（live-stats 无 src=index.js 行）⇒ 无法确认在跑哪份代码；instance-status: ${parsed.versionOk ? `包版本 ${parsed.version} ok` : '未读到 OK 的包版本'}`);
  }
  const verOk = parsed.versionOk && compareVersions(parsed.version, localVersion) >= 0;
  const fresh = Number.isFinite(releaseAt) && hostFirstAt > releaseAt;
  const fmt = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'n/a');
  const evidence = `包版本 ${parsed.version ?? '?'} ${verOk ? '≥' : '<'} ${localVersion}；软链 ${parsed.linkOk ? 'OK' : 'FAIL'}；宿主首心跳 ${fmt(hostFirstAt)} ${fresh ? '晚于' : '早于'} 发版 ${fmt(releaseAt)} ⇒ ${fresh ? '已重启' : '仍是旧进程（需要重启宿主）'}`;
  if (verOk && parsed.linkOk && fresh) return item('new-code', '新代码已加载（instance-status + 宿主启动时间）', STATUS.PASS, evidence);
  return item('new-code', '新代码已加载（instance-status + 宿主启动时间）', STATUS.FAIL, evidence);
}

/**
 * ② T12：abstain 的 reason 不再全塌 cross-scope。
 * @param {object[]} abstainRows 当前宿主 pid 的 abstain 行
 */
export function judgeAbstainReasons(abstainRows = []) {
  const rows = Array.isArray(abstainRows) ? abstainRows : [];
  if (!rows.length) {
    return item('t12-abstain', 'T12：abstain 的 reason 不再全塌 cross-scope', STATUS.NO_SAMPLE,
      '当前宿主 pid 没有 abstain 记录（没样本 ⇒ 判不了）');
  }
  const dist = {};
  for (const r of rows) dist[r?.reason ?? '(none)'] = (dist[r?.reason ?? '(none)'] ?? 0) + 1;
  const keys = Object.keys(dist);
  const evidence = `n=${rows.length} · reason ${keys.map((k) => `${k}=${dist[k]}`).join(' · ')}`;
  const allCross = keys.length === 1 && keys[0] === 'cross-scope';
  return item('t12-abstain', 'T12：abstain 的 reason 不再全塌 cross-scope',
    allCross ? STATUS.FAIL : STATUS.PASS,
    `${evidence}${allCross ? ' ⇒ 仍全塌 cross-scope（T12 未生效）' : ' ⇒ 出现非 cross-scope 原因'}`);
}

/**
 * ③ T10：最近 N 条卡样本的 signalPreview 完整度。
 * @param {object[]} sampleRows 当前宿主 pid 的 card-samples 行（时间序）
 */
export function judgeSignalPreview(sampleRows = []) {
  const rows = Array.isArray(sampleRows) ? sampleRows : [];
  const take = rows.slice(-SIGNAL_RECENT_N);
  if (take.length < MIN_SIGNAL_SAMPLES) {
    return item('t10-signal', 'T10：card-samples 的 signalPreview 完整度', STATUS.NO_SAMPLE,
      `当前宿主 pid 只有 ${take.length} 条卡样本（<${MIN_SIGNAL_SAMPLES}）⇒ 样本不足`);
  }
  const lens = take.map((r) => String(r?.signalPreview ?? '').length);
  const gt = lens.filter((n) => n > 160).length;
  const ratio = gt / lens.length;
  const evidence = `最近 ${lens.length} 条：>160 字符 ${gt} 条（${(ratio * 100).toFixed(1)}%，门槛 >${(SIGNAL_GT160_RATIO * 100).toFixed(0)}%）· 中位长度 ${lens.slice().sort((a, b) => a - b)[Math.floor(lens.length / 2)]}`;
  return item('t10-signal', 'T10：card-samples 的 signalPreview 完整度',
    ratio > SIGNAL_GT160_RATIO ? STATUS.PASS : STATUS.FAIL,
    `${evidence}${ratio > SIGNAL_GT160_RATIO ? '' : ' ⇒ 仍以 160 字截断为主（T10 未生效）'}`);
}

/**
 * ④ T25：scope 级重复注入率 vs T24 基线。
 * @param {object[]} injectRows 当前宿主 pid 的 inject 行
 */
export function judgeDuplicateInjections(injectRows = []) {
  const rows = (Array.isArray(injectRows) ? injectRows : []).filter((r) => typeof r?.digest === 'string' && r.digest);
  if (rows.length < MIN_INJECT_ROWS) {
    return item('t25-dup', 'T25：同 scope 同 digest 重复注入（对照 T24 基线）', STATUS.NO_SAMPLE,
      `当前宿主 pid 只有 ${rows.length} 条注入（<${MIN_INJECT_ROWS}）⇒ 样本不足`);
  }
  const groups = new Set(rows.map((r) => `${r.scope ?? ''}\u0000${r.digest}`));
  const extra = rows.length - groups.size;
  const rate = extra / rows.length;
  const base = T24_SCOPE_DUP_BASELINE;
  const evidence = `n=${rows.length} · 不同 (scope,digest)=${groups.size} · 多余注入=${extra} · 重复率 ${(rate * 100).toFixed(1)}% vs T24 基线 ${(base * 100).toFixed(1)}%`;
  return item('t25-dup', 'T25：同 scope 同 digest 重复注入（对照 T24 基线）',
    rate < base ? STATUS.PASS : STATUS.FAIL,
    `${evidence}${rate < base ? ' ⇒ 低于基线' : ' ⇒ 未低于基线（oncePerSession 可能仍未生效）'}`);
}

/** ⑤ T28/T31：卡上是否有「 · 恢复」尾注。 */
export function judgeRecoveryTail(text = '', { exitCode = 0, stderr = '' } = {}) {
  const raw = String(text ?? '');
  if (exitCode !== 0) {
    return item('t28-recovery', 'T28/T31：卡上出现「 · 恢复」尾注', STATUS.FAIL,
      `inject --shadow 退出码 ${exitCode}${stderr ? ` · ${String(stderr).split('\n')[0].slice(0, 160)}` : ''}`);
  }
  if (/ · 恢复/u.test(raw)) {
    const line = raw.split('\n').find((l) => / · 恢复/u.test(l)) ?? '';
    return item('t28-recovery', 'T28/T31：卡上出现「 · 恢复」尾注', STATUS.PASS,
      `命中尾注：${line.trim().slice(0, 200)}`);
  }
  return item('t28-recovery', 'T28/T31：卡上出现「 · 恢复」尾注', STATUS.NO_SAMPLE,
    '本次信号没有命中带恢复事实的 claim（卡上没有 · 恢复 尾注 —— 没样本，不能判过）');
}

/** ⑥ T16/T18/T20：三个 cap 常量都 = 64MB。 */
export function judgeCapConstants(sourceText = '') {
  const src = String(sourceText ?? '');
  const found = [];
  for (const name of CAP_CONSTANTS) {
    const m = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([^;]+);`).exec(src);
    let value = null;
    if (m) {
      const expr = m[1].replace(/\s+/g, ' ');
      const mm = /^(\d+)\s*\*\s*1024\s*\*\s*1024$/.exec(expr);
      if (mm) value = Number(mm[1]) * 1024 * 1024;
      else if (/^\d+$/.test(expr)) value = Number(expr);
    }
    found.push({ name, value });
  }
  const bad = found.filter((f) => f.value !== EXPECTED_CAP_BYTES);
  const evidence = found.map((f) => `${f.name}=${f.value === null ? 'missing' : `${(f.value / 1024 / 1024).toFixed(0)}MB`}`).join(' · ');
  return item('caps-64mb', 'T16/T18/T20：三个 sidecar 上限常量 = 64MB',
    bad.length ? STATUS.FAIL : STATUS.PASS,
    `${evidence}${bad.length ? ` ⇒ ${bad.map((f) => f.name).join(' / ')} 不是 64MB` : ' ⇒ 三个都是 64MB'}`);
}

/** ⑦ T27：metrics-guard 输出含「A1 三轴」。 */
export function judgeA1ThreeAxes(text = '', { exitCode = null } = {}) {
  const raw = String(text ?? '');
  if (/A1 三轴/u.test(raw)) {
    const line = raw.split('\n').find((l) => /A1 三轴/u.test(l)) ?? '';
    return item('t27-a1', 'T27：metrics-guard 输出含「A1 三轴」', STATUS.PASS,
      `命中：${line.trim().slice(0, 200)}${Number.isFinite(exitCode) ? `（guard exit=${exitCode}，与本项无关）` : ''}`);
  }
  return item('t27-a1', 'T27：metrics-guard 输出含「A1 三轴」', STATUS.FAIL,
    `输出里没有「A1 三轴」${Number.isFinite(exitCode) ? `（exit=${exitCode}）` : ''}`);
}

/** 汇总：任何 FAIL ⇒ 1；全 NO-SAMPLE ⇒ 2；否则 0。 */
export function summarize(items = []) {
  const list = Array.isArray(items) ? items : [];
  const pass = list.filter((i) => i.status === STATUS.PASS).length;
  const fail = list.filter((i) => i.status === STATUS.FAIL).length;
  const noSample = list.filter((i) => i.status === STATUS.NO_SAMPLE).length;
  const exitCode = fail > 0 ? 1 : (list.length > 0 && noSample === list.length ? 2 : 0);
  return { pass, fail, noSample, total: list.length, exitCode, text: `${pass}/${list.length} 项通过` };
}

// ---------------------------------------------------------------------------
// 取数（文件系统 / 子进程）
// ---------------------------------------------------------------------------

const readJsonl = (file) => {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过，不编造 */ }
  }
  return out;
};

/** 当前宿主 pid = 最后一条宿主心跳（src=index.js）的 pid；没有 ⇒ null。 */
export function pickCurrentPid(rows = []) {
  const host = (Array.isArray(rows) ? rows : []).filter((r) => String(r?.src ?? '') === 'index.js' && Number.isFinite(r?.pid));
  if (!host.length) return null;
  let last = host[0];
  for (const r of host) if (Number(r.at) >= Number(last.at)) last = r;
  return last.pid;
}

/** 运行子脚本，返回 {code, stdout, stderr}（不抛）。 */
function runNode(args, { timeoutMs = 600000 } = {}) {
  const res = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env },
  });
  return {
    code: Number.isInteger(res.status) ? res.status : (res.error ? 127 : 1),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? String(res.error.message ?? res.error) : ''),
  };
}

const mtimeMs = (file) => {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
};

/**
 * 跑全部七项。`opts.skipHeavy` 只用于**自测**（把 ⑦ 记成 NO-SAMPLE，绝不记成 PASS）。
 */
export function runChecks({ store = DEFAULT_STORE, repo = REPO, timeoutMs = 600000 } = {}) {
  const items = [];
  const liveFile = path.join(store, 'live-stats.jsonl');
  const sampleFile = path.join(store, 'card-samples.jsonl');
  const liveRows = readJsonl(liveFile);
  const currentPid = pickCurrentPid(liveRows);
  const curRows = currentPid === null ? [] : liveRows.filter((r) => r?.pid === currentPid);

  // ①
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const releaseAt = Math.max(mtimeMs(path.join(repo, 'package.json')) ?? 0, mtimeMs(path.join(repo, 'CHANGELOG.md')) ?? 0) || null;
  const hostFirstAt = curRows.length ? Math.min(...curRows.map((r) => Number(r.at)).filter(Number.isFinite)) : null;
  const inst = runNode([path.join(repo, 'scripts', 'instance-status.mjs')], { timeoutMs });
  items.push(judgeNewCode({ instanceText: inst.stdout, localVersion: pkg.version, hostFirstAt, releaseAt }));

  // ②
  items.push(judgeAbstainReasons(curRows.filter((r) => r?.action === 'abstain')));

  // ③（card-samples 也按当前 pid 切：旧 pid 的行是旧代码的账）
  const sampleRows = currentPid === null ? [] : readJsonl(sampleFile).filter((r) => r?.pid === currentPid);
  items.push(judgeSignalPreview(sampleRows));

  // ④
  items.push(judgeDuplicateInjections(curRows.filter((r) => r?.action === 'inject')));

  // ⑤
  const shadow = runNode([path.join(repo, 'scripts', 'cli.mjs'), 'inject', '--shadow', '--signal', '推进任务表', '--store', store], { timeoutMs });
  items.push(judgeRecoveryTail(`${shadow.stdout}\n${shadow.stderr}`, { exitCode: shadow.code, stderr: shadow.stderr }));

  // ⑥
  let pluginSource = '';
  try { pluginSource = fs.readFileSync(path.join(repo, 'src', 'plugin.mjs'), 'utf8'); } catch { pluginSource = ''; }
  items.push(judgeCapConstants(pluginSource));

  // ⑦
  const guard = runNode([path.join(repo, 'scripts', 'metrics-guard.mjs')], { timeoutMs });
  items.push(judgeA1ThreeAxes(`${guard.stdout}\n${guard.stderr}`, { exitCode: guard.code }));

  return { items, summary: summarize(items), store, currentPid };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function renderHuman(result) {
  const lines = [];
  lines.push('== 重启验证（post-restart-verify）==');
  lines.push(`仓库：${REPO}`);
  lines.push(`记忆库：${result.store} · 当前宿主 pid：${result.currentPid ?? '（无心跳）'}`);
  lines.push('');
  for (const it of result.items) {
    lines.push(`${it.status.padEnd(9)} ${it.title}`);
    lines.push(`          ${it.evidence}`);
  }
  lines.push('');
  lines.push(`汇总：${result.summary.text} · FAIL=${result.summary.fail} · NO-SAMPLE=${result.summary.noSample} ⇒ exit ${result.summary.exitCode}`);
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const store = path.resolve(opt('store', DEFAULT_STORE));
  const timeoutMs = Number(opt('timeout-ms', '600000')) || 600000;
  const result = runChecks({ store, repo: REPO, timeoutMs });
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(renderHuman(result));
  return result.summary.exitCode;
}

const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (invokedDirectly) {
  process.exitCode = main();
}

export default { runChecks, summarize, main, STATUS };
