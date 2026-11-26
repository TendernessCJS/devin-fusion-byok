---
trigger: model_decision
description: "排查「这个数字/结论是哪来的」「某条判据为何这样写」或要核对已下线模型、缓存代际、旧观测面的历史测量时必读——从 fusion-matrix / catalog-and-picker 迁出的实测证据与事故记录。"
---

# 目录与 Fusion 的历史取证（catalog-and-picker-forensics）

契约面在 `fusion-matrix.md` 与 `catalog-and-picker.md`；本卷只放**带日期的实测数字与事故记录**。数字会过期，契约不会——判据以契约卷为准，本卷用于回答「为什么当初这样定」。

## 2026-11-25 目录快照（当前基线）

- CLI 目录 329 个原生条目；合并 entitlement 观测后 337 条（多出 `MODEL_GPT_OSS_120B`、`arena-{smart,fast,mixed}`、`pudding-jelly-{low,medium,high,max}` 共 8 条）。
- 按 uid 档位 token 归出 78 个族基；按 `familyUid` 聚成 70 个设置页家族（无该字段者各自成单成员族）。
- 角色池：Lead 59 行、Sidekick 304 行、不可用行 0 条。
- 官方 Fusion：纯官方身份 1009 条；带 BYOK 注入的身份 1108 条（多出 99 条我方 native×native）。
- 组合端点：111 个不同 Lead、14 个不同 Sidekick，**全部带 harness**；另有 41 个端点不在原生列表里，全部是 `-fast` 双胞胎（`claude-fable-5-1-high-fast`、`gpt-6-sol-high-fast` 等）。
- 原生维度实际出现 10 个 key：`Effort`、`Reasoning Effort`、`Thinking`、`1M Context`、`Prompt Cache Retention`、`Fast Mode`、`Speed`（仅 `swe-1-6`）、`Lead`、`Sidekick`、`Recommended Sidekick`。
- 原生 harness 实际出现 9 个：`fusion`、`gemini-3-pro`、`gpt-5p4-persistent`、`gpt-5p6`、`gpt-5p6-codex`、`strawberry-pancake`、`swe-1p5`、`swe-1p6`、`swe-1p6-exec`。
- 观测来源只有 `cli` 与 `entitlement`。

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

## 顶层 f6 = `supports_legacy`（曾被当成 picker `listed` 标记）

- 旧读法：f6=1 曾按经验当作「picker 仍列出的退役 entitlement 行」（GPT-4.1/GPT-4o 有、o3 无），面板在**白名单尚未落地**时用它把这类行显示出来。`listed` 是我们起的代理名，不是字段真名。
- 2026-11-25 权威字段表（已安装 Devin 3.14.30833 的 `sessions.desktop.main.js` 里的 protobuf-es descriptor，`grep -abo` 取偏移 + `dd` 读窗口）：`exa.codeium_common_pb.ClientModelConfig` 的 **f6 = `supports_legacy`（bool）**；全表里没有 `listed`。同表核对一致：f22 `model_uid`、f4 `disabled`、f30 `model_family_metadata`、f23 `model_info`。
- 同日实测：337 条原生里 f6 为 1 的 **0 条**；白名单一旦存在该兜底本就不参与判定。整条链路（`payload.cjs` 读取 → `native-entry.cjs` 归一/合并 → `native-models.cjs` 透传 → `panel-state.cjs` 兜底）已删除，`pickerListed`（排序区 label 判定，与 f6 无关）保留。

## Fast Mode 正交性的原始测量（2026-10-15，已从契约卷移入）

真机 40 个 `(Lead 值, Effort 值)` 组合**全部**同时存在 `Fast Mode=0` 与 `=1`，两者 Lead/Effort 值完全相同。按「fast 兄弟单列」实现时产生了 `Claude Opus 5` / `Claude Opus 5.5` 两组同名 label，用户无从分辨——这是「必须并入官方族」这条契约的来源。

## Devin 3.15.14 的目录形状变化（2026-11-26）

