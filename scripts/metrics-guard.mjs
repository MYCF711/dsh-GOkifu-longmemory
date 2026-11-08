#!/usr/bin/env node
// 指标护栏（本机跑，CI 无语料）：把六轴与 A2b 的关键值钉成门槛，低于门槛直接退出 1。
//
// 用法：node scripts/metrics-guard.mjs [--strict 0.65] [--workspace <dir>] [--json]
// 依赖：本机 $DSH_HOME 的语料与 memory-context（CI 上不跑，入 PR 时用 check.mjs 的结构检查兜底）。
//
// **层级（T236b，2026-11-05 主人改判）**：
//   主判据   = **A2b（召回相关度）** —— 第一门槛：失败立刻红，**排在 A1 之前**（输出顺序也按这层）。
//   约束条件 = A1 负迁移 / A5 越界 / A6 溯源 / A4 p50 —— 任一越界即红。
//   下游参考 = **repeatFailureRate（V1）** —— 仍打印，**不参与 exit code**。
//
// **T7/T27：A1 有三条并列的轴（stale | opposite | redundant），不是替换**：
//   · `A1`（staleTransferRate）—— 原判据，口径与门槛（≤5%）一字不动；
//   · `A1.opposite`（反向记忆率）—— T7 新增，同样 ≤5%；**只有"通电"（可判率 ≥30% 且线上有正样本）
//     才参与 exit code**。线上 0 次触发时它是 0/0（精确率无样本），拿它当通过就是假绿 —— 打印"未通电"。
//   · `A1.redundant`（**会话级**冗余注入）—— T27 新增，两个子指标 `redundantWaste`（两次注入间无压缩 =
//     确定浪费）/ `redundantNecessary`（压缩后必要重注）。**只有 `redundantWaste > 1%` 且"通电"才红** ——
//     它的消费者是 `oncePerSession` 的 `session.id` 判据：waste > 1% ⇒ 查是不是 WeakSet 对象身份那类回归。
//     样本不足（窗口内注入数/token 不到通电下限）⇒ **不参与 exit code**，不硬造数。`scope 级重复`不计入。
//   · 缺轴 ⇒ 红（tombstone：把 `A1.opposite` / `A1.redundant` 的统计删掉，本闸必须红）。
//   `--workspace <dir>`：m5-report 的 workspace scope（worktree 并行时用主工作区，避免 scope 不匹配
//   把 A5/A6 判成 not-consumed）。默认仍是当前目录（行为不变）。
//
// 为什么这样分层：主人 2026-11-05 裁定「应该要保证召回相关度，下沉是 GOkifu 上下文压缩插件的事，
// 不踩坑是上下文压缩该保证的事情」。把**下游结果**当源头验收面就是**指标不可归因**：
// 源头做对也可能被下游浪费，做错也可能被下游兜住 —— 那样的红/绿说明不了源头的好坏。
// 所以 repeatFailureRate 只作参考打印；它是"记忆有没有被用起来"的下游证据，不是本仓的验收面。
//
// 门槛（2026-11-02 基线，改动需在 PR 里说明并更新本文件）：
//   A2b 严格  ≥ 0.55（样本仅 18 条，1 条 = 5.6pp；2026-11-02 观察到同 store 下 0.611–0.667 的跳动）
//   A2b 覆盖  = 1.00（上限参考）
//   A1 负迁移 ≤ 5%（硬上限）· A1.redundant 的浪费 ≤ 1%（只在通电时卡）
//   A5 越界   = 0
//   A6 溯源   = 100%
//   A4 p50    ≤ 50ms
//   repeatFailureRate（V1）—— 只打印，无门槛

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');

