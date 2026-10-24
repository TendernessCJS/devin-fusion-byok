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
- `updateProxy` 是独立路径：凭据只出现在 CONNECT 头，面板只回显掩码。
