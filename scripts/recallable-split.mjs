// scripts/recallable-split.mjs —— **只读**：把考卷按"有货可召 / 无货可召"分层。
//
// 起因（2026-11-07 实测）：主判据 48.2% 被"无货题"拉低。
//   有货可召的 26 条 **严格命中 26 = 100%**；无货的 88 条里 60% 还是给了卡（噪声）。
//   ⇒ 真正该修的是"**无货时给了噪声**"，不是"召回率不够高"。
//
// 判据（**两种口径都报**，因为"有货"的定义本身敏感）：
//   严（entity）：该局 claim 与信号共享 **≥1 硬实体**（文件路径/错误码/包名/仓库）。
//   宽（token） ：该局 claim 与信号共享 **≥2 判别词**（去停用词后）。
//
// 输出三栏：
//   有货召回率（recallable=true 的严格命中率 + Wilson）
//   无货沉默率（recallable=false 时**卡为空**的比例 + Wilson）—— 应接近 100%
//   无货噪声率（recallable=false 但仍给了卡）—— 应接近 0
//
// 只读：只读 sidecar 与考卷 JSON，不写任何文件。
import fs from 'node:fs';
import path from 'node:path';

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'are', 'was', 'were',
  'error', 'file', 'files', 'node', 'index', 'test', 'tests', 'true', 'false', 'null', 'undefined',
  'then', 'than', 'into', 'your', 'you', 'not', 'but', 'all', 'any', 'can', 'will', 'would', 'should']);

/** 硬实体：文件路径 / 扩展名 / 错误码 / 仓库地址（与 HARD_ENTITY_PATTERNS 同族，保持宽松可复算）。 */
export function hardEntities(text) {
  const out = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(/[A-Za-z]:[\\/][^\s"'`]+/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/[A-Za-z0-9_.\/-]+\.(?:mjs|js|cjs|md|json|go|exe|ts|tsx|yml|yaml|png|cmd)\b/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b(?:ENOENT|EPERM|EACCES|ETIMEDOUT|ECONNREFUSED|TypeError|SyntaxError|ReferenceError|RangeError)\b/g)) out.add(m[0]);
  return out;
}

/** 判别词：≥4 字符的小写 token，去停用词。 */
export function discriminatingTokens(text) {
  const out = new Set();
  for (const m of String(text || '').toLowerCase().matchAll(/[a-z][a-z0-9_.\/-]{3,}/g)) {
    if (!STOP.has(m[0])) out.add(m[0]);
  }
  return out;
}

/** 该局是否有"与信号相关"的 claim：entity 口径 / token 口径分别判。 */
export function recallableOf(signal, claimTexts, mode) {
  if (mode === 'entity') {
    const se = hardEntities(signal);
    if (se.size === 0) return false; // 信号里没有硬实体 ⇒ 不可能按实体判有货
    for (const t of claimTexts) {
      for (const e of hardEntities(t)) if (se.has(e)) return true;
    }
    return false;
  }
  const st = discriminatingTokens(signal);
  for (const t of claimTexts) {
    const tt = discriminatingTokens(t);
    let shared = 0;
    for (const k of st) if (tt.has(k)) shared += 1;
    if (shared >= 2) return true;
  }
  return false;
}

/** Wilson 95% 区间（小样本必须带，不能只报百分比）。 */
export function wilson(hits, n, z = 1.96) {
  if (!n) return { phat: null, lower: null, upper: null, n: 0 };
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { phat: p, lower: Math.max(0, center - half), upper: Math.min(1, center + half), n };
}

export function split(results, claimTextsByEpisode) {
  const out = {};
  for (const mode of ['entity', 'token']) {
    const rows = results.map((x) => ({
      id: x.itemId,
      recallable: recallableOf(x.signal, claimTextsByEpisode.get(x.episode) || [], mode),
      hitStrict: x.hitStrict === true,
      hitRelated: x.hitRelated === true,
      rendered: Number(x.rendered) > 0,
    }));
    const yes = rows.filter((r) => r.recallable);
    const no = rows.filter((r) => !r.recallable);
    const silent = no.filter((r) => !r.rendered).length;
    out[mode] = {
      total: rows.length,
      recallable: {
        n: yes.length,
        strictHits: yes.filter((r) => r.hitStrict).length,
        relatedHits: yes.filter((r) => r.hitRelated).length,
        strictRate: wilson(yes.filter((r) => r.hitStrict).length, yes.length),
      },
      notRecallable: {
        n: no.length,
        silent,
        gaveCard: no.length - silent,
        silenceRate: wilson(silent, no.length),
        noiseRate: wilson(no.length - silent, no.length),
        // 无货却仍被判"命中"（= 取来的是该局但与信号无关的 claim）—— **噪声**。
        falseHits: no.filter((r) => r.hitRelated).length,
      },
    };
  }
  return out;
}

function main() {
  const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
  const root = path.join(home, 'memory-context');
  const claimsDir = path.join(root, 'claims');
  const byEpisode = new Map();
  for (const f of fs.readdirSync(claimsDir)) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(claimsDir, f), 'utf8'));
    for (const s of j.support || []) {
      if (!byEpisode.has(s.episode)) byEpisode.set(s.episode, []);
      byEpisode.get(s.episode).push(j.text || '');
    }
  }
  const examPath = path.resolve(process.argv[2] || 'evidence/a2b-holdout.json');
  const exam = JSON.parse(fs.readFileSync(examPath, 'utf8'));
  const out = split(exam.results, byEpisode);
  console.log(`考卷 ${examPath} · n=${exam.results.length} · 只读（不写库）`);
  for (const [mode, r] of Object.entries(out)) {
    console.log(`\n== 口径 ${mode} ==`);
    const pct = (w) => (w.phat === null ? 'n/a' : `${(w.phat * 100).toFixed(1)}% [${(w.lower * 100).toFixed(1)}, ${(w.upper * 100).toFixed(1)}]`);
    console.log(`  有货可召 ${r.recallable.n} 条 · 严格命中率 ${pct(r.recallable.strictRate)}`);
    console.log(`  无货可召 ${r.notRecallable.n} 条 · **沉默率** ${pct(r.notRecallable.silenceRate)}（应接近 100%）`);
    console.log(`     其中给了卡 ${r.notRecallable.gaveCard} 条（**噪声率** ${pct(r.notRecallable.noiseRate)}，应接近 0）· 仍被判命中 ${r.notRecallable.falseHits} 条`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('recallable-split.mjs')) main();
