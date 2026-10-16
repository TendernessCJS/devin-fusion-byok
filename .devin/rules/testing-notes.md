---
trigger: model_decision
description: "Apply when writing or debugging tests — the installed-renderer skip dependency, the `ps | grep` self-match trap, async-settle limits, and flows not yet verified end to end."
---

## 测试注意

- `test/support/installed-renderer.cjs` 与 5 处条件 `skip` 依赖本机已安装的 Devin 原生渲染文件；缺失时会跳过而非失败。
- **用 `ps | grep <名字>` 排查进程时，注意命中的可能是执行该命令的 bash 自身**：命令文本里一旦出现那个字面量（例如脚本里的 `'backend.cjs'`），`bash -c ...`
  就会一并被匹配，且它的 ppid 正好是 CLI 的 `exec` 父进程——看起来就像「CLI 派生了一个 backend」。曾据此误判出根本不存在的孤儿 backend（2026-10-14）。要确认，
  务必打印**完整命令行**（`ps -o command= -p <pid>`）或直接核对 `/health` 与端口归属；`[b]ackend` 这类写法只能防住 grep 自己，防不住携带同样字面量的父
  bash。
- **等异步效果不要靠「跑几轮 `setImmediate`」**：扩展 fixture 的 `settle(n)` 只排空微任务与 `setImmediate`，**不会让 `setTimeout` 触发**（实测
  20 轮后 `setTimeout(0)` 仍未执行）。依赖真实定时器的行为（例如宿主的推送节流）必须用带 deadline 的轮询等待，
  否则测试会在负载变化时假性通过或假性失败——`extension-lifecycle` 的推送用例就这样脆弱过一轮。反过来，若某断言依赖「节流窗口已过」，等待时间必须**长于**节流间隔，否则删掉节流门控也测不出来。
- **Goal 与 Fast Context 不在本 fork 的验收范围内**（2026-10-16 决定）：两者是上游自带、由上游验证过的**额外功能**，本机不使用，因此**不要**为它们安排真实 Devin 窗口的端到端验收，也不要因为「只有模拟/合成测试」而把它们列为待补缺口。核心逻辑与上游同源或纯搬迁；fork 只改过它们的视图层（`panel/goal-view.cjs`、`panel/fast-context-view.cjs` 的共享 DOM 助手改造），那部分由本仓自身的视图测试覆盖。**精力投在 BYOK + Fusion 基础功能上。**
- **BYOK 三条协议路径的验证状态**（2026-10-16 实测，用真实 key、DeepSeek 端点，走扩展自己的 `serveChat` 完整链路：请求体构造 → 真实 HTTP → SSE 解析 → protobuf 输出）：
  `openai-responses`、`openai`（Chat Completions）、`anthropic`（Anthropic Messages）三条路径**都已协议级真机验证通过**，chat 与 anthropic 路径均验证了**工具调用且参数精确正确**（`multiply` 收到 `{"a":13,"b":7}`）。
  注意两点区分：① 这是**协议级**真机验证（直接调 `serveChat` + 合成请求），不是**整窗 e2e**——真实 Devin 窗口的运行时流量目前只覆盖 `openai-responses`（`deepseek-flash` 与 `deepseek-v4-pro`）；② **Chat Completions 的配置取值是 `openai`，不是 `openai-chat`**：`isChatFormat` 的正则认 `chat`/`openai`/`chat-completions` 等，不认 `openai-chat`（该值会静默落回 responses 格式），面板下拉也只提供 `openai-responses`/`openai`/`anthropic` 三档。DeepSeek 的 Anthropic 兼容端点 `https://api.deepseek.com/anthropic` 同时接受 `/anthropic/messages` 与 `/anthropic/v1/messages` 两个路径，本仓 `endpoint()` 的补路径逻辑无冲突。
