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
- **已实测的「供应商面」行为**（2026-10-16，真实端点、便宜模型、只读探测；只报结构不打印密钥）——这些事实纠正了多处早期误判，改 Responses 语义前先读这一节：
  - **本机 `Proxy`（`https://superaichao.xin/openai`）是直连官方 OpenAI Responses 的转发面，不是兼容面。** 判据是**响应体身份特征**而非域名：`id` 形如 `resp_…`（55 字符）、`object:"response"`、usage 键为 `input_tokens`/`input_tokens_details`/`output_tokens`/`output_tokens_details`/`total_tokens`/`attribution`（官方命名）、`input_tokens_details` 含 `cached_tokens` + `cache_write_tokens`、`store:true` 被接受。**因此不要把「用户只接兼容面」当成跳过官方语义实现的理由**——它正是推理状态通道最相关的场景。
  - **`previous_response_id` 在该面不可用**：`store:true` 返回 200 并给出 `resp_…`，但带 `previous_response_id` 续轮**回 400 `Invalid request.`**。多轮推理延续因此**只能**靠无状态回放——这是状态通道恒开的正当性之一。
  - **篡改 `encrypted_content` 会确定性失败**：把真实 reasoning item 的 `encrypted_content` 尾部或中间改一个字符再回放，**4/4 次**得到 **502 `AIProxy service is temporarily unavailable.`（`error.type:"api_error"`）**——是**网关级 502 而非清晰的 400**。这既是「状态损坏 = 难归因故障」的实证，也是 `replayMatches`（scope 命中 + assistant 文本逐字相等 + 工具 `id`/`name`/规范化参数逐项相同，任一不符即静默回退、**绝不发出**）必须保守的原因。注意 **DeepSeek 不校验**（篡改后仍 200），该风险**只在官方面显现**。
  - **回放本身不被强制**：DeepSeek 与 Proxy 上「回放完整 items」与「省略 reasoning」**都返回 200** 且答案一致。所以状态通道的收益是**语义对齐**，不是修复可用性故障——这是「恒开不改变可用性」判断的依据。
  - **信封真实尺寸**（携带通道的核心风险）：字段 10 的闭合闭环只在 **36 字符** Anthropic 签名上证过；实测信封随回答长度增长——Proxy 无 reasoning 约 **687 B**、带 reasoning 约 **3.4–3.6 KB**，DeepSeek 简单题约 **1.0 KB**、**详细计划题达 43,228 B（≈42 KB）**。「客户端能否原样持久化 42 KB 不透明串」**尚未验证**，而失效方向虽安全（校验不过即回退）却表现为上述难归因的 502——**改动该通道时必须在这个尺寸上实测**。
  该通道的体积与回放结果现在有四个日志事件（`runtime.log`，仅是观测，回放/丢弃语义未变，`MAX_STATE_BYTES` 仍是 256 KB 上限）：
  `state-envelope-size`{model,bytes,bucket} 每次发射都记（桶 1k/4k/16k/64k/256k/over-max）；`state-envelope-oversize`{model,bytes,limit}
  记超限丢弃——**以前是静默丢弃**，现在每次发生都有行；`state-envelope-replayed`{model,bytes,bucket,items} 只在输入侧真的完成回放时记，
  出现 `bucket:64k` 即证明 ≈42 KB 信封能原样往返，可据此关掉「客户端能否持久化」的疑问；`state-envelope-replay-failed`{model,mismatch,unparsable,oversize}
  按请求聚合三种回退，`scope`/`invalid` 属合法降级（换 provider/模型、空 items）**不计入**失败。
  - **DeepSeek 的 `encrypted_content` 是占位桩，不是真状态**（2026-10-17 实测，按本仓**真实发出的请求体**直探 `api.deepseek.com/v1/responses`：`store:false` + `include:['reasoning.encrypted_content']` + `reasoning:{effort:'high',summary:'auto'}`）：HTTP 200，`output` 为 `reasoning, message`，事件族完整；但 reasoning item 的 `encrypted_content` 仅 **38 字符**、`summary` 是**空数组**。回放这些 items 被接受（200、无错误事件），**但并不能减少推理开销**（见下条对照实验）。结论：状态通道在 DeepSeek 上**既无收益也无害**，真正的收益面是官方 Responses 转发面（Proxy）。
  - **判「某改动是否引入问题」必须带对照臂**（2026-10-17 实测，值得作为方法保留）：单臂看到「回放 reasoning 后 `response.incomplete` + 零文本」时，很容易归因成「回放导致推理暴涨」；加入「**丢弃 reasoning、只回放 message**」的对照臂后行为**完全相同**（A 回放 3010 / B 不回放 2522 推理 token），真因是 **DeepSeek 在 `effort:high` 下连一句 trivial 追问也要烧 1.7k–3k 推理 token**，在 4096 这类小预算上恰好卡边界（同一请求两次跑，一次耗尽 4096 → incomplete，一次 3010 → 正常）。真实预算（本仓默认 `maxOutputTokens` 131072）下不构成风险。
  - **`response.incomplete` 不触发零输出兜底，得到的是「空答 + stop 3」**（2026-10-17 实测闭环，代码依据 `inference.cjs` 的 `case 'response.incomplete'`）：incomplete 被映射为 stop reason 3（长度截断），而 `upstream_empty_output` 守卫**只覆盖 `reason === 2`**。因此截断且未产出文本时，用户看到的是一条**空消息**而非错误——这是**刻意的**（provider 确实截断了，stop 3 本身就是诚实的截断信号），排障时不要当成 bug。复现方式：小 `max_output_tokens` 配高 effort。
