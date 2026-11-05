// R04 topic 的 tombstone test：删掉 src/rooms/topic.mjs ⇒ 本文件整片红。
//
// 覆盖（契约 docs/数据契约.md §4 + 方案 §4.2）：
//   - 机械来源：工具参数里的文件路径 / 命令 / URL+域名 / 仓库名 / package deps / 错误串
//   - root user 消息的判别性词：CJK 2-gram + 英文词，去停用词
//   - df 与 IDF 归一（同式于 R05）
//   - 棋谱失败边的 errorSnippet 也能进主题（带 edgeId）
//   - 纯函数：同输入同输出；无事件不抛

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTopics,
  computeDf,
  deriveScaffoldTopics,
  topicId,
  hash8,
  normalizePath,
  relativizePath,
  extractErrorKey,
  extractTerms,
  extractGoal,
  extractDependencies,
  extractCommands,
  extractRepos,
  extractPathTokens,
  dedupePathPrefixes,
  HARD_KINDS,
  SOFT_KINDS,
  CJK_STOPWORDS,
  EN_STOPWORDS,
  collectRootUserTexts,
} from '../src/rooms/topic.mjs';

const CWD = 'D:\\work\\demo';

const toolCall = (seq, name, args, time = 1_700_000_000_000 + seq) => ({
  type: 'tool/call',
  seq,
  time,
  data: { turn: 1, step: 1, callId: `call-${seq}`, name, arguments: JSON.stringify(args) },
});

const toolResult = (seq, text, time = 1_700_000_000_000 + seq) => ({
  type: 'tool/result',
  seq,
  time,
  data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: `call-${seq}`, content: [{ type: 'text', text }] } },
});

const userMessage = (seq, text, time = 1_700_000_000_000 + seq) => ({
  type: 'user/message',
  seq,
  time,
  // 形状与真日志一致（T245）：`data.role` + `data.source.kind` 都在。
  // 缺了它们就是"来源不明"——R03/R04 都按 fail-closed 处理（判据见 `R04: 注入卡不当根用户` 那组用例）。
  data: { content: [{ type: 'text', text }], role: 'user', source: { kind: 'user' } },
});

/**
 * 注入卡事件：形状逐字取自真日志（T244 实测 628 条）——
 * `type:"user/message"` + `role:"user"`，唯一区别是 `data.source.kind === "dsh-gokifu-longmemory"`。
 */
const cardMessage = (seq, text = 'MEMORY: …\n<memory-ledger>\n- [observed] 产品目标是记忆系统。\n</memory-ledger>', time = 1_700_000_000_000 + seq) => ({
  type: 'user/message',
  seq,
  time,
  data: { content: [{ type: 'text', text }], role: 'user', source: { kind: 'dsh-gokifu-longmemory' } },
});

function episodeA() {
  return {
    id: 'ep-aaaaaaa1',
    sessionId: 'aaaaaaa1-0000-4000-8000-000000000000',
    scopeKey: `w:${CWD.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`)}`,
    startedAt: 1_700_000_000_000,
    events: [
      userMessage(1, '你的任务：修复 topic 抽取（task-3）。记忆系统的主题抽取必须是机械规则，不要模型判断。'),
      toolCall(2, 'bash', {
        command: 'git clone https://github.com/MYCF711/dsh-kifuin.git && cd dsh-kifuin && npm add yaml',
        description: 'clone and install',
      }),
      toolCall(3, 'read', { file_path: 'D:\\work\\demo\\src\\rooms\\topic.mjs' }),
      toolResult(4, '[stderr]\nError: Cannot find module \'yaml\'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1)\n[exit code: 1]'),
      toolCall(5, 'write', { file_path: 'D:\\work\\demo\\test\\topic.test.mjs', content: 'import x from "fs"' }),
    ],
  };
}

function episodeB() {
  return {
    id: 'ep-bbbbbbb2',
    sessionId: 'bbbbbbb2-0000-4000-8000-000000000000',
    scopeKey: `w:${CWD.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`)}`,
    startedAt: 1_700_000_100_000,
    events: [
      userMessage(1, '任务：实现 link 相关边。记忆系统要把棋谱写进同一张网。'),
      toolCall(2, 'bash', { command: 'curl https://api.github.com/repos/MYCF711/dsh-kifuin' }),
      toolCall(3, 'edit', { file_path: 'D:\\work\\demo\\src\\rooms\\link.mjs' }),
      toolResult(4, 'ok'),
    ],
    graph: {
      version: 1,
      nodes: {},
      edges: {
        e1: {
          id: 'e1',
          from: 'n1',
          to: 'n2',
          action: 'bash(command=cd "D:/work/demo"; node scripts/cli.mjs stats)',
          result: 'failure',
          errorSnippet: 'Error: Cannot find module \'yaml\'',
          ts: 1_700_000_100_500,
        },
      },
    },
  };
}

