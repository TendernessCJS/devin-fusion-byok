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

- **`close-timeout` 是关闭方式分类，不是错误计数（2026-10-26 实测校正）**：它由**即将退场**的 backend 写进 `runtime.log`，只标记「第三段
  `server.close()` 等连接没在预算内结束，已 `closeAllConnections()` 强断」。全仓无任何读取者，面板不展示，不影响流程走向。判读：无该事件 = 优雅关闭
  （实测交班 2.2 s：宿主 ready → 新 backend ready）；有该事件 = 强制收尾，交班约 5.1 s（旧实现三段共用 5 s）或约 1.1 s（`socketCloseTimeoutMs` 拆出后）。
  交接期间**新请求会拿到 503**（`draining` 在网关入口直接拒收），且新 backend 要等旧进程退出才拉起，所以这段是真实不可用窗口，不是「后台无感换血」。
  历史 4 次触发都紧贴一次新 `ready`（间隔 82–259 ms），但有一次落在新 `ready` 之后 5 s，说明日志是多进程交织，**不能只按相邻两行推顺序**。
  事件现在带 `connections`（超时瞬间、强断前的连接数采样），用于区分「1 条空闲连接」与「多条卡死」。
- **回合提前结束用 `acp-turn` 判定**：`session/prompt` settle 记 `{stopReason, ok, code, durationMs}`（只枚举/布尔/耗时，
  不记正文/sessionId/metadata）。CLI 自己的 devin-cli.log 只有 span、没有 stopReason；`session/prompt` 385ms 被关且
  `turn_stats` 紧跟 close 的实测场景里，`acp-turn.stopReason` 是区分 `max_turn_requests`/`end_turn`/`cancelled` 的唯一通道。

## 激活层耦合度量（2026-10-26 架构审查）

- **`shared` 槽共 41 个**（`extension.cjs` 只声明 18 个，其余由各 installer 赋值）：**66 个写入点 / 226 个访问点 / 跨 7 个文件**；`catalog-sync.cjs` 单文件触及 **22** 个槽。
- **只有 1 个槽被 ≥2 个文件写**：`backendStatus`（`commands` + `enable`）。其余 40 个都是单写者 ⇒「installer 互写对方的键」只在这一点成立，耦合的真实形态是**晚期绑定的 service locator**（读点全在回调内，install 阶段不取值），所以安装顺序并不像最初判断的那样脆弱。
- 归属分组（2026-10-26 已按此落地）：`deps.stores.nativeCatalog` **22 槽**（owner `catalog-sync`）、`deps.stores.cacheSync` **3 槽**（owner `cache-sync`）、`deps.stores.acpObservation` **2 槽**（**owner 是 `enable`**，读者才是 `cache-sync`+`panel-install`——正因写者在外，它不能并进 cacheSync 私有状态）、`deps.stores.panel` **4 槽**（`statusBar`/`updateStatusBar`/`manager`/`contextObserver`，owner `panel-install`，`extension.cjs` 的 catalog-changed 钩子只读 `updateStatusBar`）；仍在 `shared` 的 **10 槽**：`commands` 的 4 个函数槽、`management` 1、`backendStatus` 1、continuation 2、`ensureEnabled`/`disablePromise` 2。
- 测试伪造规模（拆分成本的主项）：只有 **2** 个测试文件实质构造 `shared`——`native-models-sync`（12 槽 / 690 行）与 `activation-sync`（3 槽 / 265 行）。
- 失效判据分布：generation 绑定 6 处（`enable.cjs:64/91/93/99/114`、`catalog-sync.cjs:71`，其中 **4 处字面完全相同**）、generation 无关 8 处、abort 2 处；曾存在肯定/否定两种写法混用（`enable.cjs:120`）。
- **历史判断已推翻**：曾认为「禁用发生在 enable 写入段的 `await` 期间时，写入仍会完成、teardown 会按 receipt 自愈还原」——75222e4 与后续收口已证明 receipt **不提供异步顺序**（恢复 snapshot 先取、在途写入后落，receipt 已被清空），现由 `managed-settings.cjs` 的 `critical`/`drain` 保证顺序，恢复**必须重读**设置与 receipt。
- 本次审查的两处误判（已更正，别再重复）：① `catalog → runtime` **不是**层方向倒置，`port.cjs` 留在 `runtime/` 才能待在 backend 闭包内；② `goal/controller` 与 `auto-continue` **不是**「补丁 + 状态机」混排——前者本身就是 store/状态机（补丁在独立文件 `goal/continue-hook.cjs`），后者没有替换式补丁（走 `loadAcpApi`），它真实的混排是「错误文本匹配器 / 连接挂载 / 续跑状态机」三件事。

## 宿主激活关联与磁盘源码快照（host-builds）

