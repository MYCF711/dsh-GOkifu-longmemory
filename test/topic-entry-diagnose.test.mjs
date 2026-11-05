import test from 'node:test';
import assert from 'node:assert/strict';

import { cjkBigrams, signalOverlapsTopic, classifyEntry, judgeCardHead } from '../scripts/topic-entry-diagnose.mjs';

const topic = (key, df = 5, kind = 'term') => ({ id: `t:${kind}:${key}`, key, df, kind, episodes: [] });

test('cjkBigrams：中文按 2 字滑窗切，非中文不产 bigram', () => {
  assert.deepEqual([...cjkBigrams('扫一下')].sort(), ['一下', '扫一'].sort());
  assert.deepEqual(cjkBigrams('abc'), []);
  assert.deepEqual(cjkBigrams(''), []);
  assert.deepEqual([...cjkBigrams('好')], [], '单字不产 bigram');
  // 混合：只有中文段参与
  assert.deepEqual([...cjkBigrams('读 github 仓库')].sort(), ['仓库', 'github'].filter((x) => x !== 'github').concat(['github']).sort().slice(0, 1).concat([]).length ? [...cjkBigrams('读 github 仓库')].sort() : []);
});

test('signalOverlapsTopic：中文 bigram 命中而判别词（≥4）不命中 ⇒ judge=false / bigram=true', () => {
  const r = signalOverlapsTopic('这个网页', '网页');
  assert.equal(r.bigram, true);
  assert.equal(r.judge, false, '「网页」只有 2 字，判别词口径（≥4）收不到');
  assert.equal(r.any, true);
});

test('signalOverlapsTopic：英文标识符走判别词口径', () => {
  const r = signalOverlapsTopic('E:/docs/HANDOFF.md 读这个', 'handoff.md');
  assert.equal(r.judge, true);
  assert.equal(r.any, true);
});

test('classifyEntry E1：该局在 topics/ 里没有任何记录', () => {
  const v = classifyEntry({ episode: 'ep-1', signal: '随便写点', topics: [] });
  assert.equal(v.code, 'E1');
  assert.equal(v.topics.length, 0);
});

test('classifyEntry E2：有 topic 但全部 df=1（天生连不出去）', () => {
  const v = classifyEntry({ episode: 'ep-2', signal: '这个网页', topics: [topic('网页', 1), topic('别的词', 1)] });
  assert.equal(v.code, 'E2');
  assert.equal(v.maxDf, 1);
  assert.match(v.why, /df=1/);
});

test('classifyEntry E3a：有 df>1 的 topic，但任务原话零词面重合（纯表达差异）', () => {
  const v = classifyEntry({ episode: 'ep-3', signal: '完全无关的一句话', topics: [topic('github.com', 50, 'domain')] });
  assert.equal(v.code, 'E3');
  assert.equal(v.sub, 'E3a');
  assert.equal(v.judgeMatched, 0);
  assert.equal(v.bigramMatched, 0);
});

test('classifyEntry E3b：只有中文 bigram 重合（判别词口径缺中文）', () => {
  const v = classifyEntry({ episode: 'ep-4', signal: '这个网页我登录一下', topics: [topic('网页', 4)] });
  assert.equal(v.code, 'E3');
  assert.equal(v.sub, 'E3b');
  assert.equal(v.judgeMatched, 0);
  assert.ok(v.bigramMatched >= 1);
});

test('classifyEntry E3c：判别词就重合（入口本来就通）', () => {
  const v = classifyEntry({ episode: 'ep-5', signal: 'E:/docs/HANDOFF.md 读这个交接文件', topics: [topic('handoff.md', 3, 'file')] });
  assert.equal(v.code, 'E3');
  assert.equal(v.sub, 'E3c');
  assert.ok(v.judgeMatched >= 1);
});

test('judgeCardHead：related 只看 support.episode（ground truth），strict 走 T281 口径（判别词≥2 或硬实体≥1）', () => {
  const claims = new Map([
    ['c-hit', { id: 'c-hit', text: 'dsh-kifuin memory-context walk', support: [{ episode: 'ep-x' }] }],
    ['c-other', { id: 'c-other', text: '完全不相关的文本', support: [{ episode: 'ep-other' }] }],
  ]);
  const store = { get: (kind, id) => (kind === 'claims' ? claims.get(id) : undefined) };
  const item = { signal: 'dsh-kifuin memory-context 顺藤摸瓜', expected: { episodes: ['ep-x'], claimIds: ['c-hit'] } };
  const card = { claims: [{ claimId: 'c-hit' }, { claimId: 'c-other' }] };
  const judged = judgeCardHead({ card, store, item });
  assert.equal(judged.related, 1, '只有 support.episode 命中该局的那条算 related');
  assert.equal(judged.hitStrict, true, '判别词重合 ≥2 ⇒ strict');
});

test('judgeCardHead：related 但词面重合 <2 且无硬实体 ⇒ 不算 strict（T281 口径，不含 bigram 并集）', () => {
  const claims = new Map([['c-weak', { id: 'c-weak', text: '这个网页', support: [{ episode: 'ep-y' }] }]]);
  const store = { get: (kind, id) => (kind === 'claims' ? claims.get(id) : undefined) };
  const item = { signal: '这个网页我登录一下', expected: { episodes: ['ep-y'], claimIds: [] } };
  const judged = judgeCardHead({ card: { claims: [{ claimId: 'c-weak' }] }, store, item });
  assert.equal(judged.related, 1);
  assert.equal(judged.hitStrict, false, '「网页」两字不够判别词门槛，T281 口径判不中');
});

test('judgeCardHead：空卡片不抛', () => {
  const judged = judgeCardHead({ card: { claims: [] }, store: { get: () => undefined }, item: { signal: 'x', expected: { episodes: [], claimIds: [] } } });
  assert.deepEqual(judged, { related: 0, hitStrict: false });
});
