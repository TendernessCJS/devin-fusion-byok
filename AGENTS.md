# AGENTS.md

Devin Fusion BYOK：一个 Devin/VSCode 扩展，通过运行时桥接把第三方模型（OpenAI Responses / Chat Completions / Anthropic
  Messages）注入 Devin 原生模型列表，并把 BYOK/原生模型的组合镜像进 Devin 官方的 Fusion 卡片。

## 主题卷索引（按需加载）

下面四卷是**流程与历史**内容，不常驻上下文。触到对应场景时**先读该卷**，再动手：

| 主题卷 | 何时必须读 |
| --- | --- |
| `.devin/rules/upstream-fork-release.md` | 同步 `upstream`、定/升版本号、发布、解 merge 冲突（含「本 fork 相对 upstream 的刻意差异」表） |
| `.devin/rules/retired-and-deadends.md` | 清理配置键、审「这段代码还活着吗」、疑惑某个旧字段为何还在 |
| `.devin/rules/testing-notes.md` | 写或调测试 |
| `.devin/rules/acp-protocol-fields.md` | 改 `src/protocol/*` 的 protobuf 字段号、核对原生请求/响应/用量字段、怀疑某字段没被送出或读回 |

**行为锚定的硬约束不在这四卷里**——全部留在本文件（always-on）。依据是实测：`devin rules list` 显示无论 `trigger: glob` 还是
  `trigger: model_decision`，规则都只登记为 **`agent-decidable`**（按模型判断注入），**不保证加载**；而本项目里漏读的代价常常是静默的（改了
  `SOURCE_FILES` 不生效、陈旧判定误删条目、缓存写坏都不报错）。所以「漏读会安静地做错」的知识一律常驻。

## 仓库与 remote

- `origin` = 本仓库的 fork（`git@github.com:TendernessCJS/devin-fusion-byok.git`），是日常推送目标。
- `upstream` = 上游原项目（`https://github.com/kuobibulaien/devin-fusion-byok.git`），只读，**不要向 upstream 推送**。
- 本地 `main` 跟踪 `origin/main`。新克隆或首次拉取后需先执行 `git fetch origin`，否则 `git status` 会显示 `[origin/main: gone]`。
- 两个 remote 走**不同的网络通道**（`origin` 是 SSH、`upstream` 是 HTTPS），代理要求不同——见下节。
- 同步上游更新见「fork 同步与发布」一节。

## 本机网络路径

本机直连 GitHub 不可用，必须经代理；代理不可用时停止并报告，不要回退直连。**代理机制与本机配置的权威说明在用户级规则 `~/.devin/global_rules.md` 的「外部网站代理」**（代理地址、
  `~/.ssh/config` 的 `ProxyCommand`、git 的 URL 限定配置、`gh` 为何只能靠环境变量），本节只记本仓库要用的结论：

| 目标 | 协议 | 命令里要不要加 `HTTPS_PROXY` |
| --- | --- | --- |
| `origin`（`git push` / `git fetch`） | SSH | **不要**：`~/.ssh/config` 的 `ProxyCommand` 自动代理 |
| `upstream`（`git fetch`） | HTTPS | **不要**：本机已配 URL 限定代理，裸命令即可；未配置的机器要加 |
| `gh`（建 Release 等） | HTTPS | **要**：`gh` 没有 proxy 配置项，也不读 git 配置 |

用 `git remote -v` 确认 remote 属于哪种。HTTPS remote 漏了前缀是**长时间挂起**而非快速报错——卡住 10 秒以上先怀疑这个。

不要用无作用域的 `git config --global http.proxy`：它作用于**所有** HTTPS remote，会把 HTTPS 形态的内网仓库也送进代理（SSH 形态的内网 remote 不受任何
  `http.proxy` 影响）。改动用户级 git 配置须由用户自行执行。

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

历史说明：`test/native-models-sync.test.cjs` 曾稳定失败——同一端口重启 backend 后，对该 origin 的首次请求复用了 undici 连接池中已被旧服务关闭的
  keep-alive socket（`ECONNRESET`），第二次请求自愈。这是**客户端连接复用缺口**，已由 `src/runtime/retry.cjs` 的 `withConnectionRetry`
  修复：`readNativeModels` 与 `readMonitor` 对连接层失败做一次重试。

纪律保留：**不要为了通过测试而修改断言**；`withConnectionRetry` 只重试连接层失败（按 `error.cause.code` / `error.code` 判定），
  `native_catalog_identity` / `monitor_identity` / `native_catalog_unavailable` 这类校验错误不得被重试绕过或伪装成成功。

## 代码约定

- 全部为 CommonJS（`.cjs`），`package.json` 无 `dependencies`。**不要引入运行时依赖**，也不要改成 ESM。
- 日志只允许记录模型名、工具名、状态码、计数。**禁止**把 `apiKey`、控制令牌、`authorization` 头、对话正文写入 output channel 或 `runtime.log`；新增日志前确认
  payload 不含凭证。
- 用户可见文案（面板、错误消息、README、命令标题）用中文；代码注释用英文。
- 面向供应商的发现与推理请求必须带 `redirect: 'error'`，避免密钥和对话被重定向到其他地址。
- 写用户设置（`devin.acp.agentEnv` / `devin.acp.agentPreferences`）必须走 `src/lifecycle/owned-settings.cjs` 的 receipt
  流程，且 key 需在 `permitted()` 白名单内，保证可回滚。不要直接写 `settings.json`。
- 服务商错误自动继续的连续预算是 **5 次自动重试 / 10 分钟窗口**；触顶必须停止、结算等待中的请求并提示用户。待办无进展停止规则与 Goal 的预算独立，不能互相绕过。
- 监控 `record()` 仅同步更新内存，落盘走串行异步队列；测试依赖持久化时等待 `flush()` / `snapshot()` / `close()`。内存保留 5000 条，正常磁盘日志到 5250
  条时压缩；读取或写入异常时不得用部分内存覆盖原日志。backend 排水必须等待响应与处理器结束、刷完日志，再释放端口。
- 监控归属**只查 `tool_call_state`**，其联合主键 `(session_id, tool_call_id)` 在仅按工具 ID 筛选时是覆盖索引扫描，不是点查（实测 58ms）。
  `message_nodes` 那条补查路（按 `json_extract(chat_message,'$.message_id')` 反查会话）**已整体删除**：该谓词无索引可用，实测在真实库上耗时约
  **31 秒**（8.1GB 主库 + 2.6GB WAL、527632 行），任何合理界内都跑不完，所以那个 `messageLookup` 开关只可能永远关着——它连带 `response-id` 归属、
  `messageIds` 记录字段（占 `monitor.jsonl` 27.4% 字节）与 `request` 参数一起成了不可达代码。**不要让任何人「恢复」这条查询**：它买不到正确性（工具 ID 已够用），
  只会重新引入全表扫描。归属词汇现为 `tool-id`/`ambiguous`/`unassigned`，原因为
  `ambiguous-match`/`no-tool-ids`/`lookup-unavailable`/`tool-id-unmatched`。`sessions.id` 是**可读 slug**（实测
  `sprout-skull`），不是 UUID。落盘的记录**不带** `sessionId`/`attribution`/`attributionReason`/`messageIds`/`role`：归属每次快照由 `associate` 重算，占位值只是「没人验证过的声明」（实测每行都是 `"attribution":"unassigned","role":"unknown"`，而 `role` 全仓零消费），排障时不要据此判断归属，要看快照或面板。不得用表级 `created_at`、`sessions.model`、全文/任意 metadata 中的 UUID 或未经核实的 `row_id` 只追加假设推测归属；消息角色不等于 Lead/Sidekick。用量主账保留在插件日志，异常计数必须排除并明确披露。
- 用量时间筛选默认当月，以本机日历边界和请求 `startedAt` 为准，内部区间左闭右开；自定义结束日转到下一日零点，不用 `new Date("YYYY-MM-DD")` 的 UTC 解析或固定 24
  小时推进日期。前后端复用 `monitor-stats.cjs` 的统计公式，明细/汇总/诊断使用同一记录集；无效区间不得回退全量。最近 5000 条保留记录不保证完整月账单，界面必须明确披露。
