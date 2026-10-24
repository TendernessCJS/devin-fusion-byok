# 原生契约漂移探针（native-contract）

`src/activation/native-contract.cjs` —— 只读自检：Devin 升级后私有 ACP 契约（RPC 名、protobuf 字段、缓存代际、stopReason 枚举、bundle 字符串）可能变化而测试仍全绿，探针让升级**自报漂移**而非依赖人肉逆向。

- **调用时机**：`enable.cjs` 激活完成后 fire-and-forget，结果存 `lifecycle.nativeContract`；失败永不抛到激活流程。返回契约：`status: ok|drift` 命中缓存时附 `reused:true`；`unavailable`（含 `code`）与 `unsupported` 不写缓存、不上面板。
- **四个产物**（基于 `native.extensionPath` = `Contents/Resources/app/extensions/windsurf/devin`）：
  | 键 | 路径 | 缺失语义 |
  | --- | --- | --- |
  | `cli` | `<extensionPath>/bin/devin` | `unavailable`，不写缓存、不报警 |
  | `ls` | `<extensionPath>/../bin/language_server_macos_arm` | 同上 |
  | `desktop` | `<app>/out/vs/workbench/workbench.desktop.main.js` | **drift**，记 `artifact-missing` |
  | `chat` | `<app>/out/vs/workbench/windsurf-chat-client/index.js` | 同上 |
  plist = `Contents/Info.plist`（`app` 上跳 2 层），正则取版本号，取不到记 null。缺失语义两档的理由：bundle 被改名/拆分 = 集成面**无法验证**，必须让人看见而非安静跳过。
- **两级标记**：`REQUIRED` 缺失即 drift——cli `GetCliModelConfigs`/`GetUserStatus`/`GetCliTeamSettings`；ls `cascade_model_config_data`；desktop `devin.refreshUserStatus`（我们真调的命令 id）+`cascade_model_config_data`；chat `cognition.ai/auth`（目录发布 `nativeApplied` 依赖桌面读它）+`cognition.ai/subagent_context`。`INFORMATIONAL` 缺失只记录——cli `model_configs_v6`/`max_turn_requests`/`end_turn`/`refusal`；ls `GetUserStatus`；desktop 空；chat `finishedOutcome`/`abort`/`clientMessageId`。代际与枚举会演进，**误报比漏报更伤**。
- **三级缓存判定**（缓存 = globalStorage `native-contract.json`）：`stat`（四产物 size+mtimeMs 全等）→ `signature`（四 sha256 按 cli:ls:desktop:chat 拼接，mtime 变字节不变走这层并回写 stat）→ 每产物单遍合并扫描。单产物 >400 MB 记 `too-large`（cli/ls→unavailable，bundle→drift）。
- **纪律**：探针只读，**不得据此自动降级或关闭任何功能**；drift 写一条 `native-contract-drift` 并在面板显示「桌面主 bundle 缺少 …」；`reused`/`unavailable`/`unsupported` 静默。
- **报告脚本**：`node scripts/native-contract-report.cjs [--json]` 输出四产物 sha256 与标记命中快照，发布前留档 diff。只读。
- **已知边界**：只覆盖字符串级契约——字段号语义、行为、消息形状变化查不出来。
