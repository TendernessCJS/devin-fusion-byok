---
trigger: model_decision
description: "Apply when changing native catalog observation or its cache, CLI cache in-place rewriting, or config-key cleanup."
---

# 原生观测与 CLI 缓存（native-observation-and-cli-cache）

原生目录观测与跨进程缓存、两条观测通道的合并、CLI 缓存原地重写、配置键分类清理。

- 原生模型目录靠观测，重启后内存里为空；观测结果经 `<storage root>/native-cache.json` 跨进程缓存（格式 `{version, savedAt, models}`，TTL 7 天，
  原子写：临时文件 + rename，`0o600`）。它是**观测缓存**、不是用户配置，只含 uid/label/能力标志，绝不落凭证；追加并集语义（与内存一致，不因单批缺席而删条目）。此时角色里的
  `nativeUid` 解析不到，**不得**断言「已从模型目录移除」——要按 `nativeCatalogStatus` 区分「尚未同步」（`loading`，面板为 muted 文案「正在同步官方模型…」，
  判定依据为**内存与缓存都没有可用观测**）与「目录就绪但模型确实不在」（真警告）。BYOK 供应商引用写在配置里，解析不到就是真的不可用，不算 `loading`。
  完整取值只有五个：`loading`（初始态，`extension.cjs` 的 `shared` 初值）/`ready`/`empty`/`unsupported`/`unavailable`，**没有 `pending`**（那是 `auto-continue` 的状态名，勿混）。
- **读失败不是空目录（2026-10-19 定论）**：宿主侧一次目录读取有四种结论，只有三种是权威的——`ready`（读到 N 条）、`empty`（后端明确回答「现在是空」）、
  `unsupported`（旧协议的 `nativeModelsProtocol !== 1`）由 `readNativeModels` 返回；`unavailable`（连接失败/身份校验失败/超时/载荷非法）由 `catalog-sync` 的
  catch 合成（`syncPending` 闭包内的 catch），**它不是目录结论**。`refreshNativeModels` 必须在
  `clear()` 之前拦它：视图非空时**保留已发布条目**、只把 `nativeCatalogStatus` 置为 `unavailable`，并走一次 `commit({ bumpRevision: false })`（面板要看到
  「无法连接插件本地服务」，但视图没变就不该推进 revision），同时打 `native-refresh-retained`。否则后端换进程的那几秒会把已发布条目清成 0、picker 显示「没有模型」（实测数字见 `.devin/rules/native-observation-and-cli-cache-forensics.md`）。**`empty` 必须继续清空**——陈旧条目清理依赖它，一起保护掉会让陈旧条目永久留存。冷启动不受此保护（首帧视图本来就空，无可保留）；
  也不要为此让宿主去读 `native-cache.json`，那会造出第二个 cache 读者。
- 原生目录由空变有（或目录签名变化）→ 触发 `pickerRefresh.changed()`；**当前线上不接任何刷新命令**（`lightCommands: []`，且
  `createPickerRefresh` 的**默认值本身就是 `[]`**——历史上默认值曾是 `['devin.reloadAcpConnections']`、只有生产显式传空才安全，
  任何一处漏传就会重新引入风暴，因此默认值必须是安全的那一侧）：实测的风暴与影响见 `.devin/rules/native-observation-and-cli-cache-forensics.md`。数据正确性完全由 cli-cache 原地刷新兜底，新会话读到的是新 payload；
  **不得回退到 `devin.newConversation` 之类开会话的命令**，重新接命令前必须先在真机确认其不会断开 ACP。另一嫌疑（`saveReceipt` 往安装目录写 POINTERS）的叙述见 `.devin/rules/native-observation-and-cli-cache-forensics.md`；不得往
  `context.extensionPath` 里新增任何周期性/激活期写文件。

- `augmentLocalModelChoices` 的门控是「Fusion 需要其原生 uid 出现在字段 7 允许列表里、普通 BYOK 不需要」——盲窗（原生观测为空）下 Fusion 整组被丢而普通
  BYOK 全留，现象会被误读成「非 Fusion 模型缺失」，排障时先看这里而不是重查目录生成。
