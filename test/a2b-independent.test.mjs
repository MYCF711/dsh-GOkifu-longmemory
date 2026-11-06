// T314 · 独立判据的单测（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDf, judge, myTerms } from '../scripts/a2b-independent.mjs';

test('T314 myTerms：中文 2 字滑窗 + 英文/数字 ≥4 字', () => {
  const t = myTerms('反代插件的路由 v2 check');
  assert.ok(t.has('反代') && t.has('代插') && t.has('插件'), JSON.stringify([...t]));
  assert.ok(t.has('check'), '英文 token 保留');
  assert.equal(t.has('v2'), false, '过短 token 被丢');
});

test('T314 判据：related=false 一律不中；判别性词 ≥2 才中', () => {
  const claims = ['反代插件的路由不生效', ...Array.from({ length: 99 }, (_, i) => `别的内容${i}`)];
  const { df, n } = buildDf(claims);
  assert.equal(judge({ signal: '反代插件', claimText: '反代插件的路由不生效', related: false, df, n }).strict, false, 'related 不成立');
  const j = judge({ signal: '反代插件', claimText: '反代插件的路由不生效', related: true, df, n });
  assert.equal(j.strict, true, `应命中（overlap=${j.overlap}）`);
  assert.ok(j.overlap >= 2);
});

test('T314 IDF：泛词（df 高）不算判别性 ⇒ 不影响命中', () => {
  // 「看看」出现在 60/100 条里 ⇒ df 0.6 > 0.02
  const claims = [...Array(60).fill('你再看看'), ...Array.from({ length: 40 }, (_, i) => `独特内容${i}`)];
  const { df, n } = buildDf(claims);
  const j = judge({ signal: '你再看看', claimText: '你再看看这个', related: true, df, n });
  assert.equal(j.strict, false, '全泛词 ⇒ 不中');
  assert.ok(j.terms >= 2);
});
