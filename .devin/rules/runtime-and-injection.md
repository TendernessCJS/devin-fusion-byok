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
  已配置 `http.proxy` 时 `enable()` 还会经同一 receipt 写入 `NO_PROXY=127.0.0.1,localhost,::1` 回环豁免，代理清空后由迁移分支自动还原。
- 服务商错误自动继续的连续预算是 **5 次自动重试 / 10 分钟窗口**；触顶必须停止、结算等待中的请求并提示用户。待办无进展停止规则与 Goal 的预算独立，不能互相绕过。

- `SOURCE_FILES` 已**不再是手工清单**（R2b-1）：`runtime/source-identity.cjs` 加载期从 `backend.cjs` 字面量 require 图推导哈希输入；`backend.cjs`
  转导出旧导出面，客户端（`native-models`/`monitor-client`）改依赖 `contract.cjs`+`port.cjs`+`retry.cjs`，`backend-handshake` 用 `source-identity` 做
  fresh 检查。**backend 闭包禁止动态 require**（非字面量 specifier 让推导抛错、起不来）；新模块被正常 `require` 即自动进哈希。
  `test/architecture.test.cjs` 禁绝 backend 闭包进宿主/UI/发现/更新模块并查文件级循环。

- 本扩展不修改 Devin 应用本体、不重新签名、不安装证书、不改系统代理。保持这个前提。
- 强依赖 Devin 私有接口：LS `Heartbeat` 抓端口（`src/runtime/host/ls-injection.cjs`）、catalog 的 protobuf 字段号与 Connect
  帧（`src/protocol/wire.cjs`、`src/catalog.cjs`）、ACP 连接器面（`windsurfAcp.registerConnection` /
  `connector.sendRequest` / `connector.forwardClientRequest`，被 `acp-observer.cjs`、`auto-continue.cjs`、
  `goal/continue.cjs` 观察与包装）、CLI 的 `WINDSURF_API_SERVER_URL` env 覆盖（经 `devin.acp.agentEnv` 受管设置注入，ACP
  通道的实际入口）、Fast Context 的 `GetDevstralStream`（`src/fast-context/remote-client.cjs`）。这些接口不稳定，改动附近代码时按「可能失败」处理，
  不要在失败路径上伪装成功。
- **实测依据与排障判据已分卷到 `runtime-forensics.md`**：`authenticate._meta` 与 env 的凭据优先级、`agentEnv` 只覆盖主 agent、注入是否生效的判据、catalog 两跳与日志归属、连接池残渣、桥的 gzip 体积都在那一卷。**改注入或排查「改了没生效」前必读**；两条禁令仍留在本卷：**不要用 `meta.api_key` 替代 env 注入**，**不要把某一时刻的 `lsof` 计数当作架构常量**。
- **`src/protocol/` 是多关注点的混合体，不要按目录名或文件名推断职责**（8 个文件，2026-10-18 拆分后核对）：① 协议转换 —— `native-chat-codec.cjs`（**Devin 侧**：解析
  `exa.chat_pb` 原生请求 + 造出站 ACP chunk）、`inference.cjs`（**三协议统一入口**：`serveChat` + `processor` 的流编排/有界降级/推理状态通道衔接；
  **不是 Responses 专用**）；它的内部职责已按协议语义拆开：`provider-request.cjs`（格式判定/端点/请求体构造，**OpenAI Chat 的请求体在这里**）、
  `provider-events.cjs`（SSE 解析/用量快照/错误详情）、`state-envelope.cjs`（状态信封前缀、`{scope, items}` 构造与其校验），`anthropic.cjs` 仍是
  Anthropic Messages 的独立实现。`inference.cjs` 的导出面被下游依赖（`backend.cjs` 取 `serveChat`，测试取 `buildRequestBody`/`parseEvent`/`STATE_PREFIX`），
  再拆时**保持这四个导出不变**；② 字节层 —— `wire.cjs` 是**全仓共享**的 proto 读写/framing/gzip 工具，`catalog/*`、`fast-context/`、
  `runtime/` 都直接依赖它，**不是协议专用**；③ 埋点 —— `tracker.cjs` 是计量（→ monitor），它落在 `protocol/` 是**依赖图决定而非语义决定**：为消除
  `protocol → runtime` 反向依赖才从 `runtime/monitor.cjs` 移出，**不能搬回 `runtime/`**（`runtime/backend.cjs` 本就 import `protocol/inference.cjs`，
  搬回即成环）。旧名对照：`chat.cjs → acp.cjs → native-chat-codec.cjs`、`responses.cjs → inference.cjs`——旧名正是误读源头（前者与 Chat Completions 无关，OpenAI Chat 的请求体在
  `provider-request.cjs`）。Fast Context 的 `remote-client.cjs` 反向 import `src/protocol/wire.cjs`，两条路径别混。在 `protocol/` 内增删/改名文件时，除 `SOURCE_FILES` 外还要留意**不靠 `require` 的隐式引用**（按模块名打桩的
  字符串键、`readFileSync` 的路径、`AGENTS.md` 里按路径写的说明），这类漏改不报错、只静默失效——`test/source-identity.test.cjs` 现在会兜住
  `SOURCE_FILES` 那一半（现在校验推导出的哈希集合与 `backend.cjs` 的 require 闭包双向精确相等），但路径字符串与打桩键它管不到。
