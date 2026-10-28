---
trigger: model_decision
description: "Apply when a 审查/取证 result is being revisited, when someone proposes to 'fix' a suspicious-looking gap in security, retry economics, protobuf reads or config recovery, or when deciding whether an audit finding is a defect or an accepted trade-off — the closed-out residual register of the 2026-10-28 five-dimension audit."
---

# 审查残余登记（audit-residuals）

这是**已核但仍有边界**的登记簿，不是缺陷清单。用途：避免把下面每条"看起来像漏洞/像漏做"的取舍当成缺陷去修，
也避免同一批怀疑被反复重查。**每条都写了判据**；判据不成立时才允许推翻结论。

## 安全面

- **`fast-context` 的 `web_read_url` 不校验 DNS 解析结果**，只查主机名/IP 字面量。理由是代理 fake-IP 模式会把公网名
  解析进保留段，按解析结果拦会误杀正常抓取。**主防线是 TLS**：`fetch` 走默认证书校验，且 `NODE_TLS_REJECT_UNAUTHORIZED=0`
  被显式 fail-closed（`web.cjs`），本地服务无法持有攻击者域名的有效证书。**不要**改成按解析结果拦；残余仅是端口存在性的粗粒度探测。
- **Fast Context 的 MCP 配置是普通 JSON 文件**：`--root` 运行期无法由工具入参改变（工具只有 `query`/`url`），
  但任何有文件写权限的 agent 都能改写它，让**后续会话**指向别的目录。这是"agent 能写文件"这一前提的通用风险，
  **插件侧修不了**；已做的是 `--root` 必须绝对路径 + `realpathSync` + 必须是目录，且设置页与 `fast_context_status` 都会显示当前 root。
- **`panel` 的取证等级**：静态层面已全覆盖（无 `innerHTML`/`eval`/`new Function`；`dom.cjs` 禁 `href/src/srcset/action/formaction/srcdoc/data/poster/background/xlink:href`；
  CSP `default-src 'none'` + 每次渲染 `randomBytes(24)` nonce 并属性转义；扩展侧消息入口白名单 + 形状校验）。
  **运行时（真实 DOM / CSP 是否生效）未取证**——Devin 启动不带 `--remote-debugging-port`，REA 的 web/Electron 工具接不上。
  2026-10-28 决定接受该等级（要补需重启 Devin 并开调试端口）。**不要把"没抓过 DOM"当成"存在注入面"**。

## 并发面

- **`auto-continue` 与 Goal 不会双发**：抑制是实时查询 `goalController.ownsSession(sessionId)`（未归档 goal 记录即真），
  授予所有权时取消已排队定时器，定时器触发时再复查一次。三条都在 `extension.cjs` / `auto-continue.cjs`。
- **残余**：`ownsSession` 是 **fail-closed**——goal 存储读取失败或 corrupt 时返回 `true`，于是自动继续被**静默**抑制；
  `auto-continue-evaluated` 只有 `suppressed: true`，分不清"有活跃 goal"还是"存储坏了"。要区分需把原因带进日志（**未做**，属可选诊断增强）。
- 定时器/监听无泄漏：`auto-continue.dispose → reset()` 清全部 timer 与 session；`goal/continue-hook` **无定时器**；
  `goal/controller.dispose` 取消全部 timer、pause 活跃 goal、解除镜像、释放所有权；每处 `setTimer` 都登记进 `timers`（可观测 `pendingTimers`）。

## 协议面

- **Chat 面收到 `[DONE]` 但不含 `finish_reason` 时，`reason` 落在默认 `2`（`end_turn`）**，即截断被漏判、续跑不触发。
  **证据等级：代码推演，无真机样本**（真机 3 次 `max_tokens` 都带 `finish_reason`）。真机一旦出现"截断没续跑且
  `acp-turn.stopReason=end_turn`"，先查这一项。**不要**为此加"`output_tokens` 等于上限就推断截断"这类推测性逻辑，成本大于收益。
- **`wire.cjs` 的 `num()` 缺字段返回 `0`、`str()` 返回 `''`**：API 层不区分"字段缺失"与"显式零/空串"。现有调用点都做了补偿
  （`maxTokens > 0` 才采用、`find(field => field.wire === 2)` 才算存在）。**新增字段读取必须显式判存在**，别直接信 `num() === 0`。
- **状态信封只在 `verdict === 'match'` 且不超 `MAX_STATE_BYTES` 时回放**，`mismatch`/`oversize` 一律丢弃并退回纯文本 + 工具调用形态；
  失败细分 reason 只出现在 `state-envelope-replay-failed`（正常重放不发日志），所以"为什么没走信封"要去翻失败事件。

## 持久化与发布

- 配置写入是"锁 + 临时文件 + `.bak` + rename + 目录 fsync"，失败清临时文件并抛 `config_write_failed`，不留半写文件；
  激活时遇 `config_corrupt` 会先归档坏文件再从 `.bak` 恢复。**残余**：`.bak` 也坏时需人工修；**不要**改成"损坏即静默重建"（会丢 provider 与凭据）。
- 版本不变量由构造保证：`vsixmanifest` 的 `Identity` 与输出文件名都从 `package.json` 派生；更新时 `verifyPackage`
  用 tag 推出的版本比对包内版本，不一致直接 `identity` 失败。

## 已排除的怀疑（别再重查）

- **自更新没有 unzip 路径穿越**：我们只用 `unzip -p` 把 `extension/package.json`、`extension.vsixmanifest` **读进内存**做身份校验，
  从不解包到目录；真正解包与安装交给 `devin-desktop --install-extension`。落盘文件名由 tag 生成（非 asset 名），下载字节先比 size 再比 sha256，通过后才写盘。
- **`monitor` 没有 SQL 注入面**：`execFile('/usr/bin/sqlite3', ['-readonly','-json',db])`，数组传参、无 shell、只读、SQL 走 stdin。
- **`fast-context` 没有 ripgrep 参数注入**：两处调用都以 `--` 终止选项，排除 glob 强制 `!` 前缀（不可能变 flag），搜索词走 `-e`。
- **2026-10-28 五维全审结论**：安全 / 生命周期并发 / 协议正确性 / 持久化 / 发布 **均未发现必修缺陷**；
  同轮之前已修并验证的 4 个真缺陷（`messageSubIndex` 气泡重复、Goal 同源缺失、退避计数共享、零输出截断空转）见 `runtime-and-injection.md`。
