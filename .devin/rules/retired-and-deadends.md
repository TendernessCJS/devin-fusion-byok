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
  | `src/goal/report.cjs` | `goal/state.cjs` 把绝对路径拼进 shell 命令（`extension.cjs` 的 `reportCliPath`） |
  | `src/lifecycle/uninstall.cjs` | `package.json` 的 `vscode:uninstall`，VS Code 卸载扩展时执行 |
  | `<globalStorage>/fusion-mcp.cjs`（**运行期生成，仓库里没有**） | `fast-context/launcher.cjs` 写出，外部 MCP 客户端（Claude Code / Codex / Cursor）按面板复制的配置启动它 → 再拉起 `fast-context/server.cjs` 的最新安装副本 |

  最后一行是新形态：入口**不在任何目录里**，它是被生成的。改 `launcher.cjs` 的模板时，已经生成过的旧 `fusion-mcp.cjs` 不会自动更新——判据是用户在面板里重新启用/重载后该文件内容是否变化。

  纯靠模块依赖图做死代码分析会把后三个报成死模块：2026-10-15 误判过一次 `goal/report.cjs`；2026-10-18 审查时又差点误判
  `lifecycle/uninstall.cjs`——它**只被测试 require、生产无人引用**，看起来正是「只有测试续命的死代码」，实际是 `vscode:uninstall` 入口。
  判死前先搜模块名与文件名（`grep -rn "$(basename X)" src/ test/ scripts/ package.json`），**并检查文件末尾有没有 `require.main === module`**。
