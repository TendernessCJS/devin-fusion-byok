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

## Anthropic 兼容面：强制选择、思考与用量（2026-10-22 实测，DeepSeek + Moonshot）

- **强制 `tool_choice` 与默认开启的思考互斥**：两家都返回 400（DeepSeek `Thinking mode does not support this tool_choice`、Moonshot `tool_choice 'specified' is incompatible with thinking enabled`），且**都支持** `thinking:{type:'disabled'}`。**DeepSeek 已验证「关闭思考 + 保留强制选择」→ 200 且只返回 `tool_use`**；Moonshot 已于 2026-10-25 补测：关闭思考 + 保留强制选择同样 200，且只返回指定的 `tool_use`。
  因此降级链定为**两步、有界**：①（仅 anthropic 且请求体原本没有 `thinking`）先注入 `thinking:{type:'disabled'}` 重试，**保住用户的强制选择**；②仍失败才把 `tool_choice` 降为 `auto`，并**把我们注入的 `thinking` 摘掉**——否则厂商若本来拒的是该字段，第三次会白失败。两次降级各自记 `provider-degraded`，`reason` 分别是 `thinking-disabled` / `tool-choice`。非 anthropic 路径没有这个杠杆，维持直接降级。判据仍是「HTTP 400 且错误文本包含 `tool_choice`」，`auto`/`none` 永不重试。
- **`thinking_tokens` 必须映射，否则统计留空而非虚高**：SDK 的 `usage.output_tokens_details.thinking_tokens` 要被读成适配器内部的 `completion_tokens_details.reasoning_tokens`（`output_tokens` 本身是含思考的权威总数，不要改）。Moonshot 实测**返回**该字段、DeepSeek 不返回。此前推断「未映射会让可见 token/tps 虚高」**是错的**：`tracker` 有门控——只要有 thinking 块却拿不到 reasoningTokens，`visibleTokens`/`tps` 直接为 `null`。可见症状是**指标缺列**，不是数字偏大。
- **思考不可控是能力缺口**：两家都不发 `thinking` 也返回 thinking 块（思考默认开），`budget_tokens` 能改思考量、`disabled` 能关，而本仓没有开关/预算入口。要加就得同时暴露「关」与「预算」，否则用户仍然无法约束成本。
- **base path 是厂商相关**：Moonshot 上 `/anthropic/messages` 为 **404**、`/anthropic/v1/messages` 才 200；DeepSeek 两个路径都 200（宽容，不是规范）。面板填厂商文档给的 `…/anthropic` 在 Moonshot 上**必然 404**，排障先看这一条。
- **签名闭环只在有签名的厂商成立**：DeepSeek 返回 36 字符签名且原样回放 200；Moonshot 不返回签名，所以续轮只能省略 signed thinking 块（`FOREIGN_STATE_PREFIX` 之外，脱敏数据另有 `dfbyok-redacted-v1:` 通道，见 `acp-protocol-fields.md`）。缺签名不等于工具多轮不可用，需厂商专项测试再下结论。**补测（2026-10-22）：把 `signature` 删掉再回放，DeepSeek 仍返回 200**——它不校验签名，所以
  「签名回放 200」不能证明我们保真，只有真 Anthropic 端点能戳穿；同理，本地全绿也不代表签名通道正确。
- **DeepSeek 的 anthropic 面忽略 `cache_control`**（2026-10-25 实测）：13 条消息的同一请求，带断点与不带断点、热缓存下完全一致（`input_tokens 227` / `cache_read_input_tokens 384`），文档亦明示忽略。**因此 `cache_read_input_tokens` 非 0 不能证明断点生效**——DeepSeek 有独立的自动上下文缓存。
- **DeepSeek 的自动缓存命中率很高**（同日 `monitor.jsonl` 实测）：单回合 `inputTokens 72,253` / `cachedTokens 70,656`（97.8%），Responses 面一直命中。别把「缓存计数为 0」当成常态，也别把非 0 归因给我们的断点。
- **文档输入三面都不通**（同日探针）：Responses `input_file`、Anthropic `document` 均 **200 但被忽略**（模型回答「没有附件」）；Chat `file` 直接 400 `file must have a file_id or file_data`（DeepSeek 把 `file_data` 放在 content part 顶层，不是 OpenAI 的嵌套 `file` 对象）。**按本卷「附件走 `resource_link`、`documents` 恒为空」的实测，这三条映射真机不可达，故不改代码**，仅记录形状差异备查。
- **Kimi K3.1 Pro 的当前 Anthropic 配置无需厂商特调**（2026-10-25 实测）：Fusion Anthropic + SWE 8 个整窗回合全 HTTP 200、`chat-failed`/`provider-degraded` 0；后续回合缓存稳定命中，`output_tokens_details.thinking_tokens` 已映射为非空 `reasoningTokens`。`medium`/`xhigh` effort 均 200，不能按文档枚举假定 400；thinking 块仍无 `signature`，不要据此宣称签名回放闭环。
- **Kimi 的强制工具降级按协议面区分**：Anthropic 在默认思考下强制选择 400，注入 `thinking:{type:'disabled'}` 后 200 并保留指定工具；Chat 也能这样解除，但现有 Chat 链直接降 `auto`，会丢强制语义，只有真机需要时再改。Responses 的 `thinking:{type:'disabled'}` 仍 400，只能降 `auto`；`reasoning.effort:'none'` 也 400，不能作为关闭思考的替代。
- **Kimi Chat 同时执行两种输出上限字段**：`max_tokens:32` 与 `max_completion_tokens:32` 都恰好输出 32 token、`finish_reason:'length'`。因此继续默认发 `max_tokens`，**不新增 `maxTokensField` 配置**；DeepSeek 的「后者被忽略」不能推广到 Kimi。
- **Kimi Responses 可用但不返回 `encrypted_content`**（2026-10-25，7/7 success/200）：信封每轮 `invalid-item` 安全跳过；**不得放宽 `validStateItem`** 把无加密 reasoning 当可回放。