- 面板控件的垂直高度统一由 CSS 令牌 `--control-h`（28px）驱动，`button`/`input`/`select` 都引用它，不要再写死各自的高度；同一行必须放下的「input + 按钮」容器用
  `.actions.nowrap`，以免 flex 折行把按钮挤到第二行（折行判定用 hypothetical size，与容器 max-content 宽度不一致是根因）。
- 三个 webview（`src/panel/view.cjs` 主面板、`goal-view.cjs`、`context-view.cjs`）共用 `src/panel/theme.cjs` 的
  `baseStyles()`：控件（`button` 及 `.secondary/.quiet/.danger`、`input/select/textarea`、`input.switch`）、字号层级、
  页面边距（`--page-x`/`--page-top`/`--page-bottom`）、`ul/ol` reset、`.code-block`、指标原语
  `.tiles`/`.tile`/`.tile-value`/`.tile-label` 都只在 base 里定义一次；**不要再往单个 webview 里加这些基础样式**，要改就改 `theme.cjs`。
  指标仪表盘统一用 `.tiles`，不要再用「gap + 容器背景色」自绘细线网格——格子数不是列数整数倍时末行会露出容器背景色块（实测上下文面板 5 列下 6 格/11 格各露出 4 个空槽）。
- 引用顺序：base 必须**先**、视图专有 CSS **后**，视图才能覆盖 base（例如 `.update-notes { font: inherit }` 覆盖 base 的 `pre` 等宽字体）。
  代码块用 `.code-block`，不要靠叠 `.update-notes`/`.mono` 去凑样式。
- webview 的 busy 锁定：控件「原 disabled 值」必须存在 JS 侧容器（Map/数组）里、每个节点只在首次锁定时记录一次，`render()` 里只重新施加锁定、**禁止**把原值存到
  DOM（`dataset`）并在 render 里重新记录——宿主对每次操作先发 `{type:'state'}` 再发 `{type:'result'}`，busy 期间必有 render，存 DOM
  的原值会被覆盖成 `true`，静态控件（顶栏重载/重启、刷新缓存等不随 render 重建的节点）就此永久禁用。正确写法参照 `openDialog` 里
  `const locked = [...].map(node => [node, node.disabled])`。
- **面板 state 必须「去重稳定」，且 render 必须保住焦点与滚动**。`controller.cjs` 的 `postState` 用 `JSON.stringify(state)` 与上一次比较去重，
  所以**任何每次都会变的字段写进 state 就等于关掉去重**：`checkCliCaches` 曾在每次自动检查时重盖 `{ at: new Date().toISOString() }`，而
  `refreshNativeModels` **每 3 秒**跑一次（`setInterval`，并顺带 `management.publish()`），于是面板每 3 秒收到一条「新」state →
  webview `render()` 全量重建所有容器（`replaceChildren`）→ 搜索框被销毁（**焦点丢失**）、`.scroll` 列表 `scrollTop` 被夹回 0（**滚动复位**）。
  规则：①**时间戳只在结果真正变化（或 `force`）时才写**，判据是除 `at` 外的字段摘要，未变则**复用同一对象**（引用相等，state JSON 才不变）；②`render()` 必须快照并恢复
  `document.activeElement` 命中的注册节点 + `selectionStart/End` + 各滚动容器 `scrollTop` +
  `document.scrollingElement.scrollTop`，注册表放 **JS 侧 Map**（重建后 `getElementById` 会拿到旧节点，不能用它回找），恢复放在
  `lockControls()` **之后**，并在 `document.hasFocus() === false` 时**直接放弃**（`retainContextWhenHidden` 下面板可存活于隐藏状态，
  抢焦点比丢焦点更糟）；③替换子节点（尤其 tbody）会让父滚动容器的 `scrollTop` 被夹到 0，**必须**快照-恢复，不能指望浏览器保留（`monitor-table-wrap` 即此类）。
- 原生模型目录靠观测，重启后内存里为空；观测结果经 `<storage root>/native-cache.json` 跨进程缓存（格式 `{version, savedAt, models}`，TTL 7 天，
  原子写：临时文件 + rename，`0o600`）。它是**观测缓存**、不是用户配置，只含 uid/label/能力标志，绝不落凭证；追加并集语义（与内存一致，不因单批缺席而删条目）。此时角色里的
  `nativeUid` 解析不到，**不得**断言「已从模型目录移除」——要按 `nativeCatalogStatus` 区分「尚未同步」（`pending`，muted 文案，
  判定依据为**内存与缓存都没有可用观测**）与「目录就绪但模型确实不在」（真警告）。BYOK 供应商引用写在配置里，解析不到就是真的不可用，不算 pending。
- 原生目录由空变有（或目录签名变化）→ 触发 `pickerRefresh.changed()`；**当前线上不接任何刷新命令**（`lightCommands: []`，且
  `createPickerRefresh` 的**默认值本身就是 `[]`**——历史上默认值曾是 `['devin.reloadAcpConnections']`、只有生产显式传空才安全，
  任何一处漏传就会重新引入风暴，因此默认值必须是安全的那一侧）：`devin.reloadAcpConnections` 实测会断开全部 ACP 连接（用户可见「ACP connection closed」+
  会话区刷新），且每次执行后 5–35 秒内整个窗口被重载（2026-10-14 真机，reload 循环达每小时十余次）。数据正确性完全由 cli-cache 原地刷新兜底，新会话读到的是新 payload；
  **不得回退到 `devin.newConversation` 之类开会话的命令**，重新接命令前必须先在真机确认其不会断开 ACP。另：扩展宿主对该窗口反复重启的另一嫌疑是 `saveReceipt`
  往**安装目录**写 `.fusion-byok-storage.json`（POINTERS）——目录被监视则每次 activate 都触发重启，现已改为 roots 不变则不写；不得往
  `context.extensionPath` 里新增任何周期性/激活期写文件。
- 新增 backend 运行时模块**必须**同时加入 `backend.cjs` 的 `SOURCE_FILES`（它参与 `sourceId()` 哈希，漏加会导致同版本重装不重启 backend，
  新代码永远不生效）。
- `augmentLocalModelChoices` 的门控是「Fusion 需要其原生 uid 出现在字段 7 允许列表里、普通 BYOK 不需要」——盲窗（原生观测为空）下 Fusion 整组被丢而普通
  BYOK 全留，现象会被误读成「非 Fusion 模型缺失」，排障时先看这里而不是重查目录生成。
