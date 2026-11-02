#!/usr/bin/env node
// 冻结 A2b 评估集（2026-11-02）：把「切点后、且有当年先例」的失败签名固化成快照，
// 以后每次测 A2b 都用同一份集合 —— 分母不再随语料漂移，提升/回归才有可比性。
//
// 用法：
//   node scripts/a2b-set.mjs --freeze   # 生成/覆盖 evidence/a2b-set.json
//   node scripts/a2b-set.mjs --check    # 只打印现有快照的统计，不写盘

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from './eval.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const SPLIT = Date.parse('2026-11-02T00:00:00Z');
const FILE = path.join(REPO, 'evidence', 'a2b-set.json');
const FILE_CROSS = path.join(REPO, 'evidence', 'a2b-set-cross.json');

export function setFromReport(report, splitAt = SPLIT, { onlyCrossScope = false } = {}) {
  const rows = report?.primary?.rows ?? [];
  const prior = new Map();
  const scopeOf = new Map(rows.filter((r) => r && typeof r.episode === 'string').map((r) => [r.episode, r.scopeKey]));
  const items = [];
  for (const row of rows) {
    if (!row || !Number.isFinite(row.startedAt)) continue;
    if (row.startedAt > splitAt) {
      for (const sig of row.repeatSignatures ?? []) {
        const priors = prior.get(sig);
        if (!priors || priors.size === 0) continue;
        const sameScope = [...priors].some((id) => scopeOf.get(id) === row.scopeKey);
        if (onlyCrossScope && sameScope) continue;
        items.push({
          sig,
          scopeKey: row.scopeKey ?? null,
          episode: row.episode,
          prior: [...priors].sort(),
          sameScope,
        });
      }
    } else {
      for (const sig of [...(row.repeatSignatures ?? []), ...(row.novelSignatures ?? [])]) {
        if (!prior.has(sig)) prior.set(sig, new Set());
        prior.get(sig).add(row.episode);
      }
    }
  }
  // 去重：同一 (sig, episode) 只留一条；稳定排序保证快照可复现
  const seen = new Set();
  const unique = items.filter((it) => {
    const key = `${it.sig}\u0000${it.episode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0) || (a.episode < b.episode ? -1 : 1));
  return { version: onlyCrossScope ? 2 : 1, splitAt, createdAt: new Date().toISOString(), onlyCrossScope, count: unique.length, items: unique };
}

export async function buildSet({ dataRoot = HOME, splitAt = SPLIT } = {}) {
  const report = await runEval({ dataRoot, splitAt });
  return setFromReport(report, splitAt);
}

const invoked = process.argv[1] ? import.meta.url === new URL(`file://${path.resolve(process.argv[1]).split(String.fromCharCode(92)).join('/')}`).href : false;
if (invoked) {
  const freeze = process.argv.includes('--freeze');
  const crossOnly = process.argv.includes('--cross');
  const file = crossOnly ? FILE_CROSS : FILE;
  if (!freeze) {
    if (!fs.existsSync(file)) { console.log(`尚未冻结：${file}`); process.exit(2); }
    const set = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`A2b 冻结集${crossOnly ? '（跨项目唯先例）' : ''}：${set.count} 条 · 冻结于 ${set.createdAt} · 同域可达 ${set.items.filter((i) => i.sameScope).length}`);
    process.exit(0);
  }
  const report = await runEval({ dataRoot: HOME, splitAt: SPLIT });
  const set = crossOnly ? setFromReport(report, SPLIT, { onlyCrossScope: true }) : setFromReport(report, SPLIT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(set, null, 2) + String.fromCharCode(10));
  console.log(`已冻结 ${set.count} 条 → ${file}（同域可达 ${set.items.filter((i) => i.sameScope).length}）`);
}
