---
trigger: model_decision
description: 自动继续（auto-continue）的实测依据与判据——`session_info_update` 与权限弹窗两次被当中途信号误作废的真机事故、为何最终降级为纯诊断、排查顺序与残留待定项；改 `auto-continue.cjs` 的资格判定或排查「该续没续」时必读
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

修复（同日）：`session_info_update` 只更新 `turn.sessionInfo` 最新观测态，续跑资格在 resolve/idle 两处按最新态判定（仍置位 → `decision: stop`、`reason: session-info`；已清除 → 正常判定）。`finishedOutcome`（`completed`/`stopped`/`suspended`/`expired`）仍走原永久路径；标记到达时若续跑已排队（`turn.consumed`），仍取消定时器、结算并删会话。（该「最新态门控」于 2026-11-05 进一步降级为纯诊断，见下节。）

## 2026-11-05 权限弹窗被当成终态：真机命中与修复依据

- 会话 `harmonious-hygienic`（tinycast）：本轮 07:58:49 开始，07:58:52.307 收到权限请求（原生 `perm_level=AcceptEdits`），插件当场作废该轮；原生侧用户 07:59:01 批准（`ApproveOnce`），本轮继续跑到 08:05:52（423 秒）停在 `max_turn_requests`，`auto-continue-evaluated` 只能记 `decision: untracked`、`reason: session-gone`，没有续跑。
- 窗口 9 的 ACP 日志：切换点前 31 次 `prompting user`，切换后 0 次；切换点是 08:05:49.607 的 `grant=ModeChange(Bypass)`。
- 全量日志统计：34 次 `session-info-observed` 全是 `action:true`，`action:false` 出现 **0 次**（清除更新从未到达）；26 次 `auto-continue-disqualified` 全是 `permission`，`state`/`reset-method`/`session-info` 各 0 次。
- 同类第二次命中：2026-11-04 13:58:02 本地，本轮 12.9 分钟，权限请求在本轮开始后 15 秒到达。
- 结论：权限弹窗与 UI 标记是**中途信号**——已观测到用户批准后该轮持续推进（423 秒），旧信号不能永久作废该轮；但不声称所有结束都一定无未决交互。修复：权限/elicitation 类请求到达只记 `auto-continue-permission-observed {method, queued}`，仅在续跑已排队（`queued:true`）时撤销定时器、结算并记 `auto-continue-disqualified`；`session_info_update` 的 `action`/`disabled` 同样降级为纯诊断（照旧写 `session-info-observed`），只在续跑已排队时撤销。`finishedOutcome` 与 v2 `state_update` 终态分支不变。

## 排查「该续没续」的顺序

1. 先看 `auto-continue-evaluated` 的 `stopReason`/`decision`/`reason`——只有 `max_tokens`/`max_turn_requests` 可续，`end_turn` 是正常收尾。
2. `decision: untracked` + `reason: session-gone` 说明这一轮在结束前被移出跟踪表：查同会话更早的 `auto-continue-disqualified`。
3. `reason: session-info` 已**不再出现在 `auto-continue-evaluated`**（2026-11-05）：`userActionRequired`/`inputDisabledReason` 只是客户端问用户时的 UI 标记，且清除更新从未被观测到，不参与资格判定。`auto-continue-disqualified reason=session-info` 只剩两种写法：`finishedOutcome` 终态（`trigger: outcome`），或标记到达时续跑已排队（`trigger: action-required|input-disabled`，撤销已排队的定时器）。空截断仍记 `truncated-empty`；诊断用的计划进展比较必须无副作用，不得为归因额外触发 `plan-no-progress`。
4. `session-info-observed` 只在 `action`/`disabled` **发生变化**时写一次，不含正文与 id；它取代了此前只能从 `session-gone` 反推的做法。

## 事件字段（本卷持有，契约卷只留事件名）

- `auto-continue-evaluated`：固定 14 字段，`decision` = `error-retry`/`plan-retry`/`stop`/`untracked`；`reason` 的取值集合见契约卷（不再含 `session-info`）。
- `auto-continue-permission-observed`：`{method, queued}`，权限/elicitation 类请求到达时写一次；只有 `queued:true`（续跑已排队）才伴随 `auto-continue-disqualified reason=permission`，运行中的轮次只观测不作废。
- `auto-continue-disqualified`：`reason` = `permission`(`method`) / `state`(`state`,`stopReason`) / `reset-method`(`method`) / `session-info`(`trigger` = `action-required`|`input-disabled`|`outcome`) / `new-prompt`。`session-info` 只在两种情形写：`finishedOutcome` 终态，或标记到达时续跑已排队（定时器存在 → 撤销并记 `trigger`）。
- `session-info-observed`：`{action: boolean, disabled: boolean, outcome: enum|null}`，仅在 `action`/`disabled` **发生变化**时写；不含正文、id 或标记原值。

## 统一决策 vs 执行边界（重构说明）

`decideContinuation(facts)` 是唯一资格判定：输入只有快照 primitive（enabled/suppressed/retryDisallowed/开关/匹配布尔/stopReason/textChars/toolCalls/hasPendingPlan/planProgressed），输出 `{decision, reason, stalledPlan}`，无 turn 引用、无日志/计时器副作用。三个入口（v1 resolve、v1 reject、v2 `state_update` idle）各保留原位生命周期 guard（disposed/active/turn 归属/generation/stopReason 缺失/cancelled/refusal），guard 通过后统一走 `evaluateTurn` 归一化事实。边界：reject 仍只认 generic（含可选句号）/timeout 原文，不拓宽到尾部匹配，也绝不进 plan 链；`plan-no-progress` 的 `auto-continue-stopped` 副作用在编排层（stalledPlan 时恰好一次）；`scheduleAuto` 的次数/时间预算、结算、合成乐观消息全部留在执行层，不进纯判断。

## 残留（未定，不要据此直接改行为）

- v2 `state_update` 的 `requires_action`/`refusal`/`cancelled` 仍是取消因子，真机 0 次命中（2026-11-05 全量统计），暂不动；若复现显示 `requires_action` 同样是中途信号，再按权限弹窗的先例讨论。
- **已结案**：「标记从未被清除、但该轮明明还在推进」的复现条件已于 2026-11-05 满足（34 次置位、0 次清除 + 本轮 423 秒继续推进），`action`/`disabled` 已从最新态门控降级为纯诊断，见上节。