- CLI 的模型选择器是「`~/.cache/devin/cli/` 的按身份持久缓存（`user_status`/`model_configs_v5`/`team_settings` 的
  `.<digest>.bin` JSON 信封，payload 为 base64 proto）∩ 白名单」；配置改动会改普通模型 uid（digest 含
  `provider.id`/`model.id`/`effort`），缓存陈旧期普通条目整批丢失，而镜像的 `fusion-<lead>-sidekick-<side>` 条目只要两侧 uid 未变就仍能命中。
  `src/runtime/cli-cache.cjs` 按「payload 含 `dfbyok` 判定我方身份、含 dfbyok 但缺当前 uid 判定陈旧」**原地重写 payload**：改写前先按
  `CACHE_RPC` 映射缓存名→RPC 路径、经 `augmentCatalog` 重算，且新 payload 必须「不丢任何已出现的期望 uid 且字节有变化」才落盘（否则 `no-improvement`
  跳过——允许净缩，清陈旧也是改进）；落盘前把原始字节写到 `<file>.bak`（原子写、`0o600`；**每次重写都覆盖，只保留最近一次**，不是首次重写前的原件），envelope 的
  `version`/`identity_digest`/`fetched_at_secs` 原样保留。**绝不改名、绝不写 `.stale`**——该 CLI 版本不会因文件缺失而补拉
  `model_configs_v5`，改名会把 picker 打空且不自愈（实测两小时零 `GetCliModelConfigs`）；不碰无 dfbyok 标记的其他身份文件；仅在重写到
  `model_configs` 时才经 `pickerRefresh.force()` 让 picker 重取（`team_settings`/`user_status` 由 CLI 自身节奏重拉、无需断 ACP
  即生效），且 `force()` 与 `changed()` 共用 `cliCacheMs` 间隔——刷新风暴不得变成 ACP 断开风暴（实测曾 30 秒内连断 3 次）。Composer
  模型缺失排障时先看缓存新鲜度，backend 注入日志（`afterOwn`）证明不了 picker 侧可见性。面板「设置 → CLI 缓存 → 刷新缓存」走同一个
  `checkCliCaches({ force: true })`（`refreshCliCaches` 消息），只做原地重写、不引入新的刷新通道；`cliCacheStatus()` 把最近一次报告交给面板渲染，
  不要在那里触发写入。**自动检查只看 uid 存在性**（`missing`/`staleProbe`），所以「uid 齐全但条目形态过时」它一律跳过——这正是 `force` 存在的理由：强制模式绕过门控、
  直接比较 augment 后的字节，只有真差异才落盘（因此连按不churn，实测二次调用即 `no-improvement`）。**重写是「比对后替换」而非盲目覆盖**（2026-10-16）：CLI
  自己也写这些文件（它经 bridge 拿增强目录再落盘），所以落盘前会重读一次、要求字节与所增强的那份**完全一致**，不一致就跳过（`concurrent-write`，等下一轮自动检查重读）——否则会用「旧
  payload 的增强结果」覆盖 CLI 刚写入的更新版本，静默丢掉它存的内容；窗口是「重读→rename」之间的几微秒。`.bak` 写的是**所增强的那份原始字节**（不是再次新读的、可能已属新世代的版本）。修
  emit 形态后**必须**走一次强制刷新或让配置变动触发自动重写，否则旧形态条目会一直留在缓存里（2026-10-14：信息性维度加 `order` 的修复就是这样落地的）。
  **`GetUserStatus` 有两种载荷形状，按 f1 的 wire type 判别**：响应是 `GetUserStatusResponse` 信封（f1 = `user_status` message，
  模型列表在其 f33），而 CLI 落盘的缓存是**裸 `UserStatus`**（f1 = `pro` bool，模型列表直接在 payload 的 f33，实测顶层 f33 = 526 条条目 + 3
  个排序区）。2026-10-16：原地修复路径只认信封形状，裸形状下 `rewriteMessage(data, 1, …)` 抛 `Ambiguous` 被 `catch` 吞掉 → 每次重写都逐字节相同 →
  记成 `no-improvement` 并**上报成功**（实测 `user_status` 期望 uid 236/456、8 个已退役 fusion uid 滞留，且只认信封的 `staleFusionUids`
  对同一份 payload 报 0）。修复后对同一份真实缓存的强制刷新：236/456 → 456/456、陈旧 fusion uid 8 → 0，且二次/三次强刷仍为 `no-improvement`（不
  churn）。`staleFusionUids` 现在扫描 payload 本身 + 它携带的每个 f1 message（覆盖 flat / 信封 / 裸三种形状）。`augmentCatalog` 接受
  `onSkip(code)`（`shape-unrecognized`/`transform-failed`），**三个 RPC 都接**（`GetCliTeamSettings` 的允许列表改写同样上报，
  此前它是唯一剩下的静默路径）；`refreshStaleCliCaches` 把「上报了 skip 且期望 uid 仍缺」记为失败码而非
  `no-improvement`——**静默返回输入等于关掉这条链路的所有自检**，面板据此显示「未改动（原因）」而不是「无需重写」。bridge 侧不要把跳过码按进程去重（扩展宿主长期存活，
  形状在会话中途变化只会打一次），而是把它作为 `skipped` 字段**搭在每次响应都打的 `catalog` 行**上。回归防线是 `test/cli-cache.test.cjs` 的端到端用例（真实裸形状
  payload → 真实 `augmentCatalog` → 真实重写链路）：**它在本修复之前必然失败**，而此前分层的单测都放过——catalog 侧用信封形状构造 payload，cache 侧用合成
  augmenter，缺口正好在接缝上。
- 加载 `src/extension.cjs` 的测试 fixture 必须 stub `./runtime/cli-cache.cjs`（或把 `dir` 指向临时目录），
  **绝不可触及真实 `~/.cache/devin/cli`**——历史上未 stub 的 fixture 曾把用户真实缓存改名搬走、清空 picker；
  `inspectCliCaches`/`refreshStaleCliCaches` 的 `dir` 参数必填（非空字符串，否则抛 `TypeError`）就是为了堵这个口子。
- **配置键分三类，清理时按类处理**：①**面板可管**（`providers`、`roleInclusions`/`roleExclusions`、`hiddenNativeModelUids`、
  `updateProxy`、自动继续开关、`enabled`）；②**程序自管**（`inferenceServerUrl` 指向本地 backend、`lastFusionSelection`
  在选组合时记录——不要手工写，也不要期望面板能改）；③**死键**（当前代码零读取，如退役管线的 `sidekicks`）。新增/删除配置键时先想清属于哪类：**死键必须有清理路径**，
  否则用户配置会永久带着它而面板又删不掉（「已关闭的排除条目」在角色列表里渲染为无开关死行，面板提供「移除」按钮走 `forgetRoleRef`：BYOK ref 是配置权威、直接可删；native ref 必须
  `nativeCatalogStatus === 'ready'` 才放行，防止盲窗期把「还没同步」误删成「真死了」）。配置清理一律走 `src/config.cjs` 的
  `pruneRetiredKeys`（激活期一次性、幂等、键不存在即返回 `false` 不写盘），它现在是**所有退役键的唯一清理路径**：`sidekicks`、`fusionPresets`、
  `defaultFusionUid`、`fusionMatrix` 全在其中（2026-10-16：预设退役迁移已删除，那三个键不再有任何读取方，留着只会让用户配置永久带着删不掉的字段）。

## 架构边界

- 本扩展不修改 Devin 应用本体、不重新签名、不安装证书、不改系统代理。保持这个前提。
- 强依赖 Devin 私有接口：LS `Heartbeat` 抓端口（`src/runtime/ls-injection.cjs`）、catalog 的 protobuf 字段号与 Connect
  帧（`src/protocol/wire.cjs`、`src/catalog.cjs`）、ACP 连接器面（`windsurfAcp.registerConnection` /
  `connector.sendRequest` / `connector.forwardClientRequest`，被 `acp-observer.cjs`、`auto-continue.cjs`、
  `goal/continue.cjs` 观察与包装）、CLI 的 `WINDSURF_API_SERVER_URL` env 覆盖（经 `devin.acp.agentEnv` 受管设置注入，ACP
  通道的实际入口）、Fast Context 的 `GetDevstralStream`（`src/fast-context/protocol.cjs`）。这些接口不稳定，改动附近代码时按「可能失败」处理，
  不要在失败路径上伪装成功。
- `AssignModel` 本地应答不含 `assignment_jwt`（官方 `ModelAssignment` 响应带该字段）。当前 CLI（3000.10.48 实测）不校验；若未来版本强制校验，
  本地指派整体失效——届时改为转发上游或显式降级，不得伪造成功。
- 修改行为时不要放宽现有安全校验（Origin 一律 403、控制令牌 `timingSafeEqual`、webview 只用 `createElement`/`textContent` 不用
  `innerHTML`、CSP nonce）。
- **矩阵恒开，没有开关**：`buildCatalog` 总是发射交叉积，`kind` 一律是 `'matrix'`，且**不得进入面板分组**（面板分组只收 `kind === 'model'` 的普通条目；旧
  `fusionMatrix` 开关与其 OFF 分支已随具名预设一起删除——那条分支只会 emit 预设，留着就是个永不产出的死配置）。官方 Fusion 卡片的维度候选来自「同 family 条目的自声明维度」，
  所以每个 Lead 值下必须有多条不同 Sidekick/Effort 条目（全交叉积），否则下拉被锁死；`fusion-<lead>-fast-sidekick-<side>` 形式的 `-fast` uid
  显式拒绝（BYOK 无 fast 能力，不得伪装降级）。条目一律 `familyUid: 'fusion'` + `isModelRouter` + `displayOption 3`，harness 用
  `inferenceServerUrl`（不是硬编码官方地址，否则本地推理地址覆盖失效）。
  **`Fast Mode` 与 `Recommended Sidekick` 两个信息性维度必须照官方线形态发射**：前者只带 `controlType: 2`、后者只带 `name`，都不写
  `order`（`encodeFamily` 因此只在声明了字段时才写，不再用 `order || 0` 兜底）。picker（`nil`）按 `order` 去重维度值、
  并**丢弃值数 < 2 的维度**：我们若写 `order: 0`，就会与官方的「无 order」分成两个桶——`Fast Mode` 从官方的 2 个选项涨到 3 个，`Recommended Sidekick`
  从「不渲染」变成一个真实控件（2026-10-14 真机实测）。