- **扩展宿主编排层在 `src/activation/`**（自 725 行 `extension.cjs` 拆出）：`errors`（RuntimeError/`safeError` + 叶子 `models/discovery-error.cjs`）、`settings`（`globalSetting`）、`backend-handshake`
  （`ensureBackend` + 局部 `pause`/`compareVersion`）、`catalog-sync`（原生目录观测/推送）、`enable`
  （受管设置写入 + LS 注入 + startNativeSync）、`commands`（命令注册、Fusion 选择与 `disable` 恢复）、`panel-install`（状态栏/面板控制器）、`cache-sync`/`config-sync`（pickerRefresh、CLI 缓存检查、配置监听/afterChange）、`teardown`。**`extension.cjs` 仍是唯一激活入口，导出面 `{ activate, deactivate, ensureBackend, safeError }`
  被测试与 `package.json` 依赖**。这些文件在扩展宿主运行、**不能进 backend 的 require 闭包**（否则宿主代码被算进重启哈希）。
  拆分时的硬约束：共享可变槽必须放进显式传递的 `shared` 对象，**不得**改成模块级单例（跨 activate 串状态）；
  `enableQueue`/`reconcileQueue` 这类序列化队列留在各自工厂闭包内；`generation`/abort 判据一处都不能少（`enable()` 里有 4 处）。
  改激活流程前先确认入口：全仓 **5 个入口**中 3 个（`fast-context/server.cjs`、`goal/report.cjs`、`lifecycle/uninstall.cjs`）
  从 `extension.cjs` 的 require 图走不到（清单见 `retired-and-deadends.md`）。
- **`src/runtime/` 按「谁运行」分区，判据是路径不是文件名**：根目录只留 backend 进程与两侧共享的 7 个模块（`backend.cjs`、`backend-control.cjs`、`bridge.cjs`、`contract.cjs`、`native-cache.cjs`、`port.cjs`、`source-identity.cjs`），**只在扩展宿主运行的模块一律放 `src/runtime/host/`**。`test/architecture.test.cjs` 按目录强制这条：backend 闭包出现任何 `runtime/host/**`、或出现白名单外的 `runtime/` 根模块，都判违规——**不再维护文件名黑名单**，新加宿主模块就地放进 `host/` 即自动受约束。放错方向的代价是把「只在宿主生效」的代码算进重启哈希（并让宿主模块被当 backend 代码改动）。
- **`src/runtime/host/injection-health.cjs` 是宿主侧模块、不得被 backend require**：只有 `activation/panel-install.cjs` require 它，结果经共享槽以
  `readHealth()` 回调传给 `runtime/host/context-diagnostics.cjs` 与 `panel/manager.cjs`（backend 里没有任何 require）。让 backend require 它会让
  `architecture` 测试红（source-identity 派生只跟随 require 图），且会把「只在宿主生效」的代码误当 backend 代码改动。输出确定性约束见 `monitor-and-panel.md`。
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
- **流式 RPC 不接受 120s body 空闲超时**：`/exa.<pkg>.<Name>Service/Stream*` 与 `.../HandleStreaming*` 是长连接推送，事件间隔按分钟计（实测 120s 空闲判据每约 102s 误杀一次
  `StreamCascade*ReactiveUpdates`）。这类路径的 body 计时器只用 30 分钟兜底（`bridge.cjs` 的 `STREAMING_RPC`/`STREAMING_IDLE_LIMIT`，上限防 socket 泄漏）；
  `connect`/`headers` 计时器**不变**——不把「上游不可达」拖成永久挂起。改 `forward` 时不得退回对推送流施加普通 idle 超时，也不得放宽前两个阶段的快速失败。
