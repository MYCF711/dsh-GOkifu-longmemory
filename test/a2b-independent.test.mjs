// T316 · 独立实现（按判据契约）的单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { bigramOverlap, buildDf, contractBigrams, contractEntities, contractTokens, judge } from '../scripts/a2b-independent.mjs';

test('J1 判别词：≥4 字、去掉 path、英文/数字按下划线点斜杠切', () => {
  const t = contractTokens('反代插件的路由 abc.ts path check');
  assert.ok(t.includes('反代插件的路由'), '中文整段作为一个 token（≥4 字）');
  assert.ok(t.includes('check'), '英文 token');
  assert.equal(t.includes('path'), false, 'path 一律丢弃');
  assert.equal(contractTokens('abc').length, 0, '3 字以下丢弃');
});

test('J2 判别性 bigram：中文 2 字窗 + 英文 ≥3 字（_ - . / 不切）+ IDF 过滤泛词', () => {
  const b = contractBigrams('反代插件 abc.ts');
  assert.ok(b.has('反代') && b.has('代插') && b.has('插件'));
  assert.ok(b.has('abc.ts'), '英文/路径保持原样');
  const claims = [...Array(60).fill('你再看看文件'), ...Array.from({ length: 40 }, (_, i) => `独特词${i}号`)];
  const { df, n } = buildDf(claims);
  assert.equal(bigramOverlap('你再看看', '你再看看这个', { df, n }), 0, '泛词（df 高）不计');
});

test('J3 硬实体：路径/错误码/包名都能抽，纯中文不产生实体', () => {
  assert.ok([...contractEntities('open C:/tmp/a.log failed')].some((x) => x.includes('a.log')), '路径应被抽到');
  assert.ok(contractEntities('Error: ENOENT').has('enoent'));
  assert.ok([...contractEntities('github.com/MYCF711/dsh-ui/internal')].some((x) => x.includes('dsh-ui/internal')));
  assert.equal(contractEntities('怎么号全崩了').size, 0);
});

test('J4 判中条件：related 为假一律不中；三条通道任一成立即中', () => {
  const claims = ['反代插件的路由不生效', ...Array.from({ length: 99 }, (_, i) => `别的内容${i}`)];
  const { df, n } = buildDf(claims);
  assert.equal(judge({ signal: '反代插件', claimText: '反代插件的路由不生效', related: false, df, n }).strict, false);
  const j = judge({ signal: '反代插件', claimText: '反代插件的路由不生效', related: true, df, n });
  assert.equal(j.strict, true, `应命中（token=${j.overlap} bigram=${j.bigram}）`);
  // 实体桥单独成立
  const e = judge({ signal: 'ENOENT', claimText: 'Error: ENOENT: no such file', related: true, df, n });
  assert.equal(e.shared.length >= 1, true, '实体桥应成立');
  assert.equal(e.strict, true);
});
