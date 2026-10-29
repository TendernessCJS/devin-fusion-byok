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
- 服务商错误自动继续的连续预算是 **5 次自动重试 / 10 分钟窗口**；触顶必须停止、结算等待中的请求并提示用户。截断续跑链的预算是**每个真实用户轮次最多 10 次自动续接**（`PLAN_ATTEMPT_LIMIT`，触顶记 `plan-attempt-limit` 并提示）；可续 `stopReason` 只有 `max_tokens` 与 `max_turn_requests`（`end_turn` 是正常收尾，不续）；**有未完成 plan 时额外要求 plan 确有进展**（否则记 `plan-no-progress` 并停），无 plan 的截断直接续；计划状态按原生语义**只保留当前计划**（新计划取代旧的、`plan_update` 非 `items` 类型不产生计划记录），不做累积，旧的「按 planId 累积」已移除；两链预算彼此独立，也都与 Goal 的预算独立，不能互相绕过；plan-retry 与 error-retry **计数分离**——error 重试不增加 plan 的 `attempts`、不占 plan 名额（共享时实测退避被拉成 2s→4s→8s→16s）；截断但**零正文且零工具调用**不续（`decision: stop`、`reason: truncated-empty`，同一预算下必然复现）。所有合成乐观 user 消息（auto-continue 与 goal 两处）**必须**带 `cognition.ai/messageSubIndex: 0`：客户端只在 clientMessageId 与 messageSubIndex 同时匹配时把回显并入 part，缺它则 append 成第二个 part、气泡文案重复。**依据**：原生只给 `max_turn_requests` 配 continue 语义、`max_tokens` 无任何处理、`end_turn` 无 affordance（枚举与偏移见 `acp-protocol-fields-forensics.md`），且本机全量 31 条评估里 `hasPendingPlan` 恒为 false（2026-10-28 跨 23 个宿主 channel 文件统计）——旧门控等于永不生效。**未验证的假设**：CLI 是否把供应商截断报成 `max_tokens`（本机 `max_tokens` 出现 0 次）；验证只需等一次真实截断后看 `acp-turn.stopReason`，**若落在 `end_turn`** 说明截断不可区分，应回退为「`end_turn` 仅在 `hasPendingPlan` 时续」的上游形态，不要靠加宽 `CONTINUABLE_STOP` 掩盖。
- **两个开关默认关**，运行期从未触发过时不要假设它们有效：每次轮次结算都写一条 `auto-continue-evaluated`（固定 14 字段：`site`/`stopReason`/`enabled`/`onProviderError`/`untilPlanComplete`/`suppressed`/`retryDisallowed`/`providerErrorMatched`/`terminalBlocker`/`hasPendingPlan`/`planUpdates`/`pendingItems`/`decision`/`reason`，**不记任何正文或 id**）。`decision` 取值 `error-retry`/`plan-retry`/`stop`/`untracked`；`reason` 只在非正常路径为字符串（`disposed`/`inactive`/`retry-disallowed`/`session-gone`/`superseded`/`generation-mismatch`/`no-stop-reason`/`cancelled`/`refusal`/`truncated-empty`），正常评估为 `null`；`planUpdates`=本轮收到的 plan 家族 session/update 数，`pendingItems`=未完成条目总数——两者用于判定「原生是否真的下发 plan 事件」。判断"某次为什么没续"只认这条事件，别靠猜——`auto-continue-miss` 只在尾部文本像供应商错误时才写，plan 链完全无记录。该事件字段集有测试钉死，加字段须同步改测试。
- **合成的 `continue` 必须带 `cognition.ai/messageSubIndex`**（2026-10-28 真机复现并修复）：原生客户端把 update 的 `_meta` 继承到每个 content part，chunk reducer 只在 **`clientMessageId` 与 `messageSubIndex` 同时相等**时才把 agent 回显的 chunk 合并进已有 part，否则走 `content.concat` 追加新 part——缺 subindex 的表现是**同一条气泡里显示 `continuecontinue`**（v1 `user_message_chunk` 与 v2 `user_message` 两条分支都要带，`auto-continue-stream` 用例已钉住）。给合成消息加 `_meta` 字段时照这个形状抄：native 自己的乐观消息就是 `isOptimistic` + `clientMessageId` + `messageSubIndex` + `timestamp`。

- `SOURCE_FILES` 已**不再是手工清单**（R2b-1）：`source-identity.cjs` 加载期从 `backend.cjs` 字面量 require 图推导哈希输入。
  **backend 闭包禁止动态 require**（非字面量 specifier 让推导抛错、起不来）。推导细节与守卫全貌见 `architecture-boundaries.md`。

