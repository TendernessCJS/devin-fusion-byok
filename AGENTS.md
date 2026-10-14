# AGENTS.md

Devin Fusion BYOK：一个 Devin/VSCode 扩展，通过运行时桥接把第三方模型（OpenAI Responses / Chat Completions / Anthropic Messages）注入 Devin 原生模型列表，并把 BYOK/原生模型的组合镜像进 Devin 官方的 Fusion 卡片。

## 仓库与 remote

- `origin` = 本仓库的 fork（`git@github.com:TendernessCJS/devin-fusion-byok.git`），是日常推送目标。
- `upstream` = 上游原项目（`https://github.com/kuobibulaien/devin-fusion-byok.git`），只读，**不要向 upstream 推送**。
- 本地 `main` 跟踪 `origin/main`。新克隆或首次拉取后需先执行 `git fetch origin`，否则 `git status` 会显示 `[origin/main: gone]`。
- 两个 remote 走**不同的网络通道**（`origin` 是 SSH、`upstream` 是 HTTPS），代理要求不同——见下节。
- 同步上游更新见「fork 同步与发布」一节。

## 本机网络路径

本机直连 GitHub 不可用，必须经代理；代理不可用时停止并报告，不要回退直连。**代理机制与本机配置的权威说明在用户级规则 `~/.devin/global_rules.md` 的「外部网站代理」**（代理地址、`~/.ssh/config` 的 `ProxyCommand`、git 的 URL 限定配置、`gh` 为何只能靠环境变量），本节只记本仓库要用的结论：

| 目标 | 协议 | 命令里要不要加 `HTTPS_PROXY` |
| --- | --- | --- |
| `origin`（`git push` / `git fetch`） | SSH | **不要**：`~/.ssh/config` 的 `ProxyCommand` 自动代理 |
| `upstream`（`git fetch`） | HTTPS | **不要**：本机已配 URL 限定代理，裸命令即可；未配置的机器要加 |
| `gh`（建 Release 等） | HTTPS | **要**：`gh` 没有 proxy 配置项，也不读 git 配置 |

用 `git remote -v` 确认 remote 属于哪种。HTTPS remote 漏了前缀是**长时间挂起**而非快速报错——卡住 10 秒以上先怀疑这个。

不要用无作用域的 `git config --global http.proxy`：它作用于**所有** HTTPS remote，会把 HTTPS 形态的内网仓库也送进代理（SSH 形态的内网 remote 不受任何 `http.proxy` 影响）。改动用户级 git 配置须由用户自行执行。

## 常用命令

```bash
npm test                                      # node --test test/*.test.cjs
npm run package                               # 生成 .vsix（依赖 /usr/bin/zip）
npm run mcp:fast-context -- --root /abs/proj  # 单独运行 Fast Context MCP
FUSION_FAST_CONTEXT_LIVE=1 node scripts/fast-context-smoke.cjs   # 真实接口验收，消耗官方额度
```

改动后至少跑 `npm test`。测试用 `node:test`，无需安装依赖，也没有 lint/typecheck 步骤。

## 测试基线

全量测试应全绿（0 失败）。

历史说明：`test/native-models-sync.test.cjs` 曾稳定失败——同一端口重启 backend 后，对该 origin 的首次请求复用了 undici 连接池中已被旧服务关闭的 keep-alive socket（`ECONNRESET`），第二次请求自愈。这是**客户端连接复用缺口**，已由 `src/runtime/retry.cjs` 的 `withConnectionRetry` 修复：`readNativeModels` 与 `readMonitor` 对连接层失败做一次重试。

纪律保留：**不要为了通过测试而修改断言**；`withConnectionRetry` 只重试连接层失败（按 `error.cause.code` / `error.code` 判定），`native_catalog_identity` / `monitor_identity` / `native_catalog_unavailable` 这类校验错误不得被重试绕过或伪装成成功。

## 代码约定

