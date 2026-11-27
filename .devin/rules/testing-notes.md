---
trigger: model_decision
description: "写或调试测试时必读——跳过依赖、异步 settle、fixture 陷阱与契约基线。"
---

## 测试注意

- `installed-renderer.cjs` 与 4 处条件 `skip`（`catalog-emit` 3、`fusion-options` 1）依赖本机已装的 Devin 原生渲染文件，缺失时跳过而非失败（判定细节见末节）。
- **用 `ps | grep <名字>` 排查进程时，命中的可能是执行该命令的 bash 自身**：命令文本里出现那个字面量（如脚本里的 `'backend.cjs'`），`bash -c ...`
  就一并被匹配，且它的 ppid 正好是 CLI 的 `exec` 父进程——像「CLI 派生了 backend」（误判事故见 forensics 卷）。要确认，
  打印**完整命令行**（`ps -o command= -p <pid>`）或核对 `/health` 与端口归属；`[b]ackend` 只防 grep 自己，防不住携带同字面量的父 bash。
- **等异步效果不要靠「跑几轮 `setImmediate`」**：fixture 的 `settle(n)` 只排空微任务与 `setImmediate`，**不会让 `setTimeout` 触发**（实测见 forensics 卷）。依赖真实定时器的行为（如宿主推送节流）必须用带 deadline 的轮询等待，
  否则会在负载变化时假性通过或假性失败。反过来，若断言依赖「节流窗口已过」，等待必须**长于**节流间隔，否则删掉节流门控也测不出来。
- **扩展 fixture 的桩按「解析后的绝对路径」匹配，不再按字面符号**（见 `test/helpers/sandbox.cjs`）：`'./config/config.cjs'`
  这类相对键按 `src/extension.cjs` 所在目录解析，`src/runtime/backend.cjs` 的 `require('../config/config.cjs')` 命中**同一个**桩——
  **移动调用方无需改桩键；被依赖文件本身改路径时须同步桩键**。相对 require 若没有桩，在**同一 vm 上下文**递归加载（共享模块缓存与 realm，否则 `instanceof`/单例守卫会碎）；解析不到、或
  require 到既无桩又非内置/`vscode` 的模块时**直接抛错**——绝不回退真实 `require`（会静默绕过桩变假绿）。
- **`globals`（立即化的 `setTimeout`、注入的 `fetch`）默认只作用于入口文件**，`shareGlobals` 谓词只额外覆盖 `src/activation/*`：
  拆分前那整段都在 `extension.cjs` 里、本就用立即定时器；而 `goal/controller.cjs` 等**必须**保持真实定时器（共享立即定时器的竞态事故见 forensics 卷）。扩范围前先确认真实语义是哪一侧。
- 每个 fixture 结束要调 `assertStubsUsed()`（`t.after` 或独立用例）：桩键拼错、或桩因重构不再被命中，都要能红——否则「桩写了但没接线」和
  「桩正确」长得一样。
- **装载器改造引入的 realm 保真度变化已逐处核过**：非桩模块现运行于 VM realm 内（此前真实 realm），2026-10-18 的 17 处 `instanceof` 分类核查记录见 forensics 卷。**但规则仍成立**：测试构造、传入沙箱的对象（如
  `setMatrixUids` 的 `vm.runInContext('Set', loader.context)` 集合）必须用沙箱 realm 的构造器，否则 `instanceof` 在测试中判假——
  这类假绿只在测试出现，生产是单 realm 不暴露。
- **`sourceId` 只能拿「安装副本」现算，用仓库副本算必然不一致**：
  `source-identity.cjs` 的哈希输入是静态 require 闭包，而 `src/runtime/contract.cjs` 有 `require('../../package.json')`，
  所以 **`package.json` 在哈希里**。Devin 安装器会**重写安装副本的 `package.json`**（tab 缩进 + 追加 `__metadata.{installedTimestamp,size}`），同一份源码两处的 `sourceId` **必然不同**（实测两例见 forensics 卷）。
  正确判据：`require('<安装目录>/src/runtime/source-identity.cjs').runtimeIdentity('<storageRoot>', true)` 与
  `runtime-control.json` 的 `sourceId`/`rootId` 比对；「`src/` 逐字节一致」要另用 `diff -rq` 单独验，两者别混。
  副产品：`__metadata` 每次安装都变，**重装同版本也会换 `sourceId`**——正好让 backend 重启到新代码，不是缺陷。
