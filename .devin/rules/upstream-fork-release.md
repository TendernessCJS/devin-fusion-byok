---
trigger: model_decision
description: "同步 upstream、定/升版本、发布或解 merge 冲突时必读——同步规则与发布流程；基线与移植历史见 upstream-port-history.md。"
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

基线位置、逐版本移植状态与 PR 记录已拆到 `upstream-port-history.md`（同步时先读它）。**基线一格不动**；只更新「上次读取」「当前位置」「上一个已移植位点」与两个计数。

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
