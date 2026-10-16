---
trigger: model_decision
description: "Apply when syncing `upstream`, choosing or bumping the version, publishing a release, or resolving a merge conflict — the fork sync rules, the upstream baseline (where we last read), the version invariant, the release steps, and how to recompute fork differences on demand."
---

## fork 同步与发布

本仓库是上游 fork。`upstream` 主要作为**参考来源**——看有没有值得借鉴的改动；**行为判断以本机实机调试为准，不以 upstream 的说法为准**（已有多处历史结论因照抄 upstream 祖先状态而被实机推翻，见 `.devin/rules/testing-notes.md` 的「已实测的供应商面行为」）。以下约定是刻意设置，merge 时不要被 upstream 覆盖。

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

### upstream 基线（只记「读到哪儿」）

**不记录逐文件差异**——差异是**可再生的**（见下节命令），存成清单只会过期：本文件的历史版本曾长期列着已改名的文件（`protocol/chat.cjs`、`protocol/responses.cjs` 在 2026-10-17 改名后，表里仍是旧名）。

| 项 | 值 |
| --- | --- |
| **基线**（我们分叉自，也是最后读到的 upstream 位置） | `5bae0bf` —— `upstream/main`，2026-10-04，`feat: add Fast Context MCP and panel tab in v0.3.42` |
| **上次读取上游** | 2026-10-17 |
| **基线以来 upstream 新增提交** | **0**（`upstream/main` 仍停在 `5bae0bf`） |
| 我们领先基线 | 121 个提交，**从未同步过** |

看上游有没有值得参考的新改动：

```bash
git fetch upstream && git log --oneline 5bae0bf..upstream/main   # 新增提交
git diff --stat 5bae0bf upstream/main                           # 改了哪些文件
```

同步（或仅阅读）之后，把上表的**基线**与**上次读取**两格更新为新位置（`git rev-parse --short upstream/main`）、并刷新「新增提交」与「领先」两个计数。

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