// 2026-11-03：除了"绝对下限 0.55"，再加**回归线**（相对冻结基线最多掉 10pp）。
// 只卡下限的话，84.2% 掉到 56% 也算 PASS —— 那是"慢慢烂掉"的典型形态。
// T242：主判据的**考卷基线**（新，n=108 = repeat + self，见 scripts/a2b-holdout.mjs）
//
// 为什么换：旧的 a2bStrictRef=0.8421 来自 **n=19 的 repeat-only 冻结集** —— 那批样本全是
// "后缀局复发了前序局的同一个签名"，是最容易的一类；n=108 的考卷混入了 self（本局自证）题，
// 实测严格命中 37/108 = 34.26%。同一个指标两个数，说明旧基线是**选择偏差**的产物。
//
// 门槛取值：**等于当前实测**（37/108 与 74/108）—— "新考卷的起点，不是目标"：
// 用分数形式写死，避免 0.3426 与 0.342592… 这种四舍五入把真实基线卡在门外的假红。
export const HOLDOUT_BASELINE = Object.freeze({
  n: 118,
  strictHits: 55,
  relatedHits: 94,
  strictMin: 55 / 118, // 46.61%（**保守下界**：同局且 ≥2 判别词；任何下降即红）
  coverMin: 94 / 118, // 79.66%（**内容相关（不限来源局）** = 覆盖）
  // 2026-11-07 重定基线（T362）：
  // ① 口径修正：旧口径 `related = (episode === 该局)` 把"跨局但内容相关"判为不相关（假阴性 32），
  //    把"同局但无关"判为相关（假阳性 17）。改为**内容相关（不限局）** —— 用户要的是"与当前任务相关"。
  // ② 门槛随考卷增长重定：考卷从 114 → 118 题（新局入馆），旧门槛按 114 定会**误报**（今天已红）。
  // **这不是放水**：严格命中仍用**更严的同局口径**（保守下界），覆盖率的误判率另报且不升。
  note: '内容相关口径（不限局）+ 同局严格下界；n=118，门槛 = 当前实测',
});

const LIMITS = {
  a1Max: 0.05,
  // T7：A1 的第二条轴（反向记忆率）与 stale **并列**，同一个 5% 硬上限。
  // 但只有"通电"（`detail.usableForDecision` = 可判率 ≥30% 且线上有正样本）才参与 exit code ——
  // 线上 0 次触发时它是 0/0，不能当通过（见文件头）。
  a1OppositeMax: 0.05,
  // T27：A1 的第三条轴（**会话级**冗余注入）。只有 `redundantWaste` 参与 exit code（necessary 是压缩后
  // 必要重注，不卡）；只有"通电"（窗口样本够）才卡 —— 样本不足时不硬造数（与 opposite 同形状）。
  a1RedundantWasteMax: 0.01,
  a5Max: 0,
  a6Min: 1,
  a4p50MaxMs: 50,
  // 新考卷门槛（T242）：低于当前实测即红 —— 只允许持平或更好
  a2bStrictMin: HOLDOUT_BASELINE.strictMin,
  a2bCoverMin: HOLDOUT_BASELINE.coverMin,
  // 旧口径（sampleSource='report'，n=19 repeat-only）才适用的回归线；新考卷不用它
  a2bStrictRef: 0.8421052631578947,
  a2bStrictDropMax: 0.1,
};

/**
 * @param {object} report         m5-report 的 JSON
 * @param {object} [limits]       门槛
 * @param {{n?:number, strict?:number, cover?:number, sampleSource?:string}|null} [a2bOverride]
 *        T242：主判据的**样本来源**由调用方决定。给了 override 就用它（考卷口径），
 *        否则退回 m5 报告里的 injectionRecall（旧口径，只作对照）。
 */
