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
- Goal 与 Fast Context 目前只有模拟连接 / 合成代码的测试，尚未在真实 Devin 窗口完成端到端验收。
- **审「这段代码还活着吗」时，`require` 图会漏掉「路径型入口」**：`src/runtime/goal-report.cjs` 没有任何 `require` 指向它，是 `goal-state.cjs`
  把它的**绝对路径拼进 shell 命令**交给 agent 执行（入口在 `extension.cjs` 的 `reportCliPath`）。纯靠模块依赖图做死代码分析会把它报成死模块（2026-10-15
  实际误判过一次）。判死前先搜「文件名字符串是否出现在代码里」（`grep -rn "$(basename X)" src/`），再下结论。
- 「重启 Devin」触发即退出 Devin，无法在会话内端到端验证；其探测与时序由 `test/app-restart.test.cjs` 的合成 app 覆盖。

