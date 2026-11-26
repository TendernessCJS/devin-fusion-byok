---
trigger: model_decision
description: "改 Fusion Lead/Sidekick 准入判定、或排查「官方侧手在面板里消失 / 组合选不到侧手」时必读——官方 3.15.14 起的侧手声明面，以及 Lead 与 Effort 的权威来源"
---

# 官方 Fusion 角色声明面（fusion-role-declarations）

## 两个声明面（2026-11-26 实测，Devin 3.15.14，纯官方载荷 780 条）

- **Sidekick**：官方为每个可用侧手发一条独立条目 `fusion-sidekick-<侧手 uid>`——`kind=6`（HIDDEN_TOOL）、`isModelRouter=true`、
  label `Fusion Sidekick (<名字>)`、**该行自身携带 harnessUids**（swe 系 `swe-1p6*`、GPT 系 `gpt-5p6*`、其余 `strawberry-pancake`）。
  实测 13 条与组合里 `-sidekick-<uid>` 的引用集合**完全 1:1**（0 多 0 少），其中 3 条是 `-priority` 快档孪生。
- **Lead / Effort**：没有独立声明条目，只有组合条目上的维度——Lead 6 个 `(order,name)`（1 Claude Opus 5.5 / 2 GPT-6.2 Sol /
  3 Claude Fable 5.2 / 4 GPT-6.2 Astra / 5 Claude Sonnet 5.5 / 6 Gemini 4 Neon），Effort 5 个（1 Low / 2 Medium / 3 High /
  4 XHigh / 5 Max）；`Recommended Sidekick` 在全部 438 条组合上恒为 `0|SWE-2 Medium`，是固定提示位，不是门禁。

## 判定契约

- **声明行是身份的权威来源，组合是维度的权威来源**：侧手是否合格看 harness（模型行或声明行任一非空即可），order/name 仍只来自组合。
  `discoverOfficialRoles` 用并集：模型行 harness 为空时回落到 `fusion-sidekick-<uid>` 的 harness，两者都为空才判不合格。
- **不得把「必须有声明行」当准入条件**：厂商若某代停发声明行，硬要求会一次性清空侧手列表；缺声明行时仍按原路径（模型行 harness）判定。
- **有效 harness 必须写进 `eligibleNativeSidekicks[uid].harnessUids`**：`build.cjs` 的 `sidekickHarnessUids` 与 `assignment.cjs` 的 f3 harness 都读它；
  只在判定处放行、记录处仍留空，会发出空 harness 的 assignment。
- **侧手的 harness 判定要覆盖两处，不能只覆盖侧手自己那处**：组合的 `Lead` claim 也要过同一个谓词（`sidekickHarnessOk`）。
  否则侧手模型行一旦失去 harness，被顺带拿掉的是**整个 Lead 家族**（实测：只改侧手那一处时，harness 移到声明行后 leads 26 → 0、sidekicks 仍 10）。

## Lead 没有声明面（2026-11-26 复核）

- 780 条里 **0 条** uid 或 label 含 `lead`；非 `fusion-` 的 router 行只有 `adaptive` / `fusion` / `subagent-default` /
  `memory-migration-default` 四条，都不是 Lead 声明。Lead 身份**只能**从组合的 `Lead` 维度反推——不要去找声明行。
- 组合的 `harnessUids` 全库只有三种取值且**每条都含 `fusion`**（`['fusion','strawberry-pancake']`×225 /
  `['fusion','gpt-5p6-codex','gpt-5p6']`×200 / `['fusion','gemini-3-pro']`×13）。这是 Lead/Sidekick 声明共同的前置条件，
  也是 `resolveAssignment` 里 Lead 侧 harness 的来源；漏 `fusion` 的组合会被静默丢弃。
- 26 个非 fast Lead 的模型行**全部** `disabled=false`、`isModelRouter=false`、harness 非空——「Lead 允许无 harness」这条宽容
  当前没有实例，保留为容错而非依据。
- 变的是**名单**不是规则：`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` / `gpt-5-6-*` 这批已被厂商从 Lead 降为 Sidekick
  （都在侧手 1..10 里），Lead 家族收敛为 6 个。严格名单由组合推导，自动跟随，不需要代码改动。

## 原生变体的 Effort 命名空间（2026-11-26 实测）

- 原生模型行 329 条里 316 条带 `fusionMetadata`。Effort 有**两个键**：`Effort`（90 行，order 0..4）
  与 `Reasoning Effort`（225 行，order 0..5）。**两个键的 name 都可信，order 都不可信**——`Reasoning Effort`
  的 order 是该族的序号（Medium 实测出现 0/1/2，High 1/2/3，Max 2/3/4/5），直接采用会把同名值拆成两个 picker 项。
  Effort 值的 order 一律取官方 Fusion Effort 空间（Low=1 … Max=5）。
- **别名行不得单独成桶**：`swe-2-1` 的 `Reasoning Effort=0|Low` 与 `swe-2-1-low` 同值；`glm-5-2` 的 `Effort=1|High`
  就是该族的 High。同族同 Effort 只发射一个成员，优先 uid 自带 tier token 的那个（`swe-2-1-low` 胜 `swe-2-1`），
  否则 picker 按 `(Lead, Effort)` 去重会静默遮蔽其中一个。
- **不参与 Fusion 维度的变体轴**：`1M Context`、`Thinking`、`Prompt Cache Retention` 是**独立 picker 行**
  （uid 的 `-1m` / `-thinking` 已被 `leadFamilyBase` 保留为不同 base），不要把它们当 Effort 值；`Speed` 只出现在
  `swe-1-6` 一条上，也不是 Fast Mode。
