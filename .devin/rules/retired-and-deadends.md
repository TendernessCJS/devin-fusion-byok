---
trigger: model_decision
description: "Apply when cleaning up config keys, auditing whether a code path is still reachable, or wondering why an old field still exists — retired pipelines, dangling-ref cleanup, and the \"path entry point\" audit trap."
---

## 待办与死角

- 旧 `config.sidekicks` 输入管线已拆除（v0.3.18 起角色选择由 `roleExclusions`/`roleInclusions` 接管）：字段只剩被忽略的惰性配置残留，旧配置里留着的
  `sidekicks` 键无害。注意 `catalog.sidekicks` **输出**与 `state.sidekicks` 仍是活的——它们是角色选择解析后的候选池，不要当成死代码删掉。角色选择走
  `setRoleModel`。
- **具名预设整条管线已退役并彻底删除**（`config.fusionPresets`、`presetUid`、`matrixUidOf`、`migrateFusionConfig`、
  `catalog.presetStates`/`presetCandidates`/`migrationPending`/`migratedFrom`、
  `saveFusionPreset`/`deleteFusionPreset` 消息、`publicState` 的
  `fusionPresets`/`presetCandidates`/`migrationPending`/`selectedFusionUid`/`fusionChoices`/`fusionCount`
  全部不存在了——只剩 `fusionCount` 这个**语义已改**的字段，现在等于 `matrixUids.size`）。退役前提是矩阵恒开：官方 Fusion 卡片就是唯一选择入口，
  一个平行的「我的预设」目录已无物可描述，它的 OFF 分支也不可能再产出（见上条）。**一次性迁移也一并删除**（2026-10-16）：它只服务「从带
  `fusionPresets`/`defaultFusionUid`/`fusionMatrix` 的旧配置升级」这一条路径，而本机配置早已迁完（实测只剩
  `enabled`/`providers`/`inferenceServerUrl`/`updateProxy`/`lastFusionSelection`），留着就是 250 行只为一条历史路径存在的代码；
  遗留键改由 `pruneRetiredKeys` 清理。**代价要记住**：若哪天真从 `config.json.pre-preset-retirement.bak` 恢复旧配置，那些预设引用的
  Lead/Sidekick 不会再生效——需要手工把它们写进 `roleInclusions`。要整体恢复具名预设必须连开关一起重建，不要只加回状态字段。
- 清单式变更（供应商/模型）会顺带调用 `pruneDanglingRoleRefs`（`panel/manager.cjs`）——`providerId` 引用在配置是权威的，模型消失即永久失效，
  必须清掉（否则面板留下死行）；`nativeUid` 引用**永不**自动清理（原生目录靠观测，缺席通常只是「还没同步」，确认死亡后的移除交给面板的 `forgetRoleRef`）。
- `lastFusionSelection` 取代了 `defaultFusionUid`：它既是「锁定的官方 Fusion 选中时回退到哪个组合」（`defaultFusion()`）的取值来源，
  也是「偏好被清空时恢复什么」的记忆。**记录它不等于改写偏好**——`reconcilePreference` 对任何 `fusion-` 形状的选择（官方的也算）只调 `rememberFusion` 记录、绝不
  `saveFusionChoice` 改写：用户/Devin 在官方卡片里选的组合必须原样保留，被改掉就是静默撤销用户操作。
- 关掉一个官方模型的显示（`config.hiddenNativeModelUids`）会**同时**把它踢出角色候选池——`discoverOfficialRoles`/`discoverAdditionalNativeRoles` 都吃 `hiddenSet`，而 `nativeHarnessUids`/`nativeLeadHarnessUids` 只由入选者构建；因此正在使用的组合会失去 harness 而无法解析（`resolveAssignment` 返回 null，不会自动回退）。同理，`roleExclusions` 排除 Lead/Sidekick 也会让存量组合失效。面板文案不得承诺「不影响已保存的组合」。
- ACP 通道的实际机制是 env 注入（`devin.acp.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL`，进程 spawn 时生效、覆盖 CLI 全部网络路径），
  **不是**握手 `_meta.api_server_url` 改写——后者的模块已在审查后删除（`acp-injection.cjs` 自 fork 初始提交起从未接线）。排障
  ACP 流量先看 settings.json 的 agentEnv 与 backend 日志，不要去复活握手改写。
  **2026-10-18 实测补正一处措辞**：`authenticate._meta.api_server_url`（须同时给 `meta.api_key`）**确实**能接管 api server 面，连
  `GetChatMessage` 都跟随；但它**优先级低于 env**（env=死端口时 CLI 直接对死端口失败、不回退 meta），而扩展拿不到 key，所以
  「env 是唯一可用入口」的结论不变——**别把这条误读成「meta 那条路根本不存在」**。细节见 `runtime-and-injection.md`。

