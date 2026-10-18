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

- `upstream` 是 **HTTPS** remote。本机已配 URL 限定代理，所以上面是裸命令；**未配置的机器**上会挂约 75 秒后才失败，此时改用
  `HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=localhost,127.0.0.1 git fetch upstream`（`NO_PROXY` 不可省：给 git
  加前缀会让该命令触及的所有 HTTPS 都走代理；见「本机网络路径」）。`origin` 是 SSH，`git push` 一律**不要**加这个前缀。
- 用 **merge**，不要用 `git pull upstream`：显式 fetch + merge 能明确来源，冲突时也便于对照 `merge-base`（见「按需重算差异」）；本仓库已设 `pull.rebase=false`，即使误用
  pull 也不会走 rebase 重写历史、不需要 force push。
- 已启用 `rerere`（`git config --local rerere.enabled true`）：README 等固定位置的重复冲突会自动复用上次解法。但
  **`package.json` 的 `version` 冲突它救不了** —— upstream 每次改的版本号都不同，冲突片段内容随之变化，匹配不上。
- 冲突处理：`package.json` 的 `version` **一律取本 fork 的值（ours）**。版本号由本 fork 自管、不跟随 upstream；上游每次发版都会只在这一行产生冲突，固定改 1
  行即可。

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

**不记录逐文件差异**——差异是**可再生的**（见下节命令），存成清单只会过期：本文件的历史版本曾长期列着已改名的文件（`protocol/chat.cjs`、`protocol/responses.cjs` 在 2026-10-17 改名后，表里仍是旧名）。

| 项 | 值 |
| --- | --- |
| **基线**（真正的 `git merge-base`；本 fork 从未 merge 过，2026-10-18 的 v0.4.0 是**手工结构映射移植**（`3d07548`），不产生 merge 提交，故基线仍停在此处） | `5bae0bf` —— 2026-10-04，`feat: add Fast Context MCP and panel tab in v0.3.42` |
| **上次读取上游** | 2026-10-18 |
| **`upstream/main` 当前位置（已移植，未 merge）** | `713836e` —— tag `v0.4.0`，2026-10-17 |
| **基线以来 upstream 新增提交** | **2（均已移植）**：`58b324b`（web search / 页面读取 / 一键检查，v0.3.43）；`713836e`（v0.4.0：外部 MCP 开关、Goal 开关、稳定 launcher、页面读取、**宿主禁用时恢复自有设置**） |
| 我们领先基线 | 150 个提交（2026-10-18 移植后实测；每次移植都要重算：`git rev-list --count "$(git merge-base upstream/main HEAD)"..HEAD`） |

**不要把「基线」改成 upstream 的新位置**（与旧版本这节的措辞不同，这是 2026-10-18 的修正）：基线一旦上移，`git log 5bae0bf..upstream/main` 就再也列不出这两个**已移植但未 merge**的提交，追踪证据随之消失。只更新「上次读取」与「当前位置」两格。

**这 2 个提交的移植状态（2026-10-18：先读、后按用户决定整体移植）**：

- 结构性冲突：upstream 仍在改**单体** `src/extension.cjs`，而本 fork 已把它拆成 `src/activation/`（`extension.cjs` 仅 154 行）。直接 merge 会在该文件大面积冲突且语义错位 → **不 merge，按结构映射手工移植**。
- **5 项全部已移植**（提交 `3d07548`，随后 `d660869` 升 0.3.49 并完成真机验收）：① `src/lifecycle/host-disabled.cjs` —— 用户在扩展管理器里禁用插件时恢复自有设置，否则 `WINDSURF_API_SERVER_URL` 会一直指向已死的 backend，把用户的 Devin CLI 打坏（正好命中本仓最重的注入面）；② `config.goalEnabled` 开关 —— Goal 默认关闭；③ 外部 MCP（`code_search`/`web_search`/`web_read_url` + 账号检测 + 开关，默认关闭）；④ 页面读取（≤5 次 https 重定向、拒私有主机、不执行脚本）；⑤ 稳定 launcher。
- **结构映射规则（下次照做）**：`panel/model.cjs → panel/manager.cjs`、`runtime/goal-state.cjs → goal/state.cjs`、单体 `extension.cjs → src/activation/*` + `lifecycle` 槽。**不要让上游的旧名文件复活**（会变成没有调用方的孤儿）。
- **刻意保留的 fork 差异，不要被上游覆盖**：版本号（自管）、`repository` 字段、面板 tab 顺序、`postState` 队列与 `reloadWindow`、DOM 助手前缀（`byId(x,'fc-')`）。
- **边界**：Goal 与对外 MCP 属**上游拥有**代码，本机不做 e2e 验收（见 `testing-notes.md`）；「仓库测试全绿」不等于「本机验过」。

看上游有没有值得参考的新改动：

```bash
git fetch upstream && git log --oneline 5bae0bf..upstream/main   # 新增提交
git diff --stat 5bae0bf upstream/main                           # 改了哪些文件
```

同步（或仅阅读）之后，只更新上表的**上次读取**与**当前位置**两格（`git rev-parse --short upstream/main`），并刷新「新增提交」与「领先」两个计数；**基线一格不动**（理由见上）。

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

- `src/update.cjs` 的 `REPOSITORY` —— 取了 upstream 会指向原仓库，本 fork 的自更新随之失效；
- `package.json` 的 `version` —— 一律取 ours（见「同步 upstream」一节）。