export function judge(report, limits = LIMITS, a2bOverride = null) {
  const axes = report?.axes ?? report ?? {};
  const fails = [];
  const a1 = axes.A1?.value;
  // m5-report 的 A1.detail.validityCoverage 是对象 {withValidity, rendered, ratio}；
  // 也兼容直接给数字的旧形态。ratio===0 ⇒ 空转（2026-11-02 审计 P1-5）。
  const covRaw = axes.A1?.detail?.validityCoverage ?? axes.A1?.validityCoverage ?? null;
  const a1Coverage = Number.isFinite(covRaw) ? covRaw : (Number.isFinite(covRaw?.ratio) ? covRaw.ratio : null);
  const a1Vacuous = Number.isFinite(a1) && (a1Coverage === null
    ? Boolean(axes.A1?.caveat && String(axes.A1.caveat).includes('空转'))
    : a1Coverage === 0);
  const a5 = axes.A5?.value;
  const a6 = axes.A6?.value;
  const a4 = axes.A4?.value;
  // T7：A1 的第二条轴（反向记忆率）。与 A1.stale **并列**，不是替换 —— 两个都要读、都要打印。
  const a1OppositeAxis = axes['A1.opposite'] ?? null;
  // 只有**带 T7 契约标记**（`a1Axes`）的报告才强制要求这条轴：旧快照 / 单测夹具没有这个字段，
  // 拿新契约去卡旧报告会造成假红（而 lib 的真实报告一定带它 —— m5-report 的 `runM5Body` 写死）。
  const a1OppositeRequired = Array.isArray(report?.a1Axes) && report.a1Axes.includes('A1.opposite');
  const a1Opposite = a1OppositeAxis?.value;
  const a1OppositeDetail = a1OppositeAxis?.detail ?? null;
  const a1OppositeN = Number.isFinite(a1OppositeDetail?.total)
    ? a1OppositeDetail.total
    : (Number.isFinite(a1OppositeAxis?.n) ? a1OppositeAxis.n : null);
  const a1OppositeDecidability = Number.isFinite(a1OppositeDetail?.decidability) ? a1OppositeDetail.decidability : null;
  // "通电" = 可判率达标**且**线上有正样本（`polarityReport` 三件套之外的额外一条，见文件头）
  const a1OppositeDecisionGrade = Boolean(a1OppositeDetail?.usableForDecision);
  // T27：A1 的第三条轴（**会话级**冗余注入）。两个子指标分开读：卡口只看 `redundantWaste`。
  const a1RedundantAxis = axes['A1.redundant'] ?? null;
  // 只有**带 T27 契约标记**（`a1Axes` 里列出）的报告才强制要求这条轴：旧快照/单测夹具没有该标记，
  // 拿新契约去卡旧报告会造成假红（m5-report 的 `runM5Body` 写死 `a1Axes: [...A1_AXIS_IDS]`）。
  const a1RedundantRequired = Array.isArray(report?.a1Axes) && report.a1Axes.includes('A1.redundant');
  const a1RedundantDetail = a1RedundantAxis?.detail ?? null;
  const a1RedundantWaste = a1RedundantAxis?.value;
  const a1RedundantNecessary = Number.isFinite(a1RedundantDetail?.redundantNecessary) ? a1RedundantDetail.redundantNecessary : null;
  // "通电" = 窗口内注入数 / token 数都够（m5-report 的 `detail.powered`）—— 样本不足就不卡，不硬造数。
  const a1RedundantPowered = Boolean(a1RedundantDetail?.powered);
  const a1RedundantN = Number.isFinite(a1RedundantDetail?.injections)
    ? a1RedundantDetail.injections
    : (Number.isFinite(a1RedundantAxis?.n) ? a1RedundantAxis.n : null);
  const recall = axes.A2?.detail?.injectionRecall ?? {};
  // T242：默认来源仍是 m5（旧口径）；调用方给了考卷结果就以考卷为准。
  const strict = a2bOverride && Number.isFinite(a2bOverride.strict) ? a2bOverride.strict : recall.recallSpecific;
  const cover = a2bOverride && Number.isFinite(a2bOverride.cover) ? a2bOverride.cover : recall.recall;
  const a2bN = a2bOverride && Number.isFinite(a2bOverride.n) ? a2bOverride.n : (recall.n ?? null);
  const sampleSource = a2bOverride?.sampleSource ?? (recall.sampleSource ?? 'report');
  // A4.value 的单位就是 ms（m5-report 里 unit:'ms'）；不再乘 1000。
  const p50 = typeof a4 === 'number' ? a4 : null;
  // ── 主判据（第一门槛）：A2b 召回相关度 ──────────────────────────────────
  // 先判它、先记它的失败 —— `fails` 的顺序就是输出的层级（T236b）。
  const main = [];
  if (!Number.isFinite(strict) || strict < limits.a2bStrictMin) main.push(`A2b 严格 ${strict} < ${limits.a2bStrictMin}（sampleSource=${sampleSource} n=${a2bN}）`);
  else if (sampleSource !== 'holdout' && Number.isFinite(limits.a2bStrictRef) && strict < limits.a2bStrictRef - (limits.a2bStrictDropMax ?? 0.1)) {
    main.push(`A2b 严格 ${strict.toFixed(4)} 比冻结基线 ${limits.a2bStrictRef.toFixed(4)} 掉了 ${((limits.a2bStrictRef - strict) * 100).toFixed(1)}pp（>${((limits.a2bStrictDropMax ?? 0.1) * 100).toFixed(0)}pp）`);
  }
  if (!Number.isFinite(cover) || cover < limits.a2bCoverMin) main.push(`A2b 覆盖 ${cover} < ${limits.a2bCoverMin}（sampleSource=${sampleSource} n=${a2bN}）`);

  // ── 约束条件：A1 / A5 / A6 / A4 ────────────────────────────────────────
  const constraints = [];
  if (!Number.isFinite(a1) || a1 > limits.a1Max) constraints.push(`A1 负迁移 ${a1} > ${limits.a1Max}`);
  // T7：A1.opposite —— 与 A1 并列的第二条负迁移轴。
  // ① 缺轴 ⇒ 红（tombstone：删掉这条统计，本闸必须红）；
  // ② 无值 ⇒ 红（没算出来 ≠ 通过，与 A1 同一条纪律）；
  // ③ 只有"通电"（可判率达标 + 有正样本）时才拿 5% 卡它 —— 0/0 的 0% 不是通过，是没通电。
  if (a1OppositeRequired) {
    if (!a1OppositeAxis) constraints.push('A1.opposite 反向记忆率缺失（tombstone：轴统计被删）');
    else if (!Number.isFinite(a1Opposite)) constraints.push(`A1.opposite 反向记忆率无值（n=${a1OppositeN ?? 'null'}；没算出来 ≠ 通过）`);
    else if (a1OppositeDecisionGrade && a1Opposite > limits.a1OppositeMax) {
      constraints.push(`A1.opposite 反向记忆率 ${a1Opposite} > ${limits.a1OppositeMax}（可判率 ${a1OppositeDecidability}）`);
    }
  }
  // T27：A1.redundant —— 与 stale / opposite 并列的第三条轴。
  // ① 缺轴 ⇒ 红（tombstone：删掉这条统计，本闸必须红）；
  // ② 只有"通电"（窗口样本够）才拿 `redundantWaste > 1%` 卡它 —— 样本不足**不参与 exit code**（不硬造数）；
  // ③ `redundantNecessary` **不卡**：压缩后必要重注是设计行为（上界），不是回归。
  if (a1RedundantRequired) {
    if (!a1RedundantAxis) constraints.push('A1.redundant 冗余注入轴缺失（tombstone：轴统计被删）');
    else if (a1RedundantPowered && Number.isFinite(a1RedundantWaste) && a1RedundantWaste > limits.a1RedundantWasteMax) {
      constraints.push(`A1.redundant 冗余浪费 ${a1RedundantWaste} > ${limits.a1RedundantWasteMax}（会话级同卡再投、期间无压缩；窗口 ${a1RedundantN ?? '?'} 次注入）⇒ 查 oncePerSession 的 session.id 判据是否回归`);
    }
  }
  // A1=0 但覆盖率 0 ⇒ 空转：不判失败，但必须显式标注（2026-11-02 审计 P1-5）
  if (!Number.isFinite(a5) || a5 > limits.a5Max) constraints.push(`A5 越界 ${a5} != 0`);
  if (!Number.isFinite(a6) || a6 < limits.a6Min) constraints.push(`A6 溯源 ${a6} < ${limits.a6Min}`);
  if (Number.isFinite(p50) && p50 > limits.a4p50MaxMs) constraints.push(`A4 p50 ${p50.toFixed(2)}ms > ${limits.a4p50MaxMs}ms`);

  // ── 下游参考：repeatFailureRate（V1）—— 只算不红 ───────────────────────
  // 它是"记忆有没有被下游用起来"的证据，不是本仓的验收面（见文件头「指标不可归因」）。
  const repeatFailureRate = Number.isFinite(axes.A2?.value) ? axes.A2.value : null;

  fails.push(...main, ...constraints);
  return {
    ok: fails.length === 0,
    fails,
    // 分层留档：消费方（evidence/metrics-guard.json）能直接看出哪条是主判据的红
    layers: { main, constraints },
    values: {
      a1,
      a1Vacuous,
      a1Coverage,
      // T7：A1 的两条并列轴（stale 在上面，opposite 在这里）
      a1Opposite,
      a1OppositeN,
      a1OppositeDecidability,
      a1OppositeDecisionGrade,
      // T27：A1 的第三条并列轴（会话级冗余；waste 与 necessary 分开报）
      a1Redundant: a1RedundantWaste,
      a1RedundantNecessary,
      a1RedundantPowered,
      a1RedundantN,
      a5,
      a6,
      p50,
      a2bStrict: strict,
      a2bCover: cover,
      a2bN,
      sampleSource,
      repeatFailureRate,
    },
  };
}

