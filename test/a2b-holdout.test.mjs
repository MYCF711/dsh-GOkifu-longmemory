// T236a · A2b 考卷构造器的单测（纯函数 + 假 store，不依赖真库）
//
// 覆盖：Wilson 区间（已知值）、判别词/重合数、claimsByEpisode、judgeCard 的四档判分、
//       buildExam 的三种信号来源（root/firstUser/shortRoot/l1 回退）与 repeat 考卷、
//       runHoldout 的分子分母与分桶。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bigramOverlapCount,
  buildExam,
  chineseBigrams,
  compareSignalModes,
  claimsByEpisode,
  discriminativeTokens,
  hardEntities,
  judgeCard,
  judgeStrict,
  negativeControl,
  overlapCount,
  runHoldout,
  sharedHardEntities,
  wilsonInterval,
} from '../scripts/a2b-holdout.mjs';

const claim = (id, eps, text = 'some claim text here') => ({
  id,
  text,
  support: eps.map((ep) => ({ episode: ep, seq: 1, quote: 'q' })),
  scopeKey: 'w:/demo',
});

const fakeStore = (claims, episodes) => ({
  list: (kind) => (kind === 'claims' ? claims.map((record) => ({ record })) : (kind === 'episodes' ? episodes.map((record) => ({ record })) : [])),
  get: (kind, id) => (kind === 'claims' ? claims.find((c) => c.id === id) ?? null : (episodes.find((e) => e.id === id) ?? null)),
});

test('T236a Wilson：已知值（18/19、0/1、空样本）', () => {
  const w = wilsonInterval(18, 19);
  assert.ok(w.lower > 0.7 && w.lower < 0.8, `18/19 下界应约 0.75，实得 ${w.lower}`);
  assert.ok(w.upper > 0.98 && w.upper <= 1, `18/19 上界应接近 1，实得 ${w.upper}`);
  assert.equal(wilsonInterval(0, 0).n, 0, '空样本不下结论');
  const half = wilsonInterval(5, 10);
  assert.ok(half.lower < 0.5 && half.upper > 0.5, '5/10 的区间应跨过 0.5');
});

test('T236a 判别词与重合数（与 m5 A2b 同一套：小写 / 切分 / ≥4 字符 / 去掉 path）', () => {
  const toks = discriminativeTokens('Error: cannot edit "path" file changed since it was read');
  assert.ok(toks.includes('cannot'));
  assert.ok(toks.includes('changed'));
  assert.equal(toks.includes('path'), false, 'path 不是判别词');
  assert.equal(overlapCount('cannot edit file changed', 'error: cannot edit the file — changed since'), 4);
  assert.equal(overlapCount('随便一句话', 'unrelated text'), 0);
});

test('T236a claimsByEpisode：support 里出现即归属，去重', () => {
  const map = claimsByEpisode([claim('c-1', ['ep-a', 'ep-b']), claim('c-2', ['ep-a']), claim('c-3', [])]);
  assert.deepEqual(map.get('ep-a').sort(), ['c-1', 'c-2']);
  assert.deepEqual(map.get('ep-b'), ['c-1']);
  assert.equal(map.has('ep-c'), false);
});

test('T236a judgeCard：related / strict / pending / unrelated 四档', () => {
  const store = fakeStore([
    claim('c-rel', ['ep-x'], 'cannot edit file changed since it was read'),
    claim('c-other', ['ep-y'], 'completely different topic about deployment'),
    claim('c-lookalike', ['ep-z'], 'cannot edit file changed again'),
  ], []);
  const card = { claims: [{ claimId: 'c-rel' }, { claimId: 'c-other' }, { claimId: 'c-lookalike' }] };
  const item = { id: 'self:ep-x', kind: 'self', episode: 'ep-x', signal: 'cannot edit the file, it changed since it was read', expected: { episodes: ['ep-x'], claimIds: ['c-rel'] } };
  const v = judgeCard({ card, store, item });
  assert.equal(v.related, 1, '只有 c-rel 的 support 含该局');
  assert.equal(v.strict, 1, 'c-rel 与信号重合 ≥2 个判别词');
  assert.equal(v.pending, 1, 'c-lookalike 像相关但不是该局的 ⇒ pending');
  assert.equal(v.unrelated, 1, 'c-other 与该局无关');
  assert.equal(v.hitStrict, true);
  assert.equal(v.hitRelated, true);
});

