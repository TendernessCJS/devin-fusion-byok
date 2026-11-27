---
trigger: model_decision
description: "排查「某条 fusion 判据为何这样定」、核对官方组合与 Lead/Sidekick/fast 档的实测数字，或判断某结论是否已过期时必读——矩阵与角色侧的带日期证据，非契约。"
---

# Fusion 矩阵的历史取证（fusion-matrix-forensics）

契约面在 `fusion-matrix.md`（发射条件、角色命名、家族维度、harness、Fast Mode）；本卷只放**带日期的实测数字与事故记录**。数字会过期，契约不会——判据以契约卷为准，本卷用于回答「为什么当初这样定」。目录与 picker 面的同类证据见 `catalog-and-picker-forensics.md`。
## Fusion 族归并的三轮收敛（2026-10-15）

- Lead 原生行 156 → 99 → 55 → **51**；多成员家族 17 → 38；覆盖 222 个合格 uid；`matrixUids` 236 → **244**（官方族的 none 档并入后随族默认选中，多出 8 条）。
- 当时 222 个合格原生里 **48 个完全无维度、94 个只有 `Fast Mode`**，按「Effort 维度名 slug」推导会让 25 个家族被拆散——这是「族键取 uid 档位 token、不依赖 Effort 维度」的由来。
- 只认 `-fast` 后缀会漏掉 **44 行独立的 `… Thinking Fast` 行**（用户截图确认），GPT 系的 `-priority` 形态由此补入后缀词表。
- 控制维度放开的验收值是「`buildRoleLists` 逐行、`buildCatalog().matrixUids` 逐条完全一致」，当时实测 **55 / 226 / 244** 全等；数字本身已过期，判据仍是不带具体数值的全等。

## Lead 不要求 harness：一次五周内反转的结论

- 2026-10-16：当时 586 条官方组合里 **40 条**以 `harnessUids=[]` 的 `gpt-6-astra-{low,medium,high,xhigh,max}` 为 Lead（`isModelRouter=false`、`disabled=false`）。用 harness 卡 Lead 会把整族挡在角色列表外、设置页误标「不能作为 Fusion」，因此 lead 侧去掉 harness 判据，sidekick 侧保留。
- 2026-11-25 复测：`gpt-6-astra-*` 已带 `[gpt-5p6-codex,gpt-5p6]`，1009 条组合的 111 个 Lead / 14 个 Sidekick **全部有 harness**——该判据今天不影响任何官方成员。
- 教训：这是服务端可随时改的形态，不是版本兼容；代码结构保持不变，不要因为「今天都用得上 harness」就把它加回去。

## 服务器家族 vs 角色分族（2026-10-15）

- `familyUid`（条目 f23 的内层 f23）当时覆盖 269 个原生条目 = 50 个家族 + 9 个无该字段者；`glm-5-2`/`-max`/`-none`/`-1m`/`-max-1m`/`-none-1m` 全部 = `glm-5.2`，`claude-opus-4-6`/`-thinking`/`-1m`/`-thinking-1m` = `claude-opus-4.6`。
- 当时官方 822 条组合（现 1009）无一条声明 `1M Context` 或引用 `-1m` 变体，所以角色分族不能改用服务器家族。
- 两套划分当时在 24310 个 uid 对里只有 21 处分歧，全部落在 1M/Thinking。

## Fast Mode 正交性的原始测量（2026-10-15，已从契约卷移入）

真机 40 个 `(Lead 值, Effort 值)` 组合**全部**同时存在 `Fast Mode=0` 与 `=1`，两者 Lead/Effort 值完全相同。按「fast 兄弟单列」实现时产生了 `Claude Opus 5` / `Claude Opus 5.5` 两组同名 label，用户无从分辨——这是「必须并入官方族」这条契约的来源。

## 3.15.14 出货 descriptor 与 fusion 矩阵的线格式核对（2026-11-26）

用 `sessions.desktop.main.js` / `webapp-host/assets/chunk-app-initial-*.js` 里的 protobuf-es `newFieldList` 逐字段读，并与 `b023` 缓存（已被我方改写，含 255 条自有条目）做线级对比。

