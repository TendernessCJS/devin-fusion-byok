---
trigger: model_decision
description: "Apply when changing the native auth-status catalog write, the publication confirmation chain (catalog-publication.cjs), deactivation/drain recovery, or GetModelStatuses handling."
---

# 目录写入与发布确认（catalog-publication）

`windsurfAuth.setAuthStatus` 原地改写、`catalog-publication.cjs` 的发布确认预算与 watchdog、注销/停用恢复判据、`GetModelStatuses` 结论。（自 `catalog-and-picker.md` 拆出，内容逐字未改。）

## 桌面 auth 目录面与发布确认（Devin 3.11.216 / CLI 3000.11.216）

- **写入面**：新 agent 窗口 picker 把 configOptions 与 `userStatus.cascadeModelConfigData` 按 UID 求交；
  交集缺失条目进 `catalogMisses` 被丢弃。`windsurfAuth.setAuthStatus` 的
  `userStatusProtoBinaryBase64` 是裸 `UserStatus`（模型列表在 f33），`auth-status.cjs` 在该调用处原地改写，
  与 CLI 缓存改写共用 `augmentCatalog`（LS 桥看到的则是 f1→f33 信封，`collectNativeModels` 同判别读两形）。
- **发布确认链**：`catalog-publication.cjs` 是唯一协调者——内容签名变化 → 1500ms 合并 →
  `devin.refreshUserStatus`（同时最多一个在途）。**命令完成 ≠ 确认**：只有 hook 回报的
  `applied`（已验证实际输出、带匹配签名）才可把该 emit 置 `ready`；跟踪 callId、未完成提交和启用世代，
  旧提交迟到必须保守撤销确认并按预算修复，不能把旧世代事件交给新协调器。命令锁仅由该命令 settle 释放，
  hook 确认不能提前释放；settle 后等确认 5s，自动尝试未确认再等 5s 按预算重试；
  手工尝试未确认只降级，不派生自动重试；未验证写入（nativeApplied）须撤销旧 ready。
  10s watchdog 只降级不释放锁，每签名最多 2 次、滚动 60s 最多 6 次自动尝试；
  `cleared`（注销/空 payload）→ `waiting-auth`，配置变化不解除暂停，旧调用成功也不能复活确认。
  在途期间目录又变 → settle 后立即发新签名（拒绝也不丢新目标）；手工 force 合并未发意图、
  取消旧自动计时器、绕过成功签名去重，但仍排队且不重置自动预算；注销暂停独立于 watchdog 状态。
- **停用恢复**：显式停用先 `deactivate()`（透传且仍观察）→ `drain(≤10s)` → 一次透传刷新验证
  新的非空、合法目录提交不含我方条目；注销/畸形/超时/未排空/有残余均不得判恢复成功，不回放、不登出。
  连接设置恢复与目录恢复分别报告；目录未确认不得展示无条件恢复成功。LS 清理失败也不能跳过 owned-settings 恢复。
  面板「刷新模型目录」只走 `publication.changed({force:true})`，不复用会断 ACP 的旧 picker 刷新。

## `GetModelStatuses` 结论（3.11.228 取证）

调用点是 Agent Window 会话面板（`out/vs/sessions/sessions.desktop.main.js`，60s 节流）；
`ModelStatusInfo.status` 只有 UNSPECIFIED/INFO/WARNING 三态 + message——**是提示徽标不是可用性白名单**。
因此桥**不改写响应**（已列入 `KNOWN_UNCHANGED`，不报未知目录 RPC）、缺我方 uid 无功能影响。
若哪天出现 `MODEL_STATUS_UNAVAILABLE` 之类的第四态，先取证再决定是否合成条目。
