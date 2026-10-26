---
trigger: model_decision
description: "Apply when writing or debugging tests — the installed-renderer skip dependency, the `ps | grep` self-match trap, async-settle limits, contract-test mutation checks, and flows not verifiable in-session."
---

## 测试注意

- `test/helpers/installed-renderer.cjs` 与 4 处条件 `skip`（`catalog-emit` 3 处、`fusion-options` 1 处）依赖本机已安装的 Devin 原生渲染文件；缺失时会跳过而非失败。
- **用 `ps | grep <名字>` 排查进程时，注意命中的可能是执行该命令的 bash 自身**：命令文本里一旦出现那个字面量（例如脚本里的 `'backend.cjs'`），`bash -c ...`
  就会一并被匹配，且它的 ppid 正好是 CLI 的 `exec` 父进程——看起来就像「CLI 派生了一个 backend」。曾据此误判出根本不存在的孤儿 backend（2026-10-14）。要确认，
  务必打印**完整命令行**（`ps -o command= -p <pid>`）或直接核对 `/health` 与端口归属；`[b]ackend` 这类写法只能防住 grep 自己，防不住携带同样字面量的父
  bash。
- **等异步效果不要靠「跑几轮 `setImmediate`」**：扩展 fixture 的 `settle(n)` 只排空微任务与 `setImmediate`，**不会让 `setTimeout` 触发**（实测
  20 轮后 `setTimeout(0)` 仍未执行）。依赖真实定时器的行为（例如宿主的推送节流）必须用带 deadline 的轮询等待，
  否则测试会在负载变化时假性通过或假性失败——`extension-lifecycle` 的推送用例就这样脆弱过一轮。反过来，若某断言依赖「节流窗口已过」，等待时间必须**长于**节流间隔，否则删掉节流门控也测不出来。
- **扩展 fixture 的桩按「解析后的绝对路径」匹配，不再按字面符号**（2026-10-18 拆分 `extension.cjs` 时改造，见 `test/helpers/sandbox.cjs`）：`'./config/config.cjs'`
  这类相对键按 `src/extension.cjs` 所在目录解析成绝对路径，所以 `src/runtime/backend.cjs` 里写的 `require('../config/config.cjs')` 命中**同一个**桩——
  **移动调用方无需改桩键；被依赖文件本身改路径时须同步桩键**。相对 require 若没有桩，就在**同一个 vm 上下文**递归加载（共享模块缓存与 realm，否则 `instanceof`/单例守卫会碎）；解析不到、或
  require 到既无桩又非内置/`vscode` 的模块时**直接抛错**——绝不回退到真实 `require`，回退会静默绕过桩、把桩测试变成假绿。
- **`globals`（立即化的 `setTimeout`、注入的 `fetch`）默认只作用于入口文件**，`shareGlobals` 谓词目前只额外覆盖 `src/activation/*`。这不是随意选择：
  拆分前那整段代码都在 `extension.cjs` 里、本来就用立即定时器；而 `goal/controller.cjs` 等**必须**保持真实定时器——实测让它共享立即定时器会引入 goal
  调度竞态（`missing-report` 误杀 `disabled` 状态）。需要扩范围时先确认真实语义是哪一侧。
- 每个 fixture 结束要调 `assertStubsUsed()`（`t.after` 里或独立用例）：桩键拼错、或某个桩因为重构而不再被命中，都要能红——否则「桩写了但没接线」和
  「桩正确」长得一模一样，这类失效正是把 11 个桩键从字面量改成路径匹配时最容易被引入的。
- **装载器改造引入的 realm 保真度变化已逐处核过（2026-10-18）**：非桩模块（`goal/controller.cjs`、`panel/controller.cjs`、`picker-refresh.cjs`、
  `catalog/augment.cjs` 等）现在运行在 VM realm 内，此前是真实 realm。全仓 17 处 `instanceof` 分两类，**都不构成隐患**：① 两侧同 realm（如
  `activation/errors.cjs` 的 `RuntimeError`、`catalog/*` 之间的 Set）——抽出的模块与它在沙箱内创建的 Set/实例同处一个 realm；② 落在被桩替换的模块里
  （`panel/manager.cjs` 的 `allowedUids instanceof Set` 在 fixture 里从不真跑）。**但规则仍然成立**：任何**由测试构造、传入沙箱**的对象（如
  `setMatrixUids` 用 `vm.runInContext('Set', loader.context)` 造的集合）必须用沙箱 realm 的构造器，否则生产代码里的 `instanceof` 在测试中会判假——
  这类假绿只在测试里出现，生产是单 realm 所以不会暴露。
