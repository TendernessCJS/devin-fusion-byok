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

## provider 模型获取方式（modelsMode / modelsUrl）

- `providers[].modelsMode` 三态：`auto`（默认，baseUrl 去尾斜杠 + `/models`）、`url`（必须配 `modelsUrl`）、`manual`（完全不请求 `/models`，靠静态列表勾选或手动添加）。
- 模式是读取端唯一的门：非当前模式的键**保留在磁盘上但不生效**；只有拥有该键的模式在保存时才写或删（在该模式内清空会删除键）。理由：静态列表是昂贵的手工输入，切模式不该销毁它。
- 旧配置无 `modelsMode` 时按 `modelsUrl ? 'url' : 'auto'` 兼容读取；表单保存后落显式三值。
- `url` 模式的发现请求同时带 `Authorization: Bearer` 与 `x-api-key`（发现与对话端点解耦后网关可能只认一种；不覆盖时请求头保持原样）；只影响发现请求，不影响对话端点。
- `modelsUrl` 校验与 baseUrl 同类（http/https、无凭据/查询/片段、去尾斜杠），但**不做** `normalizeBaseUrlPath`——它是完整端点，尾部 `/models` 是路径的一部分，剥掉会让 Moonshot 这类用例退化成错误地址。
- 覆盖地址的首屏逐字请求用户填的地址、**不**追加 `limit`；只有响应自身声明 `has_more`/`last_id` 时后续页才追加 `after_id`；派生地址行为不变（`limit=1000`）。`modelsUrlHint` 已写明密钥会发往该地址。
- `providers[].staticModels`：`manual` 模式的静态模型 ID 源（1–200 条，去重、去空行）；保存时只有 `manual` 模式写或删它，其它模式保留但不生效。它是「可添加的模型 ID 源」——从列表删 ID 不删除已配置模型，也不参与发现请求；其内容并入 `signature()`，编辑后旧候选失效。
- `models[].fastModel`：基础模型指定的 fast 变体（同供应商内模型 id）。一对一（同目标不能被两个模型指定）、目标必须存在、禁止链式与自指；删除变体时其它模型上的引用静默清除。fast 目标不作 lead 候选但可作 sidekick 取值，普通模型行与 routes 保留；孪生条目按 exact effort 匹配发射，无匹配档位不发。fast 图的三处消费（角色剔除/family 合并/孪生）共用 `fastClaimsOf` 的链式与重复声明防御（手改 config 时链式塌缩为末环、重复 target 只认首个声明者）；`fastPairsOf` 在其上加启用与档位一致判据，`targetToBase` 已删。关联期间 base 的 `contextWindow`/`maxOutputTokens`/`efforts`/`effortMode`/`reasoningEffort`/`enabled` 同步到变体且每次保存重放（base 缺的键从变体删除），`enabled` 必须双向——变体行在面板隐藏，单向停用将永远无法恢复；**raw 复制后还必须比较 `modelEfforts` 有效档位**：`auto` 模式靠 id 启发式，变体 id 通常不匹配 base 的族形（`gpt-6` 推出档位、`turbo-alias` 推不出），不一致时把 base 的解析结果具象化写入变体——`[null]` 写 `effortMode:'none'`（删 efforts/reasoningEffort）、canonical `[null,low,medium,high,xhigh,max]` 写 `effortMode:'auto'`+`reasoningEffort:true`（删 efforts）、非 null 显式列表写 `effortMode:'manual'`+`efforts`；无法精确表达的形态**拒绝保存**而不是静默保留错配。取消关联不还原；变体即使 `enabled === false` 也照常发射 routes（不发模型行），孪生不依赖变体启用态；`moveModel` 的 `delta` 接受任意非零整数（面板按可见邻居距离发送）。模型行侧，链接生效且两侧档位一致时变体并入 base 的 family（同 familyUid/家族标签/成员 label/Effort 值），base 成员写 `Fast Mode {controlType:2}`、变体成员写 `{order:1,controlType:2}`，picker 只显示一行并在卡片上给出 Fast 开关；档位不一致或 base 停用则不合并。
- manual 供应商点「导入模型」时 `refreshModels` 直接以 `staticModels` 为候选（不发起网络请求），`importModels` 走同一条落盘路径，已配置条目以 `imported` 置灰；静态列表为空时以 `manager.staticSourceEmpty` 拒绝。
- **模型编辑/新增走 `saveModel` 原子动作**（`providerId`、`model`、可选 `existingId`、可选 `importCandidateToken`）：选中未导入的 fast 目标时 UI 不再单独先调 `importModels`——候选以 token 随保存提交，manager 在同一份快照上验 token/签名/候选 id 匹配 `model.fastModel`、内存追加候选、走 `modelPatch` 校验、同步 fast 链接、跑全量 `buildCatalog` 后**只经一次 `write` 落盘**；任一校验失败则导入与编辑都不持久化、`pendingImport` 保持可用，仅在候选确实被导入且提交成功后清除。旧两步流程的「编辑失败但导入已落盘」残骸不再可能发生；显式「导入模型」对话框仍走 `importModels`，开关/删除/批量仍走 `updateModels`/`addModels`。

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