- `ClientModelConfig` 新增 5 个字段：f33 `disabled_reason`、f34 `compliance_levels`（enum repeated）、**f35 `client_traits`**、f36 `allowlist_covered_model_uids`（repeated string）、f37 `retirement_status`。今天只有 f35 有值，f36/f37 全空。
- `ClientModelTraits`：f1 `cache_keepalive`、f2 `skips_fusion_lead_reminders`、f3 `bash_mode`。**有没有这个 trait 取决于 Lead**，与 Sidekick 无关：`claude-opus-5-5*` → 2+3、`claude-fable-5-2*` → 3、`claude-sonnet-5-5*`/`gemini-4-neon`/`gpt-6-2-astra`/`gpt-6-2-sol` → 空消息、`gpt-6-1-terra`/`gpt-6-luna` → 整个缺失。我方组合条目一律不发 f35（=两个 bool 都是 false），这是 BYOK Lead 唯一诚实的取值。
- `ModelInfo` 新增 f21 `arena_config`、f24 `inference_config`、f29 `allow_route_override`；我们读的 f3/f4/f6/f13/f17/f18/f20/f22/f23/f25/f26/f27/f28 号码全部未变。
- **`display_option`（`ModelInfo.f22`）是 DisplayOption 枚举，不是 Fusion 标记**：0 UNSPECIFIED、1 ARENA、2 BATTLE_GROUP_ONLY、**3 MODEL_ROUTER**、4 QUICK_REVIEW、5 MIMIC、**6 HIDDEN_TOOL**、7 COMPACTOR、8 MODERN_AGENT_CHAT。官方组合条目全是 3，新的 `fusion-sidekick-*` 行是 6（隐藏工具），普通模型行是 0——我们发 3 正确，且已写成契约断言。
- 我方组合 vs 官方组合的线级差异只有元数据：官方多带 f13 `pricing_type`、f24 `model_cost_tier`、f27 `description`、f32 `model_dimensions`、f35 `client_traits`。这些是**按模型定价/文案/能力**的事实，BYOK 模型不能凭空声明，缺省即未指定，属取舍不属缺陷。
- `Recommended Sidekick` 的语义是「该 Lead 推荐哪个 Sidekick」，不是「本条目的 Sidekick」：官方 `fusion-claude-opus-5-5-medium-sidekick-swe-2-1-medium` 上写的是 `SWE-2 Medium`。我方按条目自身 Sidekick 写入（该维度无 order、纯信息位）。

## Fast Mode 复测：官方未改语义（2026-11-26，直接解 `ca58` 的 base64 payload，不经缓存归一化）

- **线格式仍是两态**：关 = 只写 f3 `controlType=2`（不发 f1 `order`）；开 = f1 `order=1` + f3 `controlType=2`。全目录 681 个 `Fast Mode` 维度里 `order` 只取到 1（97 原生 + 183 组合），从未出现 0 或 ≥2，`controlType` 恒为 2——所以「官方 2 个选项、我们只写 controlType」这条契约仍然成立。缓存里看到的 `order: 0` 是归一化补的默认值，不是线上字节。
- **覆盖面变了**：255 个官方 `(Lead, Effort, Sidekick)` 元组里 **183 个同时有开/关两种**（72 个只有关），fast lead 占 40.6% 的组合行；3.14 时代只有 40 个 `(Lead, Effort)` 组带 fast 孪生。
- **快档命名分两层**：模型行上 GPT 系仍写 `-priority`（65 条）、Claude 系写 `-fast`（20 条）、SWE 超快写 `<档位>-lightning`（12 条）；而**组合 uid 里的 fast lead 一律 `-fast`**（183 条全部），GPT-6.2 也一样。所以「GPT 写 `-priority`」只适用于模型 uid，不能拿去解析组合 uid。
- **16 个 fast lead uid 只在组合里存在、没有模型行**：`claude-sonnet-5-5-*`、`gpt-6-2-astra-*`、`gpt-6-2-sol-*` 各 5 个 + `gemini-4-neon-high-fast`，共 118 条组合，且全部在 780 条白名单内。它们进不了角色池（不是模型），判 fast 仍靠后缀兜底：`fastLeadSets` 实测 97 fast / 147 non-fast，与后缀判定 **0 处不一致**、也没有「label 像 fast 却判成非 fast」的行。
- **13 条 `fusion-sidekick-*`（kind=6）完全无维度**，连 `Fast Mode` 都没有。
- **不会被误删**：438 条官方组合全部带 f32 `model_dimensions`，`staleFusionUids` 的 f32 早退能保住它们——否则 fast 判据会把整整 183 条官方 fast 组合判成陈旧，等于把 picker 的 Fast Mode 选项删掉。
- **fast 组合被拒不是故障**：`resolveAssignment` 对 fast lead 返回 null 后，AssignModel 落到 `upstreamForward`，由官方自己处理，官方 fast 组合照常可用；被拒的只是我们若发射 fast lead 的那条路径（不发射）。
- 复核「同一 Lead 下 Sidekick 重名」：改写后载荷 15 个 Lead 全部 0 重名——但下拉是按整个 Fusion 族列值的，跨 Lead 的同名不同序位照样显示两行，所以真正的判据是「**我们的 order 必须与官方一致**」，而不是「每个 Lead 内部不重名」。

