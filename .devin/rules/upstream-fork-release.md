---
trigger: model_decision
description: "Apply when syncing `upstream`, choosing or bumping the version, publishing a release, or resolving a merge conflict — the fork sync rules, the upstream baseline (where we last read), the version invariant, the release steps, and how to recompute fork differences on demand."
---

## fork 同步与发布

本仓库是上游 fork。`upstream` 主要作为**参考来源**——看有没有值得借鉴的改动；**行为判断以本机实机调试为准，不以 upstream 的说法为准**（已有多处历史结论因照抄 upstream 祖先状态而被实机推翻，见 `.devin/rules/provider-measurements.md`）。以下约定是刻意设置，merge 时不要被 upstream 覆盖。

### 同步 upstream

```bash
git fetch upstream && git merge upstream/main
```

- fetch/push 前按 `platform-and-network.md` 核对当前代理通道；不要将 Devin 编辑器代理或历史本机配置视作 git 已代理的证明。
- 用 **merge**，不要用 `git pull upstream`：显式 fetch + merge 能明确来源，冲突时也便于对照 `merge-base`（见「按需重算差异」）；本仓库已设 `pull.rebase=false`，即使误用
  pull 也不会走 rebase 重写历史、不需要 force push。
- 已启用 `rerere`（`git config --local rerere.enabled true`）：README 等固定位置的重复冲突会自动复用上次解法。但
  **`package.json` 的 `version` 冲突它救不了** —— upstream 每次改的版本号都不同，冲突片段内容随之变化，匹配不上。
- 冲突处理：`package.json` 的 `version` **一律取本 fork 的值（ours）**。版本号由本 fork 自管、不跟随 upstream；上游每次发版都会只在这一行产生冲突，固定改 1
  行即可。
- **tag 命名空间只属于本 fork**（2026-10-29 设 `git config --local remote.upstream.tagOpt --no-tags`）：上游与 fork 用**同一套版本号**（都发 `v0.4.x`），
  `fetch upstream` 默认会把上游 release tag 一起导入，把本 fork 的发布 tag 语义搅乱——实测导入过 `v0.4.5`（指向 `cdc7d42`，上游提交）与 `v0.4.7`，两者都
  **不是**本 fork 发过的版本（fork 从 `v0.4.0` 直接跳到 `v0.5.1`）；`v0.4.7` 已删。看上游 tag 用 `git ls-remote --tags upstream`；`git fetch --tags upstream`
  会把污染带回来，别用。判据：`for t in $(git tag); do c=$(git rev-parse "$t^{}"); git merge-base --is-ancestor "$c" upstream/main && ! git merge-base --is-ancestor "$c" main && echo "上游 tag: $t"; done`。

### 版本号怎么取

版本号由本 fork 自管，**与 upstream 的版本号无耦合**：自更新只比较「本地 `package.json` 的 version」与「本仓库 GitHub Release 的最新版本」（`API`
  由本仓库的 `REPOSITORY` 派生），upstream 的版本号不参与任何判断。

`parseVersion()` 只认三段纯数字；`0.3.43-1`、`0.3.43+foo`、`0.3.43.1` 会让自更新直接报错失效。

- 发布版本 = 本 fork 上次发布的版本 patch +1；从 0.3.42 起自管，首次发布取 0.3.43。
- **唯一不变式：相对本 fork 自己的历史版本严格递增。** `compareVersions(latest, current)` 要求严格大于，本地版本 ≥ Release 版本时不会提示更新。
- 与 upstream 的版本号大小无关，不必刻意高于 upstream（本地 VSIX 安装是直接替换，安装更低版本不会被拒绝）。
- 发布前校验格式：

```bash
node -e "const v=require('./package.json').version; if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw Error('版本必须是三段纯数字: '+v); console.log('version OK:', v)"
```

代价：取 ours 后 `package.json` 不再反映所基于的 upstream 版本。**merge 提交信息里写明所合并的 upstream 版本**（例如
  `merge upstream v0.3.43`），`git log` 是唯一的追溯来源。

### 发布步骤

