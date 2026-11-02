# M7 · `cli volumes`：棋书视图可查（2026-11-02）

## 为什么
「棋谱成册 → 棋书」是产品主线，但此前只能在 store 里翻 `threads/*.json`；没有一眼看全的入口。

## 改动
新增只读命令：

```bash
node scripts/cli.mjs volumes [--store <dir>] [--limit <n>] [--json]
```

- 类级主卷（`class:*`）排在最前（按局数），其余按局数降序；
- 输出：总卷数 / 类级主卷数 / 每卷局数与 id；`--json` 给程序用。

## 本机实测（116 局 store）
```
卷（棋书视图，只读）：138 个 · 类级主卷 4 个
- class:module-missing · 7 局 · th-7520f349 · 主卷
- class:fs-read-before-write · 6 局 · th-ded39fb5 · 主卷
- class:web-search-empty · 4 局 · th-bddb515c · 主卷
- class:sandbox-limit · 3 局 · th-dd40765c · 主卷
```

只读：不写 store、不写日志。
