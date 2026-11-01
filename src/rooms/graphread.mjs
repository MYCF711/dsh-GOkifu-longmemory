/**
 * R02 graphread —— 棋谱读侧：基线 `graph.json` + `graph.json.delta.jsonl` 逐帧回放。
 *
 * 契约（AGENTS §11 · R02）
 * - 入口导出：`loadGraphAt({basePath, deltaPath})`；配套纯函数 `applyDelta` / `decodeDeltaFrames` /
 *   `checksum31` / `baseHashOf` / `rebuildStateIndex`（测试与后续房间复用，不另设读法）。
 * - 输入：`basePath` = 某会话目录下的 `graph.json`；`deltaPath` 缺省 = `${basePath}.delta.jsonl`。
 * - 输出：`{ graph, baseHash, frames, truncated, reason, missing, corrupt, deltaPath, error }`
 *   · `graph` 永远是「基线 + 已成功回放的前缀」，绝不把半帧当成最新图。
 * - 错误语义：
 *   · `graph.json` 不存在 → `{graph:null, missing:true}`（不抛：库扫描时"没棋谱"是常态）；
 *   · `graph.json` 解析失败 → `{graph:null, corrupt:true, error}`（不抛：一局坏图不许打断整库统计，
 *     但必须显式立旗，不许静默降级成空图）；
 *   · `graph.json` 版本未知 → **抛** `graphread: unsupported version <v>`（fail-closed，AGENTS §2.3）；
 *   · delta 帧版本未知 → **抛** `graphread: unsupported delta version <v>`；
 *   · delta 坏尾（半写行 / 校验不通 / 基线哈希不匹配 / JSON 断）→ 返回已回放前缀 + `truncated:true`
 *     + `reason`（`malformed-frame` | `checksum` | `base-mismatch` | `bad-json`），不抛。
 * - 幂等：`applyDelta` 是绝对覆盖（upsert + 追加去重），同一批帧回放两次 == 回放一次。
 *
 * ⚠ 为什么必须走这一层：`graph.json` 是基线快照，比最新状态**少一回合**；直接 `JSON.parse` 当最新会少节点/边。
 *   真实样本（2026-11-02）：`3a50f4d2-…` 基线 `edges:{}`、delta 41 帧 → 回放后 41 条边；只读基线 = 0 条边。
 *
 * 允许依赖：`node:fs` / `node:path` / `node:crypto`（见下注）/ R00。
 * 禁止依赖：上游 `dsh-gokifu-compact` 包、R01、任何第三方包。
 *
 * 注：`node:crypto` 不是"新增依赖"，是本格式的硬要求 —— 每个 delta 帧的首列就是「它写在其上的那份
 * `graph.json` 文本」的 **sha256 前 16 位十六进制**，不比对就无法判断帧是否属于当前基线。
 * sha256 不手搓；不引上游包、不复制上游源码（本文件的帧解码/应用逻辑按格式独立实现，语义对齐上游
 * `kifu-model.mjs` 的 `decodeDeltaFrames` / `applyDelta`：upsert 覆盖、del* 删除、scalars 白名单、
 * order 追加去重、stateIndex 派生重建）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** 棋谱基线格式版本（graph.json.version）。 */
export const GRAPH_VERSION = 1;
/** 增量帧格式版本（帧内 `v`）。 */
export const DELTA_VERSION = 1;

/** delta 帧里允许覆盖的标量（白名单：其余字段只由基线确立，帧无权改）。 */
export const DELTA_SCALARS = Object.freeze([
  'updatedAt',
  'nextNode',
  'nextEdge',
  'rootUserNodeIds',
  'foldCount',
  'lastFoldTotalTokens',
  'checkpointSeq',
]);

