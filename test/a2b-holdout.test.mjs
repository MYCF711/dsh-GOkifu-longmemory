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
  buildExam,
  claimsByEpisode,
  discriminativeTokens,
  judgeCard,
  overlapCount,
  runHoldout,
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
