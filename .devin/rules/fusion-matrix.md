---
trigger: model_decision
description: "Apply when changing Fusion matrix emission, Lead/Sidekick eligibility and naming, harness semantics, or Fast Mode."
---

# Fusion 矩阵（fusion-matrix）

矩阵恒开与 emit 规则、Lead/Sidekick 资格与命名、harness 语义、Fast Mode。

## 发射条件（矩阵恒开、只发新增成员）

- **矩阵恒开，没有开关**：`buildCatalog` 总是发射交叉积，`kind` 一律是 `'matrix'`，且**不得进入面板分组**（面板分组只收 `kind === 'model'` 的普通条目；旧
  `fusionMatrix` 开关与其 OFF 分支已随具名预设一起删除——那条分支只会 emit 预设，留着就是个永不产出的死配置）。官方 Fusion 卡片的维度候选来自「同 family 条目的自声明维度」，
  所以每个 Lead 值下必须有多条不同 Sidekick/Effort 条目（全交叉积），否则下拉被锁死；`fusion-<lead>-fast-sidekick-<side>` 形式的 `-fast` uid
  显式拒绝（BYOK 无 fast 能力，不得伪装降级）。条目一律 `familyUid: 'fusion'` + `isModelRouter` + `displayOption 3`，harness 用
  `inferenceServerUrl` —— **该值自 2026-10-19 起由 `src/runtime/port.cjs` 的 `BACKEND_URL` 派生**（注意：此处指后端推理地址派生值，**不是** `ModelInfo.f18`）（不读配置、不持久化；`build.cjs` 的缺省回落也是它）。不要改回读 `config.inferenceServerUrl`：那份持久副本已由 `pruneRetiredKeys` 清理，读它只会拿到 `undefined`，再叠上"硬编码官方地址"的旧回落就会把 BYOK/Fusion 推理静默打向官方服务。
  **`Fast Mode` 与 `Recommended Sidekick` 两个信息性维度必须照官方线形态发射**：前者只带 `controlType: 2`、后者只带 `name`，都不写
  `order`（`encodeFamily` 因此只在声明了字段时才写，不再用 `order || 0` 兜底）。picker（`nil`）按 `order` 去重维度值、
  并**丢弃值数 < 2 的维度**：我们若写 `order: 0`，就会与官方的「无 order」分成两个桶——`Fast Mode` 从官方的 2 个选项涨到 3 个，`Recommended Sidekick`
  从「不渲染」变成一个真实控件（2026-10-14 真机实测）。
- 矩阵只 emit「至少一方是新增成员」的组合：官方维度成员（lead 有 `leadDimension`、sidekick 有 `dimension`）之间的配对永远交给官方目录，
  即使官方没有覆盖该组合也不替它发明（避免产出官方不支持的组合）；BYOK 或非官方原生成员与官方成员配对时，官方成员条目复用官方维度 `name+order` 直接并入官方选项，不另造维度值。Lead
  一律按**系列**组织，族键统一取「uid 去掉结尾档位 token（`-(none|minimal|low|medium|high|xhigh|max|ultra)`，其后可再跟 `-fast` 或
  `-priority`；**容量限定符 `-1m` 保留在族基上**，故 `GLM-5.2` 与 `GLM-5.2 1M` 是两个族）」（`leadFamilyBase`），
  **不得依赖观测到 `Effort` 维度**——真机 222 个合格原生里 48 个完全无维度、94 个只有 `Fast Mode`，按「Effort 维度名 slug」推导会让 25 个家族被拆散。
  **fast 变体有两种后缀命名，必须都认**：Claude 系写 `-fast`（`claude-opus-5-high-fast`），
  **GPT 系写 `-priority`**（`gpt-6-1-sol-high-priority`，label 写作 `… Thinking Fast`，`Fast Mode=1`）；只认 `-fast` 会漏掉
  44 行独立的 `… Thinking Fast` 行（2026-10-15 真机实测，用户截图确认）。官方**组合条目**里 GPT 的 fast lead 段却写作
  `-fast`（`gpt-6-1-sol-high-fast`），而原生模型列表里只有 `-priority` 形态——**族归并一律以原生模型列表为准**。经过三轮归并：Lead 原生行 156 → 99 →
  55 → **51**、多成员家族 17 → 38、覆盖 222 个合格 uid；`matrixUids` 236 → **244**（官方族的 none 档并入后随族默认选中，多出 8 条）。原生侧 `none`
  的显示名是 `No Thinking`。面板里一族是一个开关，排除/选中都是整族粒度，`memberUids` 承载全部成员 uid。**同家族对永不发射**：官方网格里同名对为 0（Sonnet 5.5 Lead
  不提供 Sonnet 5.5 Medium Sidekick，GPT-5.6 Sol 不提供 GPT-5.6 Sol High），subagent 跑与 Lead 同族模型不是有效组合——BYOK 按
  provider/model `key` 判、原生按 `leadFamilyBase` 判，跨档位自配对（flash High × flash Max）同样过滤；每个 BYOK Lead 的 Sidekick
  下拉因此天然少了自己那一项，与官方空洞同形。**BYOK Sidekick 按变体级发射**：官方 Sidekick 值把档位烤进值名（`Claude Sonnet 5.5 Medium`），BYOK 家族的每个
  effort 变体各成一个 Sidekick 值（`DeepSeek · deepseek-flash High`），不得再退回「每族一个代表」（那会让 subagent 只能跑 provider 默认档、且
  `BYOK · N 档` 标注名不副实）。自定义 Sidekick 值的 order 由持久 `order` 名次取段（BYOK 段 `0x20000000` 起，provider/model 名次 × stride + effort 槽位）、
  族内按 effort 档位连续排布（picker 按 order 排下拉，变体在相邻槽位不打散）；数字只在移动/追加时变化，不随选中集合漂移，陈旧缓存条目不会顶替别的值。
  **三段 order 的段位关系由代码强制**：官方 Fusion 值（官方自填小整数，实测 Lead 1..8 / Sidekick 1..9）< 原生非 Fusion 值（`0x10000000..0x17ffffff`，哈希定位，
  实测不随供应商启停漂移）< BYOK 值（`0x20000000` 起）。`buildCatalog` 的 `assertNativeBand` 在原生段落点不在本段、或不高于官方最大值时抛 `order_band_conflict`；
  改 span/base 前先看它——段位相交会让两个值共用一个 order，而 picker 按 order 去重会**静默丢掉一个**。
