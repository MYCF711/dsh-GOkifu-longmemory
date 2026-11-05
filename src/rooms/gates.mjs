// R13 gates —— 十道闸 + 边界审计（M4 补齐：0/1/2/2b/3/4/5/6/6b/7 + boundary）
//
// 契约：方案.md §6.3（十道闸）、§5.1–§5.4（晋升/反例/失效/裁决）、docs/记忆的职责边界.md §5、
//       docs/数据契约.md §4.7/§7.2/§7.3、AGENTS §11 R13。
// 职责：**只判**，不改写、不修复、不重排 —— 输入一张记忆卡（+ 可选记录/裁决/本局证据），输出 `{ok, errors[]}`。
// 任一失败 ⇒ `ok:false`，errors 逐条列明（gate / code / detail）；判不了的进 `checks.unverified`（不假装合规）。
//
// 十道闸（编号取方案 §6.3，边界审计单列 `boundary`）：
//   0  时间戳前置   每条有 occurredAt、渲染日期 = occurredAt 的绝对日期（UTC）、provenance(episode+seq) 与行一致
//   1  作用域       条目 scopeKey == 当前 scope 或其显式祖先（`u:` 用户层 / `w:` 路径前缀）
//   2  支撑门槛     state 与 support/counter 计数匹配（support<2 不得 candidate；counter≥1 不得 promoted…）
//   2b 裁决独立性   裁决记录里不得有共享 contextId 的计入票；阈值与一致度一致；可回放
//   3  有效+适用条件 validity 必须核过；核不过/前置条件不满足 ⇒ 只能给指针（不许展开正文）
//   4  只增不改     被覆盖必须带 supersedes + supersededAtSeq；不许悬挂覆盖；同文重复必须有覆盖链
//   5  来源纪律     每条断言有 quote 且能对上 support(episode,seq)；quote 不得被篡改、不得来自摘要
//   6  预算与省略   ≤500 tokens、≤5 条、provenance 覆盖率=1、省略显式（计数 + 去哪取）
//   6b 相关闸       不命中零注入；每个 hit 带 `why`；深度 ≤2
//   7  事后降级     本局否定证据出现 ⇒ standard/semantic→disputed、candidate→observed、≥2 次→invalidated；
//                   已降级的条目不得再按高状态渲染正文
//   边界  指令式/许可/工具治理片段一律拒（方案 §7.2 纪律 1、边界 §2/§5）
//
// 纯函数：不读时钟、不写盘、不调模型。只有显式传入 `store` 时才读它（只读 get）。
// 正则与行格式从 R12 inject 单源引入；裁决口径从 R10 adjudicate 单源引入 —— 两处都不复制规则。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  BUDGET_TOKENS,
  ENTRY_LIMIT,
  GOVERNANCE_PATTERNS,
  IMPERATIVE_PATTERNS,
  INDEX_LINE_RE,
  PROVENANCE_LINE_RE,
  auditImperatives,
  estimateTokens,
  formatCardDate,
  isScopeVisible,
  normalizeScopeKey,
} from './inject.mjs';
import {
  DEFAULT_THRESHOLD,
  MIN_MEMBERS,
  independenceCheck,
  replayAdjudication,
  validateAdjudication,
} from './adjudicate.mjs';

// 2026-11-04（0.138.0）：`auditImperatives` 已搬到 inject（创建卡片时按行过滤要用同一份实现），
// 这里重新导出，保持 gates 的对外面不变（测试与 CLI 都从这里取）。
export { auditImperatives };

/** 本仓库启用的闸（顺序 = 报告顺序）。M4 起十道全开。 */
export const ACTIVE_GATES = Object.freeze(['0', '1', '2', '2b', '3', '4', '5', '6', '6b', '7', 'boundary']);

/** 尚未启用的闸：**空**（十道全在位）。保留导出，避免调用方按旧接口 panic。 */
export const PENDING_GATES = Object.freeze([]);

export const GATE_DOCS = Object.freeze({
  0: '闸 0 时间戳前置：occurredAt + 绝对日期 + provenance(episode,seq) 齐备且与渲染行一致（方案 §6.3）',
  1: '闸 1 作用域：条目 scopeKey = 当前 scope 或其显式祖先（u: / w: 路径前缀），其余不可见（方案 §4.10/§6.3）',
  2: '闸 2 支撑门槛：state 与 support/counter 匹配（support≥2 才 candidate、≥3 才 semantic/standard、counter≥1 ⇒ disputed、≥2 ⇒ invalidated）',
  '2b': '闸 2b 裁决独立性：计入票不得共享 contextId；promote 必须过阈值且 ≥2 名成员；记录可回放',
  3: '闸 3 有效性与适用条件：validity/preconditions 必须核过；核不过只给指针（方案 §5.3/§6.3 F7）',
  4: '闸 4 只增不改：被覆盖必须 supersedes + supersededAtSeq；不许悬挂覆盖；同文重复必须有覆盖链（方案 §5.2）',
  5: '闸 5 来源纪律：每条断言有 quote 且对得上 support(episode,seq)；quote 不得篡改、不得来自摘要（方案 §6.3 F5）',
  6: '闸 6 预算与省略：≤500 tokens、≤5 条、provenance 覆盖率=1、省略显式（方案 §6.3 F6）',
  '6b': '闸 6b 相关闸：不命中零注入、每个 hit 带 why、深度 ≤2（方案 §6.3 F8）',
  7: '闸 7 事后降级：本局否定证据 ⇒ standard/semantic→disputed、candidate→observed、≥2 次→invalidated（方案 §6.3）',
  boundary: '边界闸：注入文本里不得出现指令式/许可/建议片段，也不得出现工具治理痕迹（边界 §2/§5）',
});

// ---------------------------------------------------------------------------
// 闸 1 作用域：显式祖先可见，默认不可见（判据在 R12，与"注入前过滤"同一份实现）
// ---------------------------------------------------------------------------

/** `D:\Work\Demo` / `w:D:/Work` → `w:d:/Work`；`u:Owner` → `u:owner`（与 R00 episode.scopeKey 同口径）。 */
export const normalizeScope = normalizeScopeKey;

export { isScopeVisible };

// ---------------------------------------------------------------------------
// 闸 2 支撑门槛 / 闸 7 事后降级：状态机（与 R09/R08 的口径一致，方案 §5.1）
// ---------------------------------------------------------------------------

export const SUPPORT_CANDIDATE = 2; // ≥2 局独立支撑 ⇒ candidate
export const SUPPORT_STANDARD = 3; // ≥3 局 ⇒ semantic/standard（或 2 局 + 一次复用）
export const COUNTER_DISPUTED = 1; // counter ≥1 ⇒ disputed（不得 promoted）
export const COUNTER_INVALIDATE = 2; // counter ≥2 ⇒ invalidated

export const CLAIM_STATES = Object.freeze(['observed', 'candidate', 'semantic', 'standard', 'disputed', 'invalidated', 'stale']);
export const JOSEKI_STATES = Object.freeze(['candidate', 'standard', 'deprecated', 'superseded']);

/**
 * 支撑/反例计数 → 允许的状态集合。纯机械（方案 §5.1 晋升阶梯 / §5.2 反例优先）。
 * @param {{support?:number, counter?:number, reused?:boolean, strongCounter?:boolean, kind?:string}} p
 * @returns {{allowed:string[], reasons:string[]}}
 */