- 全部为 CommonJS（`.cjs`），`package.json` 无 `dependencies`。**不要引入运行时依赖**，也不要改成 ESM。
- 日志只允许记录模型名、工具名、状态码、计数。**禁止**把 `apiKey`、控制令牌、`authorization` 头、对话正文写入 output channel 或 `runtime.log`；新增日志前确认 payload 不含凭证。
- 用户可见文案（面板、错误消息、README、命令标题）用中文；代码注释用英文。
- 面向供应商的发现与推理请求必须带 `redirect: 'error'`，避免密钥和对话被重定向到其他地址。
- 写用户设置（`devin.acp.agentEnv` / `devin.acp.agentPreferences`）必须走 `src/lifecycle/owned-settings.cjs` 的 receipt 流程，且 key 需在 `permitted()` 白名单内，保证可回滚。不要直接写 `settings.json`。
- 服务商错误自动继续的连续预算是 **5 次自动重试 / 10 分钟窗口**；触顶必须停止、结算等待中的请求并提示用户。待办无进展停止规则与 Goal 的预算独立，不能互相绕过。
- 监控 `record()` 仅同步更新内存，落盘走串行异步队列；测试依赖持久化时等待 `flush()` / `snapshot()` / `close()`。内存保留 5000 条，正常磁盘日志到 5250 条时压缩；读取或写入异常时不得用部分内存覆盖原日志。backend 排水必须等待响应与处理器结束、刷完日志，再释放端口。
- 监控归属默认只查 `tool_call_state`，其联合主键 `(session_id, tool_call_id)` 在仅按工具 ID 筛选时是覆盖索引扫描，不是点查。`messageLookup: true` 仅为内部诊断开关，不默认执行 `message_nodes` 全表 JSON 查询。不得用表级 `created_at`、`sessions.model`、全文/任意 metadata 中的 UUID 或未经核实的 `row_id` 只追加假设推测归属；消息角色不等于 Lead/Sidekick。用量主账保留在插件日志，异常计数必须排除并明确披露。
- 用量时间筛选默认当月，以本机日历边界和请求 `startedAt` 为准，内部区间左闭右开；自定义结束日转到下一日零点，不用 `new Date("YYYY-MM-DD")` 的 UTC 解析或固定 24 小时推进日期。前后端复用 `monitor-stats.cjs` 的统计公式，明细/汇总/诊断使用同一记录集；无效区间不得回退全量。最近 5000 条保留记录不保证完整月账单，界面必须明确披露。
- 面板控件的垂直高度统一由 CSS 令牌 `--control-h`（28px）驱动，`button`/`input`/`select` 都引用它，不要再写死各自的高度；同一行必须放下的「input + 按钮」容器用 `.actions.nowrap`，以免 flex 折行把按钮挤到第二行（折行判定用 hypothetical size，与容器 max-content 宽度不一致是根因）。
- 三个 webview（`src/panel/view.cjs` 主面板、`goal-view.cjs`、`context-view.cjs`）共用 `src/panel/theme.cjs` 的 `baseStyles()`：控件（`button` 及 `.secondary/.quiet/.danger`、`input/select/textarea`、`input.switch`）、字号层级、页面边距（`--page-x`/`--page-top`/`--page-bottom`）、`ul/ol` reset、`.code-block`、指标原语 `.tiles`/`.tile`/`.tile-value`/`.tile-label` 都只在 base 里定义一次；**不要再往单个 webview 里加这些基础样式**，要改就改 `theme.cjs`。指标仪表盘统一用 `.tiles`，不要再用「gap + 容器背景色」自绘细线网格——格子数不是列数整数倍时末行会露出容器背景色块（实测上下文面板 5 列下 6 格/11 格各露出 4 个空槽）。
- 引用顺序：base 必须**先**、视图专有 CSS **后**，视图才能覆盖 base（例如 `.update-notes { font: inherit }` 覆盖 base 的 `pre` 等宽字体）。代码块用 `.code-block`，不要靠叠 `.update-notes`/`.mono` 去凑样式。
- 原生模型目录靠观测，重启后内存里为空；观测结果经 `<storage root>/native-cache.json` 跨进程缓存（格式 `{version, savedAt, models}`，TTL 7 天，原子写：临时文件 + rename，`0o600`）。它是**观测缓存**、不是用户配置，只含 uid/label/能力标志，绝不落凭证；追加并集语义（与内存一致，不因单批缺席而删条目）。此时角色里的 `nativeUid` 解析不到，**不得**断言「已从模型目录移除」——要按 `nativeCatalogStatus` 区分「尚未同步」（`pending`，muted 文案，判定依据为**内存与缓存都没有可用观测**）与「目录就绪但模型确实不在」（真警告）。BYOK 供应商引用写在配置里，解析不到就是真的不可用，不算 pending。
- 原生目录由空变有（或目录签名变化）→ 触发 `pickerRefresh.changed()`；**当前线上不接任何刷新命令**（`lightCommands: []`）：`devin.reloadAcpConnections` 实测会断开全部 ACP 连接（用户可见「ACP connection closed」+ 会话区刷新），且每次执行后 5–35 秒内整个窗口被重载（2026-10-14 真机，reload 循环达每小时十余次）。数据正确性完全由 cli-cache 原地刷新兜底，新会话读到的是新 payload；**不得回退到 `devin.newConversation` 之类开会话的命令**，重新接命令前必须先在真机确认其不会断开 ACP。另：扩展宿主对该窗口反复重启的另一嫌疑是 `saveReceipt` 往**安装目录**写 `.fusion-byok-storage.json`（POINTERS）——目录被监视则每次 activate 都触发重启，现已改为 roots 不变则不写；不得往 `context.extensionPath` 里新增任何周期性/激活期写文件。
- 新增 backend 运行时模块**必须**同时加入 `backend.cjs` 的 `SOURCE_FILES`（它参与 `sourceId()` 哈希，漏加会导致同版本重装不重启 backend，新代码永远不生效）。
- `augmentLocalModelChoices` 的门控是「Fusion 需要其原生 uid 出现在字段 7 允许列表里、普通 BYOK 不需要」——盲窗（原生观测为空）下 Fusion 整组被丢而普通 BYOK 全留，现象会被误读成「非 Fusion 模型缺失」，排障时先看这里而不是重查目录生成。
- CLI 的模型选择器是「`~/.cache/devin/cli/` 的按身份持久缓存（`user_status`/`model_configs_v5`/`team_settings` 的 `.<digest>.bin` JSON 信封，payload 为 base64 proto）∩ 白名单」；配置改动会改普通模型 uid（digest 含 `provider.id`/`model.id`/`effort`），缓存陈旧期普通条目整批丢失，而镜像的 `fusion-<lead>-sidekick-<side>` 条目只要两侧 uid 未变就仍能命中。`src/runtime/cli-cache.cjs` 按「payload 含 `dfbyok` 判定我方身份、含 dfbyok 但缺当前 uid 判定陈旧」**原地重写 payload**：改写前先按 `CACHE_RPC` 映射缓存名→RPC 路径、经 `augmentCatalog` 重算，且新 payload 必须「不丢任何已出现的期望 uid 且字节有变化」才落盘（否则 `no-improvement` 跳过——允许净缩，清陈旧也是改进）；落盘前把原始字节写到 `<file>.bak`（原子写、`0o600`），envelope 的 `version`/`identity_digest`/`fetched_at_secs` 原样保留。**绝不改名、绝不写 `.stale`**——该 CLI 版本不会因文件缺失而补拉 `model_configs_v5`，改名会把 picker 打空且不自愈（实测两小时零 `GetCliModelConfigs`）；不碰无 dfbyok 标记的其他身份文件；仅在重写到 `model_configs` 时才经 `pickerRefresh.force()` 让 picker 重取（`team_settings`/`user_status` 由 CLI 自身节奏重拉、无需断 ACP 即生效），且 `force()` 与 `changed()` 共用 `cliCacheMs` 间隔——刷新风暴不得变成 ACP 断开风暴（实测曾 30 秒内连断 3 次）。Composer 模型缺失排障时先看缓存新鲜度，backend 注入日志（`afterOwn`）证明不了 picker 侧可见性。面板「设置 → CLI 缓存 → 刷新缓存」走同一个 `checkCliCaches({ force: true })`（`refreshCliCaches` 消息），只做原地重写、不引入新的刷新通道；`cliCacheStatus()` 把最近一次报告交给面板渲染，不要在那里触发写入。**自动检查只看 uid 存在性**（`missing`/`staleProbe`），所以「uid 齐全但条目形态过时」它一律跳过——这正是 `force` 存在的理由：强制模式绕过门控、直接比较 augment 后的字节，只有真差异才落盘（因此连按不churn，实测二次调用即 `no-improvement`）。修 emit 形态后**必须**走一次强制刷新或让配置变动触发自动重写，否则旧形态条目会一直留在缓存里（2026-10-14：信息性维度加 `order` 的修复就是这样落地的）。
- 加载 `src/extension.cjs` 的测试 fixture 必须 stub `./runtime/cli-cache.cjs`（或把 `dir` 指向临时目录），**绝不可触及真实 `~/.cache/devin/cli`**——历史上未 stub 的 fixture 曾把用户真实缓存改名搬走、清空 picker；`inspectCliCaches`/`refreshStaleCliCaches` 的 `dir` 参数必填（非空字符串，否则抛 `TypeError`）就是为了堵这个口子。

