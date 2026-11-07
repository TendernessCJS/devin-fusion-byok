---
trigger: model_decision
description: "改基线 commit、合成场景矩阵或源码形状守卫覆盖边界时必读——固定报文契约基线与终态/预算契约矩阵的判据与纪律。"
---
# 测试基线矩阵（testing-baselines）

## 源码形状守卫的覆盖边界

`architecture.test.cjs` 的写者守卫识别 `=`/`??=`/`||=`/`&&=`、复合赋值（`+=` 等）、`++`/`--`、`delete holder.slot`、方法变异（`set/delete/clear/push/add/splice`）。但它是**源码形状**判定、不是语义分析：`(x => x)()` 之类旁路不覆盖——注释与测试名都不得宣称「完全封闭」。

- 反证必须对**真实源码文本做回退**（`reverted(from, to)` 整段替换后跑守卫），不要只喂人造行首样例——`installTimeCaptures` 曾因 `^` 行首锚定漏掉行内属性位置的真实捕获。
- **前瞻与 `\s*` 的顺序是坑**：`:\s*(?!...)` 里 `\s*` 能回退到 0、让前瞻落在空格字符上，合法箭头包装会被误报；`\s*` 要收进前瞻内部。这个坑在本仓同一守卫上踩过两次。
- 夹具陷阱：`extension-lifecycle.test.cjs` 的沙盒把 `src/activation/*` 的 `setTimeout` 换成 0ms 来实现快速重试；`managed-settings.cjs` 已**从该替换中排除**——否则 5 s drain 预算会塌成 0ms、drain 恒走超时分支，R1 用例会「因为错误的原因变绿」。新加依赖计时预算的 activation 模块时先核对 `shareGlobals` 的覆盖面。

## 固定报文契约基线

`node --test test/provider-wire-contract.test.cjs`：52 个合成场景（17 场景 × 3 协议 + 1 无断点对照）的 `buildRequestBody` 输出与 `test/fixtures/provider-wire-contract.json`（基线 commit `04dc73d`，A–E 批次之前的默认报文）逐字段 deepEqual。场景构造在 `test/fixtures/provider-wire-cases.cjs`，字面量不得「优化」。**新批次不得重新生成基线来「修绿」**：与基线不一致意味着默认报文被改动，必须停下定位；有意变更须逐场景说明理由并显式改 JSON。该测试不依赖 `.refs`、不联网。

## 终态与预算契约矩阵

`node --test test/inference-contract.test.cjs`：三协议终态（正常/截断/refusal/错误帧/无终态 EOF/非法工具 JSON/只有思考/只有签名标记/终态后帧）+ 预算（降级重发不套连接重试、多字段 400 只走首分支、Anthropic 强制选择最多三发、首头/空闲/背压/暂停期取消各只发一次）。每个用例同时断言客户端 ACP 帧、monitor 单次结算与**上游真实请求次数**——`received.length` 由测试自己的服务端统计，不得改成被测代码内部的计数。期望值按契约写死，实现改动导致失败时先判断是实现漂移还是契约变更；不得把 `expect` 调成当前实际输出来「修绿」。
