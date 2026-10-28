---
trigger: model_decision
description: "Apply when changing picker visibility, role allow-lists, stale-entry detection and cleanup, push gating, nativeFamilies, dimension order, or the declared context window."
---

# 目录与 picker（catalog-and-picker）

picker 可见性契约、角色白名单与门槛依据、陈旧 emit 条目的判定与清理、推送门控、官方模型显示分组、维度 order、声明窗口。

- 设置页「官方模型显示」的状态键是 **`state.nativeFamilies`（已取代 `nativeModels`）**：按服务器家族分组，`fusion-*` 组合条目**一律剔除**（组合归 Fusion
  页管，用户明确要求；代价是面板不再有入口单独隐去某条官方组合，`augmentProtoList` 的 hiddenFusion 能力仅剩配置层），`dfbyok-` 同样剔除；无 familyUid
  的条目回退成单成员族；「已隐藏但已离开观测目录」的 uid 仍保留单成员族以便取消隐藏。渲染为**族行（无成员行、无展开态）**：一族一个开关发 `{ uids: 成员 uid 数组 }` 统一隐藏/开放——用户
  2026-10-15 明确表示只统一控制，故删除了成员级开关与 `nativeOpen`；`setNativeModelHidden` 在 `manager.cjs` 仍同时接受 `uids` 数组与单个
  `uid`（能力保留，面板 UI 不再使用单 uid 形态）。族标签取「无标记 uid」成员的 label 剥掉档位/开关尾词（单成员族不剥，故 `SWE-1.6 Fast` 保持原样；
  **uid 变体后缀词表含 `lightning`**——`swe-2-medium-lightning` 是 fast-mode 变体而非家族名，`Lightning` 不剥 label 是因为
  `SWE-1.7 Lightning` 本身是家族名），并全局去重。
- **emit 最终标签按「家族」整体唯一，同一家族不得被拆到不同 Lead 维度值**（2026-10-28，`catalog/build.cjs` 的 `claim`/`reserved` 循环）：先把每个家族的 `familyLabel` 与每个 lead 的最终标签登记进 `owners`；**只有撞名家族**（`owners` 集合 >1）才加后缀——未撞名家族的全部标签先进入 `reserved`，所以候选必须同时避开「familyLabel + effort 名」形态（否则 `Foo`+High 与 `Foo High`+无档位仍会撞）；撞名家族按 `family.key` 排序，后缀初值 `digest(family.key).slice(0,8)`，被占用再递增 `-2`/`-3`，命中后**整族统一改写** `familyLabel`，并把该族全部最终标签并入 `reserved`。**禁止退化成按 lead 逐个加后缀**：标签确实唯一了，但一族会散到不同 Lead 维度值，picker 里同一模型出现两行。为何必须：原生 mapper 同 label 后写覆盖 → 组内丢 uid，证据见 `native-observation-and-cli-cache-forensics.md`。
- **picker 可见性契约（2026-10-15：先逆向实测、后由 App bundle 源码证实）**：picker 行 = `team_settings` proto
  **f7 `allowedModelUids` 白名单** ∩ `user_status` f33 **排序组 label 引用** ∩ 非内部 `kind`。内层 f22
  **就是 proto `DisplayOption` 枚举**（`windsurf-chat-client/index.js` 的 `nuk`/`nuM` + `niH`
  过滤器坐实）：`0/缺省 UNSPECIFIED → standard-picker`、`8 MODERN_AGENT_CHAT → standard-picker`（非 Devin Local 环境下被
  `nuj` 强制 disabled + 「Devin Local only」）；`3 MODEL_ROUTER` 仅 arena 关闭时混入（Adaptive/Fusion 条目所在面，`nuq` 的
  `isFeatured`=整组 MODEL_ROUTER 即官方推荐组）；`1 ARENA`/`4 QUICK_REVIEW` 走各自界面；`2/5/6/7` invisible。桌面端
  **f7 一次都不被读**——allowlist 是**纯 CLI 侧门控**（`model_configs_v5` 本就是 f7 过滤后的集合）。`GetCascadeModelConfigs`
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
  `fusion_lead_router_uid`（f6）分配 lead；**组合条目的 `harnessUids` 携带 `['fusion', lead真harness]`——lead 的执行通道由组合条目替它声明**，所以成员 lead 无自带 harness 也可当 lead（实测 29 个），而 sidekick 经独立 router 解析、组合条目不携带其 harness，故必须自带（实测 11/11）。**发射侧与 `resolveAssignment`（AssignModel 路径）必须同规则**：`leadNative ? leadHarnessUids : ['fusion']`（`leadHarnessUids` 在 catalog.cjs 里已含 `'fusion'`）。发射侧此前一律只写 `['fusion']`，与契约不一致，2026-10-16 修正（实测 336 条 native-Lead 组合各补上其 Lead harness、112 条 BYOK-Lead 保持 `['fusion']`；改前实测官方 586 个可解析样本中该规则 **390/390 零例外**）。**改这两处中任意一处，必须同时改另一处**，并跑那条逐条比对的回归断言。ModelInfo 官方 schema：`inferenceServerUrl/harnessUids/displayOption/modelFamilyUid/isModelRouter`——与我方 emit 字段名逐一对齐（f18 `inferenceServerUrl` JS 层零消费者，见 `retired-and-deadends.md`）。**字段级实测（2026-10-16 解 CLI 缓存 `model_configs_v5.*.bin`）**：`f4 = 声明窗口`（官方原生值 262000/1000000/200000 与其真实窗口精确相等；我方 BYOK 发 1024000），它同时就是喂给「context-window-based」压缩默认值的那个数——见 `context-and-compaction.md`；`f20 = harnessUids`（repeated，是**候选列表**），assignment 落的是**单个** `harness_uid`（`ModelAssignmentInfo`）；`f25 = isModelRouter`（官方原生不写＝默认 false，我方 fusion 条目写 1）；`f22 = displayOption`；`f23 = familyUid`。**`f5` 是一条「我方永不发、官方部分条目发」的字段**：实测 CLI 缓存 1205 条原生条目中 **234 条**带 f5，值**恒为 `LLAMA_WITH_SPECIAL`**（971 条不带；形态看是提示词模板/分词器类型，字段名未在 bundle 里确证）；我方 `encodeConfig`（`catalog/codec.cjs`）**72 条**全部不发。**影响未验证**（可能 harness 已在服务端提供模板故留空无害，也可能客户端回落默认模板），**拿到影响证据前不要改**，也不要写成「官方一律发」。