- 矩阵只 emit「至少一方是新增成员」的组合：官方维度成员（lead 有 `leadDimension`、sidekick 有 `dimension`）之间的配对永远交给官方目录，
  即使官方没有覆盖该组合也不替它发明（避免产出官方不支持的组合）；BYOK 或非官方原生成员与官方成员配对时，官方成员条目复用官方维度 `name+order` 直接并入官方选项，不另造维度值。Lead
  一律按**系列**组织，族键统一取「uid 去掉结尾档位 token（`-(none|minimal|low|medium|high|xhigh|max|ultra)`，其后可再跟 `-fast` 或
  `-priority`；**容量限定符 `-1m` 保留在族基上**，故 `GLM-5.2` 与 `GLM-5.2 1M` 是两个族）」（`leadFamilyBase`），
  **不得依赖观测到 `Effort` 维度**——真机 222 个合格原生里 48 个完全无维度、94 个只有 `Fast Mode`，按「Effort 维度名 slug」推导会让 25 个家族被拆散。
  **fast 变体有两种后缀命名，必须都认**：Claude 系写 `-fast`（`claude-opus-5-high-fast`），
  **GPT 系写 `-priority`**（`gpt-6-1-sol-high-priority`，label 写作 `… Thinking Fast`，`Fast Mode=1`）；只认 `-fast` 会漏掉
  44 行独立的 `… Thinking Fast` 行（2026-10-15 真机实测，用户截图确认）。官方**组合条目**里 GPT 的 fast lead 段却写作
  `-fast`（`gpt-6-1-sol-high-fast`），而原生模型列表里只有 `-priority` 形态——**族归并一律以原生模型列表为准**。经过三轮归并：Lead 原生行 156 → 99 →
  55 → **51**、多成员家族 17 → 38、覆盖 222 个合格 uid；`matrixUids` 236 → **244**（官方族的 none 档并入后随族默认选中，多出 8 条）。原生侧 `none`
  的显示名是 `No Thinking`。面板里一族是一个开关，排除/选中都是整族粒度，`memberUids` 承载全部成员 uid。**同家族对永不发射**：官方网格里同名对为 0（Sonnet 5.5 Lead
  不提供 Sonnet 5.5 Medium Sidekick，GPT-5.6 Sol 不提供 GPT-5.6 Sol High），subagent 跑与 Lead 同族模型不是有效组合——BYOK 按
  provider/model `key` 判、原生按 `leadFamilyBase` 判，跨档位自配对（flash High × flash Max）同样过滤；每个 BYOK Lead 的 Sidekick
  下拉因此天然少了自己那一项，与官方空洞同形。**BYOK Sidekick 按变体级发射**：官方 Sidekick 值把档位烤进值名（`Claude Sonnet 5.5 Medium`），BYOK 家族的每个
  effort 变体各成一个 Sidekick 值（`DeepSeek · deepseek-flash High`），不得再退回「每族一个代表」（那会让 subagent 只能跑 provider 默认档、且
  `BYOK · N 档` 标注名不副实）。自定义 Sidekick 值的 order 按**族键**哈希取 base、族内按 effort 档位连续排布（picker 按 order 排下拉，
  逐名独立哈希会把同族变体打散）；仍保留哈希序的初衷——名字到 order 的映射不随选中集合漂移，陈旧缓存条目不会顶替别的值。
- **`Fast Mode` 是正交开关，不属于 Lead 身份**（真机 40 个 `(Lead 值, Effort 值)` 组合**全部**同时存在 `Fast Mode=0` 与 `=1`，两者
  Lead/Effort 值完全相同）。因此官方家族的 fast 兄弟必须**并入**官方族（`Claude Opus 5` 5 → 10 成员），不能单列成同名的第二行（旧实现产生了
  `Claude Opus 5`/`Claude Opus 5.5` 两组重复 label，用户无从分辨）。官方族因此按**档位系列**吸收成员：凡 uid 能提出档位 token 的同族基成员都并入（官方声明的
  uid、`-fast`/`-priority` 兄弟、以及官方从未声明的 `-none` 档，如 `gpt-6-sol-none` 与 `gpt-5-6-sol-none` →
  `GPT-6 Sol`/`GPT-5.6 Sol` 各 5 → **12** 成员），**提不出 token 的同族基成员才留在自己的单成员行**（真机当前无此情形）。并入成员**必须继承**该族的官方
  `leadDimension`；其 Effort 值由自己的 token 给出（`none` → `No Thinking`）。**Effort 的 order 一律取官方空间**（从
  `eligibleNativeLeads` 现场聚合 `name→order`，真机 Low1/Medium2/High3/XHigh4/Max5，**不要写死**），官方没有的名字才用
  `stableOrders(该名字, reserved = 官方 order 集合)` 取哈希序——**不得改用原生观测到的 order**：那是另一套空间（GLM 观测
  `High=1`/`Max=2`/`No Thinking=0` vs 官方 `High=3`/`Max=5`），同名不同序会被 picker 拆成两个值。已发射条目里同名多
  order（Lead/Effort/Sidekick 三个维度）必须**恒为 0**。族标签 `leadFamilyLabel` 剥掉结尾的档位/Fast/Thinking
  标记但**保留 ` N M` 限定符**（`GLM-5.2 High 1M` → `GLM-5.2 1M`），且全局唯一：撞名先退回成员自身 label，再撞才追加 uid。
- **Lead 资格不要求原生条目自带 harness，Sidekick 仍要求非空 harness**：Fusion 下 Lead 跑在组合条目声明的 harness
  上（`['fusion'] + Lead 自带 harness`，无 harness 的 Lead 退化为 `['fusion']`），Lead 原生条目自己的 `harnessUids` 只决定它能否单独可选，
  与能否当 Fusion Lead 无关。官方 586 条组合实测 **40 条以 `harnessUids=[]` 的 `gpt-6-astra-{low,medium,high,xhigh,max}` 为 Lead**（`isModelRouter=false`、`disabled=false`），用 harness 卡 lead 会把整族挡在 Lead 列表外、设置页误标「不能作为 Fusion」。同批扫描的反证：lead/sidekick 引用 router = 0/0、引用 disabled = 0/0、**sidekick 引用无 harness = 0**——所以只有 lead 侧去掉 harness 判据，其余门禁（router/disabled/hidden、sidekick 的 harness）原样。`discoverAdditionalNativeRoles` 据此按角色分判：lead 候选 = `eligible || 官方 Lead 声明 || (官方族基 && 档位 token)`——astra `-priority` 兄弟无 harness 也并入官方族（`leadHarnessUids` 记 `['fusion']`，发射侧照旧被 `fastLeadUids` 跳过）；sidekick 候选 = `eligible || 官方 Sidekick 声明`。无官方声明、无官方族基档位 token 的无 harness 条目（`MODEL_*`/`arena-*`/`*-review` 类）照旧双假被跳过，不进角色池。
- **fast 档 Lead 只聚合、绝不发射**（`buildCatalog` 展开 `selectedNativeLeadUids` 时跳过 `fastLeadUids` 成员；**只跳 lead 侧**，官方
  Sidekick 维度没有子档、fast sidekick 是它自己的合法取值，实测 sidekick 段 fast 发射为 0 条）。`fastLeadUids`
  必须**由观测的 `Fast Mode` 维度判定**（`fusionMetadata` 里 `Fast Mode != 0`），**不得按 uid 后缀判定**——同一概念上游在 Claude 上写
  `-fast`、在 GPT 上写 `-priority`，按后缀写死会漏掉后者（实测漏 44 条）；观测驱动同时天然覆盖未来新命名，且与官方族准入规则用的是同一份证据。
  原因是能力缺口而非取舍：我们的矩阵条目**不写 `Fast Mode` 的 `order`**（写了就会把 Fast Mode 从官方 2 个选项涨到 3 个），于是 fast lead 条目与同档非 fast
  双胞胎**维度元组逐字节相同**（发射 40 条即产生 40 组重复），picker 无从区分；不发射则重复组为 0。`staleFusionUids`（`leadUid.endsWith('-fast')`
  判陈旧）与 `resolveAssignment`（同判据拒绝回退）**只认 `-fast` 拼写**，与「不发射」一致；
  **若未来要重新发射 fast lead，必须同时补上 `Fast Mode` 的 order 才能让 picker 区分，并把这两处判据也改成观测驱动**，否则只是造重复条目或让新条目被自己的清理逻辑删掉。
  并入成员继承官方 `leadDimension` 因此**不再为发射服务**，而是让家族聚合在「官方成员因 record 冲突被剔除、只剩这些兄弟」时仍读作官方（`buildRoleLists`
  的家族循环仍读该字段）。附注一个易误判的边界：`swe-1-6-fast`（label `SWE-1.6 Fast`）带的是 **`Speed` 开关**（不是 `Fast Mode`），
  且服务器把它算作**另一个家族**（`swe-1.6-fast` vs `swe-1.6`），故各自成行；判断「是不是 fast 开关的变体」只能看 `Fast Mode` 维度，不要按 uid 后缀或 label
  猜。
