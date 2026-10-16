---
trigger: model_decision
description: "Apply when syncing `upstream`, choosing or bumping the version, publishing a release, or resolving a merge conflict — the fork sync rules, the version invariant, the release steps and the \"deliberate fork differences\" table."
---

## fork 同步与发布

本仓库是上游 fork，会持续同步 `upstream`。以下约定是刻意设置，merge 时不要被 upstream 覆盖。

### 同步 upstream

```bash
git fetch upstream && git merge upstream/main
```

- `upstream` 是 **HTTPS** remote。本机已配 URL 限定代理，所以上面是裸命令；**未配置的机器**上会挂约 75 秒后才失败，此时改用
  `HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=localhost,127.0.0.1 git fetch upstream`（`NO_PROXY` 不可省：给 git
  加前缀会让该命令触及的所有 HTTPS 都走代理；见「本机网络路径」）。`origin` 是 SSH，`git push` 一律**不要**加这个前缀。
- 用 **merge**，不要用 `git pull upstream`：显式 fetch + merge 能明确来源，冲突时也便于对照下面的差异表；本仓库已设 `pull.rebase=false`，即使误用
  pull 也不会走 rebase 重写历史、不需要 force push。
- 已启用 `rerere`（`git config --local rerere.enabled true`）：README 等固定位置的重复冲突会自动复用上次解法。但
  **`package.json` 的 `version` 冲突它救不了** —— upstream 每次改的版本号都不同，冲突片段内容随之变化，匹配不上。
- 冲突处理：`package.json` 的 `version` **一律取本 fork 的值（ours）**。版本号由本 fork 自管、不跟随 upstream；上游每次发版都会只在这一行产生冲突，固定改 1
  行即可。

### 版本号怎么取

版本号由本 fork 自管，**与 upstream 的版本号无耦合**：自更新只比较「本地 `package.json` 的 version」与「本仓库 GitHub Release 的最新版本」（`API`
  由本仓库的 `REPOSITORY` 派生），upstream 的版本号不参与任何判断。

`parseVersion()` 只认三段纯数字；`0.3.43-1`、`0.3.43+foo`、`0.3.43.1` 会让自更新直接报错失效。

- 发布版本 = 本 fork 上次发布的版本 patch +1；从 0.3.42 起自管，首次发布取 0.3.43。
- **唯一不变式：相对本 fork 自己的历史版本严格递增。** `compareVersions(latest, current)` 要求严格大于，本地版本 ≥ Release 版本时不会提示更新。
- 与 upstream 的版本号大小无关，不必刻意高于 upstream（本地 VSIX 安装是直接替换，安装更低版本不会被拒绝）。
- 发布前校验格式：

```bash
node -e "const v=require('./package.json').version; if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw Error('版本必须是三段纯数字: '+v); console.log('version OK:', v)"
```

代价：取 ours 后 `package.json` 不再反映所基于的 upstream 版本。**merge 提交信息里写明所合并的 upstream 版本**（例如
  `merge upstream v0.3.43`），`git log` 是唯一的追溯来源。

### 发布步骤

完整流程与验收方法见 `.devin/skills/release/SKILL.md`（`/release` 调用）：定版本 → `npm test` → `npm run package` → 推送 + 打 tag
  → 建 Release → **用已安装副本的代码跑读回路校验** → 覆盖安装。

要点：`npm run package` 产出的 `devin-fusion-byok-<version>.vsix` 必须原样命名为 `v<version>` Release 的资产；必须 Publish 而非存为
  draft；Release body 即面板显示的更新说明（截取前 6000 字符）。

### 本 fork 相对 upstream 的刻意差异

**遇到冲突时的判据（不要只按本表机械取舍）**：先查该文件在 fork 侧有没有提交——

```bash
git log --oneline "$(git merge-base upstream/main HEAD)..HEAD" -- <file>
```

