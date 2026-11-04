// 打印（并可选写出）「把工具面插件挂进 profile」需要的那几行 YAML。
//
// 为什么只打印不直接改：
//   `profiles/*/cordis.patch.yml` 是**热重载开关** —— 运行中写它会让整树热重载，可能把 host 打死
//   （本机 2026-10-30 真机事故）。所以这里只产出**待粘贴片段**，由人在方便的时候（最好先退出 DSH）粘进去。
//
// 用法：
//   node scripts/print-tools-plugin-entry.mjs            # 只打印
//   node scripts/print-tools-plugin-entry.mjs --write    # 另存 tmp/profile-tools-entry.yml
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).name;

const ENTRY = `# === 棋院工具面（PTC / run_code）：kifu_* 五个只读工具 ===
# 与主插件分开挂：宿主只把 tools 服务交给**声明了 inject** 的插件；本插件缺服务时只是自己不加载，
# 记忆注入（主插件）完全不受影响。
- id: kifu-tools
  name: ${PKG}/tools
`;

const out = [
  '把下面这段加进 `$DSH_HOME/profiles/<你的 profile>/cordis.patch.yml` 的插件列表里（顶层数组，缩进与相邻条目一致）：',
  '',
  ENTRY,
  '然后重启 DSH 一次。重启后自查：',
  `  cat "$DSH_HOME/memory-context/tools-registered.json"`,
  '  看到 "via": "tools-plugin" 且 "count": 5 ⇒ 工具挂上了；',
  '  看到 "via": "tools-plugin-none" ⇒ 宿主没给工具服务（再看 "ctxHasRegister"）。',
  '',
  '注意：这条命令**不写任何配置文件**；`--write` 只是把它另存到 tmp/ 方便复制。',
].join('\n');

console.log(out);
if (process.argv.includes('--write')) {
  const target = path.join(REPO, 'tmp', 'profile-tools-entry.yml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, ENTRY);
  console.log(`\n已写入：${target}`);
}
