---
trigger: model_decision
description: "改 picker 可见性与角色白名单/Lead·Sidekick 门槛、CLI allowlist 三态与准入层、陈旧条目清理、推送门控、nativeFamilies 或维度 order 时必读"
---

# 目录与 picker（catalog-and-picker）

## 状态键与家族标签

- 设置页「官方模型显示」的状态键是 **`state.nativeFamilies`（已取代 `nativeModels`）**：按服务器家族分组，`fusion-*` 组合条目**一律剔除**（组合归 Fusion 页管；代价是面板不能单独隐去某条官方组合，hiddenFusion 能力仅剩配置层），`dfbyok-` 同样剔除；无 familyUid 的条目回退成单成员族；「已隐藏但已离开观测目录」的 uid 仍保留单成员族以便取消隐藏。渲染为**族行（无成员行、无展开态）**：一族一个开关发 `{ uids: 成员 uid 数组 }` 统一隐藏/开放——用户 2026-10-15 明确表示只统一控制，故删除了成员级开关与 `nativeOpen`；`setNativeModelHidden` 仍兼容单 `uid`（能力保留，面板只用 uids 形态）。族标签取「无标记 uid」成员的 label 剥掉档位/开关尾词（单成员族不剥，故 `SWE-2.1 Ultrafast` 这类单成员族名保持原样；族分组 uid 词表含 `lightning`（`swe-2-medium-lightning` 是变体），但 label 不剥 `Lightning`/`Ultrafast`；反例叙述见 `catalog-and-picker-forensics.md`），并全局去重。角色侧词表见 `identity.cjs` 的 `NATIVE_EFFORT_SUFFIX`/`NATIVE_FAST_SUFFIX`：`<档位>-lightning` 是 fast 标记，裸 `swe-2-1-lightning` 无档位 token、靠观测；只含 fast 成员的 Lead 家族不进角色列表（永不能发射，列了就是死控件；同族在设置页与 Fusion 页可差 1，属正常，见 `catalog-and-picker-forensics.md`）。
- **「官方模型显示」的筛选是状态投影，默认只列可用家族**：胶囊顺序固定 `全部 → 可用 → 已隐藏 → 不可用 → 内部`，前四者对非内部家族构成**互斥加和分解**（`可用 + 已隐藏 + 不可用 = 全部 − 内部`）——隐藏的族**只计入「已隐藏」**，否则默认「可用」会把用户已关掉的族又铺出来。胶囊文案用**状态词**，动词只留在批量按钮上；每个胶囊带 `title` 说明自己的判据。`内部` 胶囊**平铺**渲染（不出 vendor 头、不出 `details.fold`）。`nativeFilter` 默认与非法值兜底都是 `available`；空态必须区分「有搜索词」「筛选后为空」「目录为空」三种文案，不能一律显示同步失败。
- **emit 最终标签按「家族」整体唯一，同一家族不得被拆到不同 Lead 维度值**（2026-10-28，`catalog/build.cjs` 的 `claim`/`reserved` 循环）：先把每个家族的 `familyLabel` 与每个 lead 的最终标签登记进 `owners`；**只有撞名家族**（`owners` 集合 >1）才加后缀——未撞名家族的全部标签先进入 `reserved`，所以候选必须同时避开「familyLabel + effort 名」形态（否则 `Foo`+High 与 `Foo High`+无档位仍会撞）；撞名家族按 `family.key` 排序，后缀初值 `digest(family.key).slice(0,8)`，被占用再递增 `-2`/`-3`，命中后**整族统一改写** `familyLabel`，并把该族全部最终标签并入 `reserved`。**禁止退化成按 lead 逐个加后缀**（一族会散到不同 Lead 维度值，picker 同一模型出现两行）；原生 mapper 同 label 后写覆盖 → 组内丢 uid，证据见 `native-observation-and-cli-cache-forensics.md`。

## 隐藏语义与维度 order

