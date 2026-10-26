---
trigger: model_decision
description: "Apply before changing Responses/Anthropic/Chat semantics — measured provider-surface facts, several of which overturned earlier conclusions."
---

# 供应商面实测（provider-measurements）

用真实端点只读探测得到的供应商面事实：哪些面是官方转发面、哪些参数被接受、推理状态通道的真实尺寸与校验行为。
**这些事实推翻过多处早期结论，改协议语义前先读这一卷。**

- **BYOK 三条协议路径的验证状态**（2026-10-16 实测，用真实 key、DeepSeek 端点，走扩展自己的 `serveChat` 完整链路：请求体构造 → 真实 HTTP → SSE 解析 → protobuf 输出）：
  `openai-responses`、`openai`（Chat Completions）、`anthropic`（Anthropic Messages）三条路径**都已协议级真机验证通过**，chat 与 anthropic 路径均验证了**工具调用且参数精确正确**（`multiply` 收到 `{"a":13,"b":7}`）。
  注意两点区分：① 这是**协议级**真机验证（直接调 `serveChat` + 合成请求），不是**整窗 e2e**——真实 Devin 窗口的运行时流量目前只覆盖 `openai-responses`（`deepseek-flash` 与 `deepseek-v4-pro`）；② **Chat Completions 的配置取值是 `openai`，不是 `openai-chat`**：`isChatFormat` 的正则认 `chat`/`openai`/`chat-completions` 等，不认 `openai-chat`（该值会静默落回 responses 格式），面板下拉也只提供 `openai-responses`/`openai`/`anthropic` 三档。DeepSeek 的 Anthropic 兼容端点 `https://api.deepseek.com/anthropic` 同时接受 `/anthropic/messages` 与 `/anthropic/v1/messages` 两个路径，本仓 `endpoint()` 的补路径逻辑无冲突。
- **已实测的「供应商面」行为逐字搬到 `provider-measurements-forensics.md`**（Proxy 身份特征、`previous_response_id` 400、篡改 `encrypted_content` 的 502、回放非强制、信封真实尺寸与四个信封日志事件 `state-envelope-size`/`-oversize`/`-replayed`/`-replay-failed`、DeepSeek 占位桩、对照臂方法）。**判「某改动是否引入问题」前必须先读那份证据**，其中两条方法禁令直接适用：必须带对照臂（单臂归因已错过一次）；篡改校验失败只在官方面（转发面 502）显现，DeepSeek 不校验。
  由此产生的契约留在本卷：`replayMatches` 保守（scope/assistant 文本/工具 `id`+`name`+规范化参数任一不符即静默回退、绝不发出）；状态通道**恒开不改变可用性**；改该通道必须在 42 KB 信封尺寸上实测。
  - **`response.incomplete` 不触发零输出兜底，得到的是「空答 + stop 3」**（2026-10-17 实测闭环，代码依据 `inference.cjs` 的 `case 'response.incomplete'`）：incomplete 被映射为 stop reason 3（长度截断），而 `upstream_empty_output` 守卫**只覆盖 `reason === 2`**。因此截断且未产出文本时，用户看到的是一条**空消息**而非错误——这是**刻意的**（provider 确实截断了，stop 3 本身就是诚实的截断信号），排障时不要当成 bug。复现方式：小 `max_output_tokens` 配高 effort。
- **协议事件名以官方 SDK 为权威，别靠猜**（2026-10-16，2026-10-22 升级快照）：官方 SDK 以**只读副本**放在仓库外——本机为 `.refs/openai-node`（`openai@7.43.0`，Apache-2.0，https://github.com/openai/openai-node ）与 `.refs/anthropic-sdk-typescript`（`@anthropic-ai/sdk@1.3.0`，MIT）。该目录**被 `.gitignore` 忽略、不进仓库也不进 VSIX**，clone 本仓的人需自行获取才能对照；**只读参考，不得把 SDK 代码写进 `src/`**，若要写入必须同批在 `THIRD_PARTY_NOTICES.md` 补署名。`.refs/openai-node` 的 `ResponseStreamEvent` 联合是 Responses **HTTP 流**事件的全集（7.43.0 仍为 **59** 个成员（升级时逐个 diff 过，联合零增删），本仓处理 18 个 + 1 个扩展 `response.reasoning.delta`，未处理 41 个——**按联合成员逐个解析 `type` 字面量统计，不要全文 grep**：全文扫描会把 `response.steer.*`、`response.create` 等 WebSocket/客户端事件一起算进来，历史上因此误报成「64 个、缺 46 个」）。
  `src/resources/shared.ts` 的 `ReasoningEffort` 是 effort 取值全集。据此对照出的真实缺口已修：缺 `response.refusal.delta/done`（拒答文本会被**静默丢弃**，
  与「假 anthropic 端点」同属静默失败）、缺 `response.reasoning_text.delta`（当前推理正文事件名）、缺三个 `.done` 变体（只发 done 的供应商会丢内容）。
  两个易踩的字段名陷阱：**`response.refusal.done` 带的是 `refusal` 字段而不是 `text`**（`output_text.done`/`reasoning_text.done` 才是 `text`）；
  `reasoning.generate_summary` 是**被废弃**的旧名，现名是 `summary`（别被「更新」的直觉带反）。同一事件的 `delta` 与 `done` 必须在 `text()` 里用**同一个 key**
  （done 走 `complete=true` 会校验前缀，key 不一致会抛 `upstream_text_mismatch`——注意这与「SSE 行本身不是合法 JSON」的
  `upstream_invalid_json`（`provider-events.cjs`）是两个不同的码，不要混用）。
