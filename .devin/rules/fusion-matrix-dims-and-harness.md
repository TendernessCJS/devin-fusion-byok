---
trigger: model_decision
description: "改家族/服务器家族判定、控制维度处理或 harness 执行通道时必读——维度与执行通道的契约"
---

## 家族、维度与 harness

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