/** 基线文本的内容哈希（十六进制全串）。帧首列用它前 16 位。 */
export function baseHashOf(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * 帧体便宜校验（不是密码学哈希；只用来挡「半写 / 坏帧」）。
 * 与格式对齐：`h = (h*31 + charCode) | 0`，逐字符左折。
 */
export function checksum31(text) {
  const s = String(text ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * 解码 delta 文件文本。一帧一行：`<基线哈希前16位>\t<checksum31 十进制>\t<delta JSON>`。
 * 遇到第一处坏帧就停（就地截断），把后面的内容当坏尾 —— 后续追加会接在坏帧后面，不可信。
 *
 * @returns {{frames: object[], truncated: boolean, reason: string|null, lineNo: number}}
 *   `lineNo` = 最后一个好帧的行号（0 表示一帧都没成）。
 */
export function decodeDeltaFrames(text, baseHash) {
  const frames = [];
  const lines = String(text ?? '').split('\n');
  let lineNo = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) continue;
    const p1 = line.indexOf('\t');
    const p2 = p1 < 0 ? -1 : line.indexOf('\t', p1 + 1);
    if (p1 < 0 || p2 < 0) return { frames, truncated: true, reason: 'malformed-frame', lineNo };
    if (line.slice(0, p1) !== baseHash) return { frames, truncated: true, reason: 'base-mismatch', lineNo };
    const sum = Number(line.slice(p1 + 1, p2));
    const body = line.slice(p2 + 1);
    if (!Number.isFinite(sum) || checksum31(body) !== sum) return { frames, truncated: true, reason: 'checksum', lineNo };
    let delta;
    try {
      delta = JSON.parse(body);
    } catch {
      return { frames, truncated: true, reason: 'bad-json', lineNo };
    }
    if (delta?.v !== DELTA_VERSION) {
      // 版本不认识 ⇒ 拒绝语义（不许静默跳帧，也不许静默降级）。
      throw new Error(`graphread: unsupported delta version ${delta?.v}`);
    }
    frames.push(delta);
    lineNo = i + 1;
  }
  return { frames, truncated: false, reason: null, lineNo };
}

/**
 * 把一帧增量应用到图上（**原地**改，返回同一对象）。
 * 幂等：upsert 绝对覆盖；order 追加前查重；stateIndex 是不变量 ⇒ 每次重算（派生数据，永不进 delta）。
 */
export function applyDelta(graph, delta) {
  if (!delta || delta.v !== DELTA_VERSION) throw new Error(`graphread: unsupported delta version ${delta?.v}`);
  const g = graph;
  g.nodes ??= {};
  g.edges ??= {};
  g.order ??= [];
  for (const [id, node] of Object.entries(delta.nodes ?? {})) g.nodes[id] = node;
  for (const [id, edge] of Object.entries(delta.edges ?? {})) g.edges[id] = edge;
  for (const id of delta.delNodes ?? []) delete g.nodes[id];
  for (const id of delta.delEdges ?? []) delete g.edges[id];
  const s = delta.scalars ?? {};
  for (const k of DELTA_SCALARS) if (s[k] !== undefined) g[k] = s[k];
  if (s.lastFoldUsage !== undefined) g.lastFoldUsage = s.lastFoldUsage;
  if (Array.isArray(s.foldMarks)) g.foldMarks = s.foldMarks;
  for (const id of delta.orderDrop ?? []) {
    const at = g.order.indexOf(id);
    if (at >= 0) g.order.splice(at, 1);
  }
  const append = delta.orderAppend ?? [];
  if (append.length > 0) {
    const seen = new Set(g.order);
    for (const id of append) {
      if (seen.has(id)) continue;
      g.order.push(id);
      seen.add(id);
    }
  }
  rebuildStateIndex(g);
  return g;
}

/** stateIndex 重建：按 order 时序，只收非 pending 的 agent，同 (worldHash/constraintHash) 取首现。 */
export function rebuildStateIndex(graph) {
  const rebuilt = {};
  for (const id of graph?.order ?? []) {
    const n = graph.nodes?.[id];
    if (!n || n.kind !== 'agent') continue;
    if (n.worldHash === 'pending' || n.constraintHash === 'pending') continue;
    const key = `${n.worldHash}/${n.constraintHash}`;
    if (rebuilt[key] === undefined) rebuilt[key] = id;
  }
  graph.stateIndex = rebuilt;
  return rebuilt;
}

/**
 * 读一局的最新棋谱：基线 + delta 回放。
 *
 * @param {{basePath: string, deltaPath?: string}} paths
 * @returns {{graph: object|null, baseHash: string|null, deltaPath: string, frames: number,
 *            truncated: boolean, reason: string|null, missing: boolean, corrupt: boolean, error: string|null}}
 */
export function loadGraphAt({ basePath, deltaPath } = {}) {
  const dPath = deltaPath ?? `${basePath}.delta.jsonl`;
  const out = {
    graph: null,
    baseHash: null,
    deltaPath: dPath,
    frames: 0,
    truncated: false,
    reason: null,
    missing: false,
    corrupt: false,
    error: null,
  };
  if (!basePath || !existsSync(basePath)) return { ...out, missing: true, reason: 'missing-base' };

  const text = readFileSync(basePath, 'utf8');
  let graph;
  try {
    graph = JSON.parse(text);
  } catch (error) {
    return { ...out, corrupt: true, reason: 'bad-baseline', error: String(error?.message ?? error) };
  }
  if (!graph || typeof graph !== 'object') return { ...out, corrupt: true, reason: 'bad-baseline', error: 'baseline is not an object' };
  if (graph.version !== GRAPH_VERSION) throw new Error(`graphread: unsupported version ${graph.version}`);

  const baseHash = baseHashOf(text).slice(0, 16);
  out.graph = graph;
  out.baseHash = baseHash;
  graph.nodes ??= {};
  graph.edges ??= {};
  graph.order ??= [];

  if (!existsSync(dPath)) return out;
  const { frames, truncated, reason } = decodeDeltaFrames(readFileSync(dPath, 'utf8'), baseHash);
  for (const f of frames) applyDelta(graph, f);
  return { ...out, frames: frames.length, truncated, reason };
}
