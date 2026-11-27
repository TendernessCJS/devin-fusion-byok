---
trigger: model_decision
description: "改 Fusion 矩阵 emit、Lead/Sidekick 资格与命名、家族维度或 harness 执行通道时必读。"
---

# Fusion 矩阵（fusion-matrix）

矩阵恒开与 emit 规则、Lead/Sidekick 资格与命名、harness 语义、Fast Mode。

## 发射条件（矩阵恒开、只发新增成员）

- **矩阵恒开，没有开关**：`buildCatalog` 总是发射交叉积，`kind` 一律是 `'matrix'`，且**不得进入面板分组**（面板分组只收 `kind === 'model'` 的普通条目）。官方 Fusion 卡片的维度候选来自「同 family 条目的自声明维度」，
  所以每个 Lead 值下必须有多条不同 Sidekick/Effort 条目（全交叉积），否则下拉被锁死；`fusion-<lead>-fast-sidekick-<side>` 形式的原生 fast lead uid 显式拒绝（原生 fast lead 不发射，不得伪装降级）。条目一律 `familyUid: 'fusion'` + `isModelRouter` + `displayOption 3`，harness 用
  `inferenceServerUrl` —— **该值自 2026-10-19 起由 `src/runtime/port.cjs` 的 `BACKEND_URL` 派生**（注意：此处指后端推理地址派生值，**不是** `ModelInfo.f18`）（不读配置、不持久化；`build.cjs` 的缺省回落也是它）。不要改回读 `config.inferenceServerUrl`：它不是权威来源（不读配置、不持久化），即使旧备份恢复了持久副本也不得把推理指向它，再叠上"硬编码官方地址"的旧回落就会把 BYOK/Fusion 推理静默打向官方服务。**`Fast Mode` 与 `Recommended Sidekick` 两个信息性维度必须照官方线形态发射**：普通条目上前者只带 `controlType: 2`、后者只带 `name`，都不写
  `order`（fast 孪生例外：`order: 1`，见下；`encodeFamily` 只在声明了字段时才写，不再用 `order || 0` 兜底）。picker（`nil`）按 `order` 去重维度值、并**丢弃值数 < 2 的维度**：我们若在普通条目写 `order: 0`，就会与官方的「无 order」分成两个桶——`Fast Mode` 从官方的 2 个选项涨到 3 个，`Recommended Sidekick`从「不渲染」变成一个真实控件（2026-10-14 真机实测）。
- 矩阵只 emit「至少一方是新增成员」的组合：官方维度成员（lead 有 `leadDimension`、sidekick 有 `dimension`）之间的配对永远交给官方目录，
  即使官方没有覆盖该组合也不替它发明（避免产出官方不支持的组合）；BYOK 或非官方原生成员与官方成员配对时，官方成员条目复用官方维度 `name+order` 直接并入官方选项，不另造维度值。Lead
  一律按**系列**组织，族键统一取「uid 去掉结尾档位 token（`-(none|minimal|low|medium|high|xhigh|max|ultra)`，其后可再跟 `-fast`/`-priority`/`-lightning`；**容量限定符 `-1m` 保留在族基上**，故 `GLM-5.2` 与 `GLM-5.2 1M` 是两个族）」（`leadFamilyBase`），
  **不得依赖观测到 `Effort` 维度**——真实目录里大量条目完全无维度或只有 `Fast Mode`，按「Effort 维度名 slug」推导会把同一族拆散、把族标签退化成 uid。
  **fast 变体有三种后缀命名，必须都认**：Claude 系写 `-fast`（`claude-opus-5-high-fast`），
  **GPT 系写 `-priority`**（`gpt-6-1-sol-high-priority`，label 写作 `… Thinking Fast`，`Fast Mode=1`），**SWE Ultrafast 写 `<档位>-lightning`**
  （`swe-2-1-high-lightning`）；只认 `-fast` 会漏掉 GPT 侧整族的 `… Thinking Fast` 行。官方**组合条目**里 GPT 的 fast lead 段写作
  `-fast`（`gpt-6-1-sol-high-fast`），而原生模型列表里只有 `-priority` 形态——**族归并一律以原生模型列表为准**。原生侧 `none`
  的显示名是 `No Thinking`。面板里一族是一个开关，排除/选中都是整族粒度，`memberUids` 承载全部成员 uid。**同家族对永不发射**：subagent 跑与 Lead 同族模型不是有效组合——BYOK 按
  provider/model `key` 判、原生按 `leadFamilyBase` 判，跨档位自配对（flash High × flash Max）同样过滤；每个 BYOK Lead 的 Sidekick
  下拉因此天然少了自己那一项，与官方空洞同形。**BYOK Sidekick 按变体级发射**：官方 Sidekick 值把档位烤进值名（`Claude Sonnet 5.5 Medium`），BYOK 家族的每个
  effort 变体各成一个 Sidekick 值（`DeepSeek · deepseek-flash High`），不得再退回「每族一个代表」（那会让 subagent 只能跑 provider 默认档、且
  `BYOK · N 档` 标注名不副实）。自定义 Sidekick 值的 order 由持久 `order` 名次取段（BYOK 段 `0x20000000` 起，provider/model 名次 × stride + effort 槽位）、
  族内按 effort 档位连续排布（picker 按 order 排下拉，变体在相邻槽位不打散）；数字只在移动/追加时变化，不随选中集合漂移，陈旧缓存条目不会顶替别的值。
  **三段 order 的段位关系由代码强制**：官方 Fusion 值（官方自填小整数）< 原生非 Fusion 值（`0x10000000..0x17ffffff`，哈希定位）< BYOK 值（`0x20000000` 起）。`buildCatalog` 的 `assertNativeBand` 在原生段落点不在本段、或不高于官方最大值时抛 `order_band_conflict`；
  改 span/base 前先看它——段位相交会让两个值共用一个 order，而 picker 按 order 去重会**静默丢掉一个**。