- 本扩展不修改 Devin 应用本体、不重新签名、不安装证书、不改系统代理。保持这个前提。
- 强依赖 Devin 私有接口：LS `Heartbeat` 抓端口（`src/runtime/host/ls-injection.cjs`）、catalog 的 protobuf 字段号与 Connect
  帧（`src/protocol/wire.cjs`、`src/catalog.cjs`）、ACP 连接器面（`windsurfAcp.registerConnection` /
  `connector.sendRequest` / `connector.forwardClientRequest`，被 `acp-observer.cjs`、`auto-continue.cjs`、
  `goal/continue-hook.cjs` 观察与包装）、CLI 的 `WINDSURF_API_SERVER_URL` env 覆盖（经 `devin.acp.agentEnv` 受管设置注入，ACP
  通道的实际入口）、Fast Context 的 `GetDevstralStream`（`src/fast-context/remote-client.cjs`）。这些接口不稳定，改动附近代码时按「可能失败」处理，
  不要在失败路径上伪装成功。
- **实测依据与排障判据已分卷到 `runtime-forensics.md`**：`authenticate._meta` 与 env 的凭据优先级、`agentEnv` 只覆盖主 agent、注入是否生效的判据、catalog 两跳与日志归属、连接池残渣、桥的 gzip 体积都在那一卷。**改注入或排查「改了没生效」前必读**；两条禁令仍留在本卷：**不要用 `meta.api_key` 替代 env 注入**，**不要把某一时刻的 `lsof` 计数当作架构常量**。
- **LS/ACP 注入的三条边界**：`http.request` 补丁是宿主级共享（只有 `windsurfLanguageServer` 是 per-extension）、ACP 只钩未来注册、本地 connector 的终态是 `reconnectingMaxDelay`——判据见 `runtime-forensics.md`。
- **远端窗口（Remote-SSH/WSL）不提供目录注入，只提供反向隧道**（2026-10-29 按 upstream v0.4.7 移植）：本扩展是 `extensionKind: ["ui"]`，远端窗口里它在本地跑、原生 `codeium.windsurf` 在远端 → `nativeMain` 为 null，`ls-injection` / `auth-status` / ACP registry 全部装不上。远端分支只做两件事：`src/runtime/host/remote-tunnel.cjs` 建反向隧道（ssh 注入 `-R 127.0.0.1:39842:127.0.0.1:39842`，或经 `getRemoteExecServer` 起远端 node 做 stdio 帧复用），以及既有 agentEnv 写入把远端 CLI 指向 `http://127.0.0.1:39842`。**桌面目录在远端窗口永远观测不到**（`nativeCatalogStatus` 直接置 `unsupported`），不要为此加轮询或伪造 ready。隧道安装的 `child_process.spawn` 是**进程级共享**补丁（与 `http.request` 同类），只对带 `SSH_ASKPASS`/`WINDSURF_SSH_ASKPASS_` 且含 `-v -T -D` 的 ssh 调用注入参数；`installRemoteSupport` 不得重复安装（重复包装只有一份能还原）。远端链路**未在真实远端窗口验收**（判据与移植取舍见 `upstream-fork-release.md`）。
- 模块归属/`src/runtime` 分区/门面/架构守卫的完整表述见 `architecture-boundaries.md`（含 `protocol/` 九文件与 `activation/` 十六模块的职责清单）。
- **配对/形状判断必须复用出站构造，不要另写一套**（2026-10-26）：`anthropic.cjs` 的 `buildTurns(request)` 是「neutral history → 合并后 turns」的**唯一**实现，`buildAnthropicBody` 与观测用的 `inspectToolPairing` 都复用它。为诊断另写一份合并逻辑会把并行工具结果判成「非相邻」——这是本区块唯一容易做错的地方。诊断**只读不写**：探针在 `buildRequestBody` 之前跑，不得改变报文；新增探针一律「计数 > 0 才记」并包 try/catch，避免每轮刷日志或让观测拖垮请求。
- `AssignModel` 本地应答不含 `assignment_jwt`（官方 `ModelAssignment` 响应带该字段）。CLI **3000.11.228** 实测仍不校验（本地应答不带 jwt，指派与推理均正常；3000.10.48 起一直如此）；若未来版本强制校验，
  本地指派整体失效——届时改为转发上游或显式降级，不得伪造成功。
- **backend 转发目标由宿主推送**（**不**读 `codeium.apiServerUrl`——派生量，见 `upstream-routing.md`）：宿主经
  `POST /_runtime/upstream`（bearer + `upstreamProtocol`）推送派生链结果（LS `--api_server_url` → portal → 默认，
  `effective-origin.cjs`）；只传 URL、仅内存、拒自指；写入点只在 `enable.cjs`。
- 修改行为时不要放宽现有安全校验（Origin 一律 403、控制令牌 `timingSafeEqual`、webview 只用 `createElement`/`textContent` 不用
  `innerHTML`、CSP nonce）。
- **backend 的 ingest 必须拒绝我方 uid**（`/^(?:fusion-)?dfbyok-/`）：宿主的读取端把「被提供的 dfbyok uid」当作非法目录并直接抛
  `native_catalog_invalid`，一旦 backend 存了我方条目，**宿主的每一次 refresh 都会失败**。`pushNativeModels` 与 `isUpstreamUid`
  共用同一个谓词，避免两侧漂移。

