import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleConfigRoute, USER_CONFIG_FILE } from '../src/plugin.mjs';

const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-home-'));

test('设置接口：GET 返回生效库地址与配置文件路径', () => {
  const home = mkHome();
  try {
    const out = handleConfigRoute({ method: 'GET', dshHome: home });
    assert.equal(out.status, 200);
    assert.equal(out.body.effectiveStoreRoot, path.join(home, 'memory-context'));
    assert.equal(out.body.userConfigFile, path.join(home, USER_CONFIG_FILE));
    assert.equal(out.body.config.enabled, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('设置接口：POST 保存 storeRoot，并立即反映到 GET', () => {
  const home = mkHome();
  try {
    const saved = handleConfigRoute({ method: 'POST', body: JSON.stringify({ storeRoot: 'D:/mem/kifu' }), dshHome: home });
    assert.equal(saved.status, 200);
    const after = handleConfigRoute({ method: 'GET', dshHome: home });
    assert.equal(after.body.config.storeRoot, 'D:/mem/kifu');
    assert.equal(after.body.effectiveStoreRoot, path.resolve('D:/mem/kifu'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('设置接口：拒绝相对路径 / 非布尔 switch / 非正数预算；profile 配置优先于文件', () => {
  const home = mkHome();
  try {
    assert.equal(handleConfigRoute({ method: 'POST', body: JSON.stringify({ storeRoot: 'relative/path' }), dshHome: home }).status, 400);
    assert.equal(handleConfigRoute({ method: 'POST', body: JSON.stringify({ shadow: 'yes' }), dshHome: home }).status, 400);
    assert.equal(handleConfigRoute({ method: 'POST', body: JSON.stringify({ budgetTokens: -1 }), dshHome: home }).status, 400);
    assert.equal(handleConfigRoute({ method: 'POST', body: 'not json', dshHome: home }).status, 400);

    handleConfigRoute({ method: 'POST', body: JSON.stringify({ storeRoot: 'D:/from-file' }), dshHome: home });
    const out = handleConfigRoute({ method: 'GET', profileConfig: { storeRoot: 'D:/from-profile' }, dshHome: home });
    assert.equal(out.body.effectiveStoreRoot, path.resolve('D:/from-profile'), 'profile 配置必须覆盖用户文件');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
