---
description: 原生观测与 CLI 缓存的实测依据与事故记录——picker 刷新风暴、缓存删除/改名实验、裸 UserStatus 形状事故、fixture 误触真实缓存的证据
trigger: model_decision
---

# 原生观测与 CLI 缓存：实测依据与事故

本卷是从 `native-observation-and-cli-cache.md` 拆出的**证据**；契约与禁令在契约卷。

## picker 刷新命令的风暴

`devin.reloadAcpConnections` 实测会断开全部 ACP 连接（用户可见「ACP connection closed」+
  会话区刷新），且每次执行后 5–35 秒内整个窗口被重载（2026-10-14 真机，reload 循环达每小时十余次）。

另：扩展宿主对该窗口反复重启的另一嫌疑是 `saveReceipt`
  往**安装目录**写 `.fusion-byok-storage.json`（POINTERS）——目录被监视则每次 activate 都触发重启，现已改为 roots 不变则不写。

`force()` 与 `changed()` 共用 `cliCacheMs` 间隔时期的实测：刷新风暴曾 30 秒内连断 3 次 ACP。

## 缓存删除与改名实验

实测（2026-10-24）删掉全部 `model_configs*` 后，CLI 在约 1 分钟内只重建了
  **v6**（两个身份，字节数与删除前完全一致，v1–v5 一个没回来），且由哪条路径、在什么时机触发这次重建未确认；更早一次改写 `model_configs_v5` 后实测两小时零
  `GetCliModelConfigs`、picker 一直空。

`force` 连按不 churn 的旁证：实测二次调用即 `no-improvement`。

**重写「比对后替换」的发现过程（2026-10-16）**：CLI
  自己也写这些文件（它经 bridge 拿增强目录再落盘），所以落盘前会重读一次、要求字节与所增强的那份**完全一致**，不一致就跳过（`concurrent-write`，等下一轮自动检查重读）——否则会用「旧
  payload 的增强结果」覆盖 CLI 刚写入的更新版本，静默丢掉它存的内容；窗口是「重读→rename」之间的几微秒。

## 裸 UserStatus 形状事故

2026-10-16：原地修复路径只认信封形状，裸形状下 `rewriteMessage(data, 1, …)` 抛 `Ambiguous` 被 `catch` 吞掉 → 每次重写都逐字节相同 →
  记成 `no-improvement` 并**上报成功**（实测 `user_status` 期望 uid 236/456、8 个已退役 fusion uid 滞留，且只认信封的 `staleFusionUids`
  对同一份 payload 报 0）。修复后对同一份真实缓存的强制刷新：236/456 → 456/456、陈旧 fusion uid 8 → 0，且二次/三次强刷仍为 `no-improvement`（不
  churn）。

回归防线是 `test/cli-cache.test.cjs` 的端到端用例（真实裸形状
  payload → 真实 `augmentCatalog` → 真实重写链路）：**它在本修复之前必然失败**，而此前分层的单测都放过——catalog 侧用信封形状构造 payload，cache 侧用合成
  augmenter，缺口正好在接缝上。

## fixture 误触真实缓存

历史上未 stub 的 fixture 曾把用户真实缓存改名搬走、清空 picker。

## 后端换进程清空视图的实测

后端换进程的那几秒（实测 12 秒）会把 885 条已发布条目清成 0，picker 显示「没有模型」——这是 `unavailable` 必须被拦住的因果证据。

## 原生目录 mapper 的 label→uid 解析是后写覆盖

实测（REA 解析 `modelCatalogSource-*.js` + 本机端到端复现）：webapp 的目录 mapper 先建 `Map<label, modelUid>`
（**同 label 后写覆盖**），再把 sort 分组的 `modelLabels` 逐条映射为 uid。两个 uid 共享一个最终 label 时，
**两 uid 都留在 `models`、但分组里前一个 uid 消失、后一个出现两次**——所以 emit 侧最终展示标签必须唯一；
去重只按 familyLabel 做不够（effort 后缀在之后追加，`Foo`+High 与 `Foo High`+无档位可撞）。另一个实测边界：
`GetCliModelConfigs` 载荷**无排序区**（own group 不会注入），`GetCascadeModelConfigs` 才有
`clientModelSorts`——「分组丢 uid」只在后者一类带 sorts 的 RPC 上表现。

## team_settings 每 3 秒 `no-improvement` 的爆发（已知残留，非缺陷）

停用某个 BYOK 供应商后，`allowedModelUids` 里会留下一批「原生 Lead × 该 BYOK Sidekick」的组合 uid。
`inspectCliCaches` 用 `isOwnUid`（**任一侧**含 `dfbyok-` 即算我们的）判「自有但不在发射集」→ 报陈旧；
`augmentLocalModelChoices` 的清理用 `ownUid`（只认 BYOK 作 Lead）→ 删不掉。于是每次目录同步都「有事可做」、
改写后字节相同 → `no-improvement`，每 3 秒重试一次（2026-11-02 实测 82 条 / 5 分钟，每次读 81 KB，零写入、零报错）。

实测规模：禁用 OpenAI 时 342 条 = `gpt-6.1-sol` 的 6 个 effort uid × 57 个原生 Lead；这 6 个尾缀与按
`digest([provider.id, model.id, effort])` 重算的当前配置逐条一致，说明它们是「停用期暂时不可发射」的组合，不是作废垃圾。

自愈路径：CLI 自己重新持久化白名单时按目录求交，死引用被清掉（2026-11-02 实测 f7 1487 → 1145，死引用 342 → 0），
循环随即停止；同一现象在 2026-10-30 的旧构建上已出现（16–33 条后自行停下），所以它**不是**新版引入的回归。
若要消除噪音，只能让陈旧判定承认「augmenter 删不掉的类别」，不要靠删 uid。
