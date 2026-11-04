#!/usr/bin/env node
// A2 配对重放（T114 · 2026-11-04）：**协议先行，执行待批**。
//
// 这份骨架只做三件事，且都零模型调用：
//   ① `--build-set`：从切点之后的重放里机械产出**冻结配对集**（`{sig, scopeKey, episode, prior}`），写 `evidence/a2-pair-set.json`；
//   ② `--dry-run`：校验配对集 + 打印**成本估算**（与 `docs/A2-配对重放协议.md` §2 同一套算式），不调用任何模型；
//   ③ 真跑（`--arm both|mem|nomem`）**当前一律拒绝**：它要起干净会话、按对消耗模型预算，属预算决策，须主人点头。
//
// 判据（跑之前写死，见协议 §1）：Δ = P(避免|带记忆) − P(避免|不带)，配对 McNemar；
//   Δ ≥ +10pp 且 p<0.05 ⇒ 有净收益；±10pp 内 ⇒ 未测出；Δ ≤ −10pp ⇒ 记忆在拖后腿。
//
// 用法：
//   node scripts/a2-pair-replay.mjs --build-set [--limit 20]
//   node scripts/a2-pair-replay.mjs --dry-run [--set evidence/a2-pair-set.json] [--pairs 80]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runEval } from './eval.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';

/** 与 `evidence/a2b-set.json` 同一道切点：只用切点之后的局当考卷，防"考同一张卷子"。 */
export const DEFAULT_SPLIT = Date.parse('2026-11-02T00:00:00Z');
/** 单次会话的 token 估算：DSH 实测中位数 ~40 步 × ~3k tokens/步。 */
export const TOKENS_PER_SESSION = 40 * 3000;

/**
 * 从 runEval 的重放行里挑"在切点之后重复出现过的失败签名"，做成配对任务。
 * 只挑**切点之后、且切点前有先例**的签名（有先例才有"记忆"可注入）。
 */
export function buildPairSet({ report, splitAt = DEFAULT_SPLIT, limit = 20 } = {}) {
  const rows = Array.isArray(report?.primary?.rows) ? report.primary.rows : [];
  const priorEpisodes = new Map();
  const eligible = [];
  for (const row of rows) {
    if (!row || !Number.isFinite(row.startedAt)) continue;
    if (row.startedAt > splitAt) {
      for (const sig of row.repeatSignatures ?? []) {
        if (priorEpisodes.has(sig)) {
          eligible.push({ sig, scopeKey: row.scopeKey, episode: row.episode, prior: [...priorEpisodes.get(sig)] });
        }
      }
    } else {
      for (const sig of [...(row.repeatSignatures ?? []), ...(row.novelSignatures ?? [])]) {
        if (!priorEpisodes.has(sig)) priorEpisodes.set(sig, new Set());
        priorEpisodes.get(sig).add(row.episode);
      }
    }
  }
  // 同一签名只留一条任务（否则配对集会被同一个坑灌满）
  const seen = new Set();
  const items = [];
  for (const e of eligible) {
    if (seen.has(e.sig)) continue;
    seen.add(e.sig);
    items.push(e);
    if (items.length >= limit) break;
  }
  return { version: 1, kind: 'a2-pair-set', splitAt, createdAt: Date.now(), count: items.length, items };
}

/** 成本估算（与协议 §2 同一套算式，单测里被钉住）。 */
export function estimateCost({ pairs, tokensPerSession = TOKENS_PER_SESSION } = {}) {
  const n = Number.isFinite(pairs) && pairs > 0 ? Math.floor(pairs) : 0;
  const perPair = tokensPerSession * 2; // 两臂
  return { pairs: n, tokensPerSession, perPair, total: n * perPair };
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const setPath = path.resolve(REPO, opt('set', 'evidence/a2-pair-set.json'));

  if (argv.includes('--build-set')) {
    const limit = Number(opt('limit', '20'));
    const report = await runEval({ dataRoot: HOME, splitAt: DEFAULT_SPLIT });
    const set = buildPairSet({ report, splitAt: DEFAULT_SPLIT, limit });
    fs.writeFileSync(setPath, `${JSON.stringify(set, null, 2)}\n`);
    console.log(`已生成 ${path.relative(REPO, setPath)}：${set.count} 条任务（切点 ${new Date(set.splitAt).toISOString()}）`);
    const cost = estimateCost({ pairs: set.count });
    console.log(`按本集规模估算成本：${cost.pairs} 对 × ${cost.perPair.toLocaleString()} tokens ≈ **${cost.total.toLocaleString()} tokens**`);
    process.exit(0);
  }

  if (argv.includes('--dry-run')) {
    if (!fs.existsSync(setPath)) { console.error(`没有配对集：${setPath}（先跑 --build-set）`); process.exit(2); }
    const set = JSON.parse(fs.readFileSync(setPath, 'utf8'));
    const pairs = Number(opt('pairs', String(set.count ?? 0)));
    const cost = estimateCost({ pairs });
    console.log('A2 配对重放 · 干跑（不调用任何模型）');
    console.log(`配对集：${path.relative(REPO, setPath)} · ${set.count} 条任务 · 切点 ${new Date(set.splitAt).toISOString()}`);
    console.log(`计划规模 ${cost.pairs} 对（两臂）× 每对 ${cost.perPair.toLocaleString()} tokens ≈ **${cost.total.toLocaleString()} tokens**`);
    console.log('判据（写死在 docs/A2-配对重放协议.md §1，跑完不许改）：');
    console.log('  Δ ≥ +10pp 且 McNemar p<0.05 ⇒ 有净收益；±10pp 内 ⇒ 未测出收益；Δ ≤ −10pp ⇒ 记忆在拖后腿');
    console.log('真跑需要：① 主人对预算的表态；② 能起干净会话（两臂不能共用当前会话）。');
    process.exit(0);
  }

  console.error('真跑（--arm both|mem|nomem）当前未实现：它要起干净会话、按对消耗模型预算，属预算决策。');
  console.error('先跑 --build-set 与 --dry-run；协议见 docs/A2-配对重放协议.md。');
  process.exit(3);
}