完整流程与验收方法见 `.devin/skills/release/SKILL.md`（`/release` 调用）：定版本 → `npm test` → `npm run package` → 推送 + 打 tag
  → 建 Release → **用已安装副本的代码跑读回路校验** → 覆盖安装。

要点：`npm run package` 产出的 `devin-fusion-byok-<version>.vsix` 必须原样命名为 `v<version>` Release 的资产；必须 Publish 而非存为
  draft；Release body 即面板显示的更新说明（截取前 6000 字符）。

**`gh` 在本仓库默认解析到 `upstream`，不是 `origin`**：本机没有 `gh-resolved` 配置，多 remote 时 gh 取名为 `upstream` 的那个
  （2026-10-18 实测：裸 `gh release list` 列出的是上游 v0.3.42/40/39…，`gh repo view --json nameWithOwner` 返回
  `kuobibulaien/devin-fusion-byok`）。因此 `gh release view/list/create` 一律显式带 `--repo TendernessCJS/devin-fusion-byok`，
  否则会读到上游 Release，把「本 fork 最新版本」判错——而版本递增的判据正是「相对本 fork 自己的历史版本」。
  一次性固化可让用户执行 `gh repo set-default origin`（写 `.git/config`）。读回路验收走的是插件自己的 `releaseInfo()`
  （`REPOSITORY` 常量已指向 fork），不经 gh，所以不受这条影响。

### upstream 基线（只记「读到哪儿」）

**不记录逐文件差异**——差异是**可再生的**（见下节命令），存成清单只会过期（本文件曾长期列着已改名的文件）。

| 项 | 值 |
| --- | --- |
| **基线**（真正的 `git merge-base`；本 fork 从未 merge 过，2026-10-18 的 v0.4.0 是**手工结构映射移植**（`3d07548`），不产生 merge 提交，故基线仍停在此处） | `5bae0bf` —— 2026-10-04，`feat: add Fast Context MCP and panel tab in v0.3.42` |
| **上次读取上游** | 2026-11-24 |
| **`upstream/main` 当前位置（未移植，未 merge）** | `2a1cffb` —— `fix: harden remote catalog refresh, WSL/empty-window authority, and reconnect eviction in v0.4.7`，2026-10-29（上游 tag **不再导入本地**，见「同步 upstream」的 tag 命名空间一条） |
| **上一个已移植位点** | `713836e` —— `feat: release v0.4.0 with external MCP switch and Goal switch`，2026-10-17 |
| **⚠️ 别把 `v0.4.0` 当上游 tag** | `git tag --points-at 713836e` 为**空**（上游该 tag 本地未 fetch）；本仓 `v0.4.0` 指向 `e1d609a`，是**本 fork 自己的发布提交**。`git show v0.4.0` 拿到的不是上游移植源 |
| **基线以来 upstream 新增提交** | **5（全部已读）**：`58b324b`（web search / 页面读取 / 一键检查，v0.3.43）；`713836e`（v0.4.0：外部 MCP 开关、Goal 开关、稳定 launcher、页面读取、**宿主禁用时恢复自有设置**）；`cdc7d42`（v0.4.5：原生 picker 兼容，见下条）；`7cea3d8` + `2a1cffb`（v0.4.7：Remote-SSH/WSL 与重连淘汰，见下条） |
| 我们领先基线 | 417 个提交（2026-11-24 实测；每次移植都要重算：`git rev-list --count "$(git merge-base upstream/main HEAD)"..HEAD`） |

**不要把「基线」改成 upstream 的新位置**：基线一旦上移，`git log 5bae0bf..upstream/main` 就列不出**已移植但未 merge**的提交，追踪证据消失。只更新「上次读取」与「当前位置」两格。

**这 2 个提交的移植状态（2026-10-18：先读、后按用户决定整体移植）**：

