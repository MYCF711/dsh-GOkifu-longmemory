#!/usr/bin/env node
// T310 · antipattern 的**失效条件**（M4 / 知识库 69 的 F3）
//
// 判据（知识库 69）：值得记的失败 = F1 付过代价 · F2 可复现 · **F3 可反驳**（写得出"什么情况算我错"）。
// 缺 F3 = 口号。本脚本只做两件事：
//   1. **测量**：真库里 `kind==='antipattern'` 有多少条、其中多少条**真的**带失效条件（M4 覆盖率）；
//   2. **修法（只在副本）**：给每条 antipattern 机械派生 `falsifiableWhen`；
//      **推不出来的一律标 `unverified`**（不许为了填满而编）。
//
// 派生规则（保守，全部可核；不满足就走 unverified）：
//   R1 · 非 `scope` 的 preconditions（`file-exists` / `cmd` / `tool` / `step-range`）⇒
//        `当「<check> = <value>」不再成立时`（来源 `preconditions[i]`）
//   R2 · `validity.type !== 'none'`（file / version / commit）⇒ `当 <type>=<value> 不再成立时`（来源 `validity`）
//   R3 · 正文里**以子句开头**的显式条件（`除非…` / `只有在…` / `仅当…` / `一旦…`）⇒
//        **逐字切片**（来源 `text@<offset>`；切片必须是原文子串，测试里断言）
//   · 只有 `scope` 前置条件 ⇒ **不算**（作用域是"在哪适用"，不是"何时失效"）
//   · 其余 ⇒ `unverified`（reason 写清为什么推不出来）
//
// 只读：不加 `--apply` 时只 `store.list()`；`--apply` 只允许写到仓库 `tmp/` 下的副本（守卫见 `assertCopyTarget`）。
//
// 用法：
//   node scripts/antipattern-falsifiable.mjs --store <src> [--sample 5] [--json]
//   node scripts/antipattern-falsifiable.mjs --store <src> --apply --out tmp/t310-copy
//
// 退出码：0 成功；2 参数/库不存在/守卫拒绝。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TMP_ROOT = path.join(REPO_ROOT, 'tmp');

/** 报告结构版本。 */
export const REPORT_VERSION = 1;
/** 算"实质失效条件"的 precondition 类型（`scope` 是适用范围，不是失效条件）。 */
export const SUBSTANTIVE_CHECKS = Object.freeze(['file-exists', 'cmd', 'tool', 'step-range']);
/** 显式条件子句（必须出现在子句开头；避免把 `gh 登录失效` 这种命令输出当条件）。 */
export const TEXT_CONDITION_RE = /(?:^|[。；\n])\s*(除非|只有在|仅当|一旦)([^。；\n]{2,60})/;
/** 具体错误签名（F2 可复现的机械代理）。 */
export const ERROR_SIGNATURE_RE = /(?:^|\s)(?:[A-Za-z]*Error:|fatal:|ENOENT|EACCES|EPERM|exit code|Traceback|TypeError|SyntaxError|ReferenceError|Cannot )/;
/** 祈使句开头（口号形态的机械代理）。 */
export const IMPERATIVE_RE = /^\s*(?:要|不要|别|必须|应该|注意|小心|记得|不要忘记)/;

export class AntipatternError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AntipatternError';
    this.code = code;
  }
}

export function parseArgs(argv = []) {
  const flags = { store: null, out: null, apply: false, sample: 5, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--apply') flags.apply = true;
    else if (arg === '--store') flags.store = argv[++i] ?? null;
    else if (arg === '--out') flags.out = argv[++i] ?? null;
    else if (arg === '--sample') flags.sample = Number(argv[++i] ?? 5);
    else return { error: `未知参数：${arg}` };
  }
  return flags;
}

/* ── 派生 ─────────────────────────────────────────────────── */

/** 一条 precondition 是否"实质失效条件"（`scope` 不算）。 */
export function isSubstantiveCheck(check) {
  return SUBSTANTIVE_CHECKS.includes(String(check ?? ''));
}

/**
 * 机械派生一条 antipattern 的失效条件。
 * @returns {{status:'derived'|'unverified', clause:string|null, source:string|null, offset:number|null, reason:string|null}}
 */
