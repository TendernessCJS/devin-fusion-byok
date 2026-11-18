---
trigger: model_decision
description: "改 config.json 读写、面板提交、损坏恢复或受管设置写入串行边界时必读"
---

# 配置与存储纪律

`config.json`（`<globalStorage>/local.devin-fusion-byok/config.json`）是唯一权威配置。
多个扩展宿主（多窗口）共享同一文件：原子 rename 只保证文件完整，不保证跨进程事务——
两个进程各「读→改→写」时后写者会静默覆盖前者（已实测复现）。

## 写入契约（`src/config/store.cjs`）

- **所有 config.json 写入必须走 `updateConfig(file, mutator)`**。禁止直接
  `fs.writeFileSync`（`config/config.cjs` 已不再有写函数；远程模型发现在
  `src/models/discovery.cjs`，错误契约在 `src/models/discovery-error.cjs`）。
- `updateConfig` 内部顺序：`<file>.lock` 排他锁（`wx`+fsync，含 `{pid,time}`）→ 读最新文档 →
  mutator → `doc.configRevision = revision + 1` → tmp+fsync 写新文档 → 旧字节完整写
  `<file>.bak`（tmp+fsync+rename）→ rename → 目录 fsync（失败忽略）→ 释放锁。
- mutator 返回 `false` 表示无变化：不写文件、不推进 revision、`changed:false`。
- 锁竞争：`Atomics.wait` 同步退避 5–20ms，默认 `timeoutMs` 3000，超时抛 `config_busy`。
  陈旧锁（pid 已死 / 锁龄 >30s）每次调用最多抢一次，且只在内容未变时才 unlink。
  **空/不可解析的锁只按 mtime 判陈旧（>30s）**——持有者可能在「建文件→写 payload」窗口内，
  绝不因内容为空立刻抢占。
- 写失败统一 `config_write_failed`（`cause` 保留原始错误）；`ENOENT`/`config_corrupt` 原样透传。
- **mutator 必须是同步纯函数**：在锁内执行，里面 await/回调都不会有真正的互斥。

## `configRevision`

- 加性字段：存在即递增，缺失视为 0；旧文件首次写入即从 1 开始。
- **任何 mutator/合并逻辑都不得读改它**——`applyKeyDelta` 对它恒跳过。
- 它是提交门控与观测标记，不是乐观锁：`updateConfig` 不校验提交时 revision 是否等于读取时
  （互斥靠锁，不靠 CAS）。
- **它不是跨恢复单调的计数器**：从 `.bak` 恢复后按加性语义从 1 重新开始——恢复路径必须把
  `.bak` 里自带的 `configRevision` 剔除（extension.cjs 用解构剔除），不得用它判断「数据新旧」。

## 合并语义（`applyKeyDelta`）

面板提交（`panel-install.cjs` 的 `write`）不是整文件覆盖：`manager` 的 `apply` 在读后立刻
`baseline = structuredClone(config)`，提交时 `applyKeyDelta(doc, next, baseline)` 只把
**本次操作实际改动的顶层键**应用到最新文档——baseline 与 next 深度相等的键视为未触碰并跳过
（保留另一窗口刚写入的外部值），next 中删除的键从 doc 删除。

## 损坏恢复顺序

1. `extension.cjs` 激活时 `readDoc` 抛 `config_corrupt` → `recoverFromBackup`：`.bak` 可解析则
   把坏文件改名 `config.json.corrupt-<时间戳>` 留证，`fromEmpty:true` 重建并警告用户。
2. `.bak` 不存在或同样损坏 → `archiveCorrupt` 归档坏文件后 `fromEmpty:true` 写
   `defaultConfig()` 并告警。两条恢复路径**都会**把损坏文件归档为 `config.json.corrupt-<时间戳>`。
3. 非 `config_corrupt` 异常照旧上抛，不做兜底。

## 已知残余限制（不要在补丁里「顺手修」）

- **同一顶层键的并发编辑仍是 last-write-wins**：`applyKeyDelta` 的粒度是顶层键，两个窗口同时改
  `providers` 数组时后提交者覆盖先提交者；深层合并不在本层解决。
