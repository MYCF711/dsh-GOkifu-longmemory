// R14/计划表 keep-alive：重号索引不许与实际内容漂移。
//
// 为什么要有：`计划表.md` 是唯一权威，末尾的「重号索引」是**机械生成**的。
// 如果有人（或我）加了行/改了编号却忘了重跑 `node scripts/plan-dupe-index.mjs --write`，
// 索引就会和实际对不上 —— 而它存在的意义正是"查某编号前先看这里"。
// 这种漂移**不会报错**，只会让人查到过期信息（"坏了不报错、只悄悄变错"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex } from '../scripts/plan-dupe-index.mjs';

const PLAN = '计划表.md';
const BEGIN = '<!-- dupe-index:begin -->';
const END = '<!-- dupe-index:end -->';

test('T375: 计划表里的重号索引与正文一致（不许漂移）', () => {
  const text = fs.readFileSync(PLAN, 'utf8');
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(begin !== -1 && end !== -1, '必须有 dupe-index 区块（删掉区块 ⇒ 本测试红）');
  const section = text.slice(begin, end);
  // 正文（不含索引区块）才是"实际"，索引只是它的投影
  const bodyOnly = text.slice(0, begin) + text.slice(end);
  const actual = buildIndex(bodyOnly);
  const totalLine = section.match(/共 (\d+) 行 \/ (\d+) 个编号 \/ \*\*(\d+) 个重号\*\*/);
  assert.ok(totalLine, '索引区块必须有「共 N 行 / M 个编号 / K 个重号」这行');
  assert.equal(Number(totalLine[1]), actual.total, '行数漂了：重跑 node scripts/plan-dupe-index.mjs --write');
  assert.equal(Number(totalLine[2]), actual.unique, '编号数漂了：重跑 --write');
  assert.equal(Number(totalLine[3]), actual.dupes.length, '重号数漂了：重跑 --write');
});
