# AGENTS.md

Devin Fusion BYOK：一个 Devin/VSCode 扩展，通过运行时桥接把第三方模型（OpenAI Responses / Chat Completions / Anthropic
  Messages）注入 Devin 原生模型列表，并把 BYOK/原生模型的组合镜像进 Devin 官方的 Fusion 卡片。

## 为什么行为约束不在本文件里（2026-10-17 实测后改成分卷）

规则注入有**每文件 16,384 字节上限**，超出部分被**静默丢弃**——CLI 二进制里的原文是
  `[Rule content truncated to <N> bytes. Read the full file at <path> for additional content.]`；另有**每 prompt 预算**可把整条规则**省略**，原文
  `[Rule content omitted to stay within the per-prompt rule budget. ...]`（符号 `agent_ext::rules::event_handler::ContentRuleBudget::partition`）。这两项在文档里**没有任何配置项**。

本文件曾达 **62,731 字节**，实测**只有前 26%（16,384 字节）进入常驻上下文**；被丢弃的 74% 里包含**整节「架构边界」（33,573 字节）**——也就是说
  「漏读会安静地做错」的那批约束**从未被送达过**。而窗口是**零和预算**：在文件内新增内容必然挤掉现有内容，所以唯一的扩容方式是**移出成独立文件**。

因此改为**分卷 + 索引**：本文件只留索引、短节与最高危禁令速查；正文按主题拆到下列卷。拆分已核对**字节守恒（内容只搬不改）**，且每卷都
  **< 16,384 字节**才可能完整注入。**改 `src/**` 前先按索引找到对应卷再动手。**

## 最高危禁令速查（漏了会静默坏）

- **不动 Devin 本体**：不修改/不重签名 Devin.app、不安装证书、不改系统代理。
- **不放宽现有安全校验**：Origin 一律 403、控制令牌用 `timingSafeEqual`、webview 只用 `createElement`/`textContent`。
- **backend 代码禁用动态 require**——`sourceId()` 的哈希输入是加载期从字面量 require 图自动推导的，动态 specifier 会让推导直接抛错、backend 起不来。
- **不要让任何人「恢复」`message_nodes` 按 `message_id` 反查归属**（实测 31 秒全表扫描）；归属只查 `tool_call_state`。
- **不要恢复任何 picker 刷新命令**（`lightCommands` 必须保持 `[]`；曾导致每 5–35 秒重载整个窗口）。
- **CLI 缓存绝不改名、绝不写 `.stale`**（v6 实测会自愈、v1–v5 不会，自愈时机不可依赖；改名仍可能把 picker 打空）；`model_configs*` 可写性按文件内容判定，不按代际白名单——合法信封的未来代际照常重写。
- **日志禁止**写入 `apiKey`、控制令牌、`authorization` 头、对话正文。
- **永不向 `upstream` 推送**；`origin` 才是推送目标。

## 主题卷索引（按需加载）

下面两类卷都**不常驻**：`devin rules list` 里无论 `trigger: glob` 还是 `trigger: model_decision`，规则都只登记为
  **`agent-decidable`**（按模型判断注入，**不保证加载**）。所以「漏读会安静地做错」的知识不能靠「放在哪个文件」保证送达，
  索引必须给出**何时必读**——这也是上面「为什么不把约束留在本文件里」的同一组实测约束逼出来的结论。

**体积纪律**：每卷必须 < 16,384 字节，超限部分静默丢弃。`test/rule-budget.test.cjs`（`npm test` 的一部分）会硬拦超限卷与「新卷没进本索引」，所以别在这里维护体积快照——它必然过期，判据以测试为准。接近上限时**先拆卷再加内容**：把「实测依据/排障判据」移成 `<主题>-forensics.md`，契约卷留一条指向与禁令（`runtime-and-injection.md` ↔ `runtime-forensics.md` 是范例）。拆卷是**逐字搬运 + 不加新论断**，只补指针句。拆卷后**必须**跑 `node scripts/rule-split-check.cjs <拆卷前commit> <旧卷> [新卷…]`——退出码非 0 即有 bullet 丢失，不得提交；刻意重写的 bullet 用 `--allow=<归一化 key 子串>` 豁免并在提交信息里说明。事故依据：2026-10-27 拆 `runtime-and-injection.md` 漏做此核对，丢了 4 条约束（安全校验禁令、`assignment_jwt` 契约、backend 转发目标、`injection-health` 宿主约束），`npm test` 与 rule-budget 全绿却无人报警。

**行为锚定卷**（改代码前按需读）

