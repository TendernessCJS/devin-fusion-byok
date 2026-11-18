# Devin 原生兼容复验记录（滚动）

本文件记录每次 Devin Desktop 升级后的复验结果。**它是观测记录，不是兼容性承诺**：`status: ok` 与测试全绿只说明本轮核对过的面仍然成立，不覆盖真实会话的端到端行为。

3.12.28 那轮的有界 REA 与关键链路专项审查结论已并入下表那一行；当时的证据目录在 `/tmp`，已不可复现。

## 复验方法

一条命令覆盖「静态契约 → 运行期契约缓存 → 已安装扩展身份 → 活 backend 身份/代理就绪 → 运行日志聚合」：

```bash
npm run verify                    # 默认 24h 日志窗口
npm run verify -- --with-tests    # 追加窄测（含从当前 bundle 抽取 ACP 终态判据）
```

退出码：`FAIL` → 1；仅 `WARN` → 0；`ok` → 0；用法错误 → 2。`--json` 给出同结构的机器可读结果。

判定口径不随版本调整：`state-envelope-replay-failed`、`tool-name-unknown`、`forward-timeout` 固定为 INFO——回放未命中是回退而非错误，后两者不阻断请求，把稳态升级成 WARN 只会制造假故障（`test/verify-install.test.cjs` 守着这条映射）。

**它不覆盖**：非 macOS 平台、Sidekick 走 BYOK 的组合、`assignment_jwt` 的运行时校验、真实付费端到端会话；REA 语义图仍为 partial。

## 版本记录

| Devin | 观测时间 | 静态契约 | 运行期契约缓存 | 窄测 | 全量 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 3.12.28 | 2026-11-09 上午 | `ok`，`missing {}` | `ok` | 31/31（当轮修复后） | 1748 全绿 | 未发现必修实现缺陷；唯一问题是 ACP 测试入口指向已删模块，当轮已修 |
| 3.12.32 | 2026-11-09 10:03 | `ok`，`missing {}` | `ok`，`appVersion 3.12.32` | 128 / 0 / 0 | 1755 全绿 | 兼容；同日新增 `npm run verify` 复验脚本 |
| 3.12.43 | 2026-11-10 08:13 | `ok`，`missing {}` | `ok`，`appVersion 3.12.43` | 128 / 0 / 0 | 1755 全绿 | 兼容；夹具 11/11 仍成立（见下节） |
| 3.12.59 | 2026-11-13 上午 | `ok`，`missing {}` | `ok`，`appVersion 3.12.59` | 130 / 0 / 0 | 1764 全绿 | 兼容；未发现需适配的实现改动；installed 差异为空目录残留，判定已降为 WARN（见下） |

四版共同的稳态项：informational 只有 `desktop: devin.refreshUserStatus`（3.12.17 起官方删除该命令，插件已不再调用，缺失是稳态不是漂移），`catalog-unknown.json` 均不存在。

## 3.12.43 产物指纹（2026-11-10）

| 产物 | 路径 | 字节 | sha256 |
| --- | --- | --- | --- |
| cli | `…/extensions/windsurf/devin/bin/devin` | 192,098,880 | `6ae38d214ade53f669d8a2851693c02f33537dca7fade29364de241f7ef86a33` |
| ls | `…/extensions/windsurf/bin/language_server_macos_arm` | 147,091,808 | `4ee36e5b213e677e46ae8a60e9e25f6c93a0c31400d6f438e2061810485db3b1` |
| desktop | `…/out/vs/workbench/workbench.desktop.main.js` | 23,712,860 | `cb22ba5d1b9f95881e08cde229c00d9278d7f6a0e6d5f604a39ea293dc302519` |
| chat | `…/out/vs/workbench/windsurf-chat-client/index.js` | 28,819,940 | `e8aad50dee865d1e43559ae16c929d192553b08aba83af703edaad78318fafb7` |
| acp | `…/extensions/windsurf/dist/extension.js` | 6,556,600 | `ed9e5184115d4c517281d9d14a4ee5ceb3b1fdd85dff7898a73d5d459c8b78ff` |

