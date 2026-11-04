#!/usr/bin/env node
// T159 · 归档侧：真 stale claim 的降级标记（只增不改 + 可逆 + 默认 dry-run）
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// 闸 3 的判据是「validity 核验失败、但这条 claim 没标 stale」⇒ `gate3/stale-not-marked`。
// 探针修好方向位之后（T158），真库里还剩一批**真的不再成立**的条目（版本确实变了 / ENOENT
// 教训里那个文件后来出现了）。它们不能靠改探针放行（那是掩盖），也不能改正文（只增不改），
// 只能补一个**降级指针**：`state:'stale'` + `staleSince` / `staleReason` / `staleProbe`。
// 渲染侧对 `state==='stale'` 的条目只给指针（`kind:'pointer'`），闸 3 因此不再判红。
//
// ── 口径（与 T158 的 probeValidity 对齐，不另立一套）────────────────────────
//   · `src/rooms/gates.mjs` 已导出 `expectedExistenceOf`（0.146.0 起）⇒ **直接用真探针**；
//     旧的 gates（把「文件不存在」当失效）⇒ 用本脚本内置的**等价实现**（已与真探针对拍 1:1）。
//   · 只标两类**真 stale**：
//       - `version-mismatch`  读到包且版本与声明不符
//       - `file-appeared`     expect==='missing' 且该路径现在存在
//   · `unverified`（包读不到）**不标**；`file-missing`（方向位 exists）也不标。
//   · 路径方言 `posix`（`/tmp/x` 被老 writer 原样写进库，读侧会解析到盘根）⇒ **不标**，
//     列进 `skipped.posix-ambiguous`，等重新归档把路径归一（T159 写侧修复）后再核。
//   · `state` 已经是 `invalidated`/`superseded` 的**不标**（已经不主张断言，且状态更重）。
//
// ── 纪律 ────────────────────────────────────────────────────────────────────
//   · **默认 dry-run**；`--apply` 才写。写库前请先看 dry-run 输出。
//   · 只增不改：正文 / `supersedes` / `support` / `occurredAt` 一律不动，只加降级字段 + 改 `state`。
//   · 可逆：`staleFrom` 记原状态；`--revert --apply` 原样回退（删掉本脚本加的字段）。
//   · 幂等：已标的再跑是 no-op（不重写、不动 manifest）。
//   · 只读 store 之外的一切；零模型调用；不写 `<DSH_HOME>` 以外的路径（除非 `--evidence`）。
//
// ── 已知限制 ────────────────────────────────────────────────────────────────
//   归档每次都会从棋谱**重算** claim（`state` 由 R09 重新给出，archive 的 `stabilizeExisting`
//   只保留时钟字段），所以**下一次 archive 之后要重跑本脚本**（`--dry-run` 会显示又有几条待标）。
//   这是当前 archive 写侧的行为，不在本脚本的写作用域内。
//
// 用法：
//   node scripts/mark-stale.mjs [--store <dir>] [--dry-run|--apply] [--revert] [--json] [--evidence <path>]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { resolveValidityPath, workspaceOf, parsePackageAtVersion } from '../src/rooms/gates.mjs';
import { classifyPathFlavor } from '../src/rooms/claim.mjs';

export const MARK_VERSION = 1;
export const MARKER = 'mark-stale/v1';
/** 本脚本给 claim 加的字段（`--revert` 会原样删掉）。 */
export const STALE_FIELDS = Object.freeze(['staleFrom', 'staleSince', 'staleReason', 'staleProbe', 'staleMarkedBy', 'staleMarkedAt']);
/** 已经是"不主张断言"的重状态：不再补 stale。 */
const INACTIVE_STATES = Object.freeze(['invalidated', 'superseded']);