- **隐藏语义是家族级**：`hiddenNativeModelUids` 仍存 uid，但 `expandHiddenByFamily`（catalog.cjs）在 `augmentProtoList`/`augmentJsonList`/`buildRoleLists` 三处把隐藏 uid 连坐到同 `familyUid` 的全部兄弟——官方上新变体不会漏过黑名单；面板 `family.hidden = 任一成员隐藏`，`mixed`/`部分隐藏` 状态已移除。
- **维度 order 的稳定性是可见性命门**：picker（chat client `nr3`）按 `(dim 名, order)` 去重维度值，同 order 不同名只留先枚举到的一个，其余静默消失。维度 order 现为**显式持久契约**：BYOK 值取 `0x20000000 + providerRank*0x10000 + modelRank*0x40 + effortSlot`，provider/model 名次来自 config 里持久化的 `order` 字段（缺席 = 数组序，含停用项——停用不挪动他人编号）；原生补充值仍走 `stableOrders`（`0x10000000` 段哈希），两段天然不撞。数字只在用户移动/追加时变化，不再每次构建按集合重算，故**不会重蹈 2026-10-14**（事故叙述见 `catalog-and-picker-forensics.md`）。面板上下箭头改写持久 `order`；`sortByOrder`/`nextOrder`/`normalizeOrders` 在 `src/models/order.cjs`，越界抛 `order_rank_overflow`。
## 陈旧条目与清理

- **陈旧 emit 条目的判别指纹**：官方 fusion 条目恒带能力记录（proto field 32，含 `fusion-sidekick-*` 注册条目），我方 emit 永不写 field 32——「`fusion-*` uid 且无 f32」即我方条目（含无 `dfbyok` 标记的 native×native 形态，`ownUid`/`matrixUids` 都抓不住它们）。 **只有补 field 32 才会破坏该指纹；补 harness 不会**——判别只读条目自身的 f32，而 harness 在 inner message 的 f20。若未来给我方条目补 field 32，必须同步更新该指纹；`team_settings` 白名单里的陈旧 uid 是死指针、无对应条目，不清理。
- **清理条件必须保守：不在 emit 集合里 ≠ 陈旧**。`staleFusionUids` 的完整形态是 `{ emitted, known, excluded }`——只有「uid 拆不出 lead/sidekick」「某一侧已不在 `known`（模型消失 / BYOK uid digest 随配置变了）」「某一侧被该角色显式排除」才判为可删。**禁止退回「不在 emitted 就删」**：emit 集合随原生 Sidekick 维度时序在 24↔155 波动，按缺席删除一次就静默删掉 131 条有效组合（实测见 `catalog-and-picker-forensics.md`）。角色排除仍会退休条目，否则关掉的模型会继续把自己的维度值喂进 picker。`buildCatalog` 另返回 `excludedRoleUids`（BYOK ref → 全部 effort routes；native ref → `memberUids` 全族扩展），`resolveAssignment` 在 fusion 确定后（命中/locked 默认/split 任一）用同集合拒绝，plain routes 不受影响；**未选择 ≠ 排除**（swe-odd 类合法 split 回退仍可解析）。 **位置式调用（`staleFusionUids(data, emittedSetOrArray)`）已退役**：它编码的正是被禁语义，留着=把误删开关摆进代码。新增调用一律传对象式，且 `known` 要给出**当前真正在服务的目录**，不要图省事传 `emitted`。 **`known` 必填且非空，缺失/空 Set/空数组/字符串一律抛 `TypeError`**（`emitted`、`excluded` 仍可省略——`excluded` 默认 `{}` 本就是保守侧， `emitted` 缺失只是失去短路）：`emitted` 只是短路（命中即跳过），真正的判据只有 `!known.has(uid) || 被排除` 这一条，所以 `known` 缺席就是**静默**回到被禁止的缺席语义——已发射的条目仍被短路保住，而所有「payload 里还在、本轮暂时未选中」的条目会全部被判可删。抛错在此是安全方向：`inspectCliCaches` 用 try/catch 包住探针，抛错被吞即空陈旧集合＝一条都不删。
## 推送门控

