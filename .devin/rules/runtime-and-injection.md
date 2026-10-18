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
- **api server 入口的优先级与凭据策略（2026-10-18 实测，`devin acp` 3000.10.67，六臂对照）**：`authenticate._meta.api_server_url`
  **也能**重定向 CLI 的 api server 面——控制面（`GetUserStatus`/`GetCliTeamSettings`/`GetCliModelConfigs`）**和推理面 `GetChatMessage` 都在内**；
  但它**优先级低于** `WINDSURF_API_SERVER_URL` env，两处同时存在时一律走 env 且失败不回退。桌面端每次 `authenticate` 都带官方的
  `api_server_url`（`getConfig(Config.API_SERVER_URL)`），BYOK 没被它拨回官方正是靠 env 优先。另一条硬约束（CLI 日志原文）：
  `ACP server credential policy: ACP host is the sole source of credentials. Local CLI credentials (env vars, on-disk REPL store) will NOT be used.`
  —— acp 子进程不读本地凭据，`meta.api_key` 必须由宿主提供，而扩展拿不到 key，因此**不要试图用 meta 替代 env 注入**。对照事实：
  env=<X> + meta=死端口 → 命中 X；env=死端口 + meta=<X> → 认证直接对死端口失败、X 零命中；只给 URL 不给 key → `authenticate` 返回 `{}`
  但**零网络**（走 PKCE 分支），URL 从未被采用。方法：本机起一个只记路径的 HTTP 收集器/透传中继，用临时 `HOME` 与假 key 臂隔离，
  需要「假 key 也能认证成功」时让中继回放 `~/.cache/devin/cli/*.bin` 里的真实 protobuf。
- **`agentEnv` 按 connector id 取，只覆盖主 agent——summarizer 实例拿不到**（2026-10-18 真机，0.3.49）。`RegistryAcpConnector.get env()` 是
  `getWindsurfOrDevinConfiguration('acp.agentEnv').get(this.id)`，桌面端同时跑两个 `devin acp`：主 agent（connector `devin-cli`）与
  `devin acp --agent-type summarizer`（CLI 原生 agent 类型，`man devin-acp`：无工具、把摘要写到 `~/.local/share/devin/summaries/`）。实测后者 env 只有
  内置的 `WINDSURF_IDE_TYPE`/`WINDSURF_EXT_HOST_PID`、**没有任何 TCP 套接字**，因此它的推理走官方、**不进 monitor 账本**。
  **这不是注入失败**：`devin.acp.enabledAgents` 里只有 `devin-cli` 与 `__cascade__`，没有 summarizer 的键。要覆盖它得先弄清它挂在哪个 connector id
  （`__cascade__` 是**未验证的假设**），且把 Devin 自己的 cascade 面拨到本地 backend 风险明显更高——不做之前别写成「覆盖不全的 bug」。
- **验证注入是否真的生效，判据是进程 env + socket，不是 settings.json**（2026-10-18）：`ps eww -p <pid> | tr ' ' '\n' | grep -a '^WINDSURF_API_SERVER_URL='`
  只输出该变量（**别直接打印 `ps eww` 全量输出，里面有权钥**），再用 `lsof -a -nP -p <pid> -iTCP` 确认它确实连到 backend 端口。`lsof` 的 `-p` 与 `-i`
  默认是**或**关系，缺 `-a` 会把全机 TCP socket 都列出来（会误读成「这个进程连了一堆端口」）。
- **`remote_config` 每 60–70 秒超时一次，两侧都有 ⇒ 不要归因 backend**（2026-10-18）：主 agent（已注入）与 summarizer（未注入）的 CLI 日志各出现
  `remote config revalidation failed, keeping last-good value: fetch timed out after 5000ms`，且在 `authenticate`/`session/new`/`user_status_refresh`
  的关键路径上各算 2–5 秒。**未注入的那一侧同样报**，说明是本机到官方 remote-config 端点的网络问题，有 last-good 兜底、非致命。做归因前先比对
  一个未注入实例，否则很容易把它误判成「BYOK 后台拖慢了会话创建」。