test('T236a buildExam：self 用根用户原话，repeat 用冻结集，短信号单列 shortRoot', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't236a-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  // 三个 episode：有棋谱根文本 / 无棋谱但有日志首条用户消息 / 只有很短的根文本
  const mkGraph = (dir, text) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ nodes: { n1: { id: 'n1', kind: 'user', text } }, edges: {} }));
  };
  mkGraph(path.join(home, 'g1'), '修复登录接口的 500 错误，先看日志');
  mkGraph(path.join(home, 'g2'), '');
  mkGraph(path.join(home, 'g3'), '处理一下');
  const mkLog = (dir, text) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'log.bin'), Buffer.from('x'));
  };
  mkLog(path.join(home, 'l2'), 'x');
  const episodes = [
    { id: 'ep-1', scopeKey: 'w:/demo', endedAt: 1000, closure: { graphPath: 'g1/graph.json' } },
    { id: 'ep-2', scopeKey: 'w:/demo', endedAt: 2000, closure: { graphPath: 'g2/graph.json', logPath: 'l2/log.bin' } },
    { id: 'ep-3', scopeKey: 'w:/demo', endedAt: 3000, closure: { graphPath: 'g3/graph.json' } },
  ];
  const claims = [claim('c-1', ['ep-1']), claim('c-2', ['ep-2']), claim('c-3', ['ep-3']), claim('c-4', ['ep-prior'])];
  const frozenPath = path.join(tmp, 'set.json');
  fs.writeFileSync(frozenPath, JSON.stringify({ splitAt: 500, items: [{ sig: 'cannot edit path', scopeKey: 'w:/demo', episode: 'ep-9', prior: ['ep-prior'] }] }));
  const exam = buildExam({ store: fakeStore(claims, episodes), home, frozenPath });
  const byEp = new Map(exam.items.map((x) => [x.episode, x]));
  assert.equal(byEp.get('ep-1').signalSource, 'root');
  assert.equal(byEp.get('ep-1').signal.includes('登录'), true);
  assert.equal(byEp.get('ep-3').signalSource, 'shortRoot', '短文本仍算该局真实任务，单列');
  assert.equal(byEp.has('ep-2'), false, '假日志读不出 ⇒ 无可用信号，如实跳过');
  const repeat = exam.items.find((x) => x.kind === 'repeat');
  assert.ok(repeat, '冻结集应产出 repeat 考卷');
  assert.deepEqual(repeat.expected.episodes, ['ep-prior']);
  assert.deepEqual(repeat.expected.claimIds, ['c-4']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T236a runHoldout：分子/分母与分桶（确定性）', () => {
  const store = fakeStore([claim('c-1', ['ep-1'], 'cannot edit file changed since it was read')], []);
  const exam = {
    items: [{
      id: 'self:ep-1', kind: 'self', episode: 'ep-1', scopeKey: 'w:/demo', signal: 'cannot edit file changed since it was read',
      at: 1000, expected: { episodes: ['ep-1'], claimIds: ['c-1'] },
    }],
  };
  // 假 walk/card：直接返回一条 claim 行（runHoldout 依赖 store.get 判 related）
  const cache = { claims: [claim('c-1', ['ep-1'], 'cannot edit file changed since it was read')] };
  const fakeStoreForRun = {
    ...store,
    list: () => [],
  };
  const r = runHoldout({ store: fakeStoreForRun, exam, cache, now: 1000 });
  // 没给 walk/card 注入点时，runHoldout 用真 walk；这里只校验结构不炸
  assert.equal(r.n + r.errors, 1);
  assert.equal(typeof r.strictRate === 'number' || r.strictRate === null, true);
});

// ── T248：硬实体桥 ───────────────────────────────────────────────────────────

test('T248 ① 中文任务 + 英文报错 + 同一路径 ⇒ 判相关（旧口径拿 0 分）', () => {
  // 共享的是**路径实体**；路径组件都 <4 字符（tmp/log），所以判别词口径拿 0 分
  const task = String.raw`看下 C:\tmp\a.log 为什么打不开，是不是被占了`;
  const err = String.raw`Error: cannot open "C:\tmp\a.log": The process cannot access the file`;
  const overlap = overlapCount(task, err);
  const shared = sharedHardEntities(task, err);
  assert.equal(overlap, 0, `旧口径应 0 分（实际 overlap=${overlap}）`);
  assert.ok(shared.length >= 1, `应共享硬实体，实际 ${JSON.stringify(shared)}`);
  assert.equal(judgeStrict({ related: true, overlap, shared }), true, '并集判据应判相关');
});