- **一族一个 Lead 名**：非官方族成员发射时用**族标签**作 Lead 名（`record.leadBaseLabel = leadFamilyLabel(native.label)`；官方成员继续用
  `leadDimension.name`），于是选中一族时其全部发射条目共用同一个 Lead 值、各自带自己的 Effort。旧实现按「uid 以 Effort 名 slug 结尾」推导
  `leadBaseLabel`，对 `glm-5-2-1m`、`gpt-6-luna-medium` 这类 uid 直接失效 →
  同一族的成员发射出**多个不同 Lead 名且全部没有 Effort 维度**（2026-10-15 真机实测：选中 `GLM-5.2 1M` 三成员后出现
  `GLM-5.2 High 1M`/`Max 1M`/`No Thinking 1M` 三个 Lead 值、Effort 全空），面板「一族一行」与实际可选项对不上——这类 uid 结尾不是档位 slug
  的模型占多数，务必以族标签为准。`leadBaseUid` 已无消费者，随该推导一并删除。
- **角色族 ≠ 服务器家族，两者都不能替代对方**。服务器在条目 proto field 23（内层消息）的**内层 field 23**
  给了权威家族标识（`glm-5-2`/`-max`/`-none`/`-1m`/`-max-1m`/`-none-1m` 全部 = `glm-5.2`；
  `claude-opus-4-6`/`-thinking`/`-1m`/`-thinking-1m` 全部 =
  `claude-opus-4.6`）——这**正是我们编码端写出的同一字段**（`s(23, info.modelFamilyUid)`，BYOK 用 `dfbyok-family-*`、矩阵条目用
  `fusion`），长期只写不读。269 个原生条目 = 50 个家族 + 9 个无该字段者。**它只用于设置页聚合，绝不能拿去改角色分族**：服务器家族会把 1M/Thinking 这些 `Fast Mode`
  之外的开关变体合并进来，而官方 Fusion 卡片**不支持这些开关**（822 条官方组合条目里没有一条声明 `1M Context`，也没有一条引用 `-1m` 变体），角色侧必须继续按 uid 档位系列分族，
  否则一族内会出现维度元组完全相同的成员、picker 只能显示其一。两套划分实测 24310 个 uid 对里仅 21 处分歧，全部是 1M/Thinking。
- **控制维度一律照收，但只能被面板读**：`protoFusionMetadata`/`jsonFusionMetadata` 曾有
  `if (!CANONICAL_FAMILY_KEYS.has(key)) continue;`，把服务器真实的控制项整片丢弃（真机：`Reasoning Effort` 174 条、
  `Prompt Cache Retention` 121、`1M Context` 82、`Thinking` 70、`Speed` 2）。现在全部保留（`keys` 去重），且 name 校验收窄为「仅规范
  key 强制要求 name」——`Speed` 这类既无 name 也无 controlType 的 key 不得让整条 metadata 变成 null。
  **角色与发射逻辑只按具体 key 名取值**（`Lead`/`Effort`/`Sidekick`/`Fast Mode`），多出的 key
  必须**零影响**：改动此处的验收标准是「`buildRoleLists` 逐行、`buildCatalog().matrixUids` 逐条与改动前完全相同」（2026-10-15 实测 55/226/244
  全等）。另注意 `Reasoning Effort` 与 `Effort` **从不同时出现**（同一概念两种拼写），档位汇总要把两者都算进去。
- 设置页「官方模型显示」的状态键是 **`state.nativeFamilies`（已取代 `nativeModels`）**：按服务器家族分组，`fusion-*` 组合条目**一律剔除**（组合归 Fusion
  页管，用户明确要求；代价是面板不再有入口单独隐去某条官方组合，`augmentProtoList` 的 hiddenFusion 能力仅剩配置层），`dfbyok-` 同样剔除；无 familyUid
  的条目回退成单成员族；「已隐藏但已离开观测目录」的 uid 仍保留单成员族以便取消隐藏。渲染为**族行（无成员行、无展开态）**：一族一个开关发 `{ uids: 成员 uid 数组 }` 统一隐藏/开放——用户
  2026-10-15 明确表示只统一控制，故删除了成员级开关与 `nativeOpen`；`setNativeModelHidden` 在 `manager.cjs` 仍同时接受 `uids` 数组与单个
  `uid`（能力保留，面板 UI 不再使用单 uid 形态）。族标签取「无标记 uid」成员的 label 剥掉档位/开关尾词（单成员族不剥，故 `SWE-1.6 Fast` 保持原样；
  **uid 变体后缀词表含 `lightning`**——`swe-2-medium-lightning` 是 fast-mode 变体而非家族名，`Lightning` 不剥 label 是因为
  `SWE-1.7 Lightning` 本身是家族名），并全局去重。
- **picker 可见性契约（2026-10-15：先逆向实测、后由 App bundle 源码证实）**：picker 行 = `team_settings` proto
  **f7 `allowedModelUids` 白名单** ∩ `user_status` f33 **排序组 label 引用** ∩ 非内部 `kind`。内层 f22
  **就是 proto `DisplayOption` 枚举**（`windsurf-chat-client/index.js` 的 `nuk`/`nuM` + `niH`
  过滤器坐实）：`0/缺省 UNSPECIFIED → standard-picker`、`8 MODERN_AGENT_CHAT → standard-picker`（非 Devin Local 环境下被
  `nuj` 强制 disabled + 「Devin Local only」）；`3 MODEL_ROUTER` 仅 arena 关闭时混入（Adaptive/Fusion 条目所在面，`nuq` 的
  `isFeatured`=整组 MODEL_ROUTER 即官方推荐组）；`1 ARENA`/`4 QUICK_REVIEW` 走各自界面；`2/5/6/7` invisible。桌面端
  **f7 一次都不被读**——allowlist 是**纯 CLI 侧门控**（`model_configs_v5` 本就是 f7 过滤后的集合）。`GetCascadeModelConfigs`
  在当前流量里**从未出现**。面板 `internal` 判定链：`isModelRouter || kind≥1&&kind≠8`（Adaptive/Fusion 官方可见但按用户要求折叠）→
  `uid ∉ allowedUids`（**整集替换**而非并集，否则退役 uid 滞留）→ `pickerListed===false` → 旧启发式兜底（`listed`=顶层 f6、sources、
  harness/维度）。`pickerListed` 仅在 payload 带排序区时产生（`GetCliModelConfigs` 无排序区 → undefined）。白名单采集点是 bridge
  `forward` 里 `GetCliTeamSettings` 的**注入前**快照，经 backend 内存 → `native-cache.json`（信封含 `allowedUids`）→ 面板。
  渲染引擎要点（`nr3`/`nr8`/`nio`）：维度值**按 order 首见去重**（同 order 两名只留先枚举到的）、**「恰好 2 个无名值」即开关**（官方不看 controlType，Fast
  Mode 只写 order 就是开关）、disabled 家族成员自动落到最近可用兄弟、代表模型按 pinned>选中>isDefaultModelInFamily>首个取。
  **观测字段在全链路上都有白名单剥失的教训**：`observeNativeModels` 与 `readNativeModels` 的字段重建必须透出
  `kind/listed/sources/pickerListed`，否则新信号到不了判定层。
