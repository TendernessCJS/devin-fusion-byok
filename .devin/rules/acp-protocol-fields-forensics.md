---
description: ACP 字段号的实测方法与证据——怎么从 bundle 的 newFieldList 读字段号、CompletionDelta 的错位陷阱、附件与缓存键字段的实证来源；改字段号或怀疑读数过期时必读
trigger: model_decision
---

# ACP 字段号：实测方法与证据

本卷是从 `acp-protocol-fields.md` 拆出的**方法与证据**：字段号表与语义结论留在契约卷，这里只记怎么测出来的、踩过什么坑。

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

## 附件与缓存键字段（2026-10-22 实证补齐）

`ChatMessagePrompt` 此前只解析 `images`（10），`videos`（20）与 `documents`（21）**静默丢弃**。内层形状：`VideoData`=`1 base64_data/2 mime_type/3 url`；`DocumentData`=`1 base64_data/2 mime_type/3 filename/4 url`（是 `filename`，JSON 侧曾误拼 `fileName`）。

出站映射（**失败要响亮，不许退回静默丢**）：文档在 Responses 走 `{type:'input_file',file_data|file_url,filename}`（`file_data` 是**原始 base64**）、Chat 走 `{type:'file',file:{file_data,filename}}`（Chat **没有** URL 形态）、Anthropic 走 `{type:'document',source:{type:'base64',media_type:'application/pdf'}}`，`text/plain` 用 `{type:'text',media_type:'text/plain',data:<base64 解码后的原文>}`。**视频三种协议都无载荷**，直接抛 `attachment_unsupported`（detail `video`）；Anthropic 上 pdf/text-plain 之外的文档 mime 同样抛。该码已进 `allowedCodes`，文案是 `Attached media is not supported by this provider protocol.`；`buildRequestBody` 在取响应之前抛，外层 catch 必须单独认领，否则会被归成 `upstream_network`。

`GetChatMessageRequest` **字段 27 `prompt_cache_key`**：原生已带，此前不读。现读成 `request.promptCacheKey`，Responses 与 Chat 原样写 `body.prompt_cache_key`；**Anthropic 不发**（它要的是分段 `cache_control`）。省略该键不等于自动缓存失效，别据此判命中率。
