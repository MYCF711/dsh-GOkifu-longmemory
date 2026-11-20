# T391 · 归档分阶段打点：**写 topics 就用掉 242 秒**

> 2026-11-20 · 用 `KIFU_ARCHIVE_TRACE=1` 逐阶段打点到 stderr（进程被杀也能看到卡点）。

## 一、实测（`--incremental`，真跑，600 秒被 timeout 杀掉）

```
after-build-loop      +20,103ms     ← 读 125 个会话 + 构建 episode
after-fold            +20,105ms     ← 子代理归并（几乎不花时间）
after-claims          +20,462ms     ← 定式/claim
after-recovery-index  +20,467ms
before-derive-out     +51,675ms     ← 中间 31 秒：写权威目录（episodes putMany + sourceStatus）
after-derive-out      +53,236ms     ← derive 1.5 秒（增量已生效，不再是瓶颈）
after-topics          +295,834ms    ← ★★★ 写 topics 花了 242 秒
（links 写入未跑完，600 秒被杀）
```

## 二、结论：慢在 `putMany` 的**逐条写放大**，不在计算

`replaceDerived('topics', 26,238 条)` 耗时 242 秒 ⇒ **约 9ms/条**。

每条的成本是：读旧文件 → 算 sha256 → 写临时文件 → rename → 追 journal。
21.5 万条（links）按同比例 ⇒ **上千秒**，与实测"跑不完"完全吻合。

**读日志（20 秒）和 derive（1.5 秒）都已经不是瓶颈了** —— 前面几轮的优化是对的，只是没打到真正的痛处。

## 三、下一刀（明确的三种选择，都属纯正向）

| 方案 | 做法 | 预期 |
|---|---|---|
| **① 跳过未变记录的文件 I/O** | 先比对 `record.sha256`（若记录自带）或按 kind 的 manifest 摘要，**内容没变就不读旧文件** | 省掉 2.6 万次读 + 比较 |
| **② 批量写** | 同 kind 的记录先全部算好，再按批次写（减少 fsync/rename 次数；journal 改为批量追加一条） | 可能降一个数量级 |
| **③ links 分片存储** | 一个 topic 的边写一个文件 | 动 R15 契约，影响面大 |

**建议先量 `putMany` 里各步骤占比**（读旧值 / sha256 / write / rename / journal），再决定 ① 还是 ②。

## 四、附带确认

- 打点只在 `KIFU_ARCHIVE_TRACE=1` 时输出，**不改 summary 形状**（`archive.test` 保持 11/11）；
- `--incremental` 的读侧优化确实有效：4600 个日志从 200 秒降到 20 秒（本轮的 build-loop 20 秒里还含解析）。