## 3.12.43 运行期观测

- **目录注入**：`GetCliTeamSettings` models 238 / matrix 229 / own `0 → 99`；同日早期的 `GetUserStatus` 为 own `0 → 207`。同一批注入出现在多个目录 RPC 上属既有契约，`verify` 只取窗口内最后一条判断「有没有注入过」，不用于判断注入数量。
- **推理**：24h 窗口内 `chat-complete` 484 条，状态全为 200；`request-error` 0。3.12.43 上今日仅 3 个回合，样本很小，不能当作长稳结论。
- **回放未命中**：`state-envelope-replay-failed` 91 条，全部早于 2026-11-09T08:56Z（3.12.32 时期），reason 仅 `id`；今日窗口 0 条。这是**回退**不是错误，且 DeepSeek 面的回放既无收益也无害（见 `provider-measurements-forensics.md`）。
- **其他诊断**：`tool-name-unknown: view_image` 1 次、`forward-timeout` 2 次（均 connect 阶段），都发生在 2026-11-09；两者都不阻断请求，也不影响判定。
- `catalog-unknown.json` 不存在：没有出现白名单外的原生目录 RPC。

## 3.12.59 产物指纹（2026-11-13）

| 产物 | 路径 | 字节 | sha256 |
| --- | --- | --- | --- |
| cli | `…/extensions/windsurf/devin/bin/devin` | 192,099,840 | `43b8b587cb8d319a1e085e08015a22a6bfc8abe26d99e7cbb18a4a8a9f15b2ce` |
| ls | `…/extensions/windsurf/bin/language_server_macos_arm` | 147,091,824 | `a6f8f97370877338c8727565e8d2d6ce3d5d51aa65b28bb83c8b069937bc054d` |
| desktop | `…/out/vs/workbench/workbench.desktop.main.js` | 23,714,066 | `ac9c4991e6d7226258494e0d6b56a3fd4c4f679d58fedf8fd32f80a01b25f2e0` |
| chat | `…/out/vs/workbench/windsurf-chat-client/index.js` | 28,821,100 | `71155dcb6054fc69f80e142e9fbe5d585c59605a4af3d091293d00ae00c69832` |
| acp | `…/extensions/windsurf/dist/extension.js` | 6,556,474 | `7e2c52f550df478d2f03e521a95912a25fd1298b0e3e4654d38cda273ee3d140` |

## 3.12.59 运行期观测

- **目录注入**：`GetUserStatus` models 238 / matrix 229 / own `0 → 207`，与 3.12.43 数值一致。
- **推理**：24h 窗口 3057 条事件，`chat-complete` 710 条状态全 200，`request-error` 0，`state-envelope-replay-failed` 0。
- **`forward-timeout`** 4 条，均为 `BatchRecordAnalyticsEvents` 的 connect 阶段（2026-11-12），不阻断请求。
- **`chat-error`** 1 条（`upstream_stream_error`，`TypeError/ECONNRESET`，failFrame `response.reasoning_text.delta`），属供应商侧传输重置，与桌面版本无关。
- `catalog-unknown.json` 不存在：没有出现白名单外的原生目录 RPC。
- **原生 picker 缓存** 1101 条（3.12.43 同期为 1018）；3.12.59 新增原生形态不破坏插件：新 harness `gpt-5p4-persistent`（10 条）由插件原样透传（无白名单），29 条无 `familyUid` 条目是 `fusion`/`fusion-sidekick-*` router 条目与 `MODEL_GPT_OSS_120B`/`adaptive`，`familyUid` 仅用于设置页聚合。

## 3.13.4 运行期观测（2026-11-17）

真机：Devin **3.13.4**（`Info.plist` 2026-11-16 17:20、内置二进制 17:22，此后未变）× 插件 **0.6.10**（重装后宿主 15:03:50 起）。`config.json` 9 键，`mirrorNativeAllowlist` 不存在。

