---
trigger: model_decision
description: "测试口径的带日期实测与事故记录，非契约——契约与纪律在 testing-notes.md。"
---

契约与纪律在 `testing-notes.md`；本卷只放证据，判据以契约卷为准。

## 契约卷移入的实测片段（2026-11-27 逐字搬移）

### ppid 误判事故（2026-10-14）

`ps | grep` 的 ppid 正好是 CLI 的 `exec` 父进程——像「CLI 派生了 backend」，曾据此误判不存在的孤儿 backend。

### `settle(n)` 实测

fixture 的 `settle(n)` 只排空微任务与 `setImmediate`，不会让 `setTimeout` 触发——实测 20 轮后 `setTimeout(0)` 仍未执行；`extension-lifecycle` 的推送用例就这样脆弱过一轮。

### fixture 绝对路径改造（2026-10-18）

扩展 fixture 的桩改按「解析后的绝对路径」匹配，改造完成于 2026-10-18，实现见 `test/helpers/sandbox.cjs`。

### 共享立即定时器竞态

实测共享立即定时器会引入 goal 调度竞态（`missing-report` 误杀 `disabled` 状态）——这是 `goal/controller.cjs` 等必须保持真实定时器的原因。

### realm 保真度逐处核查（2026-10-18）

非桩模块（`goal/controller.cjs`、`panel/controller.cjs`、`catalog/augment.cjs` 等）现运行于 VM realm 内（此前真实 realm）。全仓 17 处 `instanceof` 分两类，**都不构成隐患**：① 两侧同 realm（如 `activation/errors.cjs` 的 `RuntimeError`、`catalog/*` 之间的 Set）；② 落在被桩替换的模块里（`panel/manager.cjs` 的 `allowedUids instanceof Set` 在 fixture 里从不真跑）。

### 0.3.49 真实窗口验收（2026-10-18，验收清单保留以便下次照抄）

- **protocol + activation 拆分的真实窗口验收已于 2026-10-18 在 0.3.49 完成**，验收清单（保留以便下次照抄）：
  `ready` 仅出现 1 次；`activated` 含 `nativeVersion`；`ls bridge ready N -> M`；backend 进程路径指向新版本目录；
  `runtime-control.json` 的 version/sourceId/rootId 三方一致；monitor 有 HTTP 200 且日志无 `error`/`unhandled`；已安装 `src/` 与仓库 `src/` 逐字节一致（`diff -rq`）；
  真机确认 Fusion（BYOK lead + 官方 sidekick）可选可跑。
  **两个验收时别误判的现象**：① 重载后出现一次 `backend-adopted`（旧名 `startup-error code:port_in_use`，名字误导且已改）是**良性接管**——`backend.cjs` 对 `EADDRINUSE` 记日志后 **exit 0**，宿主握手探到同
  `service` 即采用已在跑的那个（`ppid=1`，跨重载存活是本意）；② 流式超时修复的判据在**宿主输出日志**
  （`~/Library/Application Support/Devin/logs/*/window*/exthost/output_logging_*/1-Devin Fusion BYOK.log`）；`runtime.log` 的超时条目早期不带 `rpc`、现带 `rpc` 与 backend 注入的 `peerPort`（改前 10 分钟 30 条 `phase:body`，改后 0）。
  **预期副作用**：protocol 三个新文件进 `SOURCE_FILES`，`sourceId` 必变，首次重载 backend **重启一次**——新代码生效的
  正确行为，勿误判为重载循环（判据仍是 `ready` 只出现 1 次）。

### `sourceId` 实测（2026-10-25，连踩两次）

Devin 安装器重写安装副本的 `package.json`（tab 缩进 + 追加 `__metadata.{installedTimestamp,size}`；实测 1,969 B → 1,898 B），同一份源码两处的 `sourceId` 必然不同——实测仓库 `1ee28376…` vs 安装 `cfd7ed28…`。

### Goal/Fast Context 验收范围决定（2026-10-16）

两者是上游自带、上游验证过的额外功能，本机不使用，该范围决定于 2026-10-16 做出。

### SDK 契约测试史

`test/sdk-contract.test.cjs` 2026-10-16 加；同日扩展四条 Responses 契约，四条均已变异验证（逐个改坏 `.refs` 对应行 → 恰好该条失败 → 逐字节还原），基线 `skipped 0`。`.refs` 基线（2026-11-24 更新）：`@anthropic-ai/sdk 1.13.0`（tag `sdk-v1.13.0`）、`openai 7.63.0`（tag `v7.63.0`）。

### 变异法实测（2026-10-16，3/3 命中）

把源码临时改坏（删 `pause_turn` 映射、从 `EFFORTS` 删 `max`、让 `tool_choice` 丢 `any`）后逐个跑该文件，恰好对应的那一条失败，再逐字节还原。

### 挂 3 天的 `npm test` 事故（2026-10-18）

`lsof -p <pid> -a -d 1,2` 显示 fd1/2 是 `PIPE` 且 `SIZE/OFF` 恰为 **16384**，即管道缓冲满、进程阻塞在 write；成因是工具调用结束后**读端消失**，而 `node --test` 仍在写 TAP 输出。特征是四层进程全 `S`、0% CPU、**无子进程**、`fd0=/dev/null`。

### `authenticate` 返回 `{}` 实测（2026-10-18）

只带 `api_server_url`、不带 `api_key` 时 CLI 走 PKCE 分支并同样返回空结果，全程零网络。

### `real-picker.json` 捕获史

捕获于 2026-11-09（来源记在文件内 `source` 字段）。**2026-11-09 重捕**：uid 与 3.12.17 快照完全相同（11+11 条，uid/label/各维 order 一字未变），唯一实质变化是补记 family 各维 `controlType`——重捕不是追变化，是让夹具不缺真机字段。**2026-11-10 复验**：11 条原生条目在 3.12.43 实时目录 label/name 逐字一致、零缺失，故未随版本重捕。

### 其他事故记录

- `test/goal-idle-regression.test.cjs` 的旧 ACP 模块 skip 缺口系 2026-11-09 初检发现。
- `:\s*(?!...)` 的前瞻顺序坑在本仓同一守卫上踩过两次。
