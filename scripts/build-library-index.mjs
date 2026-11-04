#!/usr/bin/env node
// T144 · 知识库巨型节点的索引生产者。
//
// 主人在记忆图里把 `docs/调研/` 定成一个**巨型节点**（kind:"library"，id `lib:docs/调研`），
// 点开才展开成每篇一个子节点。本文件是那份索引的**生产者**：只产出结构，**不写盘**
// （落盘归别的房间）。全部规则都是机械的（正则 + 字符串），**不做模型判断、不改写、不总结**。
//
// 导出：
//   buildLibraryIndex({ docsDir, maxNotes = 500 })
//     → { node: {kind:'library', id, label, count},
//         notes: [{kind:'note', id, path, title, firstLine, topics:[...]}],
//         edges: [{kind:'library-mentions-topic', from:id, to:'t:<topic>', why}],
//         clamped: boolean }
//
// CLI（不写盘）：
//   node scripts/build-library-index.mjs [--json] [--docs <dir>]
//
// 机械规则（与 T144 任务书逐条对应）：
//   1. 只扫 `<docsDir>/*.md`；跳过索引文件 `00-索引与机制对照.md`（以及任何 `00-` 开头的索引）。
//   2. title = 文件里第一条 `# ` 行；没有就用文件名（去 `.md`、去 `-YYYY-MM-DD` 后缀）。
//   3. firstLine = 去掉标题后的第一条非空文本行（去掉列表/引用标记），折叠空白，截 120 字 + `…`。
//   4. topics = 文件名 + 标题里的英文标识符（小写）/ 大写缩写 / 书名号·引号里的专名 /
//      从 `00-索引与机制对照.md` 表里读到的系统名（读不到就跳过）。
//   5. edges：一条边一个主题；why = `第 <n> 篇 · <title 前 20 字>`；同一主题在 N 篇出现就 N 条边。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';

/** 巨型节点 id（主人裁定，固定字符串）。 */
export const LIBRARY_ID = 'lib:docs/调研';

/** 「知识库 → 主题」边的 kind（契约 §4.3 的边表里新增的一类）。 */
export const EDGE_KIND = 'library-mentions-topic';

/** 索引文件（它不是笔记，跳过）。 */
export const INDEX_NOTE = '00-索引与机制对照.md';

/** firstLine 上限（字）。 */
export const MAX_FIRST_LINE = 120;

/** why 里 title 的截断长度（字）。 */
export const WHY_TITLE_CHARS = 20;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DOCS_DIR = path.join(REPO_ROOT, 'docs', '调研');

// 英文标识符：首字符字母，后接 2 个以上字母数字/点/下划线/连字符。
const EN_IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9._-]{2,}/g;
// 大写缩写（保留原样，不转小写）。
const UPPER_ABBR_RE = /^[A-Z]{2,6}$/;
// 中文专名：书名号 / 「」 / “” / "..."（机械取，不做分词）。
const CJK_QUOTED_RE = /《([^》]{1,60})》|「([^」]{1,60})」|“([^”]{1,60})”|"([^"]{1,60})"/g;
// 文件名里的日期后缀（`-2026-11-04`）。
const DATE_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}$/;
// 列表/引用标记（取 firstLine 时剥掉）。
const LINE_MARKER_RE = /^(?:[-*+>]\s*)+/;

