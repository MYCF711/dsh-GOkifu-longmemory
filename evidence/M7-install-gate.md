# 安装闸：六轮独立审计的收敛记录（2026-11-02）

## 为什么需要这份文件
本机铁律 6 规定：提出"安装/重启"前必须 ① 无优化方向 ② 达到当前能力上限 ③ 经严格专员审核且无遗留。
这里把 ③ 的证据链集中记录，避免"我觉得可以装了"。

## 审计链（每轮独立子代理、只读、各自写一份报告）
| 轮次 | 报告 | 结论 | 主要问题 |
|---|---|---|---|
| 01 | `reports/audit-01.md` | 有条件通过（无 P0） | `validFrom` 未落地、`class:` 前缀随顺序丢、AGENTS 停在 0.19.1、public 写成私有、A1 空转 |
| 02 | `reports/audit-02.md` | 有条件通过 | 上述 2 项未真修：`check.mjs` 死断言、ruleset 缺失 |
| 03 | `reports/audit-03.md` | 有条件通过 | 台账数字与实测不符、发布闸 `--no-tests`、陈旧"私有"段、计划表漏记 |
| 04 | `reports/audit-04.md` | 随机 10 条 **9/10** | 方案"当前基线"过期（116 局/35.56% → 117 局/33.85%） |
| 05 | `reports/audit-05.md` | 随机 10 条 **9/10** | 历史审计报告里的**裸行号**漂移（引用失效，非事实失真） |
| **06** | `reports/audit-06.md` | **活文档随机 10 条 10/10** | 无失分；3 条卫生提示已修（S13 加时点、evidence 去掉已删选项、MAINTENANCE 补重启限定） |

## 当前可交付状态（0.64.0）
- `check PASS`、`node --test` 394 条（390 pass / 0 fail / 4 skip）、`ledger-check --full PASS`（版本/测试四分量/claim/卷/局数/A2/A4/时点）。
- `metrics-guard PASS`：A1 0%（空转，validity 26 条中 0 条渲染）、A5 0%、A6 100%、A2b 严格 84.2%（冻结 19 条）、p50 ≈2ms。
- 保护：仓库 public；`main` ruleset（pull_request + required check `rules` strict + 禁删除/强推）。
- 不发 npm：`private:true`、无 publishConfig、release 只 tag + GitHub Release。

## 仍未满足/未验证（诚实清单）
1. **A3 仍是 not-live**：插件在 `cordis.patch.yml` 里两条 `disabled:true`，从未真实加载；线上注入未验证。
2. **Q18 未裁定**：`class:*` 跨工作区展示（预演：展示命中 A=0% / B=41.7%）。
3. 三条 P2 候选未做：真实样本夹具固化、preference 逐字引文豁免口径、`boundary-audit.mjs` 静态扫描。
4. 审计抽样池不含 `evidence/**`、`计划表.md`、`reports/**`（各自有 ledger-check 或历史快照属性）。

## 结论
"文档/命令/指标可核对"这一层已有 10/10 的抽样证据；**A3 上线验证只能靠一次真实安装**，
因此下一步是**由主人执行安装三步**，装完立刻跑 `first-live.mjs` + `repeat-report.mjs` 形成第一份线上证据。
