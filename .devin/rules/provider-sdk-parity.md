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
| Anthropic `cache_control`（缓存断点） | **部分**：只有 `prompt_cache_key` | 见下一节，这是唯一真有成本差的缺口 |
| OpenAI `verbosity` / `text.verbosity` | 无 | 力度已由目录里的 effort 变体表达 |
| `prompt_cache_options` / `prompt_cache_retention` / `prompt_cache_breakpoint` | 无 | 默认即 implicit 缓存，行为等价；这些新字段第三方网关普遍不认 |
| `max_tool_calls`（7.43 新增） | 无 | 不设上限 |
| `safety_identifier` / `metadata.user_id` | 无 | 不从账号数据反推身份 |
| `text.format`（结构化输出） | 无 | 原生工具已用 JSON schema，不需要额外输出格式 |

## 原生唯一的缓存信号是 `GetChatMessageRequest#27`

`prompt_cache_key` 我们原样转发给 OpenAI（自动缓存即生效）。**Anthropic 没有等价参数**——它的缓存只能靠显式 `cache_control: {type:'ephemeral'}` 断点，所以我们发过去的每一轮都是全价重发整段历史。

证据是我们自己已经读的两个数：`cache_read_input_tokens` / `cache_creation_input_tokens` 在 Anthropic 上**恒为 0**，而同样的计数器在 OpenAI 侧非 0。要把 f27 翻译成 Anthropic 断点属于**行为变更**，不是对齐：须先定「网关不认 400 时退回不发」的降级判据，并靠上述两个计数验证生效。

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
