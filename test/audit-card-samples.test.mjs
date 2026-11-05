// audit-card-samples 的单测（M4，2026-11-04）
// 用**构造夹具**覆盖文字层三档（at-seq / elsewhere / missing）+ 日期层 + 弱判据回退，
// 不依赖真实库与会话日志（事件读取用 `loadEvents` 注入）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditRows,
  checkDate,
  classifyTextByEvents,
  eventsToBlobs,
  normalizeCardText,
  parseCardLines,
  pickCurrentPid,
} from '../scripts/audit-card-samples.mjs';

const DAY = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h);

const episodes = new Map([
  ['ep-aaaa0001', { id: 'ep-aaaa0001', scopeKey: 'w:/a', closure: { seqFrom: 0, seqTo: 100 } }],
  ['ep-bbbb0002', { id: 'ep-bbbb0002', scopeKey: 'w:/b', closure: { seqFrom: 0, seqTo: 100 } }],
]);

const rawEvents = {
  'ep-aaaa0001': [
    // 1) 卡上 seq=10，文字出现在 11（距离 1 ⇒ at-seq）
    { seq: 11, time: DAY(2026, 11, 4, 1), data: { message: { content: [{ type: 'text', text: 'Error: old_string was not found in "/a/b.go"' }] } } },
    // 2) 卡上 seq=20，文字只出现在 60（距离 40 ⇒ elsewhere）
    { seq: 60, time: DAY(2026, 11, 4, 5), data: { message: { content: [{ type: 'text', text: 'Error: cannot modify "/x/y.md": file has not been read — read the file, then retry' }] } } },
    // 3) 卡上 seq=40，文字就在 40，但那天是 11-03（卡片写 11-04 ⇒ 日期不一致）
    { seq: 40, time: DAY(2026, 11, 3, 9), data: { message: { content: [{ type: 'text', text: 'Error: date drift text' }] } } },
  ],
  'ep-bbbb0002': [
    { seq: 5, time: DAY(2026, 11, 4, 2), data: { message: { content: [{ type: 'text', text: 'Error: other scope text' }] } } },
  ],
};

const loadEvents = async (id) => rawEvents[id] ?? [];

const section = [
  '<memory-ledger>',
  '- [antipattern] Error: old_string was not found in "/a/b.go" (ep-aaaa0001, 2026-11-04, seq 10)',
  '- [antipattern] class:fs-read-before-write · Error: cannot modify "/x/y.md" (ep-aaaa0001, 2026-11-04, seq 20)',
  '- [antipattern] Error: totally missing text (ep-aaaa0001, 2026-11-04, seq 30)',
  '- [antipattern] [跨项目] Error: date drift text (ep-aaaa0001, 2026-11-04, seq 40)',
  '- [observed] Error: other scope text (ep-bbbb0002, 2026-11-04, seq 5)',
  '</memory-ledger>',
].join('\n');

const rows = [{ at: 1793749445009, digest: 'd1', tokens: 100, scope: 'w:/a', section }];

test('normalizeCardText: 单行化 + 去卡片模板前缀 + 去截断尾', () => {
  assert.equal(normalizeCardText('  [跨项目]   class:fs-read-before-write · Error:  x   y  '), 'Error: x y');
  assert.equal(normalizeCardText('[跨项目] Error: a…'), 'Error: a');
  assert.equal(normalizeCardText('class:sandbox-limit · Error: tool call aborted'), 'Error: tool call aborted');
  // CJK 与路径反斜杠保持原样
  assert.equal(normalizeCardText('C:\\a\\b.md 不存在'), 'C:\\a\\b.md 不存在');
});

test('parseCardLines: 抽出 marker / 正文 / (ep, 日期, seq)', () => {
  const lines = parseCardLines(section);
  assert.equal(lines.length, 5);
  assert.deepEqual(lines[0], {
    marker: 'antipattern',
    text: 'Error: old_string was not found in "/a/b.go"',
    episode: 'ep-aaaa0001',
    date: '2026-11-04',
    seq: 10,
  });
});

test('classifyTextByEvents: at-seq / elsewhere / missing 三档', () => {
  const events = eventsToBlobs(rawEvents['ep-aaaa0001']);
  assert.equal(classifyTextByEvents({ text: 'Error: old_string was not found', seq: 10, events }).verdict, 'at-seq');
  const far = classifyTextByEvents({ text: 'Error: cannot modify "/x/y.md"', seq: 20, events });
  assert.equal(far.verdict, 'elsewhere');
  assert.equal(far.nearestSeq, 60);
  assert.equal(far.distance, 40);
  assert.equal(classifyTextByEvents({ text: 'Error: nowhere at all', seq: 20, events }).verdict, 'missing');
});

