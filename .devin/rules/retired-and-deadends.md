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
  **不是**握手 `_meta.api_server_url` 改写——后者的模块已在审查后删除（`acp-injection.cjs` 自 fork 初始提交起从未接线，env 通道作用域严格覆盖它）。排障
  ACP 流量先看 settings.json 的 agentEnv 与 backend 日志，不要去复活握手改写。

