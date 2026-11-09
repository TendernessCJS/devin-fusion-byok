# AGENTS.md

Devin Fusion BYOK：一个 Devin/VSCode 扩展，通过运行时桥接把第三方模型（OpenAI Responses / Chat Completions / Anthropic
  Messages）注入 Devin 原生模型列表，并把 BYOK/原生模型的组合镜像进 Devin 官方的 Fusion 卡片。

## 为什么行为约束不在本文件里（2026-10-17 实测后改成分卷）

规则注入有**每文件 16,384 字节上限**，超出部分**静默丢弃**；窗口是**零和预算**，新增内容必然挤掉现有内容，唯一扩容方式是移出成独立文件。因此本文件只留索引、短节与最高危禁令速查。完整实测（本文件曾 62,731 字节、只有前 26% 进入上下文）与拆卷纪律见 `.devin/rules/rule-authoring.md`。

## 最高危禁令速查（漏了会静默坏）

- **不动 Devin 本体**：不修改/不重签名 Devin.app、不安装证书、不改系统代理。
- **不放宽现有安全校验**：Origin 一律 403、控制令牌用 `timingSafeEqual`、webview 只用 `createElement`/`textContent`。
- **backend 代码禁用动态 require**——`sourceId()` 的哈希输入是加载期从字面量 require 图自动推导的，动态 specifier 会让推导直接抛错、backend 起不来。
- **不要让任何人「恢复」`message_nodes` 按 `message_id` 反查归属**（实测 31 秒全表扫描）；归属只查 `tool_call_state`。
- **不要恢复任何 picker 刷新命令**（曾导致每 5–35 秒重载整个窗口；守护在 `test/architecture.test.cjs` 的 `reloadAcpConnections` 禁令）。
- **CLI 缓存绝不改名、绝不写 `.stale`**（v6 实测会自愈、v1–v5 不会，自愈时机不可依赖；改名仍可能把 picker 打空）；`model_configs*` 可写性按文件内容判定，不按代际白名单——合法信封的未来代际照常重写。
- **日志禁止**写入 `apiKey`、控制令牌、`authorization` 头、对话正文。
- **永不向 `upstream` 推送**；`origin` 才是推送目标。

## 主题卷索引（按需加载）

下面两类卷都**不常驻**：`devin rules list` 里无论 `trigger: glob` 还是 `trigger: model_decision`，规则都只登记为
  **`agent-decidable`**（按模型判断注入，**不保证加载**）。所以「漏读会安静地做错」的知识不能靠「放在哪个文件」保证送达，
  索引必须给出**何时必读**——这也是上面「为什么不把约束留在本文件里」的同一组实测约束逼出来的结论。
  **缺 frontmatter 的卷登记为 `manual`**（模型永远选不中它，索引里的「何时必读」就成了不可执行的声明），
  `test/rule-budget.test.cjs` 硬拦缺 `trigger`/`description` 的卷。

**体积纪律**：每卷必须 < 16,384 字节，超限部分静默丢弃；`test/rule-budget.test.cjs` 硬拦超限卷与「新卷没进本索引」，判据以测试为准。接近上限时**先拆卷再加内容**；拆卷纪律（逐字搬运、`scripts/rule-split-check.cjs`、豁免语法与 2026-10-27 事故依据）见 `.devin/rules/rule-authoring.md`。

**行为锚定卷**（改代码前按需读）