- **Fast Mode 用观测判断**：SWE 的 Ultrafast 行（`swe-2-1-lightning`、`swe-2-1-*-lightning`）自带
  `Fast Mode=1|Ultrafast`，因此按观测即为 fast，与 `-lightning` 后缀推断无关；裸 `-lightning`（如 `nemotron-3-5-lightning`）
  是产品名，后缀规则故意不算 fast，由观测决定。
- **面板角标 `N 个变体` 必须是「可发射档位数」**，不是 `memberUids.length`：后者含永远不发射的 fast 成员，也会重复计别名
  （实测修前 SWE-2.1 = 11，真实可选 5；SWE-2 / SWE-2 Flash 各 6→3）。`buildRoleLists` 给原生 lead 行另写 `variantCount`
  （非 fast 成员按 Effort name 去重），`fusion-view.cjs` 优先用它；设置页的原生模型列表仍按目录行数计，两者语义不同。
- **变体 = 不重复的维度组合，不是行数也不是 effort×fast 的笛卡尔积**：同一 `(全部维度签名)` 的多行是别名
  （`swe-2-1` 与 `swe-2-1-low` 同为 `Reasoning Effort=0|Low`）。设置页原生模型列表按此去重计数（SWE-2.1 = 10 变体 / 12 行），
  隐藏开关仍作用在整族；`claude-opus-4-6` 的 `-thinking` / `-1m` 靠各自的 `Thinking`、`1M Context` 维度区分，是 4 个变体。
- **Fusion Lead 行的角标按 effort 计「档」，并单列快档标识**：`buildRoleLists` 给原生 lead 行写 `variantCount`（非 fast 成员的
  distinct Effort）与 `fastVariants`（家族里是否有 fast 成员）；卡片显示 `官方 · N 档 · 含快档`。侧手列表仍按 effort×fast 计
  （快档侧手合法），设置页按不重复维度组合计——三个数字各自对应那一层能做的选择。

- **快档标识要读组合，不能只读模型行**：`claude-sonnet-5-5-*-fast`、`gemini-4-neon-high-fast` 只作为组合里的 Lead uid 存在，
  没有自己的模型行。`discoverOfficialRoles` 因此额外返回 `fastLeadBases`（Fast Mode≠0 组合的 Lead 家族 base），
  `buildRoleLists` 的 `fastVariants` 两者取并集——只读模型行会让 Sonnet 5.5 / Neon 4 漏标（实测这两族 fast 组合各 5 条 / 1 条）。

## 「不可用」是怎么判出来的（2026-11-26 复核，纯官方 780 条）

官方**没有「不可用清单」这种物件**：负面几乎完全等于「没被任何组合引用」。

- 原生行 329 条里 **281 条从未被任何组合引用**；被引用的 48 条中 `disabled=true`、`isModelRouter=true`、
  harness 为空各有 **0** 条——官方从不引用坏行，所以这些负面信号在真实载荷上零实例。
- 全库 `disabled=true` 的模型行 **0/329**；router 行 4 条（`adaptive` / `fusion` / `subagent-default` /
  `memory-migration-default`）全部未被引用；harness 空的 24 条（GPT-5.5 全族 10、GPT-5.4 Mini 4、
  review 3、kind6 工具 7）同样零引用。`sources` 全库统一 `["cli"]`，没有分通道门控。
- 唯一真正触发的**行级**负面是快档 Lead 缺模型行：官方 lead uid 宇宙 **52 = 26 慢档（全部有模型行）+ 26 快档**，
  其中 16 个快档 uid 没有模型行（sonnet 5.5 ×5、gpt-6.2 astra ×5、gpt-6.2 sol ×5、gemini-4-neon-high ×1），
  对应 118 条快档组合。侧手侧无此问题：13 个引用 uid 全部有模型行。

## 已核残余

- **183 条快档组合整条跳过，会让 10 个官方可用的快档 lead uid 不进名单**：`claude-opus-5-5-*-fast` 与
  `claude-fable-5-2-*-fast` 各有自己的模型行（harness `strawberry-pancake`、启用、非 router），按官方口径是可用载荷；
  我们不发射快档 Lead、官方快档组合原样透传，故无功能缺口，但「官方可用 lead uid 集合」我们少这 10 个。
- **3 个 `-priority` 快档侧手孪生只在快档组合出现**（`gpt-6-luna-high` / `gpt-6-1-terra-high` / `gpt-5-6-sol-high`），
  因此不进严格侧手（仍 10 个），只以扩展候选出现（harness `gpt-5p6-codex`、kind 8、未标 official）；order+name 与慢档孪生
  完全相同，选择结果一致。
- **harness 必填比官方证据更严**：21 条「启用 + 非 router + 无 harness」的行（GPT-5.5 全族、GPT-5.4 Mini、工具行）
  不进任何角色候选。官方零引用，结果一致；理由是推测，故保留侧手声明行与 Lead 的 `officialDim && token` 两条兜底。
- 声明行没有 `fusionMetadata`，不能单独构成可发射的 picker 值；order/name 必须来自组合。
- 官方给 `-priority` 快档孪生与常规侧手**同一个 order+name**（`GPT-5.6 Sol High` 的 52 条 = 26 常规 + 26 快档），所以快档侧手不是独立 picker 值。
- 原生行 `kind` 出现新值 8（110 行，全部 harness 非空、非 router）——角色判定不以 `kind` 为依据，无需跟进。
- `ClientModelConfig` 的 f33 `disabled_reason`、f34 `compliance_levels`、f36 `allowlist_covered_model_uids`、f37 `retirement_status`
  在 329 条原生行里出现 **0 次**；`ModelInfo` 的 f24 `inference_config`、f29 `allow_route_override` 同样缺席（f21 `arena_config` 仅 13 行）。
  即 3.15.14 没有引入新的声明性门禁。