export function allowedStates({ support = 0, counter = 0, reused = false, strongCounter = false, kind = 'claim' } = {}) {
  const s = Number.isFinite(support) ? support : 0;
  const c = Number.isFinite(counter) ? counter : 0;
  const reasons = [];

  // 反例优先（方案 §5.2）：有反例就不得是断言态
  if (c >= COUNTER_INVALIDATE || strongCounter) {
    reasons.push(`counter=${c}${strongCounter ? ' + 强反例' : ''} ⇒ invalidated`);
    return { allowed: kind === 'joseki' ? ['superseded', 'deprecated'] : ['invalidated'], reasons };
  }
  if (c >= COUNTER_DISPUTED) {
    reasons.push(`counter=${c} ⇒ disputed`);
    return { allowed: kind === 'joseki' ? ['deprecated'] : ['disputed'], reasons };
  }
  if (kind === 'joseki') {
    if (s >= SUPPORT_STANDARD || (s >= SUPPORT_CANDIDATE && reused)) {
      return { allowed: ['candidate', 'standard', 'deprecated', 'superseded'], reasons };
    }
    if (s >= SUPPORT_CANDIDATE) return { allowed: ['candidate', 'superseded'], reasons: [`support=${s} ⇒ 至多 candidate`] };
    return { allowed: ['superseded'], reasons: [`support=${s} < ${SUPPORT_CANDIDATE} ⇒ 不许 candidate`] };
  }
  if (s >= SUPPORT_STANDARD || (s >= SUPPORT_CANDIDATE && reused)) {
    return { allowed: ['observed', 'candidate', 'semantic', 'standard', 'invalidated', 'stale'], reasons };
  }
  if (s >= SUPPORT_CANDIDATE) {
    return { allowed: ['observed', 'candidate', 'invalidated', 'stale'], reasons: [`support=${s} ⇒ 至多 candidate`] };
  }
  return { allowed: ['observed', 'invalidated', 'stale'], reasons: [`support=${s} < ${SUPPORT_CANDIDATE} ⇒ 至多 observed`] };
}

/** 检查一条 claim/定式记录的 state 与计数是否匹配；匹配返回 null。 */
export function supportStateViolation(record) {
  if (!record || typeof record !== 'object') return { code: 'gate2/record-invalid', detail: null };
  const kind = String(record.id ?? '').startsWith('j-') ? 'joseki' : 'claim';
  const states = kind === 'joseki' ? JOSEKI_STATES : CLAIM_STATES;
  const state = record.state;
  if (!states.includes(state)) return { code: 'gate2/unknown-state', detail: { state: state ?? null, kind, allowed: [...states] } };
  const { allowed, reasons } = allowedStates({
    support: Array.isArray(record.support) ? record.support.length : 0,
    counter: Array.isArray(record.counter) ? record.counter.length : 0,
    reused: record.reused === true || Number(record.reuseCount) > 0,
    strongCounter: record.strongCounter === true,
    kind,
  });
  if (!allowed.includes(state)) {
    return {
      code: 'gate2/state-over-claim',
      detail: {
        id: record.id ?? null,
        state,
        support: Array.isArray(record.support) ? record.support.length : 0,
        counter: Array.isArray(record.counter) ? record.counter.length : 0,
        allowed,
        reasons,
      },
    };
  }
  return null;
}

/**
 * 闸 7 的降级函数（机械，方案 §6.3 闸 7）：本局否定一次 ⇒ 降一档；连续 ≥2 次 ⇒ invalidated。
 * 只算"该降到的状态"，不改写记录（改写是落账方的事）。
 */
export function downgradeState(state, negations = 1) {
  const n = Number(negations);
  if (!Number.isFinite(n) || n <= 0) return state;
  if (n >= 2) return 'invalidated';
  switch (state) {
    case 'standard':
    case 'semantic':
      return 'disputed';
    case 'candidate':
      return 'observed';
    case 'disputed':
      return 'invalidated';
    default:
      return state; // observed / invalidated / stale 保持
  }
}

/** 降级后还能出现在注入里的标记（正文 = 断言；指针 = 只给事实）。 */
export function allowedMarkersAfterDowngrade(expected) {
  switch (expected) {
    case 'observed':
      return ['observed', 'disputed', 'invalidated', 'stale'];
    case 'disputed':
      return ['disputed', 'invalidated', 'stale'];
    case 'invalidated':
      return ['invalidated', 'stale'];
    case 'stale':
      return ['stale'];
    default:
      return [expected];
  }
}

// ---------------------------------------------------------------------------
// 闸 5 来源纪律：摘要标记（自证污染的机械特征，陷阱 11 / 方案 F5）
// ---------------------------------------------------------------------------

/** 会主张内容的 claim 类型（闸 5 只对这类行要 quote）。 */
export const CLAIM_KINDS = Object.freeze(['fact', 'rule', 'antipattern', 'preference', 'pattern']);

export const SUMMARY_MARKERS = Object.freeze(['<compacted-summary>', '<chess-fold>', '<kifu-summary>', '<fold-summary>']);

export function looksLikeSummary(text) {
  const s = String(text ?? '').toLowerCase();
  return SUMMARY_MARKERS.some((m) => s.includes(m));
}

// ---------------------------------------------------------------------------
// 闸 3 的真核验（validity probes）
//
// 契约：方案 §5.3「能机械核的才核，核不了的不装」——file（存在 + 可选 hash/mtime）、
//       version（读 package.json 比 version）、commit（`git cat-file -e`）、none（不核）。
// 分工：**本文件只负责"怎么核"**（`probeValidity` / `runValidityCheck`）；
//       `runGates` 本身仍然不读盘 —— 核验结果由调用方传进 `validityResults`，
//       没传就记 unverified（不假装合规）。
// 纪律：单条失败只记 reason，**绝不抛**（一个坏 claim 不该让整次核验失败）。
// ---------------------------------------------------------------------------

export const VALIDITY_TYPES = Object.freeze(['none', 'file', 'version', 'commit']);

// T158（2026-11-05）闸 3 探针的两个语义修正：
//   ① `file` 有**方向位** `validity.expect: 'exists' | 'missing'`（缺省 exists；旧记录靠
//      `preconditions:[{check:'file-exists', value:<同一路径>}]` 推断 missing，见 expectedExistenceOf）。
//      证据写「该路径不存在」的记忆，文件出现才 stale（`file-appeared`）。
//   ② `version` **读不到包 ⇒ 未核验**（`unverified:true`），不是失效；只有真读到且版本不符才 stale。
//      查找面：validity.file → claim 自己的 workspace（node_modules/<name>/package.json、package.json）
//      → `<DSH_HOME>/profiles/*/node_modules/<name>/package.json` → `<DSH_HOME>/profiles/*/workspace/package.json`。
//   结果形状：`{ok, unverified?, reason, ...}`；`runValidityCheck.summary` 把 `failed`（真 stale）与
//   `unverified`（核不了）分开计数；闸 3 对 `unverified` 记 `gate3/validity-unverified`，不判红。

/** 结果键（`claims:c-…` / `joseki:j-…`）：脚本、eval、plugin 三处共用同一口径。 */
export function validityKeyOf(record) {
  const id = typeof record?.id === 'string' ? record.id : '';
  if (!id) return '';
  return `${id.startsWith('j-') ? 'joseki' : 'claims'}:${id}`;
}