**Sidekick 的代表 order 取「最小声称值」，必须与官方一致**。噪声构成与实测基准值见 `fusion-matrix-forensics.md`。只有**名字**不一致才判死 uid；
不同 uid 抢同一 order 留到发射时消解。要守的不变量是「我们的 order 与官方相同」——picker 按整族列值，同名不同序会多一行。观测侧两道卫生：官方预设随完整目录同步、自镜像 uid 不参与观测。

## 角色身份与命名（Fast Mode、Lead 资格、fast 档、族标签）

- **`Fast Mode` 是正交开关，不属于 Lead 身份**（同一 `(Lead 值, Effort 值)` 同时存在 `Fast Mode=0` 与 `=1`，两者
  Lead/Effort 值完全相同）。因此官方家族的 fast 兄弟必须**并入**官方族（`Claude Opus 5` 5 → 10 成员），不能单列成同名的第二行。官方族因此按**档位系列**吸收成员：凡 uid 能提出档位 token 的同族基成员都并入（官方声明的
  uid、`-fast`/`-priority` 兄弟、以及官方从未声明的 `-none` 档），**提不出 token 的同族基成员才留在自己的单成员行**。并入成员**必须继承**该族的官方
  `leadDimension`；其 Effort 值由自己的 token 给出（`none` → `No Thinking`）。**Effort 的 order 一律取官方空间**（从
  `eligibleNativeLeads` 现场聚合 `name→order`，**不要写死**），官方没有的名字才用
  `stableOrders(该名字, reserved = 官方 order 集合)` 取哈希序——**不得改用原生观测到的 order**：那是另一套空间，同名不同序会被 picker 拆成两个值。已发射条目里同名多
  order（Lead/Effort/Sidekick 三个维度）必须**恒为 0**。族标签 `leadFamilyLabel` 剥掉结尾的档位/Fast/Thinking
  标记但**保留 ` N M` 限定符**（`GLM-5.2 High 1M` → `GLM-5.2 1M`），且全局唯一：撞名先退回成员自身 label，再撞才追加 uid。