test('classifyTextByEvents: window 边界（默认 3，可收窄）', () => {
  const events = eventsToBlobs(rawEvents['ep-aaaa0001']);
  assert.equal(classifyTextByEvents({ text: 'Error: old_string was not found', seq: 10, events, window: 1 }).verdict, 'at-seq');
  assert.equal(classifyTextByEvents({ text: 'Error: old_string was not found', seq: 10, events, window: 0 }).verdict, 'elsewhere');
});

test('eventsToBlobs: 递归收集字符串，不把引号转义成 \\"', () => {
  const [ev] = eventsToBlobs([{ seq: 1, time: 1, data: { a: { b: ['cannot modify "/x/y.md"'] } } }]);
  assert.ok(ev.blob.includes('cannot modify "/x/y.md"'));
  assert.ok(!ev.blob.includes('\\"'));
});

test('checkDate: 同一天（UTC）算一致，跨天算不一致，无事件记 no-event', () => {
  assert.equal(checkDate({ refDate: '2026-11-04', event: { time: DAY(2026, 11, 4, 23) } }).verdict, 'ok');
  assert.equal(checkDate({ refDate: '2026-11-04', event: { time: DAY(2026, 11, 3, 23) } }).verdict, 'mismatch');
  assert.equal(checkDate({ refDate: '2026-11-04', event: null }).verdict, 'no-event');
});

test('auditRows: 三档 + 日期 + 跨作用域汇总与退出码', async () => {
  const out = await auditRows({ rows, episodes, loadEvents, window: 3, textCheck: true });
  assert.equal(out.samples, 1);
  assert.equal(out.refs, 5);
  assert.equal(out.okRefs, 5);              // 弱判据仍 100%（ep 存在 + seq 在闭包）
  assert.equal(out.textAtSeq, 3);           // 行 1、4（日期不符但文字在）、5（跨作用域但文字在）
  assert.equal(out.textElsewhere, 1);       // 行 2
  assert.equal(out.textMissing, 1);         // 行 3
  assert.equal(out.dateOk, 3);              // 行 1、2、5（日期层独立于文字层：按所引 seq 最近的事件判）
  assert.equal(out.dateBad, 2);             // 行 3（最近事件 @40 是 11-03）、行 4（同理）
  assert.equal(out.sameScopeRefs, 4);
  assert.equal(out.crossScopeRefs, 1);      // ep-bbbb0002 属于 w:/b
  assert.equal(out.exitCode, 1);            // 有 missing + 日期不一致 ⇒ 红

  const line3 = out.details[0].verdicts[2];
  assert.equal(line3.verdict, 'missing');   // 文字层：本局无这段文字
  assert.equal(line3.dateVerdict, 'mismatch'); // 日期层只看"所引 seq 最近事件"（@40，11-03），与本行文字无关
  assert.equal(line3.eventDate, '2026-11-03');
  const line4 = out.details[0].verdicts[3];
  assert.equal(line4.verdict, 'at-seq');
  assert.equal(line4.dateVerdict, 'mismatch');
  assert.equal(line4.eventDate, '2026-11-03');
});

test('auditRows: 读不到原件（loadEvents 抛错）⇒ fail-closed 记 missing', async () => {
  const out = await auditRows({
    rows,
    episodes,
    loadEvents: async () => { throw new Error('log unreadable'); },
    textCheck: true,
  });
  // T239：读不到原件不再冒充 missing —— 单列成 unreadable（旧键 textMissing 归零）
  assert.equal(out.textUnreadable, 5);
  assert.equal(out.textMissing, 0, 'notFound 才是"真找不到"');
  assert.equal(out.textNotFound, 0);
  assert.equal(out.dateBad, 0, '读不到 ≠ 日期不一致（日期层也单列为 unreadable）');
  assert.equal(out.exitCode, 1, 'fail-closed：核不了不能当绿');
});

test('auditRows: 全绿夹具 ⇒ 退出码 0', async () => {
  const okSection = [
    '- [antipattern] Error: old_string was not found in "/a/b.go" (ep-aaaa0001, 2026-11-04, seq 11)',
    '- [observed] Error: other scope text (ep-bbbb0002, 2026-11-04, seq 5)',
  ].join('\n');
  const out = await auditRows({
    rows: [{ at: 1, digest: 'd2', tokens: 10, scope: 'w:/a', section: okSection }],
    episodes,
    loadEvents,
    textCheck: true,
  });
  assert.equal(out.textAtSeq, 2);
  assert.equal(out.textMissing, 0);
  assert.equal(out.dateOk, 2);
  assert.equal(out.exitCode, 0);
});