/** T242：默认考卷路径（`scripts/a2b-holdout.mjs --json > evidence/a2b-holdout.json` 的产物）。 */
export const DEFAULT_HOLDOUT_PATH = 'evidence/a2b-holdout.json';

/**
 * 读考卷。**fail-closed**：文件不存在就抛错（绝不静默回退到 n=19 的冻结集 ——
 * 那会让主判据继续只考"最容易的一类"，正是 T242 要修的病）。
 * @returns {{n:number, strict:number, cover:number, sampleSource:'holdout', path:string}}
 */
export function loadHoldout(filePath = DEFAULT_HOLDOUT_PATH, { fsImpl = fs } = {}) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(REPO, filePath);
  if (!fsImpl.existsSync(abs)) {
    throw new Error(`考卷不存在：${abs}（先跑 node scripts/a2b-holdout.mjs --json > ${DEFAULT_HOLDOUT_PATH}）`);
  }
  const exam = JSON.parse(fsImpl.readFileSync(abs, 'utf8'));
  const n = Number(exam?.n);
  const strictHits = Number(exam?.strictHits);
  const relatedHits = Number(exam?.relatedHits);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(strictHits)) {
    throw new Error(`考卷格式不对（缺 n / strictHits）：${abs}`);
  }
  return {
    n,
    strict: Number.isFinite(exam?.strictRate) ? exam.strictRate : strictHits / n,
    // T362：覆盖率**优先用"内容相关（不限来源局）"口径**。
    // 旧口径 `related = (episode === 该局)` 已被证明**两个方向都错**（假阴性 32 + 假阳性 17），
    // 继续拿它当门槛 = 守着一把错的尺子。考卷里没有 contentRate 时才回退旧口径（老快照）。
    cover: Number.isFinite(exam?.contentRate) ? exam.contentRate
      : (Number.isFinite(exam?.contentHits) ? exam.contentHits / n
      : (Number.isFinite(exam?.relatedRate) ? exam.relatedRate : (Number.isFinite(relatedHits) ? relatedHits / n : null))),
    sampleSource: 'holdout',
    path: abs,
  };
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const strictIdx = argv.indexOf('--strict');
  const limits = { ...LIMITS };
  if (strictIdx >= 0 && Number.isFinite(Number(argv[strictIdx + 1]))) limits.a2bStrictMin = Number(argv[strictIdx + 1]);
  const json = argv.includes('--json');
  // T242：主判据默认考卷口径。`--source report` 才退回 m5 报告里的旧口径（对照用）。
  const sourceIdx = argv.indexOf('--source');
  const sourceFlag = sourceIdx >= 0 ? String(argv[sourceIdx + 1] ?? '') : '';
  const useHoldout = sourceFlag !== 'report' && !argv.includes('--no-holdout');
  const holdoutIdx = argv.indexOf('--holdout');
  const holdoutPath = holdoutIdx >= 0 && argv[holdoutIdx + 1]
    ? argv[holdoutIdx + 1]
    : (process.env.KIFU_A2B_HOLDOUT || DEFAULT_HOLDOUT_PATH);
  // T7：worktree 并行时 cwd 的 scope 与库里的主工作区对不上（A5/A6 会落 not-consumed 假红）。
  // `--workspace <dir>`（或 KIFU_M5_WORKSPACE）转发给 m5-report；**不给就仍是当前目录**（默认行为不变）。
  const workspaceIdx = argv.indexOf('--workspace');
  const workspaceFlag = workspaceIdx >= 0 ? String(argv[workspaceIdx + 1] ?? '').trim() : '';
  const m5Workspace = workspaceFlag || String(process.env.KIFU_M5_WORKSPACE ?? '').trim();
  const m5Args = [path.join(REPO, 'scripts/m5-report.mjs'), '--json'];
  if (m5Workspace) m5Args.push('--workspace', path.resolve(m5Workspace));
  // 2026-11-04：本机实测过 m5 --json **间歇性静默死亡**（一次 patrol 里报 "Command failed"，重跑又正常）。
  // 原实现把 m5 的 stderr 吞了、把 JSON.parse 失败和子进程失败混成一句 "采集失败"，等于把可诊断信息丢掉。
  // 现在：分别记 exitCode / stderr / stdout 尾部，落 tmp/m5-raw.json 供事后看；只对"exit≠0 且 stderr 为空"
  // 这种静默死亡重试一次（重试很贵，别对真错误反复跑）。
  const collect = async () => {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, m5Args, { cwd: REPO, env: process.env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (error) => resolve({ exitCode: null, stdout, stderr: `${stderr}${String(error?.message ?? error)}` }));
      child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
    });
    const tail = (text, n = 600) => String(text ?? '').trim().slice(-n);
    let report = null;
    let parseError = null;
    try { report = JSON.parse(r.stdout); } catch (error) { parseError = String(error?.message ?? error); }
    return { ...r, report, parseError, tail };
  };
  // 考卷缺失 ⇒ 立刻红（fail-closed）：不去跑 m5、也不回退到 n=19 的冻结集。
  let holdout = null;
  if (useHoldout) {
    try {
      holdout = loadHoldout(holdoutPath);
    } catch (error) {
      const msg = String(error?.message ?? error);
      console.error('metrics-guard FAIL');
      console.error(`ERR ${msg}`);
      try {
        fs.mkdirSync(path.join(REPO, 'evidence'), { recursive: true });
        fs.writeFileSync(path.join(REPO, 'evidence/metrics-guard.json'), JSON.stringify({ at: new Date().toISOString(), ok: false, fails: [msg], sampleSource: 'holdout-missing' }, null, 2) + '\n');
      } catch { /* 证据写失败不影响判定 */ }
      process.exit(1);
    }
  }
  let got = await collect();
  if (!got.report && got.exitCode !== 0 && !got.tail(got.stderr)) {
    console.error('metrics-guard: m5 静默死亡（exit≠0 且 stderr 为空），重试一次…');
    got = await collect();
  }
  if (!got.report) {
    try {
      fs.mkdirSync(path.join(REPO, 'tmp'), { recursive: true });
      fs.writeFileSync(path.join(REPO, 'tmp/m5-raw.json'), `${got.stdout ?? ''}`);
      fs.writeFileSync(path.join(REPO, 'tmp/m5-raw.stderr.txt'), `${got.stderr ?? ''}`);
    } catch { /* 证据写失败不影响报错 */ }
    console.error(`metrics-guard: 采集失败 · exit=${got.exitCode ?? 'n/a'}${got.parseError ? ` · JSON 解析：${got.parseError}` : ''}`);
    if (got.tail(got.stderr)) console.error(`  m5 stderr 尾部：${got.tail(got.stderr)}`);
    if (got.parseError && got.tail(got.stdout)) console.error(`  m5 stdout 尾部：${got.tail(got.stdout, 300)}`);
    console.error('  原始输出已落 tmp/m5-raw.json 与 tmp/m5-raw.stderr.txt');
    process.exit(2);
  }
  const report = got.report;
  const verdict = judge(report, limits, holdout ? { n: holdout.n, strict: holdout.strict, cover: holdout.cover, sampleSource: holdout.sampleSource } : null);
  const out = { at: new Date().toISOString(), root: HOME, limits, ...verdict };
  try {
    fs.mkdirSync(path.join(REPO, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(REPO, 'evidence/metrics-guard.json'), JSON.stringify(out, null, 2) + '\n');
  } catch { /* 证据写失败不影响判定 */ }
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    // 输出顺序 = 层级（T236b）：主判据 → 约束条件 → 下游参考。
    const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'n/a');
    console.log(`metrics-guard ${verdict.ok ? 'PASS' : 'FAIL'}`);
    console.log(`  主判据 · A2b 召回相关度（sampleSource=${out.values.sampleSource}，n=${out.values.a2bN}）：严格=${pct(out.values.a2bStrict)} 覆盖=${pct(out.values.a2bCover)}`);
    console.log(`  约束条件 · A1=${out.values.a1}${out.values.a1Vacuous ? '（空转：validity 覆盖 0）' : ''} A5=${out.values.a5} A6=${out.values.a6} A4.p50=${Number.isFinite(out.values.p50) ? out.values.p50.toFixed(2) + 'ms' : 'n/a'}`);
    // T7：A1 的两条并列轴（stale 在上面那一行，opposite 在这里）。"未通电"必须显式打出来 —— 别把 0/0 当通过。
    console.log(`  A1 三轴 · A1.stale=${pct(out.values.a1)} A1.opposite=${pct(out.values.a1Opposite)}（可判率 ${pct(out.values.a1OppositeDecidability)}，n=${out.values.a1OppositeN ?? 'null'}，${out.values.a1OppositeDecisionGrade ? '已通电·参与 exit code' : '未通电·不参与 exit code（0 次触发 ≠ 无反向记忆）'}）`);
    // T27：A1.redundant（会话级冗余）。两个子指标分开打印；"未通电"必须显式打出来，别把 0/0 当通过。
    console.log(`    A1.redundant=浪费 ${pct(out.values.a1Redundant)} · 必要重注 ${pct(out.values.a1RedundantNecessary)}（会话级同卡再投；n=${out.values.a1RedundantN ?? 'null'}，${out.values.a1RedundantPowered ? '已通电·参与 exit code（浪费 > 1% 才红）' : '未通电·不参与 exit code（窗口样本不足）'}）`);
    console.log(`  下游参考 · repeatFailureRate=${pct(out.values.repeatFailureRate)}（V1 · 不参与 exit code）`);
    for (const f of verdict.fails) console.error(`ERR ${f}`);
  }
  process.exit(verdict.ok ? 0 : 1);
}
