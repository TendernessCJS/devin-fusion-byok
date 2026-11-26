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

## 已核残余

- 声明行没有 `fusionMetadata`，不能单独构成可发射的 picker 值；order/name 必须来自组合。
- 官方给 `-priority` 快档孪生与常规侧手**同一个 order+name**（`GPT-5.6 Sol High` 的 52 条 = 26 常规 + 26 快档），所以快档侧手不是独立 picker 值。
- 原生行 `kind` 出现新值 8（110 行，全部 harness 非空、非 router）——角色判定不以 `kind` 为依据，无需跟进。
- `ClientModelConfig` 的 f33 `disabled_reason`、f34 `compliance_levels`、f36 `allowlist_covered_model_uids`、f37 `retirement_status`
  在 329 条原生行里出现 **0 次**；`ModelInfo` 的 f24 `inference_config`、f29 `allow_route_override` 同样缺席（f21 `arena_config` 仅 13 行）。
  即 3.15.14 没有引入新的声明性门禁。