- **审「这段代码还活着吗」时，`require` 图会漏掉「路径型入口」**。本仓有 **5 个仓库内入口**，其中 **3 个从 `src/extension.cjs` 的 require 图走不到**，另有 **1 个运行期生成入口不在仓库里**：

  | 入口 | 触发方式 |
  | --- | --- |
  | `src/extension.cjs` | `package.json` 的 `main` |
  | `src/runtime/backend.cjs` | `ensureBackend` 用 `process.execPath` 派生（也被 `extension.cjs` require，故在依赖图内） |
  | `src/fast-context/server.cjs` | `npm run mcp:fast-context`（自带 `require.main` 块） |
  | `src/goal/report.cjs` | `goal/controller.cjs` 把绝对路径拼进 shell 命令（`extension.cjs` 的 `reportCliPath`） |
  | `src/lifecycle/uninstall.cjs` | `package.json` 的 `vscode:uninstall`，VS Code 卸载扩展时执行 |
  | `<globalStorage>/fusion-mcp.cjs`（**运行期生成，仓库里没有**） | `fast-context/launcher.cjs` 写出，外部 MCP 客户端（Claude Code / Codex / Cursor）按面板复制的配置启动它 → 再拉起 `fast-context/server.cjs` 的最新安装副本 |

  最后一行是新形态：入口**不在任何目录里**，它是被生成的。改 `launcher.cjs` 的模板时，已经生成过的旧 `fusion-mcp.cjs` 不会自动更新——判据是用户在面板里重新启用/重载后该文件内容是否变化。

  纯靠模块依赖图做死代码分析会把后三个报成死模块：2026-10-15 误判过一次 `goal/report.cjs`；2026-10-18 审查时又差点误判
  `lifecycle/uninstall.cjs`——它**只被测试 require、生产无人引用**，看起来正是「只有测试续命的死代码」，实际是 `vscode:uninstall` 入口。
  判死前先搜模块名与文件名（`grep -rn "$(basename X)" src/ test/ scripts/ package.json`），**并检查文件末尾有没有 `require.main === module`**。

## 阶段三：评估后不实施（别再重复评估）

结论是结构性的，遇到同样现象不要重新立项：

- **tps 口径不改**：`tracker.finish()` 的 `tps` 要求 `!hasTools`；agentic 回合几乎都带工具，`decodeMs`（首字→终止）又含工具参数生成时间，算出的「正文 TPS」必然偏低且不可比（实机 4803/5102 为 null 即此）。面板已写明口径（`正文 TPS（不含工具）`、`含工具回合不计算`），另以 `throughputTps`（含等待）覆盖另一视角。
- **zero-size 只作基线不作阈值**：0.3.50 重载后 `usageRejections.zero-size` 3 / `acceptedUsageUpdates` 40、`missing-size` 0，属启动期用量回放的既有现象；判据是 `missing-size` 是否增长，不是 zero-size 占比。
- **目录载荷 gzip 已于 2026-10-19 实施**：桥侧 `GetUserStatus` 由 `before 47,222 → after 1,358,627`（28.77×）降到 `after 73,935`（1.566×）；残留倍数来自真实新增（`afterOwn 629`、`beforeOwn 0`），非编码膨胀。原「不改」理由是 loopback 往返约 96 次/天、收益小于风险，推翻依据是同为 loopback 每次省约 1.28MB，且保留上游 `content-encoding: gzip` 只是恢复透传语义而非新增行为。
- **生命周期计数不落诊断**：`close-timeout`/`startup-error` 由旧进程写进 `runtime.log`，新进程读不到内存计数；每 15s 扫日志换低频计数不值得，仍以直接查 `runtime.log` 为准。
- **`response.reasoning.delta` 保留**：非死分支，`inference.cjs` 与 `tracker.cjs` 仍处理它（上游同名实现也有；早期引用的 `.refs/devin-fusion-byok` 副本已不在本机 `.refs/` 里），属防御性透传；只有 `retried` 是真死代码（已删）。
- **历史 NO_PROXY 结论已被替代（2026-10-22，`293fefe`）**：2026-10-19「未配置 `http.proxy`」的取证仍有效，但不能当现行「不注入」禁令。现在 `enable()` 检测到代理配置时经 receipt 管理 `NO_PROXY=127.0.0.1,localhost,::1`；无代理的后续 enable 会还原仍匹配受管值的旧值。它不证明代理变量被下传，也不是 `http.proxy` 变更后的即时协调（已有连接时 enable 会跳过）；固定值不合并用户既有豁免，合并与动态协调属后续改进，勿写成现有保证。

