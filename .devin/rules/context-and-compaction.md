---
trigger: model_decision
description: "Apply when changing the declared context window (ModelInfo f4 / maxTokens), when compaction is suspected of being caused by the extension, or when reconstructing why a session compacted."
---

# 上下文与压缩（context-and-compaction）

「会话为什么压缩」的定论与排障入口。声明窗口（ModelInfo `f4`/`maxTokens`）是扩展唯一的杠杆；压缩由 CLI 的云端调度决定。**改声明窗口、或再次怀疑「是不是扩展触发了压缩」时必读**——这一条已被自我推翻三次，别再重走。

> 本卷从 `catalog-and-picker.md` 原样拆出（内容未改）。picker 侧的字段与可见性契约仍在那一卷。
- **上下文压缩：扩展不是施加者，且声明窗口是唯一杠杆（2026-10-16 定论，含三次自我推翻，别再重走）**。①**扩展从不碰会话历史、也不设任何压缩参数**；我们唯一的杠杆是 ModelInfo 的
  `f4 = maxTokens`（＝声明窗口）。**实测该声明被采纳且生效**：BYOK `deepseek-flash` 声明 `contextWindow: 1024000`，真实会话跑到
  **280,819** 而**零压缩**（`monitor.jsonl` 峰值，其中 >262000 共 9 条全 success），证明压缩**不是**按副模型 swe-2 的 262,000 走。
  ②**压缩由 CLI 的「压缩调度 + 阈值」决定，且调度是云端部署的**：远程 flag `enable-devin-cli-cloud-compaction-schedule=true`（描述原文「gate
  the deployment of CompactionSchedules and self-compaction for SWE-1.7/2」）、`devin-cli-compaction-threshold`
  与 `enable-devin-cli-swe2-self-compaction` 均为 `false`；CLI 配置项 `agent.compaction_threshold_tokens`（官方
  changelog：「trigger automatic compaction **earlier** than the context-window-based default」）只能让它更早，
  **没有**可靠办法推迟。③**CLI 有专门的 Fusion sidekick 阈值开关**（隐藏、`--help`
  不列）：`--compaction-thresholds <SPAWN,[APPLY,]HARD>`（示例 `183500,183500,262144`）与
  `--sidekick-compaction-thresholds`，后者原文「Override the **Local Fusion sidekick chain's** compaction
  thresholds **independently of the lead's**，未设置时回退到前者」，env 为 `DEVIN_COMPACTION_THRESHOLDS` /
  `DEVIN_SIDEKICK_COMPACTION_THRESHOLDS`。**但没有任何证据显示这两个开关在默认下把上限压到 sidekick 窗口**——实测已到 280,819 未压缩即反证，勿据此改配置。
  ④**触发是事件驱动的，不要用「压缩时的 token 数」反推阈值**：把全部真实压缩回溯前序事件，**每一条都紧跟在 `session/load` 之后**（15:21:51←15:19:15、
  15:33:11←15:32:59、16:00:01←15:59:44、17:00:20←16:59:13、00:26:01←00:23:47、01:43:00←01:39:46、
  02:08:11←02:07:45），token 数只是当时的规模，因此历史上把 141k/211k 当阈值证据、以及按 `0.7×262k`/`0.8×262k` 推阈值**都是错的**（已被
  249.9k/280.8k 无压缩直接证伪）。⑤**唯一干净的实验样本**：pid 33561 自 02:07:52 起 `initialize`/`session/load` 计数为 **0**（无重载、
  无切模型），`Summarize` 仅 02:08:11 一次，`message_nodes.num_tokens_preceding` 单调递增无断层。⑥**排障四个源**（缺一不可，
  因为压缩**不在对话里显示**——官方 changelog：「Automatic context compaction is no longer surfaced in the scrollback or the
  ACP conversation view」）：CLI 日志 `Summarize: truncated conversation history from N to M messages`、
  `message_nodes.num_tokens_preceding` 的断层、`~/.local/share/devin/cli/summaries/` 的新摘要产物、`summaries/sidekick/`
  与 summary-agent 日志。⑦**不要把面板的 `used` 与 `monitor.jsonl` 的 `inputTokens` 混用**：前者是 Devin 上报值（略高），后者是实际请求量，
  二者差值可达 5–7k，用它们互相验证会得出假结论。⑧`usageState: 'inconsistent'`（如 `cachedTokens > inputTokens`）与
  `num_tokens_preceding` 的**常态回落**（实测 484 条请求中 37 次回落、21 次 ≥5,000，最大 −31k 且 24 秒内自愈）都**不是**压缩，别当信号。