- **已实测的「供应商面」行为**（2026-10-16，真实端点、便宜模型、只读探测；只报结构不打印密钥）——这些事实纠正了多处早期误判，改 Responses 语义前先读这一节：
  - **本机 `Proxy`（`https://superaichao.xin/openai`）是直连官方 OpenAI Responses 的转发面，不是兼容面。** 判据是**响应体身份特征**而非域名：`id` 形如 `resp_…`（55 字符）、`object:"response"`、usage 键为 `input_tokens`/`input_tokens_details`/`output_tokens`/`output_tokens_details`/`total_tokens`/`attribution`（官方命名）、`input_tokens_details` 含 `cached_tokens` + `cache_write_tokens`、`store:true` 被接受。**因此不要把「用户只接兼容面」当成跳过官方语义实现的理由**——它正是推理状态通道最相关的场景。
  - **`previous_response_id` 在该面不可用**：`store:true` 返回 200 并给出 `resp_…`，但带 `previous_response_id` 续轮**回 400 `Invalid request.`**。多轮推理延续因此**只能**靠无状态回放——这是状态通道恒开的正当性之一。
  - **篡改 `encrypted_content` 会确定性失败**：把真实 reasoning item 的 `encrypted_content` 尾部或中间改一个字符再回放，**4/4 次**得到 **502 `AIProxy service is temporarily unavailable.`（`error.type:"api_error"`）**——是**网关级 502 而非清晰的 400**。这既是「状态损坏 = 难归因故障」的实证，也是 `replayMatches`（scope 命中 + assistant 文本逐字相等 + 工具 `id`/`name`/规范化参数逐项相同，任一不符即静默回退、**绝不发出**）必须保守的原因。注意 **DeepSeek 不校验**（篡改后仍 200），该风险**只在官方面显现**。
  - **回放本身不被强制**：DeepSeek 与 Proxy 上「回放完整 items」与「省略 reasoning」**都返回 200** 且答案一致。所以状态通道的收益是**语义对齐**，不是修复可用性故障——这是「恒开不改变可用性」判断的依据。
  - **信封真实尺寸**（携带通道的核心风险）：字段 10 的闭合闭环只在 **36 字符** Anthropic 签名上证过；实测信封随回答长度增长——Proxy 无 reasoning 约 **687 B**、带 reasoning 约 **3.4–3.6 KB**，DeepSeek 简单题约 **1.0 KB**、**详细计划题达 43,228 B（≈42 KB）**。「客户端能否原样持久化 42 KB 不透明串」**尚未验证**，而失效方向虽安全（校验不过即回退）却表现为上述难归因的 502——**改动该通道时必须在这个尺寸上实测**。
- **协议事件名以官方 SDK 为权威，别靠猜**（2026-10-16）：官方 SDK 以**只读副本**放在仓库外——本机为 `.refs/openai-node`（`openai@7.34.0`，Apache-2.0，https://github.com/openai/openai-node ）与 `.refs/anthropic-sdk-typescript`（`@anthropic-ai/sdk@0.135.0`，MIT）。该目录**被 `.gitignore` 忽略、不进仓库也不进 VSIX**，clone 本仓的人需自行获取才能对照；**只读参考，不得把 SDK 代码写进 `src/`**，若要写入必须同批在 `THIRD_PARTY_NOTICES.md` 补署名。`.refs/openai-node` 的 `ResponseStreamEvent` 联合是 Responses 流式事件的全集（当时 59 个），
  `src/resources/shared.ts` 的 `ReasoningEffort` 是 effort 取值全集。据此对照出的真实缺口已修：缺 `response.refusal.delta/done`（拒答文本会被**静默丢弃**，
  与「假 anthropic 端点」同属静默失败）、缺 `response.reasoning_text.delta`（当前推理正文事件名）、缺三个 `.done` 变体（只发 done 的供应商会丢内容）。
  两个易踩的字段名陷阱：**`response.refusal.done` 带的是 `refusal` 字段而不是 `text`**（`output_text.done`/`reasoning_text.done` 才是 `text`）；
  `reasoning.generate_summary` 是**被废弃**的旧名，现名是 `summary`（别被「更新」的直觉带反）。同一事件的 `delta` 与 `done` 必须在 `text()` 里用**同一个 key**
  （done 走 `complete=true` 会校验前缀，key 不一致会抛 `upstream_invalid_json`）。
