---
trigger: model_decision
description: "排查「这个数字/结论是哪来的」、核对已下线模型、缓存代际或旧观测面时必读——目录与 picker 侧的带日期实测证据，非契约。"
---

# 目录与 picker 的历史取证（catalog-and-picker-forensics）

契约面在 `catalog-and-picker.md`；本卷只放**带日期的实测数字与事故记录**。数字会过期，契约不会——判据以契约卷为准，本卷用于回答「为什么当初这样定」。Fusion 矩阵与角色侧的同类证据已分卷到 `fusion-matrix-forensics.md`。
## 2026-11-25 目录快照（当前基线）

- CLI 目录 329 个原生条目；合并 entitlement 观测后 337 条（多出 `MODEL_GPT_OSS_120B`、`arena-{smart,fast,mixed}`、`pudding-jelly-{low,medium,high,max}` 共 8 条）。
- 按 uid 档位 token 归出 78 个族基；按 `familyUid` 聚成 70 个设置页家族（无该字段者各自成单成员族）。
- 角色池：Lead 59 行、Sidekick 304 行、不可用行 0 条。
- 官方 Fusion：纯官方身份 1009 条；带 BYOK 注入的身份 1108 条（多出 99 条我方 native×native）。
- 组合端点：111 个不同 Lead、14 个不同 Sidekick，**全部带 harness**；另有 41 个端点不在原生列表里，全部是 `-fast` 双胞胎（`claude-fable-5-1-high-fast`、`gpt-6-sol-high-fast` 等）。
- 原生维度实际出现 10 个 key：`Effort`、`Reasoning Effort`、`Thinking`、`1M Context`、`Prompt Cache Retention`、`Fast Mode`、`Speed`（仅 `swe-1-6`）、`Lead`、`Sidekick`、`Recommended Sidekick`。
- 原生 harness 实际出现 9 个：`fusion`、`gemini-3-pro`、`gpt-5p4-persistent`、`gpt-5p6`、`gpt-5p6-codex`、`strawberry-pancake`、`swe-1p5`、`swe-1p6`、`swe-1p6-exec`。
- 观测来源只有 `cli` 与 `entitlement`。

## 顶层 f6 = `supports_legacy`（曾被当成 picker `listed` 标记）

- 旧读法：f6=1 曾按经验当作「picker 仍列出的退役 entitlement 行」（GPT-4.1/GPT-4o 有、o3 无），面板在**白名单尚未落地**时用它把这类行显示出来。`listed` 是我们起的代理名，不是字段真名。
- 2026-11-25 权威字段表（已安装 Devin 3.14.30833 的 `sessions.desktop.main.js` 里的 protobuf-es descriptor，`grep -abo` 取偏移 + `dd` 读窗口）：`exa.codeium_common_pb.ClientModelConfig` 的 **f6 = `supports_legacy`（bool）**；全表里没有 `listed`。同表核对一致：f22 `model_uid`、f4 `disabled`、f30 `model_family_metadata`、f23 `model_info`。
- 同日实测：337 条原生里 f6 为 1 的 **0 条**；白名单一旦存在该兜底本就不参与判定。整条链路（`payload.cjs` 读取 → `native-entry.cjs` 归一/合并 → `native-models.cjs` 透传 → `panel-state.cjs` 兜底）已删除，`pickerListed`（排序区 label 判定，与 f6 无关）保留。

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

## 已下线与零匹配项（2026-11-25 核对）

- `swe-1-7-lightning`、`swe-1-7-lightning-medium`、`swe-1-6-fast` 已从目录消失（不是 disabled）：11-17 的 v6/v7 备份里就已经没有，8 月中到 11-17 之间下线；11-18 → 11-25 这一周下架 0 条、新增 21 条（SWE-2.1 全族 12 条、SWE-2 Flash 3 条 lightning、Gemini 4 Neon 4 条、Nemotron 3.5 Lightning 2 条）。
- 文档同步删掉了 SWE-1.7 Lightning，但企业版法语镜像页仍留着过期文本；Cognition API 的 `cognition/swe-1.7-lightning` 仍在售——两者都不能证明客户端 picker 里还有它。
- 旧白名单外示例 `gpt-5-3-codex-spark-medium` 也已不在目录；现成反例是仅 entitlement 来源的 `MODEL_GPT_OSS_120B` 与 `pudding-jelly-*`。
- vendor 词表清理记录：`Mistral`/`Meta`/`Alibaba`/`MiniMax` 四行当时各 0 族，`o[0-9]`、`codex`、`chatgpt`、`xai`、`MODEL_DEVIN`、`devin` 零匹配，已删除；`MODEL_(?:CHAT_)?GPT`（保 `MODEL_GPT_OSS_120B`）与 `arena`（保 `arena-*`）必须留。

