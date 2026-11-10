# Devin 原生兼容复验记录（滚动）

本文件记录每次 Devin Desktop 升级后的复验结果。**它是观测记录，不是兼容性承诺**：`status: ok` 与测试全绿只说明本轮核对过的面仍然成立，不覆盖真实会话的端到端行为。

3.12.28 那轮的有界 REA 与关键链路专项审查结论已并入下表那一行；当时的证据目录在 `/tmp`，已不可复现。

## 复验方法

一条命令覆盖「静态契约 → 运行期契约缓存 → 已安装扩展身份 → 运行日志聚合」：

```bash
npm run verify                    # 默认 24h 日志窗口
npm run verify -- --with-tests    # 追加窄测（含从当前 bundle 抽取 ACP 终态判据）
```

退出码：`FAIL` → 1；仅 `WARN` → 0；`ok` → 0；用法错误 → 2。`--json` 给出同结构的机器可读结果。

判定口径不随版本调整：`state-envelope-replay-failed`、`tool-name-unknown`、`forward-timeout` 固定为 INFO——回放未命中是回退而非错误，后两者不阻断请求，把稳态升级成 WARN 只会制造假故障（`test/verify-install.test.cjs` 守着这条映射）。

**它不覆盖**：非 macOS 平台、Sidekick 走 BYOK 的组合、`assignment_jwt` 的运行时校验、真实付费端到端会话；REA 语义图仍为 partial。

## 版本记录

| Devin | 观测时间 | 静态契约 | 运行期契约缓存 | 窄测 | 全量 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 3.12.28 | 2026-11-09 上午 | `ok`，`missing {}` | `ok` | 31/31（当轮修复后） | 1748 全绿 | 未发现必修实现缺陷；唯一问题是 ACP 测试入口指向已删模块，当轮已修 |
| 3.12.32 | 2026-11-09 10:03 | `ok`，`missing {}` | `ok`，`appVersion 3.12.32` | 128 / 0 / 0 | 1755 全绿 | 兼容；同日新增 `npm run verify` 复验脚本 |
| 3.12.43 | 2026-11-10 08:13 | `ok`，`missing {}` | `ok`，`appVersion 3.12.43` | 128 / 0 / 0 | 1755 全绿 | 兼容；夹具 11/11 仍成立（见下节） |

三版共同的稳态项：informational 只有 `desktop: devin.refreshUserStatus`（3.12.17 起官方删除该命令，插件已不再调用，缺失是稳态不是漂移），`catalog-unknown.json` 均不存在。

## 3.12.43 产物指纹（2026-11-10）

| 产物 | 路径 | 字节 | sha256 |
| --- | --- | --- | --- |
| cli | `…/extensions/windsurf/devin/bin/devin` | 192,098,880 | `6ae38d214ade53f669d8a2851693c02f33537dca7fade29364de241f7ef86a33` |
| ls | `…/extensions/windsurf/bin/language_server_macos_arm` | 147,091,808 | `4ee36e5b213e677e46ae8a60e9e25f6c93a0c31400d6f438e2061810485db3b1` |
| desktop | `…/out/vs/workbench/workbench.desktop.main.js` | 23,712,860 | `cb22ba5d1b9f95881e08cde229c00d9278d7f6a0e6d5f604a39ea293dc302519` |
| chat | `…/out/vs/workbench/windsurf-chat-client/index.js` | 28,819,940 | `e8aad50dee865d1e43559ae16c929d192553b08aba83af703edaad78318fafb7` |
| acp | `…/extensions/windsurf/dist/extension.js` | 6,556,600 | `ed9e5184115d4c517281d9d14a4ee5ceb3b1fdd85dff7898a73d5d459c8b78ff` |

## 3.12.43 运行期观测

- **目录注入**：`GetCliTeamSettings` models 238 / matrix 229 / own `0 → 99`；同日早期的 `GetUserStatus` 为 own `0 → 207`。同一批注入出现在多个目录 RPC 上属既有契约，`verify` 只取窗口内最后一条判断「有没有注入过」，不用于判断注入数量。
- **推理**：24h 窗口内 `chat-complete` 484 条，状态全为 200；`request-error` 0。3.12.43 上今日仅 3 个回合，样本很小，不能当作长稳结论。
- **回放未命中**：`state-envelope-replay-failed` 91 条，全部早于 2026-11-09T08:56Z（3.12.32 时期），reason 仅 `id`；今日窗口 0 条。这是**回退**不是错误，且 DeepSeek 面的回放既无收益也无害（见 `provider-measurements-forensics.md`）。
- **其他诊断**：`tool-name-unknown: view_image` 1 次、`forward-timeout` 2 次（均 connect 阶段），都发生在 2026-11-09；两者都不阻断请求，也不影响判定。
- `catalog-unknown.json` 不存在：没有出现白名单外的原生目录 RPC。

## 夹具与版本的绑定关系

`test/fixtures/real-picker.json` 捕获于 3.12.28（2026-11-09）。2026-11-10 复核：这 11 条原生条目在 3.12.43 的实时 `native-cache.json`（1018 条）里 **label 与 name 逐字一致、零缺失**，因此没有随版本重捕。

重捕的触发条件是：**这些行发生变化，或 picker 报文契约发生变化**；版本号前进本身不构成重捕理由。

## 仍未验证

- 非 macOS 平台（本仓只以 macOS 为目标平台，其他平台未验证）。
- Sidekick 走 BYOK：原生 `swe-2` 不经过插件、进不了 `runtime.log`，这条腿至今没有真实证据。
- `assignment_jwt` 的运行时校验。
- 3.12.43 上的真实端到端验收（今日仅 3 个回合）。
