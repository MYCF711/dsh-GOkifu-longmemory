// T58 · 自证污染核查的**方向判定**（tombstone test）。
//
// 背景（2026-11-09 实测）：脚本自己的契约写着「`card-from-claim`（卡渲染晚于 claim = 卡引用了 claim）
// **不算**红线实例」，但它把方向只算在 `details`（默认 5 条抽样）上，结算与退出码却用**未区分方向**的
// `selfContaminated` ⇒ 本机 60 条**全部**是 card-from-claim，却被判成红线、退出码 1。
// 改后：方向在**全量** contaminated 上算，退出码只看真 F5（claim-from-card + 方向不明）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyDirection } from '../scripts/self-contamination-audit.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const T = (day) => Date.UTC(2026, 10, day, 12, 0, 0);

test('T58 ①: 卡早于 claim ⇒ claim-from-card（真 F5 嫌疑）', () => {
  assert.equal(classifyDirection(T(1), T(3)), 'claim-from-card');
});

test('T58 ②: 卡晚于 claim ⇒ card-from-claim（卡引用了 claim，不算红线；是 P2 改写问题）', () => {
  assert.equal(classifyDirection(T(5), T(3)), 'card-from-claim');
});

test('T58 ③: 时间相同 ⇒ card-from-claim（严格小于才算"卡早于"）', () => {
  assert.equal(classifyDirection(T(3), T(3)), 'card-from-claim');
});

test('T58 ④: 算不出来 ⇒ unknown（fail-closed，按真 F5 计，不许当没事）', () => {
  assert.equal(classifyDirection(null, T(3)), 'unknown');
  assert.equal(classifyDirection(T(1), null), 'unknown');
  assert.equal(classifyDirection(undefined, undefined), 'unknown');
  assert.equal(classifyDirection(Number.NaN, T(1)), 'unknown');
});

test('T58 ⑤: 退出码只看真 F5（源码契约）—— 不许再拿未区分方向的 selfContaminated 结算', () => {
  const src = readFileSync(path.join(REPO, 'scripts', 'self-contamination-audit.mjs'), 'utf8');
  assert.ok(
    src.includes('stats.realF5 = stats.claimFromCard + stats.directionUnknown'),
    '真 F5 = 卡早于 claim + 方向不明（fail-closed）',
  );
  assert.match(
    src,
    /return \(result\.stats\.realF5 \?\? result\.stats\.selfContaminated\) > 0 \? 1 : 0;/,
    '退出码必须看 realF5；改回 selfContaminated 就会把反向（卡引用 claim）判成红线',
  );
  assert.ok(
    src.includes('for (const row of contaminated)') && src.includes('directionByRow.set(row,'),
    '方向必须在**全量** contaminated 上算，不能只算 details 抽样',
  );
});