- **推送门控必须描述「真正发送的内容」，且只描述它**：**revision 门控**——`shared.nativeRevision` 只在目录/白名单**实际变化**时自增（`commit({ bumpRevision })` 是唯一写入口，refresh 与观测两条通道共用），发送条件为 `shared.nativeRevision > shared.lastPushedRevision`，且 `lastPushedRevision` 仅在后端**接受**该 revision 后才推进——失败或跳过的尝试会在下一次 refresh 重试，不会把声称过的 revision 固化住。**空载荷不推进 `lastPushedRevision`，因此不消耗门控**。不要退回任何按载荷内容算 key 的启发式。

## picker 可见性与白名单

- **picker 可见性契约**：picker 行 = `team_settings` proto **f7 `allowedModelUids` 白名单** ∩ `user_status` f33 **排序组 label 引用** ∩ 非内部 `kind`。内层 f22 **就是 proto `DisplayOption` 枚举**：`0/缺省 UNSPECIFIED → standard-picker`、`8 MODERN_AGENT_CHAT → standard-picker`；`3 MODEL_ROUTER` 仅 arena 关闭时混入；`1 ARENA`/`4 QUICK_REVIEW` 走各自界面；`2/5/6/7` invisible **仅当该 uid 在 catalog 元数据里存在**——菜单项缺元数据时按默认 standard-picker 渲染（`uid=fusion` 即此例）。桌面端 **f7 一次都不被读**——allowlist 是**纯 CLI 侧门控**（CLI 的 `model_configs` 缓存即 f7 过滤后的集合）。面板 `internal` 判定链：`isModelRouter || kind≥1&&kind≠8`（Adaptive/Fusion 官方可见但按用户要求折叠）→ `uid ∉ allowedUids`（**整集替换**而非并集，否则退役 uid 滞留）→ `pickerListed===false` → 启发式兜底（`sources`、harness/维度；顶层 f6 的 `listed` 标记已随 2026-11-25 清理删除）。`pickerListed` 仅在 payload 带排序区时产生（`GetCliModelConfigs` 无排序区，见 forensics 卷）。白名单采集点是 bridge `forward` 里 `GetCliTeamSettings` 的**注入前**快照，经 backend 内存 → `native-cache.json`（含 `allowedUids`）→ 面板。CLI 渲染器行为细节（维度值去重、开关判定、disabled 成员回落、代表模型选取）见 `catalog-and-picker-forensics.md`。 **观测字段曾在全链路被白名单剥失**：`observeNativeModels` 与 `readNativeModels` 的字段重建必须透出 `kind/sources/pickerListed`，否则新信号到不了判定层。
- **角色列表也要过白名单**：`buildRoleLists`/`buildCatalog` 可选第三参 `allowedUids`（非空=权威全集、null/空=未观测不限制）， `discoverOfficialRoles` 的两侧 claim 与 `discoverAdditionalNativeRoles` 的候选池都对它求交——白名单外 uid（仅 entitlement 来源，如 `MODEL_GPT_OSS_120B`、`pudding-jelly-*`）harness 齐全但组合在 `augmentLocalModelChoices` 注册 f7 时必被丢，列出=假可选。调用点：面板 `publicState`/`setRoleModel`/`selectFusion` + 宿主 `catalog()` + backend `getCatalog`/AssignModel；`migrateFusionConfig` 同样不传（已随预设管线删除，见 `retired-and-deadends.md`）——保留此条只为锁判据： **不该因资格丢用户既有选择**。
- **Lead/Sidekick 门槛的机制依据（App bundle proto/schema 坐实）**：官方客户端**不做资格计算**——可选组合就是服务端枚举的 fusion 条目集，picker 只做「维度元组→uid」查表。AssignModel 双 router 字段：`model_router_uid`（f2）分配 sidekick、 `fusion_lead_router_uid`（f6）分配 lead；**组合条目的 `harnessUids` 携带 `['fusion', lead真harness]`——lead 的执行通道由组合条目替它声明**，所以成员 lead 无自带 harness 也可当 lead，而 sidekick 经独立 router 解析、组合条目不携带其 harness，故必须自带。**发射侧与 `resolveAssignment`（AssignModel 路径）必须同规则**：`leadNative ? leadHarnessUids : ['fusion']`（`leadHarnessUids` 在 catalog.cjs 里已含 `'fusion'`）。**改这两处中任意一处，必须同时改另一处**，并跑那条逐条比对的回归断言。ModelInfo 官方 schema：`inferenceServerUrl/harnessUids/displayOption/modelFamilyUid/isModelRouter`——与我方 emit 字段名逐一对齐（f18 `inferenceServerUrl` JS 层零消费者，见 `retired-and-deadends.md`）。**字段级语义**：`f4 = 声明窗口`，它同时是「context-window-based」压缩默认值——见 `context-and-compaction.md`；`f20 = harnessUids`（repeated，是**候选列表**），assignment 落的是**单个** `harness_uid`（`ModelAssignmentInfo`）；`f25 = isModelRouter`（官方原生不写＝默认 false，我方 fusion 条目写 1）；`f22 = displayOption`；`f23 = familyUid`。**`f5` 是一条「我方永不发、官方部分条目发」的字段**（值恒为 `LLAMA_WITH_SPECIAL`，语义未确证）；`encodeConfig` 全部不发。**影响未验证，拿到证据前不要改**，也不要写成「官方一律发」——条目计数见 `native-observation-and-cli-cache-forensics.md`。

