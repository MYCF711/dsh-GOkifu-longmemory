// T381：gram/len 剪枝必须与全表遍历**结果完全一致**（超集剪枝，判定仍走 overlaps）。
//
// 为什么要有这条：剪枝一旦不是"超集"，就会**静默漏掉命中** —— 召回变差但没有任何报错。
// A2b 只有 118 个样本，抓不到细粒度漏召回；这里用构造用例把边界钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTopics } from '../src/rooms/walk.mjs';

function idxFrom(topics) {
  const gramIndex = new Map();
  const lenIndex = new Map();
  for (const t of topics) {
    const k = String(t.key ?? '').toLowerCase();
    if (!k) continue;
    if (!lenIndex.has(k.length)) lenIndex.set(k.length, []);
    lenIndex.get(k.length).push(t);
    for (let i = 0; i + 1 < k.length; i += 1) {
      const g = k.slice(i, i + 2);
      if (!gramIndex.has(g)) gramIndex.set(g, []);
      gramIndex.get(g).push(t);
    }
  }
  return { gramIndex, lenIndex };
}

const TOPICS = [
  { id: 't:1', kind: 'term', key: '记忆系统' },
  { id: 't:2', kind: 'repo', key: 'scanprivacy' },
  { id: 't:3', kind: 'term', key: '缓存失效' },
  { id: 't:4', kind: 'file', key: 'add-account.test.mjs' },
  { id: 't:5', kind: 'term', key: '数据库' },
  { id: 't:6', kind: 'term', key: 'api' },
  { id: 't:7', kind: 'term', key: '今天' },
];

const SIGNALS = [
  '记忆系统 缓存 失效', 'scanPrivacy 报错', 'add a button', '数据库 连接 失败',
  'api 超时', '今天天气不错', 'mem 系统', '库', 'scan', 'zzz 无关',
];

test('T381: 剪枝与全表结果逐条一致（含 CJK / ASCII / 短标识符 / 停用词边界）', () => {
  const index = idxFrom(TOPICS);
  for (const text of SIGNALS) {
    const signal = { entities: [], terms: text.split(/\s+/).filter(Boolean), text };
    const plain = matchTopics({ signal, topics: TOPICS });
    const pruned = matchTopics({ signal, topics: TOPICS, prune: index });
    const key = (arr) => arr.map((m) => `${m.topic.id}:${m.score}:${m.matchedBy}`).sort().join('|');
    assert.equal(key(pruned), key(plain), `信号「${text}」剪枝结果必须与全表一致`);
  }
});
