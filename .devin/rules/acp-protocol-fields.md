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

下表是**逐字段读出的完整 23 个字段**（2026-10-16 由 `sessions.desktop.main.js` 偏移 5980624 处的 `newFieldList` 原文核出），不是只列我们用到的那几个——只列子集曾让人以为「字段号不连续」。

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

- **`cached_tokens` 是 `input_tokens` 的子集（inclusive）**：真机实测 `prompt_cache_hit_tokens:0 + prompt_cache_miss_tokens:7 = prompt_tokens:7`。因此 `ModelUsageStats.input_tokens`（字段 2）永远写含缓存总额，4/5 只是子集分列，**不要**把 input 改成「减缓存」。
- **思考签名闭环已真机证实**（2026-10-16，真实 Devin 窗口 + 真实 DeepSeek anthropic 端点，经本地反代只记形状）：

  ```
  响应字段 10 delta_signature ──→ 客户端持久化 ──→ 请求字段 12 signature ──→ 回传 thinking 块
  ```

  证据链：第 1 轮响应 `signature_delta` 1 次（**36 字符**）→ 第 2 轮请求新增助手轮块类型 `["thinking","tool_use"]`、`signedThinkingBlocks: 1`、签名长度 `[36]` → 第 3 轮 `[36, 36]` → 第 4 轮 `[36, 36, 36]`，**逐轮累积且长度逐字一致**。因此「客户端读字段 10 并写回请求字段 12」成立，捕获与回传两半都可达。
- **字段 21 `delta_signature_type` 不需要发**：上述闭环在**完全不发字段 21** 的情况下成立，所以「取值未知」不再阻塞任何事。`signatureType` 在 JS 里只被初始化为 `""`、无消费逻辑；除非未来真机出现签名回放失败，再考虑补它。
- **脱敏思考无法往返**：`redacted_thinking` 在请求（字段 13）与响应（字段 11）两侧都只有 bool 标志、没有任何载荷字段，所以本仓只透传 `thinking_redacted=true`，不做载荷回传。
- Anthropic 侧 `ThinkingBlockParam.signature` 是**必需字段**：assistant 回传思考块仅在签名在场时进行，否则整块省略。
- **验证方法（可复用）**：把临时 `apiFormat: anthropic` 供应商指向本地反代，反代只记录形状（块类型/签名长度/布尔），**不记正文与密钥**；跑一轮带工具回合即可看到回传。注意 baseUrl 会被规范化成 `<host>/anthropic/v1`，客户端再拼 `/messages`。