## 架构边界

- 本扩展不修改 Devin 应用本体、不重新签名、不安装证书、不改系统代理。保持这个前提。
- 强依赖 Devin 私有接口：LS `Heartbeat` 抓端口（`src/runtime/ls-injection.cjs`）、catalog 的 protobuf 字段号与 Connect 帧（`src/protocol/wire.cjs`、`src/catalog.cjs`）、ACP 连接器面（`windsurfAcp.registerConnection` / `connector.sendRequest` / `connector.forwardClientRequest`，被 `acp-observer.cjs`、`auto-continue.cjs`、`goal-continue.cjs` 观察与包装）、CLI 的 `WINDSURF_API_SERVER_URL` env 覆盖（经 `devin.acp.agentEnv` 受管设置注入，ACP 通道的实际入口）、Fast Context 的 `GetDevstralStream`（`src/fast-context/protocol.cjs`）。这些接口不稳定，改动附近代码时按「可能失败」处理，不要在失败路径上伪装成功。
- `AssignModel` 本地应答不含 `assignment_jwt`（官方 `ModelAssignment` 响应带该字段）。当前 CLI（3000.10.48 实测）不校验；若未来版本强制校验，本地指派整体失效——届时改为转发上游或显式降级，不得伪造成功。
- 修改行为时不要放宽现有安全校验（Origin 一律 403、控制令牌 `timingSafeEqual`、webview 只用 `createElement`/`textContent` 不用 `innerHTML`、CSP nonce）。
- **矩阵恒开，没有开关**：`buildCatalog` 总是发射交叉积，`kind` 一律是 `'matrix'`，且**不得进入面板分组**（面板分组只收 `kind === 'model'` 的普通条目；旧 `fusionMatrix` 开关与其 OFF 分支已随具名预设一起删除——那条分支只会 emit 预设，留着就是个永不产出的死配置）。官方 Fusion 卡片的维度候选来自「同 family 条目的自声明维度」，所以每个 Lead 值下必须有多条不同 Sidekick/Effort 条目（全交叉积），否则下拉被锁死；`fusion-<lead>-fast-sidekick-<side>` 形式的 `-fast` uid 显式拒绝（BYOK 无 fast 能力，不得伪装降级）。条目一律 `familyUid: 'fusion'` + `isModelRouter` + `displayOption 3`，harness 用 `inferenceServerUrl`（不是硬编码官方地址，否则本地推理地址覆盖失效）。**`Fast Mode` 与 `Recommended Sidekick` 两个信息性维度必须照官方线形态发射**：前者只带 `controlType: 2`、后者只带 `name`，都不写 `order`（`encodeFamily` 因此只在声明了字段时才写，不再用 `order || 0` 兜底）。picker（`nil`）按 `order` 去重维度值、并**丢弃值数 < 2 的维度**：我们若写 `order: 0`，就会与官方的「无 order」分成两个桶——`Fast Mode` 从官方的 2 个选项涨到 3 个，`Recommended Sidekick` 从「不渲染」变成一个真实控件（2026-10-14 真机实测）。
- 矩阵只 emit「至少一方是新增成员」的组合：官方维度成员（lead 有 `leadDimension`、sidekick 有 `dimension`）之间的配对永远交给官方目录，即使官方没有覆盖该组合也不替它发明（避免产出官方不支持的组合）；BYOK 或非官方原生成员与官方成员配对时，官方成员条目复用官方维度 `name+order` 直接并入官方选项，不另造维度值。Lead 一律按**系列**组织：官方 lead 按 `leadDimension` 聚族，其余原生模型按「uid 去掉 Effort 维度名 slug（可带 `-fast` 后缀）」推导族基；面板里一族是一个开关，排除/选中都是整族粒度，`memberUids` 承载全部成员 uid。
- **维度 order 的稳定性是可见性命门**：picker（chat client `nr3`）按 `(dim 名, order)` 去重维度值，同 order 不同名只留先枚举到的一个，其余静默消失。自定义维度值一律走 `stableOrders`（`0x10000000 + hash(name)`，同名恒同 order、跨代稳定），**禁止恢复「20+index」式顺序分配**——配置一变 order 全移，陈旧条目与新条目会在同一 order 上互撞（2026-10-14 实测 `DeepSeek · deepseek-flash`/`Claude Haiku 5.5`/`Claude Haiku 5.5 Medium` 三名共占 order 20，BYOK lead 被隐藏）。
- **陈旧 emit 条目的判别指纹**：官方 fusion 条目恒带能力记录（proto field 32，含 `fusion-sidekick-*` 注册条目），我方 emit 永不写 field 32——「`fusion-*` uid 且无 f32」即我方条目（含无 `dfbyok` 标记的 native×native 形态，`ownUid`/`matrixUids` 都抓不住它们）。若未来给我方条目补 field 32 或额外 harness，必须同步更新该指纹；`team_settings` 白名单里的陈旧 uid 是死指针、无对应条目，不清理。
- **清理条件必须保守：不在 emit 集合里 ≠ 陈旧**。`staleFusionUids` 的完整形态是 `{ emitted, known, excluded }`——只有「uid 拆不出 lead/sidekick」「某一侧已不在 `known`（模型消失 / BYOK uid digest 随配置变了）」「某一侧被该角色显式排除」才判为可删。**禁止退回「不在 emitted 就删」**（传 Set/Array 的旧形式保留该语义，仅为兼容测试）：我们的 emit 集合会随原生 Sidekick 维度到达时序在 24↔155 之间波动，按缺席删除一次就静默删掉 131 条有效组合（2026-10-14 实测：`bak` 24 条 vs 现文件 155 条）。角色排除仍会退休条目，否则关掉的模型会继续把自己的维度值喂进 picker。
- **推送的门控必须描述「真正发送的内容」**：宿主的 `pushKey()` 曾以 `localNativeModels`（bridge 观测）计数，而实际发送的是 `nativeModels`（合并视图）——两者在激活初期不等价：首次 refresh 时 backend 可能还没就绪、返回空，于是**空载荷占用了 key**，紧接着那次有意义的 refresh 被判「未变化」直接跳过，推送静默地从未发生（只在上一轮侥幸的时序下成功过）。现在 key = `local bridge 计数 : 上游载荷条数 : 上游载荷带维度条数`，且**空载荷不占 key**。改这里时务必让门控与实际 payload 同源，否则会退化成「看起来在推、其实没推」。
- **backend 的 ingest 必须拒绝我方 uid**（`/^(?:fusion-)?dfbyok-/`）：宿主的读取端把「被提供的 dfbyok uid」当作非法目录并直接抛 `native_catalog_invalid`，一旦 backend 存了我方条目，**宿主的每一次 refresh 都会失败**。`pushNativeModels` 与 `isUpstreamUid` 共用同一个谓词，避免两侧漂移。
- **原生观测的两条通道必须按「谁更完整」合并，不能后者覆盖**：backend 看的是 CLI 侧流量（CLI 常读自己的缓存、很少重取 → 它的观测可能长期是 seed 的贫化形态），扩展宿主看的是原生扩展 UI 侧的流量（带完整 field 30）。`mergeNativeEntry`（`native-cache.cjs`）在合并时保留 `sidekickDimension`/`fusionMetadata`/`harnessUids`，缺失的一方不会把完整的一方降级；标量字段（`disabled`/`label`）仍以新到者为准。**一旦被贫化条目覆盖，所有原生 Sidekick 解析不到 → 镜像组合消失 → 又被上一条的清理逻辑删除**，这是级联失效。`refreshNativeModels` 与 `observeNativeModels` 都已走该合并。
- **关闭路径的每一段等待都必须有上限**：`close()` 里三段等待（在途请求排水、监控队列 flush、`server.close()` 等连接结束）原本都无上限。半读的 SSE 流会让请求既不 finish 也不 close → `release()` 永不执行 → 排水永不完成 → `close()`/`stopped` 永不 resolve；而 SIGTERM 的处理器本身就在 `await close()`，于是**信号变成空操作**，进程只能 SIGKILL（2026-10-14 实测：必须 `kill -9` 才清掉孤儿 backend）。现在三段都用 `drainTimeoutMs` 兜底，超时后 `closeAllConnections()` 强制收尾并继续走到 `stopped`，保证「关得掉、也杀得掉」。**不要退回无上限等待**，也不要只在超时日志里记录而不强制关闭。
- backend 的原生缓存落盘条件包含「任一入口的维度变富」，不再只看条目数：seed 已是满员（875）时条目数永不变化，只看数量就永远不会把更完整的观测写回磁盘，每次重启都重新 seed 回贫化形态（`runtime.log` 的 `native-observed` 全天只出现 2 次就是这个征兆）。

