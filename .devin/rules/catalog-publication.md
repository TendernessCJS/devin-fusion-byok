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

## ACP `configOptions` 只在会话建立时读取（2026-11-02 实测）

- agent 窗口与 Fusion 卡片的候选来自 ACP `configOptions`，它在**会话建立时**读取一次；运行期改配置不会让它重读。
  实测：停用一家供应商 + 启用一家新供应商后，`userStatus` 发布成功（`afterOwn 189 → 1080`、`phase:applied`、`nativeApplied:true`）、
  磁盘缓存也重写了（`cli-cache-refreshed` 三个文件），但宿主 output 的 `acp-models` 从 `02:02:42` 到 `02:06:27` 恒为
  `models 1123 / ownModels 90 / plain 9 / fusion 81`；重载窗口后才变成 `models 1531 / ownModels 156 / plain 12 / fusion 144`。
- **滞留层是会话目录，不是磁盘缓存**：磁盘 CLI 缓存每次配置变更都被我们重写（`cli-cache-refreshed` 三个文件，实测 `force:false`），
  它是新的；旧的是会话内 `configOptions`。把两者混说会推出错误预期（「缓存已刷新为何还看不见」）。
- **判据是 uid 是否已在会话目录里，不是「供应商是否被重载过」**：已在目录中的 uid，启用/停用、排序、角色白名单都即时生效
  （改的是 userStatus 的可见性与组合）；不在目录中的 uid，无论怎么改配置都选不到，直到新会话或窗口重载。
  反例说明粒度：一个重载时已启用的供应商，事后**新增一个模型**——那条新 uid 仍需新对话；而同一供应商下已在目录里的模型照常即时。
  两类典型观察（2026-11-02 用户实测）：①重载前禁用、重载后启用 → 等同新增，picker 不刷新；②重载前启用、重载后禁用 → 后续开关全即时。
- 面板用 `catalogDrift` 把这层暴露出来（`panel-state.cjs`：`catalog.models` 里 `isOwnUid` 的条数 vs `acpObservation.ownModels`），
  **只在 `emitted > observed` 时提示**「还有 N 个模型/组合没进入当前会话」，因为只有「新增未进目录」才真需要新对话。
  反方向（会话里还列着我们已停发的条目）**不得提示**：那些条目在 userStatus 层面已不再引用，picker 早就看不到了——
  2026-11-02 首版按「不等即提示」实现，对「重载前启用、重载后停用」误报，把已经生效的事说成还需新对话。
  判据是**数量**不是集合，增删相抵时不提示；观察值未建立（0）时不提示，避免误报。观察器只把数字交给面板，**uid 值不进日志**（`acp-observer.cjs` 顶部禁令）。
- 所以面板文案按这两类分开：`已保存，新对话中生效。`（含「已导入/已添加」）用于新增、改名、改密钥、改档位；开关、隐藏、排序等目录内操作统一走
  `catalogSuccess()`（`client.cjs`），按 `catalogDrift` **动态**取文案——无 drift 报「已保存，目录即刻更新。」，有 drift 报「另有 N 个模型/组合需新对话才能看到」，而不是静态分工。
  计数两侧同用 `isOwnUid`：acp-observer 的 `ownModels` 与面板 `catalogDrift` 的 emit 侧都是普通 `dfbyok-*`，以及 Lead 或
  Sidekick 任一侧属于 BYOK 的 `fusion-*`——包括 `fusion-<native>-sidekick-dfbyok-*`，均由 `isOwnUid` 判定（排除纯官方 fusion-*）。
  **不要**把新增类也写成「即刻更新」——2026-11-02 正是这句误导致使把时序问题当成发布失败查了三轮。
- 版本范围：以上是 **Devin 3.11.238 / macOS / 本机**的实测，不是无条件的跨版本契约。若官方改变会话建立时的目录读取时机，本条须重新取证。
