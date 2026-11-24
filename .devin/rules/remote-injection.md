---
trigger: model_decision
description: "改远端窗口（Remote-SSH/WSL）的反向隧道、probe、enable 门控或 getRemoteExecServer 降级时必读——与本地注入面的边界。"
---

# 远端窗口注入（Remote-SSH/WSL）

本地窗口的 ACP/LS 注入面见 `runtime-and-injection.md`；移植取舍见 `upstream-port-history.md`。

## 远端窗口只提供反向隧道

**远端窗口（Remote-SSH/WSL）不提供目录注入，只提供反向隧道**（2026-10-29 按 upstream v0.4.7 移植）：本扩展是 `extensionKind: ["ui"]`，远端窗口里它在本地跑、原生 `codeium.windsurf` 在远端 → `nativeMain` 为 null，`ls-injection` / `auth-status` / ACP registry 全部装不上。远端分支只做两件事：`src/runtime/host/remote-tunnel.cjs` 建反向隧道（ssh 注入 `-R 127.0.0.1:39842:127.0.0.1:39842`，或经 `getRemoteExecServer` 起远端 node 做 stdio 帧复用），以及既有 agentEnv 写入把远端 CLI 指向 `http://127.0.0.1:39842`。**桌面目录在远端窗口永远观测不到**（`nativeCatalogStatus` 直接置 `unsupported`），不要为此加轮询或伪造 ready。隧道安装的 `child_process.spawn` 是**进程级共享**补丁（与 `http.request` 同类），只对带 `SSH_ASKPASS`/`WINDSURF_SSH_ASKPASS_` 且含 `-v -T -D` 的 ssh 调用注入参数；`installRemoteSupport` 不得重复安装（重复包装只有一份能还原）。**只有 `vscode.env.remoteName` 存在时才 eager start**：本地窗口没有可隧道的 authority，装上去的进程级补丁只会白装。本地窗口改跑 `probeRemoteSupport`（`isEnabled: () => false` 装一次、立刻 dispose、记 `remote-support-probe`）——它是「这台宿主还能不能被包装」的金丝雀，缺了它，可包装性的破坏要等到第一次开远端窗口才暴露。安装失败**不得只记事件名**——`describeError` 记 `code` + 截断到 200 字符的 `message`，否则「远端支持其实一直没装上」和「无影响噪声」在日志里长得一模一样。`installRemoteSupport` 分两段独立安装、**不整体抛错**：`-R` 段只用 `node:child_process`；exec 段在 resolver workspace 缺 `getRemoteExecServer`（隐藏 API，公开 d.ts 无此方法）时降级 stub（`tunnel=false`、`resolver` 仍为 true），在 wrap 失败时回滚本段并同样降级 stub；`-R` 可用时 `ensureCurrentRemoteWindowTunnel()` 直接返回端口；每段失败只 `unwind` 自己的包装，否则那份进程级补丁永远没有还原者。probe 以 `sshForward || resolver` 判定 host 可 patch。远端链路**未在真实远端窗口验收**（判据与移植取舍见 `upstream-port-history.md`）。**`createRequire` 锚点必须是真实文件**：`discoverRemoteMain` 的 `base`→`.js`→`.json`→`index.js` 归一化不得移除（见 `runtime-forensics.md`）。