## 平台支持

**只以 macOS 为目标平台**（个人自用，本机即 macOS）：验证、真机验收、发布检查都只针对 macOS。其他平台按「逻辑可行」的最低标准处理，**短期不做实机验证**。

- **不要声称非 macOS 已验证可用**。涉及平台差异的行为，在代码与文档里注明「仅 macOS 验证」。
- **非 macOS 必须明确失败，不得静默出错**。既有先例（沿用这个模式）：`src/runtime/app-restart.cjs` 在非 darwin 抛 `restart_unsupported`，面板提示「当前环境不支持重启 Devin」；`src/update.cjs` 的 `supported` 判断使非 macOS 只能手动装 vsix。注意 `package.json` **未设 `os` 字段**，其他平台能装上、只是相应功能不可用。
- **已知 macOS 硬编码**（非 macOS 上会失败或降级，暂无适配计划）：`/usr/bin/sqlite3`（用量归属，`monitor.cjs`；失败降级为 `unavailable`）、`/usr/bin/unzip`（一键安装，`update.cjs`）、`/usr/bin/open` 与 `/usr/bin/grep`（重启 Devin，`app-restart.cjs`）、`/usr/bin/zip`（打包，`scripts/package.cjs`）。Fast Context 的 ripgrep 查找是唯一带回退的：`FUSION_FAST_CONTEXT_RG` → `PATH` → `/Applications/Devin.app/...`，都找不到才抛 `ripgrep_unavailable`。
- **测试只覆盖逻辑分支**：平台差异靠注入参数验证（如 `platform` 形参、`resolveNode(env, platform)`），不依赖真机。
- 结论：**不要为未验证的平台做重构**；能低成本避免耦合就避免，已硬编码的保持现状。