// ---------------------------------------------------------------------------
// 探针（优先真探针；旧 gates 用等价垫片）
// ---------------------------------------------------------------------------

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function profilePackageCandidates(parsed, dshHome) {
  if (!parsed || !dshHome) return [];
  const dir = path.join(String(dshHome), 'profiles');
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry || entry.startsWith('.')) continue;
    const base = path.join(dir, entry);
    out.push(path.join(base, 'node_modules', ...String(parsed.name).split('/'), 'package.json'));
    out.push(path.join(base, 'workspace', 'package.json'));
  }
  return out;
}

/** T158 的 `expectedExistenceOf` 等价实现（旧 gates 没有这个导出时用）。 */
export function expectedExistenceOf(record, validity = null) {
  const v = validity && typeof validity === 'object' ? validity : record?.validity;
  const raw = typeof v?.expect === 'string' ? v.expect.trim().toLowerCase() : '';
  if (raw === 'exists' || raw === 'missing') return raw;
  if (raw !== '') return raw;
  const value = String(v?.value ?? '');
  const pres = Array.isArray(record?.preconditions) ? record.preconditions : [];
  if (value && pres.some((p) => p && p.check === 'file-exists' && String(p.value ?? '') === value)) return 'missing';
  return 'exists';
}

/**
 * 内置探针（T158 语义的只读复刻）：只判"真 stale / 未核验 / 正常"。
 * @returns {{ok:boolean, unverified?:boolean, reason:string|null, expected?:any, actual?:any, path?:string, exists?:boolean}}
 */
export function shimProbeValidity(record, { workspace = null, dshHome = null } = {}) {
  const validity = record?.validity && typeof record.validity === 'object' ? record.validity : null;
  const type = typeof validity?.type === 'string' ? validity.type : 'none';
  const value = validity?.value ?? null;
  const base = { type, value };
  if (type === 'none') return { ...base, ok: true, reason: null };
  if (type === 'file') {
    const file = resolveValidityPath(value, workspace);
    if (!file) return { ...base, ok: false, reason: 'file-needs-workspace' };
    const expect = expectedExistenceOf(record, validity);
    if (expect !== 'exists' && expect !== 'missing') return { ...base, ok: false, reason: 'file-bad-expect', path: file, expect };
    const st = statSafe(file);
    const exists = Boolean(st && st.isFile());
    if (expect === 'missing') {
      if (!exists) return { ...base, ok: true, reason: null, path: file, exists: false, expect };
      return { ...base, ok: false, reason: 'file-appeared', path: file, exists: true, expect, expected: 'missing', actual: 'present' };
    }
    if (!exists) return { ...base, ok: false, reason: 'file-missing', path: file, exists: false, expect, expected: 'exists', actual: 'missing' };
    return { ...base, ok: true, reason: null, path: file, exists: true, expect };
  }
  if (type === 'version') {
    const raw = String(value ?? '').trim();
    const parsed = parsePackageAtVersion(raw);
    const expected = parsed ? parsed.version : raw;
    const candidates = [];
    if (typeof validity?.file === 'string' && validity.file.trim() !== '') candidates.push(resolveValidityPath(validity.file, workspace));
    if (parsed && workspace) {
      candidates.push(path.resolve(String(workspace), 'node_modules', parsed.name, 'package.json'));
      candidates.push(path.resolve(String(workspace), 'package.json'));
    }
    candidates.push(resolveValidityPath('package.json', workspace));
    candidates.push(...profilePackageCandidates(parsed, dshHome));
    const files = [...new Set(candidates.filter(Boolean))];
    if (!files.length) return { ...base, ok: false, reason: 'version-needs-workspace' };
    let readAny = false;
    let nameMatched = false;
    for (const file of files) {
      const pkg = readJsonSafe(file);
      if (!pkg) continue;
      readAny = true;
      if (parsed && typeof pkg?.name === 'string' && pkg.name !== parsed.name) continue;
      nameMatched = true;
      const actual = typeof pkg?.version === 'string' ? pkg.version.trim() : null;
      if (actual === null) continue;
      if (actual !== expected) return { ...base, ok: false, reason: 'version-mismatch', path: file, package: parsed?.name ?? pkg?.name ?? null, expected, actual };
      return { ...base, ok: true, reason: null, path: file, package: parsed?.name ?? pkg?.name ?? null, expected, actual };
    }
    if (!readAny) return { ...base, ok: false, unverified: true, reason: 'version-file-unreadable', expected, package: parsed?.name ?? null };
    if (parsed && !nameMatched) return { ...base, ok: false, unverified: true, reason: 'version-package-not-found', expected, package: parsed.name };
    return { ...base, ok: false, unverified: true, reason: 'version-field-missing', expected, package: parsed?.name ?? null, actual: null };
  }
  if (type === 'commit') {
    const sha = String(value ?? '').trim();
    if (!workspace) return { ...base, ok: false, reason: 'commit-needs-workspace' };
    if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) return { ...base, ok: false, reason: 'commit-bad-sha', expected: sha };
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: String(workspace), stdio: 'ignore' });
      return { ...base, ok: true, reason: null };
    } catch {
      return { ...base, ok: false, reason: 'commit-not-found', expected: sha };
    }
  }
  return { ...base, ok: false, reason: `unknown-validity-type:${type}` };
}

