// 棋院工具面（PTC / run_code）的 tombstone test：删掉 src/tools.mjs ⇒ 本文件整片红。
// 契约：docs/SDK-PTC.md 的工具一节。这里钉住：形状对、参数透传、错误不抛、注册失败不连累其它工具。
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildMemoryTools, registerMemoryTools, TOOL_PREFIX } from '../src/tools.mjs';

const fakeSdk = (calls) => (opts) => ({
  stats: () => { calls.push(['stats', opts]); return { ok: true, n: 1, status: 'measured' }; },
  search: (text, o) => { calls.push(['search', text, o]); return { ok: true, n: 1, hits: [{ episode: 'ep-x', seq: 1 }] }; },
  card: (text, o) => { calls.push(['card', text, o]); return { ok: true, section: '- x', tokens: 3, n: 1, claims: [], gates: { ok: true, errors: [] } }; },
  recentFailures: (o) => { calls.push(['recentFailures', o]); return { ok: true, n: 1, items: [], status: 'measured' }; },
  get: (kind, id) => { calls.push(['get', kind, id]); return { ok: true, kind, id, record: { id } }; },
});

test('tools: 五个工具、名字带 kifu_ 前缀、都有 parameters/output/execute', () => {
  const tools = buildMemoryTools();
  assert.deepEqual(tools.map((t) => t.name), [
    `${TOOL_PREFIX}_stats`, `${TOOL_PREFIX}_search`, `${TOOL_PREFIX}_card`, `${TOOL_PREFIX}_recent_failures`, `${TOOL_PREFIX}_get`,
  ]);
  for (const t of tools) {
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 10, `${t.name} 要有可读的说明`);
    assert.equal(typeof t.execute, 'function');
    assert.equal(t.parameters.type, 'object');
    assert.equal(typeof t.output.render, 'function');
  }
  const search = tools.find((t) => t.name === `${TOOL_PREFIX}_search`);
  assert.deepEqual(search.parameters.required, ['text'], 'text 必填');
});

test('tools: 参数透传给 SDK（scope/limit 不丢），返回值原样带回', async () => {
  const calls = [];
  const tools = buildMemoryTools({ createSdk: fakeSdk(calls) });
  const search = tools.find((t) => t.name === `${TOOL_PREFIX}_search`);
  const out = await search.execute({ text: 'json decode', limit: 3, scope: 'w:d:/x' });
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0][1], 'json decode');
  assert.equal(calls[0][2].limit, 3);
  assert.equal(calls[0][2].scope, 'w:d:/x');
});

test('tools: SDK 抛 SdkError ⇒ 翻成 {ok:false,error:{code}}，不把异常抛给代码块', async () => {
  const tools = buildMemoryTools({
    createSdk: () => ({
      recentFailures: () => { const e = new Error('记忆库读不了'); e.code = 'store-unreadable'; throw e; },
    }),
  });
  const tool = tools.find((t) => t.name === `${TOOL_PREFIX}_recent_failures`);
  const out = await tool.execute({ limit: 5 });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'store-unreadable');
  assert.match(out.error.message, /读不了/);
});

test('tools: 非 SdkError 的意外 ⇒ internal（也不抛）', async () => {
  const tools = buildMemoryTools({ createSdk: () => { throw new TypeError('boom'); } });
  const out = await tools[0].execute({});
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'internal');
});

test('tools: 每个工具都是并发安全的（PTC 代码块里会并行调用）', () => {
  for (const t of buildMemoryTools()) assert.equal(t.isConcurrencySafe(), true);
});

test('tools: 注册 —— 有 ctx.tools.register 就全注册；没有就安静跳过；单个失败不连累其它', () => {
  const ok = [];
  assert.deepEqual(registerMemoryTools({ tools: { register: (t) => ok.push(t.name) } }), ok);
  assert.equal(ok.length, 5);

  assert.deepEqual(registerMemoryTools({}), [], '没有工具面 ⇒ 返回空数组，不抛');
  assert.deepEqual(registerMemoryTools(null), []);

  const partial = [];
  const warned = [];
  const names = registerMemoryTools({
    tools: { register: (t) => { if (t.name.endsWith('_card')) throw new Error('deliberate'); partial.push(t.name); } },
  }, { warn: (_ctx, msg) => warned.push(msg) });
  assert.equal(names.length, 4, '除被拒的那个，其余都注册成功');
  assert.ok(warned.some((m) => m.includes('_card')), '被拒的要 warn，且说明不影响注入');
});

test('tools: 注册凭据落盘（原子写、可读回），失败返回 false 不抛', async () => {
  const { recordToolRegistration } = await import('../src/tools.mjs');

  const dir = mkdtempSync(path.join(tmpdir(), 'kifu-tools-reg-'));
  try {
    assert.equal(recordToolRegistration(dir, ['kifu_stats', 'kifu_get'], { at: 1793793301076 }), true);
    const back = JSON.parse(readFileSync(path.join(dir, 'tools-registered.json'), 'utf8'));
    assert.equal(back.count, 2);
    assert.deepEqual(back.names, ['kifu_stats', 'kifu_get']);
    assert.equal(back.at, 1793793301076);
    assert.ok(!existsSync(path.join(dir, 'tools-registered.json.tmp')), '不许留 tmp 碎片');
  } finally { rmSync(dir, { recursive: true, force: true }); }

  assert.equal(recordToolRegistration('', ['x']), false, '空目录 ⇒ false，不抛');
  assert.equal(recordToolRegistration(path.join(tmpdir(), 'kifu-nope-不存在的目录', 'x'), ['x']), false);
});


test('tools: 凭据必须写明 via 与 ctxHasRegister（两条注册路径的判据）', async () => {
  const { recordToolRegistration } = await import('../src/tools.mjs');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const dir = mkdtempSync(path.join(tmpdir(), 'kifu-tools-via-'));
  try {
    assert.equal(recordToolRegistration(dir, [], { via: 'none', ctxHasRegister: false }), true);
    const back = JSON.parse(readFileSync(path.join(dir, 'tools-registered.json'), 'utf8'));
    assert.deepEqual(back.names, [], '空数组也要落盘 —— "没注册上"本身就是判据');
    assert.equal(back.via, 'none');
    assert.equal(back.ctxHasRegister, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