## 自更新（发布约束）

- 自更新运行时只读 `src/update.cjs` 的 `REPOSITORY` 常量，`PAGE` 与 `API` 由它派生。测试通过导出的 `PAGE` 复用，不要重写回硬编码字符串。换仓库需同时改这里与 `package.json` 的 `repository.url`（后者是纯元数据，运行时不读）。
- **不要修改 `package.json` 的 `name`（必须 `devin-fusion-byok`）和 `publisher`（必须 `local`）**：`verifyPackage()` 会校验包内 `package.json` 与 `extension.vsixmanifest` 的 Id/Publisher/Version 一致，不一致则拒绝安装。
- Release 资产名必须严格等于 `devin-fusion-byok-<version>.vsix`，且下载地址必须是 GitHub 标准的 `<PAGE>/download/<tag>/<asset>` 形式（`releaseInfo()` 会做严格相等校验）。`npm run package` 按 `name-version` 命名，与之一致。
- tag 必须是 `v<major>.<minor>.<patch>` 形式的三段纯数字 semver（`v` 可省略）；draft 与 prerelease 一律不被接受。
- 资产必须带 GitHub 自动计算的 `digest`（`sha256:` + 64 位十六进制）且大小 ≤ 50 MiB，否则 `installable=false`，面板只提供「打开发布页面」。
- 插件内 `package.json` 的 `version` 必须严格小于 Release 版本才会提示更新，发布前记得 bump。
- 一键安装仅在 macOS 且 `<appRoot>/bin/devin-desktop` 存在时可用（`createUpdateHost` 里的 `supported` 判断）；其他情况 `canInstall=false`，只能手动下载 vsix。
- 更新检查只访问 `api.github.com` 与 GitHub 下载域名（`allowedUrl` 白名单在代理路径同样逐跳校验）。代理由插件自管：`config.json` 的 `updateProxy` 经 `src/proxy.cjs` 建 CONNECT 隧道，只作用于更新检查与一键安装，其余流量（模型请求、内网地址）保持直连。**不要改成读 `http.proxy` 设置或 `HTTPS_PROXY`/`http_proxy`/`ALL_PROXY` 环境变量**——那会全局生效，把内网 HTTPS 地址也送去代理。**也不要依赖扩展宿主被打过补丁的 `fetch`**：Devin 启动时会把 `globalThis.fetch` 换成 `@vscode/proxy-agent` 的代理感知版本（读 VS Code 的 `http.proxy` / `http.noProxy`，`http.proxySupport` 默认 `override`），那也是全局的，同样会波及内网地址——配置 `updateProxy` 时走 `src/proxy.cjs` 的 CONNECT 隧道；未配置代理的更新与模型发现走其 `directFetch`，使用独立 Agent，不依赖宿主全局 `fetch` 或全局 Agent。（这些约束只针对**插件运行时代码**；开发者在终端跑 git/gh 命令时按「本机网络路径」一节处理，两者不冲突。）验收方法见 `.devin/skills/release/SKILL.md`。
- **`src/proxy.cjs` 的请求一律经 `http.ClientRequest` 构造，绝不用 `http.request`/`https.request`**：宿主补丁不只换 `fetch`，还会替换 `http.request`/`http.get`（`createHttpPatch` 注入 `PacProxyAgent`，`http.proxySupport` 默认 `override`），把我们的 `createConnection` CONNECT 隧道顶掉——实测表现为跳过代理直连 `api.github.com` 随即 `ECONNRESET`。`ClientRequest` 是公开构造器、不在补丁替换范围（`node:https` 没有同名导出，TLS 仍由传入的 `https.Agent` 处理）；`directFetch` 同样必须走这条路，否则用户一旦在 VS Code 里配置 `http.proxy`，「内网地址直连」的保证就失效。`http.ClientRequest` 缺失时才回退到 `http.request`/`https.request`。
- `updateProxy` 可在面板 **设置 → 更新代理** 编辑（只作用于更新检查与一键安装），清空即直连。`snapshot().proxy` 与面板 `state().updateProxy` 只回显 `maskProxy()` 掩码（`http://***@host:port`），**凭据不进入 webview**，也不写入日志或错误文案；直接保存掩码视为未改、不覆盖存储值，输入完整新 URL 才会替换。面板侧校验复用 `parseProxy`，非法输入不回显、不写盘。
- 「重启 Devin」的 detached helper：优先经 `launchctl submit` 注册给 launchd 运行（submit 失败回退 detached `/bin/sh`）——实测 helper 是 App 后代时其 `open` 请求被归因为 App 自身激活而静默吞掉；已实测从 App 进程树内 `launchctl submit` 的 job 落在用户域 `gui/501`（非 App 自身的 runningboard 域），因此不随 App 退出被拆除。等 App 退出后只小静置约 3 秒，随后最多 10 轮「先探测再启动」的自适应重试：实测旧实例退出后 ~10 秒内启动的进程会在 ~110ms 内自退（+1.1s 与 +3.3s 两次中招，+10s 起全部存活），风险窗口是时间性的；但盲等固定时长浪费——一次自退 ~113ms 即可被探测发现，故改成「小静置 + 快速失败探测 + 有限轮重试」，若窗口其实来自已修复的陈旧 IPC 句柄则第 1 轮即成功（约 5s），否则轮次自然覆盖窗口之外，最坏与固定静置持平且无固定浪费。113ms 退出的根因已确证是 Devin 自实现的单实例仲裁：主进程监听 `<userData>/<version>-main.sock`、PID 写入 `<userData>/code.lock`，`claimInstance` 遇 `EADDRINUSE` 时会把请求交接给现有 owner 并直接 exit 0（不建窗口）；因此 helper 确认 App 已退出后、以及每轮启动前，先移除陈旧的 `*-main.sock` 与 `code.lock`（此时已无活着的 owner，与应用自身遇 `ECONNREFUSED` 时删陈旧 handle 的做法一致；`userData` 由 `<globalStorage>` 上溯三级得到）。通道分配保持「`open` 在前、`exec` 兜底」：前 50% 轮 `open`、中间到 80% `open -n`、最后两轮直接 exec `<bundle>/Contents/MacOS/<AppName>`（不经 LaunchServices 注册，参照 Electron `app.relaunch()` 的确定性路径，作为兜底）；探测命中后隔 2 秒复探才算成功（瞬时启动不算），预算内放弃 `exit 1`，取消退出时先 `launchctl remove` 再退。日志写 `<globalStorage>/restart.log`（每次重启把上一轮轮转为 `restart.log.previous`），行前缀为 UTC 时间戳；`open` 与应用自身的 stdout/stderr 也追加进该日志，且 `attempt <n> channel=<c>` / `confirmed round=<n>` 记录成功轮次与通道，真实阈值可观测。非 darwin 抛 `restart_unsupported`；存活探测用 `ps -Ao comm=`（`pgrep` 会跳过祖先进程，而 helper 必在 App 进程树内时不可用）。