export function deriveFalsifiableWhen(claim) {
  const preconditions = Array.isArray(claim?.preconditions) ? claim.preconditions.filter((p) => p && typeof p === 'object') : [];
  const substantive = preconditions.filter((p) => isSubstantiveCheck(p.check));
  if (substantive.length > 0) {
    const index = preconditions.indexOf(substantive[0]);
    const p = substantive[0];
    return {
      status: 'derived',
      clause: `当「${String(p.check)} = ${String(p.value ?? '')}」不再成立时`,
      source: `preconditions[${index}]`,
      offset: null,
      reason: null,
    };
  }
  const validity = claim?.validity && typeof claim.validity === 'object' ? claim.validity : null;
  if (validity && typeof validity.type === 'string' && validity.type !== 'none') {
    return {
      status: 'derived',
      clause: `当 ${validity.type}=${String(validity.value ?? '')} 不再成立时`,
      source: 'validity',
      offset: null,
      reason: null,
    };
  }
  if (Number.isFinite(claim?.validUntil) || Number.isFinite(claim?.validTo)) {
    const at = Number.isFinite(claim?.validUntil) ? claim.validUntil : claim.validTo;
    return { status: 'derived', clause: `当 occurredAt > ${new Date(at).toISOString()} 时不再成立`, source: 'validUntil', offset: null, reason: null };
  }
  const text = String(claim?.text ?? '');
  const match = TEXT_CONDITION_RE.exec(text);
  if (match) {
    const clause = `${match[1]}${match[2]}`.trim();
    const offset = text.indexOf(clause);
    if (offset >= 0) return { status: 'derived', clause, source: `text@${offset}`, offset, reason: null };
  }
  const scopeOnly = preconditions.length > 0 && substantive.length === 0;
  return {
    status: 'unverified',
    clause: null,
    source: null,
    offset: null,
    reason: scopeOnly ? 'scope-only-precondition（作用域不是失效条件）' : 'no-recorded-condition',
  };
}

/** 一条 claim 的形态判定（给抽样报告用，机械代理，不做语义判断）。 */
export function shapeOf(claim) {
  const text = String(claim?.text ?? '');
  return {
    hasErrorSignature: ERROR_SIGNATURE_RE.test(text),
    imperative: IMPERATIVE_RE.test(text),
    chars: text.length,
    classClaim: text.startsWith('class:'),
  };
}

/* ── 测量 ─────────────────────────────────────────────────── */

/**
 * 全量分析。
 * @param {object[]} claims
 * @returns {{total:number, literal:number, substantive:number, derived:number, unverified:number,
 *            scopeOnly:number, byReason:object, rows:object[]}}
 */
export function analyzeAntipatterns(claims = []) {
  const anti = (Array.isArray(claims) ? claims : []).filter((c) => c && c.kind === 'antipattern');
  const rows = [];
  const byReason = {};
  let literal = 0;
  let substantive = 0;
  let scopeOnly = 0;
  for (const claim of anti) {
    const preconditions = Array.isArray(claim.preconditions) ? claim.preconditions.filter((p) => p && typeof p === 'object') : [];
    const validity = claim.validity && typeof claim.validity === 'object' ? claim.validity : null;
    const hasLiteral = preconditions.length > 0
      || (validity && typeof validity.type === 'string' && validity.type !== 'none')
      || Number.isFinite(claim.validUntil)
      || Number.isFinite(claim.validTo);
    const derived = deriveFalsifiableWhen(claim);
    if (hasLiteral) literal += 1;
    if (derived.status === 'derived') substantive += 1;
    else {
      const reason = derived.reason ?? 'no-recorded-condition';
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      if (preconditions.length > 0 && !preconditions.some((p) => isSubstantiveCheck(p.check))) scopeOnly += 1;
    }
    rows.push({
      id: String(claim.id ?? ''),
      text: String(claim.text ?? ''),
      state: String(claim.state ?? ''),
      scopeKey: String(claim.scopeKey ?? ''),
      ...derived,
      shape: shapeOf(claim),
    });
  }
  return {
    total: anti.length,
    literal,
    substantive,
    derived: substantive,
    unverified: anti.length - substantive,
    scopeOnly,
    byReason,
    rows,
  };
}

/** 确定性抽样：按 id 排序后等距取 n 条（同输入同输出）。 */
export function sampleRows(rows = [], n = 5) {
  const list = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const want = Math.max(1, Math.min(Number.isFinite(n) ? Math.floor(n) : 5, list.length));
  if (list.length === 0) return [];
  if (want === 1) return [list[0]];
  const out = [];
  for (let i = 0; i < want; i += 1) out.push(list[Math.round((i * (list.length - 1)) / (want - 1))]);
  return out;
}

/* ── 修法（只在副本）─────────────────────────────────────── */

/** 副本守卫（与 T257 同口径）：只许写到仓库 `tmp/` 下，且不能落在源库内。 */
export function assertCopyTarget(outDir, srcRoot) {
  const out = path.resolve(String(outDir ?? ''));
  const src = path.resolve(String(srcRoot ?? ''));
  const rel = path.relative(TMP_ROOT, out);
  if (!out || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AntipatternError(`antipattern-falsifiable: --out 必须落在仓库 tmp/ 下（收到 ${out || '(空)'}）`, 'antipattern-falsifiable/out-not-in-tmp');
  }
  if (src && (out === src || out.startsWith(`${src}${path.sep}`) || src.startsWith(`${out}${path.sep}`))) {
    throw new AntipatternError('antipattern-falsifiable: 副本不能与源库互相包含（源库只读）', 'antipattern-falsifiable/out-inside-source');
  }
  return out;
}

