// R00 · episode —— 会话 → 棋谱（闭包 / 时间窗 / 信号占位）
//
// ── 契约（docs/数据契约.md §2，M1 冻结；AGENTS §4.1 / 方案 §4.1、§4.9、§4.10）──
// 职责：把 R01 读出的 {header, events} 归一成一条棋谱记录：作用域、双时钟、
//       闭包（这局覆盖了哪段日志/哪张棋谱/哪些 seq）、信号计数占位。
// 入口：buildEpisode({ header, events, graphPath, logPath, now }) -> episode
//       另导出 shortSessionId(sessionId) / normalizeWorkspace(cwd) 供其它房间复用
// 输入→输出：
//   header      = R01 parseEvents().header（{"type":"session", version:4, id, createdAt, cwd,
//                 isSeeded, delegationDepth, agentPreset, parentSession?, origin?}）
//   events      = R01 parseEvents().events（{type, seq, time, data}）
//   episode     = { id:"ep-<sid8>", sessionId, scopeKey:"w:<规范化 cwd>", scopeSource,
//                   startedAt, endedAt, firstEventAt, lastEventAt, recordedAt,
//                   timeSource:"event"|"inferred", eventsWithoutTime,
//                   agentPreset, delegationDepth, parentSessionId, origin,
//                   closure:{ logPath, graphPath, seqFrom, seqTo, eventCount, nodeIds:[], edgeIds:[] },
//                   l0:"", l1:"",                       // M2 填
//                   signals:{ failures:0, successes:0, unsettled:0, constraints:0, tools:[] },
//                   threadIds: [], state:"archived" }
// 时间语义（§4.9 双时钟，硬规则）：
//   occurredAt 一侧 = startedAt / firstEventAt / lastEventAt，来自**事件 time**（epoch ms）
//   recordedAt     = 入馆时间（第二时钟），来自参数 `now`；**不参与新旧判断**。
//                    M1 只读不入馆 ⇒ 不传 now 时为 null（契约 §2「可为 null」），绝不拿 Date.now() 冒充。
//   startedAt = header.createdAt；endedAt = 最后事件 time（无带 time 的事件时 = startedAt）。
//   firstEventAt/lastEventAt = 事件 time 的 min/max（无带 time 的事件时 = startedAt）。
//   timeSource = 'event'（每条事件都带 time）｜'inferred'（有事件缺 time 或全无 time）；
//   更细的缺时条数见附加字段 eventsWithoutTime（附加字段不破坏冻结枚举）。
// 作用域：用**日志 header 的 cwd**（不是棋谱里的 cwd——那是 profiles\desktop，见 AGENTS §5 陷阱 3）。
//   scopeKey = "w:" + 规范化路径（盘符统一小写、反斜杠转 /、去尾斜杠、不补根斜杠）。
// 归并：子代理会话带 header.parentSession + origin:"subagent" + delegationDepth>0；R00 原样带出
//   （parentSessionId），**归并到父局由调用方做**（AGENTS §4.1「只收 depth=0」）。
//   [本] 2026-11-02 实测 90 份日志：66 份 origin=subagent / dd=1，parentSession 全部指向存在的父局，
//   无悬空父、无 depth 反向；24 份 dd=0 可独立成谱。
// 错误语义：缺 header.id / 缺 header.createdAt / events 不是数组 ⇒ throw EpisodeError
//           （不带 id 或没有发生时间的棋谱是假记忆，宁可不入馆）
// 允许依赖：无（纯函数，零 import，不读盘）。
// 冻结后允许新增字段，不允许改语义：`scopeSource` / `eventsWithoutTime` / `parentSessionId` /
//   `origin` / `closure.eventCount` 均为**新增字段**；`timeSource` 严格限定在冻结的两值内。

/** episode 的错误类型（R00 允许零依赖，故不复用 R01 的错误类）。 */
export class EpisodeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EpisodeError';
    this.code = code;
  }
}

/**
 * 会话 id → 棋谱短 id（`ep-<sid8>`）。去掉 `session-` 前缀后取前 8 个字符。
 * @param {string} sessionId
 * @returns {string} 8 字符短 id（小写）；拿不到时返回 'unknown'
 */
export function shortSessionId(sessionId) {
  if (typeof sessionId !== 'string') return 'unknown';
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  const short = bare.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8).toLowerCase();
  return short === '' ? 'unknown' : short;
}