- **角色列表也要过白名单**：`buildRoleLists`/`buildCatalog` 可选第三参 `allowedUids`（非空=权威全集、null/空=未观测不限制），
  `discoverOfficialRoles` 的两侧 claim 与 `discoverAdditionalNativeRoles` 的候选池都对它求交——白名单外的 uid（如
  `gpt-5-3-codex-spark-medium`，仅 entitlement 来源）虽然 harness 齐全，但其组合在 `augmentLocalModelChoices` 注册 f7 时必被丢，
  列出来等于假可选。调用点：面板三处（`publicState`/`setRoleModel`/`selectFusion`）+ 宿主 `catalog()` + backend
  `getCatalog`/AssignModel；迁移路径 `migrateFusionConfig` 故意不传（不该因资格丢用户既有选择）。
- **Lead/Sidekick 门槛的机制依据（App bundle proto/schema 坐实）**：官方客户端**不做资格计算**——可选组合就是服务端枚举的 fusion 条目集，picker
  只做「维度元组→uid」查表（`nr6`，无匹配静默不切换）。AssignModel 双 router 字段：`model_router_uid`（f2）分配 sidekick、
  `fusion_lead_router_uid`（f6）分配 lead；**组合条目的 `harnessUids` 携带 `['fusion', lead真harness]`——lead 的执行通道由组合条目替它声明**，所以成员 lead 无自带 harness 也可当 lead（实测 29 个），而 sidekick 经独立 router 解析、组合条目不携带其 harness，故必须自带（实测 11/11）。**发射侧与 `resolveAssignment`（AssignModel 路径）必须同规则**：`leadNative ? leadHarnessUids : ['fusion']`（`leadHarnessUids` 在 catalog.cjs 里已含 `'fusion'`）。发射侧此前一律只写 `['fusion']`，与契约不一致，2026-10-16 修正（实测 336 条 native-Lead 组合各补上其 Lead harness、112 条 BYOK-Lead 保持 `['fusion']`；改前实测官方 586 个可解析样本中该规则 **390/390 零例外**）。**改这两处中任意一处，必须同时改另一处**，并跑那条逐条比对的回归断言。ModelInfo 官方 schema：`inferenceServerUrl/harnessUids/displayOption/modelFamilyUid/isModelRouter`——与我方 emit 字段名逐一对齐。**字段级实测（2026-10-16 解 CLI 缓存 `model_configs_v5.*.bin`）**：`f4 = 声明窗口`（官方原生值 262000/1000000/200000 与其真实窗口精确相等；我方 BYOK 发 1024000），它同时就是喂给「context-window-based」压缩默认值的那个数——见「上下文与压缩」一节；`f20 = harnessUids`（repeated，是**候选列表**），assignment 落的是**单个** `harness_uid`（`ModelAssignmentInfo`）；`f25 = isModelRouter`（官方原生不写＝默认 false，我方 fusion 条目写 1）；`f22 = displayOption`；`f23 = familyUid`。**`f5` 是一条「我方永不发、官方部分条目发」的字段**：实测 CLI 缓存 1205 条原生条目中 **234 条**带 f5，值**恒为 `LLAMA_WITH_SPECIAL`**（971 条不带；形态看是提示词模板/分词器类型，字段名未在 bundle 里确证）；我方 `encodeConfig`（catalog.cjs:88-99）**72 条**全部不发。**影响未验证**（可能 harness 已在服务端提供模板故留空无害，也可能客户端回落默认模板），**拿到影响证据前不要改**，也不要写成「官方一律发」。
- **harness = 执行通道，与模型是两条正交轴（2026-10-16 逆向）**。定义取自 CLI 隐藏开关原文：`--harness <UIDS>`「Comma-separated harness
  UIDs; **does not change the selected model**」（env `DEVIN_HARNESS`），另有 `--harness-lead-only`（「Apply
  `--harness` only to the lead, keeping the sidekick's registry harness」）与 `--harness-sidekick-only` 做方向限定。
  CLI 的 `ToolKey` 枚举含 `harness`/`OtherHarness`（工具来源分类），而 ModelInfo 里 `harness_uids` 又与
  `prompt_templater_type`/`tool_formatter_type` 同组 ⇒ **harness 是工具来源**（这条由 `ToolKey` 直接坐实）；
  「它同时决定工具调用的格式化方式」只是同组字段的**推断**，未验证。名字镜像 Cognition 服务端路由（二进制实测
  `accounts/cognition/routers/swe-1p6-cognition`、`swe-1p6-devin`）。harness 的**分组事实**（885
  条原生观测实测）：`strawberry-pancake` 覆盖 Claude 全家 + `glm-5-2`/`glm-5-3` + `kimi-k3` + 官方 `deepseek-v4-*` +
  `grok-4-5`；GPT 系为 `gpt-5p6-codex`+`gpt-5p6`；Gemini 系 `gemini-3-pro`；SWE 系 `swe-1p6`+`swe-1p5`（`swe-2-*` 多一个
  `swe-1p6-exec`，对应 CLI 的 `--sidekick-prefer-exec-tool` 工具面偏好）。**该分组的成因是推断**（「它服务 Anthropic Messages
  协议系」只是最像的解释，也可能是统一的 provider adapter），没有证据，不要当定论。**不要再从系统提示词或 App bundle 反推 harness**：桌面 App bundle 与 CLI
  二进制里 `strawberry-pancake` **零出现**（纯服务端标识符、内部代号无字面语义），压缩落盘摘要里的 `MESSAGE 0/1 - System`（真实系统提示）中 "harness" 计数为
  **0**。
- **隐藏语义是家族级**：`hiddenNativeModelUids` 仍存 uid，但 `expandHiddenByFamily`（catalog.cjs）在
  `augmentProtoList`/`augmentJsonList`/`buildRoleLists` 三处把隐藏 uid 连坐到同 `familyUid` 的全部兄弟——官方上新变体不会漏过黑名单；面板
  `family.hidden = 任一成员隐藏`，`mixed`/`部分隐藏` 状态已移除。
- **维度 order 的稳定性是可见性命门**：picker（chat client `nr3`）按 `(dim 名, order)` 去重维度值，同 order 不同名只留先枚举到的一个，其余静默消失。
  自定义维度值一律走 `stableOrders`（`0x10000000 + hash(name)`，同名恒同 order、跨代稳定），**禁止恢复「20+index」式顺序分配**——配置一变 order 全移，
  陈旧条目与新条目会在同一 order 上互撞（2026-10-14 实测
  `DeepSeek · deepseek-flash`/`Claude Haiku 5.5`/`Claude Haiku 5.5 Medium` 三名共占 order 20，BYOK lead 被隐藏）。
- **陈旧 emit 条目的判别指纹**：官方 fusion 条目恒带能力记录（proto field 32，含 `fusion-sidekick-*` 注册条目），我方 emit 永不写 field
  32——「`fusion-*` uid 且无 f32」即我方条目（含无 `dfbyok` 标记的 native×native 形态，`ownUid`/`matrixUids` 都抓不住它们）。
  **只有补 field 32 才会破坏该指纹；补 harness 不会**——判别只读条目自身的 f32，而 harness 在 inner message 的 f20（2026-10-16 给组合条目补 Lead
  harness 后实测陈旧判定零影响，`harnessUids` 与 `maxTokens` 都不参与）。若未来给我方条目补 field 32，必须同步更新该指纹；`team_settings` 白名单里的陈旧
  uid 是死指针、无对应条目，不清理。
