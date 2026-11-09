---
trigger: model_decision
description: "新增或拆分规则卷、调整 trigger、或撞到 16,384 字节注入上限时必读——体积实测与拆卷纪律"
---

# 规则编写与拆卷纪律（rule-authoring）

## 为什么分卷（2026-10-17 实测）


规则注入有**每文件 16,384 字节上限**，超出部分被**静默丢弃**——CLI 二进制里的原文是
  `[Rule content truncated to <N> bytes. Read the full file at <path> for additional content.]`；另有**每 prompt 预算**可把整条规则**省略**，原文
  `[Rule content omitted to stay within the per-prompt rule budget. ...]`（符号 `agent_ext::rules::event_handler::ContentRuleBudget::partition`）。这两项在文档里**没有任何配置项**。

本文件曾达 **62,731 字节**，实测**只有前 26%（16,384 字节）进入常驻上下文**；被丢弃的 74% 里包含**整节「架构边界」（33,573 字节）**——也就是说
  「漏读会安静地做错」的那批约束**从未被送达过**。而窗口是**零和预算**：在文件内新增内容必然挤掉现有内容，所以唯一的扩容方式是**移出成独立文件**。

因此改为**分卷 + 索引**：本文件只留索引、短节与最高危禁令速查；正文按主题拆到下列卷。拆分已核对**字节守恒（内容只搬不改）**，且每卷都
  **< 16,384 字节**才可能完整注入。**改 `src/**` 前先按索引找到对应卷再动手。**

**体积纪律**：每卷必须 < 16,384 字节，超限部分静默丢弃。`test/rule-budget.test.cjs`（`npm test` 的一部分）会硬拦超限卷与「新卷没进本索引」，所以别在这里维护体积快照——它必然过期，判据以测试为准。接近上限时**先拆卷再加内容**：把「实测依据/排障判据」移成 `<主题>-forensics.md`，契约卷留一条指向与禁令（`runtime-and-injection.md` ↔ `runtime-forensics.md` 是范例）。拆卷是**逐字搬运 + 不加新论断**，只补指针句。拆卷后**必须**跑 `node scripts/rule-split-check.cjs <拆卷前commit> <旧卷> [新卷…]`——退出码非 0 即有 bullet 丢失，不得提交；刻意重写的 bullet 用 `--allow=<归一化 key 子串>` 豁免并在提交信息里说明。该脚本同时拦「整条丢失」与「bullet 还在但内容缩水 >20%」，两类豁免语法相同。事故依据：2026-10-27 拆 `runtime-and-injection.md` 漏做此核对，丢了 4 条约束（安全校验禁令、`assignment_jwt` 契约、backend 转发目标、`injection-health` 宿主约束），`npm test` 与 rule-budget 全绿却无人报警。

AGENTS.md 保留压缩版与索引，细节以本卷为准。
