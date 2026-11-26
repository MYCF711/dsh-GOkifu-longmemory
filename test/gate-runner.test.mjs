// gate-runner（重构 A 期）：钉住 scripts/gate.mjs 的**门清单**与**退出码聚合**。
//
// 为什么这份测试本身是门禁的 tombstone：
//   · 门清单被逐项钉死（id / 顺序 / 档位 / 命令参数）—— 删掉任何一门登记、改掉任何一条命令，
//     这份测试立刻红；
//   · 聚合逻辑被钉死（全成功 = 0、有失败 = 非 0、空清单 ≠ 绿）—— 把"任一门失败即非 0"写坏，
//     这份测试也红。
// 判据本身（每门红/绿的标准）不在这里重写：那是各门脚本的事，gate.mjs 只封装。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as gate from '../scripts/gate.mjs';

const EXPECTED_IDS = ['check', 'tests', 'patrol', 'metrics-guard', 'ledger-check', 'tag-audit'];

const SUMMARY_PASS = ['ℹ tests 12', 'ℹ suites 0', 'ℹ pass 12', 'ℹ fail 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n');
const SUMMARY_FAIL = ['ℹ tests 12', 'ℹ suites 0', 'ℹ pass 10', 'ℹ fail 2', 'ℹ skipped 0'].join('\n');

const gateById = (id) => gate.GATES.find((g) => g.id === id);

/** 假的跑门函数：记录跑了哪些门，返回指定成败。 */
function fakeRunner({ failId = null, seen = [] } = {}) {
  return (g, mode) => {
    seen.push(g.id);
    return {
      id: g.id,
      name: g.name,
      ok: g.id !== failId,
      ms: 1,
      status: g.id === failId ? 1 : 0,
      timedOut: false,
      note: g.id === failId ? '合成失败' : undefined,
      out: '',
      repro: gate.reproOf(g, mode),
    };
  };
}

function capture() {
  const lines = [];
  return { lines, out: (line) => lines.push(line) };
}

test('门清单：六门齐全、顺序从便宜到贵、档位登记正确（删掉任一登记 ⇒ 本测试红）', () => {
  assert.deepEqual(gate.GATES.map((g) => g.id), EXPECTED_IDS);
  assert.ok(Object.isFrozen(gate.GATES), '门清单必须冻结，防止运行期被改');
  const modes = Object.fromEntries(gate.GATES.map((g) => [g.id, [...g.modes]]));
  assert.deepEqual(modes, {
    check: ['fast', 'full'],
    tests: ['fast', 'full'],
    patrol: ['full'],
    'metrics-guard': ['full'],
    'ledger-check': ['full'],
    'tag-audit': ['full'],
  });
  for (const g of gate.GATES) {
    assert.equal(typeof g.name, 'string');
    assert.ok(g.name.length > 0, `${g.id} 缺 name`);
    assert.equal(typeof g.argv, 'function', `${g.id} 缺 argv`);
    assert.equal(typeof gate.reproOf(g, 'full'), 'string', `${g.id} 缺复现命令`);
    assert.ok(Number.isFinite(g.timeoutMs) && g.timeoutMs > 0, `${g.id} 缺超时上限`);
  }
});

test('档位选择：--fast = check + 单测；--full = 全部六门', () => {
  assert.deepEqual(gate.selectGates('fast').map((g) => g.id), ['check', 'tests']);
  assert.deepEqual(gate.selectGates('full').map((g) => g.id), EXPECTED_IDS);
  assert.throws(() => gate.selectGates('bogus'), /未知档位/);
});

test('门命令与任务书一致（只封装，不改参数、不加不减）', () => {
  assert.deepEqual(gateById('check').argv('fast'), ['scripts/check.mjs']);
  assert.deepEqual(gateById('tests').argv('full'), ['--test', 'test/*.test.mjs']);
  assert.deepEqual(gateById('patrol').argv('full'), ['scripts/patrol.mjs']);
  assert.deepEqual(gateById('metrics-guard').argv('full'), ['scripts/metrics-guard.mjs']);
  assert.deepEqual(gateById('ledger-check').argv('full'), ['scripts/ledger-check.mjs', '--full']);
  assert.deepEqual(gateById('tag-audit').argv('full'), ['scripts/tag-audit.mjs']);
  assert.equal(gate.reproOf(gateById('ledger-check'), 'full'), 'node scripts/ledger-check.mjs --full');
  assert.equal(gate.commandOf(gateById('patrol'), 'full'), 'node scripts/patrol.mjs');
});

