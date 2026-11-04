// 台账闸用的纯解析器（无 I/O、无副作用）：把 `node --test` 的输出翻成"计数"与"红的是哪条"。
//
// 为什么单独成文件：`scripts/ledger-check.mjs` 是**跑起来就有副作用**的脚本（顶层 await 跑全流程），
// 往里面加 export 再 import 会连带执行整个检查（0.126 的 q18-preview 就这么炸过 CI）。
// 所以解析逻辑放这里，ledger-check 与单测共用同一份实现。

/** spec 报告器的 "✖ 名字 (12.3ms)" 与 tap 报告器的 "not ok 7 - 名字" 都要认。 */
export function failingTestNames(output, limit = 3) {
  const names = [];
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const tap = /^not ok \d+ - (.+)$/.exec(line);
    if (tap) {
      names.push(tap[1].trim());
    } else {
      const spec = /^\u2716 (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/.exec(line);
      if (spec) names.push(spec[1].trim());
    }
    if (names.length >= limit * 3) break;
  }
  // 去重保序（同一文件既有汇总行又有子测试行时会重复）
  return [...new Set(names)].slice(0, limit);
}

/** 取计数汇总：spec 用 ℹ、tap 用 `# `。两套都认，解析不到返回 null（**不编 0**）。 */
export function parseTestCounts(output) {
  const text = String(output ?? '');
  const spec = /\u2139 tests (\d+)[\s\S]*?\u2139 pass (\d+)[\s\S]*?\u2139 fail (\d+)[\s\S]*?\u2139 skipped (\d+)/.exec(text);
  if (spec) return { total: Number(spec[1]), pass: Number(spec[2]), fail: Number(spec[3]), skip: Number(spec[4]), reporter: 'spec' };
  const tap = /# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)[\s\S]*?# skipped (\d+)/.exec(text);
  if (tap) return { total: Number(tap[1]), pass: Number(tap[2]), fail: Number(tap[3]), skip: Number(tap[4]), reporter: 'tap' };
  return null;
}

/** 给错误信息用的后缀："；红的是：a | b"，解析不到就如实说解析不到。 */
export function describeFailure(output, limit = 3) {
  const names = failingTestNames(output, limit);
  return names.length ? `；红的是：${names.join(' | ')}` : '；且没解析出测试名（输出为空？）';
}