## 角色身份与命名（Fast Mode、Lead 资格、fast 档、族标签）

- **`Fast Mode` 是正交开关，不属于 Lead 身份**（真机 40 个 `(Lead 值, Effort 值)` 组合**全部**同时存在 `Fast Mode=0` 与 `=1`，两者
  Lead/Effort 值完全相同）。因此官方家族的 fast 兄弟必须**并入**官方族（`Claude Opus 5` 5 → 10 成员），不能单列成同名的第二行（旧实现产生了
  `Claude Opus 5`/`Claude Opus 5.5` 两组重复 label，用户无从分辨）。官方族因此按**档位系列**吸收成员：凡 uid 能提出档位 token 的同族基成员都并入（官方声明的
  uid、`-fast`/`-priority` 兄弟、以及官方从未声明的 `-none` 档，如 `gpt-6-sol-none` 与 `gpt-5-6-sol-none` →
  `GPT-6 Sol`/`GPT-5.6 Sol` 各 5 → **12** 成员），**提不出 token 的同族基成员才留在自己的单成员行**（真机当前无此情形）。并入成员**必须继承**该族的官方
  `leadDimension`；其 Effort 值由自己的 token 给出（`none` → `No Thinking`）。**Effort 的 order 一律取官方空间**（从
  `eligibleNativeLeads` 现场聚合 `name→order`，真机 Low1/Medium2/High3/XHigh4/Max5，**不要写死**），官方没有的名字才用
  `stableOrders(该名字, reserved = 官方 order 集合)` 取哈希序——**不得改用原生观测到的 order**：那是另一套空间（GLM 观测
  `High=1`/`Max=2`/`No Thinking=0` vs 官方 `High=3`/`Max=5`），同名不同序会被 picker 拆成两个值。已发射条目里同名多
  order（Lead/Effort/Sidekick 三个维度）必须**恒为 0**。族标签 `leadFamilyLabel` 剥掉结尾的档位/Fast/Thinking
  标记但**保留 ` N M` 限定符**（`GLM-5.2 High 1M` → `GLM-5.2 1M`），且全局唯一：撞名先退回成员自身 label，再撞才追加 uid。
