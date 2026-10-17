---
trigger: model_decision
description: "Apply when writing or debugging tests — the installed-renderer skip dependency, the `ps | grep` self-match trap, async-settle limits, contract-test mutation checks, and flows not verifiable in-session."
---

## 测试注意

- `test/support/installed-renderer.cjs` 与 5 处条件 `skip` 依赖本机已安装的 Devin 原生渲染文件；缺失时会跳过而非失败。
- **用 `ps | grep <名字>` 排查进程时，注意命中的可能是执行该命令的 bash 自身**：命令文本里一旦出现那个字面量（例如脚本里的 `'backend.cjs'`），`bash -c ...`
  就会一并被匹配，且它的 ppid 正好是 CLI 的 `exec` 父进程——看起来就像「CLI 派生了一个 backend」。曾据此误判出根本不存在的孤儿 backend（2026-10-14）。要确认，
  务必打印**完整命令行**（`ps -o command= -p <pid>`）或直接核对 `/health` 与端口归属；`[b]ackend` 这类写法只能防住 grep 自己，防不住携带同样字面量的父
  bash。
- **等异步效果不要靠「跑几轮 `setImmediate`」**：扩展 fixture 的 `settle(n)` 只排空微任务与 `setImmediate`，**不会让 `setTimeout` 触发**（实测
  20 轮后 `setTimeout(0)` 仍未执行）。依赖真实定时器的行为（例如宿主的推送节流）必须用带 deadline 的轮询等待，
  否则测试会在负载变化时假性通过或假性失败——`extension-lifecycle` 的推送用例就这样脆弱过一轮。反过来，若某断言依赖「节流窗口已过」，等待时间必须**长于**节流间隔，否则删掉节流门控也测不出来。
- **Goal 与 Fast Context 不在本 fork 的验收范围内**（2026-10-16 决定）：两者是上游自带、由上游验证过的**额外功能**，本机不使用，因此**不要**为它们安排真实 Devin 窗口的端到端验收，也不要因为「只有模拟/合成测试」而把它们列为待补缺口。核心逻辑与上游同源或纯搬迁；fork 只改过它们的视图层（`panel/goal-view.cjs`、`panel/fast-context-view.cjs` 的共享 DOM 助手改造），那部分由本仓自身的视图测试覆盖。**精力投在 BYOK + Fusion 基础功能上。**
- **`test/sdk-contract.test.cjs` 是防 SDK 漂移的契约测试**（2026-10-16 加）：它**读** `.refs/` 里的官方 SDK 源码，把我们的手写常量与 SDK 字面量做交叉断言——Anthropic `StopReason` 每个成员都必须映射进共享处理器认识的集合、`OutputConfig.effort` 每个取值都必须能到达 `output_config.effort`、`ReasoningEffort` 必须仍覆盖我方取值集合、`ToolChoice` 四个成员接口与出站形状一致、`ThinkingBlockParam.signature` 必须仍是**必需**字段（它一旦变可选，「只在签名在场时回放思考」这条规则就该重审）。
  `.refs/` 被 gitignore，**CI 上不存在**，所以各用例都用 `{ skip: ... }` 在文件缺失时跳过；但「**文件在、却解析不出来**」必须**失败**并提示 layout changed——两者不可混同，否则 SDK 换写法时测试会静默失效。**改这些常量时必须同步跑该文件**，别只看全量计数（CI 上它是 skipped，全绿没有信息量）。
  2026-10-16 扩展四条 Responses 契约：`CustomTool.type` 仍是 `'custom'` 且 `format?` 仍可选、`CustomToolInputFormat.Grammar` 的 `syntax` 仍是 `'lark'|'regex'` 且 `type` 是 `'grammar'`、`ResponseCustomToolCall.input` 必须仍是 `string`（我们「跳过 JSON 校验」完全建立在这条上）、请求参数里 `store` 仍存在且 `ResponseIncludable` 仍含 `'reasoning.encrypted_content'`。四条均已做过变异验证（逐个改坏 `.refs` 对应行 → 恰好该条失败 → `cp`/`diff -q` 逐字节还原），基线 `skipped 0`。
- **给「防漂移」类测试加断言后，要用变异法证明它真的有牙**（2026-10-16 实测，3/3 命中）：把源码临时改坏（删 `pause_turn` 映射、从 `EFFORTS` 删 `max`、让 `tool_choice` 丢掉 `any`）后逐个跑该测试文件，确认**恰好对应的那一条**失败，再逐字节还原（`cp` 备份 → `diff -q` 校验），最后 `rm` 掉备份。基线要同时确认 `skipped 0`——否则「全绿」可能只是整个文件被跳过。不做这一步时，「断言写得像那么回事但其实恒真」的测试和真测试长得一模一样。
- 「重启 Devin」触发即退出 Devin，无法在会话内端到端验证；其探测与时序由 `test/app-restart.test.cjs` 的合成 app 覆盖。
