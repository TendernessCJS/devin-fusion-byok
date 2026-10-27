# 原生契约漂移探针（native-contract）

`src/activation/native-contract.cjs` —— 只读自检：Devin 升级后私有 ACP 契约（RPC 名、protobuf 字段、缓存代际、stopReason 枚举、bundle 字符串）可能变化而测试仍全绿，探针让升级**自报漂移**而非依赖人肉逆向。

- **调用时机**：`enable.cjs` 激活完成后 fire-and-forget，结果存 `lifecycle.nativeContract`；失败永不抛到激活流程。返回契约：`status: ok|drift` 命中缓存时附 `reused:true`；`unavailable`（含 `code`）与 `unsupported` 不写缓存、不上面板。
- **五个产物**：`native.extensionPath` 实为 `.../extensions/windsurf`（无 `/devin`）。**不要按层级推算路径**——`findAppRoot` 从 extensionPath 向上最多 6 层锚定含 `out/vs/workbench/workbench.desktop.main.js` 的目录为 app root（`APP_ANCHOR`）；找不到 → `layout-unknown`（`unavailable`，不写缓存、下次重试，属环境问题**不是契约漂移**）。app root 记 `<app>`：
  | 键 | 路径 | 缺失语义 |
  | --- | --- | --- |
  | `cli` | `<app>/extensions/windsurf/devin/bin/devin` | `unavailable`，不写缓存、不报警 |
  | `ls` | `<app>/extensions/windsurf/bin/language_server_macos_arm` | 同上 |
  | `desktop` | `<app>/out/vs/workbench/workbench.desktop.main.js` | **drift**，记 `artifact-missing` |
  | `chat` | `<app>/out/vs/workbench/windsurf-chat-client/index.js` | 同上 |
  | `acp` | `<app>/extensions/windsurf/dist/extension.js` | **drift**，记 `artifact-missing` |
  plist = `<app>/../../Info.plist`（即 `Contents/Info.plist`），正则取 `CFBundleShortVersionString`，取不到记 null。缺失语义两档的理由：bundle 被改名/拆分 = 集成面**无法验证**，必须让人看见而非安静跳过。
- **两级标记**：`REQUIRED` 缺失即 drift——cli `GetCliModelConfigs`/`GetUserStatus`/`GetCliTeamSettings`；ls `cascade_model_config_data`/`GetUserJwt`/`GetWebSearchResults`（后两个支撑外部 Fast Context MCP）；desktop `devin.refreshUserStatus`（我们真调的命令 id）+`cascade_model_config_data`；chat `cognition.ai/auth`（目录发布 `nativeApplied` 依赖桌面读它）+`cognition.ai/subagent_context`；acp `state_update`/`plan_update`/`available_commands_update`/`config_option_update`/`session/set_config_option`/`cognition.ai/clientMessageId`/`cognition.ai/isOptimistic`/`reconnectingMaxDelay`（最后一个是本地 connector 崩溃的唯一可观测状态，改名即失明）。`INFORMATIONAL` 缺失只记录——cli `model_configs_v6`/`max_turn_requests`/`end_turn`/`refusal`/`assignment_jwt`；ls `GetUserStatus`/`GetCliModelConfigsForSite`/`GetCascadeModelConfigsForSite`/`GetCommandModelConfigsForSite`/`assignment_jwt`/`GetModelStatuses`（`GetModelStatuses` 结论见 `catalog-and-picker.md`；`*ForSite` 未触发见 `retired-and-deadends.md`）；desktop 空；chat `cognition.ai/finishedOutcome`/`cognition.ai/abort`/`cognition.ai/clientMessageId`；acp `plan_removed`/`_session/elicitation`/`session/archive`/`_cognition.ai/session/archive`/`ext/method`。代际与枚举会演进，**误报比漏报更伤**。
- **凭据存储探针（`authStoreStatus`）**：只读打开 `state.vscdb` 查 `windsurfAuthStatus` 是否存在 → `present|missing|unknown`；**只上报、不参与 drift、绝不读值**，且只在真扫描路径执行（`stat`/`signature` 命中时不打开数据库）。
- **三级缓存判定**（缓存 = globalStorage `native-contract.json`）：`stat`（五产物 size+mtimeMs 全等）→ `signature`（五 sha256 按 cli:ls:desktop:chat:acp 拼接，mtime 变字节不变走这层并回写 stat）→ 每产物单遍合并扫描。单产物 >400 MB 记 `too-large`（cli/ls→unavailable，bundle→drift）。
- **纪律**：探针只读，**不得据此自动降级或关闭任何功能**；drift 写一条 `native-contract-drift` 并在面板显示「桌面主 bundle 缺少 …」；`reused`/`unavailable`/`unsupported` 静默。
- **报告脚本**：`node scripts/native-contract-report.cjs [--json]` 输出五产物 sha256 与标记命中快照，发布前留档 diff。只读。
- **已知边界**：只覆盖字符串级契约——字段号语义、行为、消息形状变化查不出来。
- **缓存键** = `stat`/`signature` + `PROBE_VERSION`：**改标记表或探针语义必须 +1**，否则旧判定被复用、新标记永不扫描。实测依据：0.5.1→0.5.2 真机缓存缺 `authStore` 键（0.5.1 写入），证明旧 `ok` 被复用、`GetUserJwt`/`GetWebSearchResults` 未被扫描。
- **运行期未知目录 RPC 侦测**：`bridge.cjs` 对「RPC 形状 + 方法名含 `Model|ModelConfig|Catalog` + 不匹配 `CATALOG` 正则」的请求记一次 `catalog-rpc-unknown`，按方法名去重后落到 globalStorage `catalog-unknown.json`（`{at, rpc}`，上限 50，只记方法名）。理由：桥的方法名是硬编码白名单，Devin 新增一个携带目录的 RPC 不会报错，只会让 picker 里 BYOK 条目**安静地少一部分**。这份收据是升级后唯一能自查「有没有新目录面冒出来」的落点——**不得**据它自动降级或自动放行。
- **`assignment_jwt` 是 INFORMATIONAL 标记**（cli+ls）：官方 `ModelAssignment` 带该字段，我们的本地应答刻意不带（CLI 3000.11.228 实测仍不校验）。标记消失说明契约变了，届时本地指派可能被校验失败——这是提前量，**不是**要求我们伪造 jwt。

- **覆盖边界**：本探针只做产物内**字符串存在性**扫描；字段号/字段名的强断言在 `test/native-field-contract.test.cjs`（`CODEC_FIELDS`+`CATALOG_FIELDS`）。两者互补——「探针 ok」不等于「字段号还成立」，反之亦然。