- **Lead 资格不要求原生条目自带 harness，Sidekick 仍要求非空 harness**：Fusion 下 Lead 跑在组合条目声明的 harness
  上（`['fusion'] + Lead 自带 harness`，无 harness 的 Lead 退化为 `['fusion']`），Lead 原生条目自己的 `harnessUids` 只决定它能否单独可选，
  与能否当 Fusion Lead 无关。官方 586 条组合实测 **40 条以 `harnessUids=[]` 的 `gpt-6-astra-{low,medium,high,xhigh,max}` 为 Lead**（`isModelRouter=false`、`disabled=false`），用 harness 卡 lead 会把整族挡在 Lead 列表外、设置页误标「不能作为 Fusion」。同批扫描的反证：lead/sidekick 引用 router = 0/0、引用 disabled = 0/0、**sidekick 引用无 harness = 0**——所以只有 lead 侧去掉 harness 判据，其余门禁（router/disabled/hidden、sidekick 的 harness）原样。`discoverAdditionalNativeRoles` 据此按角色分判：lead 候选 = `eligible || 官方 Lead 声明 || (官方族基 && 档位 token)`——astra `-priority` 兄弟无 harness 也并入官方族（`leadHarnessUids` 记 `['fusion']`，发射侧照旧被 `fastLeadUids` 跳过）；sidekick 候选 = `eligible || 官方 Sidekick 声明`。无官方声明、无官方族基档位 token 的无 harness 条目（`MODEL_*`/`arena-*`/`*-review` 类）照旧双假被跳过，不进角色池。
- **fast 档 Lead 只聚合、绝不发射**（`buildCatalog` 展开 `selectedNativeLeadUids` 时跳过 `fastLeadUids` 成员；**只跳 lead 侧**，官方
  Sidekick 维度没有子档、fast sidekick 是它自己的合法取值，实测 sidekick 段 fast 发射为 0 条）。三处判据统一收敛为
  `isFastLeadUid(uid, observedFastUids, observedNonFastUids)`（`identity.cjs`）：**观测优先，后缀兜底**——`observedFastUids`（观测的
  `Fast Mode != 0`）命中即 fast；`observedNonFastUids`（明确 `Fast Mode=0`，或有 `Speed` 维度且无 `Fast Mode!=0`，如 `swe-1-6-fast` 的
  Speed 是另一个合法系列而非 Fast Mode）命中即非 fast；两者都无观测才回落 `-fast`/`-priority` 后缀。emit 过滤
  （`selectedNativeLeadUids`）、`staleFusionUids`（`fastLeadUids`/`nonFastLeadUids` 选项）、`resolveAssignment`（fusion 最终确定后
  统一拒绝 fast lead）共用同一判据；fast sidekick 三处都不设限。
  原因是能力缺口而非取舍：我们的矩阵条目**不写 `Fast Mode` 的 `order`**（写了就会把 Fast Mode 从官方 2 个选项涨到 3 个），于是 fast lead 条目与同档非 fast
  双胞胎**维度元组逐字节相同**（发射 40 条即产生 40 组重复），picker 无从区分；不发射则重复组为 0。
  **若未来要重新发射 fast lead，必须同时补上 `Fast Mode` 的 order 才能让 picker 区分**，否则只是造重复条目或让新条目被自己的清理逻辑删掉。
  并入成员继承官方 `leadDimension` 因此**不再为发射服务**，而是让家族聚合在「官方成员因 record 冲突被剔除、只剩这些兄弟」时仍读作官方（`buildRoleLists`
  的家族循环仍读该字段）。附注一个易误判的边界：`swe-1-6-fast`（label `SWE-1.6 Fast`）带的是 **`Speed` 开关**（不是 `Fast Mode`），
  且服务器把它算作**另一个家族**（`swe-1.6-fast` vs `swe-1.6`），故各自成行；判断「是不是 fast 开关的变体」只能看 `Fast Mode` 维度，不要按 uid 后缀或 label
  猜。
- **一族一个 Lead 名**：非官方族成员发射时用**族标签**作 Lead 名（`record.leadBaseLabel = leadFamilyLabel(native.label)`；官方成员继续用
  `leadDimension.name`），于是选中一族时其全部发射条目共用同一个 Lead 值、各自带自己的 Effort。旧实现按「uid 以 Effort 名 slug 结尾」推导
  `leadBaseLabel`，对 `glm-5-2-1m`、`gpt-6-luna-medium` 这类 uid 直接失效 →
  同一族的成员发射出**多个不同 Lead 名且全部没有 Effort 维度**（2026-10-15 真机实测：选中 `GLM-5.2 1M` 三成员后出现
  `GLM-5.2 High 1M`/`Max 1M`/`No Thinking 1M` 三个 Lead 值、Effort 全空），面板「一族一行」与实际可选项对不上——这类 uid 结尾不是档位 slug
  的模型占多数，务必以族标签为准。`leadBaseUid` 已无消费者，随该推导一并删除。
- 家族/服务器家族判定、控制维度与 harness 见 `fusion-matrix-dims-and-harness.md`。

## 不可用条目

- **BYOK 不可用条目不进角色列表**：供应商或模型停用时 `buildRoleLists` 跳过该 ref 但仍标记 seen（否则死引用循环把它捡回成假行），停用只在模型页管理；原生不可用行只来自死引用，「移除」只在那里有效（BYOK 死引用由 `pruneDanglingRoleRefs` 清）。