- `updateConfig` 不做乐观并发校验：跨进程互斥完全靠 `.lock`，revision 仅用于观测与诊断。
- 锁文件进程崩溃会残留，靠 stale 判定自愈；`config_busy` 超时应视为可重试，不要静默吞掉。

## provider baseUrl 有意不做 SSRF 限制

- 面板提交的 baseUrl 允许任意 host（含 localhost 与私网）——这是 BYOK 的设计意图（Ollama / 本地网关）。
- 限制只到「scheme 必须 http/https、禁止内嵌凭据/查询串/片段、路径归一化」，**不阻止**向任意地址发带凭据请求；收紧前先想清它会让本地部署不可用。
- 更新与 Devin 上游只共享显式代理策略来源，不共享全局 Agent；代理凭据只进入 CONNECT，不回显面板。旧版存储不会自动迁移：空目录建立新安装标记；无标记的非空目录在读取配置或启动宿主服务前拒绝，不自动删除或改写旧文件。

## 受管设置的写入/恢复串行边界

`settings-owner.cjs` 的 env 与 preference 事务共用 `managed-settings.cjs` 的单实例串行队列：**读取当前设置与 receipt → 计算原值 → 保存 receipt → 更新 globalState → 写设置**全部在入队函数内，不能只排队最后一次写入。入队和实际执行前都复核 `live`；关闭后拒绝新项，已排队未开始的项按 epoch 取消，已经开始的项允许完成。`open()` 不能复活旧 epoch 的项。被取消时抛 `RuntimeError('cancelled')`；不要在 critical 内嵌套并等待另一个 critical。UI publish 不占排水预算。

- CLI 环境由 `activation/cli-environment.cjs` 的纯构造器生成，代理来源复用 `readProxySettings`，不得重新读取合并工作区后的配置。backend 接受的代理快照通过 `applyEnvironment(proxyConfig)` 在内存中传入，排队时不能重读成更新但尚未被接受的配置；含代理地址的快照不进日志或 receipt。
- 有代理时，合并策略绕过项、用户原 `NO_PROXY`/`no_proxy` 与回环，两种拼写写为同值；不写 `HTTP(S)_PROXY`。每次从 receipt 的 original 重建，不能累积先前合成值。receipt 已有记录时原值权威，legacy `savedEnv` 只补缺；用户中途改值时更新备份，停用仍按 compare-and-restore 恢复。无代理时撤回仍由插件持有的绕过键。

- `disable()` 顺序：置 `enabled=false` → `drain()`（5 s 上限，超时记 `managed-settings-drain-timeout`）→ `teardown` → 恢复。恢复**必须重读**当前设置与 receipt——这是修复成立的机理：在途写入先落地，恢复再基于落地后的状态回滚。
- `deactivate()` 同样先关闭并排水写队列，再 teardown；只有识别为宿主禁用时才恢复设置，且恢复放在 finally 中。普通 reload/quit 保留共享设置和 backend，不借此重启或终止其他窗口。
- drain 超时**仍照常恢复**（best-effort），但跳过 `receipt.changes` 清空与 `savedEnv`/`managedEnv` 清除（`keepReceipt`），给下次停用保留补偿依据；此时**不得提示成功**——面板 warning 明示「恢复尚未确认，已保留恢复记录」，runtime session 的 deactivate 恢复段记 `host-disabled-settings-restore-pending` 而非 `restored`。
- **撤回旧判断**：「停用期间写入仍会完成、但 teardown 会按 receipt 还原」是错的——receipt 只提供回滚依据，**不提供异步顺序**；没有 drain 时恢复的 snapshot 先取、在途写入后落，受管值会残留且 receipt 已被清空。
- 边界：这只保证**单窗口内**的顺序；跨窗口并发写同一 globalState 不在本机制范围内；超时后的残留靠下次停用补偿，不做自动修复承诺。

## 配置副作用收敛

面板 `afterChange` 与文件 watcher 共用 `config-sync.cjs` 的 reconcile 入口：Goal 有效开关关闭时在任何 await 之前 suspend，自动继续标志仅在实际变化时 reset，重复通知不重复执行这两种副作用；重新打开 Goal 不自动恢复旧运行。后续 runtime/selection 工作按 revision 与 disposed 判据放弃过期结果。watcher 读取失败只记安全日志，面板等待的失败必须上抛；publish 失败不得把已提交的配置误报成写入失败。
