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

## 思考签名闭环、ACP 方法频次与已知警告（真机取证）

  ```
  响应字段 10 delta_signature ──→ 客户端持久化 ──→ 请求字段 12 signature ──→ 回传 thinking 块
  ```

  证据链：第 1 轮响应 `signature_delta` 1 次（**36 字符**）→ 第 2 轮请求新增助手轮块类型 `["thinking","tool_use"]`、`signedThinkingBlocks: 1`、签名长度 `[36]` → 第 3 轮 `[36, 36]` → 第 4 轮 `[36, 36, 36]`，**逐轮累积且长度逐字一致**。因此「客户端读字段 10 并写回请求字段 12」成立，捕获与回传两半都可达。

- **验证方法（可复用）**：把临时 `apiFormat: anthropic` 供应商指向本地反代，反代只记录形状（块类型/签名长度/布尔），**不记正文与密钥**；跑一轮带工具回合即可看到回传。注意 baseUrl 会被规范化成 `<host>/anthropic/v1`，客户端再拼 `/messages`。

- **ACP 方法频次基线（2026-10-18 真机，单窗口约 30 分钟，`devin acp` 3000.10.67）**：`session/list` **631**、`ext_method` 127、`session/new` 86、
  `ext_notification` 86、`session/prompt` 60、`session/load` 56、`session/delete` 5、`authenticate` 5、`initialize` 3。
  含义：`session/list` 约每 2.8 秒一次，是**宿主侧轮询**（本扩展不主动调 ACP 方法），排障时别把它当成异常流量；`session/new`/`session/load`
  数量偏高是因为每个面板/子会话各建一次。基线随窗口活动变化，但**量级关系**（list ≫ new > prompt）可用于识别「谁在刷 ACP」。

- **一条已知但不致命的 ACP 警告**：`ext_method{cognition.ai/revert/listSteps}` 对已不在活跃集合的会话会得到
  `ACP revert: session <id> not in active sessions`（窗口重载后渲染端仍持有旧会话 id 时出现）。单次出现属竞态，不要据此认定会话损坏。

## 外部独立实现互证（dwgx/WindsurfAPI）

另一份**独立逆向**落在同一组字段号上：`dwgx/WindsurfAPI`（本地克隆 `.refs/WindsurfAPI`，2026-10-26 更新至 HEAD `272429d3`，v3.141.592657）是 CLI → `server.codeium.com` 的上游 Connect-RPC 代理，与我们客户端侧实现逆的是同一批 `exa.api_server_pb`/`exa.chat_pb` 消息。该仓没有 `.proto`，字段号写在手写的 `parseFields` 与注释里（`src/devin-connect-catalog.js` 顶部 `F_*` 常量）。

**锚点校验（2026-10-26）**：`git diff b00b3b9..HEAD -- src/devin-connect-catalog.js` 为空，`F_*` 常量仍为 14 个，该文件最后一次改动停在 `c90e30a8`（2026-10-22）。也就是说初版互证用的锚点 `b00b3b9` 虽然旧，但**被引用的文件内容未变，下表结论不受影响**；后续再同步 `.refs` 时按同一命令复核即可，不必重做对照。

| 字段 | 我们（`src/catalog/codec.cjs`） | 对方 |
| --- | --- | --- |
| `#1` label | `s(1, config.label)` | `F_LABEL = 1` |
| `#4` disabled | 读侧 `num(entry,4) === 1` | `F_DISABLED = 4` |
| `#5` supportsImages | `v(5,1)` | `F_SUPPORTS_IMAGES = 5` |
| `#10` provider | `v(10, config.provider)` | `F_PROVIDER = 10` |
| `#18` 上下文窗口 | `v(18, config.maxTokens)` | 仅其注释称 `#18` 是上下文窗口（免费档默认 200000），**代码未解析该字段** |
| `#22` selector / model_uid | `s(22, config.modelUid)` | `F_SELECTOR = 22` |
| `#23` ModelInfo 及内层 `#23` | `m(23, …)`，内层作家族标识 | `F_MODEL_INFO = 23`，内层 `F_ALIAS = 23` |
| 出站 chunk | `3` text / `5` stop_reason / `6` tool calls / `7` usage / `9` thinking / `10` signature | 「answer text in response field **#3**」，测试用 `writeVarintField(5, …)` 表示 stop_reason |