- 版本 3.15.14（changelog 11-25）。CLI 缓存 `b023` 从 1,770,096 B 掉到 938,492 B，`GetCliTeamSettings` 的 `allowed_model_uids` 从 1338 条降到 780 条，被重写的条目从 420→245。`GetUserStatus` 的原生面仍是 319 条（gpt134/claude78/gemini28/swe27/glm12/kimi9/deepseek8/grok8/nemotron8/muse6/other1），没变——只有 `GetCliModelConfigs` 这条面缩了。
- **新增 15 条 `fusion-sidekick-<uid>` 条目**（`kind=6`、`isModelRouter=true`、label `Fusion Sidekick (…)`，如 `fusion-sidekick-swe-2-1-medium`），= 11 个官方 Sidekick + 4 个 `-priority` 快档孪生。`SWE-2.1 Medium` 自此进入官方 Sidekick 名单，官方组合 `fusion-claude-opus-5-5-medium-sidekick-swe-2-1-medium` 等 26 条把 Claude 家族与它配对。
- **当时的「双序位」是我的误判（2026-11-26 当天订正）**：`native-cache.json` 里同一 Sidekick 名字出现两个 order，看起来像官方的 per-Lead 位置。实测当前两份载荷（`b023` + `ca58`，排除 dfbyok）：`GLM-5.2 High` 恒为 7、`Claude Sonnet 5.5 Medium` 恒为 8、`Claude Haiku 5.5 Medium` 恒为 9、`GPT-5.6 Sol High` 恒为 6、`SWE-2.1 Medium` 恒为 10。多出来的那一个 order 全部是 11 条**我们自己镜像出去的** native×native 条目（uid 形如 `fusion-<native lead>-sidekick-<sidekick>`，不带 dfbyok，因此被当成原生观测），外加已从官方目录消失的陈旧组合（如 `fusion-claude-fable-5-1-medium-sidekick-glm-5-2`，两份载荷里都不存在）。
- **事故**：旧的 `discoverOfficialRoles` 把「两个 uid 抢同一 order」和「同一 uid 两个 order」都当冲突，并连坐该 order 的所有 claimant。3.15.14 的 6→10 号挤在一起，级联下来 11 个官方 Sidekick 只剩 5 个：`swe-2-1-medium` 与 `claude-haiku-5-5-medium` 抢 10 号，双方都被判死。后果是 `buildCatalog` 不再发射任何 `BYOK × SWE-2.1` 组合（矩阵从 687 条掉到 447 条自有条目，官方 picker 里能看见 `Fusion Sidekick (SWE-2.1 Medium)`，但选不出 BYOK Lead + SWE-2.1）。
- **修法**（同日）：uid 代表 order 取「组合多数、平票取小」，只有**名字**不一致才判死该 uid（两个名字无法并成一个 picker 值）；不同 uid 抢同一 order 留到发射阶段消解——先进者保官方数字，其余进原生段但保留官方名字。改后实测：原生 Sidekick 11 个、`BYOK × swe-2-1-medium` 9 条条目、（Lead, Effort）组内 0 个重名冲突、发射条目 245→365。
- 早前记录过的「官方 Fusion 组合从不引用 `swe-2-1`」（11-25）到此失效——那是 3.14 的目录。凡「官方从不 X」这类否定结论都要带版本号与日期。
- **灰掉的第二行是我们造的，已修**：BYOK Lead 下 `GLM-5.2 High` 两行（官方 7 灰、8 可选），因为旧代码按「多数」取了 8——而多数是被陈旧行与自镜像抬上去的。修法两处：代表 order 改成取**最小**声称值；同步官方预设（见下节）。

## 官方预设只同步、不自留（2026-11-26）

- `native-cache.json` 是**观测缓存**，不是用户状态：官方目录一变，条目就该跟着变。旧实现只做并集，于是官方已下线的组合一直留在缓存里继续投票（`fusion-claude-fable-5-1-medium-sidekick-glm-5-2` 这类），最终把维度 order 抬到错误的值。
- 现在 `GetCliModelConfigs`（完整可选目录）到达时，`fusion-*` 条目按批次**整体同步**：本批没有的 fusion 条目从观测里删除，普通原生条目仍取并集（entitlement 通道会带平目录里没有的行）。用户状态不在缓存里——启用/禁用由扩展配置持有，存活条目的 `disabled` 直接跟官方最新值走。
- 另一条污染源是**自镜像**：我们发射的 native×native 组合 uid 与官方同形，CLI 缓存回读时会当成原生观测。现在 bridge 把上一份目录的 `matrixUids` 通过 `onEmitted` 交给 backend，ingest 时直接跳过这些 uid。

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

## 已下线与零匹配项（2026-11-25 核对）

- `swe-1-7-lightning`、`swe-1-7-lightning-medium`、`swe-1-6-fast` 已从目录消失（不是 disabled）：11-17 的 v6/v7 备份里就已经没有，8 月中到 11-17 之间下线；11-18 → 11-25 这一周下架 0 条、新增 21 条（SWE-2.1 全族 12 条、SWE-2 Flash 3 条 lightning、Gemini 4 Neon 4 条、Nemotron 3.5 Lightning 2 条）。
- 文档同步删掉了 SWE-1.7 Lightning，但企业版法语镜像页仍留着过期文本；Cognition API 的 `cognition/swe-1.7-lightning` 仍在售——两者都不能证明客户端 picker 里还有它。
- 旧白名单外示例 `gpt-5-3-codex-spark-medium` 也已不在目录；现成反例是仅 entitlement 来源的 `MODEL_GPT_OSS_120B` 与 `pudding-jelly-*`。
- vendor 词表清理记录：`Mistral`/`Meta`/`Alibaba`/`MiniMax` 四行当时各 0 族，`o[0-9]`、`codex`、`chatgpt`、`xai`、`MODEL_DEVIN`、`devin` 零匹配，已删除；`MODEL_(?:CHAT_)?GPT`（保 `MODEL_GPT_OSS_120B`）与 `arena`（保 `arena-*`）必须留。

## 缓存代际与旧观测面

- 2026-10-24 实测：删掉全部 `model_configs` 只会让 **当时当前的 v6** 代际回来（两个身份、一分钟内），v1–v5 不会自愈，触发路径未确认——所以禁止改名/删除，只能在原地重写。
- 2026-11-25：活动代际是 **v7**（`model_configs_v7.b0239737b4184efa.bin` 与 `…ca58930127d504dd.bin` 两份，同属两个登录身份；`b023` 含我方条目，`ca58` 是纯官方）。
- `GetCascadeModelConfigs` 在当前流量里从未出现（2026-10-15 记录）；`GetCommandModelConfigs` 同样从未出现（来源只有 `cli`/`entitlement`），2026-11-25 已从观测面与 bridge 的 catalog 正则里移除，请求改为逐字节透传。`src/activation/native-contract.cjs` 的 LS 标记表**不跟着改**——那是探测 Devin 二进制用的，不是我们的兼容面。