| 卷 | 何时必须读 |
| --- | --- |
| `.devin/rules/runtime-and-injection.md` | 改 ACP/LS 注入、backend 生命周期与关闭、日志、用户设置写入、重试预算或安全校验（模块归属、`protocol/` 与 `activation/` 职责、`SOURCE_FILES` 见下一条 `architecture-boundaries.md`） |
| `.devin/rules/architecture-boundaries.md` | 改模块归属、`src/runtime` 分区、`protocol/` 职责、根门面或 `architecture.test.cjs` 守卫时必读——模块拓扑与依赖守卫的实测描述 |
| `.devin/rules/runtime-forensics.md` | **排查「注入/目录改写改了没生效」时必读**——api server 凭据优先级、`agentEnv` 只覆盖主 agent、日志归属（宿主 channel vs `runtime.log`）、连接按 pid 判、桥的 gzip 体积 |
| `.devin/rules/upstream-routing.md` | **排查「转发打到了哪里」或推送没生效时必读**——upstream origin 契约与校验、原生派生链与收敛窗口、激活期推送失败的 identity 分级、`upstream-push` / `upstream-origin` / `upstream-push.json` 三个观测落点 |
| `.devin/rules/fusion-matrix.md` | 改 Fusion 矩阵 emit 规则、Lead/Sidekick 资格与命名、harness、Fast Mode |
| `.devin/rules/catalog-and-picker.md` | 改 picker 可见性契约、角色白名单、陈旧条目判定与清理、推送门控、`nativeFamilies`、维度 order |
| `.devin/rules/context-and-compaction.md` | 改声明的上下文窗口（ModelInfo `f4`/`maxTokens`）、或怀疑「是不是扩展触发了压缩」 |
| `.devin/rules/native-observation-and-cli-cache.md` | 改原生目录观测与缓存、CLI 缓存原地重写、配置键分类清理 |
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
| `.devin/rules/retired-and-deadends.md` | 清理配置键、审「这段代码还活着吗」、疑惑旧字段为何还在 |
| `.devin/rules/acp-protocol-fields.md` | 改 `src/protocol/*` 的 protobuf 字段号、核对原生请求/响应/用量字段 |
| `.devin/rules/acp-protocol-fields-forensics.md` | 改字段号、怀疑读数过期，或排查 CompletionDelta 错位陷阱时必读（实测方法与证据） |

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

本机直连 GitHub 不可用，必须经代理；代理不可用时停止并报告，不要回退直连。**代理机制与本机配置的权威说明在用户级规则 `~/.devin/global_rules.md` 的「外部网站代理」**（代理地址、
  `~/.ssh/config` 的 `ProxyCommand`、git 的 URL 限定配置、`gh` 为何只能靠环境变量），本节只记本仓库要用的结论：

| 目标 | 协议 | 命令里要不要加 `HTTPS_PROXY` |
| --- | --- | --- |
| `origin`（`git push` / `git fetch`） | SSH | **不要**：`~/.ssh/config` 的 `ProxyCommand` 自动代理 |
| `upstream`（`git fetch`） | HTTPS | **不要**：本机已配 URL 限定代理，裸命令即可；未配置的机器要加 |
| `gh`（建 Release 等） | HTTPS | **要**：`gh` 没有 proxy 配置项，也不读 git 配置 |

代理只管「怎么连」，「连到哪个仓库」是另一回事：本仓库裸 `gh` 解析到 `upstream`，见上一节。

用 `git remote -v` 确认 remote 属于哪种。HTTPS remote 漏了前缀是**长时间挂起**而非快速报错——卡住 10 秒以上先怀疑这个。

不要用无作用域的 `git config --global http.proxy`：它作用于**所有** HTTPS remote，会把 HTTPS 形态的内网仓库也送进代理（SSH 形态的内网 remote 不受任何
  `http.proxy` 影响）。改动用户级 git 配置须由用户自行执行。
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

**只以 macOS 为目标平台**（个人自用，本机即 macOS）：验证、真机验收、发布检查都只针对 macOS。其他平台按「逻辑可行」的最低标准处理，**短期不做实机验证**。
- **不要声称非 macOS 已验证可用**。涉及平台差异的行为，在代码与文档里注明「仅 macOS 验证」。
- **非 macOS 必须明确失败，不得静默出错**。既有先例（沿用这个模式）：`src/runtime/host/app-restart.cjs` 在非 darwin 抛 `restart_unsupported`，
  面板提示「当前环境不支持重启 Devin」；`src/update/updater.cjs` 的 `supported` 判断使非 macOS 只能手动装 vsix。注意 `package.json` **未设 `os` 字段**，
  其他平台能装上、只是相应功能不可用。
- **已知 macOS 硬编码**（非 macOS 上会失败或降级，暂无适配计划）：`/usr/bin/sqlite3`（用量归属，`src/monitor/store.cjs`；失败降级为 `unavailable`）、
  `/usr/bin/unzip`（一键安装，`update/updater.cjs`）、`/usr/bin/open` 与 `/usr/bin/grep`（重启 Devin，`app-restart.cjs`）、
  `/usr/bin/zip`（打包，`scripts/package.cjs`）。Fast Context 的 ripgrep 查找是唯一带回退的：`FUSION_FAST_CONTEXT_RG` → `PATH`
  → `/Applications/Devin.app/...`，都找不到才抛 `ripgrep_unavailable`。
- **测试只覆盖逻辑分支**：平台差异靠注入参数验证（如 `platform` 形参、`resolveNode(env, platform)`），不依赖真机。
- 结论：**不要为未验证的平台做重构**；能低成本避免耦合就避免，已硬编码的保持现状。
