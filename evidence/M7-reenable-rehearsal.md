# 安装彩排：在一个"假 home"上把 re-enable 全程跑一遍（2026-11-02）

## 为什么
主人只有一次动手成本（退出 DSH → 跑脚本 → 重开）。重开若失败，代价很高。
所以在**真实 home 之外**复制一份 profile，把 `re-enable` 与 `install-doctor` 全跑一遍，
先证明脚本与插件注册链路是对的。

## 做法（真实 home 全程未被改动）
```bash
rm -rf tmp/rehearse-home && mkdir -p tmp/rehearse-home/profiles/desktop
cp "D:/DeepSeek Harness/home/profiles/desktop/package.json"        tmp/rehearse-home/profiles/desktop/
cp "D:/DeepSeek Harness/home/profiles/desktop/cordis.patch.yml"     tmp/rehearse-home/profiles/desktop/

DSH_HOME="$PWD/tmp/rehearse-home" node scripts/re-enable.mjs --dry-run
DSH_HOME="$PWD/tmp/rehearse-home" node scripts/re-enable.mjs
DSH_HOME="$PWD/tmp/rehearse-home" node scripts/install-doctor.mjs
```

## 结果
| 步骤 | 输出 |
|---|---|
| dry-run | `依赖: link:…/长期记忆系统` · `bundle: 将补` · `禁用条目: 摘除 3 条` · `patch 将改: true · package.json 将改: true` |
| 实跑 | `完成。重新打开 DSH，然后跑 node scripts/install-doctor.mjs 验收。`（pnpm 实际安装 16.1s） |
| 备份 | `cordis.patch.yml.bak-reenable-<ts>`、`package.json.bak-reenable-<ts>` 各一份 |
| 复制体 patch | **不再含 `dsh-gokifu-longmemory`**（原 4 处 → 0 处） |
| 复制体 package.json | `dependencies["dsh-gokifu-longmemory"] = "link:…"`；`dsh.profile.bundles` 含该包 |
| `install-doctor` | `ok 插件注册…未见 disabled` · `ok 设置接口 GET · status=200`（`exists:false, episodes:null`，因为假 home 没有 store） |

## 真实 home 完整性（彩排后立刻核对）
```
grep -c "dsh-gokifu-longmemory" 真实 cordis.patch.yml   → 4   （未变）
grep -c "disabled: true"        真实 patch              → 6   （未变）
package.json dependencies 含该包                        → false（未变）
```

## 结论
1. `re-enable` 的"精准摘除 + 补依赖 + 补 bundle + 备份"四件事**都按预期工作**；
2. 插件能进入 profile 并被识别（doctor 报 `未见 disabled`）；
3. **零配置**成立：没有 store 时设置接口仍 200，只是 `exists:false`；
4. 彩排只在 `tmp/` 里留下痕迹（已 gitignore），真实 profile 未被触碰。

## 给主人的三步（照 `docs/安装指南.md` §1）
1. 退出 DSH（不要用 taskkill）；
2. `node scripts/re-enable.mjs`；
3. 重新打开 DSH → `node scripts/install-doctor.mjs`，期望前三项 ok、store 项在首次归档前为 `exists:false`。