## 缓存代际与旧观测面

- 2026-10-24 实测：删掉全部 `model_configs` 只会让 **当时当前的 v6** 代际回来（两个身份、一分钟内），v1–v5 不会自愈，触发路径未确认——所以禁止改名/删除，只能在原地重写。
- 2026-11-25：活动代际是 **v7**（`model_configs_v7.b0239737b4184efa.bin` 与 `…ca58930127d504dd.bin` 两份，同属两个登录身份；`b023` 含我方条目，`ca58` 是纯官方）。
- `GetCascadeModelConfigs` 在当前流量里从未出现（2026-10-15 记录）；`GetCommandModelConfigs` 同样从未出现（来源只有 `cli`/`entitlement`），2026-11-25 已从观测面与 bridge 的 catalog 正则里移除，请求改为逐字节透传。`src/activation/native-contract.cjs` 的 LS 标记表**不跟着改**——那是探测 Devin 二进制用的，不是我们的兼容面。

## 契约卷移入的实测片段（2026-11-27 自 catalog-and-picker.md 逐字搬移）

**picker 可见性与 CLI 渲染器**

- picker 可见性契约的取证归属：2026-10-15 逆向 + App bundle 源码坐实；内层 f22 是 proto `DisplayOption` 枚举由 `windsurf-chat-client` 的 `nuk`/`nuM`/`niH` 过滤器坐实。
- `8 MODERN_AGENT_CHAT` 在 CLI 侧非 Devin Local 环境还会被 `nuj` 压成 disabled（「Devin Local only」；该串在桌面 bundle 里检索不到）；`3 MODEL_ROUTER` 的混入由 `nuq` 的 `isFeatured`=整组 MODEL_ROUTER（即官方推荐组）实现。
- 渲染引擎要点（`nr3`/`nr8`/`nio`，CLI 侧渲染器；桌面 webapp-host 走 displayOption 过滤，两套别混用）：维度值按 order 首见去重、**「恰好 2 个无名值」即开关**（官方不看 controlType，Fast Mode 只写 order 即开关）、disabled 家族成员自动落到最近可用兄弟、代表模型按 pinned>选中>isDefaultModelInFamily>首个取。官方客户端 picker 只做「维度元组→uid」查表（`nr6`，无匹配静默不切换）。

**Lead/Sidekick 门槛与 emit 字段**

- 成员 lead 无自带 harness 也可当 lead（实测 29 个）；sidekick 必须自带（实测 11/11）。
- 发射侧此前一律只写 `['fusion']`，与契约不一致，2026-10-16 修正（实测 336 条 native-Lead 组合各补 Lead harness、112 条 BYOK-Lead 保持 `['fusion']`；改前官方 586 个可解析样本该规则 **390/390 零例外**）。
- 字段级实测出处：2026-11-25 解 CLI 缓存 `model_configs_v7.*.bin`。`f4 = 声明窗口`（官方原生值 262000/1000000/200000 与其真实窗口精确相等；我方 BYOK 发 1024000）。

**陈旧条目与维度 order 事故**

- 按缺席删除的代价（2026-10-14 实测：`bak` 24 条 vs 现文件 155 条）；emit 集合随原生 Sidekick 维度时序在 24↔155 波动，按缺席删除一次就静默删掉 131 条有效组合。
- `known` 缺席的静默回退（2026-10-15 真机复现：缺 `known` 误判 1 条，三参齐全 0 条）。
- 2026-10-14 order 事故：当年「20+index」/按名排名把同一 order 发给不同名字（实测三名共占 order 20、BYOK lead 被隐藏）。
- 判别指纹只读 f32（2026-10-16 给组合条目补 Lead harness 后实测陈旧判定零影响，`harnessUids` 与 `maxTokens` 都不参与）。

**家族标签与计数**

- label 不剥 `Lightning`/`Ultrafast` 的反例叙述：`Nemotron 3.5 Lightning` 的 `Lightning` 属于家族名，剥了就与 `Nemotron 3.5` 撞族；`SWE-1.7 Lightning` 已下线，不再作反例。
- 同一族在两处会差 1：设置页按服务器家族计 SWE-2.1 **12** 条，Fusion 按 uid 档位基计 **11** 条——裸 `swe-2-1-lightning` 自成基且成员全 fast 被滤掉，这是正常现象而非漏算。

**日期归属备查**：筛选胶囊语义定于 2026-10-29；「准入层在 f7 之上」为 2026-11-17 实测。