function topicsOf(ep) {
  return extractTopics({
    episode: { id: ep.id, scopeKey: ep.scopeKey, startedAt: ep.startedAt },
    events: ep.events ?? [],
    graph: ep.graph ?? null,
  });
}

const kindKeys = (topics, kind) => topics.filter((t) => t.kind === kind).map((t) => t.key);

test('R04: 从工具参数抽 repo / file / dependency / tool / domain（机械规则）', () => {
  const topics = topicsOf(episodeA());

  assert.ok(kindKeys(topics, 'repo').includes('mycf711/dsh-kifuin'), 'github URL → repo:owner/name（小写）');
  assert.ok(kindKeys(topics, 'file').includes('src/rooms/topic.mjs'), '工作区内绝对路径 → 仓内相对路径');
  assert.ok(kindKeys(topics, 'file').includes('test/topic.test.mjs'));
  assert.ok(kindKeys(topics, 'dependency').includes('yaml'), 'npm add yaml → dependency');
  assert.ok(!kindKeys(topics, 'dependency').includes('fs'), 'node 内置模块不是依赖');
  assert.ok(kindKeys(topics, 'domain').includes('github.com'), 'URL → domain（去端口、小写）');
  for (const t of ['bash', 'read', 'git', 'npm', 'cd']) {
    assert.ok(kindKeys(topics, 'tool').includes(t), `工具名/命令名 → tool:${t}`);
  }
});

test('R04: 错误串归一（同一错误的原文在路径不同时仍相等）', () => {
  const a = extractErrorKey('[stderr]\nError: ENOENT: no such file or directory, open \'D:\\work\\demo\\x.json\'\n    at Object.<anonymous>');
  const b = extractErrorKey('boom\nError: ENOENT: no such file or directory, open \'/tmp/other/y.json\'');
  assert.equal(a, b, '同一错误文本、不同路径 ⇒ 同一 key');
  assert.match(a, /^Error: ENOENT/);
  assert.equal(extractErrorKey('[exit code: 1]'), 'exit code 1', 'bash 失败标记归一');
  assert.equal(extractErrorKey('all good, nothing failed'), null);

  const topics = topicsOf(episodeA());
  const errors = kindKeys(topics, 'error');
  assert.ok(errors.includes("Error: Cannot find module 'yaml'"), 'tool/result 里的错误进 error 主题');
});

test('R04: root user 消息 → CJK 2-gram 判别性词（去停用词）', () => {
  const terms = extractTerms('记忆系统的主题抽取要机械；项目文件需要可以解决的问题').map((t) => t.key);
  assert.ok(terms.includes('记忆'), '边界处的 2-gram 保留');
  assert.ok(terms.includes('系统'));
  assert.ok(!terms.includes('忆系'), '只出现在词内部的 2-gram（切词碎片）丢弃');
  for (const stop of ['项目', '文件', '需要', '可以', '问题', '主题']) {
    if (CJK_STOPWORDS.has(stop)) assert.ok(!terms.includes(stop), `停用词 ${stop} 被剔除`);
  }

  const topics = topicsOf(episodeA());
  const termKeys = kindKeys(topics, 'term');
  assert.ok(termKeys.includes('记忆'), '主题里含 CJK 词');
  assert.ok(termKeys.some((k) => k === 'topic' || k === 'task-3' || k === 'task'), '英文词也进 term（大小写归一）');
  assert.ok(!termKeys.includes('the'), '英文停用词剔除');
  assert.ok(EN_STOPWORDS.has('the'));
});

