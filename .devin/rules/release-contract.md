---
trigger: model_decision
description: "Apply when changing self-update behaviour or the release contract — asset naming, tags, digests, updateProxy, or the restart helper."
---

# 发布契约（release-contract）

自更新运行时契约、Release 资产名/tag/digest 规则、更新代理、重启 helper。流程与验收方法见 `.devin/skills/release/SKILL.md`。

- 自更新运行时只读 `src/update/updater.cjs` 的 `REPOSITORY` 常量，`PAGE` 与 `API` 由它派生（`src/update.cjs` 只是转发门面）。测试通过导出的 `PAGE` 复用，不要重写回硬编码字符串。换仓库需同时改这里与
  `package.json` 的 `repository.url`（后者是纯元数据，运行时不读）。
- **不要修改 `package.json` 的 `name`（必须 `devin-fusion-byok`）和 `publisher`（必须 `local`）**：`verifyPackage()` 会校验包内
  `package.json` 与 `extension.vsixmanifest` 的 Id/Publisher/Version 一致，不一致则拒绝安装。
- Release 资产名必须严格等于 `devin-fusion-byok-<version>.vsix`，且下载地址必须是 GitHub 标准的 `<PAGE>/download/<tag>/<asset>`
  形式（`releaseInfo()` 会做严格相等校验）。`npm run package` 按 `name-version` 命名，与之一致。
- tag 必须是 `v<major>.<minor>.<patch>` 形式的三段纯数字 semver（`v` 可省略）；draft 与 prerelease 一律不被接受。
- 资产必须带 GitHub 自动计算的 `digest`（`sha256:` + 64 位十六进制）且大小 ≤ 50 MiB，否则 `installable=false`，面板只提供「打开发布页面」。
- 插件内 `package.json` 的 `version` 必须严格小于 Release 版本才会提示更新，发布前记得 bump。
- 面板「最新正式版」的唯一来源是 `REPOSITORY` 常量（已固定为 `TendernessCJS/devin-fusion-byok`），比的是**本 fork** 的 Release；
  不要用 `gh release list` 的输出判断最新版——本仓库裸 `gh` 解析到 `upstream`（见 `upstream-fork-release.md`），读到的是上游 Release。
- 一键安装仅在 macOS 且 `<appRoot>/bin/devin-desktop` 存在时可用（`createUpdateHost` 里的 `supported` 判断）；其他情况
  `canInstall=false`，只能手动下载 vsix。
- 更新检查只访问 `api.github.com` 与 GitHub 下载域名（`allowedUrl` 白名单在代理路径同样逐跳校验）。代理由插件自管：`config.json` 的 `updateProxy` 经
  `src/update/proxy-transport.cjs` 建 CONNECT 隧道，只作用于更新检查与一键安装，其余流量（模型请求、内网地址）保持直连。（`src/proxy.cjs` 仅保留同名兼容导出，供旧验收脚本使用。）
  **不要改成读 `http.proxy` 设置或 `HTTPS_PROXY`/`http_proxy`/`ALL_PROXY` 环境变量**——那会全局生效，把内网 HTTPS 地址也送去代理。
  **也不要依赖扩展宿主被打过补丁的 `fetch`**：Devin 启动时会把 `globalThis.fetch` 换成 `@vscode/proxy-agent` 的代理感知版本（读 VS Code 的
  `http.proxy` / `http.noProxy`，`http.proxySupport` 默认 `override`），那也是全局的，同样会波及内网地址——配置 `updateProxy` 时走
  `src/update/proxy-transport.cjs` 的 CONNECT 隧道；未配置代理的更新与模型发现走 `src/network/direct-fetch.cjs`，使用独立 Agent，不依赖宿主全局 `fetch` 或全局 Agent。
  （这些约束只针对**插件运行时代码**；开发者在终端跑 git/gh 命令时按「本机网络路径」一节处理，两者不冲突。）验收方法见 `.devin/skills/release/SKILL.md`。
- **插件侧请求一律经 `src/network/client-request.cjs` 的 `http.ClientRequest` 构造，绝不用 `http.request`/`https.request`**：宿主补丁不只换 `fetch`，还会替换
  `http.request`/`http.get`（`createHttpPatch` 注入 `PacProxyAgent`，`http.proxySupport` 默认 `override`），把我们的
  `createConnection` CONNECT 隧道顶掉——实测表现为跳过代理直连 `api.github.com` 随即 `ECONNRESET`。`ClientRequest` 是公开构造器、
  不在补丁替换范围（`node:https` 没有同名导出，TLS 仍由传入的 `https.Agent` 处理）；`directFetch` 同样必须走这条路，否则用户一旦在 VS Code 里配置
  `http.proxy`，「内网地址直连」的保证就失效。`http.ClientRequest` 缺失时才回退到 `http.request`/`https.request`。