- **有 fork 提交 → 该文件是 fork 文件**，按「保住 fork 行为」解，并对照下表该行的差异要点逐条核对；
- **无 fork 提交 → 该文件只有 upstream 在改**，取 upstream；
- 两边都改了且下表未列出该文件 → **停下来人工判断**，不要默认取 upstream（下表是差异**说明**，下面「完整差异文件清单」才是完整性依据）。

唯一例外是 `package.json` 的 `version`：一律取 ours（见上）。

| 文件 | 差异 |
| --- | --- |
| `src/update.cjs` | `REPOSITORY` 改为 `TendernessCJS/devin-fusion-byok`；导出 `PAGE`；`requestBytes` 支持 `proxy`，无代理时默认 `directFetch`；`createUpdater` 增加 `proxy` getter，快照回显 `proxy` 供设置页编辑 |
| `test/update.test.cjs` | 使用导出的 `PAGE`，不再硬编码仓库 URL；含代理相关用例 |
| `README.md` | 顶部 fork 声明；Releases 链接指向本 fork；保留上游作者署名 |
| `package.json` | 新增 `repository` 字段；`version` 由本 fork 自管，merge 时取 ours |
| `AGENTS.md` | 本 fork 新增（upstream 无），**常驻**的项目约定、架构边界与主题卷索引 |
| `.devin/rules/*.md` | 本 fork 新增（upstream 无），从 `AGENTS.md` 拆出的按需主题卷（本卷 + `retired-and-deadends` + `testing-notes`）。`trigger: model_decision` 意味着**不保证加载**，所以行为锚定的硬约束不在这里，全留在 `AGENTS.md` |
| `.devin/skills/release/SKILL.md` | 本 fork 新增（upstream 无），发布与自更新验收流程 |
| `src/proxy.cjs` | 本 fork 新增（upstream 无），更新的 CONNECT 代理与独立 Agent 直连 GET；全部请求经 `http.ClientRequest` 构造以绕开宿主对 `request`/`get` 的补丁；CONNECT 仅用于更新，`directFetch` 用于模型发现与未配代理的更新；握手早关、压缩流、取消与 TLS 校验均有回归测试 |
| `test/proxy.test.cjs` | 本 fork 新增（upstream 无），覆盖代理、直连、解压、取消、IPv6、TLS 安全边界与宿主补丁旁路 |
| `src/runtime/retry.cjs` | 本 fork 新增（upstream 无），连接层一次性重试；只被 `native-models.cjs` 与 `monitor-client.cjs` 使用 |
| `src/runtime/app-restart.cjs` | 「重启 Devin」：存活探测用 `ps -Ao comm=`（`pgrep` 跳过祖先）；helper 优先 `launchctl submit` 注册给 launchd（落在 `gui/501`，避免 `open` 被归因为 App 自我激活且 job 不随 App 拆除），失败回退 detached `/bin/sh`；退出后先清陈旧 `*-main.sock`/`code.lock`（Devin 自实现单实例仲裁，`EADDRINUSE` 即交接退出——113ms exit 0 的根因），小静置 3s + 最多 10 轮自适应重试「先探测再启动 + 二次确认存活」（前 50% `open`、至 80% `open -n`、末两轮直接 exec 可执行文件），日志写 `restart.log` 并轮转 `.previous`（`open`/应用输出也追加进日志，成功轮次与通道可观测） |
| `test/app-restart.test.cjs` | 覆盖探测与重试策略：合成 app 复现 `pgrep` 祖先盲区、退出后才拉起、瞬时进程不误判、预算内退出、日志行、`launchctl` 首选/回退与日志轮转 |
| `src/runtime/monitor-store.cjs` | **改名**：upstream 的 `src/runtime/monitor.cjs` → 本 fork 的 `monitor-store.cjs`。工具归属查询与细分诊断；message-id 补充分支默认关闭，仅内部显式诊断开启并保留 1500 ms 上限；完整标题仅进快照；分段 ID/reasoning/异常用量安全口径；统计复用 monitor-stats；异步存储与失败保护原日志 |
| `src/monitor-stats.cjs` | 本 fork 新增（upstream 无），无 I/O 的共享统计工厂与本机日历区间筛选；前后端使用同一公式。**位置**：原在 `src/runtime/monitor-stats.cjs`，`7a4b8b0` 上提到 `src/` 根（它是共享纯计算，被面板直接消费，不属于宿主侧运行时） |
| `test/monitor-stats.test.cjs` | 本 fork 新增（upstream 无），日历月/自定义/DST 边界、同范围重算与浏览器函数注入验证 |
| `src/runtime/monitor-client.cjs` | 公开白名单保留标题、归属/存储诊断和保留上限；新增字段缺失兼容旧 backend，非法诊断不伪装为零 |
| `src/panel/monitor-view.cjs` | 完整会话 tooltip、100 条分页和 DOM 复用；默认当月时间×会话筛选，区间内重新汇总；本机时区展示与原始时间提示；细分诊断和明确 TPS 口径 |
| `test/monitor.test.cjs`、`test/monitor-panel.test.cjs` | 覆盖归属只走 `tool_call_state`（含「任何情况下都不得查 `message_nodes`」的 SQL 捕获断言）、细分归属/存储状态、旧快照兼容、reasoning/异常计数/分段 ID、指标口径，以及既有异步存储/分页/状态重传 |
| `src/panel/context-view.cjs`、`src/runtime/context-state.cjs`、`src/runtime/context-observer.cjs` | 上下文详情的最近请求指标文案与监控保持同一口径，不拿原生 TPS 替代插件度量。**「正文 TPS」这一格与同格其它指标语义不同**（2026-10-16）：它只在 `success && !hasTools && visibleTokens>0 && decodeMs>0` 时才算出（`monitor-store.cjs`），而 agent 流量实测 **92.3% 带工具**（本机 5099 条 → tps 非空仅 7.2%），所以上下文页按「最近一条请求」去读几乎总是 `—`，而用量页一直有值——**同一个指标两个页面取法不同**。已对齐为用量页语义：判据直接复用 `monitor-stats` 的 `timing`/`usageIsInconsistent`（`usageIsInconsistent` 已导出；**不要自行复述条件**，否则两处必然漂移），并把「最近有效样本」的时间用**可见文本**标注（`正文 TPS（不含工具） · 最近有效 HH:MM`）——**必须是可见文本而非 tooltip，该面板 hover 实测无效**。样本**就是**最近那次请求时不加标注（与同格其它指标一致）；`startedAt` 不可解析时措辞中性（「其时间无法解析」），**不得断言**「早于最近一次请求」。其余 9 个指标仍是「最近一条请求」语义，不要一起改。拒绝原因词汇表**只在 `context-state.cjs` 定义一次**（`USAGE_REJECTIONS`），observer 的计数器与 `context-diagnostics` 写盘都从它派生——这三份清单历史上各写一遍，改动时必然漂移。**`size` 缺失与 `size === 0` 是两个不同的事实**（`missing-size` = 上游形态变了；`zero-size` = 上游确实发了 0），必须分开计数：实测 ACP 在会话加载时会重放约 55 条 `size: 0` 的历史 subagent `usage_update`（字段齐全、类型正确、`used` 是真实值，只是窗口未知），旧的合并桶把这次一次性重放显示成「85% 的实时更新被拒」且无法定性。这些更新还携带 `cognition.ai/{inputTokens,outputTokens,cachedReadTokens}`，若将来要在面板里显示 subagent 的 token 用量（无百分比），数据源就在这里。`context-diagnostics` 还写有 `subagentDetails`/`subagentDetailsTruncated`（有界：4 会话 × 8 行，只含 id 与数字），用途是无需 hover 即可核对子代理行的键与窗口；面板子代理行标签内联 `parentAgentId`（有 `runId` 时再补前 8 位）。**已定论（真机实测）**：`cognition.ai/subagent_context` 的 `parentAgentId` 是**所属代理**而非父代理——保留值 `root` 表示会话自身主上下文（usage 与 lead 流逐字节相同，198,597/1,024,000 两行同增），**不得计成子代理**（此前因此把 `subagentUsages` 与面板多算一行）；真子代理（`parentAgentId=sidekick`）报**自己的窗口**（78,086/262,000，262,000 == swe-2 自身 `maxTokens`），不是组合/Lead 窗口 |
| `src/config.cjs`、`test/config.test.cjs` | 模型发现使用独立 Agent 的 `directFetch`；显式 request 注入测试；不依赖宿主 fetch 或全局 Agent。**模型列表信封兼容**（2026-10-16）：`/models` 的响应可能是网关自己的信封 `{code, message, data:{object, data:[...]}}`（真实网关实测形态），旧代码只认 `Array.isArray(json.data)`，信封被误判为「API 未返回模型列表」——**这句文案会被用户读成「该供应商没有模型接口」**，从而掩盖真实原因；现同时接受 `json.data` 数组与 `json.data.data` 数组。另：**仅 404/405** 的报错追加「该供应商可能未提供 /models，可用『手动添加』录入模型」引导，其余状态码保持原文案（不把「路由不存在」的断言套到无语义的 5xx 上）。**模型列表的路径约定与一处供应商缺口**（2026-10-16）：两个官方 SDK 都是「版本前缀只出现一次，messages 与 models 挂在同一前缀下」——OpenAI 把 `/v1` 放 baseURL（`https://api.openai.com/v1` + `/responses`、`/models`），Anthropic 把它放资源路径（baseURL `https://api.anthropic.com` + `/v1/messages`、`/v1/models`），本仓的「baseUrl + `/messages` / `/models`」与两者逐字一致。真机实测 `Personal`（anthropic，baseUrl `https://api.deepseek.com/anthropic/v1`）：`/anthropic/v1/models` 与 `/anthropic/models` 均 **404**，只有根 `/v1/models` 是 **200** —— 即 **DeepSeek 的 anthropic 兼容面没在 `/anthropic` 前缀下提供 `/models`**；按 SDK 约定取 baseURL `https://api.deepseek.com/anthropic` 后，**官方 Anthropic SDK 同样列不出模型**，所以这不是本仓缺陷。该类供应商的模型用「手动添加」录入（**其 messages 仍在该前缀下、推理完全正常**）；**不要**为此加「根路径回退」式非标准探测——它可能拉到与预期不同的列表 |
| `src/panel/base-url.cjs`、`test/base-url.test.cjs` | **API 地址规范化只对纯域名补 `/v1`**（2026-10-16）：旧规则是「路径里没有 `v\d+` 段就补」，于是用户填的 `.../openai`、`/api` 都被改写成 `.../openai/v1`，**无版本号路径的网关（如 `https://superaichao.xin/openai/responses`）在面板里没有任何填法能表达正确 URL**——实测该网关 `/openai/{models,responses}` 均 200、`/openai/v1/*` 均 404。现改为「剥掉粘贴的端点后缀（`/responses` 等）后，路径为空才补 `/v1`，否则原样使用」，与 README 和字段提示早已声明的「只填域名时自动补」一致。连带把 `view.cjs` 里 API 地址的提示文案改成同一口径，并在「实际请求 / 获取模型」预览下**额外标注「地址只填了域名，已自动补 /v1」**（仅纯域名时出现），让用户不必从两条 URL 反推规则。**已知限制（刻意接受，2026-10-16）**：空路径必然补 `/v1`，所以「在根路径提供服务且不要 `/v1`」仍然**无法表达**（`/v1`、`/v1/..` 等绕法均被 URL 解析器归一，实测无效）。接受它的依据是 `/v1` 属生态标准——**OpenAI SDK 把它放在 baseURL（`https://api.openai.com/v1` + 路径 `/responses`），Anthropic SDK 把它放在路径（baseURL `https://api.anthropic.com` + `/v1/messages`）**，两者最终 URL 都带 `/v1`，故「根路径无 `/v1`」是非标准布局；真遇到时**要在代码里放开，不要靠提示文案糊过去**（曾评估过加「自动补 /v1」开关，为降低 UI/持久化面而放弃）。另记：`https://superaichao.xin` 实测**在根路径完全符合 OpenAI 标准**（`/v1/{responses,chat/completions,models}` 均 200），`/openai/*` 只是额外别名且 `/openai/v1/*` 为 404——所以当初的 404 是本规则「把 `/v1` 追加到别名末尾」所致，不是网关缺 `/v1`；该供应商最简填法是**只填域名** |
| `src/extension.cjs`、`test/extension-lifecycle.test.cjs` | 错误自动继续达到预算后显示中文警告，安全处理提示 Promise；激活期执行一次幂等的退役配置键清理；`checkCliCaches` 返回报告并同时服务面板手动刷新。模块级生命周期状态收在单个 `lifecycle` 对象（跨 `activate`/`teardown`/`deactivate` 共享）；`activate()` 由 `installContinuation`/`installCatalogSync`/`installCommands`/`installPanel` 四个内层函数段组成，被多段共享的声明留在 `activate` 作用域、以内层 `let` 槽承接 |
| `src/runtime/auto-continue.cjs`、`test/auto-continue.test.cjs` | 连续错误最多自动重试 5 次、窗口 10 分钟；停止时结算并清理，回调不能影响新回合 |
| `src/runtime/backend.cjs`、`test/backend.test.cjs` | 关闭前同时等待响应与处理器结束，再刷监控队列、最后释放端口；**每一段等待都有上限**（`drainTimeoutMs`，默认 5 秒）、超时记 `drain-timeout`/`monitor-close-timeout`/`close-timeout` 并强制 `closeAllConnections`；宿主可 `POST /_runtime/native-models` 推送完整观测（`/health` 的 `nativeModelsIngest` 为能力标志）；源码身份包含 `proxy.cjs` 与 `monitor-stats.cjs` |
| `src/runtime/bridge.cjs`、`test/bridge.test.cjs` | 转发增加连接 10 秒、响应头 120 秒、流空闲 120 秒超时；无流总时长限制，取消/错误清理计时；`catalog` 日志只报 `models`/`matrix`（预设计数已删） |
| `src/panel/controller.cjs` | state 成功投递后才去重；发送串行化，ready 强制同步，旧面板不得污染新缓存 |
| `src/panel/view.cjs` | tab 顺序「模型 / Fusion / 用量 / Goal / Fast Context / 设置」；Fusion 页即官方 Fusion 卡片的角色配置（Lead/Sidekick 勾选），默认 tab 为「模型」；设置页含「官方模型显示」与「CLI 缓存」（手动刷新入口）；会话选择器单行省略、日期控件、监控分页与诊断分行布局；导出 `panelStyles`/`panelMarkup`/`panelScript`，`renderPanel` 只做组装（CSP/style/markup/script），与其余视图的 `xxxMarkup()`/`xxxScript()` 形态对齐 |
| `src/panel/dom.cjs` | webview 共享 DOM 助手：`escapeAttribute()` 与 `domHelpersSource()`（返回浏览器侧 `byId`/`text`/`element` 源码字符串）。**拼接作用域规则**：独立文档（context/goal/update/fast-context 视图）在自己 IIFE 内发射一次；主面板由 `panelScript()` 在 `<script>` 顶层**只发射一次**，`panelClient` 因 `toString()` 序列化进 webview、**不能**内联 `${...}`，只能沿用外层那份；同一 `<script>` 顶层禁止重复发射；`domHelpersSource(indent)` 的可选参数只缩进第 2 行起（首行由调用处模板字面量定位），默认不传时输出逐字节不变 |
| `src/catalog.cjs`、`src/catalog/*.cjs` | **BYOK 核心，改动最密集，冲突代价最高**。upstream 是单文件 `catalog.cjs` 的内部实现；本 fork 在 `7a4b8b0` 拆为门面 + 6 模块（`identity`/`roles`/`build`/`payload`/`augment`/`assignment`），门面导出面固定为 8 个符号（`augmentCatalog`/`buildCatalog`/`buildRoleLists`/`collectAllowedUids`/`collectNativeModels`/`refKey`/`resolveAssignment`/`staleFusionUids`）。**若 upstream 改了 `catalog.cjs` 的内部实现，必须把改动落进对应模块，绝不能把门面覆盖回大文件** |
| `src/protocol/responses.cjs`、`src/protocol/tracker.cjs` | 消除 `protocol → runtime` 反向依赖：流式计量从 upstream 的 `../runtime/monitor.cjs` 移到 `./tracker.cjs`，`createTracker({ id, route, provider })` 不再接收 `request`；`tracker.cjs` 是本 fork 新增，承载 `createTracker`/`semanticOutput`/`usageOf`。**流式事件覆盖按官方 SDK 全集补齐**（2026-10-16）：Responses 的 `response.refusal.delta`/`.done`（`.done` 读 `refusal` 字段而**不是** `text`）、`response.reasoning_text.delta` 与 `response.reasoning_text.done`/`response.reasoning_summary_text.done`，以及 Chat 的 `delta.refusal`；`semanticOutput` 须同步这些事件，否则面板 `firstOutputMs`/吞吐统计会漏。**另加零输出兜底**：`processor().finish()` 在「正常完成、无工具调用、且整条流从未产生文本/思考」时抛 `upstream_empty_output` 并在流里输出 `Provider returned no output.`；截断（`response.incomplete`）与 content_filter **不**触发。**强制 tool_choice 的反应式降级**（2026-10-16）：思考模式供应商对**强制/required** 的 tool_choice 直接回 **HTTP 400**——DeepSeek 原话「Thinking mode does not support this tool_choice」，实测省略 / `auto` / `none` 均 200，`required` 与「指定某函数」均 400；而本仓只在 native 带工具名时强发（`if (choice?.name)`），且 native 的 `any` 会映射成 `required`，所以这种组合会把一个能用的请求变成硬失败。现仅在「HTTP 400 **且**响应正文提到 tool_choice」时把 `tool_choice` 降为 `auto` 并**重试一次**：支持强制指定的供应商（OpenAI 系）不丢能力，其他原因的 400（上下文超长等）原样报错，错误正文只用于分类、**从不落日志或转发**（有测试锁定），且只读有界长度。真机验证：修复前 DeepSeek/chat 强制指定 → 400，修复后 → 200 且工具调用正常 |
| `src/protocol/chat.cjs`、`src/protocol/anthropic.cjs` | **思考签名往返与 usage 缓存分列**（2026-10-16）：chat.cjs 新增 `signatureChunk`（字段 10 `delta_signature`）与 `redactedThinkingChunk`（字段 11 `thinking_redacted`），`usageChunk` 补 `ModelUsageStats` 字段 4/5（`cache_write_tokens`/`cache_read_tokens`）；anthropic.cjs 的适配器捕获 `signature_delta`/`redacted_thinking` 转为 chat 形态，`buildAnthropicBody` 的 assistant 分支把 `{type:'thinking', thinking, signature}` 排在内容最前回传——**仅当 `signature` 非空才回传**（Anthropic `ThinkingBlockParam.signature` 为必需字段，无签名回传是非法请求）；脱敏思考**无载荷字段、无法往返**，只透传标志位；签名/脱敏标记不进 `texts`、不算语义输出（刻意决定，`upstream_empty_output` 判定不受影响）。字段号权威出处见 `.devin/rules/acp-protocol-fields.md` |
| `src/goal/*.cjs`（5 个） | **搬迁**：upstream 的平铺 `src/runtime/goal-{continue,prompts,report,state,store}.cjs` → 本 fork 的 `src/goal/` 且去掉 `goal-` 前缀（`7cdc4ff`，内容逐字节未改）。Goal 功能本身 upstream 就有。`report.cjs` 是**路径型入口**：`extension.cjs` 把它的绝对路径拼进 shell 命令（`reportCliPath`），任何改名/移动都必须同步该字符串 |
| `src/panel/model.cjs`（删）→ `src/panel/manager.cjs`（增） | **改名**（`c592368`）：upstream 的 `model.cjs` 实际是面板状态管理器，改名后名实相符。`test/panel-model.test.cjs` → `test/panel-manager.test.cjs` 同步 |
| `src/panel/theme.cjs` | 本 fork 新增（upstream 无），共享样式层 `baseStyles()`：控件（`button`/`.secondary`/`.quiet`/`.danger`、`input`/`select`/`textarea`、`input.switch`）、字号层级、页面边距、`ul/ol` reset、`.code-block`、`.tiles` 指标原语只在此定义一次；视图专有 CSS 必须排在 base **之后**才能覆盖 |
| `src/panel/update-view.cjs`、`src/panel/goal-view.cjs`、`src/panel/fast-context-view.cjs` | 差异主要为 `c592368` 的共享 DOM 助手改造与 `4bafdeb` 的样式层抽取：各视图改为发射 `domHelpersSource()`（浏览器侧 `byId`/`text`/`element`），**不再各自手写** `const byId = id => document.getElementById(...)`；`byId` 新增第二个参数 `prefix`（`byId(id, prefix = '')`），fast-context 因此从 `document.getElementById('fc-' + id)` 改为 `byId(id, 'fc-')`。**发射缩进**：`update-view`/`fast-context-view` 用 `domHelpersSource('    ')`（嵌在更深的模板里），`context-view`/`goal-view`/`view.cjs` 用无参调用。另 update-view 含设置页状态汇总与文案统一，`fast-context-view` 的预览 `<pre>` 类名从 `update-notes setting mono` 改为 `.code-block` |
| `src/runtime/cli-cache.cjs` | 本 fork 新增（upstream 无），CLI 按身份持久缓存的**原地重写**（陈旧 uid 修复）。**绝不改名、绝不写 `.stale`**——该 CLI 版本不会因文件缺失补拉 `model_configs_v5`，改名会把 picker 打空且不自愈 |
| `src/runtime/native-cache.cjs` | 本 fork 新增（upstream 无），原生模型观测的跨进程缓存（`native-cache.json`，TTL 7 天，原子写 `0o600`，追加并集语义）；只含 uid/label/能力标志，绝不落凭证 |
| `src/runtime/native-models.cjs` | 宿主把完整原生观测推送给 backend（消除两侧目录不一致）；推送门控对齐实际载荷；**禁止 ingest 存我方 uid**；「官方模型显示」按服务器家族聚合；对齐官方 picker 可见性契约 |
| `src/runtime/picker-refresh.cjs` | 收敛 ACP 强制刷新：仅 `model_configs` 重写触发、与 `changed()` 共享 `cliCacheMs` 间隔；消除启用期窗口重载循环；**`lightCommands` 默认值必须是空数组**（历史上默认是 `['devin.reloadAcpConnections']`，漏传即刷新风暴） |
| `src/runtime/context-diagnostics.cjs` | 子代理行内联 `runId` 标记并落诊断明细；上下文用量拒绝原因拆分并向**单一词汇表**（`context-state.cjs` 的 `USAGE_REJECTIONS`）收敛 |
| `src/runtime/acp-observer.cjs` | `installAcpObserver` 增加 `onModels` 回调（模型计数变化时通知宿主） |
| `src/runtime/ls-injection.cjs` | 增加 `ls port observed` 上报（端口可观测，排障用） |
| `src/lifecycle/owned-settings.cjs` | **`saveReceipt` 只在 roots 列表真正变化时才写**：往安装目录写 `.fusion-byok-storage.json` 会被应用监视，每次 activate 都触发扩展宿主重启（启用期重载循环的嫌疑点之一） |
| `src/runtime/acp-injection.cjs`（删）、`test/acp-injection.test.cjs`（删） | upstream 有、本 fork **删除**。该模块自 fork 初始提交起**从未接线**；env（`WINDSURF_API_SERVER_URL`）通道作用域严格覆盖它，保留只会误导 |
| `test/fixtures/presets.cjs`（删）、`test/fusion-presets.test.cjs`（删） | upstream 的具名预设管线测试；本 fork 退役该管线（改由官方 Fusion 卡片承载），迁移与清理见 `retired-and-deadends` 卷 |

