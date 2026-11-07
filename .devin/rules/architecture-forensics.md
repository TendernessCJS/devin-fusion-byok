---
trigger: model_decision
description: "Apply when touching module ownership/activation coupling, host-builds snapshots, or the LS/ACP injection boundary measured against the shipped Devin artifacts — the evidence behind architecture-boundaries.md."
---
# 架构与出厂产物核对（architecture-forensics）

## 激活层耦合度量（2026-10-26 架构审查）

- **`shared` 现在只剩 10 个槽**（清单见下条）；「41 槽 / 66 写入点 / 226 访问点 / 跨 7 文件」是拆分前的旧快照，2026-10-28 复核已不成立，**别再用**。
- **只有 1 个槽被 ≥2 个文件写**：`backendStatus`（`commands` + `enable`）。其余 9 个都是单写者 ⇒「installer 互写对方的键」只在这一点成立，耦合的真实形态是**晚期绑定的 service locator**（读点全在回调内，install 阶段不取值），所以安装顺序并不像最初判断的那样脆弱。
- 归属分组（2026-10-26 已按此落地）：`deps.stores.nativeCatalog` **22 槽**（owner `catalog-sync`）、`deps.stores.cacheSync` **3 槽**（owner `cache-sync`）、`deps.stores.acpObservation` **2 槽**（**owner 是 `enable`**，读者才是 `cache-sync`+`panel-install`——正因写者在外，它不能并进 cacheSync 私有状态）、`deps.stores.panel` **4 槽**（`statusBar`/`updateStatusBar`/`manager`/`contextObserver`，owner `panel-install`，`extension.cjs` 的 catalog-changed 钩子只读 `updateStatusBar`）；仍在 `shared` 的 **10 槽**：`commands` 的 4 个函数槽、`management` 1、`backendStatus` 1、continuation 2、`ensureEnabled`/`disablePromise` 2。
- 测试伪造规模（拆分成本的主项）：只有 **2** 个测试文件实质构造 `shared`——`native-models-sync`（12 槽）与 `activation-sync`（3 槽）。行数不记，变化太快。
- 失效判据分布：`enable.cjs` 有 **5 处** `superseded(lifecycle, config, generation)`（**3 处字面相同**，第 5 处在 auth hook 的 `isEnabled` 回调）；`catalog-sync` 同样按 generation 校验。**刻意不记 file:line**——旧记录在 2026-10-28 复核时已全部指错行。
- **历史判断已推翻**：曾认为「禁用发生在 enable 写入段的 `await` 期间时，写入仍会完成、teardown 会按 receipt 自愈还原」——75222e4 与后续收口已证明 receipt **不提供异步顺序**（恢复 snapshot 先取、在途写入后落，receipt 已被清空），现由 `managed-settings.cjs` 的 `critical`/`drain` 保证顺序，恢复**必须重读**设置与 receipt。
- 本次审查的两处误判（已更正，别再重复）：① `catalog → runtime` **不是**层方向倒置，`port.cjs` 留在 `runtime/` 才能待在 backend 闭包内；② `goal/controller` 与 `auto-continue` **不是**「补丁 + 状态机」混排——前者本身就是 store/状态机（补丁在独立文件 `goal/continue-hook.cjs`），后者没有替换式补丁（走 `loadAcpApi`），它真实的混排是「错误文本匹配器 / 连接挂载 / 续跑状态机」三件事。

## 宿主激活关联与磁盘源码快照（host-builds）

backend `sourceId` 只覆盖 backend require 闭包；宿主侧改动（`activation/`、`panel/` 等）**不会**改变它，因此**不能**用它判断宿主代码新旧。

宿主每次 `activate()` 会写一条**按激活实例**的记录 `<globalStorage>/host-builds/<pid>-<instanceId>.json`：`{ id, files, version, extension, writtenAt, pid, instanceId, activatedAt, kind: 'disk-source-snapshot', recordFile }`。`id` 是对 `src/**/*.cjs` 的路径+内容 sha256（`node_modules`/`.git` 忽略），`files` 是参与哈希的文件数。同 PID 多次激活各写各的、互不覆盖；`recordFile` 是相对 globalStorage 的路径，日志 `host-build` 事件同字段，可把记录关联到具体 output channel/进程。