- **Goal 与 Fast Context 不在本 fork 的验收范围内**：两者是上游自带、上游验证过的**额外功能**，本机不使用，**不要**为它们安排真实窗口端到端验收，也不要因「只有模拟/合成测试」列为待补缺口。fork 只改过视图层（`panel/goal-view.cjs`、`panel/fast-context-view.cjs` 的共享 DOM 助手改造），由本仓视图测试覆盖。**精力投在 BYOK + Fusion 基础功能上。**
- **`test/sdk-contract.test.cjs` 是防 SDK 漂移的契约测试**：读 `.refs/` 的官方 SDK 源码，把手写常量与 SDK 字面量交叉断言——Anthropic `StopReason` 每个成员都必须映射进共享处理器认识的集合、`OutputConfig.effort` 每个取值都必须能到达 `output_config.effort`、`ReasoningEffort` 必须仍覆盖我方取值集合、`ToolChoice` 四个成员接口与出站形状一致、`ThinkingBlockParam.signature` 必须仍是**必需**字段（它一旦变可选，「只在签名在场时回放思考」这条规则就该重审）。
  `.refs/` 被 gitignore，**CI 上不存在**，文件缺失用 `{ skip: ... }` 跳过；但「**文件在、却解析不出来**」必须**失败**并提示 layout changed——两者不可混同，否则 SDK 换写法时测试静默失效。**改这些常量时必须同步跑该文件**，别只看全量计数（CI 上 skipped，全绿无信息量）。
  2026-10-16 扩展四条 Responses 契约：`CustomTool.type` 仍是 `'custom'` 且 `format?` 仍可选、`CustomToolInputFormat.Grammar` 的 `syntax` 仍是 `'lark'|'regex'` 且 `type` 是 `'grammar'`、`ResponseCustomToolCall.input` 必须仍是 `string`（「跳过 JSON 校验」完全建立在这条上）、请求参数里 `store` 仍存在且 `ResponseIncludable` 仍含 `'reasoning.encrypted_content'`。**`.refs` 基线版本见 forensics 卷**；两份都是 git 克隆而非 npm tarball——契约测试读 `src/resources/**` 的 TypeScript 源码，tarball 里没有 `src/`。更新后必须重跑本文件并确认 **`skipped 0`**（skip 只代表 `.refs` 缺失，全绿无信息量）。对照结论见 `provider-sdk-parity.md`。
- **「防漂移」测试加断言后要用变异法证明有牙**：把源码临时改坏后逐个跑该文件，确认**恰好对应的那一条**失败，再逐字节还原（`cp` → `diff -q` → `rm` 备份）。基线要同时确认 `skipped 0`——否则「全绿」可能只是整个文件被跳过；不做这一步，恒真断言和真测试长得一样。
- 「重启 Devin」触发即退出 Devin，无法在会话内端到端验证；其探测与时序由 `test/app-restart.test.cjs` 的合成 app 覆盖。
- **一个挂了 3 天的 `npm test` 不是「测试挂死」**（事故全程见 forensics 卷）：`lsof` 显示 fd1/2 是 `PIPE` 且 `SIZE/OFF` 恰为 **16384** 即管道缓冲满、进程阻塞在 write。**不要**据此推断测试套件可能不退出，也不要加超时/重试——真实运行正常退出。同类现象只按 fd 判定，别按「活着多久」。
- **`authenticate` 返回 `{}` 不是「CLI 连上了我们的 backend」的判据**：只带 `api_server_url`、不带 `api_key` 时，
  CLI 走 PKCE 分支并**同样**返回空结果，全程零网络——把它当健康信号会得到假阳性。真判据只能是 backend 侧落盘的 `catalog` /
  `assignment` / `inference` 事件。反向：`AssignModel` **不是必经 RPC**，实测 `GetChatMessage` 可直接落到 api server，
  「没有 assignment 就等于没接通」是假阴性。同理，`devin models list` 在 acp 模式下报 "Not logged in" 属正常——ACP 宿主是
  **唯一**凭据来源，CLI 不读本地 REPL 凭据与 env 里的 key。
- **架构反例必须调用真实违规谓词并精确断言 `source -> target`**：endsWith/子串匹配或自造判定会让「删掉守卫」照样绿，等于没有反例。
- **传输取消用例的判据是「请求到达目标阶段 + 服务端 socket 实际 close」**：不用固定 sleep 触发 abort，也不只断言 reject——要条件等到 `slowHits`/`closes` 递增。
- `test/fixtures/real-picker.json` 是 **Devin Desktop 3.12.28** 真实 picker 观测的子集快照；更新必须说明取自哪个版本（重捕与复验记录见 forensics 卷）。更新触发条件是行内容或 picker 报文契约变化，版本号前进本身不算。
- 读 `test/fixtures/**` 一律用 `__dirname` 拼绝对路径，禁止 CWD 相对路径（曾导致从其他目录单跑 ENOENT）。

## installed-renderer 双能力探测（批次 C 后）