test('R04: goal 只认显式任务句式', () => {
  assert.equal(extractGoal('你的任务：修复 topic 抽取（task-3）。记忆系统…'), '修复 topic 抽取');
  assert.equal(extractGoal('任务：实现 link 相关边。记忆系统要把棋谱写进同一张网。'), '实现 link 相关边');
  assert.equal(extractGoal('随便聊聊天气'), null);

  const topics = topicsOf(episodeB());
  assert.deepEqual(kindKeys(topics, 'goal').slice(0, 1), ['实现 link 相关边']);
});

test('R04: 棋谱失败边 → error 主题（带 edgeId），边动作 → tool/file', () => {
  const topics = topicsOf(episodeB());
  const errorTopic = topics.find((t) => t.kind === 'error');
  assert.ok(errorTopic, '失败边 errorSnippet 进 error');
  assert.equal(errorTopic.key, "Error: Cannot find module 'yaml'");
  assert.equal(errorTopic.occurrences[0].edgeId, 'e1', '节点↔节点直连需要 edgeId');
  assert.ok(kindKeys(topics, 'tool').includes('node'));
  assert.ok(kindKeys(topics, 'file').includes('scripts/cli.mjs'));
});

test('R04: computeDf 的 df 与 IDF 归一', () => {
  const a = topicsOf(episodeA());
  const b = topicsOf(episodeB());
  const { n, topics, byId } = computeDf([
    { episodeId: 'ep-a', topics: a },
    { episodeId: 'ep-b', topics: b },
  ]);

  assert.equal(n, 2);
  const repo = topics.find((t) => t.kind === 'repo' && t.key === 'mycf711/dsh-kifuin');
  assert.equal(repo.df, 2, '两局共有的主题 df=2');
  assert.deepEqual([...repo.episodes].sort(), ['ep-a', 'ep-b']);

  const err = topics.find((t) => t.kind === 'error' && t.key === "Error: Cannot find module 'yaml'");
  assert.equal(err.df, 2, '两局同一错误 df=2');

  const uniqueFile = topics.find((t) => t.kind === 'file' && t.key === 'test/topic.test.mjs');
  assert.equal(uniqueFile.df, 1, '只在一局出现 df=1');
  assert.ok(uniqueFile.idf > 0, 'idf > 0');
  assert.ok(uniqueFile.idfNorm > 0 && uniqueFile.idfNorm <= 1, 'idfNorm ∈ (0,1]');

  assert.equal(byId.size, topics.length, 'byId 与 topics 一致');
  assert.equal(topicId('repo', 'x'), `t:repo:${hash8('repo\u0000x')}`, '契约 §4：t:<kind>:<hash8>');
});

test('R04: scaffold 由同一前缀族的依赖机械推导（magpie 案例）', () => {
  const e1 = extractTopics({
    episode: { id: 'ep-1', scopeKey: 'w:d:/work/a' },
    events: [toolCall(1, 'bash', { command: 'pnpm add magpie-plugin-alpha' })],
  });
  const e2 = extractTopics({
    episode: { id: 'ep-2', scopeKey: 'w:d:/work/b' },
    events: [toolCall(1, 'bash', { command: 'pnpm add magpie-plugin-beta' })],
  });
  const per = deriveScaffoldTopics([
    { episodeId: 'ep-1', topics: e1 },
    { episodeId: 'ep-2', topics: e2 },
  ]);
  const scaffold = per[0].topics.find((t) => t.kind === 'scaffold');
  assert.ok(scaffold, '同族 ≥2 个包 ⇒ 推导出 scaffold');
  assert.equal(scaffold.key, 'magpie-plugin');
  assert.ok(HARD_KINDS.has('scaffold'), 'scaffold 属硬主题（方案 §4.2 共用基础）');
  assert.ok(SOFT_KINDS.has('term'));
  assert.ok(!HARD_KINDS.has('term'));
});