## fork 同步与发布

本仓库是上游 fork，会持续同步 `upstream`。以下约定是刻意设置，merge 时不要被 upstream 覆盖。

### 同步 upstream

```bash
git fetch upstream && git merge upstream/main
```

- `upstream` 是 **HTTPS** remote。本机已配 URL 限定代理，所以上面是裸命令；**未配置的机器**上会挂约 75 秒后才失败，此时改用 `HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=localhost,127.0.0.1 git fetch upstream`（`NO_PROXY` 不可省：给 git 加前缀会让该命令触及的所有 HTTPS 都走代理；见「本机网络路径」）。`origin` 是 SSH，`git push` 一律**不要**加这个前缀。
- 用 **merge**，不要用 `git pull upstream`：显式 fetch + merge 能明确来源，冲突时也便于对照下面的差异表；本仓库已设 `pull.rebase=false`，即使误用 pull 也不会走 rebase 重写历史、不需要 force push。
- 已启用 `rerere`（`git config --local rerere.enabled true`）：README 等固定位置的重复冲突会自动复用上次解法。但 **`package.json` 的 `version` 冲突它救不了** —— upstream 每次改的版本号都不同，冲突片段内容随之变化，匹配不上。
- 冲突处理：`package.json` 的 `version` **一律取本 fork 的值（ours）**。版本号由本 fork 自管、不跟随 upstream；上游每次发版都会只在这一行产生冲突，固定改 1 行即可。

### 版本号怎么取

版本号由本 fork 自管，**与 upstream 的版本号无耦合**：自更新只比较「本地 `package.json` 的 version」与「本仓库 GitHub Release 的最新版本」（`API` 由本仓库的 `REPOSITORY` 派生），upstream 的版本号不参与任何判断。

`parseVersion()` 只认三段纯数字；`0.3.43-1`、`0.3.43+foo`、`0.3.43.1` 会让自更新直接报错失效。

- 发布版本 = 本 fork 上次发布的版本 patch +1；从 0.3.42 起自管，首次发布取 0.3.43。
- **唯一不变式：相对本 fork 自己的历史版本严格递增。** `compareVersions(latest, current)` 要求严格大于，本地版本 ≥ Release 版本时不会提示更新。
- 与 upstream 的版本号大小无关，不必刻意高于 upstream（本地 VSIX 安装是直接替换，安装更低版本不会被拒绝）。
- 发布前校验格式：

```bash
node -e "const v=require('./package.json').version; if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw Error('版本必须是三段纯数字: '+v); console.log('version OK:', v)"
```

代价：取 ours 后 `package.json` 不再反映所基于的 upstream 版本。**merge 提交信息里写明所合并的 upstream 版本**（例如 `merge upstream v0.3.43`），`git log` 是唯一的追溯来源。

### 发布步骤

完整流程与验收方法见 `.devin/skills/release/SKILL.md`（`/release` 调用）：定版本 → `npm test` → `npm run package` → 推送 + 打 tag → 建 Release → **用已安装副本的代码跑读回路校验** → 覆盖安装。

要点：`npm run package` 产出的 `devin-fusion-byok-<version>.vsix` 必须原样命名为 `v<version>` Release 的资产；必须 Publish 而非存为 draft；Release body 即面板显示的更新说明（截取前 6000 字符）。

### 本 fork 相对 upstream 的刻意差异

merge 冲突时以此表为准；表外差异一律视为 upstream 改动，取 upstream。