## 已结案的逆向调查（别再重复评估）

- **`cognition.ai/modelsFile` / `cognition.ai/clientProvidedModels` 不是注入通道**：客户端侧只有读者；扫 1887 个 bundle 零真实赋值（命中全是 zod `optional().default(!1)`/`nullish()` 注册），CLI/LS 也无 `client_provided_models`/`models_file` 线缆字段名。
- **`GetClientModelConfigs` / `*ForSite` 无真实调用**：LS 里有这些 RPC 名（`GetCascadeModelConfigsForSite` 103 次等），但运行日志 3 条命中全是 `session_manager` 记录的我们自己的 grep 命令（自我匹配陷阱）；真实目录 RPC 只有 `GetUserStatus`/`GetCliTeamSettings`/`GetCliModelConfigs`。
- **外部模型注册已死，别评估「注册进官方目录」**：`CreateExternalModels`/`UpdateExternalModels`/`DeleteExternalModels`/`GetExternalModels*` 在 shipped 客户端零调用点（`extension.js` 里 `total == 服务表定义数`，devin CLI 二进制 0 次），LS 内含弃用串 `external models feature has been deprecated and is no longer supported`。AI Gateway 方向相反（企业接 Cognition 托管模型），不能替代目录注入。
- **BYOK 覆盖边界**：`GetDevstralStream`（自动补全/apply 路径）与 `GetAccountManagedPlugins` 不在覆盖范围；`GetCascadeModelConfigs`/`GetCommandModelConfigs` 及 `*ForSite` 变体在本机运行时从未触发（catalog 事件只有 GetUserStatus/GetCliTeamSettings/GetCliModelConfigs 三种），LS 有 route 串才加了防御性形状。
- **`ModelInfo.f18 inference_server_url` 在 JS 层零消费者**：四个已安装 bundle 做「定义 vs 读取」分离扫描（`inferenceServerUrl`/`inference_server_url`），命中 1+1 / 1+1 / 4+4 / 3+3 全是 protobuf-es 生成字段初始化与描述符，读取点 0；LS 原生是否消费未证（需 Ghidra+JDK；REA 语义图在本机对 `extension.js` 解析期即超时/堆耗尽，8 组预算无一成功，见 `acp-protocol-fields-forensics.md`）。因此**不要当推理路由杠杆**，也别再设计 stub 实验；升级后重查的判据是读取点计数而非字符串出现次数。同主题 `codeium.inferenceApiServerUrl` 已定案不接，见 `upstream-routing.md`「原生设置的两个键」。
- **服务注册表枚举已盘点（2026-10-27 重跑，别再造表）**：目录形方法（`Model/Models/ModelConfig/Catalog`）在 `extension.js` 553 法中占 19、`sessions.desktop.main.js` 450 法中占 19（两集合相同）、`workbench.desktop.main.js` 155 法中占 4。桥拦截其中 6 个（三个目录 RPC 及 `ForSite` 变体），`AssignModel` 走指派面，`GetModelStatuses` 预登记为 `KNOWN_UNCHANGED`；未建模的 11 个是：`AssignArenaModel`（arena 指派，客户端零调用点，`arenaMode` 31 处但真实指派走 `AssignModel`）、外部模型注册 6 个、AI Gateway 2 个（`GetAiGatewayModelPrices`/`GetModelProviders`，反方向）、`GetStreamingModelAPITextCompletion`/`RecordChatModelNodeRun`（与目录无关）。两条属设计而非遗漏：`*ForSite` 三个由桥 `CATALOG` 正则覆盖、不算未知；上述 11 个**刻意不登记**——真被调用会进 `catalog-unknown.json`，那正是「新面启用」的信号，不要为「收据干净」加白名单。
- **strings 层不可解两项**：`max_turn_requests` 数值上限、CLI 实际读哪份缓存身份——都需结构分析（Ghidra + JDK，本机未装）。兜底：「按枚举处理 + 请求数纪律」与「面板双身份自有计数」。
- **方法论**：可疑字符串按「读者 / schema 注册 / 真实赋值」三步定性，不要直接推成能力位。