- **本次重构（protocol 拆分 + activation 拆分）的真实窗口验收已于 2026-10-18 在 0.3.49 完成**：`ready` 只出现 1 次（port 39842, version 0.3.49）、
  `activated` 含 `nativeVersion 0.2.0`、`ls bridge ready 64038 -> 64069`、backend 进程路径指向 `local.devin-fusion-byok-0.3.49`、monitor 有 HTTP 200 且
  无 `error`/`unhandled`、已安装 `src/` 与仓库 `src/` 逐字节一致（`diff -rq`）；并在真机确认 Fusion（BYOK lead + 官方 sidekick）可选可跑。原清单（保留以便下次照抄）：
  `ready` 仅出现 1 次；`activated` 含 `nativeVersion`；`ls bridge ready N -> M`；backend 进程路径指向新版本目录；`runtime-control.json` 的 version/sourceId/rootId
  三方一致；monitor 有 HTTP 200 且日志无 `error`/`unhandled`。
  **两个验收时别误判的现象**：① 重载后出现一次 `backend-adopted`（0.3.50 之前叫 `startup-error code:port_in_use`，名字误导且已改）是**良性接管**——`backend.cjs` 对 `EADDRINUSE` 记日志后 **exit 0**，宿主握手探到同
  `service` 即采用已在跑的那个（backend 因此 `ppid=1`，跨重载存活是本意）；② 流式超时修复的判据在**宿主输出日志**
  （`~/Library/Application Support/Devin/logs/*/window*/exthost/output_logging_*/1-Devin Fusion BYOK.log`）；早期 `runtime.log` 的超时条目不带 `rpc`，当前已带 `rpc` 与 backend 注入的 `peerPort`。历史改前同期 10 分钟 30 条 `phase:body`，改后 0 条。
  **预期副作用**：protocol 三个新文件进了 `SOURCE_FILES`，`sourceId` 必变，首次重载会让 backend **重启一次**——这是新代码生效的
  正确行为，不要误判为重载循环（判据仍是 `ready` 只出现 1 次）。
- **`sourceId` 只能拿「安装副本」现算，用仓库副本算必然不一致**（2026-10-25 实测，同一坑连踩两次）：
  `source-identity.cjs` 的哈希输入是静态 require 闭包，而 `src/runtime/contract.cjs` 里有 `require('../../package.json')`，
  所以 **`package.json` 在哈希里**。Devin 安装器会**重写安装副本的 `package.json`**（tab 缩进 + 追加 `__metadata.{installedTimestamp,size}`；
  实测仓库 1,969 B → 安装 1,898 B），于是同一份源码两处的 `sourceId` **必然不同**（实测仓库 `1ee28376…` vs 安装 `cfd7ed28…`）。
  正确判据：`require('<安装目录>/src/runtime/source-identity.cjs').runtimeIdentity('<storageRoot>', true)` 与
  `runtime-control.json` 的 `sourceId`/`rootId` 比对；「`src/` 逐字节一致」要另用 `diff -rq` 单独验，两者别混。
  副产品：`__metadata` 每次安装都变，所以**重装同版本也会换 `sourceId`**——这正好让 backend 重启到新代码，不是缺陷。
