# M7 · re-enable 脚本加固（2026-11-02）

## 发现的风险（旧版）
旧 `scripts/re-enable.mjs` 处理 `cordis.patch.yml` 的方式是：**从标记注释开始一直截到文件末尾**。

问题：
- 如果禁用块后面还有别的服务/配置，会被一起删掉；
- 只处理一条禁用条目，而本机实际有**两条**（历史改名残留），处理后仍剩一条 `disabled: true`。

## 新版做法（精准摘除）
`stripDisableBlock(text, pkgName)`：
1. 先摘掉含包名且含「临时禁用」的**注释行**；
2. 再按 `- id:` 切分条目块，只删除**含本包名且含 `disabled: true`** 的块；
3. 其它条目、其它注释、文件其余内容**原样保留**；
4. 返回 `{text, removed, disabledLeft}`，dry-run 直接打印。

## 本机 dry-run（2026-11-02 19:10）
```
禁用条目: 摘除 3 条          ← 1 条注释 + 2 条 disabled 条目
[dry-run] patch 将改: true · package.json 将改: true
```

## 验收方式（给主人）
1. 退出 DSH → `node scripts/re-enable.mjs`；
2. 重开 DSH → `node scripts/install-doctor.mjs`：注册项应显示「未见 disabled」；
3. `node scripts/metrics-guard.mjs` 应 PASS。

## 测试
3 条单测：精准摘除并保留尾随条目 / 无禁用块时幂等 / 已启用条目保留并计数。