- **`test/sdk-contract.test.cjs` 是防 SDK 漂移的契约测试**（2026-10-16 加）：它**读** `.refs/` 里的官方 SDK 源码，把我们的手写常量与 SDK 字面量做交叉断言——Anthropic `StopReason` 每个成员都必须映射进共享处理器认识的集合、`OutputConfig.effort` 每个取值都必须能到达 `output_config.effort`、`ReasoningEffort` 必须仍覆盖我方取值集合、`ToolChoice` 四个成员接口与出站形状一致、`ThinkingBlockParam.signature` 必须仍是**必需**字段（它一旦变可选，「只在签名在场时回放思考」这条规则就该重审）。
  `.refs/` 被 gitignore，**CI 上不存在**，所以各用例都用 `{ skip: ... }` 在文件缺失时跳过；但「**文件在、却解析不出来**」必须**失败**并提示 layout changed——两者不可混同，否则 SDK 换写法时测试会静默失效。**改这些常量时必须同步跑该文件**，别只看全量计数（CI 上它是 skipped，全绿没有信息量）。
  2026-10-16 扩展四条 Responses 契约：`CustomTool.type` 仍是 `'custom'` 且 `format?` 仍可选、`CustomToolInputFormat.Grammar` 的 `syntax` 仍是 `'lark'|'regex'` 且 `type` 是 `'grammar'`、`ResponseCustomToolCall.input` 必须仍是 `string`（我们「跳过 JSON 校验」完全建立在这条上）、请求参数里 `store` 仍存在且 `ResponseIncludable` 仍含 `'reasoning.encrypted_content'`。四条均已做过变异验证（逐个改坏 `.refs` 对应行 → 恰好该条失败 → `cp`/`diff -q` 逐字节还原），基线 `skipped 0`。
- **给「防漂移」类测试加断言后，要用变异法证明它真的有牙**（2026-10-16 实测，3/3 命中）：把源码临时改坏（删 `pause_turn` 映射、从 `EFFORTS` 删 `max`、让 `tool_choice` 丢掉 `any`）后逐个跑该测试文件，确认**恰好对应的那一条**失败，再逐字节还原（`cp` 备份 → `diff -q` 校验），最后 `rm` 掉备份。基线要同时确认 `skipped 0`——否则「全绿」可能只是整个文件被跳过。不做这一步时，「断言写得像那么回事但其实恒真」的测试和真测试长得一模一样。
- **「HTTP 200 + text/event-stream」不足以判定供应商可用**：中转/网关会给不存在的路径返回 200 的 HTML 兜底页，甚至把 anthropic 路径**透传**成
  Responses 格式（`object:"response"`、id 前缀 `resp_`、SSE 首帧 `response.created`）——此时传输层全部正常，只是我们的 anthropic 适配器不认这些事件名，
  于是**状态 200、日志 chat-complete、回答为空**。判据只能是**响应体形状**（事件名/字段），不是状态码或 content-type。
- **零输出成功检测**（`upstream_empty_output`，2026-10-16 加）：`serveChat` 在 `processor().finish()` 里判定「正常完成、无工具调用、
  且整条流从未产生任何文本/思考」→ 抛错并在流里输出 `Provider returned no output.`。这是**通用兜底**：未来任何事件名变更或未知供应商行为都会
  变成响亮错误而不是静默空回答。截断（`response.incomplete`）与 content_filter 不触发。给供应商加新事件时，`tracker.cjs` 的 `semanticOutput()`
  要同步，否则面板的 `firstOutputMs`/吞吐统计会漏。
- **审「这段代码还活着吗」时，`require` 图会漏掉「路径型入口」**：`src/goal/report.cjs` 没有任何 `require` 指向它，是 `goal/state.cjs`
  把它的**绝对路径拼进 shell 命令**交给 agent 执行（入口在 `extension.cjs` 的 `reportCliPath`）。纯靠模块依赖图做死代码分析会把它报成死模块（2026-10-15
  实际误判过一次）。判死前先搜「文件名字符串是否出现在代码里」（`grep -rn "$(basename X)" src/`），再下结论。
- 「重启 Devin」触发即退出 Devin，无法在会话内端到端验证；其探测与时序由 `test/app-restart.test.cjs` 的合成 app 覆盖。

