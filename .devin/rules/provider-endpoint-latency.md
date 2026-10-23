---
trigger: model_decision
description: "Apply when diagnosing slow first response, upstream_timeout / upstream_stream_error failures, or deciding timeout budgets for a provider endpoint."
---

# 端点延迟与超时判据（provider-endpoint-latency）

2026-10-23 本机会话诊断。以下是当时日志快照和独立请求的观测，不代表端点长期可用性；改超时预算或归因前先区分证据与推断。

## 极小请求的响应头时间

方法：终端 Node fetch 使用各 provider 已配置凭据，发送极小流式请求，不经过插件 backend。Proxy 用 Responses 格式、`gpt-6.1-sol`、`input:"hi"`；DeepSeek Chat 用 Chat Completions 格式、`deepseek-flash`、单条 `hi`。未显式设置 effort。只输出时间与状态，不输出凭据或响应正文。

| 端点 | HTTP 状态 | 响应头时间 |
| --- | --- | --- |
| `Proxy` = `https://superaichao.xin/openai` | 200 | 13.1s / 12.4s / 18.4s（3 次） |
| `DeepSeek Chat` = `https://api.deepseek.com/v1` | 200 | 0.17s / 0.10s（2 次） |

这说明 Proxy 的极小请求也观察到了较长等待。两个样本组的模型、协议和推理配置不同，不能据此把时间差全部归因为 relay 排队，也不能排除大请求或状态回放对实际会话的影响。探针没有解析完整终止事件，HTTP 200 不等于已验证推理成功。

## 历史记录快照的统计口径

当时 `monitor.jsonl` 中 `gpt-6.1-sol` 共 186 条：175 success、10 error、1 cancelled。10 条 error 包括 `upstream_timeout` 5、`upstream_stream_error` 4、`upstream_http` 1（HTTP 402）。按全部请求为分母，error 为 **10/186 ≈ 5.38%**；取消请求单列，不能算端点故障。

DeepSeek Anthropic provider 的 4816 条记录中有 8 条非 success；当时未拆分 error/cancelled，不能直接称为失败率。不同 provider 的模型、协议、时间窗口和负载也不同，不能用比值证明端点是唯一原因。

在上述 175 条成功且有 `firstOutputMs` 的记录中，首输出 p50 **21.7s**、p90 **52.8s**、p99 **66.2s**、max **81.7s**（按排序下标 `floor((n-1)*p)` 取值）。这不是响应头时间或面板 `firstResponseMs`，也未按 effort 分组；失败请求未进入该分布。

## 本次两条失败

- 本地时间 **08:01:19** 开始：120.004s 后 `upstream_timeout`、HTTP 状态记录为 0、transport 为 AbortError，首输出为空。结合 `serveChat` 代码，符合等待上游响应头时插件的默认计时器触发取消；日志不能区分 DNS、连接、TLS、上传、服务端等待等阶段，也不能证明上游若继续等待是否会成功。
- 本地时间 **08:03:32** 开始：HTTP 200，约 3.816s 有首输出，9.522s 后收到 `response.failed`；日志为 `upstream_stream_error`、`errorCode: server_error`、`errorType: service_unavailable_error`。此前已观察到 `response.created`、`response.in_progress`、输出 delta 和 output_item.done 等事件。这里能确认端点主动报告失败，无法仅凭该帧定位 relay 还是其上游模型服务故障。
- 第二条没有完整用量（`usageState: missing`），面板 token 显示 `—` 符合记录，不应推算成零 token。两条记录不足以证明或排除本次重构与所有端点故障的关联。

## 超时实际作用范围

- `src/protocol/inference.cjs` 的 `serveChat`：发送前启动 `firstResponseLimit`，默认 **120000 ms**；fetch 返回响应头后清除。随后对每次流读取启动默认 **120000 ms** 的 idleLimit，成功读取后清除。因此前者是响应头等待预算，后者是逐次读取的空闲预算，不是整次请求的总时长。
- `src/runtime/backend.cjs` 命中 BYOK route 后直接调用 `serveChat`，未传 timeouts，实际使用默认值。
- `src/runtime/bridge.cjs` 的 `forward` 另有 connect/headers/body 预算，普通 headers/body 默认也是 120000 ms，但它属于转发路径。**不能仅凭相同数字认定 bridge 位于上述 BYOK 推理的必经链路，也不能要求放宽时两处一律同步修改**；应先确认请求实际走哪条路径。推送 RPC 的独立长空闲预算仍按 runtime 规则处理。

