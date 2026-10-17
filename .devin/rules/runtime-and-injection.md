---
trigger: model_decision
description: "Apply when changing ACP/LS injection, backend lifecycle or shutdown, logging, owned-settings writes, retry budgets, security checks, or the backend SOURCE_FILES list."
---

# 运行时与注入（runtime-and-injection）

Devin 私有接口依赖、ACP/LS 注入、backend 生命周期与关闭、日志与密钥纪律、用户设置写入、重试预算、安全边界。

- 全部为 CommonJS（`.cjs`），`package.json` 无 `dependencies`。**不要引入运行时依赖**，也不要改成 ESM。
- 日志只允许记录模型名、工具名、状态码、计数。**禁止**把 `apiKey`、控制令牌、`authorization` 头、对话正文写入 output channel 或 `runtime.log`；新增日志前确认
  payload 不含凭证。
- 用户可见文案（面板、错误消息、README、命令标题）用中文；代码注释用英文。
- 面向供应商的发现与推理请求必须带 `redirect: 'error'`，避免密钥和对话被重定向到其他地址。
- 写用户设置（`devin.acp.agentEnv` / `devin.acp.agentPreferences`）必须走 `src/lifecycle/owned-settings.cjs` 的 receipt
  流程，且 key 需在 `permitted()` 白名单内，保证可回滚。不要直接写 `settings.json`。
- 服务商错误自动继续的连续预算是 **5 次自动重试 / 10 分钟窗口**；触顶必须停止、结算等待中的请求并提示用户。待办无进展停止规则与 Goal 的预算独立，不能互相绕过。

- 新增 backend 运行时模块**必须**同时加入 `backend.cjs` 的 `SOURCE_FILES`（它参与 `sourceId()` 哈希，漏加会导致同版本重装不重启 backend，
  新代码永远不生效）。

- 本扩展不修改 Devin 应用本体、不重新签名、不安装证书、不改系统代理。保持这个前提。
- 强依赖 Devin 私有接口：LS `Heartbeat` 抓端口（`src/runtime/ls-injection.cjs`）、catalog 的 protobuf 字段号与 Connect
  帧（`src/protocol/wire.cjs`、`src/catalog.cjs`）、ACP 连接器面（`windsurfAcp.registerConnection` /
  `connector.sendRequest` / `connector.forwardClientRequest`，被 `acp-observer.cjs`、`auto-continue.cjs`、
  `goal/continue.cjs` 观察与包装）、CLI 的 `WINDSURF_API_SERVER_URL` env 覆盖（经 `devin.acp.agentEnv` 受管设置注入，ACP
  通道的实际入口）、Fast Context 的 `GetDevstralStream`（`src/fast-context/protocol.cjs`）。这些接口不稳定，改动附近代码时按「可能失败」处理，
  不要在失败路径上伪装成功。
- **`src/protocol/` 是三种关注点的混合体，不要按目录名推断文件职责**（5 个文件，2026-10-17 核对）：① 协议转换 —— `acp.cjs`（**Devin 侧**：解析
  `exa.chat_pb` 原生请求 + 造出站 ACP chunk）、`inference.cjs`（**三协议统一编排**：`serveChat`/`endpoint` 路由/请求体/SSE/有界降级/推理状态通道；
  **不是 Responses 专用**）、`anthropic.cjs`；② 字节层 —— `wire.cjs` 是**全仓共享**的 proto 读写/framing/gzip 工具，`catalog/*`、`fast-context/`、
  `runtime/` 都直接依赖它，**不是协议专用**；③ 埋点 —— `tracker.cjs` 是计量（→ monitor），它落在 `protocol/` 是**依赖图决定而非语义决定**：为消除
  `protocol → runtime` 反向依赖才从 `runtime/monitor.cjs` 移出，**不能搬回 `runtime/`**（`runtime/backend.cjs` 本就 import `protocol/inference.cjs`，
  搬回即成环）。旧名对照：`chat.cjs → acp.cjs`、`responses.cjs → inference.cjs`——旧名正是误读源头（前者与 Chat Completions 无关，OpenAI Chat 的请求体在
  `inference.cjs`）。**撞名警告**：`src/fast-context/protocol.cjs` 是**另一个** protocol（Fast Context 的 MCP 实现），且它反向 import
  `src/protocol/wire.cjs`——两条路径别混。在 `protocol/` 内增删/改名文件时，除 `SOURCE_FILES` 外还要留意**不靠 `require` 的隐式引用**（按模块名打桩的
  字符串键、`readFileSync` 的路径、`AGENTS.md` 里按路径写的说明），这类漏改不报错、只静默失效。
- `AssignModel` 本地应答不含 `assignment_jwt`（官方 `ModelAssignment` 响应带该字段）。当前 CLI（3000.10.48 实测）不校验；若未来版本强制校验，
  本地指派整体失效——届时改为转发上游或显式降级，不得伪造成功。
- 修改行为时不要放宽现有安全校验（Origin 一律 403、控制令牌 `timingSafeEqual`、webview 只用 `createElement`/`textContent` 不用
  `innerHTML`、CSP nonce）。

- **backend 的 ingest 必须拒绝我方 uid**（`/^(?:fusion-)?dfbyok-/`）：宿主的读取端把「被提供的 dfbyok uid」当作非法目录并直接抛
  `native_catalog_invalid`，一旦 backend 存了我方条目，**宿主的每一次 refresh 都会失败**。`pushNativeModels` 与 `isUpstreamUid`
  共用同一个谓词，避免两侧漂移。

- **关闭路径的每一段等待都必须有上限**：`close()` 里三段等待（在途请求排水、监控队列 flush、`server.close()` 等连接结束）原本都无上限。半读的 SSE 流会让请求既不 finish
  也不 close → `release()` 永不执行 → 排水永不完成 → `close()`/`stopped` 永不 resolve；而 SIGTERM 的处理器本身就在 `await close()`，
  于是**信号变成空操作**，进程只能 SIGKILL（2026-10-14 实测：必须 `kill -9` 才清掉孤儿 backend）。现在三段都用 `drainTimeoutMs` 兜底，超时后
  `closeAllConnections()` 强制收尾并继续走到 `stopped`，保证「关得掉、也杀得掉」。**不要退回无上限等待**，也不要只在超时日志里记录而不强制关闭。