- catalog 事件全部为 **`models=61 / matrix=52`**（8 条 `GetUserStatus` + 1 条 `GetCliModelConfigs` + 1 条 `GetCliTeamSettings`），无 `mirror` 字段；
- 原生条目数 `GetUserStatus=47` / `GetCliModelConfigs=69`，`allowedCount=69`、`allowedKind=restricted`；`families` 为 `{glm:12, swe:12(13), kimi:9, deepseek:8, nemotron:6}`，**claude / gpt / gemini 各 0**；
- `team_settings.b0239737b4184efa.bin` = 10,272 B（mirror 开启时为 77,736 B，内部 `claude/gpt/gemini` 各 0 次）；`GetCliTeamSettings` `before 881 → after 1398`、`afterOwn 45`（mirror 时 6,517）；
- 两把实际生效的凭据（桌面 `accessToken` 与 ACP 递给 CLI 的 key `auth=1efb47a89d33`）**结果一致**（`credentials.toml` 那条 CLI 根本不读，`auth status` 仍报未登录）——当时据此推断限制是账号级而非凭据级，该推断已被同凭据网络 A/B 修正，见「3.14.30819 源码适配状态」；
- 官方 `GET /api/v2alpha/models` 实测：全量 **1074**，`allowed:true` 仅 **47**，1011 条 claude/gpt/gemini 全 `allowed:false`，`allowed_model_uids` 与 `allowed_model_tags` 均为 `[]`，带 `org_id` 查询结果与 `ETag`（`32816dd722975ae619236aef434b7917`）完全一致；
- 上游口径变化（同一安装、同一凭据）：`model_configs` v6 代际 payload **913,664 B**（`2026-11-17T01:58Z`，claude 命中 2601 / gpt 4544）→ v7 代际 **58,299 B**（`05:00Z`，仅 `fusion-sidekick-*`）。故当时判定目录收窄发生在服务端准入层、与客户端版本和插件重写无关——「与插件无关」部分后被撤回，见下节。

结论：`matrix` 从 229 掉到 52 是 lead 侧 frontier 被准入层移除的连带结果，`mirrorNativeAllowlist` 无法恢复（交集上限 = 原生集合）。判据见 `.devin/rules/model-entitlement-forensics.md`。

## 3.14.30819 源码适配状态（2026-11-18）

本轮原生字段/探针专项测试 40/40 通过。REA 对 proxy-agent、生产目录映射和已安装插件选中模块共 7 个 JS 文件做有界静态分析，语义图为 partial；未完成 CLI/LS 原生反编译，不据此宣称所有私有 API 已验证。适配集中在代理下发、backend 显式 CONNECT 转发和活进程身份诊断，不改 Fusion 角色、protobuf 或供应商线格式。

正式实现的本机覆盖安装尚未验收。此前安装副本临时补丁曾得到 allowedCount=1097，这不是本次正式代码的真机结果。验收需同时确认安装文件、活 sourceId/instance/PID、新一次目录请求以及实际代理连接；Reload/Cmd+Q 不保证 detached backend 被重建。

后续网络 A/B 已推翻本页旧的“同凭据同结果即账号级、与插件无关”推断：同一凭据经代理可取到官方家族，backend 直连时受限。应先核对每一跳的真实出口，再讨论账号权益。历史数字保留作当时观测，不代表当前目录规模。

## 官方 Fusion 组合的变更与注入边界（2026-11-13）

解析同一 identity 的 CLI 缓存 `~/.cache/devin/cli/model_configs_v6.22718a016192f32f.bin` 与其 11-06 备份（`.bak`，覆盖本次升级）：

| 项 | 11-06 | 11-13（3.12.59） | 变化 |
| --- | --- | --- | --- |
| 官方 lead×side combo | 864 | 934 | +70 |
| 官方 combo 的 lead 值 | 95 | 105 | +10 |
| 官方 sidekick uid | 14 | 14 | 0 |
| 官方 sidekick 维度值 | 10（order 1..10） | 10（order 1..10） | 0，name+order 逐项一致 |
| 官方 `fusion-sidekick-*` 注册条目 | 14 | 14 | 0 |
| 原生模型条目 | 270 | 288 | +18 |
| 我方注入条目 | 99 | 99 | 0 |

