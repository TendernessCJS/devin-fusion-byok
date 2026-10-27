---
trigger: model_decision
description: "Apply when changing usage recording, attribution, time filtering, panel/webview styling, busy locking, or state de-duplication and focus retention."
---

# 监控与面板（monitor-and-panel）

用量记录与归属、时间筛选、面板样式与三个 webview 的共用规则、busy 锁定、state 去重与焦点/滚动保留。

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
  小时推进日期。前后端复用 `src/monitor/stats.cjs` 的统计公式，明细/汇总/诊断使用同一记录集；无效区间不得回退全量。最近 5000 条保留记录不保证完整月账单，界面必须明确披露。
- 面板控件的垂直高度统一由 CSS 令牌 `--control-h`（28px）驱动，`button`/`input`/`select` 都引用它，不要再写死各自的高度；同一行必须放下的「input + 按钮」容器用
  `.actions.nowrap`，以免 flex 折行把按钮挤到第二行（折行判定用 hypothetical size，与容器 max-content 宽度不一致是根因）。
- 主面板浏览器代码已拆分：`panel/client.cjs` 拥有 state/busy/共享 selection/request/对话框/焦点与滚动注册表/锁定恢复与消息监听；
  `panel/models-view.cjs`、`fusion-view.cjs`、`settings-view.cjs` 各导出 `pageMarkup` 与 `create*View(ui)`（经 toString 注入，bind 只绑一次）；
  纯投影在 `panel/panel-state.cjs`（`publicState`/`nativeVendor`，`manager.cjs` 转导出），`panel/view.cjs` 只剩外壳、样式与装配。
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

- **配置键分三类，清理时按类处理**：①**面板可管**（`providers`、`roleInclusions`/`roleExclusions`、`hiddenNativeModelUids`、
  `updateProxy`、自动继续开关、`enabled`）；②**程序自管**（`lastFusionSelection`
  在选组合时记录——不要手工写，也不要期望面板能改）；③**死键**（当前代码零读取，如退役管线的 `sidekicks`）。
  另有一类**派生值**：`inferenceServerUrl`（后端推理地址派生值，非 `ModelInfo.f18`）由运行端口派生、不再持久化；旧配置里等于派生值的副本由 `pruneRetiredKeys` 清理，
  不同值视为用户手工覆盖保留。新增/删除配置键时先想清属于哪类：**死键必须有清理路径**，
  否则用户配置会永久带着它而面板又删不掉（「已关闭的排除条目」在角色列表里渲染为无开关死行，面板提供「移除」按钮走 `forgetRoleRef`：BYOK ref 是配置权威、直接可删；native ref 必须
  `nativeCatalogStatus === 'ready'` 才放行，防止盲窗期把「还没同步」误删成「真死了」）。配置清理一律走 `src/config/config.cjs` 的
  `pruneRetiredKeys`（激活期一次性、幂等、键不存在即返回 `false` 不写盘），它现在是**所有退役键的唯一清理路径**：`sidekicks`、`fusionPresets`、
  `defaultFusionUid`、`fusionMatrix` 全在其中（2026-10-16：预设退役迁移已删除，那三个键不再有任何读取方，留着只会让用户配置永久带着删不掉的字段）。
- **`context-diagnostics` 里的 `zero-size` 计数不是回归信号，唯一判据是「启动后是否继续增长」**。上游在启动阶段会送 `size: 0` 的
  `usage_update`，被观测器按设计丢弃（不渲染、不参与百分比，也不会出现 NaN%）；0.3.47 / 0.3.48 三次实机验收分别停在 6 / 11 / 12 后
  不再增长，而 `missing-size` 始终为 0。**启动期一次性突发属正常，不要为它改代码**；只有该计数在启动之后仍持续增长，才值得插桩
  （记录 `sessionId` / `size` / `modelUid`）定位发射者。`context-state.cjs` 把 `zero-size` 与 `missing-size` 分开计数正是为此——
  合并成一个 `invalid-size` 曾把启动回放误读成「实时 85% 拒绝率」。
- **面板 `health` 字段必须完全确定、不含时间戳**：它走同一条 `postState` JSON 去重，任何每次调用都变的字段会让面板每 3 秒重渲染并杀掉搜索焦点（同 `at` 事故的机制）。
  `checkInjectionHealth` 的输入只取自既有共享槽（backendStatus/bridgeState/env/cliCache/acp 计数），返回值由输入唯一决定。ACP 信号必须**三态**：首个
  `session/new` 观测（`acpObserved > 0`）之前判 `unknown`，否则每次窗口重载都会误报「会话无本插件条目」。

## webview 安全不变量

- **CSP**（`src/panel/view.cjs`）：`default-src 'none'`；`style-src`/`script-src` 用 per-render 24 字节随机 nonce 白名单（`renderPanel({ nonce })`，nonce 同用于 `<style>`/`<script>`）；`img-src 'none'`、`font-src 'none'`、`connect-src 'none'`、`base-uri 'none'`、`form-action 'none'`。`connect-src 'none'` 意味着即便注入脚本也无法外联；**不要为加图标放宽 `img-src`**——三个 webview 的 `localResourceRoots` 都是 `[]`，放了也拿不到本地资源。
- **DOM 构造**（`src/panel/dom.cjs`）：只用 `createElement` + `textContent`；`element()` 对危险属性**直接抛错**，拒绝清单按小写比较：`href`、`src`、`srcset`、`action`、`formaction`、`srcdoc`、`data`、`poster`、`background`、`xlink:href`（`data-*` 自定义属性不受影响）。
- **入站消息**：只认显式 `type ===` 白名单，未知类型忽略，字段逐个校验。
- **外链**：`openExternal` 只接受已校验快照的 `releaseUrl`，不接受 webview 传入的任意 URL。
- 纪律：以上不变量只在 `src/panel/**` 与对应测试里；任何放宽必须在同一改动里补测试，否则属静默降级。