## CLI 白名单与服务端准入

### allowlist 三态与 restricted→unrestricted 链路

`collectAllowedUids` 返回三态：`{kind:'restricted',uids}` / `{kind:'unrestricted'}` / `null`（非该 RPC 或形状坏）。
proto3 repeated 无法区分「存在但空」与「不存在」，**空是弱信号**，**两条通道各自 N=3 去抖**：
宿主 `observeAllowedUids` 与 backend 原始观测 `onObservedAllowedUids`（`allowedEmptyStreak`）都要连续 3 次
unrestricted 才翻转，反向 restricted 单次立即恢复；**从未建立受限权威的宿主不因空 streak 翻转，只能经
backend 冷启动回显采纳**。bridge 对 GetCliTeamSettings **每请求恰好通知一次**，任何失败（非 200/坏 JSON/
断连/超时/客户端取消）通知 `null` 并打断连续计数。**确认提交（control POST / 已去抖判定）直调
`onAllowedUids` 立即生效并重置原始空计数，不再等 3**；unrestricted 时 `allowedUids` 为空仍要推，但
models 必须非空（空 payload 不推），POST 的模式校验在 ingest 之前。旧缓存缺 `allowedMode` 键=restricted。

### 准入层在 f7 之上

`GetCliTeamSettings` f7 只是**用户侧白名单**；服务端在更上层还按账号准入（plan / billing / 区域）过滤 `model_configs` 与
`GetUserStatus`，所以 **f7 加宽造不出原生目录没有的条目**（交集上限 = 原生集合）。判定 `restricted` 时不要直接归因
「团队/组织限制了模型」：`allowedKind=restricted` 与「存储白名单为空」可以同时成立，此时限制来自准入层，页面上那个
`Reset settings` 是空操作。判据与取证方式见 `model-entitlement-forensics.md`。

- `pickerGroup`/`pickerGroupRank` 取 `Provider` 段（须含命名组，0 基），否则按 f10 枚举兜底；carry 仅限无排序区观测，sorts 与枚举皆空才清除。

## 分卷指针

- **声明窗口 `f4`/`maxTokens` 与上下文压缩已分卷到 `context-and-compaction.md`**：**改声明窗口或怀疑「扩展触发了压缩」前必读**，勿凭印象重推阈值。
- **桌面 auth 目录写入与 `GetModelStatuses` 已分卷到 `catalog-publication.md`**：**改 `auth-status` 前必读**。发布确认链已随 3.12.17 删除、勿重建，历史见该卷与 `retired-and-deadends.md`。
- 准入层（plan/区域）的取证判据见 `model-entitlement-forensics.md`（上文「准入层在 f7 之上」是契约面）。