## 后续判断边界

本次确认了插件主动超时和端点显式失败两种机制。响应头探针等待已包含连接、上传和服务端等待，历史首输出时间同样从请求开始计算；两者不能相加，否则会重复计时。现有数据不足以确认排队时长、请求体影响或延长超时后的成功率。

记录本身不改变超时或重试。后续若调整预算或重试，应按实际请求路径验证取消、资源释放、部分输出和工具调用的重复风险，并保留有界等待。

## 2026-10-24 00:02 一次「零字节」超时（Anthropic 端点，不是 relay）

本地 00:02:26（UTC+8）本机会话实测。与上面两条 Proxy 失败**不是同一端点**，不能合并归因。

- 通道：provider `DeepSeek` = `https://api.deepseek.com/anthropic/v1`（Anthropic Messages），providerId `provider-9f5adb21…`，模型 `deepseek-flash`、effort `high`；`monitor.jsonl` 记录 id `1d9c1743-…`。
- 记录：`upstream_timeout`、`httpStatus 0`、`firstOutputMs` / `firstTextMs` 均为 null、`usageState: missing`、持续 **120,005 ms**；`runtime.log` 同时段 `chat-error` 的 transport 为 `AbortError`。与 `serveChat` 默认 `firstResponseLimit` 一致，是**插件计时器**取消，不是上游回的错误帧。
- 对照（同一 provider、同一模型）：失败前 7.3s（16:02:19.573Z）一条 `inputTokens 312,984` 的请求 `firstTextMs 6,433`、总 7,078 ms 成功；失败后 16:06:46Z 起连续成功（输入降到约 178,718，疑似期间发生过压缩）。
- 6 小时窗口（10:02:26Z–16:02:26Z，provider-9f5adb21）：**277 success / 2 error / 3 cancelled**。成功且 `firstOutputMs` 可用 277 条：p50 **2,498 ms**、p90 **25,743 ms**、p99 **52,944 ms**、max **85,081 ms**；`firstTextMs`：p50 **6,967 ms**、p90 **33,441 ms**、p99 **47,002 ms**、max **52,190 ms**。
- 该 provider 全部 4,925 条 `deepseek-flash` 记录中 error 仅 4 条：`upstream_invalid_tool` 2 条（`httpStatus 200`）、`upstream_network` 1 条（ECONNRESET，1,798 ms，14:11:44Z）、`upstream_timeout` 1 条（本次）。

边界：

- 零字节 120s 只说明该请求在上限内**没拿到响应头**；日志无法区分 DNS、建连、TLS、上传、服务端排队卡在哪一步，也**不能**据此说该端点整体变慢——同尺寸请求在它前后几秒内都成功了。
- 反过来，同尺寸成功也不能排除上下文规模的影响：这次失败紧接在 `inputTokens ≈ 313k` 之后，但同一规模的前一条成功，**规模不是充分条件**。
- 因此**不建议**拿「调高上限」当处理方式：等待更久对零字节停滞没有证据收益；且 `firstResponseLimit` 是响应头预算，不是整次请求总时长。

重试面（该次未开启，随后由用户开启 `autoContinueOnProviderError`）：

- 超时现在有专属文案 `Provider response timed out after <预算>s/ms`（`src/protocol/inference.cjs` 按 `status` 选 `firstResponseLimit` 或 `idleLimit`）；`upstream_stream_error` / `upstream_stream_incomplete` / `upstream_network` 仍走通用文案 `Provider response could not be completed.`。两类文案都被 `src/runtime/host/auto-continue.cjs` 匹配为可重试目标（`TARGET_ERROR` + `TIMEOUT_RE`）；终止判定 `TERMINAL_BLOCKER_RE` 只匹配 `Provider returned HTTP 4xx/5xx.` 与格式类错误，所以这两类文案**都会**被自动重试。匹配失败只在 tail 末尾 400 字符含「provider response」时记 `auto-continue-miss`（只记 `reason`/`tailLength`/布尔量/`stopReason`，绝不记正文），据此区分 `tail-mismatch`/`session-suppressed`/`retry-disallowed`/`reject-mismatch`。
- 预算：`ERROR_ATTEMPT_LIMIT = 5`、`ERROR_WINDOW_MS = 10 min`，超出即停止，不会无限重试。