## 2026-11-07 退役登记：Devin 3.12.17 断供后的整链删除

- **发布确认链**：`src/activation/catalog-publication.cjs`（协调器）+ `lifecycle.publication`/`createPublication`/`onPublication` 事件面 + 面板「刷新模型目录」按钮 + 注入健康检查 `catalog` 项 + 停用路径的 `drain`/`restore` 验证（`teardown` 的 `{restore}` 形参、`desktop-catalog-restore` 日志、`auth-status.cjs` 的 `emittedOwnUids`/`restoreProbe`/`drainWaiters`/`hasField32`/`isResidual` 与 passthrough 残余扫描）。判据：**版本实测**——3.12.17 全包 3257 个 JS 文件里 `devin.refreshUserStatus` 命令 0 命中，确认链永久停在 `unsupported`，再无发射器可挂。auth-status 的重写 + `collect`/`onNativeModels` 观测 + `shadowed`/`deactivate`/`dispose` 保留——picker 改写面仍活着。
- **`src/proxy.cjs` compatibility facade**：判据**零消费者**——生产与测试均直接 require `update/proxy-config.cjs`、`update/proxy-transport.cjs`、`network/direct-fetch.cjs`。
- **`installed-renderer.cjs` 旧 chat-client 半区**（`loadFamilyPicker`/`loadAcpPicker`/`loadGroupSorter`/`legacyAvailable`/`rendererFile`/`load`）：判据**零消费者 + 版本实测**——四者无引用，且 3.12.17 的 `windsurf-chat-client/index.js` 里 `familyUid`/`catalogMisses` 命中数为 0。webapp bundle 探测仍是唯一探测面。
- **`cli-cache.cjs` 的 `CACHE_RPC` 表**：判据**零消费者**——且表内含已不存在的 `model_configs_v5` 条目；`rpcFor`/`CACHE_PREFIX_RPC` 保留（生产在用）。
- **若 Devin 恢复 `devin.refreshUserStatus`**：从 git 历史恢复上述删除（2026-11-07 前的版本含完整实现与测试），不要凭记忆重写。
- **`src/runtime/host/picker-refresh.cjs`（95 行 + 13 个用例）**：判据**运行期效果为零**——生产硬编码 `lightCommands: []` 使 `run()` 无条件返回，`force()` 全仓零调用。`reloadAcpConnections` 禁令改由 `test/architecture.test.cjs` 守卫（`src/**` 不得出现该字面量）。
- **6 个死函数（同日删除）**：`catalog/payload.cjs` 的 `protoSidekick`/`jsonSidekick`、`goal/store.cjs` 的 `removeCapability`/`removeCapabilitiesForGoal`、`models/order.cjs` 的 `rankMap`、`panel/goal-view.cjs` 服务端 `statusText`（goalScript 模板内同名客户端函数保留）。判据：**定义后全仓零引用**（交叉扫描确认）。

## 2026-11-10 导出面清理与自更新传输去重

- **81 个零外部引用导出条目（33 文件）已删**：只删 `module.exports` 项，函数全保留。判据=src/test/scripts 交叉零引用 + 无 `module[变量]` 取用，清理后剩 0。反例：`cli-cache.cjs` 的 `rpcFor` 仍被文件内生产代码调用，只是导出多余。
- **`src/update/transfer.cjs`（新）**：fetch 与 http.request 两条自更新传输原各抄一份「5 跳重定向 + 限长 + abort/timeout」，现合为 `transferBytes(..., { open })`。**`policy.allowedUrl` 保持成员访问**——`test/proxy.test.cjs` 靠替换它打本地假件。净减 48 行；`attachmentUnsupported` 同时收成 `anthropic.cjs` 单份。