| 文件 | 差异 |
| --- | --- |
| `src/update.cjs` | `REPOSITORY` 改为 `TendernessCJS/devin-fusion-byok`；导出 `PAGE`；`requestBytes` 支持 `proxy`，无代理时默认 `directFetch`；`createUpdater` 增加 `proxy` getter，快照回显 `proxy` 供设置页编辑 |
| `test/update.test.cjs` | 使用导出的 `PAGE`，不再硬编码仓库 URL；含代理相关用例 |
| `README.md` | 顶部 fork 声明；Releases 链接指向本 fork；保留上游作者署名 |
| `package.json` | 新增 `repository` 字段；`version` 由本 fork 自管，merge 时取 ours |
| `AGENTS.md` | 本 fork 新增（upstream 无），项目约定与 fork 同步规则 |
| `.devin/skills/release/SKILL.md` | 本 fork 新增（upstream 无），发布与自更新验收流程 |
| `src/proxy.cjs` | 本 fork 新增（upstream 无），更新的 CONNECT 代理与独立 Agent 直连 GET；全部请求经 `http.ClientRequest` 构造以绕开宿主对 `request`/`get` 的补丁；CONNECT 仅用于更新，`directFetch` 用于模型发现与未配代理的更新；握手早关、压缩流、取消与 TLS 校验均有回归测试 |
| `test/proxy.test.cjs` | 本 fork 新增（upstream 无），覆盖代理、直连、解压、取消、IPv6、TLS 安全边界与宿主补丁旁路 |
| `src/runtime/retry.cjs` | 本 fork 新增（upstream 无），连接层一次性重试；只被 `native-models.cjs` 与 `monitor-client.cjs` 使用 |
| `src/runtime/app-restart.cjs` | 「重启 Devin」：存活探测用 `ps -Ao comm=`（`pgrep` 跳过祖先）；helper 优先 `launchctl submit` 注册给 launchd（落在 `gui/501`，避免 `open` 被归因为 App 自我激活且 job 不随 App 拆除），失败回退 detached `/bin/sh`；退出后先清陈旧 `*-main.sock`/`code.lock`（Devin 自实现单实例仲裁，`EADDRINUSE` 即交接退出——113ms exit 0 的根因），小静置 3s + 最多 10 轮自适应重试「先探测再启动 + 二次确认存活」（前 50% `open`、至 80% `open -n`、末两轮直接 exec 可执行文件），日志写 `restart.log` 并轮转 `.previous`（`open`/应用输出也追加进日志，成功轮次与通道可观测） |
| `test/app-restart.test.cjs` | 覆盖探测与重试策略：合成 app 复现 `pgrep` 祖先盲区、退出后才拉起、瞬时进程不误判、预算内退出、日志行、`launchctl` 首选/回退与日志轮转 |
| `src/runtime/monitor.cjs` | 工具归属查询与细分诊断；message-id 补充分支默认关闭，仅内部显式诊断开启并保留 1500 ms 上限；完整标题仅进快照；分段 ID/reasoning/异常用量安全口径；统计复用 monitor-stats；异步存储与失败保护原日志 |
| `src/runtime/monitor-stats.cjs` | 本 fork 新增（upstream 无），无 I/O 的共享统计工厂与本机日历区间筛选；前后端使用同一公式 |
| `test/monitor-stats.test.cjs` | 本 fork 新增（upstream 无），日历月/自定义/DST 边界、同范围重算与浏览器函数注入验证 |
| `src/runtime/monitor-client.cjs` | 公开白名单保留标题、归属/存储诊断和保留上限；新增字段缺失兼容旧 backend，非法诊断不伪装为零 |
| `src/panel/monitor-view.cjs` | 完整会话 tooltip、100 条分页和 DOM 复用；默认当月时间×会话筛选，区间内重新汇总；本机时区展示与原始时间提示；细分诊断和明确 TPS 口径 |
| `test/monitor.test.cjs`、`test/monitor-panel.test.cjs` | 覆盖默认禁用消息扫描、诊断 opt-in、细分归属/存储状态、旧快照兼容、reasoning/异常计数/分段 ID、指标口径，以及既有异步存储/分页/状态重传 |
| `src/panel/context-view.cjs`、`test/context.test.cjs` | 上下文详情的最近请求指标文案与监控保持同一口径，不拿原生 TPS 替代插件度量 |
| `src/config.cjs`、`test/config.test.cjs` | 模型发现使用独立 Agent 的 `directFetch`；显式 request 注入测试；不依赖宿主 fetch 或全局 Agent |
| `src/extension.cjs`、`test/extension-lifecycle.test.cjs` | 错误自动继续达到预算后显示中文警告，安全处理提示 Promise；激活时执行一次带备份的预设退役迁移；`checkCliCaches` 返回报告并同时服务面板手动刷新 |
| `src/runtime/auto-continue.cjs`、`test/auto-continue.test.cjs` | 连续错误最多自动重试 5 次、窗口 10 分钟；停止时结算并清理，回调不能影响新回合 |
| `src/runtime/backend.cjs`、`test/backend.test.cjs` | 关闭前同时等待响应与处理器结束，再刷监控队列、最后释放端口；**每一段等待都有上限**（`drainTimeoutMs`，默认 5 秒）、超时记 `drain-timeout`/`monitor-close-timeout`/`close-timeout` 并强制 `closeAllConnections`；宿主可 `POST /_runtime/native-models` 推送完整观测（`/health` 的 `nativeModelsIngest` 为能力标志）；源码身份包含 `proxy.cjs` 与 `monitor-stats.cjs` |
| `src/runtime/bridge.cjs`、`test/bridge.test.cjs` | 转发增加连接 10 秒、响应头 120 秒、流空闲 120 秒超时；无流总时长限制，取消/错误清理计时；`catalog` 日志只报 `models`/`matrix`（预设计数已删） |
| `src/panel/controller.cjs` | state 成功投递后才去重；发送串行化，ready 强制同步，旧面板不得污染新缓存 |
| `src/panel/view.cjs` | tab 顺序「模型 / Fusion / 用量 / Goal / Fast Context / 设置」；Fusion 页即官方 Fusion 卡片的角色配置（Lead/Sidekick 勾选），默认 tab 为「模型」；设置页含「官方模型显示」与「CLI 缓存」（手动刷新入口）；会话选择器单行省略、日期控件、监控分页与诊断分行布局 |

