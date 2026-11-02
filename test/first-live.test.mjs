import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFirstLive } from '../scripts/first-live.mjs';

const doctorOk = { ok: true, checks: [
  { name: '插件注册（配置里出现包名）', ok: true, detail: '$DSH_HOME/profiles/desktop/cordis.patch.yml · 未见 disabled' },
  { name: '热路径抽测', ok: true, detail: 'runs=5 injected=3 empty=2 failed=0 warn=0 p95=14ms' },
] };
const guardOk = { ok: true, fails: [], values: { a1: 0, a5: 0, a6: 1, p50: 2.1, a2bStrict: 0.84, a2bCover: 1, a2bN: 19 } };

test('first-live: 注册无禁用 + 门槛通过 ⇒ liveReady=true', () => {
  const out = buildFirstLive({ version: '0.51.0', at: new Date('2026-11-02T12:00:00Z'), doctorReport: doctorOk, guard: guardOk });
  assert.equal(out.liveReady, true);
  assert.equal(out.disabled, 0);
  assert.match(out.markdown, /已上线/);
  assert.match(out.markdown, /84\.00%/);
});

test('first-live: 仍有 disabled ⇒ liveReady=false，并提示三步', () => {
  const doctorDisabled = { ok: true, checks: [
    { name: '插件注册（配置里出现包名）', ok: true, detail: 'cordis.patch.yml · 其中 4 条 disabled:true（等 re-enable）' },
  ] };
  const out = buildFirstLive({ version: 'x', at: new Date(), doctorReport: doctorDisabled, guard: guardOk });
  assert.equal(out.liveReady, false);
  assert.equal(out.disabled, 4);
  assert.match(out.markdown, /尚未上线/);
  assert.match(out.markdown, /退出 DSH/);
});

test('first-live: 门槛失败 ⇒ liveReady=false，并列出失败轴', () => {
  const guardFail = { ok: false, fails: ['A5 越界 0.01 != 0'], values: { a1: 0.06 } };
  const out = buildFirstLive({ version: 'x', at: new Date(), doctorReport: doctorOk, guard: guardFail });
  assert.equal(out.liveReady, false);
  assert.match(out.markdown, /A5 越界 0\.01/);
});

test('first-live: 没有影子与遥测时不编数字', () => {
  const out = buildFirstLive({ version: 'x', at: new Date(), doctorReport: doctorOk, guard: guardOk, shadow: { records: null }, repeat: { total: null } });
  assert.match(out.markdown, /影子台账不存在/);
  assert.match(out.markdown, /没有遥测/);
});