- **清理条件必须保守：不在 emit 集合里 ≠ 陈旧**。`staleFusionUids` 的完整形态是 `{ emitted, known, excluded }`——只有「uid 拆不出
  lead/sidekick」「某一侧已不在 `known`（模型消失 / BYOK uid digest 随配置变了）」「某一侧被该角色显式排除」才判为可删。**禁止退回「不在 emitted 就删」**：我们的
  emit 集合会随原生 Sidekick 维度到达时序在 24↔155 之间波动，按缺席删除一次就静默删掉 131 条有效组合（2026-10-14 实测：`bak` 24 条 vs 现文件 155 条）。
  角色排除仍会退休条目，否则关掉的模型会继续把自己的维度值喂进 picker。
  **位置式调用（`staleFusionUids(data, emittedSetOrArray)`）已退役**：它编码的正是这条被禁止的语义，留着就等于把误删开关摆在代码里等人去按（当时它还存在只为兼容 5
  处旧测试断言）。新增调用一律传对象式，且 `known` 要给出**当前真正在服务的目录**，不要图省事传 `emitted`。
  **`known` 必填且非空，缺失/空 Set/空数组/字符串一律抛 `TypeError`**（`emitted`、`excluded` 仍可省略——`excluded` 默认 `{}` 本就是保守侧，
  `emitted` 缺失只是失去短路）：`emitted` 只是短路（命中即跳过），真正的判据只有 `!known.has(uid) || 被排除` 这一条，所以 `known`
  缺席就是**静默**回到被禁止的缺席语义——已发射的条目仍被短路保住，而所有「payload 里还在、本轮暂时未选中」的条目会全部被判可删（2026-10-15 真机复现：缺 `known` 误判 1 条，三参齐全
  0 条）。抛错在此是安全方向：`inspectCliCaches` 用 try/catch 包住探针，抛错被吞即空陈旧集合＝一条都不删。
- **推送的门控必须描述「真正发送的内容」**：宿主的 `pushKey()` 曾以 `localNativeModels`（bridge 观测）计数，而实际发送的是
  `nativeModels`（合并视图）——两者在激活初期不等价：首次 refresh 时 backend 可能还没就绪、返回空，于是**空载荷占用了 key**，紧接着那次有意义的 refresh
  被判「未变化」直接跳过，推送静默地从未发生（只在上一轮侥幸的时序下成功过）。现在 key = `local bridge 计数 : 上游载荷条数 : 上游载荷带维度条数`，且**空载荷不占 key**。
  改这里时务必让门控与实际 payload 同源，否则会退化成「看起来在推、其实没推」。
- **backend 的 ingest 必须拒绝我方 uid**（`/^(?:fusion-)?dfbyok-/`）：宿主的读取端把「被提供的 dfbyok uid」当作非法目录并直接抛
  `native_catalog_invalid`，一旦 backend 存了我方条目，**宿主的每一次 refresh 都会失败**。`pushNativeModels` 与 `isUpstreamUid`
  共用同一个谓词，避免两侧漂移。
- **原生观测的两条通道必须按「谁更完整」合并，不能后者覆盖**：backend 看的是 CLI 侧流量（CLI 常读自己的缓存、很少重取 → 它的观测可能长期是 seed 的贫化形态），扩展宿主看的是原生扩展 UI
  侧的流量（带完整 field 30）。`mergeNativeEntry`（`native-cache.cjs`）在合并时保留
  `sidekickDimension`/`fusionMetadata`/`harnessUids`，缺失的一方不会把完整的一方降级；标量字段（`disabled`/`label`）仍以新到者为准。
  **一旦被贫化条目覆盖，所有原生 Sidekick 解析不到 → 镜像组合消失 → 又被上一条的清理逻辑删除**，这是级联失效。`refreshNativeModels` 与
  `observeNativeModels` 都已走该合并。
- **关闭路径的每一段等待都必须有上限**：`close()` 里三段等待（在途请求排水、监控队列 flush、`server.close()` 等连接结束）原本都无上限。半读的 SSE 流会让请求既不 finish
  也不 close → `release()` 永不执行 → 排水永不完成 → `close()`/`stopped` 永不 resolve；而 SIGTERM 的处理器本身就在 `await close()`，
  于是**信号变成空操作**，进程只能 SIGKILL（2026-10-14 实测：必须 `kill -9` 才清掉孤儿 backend）。现在三段都用 `drainTimeoutMs` 兜底，超时后
  `closeAllConnections()` 强制收尾并继续走到 `stopped`，保证「关得掉、也杀得掉」。**不要退回无上限等待**，也不要只在超时日志里记录而不强制关闭。
- backend 的原生缓存落盘条件包含「任一入口的维度变富」，不再只看条目数：seed 已是满员（875）时条目数永不变化，只看数量就永远不会把更完整的观测写回磁盘，每次重启都重新 seed
  回贫化形态（`runtime.log` 的 `native-observed` 全天只出现 2 次就是这个征兆）。
- **上下文压缩：扩展不是施加者，且声明窗口是唯一杠杆（2026-10-16 定论，含三次自我推翻，别再重走）**。①**扩展从不碰会话历史、也不设任何压缩参数**；我们唯一的杠杆是 ModelInfo 的
  `f4 = maxTokens`（＝声明窗口）。**实测该声明被采纳且生效**：BYOK `deepseek-flash` 声明 `contextWindow: 1024000`，真实会话跑到
  **280,819** 而**零压缩**（`monitor.jsonl` 峰值，其中 >262000 共 9 条全 success），证明压缩**不是**按副模型 swe-2 的 262,000 走。
  ②**压缩由 CLI 的「压缩调度 + 阈值」决定，且调度是云端部署的**：远程 flag `enable-devin-cli-cloud-compaction-schedule=true`（描述原文「gate
  the deployment of CompactionSchedules and self-compaction for SWE-1.7/2」）、`devin-cli-compaction-threshold`
  与 `enable-devin-cli-swe2-self-compaction` 均为 `false`；CLI 配置项 `agent.compaction_threshold_tokens`（官方
  changelog：「trigger automatic compaction **earlier** than the context-window-based default」）只能让它更早，
  **没有**可靠办法推迟。③**CLI 有专门的 Fusion sidekick 阈值开关**（隐藏、`--help`
  不列）：`--compaction-thresholds <SPAWN,[APPLY,]HARD>`（示例 `183500,183500,262144`）与
  `--sidekick-compaction-thresholds`，后者原文「Override the **Local Fusion sidekick chain's** compaction
  thresholds **independently of the lead's**，未设置时回退到前者」，env 为 `DEVIN_COMPACTION_THRESHOLDS` /
  `DEVIN_SIDEKICK_COMPACTION_THRESHOLDS`。**但没有任何证据显示这两个开关在默认下把上限压到 sidekick 窗口**——实测已到 280,819 未压缩即反证，勿据此改配置。
  ④**触发是事件驱动的，不要用「压缩时的 token 数」反推阈值**：把全部真实压缩回溯前序事件，**每一条都紧跟在 `session/load` 之后**（15:21:51←15:19:15、
  15:33:11←15:32:59、16:00:01←15:59:44、17:00:20←16:59:13、00:26:01←00:23:47、01:43:00←01:39:46、
  02:08:11←02:07:45），token 数只是当时的规模，因此历史上把 141k/211k 当阈值证据、以及按 `0.7×262k`/`0.8×262k` 推阈值**都是错的**（已被
  249.9k/280.8k 无压缩直接证伪）。⑤**唯一干净的实验样本**：pid 33561 自 02:07:52 起 `initialize`/`session/load` 计数为 **0**（无重载、
  无切模型），`Summarize` 仅 02:08:11 一次，`message_nodes.num_tokens_preceding` 单调递增无断层。⑥**排障四个源**（缺一不可，
  因为压缩**不在对话里显示**——官方 changelog：「Automatic context compaction is no longer surfaced in the scrollback or the
  ACP conversation view」）：CLI 日志 `Summarize: truncated conversation history from N to M messages`、
  `message_nodes.num_tokens_preceding` 的断层、`~/.local/share/devin/cli/summaries/` 的新摘要产物、`summaries/sidekick/`
  与 summary-agent 日志。⑦**不要把面板的 `used` 与 `monitor.jsonl` 的 `inputTokens` 混用**：前者是 Devin 上报值（略高），后者是实际请求量，
  二者差值可达 5–7k，用它们互相验证会得出假结论。⑧`usageState: 'inconsistent'`（如 `cachedTokens > inputTokens`）与
  `num_tokens_preceding` 的**常态回落**（实测 484 条请求中 37 次回落、21 次 ≥5,000，最大 −31k 且 24 秒内自愈）都**不是**压缩，别当信号。

## 平台支持

**只以 macOS 为目标平台**（个人自用，本机即 macOS）：验证、真机验收、发布检查都只针对 macOS。其他平台按「逻辑可行」的最低标准处理，**短期不做实机验证**。