test('auditRows --no-text: 退回弱判据（文字层 skipped，退出码只看引用层）', async () => {
  const out = await auditRows({ rows, episodes, loadEvents, textCheck: false });
  assert.equal(out.textCheck, false);
  assert.equal(out.textMissing, 0);
  assert.equal(out.textAtSeq, 0);
  assert.equal(out.details[0].verdicts.every((v) => v.verdict === 'skipped'), true);
  assert.equal(out.exitCode, 0);            // 旧口径：5/5 可回溯 ⇒ 绿（这正是本次升级要堵的假绿）
  assert.equal(out.crossScopeRefs, 1);      // 弱判据下跨作用域照样计得出来
});


// ---------------------------------------------------------------------------
// --current（2026-11-04）：从心跳里自动挑"当前宿主"，把旧进程的账切出去
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 10, 4, 6, 0, 0);

test('pickCurrentPid: 取最后一条心跳所在的 pid，并给出该进程的心跳条数', () => {
  const rows = [
    { at: T0, pid: 111 },
    { at: T0 + 1000, pid: 111 },
    { at: T0 + 5000, pid: 222 },
    { at: T0 + 2000, pid: 111 },
  ];
  const cur = pickCurrentPid(rows, { nowMs: T0 + 60_000 });
  assert.equal(cur.pid, 222);
  assert.equal(cur.count, 1);
  assert.equal(cur.stale, false);
  assert.equal(cur.ageMs, 55_000);
});

test('pickCurrentPid: 超过 30 分钟没心跳 ⇒ 标 stale（宿主可能没在跑）', () => {
  const cur = pickCurrentPid([{ at: T0, pid: 7 }], { nowMs: T0 + 31 * 60 * 1000 });
  assert.equal(cur.stale, true);
});

test('pickCurrentPid: 空/垃圾输入 ⇒ null（不编一个 pid 出来）', () => {
  assert.equal(pickCurrentPid([]), null);
  assert.equal(pickCurrentPid([{ at: 'x' }, {}, null]), null);
  assert.equal(pickCurrentPid(null), null);
});

// ---------------------------------------------------------------------------
// joined 档（0.132.0）：同一事件里多段字符串被抽取拼成一行 ⇒ 记 joined，不冒充 at-seq，也不算 missing
// ---------------------------------------------------------------------------

test('classifyTextByEvents: 严格版没命中、空格拼接版命中 ⇒ joined', () => {
  const events = eventsToBlobs([
    { seq: 10, data: { text: ['go build github.com/x: copying', 'C:/tmp/a.out: permission denied'] } },
  ]);
  const r = classifyTextByEvents({ text: 'go build github.com/x: copying C:/tmp/a.out', seq: 10, events, window: 3 });
  assert.equal(r.verdict, 'joined', '跨段拼成一行 ⇒ joined（同一局里的片段，但不是逐字子串）');
});

test('classifyTextByEvents: 单段逐字命中仍是 at-seq（joined 不许抢功）', () => {
  const events = eventsToBlobs([{ seq: 10, data: { text: 'Cannot find module yaml' } }]);
  assert.equal(classifyTextByEvents({ text: 'Cannot find module yaml', seq: 10, events, window: 3 }).verdict, 'at-seq');
});

test('classifyTextByEvents: 哪都不存在 ⇒ missing（不做无根据的宽容）', () => {
  const events = eventsToBlobs([{ seq: 10, data: { text: 'Cannot find module yaml' } }]);
  assert.equal(classifyTextByEvents({ text: '完全不相干的一句话', seq: 10, events, window: 3 }).verdict, 'missing');
});

// ---------------------------------------------------------------- T239（docs/调研/46：未知 ≠ 已失效）
//
// A6 从三档改成四态：ok / offset（同一局别的 seq）/ unreadable（读不到）/ notFound（真找不到）。
// 85% 的 not-substring 其实是"指针偏了几个 seq"或"空白被折叠"（T232/T238）—— 内容在，只是指针不对，
// 与"内容真的对不上"是两类问题，必须分开说。