test('fast 档单测 = 全量 test/*.test.mjs 减去真库 e2e', () => {
  const argv = gateById('tests').argv('fast');
  assert.equal(argv[0], '--test');
  const files = argv.slice(1);
  assert.ok(files.length > 0, 'fast 档不能跑 0 个测试文件');
  assert.ok(files.every((f) => f.startsWith('test/') && f.endsWith('.test.mjs')), '只许跑 test/*.test.mjs');
  assert.ok(!files.some((f) => gate.FAST_E2E_PATTERN.test(f)), 'fast 档不得包含真库 e2e');
  assert.deepEqual([...files].sort(), files, '文件清单要排序，复现命令才稳定');
  // 排除规则不能空转：仓库里确实有 e2e 文件，且 fast = 全量 − e2e
  const all = fs.readdirSync(path.join(gate.ROOT, 'test')).filter((name) => name.endsWith('.test.mjs'));
  const e2e = all.filter((name) => gate.FAST_E2E_PATTERN.test(name));
  assert.ok(e2e.length >= 1, '仓库里应当有真库 e2e 测试（否则排除规则空转）');
  assert.equal(files.length, all.length - e2e.length);
});

test('单测汇总解析：口径与 ledger-check / deliverability 一致', () => {
  assert.deepEqual(gate.parseTestSummary(SUMMARY_PASS), { total: 12, pass: 12, fail: 0, skip: 0 });
  assert.equal(gate.parseTestSummary('没有汇总'), null);
});

test('单测门判据：fail 0 且至少跑了 1 条才算过（0 条 ≠ 绿）', () => {
  assert.equal(gate.judgeTestOutput(SUMMARY_PASS).ok, true);
  const fail = gate.judgeTestOutput(SUMMARY_FAIL);
  assert.equal(fail.ok, false);
  assert.match(fail.note, /fail 2/);
  assert.equal(gate.judgeTestOutput('没有汇总').ok, false);
});

test('正则门判据：输出里没有通过标记 ⇒ 红（光有退出码 0 不算过）', () => {
  const checkGate = gateById('check');
  assert.equal(gate.judgeOutput(checkGate, '...\ncheck: PASS\n').ok, true);
  assert.equal(gate.judgeOutput(checkGate, 'warn 房间未建（M1 进行中）').ok, false);

  const patrolGate = gateById('patrol');
  assert.equal(gate.judgeOutput(patrolGate, '结论：三项体检 + 主判据（A2b）+ 语义不变量（SI）全绿。').ok, true);
  const red = gate.judgeOutput(patrolGate, '结论：需要处理 —— 主判据 A2b 红了。');
  assert.equal(red.ok, false);
  assert.match(red.note, /需要处理/);

  const ledgerGate = gateById('ledger-check');
  assert.equal(gate.judgeOutput(ledgerGate, 'ledger-check: PASS').ok, true);
  assert.equal(gate.judgeOutput(ledgerGate, 'ledger-check: FAIL（台账与实测不一致）').ok, false);
});

test('退出码聚合：全成功 = 0；有失败 = 非 0；空清单 = 非 0（一门没跑 ≠ 绿）', () => {
  assert.equal(gate.exitCodeOf([{ ok: true }, { ok: true }]), 0);
  assert.notEqual(gate.exitCodeOf([{ ok: true }, { ok: false }]), 0);
  assert.notEqual(gate.exitCodeOf([{ ok: false }]), 0);
  assert.notEqual(gate.exitCodeOf([]), 0);
  assert.notEqual(gate.exitCodeOf(undefined), 0);
});

test('runGates：按档位选门、按清单顺序跑并聚合', () => {
  const seen = [];
  const fast = gate.runGates({ mode: 'fast', run: fakeRunner({ seen }) });
  assert.deepEqual(seen, ['check', 'tests']);
  const fastSummary = gate.summarize(fast, 'fast');
  assert.equal(fastSummary.ok, true);
  assert.equal(fastSummary.total, 2);
  assert.equal(fastSummary.passed, 2);

  const seenFull = [];
  const full = gate.runGates({ mode: 'full', run: fakeRunner({ seen: seenFull }) });
  assert.deepEqual(seenFull, EXPECTED_IDS);
  assert.deepEqual(full.map((r) => r.id), EXPECTED_IDS);
});