- **Goal 与 Fast Context 不在本 fork 的验收范围内**（2026-10-16 决定）：两者是上游自带、由上游验证过的**额外功能**，本机不使用，因此**不要**为它们安排真实 Devin 窗口的端到端验收，也不要因为「只有模拟/合成测试」而把它们列为待补缺口。核心逻辑与上游同源或纯搬迁；fork 只改过它们的视图层（`panel/goal-view.cjs`、`panel/fast-context-view.cjs` 的共享 DOM 助手改造），那部分由本仓自身的视图测试覆盖。**精力投在 BYOK + Fusion 基础功能上。**
- **`test/sdk-contract.test.cjs` 是防 SDK 漂移的契约测试**（2026-10-16 加）：它**读** `.refs/` 里的官方 SDK 源码，把我们的手写常量与 SDK 字面量做交叉断言——Anthropic `StopReason` 每个成员都必须映射进共享处理器认识的集合、`OutputConfig.effort` 每个取值都必须能到达 `output_config.effort`、`ReasoningEffort` 必须仍覆盖我方取值集合、`ToolChoice` 四个成员接口与出站形状一致、`ThinkingBlockParam.signature` 必须仍是**必需**字段（它一旦变可选，「只在签名在场时回放思考」这条规则就该重审）。
  `.refs/` 被 gitignore，**CI 上不存在**，所以各用例都用 `{ skip: ... }` 在文件缺失时跳过；但「**文件在、却解析不出来**」必须**失败**并提示 layout changed——两者不可混同，否则 SDK 换写法时测试会静默失效。**改这些常量时必须同步跑该文件**，别只看全量计数（CI 上它是 skipped，全绿没有信息量）。
  2026-10-16 扩展四条 Responses 契约：`CustomTool.type` 仍是 `'custom'` 且 `format?` 仍可选、`CustomToolInputFormat.Grammar` 的 `syntax` 仍是 `'lark'|'regex'` 且 `type` 是 `'grammar'`、`ResponseCustomToolCall.input` 必须仍是 `string`（我们「跳过 JSON 校验」完全建立在这条上）、请求参数里 `store` 仍存在且 `ResponseIncludable` 仍含 `'reasoning.encrypted_content'`。四条均已做过变异验证（逐个改坏 `.refs` 对应行 → 恰好该条失败 → `cp`/`diff -q` 逐字节还原），基线 `skipped 0`。
  **`.refs` 基线（2026-10-24 更新）**：`@anthropic-ai/sdk 1.3.0`（tag `sdk-v1.3.0`）、`openai 7.43.0`（tag `v7.43.0`）；两份都是 git 克隆而非 npm tarball——契约测试读 `src/resources/**` 的 TypeScript 源码，tarball 里没有 `src/`。更新后必须重跑本文件并确认 **`skipped 0`**（skip 只代表 `.refs` 缺失，全绿无信息量）。对照结论见 `provider-sdk-parity.md`。
- **给「防漂移」类测试加断言后，要用变异法证明它真的有牙**（2026-10-16 实测，3/3 命中）：把源码临时改坏（删 `pause_turn` 映射、从 `EFFORTS` 删 `max`、让 `tool_choice` 丢掉 `any`）后逐个跑该测试文件，确认**恰好对应的那一条**失败，再逐字节还原（`cp` 备份 → `diff -q` 校验），最后 `rm` 掉备份。基线要同时确认 `skipped 0`——否则「全绿」可能只是整个文件被跳过。不做这一步时，「断言写得像那么回事但其实恒真」的测试和真测试长得一模一样。
- 「重启 Devin」触发即退出 Devin，无法在会话内端到端验证；其探测与时序由 `test/app-restart.test.cjs` 的合成 app 覆盖。
- **一个挂了 3 天的 `npm test` 不是「测试挂死」**（2026-10-18 判定）：`lsof -p <pid> -a -d 1,2` 显示 fd1/2 是 `PIPE` 且 `SIZE/OFF` 恰为 **16384**，
  即管道缓冲满、进程阻塞在 write；成因是工具调用结束后**读端消失**，而 `node --test` 仍在写 TAP 输出。特征是四层进程全 `S`、0% CPU、**无子进程**、
  `fd0=/dev/null`（不是等 stdin）。**不要**据此推断测试套件可能不退出，也不要加超时/重试——真实运行是正常退出的。同类现象只按 fd 判定，别按「活着多久」。
