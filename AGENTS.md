# AGENTS.md

Devin Fusion BYOK：一个 Devin/VSCode 扩展，通过运行时桥接把第三方模型（OpenAI Responses / Chat Completions / Anthropic Messages）注入 Devin 原生模型列表，并组合成 Fusion 预设。

## 仓库与 remote

- `origin` = 本仓库的 fork（`git@github.com:TendernessCJS/devin-fusion-byok.git`），是日常推送目标。
- `upstream` = 上游原项目（`https://github.com/kuobibulaien/devin-fusion-byok.git`），只读，**不要向 upstream 推送**。
- 本地 `main` 跟踪 `origin/main`。新克隆或首次拉取后需先执行 `git fetch origin`，否则 `git status` 会显示 `[origin/main: gone]`。
- 同步上游更新见「fork 同步与发布」一节。

## 常用命令

```bash
npm test                                      # node --test test/*.test.cjs
npm run package                               # 生成 .vsix（依赖 /usr/bin/zip）
npm run mcp:fast-context -- --root /abs/proj  # 单独运行 Fast Context MCP
FUSION_FAST_CONTEXT_LIVE=1 node scripts/fast-context-smoke.cjs   # 真实接口验收，消耗官方额度
```

改动后至少跑 `npm test`。测试用 `node:test`，无需安装依赖，也没有 lint/typecheck 步骤。

## 已知测试失败（不要追这个）

`test/native-models-sync.test.cjs:92`（「fails closed on foreign roots…」）在 Node v24.21.0 / macOS 上稳定失败，退出码 1，报错为 `fetch failed` / `ECONNRESET`（`errno: -54`）。全量测试当前为 623 例、622 通过。

已定位的机制：同一端口重启 backend 后，对该 origin 的首次请求复用了 undici 连接池中已被旧服务关闭的 keep-alive socket。复现条件是「重启前已向该 origin 发起 ≥2 次请求」；加重启后 100ms 延迟或请求头 `Connection: close` 即可避免。这是测试暴露的客户端连接复用问题，与 backend 实现无关，**不要为了让它通过而修改断言**。

## 代码约定

- 全部为 CommonJS（`.cjs`），`package.json` 无 `dependencies`。**不要引入运行时依赖**，也不要改成 ESM。
- 日志只允许记录模型名、工具名、状态码、计数。**禁止**把 `apiKey`、控制令牌、`authorization` 头、对话正文写入 output channel 或 `runtime.log`；新增日志前确认 payload 不含凭证。
- 用户可见文案（面板、错误消息、README、命令标题）用中文；代码注释用英文。
- 面向供应商的发现与推理请求必须带 `redirect: 'error'`，避免密钥和对话被重定向到其他地址。
- 写用户设置（`devin.acp.agentEnv` / `devin.acp.agentPreferences`）必须走 `src/lifecycle/owned-settings.cjs` 的 receipt 流程，且 key 需在 `permitted()` 白名单内，保证可回滚。不要直接写 `settings.json`。

## 架构边界

- 本扩展不修改 Devin 应用本体、不重新签名、不安装证书、不改系统代理。保持这个前提。
- 强依赖 Devin 私有接口：LS `Heartbeat` 抓端口（`src/runtime/ls-injection.cjs`）、catalog 的 protobuf 字段号与 Connect 帧（`src/protocol/wire.cjs`、`src/catalog.cjs`）、ACP `registerConnection` 与握手 `api_server_url`（`src/runtime/acp-injection.cjs`、`auto-continue.cjs`、`goal-continue.cjs`）、Fast Context 的 `GetDevstralStream`（`src/fast-context/protocol.cjs`）。这些接口不稳定，改动附近代码时按「可能失败」处理，不要在失败路径上伪装成功。
- 修改行为时不要放宽现有安全校验（Origin 一律 403、控制令牌 `timingSafeEqual`、webview 只用 `createElement`/`textContent` 不用 `innerHTML`、CSP nonce）。

## 自更新（发布约束）

- 自更新运行时只读 `src/update.cjs` 的 `REPOSITORY` 常量，`PAGE` 与 `API` 由它派生。测试通过导出的 `PAGE` 复用，不要重写回硬编码字符串。换仓库需同时改这里与 `package.json` 的 `repository.url`（后者是纯元数据，运行时不读）。
- **不要修改 `package.json` 的 `name`（必须 `devin-fusion-byok`）和 `publisher`（必须 `local`）**：`verifyPackage()` 会校验包内 `package.json` 与 `extension.vsixmanifest` 的 Id/Publisher/Version 一致，不一致则拒绝安装。
- Release 资产名必须严格等于 `devin-fusion-byok-<version>.vsix`，且下载地址必须是 GitHub 标准的 `<PAGE>/download/<tag>/<asset>` 形式（`releaseInfo()` 会做严格相等校验）。`npm run package` 按 `name-version` 命名，与之一致。
- tag 必须是 `v<major>.<minor>.<patch>` 形式的三段纯数字 semver（`v` 可省略）；draft 与 prerelease 一律不被接受。
- 资产必须带 GitHub 自动计算的 `digest`（`sha256:` + 64 位十六进制）且大小 ≤ 50 MiB，否则 `installable=false`，面板只提供「打开发布页面」。
- 插件内 `package.json` 的 `version` 必须严格小于 Release 版本才会提示更新，发布前记得 bump。
- 一键安装仅在 macOS 且 `<appRoot>/bin/devin-desktop` 存在时可用（`createUpdateHost` 里的 `supported` 判断）；其他情况 `canInstall=false`，只能手动下载 vsix。
- 更新检查只访问 `api.github.com` 与 GitHub 下载域名（`allowedUrl` 白名单在代理路径同样逐跳校验）。代理由插件自管：`config.json` 的 `updateProxy` 经 `src/proxy.cjs` 建 CONNECT 隧道，只作用于更新检查与一键安装，其余流量（模型请求、内网地址）保持直连。**不要改成读 `http.proxy` 设置或 `HTTPS_PROXY`/`http_proxy`/`ALL_PROXY` 环境变量**——那会全局生效，把 Gitee 等内网地址也送去代理。验收方法见 `.devin/skills/release/SKILL.md`。