- **Lead 资格不要求原生条目自带 harness，Sidekick 仍要求非空 harness**：Fusion 下 Lead 跑在组合条目声明的 harness
  上（`['fusion'] + Lead 自带 harness`，无 harness 的 Lead 退化为 `['fusion']`），Lead 原生条目自己的 `harnessUids` 只决定它能否单独可选，
  与能否当 Fusion Lead 无关。该判据属易变契约（结论曾在五周内翻转，实测与反证数字见 `fusion-matrix-forensics.md`）：**保留结构，不要用 harness 卡 Lead**——只有 lead 侧去掉 harness 判据，其余门禁（router/disabled/hidden、sidekick 的 harness）原样。`discoverAdditionalNativeRoles` 据此按角色分判：lead 候选 = `eligible || 官方 Lead 声明 || (官方族基 && 档位 token)`——astra `-priority` 兄弟无 harness 也并入官方族（`leadHarnessUids` 记 `['fusion']`，发射侧照旧被 `fastLeadUids` 跳过）；sidekick 候选 = `eligible || 官方 Sidekick 声明`。无官方声明、无官方族基档位 token 的无 harness 条目（`MODEL_*`/`arena-*`/`*-review` 类）照旧双假被跳过，不进角色池。
- **fast 档 Lead 只聚合、绝不发射**（`buildCatalog` 展开 `selectedNativeLeadUids` 时跳过 `fastLeadUids` 成员；**只跳 lead 侧**，官方
  Sidekick 维度没有子档、fast sidekick 是它自己的合法取值）。三处判据统一收敛为
  `isFastLeadUid(uid, observedFastUids, observedNonFastUids)`（`identity.cjs`）：**观测优先，后缀兜底**——`observedFastUids` 命中即 fast；`observedNonFastUids`（明确 `Fast Mode=0`，或有 `Speed` 维度而无 `Fast Mode!=0`）命中即非 fast；都无观测才回落 `-fast`/`-priority` 后缀。emit 过滤（`selectedNativeLeadUids`）、`staleFusionUids`（`fastLeadUids`/`nonFastLeadUids` 选项）、`resolveAssignment`（fusion 确定后统一拒绝 fast lead）共用同一判据；fast sidekick 三处都不设限。原生 fast lead 口径不变。BYOK fast 走孪生：配置 `fastModel` 后每基础 combo 增发一条——三维度逐字节相同、仅 `Fast Mode` 写 `{order: 1, controlType: 2}`，label Lead 段取变体名加 ` · Fast`（仅当该标记是同标签碰撞解析**生成**的才不再重复追加外层后缀——用户把变体自然命名为 `Custom · Fast` 之类时外层后缀照常保留；`Fast Mode` 元数据始终带开关）；uid lead 段指向同 effort 的 fast 路线（缺档不发）；
  fast 目标不作 Lead 单发；可作 Sidekick 取值，label 取变体自身防与 base 撞名——变体 label 在 Sidekick 维度与孪生 label 之前做**全局唯一性解析**：普通/base 行先按最终 `家族标签+档位名` 占位，变体按稳定身份序处理；加前缀后的自身 label 与 base 家族标签**完全相同**（用户把两者写成同名）时确定性追加 ` · Fast`，仍与任何普通行或其它变体相撞（如有第三方模型恰好叫 `Same · Fast`）再追加确定性的模型 id 消歧后缀，保证所有带档位的行 label 全局唯一。`lead.ownLabel` 与 `variantOwnLabels` 都取解析后的最终 label，使模型行、picker 列表、Sidekick 维度的 `(name, order)` 与孪生 label 四面一致。**fast 孪生 lead 的解析以 base 的现役资格为限**：`buildCatalog` 产出 `fastTargetLeadActive`（按 fast 目标 route uid 键控，仅当 base 以完全相同的 effort 落在`candidates.lead` 时为 true），`resolveAssignment` 在 fusion 解析/拆分后查该表——base 被停用或取消选择后，即使变体 route 照常存在（停用变体保留 routes），记住的孪生 uid 也必须拒绝解析；普通 uid 拆分回退（无 fast 牵涉）不受影响。模型行侧档位一致时变体并入 base family（同 familyUid/家族标签/Effort），成员 label 各自独立、变体出 sorts 列表组但留 routes 与 f1——picker 按 label→uid 展开列表，重名会让 base 行消失且默认 fast。
  并入成员继承官方 `leadDimension` 因此**不再为发射服务**，而是让家族聚合在「官方成员因 record 冲突被剔除、只剩这些兄弟」时仍读作官方（`buildRoleLists`
  的家族循环仍读该字段）。附注易误判边界：`swe-1-6`（label `SWE-1.6`）带 **`Speed` 开关**（不是 `Fast Mode`），而 `swe-1-6-fast`（label `SWE-1.6 Fast`）的 uid 已随代际下线；判断「是不是 fast 开关的变体」只能看 `Fast Mode` 维度，不要按 uid 后缀或 label
  猜。