| 卷 | 何时必须读 |
| --- | --- |
| `.devin/rules/runtime-and-injection.md` | 改 ACP/LS 注入、backend 生命周期与关闭、日志、用户设置写入、重试预算或安全校验（模块归属、`protocol/` 与 `activation/` 职责、`SOURCE_FILES` 见下一条 `architecture-boundaries.md`） |
| `.devin/rules/architecture-boundaries.md` | 改模块归属、`src/runtime` 分区、`protocol/` 职责、根门面或 `architecture.test.cjs` 守卫时必读——模块拓扑与依赖守卫的实测描述 |
| `.devin/rules/runtime-forensics.md` | **排查「注入/目录改写改了没生效」时必读**——api server 凭据优先级、`agentEnv` 只覆盖主 agent、日志归属（宿主 channel vs `runtime.log`）、连接按 pid 判、桥的 gzip 体积 |
| `.devin/rules/architecture-forensics.md` | **改模块归属/激活耦合、`host-builds` 快照读法或 LS/ACP 注入边界时必读**——2026-10-26 架构审查的耦合度量与出厂产物核对证据 |
| `.devin/rules/auto-continue-forensics.md` | **排查「该续没续」或改 `auto-continue.cjs` 资格判定时必读**——2026-10-31 `session-info` 永久取消资格的真机时间线与修复依据、两个观测事件的字段、残留待定项 |
| `.devin/rules/upstream-routing.md` | **排查「转发打到了哪里」或推送没生效时必读**——upstream origin 契约与校验、原生派生链与收敛窗口、激活期推送失败的 identity 分级、`upstream-push` / `upstream-origin` / `upstream-push.json` 三个观测落点 |
| `.devin/rules/fusion-matrix.md` | 改 Fusion 矩阵 emit 规则、Lead/Sidekick 资格与命名、harness、Fast Mode |
| `.devin/rules/fusion-matrix-dims-and-harness.md` | 改家族/服务器家族判定、控制维度处理或 harness 执行通道时必读 |
| `.devin/rules/catalog-and-picker.md` | 改 picker 可见性契约、角色白名单、陈旧条目判定与清理、推送门控、`nativeFamilies`、维度 order |
| `.devin/rules/picker-visibility.md` | 改 picker 行可见性契约、角色白名单或 Lead/Sidekick 门槛时必读 |
| `.devin/rules/catalog-allowlist.md` | 改 allowlist 三态判定、双通道去抖或 restricted→unrestricted 提交时机时必读 |
| `.devin/rules/catalog-publication.md` | 改原生 `auth-status` 写入、`GetModelStatuses`，或怀疑「改了配置会话看不见」时必读；发布确认链已随 3.12.17 删除 |
| `.devin/rules/context-and-compaction.md` | 改声明的上下文窗口（ModelInfo `f4`/`maxTokens`）、或怀疑「是不是扩展触发了压缩」 |
| `.devin/rules/native-observation-and-cli-cache.md` | 改原生目录观测与缓存、CLI 缓存原地重写、配置键分类清理 |
| `.devin/rules/cli-cache-generations.md` | 改 CLI 缓存写入资格、代际判定、coverage 与 health 映射时必读 |
| `.devin/rules/native-observation-and-cli-cache-forensics.md` | 排查 picker 风暴/缓存实验/裸形状事故依据时必读（实测证据，非契约） |
| `.devin/rules/native-contract-probe.md` | 改探针标记表、缓存判定，或排查「Devin 升级后插件静默失效」时必读 |
| `.devin/rules/fast-context-mcp.md` | 改 Fast Context 工具/开关/凭据/SSRF 边界，或外部 MCP 报 `unauthenticated`/`upstream_error` 时必读 |
| `.devin/rules/config-and-storage.md` | 改 config.json 读写、面板提交、损坏恢复、受管设置的写入/恢复串行边界 |
| `.devin/rules/monitor-and-panel.md` | 改用量记录/归属/时间筛选、面板 webview 样式、busy 锁定、state 去重与焦点保留 |
| `.devin/rules/release-contract.md` | 改自更新与发布契约（资产名、tag、digest、`updateProxy`、重启 helper） |

**流程与历史卷**

| 卷 | 何时必须读 |
| --- | --- |
| `.devin/rules/upstream-fork-release.md` | 同步 `upstream`、定/升版本号、发布、解 merge 冲突 |
| `.devin/rules/provider-measurements.md` | **改 Responses 面或跨面契约前必读**——供应商面实测事实，已推翻多处早期结论；Anthropic/Chat 单面契约见下一条 |
| `.devin/rules/provider-measurements-anthropic-chat.md` | **改 Anthropic 或 Chat 线格式语义前必读**——按协议面拆出的契约：强制选择×思考的两步降级、签名闭环边界、`cache_control` 被忽略、`max_tokens` 取舍、路由判定的两条通道 |
| `.devin/rules/provider-measurements-forensics.md` | **排查「回放 reasoning 后行为异常」「某改动是否引入问题」或要动状态信封尺寸时必读**——Proxy/DeepSeek 各面的探针证据、对照臂方法与信封尺寸依据（实测证据，非契约） |
| `.devin/rules/provider-endpoint-latency.md` | **排查首响慢、`upstream_timeout`/`upstream_stream_error`，或要动超时预算时必读**——响应头探针、历史统计口径与超时路径的证据边界 |
| `.devin/rules/provider-sdk-parity.md` | **判断某个 provider 线格式字段是否合法、该不该发，或更新 `.refs` 里的 SDK 时必读**——SDK 基线版本与更新方式、我们发送字段的合法性对照、原生无法表达因此刻意不发的字段、以及「REA 管不到 provider 线格式」的判据 |
| `.devin/rules/testing-notes.md` | 写或调测试 |
| `.devin/rules/testing-baselines.md` | 改契约基线 commit、合成场景矩阵或守卫覆盖边界时必读 |
| `.devin/rules/retired-and-deadends.md` | 清理配置键、审「这段代码还活着吗」、疑惑旧字段为何还在 |
| `.devin/rules/audit-residuals.md` | **想"修"某个看着像漏洞/漏做的取舍前必读**——已核残余（DNS 不校验、`ownsSession` fail-closed、`finish_reason` 缺失落 end_turn、config 恢复依赖 `.bak`、panel 运行时未取证）与已排除怀疑（unzip 穿越、SQL 注入、rg 参数注入） |
| `.devin/rules/acp-protocol-fields.md` | 改 `src/protocol/*` 的 protobuf 字段号、核对原生请求/响应/用量字段 |
| `.devin/rules/acp-protocol-fields-forensics.md` | 改字段号、怀疑读数过期，或排查 CompletionDelta 错位陷阱时必读（实测方法与证据） |
| `.devin/rules/acp-protocol-fields-forensics-rea.md` | **用 REA 取证、或想知道「本机 REA 还能用什么」时必读**——原生面不可用的确切原因、语义图预算实测、partial evidence 只在同会话内有效 |
| `.devin/rules/rule-authoring.md` | 新增/拆分规则卷、调整 trigger 或撞到 16,384 字节上限时必读 |
| `.devin/rules/platform-and-network.md` | 处理非 macOS 分支、macOS 硬编码路径，或对接 GitHub 与代理时必读 |