## fork 同步与发布

本仓库是上游 fork，会持续同步 `upstream`。以下约定是刻意设置，merge 时不要被 upstream 覆盖。

### 同步 upstream

```bash
git fetch upstream && git merge upstream/main
```

- 用 **merge**，不要用 `git pull upstream`：显式 fetch + merge 能明确来源，冲突时也便于对照下面的差异表；本仓库已设 `pull.rebase=false`，即使误用 pull 也不会走 rebase 重写历史、不需要 force push。
- 已启用 `rerere`（`git config --local rerere.enabled true`）：README 等固定位置的重复冲突会自动复用上次解法。但 **`package.json` 的 `version` 冲突它救不了** —— upstream 每次改的版本号都不同，冲突片段内容随之变化，匹配不上。
- 冲突处理：`package.json` 的 `version` **一律取本 fork 的值（ours）**。版本号由本 fork 自管、不跟随 upstream；上游每次发版都会只在这一行产生冲突，固定改 1 行即可。

### 版本号怎么取

版本号由本 fork 自管，**与 upstream 的版本号无耦合**：自更新只比较「本地 `package.json` 的 version」与「本仓库 GitHub Release 的最新版本」（`API` 由本仓库的 `REPOSITORY` 派生），upstream 的版本号不参与任何判断。

`parseVersion()` 只认三段纯数字；`0.3.43-1`、`0.3.43+foo`、`0.3.43.1` 会让自更新直接报错失效。

- 发布版本 = 本 fork 上次发布的版本 patch +1；从 0.3.42 起自管，首次发布取 0.3.43。
- **唯一不变式：相对本 fork 自己的历史版本严格递增。** `compareVersions(latest, current)` 要求严格大于，本地版本 ≥ Release 版本时不会提示更新。
- 与 upstream 的版本号大小无关，不必刻意高于 upstream（本地 VSIX 安装是直接替换，安装更低版本不会被拒绝）。
- 发布前校验格式：

```bash
node -e "const v=require('./package.json').version; if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw Error('版本必须是三段纯数字: '+v); console.log('version OK:', v)"
```

代价：取 ours 后 `package.json` 不再反映所基于的 upstream 版本。**merge 提交信息里写明所合并的 upstream 版本**（例如 `merge upstream v0.3.43`），`git log` 是唯一的追溯来源。

### 发布步骤

完整流程与验收方法见 `.devin/skills/release/SKILL.md`（`/release` 调用）：定版本 → `npm test` → `npm run package` → 推送 + 打 tag → 建 Release → **用已安装副本的代码跑读回路校验** → 覆盖安装。

要点：`npm run package` 产出的 `devin-fusion-byok-<version>.vsix` 必须原样命名为 `v<version>` Release 的资产；必须 Publish 而非存为 draft；Release body 即面板显示的更新说明（截取前 6000 字符）。

### 本 fork 相对 upstream 的刻意差异

merge 冲突时以此表为准；表外差异一律视为 upstream 改动，取 upstream。

| 文件 | 差异 |
| --- | --- |
| `src/update.cjs` | `REPOSITORY` 改为 `TendernessCJS/devin-fusion-byok`，并导出 `PAGE` |
| `test/update.test.cjs` | 使用导出的 `PAGE`，不再硬编码仓库 URL |
| `README.md` | 顶部 fork 声明；Releases 链接指向本 fork；保留上游作者署名 |
| `package.json` | 新增 `repository` 字段；`version` 由本 fork 自管，merge 时取 ours |
| `AGENTS.md` | 本 fork 新增（upstream 无），项目约定与 fork 同步规则 |
| `.devin/skills/release/SKILL.md` | 本 fork 新增（upstream 无），发布与自更新验收流程 |

## 待办与死角

- `src/runtime/acp-injection.cjs`、`src/runtime/acp-observer.cjs` 在 `src/` 内无任何调用点（仅各自测试通过 `vm` 加载）；`src/config.cjs` 的 `updateSidekicks()` 同样未被调用。改动这两块前先确认是否已废弃。
- macOS 专属硬编码：一键更新与「重启 Devin」（`src/update.cjs` 用 `/usr/bin/unzip`）、打包用 `/usr/bin/zip`、用量统计用 `/usr/bin/sqlite3`。跨平台改动需一并处理这些路径。

## 测试注意

- `test/support/installed-renderer.cjs` 与 5 处条件 `skip` 依赖本机已安装的 Devin 原生渲染文件；缺失时会跳过而非失败。
- Goal 与 Fast Context 目前只有模拟连接 / 合成代码的测试，尚未在真实 Devin 窗口完成端到端验收。