## Chat 面（`apiFormat: 'openai'`）实测（2026-10-22 DeepSeek `/v1`）

- `/models`、`/chat/completions` 均 200；`tool_calls`/强制 `tool_choice` 完整（正常工具调用返回 `finish_reason: "tool_calls"`）。
- **`max_completion_tokens` 不只是「静默接受」，而是被完全忽略**（2026-10-25 实测）：设 40 仍输出 **3234** completion tokens、`finish_reason: "stop"`；改发 `max_tokens: 40` 立刻 `finish_reason: "length"` 且正好 40。故 Chat 面发 **`max_tokens`**，并对「400 且错误正文点名该字段」做一次换名回退（`provider-degraded reason=max-tokens-field`）——官方 OpenAI 推理模型只认另一个名字，是镜像情况。
- Chat 面**已有整窗真机流量**（2026-10-25，Fusion「BYOK Chat + 官方 sidekick / SWE」实跑）：修复前 **33 回合全部** `status: success` + HTTP 200；
  那时发的是被忽略的 `max_completion_tokens`（值 = route 上限 **393216**），实际生效的是 DeepSeek 自己的默认（思考 64K / 非思考 8K），
  单回合输出最大 **4,239**、从未触顶，缓存命中 **99.8%**（`inputTokens 113,078` / `cachedTokens 112,896`）。
  修复后改发 `max_tokens: 393216`（恰为 DeepSeek 文档上限 384K），11 回合全 200、`provider-degraded` **0 次**——该字段被直接接受，换名回退未被需要。
- 直接因果证据（同日探针，用本仓 `buildRequestBody` 直发真实端点）：`max_completion_tokens: 40` → 输出 **3234** tokens / `finish_reason "stop"`；
  `max_tokens: 40` → `finish_reason "length"`、正好 40 tokens。注：小上限下思考会吃掉全部预算，出现「`length` + 零可见文本」是**已记录的刻意行为**（见本卷 `response.incomplete` 条）。
- **思考 token 有无取决于"面"，不取决于厂商**：同一 `deepseek-flash`，Chat 面给
  `completion_tokens_details.reasoning_tokens`（15/17 >0），Anthropic 面给 `thinking_tokens`（0/34）。掉列先看路由。
- `tps` 仅 `hasTools === false` 时计算（`monitor/store.cjs`）；Chat 至今每请求都带工具 → 全 `null` 是**设计**。
- `effort` 来自 provider 配置而非模型名：`efforts: []` + `manual` → 单档 `null`，不发 `reasoning_effort`。
- **判路由两条通道**：`monitor.jsonl` 每行有 `providerId`（`runtime.log` 的 `inference` 没有）＝谁真服务了请求；
  `acp-messages/*.db` 的 `sessions.model` ＝用户选中哪个。两者互证。

## 附件走 `resource_link`，不是 document（2026-10-22 桌面客户端实测）

- **桌面客户端不内联文档字节**：一份 61,341 B 的 PDF 以 `chisel/acp-content-blocks` 里的 `resource_link` 进入消息
  （`uri: file:///…`、`_meta: {"cognition.ai/scope-item-type":"file"}`），`content` 只剩一行 markdown 链接，**节点总长 724 B**。
  对照同一会话的截图消息：**137,580 B**，带 `images[].base64_data`。全会话 5,829 节点统计：`documents` **0** 次、`resource_link` 6 次、含 `images` 5 次。
- 结论：**`documents`（protobuf 21）在该客户端恒为空**，所以 `contentOf` 的 `input_file`（Responses）/ `file`（Chat）/`document`（Anthropic）
  三条映射**真机不可达**，只有测试背书；`attachment_unsupported` 同样**不可触发**——没有东西可拒，别把「日志里没这条」读成「守卫生效」。
- 后果：模型只拿到链接，PDF 正文必须由自己读文件获得（本机 `pypdf`/`pdfplumber` 缺失，`pymupdf` 可用）。
- **不要给 `resource`/`resource_link` 猜一个 wire 映射**：当前没坏是因为 CLI 同时把链接写进了正文；在拿到真实 wire 证据前加映射等于凭想象改协议层。
