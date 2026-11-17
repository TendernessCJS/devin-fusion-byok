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

## 准入层在 f7 之上（2026-11-17 实测）

`GetCliTeamSettings` f7 只是**用户侧白名单**；服务端在更上层还按账号准入（plan / billing / 区域）过滤 `model_configs` 与
`GetUserStatus`，所以 **f7 加宽不会造出原生目录里没有的条目**（交集上限 = 原生集合）。判定 `restricted` 时不要直接归因
「团队/组织限制了模型」：`allowedKind=restricted` 与「存储白名单为空」可以同时成立，此时限制来自准入层，页面上那个
`Reset settings` 是空操作。判据与取证方式见 `model-entitlement-forensics.md`。