- **`authenticate` 返回 `{}` 不是「CLI 连上了我们的 backend」的判据**（2026-10-18 实测）：只带 `api_server_url`、不带 `api_key` 时，
  CLI 走 PKCE 分支并**同样**返回空结果，且全程零网络——把它当健康信号会得到假阳性。真判据只能是 backend 侧落盘的 `catalog` /
  `assignment` / `inference` 事件。反向也要注意：`AssignModel` **不是必经 RPC**，实测 `GetChatMessage` 可直接落到 api server，
  所以「没有 assignment 就等于没接通」是假阴性。同理，`devin models list` 在 acp 模式下报 "Not logged in" 属正常——ACP 宿主是
  **唯一**凭据来源，CLI 不读本地 REPL 凭据与 env 里的 key。
- **架构反例必须调用真实违规谓词并精确断言 `source -> target`**：endsWith/子串匹配或自造判定函数会让「删掉守卫」照样绿，等于没有反例。
- **传输取消用例的判据是「请求到达目标阶段 + 服务端 socket 实际 close」**：不用固定 sleep 触发 abort，也不只断言 reject——要条件等待到 `slowHits`/`closes` 递增。
- `test/fixtures/real-picker.json` 是 **0.3.11 时期**真实 picker 响应的快照（文件名不再带版本，来源记在这里）；更新它必须说明取自哪个版本。
- 读 `test/fixtures/**` 一律用 `__dirname` 拼绝对路径，禁止 CWD 相对路径（曾导致从其他目录单跑 ENOENT）。

## installed-renderer 双能力探测（批次 C 后）

- `test/helpers/installed-renderer.cjs` 分 legacy / webapp 两套：`legacyAvailable`（旧
  `windsurf-chat-client/index.js`）与 `webappAvailable`（`devin-webapp-host/assets` 目录存在）。
  webapp 用例 skip **只依据 `webappAvailable`**，不再看旧 renderer 文件。
- 安装根可用参数或 `DFBYOK_TEST_APP_ROOT` 覆盖，默认 `/Applications/Devin.app/Contents/Resources/app`；
  assets listing 与文件内容按 root 缓存。仅 assets 目录不存在可 skip；目录存在但候选缺失、重复、
  不可读或锚点漂移必须 fail-loud，不得在能力探测阶段把解析失败转成 unavailable。
- `native-field-contract.test.cjs` 从 webapp assets 的 protobuf-es `newFieldList` 描述文本按字段号断言；
  只锁定实际读取的字段，新字段（ModelInfo f26、ChatMessagePrompt f22、ModelUsageStats f13、
  GetChatMessageRequest f28）只登记存在性。仅 assets 目录缺失可 skip，目录存在却没有 schema 锚点必须 fail。

## 源码形状守卫的覆盖边界

`architecture.test.cjs` 的写者守卫识别 `=`/`??=`/`||=`/`&&=`、复合赋值（`+=` 等）、`++`/`--`、`delete holder.slot`、方法变异（`set/delete/clear/push/add/splice`）。但它是**源码形状**判定、不是语义分析：`(x => x)()` 之类旁路不覆盖——注释与测试名都不得宣称「完全封闭」。

- 反证必须对**真实源码文本做回退**（`reverted(from, to)` 整段替换后跑守卫），不要只喂人造行首样例——`installTimeCaptures` 曾因 `^` 行首锚定漏掉行内属性位置的真实捕获。
- **前瞻与 `\s*` 的顺序是坑**：`:\s*(?!...)` 里 `\s*` 能回退到 0、让前瞻落在空格字符上，合法箭头包装会被误报；`\s*` 要收进前瞻内部。这个坑在本仓同一守卫上踩过两次。
- 夹具陷阱：`extension-lifecycle.test.cjs` 的沙盒把 `src/activation/*` 的 `setTimeout` 换成 0ms 来实现快速重试；`managed-settings.cjs` 已**从该替换中排除**——否则 5 s drain 预算会塌成 0ms、drain 恒走超时分支，R1 用例会「因为错误的原因变绿」。新加依赖计时预算的 activation 模块时先核对 `shareGlobals` 的覆盖面。