test('R04: 路径规范化与 prefix 去重（不把空白切词的残片当文件）', () => {
  assert.equal(normalizePath('/d/DeepSeek Harness/home/x.mjs'), 'd:/DeepSeek Harness/home/x.mjs');
  assert.equal(normalizePath('D:\\work\\demo\\a.mjs'), 'd:/work/demo/a.mjs');
  assert.equal(relativizePath('D:\\work\\demo\\src\\x.mjs', 'd:/work/demo'), 'src/x.mjs');
  assert.equal(relativizePath('E:\\other\\y.mjs', 'd:/work/demo'), 'e:/other/y.mjs');

  const tokens = extractPathTokens('cd "D:\\DeepSeek Harness\\home" && sed -n \'/## 4.1/p\' src/rooms/topic.mjs');
  assert.ok(tokens.includes('d:/DeepSeek Harness/home') || tokens.includes('D:\\DeepSeek Harness\\home'));
  assert.ok(tokens.some((t) => t.endsWith('src/rooms/topic.mjs')));
  assert.ok(!tokens.some((t) => t.includes('#')), '正则/注释残片不是路径');
  assert.deepEqual(dedupePathPrefixes(['d:/a', 'd:/a/b.mjs']), ['d:/a/b.mjs']);
});

test('R04: 纯函数 —— 同输入同输出、空输入不抛', () => {
  const once = topicsOf(episodeB());
  const twice = topicsOf(episodeB());
  assert.deepEqual(once, twice, '两次抽取完全一致（可复算）');
  assert.deepEqual(extractTopics({}), []);
  assert.deepEqual(extractTopics({ episode: null, events: [], graph: null }), []);

  assert.deepEqual(extractRepos('see https://github.com/o/r and git@github.com:o/r2.git'), ['o/r', 'o/r2']);
  assert.deepEqual(extractCommands('cd /tmp && node x.mjs; echo hi | grep z'), ['cd', 'node', 'echo', 'grep']);
  assert.deepEqual(extractDependencies('npm i chalk@5 && import("yaml")'), ['chalk', 'yaml']);
});

// D2 扩展（2026-11-02）：类级错误主题，让不同路径的同一协议坑跨会话连起来
test('error-class: 已知协议类归一为 class:<name>，一次性报错返回 null', async () => {
  const { errorClassKeyOf } = await import('../src/rooms/topic.mjs');
  assert.equal(errorClassKeyOf('Error: cannot modify "D:/a/x.md": file has not been read'), 'class:fs-read-before-write');
  assert.equal(errorClassKeyOf('Error: cannot edit "D:/b/y.mjs": file changed since it was read'), 'class:fs-read-before-write');
  assert.equal(errorClassKeyOf('Error: unknown tool "bash"'), 'class:tool-unavailable');
  assert.equal(errorClassKeyOf('Error: team member limit 8 reached'), 'class:sandbox-limit');
  assert.equal(errorClassKeyOf('SyntaxError: missing ) after argument list'), null);
});

// T233/F1：失败边的 seq 必须取「结果事件」的 end，不是「调用事件」的 start。
// 片段（errorSnippet）出现在结果回来的那个事件里；取 start 会系统性偏移一个窗口 ⇒ 审计周期性报 missing。
function failureEpisode(evidence) {
  return {
    id: 'ep-f1t233aa',
    scopeKey: 'w:d:/work/demo',
    startedAt: 1_700_000_100_000,
    events: [userMessage(1, '任务：复现失败边 seq 偏移。')],
    graph: {
      version: 1,
      nodes: {},
      edges: {
        e1: {
          id: 'e1',
          from: 'n1',
          to: 'n2',
          action: 'bash(command=node scripts/cli.mjs stats)',
          result: 'failure',
          errorSnippet: "Error: Cannot find module 'yaml'",
          ts: 1_700_000_100_500,
          evidence,
        },
      },
    },
  };
}

