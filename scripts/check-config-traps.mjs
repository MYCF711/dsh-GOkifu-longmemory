// scripts/check-config-traps.mjs —— **只读**：扫 `config.X !== false` 的写法（"默认开启"的错误写法）。
//
// 依据（知识库 45「配置面陷阱」+ T366e 的 D5 实测）：
//   `undefined !== false` = true ⇒ **把"未设置"当成"开启"**。
//   正确的"默认开启"写法是**在 `DEFAULT_CONFIG` 里设 `true`**（未设置时有明确默认值），
//   **不是 `config.X !== false`**。
//
// 本脚本把 `src/` 里 `config.X !== false` 的写法扫出来（**跳过注释行**），
// 并报告"这会把'未设置'当成'开启'，应该在 DEFAULT_CONFIG 里设 true"。

import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');
const findings = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.mjs')) scan(p);
  }
}

function scan(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    // 跳过注释行（`//`、`/*`、`*`）
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // 找 `config.X !== false`（真的代码，不是注释）
    for (const m of line.matchAll(/config\.([A-Za-z0-9_]+)\s*!==\s*false/g)) {
      findings.push({ file: path.relative(process.cwd(), file), line: i + 1, key: m[1], text: trimmed.slice(0, 100) });
    }
  }
}

walk(SRC);

console.log(`config.X !== false 的写法（"默认开启"的**错误写法**，把"未设置"当成"开启"）：${findings.length} 处`);
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}  config.${f.key} !== false`);
  console.log(`      ${f.text}`);
  console.log(`      → **应该在 DEFAULT_CONFIG 里设 \`${f.key}: true\`**，而不是 \`!== false\`。`);
}

// 退出码：发现就非零（让 CI 能拦住），但不强退（先报出来，修不修看裁定）
process.exit(findings.length > 0 ? 1 : 0);
