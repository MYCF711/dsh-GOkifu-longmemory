import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('M5 负迁移演练：10 个坏样本全拦住 + 1 个合格卡不被误杀', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/redteam.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.badSamples, 10);
  assert.equal(report.blocked, 10);
  assert.equal(report.leaked, 0, `泄漏样本：${report.cases.filter((c) => !c.ok).map((c) => c.name).join(' / ')}`);
  assert.equal(report.control, 1);
  assert.equal(report.controlKilled, 0, '合格卡被误杀');
});