const failureOcc = (ep) => {
  const topics = topicsOf(ep);
  const hit = topics.filter((t) => t.occurrences.some((o) => o.edgeId === 'e1' && o.source === 'graph:edge.failure'));
  assert.equal(hit.length, 1, '失败边只产出一个 error 主题（带 edgeId 的 occurrence）');
  return hit[0].occurrences.filter((o) => o.edgeId === 'e1' && o.source === 'graph:edge.failure');
};

test('T233/F1-①: 有 end ⇒ seq 取 end（片段所在的结果事件）', () => {
  const occ = failureOcc(failureEpisode({ start: 3670, end: 3674 }));
  assert.equal(occ.length, 1);
  assert.equal(occ[0].seq, 3674, '取 end，不是 start');
});

test('T233/F1-②: 只有 start ⇒ fallback 到 start（不崩、不丢）', () => {
  const occ = failureOcc(failureEpisode({ start: 5736 }));
  assert.equal(occ.length, 1);
  assert.equal(occ[0].seq, 5736, 'end 缺失时退回 start');
});

test('T233/F1-③: end 与 start 相同 ⇒ 不重复、不崩', () => {
  const occ = failureOcc(failureEpisode({ start: 4400, end: 4400 }));
  assert.equal(occ.length, 1, '同一 (edgeId, quote) 只记一次');
  assert.equal(occ[0].seq, 4400);
});

/* ── 自证污染：注入卡不得当根用户（T245）────────────────────────
 * 判据：`data.source.kind === "user"`（与 R03 的 `isUserMessage` 同口径）。
 * 为什么不能只看 `type`：注入卡也是 `user/message` + `role:"user"`，只看 type 会让
 * "卡恰好排在第一"时把卡当成根用户原话 —— 当前 730 局没出事，纯靠"卡不在首位"。
 */

test('R04: 注入卡排在首位 ⇒ 不当根用户（取后面那条真用户消息）', () => {
  const roots = collectRootUserTexts({
    events: [
      cardMessage(1),
      userMessage(2, '真实任务：把记忆卡排除在语料之外。'),
    ],
    graph: null,
  });
  assert.equal(roots.length, 1, '只认一条根用户消息');
  assert.equal(roots[0].seq, 2, '跳过卡（seq 1），取真用户消息（seq 2）');
  assert.ok(!roots[0].text.includes('<memory-ledger>'), '根用户文本里不许出现卡');
  assert.ok(!roots[0].text.includes('MEMORY: '), '卡前言也不许进来');
});

test('R04: 真用户消息在首位 ⇒ 照常抽取（golden：文本与 seq 不变）', () => {
  const roots = collectRootUserTexts({
    events: [
      userMessage(1, '任务：实现 link 相关边。记忆系统要把棋谱写进同一张网。'),
      cardMessage(2),
    ],
    graph: null,
  });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].seq, 1);
  assert.equal(roots[0].text, '任务：实现 link 相关边。记忆系统要把棋谱写进同一张网。');
});

test('R04: 只有卡、没有真用户消息 ⇒ 根用户为空（fail-closed，不拿卡顶替）', () => {
  const roots = collectRootUserTexts({ events: [cardMessage(1), cardMessage(2)], graph: null });
  assert.deepEqual(roots, [], '宁可没有根用户，也不把注入卡当用户原话');
});

test('R04: 老事件没有 source.kind ⇒ 按 role==="user" 兜底（兼容旧日志）', () => {
  const legacy = {
    type: 'user/message',
    seq: 3,
    time: 1_700_000_000_003,
    data: { role: 'user', content: [{ type: 'text', text: '必须只读' }] },
  };
  const roots = collectRootUserTexts({ events: [legacy], graph: null });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].text, '必须只读');
});

test('R04: 来源不明（无 source.kind 且无 role）⇒ 不作根用户（fail-closed）', () => {
  const bare = {
    type: 'user/message',
    seq: 4,
    time: 1_700_000_000_004,
    data: { content: [{ type: 'text', text: '必须只读' }] },
  };
  assert.deepEqual(collectRootUserTexts({ events: [bare], graph: null }), []);
});
