---
trigger: model_decision
description: "同步 upstream、核对基线位置或某一版本是否已移植时必读——基线表与逐版本移植状态；同步规则与发布流程见 upstream-fork-release.md。"
---

# upstream 移植历史

本卷只记录「读到哪儿」与逐版本移植状态；同步规则、版本号策略与发布步骤见 `upstream-fork-release.md`。

## upstream 基线（只记「读到哪儿」）

**不记录逐文件差异**——差异是**可再生的**（命令见 `upstream-fork-release.md` 的「按需重算差异」），存成清单只会过期。

| 项 | 值 |
| --- | --- |
| **基线**（真正的 `git merge-base`；本 fork 从未 merge 过，2026-10-18 的 v0.4.0 是**手工结构映射移植**（`3d07548`），不产生 merge 提交，故基线仍停在此处） | `5bae0bf` —— 2026-10-04，`feat: add Fast Context MCP and panel tab in v0.3.42` |
| **上次读取上游** | 2026-11-24 |
| **`upstream/main` 当前位置（未移植，未 merge）** | `2a1cffb` —— `fix: harden remote catalog refresh, WSL/empty-window authority, and reconnect eviction in v0.4.7`，2026-10-29（上游 tag **不再导入本地**，见 `upstream-fork-release.md`「同步 upstream」的 tag 命名空间一条） |
| **上一个已移植位点** | `713836e` —— `feat: release v0.4.0 with external MCP switch and Goal switch`，2026-10-17 |
| **⚠️ 别把 `v0.4.0` 当上游 tag** | `git tag --points-at 713836e` 为**空**（上游该 tag 本地未 fetch）；本仓 `v0.4.0` 指向 `e1d609a`，是**本 fork 自己的发布提交**。`git show v0.4.0` 拿到的不是上游移植源 |
| **基线以来 upstream 新增提交** | **5（全部已读）**：`58b324b`（web search / 页面读取 / 一键检查，v0.3.43）；`713836e`（v0.4.0：外部 MCP 开关、Goal 开关、稳定 launcher、页面读取、**宿主禁用时恢复自有设置**）；`cdc7d42`（v0.4.5：原生 picker 兼容，见下条）；`7cea3d8` + `2a1cffb`（v0.4.7：Remote-SSH/WSL 与重连淘汰，见下条） |
| 我们领先基线 | 417 个提交（2026-11-24 实测；每次移植都要重算：`git rev-list --count "$(git merge-base upstream/main HEAD)"..HEAD`） |

**不要把「基线」改成 upstream 的新位置**：基线一旦上移，`git log 5bae0bf..upstream/main` 就列不出**已移植但未 merge**的提交，追踪证据消失。只更新「上次读取」与「当前位置」两格。

**这 2 个提交的移植状态（2026-10-18 整体移植）**：

- 结构性冲突：upstream 仍在改**单体** `src/extension.cjs`，而本 fork 已把它拆成 `src/activation/`，`extension.cjs` 只剩入口层。直接 merge 会在该文件大面积冲突且语义错位 → **不 merge，按结构映射手工移植**。
- **5 项全部已移植**（`3d07548`，随后 `d660869` 升 0.3.49）：`src/lifecycle/host-disabled.cjs`（宿主禁用插件时恢复自有设置，否则 `WINDSURF_API_SERVER_URL` 指向已死 backend，把 Devin CLI 打坏）、`config.goalEnabled` 开关（Goal 默认关闭）、外部 MCP（默认关闭）、页面读取（≤5 次 https 重定向、拒私有主机）、稳定 launcher。
- **结构映射规则（下次照做）**：`panel/model.cjs → panel/manager.cjs`、`runtime/goal-state.cjs → goal/controller.cjs`、单体 `extension.cjs → src/activation/*` + `lifecycle` 槽。**不要让上游的旧名文件复活**（会变成没有调用方的孤儿）。
- **刻意保留的 fork 差异，不要被上游覆盖**：版本号（自管）、`repository` 字段、面板 tab 顺序、`postState` 队列与 `reloadWindow`、DOM 助手前缀（`byId(x,'fc-')`），以及**自动继续的续跑条件**：本仓 `CONTINUABLE_STOP = {max_tokens, max_turn_requests}`、无 plan 的截断直接续；上游是 `end_turn || max_tokens` 且**必须** `hasPendingPlan`。同步时若整体覆盖 `runtime/host/auto-continue.cjs`（上游路径是 `runtime/auto-continue.cjs`），会把 `end_turn` 门控带回来——那是有意分歧不是回归，依据见 `acp-protocol-fields-forensics.md` 的 stop reason 实测与 `runtime-and-injection.md` 的回退条件。
- **边界**：Goal 与对外 MCP 属**上游拥有**代码，本机不做 e2e 验收（见 `testing-notes.md`）；「仓库测试全绿」不等于「本机验过」。

**`cdc7d42`（v0.4.5）的移植状态：整体移植后按用户决定整体回退 → 净移植 0（2026-10-26）**

上游这一版含六块：C 家族/effort 折叠、A picker 首页策展（`homeModels`）、B 原生置顶/最近读写（`windsurf.state.*`）、D `host-catalog` 改写 UserStatus、F `native-models` 重试与 renderer 匹配加固、E backend 代理环境。不可 merge（`merge-tree` 19 处冲突）→ 按「结构映射规则」重写。

