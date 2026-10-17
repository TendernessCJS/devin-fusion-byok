---
trigger: model_decision
description: "Apply when changing Fusion matrix emission, Lead/Sidekick eligibility and naming, harness semantics, or Fast Mode."
---

# Fusion 矩阵（fusion-matrix）

矩阵恒开与 emit 规则、Lead/Sidekick 资格与命名、harness 语义、Fast Mode。

- **矩阵恒开，没有开关**：`buildCatalog` 总是发射交叉积，`kind` 一律是 `'matrix'`，且**不得进入面板分组**（面板分组只收 `kind === 'model'` 的普通条目；旧
  `fusionMatrix` 开关与其 OFF 分支已随具名预设一起删除——那条分支只会 emit 预设，留着就是个永不产出的死配置）。官方 Fusion 卡片的维度候选来自「同 family 条目的自声明维度」，
  所以每个 Lead 值下必须有多条不同 Sidekick/Effort 条目（全交叉积），否则下拉被锁死；`fusion-<lead>-fast-sidekick-<side>` 形式的 `-fast` uid
  显式拒绝（BYOK 无 fast 能力，不得伪装降级）。条目一律 `familyUid: 'fusion'` + `isModelRouter` + `displayOption 3`，harness 用
  `inferenceServerUrl`（不是硬编码官方地址，否则本地推理地址覆盖失效）。
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
  `BYOK · N 档` 标注名不副实）。自定义 Sidekick 值的 order 按**族键**哈希取 base、族内按 effort 档位连续排布（picker 按 order 排下拉，
  逐名独立哈希会把同族变体打散）；仍保留哈希序的初衷——名字到 order 的映射不随选中集合漂移，陈旧缓存条目不会顶替别的值。
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
  Sidekick 维度没有子档、fast sidekick 是它自己的合法取值，实测 sidekick 段 fast 发射为 0 条）。`fastLeadUids`
  必须**由观测的 `Fast Mode` 维度判定**（`fusionMetadata` 里 `Fast Mode != 0`），**不得按 uid 后缀判定**——同一概念上游在 Claude 上写
  `-fast`、在 GPT 上写 `-priority`，按后缀写死会漏掉后者（实测漏 44 条）；观测驱动同时天然覆盖未来新命名，且与官方族准入规则用的是同一份证据。
  原因是能力缺口而非取舍：我们的矩阵条目**不写 `Fast Mode` 的 `order`**（写了就会把 Fast Mode 从官方 2 个选项涨到 3 个），于是 fast lead 条目与同档非 fast
  双胞胎**维度元组逐字节相同**（发射 40 条即产生 40 组重复），picker 无从区分；不发射则重复组为 0。`staleFusionUids`（`leadUid.endsWith('-fast')`
  判陈旧）与 `resolveAssignment`（同判据拒绝回退）**只认 `-fast` 拼写**，与「不发射」一致；
  **若未来要重新发射 fast lead，必须同时补上 `Fast Mode` 的 order 才能让 picker 区分，并把这两处判据也改成观测驱动**，否则只是造重复条目或让新条目被自己的清理逻辑删掉。
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
- **角色族 ≠ 服务器家族，两者都不能替代对方**。服务器在条目 proto field 23（内层消息）的**内层 field 23**
  给了权威家族标识（`glm-5-2`/`-max`/`-none`/`-1m`/`-max-1m`/`-none-1m` 全部 = `glm-5.2`；
  `claude-opus-4-6`/`-thinking`/`-1m`/`-thinking-1m` 全部 =
  `claude-opus-4.6`）——这**正是我们编码端写出的同一字段**（`s(23, info.modelFamilyUid)`，BYOK 用 `dfbyok-family-*`、矩阵条目用
  `fusion`），长期只写不读。269 个原生条目 = 50 个家族 + 9 个无该字段者。**它只用于设置页聚合，绝不能拿去改角色分族**：服务器家族会把 1M/Thinking 这些 `Fast Mode`
  之外的开关变体合并进来，而官方 Fusion 卡片**不支持这些开关**（822 条官方组合条目里没有一条声明 `1M Context`，也没有一条引用 `-1m` 变体），角色侧必须继续按 uid 档位系列分族，
  否则一族内会出现维度元组完全相同的成员、picker 只能显示其一。两套划分实测 24310 个 uid 对里仅 21 处分歧，全部是 1M/Thinking。
- **控制维度一律照收，但只能被面板读**：`protoFusionMetadata`/`jsonFusionMetadata` 曾有
  `if (!CANONICAL_FAMILY_KEYS.has(key)) continue;`，把服务器真实的控制项整片丢弃（真机：`Reasoning Effort` 174 条、
  `Prompt Cache Retention` 121、`1M Context` 82、`Thinking` 70、`Speed` 2）。现在全部保留（`keys` 去重），且 name 校验收窄为「仅规范
  key 强制要求 name」——`Speed` 这类既无 name 也无 controlType 的 key 不得让整条 metadata 变成 null。
  **角色与发射逻辑只按具体 key 名取值**（`Lead`/`Effort`/`Sidekick`/`Fast Mode`），多出的 key
  必须**零影响**：改动此处的验收标准是「`buildRoleLists` 逐行、`buildCatalog().matrixUids` 逐条与改动前完全相同」（2026-10-15 实测 55/226/244
  全等）。另注意 `Reasoning Effort` 与 `Effort` **从不同时出现**（同一概念两种拼写），档位汇总要把两者都算进去。

- **harness = 执行通道，与模型是两条正交轴（2026-10-16 逆向）**。定义取自 CLI 隐藏开关原文：`--harness <UIDS>`「Comma-separated harness
  UIDs; **does not change the selected model**」（env `DEVIN_HARNESS`），另有 `--harness-lead-only`（「Apply
  `--harness` only to the lead, keeping the sidekick's registry harness」）与 `--harness-sidekick-only` 做方向限定。
  CLI 的 `ToolKey` 枚举含 `harness`/`OtherHarness`（工具来源分类），而 ModelInfo 里 `harness_uids` 又与
  `prompt_templater_type`/`tool_formatter_type` 同组 ⇒ **harness 是工具来源**（这条由 `ToolKey` 直接坐实）；
  「它同时决定工具调用的格式化方式」只是同组字段的**推断**，未验证。名字镜像 Cognition 服务端路由（二进制实测
  `accounts/cognition/routers/swe-1p6-cognition`、`swe-1p6-devin`）。harness 的**分组事实**（885
  条原生观测实测）：`strawberry-pancake` 覆盖 Claude 全家 + `glm-5-2`/`glm-5-3` + `kimi-k3` + 官方 `deepseek-v4-*` +
  `grok-4-5`；GPT 系为 `gpt-5p6-codex`+`gpt-5p6`；Gemini 系 `gemini-3-pro`；SWE 系 `swe-1p6`+`swe-1p5`（`swe-2-*` 多一个
  `swe-1p6-exec`，对应 CLI 的 `--sidekick-prefer-exec-tool` 工具面偏好）。**该分组的成因是推断**（「它服务 Anthropic Messages
  协议系」只是最像的解释，也可能是统一的 provider adapter），没有证据，不要当定论。**不要再从系统提示词或 App bundle 反推 harness**：桌面 App bundle 与 CLI
  二进制里 `strawberry-pancake` **零出现**（纯服务端标识符、内部代号无字面语义），压缩落盘摘要里的 `MESSAGE 0/1 - System`（真实系统提示）中 "harness" 计数为
  **0**。