/**
 * 把 claim 层复制到副本，并给 antipattern 补 `falsifiableWhen`（推不出来写 null + `unverified`）。
 * @returns {{outDir:string, copied:number, derived:number, unverified:number, skipped:number}}
 */
export function applyToCopy({ srcRoot, outDir } = {}) {
  const src = path.resolve(String(srcRoot ?? ''));
  const out = assertCopyTarget(outDir, src);
  const source = createStore({ root: src });
  const dest = createStore({ root: out });
  let copied = 0;
  let derived = 0;
  let unverified = 0;
  let skipped = 0;
  for (const item of source.list('claims')) {
    const record = item?.record;
    if (!record || typeof record.id !== 'string') {
      skipped += 1;
      continue;
    }
    const next = { ...record };
    if (record.kind === 'antipattern') {
      const decision = deriveFalsifiableWhen(record);
      next.falsifiableWhen = decision.clause;
      next.falsificationStatus = decision.status;
      next.falsificationSource = decision.source;
      next.falsificationReason = decision.reason;
      if (decision.status === 'derived') derived += 1;
      else unverified += 1;
    }
    dest.put('claims', next);
    copied += 1;
  }
  return { outDir: out, copied, derived, unverified, skipped };
}

/* ── 渲染 ─────────────────────────────────────────────────── */

const pct = (x) => `${(Number(x) * 100).toFixed(1)}%`;

export function renderReport({ analysis, samples, storeRoot }) {
  const lines = [];
  lines.push('# T310 · antipattern 的失效条件（M4 / F3）');
  lines.push('');
  lines.push(`> 真库：\`${storeRoot}\`（只读，未写）`);
  lines.push(`> 生成于 \`[本] ${new Date().toISOString()}\``);
  lines.push('');
  lines.push('## 一 · 测量');
  lines.push('');
  lines.push(`- antipattern 总数：**${analysis.total}**`);
  lines.push(`- **字面**带失效条件（` + '`preconditions` / `validity` / `validUntil`' + `）：**${analysis.literal} / ${analysis.total} = ${pct(analysis.total ? analysis.literal / analysis.total : 0)}**`);
  lines.push(`- **实质**带失效条件（非 ` + '`scope`' + ` 的 preconditions / validity / 显式条件子句）：**${analysis.substantive} / ${analysis.total} = ${pct(analysis.total ? analysis.substantive / analysis.total : 0)}**`);
  lines.push(`- 其中只有 ` + '`scope`' + ` 前置条件的：**${analysis.scopeOnly}** 条（作用域 ≠ 失效条件）`);
  lines.push(`- 标 \`unverified\`（推不出来、不编）：**${analysis.unverified}** 条 · 原因分布 \`${JSON.stringify(analysis.byReason)}\``);
  lines.push('');
  lines.push('## 二 · 抽样 5 条（逐字）');
  lines.push('');
  for (const row of samples) {
    lines.push(`### ${row.id}`);
    lines.push('');
    lines.push('```text');
    lines.push(row.text);
    lines.push('```');
    lines.push('');
    lines.push(`- 形态：\`${JSON.stringify(row.shape)}\` · state=\`${row.state}\` · scope=\`${row.scopeKey}\``);
    lines.push(row.status === 'derived'
      ? `- **可派生的失效条件**：\`${row.clause}\`（来源 \`${row.source}\`）`
      : `- **失效条件**：\`unverified\` —— ${row.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write('用法：node scripts/antipattern-falsifiable.mjs --store <src> [--sample 5] [--json] [--apply --out tmp/<copy>]\n');
    return 0;
  }
  if (flags.error) {
    process.stderr.write(`${flags.error}\n`);
    return 2;
  }
  if (!flags.store) {
    process.stderr.write('缺少 --store\n');
    return 2;
  }
  const storeRoot = path.resolve(flags.store);
  if (!fs.existsSync(storeRoot)) {
    process.stderr.write(`源库不存在：${storeRoot}\n`);
    return 2;
  }
  const store = createStore({ root: storeRoot });
  const claims = store.list('claims').map((r) => r.record).filter(Boolean);
  const analysis = analyzeAntipatterns(claims);
  let applied = null;
  if (flags.apply) {
    try {
      applied = applyToCopy({ srcRoot: storeRoot, outDir: flags.out });
    } catch (error) {
      if (error instanceof AntipatternError) {
        process.stderr.write(`${error.code}: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }
  const samples = sampleRows(analysis.rows, flags.sample);
  if (flags.json) process.stdout.write(`${JSON.stringify({ version: REPORT_VERSION, storeRoot, analysis, samples, applied }, null, 2)}\n`);
  else process.stdout.write(`${renderReport({ analysis, samples, storeRoot })}\n${applied ? `\n副本：${applied.outDir} · 复制 ${applied.copied} 条 · derived ${applied.derived} · unverified ${applied.unverified} · skipped ${applied.skipped}\n` : ''}`);
  return 0;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();

export { main };