- **A/B 由用户判定不需要**（picker 首页与置顶/最近列表；用户直接搜模型名），已整体回退；`homeModels` 配置键随之消失，无死键。
- **C 回退的理由是「没有消费者」**：`modelChoices` 只喂面板 `modelCount`/`variantCount`，`src/` 没有视图读这两个字段；面板可见的家族数本就来自 `nativeFamilies`。留它只多一个 backend 模块、多一次 `sourceId` 变化导致的重启。
- D/F/E 从未取：D 本 fork `auth-status.cjs` 已更严（多一层输出侧自证）；F 已有 `retry.cjs` 与更严的双通道 renderer 匹配；E 按用户选择不纳入。
- 重做按结构映射重新实现，别去找旧分支。

**下次看到 upstream 动 picker/首页/原生列表时的判据**：先确认「有没有人消费这份新数据」再动手——面板能显示的家族数已在 `nativeFamilies` 里，重复做投影只会增加 backend 闭包与重启次数。

**`7cea3d8` + `2a1cffb`（v0.4.7）的移植状态：选择性移植（2026-10-29）**

上游这一版是 Remote-SSH/WSL 支持及其加固。仍然**不 merge**（它继续改单体 `extension.cjs`，且 `host-catalog.cjs` 在本仓不存在），按结构映射重写。

- **移植了**：① 反向隧道 → `src/runtime/host/remote-tunnel.cjs`（端口 `port.cjs` 的 `PORT`，身份 `controlFile(root).rootId`；含 `2a1cffb` 的 CRLF、`lastResolvedAuthority` 兜底等加固）；② 远端激活 → `src/activation/remote-support.cjs`（发现 remote 扩展 main，懒安装 + 代际守卫）＋ `enable.cjs` 的 `!native && remoteName` 分支 ＋ `teardown.cjs` 的 stop；③ ACP 重连淘汰 → registry 新增**可选层钩子 `update`**（包 `api.updateConnection`），远端断线只 `epoch++` 清状态、**不摘挂载**（本地行为逐字未变）；④ 面板：官方模型页的批量停用/启用 + 筛选胶囊（家族粒度，按 250 uid 分批）。
- **有意不取**：① `host-catalog.cjs` 的远端分支（读 `state.vscdb` + `node:sqlite` + `vscode.windsurfAuth`）——本仓目录注入走 LS 桥 ＋ `setAuthStatus` 包装，远端窗口里二者都装不上，无法按结构映射落地，且**写入 auth 存储的路径无法本机验证**；② `officialServer` 白名单加 `server.self-serve.windsurf.com`——本机 native bundle 里 0 处（该 origin 只被我们自己的 Fast Context/Exa 用），属无证据放宽安全校验；③ `panel/controller.cjs` 的 `delete require.cache` 热重载（打包后无收益）；④ picker 首页双列网格（`homeModels`，A/B 早已按用户决定回退）。
- **判据/未验证**：远端链路**未在真实远端窗口验收**，只能看 `activated-remote` 与 `remote-tunnel-unavailable` 两条日志。已知盲点：空窗口（无 folder）且 remote 扩展的 resolver 早于本扩展激活时，`currentAuthority()` 只剩 `lastResolvedAuthority` 兜底。`-R`-only 分支在 resolver wrap 不可用时也能让端口可达，部分缓解该盲点。若将来要补目录注入，先确认 UI 侧 `vscode.windsurfAuth` 是否存在、`state.vscdb` 读的是本地还是远端。

**`PR #2`（`fix: keep Remote-SSH usable when the exec-server tunnel is unavailable`，未合并）的移植状态：已按结构映射移植（2026-11-24）**

open PR #2（上游 main 仍停在 `2a1cffb`）修的是本仓同构的缺陷：`installRemoteSupport` 在
`createRequire(apiPath)('vscode')` 之后才装 `-R` 包装，API 解析失败连带跳过唯一可用的 `-R`；exec tunnel 失败后 `remoteSupport` 为空而
`agentEnv` 已指向 `127.0.0.1:<port>`，远端 agent 卡 connection refused。

- 移植了：`-R` 改用 `require('node:child_process')` 独立安装；exec-server manager 降级为 stub（`sshForward` 为真时
  `ensureCurrentRemoteWindowTunnel()` 直接返回端口）；暴露 `sshForward`/`tunnel`/`errors`（后续加固又加了 `resolver`，语义见 `remote-injection.md`）；`enable()` 在两条路都不可用时
  drain + 恢复 owned settings 并抛 `remote_support_unavailable`（含 zh-CN/en 文案）。
- fork 差异（不要照抄上游）：`probeRemoteSupport` 原本依赖 install 抛错判断「host 能否被 patch」，移植后改读能力位
  （`sshForward || resolver`），失败原因经 `errors` 投影保留；「failed install unwinds」测试改为「resolver 段失败只回滚自身」。
  install 检测 `getRemoteExecServer`：缺失即 `tunnel=false`、`resolver` 仍装；不取 native workspace 回退（remote 下 `nativeMain` 恒 null）。
- 未验证：远端链路仍无真机验收，只能看 `activated-remote` 与 `remote-*-unavailable` 日志。

看上游有没有值得参考的新改动：

```bash
git fetch upstream && git log --oneline 5bae0bf..upstream/main   # 新增提交
git diff --stat 5bae0bf upstream/main                           # 改了哪些文件
```

同步（或仅阅读）之后，只更新上表的**上次读取**、**当前位置**、**上一个已移植位点**（仅当这次真的移植了）三格与「新增提交」「领先」两计数；**基线一格不动**（理由见上）。

