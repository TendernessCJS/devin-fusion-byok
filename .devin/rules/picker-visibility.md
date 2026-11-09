---
trigger: model_decision
description: "改 picker 行可见性契约、角色白名单或 Lead/Sidekick 门槛时必读"
---

## picker 可见性与白名单

- **picker 可见性契约（2026-10-15：先逆向实测、后由 App bundle 源码证实）**：picker 行 = `team_settings` proto
  **f7 `allowedModelUids` 白名单** ∩ `user_status` f33 **排序组 label 引用** ∩ 非内部 `kind`。内层 f22
  **就是 proto `DisplayOption` 枚举**（`windsurf-chat-client/index.js` 的 `nuk`/`nuM` + `niH`
  过滤器坐实）：`0/缺省 UNSPECIFIED → standard-picker`、`8 MODERN_AGENT_CHAT → standard-picker`（非 Devin Local 环境下被
  `nuj` 强制 disabled + 「Devin Local only」）；`3 MODEL_ROUTER` 仅 arena 关闭时混入（Adaptive/Fusion 条目所在面，`nuq` 的
  `isFeatured`=整组 MODEL_ROUTER 即官方推荐组）；`1 ARENA`/`4 QUICK_REVIEW` 走各自界面；`2/5/6/7` invisible。桌面端
  **f7 一次都不被读**——allowlist 是**纯 CLI 侧门控**（CLI 的 `model_configs` 缓存本就是 f7 过滤后的集合）。`GetCascadeModelConfigs`
  在当前流量里**从未出现**。面板 `internal` 判定链：`isModelRouter || kind≥1&&kind≠8`（Adaptive/Fusion 官方可见但按用户要求折叠）→
  `uid ∉ allowedUids`（**整集替换**而非并集，否则退役 uid 滞留）→ `pickerListed===false` → 旧启发式兜底（`listed`=顶层 f6、sources、
  harness/维度）。`pickerListed` 仅在 payload 带排序区时产生（`GetCliModelConfigs` 无排序区 → undefined）。白名单采集点是 bridge
  `forward` 里 `GetCliTeamSettings` 的**注入前**快照，经 backend 内存 → `native-cache.json`（信封含 `allowedUids`）→ 面板。
  渲染引擎要点（`nr3`/`nr8`/`nio`）：维度值**按 order 首见去重**（同 order 两名只留先枚举到的）、**「恰好 2 个无名值」即开关**（官方不看 controlType，Fast
  Mode 只写 order 就是开关）、disabled 家族成员自动落到最近可用兄弟、代表模型按 pinned>选中>isDefaultModelInFamily>首个取。
  **观测字段在全链路上都有白名单剥失的教训**：`observeNativeModels` 与 `readNativeModels` 的字段重建必须透出
  `kind/listed/sources/pickerListed`，否则新信号到不了判定层。
- **角色列表也要过白名单**：`buildRoleLists`/`buildCatalog` 可选第三参 `allowedUids`（非空=权威全集、null/空=未观测不限制），
  `discoverOfficialRoles` 的两侧 claim 与 `discoverAdditionalNativeRoles` 的候选池都对它求交——白名单外的 uid（如
  `gpt-5-3-codex-spark-medium`，仅 entitlement 来源）虽然 harness 齐全，但其组合在 `augmentLocalModelChoices` 注册 f7 时必被丢，
  列出来等于假可选。调用点：面板三处（`publicState`/`setRoleModel`/`selectFusion`）+ 宿主 `catalog()` + backend
  `getCatalog`/AssignModel；历史上的迁移路径 `migrateFusionConfig` 同样不传——该函数已随预设管线删除（见 `retired-and-deadends.md`），保留这条只为锁住判据：**不该因资格丢用户既有选择**。
- **Lead/Sidekick 门槛的机制依据（App bundle proto/schema 坐实）**：官方客户端**不做资格计算**——可选组合就是服务端枚举的 fusion 条目集，picker
  只做「维度元组→uid」查表（`nr6`，无匹配静默不切换）。AssignModel 双 router 字段：`model_router_uid`（f2）分配 sidekick、
  `fusion_lead_router_uid`（f6）分配 lead；**组合条目的 `harnessUids` 携带 `['fusion', lead真harness]`——lead 的执行通道由组合条目替它声明**，所以成员 lead 无自带 harness 也可当 lead（实测 29 个），而 sidekick 经独立 router 解析、组合条目不携带其 harness，故必须自带（实测 11/11）。**发射侧与 `resolveAssignment`（AssignModel 路径）必须同规则**：`leadNative ? leadHarnessUids : ['fusion']`（`leadHarnessUids` 在 catalog.cjs 里已含 `'fusion'`）。发射侧此前一律只写 `['fusion']`，与契约不一致，2026-10-16 修正（实测 336 条 native-Lead 组合各补上其 Lead harness、112 条 BYOK-Lead 保持 `['fusion']`；改前实测官方 586 个可解析样本中该规则 **390/390 零例外**）。**改这两处中任意一处，必须同时改另一处**，并跑那条逐条比对的回归断言。ModelInfo 官方 schema：`inferenceServerUrl/harnessUids/displayOption/modelFamilyUid/isModelRouter`——与我方 emit 字段名逐一对齐（f18 `inferenceServerUrl` JS 层零消费者，见 `retired-and-deadends.md`）。**字段级实测（2026-10-16 解 CLI 缓存 `model_configs_v5.*.bin`）**：`f4 = 声明窗口`（官方原生值 262000/1000000/200000 与其真实窗口精确相等；我方 BYOK 发 1024000），它同时就是喂给「context-window-based」压缩默认值的那个数——见 `context-and-compaction.md`；`f20 = harnessUids`（repeated，是**候选列表**），assignment 落的是**单个** `harness_uid`（`ModelAssignmentInfo`）；`f25 = isModelRouter`（官方原生不写＝默认 false，我方 fusion 条目写 1）；`f22 = displayOption`；`f23 = familyUid`。**`f5` 是一条「我方永不发、官方部分条目发」的字段**（值恒为 `LLAMA_WITH_SPECIAL`，语义未确证）；我方 `encodeConfig` 全部不发。**影响未验证，拿到证据前不要改**，也不要写成「官方一律发」——条目计数见 `native-observation-and-cli-cache-forensics.md`。