- **catalog 有两跳独立重写，日志落在不同的文件里，别拿一条事件当另一条的证据**（2026-10-18 真机 0.3.49 实测）：
  ① **渲染端 picker 路径 = 桥**：`ls-injection.cjs` 观测 LS 端口后建桥，宿主 output channel 里是 `ls bridge ready <LS> -> <bridge>`
  （实测 `57159 -> 57194`）；渲染端（Chromium 的 `--utility-sub-type=network.mojom.NetworkService` 进程）连桥、宿主连 LS，catalog 响应在
  `src/runtime/bridge.cjs` 的 `forward` 里改写成明文回写。它的 `catalog` 事件只出现在宿主的 `output_logging_*/1-Devin Fusion BYOK.log`。
  ② **CLI/ACP 路径 = backend**：CLI 的 api server 就是 backend（env 注入），控制面 RPC 由 backend 经 `bridge.cjs` 的 `forward` 转发到
  `server.codeium.com` 后改写，`catalog` 事件写 `runtime.log`（**`runtime.log` 的唯一写入点是 `backend.cjs`**）。
  两处事件同名字段但 payload 完全不同（实测桥 `before 47216 → after 1358625`、backend `before 154666 → after 716794`），因此
  **排查「picker 没生效」要看宿主 output channel，排查「CLI 模型列表没生效」要看 `runtime.log`**，反之会得出错误结论。
  backend 的 forward 类事件（`catalog` / `catalog-error` / `forward-timeout`）**带 `peerPort`**（该请求客户端 socket 的 `remotePort`，由
  `backend.cjs` 的 `forwardLog` 逐请求包装注入；`bridge.cjs` 不参与，桥侧日志没有这个字段）——事后 `lsof -nP -i TCP:<peerPort>` 即可反查 pid，
  这是区分「扩展宿主打自有端点」与「CLI 打控制面」的唯一直接手段。
  `forward-timeout` 早期条目缺 `rpc` 属**历史**（32 条全在 2026-10-16，之后的代码已带 `rpc` 与 `peerPort`），不要据此判断当前实现丢字段。
- **LS 进程不是 backend 的客户端**（同上实测）：LS 的 env 没有 `WINDSURF_API_SERVER_URL`、也没有到 39842 的 socket；backend 的客户端只有扩展宿主
  （且只打自有端点：native push / health / monitor）与 `devin` CLI。所以「backend 改写了渲染端的 catalog」是**错的**说法——渲染端那一跳在桥上。
- **渲染端仍有到真实 LS 端口的短连接，但它们是连接池残渣、不是固定第二入口**：实测空闲 2 分钟内网络服务侧到 LS 的连接 10 → 1 自行衰减，而桥侧
  「渲染端→桥」与「宿主→LS」稳定为 6/6 一一对应。所以**不要把某一时刻的 `lsof` 计数当作架构常量**；连接归属必须按 **pid** 判（`lsof` 的进程名被
  截断成 `Devin\x20`，按名字匹配会全部落空或全命中），`WebKit/Chromium` 侧真正持有 socket 的是 network service 进程而非渲染进程本体。
- **桥的载荷放大是已知代价**：LS 侧 catalog 响应是 gzip，桥 `wire.decode` 解压后按 `gzip:false` 明文回写，实测 `GetUserStatus`
  `47,216 B → 1,358,625 B`（≈28.8×，每几分钟一次）；backend 侧上游未压缩故只有 4.6×。若要降开销，方向是「上游压缩过就重新压缩」，**不是放宽改写**。