test('T248 ② 中文任务 + 英文报错 + 无共享实体 ⇒ 不判相关（不放水）', () => {
  const task = '怎么号全崩了？是被封号了吗？';
  const err = 'class:timeout · if err := json.Unmarshal(raw, &a)';
  const overlap = overlapCount(task, err);
  const shared = sharedHardEntities(task, err);
  assert.equal(overlap, 0, `判别词应 0，实际 ${overlap}`);
  assert.equal(shared.length, 0, `硬实体应 0，实际 ${JSON.stringify(shared)}`);
  assert.equal(judgeStrict({ related: true, overlap, shared }), false, '无任何重合 ⇒ 不判相关');
});

test('T248 ③ 旧路径不变：related=false 时任何重合都不判相关；≥2 判别词仍判相关', () => {
  assert.equal(judgeStrict({ related: false, overlap: 99, shared: ['x'] }), false);
  assert.equal(judgeStrict({ related: true, overlap: 2, shared: [] }), true);
  assert.equal(judgeStrict({ related: true, overlap: 1, shared: [] }), false, '1 个判别词仍不够');
  assert.equal(judgeStrict({ related: true, overlap: 0, shared: ['enoent'] }), true);
});

test('T248 ④ 硬实体抽取：路径/错误码/包名/命令都能抽，纯中文不产生实体', () => {
  const paths = hardEntities(String.raw`open "C:\tmp\a.log" failed`);
  assert.ok([...paths].some((x) => x.includes('a.log')), `应抽到 a.log：${JSON.stringify([...paths])}`);
  const codes = hardEntities('Error: ENOENT and class:fs-read-before-write');
  assert.ok(codes.has('enoent') && codes.has('class:fs-read-before-write'), JSON.stringify([...codes]));
  const pkg = hardEntities('github.com/MYCF711/dsh-ui/internal/uiplugins');
  assert.ok([...pkg].some((x) => x.includes('dsh-ui/internal')), JSON.stringify([...pkg]));
  const cmd = hardEntities('node scripts/check.mjs && git status');
  assert.ok([...cmd].some((x) => x.includes('node scripts')), JSON.stringify([...cmd]));
  assert.equal(hardEntities('怎么号全崩了').size, 0, '纯中文不该凭空产生实体');
});

test('T248 ⑤ 不相关对照组：误判率不高于原口径（放水的反证）', () => {
  const unrelated = Array.from({ length: 30 }, (_, i) => claim(`c-x${i}`, ['ep-other'], `class:timeout · unrelated text ${i}`));
  const store = fakeStore(unrelated, []);
  const exam = {
    items: [{
      id: 'self:ep-1', kind: 'self', episode: 'ep-1', scopeKey: 'w:/demo',
      signal: '看下 dsh-ui/internal/uiplugins 这个包的测试为什么挂了',
      at: 1000, expected: { episodes: ['ep-1'], claimIds: ['c-none'] },
    }],
  };
  const c = negativeControl({ store, exam, perItem: 10 });
  assert.equal(c.n, 10, '每组取 10 条对照');
  assert.equal(c.bridged, 0, `无关 claim 不应被硬实体桥判相关，实际 ${c.bridged}：${JSON.stringify(c.examples)}`);
  assert.ok(c.bridgeRate <= c.tokenRate, `硬实体误判率(${c.bridgeRate}) 不应高于原口径(${c.tokenRate})`);
});