新增的 10 个 lead 全属同一新家族 Claude Fable 5.2（`medium/high/xhigh/low/max` 及各自 `-fast`），无删除；+70 = 10 lead × 7 sidekick。我方 99 条（9 个 BYOK 模型 + 90 条 `fusion-dfbyok-…-sidekick-<原生>`）逐条不变。

**真正的变化在 Lead 维度，不在 Sidekick**：Fable 5.2 插进 Lead 第 3 位，原 #3 起的 8 个值整体后移，Lead 维度值 8 → 9 个，70 个既有 lead 的 order +1（如 `GPT-5.6 Sol#6→#7`、`Claude Opus 5#7→#8`）。Sidekick 侧 10 个维度值 `SWE-2 Medium#1` … `Claude Haiku 5.5 Medium#10` 与 14 个 uid（10 普通 + 4 个 GPT `-priority`）逐项未变。Fable 5.2 的 fast 档只声明 4 个 `-priority` sidekick，普通 5 档各配满 10 个，是官方自身的不对称。

判定为不冲突的依据：

- 目录内 uid 零重复；官方 uid 形如 `fusion-<原生>-sidekick-<原生>`，我方全部含 `dfbyok`，`isOwnUid` 可判归属。
- `build.cjs` 用观测到的 `fusion-` 原生 uid 建 `officialFusionUids`，同 uid 的矩阵条目不发射，不会遮蔽官方条目；官方这次只改 Lead 的 order、uid 未变，守卫照常生效。
- 我方组合从 BYOK lead 出发，官方 lead 集合的增减不改变发射数。
- sidekick 维度复用官方 `name+order`，不另造值；官方侧这次 0 变化，复用锚点未动。官方 14 个 sidekick uid 里 4 个 GPT `-priority` 与普通变体共享同一维度、由 `Fast Mode` 承载，去重后只留 10 个 uid 代表，`test/role-exclusions.test.cjs` 守着该行为。
- Lead 重排不波及我方：BYOK lead 维度落在 BYOK 段（`0x20000000`），`assertNativeBand` 的官方下限取自实时观测（现为 9），原生段 `0x10000000` 起仍远高于它；我方不写官方 Lead 维度。

**跨 identity 不可比**：另一 identity（`c87a25d8…`）的 lead×side combo 为 795 条，目录规模不同；上述变化全部取自同一 identity 的前后对比。

## verify 的 installed 判定口径

`verify` 的 `installed` 项曾对「仅已安装侧多出的空目录」报 FAIL（0.6.7 vsix 打包时仓库仍含空的 `src/activation/stores/`，随后仓库删除了它）。判定已改为 WARN（建议重新打包安装）；代码内容哈希不一致仍是 FAIL。

`live-backend` 独立读取回环 `/health`，将活进程 `sourceId` 与已安装副本的新鲜源码身份比较，并报告受限的 PID、instanceId、Node/Electron 版本、启动时间。磁盘一致不等于进程已加载新代码。`proxyReady=false` 是 FAIL；旧 backend 无能力字段、不可达或无法计算安装身份是 WARN/unknown，不是通过。探测仅有界只读，不重启进程、不更改控制面。

## 夹具与版本的绑定关系

`test/fixtures/real-picker.json` 捕获于 3.12.28（2026-11-09）。2026-11-10 复核：这 11 条原生条目在 3.12.43 的实时 `native-cache.json`（1018 条）里 **label 与 name 逐字一致、零缺失**，因此没有随版本重捕。2026-11-13 复核：在 3.12.59 的 `native-cache.json`（1101 条）里同样 **label 逐字一致、零缺失**，未重捕。

重捕的触发条件是：**这些行发生变化，或 picker 报文契约发生变化**；版本号前进本身不构成重捕理由。

## 仍未验证

- 非 macOS 平台（本仓只以 macOS 为目标平台，其他平台未验证）。
- Sidekick 走 BYOK：原生 `swe-2` 不经过插件、进不了 `runtime.log`，这条腿至今没有真实证据。
- `assignment_jwt` 的运行时校验。
- 3.12.43 上的真实端到端验收（今日仅 3 个回合）。