- 结构性冲突：upstream 仍在改**单体** `src/extension.cjs`，而本 fork 已把它拆成 `src/activation/`（`extension.cjs` 仅 217 行）。直接 merge 会在该文件大面积冲突且语义错位 → **不 merge，按结构映射手工移植**。
- **5 项全部已移植**（`3d07548`，随后 `d660869` 升 0.3.49 并完成真机验收）：`src/lifecycle/host-disabled.cjs`（宿主禁用插件时恢复自有设置，否则 `WINDSURF_API_SERVER_URL` 指向已死 backend，把 Devin CLI 打坏）、`config.goalEnabled` 开关（Goal 默认关闭）、外部 MCP（默认关闭）、页面读取（≤5 次 https 重定向、拒私有主机）、稳定 launcher。
- **结构映射规则（下次照做）**：`panel/model.cjs → panel/manager.cjs`、`runtime/goal-state.cjs → goal/controller.cjs`、单体 `extension.cjs → src/activation/*` + `lifecycle` 槽。**不要让上游的旧名文件复活**（会变成没有调用方的孤儿）。
- **刻意保留的 fork 差异，不要被上游覆盖**：版本号（自管）、`repository` 字段、面板 tab 顺序、`postState` 队列与 `reloadWindow`、DOM 助手前缀（`byId(x,'fc-')`），以及**自动继续的续跑条件**：本仓 `CONTINUABLE_STOP = {max_tokens, max_turn_requests}`、无 plan 的截断直接续；上游是 `end_turn || max_tokens` 且**必须** `hasPendingPlan`。同步时若整体覆盖 `runtime/host/auto-continue.cjs`（上游路径是 `runtime/auto-continue.cjs`），会把 `end_turn` 门控带回来——那是有意分歧不是回归，依据见 `acp-protocol-fields-forensics.md` 的 stop reason 实测与 `runtime-and-injection.md` 的回退条件。
- **边界**：Goal 与对外 MCP 属**上游拥有**代码，本机不做 e2e 验收（见 `testing-notes.md`）；「仓库测试全绿」不等于「本机验过」。

**`cdc7d42`（v0.4.5）的移植状态：读后整体移植、再按用户决定整体回退 → 净移植 0（2026-10-26）**

上游这一版含六块：C 家族/effort 折叠、A picker 首页策展（`homeModels`）、B 原生置顶/最近读写（`windsurf.state.*`）、D `host-catalog` 改写 UserStatus、F `native-models` 重试与 renderer 匹配加固、E backend 代理环境。不可 merge（`merge-tree` 19 处冲突）→ 按「结构映射规则」重写，C+A+B 曾全部落地并通过 1523 测试。

- **A/B 由用户判定不需要**（picker 首页与置顶/最近列表；用户直接搜模型名），已整体回退；`homeModels` 配置键随之消失，无死键。
- **C 回退的理由是「没有消费者」**：`modelChoices` 只喂面板 `modelCount`/`variantCount`，`src/` 没有视图读这两个字段；面板可见的家族数本就来自 `nativeFamilies`。留它只多一个 backend 模块、多一次 `sourceId` 变化导致的重启。
- D/F/E 从未取：D 本 fork `auth-status.cjs` 已更严（多一层输出侧自证）；F 已有 `retry.cjs` 与更严的双通道 renderer 匹配；E 按用户选择不纳入。
- 这轮改动**未提交、无分支**，只存在于 `/tmp` 备份（会被系统清理）。重做按结构映射重新实现，别去找旧分支。

**下次看到 upstream 动 picker/首页/原生列表时的判据**：先确认「有没有人消费这份新数据」再动手——面板能显示的家族数已在 `nativeFamilies` 里，重复做投影只会增加 backend 闭包与重启次数。

**`7cea3d8` + `2a1cffb`（v0.4.7）的移植状态：选择性移植（2026-10-29）**

上游这一版是 Remote-SSH/WSL 支持（约 800 行 + 测试）及其加固。仍然**不 merge**（它继续改单体 `extension.cjs`，且 `host-catalog.cjs` 在本仓不存在），按结构映射重写。