## 待办与死角

- 旧 `config.sidekicks` 输入管线已拆除（v0.3.18 起角色选择由 `roleExclusions`/`roleInclusions` 接管）：字段只剩被忽略的惰性配置残留，旧配置里留着的 `sidekicks` 键无害。注意 `catalog.sidekicks` **输出**与 `state.sidekicks` 仍是活的——它们是角色选择解析后的候选池，不要当成死代码删掉。角色选择走 `setRoleModel`。
- **具名预设整条管线已退役**（`config.fusionPresets`、`presetUid`、`catalog.presetStates`/`presetCandidates`/`migrationPending`/`migratedFrom`、`saveFusionPreset`/`deleteFusionPreset` 消息、`publicState` 的 `fusionPresets`/`presetCandidates`/`migrationPending`/`selectedFusionUid`/`fusionChoices`/`fusionCount` 全部不存在了——只剩 `fusionCount` 这个**语义已改**的字段，现在等于 `matrixUids.size`）。退役前提是矩阵恒开：官方 Fusion 卡片就是唯一选择入口，一个平行的「我的预设」目录已无物可描述，它的 OFF 分支也不可能再产出（见上条）。要恢复具名预设必须连开关一起重建，不要只加回状态字段。
- **一次性配置迁移 `migrateFusionConfig`**（`catalog.cjs`）在 `extension.cjs` 激活时执行一次，且只认 `fusionPresets`/`defaultFusionUid`/`fusionMatrix` 三键中任一存在才动手（幂等，迁移后立即返回 false）。它把预设引用的 lead/sidekick 提升为 `roleInclusions`（仅当**当前可解析且未被排除**，否则丢弃——否则会复活用户已排除的模型）、把预设 uid 映射成等价矩阵 uid 写进 `lastFusionSelection`、然后删除三个旧键。**写盘前必须把原文件复制到 `config.json.pre-preset-retirement.bak`**（用户亲手写的预设列表不能无声消失），该备份存在即跳过后续迁移。清单式变更（供应商/模型）会顺带调用 `pruneDanglingRoleRefs`（`panel/model.cjs`）——`providerId` 引用在配置是权威的，模型消失即永久失效，必须清掉（否则面板留下无法清除的死行）；`nativeUid` 引用**永不**清理（原生目录靠观测，缺席通常只是「还没同步」）。
- `lastFusionSelection` 取代了 `defaultFusionUid`：它既是「锁定的官方 Fusion 选中时回退到哪个组合」（`defaultFusion()`）的取值来源，也是「偏好被清空时恢复什么」的记忆。**记录它不等于改写偏好**——`reconcilePreference` 对任何 `fusion-` 形状的选择（官方的也算）只调 `rememberFusion` 记录、绝不 `saveFusionChoice` 改写：用户/Devin 在官方卡片里选的组合必须原样保留，被改掉就是静默撤销用户操作。
- 关掉一个官方模型的显示（`config.hiddenNativeModelUids`）会**同时**把它踢出角色候选池——`discoverOfficialRoles`/`discoverNamedPresetRoles` 都吃 `hiddenSet`，而 `nativeHarnessUids`/`nativeLeadHarnessUids` 只由入选者构建；因此正在使用的组合会失去 harness 而无法解析（`resolveAssignment` 返回 null，不会自动回退）。同理，`roleExclusions` 排除 Lead/Sidekick 也会让存量组合失效。面板文案不得承诺「不影响已保存的组合」。
- ACP 通道的实际机制是 env 注入（`devin.acp.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL`，进程 spawn 时生效、覆盖 CLI 全部网络路径），**不是**握手 `_meta.api_server_url` 改写——后者的模块已在审查后删除（`acp-injection.cjs` 自 fork 初始提交起从未接线，env 通道作用域严格覆盖它）。排障 ACP 流量先看 settings.json 的 agentEnv 与 backend 日志，不要去复活握手改写。

## 测试注意

- `test/support/installed-renderer.cjs` 与 5 处条件 `skip` 依赖本机已安装的 Devin 原生渲染文件；缺失时会跳过而非失败。
- **用 `ps | grep <名字>` 排查进程时，注意命中的可能是执行该命令的 bash 自身**：命令文本里一旦出现那个字面量（例如脚本里的 `'backend.cjs'`），`bash -c ...` 就会一并被匹配，且它的 ppid 正好是 CLI 的 `exec` 父进程——看起来就像「CLI 派生了一个 backend」。曾据此误判出根本不存在的孤儿 backend（2026-10-14）。要确认，务必打印**完整命令行**（`ps -o command= -p <pid>`）或直接核对 `/health` 与端口归属；`[b]ackend` 这类写法只能防住 grep 自己，防不住携带同样字面量的父 bash。
- **等异步效果不要靠「跑几轮 `setImmediate`」**：扩展 fixture 的 `settle(n)` 只排空微任务与 `setImmediate`，**不会让 `setTimeout` 触发**（实测 20 轮后 `setTimeout(0)` 仍未执行）。依赖真实定时器的行为（例如宿主的推送节流）必须用带 deadline 的轮询等待，否则测试会在负载变化时假性通过或假性失败——`extension-lifecycle` 的推送用例就这样脆弱过一轮。反过来，若某断言依赖「节流窗口已过」，等待时间必须**长于**节流间隔，否则删掉节流门控也测不出来。
- Goal 与 Fast Context 目前只有模拟连接 / 合成代码的测试，尚未在真实 Devin 窗口完成端到端验收。
- 「重启 Devin」触发即退出 Devin，无法在会话内端到端验证；其探测与时序由 `test/app-restart.test.cjs` 的合成 app 覆盖。