function sha256OfFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 默认探针（真实 IO；测试可整体替换）。 */
export const REAL_PROBE = Object.freeze({
  stat: (p) => {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  },
  readJson: (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
  readDir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
  sha256: (p) => sha256OfFile(p),
  gitHasCommit: (sha, cwd) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * 记录里的路径 → 磁盘路径。两种历史写法都要认：
 *   · Windows 原生：`d:/workspace/…`、`D:\workspace\…`
 *   · Git Bash 风格：`/d/workspace/…`（真实语料里确实这么写）⇒ 还原成 `d:/workspace/…`
 * 相对路径按 workspace 解析。
 */
export function resolveValidityPath(value, workspace) {
  let raw = String(value ?? '').trim();
  if (raw === '') return '';
  if (/^\/[A-Za-z]\//.test(raw)) raw = `${raw.slice(1, 2)}:${raw.slice(2)}`; // /d/a/b → d:/a/b
  if (/^[A-Za-z]:[\\/]/.test(raw)) return path.normalize(raw.replace(/\//g, path.sep));
  if (path.isAbsolute(raw)) return path.normalize(raw);
  if (!workspace) return '';
  return path.resolve(String(workspace), raw);
}

/**
 * 记录自己所属的工作区（scopeKey = `w:<path>`）：**每条按自己的作用域核**，
 * 避免"拿 A 工作区的基准去核 B 工作区的记忆"。`fallback` 只在记录没有 scopeKey 时用。
 */
export function workspaceOf(record, fallback = null) {
  const scope = typeof record?.scopeKey === 'string' ? record.scopeKey.trim() : '';
  if (scope.startsWith('w:')) {
    const tail = scope.slice(2);
    if (tail && tail !== 'unknown' && tail !== '<unknown>') return path.normalize(tail.replace(/\//g, path.sep));
  }
  return fallback ? path.resolve(String(fallback)) : null;
}

/** `pkg@1.2.3` → `{name, version}`；不是这种形态返回 null。 */
export function parsePackageAtVersion(value) {
  const raw = String(value ?? '').trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0) return null;
  const name = raw.slice(0, at);
  const version = raw.slice(at + 1);
  if (!name || !version || /\s/.test(raw)) return null;
  if (!/^(?:@[^/@\s]+\/)?[^@/\s]+$/.test(name)) return null;
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) return null;
  return { name, version };
}

function resolveInWorkspace(value, workspace) {
  return resolveValidityPath(value, workspace);
}

/**
 * `type:'file'` 的**期望方向**：`'exists'`（默认：此刻文件应在）或 `'missing'`（此刻文件应**不存在**）。
 *
 * 为什么需要它（2026-11-05 T158）：同一个 `type:'file'` 承载了两种相反语义 ——
 *   · ENOENT 派生的 fact：证据是「该路径不存在」，文件**出现**才失效（`claim.mjs` 的 why 原文）；
 *   · 普通文件 fact：证据是「该文件在此，内容哈希/mtime 如何」，文件**消失**才失效。
 * 旧记录没有 `expect` 字段。`claim.mjs` 给 ENOENT 派生的 fact 同时写了
 * `preconditions:[{check:'file-exists', value:<同一路径>}]`，这条前置条件就是 missing 的机械标记
 * （名字叫 file-exists，语义却是"该路径出现即不再成立"）⇒ 旧记录按 missing 判，其余默认 exists。
 * 显式 `expect` 永远优先（新 writer 写 `expect:'missing'`）。
 * @returns {'exists'|'missing'|string} 非法值原样返回，由调用方判红（不静默降级）。
 */
export function profilePackageCandidates(parsed, home, io) {
  if (!parsed || !home) return [];
  const profilesDir = path.join(String(home), 'profiles');
  const out = [];
  for (const name of io.readDir(profilesDir)) {
    const entry = String(name ?? '');
    if (!entry || entry.startsWith('.')) continue;
    const dir = path.join(profilesDir, entry);
    out.push(path.join(dir, 'node_modules', ...String(parsed.name).split('/'), 'package.json'));
    out.push(path.join(dir, 'workspace', 'package.json'));
  }
  return out;
}

export function expectedExistenceOf(record, validity = null) {
  const v = validity && typeof validity === 'object' ? validity : record?.validity;
  const raw = typeof v?.expect === 'string' ? v.expect.trim().toLowerCase() : '';
  if (raw === 'exists' || raw === 'missing') return raw;
  if (raw !== '') return raw; // 未知取值：交给 probe 报 file-bad-expect
  const value = String(v?.value ?? '');
  const pres = Array.isArray(record?.preconditions) ? record.preconditions : [];
  if (value && pres.some((p) => p && p.check === 'file-exists' && String(p.value ?? '') === value)) return 'missing';
  return 'exists';
}

/**
 * 核一条记录的 validity。**永不抛**：任何异常都变成 `{ok:false, reason}`。
 *
 * @param {object} record  claim / joseki 记录（用 `validity` 字段）
 * @param {{workspace?:string, now?:number, probe?:object}} [opts]
 * @returns {{type:string, value:any, ok:boolean, reason:string|null, checkedAt:number,
 *            exists?:boolean, actual?:any, expected?:any, path?:string}}
 */
export function probeValidity(record, { workspace = null, now = null, probe = null, dshHome = null } = {}) {
  const checkedAt = Number.isFinite(now) ? Number(now) : Date.now();
  const validity = record?.validity && typeof record.validity === 'object' ? record.validity : null;
  const type = typeof validity?.type === 'string' ? validity.type : 'none';
  const value = validity?.value ?? null;
  const base = { type, value, checkedAt };

  if (!VALIDITY_TYPES.includes(type)) {
    return { ...base, ok: false, reason: `unknown-validity-type:${type}` };
  }
  if (type === 'none') {
    return { ...base, ok: true, reason: null };
  }

  const io = { ...REAL_PROBE, ...(probe && typeof probe === 'object' ? probe : {}) };
  // 版本族放宽查找面时用；未显式传就取宿主环境（只读）
  const home = typeof dshHome === 'string' && dshHome !== '' ? dshHome : (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : null);
  try {
    if (type === 'file') {
      const file = resolveInWorkspace(value, workspace);
      if (!file) return { ...base, ok: false, reason: 'file-needs-workspace' };
      const expect = expectedExistenceOf(record, validity);
      if (expect !== 'exists' && expect !== 'missing') {
        return { ...base, ok: false, reason: 'file-bad-expect', path: file, expect };
      }
      const st = io.stat(file);
      const exists = Boolean(st && st.isFile());
      if (expect === 'missing') {
        // 证据时刻「此路径不存在」⇒ 不存在=ok；文件出现了才 stale（mtime/sha256 不参与：方向位只看存在性）
        if (!exists) return { ...base, ok: true, reason: null, path: file, exists: false, expect };
        return { ...base, ok: false, reason: 'file-appeared', path: file, exists: true, expect, expected: 'missing', actual: 'present' };
      }
      if (!exists) return { ...base, ok: false, reason: 'file-missing', path: file, exists: false, expect, expected: 'exists', actual: 'missing' };
      const wantMtime = Number.isFinite(validity?.mtimeMs) ? Number(validity.mtimeMs) : null;
      if (wantMtime !== null && Math.abs(st.mtimeMs - wantMtime) > 2) {
        return { ...base, ok: false, reason: 'file-mtime-changed', path: file, expected: wantMtime, actual: st.mtimeMs };
      }
      const wantHash = typeof validity?.sha256 === 'string' && validity.sha256.trim() !== '' ? validity.sha256.trim().toLowerCase() : null;
      if (wantHash) {
        const actual = String(io.sha256(file)).toLowerCase();
        if (actual !== wantHash) {
          return { ...base, ok: false, reason: 'file-hash-changed', path: file, expected: wantHash, actual };
        }
      }
      return { ...base, ok: true, reason: null, path: file, exists: true, expect };
    }

    if (type === 'version') {
      const raw = String(value ?? '').trim();
      const parsed = parsePackageAtVersion(raw);
      const expected = parsed ? parsed.version : raw;
      // 候选文件（T158b）：显式 validity.file > claim 自己的 workspace
      //   > <DSH_HOME>/profiles/*/node_modules/<name>/package.json > <DSH_HOME>/profiles/*/workspace/package.json
      const candidates = [];
      if (typeof validity?.file === 'string' && validity.file.trim() !== '') {
        candidates.push(resolveInWorkspace(validity.file, workspace));
      }
      if (parsed && workspace) {
        candidates.push(path.resolve(String(workspace), 'node_modules', parsed.name, 'package.json'));
        candidates.push(path.resolve(String(workspace), 'package.json'));
      }
      candidates.push(resolveInWorkspace('package.json', workspace));
      candidates.push(...profilePackageCandidates(parsed, home, io));
      const files = [...new Set(candidates.filter(Boolean))];
      if (!files.length) return { ...base, ok: false, reason: 'version-needs-workspace' };

      let readAny = false;
      let nameMatched = false;
      for (const file of files) {
        let pkg;
        try {
          pkg = io.readJson(file);
        } catch {
          continue; // 这个候选不存在，换下一个
        }
        readAny = true;
        // 带包名时，必须同名才算（否则就是拿错 package.json 糊弄）
        const sameName = !parsed || typeof pkg?.name !== 'string' || pkg.name === parsed.name;
        if (parsed && typeof pkg?.name === 'string' && pkg.name !== parsed.name) continue;
        if (sameName) nameMatched = true;
        const actual = typeof pkg?.version === 'string' ? pkg.version.trim() : null;
        if (actual === null) continue;
        if (actual !== expected) {
          return { ...base, ok: false, reason: 'version-mismatch', path: file, package: parsed?.name ?? pkg?.name ?? null, expected, actual };
        }
        return { ...base, ok: true, reason: null, path: file, package: parsed?.name ?? pkg?.name ?? null, expected, actual };
      }
      // 读不到包 ≠ 失效（T158b）：返回「未核验」，闸 3 记 unverified、不判红。
      // 只有**真读到且版本不符**才是 stale（版本判据一字不改）。
      if (!readAny) return { ...base, ok: false, unverified: true, reason: 'version-file-unreadable', expected, package: parsed?.name ?? null };
      if (parsed && !nameMatched) return { ...base, ok: false, unverified: true, reason: 'version-package-not-found', expected, package: parsed.name };
      return { ...base, ok: false, unverified: true, reason: 'version-field-missing', expected, package: parsed?.name ?? null, actual: null };
    }

    // commit
    const sha = String(value ?? '').trim();
    if (!workspace) return { ...base, ok: false, reason: 'commit-needs-workspace' };
    if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) return { ...base, ok: false, reason: 'commit-bad-sha', expected: sha };
    const found = io.gitHasCommit(sha, String(workspace));
    return { ...base, ok: found === true, reason: found === true ? null : 'commit-not-found', expected: sha };
  } catch (error) {
    return { ...base, ok: false, reason: `probe-error:${String(error?.message ?? error)}` };
  }
}

/**
 * 批量核验（脚本 / eval / plugin 共用）。
 * @param {{records?:any, workspace?:string, now?:number, probe?:object}} opts
 *   records：数组，或 `{claims:[…], joseki:[…]}`
 * @returns {{results:Object<string,object>, summary:object}}
 */
export function runValidityCheck({ records = null, workspace = null, now = null, probe = null, dshHome = null } = {}) {
  const claims = Array.isArray(records?.claims) ? records.claims : (Array.isArray(records) ? records : []);
  const joseki = Array.isArray(records?.joseki) ? records.joseki : [];
  const results = {};
  const summary = { total: 0, checked: 0, ok: 0, failed: 0, unverified: 0, skipped: 0, byType: {}, failures: [], unverifiedList: [] };

  for (const record of [...claims, ...joseki]) {
    const key = validityKeyOf(record);
    if (!key) continue;
    const type = typeof record?.validity?.type === 'string' ? record.validity.type : 'none';
    if (type === 'none') {
      summary.skipped += 1;
      continue;
    }
    summary.total += 1;
    summary.byType[type] = (summary.byType[type] ?? 0) + 1;
    // 每条按**自己**的作用域核（scopeKey = w:<path>），没有 scopeKey 才退回调用方的基准
    const recordWorkspace = workspaceOf(record, workspace);
    const result = probeValidity(record, { workspace: recordWorkspace, now, probe, dshHome });
    result.workspace = recordWorkspace;
    results[key] = result;
    if (result.ok) summary.ok += 1;
    else if (result.unverified === true) {
      // 「核不了」不算失效（T158b）：单独计数，不混进 failed
      summary.unverified += 1;
      summary.unverifiedList.push({ key, type, reason: result.reason, expected: result.expected ?? null, path: result.path ?? null });
    } else {
      summary.failed += 1;
      summary.failures.push({ key, type, reason: result.reason, expected: result.expected ?? null, actual: result.actual ?? null, path: result.path ?? null });
    }
    summary.checked += 1;
  }

  return { results, summary };
}

// ---------------------------------------------------------------------------
// 记录解析（可选：把 claims/joseki/episodes 记录喂进来才能做 1/2/3/4/5/7）
// ---------------------------------------------------------------------------

export function buildResolver({ records = null, store = null, cache = null } = {}) {
  const buckets = { claims: new Map(), joseki: new Map(), episodes: new Map() };
  const put = (kind, record, fallbackId = null) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    const id = typeof record.id === 'string' && record.id ? record.id : fallbackId;
    if (typeof id === 'string' && id) buckets[kind].set(id, record);
  };
  const addAll = (kind, src) => {
    if (!src) return;
    if (src instanceof Map) {
      for (const [k, v] of src) put(kind, v, k);
      return;
    }
    if (Array.isArray(src)) {
      for (const r of src) put(kind, r);
      return;
    }
    if (typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) put(kind, v, k);
    }
  };
  const typed = records
    && typeof records === 'object'
    && !Array.isArray(records)
    && !(records instanceof Map)
    && ['claims', 'joseki', 'episodes'].some((k) => k in records);
  if (typed) {
    addAll('claims', records.claims);
    addAll('joseki', records.joseki);
    addAll('episodes', records.episodes);
  } else {
    addAll('claims', records);
  }
  const storeOk = Boolean(store && typeof store.get === 'function');
  return {
    size: () => buckets.claims.size + buckets.joseki.size + buckets.episodes.size,
    available: () => storeOk || (buckets.claims.size + buckets.joseki.size + buckets.episodes.size) > 0,
    claims: () => [...buckets.claims.values()],
    get(kind, id) {
      if (typeof id !== 'string' || !id) return null;
      if (buckets[kind]?.has(id)) return buckets[kind].get(id);
      if (cache && typeof cache.get === 'function') {
        try {
          const hit = cache.get(kind, id);
          if (hit) return hit;
        } catch { /* 缓存不可用就退回 store */ }
      }
      if (storeOk) {
        try {
          return store.get(kind, id) ?? null;
        } catch {
          return null;
        }
      }
      return null;
    },
  };
}

const recordKindOf = (id) => (String(id ?? '').startsWith('j-') ? 'joseki' : (String(id ?? '').startsWith('ep-') ? 'episodes' : 'claims'));

/** 卡片条目的语义状态（R12 的 entry.state 是 claim 状态；手工卡可能只有 marker）。 */
const stateOf = (entry) => {
  if (typeof entry?.state === 'string' && entry.state) return entry.state;
  if (typeof entry?.marker === 'string' && entry.marker) return entry.marker;
  return null;
};

// ---------------------------------------------------------------------------
// 边界扫描
// ---------------------------------------------------------------------------

/** 扫描工具治理痕迹（`permission: allow` 之类本不该出现在记忆卡里）。 */
export function auditGovernance(text) {
  const s = String(text ?? '');
  const out = [];
  for (const re of GOVERNANCE_PATTERNS) {
    const m = re.exec(s);
    if (m) out.push({ pattern: String(re), match: m[0] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 合并节点（T162b）：合并节点自己不算重复，成员也不因它而被判重复/状态不符
// ---------------------------------------------------------------------------

/** 合并节点（带 `merge.members`）的成员 id 列表；不是合并节点 ⇒ null。 */
function mergeMemberIds(record) {
  const members = Array.isArray(record?.merge?.members) ? record.merge.members : null;
  if (!members) return null;
  const ids = members.filter((x) => typeof x === 'string' && x.trim() !== '');
  return ids.length ? ids : null;
}

/**
 * 合并节点在闸 2 里的上限：合并节点是"成员证据并集"的产物，不能按它自己那条 support 的条数判。
 * 上限 = 成员的允许态并集 ∪ 并集支撑（`merge.supportEpisodes`）对应的允许态。
 * 成员一条也取不到 ⇒ `resolved: 0`，调用方按记录自身 state 放行并记 `merged-unverified`。
 */
function mergedStateCap(record, resolver) {
  const members = mergeMemberIds(record);
  if (!members) return null;
  const kind = String(record?.id ?? '').startsWith('j-') ? 'joseki' : 'claim';
  const allowed = new Set();
  let resolved = 0;
  for (const id of members) {
    const member = resolver.get(recordKindOf(id), id);
    if (!member) continue;
    resolved += 1;
    const memberKind = String(member?.id ?? '').startsWith('j-') ? 'joseki' : 'claim';
    const verdict = allowedStates({
      support: Array.isArray(member.support) ? member.support.length : 0,
      counter: Array.isArray(member.counter) ? member.counter.length : 0,
      reused: member.reused === true || Number(member.reuseCount) > 0,
      strongCounter: member.strongCounter === true,
      kind: memberKind,
    });
    for (const st of verdict.allowed) allowed.add(st);
  }
  const episodes = Array.isArray(record?.merge?.supportEpisodes) ? record.merge.supportEpisodes.length : 0;
  const unionSupport = episodes > 0 ? episodes : (Array.isArray(record.support) ? record.support.length : 0);
  const own = allowedStates({
    support: unionSupport,
    counter: Array.isArray(record.counter) ? record.counter.length : 0,
    reused: record.reused === true || Number(record.reuseCount) > 0,
    strongCounter: record.strongCounter === true,
    kind,
  });
  for (const st of own.allowed) allowed.add(st);
  return { resolved, allowed };
}

/** 两条记录是不是"合并关系"：A 是 B 的成员 / B 是 A 的成员 / 两个合并节点成员有交集。 */
function isMergeRelated(a, b) {
  const am = new Set(mergeMemberIds(a) ?? []);
  const bm = new Set(mergeMemberIds(b) ?? []);
  if (am.has(b?.id) || bm.has(a?.id)) return true;
  if (am.size === 0 || bm.size === 0) return false;
  for (const id of am) if (bm.has(id)) return true;
  return false;
}

/**
 * T162c：**成员侧反指针** `mergedInto: '<合并节点 id>'`。
 *
 * 为什么需要：T162b 只让"合并节点 ↔ 成员"免于 gate4 —— 但当**两个成员彼此同文**、
 * 合并节点本身没上卡时，成员身上没有任何信息说明它们属于同一合并组，仍会判重复、整卡打回。
 * 规则（与合流侧契约一致）：
 *   · 两条同文记录的 `mergedInto` 是同一个非空字符串 ⇒ 同一合并组（**组由记录自己证明**，
 *     不需要合并节点在场）⇒ 不判重复；
 *   · 该合并节点取不到 ⇒ 仍然不判红，只把这一对计入 `checks.merged.unresolved`（可观测，不阻塞）；
 *   · 只有一条带指针 / 空串 / 指向不同节点 ⇒ **不是**合并关系，判据一字不改。
 *
 * @returns {{related:boolean, unresolved:boolean}}
 */
function mergeRelationOf(a, b, resolver) {
  if (isMergeRelated(a, b)) return { related: true, unresolved: false, unverified: null };
  const am = typeof a?.mergedInto === 'string' ? a.mergedInto.trim() : '';
  const bm = typeof b?.mergedInto === 'string' ? b.mergedInto.trim() : '';
  if (!am || am !== bm) return { related: false, unresolved: false, unverified: null };
  // T198（audit-12 安全洞）：**自证豁免**。原来只比字符串相等就放行 —— 任何数据写同一个 id
  // （哪怕节点不存在 / 不是合并节点 / members 不含双方）就能让闸 4 永不报重复。
  // 现在必须三条同时成立：① 节点存在 ② 它确实是合并节点（members 非空）③ members 同时含这两条。
  const node = resolver && typeof resolver.get === 'function' ? resolver.get(recordKindOf(am), am) : null;
  if (!node) return { related: false, unresolved: true, unverified: 'missing-node' };
  const members = Array.isArray(node?.merge?.members)
    ? node.merge.members.filter((x) => typeof x === 'string' && x)
    : [];
  if (!members.length) return { related: false, unresolved: false, unverified: 'not-merge-node' };
  const hasA = members.includes(String(a?.id ?? ''));
  const hasB = members.includes(String(b?.id ?? ''));
  if (!hasA || !hasB) return { related: false, unresolved: false, unverified: 'members-mismatch' };
  return { related: true, unresolved: false, unverified: null };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function stringOf(v) {
  return typeof v === 'string' ? v : '';
}

function sectionLines(section) {
  return String(section ?? '').split('\n');
}

/**
 * 跑闸。**只读**输入，不做修复。
 *
 * @param {object} p
 * @param {object} p.card            R12 `buildMemoryCard()` 的输出
 * @param {object} [p.walkResult]    R11 walk 结果（缺省跳过闸 6b 的命中/深度检查）
 * @param {any}    [p.records]       claims/joseki/episodes 记录（Map | 数组 | {id:record} | {claims,joseki,episodes}）
 * @param {object} [p.store]         R15 createStore()（只读；给了 records 可以不传）
 * @param {string} [p.scope]         当前 scopeKey（闸 1）
 * @param {Array}  [p.adjudications] R10 裁决记录（闸 2b）
 * @param {Array}  [p.evidence]      本局否定证据 `[{claimId, episode, seq, quote}]`（闸 7）
 * @param {object} [p.validityResults]    `{"claims:c-…": {ok:boolean, reason?:string}}`（闸 3 真核验结果，`runValidityCheck` 的产物）
 * @param {object} [p.validityChecks]     `{[claimId]: {ok:boolean, reason?:string}}`（闸 3 旧参数，保留兼容）
 * @param {object} [p.preconditionChecks] `{[claimId]: {ok:boolean, results?:Array}}`（闸 3）
 * @param {number} [p.limit]         条数上限（默认 5）
 * @param {number} [p.budgetTokens]  token 预算（默认 500）
 * @param {boolean}[p.strict]        true ⇒「判不了」也算失败（默认 false：记 checks.unverified，不假装合规）
 * @returns {{ok:boolean, errors:Array<{gate:string, code:string, detail:any}>, checks:object}}
 */
export function runGates({
  card = null,
  walkResult = null,
  records = null,
  store = null,
  cache = null,
  scope = null,
  adjudications = [],
  evidence = [],
  validityChecks = null,
  validityResults = null,
  preconditionChecks = null,
  limit = ENTRY_LIMIT,
  budgetTokens = BUDGET_TOKENS,
  strict = false,
} = {}) {
  const errors = [];
  const push = (gate, code, detail = null) => errors.push({ gate, code, detail });
  const checks = {
    claims: 0,
    lines: 0,
    tokens: 0,
    hits: 0,
    scannedStrings: 0,
    omitted: 0,
    adjudications: 0,
    evidence: 0,
    scopeChecked: 0,
    supportChecked: 0,
    validityChecked: 0,
    immutabilityChecked: 0,
    provenanceChecked: 0,
    downgradeChecked: 0,
    unverified: [],
    merged: {
      total: 0,
      skippedGate4: 0,
      skippedGate2: 0,
      unverified: 0,
      unresolved: 0,
      unverifiedRefs: 0, // T198：mergedInto 自证不成立、被照报的对数
      unverifiedRefReasons: {}, // T198：按原因分开（missing-node / not-merge-node / members-mismatch）
    },
    byGate: { 0: 0, 1: 0, 2: 0, '2b': 0, 3: 0, 4: 0, 5: 0, 6: 0, '6b': 0, 7: 0, boundary: 0 },
  };
  /** 判不了的：非 strict 记 unverified（不假装合规），strict 直接失败。 */
  const unverified = (gate, code, count, reason) => {
    if (!count) return;
    if (strict) push(gate, code, { count, reason, unverified: true });
    else checks.unverified.push({ gate, code, count, reason });
  };

  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    push('0', 'card/missing', 'runGates 需要 R12 buildMemoryCard() 的 card 对象');
    return { ok: false, errors, checks };
  }

  const claims = Array.isArray(card.claims) ? card.claims : [];
  const section = typeof card.section === 'string' ? card.section : null;
  checks.claims = claims.length;
  const resolver = buildResolver({ records, store, cache });

  // ---------------------------------------------------------------- 闸 0（时间戳前置）
  const indexLine = typeof card.indexLine === 'string' ? card.indexLine.trim() : '';
  if (!indexLine) push('0', 'gate0/missing-index-line', '首轮那行 INDEX 指针缺失');
  else if (!INDEX_LINE_RE.test(indexLine)) push('0', 'gate0/index-line-shape', { indexLine });

  claims.forEach((c, i) => {
    const claim = c && typeof c === 'object' ? c : {};
    if (!Number.isFinite(claim.occurredAt)) {
      push('0', 'gate0/missing-occurred-at', { index: i, claimId: claim.claimId ?? null, text: typeof claim.text === 'string' ? claim.text.slice(0, 80) : null });
    }
    const src = claim.source && typeof claim.source === 'object' ? claim.source : null;
    if (!src) {
      push('0', 'gate0/missing-provenance', { index: i, text: typeof claim.text === 'string' ? claim.text.slice(0, 80) : null });
    } else {
      if (typeof src.episode !== 'string' || !src.episode) push('0', 'gate0/missing-episode', { index: i });
      if (!Number.isFinite(src.seq)) push('0', 'gate0/missing-seq', { index: i, episode: src.episode ?? null });
    }

    const line = typeof claim.line === 'string' ? claim.line : '';
    const m = PROVENANCE_LINE_RE.exec(line);
    if (!m) {
      push('0', 'gate0/line-not-provenanced', { index: i, line: line || null });
      return;
    }
    const [, , , epId, date, seq] = m;
    if (!Number.isFinite(claim.occurredAt)) return; // 已记 missing-occurred-at
    const expectedDate = formatCardDate(claim.occurredAt);
    if (date !== expectedDate) push('0', 'gate0/date-mismatch', { index: i, rendered: date, expected: expectedDate });
    if (src && typeof src.episode === 'string' && epId !== src.episode) {
      push('0', 'gate0/episode-mismatch', { index: i, rendered: epId, expected: src.episode });
    }
    if (src && Number.isFinite(src.seq) && Number(seq) !== Number(src.seq)) {
      push('0', 'gate0/seq-mismatch', { index: i, rendered: Number(seq), expected: Number(src.seq) });
    }
  });

  if (section !== null) {
    const trimmed = section.trim();
    if (!trimmed.startsWith('<memory-ledger>') || !trimmed.endsWith('</memory-ledger>')) {
      push('0', 'gate0/section-shape', '展开段必须是 <memory-ledger>…</memory-ledger>');
    }
    const lines = sectionLines(section);
    const entryLines = lines.filter((l) => l.startsWith('- '));
    checks.lines = entryLines.length;
    if (entryLines.length !== claims.length) {
      push('0', 'gate0/section-line-count', { lines: entryLines.length, claims: claims.length });
    }
    entryLines.forEach((line, i) => {
      if (!PROVENANCE_LINE_RE.test(line)) push('0', 'gate0/section-line-not-provenanced', { index: i, line });
    });
    const stray = lines.filter((l) => l.trim() !== '' && !l.startsWith('<') && !l.startsWith('- ') && !l.startsWith('#') && !l.startsWith('omitted:'));
    if (stray.length) push('0', 'gate0/stray-section-line', { lines: stray.slice(0, 3) });
  } else if (claims.length > 0) {
    push('0', 'gate0/claims-without-section', { claims: claims.length });
  }

  // ---------------------------------------------------------------- 闸 1（作用域）
  const currentScope = normalizeScope(scope);
  let scopeUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    const episodeId = typeof c.source?.episode === 'string' ? c.source.episode : null;
    const record = claimId ? resolver.get(recordKindOf(claimId), claimId) : null;
    const episode = !record && episodeId ? resolver.get('episodes', episodeId) : null;
    const holder = record ?? episode;
    if (!holder) {
      scopeUnresolved += 1;
      continue;
    }
    const entryScope = holder.scopeKey;
    if (typeof entryScope !== 'string' || entryScope.trim() === '') {
      push('1', 'gate1/entry-scope-missing', { index: i, claimId, episode: episodeId });
      continue;
    }
    if (!currentScope) {
      scopeUnresolved += 1;
      continue;
    }
    if (!isScopeVisible(entryScope, currentScope)) {
      push('1', 'gate1/scope-mismatch', { index: i, claimId, entryScope: normalizeScope(entryScope), scope: currentScope });
    } else {
      checks.scopeChecked += 1;
    }
  }
  if (!currentScope) unverified('1', 'gate1/scope-unknown', claims.length, '未提供当前 scopeKey');
  else unverified('1', 'gate1/record-unresolved', scopeUnresolved, '条目记录不可解析（未给 records/store）');

  // ---------------------------------------------------------------- 闸 2（支撑门槛）
  let supportUnresolved = 0;
  const mergedSeen = new Set();
  for (let i = 0; i < claims.length; i += 1) {
    const claimId = typeof claims[i]?.claimId === 'string' ? claims[i].claimId : null;
    const record = claimId ? resolver.get(recordKindOf(claimId), claimId) : null;
    if (!record) {
      if (claimId) supportUnresolved += 1;
      continue;
    }
    checks.supportChecked += 1;
    // T162b：合并节点的状态由成员机械决定，不按它自己那条 support 的条数判。
    const mergedCap = mergedStateCap(record, resolver);
    if (mergedCap) {
      if (!mergedSeen.has(record.id)) {
        mergedSeen.add(record.id);
        checks.merged.total += 1;
      }
      if (mergedCap.resolved === 0) {
        // 成员都取不到 ⇒ 判不了：按记录自身 state 放行，并如实记 merged-unverified（不假装核过）。
        checks.merged.unverified += 1;
        continue;
      }
      if (mergedCap.allowed.has(record.state)) {
        checks.merged.skippedGate2 += 1;
        continue;
      }
    }
    const violation = supportStateViolation(record);
    if (violation) push('2', violation.code, { index: i, ...violation.detail });
  }
  unverified('2', 'gate2/record-unresolved', supportUnresolved, '条目记录不可解析（未给 records/store）');
  unverified('2', 'gate2/merged-unverified', checks.merged.unverified, '合并节点的成员记录不可解析（按记录自身 state 放行）');

  // ---------------------------------------------------------------- 闸 2b（裁决独立性）
  const adjudicationList = Array.isArray(adjudications) ? adjudications : (adjudications ? [adjudications] : []);
  checks.adjudications = adjudicationList.length;
  for (const record of adjudicationList) {
    const shape = validateAdjudication(record);
    for (const e of shape.errors) {
      const code = e.code === 'adjudication/shared-context'
        ? 'gate2b/shared-context'
        : (e.code === 'adjudication/missing' ? 'gate2b/record-missing' : 'gate2b/invalid-record');
      push('2b', code, { adjudicationId: record?.id ?? null, ...e });
    }
    if (shape.errors.length === 0) {
      const replay = replayAdjudication(record);
      if (!replay.ok) push('2b', 'gate2b/not-replayable', { adjudicationId: record.id, diffs: replay.diffs });
    }
    const thr = Number.isFinite(record?.threshold) ? record.threshold : DEFAULT_THRESHOLD;
    if (record?.decision === 'promote') {
      if (!(Number.isFinite(record.agreement) && record.agreement >= thr)) {
        push('2b', 'gate2b/threshold-violation', { adjudicationId: record?.id ?? null, agreement: record?.agreement ?? null, threshold: thr });
      }
      if (!(Number.isFinite(record.n) && record.n >= MIN_MEMBERS)) {
        push('2b', 'gate2b/single-member-promote', { adjudicationId: record?.id ?? null, n: record?.n ?? null });
      }
    }
    if (Array.isArray(record?.votes)) {
      const ind = independenceCheck(record.votes);
      if (!ind.ok) push('2b', 'gate2b/shared-context', { adjudicationId: record?.id ?? null, shared: ind.shared });
    }
  }

  // ---------------------------------------------------------------- 闸 3（有效性 + 适用条件）
  let validityUnresolved = 0;
  let validityUnverified = 0;
  /**
   * 取一条记录的 validity 核验结果，三个都认：
   *   1) `validityResults["claims:c-…"]`（gates-check / eval / plugin 的标准口径）
   *   2) `validityResults["c-…"]`（扁平写法，兼容手搓）
   *   3) `validityChecks["c-…"]`（M4 的旧参数，保留）
   */
  const validityResultOf = (record, claimId) => {
    const key = validityKeyOf(record);
    const fromResults = validityResults && typeof validityResults === 'object' ? validityResults : null;
    if (fromResults && key && fromResults[key]) return fromResults[key];
    if (fromResults && claimId && fromResults[claimId]) return fromResults[claimId];
    if (validityChecks && typeof validityChecks === 'object' && claimId && validityChecks[claimId]) return validityChecks[claimId];
    return null;
  };
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    const record = claimId ? resolver.get(recordKindOf(claimId), claimId) : null;
    if (!record) continue;
    const validity = record.validity && typeof record.validity === 'object' ? record.validity : null;
    const validityType = validity?.type ?? 'none';
    const preconditions = Array.isArray(record.preconditions) ? record.preconditions : [];
    const state = stateOf(c);
    const isPointer = typeof c.kind === 'string' && c.kind === 'pointer';

    if (validityType !== 'none') {
      const check = validityResultOf(record, claimId);
      if (!check || typeof check.ok !== 'boolean') {
        validityUnresolved += 1;
      } else if (check.unverified === true) {
        // 探针读不到（包不存在/读不了）⇒ 核不了 ≠ 失效（T158b）：记 unverified，不判红
        validityUnverified += 1;
      } else {
        checks.validityChecked += 1;
        if (check.ok === false) {
          if (state !== 'stale') push('3', 'gate3/stale-not-marked', { index: i, claimId, validity: validityType, state: state ?? null, reason: check.reason ?? null });
          else if (!isPointer) push('3', 'gate3/stale-rendered', { index: i, claimId, validity: validityType, kind: c.kind ?? null });
        }
      }
    }
    if (preconditions.length > 0) {
      const check = preconditionChecks && typeof preconditionChecks === 'object' ? preconditionChecks[claimId] : null;
      if (!check || typeof check.ok !== 'boolean') {
        validityUnresolved += 1;
      } else if (check.unverified === true) {
        validityUnverified += 1;
      } else {
        checks.validityChecked += 1;
        if (check.ok === false) {
          if (state !== 'stale') {
            push('3', 'gate3/precondition-failed', {
              index: i,
              claimId,
              state: state ?? null,
              failed: Array.isArray(check.failed) ? check.failed : null,
              results: Array.isArray(check.results) ? check.results.filter((r) => r && r.ok === false) : null,
            });
          } else if (!isPointer) {
            push('3', 'gate3/precondition-failed', { index: i, claimId, state, kind: c.kind ?? null, onlyPointerAllowed: true });
          }
        }
      }
    }
  }
  unverified('3', 'gate3/validity-unverified', validityUnverified, '探针读不到（包/文件不可读 ⇒ 核不了 ≠ 失效；T158b）');
  unverified('3', 'gate3/validity-unchecked', validityUnresolved, '带 validity/preconditions 的条目没有核验结果（未给 validityResults/validityChecks；先跑 scripts/gates-check.mjs）');

  // ---------------------------------------------------------------- 闸 4（只增不改）
  const renderedRecords = [];
  let immutabilityUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    if (!claimId) continue;
    const record = resolver.get(recordKindOf(claimId), claimId);
    if (!record) {
      immutabilityUnresolved += 1;
      continue;
    }
    renderedRecords.push({ index: i, record });
    const supersededBy = record.supersededBy ?? (record.state === 'superseded' ? (record.supersedes ?? true) : null);
    if (supersededBy && !Number.isFinite(record.supersededAtSeq)) {
      push('4', 'gate4/missing-superseded-at', { index: i, claimId, supersededBy });
    }
    if (record.supersedes) {
      const target = resolver.get(recordKindOf(record.supersedes), record.supersedes);
      if (!target) push('4', 'gate4/dangling-supersedes', { index: i, claimId, supersedes: record.supersedes });
    }
    if (supersededBy) {
      const state = stateOf(c);
      const kind = typeof c.kind === 'string' ? c.kind : null;
      if (kind !== 'pointer' && !['stale', 'invalidated', 'disputed', 'superseded'].includes(state)) {
        push('4', 'gate4/superseded-rendered', { index: i, claimId, state: state ?? null, supersededBy });
      }
    }
  }
  // 同文重复（同 kind + 同 scope + 同规范化文本）却没有覆盖链 ⇒ 冲突必须显式（只增不改）
  const byBody = new Map();
  for (const { index, record } of renderedRecords) {
    if (typeof record.text !== 'string') continue;
    const key = `${record.kind ?? ''}\u0000${normalizeScope(record.scopeKey)}\u0000${record.text.replace(/\s+/g, ' ').trim()}`;
    if (!byBody.has(key)) byBody.set(key, []);
    byBody.get(key).push({ index, record });
  }
  for (const group of byBody.values()) {
    if (group.length < 2) continue;
    // 兜底去重（T155）：按 record.id 先去重。**同一个 id 在一张卡里出现两次不是"重复条目"** ——
    // 那是同一条断言的两个出处（R12 侧 T154 已按 claimId 去重，这里再兜一层）；
    // 去重后不足 2 个不同 id ⇒ 不构成"未标 supersedes 的重复"。
    const ids = [...new Set(group.map((g) => g.record.id))];
    if (ids.length < 2) continue;
    const idSet = new Set(ids);
    const linked = group.some((g) => g.record.supersedes && idSet.has(g.record.supersedes))
      || group.some((g) => g.record.supersededBy && idSet.has(g.record.supersededBy));
    if (linked) continue;
    // T162b：合并节点与它的成员同文不算"未标覆盖"的重复；两个合并节点成员有交集同理。
    // 其余判据（不同 id 同文且无覆盖链）一字不改：豁免只作用于**合并关系**覆盖到的那些行。
    const exempt = new Set();
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        if (group[a].record.id === group[b].record.id) continue;
        // T162c：既认"合并节点 ↔ 成员"（T162b），也认**成员侧反指针** mergedInto（两条同组即豁免）。
        const relation = mergeRelationOf(group[a].record, group[b].record, resolver);
        if (relation.unresolved) checks.merged.unresolved += 1;
        if (relation.unverified) {
          // 自证不成立：**只计数、照样报重复**（不静默放行），按原因分开记，便于事后定位数据问题
          checks.merged.unverifiedRefs += 1;
          checks.merged.unverifiedRefReasons[relation.unverified] = (checks.merged.unverifiedRefReasons[relation.unverified] ?? 0) + 1;
        }
        if (relation.related) {
          exempt.add(group[a].record.id);
          exempt.add(group[b].record.id);
        }
      }
    }
    if (exempt.size > 0) checks.merged.skippedGate4 += exempt.size;
    const rest = group.filter((g) => !exempt.has(g.record.id));
    const restIds = [...new Set(rest.map((g) => g.record.id))];
    if (restIds.length < 2) continue;
    // detail.ids 给**去重后的唯一 id 列表**（排查时不该看到同一个 id 重复两遍）
    push('4', 'gate4/unsuperseded-duplicate', { ids: restIds, indexes: rest.map((g) => g.index) });
  }
  unverified('4', 'gate4/record-unresolved', immutabilityUnresolved, '条目记录不可解析（未给 records/store）');
  checks.immutabilityChecked = renderedRecords.length;

  // ---------------------------------------------------------------- 闸 5（来源纪律）
  let provenanceUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    const kind = typeof c.kind === 'string' ? c.kind : null;
    // 只有"主张断言"的行才要 quote：R12 的 claim 行带 claimId 或 claim 系 kind（fact/rule/…），
    // 其余是棋谱指针行（failure/constraint/pointer，只给这一局命中过什么），不主张内容。
    const asserting = Boolean(claimId) || CLAIM_KINDS.includes(kind);
    if (!asserting) continue;

    const record = claimId ? resolver.get(recordKindOf(claimId), claimId) : null;
    const cardQuote = typeof c.source?.quote === 'string' ? c.source.quote : null;
    const episode = typeof c.source?.episode === 'string' ? c.source.episode : null;
    const seq = Number.isFinite(c.source?.seq) ? Number(c.source.seq) : null;

    if (!record) {
      // 没有记录可核：至少要求卡片自带 quote（结构检查），否则就是"无源"
      if (!cardQuote || cardQuote.trim() === '') {
        if (claimId) provenanceUnresolved += 1;
        else push('5', 'gate5/missing-quote', { index: i, claimId, episode, seq });
      } else {
        checks.provenanceChecked += 1;
        if (looksLikeSummary(cardQuote)) push('5', 'gate5/summary-source', { index: i, claimId, episode, seq });
      }
      continue;
    }

    checks.provenanceChecked += 1;
    const support = Array.isArray(record.support) ? record.support : [];
    const entry = support.find((s) => s && String(s.episode) === String(episode) && Number(s.seq) === Number(seq)) ?? null;
    if (!entry) {
      push('5', 'gate5/provenance-not-in-support', {
        index: i,
        claimId,
        episode,
        seq,
        support: support.map((s) => ({ episode: s?.episode ?? null, seq: s?.seq ?? null })),
      });
      continue;
    }
    const recordQuote = stringOf(entry.quote);
    if (recordQuote.trim() === '') {
      push('5', 'gate5/missing-quote', { index: i, claimId, episode, seq });
      continue;
    }
    if (looksLikeSummary(recordQuote)) push('5', 'gate5/summary-source', { index: i, claimId, episode, seq });
    if (cardQuote && cardQuote.trim() !== '' && !recordQuote.includes(cardQuote.trim())) {
      push('5', 'gate5/quote-tampered', { index: i, claimId, episode, seq });
    }
  }
  unverified('5', 'gate5/record-unresolved', provenanceUnresolved, '条目记录不可解析（未给 records/store）');

  // ---------------------------------------------------------------- 闸 6（预算与省略）
  if (!Number.isFinite(card.tokens)) {
    push('6', 'gate6/missing-tokens', 'card.tokens 必须是数字（预算要有可核的数）');
  } else {
    checks.tokens = card.tokens;
    const recomputed = estimateTokens(stringOf(card.indexLine)) + estimateTokens(section ?? '');
    if (card.tokens !== recomputed) push('6', 'gate6/token-mismatch', { declared: card.tokens, recomputed });
    if (card.tokens > budgetTokens) push('6', 'gate6/budget-exceeded', { tokens: card.tokens, budget: budgetTokens });
  }
  if (claims.length > limit) push('6', 'gate6/over-limit', { claims: claims.length, limit });

  const covered = claims.filter((c) => c?.source
    && typeof c.source.episode === 'string' && c.source.episode
    && Number.isFinite(c.source.seq)
    && Number.isFinite(c?.occurredAt)).length;
  if (claims.length > 0 && covered !== claims.length) {
    push('6', 'gate6/provenance-coverage', { covered, total: claims.length, rate: covered / claims.length });
  }

  const omittedCount = Number.isFinite(card.omittedCount) ? card.omittedCount : null;
  if (omittedCount !== null) checks.omitted = omittedCount;
  if (omittedCount !== null && omittedCount > 0) {
    const omissions = card.omissions;
    if (typeof omissions !== 'string' || !/omitted:\s*\d+/i.test(omissions)) {
      push('6', 'gate6/omission-hidden', { omittedCount, omissions: typeof omissions === 'string' ? omissions : null });
    } else if (!/index\.md/i.test(omissions)) {
      push('6', 'gate6/omission-no-pointer', { omissions });
    }
  }
  if (typeof card.omissions === 'string' && card.omissions !== '' && !/index\.md/i.test(card.omissions)) {
    push('6', 'gate6/omission-no-pointer', { omissions: card.omissions });
  }

  // ---------------------------------------------------------------- 闸 6b（相关闸）
  if (walkResult && typeof walkResult === 'object') {
    const hits = Array.isArray(walkResult.hits) ? walkResult.hits : [];
    checks.hits = hits.length;
    const depth = Number.isFinite(walkResult.depth) ? walkResult.depth : (Number.isFinite(walkResult.maxDepth) ? walkResult.maxDepth : 2);
    if (depth > 2) push('6b', 'gate6b/depth-exceeded', { depth, max: 2 });
    if (hits.length === 0 && section !== null) {
      push('6b', 'gate6b/zero-hit-injection', { hits: 0, sectionTokens: estimateTokens(section) });
    }
    if (hits.length === 0 && claims.length > 0) {
      push('6b', 'gate6b/claims-without-hits', { claims: claims.length });
    }
    hits.forEach((h, i) => {
      const why = h?.why;
      const hasWhy = Array.isArray(why)
        ? why.filter((x) => typeof x === 'string' && x.trim() !== '').length > 0
        : (typeof why === 'string' && why.trim() !== '');
      if (!hasWhy) push('6b', 'gate6b/missing-why', { index: i, episode: h?.episode ?? null });
      if (Number.isFinite(h?.depth) && h.depth > 2) push('6b', 'gate6b/hit-depth-exceeded', { index: i, depth: h.depth });
      if (typeof h?.episode !== 'string' || !h.episode) push('6b', 'gate6b/hit-without-episode', { index: i });
    });
  }

  // ---------------------------------------------------------------- 闸 7（事后降级）
  const evidenceList = Array.isArray(evidence) ? evidence : (evidence ? [evidence] : []);
  checks.evidence = evidenceList.length;
  const negations = new Map();
  for (const item of evidenceList) {
    const claimId = typeof item?.claimId === 'string' ? item.claimId : null;
    if (!claimId) continue;
    if (!negations.has(claimId)) negations.set(claimId, []);
    negations.get(claimId).push(item);
  }
  let downgradeUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    if (!claimId) continue;
    const record = resolver.get(recordKindOf(claimId), claimId);
    const list = negations.get(claimId) ?? [];
    // 只按**本局新证据**降级：记录里已有的 counter 已经体现在它的 state 上（那由闸 2 核），
    // 再拿来做闸 7 就是同一件事数两遍。
    const total = list.length;
    if (total === 0) continue;
    if (!record) {
      downgradeUnresolved += 1;
      continue;
    }
    checks.downgradeChecked += 1;
    const expected = downgradeState(record.state, total);
    const allowed = allowedMarkersAfterDowngrade(expected);
    const state = stateOf(c);
    const kind = typeof c.kind === 'string' ? c.kind : null;
    if (kind === 'pointer' || state === 'stale') continue; // 指针 / 条件已变：不主张断言，合规
    if (!allowed.includes(state)) {
      push('7', 'gate7/not-downgraded', {
        index: i,
        claimId,
        state: record.state ?? null,
        negations: total,
        expected,
        renderedState: state ?? null,
        allowedStates: allowed,
      });
    }
  }
  unverified('7', 'gate7/record-unresolved', downgradeUnresolved, '有否定证据但条目记录不可解析（未给 records/store）');

  // ---------------------------------------------------------------- 边界闸
  // 只扫**模型可见**的字符串：indexLine + section；claims[].text 若已渲染进 section 就不重复扫
  // （同一段违规只报一次），手工拼的卡（text 未进 section）仍然扫得到。
  const scanned = [];
  if (typeof card.indexLine === 'string') scanned.push(card.indexLine);
  if (section !== null) scanned.push(section);
  for (const c of claims) {
    const text = typeof c?.text === 'string' ? c.text : null;
    if (!text) continue;
    if (section !== null && section.includes(text)) continue;
    scanned.push(text);
  }
  checks.scannedStrings = scanned.length;
  const seen = new Set();
  for (const text of scanned) {
    const key = String(text);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const hit of auditImperatives(text)) push('boundary', 'boundary/imperative', hit);
    for (const hit of auditGovernance(text)) push('boundary', 'boundary/tool-governance', hit);
  }

  // ---------------------------------------------------------------- 汇总
  for (const e of errors) {
    if (checks.byGate[e.gate] !== undefined) checks.byGate[e.gate] += 1;
  }

  return { ok: errors.length === 0, errors, checks };
}

export default {
  ACTIVE_GATES,
  PENDING_GATES,
  GATE_DOCS,
  CLAIM_STATES,
  JOSEKI_STATES,
  SUMMARY_MARKERS,
  SUPPORT_CANDIDATE,
  SUPPORT_STANDARD,
  COUNTER_DISPUTED,
  COUNTER_INVALIDATE,
  normalizeScope,
  isScopeVisible,
  allowedStates,
  supportStateViolation,
  downgradeState,
  allowedMarkersAfterDowngrade,
  looksLikeSummary,
  VALIDITY_TYPES,
  validityKeyOf,
  probeValidity,
  runValidityCheck,
  REAL_PROBE,
  buildResolver,
  auditImperatives,
  auditGovernance,
  runGates,
};