- **移植了**：① 反向隧道 → `src/runtime/host/remote-tunnel.cjs`（端口 `port.cjs` 的 `PORT`，身份 `controlFile(root).rootId`；含 `2a1cffb` 的 CRLF、`lastResolvedAuthority` 兜底等加固）；② 远端激活 → `src/activation/remote-support.cjs`（发现 remote 扩展 main，懒安装 + 代际守卫）＋ `enable.cjs` 的 `!native && remoteName` 分支 ＋ `teardown.cjs` 的 stop；③ ACP 重连淘汰 → registry 新增**可选层钩子 `update`**（包 `api.updateConnection`），远端断线只 `epoch++` 清状态、**不摘挂载**（本地行为逐字未变）；④ 面板：官方模型页的批量停用/启用 + 筛选胶囊（家族粒度，按 250 uid 分批）。
- **有意不取**：① `host-catalog.cjs` 的远端分支（读 `state.vscdb` + `node:sqlite` + `vscode.windsurfAuth`）——本仓目录注入走 LS 桥 ＋ `setAuthStatus` 包装，远端窗口里二者都装不上，无法按结构映射落地，且**写入 auth 存储的路径无法本机验证**；② `officialServer` 白名单加 `server.self-serve.windsurf.com`——本机 native bundle 里 0 处（该 origin 只被我们自己的 Fast Context/Exa 用），属无证据放宽安全校验；③ `panel/controller.cjs` 的 `delete require.cache` 热重载（打包后无收益）；④ picker 首页双列网格（`homeModels`，A/B 早已按用户决定回退）。
- **判据/未验证**：远端链路**未在真实远端窗口验收**，只能看 `activated-remote` 与 `remote-tunnel-unavailable` 两条日志。已知盲点：空窗口（无 folder）且 remote 扩展的 resolver 早于本扩展激活时，`currentAuthority()` 只剩 `lastResolvedAuthority` 兜底。`-R`-only 分支在 resolver wrap 不可用时也能让端口可达，部分缓解该盲点。若将来要补目录注入，先确认 UI 侧 `vscode.windsurfAuth` 是否存在、`state.vscdb` 读的是本地还是远端。

**`PR #2`（`fix: keep Remote-SSH usable when the exec-server tunnel is unavailable`，未合并）的移植状态：已按结构映射移植（2026-11-24）**

上游 main 自 2026-10-29 起没有新提交（仍为 `2a1cffb`），但同日开出的 open PR #2 修的是本仓同构的缺陷：`installRemoteSupport` 在
`createRequire(apiPath)('vscode')` 之后才安装 SSH `-R` 包装，vscode/proposed API 解析失败会连带跳过唯一可用的 `-R` 路径；exec-server
tunnel 失败后 `remoteSupport` 为空，而 `agentEnv` 已把远端 CLI 指向 `127.0.0.1:<port>`，远端 agent 卡在 connection refused。

- 移植了：`-R` 改用 `require('node:child_process')` 独立安装；exec-server manager 降级为 stub（`sshForward` 为真时
  `ensureCurrentRemoteWindowTunnel()` 直接返回端口）；暴露 `sshForward`/`tunnel`/`errors`；`enable()` 在两条路都不可用时
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

### 按需重算差异（不存清单）

```bash
git diff --name-only "$(git merge-base upstream/main HEAD)" HEAD -- src test   # 全部有 fork 改动的文件
git log --oneline "$(git merge-base upstream/main HEAD)..HEAD" -- <file>      # 某文件为何与 upstream 不同
git diff "$(git merge-base upstream/main HEAD)" HEAD -- <file>                # 具体改了什么
```

用 `merge-base` 而不是写死 hash：分叉点会随每次同步自动前移，写死必然过期。

### 同步时的判据（唯一必须记住的）

本 fork 在**共享文件**里有刻意行为分歧，冲突或整文件覆盖时**不要默认取 upstream**：

1. 先跑上面的 `--name-only` 列出差异文件；
2. 对每个文件跑 `-- <file>` 看本侧改动的原因与提交；
3. **有 fork 提交 → 按「保住 fork 行为」解**；**无 fork 提交 → 该文件只有 upstream 在改，取 upstream**；
4. 两边都改了 → **停下来人工判断**。

最容易**静默**坏掉的两处（行为看似正常但功能失效，测试不一定抓得住）：

- `src/update/updater.cjs` 的 `REPOSITORY` —— 取了 upstream 会指向原仓库，本 fork 的自更新随之失效；
- `package.json` 的 `version` —— 一律取 ours（见「同步 upstream」一节）。
