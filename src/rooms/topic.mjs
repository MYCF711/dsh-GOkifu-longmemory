// R04 topic —— 主题/实体抽取（机械规则，无模型判断、无向量检索）
//
// 契约：docs/数据契约.md §4（topic / mention / link 字段）、AGENTS.md §4.2、方案.md §4.2。
//
// 输入只允许两类原始证据：
//   1. events —— 会话日志事件（tool/call 的参数、tool/result 的文本、root user 消息）
//   2. graph  —— 压缩仓产出的棋谱（节点 text、边 action/errorSnippet）
// 禁止把模型生成摘要（session/title、l0/l1、<compacted-summary>、<chess-fold>）当源：
//   session/title 由 provider 或 fallback 生成，属于模型产物，本模块**不读**。
//
// 主题种类（kind）与强度分层（方案 §4.2）：
//   硬（共用基础 / 技术对象）：repo scaffold dependency tool file domain error
//   软（目的 / 主题词）：      term goal
// 权重规则由 R05 计算；本模块只给 df / idf 所需的机械量。

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 常量：种类、顺序、上限、停用词
// ---------------------------------------------------------------------------

export const KIND_ORDER = Object.freeze([
  'repo', 'scaffold', 'dependency', 'tool', 'file', 'domain', 'error', 'term', 'goal',
]);

export const HARD_KINDS = Object.freeze(new Set(['repo', 'scaffold', 'dependency', 'tool', 'file', 'domain', 'error']));
export const SOFT_KINDS = Object.freeze(new Set(['term', 'goal']));

// 每局每类的主题数上限：防止单局把整张表撑爆（机械、可复算、可单测）。
export const DEFAULT_LIMITS = Object.freeze({
  repo: 12,
  scaffold: 8,
  dependency: 20,
  tool: 24,
  file: 30,
  domain: 10,
  error: 20,
  term: 20,
  goal: 2,
  occurrencesPerTopic: 8,
  quoteChars: 120,
});

// 「硬主题不能被当成通用噪声」的停用表：只收虚词/填充 2-gram。
// 明令：领域词（记忆 / 棋谱 / 主题 / 索引 / 房间 / 压缩 …）不属于停用词，它们是判别性信号。
export const CJK_STOPWORDS = Object.freeze(new Set([
  '文件', '项目', '问题', '需要', '可以', '这个', '那个', '我们', '你们', '他们', '什么', '怎么',
  '然后', '因为', '所以', '但是', '如果', '就是', '不是', '没有', '一个', '这些', '那些', '进行',
  '使用', '已经', '应该', '或者', '以及', '还有', '现在', '之后', '之前', '时候', '这样', '那样',
  '自己', '东西', '事情', '地方', '部分', '内容', '情况', '方式', '方法', '方面', '通过', '对于',
  '关于', '由于', '因此', '而且', '并且', '虽然', '除非', '除了', '只有', '只要', '无论', '不管',
  '一直', '一起', '一样', '一些', '一次', '一定', '可能', '能够', '必须', '注意', '记得', '最好',
  '建议', '要求', '实现', '完成', '处理', '开始', '结束', '继续', '不要', '不能', '不会', '知道',
  '看到', '发现', '觉得', '认为', '希望', '提供', '支持', '包括', '例如', '比如', '其中', '其他',
  '另外', '同时', '以后', '目前', '当前', '本次', '以下', '上述', '下面', '上面', '这里', '那里',
  '哪里', '所有', '每个', '各种', '不同', '相同', '主要', '重要', '简单', '复杂', '大概', '大约',
  '基本', '其实', '确实', '当然', '接着', '直接', '间接', '最终', '最后', '负责', '工作', '任务',
  '规则', '做法', '过程', '结果', '原因', '理由', '状态', '时间', '日期', '数量', '数字', '目录',
  '路径', '信息', '数据', '一下', '一点', '出来', '起来', '过来', '下去', '不到', '不过', '这么',
  '那么', '多少', '怎样', '如何', '是否', '真的', '还是', '总是', '一般', '整个', '全部', '任何',
]));

// 两字都落在虚字表里 ⇒ 丢弃（例：「的」+「了」）。
export const CJK_STOP_CHARS = Object.freeze(new Set(
  '的了是在我你他她它们这那有和与就都也还不没要会可以个上下中里外到对从把被让给说出来去过来着得地吗呢吧啊呀哦么之而其所以及或但并为嘛嘛'.split(''),
));

export const EN_STOPWORDS = Object.freeze(new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'you', 'your', 'are', 'was', 'were', 'will', 'would',
  'can', 'could', 'should', 'have', 'has', 'had', 'not', 'but', 'from', 'into', 'then', 'than',
  'them', 'they', 'there', 'when', 'what', 'which', 'who', 'how', 'why', 'all', 'any', 'some',
  'such', 'only', 'also', 'just', 'very', 'much', 'many', 'more', 'most', 'other', 'its', 'use',
  'using', 'used', 'true', 'false', 'null', 'undefined', 'const', 'function', 'return', 'import',
  'export', 'default', 'async', 'await', 'new', 'let', 'var', 'type', 'name', 'value', 'data',
  'test', 'tests', 'run', 'error', 'errors', 'code', 'line', 'first', 'second', 'one', 'two',
  'now', 'here', 'where', 'about', 'after', 'before', 'because', 'while', 'each', 'every', 'own',
]));

// Node 内置模块：不是「依赖」（import paths / deps 里出现它们属于噪声）。
export const NODE_BUILTINS = Object.freeze(new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events', 'tty', 'url',
  'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'test',
]));