## 仓库与 remote
- `origin` = 本仓库的 fork（`git@github.com:TendernessCJS/devin-fusion-byok.git`），是日常推送目标。
- `upstream` = 上游原项目（`https://github.com/kuobibulaien/devin-fusion-byok.git`），只读，**不要向 upstream 推送**。
- 本地 `main` 跟踪 `origin/main`。新克隆或首次拉取后需先执行 `git fetch origin`，否则 `git status` 会显示 `[origin/main: gone]`。
- 两个 remote 走**不同的网络通道**（`origin` 是 SSH、`upstream` 是 HTTPS），代理要求不同——见下节。
- **裸 `gh` 在本仓库指向 `upstream`，不是 `origin`**：多 remote 时 `gh` 按**名字**优先选 `upstream`（实测：`origin`+`upstream` → 上游；
  只留 `origin` 或把上游仓改名 → `origin`）。所以 `gh release view/list/create` 一律显式带 `--repo TendernessCJS/devin-fusion-byok`，
  否则读到上游 Release、把「本 fork 最新版本」判错。细节见 `.devin/rules/upstream-fork-release.md`。
- 同步上游更新见「fork 同步与发布」一节。
## 本机网络路径

GitHub 直连不可用，**必须经代理；代理不可用即停止并报告，不回退直连**。`origin`(SSH) 与 `upstream`(HTTPS) 的通道差异、`gh` 为何只能靠环境变量、URL 限定 git 代理的具体做法见 `.devin/rules/platform-and-network.md`。

## 常用命令

```bash
npm test                                      # node --test test/*.test.cjs
npm run package                               # 生成 .vsix（依赖 /usr/bin/zip）
npm run mcp:fast-context -- --root /abs/proj  # 单独运行 Fast Context MCP
node scripts/rule-split-check.cjs b4a9da7 .devin/rules/runtime-and-injection.md .devin/rules/architecture-boundaries.md --allow=激活失效判据  # 拆卷后守恒核对
FUSION_FAST_CONTEXT_LIVE=1 node scripts/fast-context-smoke.cjs   # 真实接口验收，消耗官方额度
```

改动后至少跑 `npm test`。测试用 `node:test`，无需安装依赖，也没有 lint/typecheck 步骤。
## 测试基线

全量测试应全绿（0 失败）。

历史说明：`test/native-models-sync.test.cjs` 曾稳定失败——同一端口重启 backend 后，对该 origin 的首次请求复用了 undici 连接池中已被旧服务关闭的
  keep-alive socket（`ECONNRESET`），第二次请求自愈。这是**客户端连接复用缺口**，已由 `src/runtime/host/retry.cjs` 的 `withConnectionRetry`
  修复：`readNativeModels` 与 `readMonitor` 对连接层失败做一次重试。

纪律保留：**不要为了通过测试而修改断言**；`withConnectionRetry` 只重试连接层失败（按 `error.cause.code` / `error.code` 判定），
  `native_catalog_identity` / `monitor_identity` / `native_catalog_unavailable` 这类校验错误不得被重试绕过或伪装成成功。

## 平台支持

**只以 macOS 为目标平台**：验证、真机验收、发布检查都只针对 macOS，不要声称其他平台已验证可用。**非 macOS 必须显式失败，不得静默出错**，沿用 `restart_unsupported` 这类既有模式。已知硬编码路径与测试边界见 `.devin/rules/platform-and-network.md`。
