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

## Fusion 维度容器与两个未读字段（2026-11-25）

- 角色维度在 f30 `ModelFamilyMetadata`：`{label=f1, entries=f2{key=f1, value=f2{order=f1, name=f2, control_type=f3}}}`，与 `payload.cjs` / `codec.cjs` 的读与写逐项一致。同日核对同源的另两处：`UserStatus.f33 = cascade_model_config_data`（bridge 的注入路径）、`GetCliTeamSettingsResponse.f7 = allowed_model_uids`（实测 b023 1758 条 / ca58 1338 条，与目录逐条相等；f3 `disable_fast_context`、f4 `cascade_web_search_enabled` 也被 `fast-context` 读）。
- f30 维度 key 实测分布（ca58 1338 条）：`Fast Mode` 1238、`Effort` 1085、`Lead`/`Sidekick`/`Recommended Sidekick` 各 995、`Reasoning Effort` 225、`Prompt Cache Retention` 134、`1M Context` 90、`Thinking` 78、`Speed` 1。
- **f32 `model_dimensions` 不是角色维度容器**：1319 条有值，内容是按 token 计价的维度行（`Input`/`Cached input`/`Output`/`Sidekick input`/`Free` 等；内层 f2/f4/f5 是 double、f6 bool、f7 string）。零读取是安全的，**不要**把它当 Lead/Sidekick/Fast Mode 的备份来源。
- **f21 `fast_status{is_active=f1, tooltip=f2}` 在 schema 里存在，但今天 0 条有值**（两份缓存均为 0，f6 同样 0）。Fast Mode 判定只能继续吃 f30 的 `Fast Mode` 维度；只有 f21 开始有值时才考虑把它并入观测。

## 已下线与零匹配项（2026-11-25 核对）

- `swe-1-7-lightning`、`swe-1-7-lightning-medium`、`swe-1-6-fast` 已从目录消失（不是 disabled）：11-17 的 v6/v7 备份里就已经没有，8 月中到 11-17 之间下线；11-18 → 11-25 这一周下架 0 条、新增 21 条（SWE-2.1 全族 12 条、SWE-2 Flash 3 条 lightning、Gemini 4 Neon 4 条、Nemotron 3.5 Lightning 2 条）。
- 文档同步删掉了 SWE-1.7 Lightning，但企业版法语镜像页仍留着过期文本；Cognition API 的 `cognition/swe-1.7-lightning` 仍在售——两者都不能证明客户端 picker 里还有它。
- 旧白名单外示例 `gpt-5-3-codex-spark-medium` 也已不在目录；现成反例是仅 entitlement 来源的 `MODEL_GPT_OSS_120B` 与 `pudding-jelly-*`。
- vendor 词表清理记录：`Mistral`/`Meta`/`Alibaba`/`MiniMax` 四行当时各 0 族，`o[0-9]`、`codex`、`chatgpt`、`xai`、`MODEL_DEVIN`、`devin` 零匹配，已删除；`MODEL_(?:CHAT_)?GPT`（保 `MODEL_GPT_OSS_120B`）与 `arena`（保 `arena-*`）必须留。

## 缓存代际与旧观测面

- 2026-10-24 实测：删掉全部 `model_configs` 只会让 **当时当前的 v6** 代际回来（两个身份、一分钟内），v1–v5 不会自愈，触发路径未确认——所以禁止改名/删除，只能在原地重写。
- 2026-11-25：活动代际是 **v7**（`model_configs_v7.b0239737b4184efa.bin` 与 `…ca58930127d504dd.bin` 两份，同属两个登录身份；`b023` 含我方条目，`ca58` 是纯官方）。
- `GetCascadeModelConfigs` 在当前流量里从未出现（2026-10-15 记录）；`GetCommandModelConfigs` 同样从未出现（来源只有 `cli`/`entitlement`），2026-11-25 已从观测面与 bridge 的 catalog 正则里移除，请求改为逐字节透传。`src/activation/native-contract.cjs` 的 LS 标记表**不跟着改**——那是探测 Devin 二进制用的，不是我们的兼容面。
