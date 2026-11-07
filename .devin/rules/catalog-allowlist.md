---
trigger: model_decision
description: "改 allowlist 三态判定、双通道去抖或 restricted→unrestricted 提交时机时必读。"
---
# allowlist 三态与放行链路（catalog-allowlist）

## allowlist 三态与 restricted→unrestricted 链路

`collectAllowedUids` 返回三态：`{kind:'restricted',uids}` / `{kind:'unrestricted'}` / `null`（非该 RPC 或形状坏）。
proto3 repeated 无法区分「存在但空」与「不存在」，**空是弱信号**，**两条通道各自 N=3 去抖**：
宿主 `observeAllowedUids` 与 backend 原始观测 `onObservedAllowedUids`（`allowedEmptyStreak`）都要连续 3 次
unrestricted 才翻转，反向 restricted 单次立即恢复；**从未建立受限权威的宿主不因空 streak 翻转，只能经
backend 冷启动回显采纳**。bridge 对 GetCliTeamSettings **每请求恰好通知一次**，任何失败（非 200/坏 JSON/
断连/超时/客户端取消）通知 `null` 并打断连续计数。**确认提交（control POST / 已去抖判定）直调
`onAllowedUids` 立即生效并重置原始空计数，不再等 3**；unrestricted 时 `allowedUids` 为空仍要推，但
models 必须非空（空 payload 不推），POST 的模式校验在 ingest 之前。旧缓存缺 `allowedMode` 键=restricted。