test('T249/T264 shortRoot：短任务原话**不再**换成事后实体（只留原话），事后实体单列 C 路', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't249-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'g1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'g1', 'graph.json'), JSON.stringify({ nodes: { n1: { id: 'n1', kind: 'user', text: '处理一下' } }, edges: {} }));
  const episodes = [{
    id: 'ep-s1', scopeKey: 'w:/demo', endedAt: 1000, closure: { graphPath: 'g1/graph.json' },
    topics: [{ kind: 'file', key: '_tmp/replace-invite-method.mjs', count: 2 }, { kind: 'error', key: 'Error: cannot edit', count: 1 }],
  }];
  const exam = buildExam({ store: fakeStore([claim('c-a', ['ep-s1'])], episodes), home, includeRepeat: false });
  const it = exam.items.find((x) => x.episode === 'ep-s1');
  assert.equal(it.signalSource, 'shortRoot', 'T264 起 shortRoot 不再改标签（信号就是原话）');
  assert.equal(it.signal, '处理一下', '合法信号 = 用户原话');
  assert.equal(it.taskEntities.length, 0, '原话里没有实体');
  assert.ok(it.signals.postHoc.includes('_tmp/replace-invite-method.mjs'), '事后实体只在 C 路');
  assert.equal(it.signalMeta.postHoc.injectionTime, false, 'C 路必须标成事后');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T263/T264 self/root：合法信号 = 原话 + **原话内**实体；事后实体只进 C 路', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't263-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'g1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'g1', 'graph.json'), JSON.stringify({ nodes: { n1: { id: 'n1', kind: 'user', text: '读一下 E:/docs/HANDOFF.md 然后写方案' } }, edges: {} }));
  const episodes = [{
    id: 'ep-r1', scopeKey: 'w:/demo', endedAt: 1000, closure: { graphPath: 'g1/graph.json' },
    topics: [{ kind: 'file', key: 'src/post-hoc.ts', count: 3 }, { kind: 'error', key: 'TypeError: boom', count: 1 }],
  }];
  const exam = buildExam({ store: fakeStore([claim('c-r', ['ep-r1'])], episodes), home, includeRepeat: false });
  const it = exam.items.find((x) => x.episode === 'ep-r1');
  assert.equal(it.signalSource, 'root');
  assert.equal(it.signal, it.signals.taskPlusEntity, '默认信号 = B 路（合法）');
  assert.ok(it.signal.includes('E:/docs/HANDOFF.md'), `B 路应含原话里的路径：${it.signal}`);
  assert.equal(it.signal.includes('src/post-hoc.ts'), false, 'B 路不许含事后信息');
  assert.ok(it.signals.postHoc.includes('src/post-hoc.ts'), 'C 路（对照）才含事后信息');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T264 ① 信号不含事后信息：B 路的实体必须能在**用户原话**里找到', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't264-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'g1'), { recursive: true });
  // 原话里有一条路径；棋谱主题里另有一条**原话没有**的路径（事后信息）
  fs.writeFileSync(path.join(home, 'g1', 'graph.json'), JSON.stringify({ nodes: { n1: { id: 'n1', kind: 'user', text: '读一下 E:/docs/HANDOFF.md 然后写方案' } }, edges: {} }));
  const episodes = [{
    id: 'ep-x1', scopeKey: 'w:/demo', endedAt: 1000, closure: { graphPath: 'g1/graph.json' },
    topics: [{ kind: 'file', key: 'src/secret/post-hoc.ts', count: 3 }, { kind: 'error', key: 'TypeError: boom', count: 1 }],
  }];
  const exam = buildExam({ store: fakeStore([claim('c-x', ['ep-x1'])], episodes), home, includeRepeat: false });
  const it = exam.items.find((x) => x.episode === 'ep-x1');
  const taskText = it.signals.task;
  // ① B 路：出现的实体必须全部出自原话
  assert.ok(it.signals.taskPlusEntity.includes('e:/docs/handoff.md'), `B 路应含原话里的路径：${it.signals.taskPlusEntity}`);
  for (const ent of it.taskEntities) assert.ok(taskText.toLowerCase().includes(String(ent).toLowerCase()), `实体 ${ent} 必须来自原话`);
  // ② 事后实体只许出现在 C 路
  assert.equal(it.signals.taskPlusEntity.includes('src/secret/post-hoc.ts'), false, 'B 路不许含事后信息');
  assert.ok(it.signals.postHoc.includes('src/secret/post-hoc.ts'), 'C 路（对照）才允许含事后信息');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T264 ② 合法信号（A/B）标 injectionTime=true，C 路标 false 且不进主判据', () => {
  const exam = {
    items: [{
      id: 'i1', kind: 'self', episode: 'ep-1', scopeKey: 'w:/demo', at: 1,
      signal: 'b', signals: { task: 'a', taskPlusEntity: 'b', postHoc: 'c' },
      signalMeta: {
        task: { injectionTime: true, desc: '用户原话' },
        taskPlusEntity: { injectionTime: true, desc: '原话+原话内实体' },
        postHoc: { injectionTime: false, desc: '事后' },
      },
      expected: { episodes: ['ep-1'], claimIds: [] },
    }],
  };
  const c = compareSignalModes({ store: { list: () => [], get: () => null }, exam, cache: null });
  assert.equal(c.task.injectionTime, true);
  assert.equal(c.taskPlusEntity.injectionTime, true);
  assert.equal(c.postHoc.injectionTime, false, 'C 路必须标成事后（作弊对照）');
  assert.equal(c.task.desc, '用户原话');
});

