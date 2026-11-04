# 闸 3 `gate3/stale-not-marked` 生产拦截追因（M4，2026-11-05）

> `[本] 2026-11-05 01:20 +08:00`（快照时间 `2026-11-04T17:20:16Z`）· 只读分析
> 数据：`<DSH_HOME>/memory-context`（claims 1312 条）· 心跳 `live-stats.jsonl` · 会话日志逐帧解
> 未改源码 / 未改记忆库 / 未重启 DSH / 未跑全量测试；本文件是本次唯一写入。
> 复现脚本放在 `tmp/`（不进 git）。

## 1 · 现象

心跳里 3 次 `gates-failed`，唯一错误码 `gate3/stale-not-marked`，全部 pid 4532：

| 时间（+08:00） | scope | digest | tokens | 备注 |
|---|---|---|---|---|
| 2026-11-05 00:19:21 | `<repo>/反代/work buddy` | `c6cd915b37e3cbd1` | 139 | 第一次 |
| 2026-11-05 00:40:58 | `<repo>/default-workspace/DSH-GO` | `0cce41e612f27362` | 169 | 第二次 |
| 2026-11-05 00:47:56 | 同 scope、同 digest、同 tokens | `0cce41e612f27362` | 169 | **同一张卡重试** |

所以是 **2 张不同的卡**（DSH-GO 那张被重试了一次）。

## 2 · 闸 3 的判据（文件 + 符号，不写行号）

**入口与判法**：`src/rooms/gates.mjs` 的 `runGates` 里闸 3 分支。

1. 只看**卡片里渲染出来的行**（`card.claims`）：按 `claimId` 取回 claim / joseki 记录；没有记录的行直接跳过。
2. 只对 `record.validity.type !== 'none'` 的记录做有效期检查；没有核验结果就记 `unverified`（不假装合规，`gate3/validity-unchecked`）。
3. **核验失败（`check.ok === false`）且该行的 state 不是 `stale` ⇒ `gate3/stale-not-marked`**（这就是生产里挡注入的那条）；
   state 是 `stale` 但不是指针行 ⇒ `gate3/stale-rendered`。
4. `record.preconditions` 非空时同理，失败码是 `gate3/precondition-failed`（本轮 3 次都不是它）。

**核验本身**：`src/rooms/gates.mjs` 的 `probeValidity`（`runValidityCheck` 批量版；`REAL_PROBE` 是真 IO 探针）。

| validity.type | 判法（`probeValidity`） | 失败标记 |
|---|---|---|
| `none` | 直接 ok | — |
| `file` | `resolveValidityPath` 解析路径（认 `/d/…`、`d:/…`、相对路径按 workspace）→ `stat`；**文件不存在或不是普通文件 ⇒ 失败**；另可要求 `mtimeMs`（±2ms）与 `sha256` 一致 | `file-missing` / `file-mtime-changed` / `file-hash-changed` |
| `version` | `parsePackageAtVersion` 解析 `name@x.y.z`（解析不出就把整串当期望版本）→ 候选文件：`validity.file` > `<claim 自己的 workspace>/node_modules/<name>/package.json` > `<workspace>/package.json` → 读到的版本不等于期望 ⇒ 失败；**一个候选都读不到 ⇒ `version-file-unreadable`（算失败）** | `version-mismatch` / `version-file-unreadable` / `version-package-not-found` |
| `commit` | `git cat-file -e <sha>^{commit}`（在记录自己的 workspace 里） | `commit-not-found` |

**工作区归属**：`workspaceOf(record)` —— 每条按**它自己的** `scopeKey = w:<path>` 解析，不用注入时的 cwd。

**注入侧调用**：`src/plugin.mjs` 的 `probeCardValidity`（只核这张卡里出现的条目，按 `validityKeyOf` 做键、带 TTL 缓存），
结果传给 `runGates({ card, walkResult, store, scope, validityResults })`。

## 3 · 真库命中清单（哪些 claim 会被闸 3 判中）

`[本] 2026-11-05 01:20` 快照：claims **1312** 条，带 `validity != none` 的 **138** 条，其中 **129 条现在核验失败**（会被闸 3 判中）。

| 类型 / 原因 | 条数 | 含义 |
|---|---|---|
| `version / version-file-unreadable` | **62** | 在 claim 自己的 workspace 里找不到能读的 package.json |
| `file / file-missing` | **61** | validity 指向的文件**现在不存在** |
| `version / version-package-not-found` | 5 | 候选 package.json 都读到了，但没有同名包 |
| `version / version-mismatch` | 1 | 读到了，版本确实变了 |

按 claim 自身 scope 分布：`default-workspace` 系（含 DSH-GO / GOkifu上下文压缩 子域）**72**、`反代` 系 **57**。
（注：`default-workspace` 的 30 条属于父工程 scope，对 DSH-GO 这类子域是**祖先可见**的。）