- **一族一个 Lead 名**：非官方族成员发射时用**族标签**作 Lead 名（`record.leadBaseLabel = leadFamilyLabel(native.label)`；官方成员继续用
  `leadDimension.name`），于是选中一族时其全部发射条目共用同一个 Lead 值、各自带自己的 Effort。族标签必须来自 `leadFamilyLabel`，**不得按「uid 以 Effort 名 slug 结尾」推导**——对 `glm-5-2-1m`、`gpt-6-luna-medium` 这类 uid 直接失效，会把一族发射成多个 Lead 值且 Effort 全空，面板「一族一行」与实际可选项对不上。

## 不可用条目

- **BYOK 不可用条目不进角色列表**：供应商或模型停用时 `buildRoleLists` 跳过该 ref 但仍标记 seen（否则死引用循环把它捡回成假行），停用只在模型页管理；原生不可用行只来自死引用，「移除」只在那里有效（BYOK 死引用由 `pruneDanglingRoleRefs` 清）。

## 家族、维度与 harness

- **角色族 ≠ 服务器家族，两者都不能替代对方**。服务器在条目 proto field 23（内层消息）的**内层 field 23**
  给了权威家族标识（聚类实例见 `fusion-matrix-forensics.md`）——这**正是我们编码端写出的同一字段**（`s(23, info.modelFamilyUid)`，BYOK 用 `dfbyok-family-*`、矩阵条目用
  `fusion`），长期只写不读。**它只用于设置页聚合，绝不能拿去改角色分族**：服务器家族会把 1M/Thinking 这些 `Fast Mode`
  之外的开关变体合并进来，而官方 Fusion 卡片**不支持这些开关**（证据见 `fusion-matrix-forensics.md`），角色侧必须继续按 uid 档位系列分族，
  否则一族内会出现维度元组完全相同的成员、picker 只能显示其一。两套划分的分歧只出现在 1M/Thinking 变体上。
- **控制维度一律照收，但只能被面板读**：`protoFusionMetadata`/`jsonFusionMetadata` 曾有
  `if (!CANONICAL_FAMILY_KEYS.has(key)) continue;`，把服务器真实的控制项整片丢弃。现在全部保留（`keys` 去重），且 name 校验收窄为「仅规范
  key 强制要求 name」——`Speed` 这类既无 name 也无 controlType 的 key 不得让整条 metadata 变成 null。
  **角色与发射逻辑只按具体 key 名取值**（`Lead`/`Effort`/`Sidekick`/`Fast Mode`），多出的 key
  必须**零影响**：改动此处的验收标准是「`buildRoleLists` 逐行、`buildCatalog().matrixUids` 逐条与改动前完全相同」（2026-10-15 与 2026-11-25 两次实测都要求逐行/逐条全等；数字随目录变化，不要把旧值写进判据）。另注意 `Reasoning Effort` 与 `Effort` **从不同时出现**（同一概念两拼写），档位汇总两者都要算。

- **harness = 执行通道，与模型是两条正交轴（2026-10-16 逆向）**。定义取自 CLI 隐藏开关原文：`--harness <UIDS>`「Comma-separated harness
  UIDs; **does not change the selected model**」（env `DEVIN_HARNESS`），另有 `--harness-lead-only` 与 `--harness-sidekick-only` 做方向限定。
  CLI 的 `ToolKey` 枚举含 `harness`/`OtherHarness`（工具来源分类），而 ModelInfo 里 `harness_uids` 又与
  `prompt_templater_type`/`tool_formatter_type` 同组 ⇒ **harness 是工具来源**（由 `ToolKey` 直接坐实）；
  「它同时决定工具调用的格式化方式」只是同组字段的**推断**，未验证。名字镜像 Cognition 服务端路由，harness 的分组实测（路由与「哪些模型归哪个 harness」）见 `fusion-matrix-forensics.md`。**该分组的成因是推断**（「它服务 Anthropic Messages
  协议系」只是最像的解释，也可能是统一的 provider adapter），没有证据，不要当定论。**不要从系统提示词或 App bundle 反推 harness**（`strawberry-pancake` 在桌面 App bundle 与 CLI 二进制里零出现，纯服务端标识符）。