- **使用结论**：再质疑这些字段号先看这张表——两份独立实现同时错的概率远低于单方读数错误；但**这不是新证据源**，表外字段、以及与本机读数冲突的任何断言，一律以本机 REA 为准（本机 REA 的可用手法只剩字节级扫描，MCP 语义面不可用，见下节「REA 的原生面与语义图预算」）。

### 冲突时以本机 REA 为准

外部实现的**注释与文档头不等于它的实现**，更不等于本机 schema；两侧冲突时以本机 `newFieldList` 为准。

- **案例 1（`GetChatMessageRequest` `#16`）**：对方 `src/session-continuity.js` 文档头写「stable protobuf session_id (**#16**)」，其代码 `writeStringField(16, …)` 的注释自认「这是 `cascade_id`，不是 session id；新 web schema 在 #28 加了 `session_id`，我们不发」。本机 bundle 实测：`16 = cascade_id`、`28 = session_id`。
- **案例 2（同消息 `#22`）**：对方注释写「`#22` request_id，故意不发」。本机 bundle 实测：`22 = execution_id`（其 `request_id` 在出站响应里是 `GetChatMessageResponse#17`）。
- **案例 3（`#18`，已在上一轮记录）**：对方只有注释提到 `#18` 是上下文窗口，代码并未解析该字段。
- **方法论**：交叉验证要同时落到**对方的解析代码**和**本机 schema** 两侧；连续三例说明只读注释会引入假事实。本机取证见上文「怎么读权威字段号」——`newFieldList` 字面量是唯一权威，LS 二进制描述符只证存在性、不含字段号。
- **反例**（附到「不要猜数值枚举」）：对方 `docs/HISTORY-LEDGER-2026-07-late.md`（~147 行）曾按 protobuf 变体名顺序猜「`StopReason 4 = max_turn_requests`」，被付费实测推翻（4 是付费层正常完成）——后果是完整付费响应被报成截断，按 length 续写的客户端会无限续写。
- **stop reason 枚举实测**（2026-10-28，`@exa/chat-client/index.js`）：v1 `session/prompt` 结果是**封闭**枚举
  `end_turn, max_tokens, max_turn_requests, refusal, cancelled`（偏移 ~3498576），与对方 `docs/DEVIN-CONNECT-CUTOVER.md`
  （~434 行）所列一致；v2 `state_update.stopReason` 是**开放**联合 `[5 值, string]`（偏移 ~3775106），所以判定必须用
  集合成员，穷举会漏。原生对各值的对待并不对等：i18n 只给 `max_turn_requests` 配了 continue 语义
  （`Reached max tool calls — send another message to continue`，英文/西/日/葡四套，偏移 ~11065694），`max_tokens`
  在 bundle 里**零**用户可见处理（无文案、无重试，同名字面量全是无关的 proto 字段），`end_turn` 无 affordance。
  本仓据此把 `CONTINUABLE_STOP` 收窄为 `{max_tokens, max_turn_requests}`，条件见 `runtime-and-injection.md`。

## REA 的 JS 语义图在本 artifact 上拿不到

历史过程与全部实测数据见 `acp-protocol-fields-forensics-rea.md`「REA 的原生面与语义图预算」一节——`analyze_javascript_application` 对本 artifact
**在解析阶段就吃满预算**，`partial` 图不得当作「不存在某逻辑」的证明，**不要重复尝试**。

## 谁组装 prompt 历史：原生 CLI，不是 JS bundle

- 客户端 bundle 里 `prompts.push(` **0 次**；`prompts:` 仅 5 处（URI scheme 表、MCP 服务器对象、MCP 提示缓存、publish 集合）；`chatMessagePrompts` 的实际构造点属 `exa.opensearch_clients_pb.KnowledgeBaseSearchRequest`（知识库检索），**与 agent 请求无关**。
- 归属由既有实测决定（见 `runtime-forensics.md`）：backend 的客户端只有**扩展宿主**（只打自有端点）与 **`devin` CLI**，LS 不是客户端。

⇒ `GetChatMessageRequest.prompts` 由**原生 `devin` CLI 二进制**组装。**「原生是否会送出孤儿 `tool_result`」在 JS bundle 里永远查不到**，静态路线的正确目标只剩 Rust CLI（投入过大）。该问题只能靠真实流量观测。

## 客户端不改写历史（压缩的归属）

`compaction` 在 sessions bundle 仅两处：`ClientModelConfig#26 compaction_thresholds`（目录字段）与 `cognition.ai/compaction` / `_cognition.ai/compaction` ext-notification（只设 UI 标记 `compacting`）。**客户端不裁剪历史**，压缩在服务端/agent 侧。

## 两处已排除的假线索（别再挖）

- `orphan` 在该 bundle 出现 33 次，全部无关：工作台文件「孤立」状态（`isOrphaned`/`setOrphaned`）与 Teams 集成「orphaned channels」。
- `trimHistory` 是 toast 通知库的历史裁剪，不是对话历史。

## 3.11.228 读出的三条消息字段（REA 2026-10-27）

读法：在 `extensions/windsurf/dist/extension.js` 里搜 `typeName="exa.api_server_pb.AssignModelRequest"`，紧跟的 `newFieldList` 就是权威字段号（`ModelStatusInfo` 同理，在 `codeium_common_pb`）。

- `exa.api_server_pb.AssignModelRequest`：`1 metadata`、`2 model_router_uid`、`3 cascade_id`、`5 chat_message_prompt`、`6 fusion_lead_router_uid`
- `exa.api_server_pb.ModelAssignment`：`1 assignment_jwt`、`2 model_uid`、`3 harness_uids`(repeated)。本地应答只发 2、3，故意不发 1。
- `exa.codeium_common_pb.ModelStatusInfo`：`1 model`(enum)、`2 message`、`3 status`(enum `ModelStatus`：`UNSPECIFIED=0`、`INFO=1`、`WARNING=2`)、`4 model_uid`
- `exa.language_server_pb.GetModelStatusesRequest{1 metadata}` / `GetModelStatusesResponse{1 model_status_infos repeated}`：调用点在 `out/vs/sessions/sessions.desktop.main.js`（Agent Window 会话面板，60s 节流 `useMemo`）。`status` 三态 + message 是**提示徽标通道不是可用性白名单**，BYOK uid 缺席无功能影响，桥原样转发不改写。

## 3.11.228 目录面字段表（REA 2026-10-27）

读法同前（assets 里搜 `typeName=\`<类型>\``，紧跟的 `newFieldList`）。强断言在 `test/native-field-contract.test.cjs` 的 `CATALOG_FIELDS`；**本次升级目录面未漂移**（逐条一致）。

```
ClientModelConfig: 1 label,4 disabled,5 supports_images,10 provider,18 max_tokens,22 model_uid,23 model_info,30 model_family_metadata
ModelInfo: 3 model_type,4 max_tokens,6 model_features,13 max_output_tokens,17 model_uid,18 inference_server_url,20 harness_uids,22 display_option,23 model_family_uid,25 is_model_router
ModelFeatures: 8 zero_shot_capable,11 supports_images,12 supports_tool_calls,15 supports_thinking,21 supports_parallel_tool_calls
ModelFamilyMetadata: 1 model_family_label,2 entries,3 is_default_model_in_family
ModelFamilyMetadataEntry: 1 key,2 value
ModelFamilyMetadataValue: 1 order,2 name,3 control_type
ClientModelSort: 1 name,2 groups,3 display_metric
CascadeModelConfigData: 1 client_model_configs,2 client_model_sorts,3 default_override_model_config
ModelStatusInfo: 1 model,2 message,3 status,4 model_uid
AssignModelRequest: 1 metadata,2 model_router_uid,3 cascade_id,5 chat_message_prompt,6 fusion_lead_router_uid
ModelAssignment: 1 assignment_jwt,2 model_uid,3 harness_uids
```
注：`ClientModelSort.groups` 的内层类型在 schema 里是 minified 引用、无独立 `typeName`，组内字段（f1 name / f2 label）无法描述符断言，仍靠 fixture。

### REA 的原生面与语义图预算

REA 各工具的本机可用性、语义图的 8 组预算实测、partial evidence 的同会话失效纪律，见 `acp-protocol-fields-forensics-rea.md`（2026-10-28 复测，REA 6.8.0）。