- `test/helpers/installed-renderer.cjs` 只探 webapp 一套：webapp 用例 skip **只依据 `webappAvailable`**
  （`devin-webapp-host/assets` 目录存在）。旧 chat-client 半区已随 3.12.17 删除（`familyUid`/`catalogMisses` 在旧 bundle 0 命中）。
- 安装根可用参数或 `DFBYOK_TEST_APP_ROOT` 覆盖，默认 `/Applications/Devin.app/Contents/Resources/app`；
  assets listing 与文件内容按 root 缓存。仅 assets 目录不存在可 skip；目录存在但候选缺失、重复、
  不可读或锚点漂移必须 fail-loud，不得把解析失败转成 unavailable。
- **`test/goal-idle-regression.test.cjs` 的旧 ACP 模块 skip 缺口已补齐**：它曾硬编码
  `node_modules/@exa/windsurf-acp/index.cjs`，3.12.28 中该旧路径不存在即 skip。现经 `test/helpers/installed-acp.cjs`
  按唯一 export 锚点从 `dist/extension.js` 抽取真实谓词（含 $ 的 minify 名不写死）与其依赖函数，仅 root 缺席才 skip，
  锚点缺失/重复/形状不支持 fail-loud；两份真实 bundle 变异验证证明断言有牙。
- `native-field-contract.test.cjs` 从 webapp assets 的 protobuf-es `newFieldList` 锁定实际消费字段的
  号/名/kind/scalar T/repeated/opt，及关键 message/enum 引用的完整 typeName（import→export 递归解析）；
  新字段（ModelInfo f26、ChatMessagePrompt f22、ModelUsageStats f13、GetChatMessageRequest f28）只登记。
  opt/repeated 只认 `!0`/`true`、`!1`/`false` 与缺席——其他字面量/表达式必须 fail；仅 assets 目录缺失可 skip。

## 源码形状守卫的覆盖边界

`architecture.test.cjs` 的形状守卫先经 `maskNonCode`（字符串/注释感知屏蔽，模板 `${}` 内仍算代码）再断言 activation 源码无 `shared`/`stores` 标识符。但它仍是**源码形状**判定、不是语义分析（正则字面量内目标词会误报、`(x => x)()` 旁路不覆盖）——注释与测试名不得宣称「完全封闭」。

- 反证必须对**真实源码文本做回退**（以下两条为旧写者守卫的历史陷阱，现行守卫照此纪律）（`reverted(from, to)` 整段替换后跑守卫），不要只喂人造行首样例——`installTimeCaptures` 曾因 `^` 行首锚定漏掉行内属性位置的真实捕获。
- **前瞻与 `\s*` 的顺序是坑**：`:\s*(?!...)` 里 `\s*` 能回退到 0、让前瞻落在空格字符上，合法箭头包装会被误报；`\s*` 要收进前瞻内部（本仓踩过两次，记录见 forensics 卷）。
- 夹具陷阱：`extension-lifecycle.test.cjs` 的沙盒把 `src/activation/*` 的 `setTimeout` 换成 0ms 来实现快速重试；`managed-settings.cjs` 已**从该替换中排除**——否则 5 s drain 预算会塌成 0ms、drain 恒走超时分支，R1 用例会「因为错误的原因变绿」。新加依赖计时预算的 activation 模块时先核对 `shareGlobals` 的覆盖面。

## 固定报文契约基线

`node --test test/provider-wire-contract.test.cjs`：52 个合成场景（17 场景 × 3 协议 + 1 无断点对照）的 `buildRequestBody` 输出与 `test/fixtures/provider-wire-contract.json`（基线 commit `04dc73d`，A–E 批次之前的默认报文）逐字段 deepEqual。场景构造在 `test/fixtures/provider-wire-cases.cjs`，字面量不得「优化」。**新批次不得重新生成基线来「修绿」**：与基线不一致意味着默认报文被改动，必须停下定位；有意变更须逐场景说明理由并显式改 JSON。该测试不依赖 `.refs`、不联网。

## 终态与预算契约矩阵

`node --test test/inference-contract.test.cjs`：三协议终态（正常/截断/refusal/错误帧/无终态 EOF/非法工具 JSON/只有思考/只有签名标记/终态后帧）+ 预算（降级重发不套连接重试、多字段 400 只走首分支、Anthropic 强制选择最多三发、首头/空闲/背压/暂停期取消各只发一次）。每个用例同时断言客户端 ACP 帧、monitor 单次结算与**上游真实请求次数**——`received.length` 由测试自己的服务端统计，不得改成被测代码内部的计数。期望值按契约写死，实现改动导致失败时先判断是实现漂移还是契约变更；不得把 `expect` 调成当前实际输出来「修绿」。