- **关闭路径的每一段等待都必须有上限**：`close()` 里三段等待（在途请求排水、监控队列 flush、`server.close()` 等连接结束）原本都无上限。半读的 SSE 流会让请求既不 finish
  也不 close → `release()` 永不执行 → 排水永不完成 → `close()`/`stopped` 永不 resolve；而 SIGTERM 的处理器本身就在 `await close()`，
  于是**信号变成空操作**，进程只能 SIGKILL（2026-10-14 实测：必须 `kill -9` 才清掉孤儿 backend）。现在前两段用 `drainTimeoutMs`（5 s）兜底，第三段
  **单独用 `socketCloseTimeoutMs`（1 s）**——它只等连接消失、不与请求工作重叠，共用 5 s 会把每次交班的不可用窗口拖满 5 秒；超时后先 `getConnections`
  采样连接数、再 `closeAllConnections()` 强制收尾并继续走到 `stopped`，保证「关得掉、也杀得掉」。**不要退回无上限等待**，也不要只在超时日志里记录而不强制关闭。
- **流式 RPC 不接受 120s body 空闲超时**：`/exa.<pkg>.<Name>Service/Stream*` 与 `.../HandleStreaming*` 是长连接推送，事件间隔按分钟计（实测 120s 空闲判据每约 102s 误杀一次
  `StreamCascade*ReactiveUpdates`）。这类路径的 body 计时器只用 30 分钟兜底（`bridge.cjs` 的 `STREAMING_RPC`/`STREAMING_IDLE_LIMIT`，上限防 socket 泄漏）；
  `connect`/`headers` 计时器**不变**——不把「上游不可达」拖成永久挂起。改 `forward` 时不得退回对推送流施加普通 idle 超时，也不得放宽前两个阶段的快速失败。

## 架构审查结论（2026-10-26 实测；耦合清单，不是待办清单）

- **`shared` 是刻意的反单例容器，别改回模块级单例**（会跨 activate 串状态）。它的槽所有权由测试强制：每槽只允许一个写者，唯一多写者在 `test/architecture.test.cjs` 的 `SHARED_MULTI_WRITER` 白名单里，**新增写者必须改槽归属或显式进白名单**。收敛方向是按所有权拆成显式 store、跨 installer 走命名方法（槽数、读写点数与归属分组见 `runtime-forensics.md`）。已拆出 `deps.stores`（`nativeCatalog`/`cacheSync`/`acpObservation`/`panel`）；`STORE_OWNER` 守卫把每个 store 限制为**单一 owner 写者**，且判定**同时识别赋值与方法变异**（`shared.x.push(...)` 也算写）。
- **激活失效判据经 `superseded(...)` 收敛**（`src/activation/liveness.cjs`）：`enable.cjs` 里现有 **5 处 `superseded(...)` 调用**（4 处在 `await` 之后、第 5 处是 publication 事件回调，且还要叠加 `lifecycle.publication !== publisher`）；`publish()` 包装仍用字面 `generation` 比较、**刻意不用** `superseded`。**新增 `await` 必须补一次检查**，漏一处就会在“用户已禁用”之后把钩子装回去。
- **`runtime/port.cjs` 留在 `runtime/` 是刻意的，别挪**：`backend.cjs` 自己 `require('./port.cjs')`，而 backend 闭包守卫禁止 `network` 目录、根文件只允许 `catalog.cjs` ⇒ 挪到 `network/` 或 `src/` 根会让两条守卫**同时**失败。看着像层方向倒置，实际是 `BACKEND_RUNTIME_ROOT` 白名单允许的设计（`catalog/build.cjs` 与 `config/config.cjs` 引它只为“单一地址来源”）。
- **失效判据统一在 `src/activation/liveness.cjs`，两个函数语义不可互换**（2026-10-26）：`live(lifecycle, config)` = `!activationDisposed && enabled !== false`（还能用吗）；`superseded(lifecycle, config, generation)` = `generation !== activationGeneration || enabled === false`（这一刻的代次工作是否该放弃）。**`superseded` 不含 `disposed`**——禁用会作废在途工作但激活并未销毁，需要两者时**显式组合**（`superseded(...) || lifecycle.activationDisposed`）；把 `disposed` 并进 `superseded` 会悄悄改变行为。`enable()` 里”只判代次、不判 enabled”的那处（`publish()` 包装）**刻意不用** `superseded`。
- **publication 的 `isCurrent` 不得带 generation 判断**（2026-10-26 修正）：`extension.cjs` 与 `activation/enable.cjs` 原本各写一套谓词，后者多一个 `generation === lifecycle.activationGeneration`。生产路径上 `extension.cjs` 先建好协调器（`:164`）再 `installEnable`（`:172`），所以那一套**只有测试走得到**；而它对「跨 enable/disable 复用同一个协调器」的设计是**错的**——generation 一推进就会在 `catalog-publication.cjs:136/173` 把它判成 `inactive`。generation 的钉住位置在 `enable.cjs` 的 `publish()` 包装里（同时比 generation 与 publisher 身份），**不要挪回 `isCurrent`**。
