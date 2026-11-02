# M7 · `cli audit`：记忆健康一眼可查（2026-11-02）

## 为什么
「被遮蔽的记忆」有三类：过期（validityOk=false）、invalidated、无支撑（违反无源不入）。
此前只能翻 `claims/*.json` 才能知道有没有问题。

## 新增（只读）
```bash
node scripts/cli.mjs audit [--store <dir>] [--json]
```

- claim 总数 + 状态分布；
- **被遮蔽计数**：过期 / invalidated / 无支撑；
- 卷数 + 类级主卷 Top5；
- 有「无支撑 claim」⇒ **退出码 1**（CI 可拦）。

## 本机实测（116 局 store）
```
claim 282 条 · 状态 observed=257 · candidate=25
被遮蔽：过期(validityOk=false) 22 · invalidated 0 · 无支撑 0
卷 138 个 · 类级主卷 4 个
```

## 与调研的关系
对应 Cognee 的 `forget` 语义检查（N11）：我们只遮蔽不删，所以需要一眼确认“被遮蔽的确实没进注入”。