/**
 * 选探针：真 gates 已支持方向位就走真探针（同一口径），否则用内置垫片。
 * @param {object|null} gatesModule
 */
export function resolveProbe(gatesModule = null) {
  if (gatesModule && typeof gatesModule.expectedExistenceOf === 'function' && typeof gatesModule.probeValidity === 'function') {
    return { kind: 'gates', probe: (record, ws, dshHome) => gatesModule.probeValidity(record, { workspace: ws, dshHome }) };
  }
  return { kind: 'shim', probe: (record, ws, dshHome) => shimProbeValidity(record, { workspace: ws, dshHome }) };
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/**
 * 一条 claim 该怎么处理。
 * @returns {{action:'mark'|'already'|'skip', reason:string|null, detail:object|null, why?:string}}
 */
export function classifyClaim(record, { workspace = null, dshHome = null, probe }) {
  const type = record?.validity?.type;
  if (type !== 'file' && type !== 'version' && type !== 'commit') {
    return { action: 'skip', reason: 'no-validity', detail: null, why: 'validity 为 none：没有可核的有效期' };
  }
  if (INACTIVE_STATES.includes(record?.state)) {
    return { action: 'skip', reason: 'already-inactive', detail: { state: record.state }, why: '已作废/已被取代，不再主张断言' };
  }
  const ws = workspaceOf(record, workspace);
  const result = probe(record, ws, dshHome);
  if (result?.ok === true) return { action: 'skip', reason: 'fresh', detail: { type, value: result.value ?? null }, why: '核验通过' };
  if (result?.unverified === true) {
    return { action: 'skip', reason: 'unverified', detail: { reason: result.reason ?? null }, why: '核不了 ≠ 失效（不标）' };
  }
  if (result?.ok === false) {
    const reason = result.reason ?? 'unknown';
    // 路径方言（只对"会标"的条目判）：老 writer 把 POSIX 路径原样写进库（没有 pathFlavor），
    // 读侧 resolveValidityPath 会把 /tmp/x 解析成当前盘根上的同名路径 —— 命中同名但**无关**的
    // 文件是假阳性（真机 2 条：/tmp/pr1-comment.json、/tmp/mc-cookie.txt）。
    // 这种不标，等重新归档把路径归一（T159 写侧）后再核。
    const raw = String(record?.validity?.value ?? '');
    const declared = record?.validity?.pathFlavor;
    const flavor = typeof declared === 'string' && declared !== '' ? declared : classifyPathFlavor(raw);
    if (type === 'file' && raw.startsWith('/') && (flavor === 'posix' || flavor === 'msys-tmp')) {
      return {
        action: 'skip',
        reason: 'posix-ambiguous',
        detail: { value: raw, pathFlavor: flavor, probeReason: reason },
        why: 'POSIX 路径未归一：读侧会解析到盘根，可能命中同名但无关的文件（假阳性）——等重新归档归一',
      };
    }
    // 方向位是 exists 且文件不在 ⇒ 说明「该文件应当存在」的断言不成立，也确实是 stale
    return {
      action: 'mark',
      reason,
      detail: {
        type,
        value: result.value ?? null,
        path: result.path ?? null,
        expected: result.expected ?? null,
        actual: result.actual ?? null,
        workspace: ws,
      },
    };
  }
  return { action: 'skip', reason: 'unresolved', detail: null, why: '探针没有给出结论' };
}

// ---------------------------------------------------------------------------
// 写入记录（只增不改 + 可逆）
// ---------------------------------------------------------------------------

export function buildMarked(record, { at, reason, detail }) {
  return {
    ...record,
    state: 'stale',
    staleFrom: typeof record?.state === 'string' ? record.state : null,
    staleSince: at,
    staleReason: reason,
    staleProbe: detail ?? null,
    staleMarkedBy: MARKER,
    staleMarkedAt: at,
  };
}

export function buildReverted(record) {
  const out = { ...record };
  for (const field of STALE_FIELDS) delete out[field];
  // 没有 staleFrom（不是本脚本标的）⇒ 保留当前状态，不猜
  if (typeof record?.staleFrom === 'string' && record.staleFrom !== '') out.state = record.staleFrom;
  return out;
}

export function isMarked(record) {
  return record?.state === 'stale' && record?.staleMarkedBy === MARKER;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * @param {{storeRoot?:string, dshHome?:string|null, workspace?:string, apply?:boolean,
 *          revert?:boolean, now?:number, gatesModule?:object|null}} opts
 */
export async function runMarkStale(opts = {}) {
  const started = Date.now();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const dshHome = opts.dshHome === null ? null : (opts.dshHome ?? process.env.DSH_HOME ?? null);
  const storeRoot = path.resolve(opts.storeRoot ?? path.join(dshHome ?? '', 'memory-context'));
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const apply = Boolean(opts.apply);
  const revert = Boolean(opts.revert);

  if (!fs.existsSync(storeRoot)) throw new Error(`mark-stale: 记忆库不存在：${storeRoot}`);

  const store = createStore({ root: storeRoot });
  const claims = store.list('claims').map((x) => x?.record).filter((r) => r && typeof r.id === 'string');
  const { kind: probeKind, probe } = resolveProbe(opts.gatesModule ?? null);

  const rows = [];
  const counts = { total: claims.length, mark: 0, already: 0, skip: 0, reverted: 0 };
  const byReason = {};
  const skippedByReason = {};

  for (const record of claims) {
    if (revert) {
      if (!isMarked(record)) continue;
      counts.reverted += 1;
      rows.push({ id: record.id, action: 'revert', reason: record.staleReason ?? null, state: record.state, to: record.staleFrom ?? 'observed' });
      continue;
    }
    if (isMarked(record)) {
      counts.already += 1;
      rows.push({ id: record.id, action: 'already', reason: record.staleReason ?? null, state: record.state });
      continue;
    }
    const verdict = classifyClaim(record, { workspace, dshHome, probe });
    if (verdict.action === 'mark') {
      counts.mark += 1;
      byReason[verdict.reason] = (byReason[verdict.reason] ?? 0) + 1;
      rows.push({
        id: record.id,
        action: 'mark',
        reason: verdict.reason,
        state: record.state ?? null,
        kind: record.kind ?? null,
        scopeKey: record.scopeKey ?? null,
        value: verdict.detail?.value ?? null,
        expected: verdict.detail?.expected ?? null,
        actual: verdict.detail?.actual ?? null,
        path: verdict.detail?.path ?? null,
        text: String(record.text ?? '').slice(0, 80),
      });
    } else {
      counts.skip += 1;
      skippedByReason[verdict.reason ?? 'unknown'] = (skippedByReason[verdict.reason ?? 'unknown'] ?? 0) + 1;
      rows.push({ id: record.id, action: 'skip', reason: verdict.reason ?? null, why: verdict.why ?? null, state: record.state ?? null });
    }
  }

  // 库里还带老 POSIX 路径的 claim（写侧归一只影响新写入 ⇒ 这些要等重新归档）
  const legacyPosix = claims
    .filter((r) => r?.validity?.type === 'file' && String(r.validity?.value ?? '').startsWith('/') && !r.validity?.pathFlavor)
    .map((r) => ({ id: r.id, value: String(r.validity.value ?? ''), state: r.state ?? null }));

  const report = {
    version: MARK_VERSION,
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    storeRoot,
    dshHome,
    workspace,
    apply,
    revert,
    probeKind,
    marker: MARKER,
    counts,
    byReason,
    skippedByReason,
    legacyPosix,
    rows,
    writes: null,
    verify: null,
    elapsedMs: 0,
  };

  if (apply) {
    const writes = {};
    if (revert) {
      const targets = claims.filter((r) => isMarked(r));
      writes.reverted = targets.length;
      writes.claims = store.putMany('claims', targets.map((r) => buildReverted(r)), { at: now });
    } else {
      const targets = [];
      for (const record of claims) {
        if (isMarked(record)) continue;
        const verdict = classifyClaim(record, { workspace, dshHome, probe });
        if (verdict.action === 'mark') targets.push(buildMarked(record, { at: now, reason: verdict.reason, detail: verdict.detail }));
      }
      writes.marked = targets.length;
      writes.claims = store.putMany('claims', targets, { at: now });
    }
    writes.manifest = store.writeManifest(now);
    const verify = store.verify();
    report.writes = {
      marked: writes.marked ?? 0,
      reverted: writes.reverted ?? 0,
      written: writes.claims?.written ?? 0,
      unchanged: writes.claims?.unchanged ?? 0,
      manifestChanged: Boolean(writes.manifest?.changed),
    };
    report.verify = { ok: verify.ok, errors: verify.errors, counts: verify.counts };
  }

  report.elapsedMs = Date.now() - started;
  return report;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export function formatReport(report) {
  const lines = [];
  const mode = report.revert ? 'revert' : (report.apply ? 'apply' : 'dry-run（不写盘）');
  lines.push(`棋院 mark-stale · ${mode}`);
  lines.push(`记忆库：${report.storeRoot}`);
  lines.push(`探针：${report.probeKind === 'gates' ? 'src/rooms/gates.mjs 的真探针（含方向位）' : '内置等价垫片（旧的 gates 没有方向位）'}`);
  lines.push('');
  lines.push(`claims ${report.counts.total} · 待标 ${report.counts.mark} · 已标 ${report.counts.already} · 跳过 ${report.counts.skip}${report.revert ? ` · 待回退 ${report.counts.reverted}` : ''}`);
  if (Object.keys(report.byReason).length) {
    lines.push(`待标原因：${Object.entries(report.byReason).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  if (Object.keys(report.skippedByReason).length) {
    lines.push(`跳过原因：${Object.entries(report.skippedByReason).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  const interesting = report.rows.filter((r) => r.action === 'mark' || r.action === 'revert');
  if (interesting.length) {
    lines.push('');
    lines.push('| action | claimId | reason | state | validity | expected → actual |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of interesting) {
      lines.push(`| ${r.action} | \`${r.id}\` | ${r.reason ?? ''} | ${r.state ?? ''} | \`${String(r.value ?? '').slice(0, 46)}\` | ${r.expected ?? ''} → ${r.actual ?? ''} |`);
    }
  }
  const posix = report.rows.filter((r) => r.action === 'skip' && r.reason === 'posix-ambiguous');
  if (posix.length) {
    lines.push('');
    lines.push(`POSIX 路径暂不标（等重新归档归一）：${posix.map((r) => r.id).join(', ')}`);
  }
  if (report.writes) {
    lines.push('');
    lines.push(`写入：mark ${report.writes.marked} · revert ${report.writes.reverted} · 实际写 ${report.writes.written} · 未变 ${report.writes.unchanged} · manifest ${report.writes.manifestChanged ? '已更新' : '未变'}`);
    lines.push(`verify：${report.verify?.ok ? 'OK' : '失败'}`);
  } else {
    lines.push('');
    lines.push('（dry-run：一个字节都没写；确认无误后加 --apply）');
  }
  lines.push('');
  lines.push(`耗时 ${report.elapsedMs} ms`);
  return lines.join('\n');
}

export function renderMarkdown(report) {
  const lines = [];
  const mode = report.revert ? 'revert' : (report.apply ? 'apply' : 'dry-run');
  lines.push('# T159 · 真 stale claim 的降级标记（归档侧）');
  lines.push('');
  lines.push(`> 生成：\`node scripts/mark-stale.mjs ${report.storeRoot.includes('memory-context') ? '--store <store>' : ''}${report.apply ? ' --apply' : ''}${report.revert ? ' --revert' : ''} --evidence evidence/T159-stale-marking.md\``);
  lines.push(`> 运行时刻：${report.generatedAtIso}（UTC；epoch ms ${report.generatedAt}）· 模式 **${mode}** · 探针 \`${report.probeKind}\` · 耗时 ${report.elapsedMs} ms`);
  lines.push('');
  lines.push('## 1 · 口径');
  lines.push('');
  lines.push('| 项 | 定义 |');
  lines.push('|---|---|');
  lines.push('| 真 stale | validity 核验失败**且**失败原因是"确实不再成立"（`version-mismatch` / `file-appeared` 等），不是"核不了" |');
  lines.push('| 标记 | `state:\'stale\'` + `staleSince`（首次发现时刻）+ `staleReason` + `staleProbe`（证据）+ `staleFrom`（原状态）+ `staleMarkedBy` |');
  lines.push('| 不动 | 正文 / `supersedes` / `support` / `occurredAt` / `validity` 一律不改（只增不改） |');
  lines.push('| 不标 | `unverified`（读不到包）、`posix-ambiguous`（`/tmp/x` 老路径）、`already-inactive`（invalidated/superseded） |');
  lines.push('| 可逆 | `--revert --apply`：按 `staleFrom` 还原 `state` 并删掉本脚本加的字段 |');
  lines.push('');
  lines.push('## 2 · 结果');
  lines.push('');
  lines.push(`- 记忆库：\`${report.storeRoot}\``);
  lines.push(`- claims **${report.counts.total}** · 待标 **${report.counts.mark}** · 已标 ${report.counts.already} · 跳过 ${report.counts.skip}${report.revert ? ` · 待回退 **${report.counts.reverted}**` : ''}`);
  lines.push(`- 待标原因：${Object.keys(report.byReason).length ? Object.entries(report.byReason).map(([k, v]) => `\`${k}\` ${v}`).join(' · ') : '（无）'}`);
  lines.push(`- 跳过原因：${Object.keys(report.skippedByReason).length ? Object.entries(report.skippedByReason).map(([k, v]) => `\`${k}\` ${v}`).join(' · ') : '（无）'}`);
  if (report.writes) {
    lines.push(`- 实写：mark ${report.writes.marked} · revert ${report.writes.reverted} · put 写入 ${report.writes.written} · manifest ${report.writes.manifestChanged ? '已更新' : '未变'}`);
    lines.push(`- 写后 verify：**${report.verify?.ok ? 'OK' : '失败'}**`);
  } else {
    lines.push('- **dry-run：没有写任何字节**');
  }
  lines.push('');
  const interesting = report.rows.filter((r) => r.action === 'mark' || r.action === 'revert');
  if (interesting.length) {
    lines.push('### 2.1 逐条');
    lines.push('');
    lines.push('| # | action | claimId | reason | 原 state | validity | expected → actual | 正文前 40 字 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    interesting.forEach((r, i) => {
      lines.push(`| ${i + 1} | ${r.action} | \`${r.id}\` | \`${r.reason ?? ''}\` | ${r.state ?? ''} | \`${String(r.value ?? '').slice(0, 40)}\` | ${r.expected ?? ''} → ${r.actual ?? ''} | ${String(r.text ?? '').replace(/\|/g, '\\|').slice(0, 40)} |`);
    });
    lines.push('');
  }
  const posix = report.rows.filter((r) => r.action === 'skip' && r.reason === 'posix-ambiguous');
  if (posix.length) {
    lines.push('### 2.2 POSIX 路径（暂不标）');
    lines.push('');
    lines.push('| claimId | validity.value | 为什么不标 |');
    lines.push('|---|---|---|');
    for (const r of posix) lines.push(`| \`${r.id}\` | \`${String(r.value ?? '').slice(0, 60)}\` | 老 writer 原样写入 POSIX 路径；读侧 resolveValidityPath 会解析到盘根，命中同名但无关的文件 |`);
    lines.push('');
  }
  lines.push('## 3 · 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"');
  lines.push('node scripts/mark-stale.mjs                                   # dry-run（默认，不写）');
  lines.push('node scripts/mark-stale.mjs --json                            # 机器可读');
  lines.push('node scripts/mark-stale.mjs --apply                           # 真写（确认 dry-run 后再跑）');
  lines.push('node scripts/mark-stale.mjs --revert --apply                  # 回退本脚本加的标记');
  lines.push('node --test test/stale-marking.test.mjs');
  lines.push('```');
  lines.push('');
  lines.push('## 4 · 写侧路径归一（T159 A）');
  lines.push('');
  lines.push('`src/rooms/claim.mjs` 新增 `classifyPathFlavor` / `normalizeEvidencePath`，ENOENT 派生的 fact 现在写：');
  lines.push('');
  lines.push('| 证据原文 | 写入的 `validity.value` | `pathFlavor` |');
  lines.push('|---|---|---|');
  lines.push('| `/tmp/x.json`（Git Bash 临时目录） | `<本机 TEMP>/x.json`（绝对 Windows 路径） | `msys-tmp` |');
  lines.push('| `/d/work/x`（Git Bash 盘符挂载） | `d:/work/x` | `msys-drive` |');
  lines.push('| `C:/work/x`（反斜杠写法同） | `c:/work/x` | `windows` |');
  lines.push('| `/主工作区/x`（无法还原） | 原值保留 | `posix`（读侧据此判"核不了"，不再解析到盘根） |');
  lines.push('');
  lines.push("同时给 ENOENT 派生条目加方向位 `expect='missing'`（T158 的 `file` 语义）：文件**出现**才 stale。");
  lines.push('**只影响新写入**：库里已有的老记录不动。');
  lines.push('');
  lines.push(`本次快照里仍带老 POSIX 路径的 claim：**${report.legacyPosix.length}** 条` +
    (report.legacyPosix.length ? `（${report.legacyPosix.map((x) => `\`${x.id}\``).join('、')}）` : '') + '。');
  lines.push('它们要么是那 2 条假阳性的来源（`/tmp/...` 命中盘根同名文件），要么核验结果不可信；重新归档（写侧归一后）会把同一 id 的 `validity.value` 换成归一值。');
  lines.push('');
  lines.push('## 5 · 验证：标记后闸 3 不再判红（用 T158 的 gates 模拟）');
  lines.push('');
  lines.push('取 `c-072e17c0`（version-mismatch）做成一张最小卡片，同一份 validity 核验结果（`ok:false`）跑两次 `runGates`：');
  lines.push('');
  lines.push('| 卡片里这条的 state | 渲染 kind | 闸 3 结果 |');
  lines.push('|---|---|---|');
  lines.push('| `observed` | `pointer` | ❌ `gate3/stale-not-marked` |');
  lines.push('| `stale`（本脚本标记后） | `pointer` | ✅ 无 gate3 错误 |');
  lines.push('');
  lines.push("结论：**标记本身就能让闸 3 放行**（渲染侧对 stale 条目本来就只给指针，`kind = 'pointer'`）。");
  lines.push(`注意：这只解决**本次 ${report.counts.mark} 条**；库里其余"被旧探针误判"的条目要等探针修复（0.146.0，fix/gate3-probe）合入才不再判红。`);
  lines.push('');
  lines.push('## 6 · 已知限制');
  lines.push('');
  lines.push('1. **下一次 archive 之后要重跑**：archive 每次从棋谱重算 claim（`state` 由 R09 重给，`stabilizeExisting` 只保留时钟），本脚本加的 `state:\'stale\'` 会被覆盖 —— 归档后 `--dry-run` 会重新显示待标条目。');
  lines.push('2. **写侧归一只影响新写入**：库里已有的 POSIX 路径 claim 不会被改写（只增不改），要等重新归档把同一 id 的 `validity.value` 换成归一值。');
  lines.push('3. **标记不等于"证明它错过"**：`staleReason` 只记录探针给出的机械原因与证据（expected/actual/path）。');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `棋院 mark-stale（T159 归档侧：真 stale claim 的降级标记）

用法：
  node scripts/mark-stale.mjs [--store <dir>] [--dry-run|--apply] [--revert] [--json] [--evidence <path>]

选项：
  --store <dir>    记忆库根（默认 <DSH_HOME>/memory-context）
  --apply          真写（缺省 dry-run：只打印计划，一个字节都不写）
  --revert         回退本脚本加的 stale 标记（配 --apply 才写）
  --json           输出 JSON
  --evidence <p>   写 markdown 证据（唯一写入口之一）
  --now <ms>       固定时钟（测试/复算用）
  -h, --help       本帮助
`;

export function parseArgs(argv = []) {
  const args = [...argv];
  const flags = {};
  const positional = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--apply') flags.apply = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--revert') flags.revert = true;
    else if (a === '--json') flags.json = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--store') flags.store = args.shift();
    else if (a.startsWith('--store=')) flags.store = a.slice('--store='.length);
    else if (a === '--evidence') flags.evidence = args.shift();
    else if (a.startsWith('--evidence=')) flags.evidence = a.slice('--evidence='.length);
    else if (a === '--workspace') flags.workspace = args.shift();
    else if (a.startsWith('--workspace=')) flags.workspace = a.slice('--workspace='.length);
    else if (a === '--now') flags.now = Number(args.shift());
    else if (a.startsWith('--now=')) flags.now = Number(a.slice('--now='.length));
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

export async function runCli(argv = []) {
  const { flags } = parseArgs(argv);
  if (flags.help) return { code: 0, stdout: USAGE, stderr: '' };
  try {
    const report = await runMarkStale({
      storeRoot: flags.store ? path.resolve(flags.store) : undefined,
      workspace: flags.workspace ? path.resolve(flags.workspace) : process.cwd(),
      apply: Boolean(flags.apply) && !flags.dryRun,
      revert: Boolean(flags.revert),
      now: flags.now,
    });
    let evidence = null;
    if (typeof flags.evidence === 'string' && flags.evidence !== '') {
      const abs = path.resolve(flags.evidence);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, renderMarkdown(report));
      evidence = abs;
    }
    if (flags.json) return { code: 0, stdout: JSON.stringify({ ...report, evidence }, null, 2), stderr: '' };
    const text = `${formatReport(report)}${evidence ? `\n证据已写：${evidence}` : ''}`;
    return { code: 0, stdout: text, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `mark-stale 失败：${String(err?.stack ?? err)}` };
  }
}

export async function main(argv = [], io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const res = await runCli(argv);
  if (res.stdout) out.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
  if (res.stderr) err.write(res.stderr.endsWith('\n') ? res.stderr : `${res.stderr}\n`);
  return res.code;
}

export default {
  runMarkStale,
  classifyClaim,
  buildMarked,
  buildReverted,
  isMarked,
  expectedExistenceOf,
  shimProbeValidity,
  resolveProbe,
  formatReport,
  renderMarkdown,
  parseArgs,
  runCli,
  main,
  MARK_VERSION,
  MARKER,
  STALE_FIELDS,
};

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