- **隐藏语义是家族级**：`hiddenNativeModelUids` 仍存 uid，但 `expandHiddenByFamily`（catalog.cjs）在
  `augmentProtoList`/`augmentJsonList`/`buildRoleLists` 三处把隐藏 uid 连坐到同 `familyUid` 的全部兄弟——官方上新变体不会漏过黑名单；面板
  `family.hidden = 任一成员隐藏`，`mixed`/`部分隐藏` 状态已移除。
- **维度 order 的稳定性是可见性命门**：picker（chat client `nr3`）按 `(dim 名, order)` 去重维度值，同 order 不同名只留先枚举到的一个，其余静默消失。
  自定义维度值一律走 `stableOrders`（`0x10000000 + hash(name)`，同名恒同 order、跨代稳定），**禁止恢复「20+index」式顺序分配**——配置一变 order 全移，
  陈旧条目与新条目会在同一 order 上互撞（2026-10-14 实测
  `DeepSeek · deepseek-flash`/`Claude Haiku 5.5`/`Claude Haiku 5.5 Medium` 三名共占 order 20，BYOK lead 被隐藏）。
- **陈旧 emit 条目的判别指纹**：官方 fusion 条目恒带能力记录（proto field 32，含 `fusion-sidekick-*` 注册条目），我方 emit 永不写 field
  32——「`fusion-*` uid 且无 f32」即我方条目（含无 `dfbyok` 标记的 native×native 形态，`ownUid`/`matrixUids` 都抓不住它们）。
  **只有补 field 32 才会破坏该指纹；补 harness 不会**——判别只读条目自身的 f32，而 harness 在 inner message 的 f20（2026-10-16 给组合条目补 Lead
  harness 后实测陈旧判定零影响，`harnessUids` 与 `maxTokens` 都不参与）。若未来给我方条目补 field 32，必须同步更新该指纹；`team_settings` 白名单里的陈旧
  uid 是死指针、无对应条目，不清理。