// 命令名白名单（机械来源：bash/pwsh 命令首 token）。
export const SHELL_COMMANDS = Object.freeze(new Set([
  'bash', 'sh', 'pwsh', 'powershell', 'cmd', 'node', 'npx', 'npm', 'pnpm', 'yarn', 'python',
  'python3', 'pip', 'git', 'gh', 'ls', 'cd', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'find',
  'sed', 'awk', 'sort', 'uniq', 'wc', 'cut', 'tr', 'xargs', 'tee', 'curl', 'wget', 'jq', 'mkdir',
  'rmdir', 'cp', 'mv', 'rm', 'touch', 'chmod', 'chown', 'diff', 'file', 'du', 'df', 'ps', 'kill',
  'tasklist', 'whoami', 'date', 'stat', 'tar', 'gzip', 'zstd', 'unzip', 'zip', 'docker', 'ssh',
  'scp', 'rsync', 'make', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha', 'echo', 'test',
  'true', 'false', 'exit', 'source', 'export', 'set', 'env', 'printenv', 'sleep', 'time', 'which',
  'where', 'type', 'alias', 'history', 'open', 'start', 'explorer', 'schtasks', 'sc', 'reg',
]));

// 归类为「工具」的事件名（DSH 工具名本身就是技术对象）。
export const EVENT_TOOL_KINDS = Object.freeze(new Set(['tool/call']));

// 错误串只从这些「命令类工具」的结果里取：read/glob 读到的源码或文档里的 "Error: …" 是示例，不是事件。
export const SHELL_ERROR_TOOLS = Object.freeze(new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd', 'shell']));

const FILE_EXT = '(?:mjs|cjs|js|jsx|ts|tsx|json|jsonl|md|mdx|ya?ml|toml|ini|cfg|conf|ps1|sh|bat|cmd|py|rb|go|rs|java|c|h|cpp|hpp|css|scss|html|zst|log|txt|lock|env)';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 稳定短哈希：t:<kind>:<hash8>（契约 §4）。sha256 前 8 位十六进制。 */
export function hash8(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 8);
}