backend `sourceId` 只覆盖 backend require 闭包；宿主侧改动（`activation/`、`panel/` 等）**不会**改变它，因此**不能**用它判断宿主代码新旧。

宿主每次 `activate()` 会写一条**按激活实例**的记录 `<globalStorage>/host-builds/<pid>-<instanceId>.json`：`{ id, files, version, extension, writtenAt, pid, instanceId, activatedAt, kind: 'disk-source-snapshot', recordFile }`。`id` 是对 `src/**/*.cjs` 的路径+内容 sha256（`node_modules`/`.git` 忽略），`files` 是参与哈希的文件数。同 PID 多次激活各写各的、互不覆盖；`recordFile` 是相对 globalStorage 的路径，日志 `host-build` 事件同字段，可把记录关联到具体 output channel/进程。

读法：从当前窗口 output channel 的 `host-build` 事件取 `pid` + `instanceId` + `recordFile`，对照同 pid 进程的启动/`activatedAt` 时间，再读该条指定记录——**不要**按目录全局最新排序挑（可能选到另一窗口的记录）。**撤回旧判据**：单看 `writtenAt` 与 vsix mtime 先后**不充分**——它只是磁盘快照（`kind: 'disk-source-snapshot'`），证明的是激活时磁盘上是哪份代码，不等于已加载模块的绝对证明。旧的单例 `host-build.json` 是遗留用户文件，不作清理，也不得再当验收判据。

它是**诊断用**身份：不参与 backend 重启判定，也不得混入 `SOURCE_FILES`。

## LS/ACP 注入的边界（2026-10-26 出厂产物核对）

- **`http.request` 的补丁是扩展宿主级共享，不是「每个扩展一份」**：扩展宿主只拦截 `vscode`（外加 `open`/`opn` 与 ripgrep 别名），`http` 走 Node 内置的进程级缓存，因此 `ls-injection` 的包装对**所有**扩展生效。`vscode.windsurfLanguageServer` 是 per-extension 对象（每扩展一份 `_apiFactory` 结果），所以 `setPort`/`setChildLanguageServerInfo` 的包装精确，`http.request` 的不精确。后果：兜底心跳探针可能被后装的第三方包装遮蔽（`status.httpHook === 'shadowed'`，一次性 `ls-http-hook-shadowed` 事件），主路径（`setPort` 重发桥端口）不受影响。**不要把「只影响原生扩展」当作改写 `http` 的前提。**
- **本地 connector 的 transport-down 状态是 `reconnectingMaxDelay`**：基类 `transportDownStatus()` 对本地恒返回它（进程退出与握手失败都走），只有 `RemoteAcpConnector` 才覆写成 `disconnected`；真实状态集合为 `connecting|connected|reconnecting|reconnectingMaxDelay|disconnected|disabled`，**没有 `disposed`**。插件只挂本地 connector，终态匹配漏掉 `reconnectingMaxDelay` 会让 agent 崩溃后的定时器与会话状态不回收。
- **ACP 注入只能覆盖「安装之后」的注册**：`createAcpRegistry` 包的是 `api.registerConnection`，既有 connector 在扩展宿主私有的 `_connectors` Map 里、外部无法枚举。激活顺序不利时三层全部静默失效（面板停在 `waiting`），因此注册表在首个 layer 装上后 30 s 内没有任何 attach 时记一次 `acp-attach-missing`。
- **UI 侧不持久化 worktree LS 端口**：`_saveWorktreeLsGroupInfo` 只存 `parentWorkspaceUri`/`worktreeUri`/`creationTimestamp`，这是桥端口（每次会话随机）不会写进跨窗口状态的**当前**原因。若该字段集合将来加入 `port`，恢复路径会连到已死的桥端口——改 `setChildLanguageServerInfo` 附近代码前先核这条。

## 上游转发目标（2026-10-27 实测）

- `upstream-push` 是判断「推送有没有发生」的唯一事件，成败都记：成功 `{ok:true,custom}`、失败 `{ok:false,reason}`；**payload 不含 host**，别为排障加。
- `custom` = 「与默认上游不同」，不是「设成功了」：推默认值或 `null` 都得 `false`。`reason`：`unsupported`=旧 backend（`/health.upstreamProtocol !== 1`）、`identity`=health 与控制文件不一致、`invalid`=origin 被拒、`unavailable`=连不上或 4 s 超时。
- 核对顺序：`/health` 的 `upstreamProtocol: 1` 与 `instanceId`/`sourceId` 同 `runtime-control.json` 一致，才说明控制通道可用。
- 本机（2026-10-27）：`settings.json` 无 `codeium.*`，LS 用默认 `--api_server_url https://server.codeium.com`、`--inference_api_server_url https://inference.codeium.com`，故推 `null`、`custom:false`——SaaS 账号下该能力空跑。