/** 按「字」（码点）截断；超长补 `…`。 */
export function clipChars(text, max) {
  const chars = Array.from(String(text ?? ''));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 折叠空白（不改变文字，只把连续空白压成一个空格）。 */
function squeeze(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 第一条 `# ` 行 → title（`##` 不算，因为 `#` 后需紧跟空白）。
 * 没有标题 ⇒ 文件名去 `.md`、去 `-YYYY-MM-DD` 后缀。
 */
export function titleOf(source, filename) {
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(String(source ?? ''));
  if (m && m[1]) return m[1].trim();
  const bare = String(filename ?? '').replace(/\.md$/i, '');
  return bare.replace(DATE_SUFFIX_RE, '');
}

/**
 * 去掉标题行后的第一条非空文本行（剥列表/引用标记、折叠空白），截 120 字。
 */
export function firstLineOf(source) {
  const lines = String(source ?? '').split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => /^#[ \t]+/.test(line) && !/^##+/.test(line));
  const start = titleIndex === -1 ? 0 : titleIndex + 1; // 没有标题 ⇒ 从第一行开始找
  for (let i = start; i < lines.length; i += 1) {
    const body = lines[i].replace(LINE_MARKER_RE, '').trim();
    if (body === '') continue;
    return clipChars(squeeze(body), MAX_FIRST_LINE);
  }
  return '';
}

/**
 * 从一段文本里机械抽主题词：英文标识符（小写）/ 大写缩写（原样）/ 引号里的中文专名。
 * 同一词的大小写变体只保留一个：有大写缩写就丢掉它的小写形式（`AWS` 与 `aws` 不重复计）。
 */
export function topicsFromText(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const m of s.matchAll(EN_IDENTIFIER_RE)) {
    // 标识符允许 `. _ -`，但首尾的分隔符是切词残渣（`Letta-MemFS-与…` ⇒ `letta-memfs-`），先剪掉。
    const raw = m[0].replace(/^[._-]+|[._-]+$/g, '');
    if (raw.length < 3) continue;
    out.add(UPPER_ABBR_RE.test(raw) ? raw : raw.toLowerCase());
    // 连字符/点/下划线连成的整串（`aws-agentcore-memory-ttl`）同时拆出子词，
    // 否则文件名会退化成一个大 token，图上永远匹配不上别的笔记。
    for (const part of raw.split(/[._-]+/)) {
      if (part.length < 3) continue;
      out.add(UPPER_ABBR_RE.test(part) ? part : part.toLowerCase());
    }
  }
  for (const m of s.matchAll(CJK_QUOTED_RE)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (value) out.add(value);
  }
  for (const key of [...out]) {
    const upper = key.toUpperCase();
    if (key !== upper && out.has(upper)) out.delete(key);
  }
  return [...out];
}

/**
 * 从 `00-索引与机制对照.md` 的「按系统逐篇」表里读系统名（第二列）。
 * 读不到文件就返回空集（调用方据此跳过这一步）。
 */
export function readSystemNames(indexPath) {
  let source;
  try {
    source = readFileSync(indexPath, 'utf8');
  } catch {
    return new Set();
  }
  const names = new Set();
  for (const line of source.split(/\r?\n/)) {
    const row = /^\|\s*\d{2}\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!row) continue;
    const cell = row[1].replace(/[`*]/g, '').trim();
    // 系统名可能带括注或并列（`Mem0 v3 记忆管线（ADD-only 累积）`、`Letta MemFS + dreaming`）。
    for (const part of cell.split(/[、+（(]/)) {
      const name = part.replace(/[)）].*$/, '').trim();
      if (name.length >= 2) names.add(name);
    }
  }
  return names;
}

/**
 * 文件名 + 标题 → 主题集合。
 * @param {string} haystack 文件名与标题拼起来的文本
 * @param {Set<string>} systemNames 已知系统名（可空）
 */
export function collectTopics(haystack, systemNames = new Set()) {
  const topics = new Set(topicsFromText(haystack));
  const lower = String(haystack ?? '').toLowerCase();
  for (const name of systemNames) {
    if (!name) continue;
    if (!lower.includes(name.toLowerCase())) continue;
    // 系统名本身也按同一套机械规则拆词（中文名没有可拆的就整名记为专名）。
    const fromName = topicsFromText(name);
    if (fromName.length === 0 && Array.from(name).length >= 2 && Array.from(name).length <= 30) {
      topics.add(name);
    }
    for (const t of fromName) topics.add(t);
  }
  for (const key of [...topics]) {
    const upper = key.toUpperCase();
    if (key !== upper && topics.has(upper)) topics.delete(key);
  }
  return [...topics];
}

/** 笔记 id / path 用 POSIX 分隔相对路径（跨机稳定）。 */
function relativeNotePath(docsDir, filename) {
  const relDir = path.relative(REPO_ROOT, docsDir);
  const insideRepo = relDir !== '' && !relDir.startsWith('..') && !path.isAbsolute(relDir);
  const base = insideRepo ? relDir : path.basename(docsDir);
  return [base, filename].join('/').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/** 列出要扫的笔记文件（跳过索引、跳过非 .md），按文件名排序保证可复算。 */
export function listNotes(docsDir) {
  return readdirSync(docsDir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .filter((f) => f !== INDEX_NOTE && !f.startsWith('00-'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 生产者入口：扫一遍 docsDir，产出「巨型节点 + 子节点 + 主题边」。
 *
 * `resolveTopic`（可选、纯函数、由调用方注入）把**主题名**解析成**真实 topic id**：
 *   - 传了：解析成功 ⇒ 边指向真实 id（`t:term:…` / `t:tool:…`）；解析不到 ⇒ 进 `orphans`
 *     （"知识库提到、但记忆里从没出现过"的主题——**不许编造节点**，所以不建边）。
 *   - 不传：退化成旧行为（`to: 't:<name>'`，没有孤儿），保持向后兼容。
 *
 * @param {{docsDir?: string, maxNotes?: number, resolveTopic?: ((name: string) => string|null)|null}} [options]
 */
export function buildLibraryIndex({ docsDir = DEFAULT_DOCS_DIR, maxNotes = 500, resolveTopic = null } = {}) {
  const dir = path.resolve(docsDir);
  const files = listNotes(dir);
  const systemNames = readSystemNames(path.join(dir, INDEX_NOTE));

  const limit = Number.isFinite(maxNotes) && maxNotes > 0 ? Math.floor(maxNotes) : 0;
  const clamped = files.length > limit;
  const kept = clamped ? files.slice(0, limit) : files;

  const notes = kept.map((filename) => {
    const source = readFileSync(path.join(dir, filename), 'utf8');
    const title = titleOf(source, filename);
    const notePath = relativeNotePath(dir, filename);
    return {
      kind: 'note',
      id: `note:${notePath}`,
      path: notePath,
      title,
      firstLine: firstLineOf(source),
      topics: collectTopics(`${filename}\n${title}`, systemNames),
    };
  });

  const hasResolver = typeof resolveTopic === 'function';
  const edges = [];
  const orphans = [];
  notes.forEach((note, i) => {
    const why = `第 ${i + 1} 篇 · ${clipChars(note.title, WHY_TITLE_CHARS)}`;
    for (const topicName of note.topics) {
      if (!hasResolver) {
        // 向后兼容：没有解析器时沿用旧形态，边指向 `t:<name>`
        edges.push({ kind: EDGE_KIND, from: LIBRARY_ID, to: `t:${topicName}`, topicName, why });
        continue;
      }
      const target = resolveTopic(topicName);
      if (typeof target === 'string' && target !== '') {
        edges.push({ kind: EDGE_KIND, from: LIBRARY_ID, to: target, topicName, why });
      } else {
        orphans.push({ name: topicName, why });
      }
    }
  });

  return {
    node: {
      kind: 'library',
      id: LIBRARY_ID,
      label: `调研知识库（${notes.length} 篇）`,
      count: notes.length,
    },
    notes,
    edges,
    orphans,
    counts: {
      notes: notes.length,
      // 总提及数 = 解析成功的边 + 解析不到的孤儿；三者永远满足这条恒等式
      edges: edges.length + orphans.length,
      resolvedEdges: edges.length,
      orphans: orphans.length,
    },
    clamped,
  };
}

/**
 * 从 sidecar 的 `topics` 里建「主题名（小写、去空白）→ 真实 topic id」解析器。
 * **只读**：`createStore` 只用来 list，不写库。
 * @param {{storeDir: string}} options
 */
export function createTopicResolver({ storeDir } = {}) {
  const store = createStore({ root: storeDir });
  const byName = new Map();
  for (const entry of store.list('topics')) {
    const key = entry?.record?.key;
    if (typeof key !== 'string') continue;
    const name = key.trim().toLowerCase();
    if (!name || byName.has(name)) continue; // 同名 topic 取先出现的一条，保证可复算
    byName.set(name, entry.id);
  }
  return (name) => byName.get(String(name ?? '').trim().toLowerCase()) ?? null;
}

/** CLI 参数：`[--json] [--docs <dir>] [--store <dir>]`。 */
export function parseArgs(argv = []) {
  const flags = { json: false, docs: null, store: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--docs') (flags.docs = argv[i + 1] ?? null), (i += 1);
    else if (arg.startsWith('--docs=')) flags.docs = arg.slice('--docs='.length);
    else if (arg === '--store') (flags.store = argv[i + 1] ?? null), (i += 1);
    else if (arg.startsWith('--store=')) flags.store = arg.slice('--store='.length);
  }
  return flags;
}

/** CLI：打印摘要或完整 JSON；不写盘。 */
export function main(argv = [], { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseArgs(argv);
  const docsDir = flags.docs ?? DEFAULT_DOCS_DIR;

  let resolveTopic = null;
  if (flags.store) {
    const storeDir = path.resolve(flags.store);
    if (!existsSync(storeDir)) {
      stderr.write(`build-library-index: --store 目录不存在 ${storeDir}\n`);
      return 2;
    }
    try {
      resolveTopic = createTopicResolver({ storeDir });
    } catch (error) {
      stderr.write(`build-library-index: 读主题库失败 ${storeDir}：${String(error?.message ?? error)}\n`);
      return 2;
    }
  }

  let result;
  try {
    result = buildLibraryIndex({ docsDir, resolveTopic });
  } catch (error) {
    stderr.write(`build-library-index: 读取失败 ${path.resolve(docsDir)}：${String(error?.message ?? error)}\n`);
    return 2;
  }
  if (flags.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const { counts } = result;
  const names = new Set([...result.edges.map((e) => e.topicName), ...result.orphans.map((o) => o.name)]);
  stdout.write('调研知识库索引（生产者 · 不写盘）\n');
  if (flags.store) stdout.write(`主题库：${path.resolve(flags.store)}（只读）\n`);
  stdout.write(`篇数：${counts.notes}\n`);
  stdout.write(`主题数：${names.size}\n`);
  stdout.write(`边数：${counts.edges} = resolvedEdges ${counts.resolvedEdges} + orphans ${counts.orphans}\n`);
  stdout.write(`clamped：${result.clamped ? '是' : '否'}\n`);
  return 0;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) process.exitCode = main(process.argv.slice(2));