/**
 * 工作区路径规范化（用于 scopeKey）：反斜杠→正斜杠、盘符小写、去尾斜杠。
 * @param {string} cwd
 * @returns {string} 规范化路径；输入无效时返回 ''
 */
export function normalizeWorkspace(cwd) {
  if (typeof cwd !== 'string') return '';
  let path = cwd.trim().replace(/\\/g, '/');
  if (path === '') return '';
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(path);
  // 只小写盘符，不补斜杠：`E:`（盘符相对）与 `E:/`（盘根）是两种路径，改写会伪造作用域。
  if (drive) path = `${drive[1].toLowerCase()}:${drive[2] ?? ''}`;
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  return path;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function firstFinite(...values) {
  for (const value of values) if (finite(value)) return value;
  return null;
}

/**
 * 会话 → 棋谱记录。
 * @param {{header: object, events: object[], graphPath?: string|null, logPath?: string|null,
 *          now?: number|null, recordedAt?: number|null}} input
 *        `now` = 入馆时钟（契约 §2 参数名）；`recordedAt` 作为同义别名接受。
 * @returns {object} episode（形状见文件头契约）
 */
export function buildEpisode(input) {
  if (input === null || typeof input !== 'object') {
    throw new EpisodeError('episode: input must be an object {header, events}', 'episode/input');
  }
  const { header, events } = input;
  if (header === null || typeof header !== 'object' || typeof header.id !== 'string' || header.id === '') {
    throw new EpisodeError('episode: missing header.id', 'episode/missing-id');
  }
  if (!finite(header.createdAt)) {
    throw new EpisodeError('episode: missing header.createdAt (occurredAt cannot be inferred)', 'episode/missing-createdAt');
  }
  if (!Array.isArray(events)) {
    throw new EpisodeError('episode: events must be an array', 'episode/input');
  }

  const startedAt = header.createdAt;
  let seenTime = 0;
  let firstEventAt = Number.POSITIVE_INFINITY;
  let lastEventAt = Number.NEGATIVE_INFINITY;
  let seqFrom = Number.POSITIVE_INFINITY;
  let seqTo = Number.NEGATIVE_INFINITY;
  let eventsWithoutTime = 0;

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (finite(event.time)) {
      seenTime += 1;
      if (event.time < firstEventAt) firstEventAt = event.time;
      if (event.time > lastEventAt) lastEventAt = event.time;
    } else {
      eventsWithoutTime += 1;
    }
    if (finite(event.seq)) {
      if (event.seq < seqFrom) seqFrom = event.seq;
      if (event.seq > seqTo) seqTo = event.seq;
    }
  }

  if (seenTime === 0) {
    // 无任何事件时间 ⇒ 窗口回退 header.createdAt（§4.9 + AGENTS 陷阱 10 允许的回退）
    firstEventAt = startedAt;
    lastEventAt = startedAt;
  }
  const timeSource = eventsWithoutTime > 0 || seenTime === 0 ? 'inferred' : 'event';
  const endedAt = seenTime === 0 ? startedAt : lastEventAt;

  const workspace = normalizeWorkspace(header.cwd);
  const scopeKey = `w:${workspace === '' ? 'unknown' : workspace}`;
  const recordedAt = firstFinite(input.now, input.recordedAt);

  return {
    id: `ep-${shortSessionId(header.id)}`,
    sessionId: header.id,
    parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : null,
    scopeKey,
    scopeSource: workspace === '' ? 'unknown' : 'header.cwd',
    startedAt,
    endedAt,
    firstEventAt,
    lastEventAt,
    recordedAt,
    timeSource,
    eventsWithoutTime,
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
    origin: typeof header.origin === 'string' ? header.origin : null,
    delegationDepth: finite(header.delegationDepth) ? header.delegationDepth : 0,
    closure: {
      logPath: typeof input.logPath === 'string' ? input.logPath : null,
      graphPath: typeof input.graphPath === 'string' ? input.graphPath : null,
      seqFrom: finite(seqFrom) ? seqFrom : null,
      seqTo: finite(seqTo) ? seqTo : null,
      eventCount: events.length,
      nodeIds: [],
      edgeIds: [],
    },
    l0: '',
    l1: '',
    signals: { failures: 0, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    threadIds: [],
    state: 'archived',
  };
}
