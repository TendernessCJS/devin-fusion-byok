---
trigger: model_decision
description: "处理非 macOS 分支、macOS 硬编码路径，或对接 GitHub 与代理时必读"
---

## 本机网络路径

GitHub 必须经本机 `http://127.0.0.1:7897`，不可用时停止，不回退直连。通用命令选路与诊断见 `~/.devin/rules/github-proxy.md`；本仓库只补充：

- `origin` 是 SSH，使用已验证的 SSH 代理通道；`upstream` 是 HTTPS，使用已验证的 GitHub URL 限定代理，缺失时只为当前命令补齐。协议或现有配置变化时重新核实，不把历史本机配置当作当前证明。
- gh 操作显式带 `--repo TendernessCJS/devin-fusion-byok`，不依赖多 remote 下的默认目标；仓库身份与上游同步约束见 `upstream-fork-release.md`。
- Devin 编辑器的代理设置不等于终端已配置。插件 Devin 上游与更新请求的代理契约分别见 `upstream-routing.md`、`release-contract.md`；不要把命令行临时环境变量扩展成全局 Agent、系统代理或 BYOK 路由修改。

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