### 完整差异文件清单（完整性依据，与上表互补）

上表是**说明**（改了哪些行为、为什么），下面是**清单**（哪些文件有 fork 侧改动）。判据以此为准：

```bash
git diff --name-only "$(git merge-base upstream/main HEAD)" HEAD -- src test
```

截至 `6ed0a2b`：**97 个条目**（src 52 / test 45），其中 **91 个现存**（src 49 / test 42）+ **6 个已删除**（src 3 / test 3）。

**src 现存（49）**：`catalog.cjs`、`catalog/{assignment,augment,build,identity,payload,roles}.cjs`、`config.cjs`、`extension.cjs`、`goal/{continue,prompts,report,state,store}.cjs`、`lifecycle/owned-settings.cjs`、`monitor-stats.cjs`、`panel/{base-url,context-view,controller,dom,fast-context-view,goal-view,manager,monitor-view,theme,update-view,view}.cjs`、`protocol/{anthropic,chat,responses,tracker}.cjs`、`proxy.cjs`、`runtime/{acp-observer,app-restart,auto-continue,backend,bridge,cli-cache,context-diagnostics,context-observer,context-state,ls-injection,monitor-client,monitor-store,native-cache,native-models,picker-refresh,retry}.cjs`、`update.cjs`

**src 已删除（3）**：`runtime/acp-injection.cjs`、`runtime/monitor.cjs`（→ `monitor-store.cjs`）、`panel/model.cjs`（→ `manager.cjs`）

**test 现存（42）**：`anthropic`、`app-restart`、`auto-continue`、`backend`、`base-url`、`bridge`、`catalog`、`cli-cache`、`config`、`context-diagnostics`、`context`、`extension-lifecycle`、`fast-context-panel`、`fast-context-view`、`fusion-options`、`goal-{command,extension,idle-regression,integration,state,store,tab,transport,view}`、`monitor-panel`、`monitor-stats`、`monitor`、`native-cache-sync`、`native-cache`、`native-models-sync`、`native-roles`、`panel-manager`、`panel-view`、`picker-refresh`、`protocol`、`proxy`、`retry`、`role-exclusions`、`runtime-manager`、`theme`、`update`、`vision-capabilities`

**test 已删除（3）**：`acp-injection`、`fixtures/presets`、`fusion-presets`

其余文件（`src/fast-context/*`、`src/model-capabilities.cjs`、`src/lifecycle/{jsonc-edit,uninstall}.cjs`、`src/protocol/wire.cjs` 等）**两边同源、无 fork 改动**，冲突时取 upstream。

> `src/panel/base-url.cjs` 原在本列表中，自 2026-10-16 起有 fork 改动（见上表），**不要**再按「取 upstream」处理。