- CLI 的模型选择器是「`~/.cache/devin/cli/` 的按身份持久缓存（`user_status`/`model_configs_v5`/`team_settings` 的
  `.<digest>.bin` JSON 信封，payload 为 base64 proto）∩ 白名单」；配置改动会改普通模型 uid（digest 含
  `provider.id`/`model.id`/`effort`），缓存陈旧期普通条目整批丢失，而镜像的 `fusion-<lead>-sidekick-<side>` 条目只要两侧 uid 未变就仍能命中。
  `src/runtime/host/cli-cache.cjs` 按「payload 含 `dfbyok` 判定我方身份、含 dfbyok 但缺当前 uid 判定陈旧」**原地重写 payload**：改写前先按
  `CACHE_RPC` 映射缓存名→RPC 路径、经 `augmentCatalog` 重算，且新 payload 必须「不丢任何已出现的期望 uid 且字节有变化」才落盘（否则 `no-improvement`
  跳过——允许净缩，清陈旧也是改进）；落盘前把原始字节写到 `<file>.bak`（原子写、`0o600`；**每次重写都覆盖，只保留最近一次**，不是首次重写前的原件），envelope 的
  `version`/`identity_digest`/`fetched_at_secs` 原样保留。**绝不改名、绝不写 `.stale`**：改名/删除**不能**当刷新手段（删除与改写的实验过程见 `.devin/rules/native-observation-and-cli-cache-forensics.md`）。不碰无 dfbyok 标记的其他身份文件；仅在重写到
  `model_configs` 时才经 `pickerRefresh.force()` 让 picker 重取（`team_settings`/`user_status` 由 CLI 自身节奏重拉、无需断 ACP
  即生效），且 `force()` 与 `changed()` 共用 `cliCacheMs` 间隔——刷新风暴不得变成 ACP 断开风暴。Composer
  模型缺失排障时先看缓存新鲜度，backend 注入日志（`afterOwn`）证明不了 picker 侧可见性。面板「设置 → CLI 缓存 → 刷新缓存」走同一个
  `checkCliCaches({ force: true })`（`refreshCliCaches` 消息），只做原地重写、不引入新的刷新通道；`cliCacheStatus()` 把最近一次报告交给面板渲染，
  不要在那里触发写入。**自动检查只看 uid 存在性**（`missing`/`staleProbe`），所以「uid 齐全但条目形态过时」它一律跳过——这正是 `force` 存在的理由：强制模式绕过门控、
  直接比较 augment 后的字节，只有真差异才落盘。**重写是「比对后替换」而非盲目覆盖**：落盘前重读、要求字节与所增强的那份**完全一致**，不一致就跳过（`concurrent-write`）——否则会用旧 payload 的增强结果覆盖 CLI 刚写入的更新版本、静默丢掉它存的内容（发现过程见 `.devin/rules/native-observation-and-cli-cache-forensics.md`）。`.bak` 写的是**所增强的那份原始字节**（不是再次新读的、可能已属新世代的版本）。修
  emit 形态后**必须**走一次强制刷新或让配置变动触发自动重写，否则旧形态条目会一直留在缓存里（2026-10-14：信息性维度加 `order` 的修复就是这样落地的）。
  **`GetUserStatus` 有两种载荷形状，按 f1 的 wire type 判别**：响应是 `GetUserStatusResponse` 信封（f1 = `user_status` message，
  模型列表在其 f33），而 CLI 落盘的缓存是**裸 `UserStatus`**（f1 = `pro` bool，模型列表直接在 payload 的 f33，实测顶层 f33 = 526 条条目 + 3
  个排序区）。`staleFusionUids` 现在扫描 payload 本身 + 它携带的每个 f1 message（覆盖 flat / 信封 / 裸三种形状）。`augmentCatalog` 接受
  `onSkip(code)`（`shape-unrecognized`/`transform-failed`），**三个 RPC 都接**（`GetCliTeamSettings` 的允许列表改写同样上报，
  此前它是唯一剩下的静默路径）；`refreshStaleCliCaches` 把「上报了 skip 且期望 uid 仍缺」记为失败码而非
  `no-improvement`——**静默返回输入等于关掉这条链路的所有自检**，面板据此显示「未改动（原因）」而不是「无需重写」。bridge 侧不要把跳过码按进程去重（扩展宿主长期存活，
  形状在会话中途变化只会打一次），而是把它作为 `skipped` 字段**搭在每次响应都打的 `catalog` 行**上。回归防线是 `test/cli-cache.test.cjs` 的端到端用例（真实裸形状 payload → 真实 `augmentCatalog` → 真实重写链路，事故全程见 `.devin/rules/native-observation-and-cli-cache-forensics.md`）。