- `updateProxy` 可在面板 **设置 → 更新代理** 编辑（只作用于更新检查与一键安装），清空即直连。`snapshot().proxy` 与面板 `state().updateProxy` 只回显
  `maskProxy()` 掩码（`http://***@host:port`），**凭据不进入
  webview**，也不写入日志或错误文案；直接保存掩码视为未改、不覆盖存储值，输入完整新 URL 才会替换。面板侧校验复用 `parseProxy`，非法输入不回显、不写盘。
- 「重启 Devin」的 detached helper：优先经 `launchctl submit` 注册给 launchd 运行（submit 失败回退 detached `/bin/sh`）——实测
  helper 是 App 后代时其 `open` 请求被归因为 App 自身激活而静默吞掉；已实测从 App 进程树内 `launchctl submit` 的 job 落在用户域 `gui/501`（非 App
  自身的 runningboard 域），因此不随 App 退出被拆除。等 App 退出后只小静置约 3 秒，随后最多 10 轮「先探测再启动」的自适应重试：实测旧实例退出后 ~10 秒内启动的进程会在 ~110ms
  内自退（+1.1s 与 +3.3s 两次中招，+10s 起全部存活），风险窗口是时间性的；但盲等固定时长浪费——一次自退 ~113ms 即可被探测发现，故改成「小静置 + 快速失败探测 + 有限轮重试」，
  若窗口其实来自已修复的陈旧 IPC 句柄则第 1 轮即成功（约 5s），否则轮次自然覆盖窗口之外，最坏与固定静置持平且无固定浪费。113ms 退出的根因已确证是 Devin 自实现的单实例仲裁：主进程监听
  `<userData>/<version>-main.sock`、PID 写入 `<userData>/code.lock`，`claimInstance` 遇 `EADDRINUSE` 时会把请求交接给现有
  owner 并直接 exit 0（不建窗口）；因此 helper 确认 App 已退出后、以及每轮启动前，先移除陈旧的 `*-main.sock` 与 `code.lock`（此时已无活着的 owner，
  与应用自身遇 `ECONNREFUSED` 时删陈旧 handle 的做法一致；`userData` 由 `<globalStorage>` 上溯三级得到）。通道分配保持「`open` 在前、`exec`
  兜底」：前 50% 轮 `open`、中间到 80% `open -n`、最后两轮直接 exec `<bundle>/Contents/MacOS/<AppName>`（不经 LaunchServices 注册，
  参照 Electron `app.relaunch()` 的确定性路径，作为兜底）；探测命中后隔 2 秒复探才算成功（瞬时启动不算），预算内放弃 `exit 1`，取消退出时先 `launchctl remove`
  再退。日志写 `<globalStorage>/restart.log`（每次重启把上一轮轮转为 `restart.log.previous`），行前缀为 UTC 时间戳；`open` 与应用自身的
  stdout/stderr 也追加进该日志，且 `attempt <n> channel=<c>` / `confirmed round=<n>` 记录成功轮次与通道，真实阈值可观测。非 darwin 抛
  `restart_unsupported`；存活探测用 `ps -Ao comm=`（`pgrep` 会跳过祖先进程，而 helper 必在 App 进程树内时不可用）。

- 重启 helper 的 child 必须处理异步 `error`，不能只 catch `spawn()` 的同步异常。launchctl 提交失败才回退一次 shell；**提交超时不回退、不 quit**（结果不确定，迟到成功可能造成双 helper）。shell 必须确认 `spawn` 后才 unref/quit；派生失败、提前退出或超时均报错且不退出应用。error/exit/timeout 只结算一次，迟到事件不得再次回退、quit 或形成未处理 error。真实重启仍由用户确认，测试只能使用隔离假进程。

## 信任根与不可信输入

- 更新链的信任根是 **GitHub TLS**：资产名由已校验版本推导、`browser_download_url` 必须与推导值严格相等、`digest` 必须是 `sha256:<64hex>`——缺任一项即 `installable:false`，不降级为「无 digest 也装」。
- `verifyPackage` 用 `/usr/bin/unzip -p` 读不可信 zip 的两个条目，是有意的最小暴露：只读 stdout、`maxBuffer` 1 MB、超时 15 s。**无代码签名校验**；包内身份（`package.json` 的 name/publisher/version 与 vsixmanifest 的 `Identity`）交叉校验是唯一的包身份边界。
- 含 `<!` 或 `&` 的 vsixmanifest 直接拒绝（防实体注入），重复 Identity 属性判失败。
