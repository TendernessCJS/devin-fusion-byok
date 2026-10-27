---
trigger: model_decision
description: "Apply when changing module ownership, the src/runtime partition, protocol/ responsibilities, root facades, or the test/architecture.test.cjs guards — the measured topology facts behind the dependency guards."
---

# 架构边界与模块拓扑（从 runtime-and-injection 拆出）

模块归属、分区判据、根门面与依赖守卫的实测描述；行为约束仍在 `runtime-and-injection.md`。

- `SOURCE_FILES` 已**不再是手工清单**（R2b-1）：`runtime/source-identity.cjs` 加载期从 `backend.cjs` 字面量 require 图推导哈希输入；`backend.cjs`
  转导出旧导出面，客户端（`native-models`/`monitor-client`）改依赖 `contract.cjs`+`port.cjs`+`retry.cjs`，`backend-handshake` 用 `source-identity` 做
  fresh 检查。**backend 闭包禁止动态 require**（非字面量 specifier 让推导抛错、起不来）；新模块被正常 `require` 即自动进哈希。
  `test/architecture.test.cjs` 禁绝 backend 闭包进宿主/UI/发现/更新模块并查文件级循环。
- **`src/protocol/` 是多关注点的混合体，不要按目录名或文件名推断职责**（9 个文件）：① 协议转换 —— `native-chat-codec.cjs`（**Devin 侧**：解析
  `exa.chat_pb` 原生请求 + 造出站 ACP chunk）、`inference.cjs`（**三协议统一入口**：`serveChat` + `processor` 的流编排/有界降级/推理状态通道衔接；
  **不是 Responses 专用**）；它的内部职责已按协议语义拆开：`provider-request.cjs`（格式判定/端点/请求体构造，**OpenAI Chat 的请求体在这里**）、
  `provider-events.cjs`（SSE 解析/用量快照/错误详情）、`state-envelope.cjs`（状态信封前缀、`{scope, items}` 构造与其校验）、`cache-support.cjs`
  （`providerKey()`，供状态信封/缓存复用），`anthropic.cjs` 仍是
  Anthropic Messages 的独立实现。`inference.cjs` 的导出面被下游依赖（`backend.cjs` 取 `serveChat`，测试取 `buildRequestBody`/`parseEvent`/`STATE_PREFIX`），
  再拆时**保持这四个导出不变**；② 字节层 —— `wire.cjs` 是**全仓共享**的 proto 读写/framing/gzip 工具，`catalog/*`、`fast-context/`、
  `runtime/` 都直接依赖它，**不是协议专用**；③ 埋点 —— `tracker.cjs` 是计量（→ monitor），它落在 `protocol/` 是**依赖图决定而非语义决定**：为消除
  `protocol → runtime` 反向依赖才从 `runtime/monitor.cjs` 移出，**不能搬回 `runtime/`**（`runtime/backend.cjs` 本就 import `protocol/inference.cjs`，
  搬回即成环）。旧名对照：`chat.cjs → acp.cjs → native-chat-codec.cjs`、`responses.cjs → inference.cjs`——旧名正是误读源头（前者与 Chat Completions 无关，OpenAI Chat 的请求体在
  `provider-request.cjs`）。Fast Context 的 `remote-client.cjs` 反向 import `src/protocol/wire.cjs`，两条路径别混。在 `protocol/` 内增删/改名文件时，除 `SOURCE_FILES` 外还要留意**不靠 `require` 的隐式引用**（按模块名打桩的
  字符串键、`readFileSync` 的路径、`AGENTS.md` 里按路径写的说明），这类漏改不报错、只静默失效——`test/source-identity.test.cjs` 现在会兜住
  `SOURCE_FILES` 那一半（现在校验推导出的哈希集合与 `backend.cjs` 的 require 闭包双向精确相等），但路径字符串与打桩键它管不到。