- **协议事件名以官方 SDK 为权威，别靠猜**（2026-10-16，2026-10-22 升级快照）：官方 SDK 以**只读副本**放在仓库外——本机为 `.refs/openai-node`（`openai@7.41.0`，Apache-2.0，https://github.com/openai/openai-node ）与 `.refs/anthropic-sdk-typescript`（`@anthropic-ai/sdk@1.1.0`，MIT）。该目录**被 `.gitignore` 忽略、不进仓库也不进 VSIX**，clone 本仓的人需自行获取才能对照；**只读参考，不得把 SDK 代码写进 `src/`**，若要写入必须同批在 `THIRD_PARTY_NOTICES.md` 补署名。`.refs/openai-node` 的 `ResponseStreamEvent` 联合是 Responses **HTTP 流**事件的全集（7.41.0 为 **59** 个成员，本仓处理 18 个 + 1 个扩展 `response.reasoning.delta`，未处理 41 个——**按联合成员逐个解析 `type` 字面量统计，不要全文 grep**：全文扫描会把 `response.steer.*`、`response.create` 等 WebSocket/客户端事件一起算进来，历史上因此误报成「64 个、缺 46 个」）。
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

- **强制 `tool_choice` 与默认开启的思考互斥**：两家都返回 400（DeepSeek `Thinking mode does not support this tool_choice`、Moonshot `tool_choice 'specified' is incompatible with thinking enabled`），且**都支持** `thinking:{type:'disabled'}`。**DeepSeek 已验证「关闭思考 + 保留强制选择」→ 200 且只返回 `tool_use`**；Moonshot 该组合**尚未测**，别写成两家都验过。
  因此降级链定为**两步、有界**：①（仅 anthropic 且请求体原本没有 `thinking`）先注入 `thinking:{type:'disabled'}` 重试，**保住用户的强制选择**；②仍失败才把 `tool_choice` 降为 `auto`，并**把我们注入的 `thinking` 摘掉**——否则厂商若本来拒的是该字段，第三次会白失败。两次降级各自记 `provider-degraded`，`reason` 分别是 `thinking-disabled` / `tool-choice`。非 anthropic 路径没有这个杠杆，维持直接降级。判据仍是「HTTP 400 且错误文本包含 `tool_choice`」，`auto`/`none` 永不重试。
- **`thinking_tokens` 必须映射，否则统计留空而非虚高**：SDK 的 `usage.output_tokens_details.thinking_tokens` 要被读成适配器内部的 `completion_tokens_details.reasoning_tokens`（`output_tokens` 本身是含思考的权威总数，不要改）。Moonshot 实测**返回**该字段、DeepSeek 不返回。此前推断「未映射会让可见 token/tps 虚高」**是错的**：`tracker` 有门控——只要有 thinking 块却拿不到 reasoningTokens，`visibleTokens`/`tps` 直接为 `null`。可见症状是**指标缺列**，不是数字偏大。
- **思考不可控是能力缺口**：两家都不发 `thinking` 也返回 thinking 块（思考默认开），`budget_tokens` 能改思考量、`disabled` 能关，而本仓没有开关/预算入口。要加就得同时暴露「关」与「预算」，否则用户仍然无法约束成本。
- **base path 是厂商相关**：Moonshot 上 `/anthropic/messages` 为 **404**、`/anthropic/v1/messages` 才 200；DeepSeek 两个路径都 200（宽容，不是规范）。面板填厂商文档给的 `…/anthropic` 在 Moonshot 上**必然 404**，排障先看这一条。
- **签名闭环只在有签名的厂商成立**：DeepSeek 返回 36 字符签名且原样回放 200；Moonshot 不返回签名，所以续轮只能省略 signed thinking 块（`FOREIGN_STATE_PREFIX` 之外，脱敏数据另有 `dfbyok-redacted-v1:` 通道，见 `acp-protocol-fields.md`）。缺签名不等于工具多轮不可用，需厂商专项测试再下结论。**补测（2026-10-22）：把 `signature` 删掉再回放，DeepSeek 仍返回 200**——它不校验签名，所以
  「签名回放 200」不能证明我们保真，只有真 Anthropic 端点能戳穿；同理，本地全绿也不代表签名通道正确。

## 附件走 `resource_link`，不是 document（2026-10-22 桌面客户端实测）

- **桌面客户端不内联文档字节**：一份 61,341 B 的 PDF 以 `chisel/acp-content-blocks` 里的 `resource_link` 进入消息
  （`uri: file:///…`、`_meta: {"cognition.ai/scope-item-type":"file"}`），`content` 只剩一行 markdown 链接，**节点总长 724 B**。
  对照同一会话的截图消息：**137,580 B**，带 `images[].base64_data`。全会话 5,829 节点统计：`documents` **0** 次、`resource_link` 6 次、含 `images` 5 次。
- 结论：**`documents`（protobuf 21）在该客户端恒为空**，所以 `contentOf` 的 `input_file`（Responses）/ `file`（Chat）/`document`（Anthropic）
  三条映射**真机不可达**，只有测试背书；`attachment_unsupported` 同样**不可触发**——没有东西可拒，别把「日志里没这条」读成「守卫生效」。
- 后果：模型只拿到链接，PDF 正文必须由自己读文件获得（本机 `pypdf`/`pdfplumber` 缺失，`pymupdf` 可用）。
- **不要给 `resource`/`resource_link` 猜一个 wire 映射**：当前没坏是因为 CLI 同时把链接写进了正文；在拿到真实 wire 证据前加映射等于凭想象改协议层。