- 加载 `src/extension.cjs` 的测试 fixture 必须 stub `./runtime/host/cli-cache.cjs`（或把 `dir` 指向临时目录），
  **绝不可触及真实 `~/.cache/devin/cli`**（fixture 误触真实缓存的事故叙述见 `.devin/rules/native-observation-and-cli-cache-forensics.md`）；
  `inspectCliCaches`/`refreshStaleCliCaches` 的 `dir` 参数必填（非空字符串，否则抛 `TypeError`）就是为了堵这个口子。

- **原生观测的两条通道必须按「谁更完整」合并，不能后者覆盖**：backend 看的是 CLI 侧流量（CLI 常读自己的缓存、很少重取 → 它的观测可能长期是 seed 的贫化形态），扩展宿主看的是原生扩展 UI
  侧的流量（带完整 field 30）。`mergeNativeEntry`（`native-cache.cjs`）在合并时保留
  `sidekickDimension`/`fusionMetadata`/`harnessUids`，缺失的一方不会把完整的一方降级；标量字段（`disabled`/`label`）仍以新到者为准。
  **一旦被贫化条目覆盖，所有原生 Sidekick 解析不到 → 镜像组合消失 → 又被上一条的清理逻辑删除**，这是级联失效。`refreshNativeModels` 与
  `observeNativeModels` 都已走该合并。

- backend 的原生缓存落盘条件包含「任一入口的维度变富」，不再只看条目数：seed 已是满员（875）时条目数永不变化，只看数量就永远不会把更完整的观测写回磁盘，每次重启都重新 seed
  回贫化形态（`runtime.log` 的 `native-observed` 全天只出现 2 次就是这个征兆）。

- LS 观测到的允许集变更必须经 `catalog-sync` 的 `observeAllowedUids` 进入统一 commit：推进 `nativeRevision`，并触发面板、picker、缓存与 backend 推送；不得只替换集合后调用 `pushToBackend`（revision 已追平时会被门控挡住，随后被旧 backend 快照覆盖）。同集合的重排/重复值不算变更；停用/销毁后不接收回调。restricted → unrestricted 三态已实现（C3）：`collectAllowedUids` 三态、双通道 N=3 去抖、确认提交直接生效——细节见 `catalog-and-picker.md` 尾节。另注意：`observeNativeModels` 对**同值**条目也登记 `observed`（来源权威），但不 bump `nativeRevision`、不 fanout。两路观测的时序问题已改为宿主权威，见下节「双观测通道的权威归属」。

## 双观测通道的权威归属（allowlist 与条目合并）

原生目录有两条观测通道（LS 桥 → `observeAllowedUids`/`observeNativeModels`；backend → `refreshNativeModels` 的 `GET /_runtime/native-models` 回显），且无版本/时序字段——**旧副本不能靠到达顺序赢**。

- **allowlist：宿主一经观测即为权威**。`observeAllowedUids` 接受非空集合后置 `nativeAllowedObserved`；
  此后 backend 回显永不覆盖本地集合（只记日志）。backend 回显仅用于**冷启动采纳一次**（宿主还没观测过时），
  采纳后置同一标志。
