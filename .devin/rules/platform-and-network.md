---
trigger: model_decision
description: "处理非 macOS 分支、macOS 硬编码路径，或对接 GitHub 与代理时必读"
---

## 本机网络路径

本机直连 GitHub 不可用，必须经代理；代理不可用时停止并报告，不要回退直连。**代理机制与本机配置的权威说明在用户级规则 `~/.devin/global_rules.md` 的「外部网站代理」**（代理地址、
  `~/.ssh/config` 的 `ProxyCommand`、git 的 URL 限定配置、`gh` 为何只能靠环境变量），本节只记本仓库要用的结论：

| 目标 | 协议 | 命令里要不要加 `HTTPS_PROXY` |
| --- | --- | --- |
| `origin`（`git push` / `git fetch`） | SSH | **不要**：`~/.ssh/config` 的 `ProxyCommand` 自动代理 |
| `upstream`（`git fetch`） | HTTPS | **不要**：本机已配 URL 限定代理，裸命令即可；未配置的机器要加 |
| `gh`（建 Release 等） | HTTPS | **要**：`gh` 没有 proxy 配置项，也不读 git 配置 |

代理只管「怎么连」，「连到哪个仓库」是另一回事：本仓库裸 `gh` 解析到 `upstream`，见上一节。

用 `git remote -v` 确认 remote 属于哪种。HTTPS remote 漏了前缀是**长时间挂起**而非快速报错——卡住 10 秒以上先怀疑这个。

不要用无作用域的 `git config --global http.proxy`：它作用于**所有** HTTPS remote，会把 HTTPS 形态的内网仓库也送进代理（SSH 形态的内网 remote 不受任何
  `http.proxy` 影响）。改动用户级 git 配置须由用户自行执行。


## 平台支持

**只以 macOS 为目标平台**（个人自用，本机即 macOS）：验证、真机验收、发布检查都只针对 macOS。其他平台按「逻辑可行」的最低标准处理，**短期不做实机验证**。
- **不要声称非 macOS 已验证可用**。涉及平台差异的行为，在代码与文档里注明「仅 macOS 验证」。
- **非 macOS 必须明确失败，不得静默出错**。既有先例（沿用这个模式）：`src/runtime/host/app-restart.cjs` 在非 darwin 抛 `restart_unsupported`，
  面板提示「当前环境不支持重启 Devin」；`src/update/updater.cjs` 的 `supported` 判断使非 macOS 只能手动装 vsix。注意 `package.json` **未设 `os` 字段**，
  其他平台能装上、只是相应功能不可用。
- **已知 macOS 硬编码**（非 macOS 上会失败或降级，暂无适配计划）：`/usr/bin/sqlite3`（用量归属，`src/monitor/store.cjs`；失败降级为 `unavailable`）、
  `/usr/bin/unzip`（一键安装，`update/updater.cjs`）、`/usr/bin/open` 与 `/usr/bin/grep`（重启 Devin，`app-restart.cjs`）、
  `/usr/bin/zip`（打包，`scripts/package.cjs`）。Fast Context 的 ripgrep 查找是唯一带回退的：`FUSION_FAST_CONTEXT_RG` → `PATH`
  → `/Applications/Devin.app/...`，都找不到才抛 `ripgrep_unavailable`。
- **测试只覆盖逻辑分支**：平台差异靠注入参数验证（如 `platform` 形参、`resolveNode(env, platform)`），不依赖真机。
- 结论：**不要为未验证的平台做重构**；能低成本避免耦合就避免，已硬编码的保持现状。

