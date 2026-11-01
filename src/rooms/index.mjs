// R07 index —— index.md 树（派生数据、可重算、可复算）
//
// 契约：docs/数据契约.md §5。
//   - 按 scope 分节；每局一行：
//     `- <YYYY-MM-DD> <ep-id> · <l0≤60字> · fail=<n> · topics=<top3> · links=<n>`
//   - 必须含声明：「未列出 ≠ 不存在；完整清单见 index.md 树」
// 本房间只组织与索引，不生成内容：所有字段都来自 R04/R05 的机械产物。
// 不调用模型、不读时钟（生成时间由调用方传入，保证同输入同输出）。

import { HARD_KINDS, KIND_ORDER } from './topic.mjs';

const DECLARATION = '未列出 ≠ 不存在；完整清单见 index.md 树';
const L0_MAX = 60;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * epoch ms → `YYYY-MM-DD`。
 * 默认 UTC（跨机可复算，便于测试与复算）；`tz:"local"` 用本机时区
 * （CLI 渲染 index.md 时用 local：会话发生在用户日历的哪一天才是人/模型要读到的日期）。
 */
export function formatDay(ms, tz = 'UTC') {
  if (!Number.isFinite(ms)) return '????-??-??';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '????-??-??';
  if (tz === 'local') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function clipText(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function episodeTime(ep) {
  for (const k of ['startedAt', 'firstEventAt', 'lastEventAt', 'endedAt']) {
    if (Number.isFinite(ep?.[k])) return ep[k];
  }
  return null;
}

function kindRank(kind) {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

/**
 * 选 top3 主题：硬主题优先 → 判别性（df 小）优先 → 出现次数多优先 → key 字节序。
 * @param {Array} topics 本局主题（R04 输出）
 * @param {Map}   dfById 主题 id → df
 */
export function pickTopTopics(topics, dfById = new Map(), k = 3) {
  const list = (Array.isArray(topics) ? topics : []).filter((t) => t && t.id && t.key);
  const scored = list.map((t) => {
    const df = dfById.get(t.id);
    return {
      key: t.key,
      kind: t.kind,
      hard: HARD_KINDS.has(t.kind) ? 0 : 1,
      kindRank: kindRank(t.kind),
      df: Number.isFinite(df) ? df : 9999,
      count: Number.isFinite(t.count) ? t.count : (Array.isArray(t.occurrences) ? t.occurrences.length : 0),
    };
  });
  scored.sort((a, b) => (a.hard - b.hard)
    || (a.kindRank - b.kindRank)
    || (a.df - b.df)
    || (b.count - a.count)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return scored.slice(0, k);
}

/**
 * 渲染 index.md。
 * @param {object} p
 * @param {Array}  p.episodes 契约 §2 的棋谱（含 id/scopeKey/时间/l0/signals/topics）
 * @param {Array}  p.links    R05 的相关边
 * @param {object|Array} [p.topics] R04.computeDf 的输出（用于 df 排序）
 * @param {Array}  [p.mentions] R05 的 mention（缺省时用 episodes 自带主题推断失败数）
 * @param {number|Date} [p.generatedAt] 生成时间（不传则不渲染该行 → 输出可复算）
 */
export function renderIndex({ episodes = [], links = [], topics = null, mentions = [], generatedAt = null, tz = 'UTC' } = {}) {
  const eps = (Array.isArray(episodes) ? episodes : []).filter((e) => e && e.id);

  const dfById = new Map();
  if (topics) {
    const arr = Array.isArray(topics) ? topics : (topics.topics ?? []);
    for (const t of arr) if (t?.id && Number.isFinite(t.df)) dfById.set(t.id, t.df);
  }

  const linkCount = new Map();
  for (const l of Array.isArray(links) ? links : []) {
    if (!l || !l.a || !l.b) continue;
    linkCount.set(l.a.episode, (linkCount.get(l.a.episode) ?? 0) + 1);
    linkCount.set(l.b.episode, (linkCount.get(l.b.episode) ?? 0) + 1);
  }

  const errorMentions = new Map();
  for (const m of Array.isArray(mentions) ? mentions : []) {
    if (!m?.from?.episode) continue;
    if (m.weight === 1 && String(m.topic ?? '').startsWith('t:error:')) {
      errorMentions.set(m.from.episode, (errorMentions.get(m.from.episode) ?? 0) + 1);
    }
  }

  const sections = new Map();
  for (const ep of eps) {
    const scope = typeof ep.scopeKey === 'string' && ep.scopeKey ? ep.scopeKey : 'w:<unknown>';
    if (!sections.has(scope)) sections.set(scope, []);
    sections.get(scope).push(ep);
  }

  const scopeKeys = [...sections.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  out.push('# 棋馆索引（index.md）');
  out.push('');
  out.push(`> **${DECLARATION}**`);
  out.push('> 一行一局：日期 · 棋谱 id · l0（≤60字） · 失败数 · top3 主题 · 相关边数。');
  if (generatedAt !== null) {
    const t = generatedAt instanceof Date ? generatedAt.getTime() : Number(generatedAt);
    if (Number.isFinite(t)) out.push(`> 生成时间：${new Date(t).toISOString()}`);
  }
  out.push(`> 统计：棋谱 ${eps.length} · 主题 ${dfById.size} · 相关边 ${Array.isArray(links) ? links.length : 0} · scope ${scopeKeys.length}`);
  out.push('');

  if (!eps.length) {
    out.push('（暂无棋谱）');
    out.push('');
  }

  for (const scope of scopeKeys) {
    const list = sections.get(scope);
    list.sort((a, b) => ((episodeTime(b) ?? 0) - (episodeTime(a) ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push(`## ${scope}`);
    out.push('');
    out.push(`共 ${list.length} 局（按 startedAt 倒序）`);
    for (const ep of list) {
      const day = formatDay(episodeTime(ep), tz);
      const top = pickTopTopics(ep.topics, dfById, 3).map((t) => t.key);
      const l0 = clipText(ep.l0 ?? '', L0_MAX) || '—';
      const failures = Number.isFinite(ep.signals?.failures)
        ? ep.signals.failures
        : (errorMentions.get(ep.id) ?? 0);
      const linksN = linkCount.get(ep.id) ?? 0;
      out.push(`- ${day} ${ep.id} · ${l0} · fail=${failures} · topics=${top.length ? top.join(' / ') : '—'} · links=${linksN}`);
    }
    out.push('');
  }

  out.push(`> ${DECLARATION}`);
  out.push('');
  return out.join('\n');
}

export default { renderIndex, formatDay, pickTopTopics };