export function topicId(kind, key) {
  return `t:${kind}:${hash8(`${kind}\u0000${key}`)}`;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** 路径规范化：反斜杠→正斜杠、MSYS 盘符、小写盘符、折叠重复斜杠、去尾随标点。 */
export function normalizePath(raw) {
  let p = String(raw ?? '').trim();
  if (!p) return '';
  p = p.replace(/^["'`]+|["'`]+$/g, '');
  p = p.replace(/\\/g, '/');
  // MSYS/Git-Bash 盘符：/d/xxx → d:/xxx（但 //server 与 URL 不动）
  p = p.replace(/^\/([A-Za-z])\//, (_, d) => `${d.toLowerCase()}:/`);
  p = p.replace(/^\/([A-Za-z])$/, (_, d) => `${d.toLowerCase()}:/`);
  p = p.replace(/([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/[.,;:]+$/g, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  p = p.replace(/^\.\//, '');
  return p;
}

/**
 * 相对化：把工作区内的绝对路径压成仓内相对路径（契约 §2：scopeKey 用规范化 cwd）。
 * 工作区外的路径保留绝对形式（M1 只读，可接受；M2 入 sidecar 前由 R15 再处理）。
 */
export function relativizePath(p, workspace) {
  const norm = normalizePath(p);
  if (!norm || !workspace) return norm;
  const ws = normalizePath(workspace).replace(/\/+$/, '');
  if (!ws) return norm;
  const lower = norm.toLowerCase();
  const wsLower = ws.toLowerCase();
  if (lower === wsLower) return '.';
  if (lower.startsWith(`${wsLower}/`)) {
    const rest = norm.slice(ws.length + 1);
    return rest.replace(/^\.\//, '');
  }
  return norm;
}

function looksLikePath(token) {
  const t = String(token ?? '').trim();
  if (t.length < 3 || t.length > 200) return false;
  if (/^[a-z]+:\/\//i.test(t)) return false; // URL
  if (/^[.][.]?\//.test(t) && t.length < 4) return false;
  // 正则/通配/哨兵字符：属于 pattern、sed 表达式、shell 重定向，不是路径
  if (/[#$*?()[\]{}'"|&;=<>`^+!~]/.test(t)) return false;
  if (/^#/.test(t) || /\/#/.test(t)) return false;
  if (/^\/(?:dev|proc|sys|nul)\//i.test(t) || /^\/(?:dev|nul)$/i.test(t)) return false;
  if (/^(?:nul|con)$/i.test(t)) return false;
  const hasSep = t.includes('/') || t.includes('\\');
  if (!hasSep) return false;
  if (/^(?:\d+\.){3}\d+$/.test(t)) return false;
  // 每段必须像组件（字母数字 + 中文 + _.- ），排除 /##、/## 4.1 之类
  const segs = t.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
  if (segs.length < 2) return false;
  // 盘符路径必须是「盘符 + 目录 + 名字」（排除 sed 替换串里的 n:/g 这类假路径）
  if (/^[A-Za-z]:$/.test(segs[0]) && segs.length < 3 && !new RegExp(`\\.${FILE_EXT}$`, 'i').test(t)) return false;
  const compRe = /^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_.\-\u4e00-\u9fff ]*$/;
  const isDrive = /^[A-Za-z]:$/;
  if (!segs.every((s) => isDrive.test(s) || compRe.test(s) || s === '.' || s === '..')) return false;
  return true;
}

/** 去掉被更长路径覆盖的前缀片段（`d:/DeepSeek` 被 `d:/DeepSeek Harness/x` 覆盖）。 */
export function dedupePathPrefixes(paths) {
  const list = [...new Set(paths.map((p) => normalizePath(p)).filter(Boolean))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const kept = [];
  for (const p of list) {
    const lower = p.toLowerCase();
    const covered = kept.some((k) => {
      const kl = k.toLowerCase();
      return kl === lower || kl.startsWith(`${lower}/`) || kl.startsWith(`${lower} `);
    });
    if (!covered) kept.push(p);
  }
  return kept.sort();
}

// ---------------------------------------------------------------------------
// 错误串规范化（契约 §4.3：错误串规范化后相等 ⇒ 同一 error）
// ---------------------------------------------------------------------------

const ERROR_MARKERS = [
  /\b(?:[A-Z][A-Za-z]*)?Error\b\s*:/,           // Error: / TypeError: / SyntaxError:
  /\bENOENT\b/, /\bEACCES\b/, /\bEPERM\b/, /\bEEXIST\b/, /\bECONNREFUSED\b/, /\bETIMEDOUT\b/,
  /\bERR_[A-Z0-9_]+\b/,                          // Node ERR_* 码
  /\[exit code: \d+\]/,                          // 本机 bash 工具失败标记
  /\bexit code \d+\b/i,
  /\bCannot find module\b/,
  /\bNo such file or directory\b/,
];

// 合成标记：只说明「命令失败」，不说明「错在哪」——可用于 mention，但不建 same-error 边。
const GENERIC_ERROR_RE = /^(?:exit code \d+|\[exit code: \d+\])$/;

// 类级错误主题（D2 口径，2026-11-02）：同一个「协议类坑」在不同路径/文件下也应连起来，
// 否则跨会话重复只能靠原文完全相等才成立（实测 12 条跨局重复里 10 条被路径差异拆散）。
const ERROR_CLASS_RULES = [
  ['fs-read-before-write', /file has not been read|file changed since it was read|file no longer exists/i],
  ['tool-unavailable', /unknown tool|tool .* not found|unknown command/i],
  ['policy-human-turn', /requires a direct human turn/i],
  ['sandbox-limit', /team member limit|tool call aborted|timed out after/i],
  ['web-search-empty', /web_search_tool_result blocks/i],
  ['module-missing', /cannot find module|err_module_not_found/i],
  ['permission-denied', /EACCES|EPERM|permission denied/i],
  ['timeout', /timed out|timeout|ETIMEDOUT/i],
];

/** 类级错误 key；没有匹配返回 null（只连已知协议类，避免把一次性报错并进来）。 */
export function errorClassKeyOf(text) {
  const value = String(text ?? '');
  for (const [name, re] of ERROR_CLASS_RULES) if (re.test(value)) return `class:${name}`;
  return null;
}

/** exit code 之类的合成标记不构成「同一报错原文」的证据。 */
export function isGenericErrorKey(key) {
  return GENERIC_ERROR_RE.test(String(key ?? '').trim());
}

/**
 * 从一段文本里抽出第一条可归一的错误行；没有则返回 null。
 * 归一化：去 ANSI → 取含错误标记的首行 → 空白折叠 → 路径替换为 <path> → 截断 160 字。
 * 保留原文供 mention.quote 用（调用方自取）。
 */
export function extractErrorKey(input) {
  const text = stripAnsi(input).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 12)) {
    let at = -1;
    for (const re of ERROR_MARKERS) {
      const m = re.exec(line);
      if (m && (at === -1 || m.index < at)) at = m.index;
    }
    if (at === -1) continue;
    let key = line.slice(at)
      .replace(/\[exit code: (\d+)\]/g, 'exit code $1')
      .replace(/"(?:[A-Za-z]:[\\/]|\/)[^"]*"/g, '"<path>"')
      .replace(/(?:[A-Za-z]:[\\/]|\/(?:[A-Za-z0-9_.-]+\/){1,})[^\s"',;)]+/g, '<path>')
      .replace(/\/<path>/g, '<path>')
      .replace(/\s+/g, ' ')
      .replace(/\s+at\s.*$/, '')
      .replace(/[.。,;；]+$/, '')
      .trim();
    if (!key) continue;
    return key.length > 160 ? `${key.slice(0, 159)}…` : key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 文本 → 主题候选
// ---------------------------------------------------------------------------

/** 从文本抽取类路径串（含引号包裹的带空格路径）。 */
export function extractPathTokens(text) {
  const out = new Set();
  const s = String(text ?? '');
  // 1) 引号包裹的绝对路径（允许空格）
  for (const m of s.matchAll(/["'`]((?:[A-Za-z]:[\\/]|\/)[^"'`\n]{2,200})["'`]/g)) {
    if (looksLikePath(m[1])) out.add(m[1]);
  }
  // 2) 普通 token（空白/标点分隔）；只收「绝对路径」或「带已知扩展名」的 token ——
  //    无扩展名的相对片段（`Harness/Desktop`、`4.2/p`）是空白切词的残渣，属噪声。
  for (const raw of s.split(/[\s"'`()<>\[\]{},;|]+/)) {
    const t = raw.replace(/^[-=]+/, '').replace(/[.,;:!?]+$/, '');
    if (!looksLikePath(t)) continue;
    if (/^[A-Za-z]:[\\/]/.test(t) || /^\//.test(t) || new RegExp(`\\.${FILE_EXT}$`, 'i').test(t)) {
      out.add(t);
    }
  }
  return dedupePathPrefixes([...out]);
}

/** URL → {host, path}；非法返回 null。 */
export function parseUrl(raw) {
  try {
    const u = new URL(String(raw).replace(/[.,;:)\]]+$/, ''));
    if (!/^https?:$/.test(u.protocol)) return null;
    return { url: u.toString(), host: u.host.replace(/:\d+$/, '').toLowerCase(), path: u.pathname };
  } catch {
    return null;
  }
}

export function extractUrls(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s"'`<>)\]}]+/g)) {
    const u = parseUrl(m[0]);
    if (u) out.push(u);
  }
  return out;
}

/** github URL / git@ 地址 → repo:owner/name（小写）。 */
export function extractRepos(text) {
  const out = new Set();
  const s = String(text ?? '');
  // 只有 github.com 主机本身才算仓库地址（api.github.com / 子域不算，由下面的专名规则处理）
  for (const m of s.matchAll(/(?<![\w.-])github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=$|[\s"'`/?#)\]])/g)) {
    if (m[1] && m[2] && !/^(?:orgs|users|topics|settings|marketplace|repos)$/i.test(m[1])) {
      out.add(`${m[1]}/${m[2]}`.toLowerCase());
    }
  }
  // GitHub API 形态：api.github.com/repos/<owner>/<repo>
  for (const m of s.matchAll(/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
    if (m[1] && m[2]) out.add(`${m[1]}/${m[2]}`.toLowerCase());
  }
  return [...out];
}

/** 包管理器安装命令 / import-require 引用的包名。 */
export function extractDependencies(text) {
  const out = new Set();
  const s = String(text ?? '');
  for (const m of s.matchAll(/\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+((?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_@./-]+(?:@[A-Za-z0-9^~*.<>-]+)?)/g)) {
    const pkg = m[1].replace(/@[\w^~*.<>=-]+$/, '');
    if (pkg && !pkg.startsWith('.') && !pkg.startsWith('/')) out.add(pkg.toLowerCase());
  }
  for (const m of s.matchAll(/\b(?:import\s[^'"]*?from\s*|require\(\s*|import\(\s*)["']((?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.:-]+)["']/g)) {
    const pkg = m[1].toLowerCase().replace(/^node:/, '');
    if (pkg.startsWith('.') || pkg === '') continue;
    out.add(pkg);
  }
  // package.json 片段（工具结果里读到依赖表）
  for (const m of s.matchAll(/"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{([\s\S]{0,4000}?)\}/g)) {
    for (const p of m[1].matchAll(/"((?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+)"\s*:\s*"/g)) {
      out.add(p[1].toLowerCase());
    }
  }
  return [...out].filter((x) => x.length >= 2 && x.length <= 80 && !/^\d+$/.test(x) && !NODE_BUILTINS.has(x));
}

/** 命令串 → 首 token 的命令名集合（白名单，机械）。 */
export function extractCommands(cmd) {
  const out = new Set();
  const s = String(cmd ?? '');
  for (const seg of s.split(/[;&|\n]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^(?:sudo|env|[A-Za-z_][A-Za-z0-9_]*=.*)$/.test(tokens[i])) i += 1;
    const tok = tokens[i];
    if (!tok) continue;
    const name = tok.replace(/\.(?:exe|cmd|bat)$/i, '').replace(/^.*[\\/]/, '').toLowerCase();
    if (SHELL_COMMANDS.has(name)) out.add(name);
  }
  return [...out];
}

function isCjkStopGram(gram) {
  if (CJK_STOPWORDS.has(gram)) return true;
  return CJK_STOP_CHARS.has(gram[0]) && CJK_STOP_CHARS.has(gram[1]);
}

/**
 * 抽词前先抹掉路径/URL：根 user 消息里常整段粘贴工作区路径（`D:\work\demo`、`http://…`），
 * 其中的 `deepseek` `harness` `default-workspace` 之类会变成「几乎每局都有」的假判别词。
 * 纯字符串清洗，不改变其它抽取器（repo/file 仍从命令与工具参数取）。
 */
export function sanitizeForTerms(text) {
  return String(text ?? '')
    .replace(/https?:\/\/[^\s"'`<>)\]}]+/g, ' ')
    .replace(/[A-Za-z]:[\\/][^\s"'`<>|;,)]*/g, ' ')
    .replace(/(?:[A-Za-z0-9_.-]+[\\/]){1,}[A-Za-z0-9_.\-]+/g, ' ')
    .replace(/\/(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]*/g, ' ');
}

/**
 * 判别性词：CJK 2-gram + 英文词；去停用词，按出现次数排序（次数相等按字节序，保证可复算）。
 * 碎片过滤（机械，无词表打分）：
 *   1) 2-gram 含虚字（CJK_STOP_CHARS）⇒ 丢；
 *   2) 左右两侧都没有「词边界」（句读处 / 虚字 / 串首尾）⇒ 判为切词碎片丢弃。
 *   例「记忆系统的主题」：记忆（串首）· 系统（右邻「的」）· 主题（左邻「的」）留；
 *   「忆系」「统的」「的主」既无边界又夹虚字 ⇒ 丢。
 * 返回 [{key, script:"cjk"|"en", count}]。
 */
export function extractTerms(text, { maxCjk = 14, maxEn = 8 } = {}) {
  const s = String(text ?? '');
  const counts = new Map();
  const bump = (key, script) => {
    const prev = counts.get(key);
    if (prev) prev.count += 1;
    else counts.set(key, { key, script, count: 1 });
  };
  for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (isCjkStopGram(gram)) continue;
      if (CJK_STOP_CHARS.has(gram[0]) || CJK_STOP_CHARS.has(gram[1])) continue;
      const left = i === 0 ? '' : run[i - 1];
      const right = i + 2 === run.length ? '' : run[i + 2];
      const boundary = !left || !right || CJK_STOP_CHARS.has(left) || CJK_STOP_CHARS.has(right);
      if (!boundary) continue;
      bump(gram, 'cjk');
    }
  }
  for (const w of s.toLowerCase().match(/[a-z][a-z0-9_.-]{2,29}/g) ?? []) {
    if (EN_STOPWORDS.has(w) || /^\d/.test(w) || /^[._-]+$/.test(w)) continue;
    bump(w, 'en');
  }
  const all = [...counts.values()]
    .sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const cjk = all.filter((t) => t.script === 'cjk').slice(0, maxCjk);
  const en = all.filter((t) => t.script === 'en').slice(0, maxEn);
  return [...cjk, ...en]
    .map(({ key, script, count }) => ({ key, script, count }))
    .sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 目标：只认显式任务句式（「任务：…」「目标：…」），不做语义判断。 */
export function extractGoal(text) {
  const s = String(text ?? '');
  const m = s.match(/(?:你的任务|本次任务|任务|目标)\s*[：:]\s*([^\n。；;（(\[]{4,80})/);
  if (!m) return null;
  const key = m[1].replace(/^[-–—\s]+/, '').replace(/\s+/g, ' ').trim();
  return key.length >= 4 ? key.slice(0, 80) : null;
}

// ---------------------------------------------------------------------------
// 事件读取（包裹层：{type, seq, time, data}）
// ---------------------------------------------------------------------------

function eventText(ev) {
  const d = ev?.data ?? {};
  const parts = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) parts.push(v);
  };
  if (typeof d.text === 'string') push(d.text);
  const content = d.content ?? d.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text') push(block.text);
    }
  } else if (typeof content === 'string') {
    push(content);
  }
  return parts.join('\n');
}

function userEventText(ev) {
  const d = ev?.data ?? {};
  const content = d.content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  if (typeof content === 'string') return content;
  return typeof d.text === 'string' ? d.text : '';
}

/** 用户真的说过话的事件来源（与 `src/rooms/extract.mjs` 的 `USER_SOURCE_KIND` 同口径）。 */
const USER_SOURCE_KIND = 'user';

/**
 * 事件是不是"用户真的说了话"的那一条。
 *
 * 为什么（T244/T245）：`<memory-ledger>` 注入卡也是 `type:"user/message"` + `role:"user"`，
 * 唯一区别在 `data.source.kind`（卡是 `dsh-gokifu-longmemory`，真用户是 `user`）。
 * 只看 `type` 会让"卡恰好排在第一"时被当成**根用户原话**（当前 730 局全都没出事，纯靠"卡不在首位"）。
 * 这里与 R03 一样按来源判，把幸运变成规则；`kind` 缺省时退回 `role === "user"`（老事件兼容）。
 */
function isUserMessageEvent(ev) {
  if (ev?.type !== 'user/message') return false;
  const kind = ev.data?.source?.kind;
  if (kind === undefined) return ev.data?.role === USER_SOURCE_KIND;
  return kind === USER_SOURCE_KIND;
}

function parseArgs(json) {
  if (!json) return null;
  if (typeof json === 'object') return json;
  try {
    const v = JSON.parse(String(json));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const PATH_ARG_KEYS = new Set(['file_path', 'path', 'file', 'dir', 'cwd', 'root', 'target']);
const COMMAND_ARG_KEYS = new Set(['command', 'cmd', 'script']);
const URL_ARG_KEYS = new Set(['url', 'href', 'uri']);

// ---------------------------------------------------------------------------
// 棋谱（graph）读取
// ---------------------------------------------------------------------------

function graphEdgeActionParts(action) {
  // 上游 action 形如 `bash(command=…)` / `write(file_path=… content=…)`
  const toolMatch = String(action ?? '').match(/^([A-Za-z_][\w.-]*)\(/);
  return { tool: toolMatch ? toolMatch[1].toLowerCase() : null, raw: String(action ?? '') };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 抽取一局的主题（含每条出现的位置证据）。
 * @param {object}   p
 * @param {object}  [p.episode] 契约 §2 的 episode（只用 scopeKey / cwd / id / startedAt）
 * @param {Array}   [p.events]  契约 §1.3 的事件数组
 * @param {object}  [p.graph]   契约 §3 的棋谱对象
 * @param {object}  [p.limits]  覆盖 DEFAULT_LIMITS
 * @returns {Array<{id,kind,key,count,firstSeenAt,lastSeenAt,occurrences}>}
 */
export function extractTopics({ episode = null, events = [], graph = null, limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const workspace = normalizePath(episode?.workspace ?? episode?.cwd ?? String(episode?.scopeKey ?? '').replace(/^w:/, '')) || null;
  const buckets = new Map();

  const add = (kind, keyRaw, occ) => {
    let key = String(keyRaw ?? '').trim();
    if (!key) return;
    if (key.length > 200) key = key.slice(0, 200);
    const id = topicId(kind, key);
    let b = buckets.get(id);
    if (!b) {
      b = { id, kind, key, occurrences: [] };
      buckets.set(id, b);
    }
    if (b.occurrences.length >= lim.occurrencesPerTopic) return;
    b.occurrences.push({
      seq: Number.isFinite(occ?.seq) ? occ.seq : null,
      quote: clip(occ?.quote, lim.quoteChars),
      occurredAt: Number.isFinite(occ?.occurredAt) ? occ.occurredAt : null,
      nodeId: occ?.nodeId ?? null,
      edgeId: occ?.edgeId ?? null,
      source: occ?.source ?? null,
    });
  };

  // ---- 0. 事件：callId → 工具名表。错误串只从「命令类工具」的结果里取，
  // 避免把 read 出来的源码/文档里出现的 "Error: …" 当成真错误（实测会污染 error 主题）。
  const callNames = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const callId = ev?.data?.callId ?? ev?.data?.message?.toolCallId ?? ev?.data?.toolCallId;
    const name = ev?.data?.name;
    if (ev?.type === 'tool/call' && typeof callId === 'string' && typeof name === 'string') {
      callNames.set(callId, name.toLowerCase());
    }
  }

  // ---- 1. 事件：tool/call（参数） ----
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    const seq = Number.isFinite(ev.seq) ? ev.seq : null;
    const ts = Number.isFinite(ev.time) ? ev.time : null;

    if (EVENT_TOOL_KINDS.has(ev.type)) {
      const name = typeof ev.data?.name === 'string' ? ev.data.name.toLowerCase() : null;
      const args = parseArgs(ev.data?.arguments);
      if (name) {
        const primary = args ? (args.command ?? args.file_path ?? args.path ?? args.query ?? args.url ?? '') : '';
        add('tool', name, { seq, occurredAt: ts, quote: `${name} ${clip(primary, 80)}`.trim(), source: 'event:tool/call' });
      }
      if (!args) continue;
      for (const [k, v] of Object.entries(args)) {
        if (typeof v !== 'string' || !v) continue;
        if (COMMAND_ARG_KEYS.has(k)) {
          for (const cmd of extractCommands(v)) {
            add('tool', cmd, { seq, occurredAt: ts, quote: clip(v, 100), source: 'event:tool/call' });
          }
          for (const dep of extractDependencies(v)) {
            add('dependency', dep, { seq, occurredAt: ts, quote: clip(v, 100), source: 'event:tool/call' });
          }
          for (const repo of extractRepos(v)) {
            add('repo', repo, { seq, occurredAt: ts, quote: clip(v, 100), source: 'event:tool/call' });
          }
          for (const u of extractUrls(v)) {
            add('domain', u.host, { seq, occurredAt: ts, quote: clip(u.url, 100), source: 'event:tool/call' });
          }
        }
        if (PATH_ARG_KEYS.has(k)) {
          const p = relativizePath(v, workspace);
          if (p && p !== '.' && p.length >= 3) {
            add('file', p, { seq, occurredAt: ts, quote: clip(v, 100), source: 'event:tool/call' });
          }
        }
        if (URL_ARG_KEYS.has(k)) {
          const u = parseUrl(v);
          if (u) add('domain', u.host, { seq, occurredAt: ts, quote: clip(u.url, 100), source: 'event:tool/call' });
        }
      }
      // 命令/内容里出现的 URL 与仓库（不限 key 名）
      const allArgText = Object.values(args).filter((x) => typeof x === 'string').join('\n');
      for (const u of extractUrls(allArgText)) {
        add('domain', u.host, { seq, occurredAt: ts, quote: clip(u.url, 100), source: 'event:tool/call' });
      }
      for (const repo of extractRepos(allArgText)) {
        add('repo', repo, { seq, occurredAt: ts, quote: clip(repo, 100), source: 'event:tool/call' });
      }
      // 命令串里的文件路径
      for (const [k, v] of Object.entries(args)) {
        if (COMMAND_ARG_KEYS.has(k) || PATH_ARG_KEYS.has(k)) {
          for (const tok of extractPathTokens(v)) {
            const p = relativizePath(tok, workspace);
            if (p && p !== '.' && p.length >= 3) {
              add('file', p, { seq, occurredAt: ts, quote: clip(tok, 100), source: 'event:tool/call' });
            }
          }
        }
      }
      continue;
    }

    // ---- 2. 事件：tool/result（错误串 + 依赖表） ----
    if (ev.type === 'tool/result') {
      const text = eventText(ev);
      if (!text) continue;
      const head = text.slice(0, 6000);
      const callId = ev.data?.toolCallId ?? ev.data?.message?.toolCallId;
      const toolName = callId ? callNames.get(callId) : undefined;
      const fromCommandTool = toolName ? SHELL_ERROR_TOOLS.has(toolName) : true;
      if (fromCommandTool && /\[stderr\]|\[exit code: \d+\]|(?:^|\n)\s*(?:[A-Z][A-Za-z]*Error|ENOENT|EACCES|ERR_[A-Z_]+\b|Cannot find module)/.test(head)) {
        const err = extractErrorKey(head);
        if (err) {
          add('error', err, { seq, occurredAt: ts, quote: clip(err, 120), source: 'event:tool/result' });
          const cls = errorClassKeyOf(err);
          if (cls) add('error', cls, { seq, occurredAt: ts, quote: cls, source: 'error:class' });
        }
      }
      if (/"dependencies"\s*:/.test(head)) {
        for (const dep of extractDependencies(head)) {
          add('dependency', dep, { seq, occurredAt: ts, quote: clip(dep, 100), source: 'event:tool/result' });
        }
      }
    }
  }

  // ---- 3. root user 消息（判别性词 / 目标） ----
  const rootTexts = collectRootUserTexts({ events, graph });
  for (const root of rootTexts) {
    const termSource = sanitizeForTerms(root.text);
    for (const term of extractTerms(termSource, { maxCjk: 14, maxEn: 8 })) {
      const at = termSource.indexOf(term.key);
      const snippet = at >= 0 ? termSource.slice(Math.max(0, at - 24), Math.min(termSource.length, at + term.key.length + 36)) : term.key;
      add('term', term.key, {
        seq: root.seq,
        occurredAt: root.ts,
        quote: clip(snippet, lim.quoteChars),
        nodeId: root.nodeId,
        source: 'user:root',
      });
    }
    const goal = extractGoal(root.text);
    if (goal) {
      add('goal', goal, { seq: root.seq, occurredAt: root.ts, quote: clip(goal, lim.quoteChars), nodeId: root.nodeId, source: 'user:root' });
    }
  }

  // ---- 4. 棋谱：失败边（errorSnippet）+ 边动作（tool/file/domain/repo） ----
  const edges = graph?.edges && typeof graph.edges === 'object' ? Object.values(graph.edges) : [];
  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') continue;
    const seq = Number.isFinite(edge.seq) ? edge.seq : (Number.isFinite(edge.evidence?.start) ? edge.evidence.start : null);
    const ts = Number.isFinite(edge.ts) ? edge.ts : null;
    const execId = edge.id ?? null;
    const { tool, raw } = graphEdgeActionParts(edge.action);
    if (tool) {
      add('tool', tool, { seq, occurredAt: ts, edgeId: execId, quote: clip(raw, 100), source: 'graph:edge.action' });
    }
    for (const dep of extractDependencies(raw)) {
      add('dependency', dep, { seq, occurredAt: ts, edgeId: execId, quote: clip(raw, 100), source: 'graph:edge.action' });
    }
    for (const repo of extractRepos(raw)) {
      add('repo', repo, { seq, occurredAt: ts, edgeId: execId, quote: clip(raw, 100), source: 'graph:edge.action' });
    }
    for (const u of extractUrls(raw)) {
      add('domain', u.host, { seq, occurredAt: ts, edgeId: execId, quote: clip(u.url, 100), source: 'graph:edge.action' });
    }
    // 上游 action 形如 `bash(command=<原文>)` / `write(file_path=<p> content=<c>)`；
    // 值可能含空格与引号，因此按「下一个 arg 键」切段，而不是按空白切。
    const argStarts = [...raw.matchAll(/(?:^|[\s(])(command|file_path|path|dir|cwd|url)=/g)];
    for (let i = 0; i < argStarts.length; i += 1) {
      const key = argStarts[i][1];
      const from = argStarts[i].index + argStarts[i][0].length;
      const to = i + 1 < argStarts.length ? argStarts[i + 1].index : raw.length;
      let value = raw.slice(from, to).trim();
      if (value.endsWith(')')) value = value.slice(0, -1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
      if (!value) continue;
      if (PATH_ARG_KEYS.has(key)) {
        const p = relativizePath(value, workspace);
        if (p && p !== '.' && p.length >= 3) {
          add('file', p, { seq, occurredAt: ts, edgeId: execId, quote: clip(value, 100), source: 'graph:edge.action' });
        }
      }
      if (COMMAND_ARG_KEYS.has(key)) {
        for (const cmd of extractCommands(value)) {
          add('tool', cmd, { seq, occurredAt: ts, edgeId: execId, quote: clip(value, 100), source: 'graph:edge.action' });
        }
        for (const dep of extractDependencies(value)) {
          add('dependency', dep, { seq, occurredAt: ts, edgeId: execId, quote: clip(value, 100), source: 'graph:edge.action' });
        }
        for (const repo of extractRepos(value)) {
          add('repo', repo, { seq, occurredAt: ts, edgeId: execId, quote: clip(value, 100), source: 'graph:edge.action' });
        }
        for (const u of extractUrls(value)) {
          add('domain', u.host, { seq, occurredAt: ts, edgeId: execId, quote: clip(u.url, 100), source: 'graph:edge.action' });
        }
        for (const tok of extractPathTokens(value)) {
          const p = relativizePath(tok, workspace);
          if (p && p !== '.' && p.length >= 3) {
            add('file', p, { seq, occurredAt: ts, edgeId: execId, quote: clip(tok, 100), source: 'graph:edge.action' });
          }
        }
      }
    }
    if (edge.result === 'failure') {
      // 片段属于**结果**事件，不属于**调用**事件（T233/F1）：
      // 失败边的 evidence 有 start（模型开始调用）与 end（结果回来），
      // errorSnippet / 引文实际出现在 end 那个事件里；取 start 会让 seq 系统性偏移一个窗口，
      // 审计按 at-seq 判定时就会周期性报 missing。故 end 优先，start 仅作 fallback。
      const failureSeq = Number.isFinite(edge.evidence?.end)
        ? edge.evidence.end
        : (Number.isFinite(edge.seq) ? edge.seq : (Number.isFinite(edge.evidence?.start) ? edge.evidence.start : null));
      const err = extractErrorKey(edge.errorSnippet) ?? null;
      if (err) {
        add('error', err, { seq: failureSeq, occurredAt: ts, edgeId: execId, quote: clip(edge.errorSnippet, lim.quoteChars), source: 'graph:edge.failure' });
        const cls = errorClassKeyOf(err);
        if (cls) add('error', cls, { seq: failureSeq, occurredAt: ts, edgeId: execId, quote: cls, source: 'error:class' });
      }
    }
  }

  // ---- 5. 收尾：种类上限 + 稳定排序 ----
  const byKind = new Map();
  for (const b of buckets.values()) {
    if (!byKind.has(b.kind)) byKind.set(b.kind, []);
    byKind.get(b.kind).push(b);
  }
  const kept = [];
  for (const [kind, list] of byKind) {
    list.sort((a, b) => (b.occurrences.length - a.occurrences.length) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    kept.push(...list.slice(0, lim[kind] ?? 30));
  }
  // 文件主题去重：绝对路径若是某相对路径的延伸，保留相对形式（跨机稳定）；超长路径丢弃。
  const fileKeys = kept.filter((b) => b.kind === 'file').map((b) => b.key);
  const dropFile = new Set();
  for (const a of fileKeys) {
    if (a.length > 140) dropFile.add(a);
    for (const b of fileKeys) {
      if (a === b) continue;
      const al = a.toLowerCase();
      const bl = b.toLowerCase();
      if (bl.endsWith(`/${al}`)) dropFile.add(b); // 绝对形式被相对形式覆盖
      if (bl.startsWith(`${al}/`) || bl.startsWith(`${al} `)) dropFile.add(a); // 空白切词的残片
    }
  }
  const finalList = kept.filter((b) => b.kind !== 'file' || !dropFile.has(b.key));
  finalList.sort((a, b) => (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return finalList.map((b) => {
    const times = b.occurrences.map((o) => o.occurredAt).filter((t) => Number.isFinite(t));
    return {
      id: b.id,
      kind: b.kind,
      key: b.key,
      count: b.occurrences.length,
      firstSeenAt: times.length ? Math.min(...times) : null,
      lastSeenAt: times.length ? Math.max(...times) : null,
      occurrences: b.occurrences,
    };
  });
}

/**
 * root user 消息：优先棋谱的 rootUserNodeIds（机械、权威）；否则取首条**真用户**的 user/message。
 * 不读 session/title（模型生成，属摘要，不得作源）。
 * 也不吃注入卡：判据与 R03 的 `isUserMessage` 同口径（`data.source.kind === "user"`），见 `isUserMessageEvent`。
 */
export function collectRootUserTexts({ events = [], graph = null } = {}) {
  const out = [];
  const ids = Array.isArray(graph?.rootUserNodeIds) ? graph.rootUserNodeIds : [];
  for (const id of ids) {
    const node = graph?.nodes?.[id];
    const text = typeof node?.text === 'string' ? node.text : '';
    if (!text.trim()) continue;
    out.push({
      text,
      seq: Number.isFinite(node.seq) ? node.seq : null,
      ts: Number.isFinite(node.ts) ? node.ts : null,
      nodeId: id,
    });
  }
  if (out.length) return out;
  const first = (Array.isArray(events) ? events : [])
    .filter(isUserMessageEvent)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0];
  if (first) {
    const text = userEventText(first);
    if (text.trim()) out.push({ text, seq: first.seq ?? null, ts: Number.isFinite(first.time) ? first.time : null, nodeId: null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// df / IDF
// ---------------------------------------------------------------------------

/**
 * 文档频率：一个主题出现在多少局棋谱里（契约 §4）。
 * @param {Array} perEpisode [{episodeId, topics:[…]}] 或 [[…]] 或 [{topics}] 混排
 * @returns {{n:number, topics:Array, byId:Map}}
 */
export function computeDf(perEpisode, { n } = {}) {
  const list = Array.isArray(perEpisode) ? perEpisode : [];
  const N = Number.isFinite(n) ? n : list.length;
  const acc = new Map();

  list.forEach((entry, idx) => {
    const episodeId = Array.isArray(entry) ? `#${idx}` : (entry?.episodeId ?? entry?.id ?? `#${idx}`);
    const topics = Array.isArray(entry) ? entry : (entry?.topics ?? []);
    const seen = new Set();
    for (const t of topics) {
      if (!t || !t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      let a = acc.get(t.id);
      if (!a) {
        a = { id: t.id, kind: t.kind, key: t.key, episodes: new Set(), firstSeenAt: null, lastSeenAt: null };
        acc.set(t.id, a);
      }
      a.episodes.add(episodeId);
      const first = Number.isFinite(t.firstSeenAt) ? t.firstSeenAt : null;
      const last = Number.isFinite(t.lastSeenAt) ? t.lastSeenAt : null;
      if (first !== null) a.firstSeenAt = a.firstSeenAt === null ? first : Math.min(a.firstSeenAt, first);
      if (last !== null) a.lastSeenAt = a.lastSeenAt === null ? last : Math.max(a.lastSeenAt, last);
    }
  });

  const topics = [...acc.values()].map((a) => {
    const df = a.episodes.size;
    const idf = Math.log((N + 1) / (df + 0.5));
    const idfNorm = clamp(idf / Math.log(N + 2), 0, 1);
    return {
      id: a.id,
      kind: a.kind,
      key: a.key,
      df,
      idf,
      idfNorm,
      firstSeenAt: a.firstSeenAt,
      lastSeenAt: a.lastSeenAt,
      episodes: [...a.episodes],
    };
  });
  topics.sort((a, b) => (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    || (a.id < b.id ? -1 : 1));

  return { n: N, topics, byId: new Map(topics.map((t) => [t.id, t])) };
}

/**
 * 脚手架（scaffold）：同一前缀族被 ≥2 个不同包名共用（主人例：magpie-plugin-*）。
 * 纯机械：取包名前两段（需 ≥3 段），族内成员数 ≥2 ⇒ 该族是脚手架；局内命中任一成员即记。
 * @returns 新的 perEpisode 数组（已合并 scaffold 主题），不修改入参
 */
export function deriveScaffoldTopics(perEpisode, { minMembers = 2 } = {}) {
  const family = (pkg) => {
    const segs = pkg.split('-');
    if (segs.length < 3) return null;
    const prefix = segs.slice(0, 2).join('-');
    return prefix.length >= 3 ? prefix : null;
  };
  const groups = new Map();
  for (const entry of perEpisode) {
    const topics = Array.isArray(entry) ? entry : (entry?.topics ?? []);
    for (const t of topics) {
      if (t?.kind !== 'dependency') continue;
      const f = family(t.key);
      if (!f) continue;
      if (!groups.has(f)) groups.set(f, new Set());
      groups.get(f).add(t.key);
    }
  }
  const scaffolds = new Map([...groups].filter(([, members]) => members.size >= minMembers));

  return perEpisode.map((entry) => {
    const isArr = Array.isArray(entry);
    const topics = isArr ? entry : (entry?.topics ?? []);
    const extra = [];
    for (const t of topics) {
      if (t?.kind !== 'dependency') continue;
      const f = family(t.key);
      if (!f || !scaffolds.has(f)) continue;
      if (extra.some((x) => x.key === f)) continue;
      extra.push({
        id: topicId('scaffold', f),
        kind: 'scaffold',
        key: f,
        count: t.occurrences?.length ?? 1,
        firstSeenAt: t.firstSeenAt ?? null,
        lastSeenAt: t.lastSeenAt ?? null,
        occurrences: (t.occurrences ?? []).slice(0, 1).map((o) => ({ ...o, source: 'derived:scaffold' })),
      });
    }
    const merged = extra.length ? [...topics, ...extra] : topics;
    return isArr ? merged : { ...entry, topics: merged };
  });
}

export default { extractTopics, computeDf, deriveScaffoldTopics, topicId, idfNorm: (df, n) => clamp(Math.log((n + 1) / (df + 0.5)) / Math.log(n + 2), 0, 1) };
