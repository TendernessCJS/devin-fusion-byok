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

## 阶段三：评估后不实施（别再重复评估）

以下各项都已在阶段三审查中给出结论，理由是结构性的，再遇到同样现象不要重新立项评估：

- **tps 口径不改**：`tracker.finish()` 的 `tps` 要求 `!hasTools`，实机 4803/5102 为 null 是**结构性**的——agentic 回合几乎都带工具，而
  `decodeMs`（首字→终止）会把工具参数生成时间算进分母，给带工具的回合算「正文 TPS」只会得到偏低且不可比的数。面板已在标签与提示里写明口径
  （`正文 TPS（不含工具）`、`含工具回合不计算`），另有 `throughputTps`（含等待）覆盖另一视角。
- **zero-size 只作基线不作阈值**：0.3.50 重载后实测 `usageRejections.zero-size` 3 / `acceptedUsageUpdates` 40，`missing-size` 为 0；
  这是启动期用量回放的既有现象。判据是 `missing-size` 是否增长，而不是 zero-size 的占比。
- **目录载荷放大已于 2026-10-19 实施 gzip 保留**：桥侧 `GetUserStatus` 由 `before 47,222 → after 1,358,627`（28.77×）降到
  `after 73,935`（1.566×）。残留 1.57× 是真实新增条目（`afterOwn 629`、`beforeOwn 0`），非编码膨胀。
  原「不改」的理由是往返走 loopback、实测约 96 次/天、收益小于风险；推翻依据是同为 loopback 但每次往返省约 1.28MB，
  且保留上游 `content-encoding: gzip` 只是恢复透传语义而非新增行为。
- **生命周期计数不落诊断**：`close-timeout` / `startup-error` 由**旧进程**写进 `runtime.log`，新进程读不到内存计数；让扩展宿主每 15s 扫日志
  换一个低频计数不值得。仍以直接查 `runtime.log` 为准。
- **`response.reasoning.delta` 保留**：非死分支，上游同样处理（`.refs/devin-fusion-byok/src/protocol/responses.cjs:416`；`.refs/` 在 `.gitignore` 里**未入库**，该行号仅本机可核），属防御性透传；
  只有 `retried` 是真死代码（已删）。
- **受管 env 不加 `NO_PROXY`（2026-10-19 真机实测，触发条件不成立）**：目标曾是"`http.proxy` 配置时给 `devin-cli` 子进程加回环豁免"
  （`test/proxy-env.test.cjs:97` 那条 `todo`）。取证：Devin 主进程 env 无 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`、`settings.json` 的
  `http.proxy` 未设置、运行中的 `devin acp` 子进程（`ps eww`）env **只有** `WINDSURF_API_SERVER_URL`，且原生 LS 启动参数带
  `--detect_proxy=false`。即 `http.proxy` 是 VS Code 自身网络栈的设置，**没有证据表明它会被下传给 ACP 子进程**——那条 `todo` 把"用户配了代理"
  当成了"CLI 拿到了代理"，中间缺一环。本机的代理是 **git URL 限定** + **SSH `ProxyCommand`**，都不产生环境变量。
  条件只在"从带代理变量的终端启动 Devin"或 `launchctl setenv HTTP_PROXY` 后才成立；真出现时再加，且必须**合并**用户已有的 `noProxy`
  条目而非覆盖。