## 契约卷移入的实测片段（2026-11-27 自 fusion-matrix.md 逐字搬移）

**发射与族归并**

- （2026-11-25：337 条原生观测按 uid 归出 78 个族基）
- （2026-11-25：59 个 Lead 角色行、官方组合 1009 条、含我方 native×native 的 `matrixUids` 1108 条）
- 官方从未声明的 `-none` 档实例：`gpt-6-sol-none` 与 `gpt-5-6-sol-none` → `GPT-6 Sol`/`GPT-5.6 Sol` 各 5 → **12** 成员；「提不出 token 的同族基成员留在自己的单成员行」——（真机当前无此情形）。
- 官方网格里同名对为 0（Sonnet 5.5 Lead 不提供 Sonnet 5.5 Medium Sidekick，GPT-5.6 Sol 不提供 GPT-5.6 Sol High）——「同家族对永不发射」的网格证据。
- GLM 观测 `High=1`/`Max=2`/`No Thinking=0` vs 官方 `High=3`/`Max=5`——「原生观测 order 是另一套空间」的实例。
- 真机 Effort order 聚合值：Low1/Medium2/High3/XHigh4/Max5。
- `swe-1-6-fast` 的 uid 已随代际下线（2026-11-25 复测只剩 `swe-1-6`）；另实测 sidekick 段 fast 发射为 0 条。

**维度 order 与 Sidekick 代表位**

- 官方 Fusion 值自填小整数，实测 Lead 1..8 / Sidekick 1..9；原生非 Fusion 值 `0x10000000..0x17ffffff` 哈希定位，实测不随供应商启停漂移。
- 观测里有两类噪声：官方已下线的组合、我们自镜像的 native×native 条目（uid 与官方同形，会被回读）；两者只会带来更大的数字，取最小即官方基准位（实测 GLM-5.2 High 7、GPT-5.6 Sol High 6、Sonnet 5.5 8、Haiku 5.5 9、SWE-2.1 10）。

**服务器家族与控制维度**

- 2026-11-25 复测：329 个原生条目（合并 entitlement 后 337）按该字段聚成 70 个设置页家族，无该字段的条目各自成单成员族。
- （2026-11-25：1009 条官方组合无一条声明 `1M Context` 或引用 `-1m` 变体）
- 真机控制维度 key 大量出现：`Reasoning Effort`、`Prompt Cache Retention`、`1M Context`、`Thinking`、`Speed`。

**harness**

- 同批扫描的反证（2026-11-25，数字不在上方「Lead 不要求 harness」节里）：lead/sidekick 引用 router = 0/0、引用 disabled = 0/0、**sidekick 引用无 harness = 0**——所以只有 lead 侧去掉 harness 判据，sidekick 的 harness 门禁原样。
- harness 的分组事实（原生观测实测）：`strawberry-pancake` 覆盖 Claude 全家 + `glm-5-2`/`glm-5-3` + `kimi-k3` + 官方 `deepseek-v4-*` + `grok-4-6`/`grok-4-7`；GPT 系为 `gpt-5p6-codex`+`gpt-5p6`；Gemini 系 `gemini-3-pro`；SWE 系 `swe-1p6`+`swe-1p5`（`swe-2-*` 多一个 `swe-1p6-exec`，对应 CLI 的 `--sidekick-prefer-exec-tool` 工具面偏好）。
- 名字镜像 Cognition 服务端路由（二进制实测 `routers/swe-1p6-cognition`、`swe-1p6-devin`）。