- **`src/protocol/` 是多关注点的混合体，不要按目录名或文件名推断职责**（8 个文件，2026-10-18 拆分后核对）：① 协议转换 —— `acp.cjs`（**Devin 侧**：解析
  `exa.chat_pb` 原生请求 + 造出站 ACP chunk）、`inference.cjs`（**三协议统一入口**：`serveChat` + `processor` 的流编排/有界降级/推理状态通道衔接；
  **不是 Responses 专用**）；它的内部职责已按协议语义拆开：`provider-request.cjs`（格式判定/端点/请求体构造，**OpenAI Chat 的请求体在这里**）、
  `provider-events.cjs`（SSE 解析/用量快照/错误详情）、`state-envelope.cjs`（状态信封前缀、`{scope, items}` 构造与其校验），`anthropic.cjs` 仍是
  Anthropic Messages 的独立实现。`inference.cjs` 的导出面被下游依赖（`backend.cjs` 取 `serveChat`，测试取 `buildRequestBody`/`parseEvent`/`STATE_PREFIX`），
  再拆时**保持这四个导出不变**；② 字节层 —— `wire.cjs` 是**全仓共享**的 proto 读写/framing/gzip 工具，`catalog/*`、`fast-context/`、
  `runtime/` 都直接依赖它，**不是协议专用**；③ 埋点 —— `tracker.cjs` 是计量（→ monitor），它落在 `protocol/` 是**依赖图决定而非语义决定**：为消除
  `protocol → runtime` 反向依赖才从 `runtime/monitor.cjs` 移出，**不能搬回 `runtime/`**（`runtime/backend.cjs` 本就 import `protocol/inference.cjs`，
  搬回即成环）。旧名对照：`chat.cjs → acp.cjs`、`responses.cjs → inference.cjs`——旧名正是误读源头（前者与 Chat Completions 无关，OpenAI Chat 的请求体在
  `provider-request.cjs`）。**撞名警告**：`src/fast-context/protocol.cjs` 是**另一个** protocol（Fast Context 的 MCP 实现），且它反向 import
  `src/protocol/wire.cjs`——两条路径别混。在 `protocol/` 内增删/改名文件时，除 `SOURCE_FILES` 外还要留意**不靠 `require` 的隐式引用**（按模块名打桩的
  字符串键、`readFileSync` 的路径、`AGENTS.md` 里按路径写的说明），这类漏改不报错、只静默失效——`test/source-identity.test.cjs` 现在会兜住
  `SOURCE_FILES` 那一半（它要求 `SOURCE_FILES` 与 `backend.cjs` 的 require 闭包双向精确相等），但路径字符串与打桩键它管不到。
- **扩展宿主编排层在 `src/activation/`**（2026-10-18 从 725 行的 `extension.cjs` 拆出，现 154 行）：`errors`（RuntimeError/`safeError`/`pause`/
  `compareVersion`/`globalSetting`，零依赖）、`backend-handshake`（`ensureBackend`）、`catalog-sync`（原生目录观测/推送/CLI 缓存触发）、`enable`
  （受管设置写入 + LS 注入 + startNativeSync）、`commands`（命令注册、Fusion 选择与 `disable` 恢复）、`panel-install`（状态栏/pickerRefresh/
  `checkCliCaches`/面板控制器/配置监听）、`teardown`。**`extension.cjs` 仍是唯一激活入口，导出面 `{ activate, deactivate, ensureBackend, safeError }`
  被测试与 `package.json` 依赖**。这些文件运行在扩展宿主、**不在 backend 里，因此不进 `SOURCE_FILES`**（加了会让 source-identity 测试红）。
  拆分时的硬约束：共享可变槽必须放进显式传递的 `shared` 对象，**不得**改成模块级单例（会在多次 activate 之间串状态）；
  `enableQueue`/`reconcileQueue` 这类序列化队列留在各自工厂闭包内；`generation`/abort 判据一处都不能少（`enable()` 里有 4 处）。
  改激活流程前先确认动的是哪个入口：全仓共 **5 个入口**，其中 3 个（`fast-context/server.cjs`、`goal/report.cjs`、`lifecycle/uninstall.cjs`）
  **从 `extension.cjs` 的 require 图走不到**，清单见 `.devin/rules/retired-and-deadends.md` 的「路径型入口」表。
- **`src/runtime/health.cjs` 虽在 `runtime/`，却是宿主侧模块、不进 `SOURCE_FILES`**：只有 `activation/panel-install.cjs` require 它，结果经共享槽以
  `readHealth()` 回调传给 `runtime/context-diagnostics.cjs` 与 `panel/manager.cjs`（backend 里没有任何 require）。放进 `SOURCE_FILES` 会让
  `source-identity` 测试红，且会让「只在宿主生效」的代码被误当成 backend 代码改动。输出确定性约束见 `monitor-and-panel.md`。
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
