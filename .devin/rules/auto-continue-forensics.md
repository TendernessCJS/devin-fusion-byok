---
trigger: model_decision
description: 自动继续（auto-continue）的实测依据与判据——`session_info_update` 取消资格的实测时间线、为何改成最新态门控、残留待定项；改 `auto-continue.cjs` 的资格判定或排查「该续没续」时必读
---

# 自动继续取证（auto-continue-forensics）

契约（不变量、预算、事件字段）在 `runtime-and-injection.md`；本卷只放**实测依据与排障判据**。

## 2026-10-31 `session-info` 永久取消资格：真机命中与修复依据

日志：`~/Library/Application Support/Devin/logs/20261031T161749/window1/exthost/output_logging_20261031T161751/1-Devin Fusion BYOK.log`（时间为 UTC）。

| 时间 | 事件 |
| --- | --- |
| 08:24:47 | `auto-continue-evaluated` → `max_turn_requests`、`decision: plan-retry`，08:24:49 `auto-continue-fired`（续跑机制正常） |
| 08:28:38 | `auto-continue-disqualified reason=reset-method method=session/cancel`（用户主动取消，判定**正确**，必须继续永久作废） |
| 08:35:34 | `auto-continue-disqualified reason=session-info trigger=action-required outcome=null` |
| 08:45:09 | `auto-continue-evaluated` → `max_turn_requests`、`retryDisallowed: true`、`hasPendingPlan: true`、`planUpdates: 1`、`pendingItems: 4`、`decision: untracked`、`reason: session-gone`、`durationMs: 588830` |

已观测事实与证据边界：

- 08:35 被判永久取消资格后，该轮**又连续工作约 9 分 49 秒**并产生计划进展（`planUpdates:1`、`pendingItems:4`），最后撞请求预算。这证明旧取消资格分支没有阻止原轮继续工作；日志未记录标记的清除序列，不能据此确认标记何时清除或具体的用户确认流程。
- 该轮 `permission` / `state` / `reset-method` 一次都没触发；唯一原因是 `session_info_update` 分支既置 `retryDisallowed` 又删会话，于是 10 分钟后的 resolve 只能读到 `session-gone`。
- 旧分支会让仍在推进的原轮永久失去自动继续资格；已批准改为最新观测态门控。客户端是否发送清除态仍需新诊断 `session-info-observed` 的真机序列验证，不把「用户批准后清除」当成已观测事实。

修复（同日）：`session_info_update` 只更新 `turn.sessionInfo` 最新观测态，续跑资格在 resolve/idle 两处按最新态判定（仍置位 → `decision: stop`、`reason: session-info`；已清除 → 正常判定）。`finishedOutcome`（`completed`/`stopped`/`suspended`/`expired`）仍走原永久路径；标记到达时若续跑已排队（`turn.consumed`），仍取消定时器、结算并删会话。

## 排查「该续没续」的顺序

1. 先看 `auto-continue-evaluated` 的 `stopReason`/`decision`/`reason`——只有 `max_tokens`/`max_turn_requests` 可续，`end_turn` 是正常收尾。
2. `decision: untracked` + `reason: session-gone` 说明这一轮在结束前被移出跟踪表：查同会话更早的 `auto-continue-disqualified`。
3. 有 `reason: session-info` + `decision: stop`：那是**当时仍置位**的最新态门控，不是永久作废；看 `session-info-observed` 的 `{action,disabled}` 序列即可确认是「一直没清除」还是「清除后仍被挡」。`session-info` 只在门控确实是决定因素时才记——同一轮若因开关关闭、`stopReason` 不可续、空截断或计划无进展而不续，分别记原有原因或 `null`（2026-10-31 补全；之前即使这些门先决定，也可能误记 `session-info`）。诊断用的计划进展比较必须无副作用，不得为归因额外触发 `plan-no-progress`。
4. `session-info-observed` 只在 `action`/`disabled` **发生变化**时写一次，不含正文与 id；它取代了此前只能从 `session-gone` 反推的做法。

## 事件字段（本卷持有，契约卷只留事件名）

- `auto-continue-evaluated`：固定 14 字段，`decision` = `error-retry`/`plan-retry`/`stop`/`untracked`；`reason` 的取值集合见契约卷（含 `session-info`）。
- `auto-continue-disqualified`：`reason` = `permission`(`method`) / `state`(`state`,`stopReason`) / `reset-method`(`method`) / `session-info`(`trigger` = `action-required`|`input-disabled`|`outcome`) / `new-prompt`。`session-info` 只在两种情形写：`finishedOutcome` 终态，或标记到达时续跑已排队（`turn.consumed`）。
- `session-info-observed`：`{action: boolean, disabled: boolean, outcome: enum|null}`，仅在 `action`/`disabled` **发生变化**时写；不含正文、id 或标记原值。

## 残留（未定，不要据此直接改行为）

若后续复现显示「标记从未被清除、但该轮明明还在推进」，才需要讨论把 `action-required` 完全移出取消因子（而不是最新态门控）。届时必须有 `session-info-observed` 的清除序列缺失 + `auto-continue-evaluated` 的 `pendingItems` 进展作对照，单凭一次 `session-gone` 不足以判断。
