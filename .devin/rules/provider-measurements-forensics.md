---
trigger: model_decision
description: "provider-measurements 的实测依据——Proxy/DeepSeek 各面的探针证据、篡改与回放实验、信封真实尺寸、对照臂方法；判「某改动是否引入问题」或动状态通道前必读。"
---

# 供应商面实测依据（provider-measurements-forensics）

本卷是 `provider-measurements.md` 的实证部分，**逐字搬出**：只记探针怎么打的、测出了什么、当时的误判是如何被推翻的。
契约与禁令留在 `provider-measurements.md`；两者冲突时以契约卷为准。

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

## Kimi K3.1 Pro 字段探针（2026-10-25）

真实 key 仅用于进程内请求、未打印或落盘。探针结论：

- **Anthropic**：baseline / `medium` / `xhigh` effort 均 200；thinking 块 `signatureLength=0`。
- **强制工具**：默认思考下 forced → 400 `tool_choice 'specified' is incompatible with thinking enabled`；forced + `thinking:{type:'disabled'}` → 200 且 `tool_use=probe_echo`。
- **Chat**：`max_tokens:32` 与 `max_completion_tokens:32` 均恰输出 32 token、`finish_reason:'length'`；forced + thinking disabled + `reasoning_effort:'high'` → 200 / `tool_calls`。
- **Responses**：forced + `thinking:{type:'disabled'}` → 400；`reasoning.effort:'none'` → 400。
- **缓存**：顶层 `cache_control:{type:'ephemeral',ttl:'1h'}` → 200，但短请求 `cache_creation`/`cache_read` 全 0——只能证明字段被接受，不能证明缓存创建/命中或 TTL 生效。
- **自动缓存命中**：真机第二轮示例 `input 49856` / `cached 49408`，共 8 轮中首轮未命中、其余 7 轮均命中；不断言它由消息级断点造成。

### Kimi Responses 整窗回合与 `encrypted_content` 缺失（2026-10-25）

- **真机流量**：Kimi Responses provider 7 个整窗回合 **7/7 `status:success` + HTTP 200 + `usageComplete`**，全部带工具；`chat-failed`/`provider-degraded`/`upstream-retry`/`tool-claim-mismatch`/`tool-name-unknown` 均 0；最新回合 `input 112828` / `cached 112384`。普通多轮与自动缓存正常。
- **状态通道边界（非主链路失败）**：7 次全部 `state-envelope-skipped reason=invalid-item`，`state-envelope-size`/`-replayed` 均 0。跳过信封是既有安全降级，普通历史投影不受影响。
- **根因（同参数真实非流式探针）**：请求含 `store:false` + `include:['reasoning.encrypted_content']` + `reasoning summary:'auto'`，HTTP 200 `completed`；reasoning item 只有 `id/status/summary/type`，**完全没有 `encrypted_content` 属性**（不是空串）；message item 合法。`validStateItem` 要求 `reasoning.encrypted_content` 为非空 string → 判 `invalid-item`。**不能把 Kimi 称为占位加密状态——它根本没提供该字段**（区别于 DeepSeek 的 38 字符占位桩）。
- **处置**：当前不修协议、不放宽 `validStateItem`、不加厂商分支或重试；「把 `missing-encrypted-content` 记成更具体 reason」留待以后。

### Moonshot 三面样本（2026-10-25）

- Anthropic **15/15** success/200/usageComplete（14 工具回合 + 1 纯文本）；Chat **3/3**（2 工具 + 1 纯文本）；Responses **7/7**（7 工具）。仅作样本计数，**不做性能排名**。
