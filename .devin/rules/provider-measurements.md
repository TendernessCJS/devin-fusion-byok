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
  - **DeepSeek 的 `encrypted_content` 是占位桩，不是真状态**（2026-10-17 实测，按本仓**真实发出的请求体**直探 `api.deepseek.com/v1/responses`：`store:false` + `include:['reasoning.encrypted_content']` + `reasoning:{effort:'high',summary:'auto'}`）：HTTP 200，`output` 为 `reasoning, message`，事件族完整；但 reasoning item 的 `encrypted_content` 仅 **38 字符**、`summary` 是**空数组**。回放这些 items 被接受（200、无错误事件），**但并不能减少推理开销**（见下条对照实验）。结论：状态通道在 DeepSeek 上**既无收益也无害**，真正的收益面是官方 Responses 转发面（Proxy）。
  - **判「某改动是否引入问题」必须带对照臂**（2026-10-17 实测，值得作为方法保留）：单臂看到「回放 reasoning 后 `response.incomplete` + 零文本」时，很容易归因成「回放导致推理暴涨」；加入「**丢弃 reasoning、只回放 message**」的对照臂后行为**完全相同**（A 回放 3010 / B 不回放 2522 推理 token），真因是 **DeepSeek 在 `effort:high` 下连一句 trivial 追问也要烧 1.7k–3k 推理 token**，在 4096 这类小预算上恰好卡边界（同一请求两次跑，一次耗尽 4096 → incomplete，一次 3010 → 正常）。真实预算（本仓默认 `maxOutputTokens` 131072）下不构成风险。
  - **`response.incomplete` 不触发零输出兜底，得到的是「空答 + stop 3」**（2026-10-17 实测闭环，代码依据 `inference.cjs` 的 `case 'response.incomplete'`）：incomplete 被映射为 stop reason 3（长度截断），而 `upstream_empty_output` 守卫**只覆盖 `reason === 2`**。因此截断且未产出文本时，用户看到的是一条**空消息**而非错误——这是**刻意的**（provider 确实截断了，stop 3 本身就是诚实的截断信号），排障时不要当成 bug。复现方式：小 `max_output_tokens` 配高 effort。
- **协议事件名以官方 SDK 为权威，别靠猜**（2026-10-16）：官方 SDK 以**只读副本**放在仓库外——本机为 `.refs/openai-node`（`openai@7.34.0`，Apache-2.0，https://github.com/openai/openai-node ）与 `.refs/anthropic-sdk-typescript`（`@anthropic-ai/sdk@0.135.0`，MIT）。该目录**被 `.gitignore` 忽略、不进仓库也不进 VSIX**，clone 本仓的人需自行获取才能对照；**只读参考，不得把 SDK 代码写进 `src/`**，若要写入必须同批在 `THIRD_PARTY_NOTICES.md` 补署名。`.refs/openai-node` 的 `ResponseStreamEvent` 联合是 Responses 流式事件的全集（当时 59 个），
  `src/resources/shared.ts` 的 `ReasoningEffort` 是 effort 取值全集。据此对照出的真实缺口已修：缺 `response.refusal.delta/done`（拒答文本会被**静默丢弃**，
  与「假 anthropic 端点」同属静默失败）、缺 `response.reasoning_text.delta`（当前推理正文事件名）、缺三个 `.done` 变体（只发 done 的供应商会丢内容）。
  两个易踩的字段名陷阱：**`response.refusal.done` 带的是 `refusal` 字段而不是 `text`**（`output_text.done`/`reasoning_text.done` 才是 `text`）；
  `reasoning.generate_summary` 是**被废弃**的旧名，现名是 `summary`（别被「更新」的直觉带反）。同一事件的 `delta` 与 `done` 必须在 `text()` 里用**同一个 key**
  （done 走 `complete=true` 会校验前缀，key 不一致会抛 `upstream_invalid_json`）。
- **「HTTP 200 + text/event-stream」不足以判定供应商可用**：中转/网关会给不存在的路径返回 200 的 HTML 兜底页，甚至把 anthropic 路径**透传**成
  Responses 格式（`object:"response"`、id 前缀 `resp_`、SSE 首帧 `response.created`）——此时传输层全部正常，只是我们的 anthropic 适配器不认这些事件名，
  于是**状态 200、日志 chat-complete、回答为空**。判据只能是**响应体形状**（事件名/字段），不是状态码或 content-type。
- **零输出成功检测**（`upstream_empty_output`，2026-10-16 加）：`serveChat` 在 `processor().finish()` 里判定「正常完成、无工具调用、
  且整条流从未产生任何文本/思考」→ 抛错并在流里输出 `Provider returned no output.`。这是**通用兜底**：未来任何事件名变更或未知供应商行为都会
  变成响亮错误而不是静默空回答。截断（`response.incomplete`）与 content_filter 不触发。给供应商加新事件时，`tracker.cjs` 的 `semanticOutput()`
  要同步，否则面板的 `firstOutputMs`/吞吐统计会漏。