- **不要声称非 macOS 已验证可用**。涉及平台差异的行为，在代码与文档里注明「仅 macOS 验证」。
- **非 macOS 必须明确失败，不得静默出错**。既有先例（沿用这个模式）：`src/runtime/app-restart.cjs` 在非 darwin 抛 `restart_unsupported`，
  面板提示「当前环境不支持重启 Devin」；`src/update.cjs` 的 `supported` 判断使非 macOS 只能手动装 vsix。注意 `package.json` **未设 `os` 字段**，
  其他平台能装上、只是相应功能不可用。
- **已知 macOS 硬编码**（非 macOS 上会失败或降级，暂无适配计划）：`/usr/bin/sqlite3`（用量归属，`monitor-store.cjs`；失败降级为 `unavailable`）、
  `/usr/bin/unzip`（一键安装，`update.cjs`）、`/usr/bin/open` 与 `/usr/bin/grep`（重启 Devin，`app-restart.cjs`）、
  `/usr/bin/zip`（打包，`scripts/package.cjs`）。Fast Context 的 ripgrep 查找是唯一带回退的：`FUSION_FAST_CONTEXT_RG` → `PATH`
  → `/Applications/Devin.app/...`，都找不到才抛 `ripgrep_unavailable`。
- **测试只覆盖逻辑分支**：平台差异靠注入参数验证（如 `platform` 形参、`resolveNode(env, platform)`），不依赖真机。
- 结论：**不要为未验证的平台做重构**；能低成本避免耦合就避免，已硬编码的保持现状。

## 自更新（发布约束）

- 自更新运行时只读 `src/update.cjs` 的 `REPOSITORY` 常量，`PAGE` 与 `API` 由它派生。测试通过导出的 `PAGE` 复用，不要重写回硬编码字符串。换仓库需同时改这里与
  `package.json` 的 `repository.url`（后者是纯元数据，运行时不读）。
- **不要修改 `package.json` 的 `name`（必须 `devin-fusion-byok`）和 `publisher`（必须 `local`）**：`verifyPackage()` 会校验包内
  `package.json` 与 `extension.vsixmanifest` 的 Id/Publisher/Version 一致，不一致则拒绝安装。
- Release 资产名必须严格等于 `devin-fusion-byok-<version>.vsix`，且下载地址必须是 GitHub 标准的 `<PAGE>/download/<tag>/<asset>`
  形式（`releaseInfo()` 会做严格相等校验）。`npm run package` 按 `name-version` 命名，与之一致。
- tag 必须是 `v<major>.<minor>.<patch>` 形式的三段纯数字 semver（`v` 可省略）；draft 与 prerelease 一律不被接受。
- 资产必须带 GitHub 自动计算的 `digest`（`sha256:` + 64 位十六进制）且大小 ≤ 50 MiB，否则 `installable=false`，面板只提供「打开发布页面」。
- 插件内 `package.json` 的 `version` 必须严格小于 Release 版本才会提示更新，发布前记得 bump。
- 一键安装仅在 macOS 且 `<appRoot>/bin/devin-desktop` 存在时可用（`createUpdateHost` 里的 `supported` 判断）；其他情况
  `canInstall=false`，只能手动下载 vsix。
- 更新检查只访问 `api.github.com` 与 GitHub 下载域名（`allowedUrl` 白名单在代理路径同样逐跳校验）。代理由插件自管：`config.json` 的 `updateProxy` 经
  `src/proxy.cjs` 建 CONNECT 隧道，只作用于更新检查与一键安装，其余流量（模型请求、内网地址）保持直连。
  **不要改成读 `http.proxy` 设置或 `HTTPS_PROXY`/`http_proxy`/`ALL_PROXY` 环境变量**——那会全局生效，把内网 HTTPS 地址也送去代理。
  **也不要依赖扩展宿主被打过补丁的 `fetch`**：Devin 启动时会把 `globalThis.fetch` 换成 `@vscode/proxy-agent` 的代理感知版本（读 VS Code 的
  `http.proxy` / `http.noProxy`，`http.proxySupport` 默认 `override`），那也是全局的，同样会波及内网地址——配置 `updateProxy` 时走
  `src/proxy.cjs` 的 CONNECT 隧道；未配置代理的更新与模型发现走其 `directFetch`，使用独立 Agent，不依赖宿主全局 `fetch` 或全局 Agent。
  （这些约束只针对**插件运行时代码**；开发者在终端跑 git/gh 命令时按「本机网络路径」一节处理，两者不冲突。）验收方法见 `.devin/skills/release/SKILL.md`。
- **`src/proxy.cjs` 的请求一律经 `http.ClientRequest` 构造，绝不用 `http.request`/`https.request`**：宿主补丁不只换 `fetch`，还会替换
  `http.request`/`http.get`（`createHttpPatch` 注入 `PacProxyAgent`，`http.proxySupport` 默认 `override`），把我们的
  `createConnection` CONNECT 隧道顶掉——实测表现为跳过代理直连 `api.github.com` 随即 `ECONNRESET`。`ClientRequest` 是公开构造器、
  不在补丁替换范围（`node:https` 没有同名导出，TLS 仍由传入的 `https.Agent` 处理）；`directFetch` 同样必须走这条路，否则用户一旦在 VS Code 里配置
  `http.proxy`，「内网地址直连」的保证就失效。`http.ClientRequest` 缺失时才回退到 `http.request`/`https.request`。
- `updateProxy` 可在面板 **设置 → 更新代理** 编辑（只作用于更新检查与一键安装），清空即直连。`snapshot().proxy` 与面板 `state().updateProxy` 只回显
  `maskProxy()` 掩码（`http://***@host:port`），**凭据不进入
  webview**，也不写入日志或错误文案；直接保存掩码视为未改、不覆盖存储值，输入完整新 URL 才会替换。面板侧校验复用 `parseProxy`，非法输入不回显、不写盘。
- 「重启 Devin」的 detached helper：优先经 `launchctl submit` 注册给 launchd 运行（submit 失败回退 detached `/bin/sh`）——实测
  helper 是 App 后代时其 `open` 请求被归因为 App 自身激活而静默吞掉；已实测从 App 进程树内 `launchctl submit` 的 job 落在用户域 `gui/501`（非 App
  自身的 runningboard 域），因此不随 App 退出被拆除。等 App 退出后只小静置约 3 秒，随后最多 10 轮「先探测再启动」的自适应重试：实测旧实例退出后 ~10 秒内启动的进程会在 ~110ms
  内自退（+1.1s 与 +3.3s 两次中招，+10s 起全部存活），风险窗口是时间性的；但盲等固定时长浪费——一次自退 ~113ms 即可被探测发现，故改成「小静置 + 快速失败探测 + 有限轮重试」，
  若窗口其实来自已修复的陈旧 IPC 句柄则第 1 轮即成功（约 5s），否则轮次自然覆盖窗口之外，最坏与固定静置持平且无固定浪费。113ms 退出的根因已确证是 Devin 自实现的单实例仲裁：主进程监听
  `<userData>/<version>-main.sock`、PID 写入 `<userData>/code.lock`，`claimInstance` 遇 `EADDRINUSE` 时会把请求交接给现有
  owner 并直接 exit 0（不建窗口）；因此 helper 确认 App 已退出后、以及每轮启动前，先移除陈旧的 `*-main.sock` 与 `code.lock`（此时已无活着的 owner，
  与应用自身遇 `ECONNREFUSED` 时删陈旧 handle 的做法一致；`userData` 由 `<globalStorage>` 上溯三级得到）。通道分配保持「`open` 在前、`exec`
  兜底」：前 50% 轮 `open`、中间到 80% `open -n`、最后两轮直接 exec `<bundle>/Contents/MacOS/<AppName>`（不经 LaunchServices 注册，
  参照 Electron `app.relaunch()` 的确定性路径，作为兜底）；探测命中后隔 2 秒复探才算成功（瞬时启动不算），预算内放弃 `exit 1`，取消退出时先 `launchctl remove`
  再退。日志写 `<globalStorage>/restart.log`（每次重启把上一轮轮转为 `restart.log.previous`），行前缀为 UTC 时间戳；`open` 与应用自身的
  stdout/stderr 也追加进该日志，且 `attempt <n> channel=<c>` / `confirmed round=<n>` 记录成功轮次与通道，真实阈值可观测。非 darwin 抛
  `restart_unsupported`；存活探测用 `ps -Ao comm=`（`pgrep` 会跳过祖先进程，而 helper 必在 App 进程树内时不可用）。

