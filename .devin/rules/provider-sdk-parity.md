---
trigger: model_decision
description: "Apply when judging whether a provider wire field is legitimate, updating the .refs SDK copies, or wondering why an SDK capability we could send is deliberately omitted — SDK parity baseline, the fields native cannot express, and why REA does not govern this layer."
---

# 供应商 SDK 对照（provider-sdk-parity）

## 基线版本（2026-10-24 更新）

| 包 | `.refs/` 目录 | 版本 | tag | commit |
| --- | --- | --- | --- | --- |
| `@anthropic-ai/sdk` | `anthropic-sdk-typescript` | **1.3.0** | `sdk-v1.3.0` | `cb5fba41` |
| `openai` | `openai-node` | **7.43.0** | `v7.43.0` | `d02d4de7` |

参照物（不是我们的对照实现）：Devin.app 自带 **`@anthropic-ai/sdk 0.82.0`**，**没有** `openai`。

## 更新方式：必须是 git 克隆，不能是 npm tarball

`test/sdk-contract.test.cjs` 读的是 `src/resources/messages/messages.ts` 这类 **TypeScript 源码**；npm 包里只有编译产物（`resources/*.mjs` 与 `.d.mts`），**没有 `src/`**——拿 tarball 覆盖会让契约测试解析不出而红。

```bash
HTTPS_PROXY=http://127.0.0.1:7897 git -C .refs/<repo> fetch --tags origin
git -C .refs/<repo> checkout <tag>
node --test test/sdk-contract.test.cjs     # 判据：pass 全绿且 skipped 0
```

`skipped` 的含义是「`.refs` 不存在」（CI 上就是这样），**全绿但 skip 没有信息量**；「文件在、却解析不出」必须**失败**。更新完把新版本号回填到本卷表格与 `testing-notes.md` 的同一段落。

## 我们发出的字段：三协议逐条合法

已对 1.1.0 / 1.3.0（以及 Devin 自带 0.82.0 的稳定面）分别核过，**没有一处非法或多余字段**。

| 协议 | 我们发送的顶层字段 | 说明 |
| --- | --- | --- |
| Anthropic Messages | `model` `max_tokens` `messages` `stream` `system`（字符串）`output_config.effort` `tools[]` `tool_choice` | `effort` 联合 `low\|medium\|high\|xhigh\|max` 与 SDK 逐字相同；`minimal` 已映射为 `low`，未知值拒收（契约测试钉住） |
| Anthropic 内容块 | `text` `image{source:{type:base64}}` `document{source:{type:text,media_type:'text/plain'}}` `thinking` `redacted_thinking{data}` `tool_use` `tool_result{is_error}` | 与 `PlainTextSource` / `Base64PDFSource` 形状一致 |
| Chat Completions | `system` 角色 `tool` 角色 + `tool_call_id` `file{file_data,filename}` `max_completion_tokens` `stream_options.include_usage` `prompt_cache_key` `parallel_tool_calls` `reasoning_effort` `tool_choice{type:'function'}` | `file_data` 传**裸 base64**（SDK 注释原文：base64 encoded file data），不加 data URL 前缀 |
| Responses | `developer` 角色 `input_file` `function_call`/`custom_tool_call`（含 `*_output`）`store:false` `include:['reasoning.encrypted_content']` `reasoning{effort,summary:'auto'}` `max_output_tokens` `tools[].strict` | `store:false` + `encrypted_content` 是配套要求；`summary:'auto'` 在 `Shared.Reasoning` 联合内 |

**两条别顺手「统一升级」的**：Chat 用 `system` 角色、只有 Responses 用 `developer`——Chat 兼容面窄，很多第三方网关只认 `system`；`file_data` 的裸 base64 也不是疏漏。

## 刻意不发：SDK 有、原生无法表达

判据是「ACP 请求里有没有对应控制位」。没有控制位就不发——发了等于替用户做决定，且第三方兼容网关更容易 400。

| SDK 字段 | 原生有无对应 | 结论 |
| --- | --- | --- |
| Anthropic `thinking`（`budget_tokens` / `adaptive`） | 无 | 不请求扩展思考。`output_config.effort` 是**力度**，不等于开启思考；`anthropic.cjs` 的 thinking/signature/redacted 回放只在**上游自己吐**时才走到 |
| Anthropic `cache_control`（缓存断点） | **已实现**（见下节） | 由 `prompt_cache_key` 驱动，带 400 因果降级 |
| OpenAI `verbosity` / `text.verbosity` | 无 | 力度已由目录里的 effort 变体表达 |
| `prompt_cache_options` / `prompt_cache_retention` / `prompt_cache_breakpoint` | 无 | 默认即 implicit 缓存，行为等价；这些新字段第三方网关普遍不认 |
| `max_tool_calls`（7.43 新增） | 无 | 不设上限 |
| `safety_identifier` / `metadata.user_id` | 无 | 不从账号数据反推身份 |
| `text.format`（结构化输出） | 无 | 原生工具已用 JSON schema，不需要额外输出格式 |

