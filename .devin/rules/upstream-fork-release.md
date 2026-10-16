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

merge 冲突时以此表为准；表外差异一律视为 upstream 改动，取 upstream。

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
| `src/runtime/monitor-store.cjs` | 工具归属查询与细分诊断；message-id 补充分支默认关闭，仅内部显式诊断开启并保留 1500 ms 上限；完整标题仅进快照；分段 ID/reasoning/异常用量安全口径；统计复用 monitor-stats；异步存储与失败保护原日志 |
| `src/runtime/monitor-stats.cjs` | 本 fork 新增（upstream 无），无 I/O 的共享统计工厂与本机日历区间筛选；前后端使用同一公式 |
| `test/monitor-stats.test.cjs` | 本 fork 新增（upstream 无），日历月/自定义/DST 边界、同范围重算与浏览器函数注入验证 |
| `src/runtime/monitor-client.cjs` | 公开白名单保留标题、归属/存储诊断和保留上限；新增字段缺失兼容旧 backend，非法诊断不伪装为零 |
| `src/panel/monitor-view.cjs` | 完整会话 tooltip、100 条分页和 DOM 复用；默认当月时间×会话筛选，区间内重新汇总；本机时区展示与原始时间提示；细分诊断和明确 TPS 口径 |
| `test/monitor.test.cjs`、`test/monitor-panel.test.cjs` | 覆盖归属只走 `tool_call_state`（含「任何情况下都不得查 `message_nodes`」的 SQL 捕获断言）、细分归属/存储状态、旧快照兼容、reasoning/异常计数/分段 ID、指标口径，以及既有异步存储/分页/状态重传 |
| `src/panel/context-view.cjs`、`src/runtime/context-state.cjs`、`src/runtime/context-observer.cjs` | 上下文详情的最近请求指标文案与监控保持同一口径，不拿原生 TPS 替代插件度量。**「正文 TPS」这一格与同格其它指标语义不同**（2026-10-16）：它只在 `success && !hasTools && visibleTokens>0 && decodeMs>0` 时才算出（`monitor-store.cjs`），而 agent 流量实测 **92.3% 带工具**（本机 5099 条 → tps 非空仅 7.2%），所以上下文页按「最近一条请求」去读几乎总是 `—`，而用量页一直有值——**同一个指标两个页面取法不同**。已对齐为用量页语义：判据直接复用 `monitor-stats` 的 `timing`/`usageIsInconsistent`（`usageIsInconsistent` 已导出；**不要自行复述条件**，否则两处必然漂移），并把「最近有效样本」的时间用**可见文本**标注（`正文 TPS（不含工具） · 最近有效 HH:MM`）——**必须是可见文本而非 tooltip，该面板 hover 实测无效**。样本**就是**最近那次请求时不加标注（与同格其它指标一致）；`startedAt` 不可解析时措辞中性（「其时间无法解析」），**不得断言**「早于最近一次请求」。其余 9 个指标仍是「最近一条请求」语义，不要一起改。拒绝原因词汇表**只在 `context-state.cjs` 定义一次**（`USAGE_REJECTIONS`），observer 的计数器与 `context-diagnostics` 写盘都从它派生——这三份清单历史上各写一遍，改动时必然漂移。**`size` 缺失与 `size === 0` 是两个不同的事实**（`missing-size` = 上游形态变了；`zero-size` = 上游确实发了 0），必须分开计数：实测 ACP 在会话加载时会重放约 55 条 `size: 0` 的历史 subagent `usage_update`（字段齐全、类型正确、`used` 是真实值，只是窗口未知），旧的合并桶把这次一次性重放显示成「85% 的实时更新被拒」且无法定性。这些更新还携带 `cognition.ai/{inputTokens,outputTokens,cachedReadTokens}`，若将来要在面板里显示 subagent 的 token 用量（无百分比），数据源就在这里。`context-diagnostics` 还写有 `subagentDetails`/`subagentDetailsTruncated`（有界：4 会话 × 8 行，只含 id 与数字），用途是无需 hover 即可核对子代理行的键与窗口；面板子代理行标签内联 `parentAgentId`（有 `runId` 时再补前 8 位）。**已定论（真机实测）**：`cognition.ai/subagent_context` 的 `parentAgentId` 是**所属代理**而非父代理——保留值 `root` 表示会话自身主上下文（usage 与 lead 流逐字节相同，198,597/1,024,000 两行同增），**不得计成子代理**（此前因此把 `subagentUsages` 与面板多算一行）；真子代理（`parentAgentId=sidekick`）报**自己的窗口**（78,086/262,000，262,000 == swe-2 自身 `maxTokens`），不是组合/Lead 窗口 |
| `src/config.cjs`、`test/config.test.cjs` | 模型发现使用独立 Agent 的 `directFetch`；显式 request 注入测试；不依赖宿主 fetch 或全局 Agent |
| `src/extension.cjs`、`test/extension-lifecycle.test.cjs` | 错误自动继续达到预算后显示中文警告，安全处理提示 Promise；激活期执行一次幂等的退役配置键清理；`checkCliCaches` 返回报告并同时服务面板手动刷新。模块级生命周期状态收在单个 `lifecycle` 对象（跨 `activate`/`teardown`/`deactivate` 共享）；`activate()` 由 `installContinuation`/`installCatalogSync`/`installCommands`/`installPanel` 四个内层函数段组成，被多段共享的声明留在 `activate` 作用域、以内层 `let` 槽承接 |
| `src/runtime/auto-continue.cjs`、`test/auto-continue.test.cjs` | 连续错误最多自动重试 5 次、窗口 10 分钟；停止时结算并清理，回调不能影响新回合 |
| `src/runtime/backend.cjs`、`test/backend.test.cjs` | 关闭前同时等待响应与处理器结束，再刷监控队列、最后释放端口；**每一段等待都有上限**（`drainTimeoutMs`，默认 5 秒）、超时记 `drain-timeout`/`monitor-close-timeout`/`close-timeout` 并强制 `closeAllConnections`；宿主可 `POST /_runtime/native-models` 推送完整观测（`/health` 的 `nativeModelsIngest` 为能力标志）；源码身份包含 `proxy.cjs` 与 `monitor-stats.cjs` |
| `src/runtime/bridge.cjs`、`test/bridge.test.cjs` | 转发增加连接 10 秒、响应头 120 秒、流空闲 120 秒超时；无流总时长限制，取消/错误清理计时；`catalog` 日志只报 `models`/`matrix`（预设计数已删） |
| `src/panel/controller.cjs` | state 成功投递后才去重；发送串行化，ready 强制同步，旧面板不得污染新缓存 |
| `src/panel/view.cjs` | tab 顺序「模型 / Fusion / 用量 / Goal / Fast Context / 设置」；Fusion 页即官方 Fusion 卡片的角色配置（Lead/Sidekick 勾选），默认 tab 为「模型」；设置页含「官方模型显示」与「CLI 缓存」（手动刷新入口）；会话选择器单行省略、日期控件、监控分页与诊断分行布局；导出 `panelStyles`/`panelMarkup`/`panelScript`，`renderPanel` 只做组装（CSP/style/markup/script），与其余视图的 `xxxMarkup()`/`xxxScript()` 形态对齐 |
| `src/panel/dom.cjs` | webview 共享 DOM 助手：`escapeAttribute()` 与 `domHelpersSource()`（返回浏览器侧 `byId`/`text`/`element` 源码字符串）。**拼接作用域规则**：独立文档（context/goal/update/fast-context 视图）在自己 IIFE 内发射一次；主面板由 `panelScript()` 在 `<script>` 顶层**只发射一次**，`panelClient` 因 `toString()` 序列化进 webview、**不能**内联 `${...}`，只能沿用外层那份；同一 `<script>` 顶层禁止重复发射；`domHelpersSource(indent)` 的可选参数只缩进第 2 行起（首行由调用处模板字面量定位），默认不传时输出逐字节不变 |

