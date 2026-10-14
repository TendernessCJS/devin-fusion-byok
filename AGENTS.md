# AGENTS.md

Devin Fusion BYOK：一个 Devin/VSCode 扩展，通过运行时桥接把第三方模型（OpenAI Responses / Chat Completions / Anthropic Messages）注入 Devin 原生模型列表，并组合成 Fusion 预设。

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
- 原生模型目录靠观测，重启后内存里为空；观测结果经 `<storage root>/native-cache.json` 跨进程缓存（格式 `{version, savedAt, models}`，TTL 7 天，原子写：临时文件 + rename，`0o600`）。它是**观测缓存**、不是用户配置，只含 uid/label/能力标志，绝不落凭证；追加并集语义（与内存一致，不因单批缺席而删条目）。此时预设引用的官方模型解析不到，**不得**断言「已从角色列表移除」——要按 `nativeCatalogStatus` 区分「尚未同步」（`pending`，muted 文案，判定依据为**内存与缓存都没有可用观测**）与「目录就绪但模型确实不在」（真警告）。BYOK 供应商引用写在配置里，解析不到就是真的不可用，不算 pending。
- 原生目录由空变有（或目录签名变化）→ 触发 `pickerRefresh.changed()`；刷新只用轻量命令 `devin.reloadAcpConnections`（执行成功即算完成，ACP 观测只是旁证——session 惰性生成，验证超时不再回退）；**不得回退到 `devin.newConversation` 之类开会话的命令**——会话惰性生成导致验证常超时，实测每次重载都自动开会话，干扰用户。数据正确性由 cli-cache 失效兜底，刷新只是加速可见。
- 新增 backend 运行时模块**必须**同时加入 `backend.cjs` 的 `SOURCE_FILES`（它参与 `sourceId()` 哈希，漏加会导致同版本重装不重启 backend，新代码永远不生效）。
- `augmentLocalModelChoices` 的门控是「Fusion 需要其原生 uid 出现在字段 7 允许列表里、普通 BYOK 不需要」——盲窗（原生观测为空）下 Fusion 整组被丢而普通 BYOK 全留，现象会被误读成「非 Fusion 模型缺失」，排障时先看这里而不是重查目录生成。
- CLI 的模型选择器是「`~/.cache/devin/cli/` 的按身份持久缓存（`user_status`/`model_configs_v5`/`team_settings` 的 `.<digest>.bin` JSON 信封，payload 为 base64 proto）∩ 白名单」；配置改动会改普通模型 uid（digest 含 `provider.id`/`model.id`/`effort`），缓存陈旧期普通条目整批丢失而 Fusion 预设幸存（uid 仅由 `preset.id` 导出）。`src/runtime/cli-cache.cjs` 按「payload 含 `dfbyok` 判定我方身份、含 dfbyok 但缺当前 uid 判定陈旧」把陈旧文件改名为 `.stale`（不删除、可回退、CLI 下次读取时重拉），不碰无 dfbyok 标记的其他身份文件；失效后经 `pickerRefresh.force()`（绕过签名比较的强制路径）刷新。Composer 模型缺失排障时先看缓存新鲜度，backend 注入日志（`afterOwn`）证明不了 picker 侧可见性。

## 架构边界

- 本扩展不修改 Devin 应用本体、不重新签名、不安装证书、不改系统代理。保持这个前提。
- 强依赖 Devin 私有接口：LS `Heartbeat` 抓端口（`src/runtime/ls-injection.cjs`）、catalog 的 protobuf 字段号与 Connect 帧（`src/protocol/wire.cjs`、`src/catalog.cjs`）、ACP 连接器面（`windsurfAcp.registerConnection` / `connector.sendRequest` / `connector.forwardClientRequest`，被 `acp-observer.cjs`、`auto-continue.cjs`、`goal-continue.cjs` 观察与包装）、CLI 的 `WINDSURF_API_SERVER_URL` env 覆盖（经 `devin.acp.agentEnv` 受管设置注入，ACP 通道的实际入口）、Fast Context 的 `GetDevstralStream`（`src/fast-context/protocol.cjs`）。这些接口不稳定，改动附近代码时按「可能失败」处理，不要在失败路径上伪装成功。
- `AssignModel` 本地应答不含 `assignment_jwt`（官方 `ModelAssignment` 响应带该字段）。当前 CLI（3000.10.48 实测）不校验；若未来版本强制校验，本地指派整体失效——届时改为转发上游或显式降级，不得伪造成功。
- 修改行为时不要放宽现有安全校验（Origin 一律 403、控制令牌 `timingSafeEqual`、webview 只用 `createElement`/`textContent` 不用 `innerHTML`、CSP nonce）。

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
| `src/extension.cjs`、`test/extension-lifecycle.test.cjs` | 错误自动继续达到预算后显示中文警告，安全处理提示 Promise |
| `src/runtime/auto-continue.cjs`、`test/auto-continue.test.cjs` | 连续错误最多自动重试 5 次、窗口 10 分钟；停止时结算并清理，回调不能影响新回合 |
| `src/runtime/backend.cjs`、`test/backend.test.cjs` | 关闭前同时等待响应与处理器结束，再刷监控队列、最后释放端口；源码身份包含 `proxy.cjs` 与 `monitor-stats.cjs` |
| `src/runtime/bridge.cjs`、`test/bridge.test.cjs` | 转发增加连接 10 秒、响应头 120 秒、流空闲 120 秒超时；无流总时长限制，取消/错误清理计时 |
| `src/panel/controller.cjs` | state 成功投递后才去重；发送串行化，ready 强制同步，旧面板不得污染新缓存 |
| `src/panel/view.cjs` | 会话选择器单行省略、日期控件、监控分页与诊断分行布局 |

## 待办与死角

- 旧 `config.sidekicks` 输入管线已拆除（v0.3.18 起角色选择由 `fusionPresets` + `roleExclusions`/`roleInclusions` 接管）：字段只剩被忽略的惰性配置残留，旧配置里留着的 `sidekicks` 键无害。注意 `catalog.sidekicks` **输出**与 `state.sidekicks` 仍是活的——它们是角色选择解析后的候选池，legacy `fusion-dfbyok-native-` 默认 uid 迁移和面板状态都在用，不要当成死代码删掉。角色选择走 `setRoleModel`，预设走 `saveFusionPreset`。
- ACP 通道的实际机制是 env 注入（`devin.acp.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL`，进程 spawn 时生效、覆盖 CLI 全部网络路径），**不是**握手 `_meta.api_server_url` 改写——后者的模块已在审查后删除（`acp-injection.cjs` 自 fork 初始提交起从未接线，env 通道作用域严格覆盖它）。排障 ACP 流量先看 settings.json 的 agentEnv 与 backend 日志，不要去复活握手改写。

## 测试注意

- `test/support/installed-renderer.cjs` 与 5 处条件 `skip` 依赖本机已安装的 Devin 原生渲染文件；缺失时会跳过而非失败。
- Goal 与 Fast Context 目前只有模拟连接 / 合成代码的测试，尚未在真实 Devin 窗口完成端到端验收。
- 「重启 Devin」触发即退出 Devin，无法在会话内端到端验证；其探测与时序由 `test/app-restart.test.cjs` 的合成 app 覆盖。
