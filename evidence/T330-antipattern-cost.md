# T330 · antipattern 的 `cost`（T3 付过代价）

> `[本] 2026-11-06T09:31:56.151Z` · **只读**（不写库）· 未跑全量测试、未重启 DSH。
> 只认机械痕迹：retry / rework / interruption / steps。**判不出 ⇒ `cost: 0`（没测到，不是没代价）**。

## 0 · 一句话

**1 / 1105 条能机械判出"付过代价"（0.09%）**；其余 1104 条 `cost: 0`（没测到代价）。

## 1 · 汇总

```
antipattern 1105 · 测到代价 1 · cost:0 1104
痕迹分布：{"retry":1}
失败→恢复平均 62.2 步
```

## 2 · 逐字对照（3 条）

### 1. `c-cb03dd01`（ep-d52b6ca5 seq 1400）cost=1 · retry · steps=n/a

```
re.PatternError: unterminated character set at position 9
```


## 3 · cost:0 的样本（前 5，没测到代价）

- `c-00248579` "Error: unknown job bash-49fb11d400eb4696"
- `c-008c3e04` "[notice] A new release of pip is available: 26.2.1 -> 26.2.2 [notice] To update,"
- `c-00a2178a` "Error: writing under C:/Windows/Fonts/msyh.ttc would destroy the running runtime"
- `c-00f68083` "✗ C172 「2 分钟总览」必须与 CHANGELOG / HANDOFF / live-folds.json 同步（此前无人守） ✗ C305 进度页现状摘"
- `c-0153220d` "11: * 1. `worldstate.touch(paths)` 收到的是**单个路径字符串**（engine 的 `st.touchPath`）， 30:"