- **扩展宿主编排层在 `src/activation/`**（自 725 行 `extension.cjs` 拆出，16 个 `.cjs`）：`errors`（RuntimeError/`safeError` + 叶子 `models/discovery-error.cjs`）、`settings`（`globalSetting`）、`backend-handshake`
  （`ensureBackend` + 局部 `pause`/`compareVersion`）、`catalog-sync`（原生目录观测/推送）、`catalog-publication`（桌面目录发布协调器）、`effective-origin`（解析原生派生链：
  LS `--api_server_url` → portal → 默认，含收敛窗口）、`managed-settings`（受管设置写入的 `critical()` 闸门）、`enable`
  （受管设置写入 + LS 注入 + startNativeSync）、`commands`（命令注册、Fusion 选择与 `disable` 恢复）、`panel-install`（状态栏/面板控制器）、`host-identity`（宿主构建身份）、`native-contract`（只读探针）、`liveness`（`live`/`superseded` 判据）、`cache-sync`/`config-sync`（pickerRefresh、CLI 缓存检查、配置监听/afterChange）、`teardown`。**`extension.cjs` 仍是唯一激活入口，导出面 `{ activate, deactivate, ensureBackend, safeError }`
  被测试与 `package.json` 依赖**。这些文件在扩展宿主运行、**不能进 backend 的 require 闭包**（否则宿主代码被算进重启哈希）。
  拆分时的硬约束：共享可变槽必须放进显式传递的 `shared` 对象，**不得**改成模块级单例（跨 activate 串状态）；
  `enableQueue`/`reconcileQueue` 这类序列化队列留在各自工厂闭包内；`generation`/abort 判据一处都不能少。
  改激活流程前先确认入口：全仓 **5 个入口**中 3 个（`fast-context/server.cjs`、`goal/report.cjs`、`lifecycle/uninstall.cjs`）
  从 `extension.cjs` 的 require 图走不到（清单见 `retired-and-deadends.md`）。
- **`src/runtime/` 按「谁运行」分区，判据是路径不是文件名**：根目录只留 backend 进程与两侧共享的 8 个模块（`backend.cjs`、`backend-control.cjs`、`bridge.cjs`、`contract.cjs`、`native-cache.cjs`、`port.cjs`、`source-identity.cjs`、`upstream-origin.cjs`——`upstream-origin.cjs` 是 `origin` 校验与 `DEFAULT_UPSTREAM` 的实现，激活侧与 backend 共用），**只在扩展宿主运行的模块一律放 `src/runtime/host/`**。`test/architecture.test.cjs` 按三层判据强制：`src/runtime/` 内部用根目录 8 文件白名单（fail-closed），宿主模块一律进 `host/`；`src/` 顶层用目录级 deny-list（`BACKEND_FORBIDDEN_DIRS`）；**混合目录只能在 `BACKEND_FORBIDDEN_FILES` 按文件名排除**——目前只有 `models/`（`capabilities`/`native-entry` 在 backend 闭包内、`discovery*.cjs` 是宿主专用，目录级规则表达不了）。另有顶层 allow-list 守卫：新宿主侧顶层目录必须显式加进允许集合。放错方向的代价是把「只在宿主生效」的代码算进重启哈希（并让宿主模块被当 backend 代码改动）。
- **三个根级门面的规矩**：

  | 门面 | 生产引用 | 护栏 |
  | --- | --- | --- |
  | `src/catalog.cjs` | **有**，`src/extension.cjs:7` 直接 require | 无专门测试；它是 catalog 子系统的对外入口 |
  | `src/update.cjs` | 无 | 有测试保证它保持纯门面（只转出 `update/updater.cjs`） |
  | `src/proxy.cjs` | 无 | 有测试保证**生产模块不得 require 它** |

  新加门面前先确认它属于哪一类，别让「兼容门面」被生产代码依赖。
- **`src/runtime/host/injection-health.cjs` 是宿主侧模块、不得被 backend require**：只有 `activation/panel-install.cjs` require 它，结果经共享槽以
  `readHealth()` 回调传给 `runtime/host/context-diagnostics.cjs` 与 `panel/manager.cjs`（backend 里没有任何 require）。让 backend require 它会让
  `architecture` 测试红（source-identity 派生只跟随 require 图），且会把「只在宿主生效」的代码误当 backend 代码改动。输出确定性约束见 `monitor-and-panel.md`。


- **`test/architecture.test.cjs` 是架构的权威表述**：backend 闭包 allow/deny-list、`src/runtime/` 根目录 8 文件白名单、`network/`+`update/` 的依赖上限、`proxy-config` 叶子、文件级零环、动态 require 白名单——**改依赖关系前先读它**，比读散文式文档可靠。
