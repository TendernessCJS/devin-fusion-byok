---
trigger: model_decision
description: "Apply when writing or debugging tests — the installed-renderer skip dependency, the `ps | grep` self-match trap, async-settle limits, and flows not yet verified end to end."
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
- **BYOK 三条协议路径的验证状态**（2026-10-16 实测，用真实 key、DeepSeek 端点，走扩展自己的 `serveChat` 完整链路：请求体构造 → 真实 HTTP → SSE 解析 → protobuf 输出）：
  `openai-responses`、`openai`（Chat Completions）、`anthropic`（Anthropic Messages）三条路径**都已协议级真机验证通过**，chat 与 anthropic 路径均验证了**工具调用且参数精确正确**（`multiply` 收到 `{"a":13,"b":7}`）。
  注意两点区分：① 这是**协议级**真机验证（直接调 `serveChat` + 合成请求），不是**整窗 e2e**——真实 Devin 窗口的运行时流量目前只覆盖 `openai-responses`（`deepseek-flash` 与 `deepseek-v4-pro`）；② **Chat Completions 的配置取值是 `openai`，不是 `openai-chat`**：`isChatFormat` 的正则认 `chat`/`openai`/`chat-completions` 等，不认 `openai-chat`（该值会静默落回 responses 格式），面板下拉也只提供 `openai-responses`/`openai`/`anthropic` 三档。DeepSeek 的 Anthropic 兼容端点 `https://api.deepseek.com/anthropic` 同时接受 `/anthropic/messages` 与 `/anthropic/v1/messages` 两个路径，本仓 `endpoint()` 的补路径逻辑无冲突。
- **审「这段代码还活着吗」时，`require` 图会漏掉「路径型入口」**：`src/goal/report.cjs` 没有任何 `require` 指向它，是 `goal/state.cjs`
  把它的**绝对路径拼进 shell 命令**交给 agent 执行（入口在 `extension.cjs` 的 `reportCliPath`）。纯靠模块依赖图做死代码分析会把它报成死模块（2026-10-15
  实际误判过一次）。判死前先搜「文件名字符串是否出现在代码里」（`grep -rn "$(basename X)" src/`），再下结论。
- 「重启 Devin」触发即退出 Devin，无法在会话内端到端验证；其探测与时序由 `test/app-restart.test.cjs` 的合成 app 覆盖。