- **条目合并按 uid 分方向**：`refreshNativeModels` 对 `observed`（本会话宿主观测过）的 uid 用
  `mergeNativeEntry(backendEntry, hostEntry)`——宿主值为 incoming 胜出标量字段，backend 独缺的
  `kind`/`familyUid`/`sources` 由 carrying 保留；backend 独有的 uid 仍以 backend 为 incoming 采纳。
- **诊断**：`native-allowed-diverged`＝宿主已观测但 backend 回显与本地不一致（只记条数，去重，集合重新相等时复位）；
  `native-allowed-backend-lost`＝backend 回显空 allowlist 而宿主有非空集合，置 `nativePushStale` 强制下一次
  `pushToBackend` 绕过 revision 门控重推（空 payload 仍不推）。
- **已知代价（有意取舍，勿回退）**：若某次 allowlist 变化只被 CLI 通道看到而宿主通道没看到，宿主保持旧集合
  并留下 `diverged` 日志，直到宿主自己观测到。这是为避免「旧副本覆盖新事实」，**不要**在后继改动里悄悄恢复
  「最后到达者赢」。

## CLI 缓存世代与 coverage（Devin 3.11.216 / CLI 3000.11.216 实测后新增；3.11.228 复核仍 `model_configs_v6`）

- `model_configs_v6.<16hex>.bin` 是当前 CLI 版本在写的格式；**可写性按内容判定，代际号只用于展示**——
  `model_configs*`（含无后缀=v1）一律是候选：信封+载荷校验通过即 supported（任意 `_vN` 可写，
  由 `rpcFor` 前缀派生 `GetCliModelConfigs`）；非 JSON → `legacy`（历史残留）；
  是 JSON 但校验失败 → `unsupported`（未来格式，请更新插件）。supported 中 `_vN`>6 → `coverage.dynamic`。
- 写入资格（任意代际、内容判定同上）：>64MiB 先 statSync 拒绝不读；JSON 信封必须
  `{version:1, identity_digest 非空字符串, fetched_at_secs 安全整数, payload 严格 base64}`；
  model_configs 须有合法 f1 wire2 条目、唯一非空 f22 UID；零字节是合法空表且不取得写资格。
  输出也须校验；仅 expected 为空且原 UID 全属我方时可退役为空表，已知字段类型须合法；
  仅 UID 中的自有前缀可判归属，label/其他字段含 marker 不算。user_status 校验裸/信封内真实目录，
  team_settings 从 f7 UID 允许列表判归属。JSON 解析失败须保留原始字节分类，不能把损坏 JSON 当 legacy。
  `read-failed`/`too-large` 只进 `skipped` 稳定 code、不计 supported/legacy；其余校验失败
  同时进 `skipped`（`unsupported-envelope`/`malformed-payload`）与 coverage 分类，字节不变。
- `coverage`：`{dirState, supported, legacy:[{name,generation}], unsupported:[...],
  generations:[{generation,name,fetchedAt,own}], current, dynamic}`，
  `current` = supported model_configs 中最大 generation（同代取 `fetched_at_secs` 最新），
  纯由目录内容决定；它不是 CLI 实际读取代际的观测，面板应称「检测到兼容缓存 vN」，不得宣称「当前使用」。
  目录缺失不得表现为「全部正常」。
- `expectedUids` 为空**仍执行一次检查**，让已识别的我方陈旧条目走保守 retirement；
  真实模型 UID/允许列表中的自有条目不在 expected 时也须触发退役；缓存/auth 使用显式 retireOwn，
  空 emit 不能早退而留下最后一个已删模型。保留原生与未知字段，二次检查不得 churn。
  无 known UID 依据时不得删 native 形态组合、不得伪造空目录清空。
  `loading`/`unavailable` 下 `retire:false` 硬闸禁删自有条目；retirement 只在权威态允许（`retire-withheld`）；权威首达 `nativeRevision`+1 补写。
- 面板语义：未知代际/格式异常 = 「未处理/请更新插件」，与 `no-improvement` 的「无需重写」分开；
  health 映射：coverage 缺失或 dirState≠ok → unknown，unsupported 或写失败 → bad，legacy 不影响。
