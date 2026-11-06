// T341 · GOKIFU_INJECT 环境变量开关（ablation B 臂真关注入）
// 背景：旧 ablation 脚本写的 GOKIFU_INJECT=off 此前无人读取（虚构开关）⇒ B 臂仍带注入、两臂等价。
// 本开关仅显式 off/false/0 才关（enabled=false 且 shadow=false），不设/其他值 = 配置键为准（绝不误关生产）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeConfig } from '../src/plugin.mjs';

function withEnv(value, fn) {
  const prev = process.env.GOKIFU_INJECT;
  if (value === undefined) delete process.env.GOKIFU_INJECT;
  else process.env.GOKIFU_INJECT = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.GOKIFU_INJECT;
    else process.env.GOKIFU_INJECT = prev;
  }
}

test('T341 ① off/false/0（大小写不敏感）⇒ enabled=false 且 shadow=false（完全静默，tombstone）', () => {
  for (const v of ['off', 'false', '0', 'OFF', 'False']) {
    withEnv(v, () => {
      const c = sanitizeConfig({});
      assert.equal(c.enabled, false, `GOKIFU_INJECT=${v} 必须关 enabled`);
      assert.equal(c.shadow, false, `GOKIFU_INJECT=${v} 必须关 shadow`);
    });
  }
});

test('T341 ② 不设环境变量 ⇒ 配置键为准（默认 enabled=true, shadow=false，行为不变）', () => {
  withEnv(undefined, () => {
    const c = sanitizeConfig({});
    assert.equal(c.enabled, true);
    assert.equal(c.shadow, false);
  });
});

test('T341 ③ on/true/1/其他值 ⇒ 不强制关（配置键为准，绝不误关生产注入）', () => {
  for (const v of ['on', 'true', '1', 'yes', 'garbage']) {
    withEnv(v, () => {
      const c = sanitizeConfig({});
      assert.equal(c.enabled, true, `GOKIFU_INJECT=${v} 不许误关`);
    });
  }
});

test('T341 ④ off 优先于配置键 enabled:true/shadow:true（实验强制关，两臂才能真分离）', () => {
  withEnv('off', () => {
    const c = sanitizeConfig({ enabled: true, shadow: true });
    assert.equal(c.enabled, false);
    assert.equal(c.shadow, false);
  });
});