读法：从当前窗口 output channel 的 `host-build` 事件取 `pid` + `instanceId` + `recordFile`，对照同 pid 进程的启动/`activatedAt` 时间，再读该条指定记录——**不要**按目录全局最新排序挑（可能选到另一窗口的记录）。**撤回旧判据**：单看 `writtenAt` 与 vsix mtime 先后**不充分**——它只是磁盘快照（`kind: 'disk-source-snapshot'`），证明的是激活时磁盘上是哪份代码，不等于已加载模块的绝对证明。旧的单例 `host-build.json` 是遗留用户文件，不作清理，也不得再当验收判据。

它是**诊断用**身份：不参与 backend 重启判定，也不得混入 `SOURCE_FILES`。

## LS/ACP 注入的边界（2026-10-26 出厂产物核对）

- **`http.request` 的补丁是扩展宿主级共享，不是「每个扩展一份」**：扩展宿主只拦截 `vscode`（外加 `open`/`opn` 与 ripgrep 别名），`http` 走 Node 内置的进程级缓存，因此 `ls-injection` 的包装对**所有**扩展生效。`vscode.windsurfLanguageServer` 是 per-extension 对象（每扩展一份 `_apiFactory` 结果），所以 `setPort`/`setChildLanguageServerInfo` 的包装精确，`http.request` 的不精确。后果：兜底心跳探针可能被后装的第三方包装遮蔽（`status.httpHook === 'shadowed'`，一次性 `ls-http-hook-shadowed` 事件），主路径（`setPort` 重发桥端口）不受影响。**不要把「只影响原生扩展」当作改写 `http` 的前提。**
- **本地 connector 的 transport-down 状态是 `reconnectingMaxDelay`**：基类 `transportDownStatus()` 对本地恒返回它（进程退出与握手失败都走），只有 `RemoteAcpConnector` 才覆写成 `disconnected`；真实状态集合为 `connecting|connected|reconnecting|reconnectingMaxDelay|disconnected|disabled`，**没有 `disposed`**。插件只挂本地 connector，终态匹配漏掉 `reconnectingMaxDelay` 会让 agent 崩溃后的定时器与会话状态不回收。
- **ACP 注入只能覆盖「安装之后」的注册**：`createAcpRegistry` 包的是 `api.registerConnection`，既有 connector 在扩展宿主私有的 `_connectors` Map 里、外部无法枚举。激活顺序不利时三层全部静默失效（面板停在 `waiting`），因此注册表在首个 layer 装上后 30 s 内没有任何 attach 时记一次 `acp-attach-missing`。
- **UI 侧不持久化 worktree LS 端口**：`_saveWorktreeLsGroupInfo` 只存 `parentWorkspaceUri`/`worktreeUri`/`creationTimestamp`，这是桥端口（每次会话随机）不会写进跨窗口状态的**当前**原因。若该字段集合将来加入 `port`，恢复路径会连到已死的桥端口——改 `setChildLanguageServerInfo` 附近代码前先核这条。
- **远端支持的锚点曾整段失效**：`windsurf-remote-openssh` 的 manifest `main` 是 `./dist/extension`（无 `.js`），而 `windsurf-remote-wsl` 与 `windsurf` 都带；`createRequire` 拿这个字面路径当锚点时宿主不补扩展名，抛 `ENOENT … access`，`installRemoteSupport` 直接抛错 → `manager` 恒为 null → 远端窗口的 `ensureCurrentRemoteWindowTunnel()` 只会 reject。0.6.0/0.6.1 的远端支持因此**从未装上**，而日志只有一条无信息量的 `remote-support-unavailable`。定位靠本地窗口的 `remote-support-probe`（装一次即拆、`isEnabled: () => false`）：失败时它带 `code`/`message`，成功时记 `installed: true`——后者是「本机宿主可被进程级包装」的唯一实测判据。
