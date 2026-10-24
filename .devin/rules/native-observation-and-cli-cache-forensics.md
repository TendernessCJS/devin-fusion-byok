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
