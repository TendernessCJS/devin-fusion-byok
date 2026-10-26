---
trigger: model_decision
description: "Apply before changing Anthropic or Chat wire semantics — the per-protocol contracts split out of provider-measurements.md."
---

# 供应商面实测：Anthropic 与 Chat 两个协议面

本卷与 `provider-measurements.md` 是**按协议面**拆的姊妹卷（2026-10-26 逐字搬运，只补指针句、不加新论断）：Responses 面与跨面契约留在原卷，Anthropic / Chat 两个协议面的契约在本卷。实证依据仍在 `provider-measurements-forensics.md`。

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