test('T239 ①: 四态分列 —— ok / offset / unreadable / notFound 各归各位', async () => {
  const mkRow = (lines) => [{ at: 1793749445009, digest: 'd239', tokens: 100, scope: 'w:/a', section: lines.join('\n') }];
  // ep-aaaa0001 的事件：seq 11（原文 A）、seq 40（原文 B）
  const eps = new Map([['ep-aaaa0001', { id: 'ep-aaaa0001', scopeKey: 'w:/a', closure: { seqFrom: 0, seqTo: 100 } }]]);
  const evs = {
    'ep-aaaa0001': [
      { seq: 11, time: DAY(2026, 11, 4, 6), data: { text: 'AAA 原文一' } },
      { seq: 40, time: DAY(2026, 11, 4, 6), data: { text: 'BBB 原文二' } },
    ],
  };
  const out = await auditRows({
    rows: mkRow([
      '- [antipattern] AAA 原文一 (ep-aaaa0001, 2026-11-04, seq 11)',   // ok
      '- [antipattern] BBB 原文二 (ep-aaaa0001, 2026-11-04, seq 13)',   // offset（距离 27 → 远）
      '- [antipattern] 本局没有这句 (ep-aaaa0001, 2026-11-04, seq 11)',  // notFound
    ]),
    episodes: eps,
    loadEvents: async (id) => evs[id] ?? [],
    window: 3,
    textCheck: true,
  });
  assert.equal(out.textOk, 1);
  assert.equal(out.textOffset, 1);
  assert.equal(out.textNotFound, 1);
  assert.equal(out.textUnreadable, 0);
  assert.equal(out.textMissing, out.textNotFound, '旧键 missing = notFound（兼容）');
  assert.equal(out.textOffsetFar, 1, '距离 27 > 20 ⇒ 远偏移');
  assert.equal(out.offsetDistanceMedian, 27);
  assert.equal(out.a6Denominator, 3);
});

test('T239 ②: offset 不红、notFound 红、unreadable 红（fail-closed）', async () => {
  const eps = new Map([['ep-aaaa0001', { id: 'ep-aaaa0001', scopeKey: 'w:/a', closure: { seqFrom: 0, seqTo: 100 } }]]);
  const evs = { 'ep-aaaa0001': [{ seq: 11, time: DAY(2026, 11, 4, 6), data: { text: 'AAA 原文一' } }] };
  const run = (line) => auditRows({
    rows: [{ at: 1793749445009, digest: 'd', tokens: 10, scope: 'w:/a', section: line }],
    episodes: eps,
    loadEvents: async (id) => evs[id] ?? [],
    window: 3,
    textCheck: true,
  });
  const offsetOnly = await run('- [antipattern] AAA 原文一 (ep-aaaa0001, 2026-11-04, seq 20)');
  assert.equal(offsetOnly.textOffset, 1);
  assert.equal(offsetOnly.exitCode, 0, 'offset 是待修项，不判红');
  const notFound = await run('- [antipattern] 本局没有这句 (ep-aaaa0001, 2026-11-04, seq 11)');
  assert.equal(notFound.textNotFound, 1);
  assert.equal(notFound.exitCode, 1, '真坏引用仍红');
  const unreadable = await auditRows({
    rows: [{ at: 1793749445009, digest: 'd', tokens: 10, scope: 'w:/a', section: '- [antipattern] AAA 原文一 (ep-aaaa0001, 2026-11-04, seq 11)' }],
    episodes: eps,
    loadEvents: async () => { throw new Error('log unreadable'); },
    window: 3,
    textCheck: true,
  });
  assert.equal(unreadable.textUnreadable, 1);
  assert.equal(unreadable.a6Denominator, 0, 'unreadable 不进分母');
  assert.equal(unreadable.exitCode, 1, 'fail-closed');
});

test('T239 ③: 中位距离 + offset 占比（分母不含 unreadable）', async () => {
  const eps = new Map([['ep-aaaa0001', { id: 'ep-aaaa0001', scopeKey: 'w:/a', closure: { seqFrom: 0, seqTo: 100 } }]]);
  const evs = {
    'ep-aaaa0001': [
      { seq: 11, time: DAY(2026, 11, 4, 6), data: { text: 'AAA 原文一' } },
      { seq: 12, time: DAY(2026, 11, 4, 6), data: { text: 'BBB 原文二' } },
    ],
  };
  const out = await auditRows({
    rows: [{
      at: 1793749445009, digest: 'd', tokens: 10, scope: 'w:/a',
      section: [
        '- [antipattern] AAA 原文一 (ep-aaaa0001, 2026-11-04, seq 18)', // offset 距离 7
        '- [antipattern] BBB 原文二 (ep-aaaa0001, 2026-11-04, seq 25)', // offset 距离 13
        '- [antipattern] AAA 原文一 (ep-aaaa0001, 2026-11-04, seq 11)', // ok
      ].join('\n'),
    }],
    episodes: eps,
    loadEvents: async (id) => evs[id] ?? [],
    window: 3,
    textCheck: true,
  });
  assert.equal(out.textOffset, 2);
  assert.equal(out.textOffsetNear, 2, '7 与 13 都 ≤ 20');
  assert.equal(out.offsetDistanceMedian, 10, '(7+13)/2');
  assert.equal(out.a6Denominator, 3);
  assert.equal(out.textOffsetRatio, 2 / 3);
});
