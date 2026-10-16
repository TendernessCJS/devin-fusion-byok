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

| 号 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 3 | `delta_text` | string | 可见文本增量（`textChunk`） |
| 5 | `stop_reason` | enum StopReason | 结束原因（`stopChunk`） |
| 6 | `delta_tool_calls` | repeated ChatToolCall | 工具调用（`toolChunk`） |
| 7 | `usage` | ModelUsageStats | 用量（`usageChunk`） |
| 9 | `delta_thinking` | string | 思考增量（`thinkingChunk`） |
| 10 | `delta_signature` | string | 思考签名（`signatureChunk`，anthropic `signature_delta` 透出） |
| 11 | `thinking_redacted` | bool | 脱敏思考标记（`redactedThinkingChunk`），**无载荷字段** |
| 21 | `delta_signature_type` | string | 签名类型——取值未知，见下 |
| 23 | `actual_model_uid` | string | 实际模型 uid（`stopChunk` 尾部） |

## 入站：`exa.chat_pb.ChatMessagePrompt`（请求侧，已由 `parseChat` 消费）

| 号 | 字段 | 类型 |
| --- | --- | --- |
| 6 | tool calls | repeated |
| 7 | `tool_call_id` | string |
| 10 | images | repeated |
| 11 | `thinking` | string |
| 12 | `signature` | string |
| 13 | `thinking_redacted` | bool |
| 16 | `thinking_id` | string |
| 17 | `gemini_thought_signature` | bytes |
| 18 | `signature_type` | string |

## `ModelUsageStats`（字段 7 的子消息）

| 号 | 字段 | 说明 |
| --- | --- | --- |
| 2 | `input_tokens` | **含缓存的总额** |
| 3 | `output_tokens` | |
| 4 | `cache_write_tokens` | 写缓存子集 |
| 5 | `cache_read_tokens` | 读缓存子集 |
| 6 | `api_provider` | |
| 7 | `message_id` | 本仓用它装 chunk id（`s(7, id)`） |
| 8 | `response_header` | |
| 9 | `model_uid` | |

## `ChatToolCall` 与 `StopReason`

- `ChatToolCall`：`1=id`、`2=name`、`3=arguments_json`。
- `StopReason`：`2=STOP_PATTERN`、`3=MAX_TOKENS`、`10=FUNCTION_CALL`、`11=CONTENT_FILTER`、`13=ERROR`（bundle 字段表逐项核对一致）。

## 已核实的语义结论

- **`cached_tokens` 是 `input_tokens` 的子集（inclusive）**：真机实测 `prompt_cache_hit_tokens:0 + prompt_cache_miss_tokens:7 = prompt_tokens:7`。因此 `ModelUsageStats.input_tokens`（字段 2）永远写含缓存总额，4/5 只是子集分列，**不要**把 input 改成「减缓存」。
- **`delta_signature_type`（字段 21）取值未知**：JS bundle 里 `signatureType` 只被初始化为 `""`、无任何比较/消费逻辑。当前只发字段 10、不发类型；若真机验证发现签名未被持久化/回放失败，**优先尝试补字段 21**。
- **脱敏思考无法往返**：`redacted_thinking` 在请求与响应两侧都只有 bool 标志、没有任何载荷字段，所以本仓只透传 `thinking_redacted=true`，不做载荷回传。
- Anthropic 侧 `ThinkingBlockParam.signature` 是**必需字段**：assistant 回传思考块仅在签名在场时进行，否则整块省略。