## 原生唯一的缓存信号是 `GetChatMessageRequest#27`

`prompt_cache_key` 原样转发给 OpenAI（自动缓存即生效）。**Anthropic 没有等价参数**——它的缓存必须靠显式 `cache_control: {type:'ephemeral'}` 断点，否则每轮全价重发整段历史。

**现在的实现**（`anthropic.cjs` 的 `buildAnthropicBody` 第 4 参 `options.cacheBreakpoints`）：

- 仅当 `options.cacheBreakpoints === true` **且** 原生给了 f27 **且** 合并后的 `messages.length >= 2` 时打**一个**断点
- 落点：**倒数第二条**消息里最后一个 `text`/`tool_result`/`tool_use`/`image`/`document` 块；**绝不打在最后一条**（那是本轮新内容，写不进缓存）
- 只打在消息块上就够：Anthropic 的前缀顺序是 **tools → system → messages**，断点缓存「该块之前的一切」，因此一个消息级断点同时覆盖工具定义与 system，**不必**把 `system` 改成数组形态

**降级：不靠关键词，靠因果**

打点后收到 400 → 剥掉全部 `cache_control`（`stripCacheControl`）**重试一次**：

- 重试**成功** ⇒ 就是断点导致的 ⇒ 把该 provider 写进 `<存储根>/provider-cache.json` 持久标记，此后不再打点，并记 `cache-breakpoint-disabled`（一次性，不每轮刷）
- 重试**仍失败** ⇒ 与断点无关（上下文超限、参数错），照原样以 `upstream_http` 抛出，**不标记**

之所以不用关键词匹配（现有 `tool_choice` / `store|include` 两条分支是关键词门控的）：网关拒绝措辞五花八门，猜错等于「以为降级了其实没降」。因果判定不需要维护词表，也不会被措辞变更悄悄打破。

**状态文件纪律**：键是 `sha256(JSON.stringify([provider.id, provider.baseUrl]))`，文件里**不出现 apiKey、也不出现 baseUrl 明文**；上限 32 条按时间淘汰；临时文件 + `rename` 原子写，权限 `0o600`；缺失/非法 JSON/版本不符一律按空状态（全放行），不抛。用户改 `baseUrl` 会导致键变化，能力**自动重评**，无需清理逻辑。

**尚未验证的事实（不要写成结论）**：生效判据是真实 provider 上 `cache_read_input_tokens` / `cache_creation_input_tokens` 从 0 变为非 0——这两个数我们已经在读并入库，但**截至本卷更新时还没有真实观测数据**。写任何「已生效」的断言前先拿到该数据。实测边界（2026-10-25，DeepSeek）：DeepSeek 的 anthropic 面忽略该字段（带/不带断点用量完全一致），其自动缓存独立生效；所以「缓存计数变为非 0」只有在真 Anthropic 端点上才算断点生效的证据。

## 为什么 REA 在这一层不适用（重要）

「冲突时以本机 REA 为准」只对 **ACP 字段号**成立，对 provider 线格式**不成立**，因为原生侧根本没有这条线：

| 检索项 | 194 MB CLI 二进制命中 |
| --- | --- |
| `anthropic-version`、`cache_control`、`anthropic-beta`、`budget_tokens`、`output_config`、`max_completion_tokens`、`stream_options` | **全部 0** |
| `reasoning_effort` / `prompt_cache_key` / `verbosity` | 4 / 11 / 25（是它自己的模型配置与 ACP 面，不是 HTTP 请求构造） |

也就是说：原生不跟这两家 API 说话，**漏了字段也没有补偿层**；字段合法性只能以 SDK/API 为准。

## 版本间实际变化（2026-10-24 实测）

- **anthropic 1.1.0 → 1.3.0**：`messages.ts` 只有文档注释改动（22 增 5 删），`MessageCreateParamsBase` 字段**零增删**；`StopReason` 未变。
- **openai 7.41.0 → 7.43.0**：`ResponseCreateParamsBase` 仅新增 `max_tool_calls`；`ResponseStreamEvent` 联合**零增删**；`shared.ts` 新增带 `detail?: 'low'|'high'|'auto'|'original'` 的 `input_image` 形状（我们已符合，`detail` 可选）。
- 结论：两次升级对我们的发送面**零动作**，契约测试 10/10 绿且 `skipped 0`。

## 纪律

- 改 `src/protocol/*` 的发送面之前，先读 `provider-measurements.md`（实测事实）与本卷（合法性/该不该发）。
- 新增字段的唯一正当理由是「原生给了对应控制位」，不是「SDK 加了」。
- 任何「我们发的字段 SDK 里没有」都视为缺陷；反之（SDK 有而我们不发）先查本卷的刻意不发表，别当成缺漏。
- provider 侧的「能自愈的 400」目前只有三种：`tool_choice`、Responses 的 `store|include`、以及 Anthropic 的 `cache_control`。前两者语义面小、可按关键词判定；新增同类降级时优先用**因果判定**（改动后重试成功才算该因子导致），不要继续堆关键词。