test('T264 ③ 原话里没有实体 ⇒ B 路 == A 路（不许凭空造信号）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't264b-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'g1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'g1', 'graph.json'), JSON.stringify({ nodes: { n1: { id: 'n1', kind: 'user', text: '处理一下' } }, edges: {} }));
  const episodes = [{ id: 'ep-y1', scopeKey: 'w:/demo', endedAt: 1, closure: { graphPath: 'g1/graph.json' }, topics: [{ kind: 'file', key: 'src/post-hoc.ts', count: 1 }] }];
  const exam = buildExam({ store: fakeStore([claim('c-y', ['ep-y1'])], episodes), home, includeRepeat: false });
  const it = exam.items.find((x) => x.episode === 'ep-y1');
  assert.equal(it.signals.taskPlusEntity, '处理一下', '原话无实体 ⇒ B 路就是原话本身');
  assert.equal(it.taskEntities.length, 0);
  assert.ok(it.signals.postHoc.includes('src/post-hoc.ts'), 'C 路仍可含事后实体（仅对照）');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── T284：中文二元组 ─────────────────────────────────────────────────────────

test('T284 ① 中文 bigram：「反代插件卷」vs 卡上「反代插件」能认出重合（旧 includes 认不出）', () => {
  const signal = '反代插件卷的问题';
  const claim = '反代插件的路由不生效';
  // 旧口径：整段当一个 token ⇒ includes 不命中
  assert.equal(overlapCount(signal, claim) >= 2, false, '旧口径不应命中');
  // 新口径：bigram 滑窗
  const bg = bigramOverlapCount(signal, claim);
  assert.ok(bg >= 2, `bigram 应 ≥2，实际 ${bg}：${JSON.stringify([...chineseBigrams(signal)])}`);
  assert.equal(judgeStrict({ related: true, overlap: 0, shared: [], bigram: bg }), true, '并集判据应判严格命中');
});

test('T284 ② 完全无关的中文 ⇒ 不重合', () => {
  const signal = '反代插件卷的问题';
  const claim = '今天天气不错，适合出去走走';
  assert.equal(bigramOverlapCount(signal, claim), 0);
  assert.equal(judgeStrict({ related: true, overlap: 0, shared: [], bigram: 0 }), false);
});

test('T284 ③ 误判不升：bigram 路径在无关样本上的命中率 ≤ 原判别词路径的历史基线', () => {
  // 无关对：两个毫无共享 bigram 的中文串 ⇒ 0；共享 1 个 bigram ⇒ 不到门槛（≥2）
  assert.equal(bigramOverlapCount('反代插件卷的问题', '插件的配置'), 1, '只共享「插件」1 个 bigram');
  assert.equal(judgeStrict({ related: true, overlap: 0, shared: [], bigram: 1 }), false, '1 个 bigram 不够');
  // 英文/路径仍走原判别词路径（不许因为中文改动而放松）
  assert.equal(judgeStrict({ related: true, overlap: 0, shared: [], bigram: 99 }), true);
  assert.equal(judgeStrict({ related: false, overlap: 99, shared: ['x'], bigram: 99 }), false, 'related 定义一字未动');
});

test('T284 ④ chineseBigrams：中文 2 字滑窗 + 英文/数字保原样', () => {
  const b = chineseBigrams('反代插件 abc.ts');
  assert.ok(b.has('反代') && b.has('代插') && b.has('插件'), JSON.stringify([...b]));
  assert.ok(b.has('abc.ts'), '英文/路径保持原样');
  assert.equal(b.has('反代插'), false, '不是 3 字窗');
});
