---
description: ACP 协议 protobuf 字段号的权威出处与已核对字段表——改 src/protocol/* 的字段号、核对原生请求/响应/用量字段、怀疑某字段没被送出或读回时必读
trigger: model_decision
---

# ACP 协议字段号

`src/protocol/*` 收发的 protobuf 消息属于 Devin 私有协议（`exa.api_server_pb` / `exa.chat_pb`），**字段号没有公开 schema，不要靠猜**。权威来源是 Devin.app 打包产物里的 protobuf-es `newFieldList` 字面量。

## 怎么读权威字段号

protobuf-es 生成的代码把每个消息的字段表写成字面量，形如 `{no:3, name:"delta_text", kind:"scalar", T:9, ...}`。

```bash
# 在 bundle 里定位字段名的字节偏移
grep -abo 'name:"delta_signature"' \
  /Applications/Devin.app/Contents/Resources/app/out/vs/sessions/sessions.desktop.main.js
# 从偏移处起读 N 字节，得到含字段号/类型/名字的 newFieldList 段
tail -c +<偏移> <bundle> | head -c 600
```

- 主要 bundle：`out/vs/sessions/sessions.desktop.main.js`（会话侧消息）、`out/vs/workbench/workbench.desktop.main.js`（工作台侧）。
- `extensions/windsurf/bin/language_server_macos_arm`（或对应架构二进制）内嵌 proto **描述符**：`grep -a` 能查字段名，但**不含字段号**，只能佐证存在性。
- 两次实测回本：StopReason 枚举、`GetChatMessageResponse` 全部字段均由该方法逐字段读出。

## 出站：`exa.api_server_pb.GetChatMessageResponse`（chunk 全集）

下表是**逐字段读出的完整 28 个字段**（由 `sessions.desktop.main.js` 的 `newFieldList` 原文核出；早期读数 23，当前安装版 schema 已扩到 28），不是只列我们用到的那几个——只列子集曾让人以为「字段号不连续」。

| 号 | 字段 | 类型 | 本仓用法 |
| --- | --- | --- | --- |
| 1 | `message_id` | string | — |
| 2 | `timestamp` | Timestamp | — |
| 3 | `delta_text` | string | ✓ `textChunk` |
| 4 | `delta_tokens` | int32 | — |
| 5 | `stop_reason` | enum StopReason | ✓ `stopChunk` |
| 6 | `delta_tool_calls` | repeated ChatToolCall | ✓ `toolChunk` |
| 7 | `usage` | ModelUsageStats | ✓ `usageChunk` |
| 8 | `redact` | bool | — |
| 9 | `delta_thinking` | string | ✓ `thinkingChunk` |
| 10 | `delta_signature` | string | ✓ `signatureChunk`（anthropic `signature_delta`） |
| 11 | `thinking_redacted` | bool | ✓ `redactedThinkingChunk`，**无载荷字段** |
| 12 | `latency` | double | — |
| 13 | `completion_profile` | CompletionProfile | — |
| 14 | `credit_cost` | double | — |
| 15 | `output_id` | string | — |
| 16 | `thinking_id` | string | — |
| 17 | `request_id` | string | — |
| 18 | `committed_credit_cost` | double | — |
| 19 | `prompt` | string | — |
| 20 | `gemini_thought_signature` | bytes | — |
| 21 | `delta_signature_type` | string | 未发；**已证不需要**，见下 |
| 22 | `committed_acu_cost` | double | — |
| 23 | `actual_model_uid` | string | ✓ `stopChunk` 尾部 |
| 24 | `arena_invocation_cap_reached` | bool | — |
| 25 | `phase` | string | — |
| 26 | `committed_quota_cost_basis_points` | int64 optional | — |
| 27 | `committed_overage_cost_cents` | int64 optional | — |
| 28 | `response_dimension_groups` | repeated message | — |

## 入站：`exa.chat_pb.ChatMessagePrompt`（请求侧，已由 `parseChat` 消费）

完整 21 个字段（`sessions.desktop.main.js` 偏移 6258731 处核出）：

| 号 | 字段 | 类型 |
| --- | --- | --- |
| 3 | `prompt` | string |
| 6 | `tool_calls` | repeated ChatToolCall |
| 7 | `tool_call_id` | string |
| 9 | `tool_result_is_error` | bool |
| 10 | `images` | repeated ImageData |
| 11 | `thinking` | string |
| 12 | `signature` | string |
| **13** | `thinking_redacted` | **bool** |
| 15 | `output_id` | string |
| 16 | `thinking_id` | string |
| 17 | `gemini_thought_signature` | bytes |
| 18 | `signature_type` | string |
| 19 | `phase` | string |

（其余为 `message_id`/`source`/`num_tokens`/`safe_for_code_telemetry`/`prompt_cache_options`/`prompt_annotation_ranges`/`videos`/`documents`。）

## 入站补充：`GetChatMessageRequest` 与 `ChatToolDefinition`

- `GetChatMessageRequest` **字段 11 `disable_parallel_tool_calls`**（bool）：`parseChat` 归一为 `disableParallelToolCalls`（默认 false，JSON 兼容 `disableParallelToolCalls`/`disable_parallel_tool_calls`）。仅当显式 `true` 才出站：OpenAI 两路 → `parallel_tool_calls:false`；Anthropic → `tool_choice.disable_parallel_tool_use:true`（choice 缺省时补 `{type:'auto',disable_parallel_tool_use:true}`；`type:'none'` 保持纯净不附加）。
- `ChatToolDefinition` **字段 12 `strict`**（bool）：归一为 `tool.strict`。字段表原文是 `{no:12,name:"strict",kind:"scalar",T:8}`——**没有 `opt:!0`**，即普通 proto3 bool，**无法区分「未设置」与「显式 false」**，两者在原生侧都是 `false`。
- **`strict` 与 `disable_parallel_tool_calls` 的出站策略刻意不同**：
  - `strict`：OpenAI 两路（`openai` / `openai-responses`）**始终**写布尔 `strict: tool.strict === true`。理由是官方 Responses SDK 明说「省略 `strict` 时会尝试启用严格校验」（`strict?: boolean \| null` 的注释原文），所以「省略」≠「原生 false」，无法表达原生意图；Anthropic 仍只在 `true` 时写顶层 `strict:true`（Anthropic 没有这种「省略即自动严格」的语义）。
  - `disable_parallel_tool_calls`：**只透传显式 `true`**，默认/未设置时不在 body 里写厂商字段，保持对老网关的兼容。
- 实测（2026-10-16，真实端点）：`strict:false` 与省略 strict 两种写法在 DeepSeek `deepseek-flash`（responses）与 Moonshot `kimi-k2.6`（chat）上**都是 200**，参数键均为 `["source"]` 且无空串值（`{path, source}` 二选一 schema）。
- `ChatToolDefinition` **字段 9/10/11 自定义工具**（2026-10-16 登记）：`{no:9,name:"is_custom_tool",kind:"scalar",T:8,opt:!0}`、`{no:10,name:"custom_tool_grammar",T:9,opt:!0}`、`{no:11,name:"custom_tool_grammar_syntax",T:9,opt:!0}`——**三者都带 `opt:!0`**（可选），与上面无 `opt` 的 `strict` 不同：`is_custom_tool` 是 optional bool，两字符串字段缺省为 `''`（JSON/proto 两侧归一为 `isCustomTool`/`customToolGrammar`/`customToolGrammarSyntax`，字符串缺席落 `''` 以保 parity）。出站：仅 `openai-responses` 且 `isCustomTool === true` → `{type:'custom',name,[description]}`；`grammar` 与 `syntax` **同时存在**且 syntax 恰为 `'lark'`/`'regex'` 时才附 `format:{type:'grammar',definition,syntax}`，否则无 `format`（官方 SDK 默认无约束文本，不猜默认值）；`openai`/`anthropic` 无此类型，仍为 function 形态。响应侧 `custom_tool_call` 的 `input` 是**原始字符串**（非 JSON），`response.custom_tool_call_input.delta`（`delta` 字段）/`.done`（`input` 字段）只按字符串校验、跳过 `JSON.parse`，原样进 ACP 工具块。

## ⚠️ 陷阱：`CompletionDelta` 是**另一个消息**，字段号整体错位

同一个 bundle 里还有一个 `exa.codeium_common_pb.CompletionDelta`（偏移 2610902），字段名**几乎一样但号全不同**。把它当成出站 chunk 会**每一个字段都写错**：

| 字段 | `GetChatMessageResponse`（出站，本文档） | `CompletionDelta`（另一个消息） |
| --- | --- | --- |
| `delta_text` | **3** | 1 |
| `stop_reason` | **5** | 3 |
| `delta_tool_calls` | **6** | 5 |
| `usage` | **7** | 4 |
| `delta_thinking` | **9** | 6 |
| `delta_signature` | **10** | 7 |
| `thinking_redacted` | **11** | 8 |
| `delta_signature_type` | **21** | 12 |

判别方法：确认 `typeName` 是 `exa.api_server_pb.GetChatMessageResponse`。`delta_signature` 在 bundle 里有**两个**偏移，第一个（2611300）属 `CompletionDelta`，**不要用**。

## `ModelUsageStats`（`GetChatMessageResponse` 字段 7 的子消息，`exa.codeium_common_pb`）

| 号 | 字段 | 说明 |
| --- | --- | --- |
| 2 | `input_tokens` | **含缓存的总额** |
| 3 | `output_tokens` | |
| 4 | `cache_write_tokens` | 写缓存子集 |
| 5 | `cache_read_tokens` | 读缓存子集 |
| 6 | `api_provider` | |
| 7 | `message_id` | 本仓用它装 chunk id（`s(7, id)`） |
| 8 | `response_header` | map |
| 9 | `model_uid` | |
| 12 | `provider_refusal` | 拒绝标记（本仓未发） |

（另有 1 `model_deprecated`(enum，jsonName `model`)、10 `billing_model_uid`、11 `requested_model_uid`。）

## `ChatToolCall` 与 `StopReason`

- `ChatToolCall`：`1=id`、`2=name`、`3=arguments_json`。
- `StopReason`：`2=STOP_PATTERN`、`3=MAX_TOKENS`、`10=FUNCTION_CALL`、`11=CONTENT_FILTER`、`13=ERROR`（bundle 字段表逐项核对一致）。

## 已核实的语义结论

- **CLI 侧 `GetUserStatus` 与渲染端不是同一个 service**（2026-10-18 实测）：CLI 打到 api server 的是
  `exa.seat_management_pb.SeatManagementService/GetUserStatus`（伴随 `SeatManagementService/GetCliTeamSettings` 与
  `api_server_pb.ApiServerService/GetCliModelConfigs`，一次认证引导共 7 条：`GetUserStatus`×5、其余各 1）；渲染端经 LS 走的是
  `exa.language_server_pb.LanguageServerService/GetUserStatus`。`bridge.cjs` 的 CATALOG 正则**两者都覆盖**；`cli-cache.cjs` 的
  `CACHE_RPC.user_status` 写的是 language_server 路径，**这不是 bug**——`catalog/augment.cjs` 的 `rpcShape` 只取路径最后一段方法名。
  重构时别把两处「统一」成一个路径，那会让其中一侧静默不再被 augment。

- **`cached_tokens` 是 `input_tokens` 的子集（inclusive）**：真机实测 `prompt_cache_hit_tokens:0 + prompt_cache_miss_tokens:7 = prompt_tokens:7`。因此 `ModelUsageStats.input_tokens`（字段 2）永远写含缓存总额，4/5 只是子集分列，**不要**把 input 改成「减缓存」。
- **思考签名闭环已真机证实**（2026-10-16，真实 Devin 窗口 + 真实 DeepSeek anthropic 端点，经本地反代只记形状）：

  ```
  响应字段 10 delta_signature ──→ 客户端持久化 ──→ 请求字段 12 signature ──→ 回传 thinking 块
  ```

  **字段 10 被两条路径复用**（2026-10-16 登记）：Anthropic 用它回传思考签名，Responses 用它携带推理状态信封（`dfbyok-responses-v1:` + base64url）。信封落在 Devin 侧持久化的同一个 `signature` 槽位，因此 Anthropic 侧回放必须拒绝 `dfbyok-` 前缀（`FOREIGN_STATE_PREFIX`）——否则外来信封会被当成思考签名写进 `{type:'thinking',signature}`，官方对修改过的思考块直接 400。两条路径各自读同一字段但语义不同，**不要让任何一边把对方的值当作自己的载荷**。

  证据链：第 1 轮响应 `signature_delta` 1 次（**36 字符**）→ 第 2 轮请求新增助手轮块类型 `["thinking","tool_use"]`、`signedThinkingBlocks: 1`、签名长度 `[36]` → 第 3 轮 `[36, 36]` → 第 4 轮 `[36, 36, 36]`，**逐轮累积且长度逐字一致**。因此「客户端读字段 10 并写回请求字段 12」成立，捕获与回传两半都可达。
- **字段 21 `delta_signature_type` 不需要发**：上述闭环在**完全不发字段 21** 的情况下成立，所以「取值未知」不再阻塞任何事。`signatureType` 在 JS 里只被初始化为 `""`、无消费逻辑；除非未来真机出现签名回放失败，再考虑补它。
- **脱敏思考无法往返**：`redacted_thinking` 在请求（字段 13）与响应（字段 11）两侧都只有 bool 标志、没有任何载荷字段，所以本仓只透传 `thinking_redacted=true`，不做载荷回传。
- Anthropic 侧 `ThinkingBlockParam.signature` 是**必需字段**：assistant 回传思考块仅在签名在场时进行，否则整块省略。
- **验证方法（可复用）**：把临时 `apiFormat: anthropic` 供应商指向本地反代，反代只记录形状（块类型/签名长度/布尔），**不记正文与密钥**；跑一轮带工具回合即可看到回传。注意 baseUrl 会被规范化成 `<host>/anthropic/v1`，客户端再拼 `/messages`。

- **ACP 方法频次基线（2026-10-18 真机，单窗口约 30 分钟，`devin acp` 3000.10.67）**：`session/list` **631**、`ext_method` 127、`session/new` 86、
  `ext_notification` 86、`session/prompt` 60、`session/load` 56、`session/delete` 5、`authenticate` 5、`initialize` 3。
  含义：`session/list` 约每 2.8 秒一次，是**宿主侧轮询**（本扩展不主动调 ACP 方法），排障时别把它当成异常流量；`session/new`/`session/load`
  数量偏高是因为每个面板/子会话各建一次。基线随窗口活动变化，但**量级关系**（list ≫ new > prompt）可用于识别「谁在刷 ACP」。
- **一条已知但不致命的 ACP 警告**：`ext_method{cognition.ai/revert/listSteps}` 对已不在活跃集合的会话会得到
  `ACP revert: session <id> not in active sessions`（窗口重载后渲染端仍持有旧会话 id 时出现）。单次出现属竞态，不要据此认定会话损坏。