- **「HTTP 200 + text/event-stream」不足以判定供应商可用**：中转/网关会给不存在的路径返回 200 的 HTML 兜底页，甚至把 anthropic 路径**透传**成
  Responses 格式（`object:"response"`、id 前缀 `resp_`、SSE 首帧 `response.created`）——此时传输层全部正常，只是我们的 anthropic 适配器不认这些事件名，
  于是**状态 200、日志 chat-complete、回答为空**。判据只能是**响应体形状**（事件名/字段），不是状态码或 content-type。
- **零输出成功检测**（`upstream_empty_output`，2026-10-16 加）：`serveChat` 在 `processor().finish()` 里判定「正常完成、无工具调用、
  且整条流从未产生任何文本/思考」→ 抛错并在流里输出 `Provider returned no output.`。这是**通用兜底**：未来任何事件名变更或未知供应商行为都会
  变成响亮错误而不是静默空回答。截断（`response.incomplete`）与 content_filter 不触发。给供应商加新事件时，`tracker.cjs` 的 `semanticOutput()`
  要同步，否则面板的 `firstOutputMs`/吞吐统计会漏。
- **注解事件不处理是刻意的**：`response.output_text.annotation.added`、`response.content_part.done` 不进 `switch`；完整正文随
  `response.completed.output` 的 message parts 到达（走 `item(..., true)` 的 `complete=true` 前缀校验），而 ACP 侧没有引用/注解的载荷表示。
  只有当出现「上游只在 annotation 里给正文」的实测证据时才处理。
- **状态信封不支持 `custom_tool_call` 是刻意的**：`validStateItem`（`state-envelope.cjs`）拒绝它——自定义工具参数是原始串，
  `replayMatches` 的 JSON 规范化校验不适用。现在 `finish()` 会因此在 `runtime.log` 记一条 `state-envelope-skipped`（`reason` 为
  `custom-tool` 或 `invalid-item`，每次请求最多一条）。这是可观测性，不是新故障——看到该日志不等于回放坏了。

Anthropic 与 Chat 两个协议面的契约已按**协议面**逐字拆到 `provider-measurements-anthropic-chat.md`（2026-10-26）；本卷保留 Responses 面与跨面契约。

## 附件走 `resource_link`，不是 document（2026-10-22 桌面客户端实测）

- **桌面客户端不内联文档字节**：一份 61,341 B 的 PDF 以 `chisel/acp-content-blocks` 里的 `resource_link` 进入消息
  （`uri: file:///…`、`_meta: {"cognition.ai/scope-item-type":"file"}`），`content` 只剩一行 markdown 链接，**节点总长 724 B**。
  对照同一会话的截图消息：**137,580 B**，带 `images[].base64_data`。全会话 5,829 节点统计：`documents` **0** 次、`resource_link` 6 次、含 `images` 5 次。
- 结论：**`documents`（protobuf 21）在该客户端恒为空**，所以 `contentOf` 的 `input_file`（Responses）/ `file`（Chat）/`document`（Anthropic）
  三条映射**真机不可达**，只有测试背书；`attachment_unsupported` 同样**不可触发**——没有东西可拒，别把「日志里没这条」读成「守卫生效」。
- 后果：模型只拿到链接，PDF 正文必须由自己读文件获得（本机 `pypdf`/`pdfplumber` 缺失，`pymupdf` 可用）。
- **不要给 `resource`/`resource_link` 猜一个 wire 映射**：当前没坏是因为 CLI 同时把链接写进了正文；在拿到真实 wire 证据前加映射等于凭想象改协议层。
