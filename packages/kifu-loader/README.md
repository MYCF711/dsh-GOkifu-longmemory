# kifu-loader（开发专用，普通用户不用看）

> **这是给本机开发用的软链加载器**：让 `dsh-gokifu-longmemory` 直接读开发工作区里的源码，改代码不用重装。
>
> **普通用户不需要它**——直接打开 `dsh-gokifu-longmemory` 本体就行（那是自包含插件，核心 = `src/plugin.mjs`）。
>
> `package.json` 的 `files` 不含 `packages/`，本目录**不会被打包分发**。
>
> **本体与 kifu-loader 只开一个**（双开 = 双注入）。

它做的事只有一件：`loadCore()` 按 `KIFU_CORE_PATH`（或默认的 `../../src/plugin.mjs`）加载插件核心，把 `apply(ctx, config)` 原样返回给宿主。
