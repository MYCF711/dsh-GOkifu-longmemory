#!/usr/bin/env node
// T363：计划表的「重号索引」—— 只读、机械生成，不做任何判断。
//
// 为什么要有它：`计划表.md` 是唯一权威，但历史上编号被复用（T13/T49/T50… 各出现两次），
// 于是"查 T49"会查到两行，判断依据直接失效。重编号会牵动 CHANGELOG/evidence 里的交叉引用（有代价），
// 所以这里只**把重号摊开**：哪个编号、出现在第几行、各是什么内容。谁要查，先看这张表。
//
// 用法：node scripts/plan-dupe-index.mjs [--write]   # --write 把索引写回 计划表.md 的固定区块
import fs from 'node:fs';
import path from 'node:path';

const FILE = '计划表.md';
const BEGIN = '<!-- dupe-index:begin -->';
const END = '<!-- dupe-index:end -->';

export function buildIndex(text) {
  const rows = String(text).split('\n');
  const hits = new Map();
  rows.forEach((line, i) => {
    const m = line.match(/^\| (T\d+)\b/);
    if (!m) return;
    const id = m[1];
    if (!hits.has(id)) hits.set(id, []);
    const cells = line.split('|').map((c) => c.trim());
    hits.get(id).push({ line: i + 1, title: (cells[2] ?? '').slice(0, 40), state: (cells[3] ?? '').slice(0, 12) });
  });
  const dupes = [...hits.entries()].filter(([, v]) => v.length > 1).sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
  const total = [...hits.values()].reduce((n, v) => n + v.length, 0);
  return { total, unique: hits.size, dupes };
}

export function renderSection(index) {
  const lines = [];
  lines.push(BEGIN);
  lines.push('## 重号索引（机械生成，`node scripts/plan-dupe-index.mjs --write` 可重算）');
  lines.push('');
  lines.push(`共 ${index.total} 行 / ${index.unique} 个编号 / **${index.dupes.length} 个重号**。`);
  lines.push('查某个编号前先看这里：同一编号出现两次时，**行号大的那条通常是后来的改判或续记**。');
  lines.push('');
  lines.push('| 编号 | 行号 | 状态 | 行首标题 |');
  lines.push('|---|---|---|---|');
  for (const [id, list] of index.dupes) {
    for (const h of list) lines.push(`| ${id} | ${h.line} | ${h.state} | ${h.title} |`);
  }
  lines.push(END);
  return lines.join('\n');
}

const isMain = process.argv[1] && process.argv[1].endsWith('plan-dupe-index.mjs');
if (isMain) {
  const file = path.resolve(FILE);
  const raw = fs.readFileSync(file, 'utf8');
  // T375（2026-11-19）：**先把自己那份索引剥掉再统计**。
  // 否则索引表格里的 `| T188 | 225 | ...` 这些行会被当成计划表正文一起计数，
  // 于是每跑一次 `--write`，行数就虚增一轮（实测累计到 396，而正文只有 312）——
  // 这正是"重号索引"该防的漂移，却由它自己制造。
  const b = raw.indexOf(BEGIN);
  const e = raw.indexOf(END);
  const text = (b !== -1 && e !== -1) ? (raw.slice(0, b) + raw.slice(e + END.length)) : raw;
  const index = buildIndex(text);
  const section = renderSection(index);
  if (process.argv.includes('--write')) {
    const begin = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    let next;
    if (begin !== -1 && end !== -1) next = text.slice(0, begin) + section + text.slice(end + END.length);
    else next = `${text.trimEnd()}\n\n${section}\n`;
    fs.writeFileSync(file, next);
    console.log(`已写入重号索引：${index.dupes.length} 个重号`);
  } else {
    console.log(section);
  }
}