### 3.1 `file` 族（61 条，reason 全部 `file-missing`）

| claimId | validity | scope | occurredAt | 前 60 字 | 命中理由 |
|---|---|---|---|---|---|
| `c-00d76725` | `file:c:/tmp/rewrite/replace.txt` | deepseek-harness/default-workspace | 2026-11-02 | Error: ENOENT: no such file or directory, open 'C:\tmp\rewri | `file-missing` |
| `c-00eb81f4` | `file:/_lead/community-workbuddy-index.mjs` | 反代/work buddy | 2026-11-03 | cp: cannot stat 'references/_lead/community-workbuddy-index. | `file-missing` |
| `c-05436e7b` | `file:/c<user-home>` | deepseek-harness/default-workspace | 2026-11-04 | ls: cannot access '/c<user-home>': No such file or directory | `file-missing` |
| `c-1201ac84` | `file:/大小` | DeepSeek Harness/反代 | 2026-11-03 | === MAINTENANCE.md 行数/大小 === wc: MAINTENANCE.md: No such fil | `file-missing` |
| `c-12f92ec0` | `file:c:/e/Documents/deepseek-harness/default-workspace/tmp/dsc-re` | deepseek-harness/default-workspace | 2026-11-02 | Error: ENOENT: no such file or directory, open 'C:\e\Documen | `file-missing` |
| `c-13d0c05b` | `file:/c<user-home>` | 反代/magpie-amgicrew-auth | 2026-11-03 | cp: cannot stat '/c<user-home>': No such file or directory l | `file-missing` |
| `c-14ae511a` | `file:c:/tmp/wb-official.png` | 反代/work buddy | 2026-11-03 | Error: ENOENT: no such file or directory, open 'C:\tmp\wb-of | `file-missing` |
| `c-1a6ca82a` | `file:c:/tmp/agent-mine.mjs` | deepseek-harness/default-workspace | 2026-11-02 | Error: ENOENT: no such file or directory, open 'C:\tmp\agent | `file-missing` |
| `c-20b638e4` | `file:d:/tmp/aipy-sniff.log` | DeepSeek Harness/反代 | 2026-11-03 | Error: ENOENT: no such file or directory, open 'D:\tmp\aipy- | `file-missing` |
| `c-2691e608` | `file:d:/��������/tmp/qq-bot-research/ui_now.xml` | DeepSeek Harness/default-workspace | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: 'D:/ | `file-missing` |
| `c-2bc369e5` | `file:/tmp/probe-sub.mjs` | deepseek-harness/default-workspace | 2026-11-03 | cp: cannot stat '/tmp/probe-sub.mjs': No such file or direct | `file-missing` |
| `c-2caa6d03` | `file:/tmp/pr-resp.json` | 反代/work buddy | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-30b89a1d` | `file:c:/tmp/plist.json` | DeepSeek Harness/反代 | 2026-11-02 | Error: ENOENT: no such file or directory, open 'C:\tmp\plist | `file-missing` |
| `c-32870086` | `file:/d/` | deepseek-harness/default-workspace | 2026-11-01 | DSH_HOME=<repo>\home ls: cannot access '/d/'$'\346\267\261\3 | `file-missing` |
| `c-37938a7f` | `file:/tmp/models.json` | DeepSeek Harness/反代 | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-383b2271` | `file:/tmp/probe_dupe.py` | DSH-GO | 2026-11-02 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-386a8833` | `file:/msg-open.txt` | DSH-GO | 2026-11-04 | fatal: could not read log file 'tmp/msg-open.txt': No such f | `file-missing` |
| `c-4514e2b7` | `file:e:/loomy/Loomy.exe` | DeepSeek Harness/default-workspace | 2026-11-04 | ls: cannot access 'E:/loomy/Loomy.exe': No such file or dire | `file-missing` |
| `c-4f0231b1` | `file:<repo>/反代/work buddy/magpie-workbuddy/references/_lead/icons` | 反代/work buddy | 2026-11-03 | Error: ENOENT: no such file or directory, open '<repo>\反代\wo | `file-missing` |
| `c-59cd7609` | `file:d:/d/DeepSeek Harness/home/profiles/desktop/node_modules/dsh` | deepseek-harness/default-workspace | 2026-11-03 | Error: ENOENT: no such file or directory, open 'D:\d\DeepSee | `file-missing` |
| `c-5d48ff82` | `file:/tmp/entry-0175.md` | deepseek-harness/default-workspace | 2026-11-04 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-5e6c4583` | `file:/d/DeepSeek Harness/345/217/215/344/273/243/magpie-magicrew-` | 反代/magpie-amgicrew-auth | 2026-11-03 | /usr/bin/bash: line 1: cd: $'/d/DeepSeek Harness/\345\217\21 | `file-missing` |
| `c-65bbe6ed` | `file:d:/tmp/magpie-plugins-after-waf.json` | 反代/magpie-amgicrew-auth | 2026-11-03 | Error: ENOENT: no such file or directory, open 'D:\tmp\magpi | `file-missing` |
| `c-66ddf00e` | `file:/cmd5.png` | DSH-GO | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: 'tmp | `file-missing` |
| `c-6ff84dcb` | `file:/cover-1.png` | DeepSeek Harness/反代 | 2026-11-02 | FileNotFoundError: [Errno 2] No such file or directory: 'ass | `file-missing` |
| `c-72298d0b` | `file:/tmp/ps.json` | DeepSeek Harness/default-workspace | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-76a0ea07` | `file:/tmp/dshd-tools-compact.json` | DSH-GO | 2026-11-04 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-7d85da7e` | `file:c:/tmp/cw.js` | DeepSeek Harness/反代 | 2026-11-02 | Error: ENOENT: no such file or directory, open 'C:\tmp\cw.js | `file-missing` |
| `c-7ece9589` | `file:d:/tmp/baizhi.svg` | 反代/monkey code | 2026-11-03 | Error: ENOENT: no such file or directory, open 'D:\tmp\baizh | `file-missing` |
| `c-81f0893e` | `file:/tmp/lingxi-score.json` | 反代/wps | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-82e1bf1f` | `file:/tmp/wb-head.bin` | 反代/work buddy | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-91f27c6d` | `file:<repo>/resources/app.asar` | DeepSeek Harness/default-workspace | 2026-11-03 | Error: ENOENT: no such file or directory, open '<repo>\resou | `file-missing` |
| `c-953203e2` | `file:/tmp/who.json` | DeepSeek Harness/default-workspace | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-9cf49c3b` | `file:/live-verify.mjs` | DeepSeek Harness/反代 | 2026-11-02 | ls: cannot access 'scripts/live-verify.mjs': No such file or | `file-missing` |
| `c-a2bdd6c1` | `file:d:/tmp/pack.json` | deepseek-harness/default-workspace | 2026-11-01 | Error: ENOENT: no such file or directory, open 'D:\tmp\pack. | `file-missing` |
| `c-a42b20ac` | `file:/c<user-home>` | DeepSeek Harness/反代 | 2026-11-03 | ls: cannot access '/c<user-home>': No such file or directory | `file-missing` |
| `c-a4ce19d6` | `file:c:/d/DeepSeek Harness/反代/probe/cap-crop.png` | DeepSeek Harness/反代 | 2026-11-02 | Error: ENOENT: no such file or directory, open 'C:\d\DeepSee | `file-missing` |
| `c-a7868cf8` | `file:d:/tmp/m3.json` | 反代/AIysis code | 2026-11-02 | Error: ENOENT: no such file or directory, open 'D:\tmp\m3.js | `file-missing` |
| `c-ac8cd9cc` | `file:/tmp/dsh-022-meta.json` | DSH-GO | 2026-11-04 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-ace52463` | `file:/../../docs/reasoning-ui.md` | DSH-GO | 2026-11-04 | grep: ../../../docs/reasoning-ui.md: No such file or directo | `file-missing` |
| `c-ae78f4d6` | `file:d:/tmp/old-static.mjs` | DeepSeek Harness/反代 | 2026-11-02 | Error: ENOENT: no such file or directory, open 'D:\tmp\old-s | `file-missing` |
| `c-b3ead453` | `file:<user-home>` | 反代/wps | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: 'C:\ | `file-missing` |
| `c-b6ebadd4` | `file:/d/主工作区/projects/dsh-github-bridge/package.json` | deepseek-harness/default-workspace | 2026-11-01 | sed: can't read /d/主工作区/projects/dsh-github-bridge/package.j | `file-missing` |
| `c-b8f71ddf` | `file:c:/tmp/modelpricing.html` | DeepSeek Harness/反代 | 2026-11-02 | Error: ENOENT: no such file or directory, open 'C:\tmp\model | `file-missing` |
| `c-bded74c5` | `file:/tmp/wps_usage.jsonl` | 反代/wps | 2026-11-04 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-be725e81` | `file:c:/tmp/plugin-auth.backup-011847.json` | DeepSeek Harness/反代 | 2026-11-02 | Error: ENOENT: no such file or directory, open 'C:\tmp\plugi | `file-missing` |
| `c-c16ea1e0` | `file:d:/tmp/fileref.txt` | deepseek-harness/default-workspace | 2026-11-01 | Error: ENOENT: no such file or directory, open 'D:\tmp\filer | `file-missing` |
| `c-c238fc3b` | `file:/tmp/dom.html` | DeepSeek Harness/反代 | 2026-11-03 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-c2d6aa4a` | `file:/tmp/or.json` | DeepSeek Harness/反代 | 2026-11-02 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-c43a84e8` | `file:/tool/bash/*.go` | DSH-GO | 2026-11-02 | grep: modules/tool/bash/*.go: No such file or directory ls:  | `file-missing` |
| `c-c6f3ec3e` | `file:/tmp/assets-shared-vet.log` | DSH-GO | 2026-11-04 | ls: cannot access '/tmp/assets-shared-vet.log': No such file | `file-missing` |
| `c-cb186bfd` | `file:/tmp/icn/shot2.png` | DeepSeek Harness/反代 | 2026-11-04 | FileNotFoundError: [Errno 2] No such file or directory: '/tm | `file-missing` |
| `c-dd256b35` | `file:<repo>/反代/monkey code/work buddy/references/community-plugin` | 反代/monkey code | 2026-11-03 | Error: ENOENT: no such file or directory, open '<repo>\反代\mo | `file-missing` |
| `c-de00a9c9` | `file:/tmp/asarout/apps/desktop/dist-electron/` | DeepSeek Harness/反代 | 2026-11-02 | exit=0 ls: cannot access '/tmp/asarout/apps/desktop/dist-ele | `file-missing` |
| `c-dfc44a96` | `file:/c<user-home>` | DeepSeek Harness/反代 | 2026-11-02 | FileNotFoundError: [Errno 2] No such file or directory: '/c< | `file-missing` |
| `c-ed271fa4` | `file:c:/tmp/q.json` | 反代/magpie-amgicrew-auth | 2026-11-04 | Error: ENOENT: no such file or directory, open 'C:\tmp\q.jso | `file-missing` |
| `c-efb2e77b` | `file:/dscommands/commands_test.go` | DSH-GO | 2026-11-04 | sed: can't read plugins/dscommands/commands_test.go: No such | `file-missing` |
| `c-f1095834` | `file:e:/Documents/deepseek-harness/default-workspace/prompt-opt/v` | deepseek-harness/default-workspace | 2026-11-01 | Error: ENOENT: no such file or directory, open 'E:\Documents | `file-missing` |
| `c-f24b6bf1` | `file:<user-home>` | DeepSeek Harness/反代 | 2026-11-02 | Error: ENOENT: no such file or directory, open '<user-home> | `file-missing` |
| `c-fb821807` | `file:/pluginapi/plugin.go` | DSH-GO | 2026-11-03 | grep: internal/pluginapi/plugin.go: No such file or director | `file-missing` |
| `c-ff7c3a3d` | `file:<desk>/repos/主工作区 eposdsh-GOkifu-compact` | deepseek-harness/default-workspace | 2026-11-01 | Error: ENOENT: no such file or directory, symlink '<desk>\re | `file-missing` |

### 3.2 `version` 族（68 条）

| claimId | validity | scope | occurredAt | 前 60 字 | 命中理由 |
|---|---|---|---|---|---|
| `c-0080133b` | `version:0.2.1-go.23` | DSH-GO | 2026-11-02 | version = "0.2.1-go.23 | `version-file-unreadable` |
| `c-0337722c` | `version:0.2.1-go.15` | DSH-GO | 2026-11-02 | version = "0.2.1-go.15 | `version-file-unreadable` |
| `c-0a7e7ac0` | `version:dsh-gokifu-compact@1.16.0` | deepseek-harness/default-workspace | 2026-11-01 | dsh-gokifu-compact@1.16.0 | `version-file-unreadable` |
| `c-0b066ed3` | `version:0.2.1-go.25` | DSH-GO | 2026-11-02 | version = "0.2.1-go.25 | `version-file-unreadable` |
| `c-0d73c9dc` | `version:0.1.2878-speedfix` | 反代/wps | 2026-11-03 | version=0.1.2878-speedfix | `version-file-unreadable` |
| `c-175d29e9` | `version:magpie-chatbox-ai@0.1.0` | DeepSeek Harness/反代 | 2026-11-02 | magpie-chatbox-ai@0.1.0 | `version-file-unreadable` |
| `c-1d1b4c67` | `version:dsh@0.2.1-rc.5` | deepseek-harness/default-workspace | 2026-11-04 | dsh@0.2.1-rc.5 | `version-file-unreadable` |
| `c-20612b56` | `version:magpie-plugin-scaffold@0.3.8` | DeepSeek Harness/反代 | 2026-11-03 | magpie-plugin-scaffold@0.3.8 | `version-file-unreadable` |
| `c-2c1df567` | `version:0.2.1-go.5` | DSH-GO | 2026-11-02 | version = "0.2.1-go.5 | `version-file-unreadable` |
| `c-2cbbd37d` | `version:cordis@4.0.5` | deepseek-harness/default-workspace | 2026-11-04 | cordis@4.0.5 | `version-file-unreadable` |
| `c-38c819c7` | `version:0.2.1-go.14` | DSH-GO | 2026-11-02 | version = "0.2.1-go.14 | `version-file-unreadable` |
| `c-3d4243e0` | `version:dsh-session-superagent@0.8.11` | deepseek-harness/default-workspace | 2026-11-01 | dsh-session-superagent@0.8.11 | `version-file-unreadable` |
| `c-4225b416` | `version:dsh-session-superagent@0.8.12` | deepseek-harness/default-workspace | 2026-11-01 | dsh-session-superagent@0.8.12 | `version-file-unreadable` |
| `c-585bba9e` | `version:0.2.1-go.20` | DSH-GO | 2026-11-02 | version = "0.2.1-go.20 | `version-file-unreadable` |
| `c-58777ca2` | `version:0.2.1-go.12` | DSH-GO | 2026-11-02 | version = "0.2.1-go.12 | `version-file-unreadable` |
| `c-6055dd27` | `version:0.4.24` | deepseek-harness/default-workspace | 2026-11-02 | version="0.4.24 | `version-file-unreadable` |
| `c-64ff8750` | `version:0.2.1-go.24` | DSH-GO | 2026-11-02 | version = "0.2.1-go.24 | `version-file-unreadable` |
| `c-6a8e48ab` | `version:dsh-ptc-domain-presets@0.1.0` | DeepSeek Harness/default-workspace | 2026-11-03 | dsh-ptc-domain-presets@0.1.0 | `version-file-unreadable` |
| `c-6ed52f5e` | `version:0.2.1-go.7` | DSH-GO | 2026-11-02 | version = "0.2.1-go.7 | `version-file-unreadable` |
| `c-7525f8ca` | `version:0.47.3` | deepseek-harness/default-workspace | 2026-11-01 | version='0.47.3 | `version-file-unreadable` |
| `c-78eb4c23` | `version:dsh@0.2.2-rc.1` | deepseek-harness/default-workspace | 2026-11-04 | dsh@0.2.2-rc.1 | `version-file-unreadable` |
| `c-8263d203` | `version:magpie-workbuddy@0.0.0-stage` | 反代/work buddy | 2026-11-03 | magpie-workbuddy@0.0.0-stage | `version-file-unreadable` |
| `c-82b213ce` | `version:0.2.1-go.18` | DSH-GO | 2026-11-02 | version = "0.2.1-go.18 | `version-file-unreadable` |
| `c-836c09c9` | `version:0.2.16` | 反代/monkey code | 2026-11-03 | version="0.2.16 | `version-file-unreadable` |
| `c-84e98a55` | `version:magpie-alysis-code@0.1.15` | DeepSeek Harness/反代 | 2026-11-04 | magpie-alysis-code@0.1.15 | `version-file-unreadable` |
| `c-87b3c5e8` | `version:magpie-opc-auth@0.1.3` | DeepSeek Harness/反代 | 2026-11-03 | magpie-opc-auth@0.1.3 | `version-file-unreadable` |
| `c-886b91dc` | `version:0.2.1-go.19` | DSH-GO | 2026-11-02 | version = "0.2.1-go.19 | `version-file-unreadable` |
| `c-8b80ae8d` | `version:cordis@4.1.0` | deepseek-harness/default-workspace | 2026-11-04 | cordis@4.1.0 | `version-file-unreadable` |
| `c-92b82516` | `version:0.2.1-go.26` | DSH-GO | 2026-11-02 | version = "0.2.1-go.26 | `version-file-unreadable` |
| `c-9477ee0f` | `version:0.2.1-go.10` | DSH-GO | 2026-11-02 | version = "0.2.1-go.10 | `version-file-unreadable` |
| `c-96e12366` | `version:dsh-gokifu-compact@1.17.1` | deepseek-harness/default-workspace | 2026-11-02 | dsh-gokifu-compact@1.17.1 | `version-file-unreadable` |
| `c-96faae76` | `version:martty@0.3.3` | DSH-GO | 2026-11-02 | martty@0.3.3 | `version-file-unreadable` |
| `c-97fc2150` | `version:magpie-chatbox-ai@0.1.2` | DeepSeek Harness/反代 | 2026-11-02 | magpie-chatbox-ai@0.1.2 | `version-file-unreadable` |
| `c-9c5b7c51` | `version:magpie-workbuddy@0.1.2` | 反代/work buddy | 2026-11-03 | magpie-workbuddy@0.1.2 | `version-file-unreadable` |
| `c-a67cccc6` | `version:dsh-goal@0.2.2-rc.1` | deepseek-harness/default-workspace | 2026-11-04 | dsh-goal@0.2.2-rc.1 | `version-file-unreadable` |
| `c-a69877f3` | `version:0.2.1-go.8` | DSH-GO | 2026-11-02 | version = "0.2.1-go.8 | `version-file-unreadable` |
| `c-a74a2e16` | `version:dsh-session-superagent@0.9.167` | deepseek-harness/default-workspace | 2026-11-04 | dsh-session-superagent@0.9.167 | `version-file-unreadable` |
| `c-aab3aeb4` | `version:0.2.1-go.6` | DSH-GO | 2026-11-02 | version = "0.2.1-go.6 | `version-file-unreadable` |
| `c-b0a13199` | `version:claude-code@2.1.318` | DeepSeek Harness/default-workspace | 2026-11-04 | claude-code@2.1.318 | `version-file-unreadable` |
| `c-b105f35b` | `version:9.9.9` | DeepSeek Harness/default-workspace | 2026-11-04 | version='9.9.9 | `version-file-unreadable` |
| `c-b3210317` | `version:magpie-opc-auth@0.1.4` | DeepSeek Harness/反代 | 2026-11-03 | magpie-opc-auth@0.1.4 | `version-file-unreadable` |
| `c-b5ae27cc` | `version:magpie-workbuddy@0.1.0` | 反代/work buddy | 2026-11-03 | magpie-workbuddy@0.1.0 | `version-file-unreadable` |
| `c-b9fb21fd` | `version:0.2.1-go.13` | DSH-GO | 2026-11-02 | version = "0.2.1-go.13 | `version-file-unreadable` |
| `c-bb8fe6f9` | `version:dsh-session-superagent@0.8.14` | deepseek-harness/default-workspace | 2026-11-01 | dsh-session-superagent@0.8.14 | `version-file-unreadable` |
| `c-bb990458` | `version:dsh-gokifu-compact@1.17.2` | deepseek-harness/default-workspace | 2026-11-02 | dsh-gokifu-compact@1.17.2 | `version-file-unreadable` |
| `c-c31163d5` | `version:unnamed-plugin@0.3.8` | DeepSeek Harness/反代 | 2026-11-03 | unnamed-plugin@0.3.8 | `version-file-unreadable` |
| `c-c937d963` | `version:0.2.1-go.21` | DSH-GO | 2026-11-02 | version = "0.2.1-go.21 | `version-file-unreadable` |
| `c-cc5b8f0a` | `version:dsh-gokifu-compact@1.17.3` | deepseek-harness/default-workspace | 2026-11-02 | dsh-gokifu-compact@1.17.3 | `version-file-unreadable` |
| `c-cc96603d` | `version:0.2.1-go.11` | DSH-GO | 2026-11-02 | version = "0.2.1-go.11 | `version-file-unreadable` |
| `c-cf35d2e8` | `version:1.17.6` | GOkifu上下文压缩 | 2026-11-02 | version="1.17.6 | `version-file-unreadable` |
| `c-d10aef8e` | `version:0.2.1-go.9` | DSH-GO | 2026-11-02 | version = "0.2.1-go.9 | `version-file-unreadable` |
| `c-d2dba976` | `version:0.1.1` | DeepSeek Harness/反代 | 2026-11-03 | version='0.1.1 | `version-file-unreadable` |
| `c-d6e8c06a` | `version:0.2.1-go.22` | DSH-GO | 2026-11-02 | version = "0.2.1-go.22 | `version-file-unreadable` |
| `c-def3f0fa` | `version:0.2.0` | 反代/monkey code | 2026-11-03 | version="0.2.0 | `version-file-unreadable` |
| `c-df13d467` | `version:magpie-alysis-auth@0.1.12` | DeepSeek Harness/反代 | 2026-11-04 | magpie-alysis-auth@0.1.12 | `version-file-unreadable` |
| `c-e3e72236` | `version:magpie-opc-auth@0.1.2` | DeepSeek Harness/反代 | 2026-11-03 | magpie-opc-auth@0.1.2 | `version-file-unreadable` |
| `c-e950611f` | `version:0.2.1-go.16` | DSH-GO | 2026-11-02 | version = "0.2.1-go.16 | `version-file-unreadable` |
| `c-ece24ff2` | `version:magpie-plugin-scaffold@0.3.9` | 反代/work buddy | 2026-11-03 | magpie-plugin-scaffold@0.3.9 | `version-file-unreadable` |
| `c-f07d87a9` | `version:dsh-goal@0.2.1-rc.5` | deepseek-harness/default-workspace | 2026-11-04 | dsh-goal@0.2.1-rc.5 | `version-file-unreadable` |
| `c-f12478ae` | `version:0.1.2` | DeepSeek Harness/反代 | 2026-11-03 | version='0.1.2 | `version-file-unreadable` |
| `c-f3511dab` | `version:1.16.0` | deepseek-harness/default-workspace | 2026-11-01 | version='1.16.0 | `version-file-unreadable` |
| `c-f6dad8cb` | `version:0.2.1-go.17` | DSH-GO | 2026-11-02 | version = "0.2.1-go.17 | `version-file-unreadable` |
| `c-072e17c0` | `version:0.3.73` | 反代/magpie-amgicrew-auth | 2026-11-03 | version='0.3.73 | `version-mismatch` |
| `c-30aa4723` | `version:magicrew-auth@0.3.71` | 反代/magpie-amgicrew-auth | 2026-11-03 | magicrew-auth@0.3.71 | `version-package-not-found` |
| `c-7868399c` | `version:magpie-alysis-auth@0.1.0` | 反代/AIysis code | 2026-11-02 | magpie-alysis-auth@0.1.0 | `version-package-not-found` |
| `c-94feb53a` | `version:magpie-alysis-auth@0.1.3` | 反代/AIysis code | 2026-11-02 | magpie-alysis-auth@0.1.3 | `version-package-not-found` |
| `c-cd0f85ac` | `version:magpie-alysis-auth@0.1.2` | 反代/AIysis code | 2026-11-02 | magpie-alysis-auth@0.1.2 | `version-package-not-found` |
| `c-cdde4998` | `version:opencode-cline-auth@0.1.11` | 反代/AIysis code | 2026-11-02 | opencode-cline-auth@0.1.11 | `version-package-not-found` |

## 4 · 结论：主因是 **(b) 探针误判**，另有 8 条真「该标未标」

### 4.1 `file` 族：**61/61 是误判**（语义被写反了）

- 独立复核：这 61 条 validity 指向的路径，**现在 0 条真的存在**（逐个 `stat` 验证）。
- 而 `src/rooms/claim.mjs` 的抽取契约写的是：
  > 「失败边里带 ENOENT / "No such file or directory" 且能取出路径 ⇒ `validity{type:"file", value:path}`
  > （**「证据时刻该文件不存在」**；读侧 `stat` 到文件出现即判 stale）」
- `probeValidity` 的 `file` 分支做的是**相反**的检查：文件不存在 ⇒ `ok:false`。
- 结果：凡是"某个文件当时不存在"的教训（ENOENT 反模式），渲染时**必然**被判 stale。61/61 全部属于这一类（reason 全为 `file-missing`、正文全是 ENOENT / FileNotFoundError / `cp: cannot stat` / `cannot access`）。

> 设计文档自身也不一致：`方案.md` §5.3 的表格把 `file` 写成「路径存在 + 内容 hash」（正向），
> 而 `src/rooms/claim.mjs` 的抽取契约对 ENOENT 用的是反向语义。**同一个 `type` 承载两种语义，探针只实现了正向那种。**

### 4.2 `version` 族：62 条「读不到」被当成「已失效」

- 探针只在 **claim 自己的 workspace** 里找 `node_modules/<name>/package.json` 或 `<workspace>/package.json`。
- 实际语料里这些包多装在 **profile 的 `node_modules`**（宿主侧），例如 `dsh-gokifu-compact`、`dsh-session-superagent`。
  把查找面放宽到 `<user-home>/profiles/*/node_modules` 后：
  - **8 条**确实变了（`dsh-gokifu-compact` 1.16.0/1.17.1/1.17.2/1.17.3 → 实际 1.17.6；`dsh-session-superagent` 0.8.11/0.8.12/0.8.14/0.9.167 → 实际 0.9.179）→ **这一部分是 (a)「该标未标」**；
  - **1 条**放宽后与声明一致（属巧合类，探针命中了别的候选文件）；
  - **59 条**即使放宽也找不到包 ⇒ 只能算「核不了」，现在却被当成「已失效」。
- 另有 `version-package-not-found` 5 条：包根本不在本地（外部依赖/别的机器），**无法核验 ≠ 失效**。
- `version-mismatch` 1 条：`c-072e17c0`（`magpie-amgicrew-auth` 声明 0.3.73、实际 1.0.0）—— **真 stale**。
- 注：上面 8 条"确实变了"的 claim 属于 **E: 盘那个旧工作区**（`w:e:/Documents/…`），对它自己的 scope 而言是真 stale；
  它们与 DSH-GO（`w:d:/…/DSH-GO`）不同盘、不同工作区，**互不可见**，不会进这两张卡。

### 4.3 一句话

**闸 3 的语义没错（"声明已失效却没标"确实该拦），错在有效期探针把两件事当成了失效：**
① 「文件不存在」（对 ENOENT 型教训，这正是它成立的条件）；
② 「读不到版本文件」（未知，不是失效）。
真正"该标未标"的只有 **8 + 1 = 9 条**（版本确实变了），其余 **120 条是探针误判**。

## 5 · 那 3 次心跳能还原到什么程度（如实）

- `live-stats.jsonl` 的行**只有 digest / tokens / gateCodes**，不记 claimId；
- 被闸挡下的卡**不写** `card-samples.jsonl`（只有注入成功的才留样），所以两张失败卡的原件拿不到；
- 尝试用当前库按 digest 回放：读了这两个 scope 下 6 个会话的首条用户消息、以及 concern 会话里 16 条用户消息去重算卡片，**没有一次命中** `c6cd915b…` / `0cce41e6…`（库在 00:40 之后继续增长，同样的信号已生成不同卡片）。**所以这 3 次的具体 claimId 还原不出来，不编。**

能给出的边界：
1. 这两个 scope 里**可渲染的失败 claim** 共 **42 条**，全部落在上面两族：
   - `DSH-GO`：33 条（23 `version-file-unreadable` + 10 `file-missing`）；
   - `反代/work buddy`：9 条（4 `version-file-unreadable` + 5 `file-missing`）。
2. 那 9 条真 stale **都不在这两个 scope 的可见域里**：
   - 8 条（`dsh-gokifu-compact` / `dsh-session-superagent` 的旧版本）属于 `w:e:/Documents/deepseek-harness/default-workspace`
     —— 是**另一个工作区**（E: 盘旧路径），不是 DSH-GO 的祖先 `w:d:/…/default-workspace`；
   - 1 条 `c-072e17c0` 属于 `w:d:/…/反代/magpie-amgicrew-auth`，与 work buddy 是兄弟关系（互不可见）。
   即：可见域内（DSH-GO 41 条、work buddy 38 条，含祖先）的失败 claim **全部落在 F1/F2 两族**。

## 6 · 最小修法（只描述，不改代码）

| # | 改动点 | 改法 | 能救回 |
|---|---|---|---|
| **F1（P0）** | `src/rooms/gates.mjs` · `probeValidity` 的 `file` 分支 | 给 `validity` 增加方向位（例如 `expect: 'absent' | 'present'`，缺省 `present` 保持向后兼容）；`expect==='absent'` 时：文件不存在 ⇒ ok，存在 ⇒ `file-appeared`（这才是 `claim.mjs` 写的"文件出现即 stale"）。抽取侧对 ENOENT 派生条目写 `expect:'absent'` | **61 条**（file 族全部） |
| **F2（P0）** | 同上 · `version` 分支 | 「一个候选都读不到」改为**未核验**（返回 `{ok:null}` 或干脆不给 result ⇒ 闸 3 记 `unverified`），不要返回 `ok:false`；同时把候选面从 claim workspace 扩到 `<user-home>/profiles/*/node_modules` | **59 条**（读不到的）；扩面后另 8 条会变成真 `version-mismatch`（原因正确） |
| **F3（P1）** | 归档/晋升侧（数据层） | 对真·版本已变的 8+N 条：按"只增不改"打 `stale`（`validTo` + 指针），让闸 3 走 `stale-rendered`→ 只给指针；**这一步是 (a) 的正解，不该靠修探针掩盖** | 不影响 3 次，但决定长期噪声 |
| **F4（P2）** | `src/plugin.mjs` · `probeCardValidity` | 把每张卡的核验结果摘要（`checked/ok/failed/unverified + 失败 claimId`）写进心跳行，补上"只有 digest 没有 claimId"的盲区 | 让下次可直接定位，无需回放 |

**能救回几次**：按上面的族分布，**F1+F2 落地后，这 3 次（2 张卡）应全部可注入**（3/3）。
严格说这是**条件结论**：只有当那两张卡渲染的是 file 族或 version-读不到族时才成立（该两 scope 可渲染的 42 条全在这两族）；
若恰好渲染的是那 9 条真 stale 之一，则应走 F3（标 stale + 降级指针），而不是放行。

## 7 · 复现

```bash
# 1) 心跳里那 3 次
node -e 'const fs=require("fs");const rows=fs.readFileSync("<DSH_HOME>/memory-context/live-stats.jsonl","utf8").split("
").filter(Boolean).map(JSON.parse);
for(const r of rows) if(Array.isArray(r.gateCodes)&&r.gateCodes.includes("gate3/stale-not-marked")) console.log(new Date(r.at).toISOString(),r.scope,r.digest,r.tokens);'

# 2) 现在会被闸 3 判中的 claim（本文件第 3 节的清单）
node -e '...'   # 见 tmp/g3-*.mjs 里的 probeValidity(record,{workspace:workspaceOf(record)}) 逐个核

# 3) 校验：file 族指向的文件现在是否真的存在
node -e '...'   # 逐条 statSync(resolveValidityPath(validity.value, workspaceOf(claim)))

# 4) 放宽 version 查找面到 profiles/*/node_modules 后重比
node -e '...'
```

（上述 2–4 的完整脚本见 `tmp/g3-rows.json` 的生成命令；`tmp/` 不进 git。）
