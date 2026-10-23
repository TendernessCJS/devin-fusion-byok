---
trigger: model_decision
description: "Apply when diagnosing why injection or catalog changes appear not to work, attributing catalog events to bridge vs backend, or tracing agentEnv credential flow — the measured evidence behind runtime-and-injection.md."
---

# 运行时实测与排障（runtime-forensics）

`runtime-and-injection.md` 里「这些约束为什么存在」的实测依据与排障判据：api server 凭据优先级、`agentEnv` 的覆盖范围、注入是否真的生效、日志归属怎么判、连接归属怎么判、桥的体积开销。

结论性禁令仍在 `runtime-and-injection.md`（尤其「不要用 `meta.api_key` 替代 env 注入」）；本卷是它们的证据。**改注入、改日志归属或排查「改了没生效」时必读**，否则会按错误因果动手。
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
  `src/runtime/bridge.cjs` 的 `forward` 里改写并保留传输层 gzip。它的 `catalog` 事件只出现在宿主的 `output_logging_*/1-Devin Fusion BYOK.log`。
  ② **CLI/ACP 路径 = backend**：CLI 的 api server 就是 backend（env 注入），控制面 RPC 由 backend 经 `bridge.cjs` 的 `forward` 转发到
  `server.codeium.com` 后改写，`catalog` 事件写 `runtime.log`（**`runtime.log` 的唯一写入点是 `backend.cjs`**）。
  两处事件同名字段但 payload 完全不同（实测桥 `before 47216 → after 1358625`、backend `before 154666 → after 716794`），因此
  **排查「picker 没生效」要看宿主 output channel，排查「CLI 模型列表没生效」要看 `runtime.log`**，反之会得出错误结论。
  backend 的 forward 类事件（`catalog` / `catalog-error` / `forward-timeout`）**带 `peerPort`**（该请求客户端 socket 的 `remotePort`，由
  `backend.cjs` 的 `forwardLog` 逐请求包装注入；`bridge.cjs` 不参与，桥侧日志没有这个字段）——事后 `lsof -nP -i TCP:<peerPort>` 即可反查 pid 定性。
  **归属已实测坐实（0.3.50 首验）**：`catalog peerPort 55805` 的对端是 `devin acp`（主 agent，`ps eww` 里含 `WINDSURF_API_SERVER_URL`），
  所以「backend 的 CLI 侧 catalog 转发由 ACP CLI 发起」不再是排除法结论。
  `forward-timeout` 早期条目缺 `rpc` 属**历史**（32 条全在 2026-10-16，之后的代码已带 `rpc` 与 `peerPort`），不要据此判断当前实现丢字段。
- **LS 进程不是 backend 的客户端**（同上实测）：LS 的 env 没有 `WINDSURF_API_SERVER_URL`、也没有到 39842 的 socket；backend 的客户端只有扩展宿主
  （且只打自有端点：native push / health / monitor）与 `devin` CLI。所以「backend 改写了渲染端的 catalog」是**错的**说法——渲染端那一跳在桥上。
- **渲染端仍有到真实 LS 端口的短连接，但它们是连接池残渣、不是固定第二入口**：实测空闲 2 分钟内网络服务侧到 LS 的连接 10 → 1 自行衰减，而桥侧
  「渲染端→桥」与「宿主→LS」稳定为 6/6 一一对应。所以**不要把某一时刻的 `lsof` 计数当作架构常量**；连接归属必须按 **pid** 判（`lsof` 的进程名被
  截断成 `Devin\x20`，按名字匹配会全部落空或全命中），`WebKit/Chromium` 侧真正持有 socket 的是 network service 进程而非渲染进程本体。
- **桥已保留传输层 gzip（2026-10-19）**：旧版解压后明文回写曾放大约 28.8×；修复后实测 `47,222 B → 73,935 B`（1.566×，新增目录条目的真实开销）。不得把旧测量当现状，也不得通过放宽改写降低体积；逐消息压缩仍按原逻辑展平。