- **清理条件必须保守：不在 emit 集合里 ≠ 陈旧**。`staleFusionUids` 的完整形态是 `{ emitted, known, excluded }`——只有「uid 拆不出
  lead/sidekick」「某一侧已不在 `known`（模型消失 / BYOK uid digest 随配置变了）」「某一侧被该角色显式排除」才判为可删。**禁止退回「不在 emitted 就删」**：我们的
  emit 集合会随原生 Sidekick 维度到达时序在 24↔155 之间波动，按缺席删除一次就静默删掉 131 条有效组合（2026-10-14 实测：`bak` 24 条 vs 现文件 155 条）。
  角色排除仍会退休条目，否则关掉的模型会继续把自己的维度值喂进 picker。
  **位置式调用（`staleFusionUids(data, emittedSetOrArray)`）已退役**：它编码的正是这条被禁止的语义，留着就等于把误删开关摆在代码里等人去按（当时它还存在只为兼容 5
  处旧测试断言）。新增调用一律传对象式，且 `known` 要给出**当前真正在服务的目录**，不要图省事传 `emitted`。
  **`known` 必填且非空，缺失/空 Set/空数组/字符串一律抛 `TypeError`**（`emitted`、`excluded` 仍可省略——`excluded` 默认 `{}` 本就是保守侧，
  `emitted` 缺失只是失去短路）：`emitted` 只是短路（命中即跳过），真正的判据只有 `!known.has(uid) || 被排除` 这一条，所以 `known`
  缺席就是**静默**回到被禁止的缺席语义——已发射的条目仍被短路保住，而所有「payload 里还在、本轮暂时未选中」的条目会全部被判可删（2026-10-15 真机复现：缺 `known` 误判 1 条，三参齐全
  0 条）。抛错在此是安全方向：`inspectCliCaches` 用 try/catch 包住探针，抛错被吞即空陈旧集合＝一条都不删。
- **推送门控必须描述「真正发送的内容」，且只描述它**：旧实现是 `pushKey()`——把「本地桥计数 : 上游载荷条数 : 上游载荷带维度条数」拼成字符串的启发式，它在激活初期不等价（首次 refresh 时 backend 可能未就绪、返回空），于是**空载荷占用了 key**，紧接着那次有意义的 refresh 被判「未变化」，推送静默地从未发生（只在上一轮侥幸的时序下成功过）。2026-10-19 起改为 **revision 门控**：`shared.nativeRevision` 只在目录/白名单**实际变化**时自增（`commit({ bumpRevision })` 是唯一写入口，refresh 与观测两条通道共用），发送条件为 `shared.nativeRevision > shared.lastPushedRevision`，且 `lastPushedRevision` 仅在后端**接受**该 revision 后才推进——失败或跳过的尝试会在下一次 refresh 重试，不会把声称过的 revision 固化住。**空载荷不推进 `lastPushedRevision`，因此不消耗门控**。`pushKey` 与 `localNativeModels` 都已删除（后者改名为 `catalog-sync` 闭包内的 `observed`），别按它们的旧语义去「修复」。

- **上下文压缩（声明窗口 `f4`/`maxTokens` 是唯一杠杆、压缩由 CLI 云端调度、四项排障信号）已分卷到 `context-and-compaction.md`**：那一卷含三次自我推翻的定论与实验样本，**改声明窗口或怀疑「扩展触发了压缩」前必读**，不要在这里凭印象重推阈值。

## allowlist 三态与 restricted→unrestricted 链路

`collectAllowedUids` 返回三态：`{kind:'restricted',uids}` / `{kind:'unrestricted'}` / `null`（非该 RPC 或形状坏）。
proto3 repeated 无法区分「存在但空」与「不存在」，**空是弱信号**，**两条通道各自 N=3 去抖**：
宿主 `observeAllowedUids` 与 backend 原始观测 `onObservedAllowedUids`（`allowedEmptyStreak`）都要连续 3 次
unrestricted 才翻转，反向 restricted 单次立即恢复；**从未建立受限权威的宿主不因空 streak 翻转，只能经
backend 冷启动回显采纳**。bridge 对 GetCliTeamSettings **每请求恰好通知一次**，任何失败（非 200/坏 JSON/
断连/超时/客户端取消）通知 `null` 并打断连续计数。**确认提交（control POST / 已去抖判定）直调
`onAllowedUids` 立即生效并重置原始空计数，不再等 3**；unrestricted 时 `allowedUids` 为空仍要推，但
models 必须非空（空 payload 不推），POST 的模式校验在 ingest 之前。旧缓存缺 `allowedMode` 键=restricted。
- **桌面 auth 目录写入、发布确认链与停用恢复、`GetModelStatuses` 结论已分卷到 `catalog-publication.md`**：`windsurfAuth.setAuthStatus` 的原地改写、`catalog-publication.cjs` 的确认预算/看门狗/注销与停用恢复判据都在那一卷，**改发布确认或 `auth-status` 前必读**，不要在本文里重推预算数字。
