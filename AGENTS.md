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

## 架构边界

- 本扩展不修改 Devin 应用本体、不重新签名、不安装证书、不改系统代理。保持这个前提。
- 强依赖 Devin 私有接口：LS `Heartbeat` 抓端口（`src/runtime/ls-injection.cjs`）、catalog 的 protobuf 字段号与 Connect 帧（`src/protocol/wire.cjs`、`src/catalog.cjs`）、ACP `registerConnection` 与握手 `api_server_url`（`src/runtime/acp-injection.cjs`、`auto-continue.cjs`、`goal-continue.cjs`）、Fast Context 的 `GetDevstralStream`（`src/fast-context/protocol.cjs`）。这些接口不稳定，改动附近代码时按「可能失败」处理，不要在失败路径上伪装成功。
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
| `src/update.cjs` | `REPOSITORY` 改为 `TendernessCJS/devin-fusion-byok`；导出 `PAGE`；`requestBytes` 支持 `proxy`，无代理时默认 `directFetch`；`createUpdater` 增加 `proxy` getter |
| `test/update.test.cjs` | 使用导出的 `PAGE`，不再硬编码仓库 URL；含代理相关用例 |
| `README.md` | 顶部 fork 声明；Releases 链接指向本 fork；保留上游作者署名 |
| `package.json` | 新增 `repository` 字段；`version` 由本 fork 自管，merge 时取 ours |
| `AGENTS.md` | 本 fork 新增（upstream 无），项目约定与 fork 同步规则 |
| `.devin/skills/release/SKILL.md` | 本 fork 新增（upstream 无），发布与自更新验收流程 |
| `src/proxy.cjs` | 本 fork 新增（upstream 无），更新的 CONNECT 代理与独立 Agent 直连 GET；CONNECT 仅用于更新，`directFetch` 用于模型发现与未配代理的更新；握手早关、压缩流、取消与 TLS 校验均有回归测试 |
| `test/proxy.test.cjs` | 本 fork 新增（upstream 无），覆盖代理、直连、解压、取消、IPv6 与 TLS 安全边界 |
| `src/runtime/retry.cjs` | 本 fork 新增（upstream 无），连接层一次性重试；只被 `native-models.cjs` 与 `monitor-client.cjs` 使用 |
| `src/runtime/app-restart.cjs` | 「重启 Devin」的存活探测由 `pgrep` 改为 `ps -Ao comm=`：macOS `pgrep` 跳过调用者自身的祖先进程，而 helper 必然在 app 进程树内，因此原本永远看不到主进程（表现为只关闭不重启） |
| `test/app-restart.test.cjs` | 覆盖新探测方式：合成 app 复现 `pgrep` 祖先盲区、并验证 app 退出后才重新拉起 |
| `src/runtime/monitor.cjs` | 归属查询保留失败隔离：索引 tool-id 为权威，message-id 补充分支保留 1500 ms 上限；完整标题与活动时间只进快照；异步追加、每额外 250 条压缩、失败保护原日志、`flush()` / `close()` 等待落盘 |
| `src/runtime/monitor-client.cjs` | `sessionOf()` 白名单放行 `title` / `lastActivityAt`（漏登记会被静默剥离） |
| `src/panel/monitor-view.cjs` | 会话下拉显示标题与相对时间、完整 tooltip；请求表每页 100 条，汇总仍覆盖全部保留记录；不变快照不重建表格和指标节点 |
| `test/monitor.test.cjs`、`test/monitor-panel.test.cjs` | 覆盖归属失败隔离、完整标题与白名单、异步存储/关闭/错误保护、分页与节点复用，以及控制器 state 投递失败重传 |
| `src/config.cjs`、`test/config.test.cjs` | 模型发现使用独立 Agent 的 `directFetch`；显式 request 注入测试；不依赖宿主 fetch 或全局 Agent |
| `src/extension.cjs`、`test/extension-lifecycle.test.cjs` | 错误自动继续达到预算后显示中文警告，安全处理提示 Promise |
| `src/runtime/auto-continue.cjs`、`test/auto-continue.test.cjs` | 连续错误最多自动重试 5 次、窗口 10 分钟；停止时结算并清理，回调不能影响新回合 |
| `src/runtime/backend.cjs`、`test/backend.test.cjs` | 关闭前同时等待响应与处理器结束，再刷监控队列、最后释放端口；源码身份包含 `proxy.cjs` |
| `src/runtime/bridge.cjs`、`test/bridge.test.cjs` | 转发增加连接 10 秒、响应头 120 秒、流空闲 120 秒超时；无流总时长限制，取消/错误清理计时 |
| `src/panel/controller.cjs` | state 成功投递后才去重；发送串行化，ready 强制同步，旧面板不得污染新缓存 |
| `src/panel/view.cjs` | 会话选择器单行省略与监控分页布局 |

## 待办与死角

- `src/runtime/acp-injection.cjs`、`src/runtime/acp-observer.cjs` 在 `src/` 内无任何调用点（仅各自测试通过 `vm` 加载）；`src/config.cjs` 的 `updateSidekicks()` 同样未被调用。改动这两块前先确认是否已废弃。

## 测试注意

- `test/support/installed-renderer.cjs` 与 5 处条件 `skip` 依赖本机已安装的 Devin 原生渲染文件；缺失时会跳过而非失败。
- Goal 与 Fast Context 目前只有模拟连接 / 合成代码的测试，尚未在真实 Devin 窗口完成端到端验收。
- 「重启 Devin」触发即退出 Devin，无法在会话内端到端验证；其探测与时序由 `test/app-restart.test.cjs` 的合成 app 覆盖。