test('main：全成功 ⇒ 退出码 0，逐门 PASS + 汇总', () => {
  const { lines, out } = capture();
  const code = gate.main(['--fast'], { out, run: fakeRunner() });
  assert.equal(code, 0);
  const text = lines.join('\n');
  assert.match(text, /gate --fast：2 门（check \/ tests）/);
  assert.equal((text.match(/✓ PASS/g) ?? []).length, 2, '每门都要有一行 PASS');
  assert.match(text, /2\/2 门通过/);
  assert.doesNotMatch(text, /失败门：/);
});

test('main：逐门即时打印（下一门开跑前，上一门的结果已经输出）', () => {
  const { lines, out } = capture();
  const seenAtStart = [];
  const run = (g, mode) => {
    seenAtStart.push(lines.length);
    return {
      id: g.id,
      name: g.name,
      ok: true,
      ms: 1,
      status: 0,
      timedOut: false,
      note: undefined,
      out: '',
      repro: gate.reproOf(g, mode),
    };
  };
  assert.equal(gate.main(['--fast'], { out, run }), 0);
  // 第一门开跑时只有表头；第二门开跑时应当已经能看到第一门的结果行
  assert.equal(seenAtStart[0], 1, '第一门开跑前只应有表头');
  assert.ok(seenAtStart[1] >= 2, '第二门开跑前必须已打印第一门的结果（不许等全部跑完才输出）');
});

test('main：任一门失败 ⇒ 非 0，且给出失败门清单 + 复现命令', () => {
  const { lines, out } = capture();
  const code = gate.main(['--fast'], { out, run: fakeRunner({ failId: 'tests' }) });
  assert.notEqual(code, 0);
  const text = lines.join('\n');
  assert.match(text, /✗ FAIL\s+tests/);
  assert.match(text, /1\/2 门通过/);
  assert.match(text, /失败门：/);
  assert.match(text, /· tests —— 合成失败/);
  assert.match(text, /复现：node scripts\/gate\.mjs --fast --only tests/);
});

test('main：--only 只跑指定门；不在当前档位的门按参数错误处理（退出码 2）', () => {
  const seen = [];
  assert.equal(gate.main(['--fast', '--only', 'tests'], { out: () => {}, run: fakeRunner({ seen }) }), 0);
  assert.deepEqual(seen, ['tests']);

  const collected = [];
  const bad = gate.main(['--fast', '--only', 'patrol'], { out: (line) => collected.push(line), run: fakeRunner() });
  assert.equal(bad, 2);
  assert.match(collected.join('\n'), /不在 --fast 里/);

  const unknown = gate.main(['--fast', '--only', 'nope'], { out: () => {}, run: fakeRunner() });
  assert.equal(unknown, 2);

  const badArg = gate.main(['--bogus'], { out: () => {}, run: fakeRunner() });
  assert.equal(badArg, 2);
});

test('main：--list 只打印清单，不跑任何门', () => {
  const seen = [];
  const { lines, out } = capture();
  assert.equal(gate.main(['--list'], { out, run: fakeRunner({ seen }) }), 0);
  assert.deepEqual(seen, []);
  const text = lines.join('\n');
  for (const id of EXPECTED_IDS) assert.match(text, new RegExp(`\\b${id}\\b`));
});

test('runOneGate：真跑子进程 —— exit 0 + 标记命中 = 过；缺标记 / 非 0 = 红', () => {
  const base = {
    name: '合成门',
    repro: 'x',
    expect: /MARK PASS/,
    timeoutMs: 60_000,
  };
  const ok = gate.runOneGate({ ...base, id: 'synthetic-ok', argv: () => ['-e', 'console.log("MARK PASS")'] }, 'fast');
  assert.equal(ok.ok, true);

  const noMarker = gate.runOneGate({ ...base, id: 'synthetic-nomarker', argv: () => ['-e', 'console.log("nothing here")'] }, 'fast');
  assert.equal(noMarker.ok, false, '退出码 0 但没有通过标记 ⇒ 红（fail-closed）');

  const badExit = gate.runOneGate({ ...base, id: 'synthetic-exit1', argv: () => ['-e', 'console.log("MARK PASS"); process.exit(1)'] }, 'fast');
  assert.equal(badExit.ok, false, '有通过标记但退出码非 0 ⇒ 红');
});

test('runOneGate：超时按红算（挂住 = 没验出结论）', () => {
  const r = gate.runOneGate({
    id: 'synthetic-timeout',
    name: '超时门',
    argv: () => ['-e', 'setTimeout(() => {}, 30_000)'],
    repro: 'x',
    expect: /never/,
    timeoutMs: 500,
  }, 'fast');
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(String(r.note), /超时/);
});