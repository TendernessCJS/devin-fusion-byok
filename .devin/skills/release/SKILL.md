---
name: release
description: 发布 devin-fusion-byok 新版本并验收自更新（bump 版本 → 测试 → 打包 → 推送 tag → 建 GitHub Release → 读回路验收 → 覆盖安装）。当用户要求"发新版本""发布 vsix""建 Release""验收自更新""检查更新失败"，或需要改动发布契约（资产命名、tag 格式、digest 校验、releaseInfo/verifyPackage）时使用。
argument-hint: "[version]"
allowed-tools:
  - read
  - grep
  - glob
permissions:
  allow:
    - Exec(npm run package)
    - Exec(npm test)
    - Exec(node --test)
    - Exec(gh release view)
    - Exec(HTTPS_PROXY=http://127.0.0.1:7897 gh release view)
    - Exec(gh release list)
    - Exec(HTTPS_PROXY=http://127.0.0.1:7897 gh release list)
    - Exec(git status)
    - Exec(git log)
    - Exec(git diff)
    - Exec(git rev-parse)
    - Exec(git ls-remote)
    - Exec(shasum)
---

# 发布与自更新验收

覆盖「发一个新版本 → 让插件自更新真正可用 → 验收」全流程。发布契约的权威定义在 `src/update/updater.cjs`（`releaseInfo()` / `verifyPackage()`，`src/update.cjs` 为门面）与 `.devin/rules/release-contract.md`；本 skill 只固化流程与验收方法，规则冲突时以那两处为准。

## 0. 先确认你在改什么

| 想做的事 | 去哪 |
| --- | --- |
| 发布一个已就绪的版本 | 走下面 1→7 |
| 改动发布契约（资产名 / tag / digest 规则） | 先改 `src/update/updater.cjs` + `test/update.test.cjs` 并补测试，再发布 |
| 同步 upstream | 见 `.devin/rules/upstream-fork-release.md`，不是本 skill |

**不要改** `package.json` 的 `name`（`devin-fusion-byok`）与 `publisher`（`local`）：`verifyPackage()` 会校验包内身份，改了就拒绝安装自己的包。

## 1. 定版本号

版本自管递增：`patch +1`。唯一不变式是**严格大于本 fork 上次发布的版本**——`compareVersions(latest, current)` 要求严格大于，相等时面板不会提示更新。与 upstream 的版本号大小无关。

```bash
node -e "const v=require('./package.json').version; if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw Error('版本必须是三段纯数字: '+v); console.log('version OK:', v)"
```

三段纯数字是硬约束：`0.3.44-1`、`0.3.44+foo`、`0.3.44.1` 会让 `parseVersion()` 抛错，自更新彻底失效（表现为面板「检查更新失败」）。

要查「本 fork 上次发布了什么」，用本地 tag 最稳（不受 `gh` 解析仓库影响）：

```bash
git tag --list 'v*' --sort=-v:refname | head -3
```

用 `gh release list` 时**必须**带 `--repo TendernessCJS/devin-fusion-byok`，原因见第 5 步末尾。

## 2. 跑测试

```bash
npm test
```

**应全绿 0 失败**。曾有的 `native-models-sync` 连接复用失败已由 `src/runtime/host/retry.cjs` 的 `withConnectionRetry` 修复（见 `AGENTS.md`「测试基线」）；出现任何失败先查清再继续，**不要为了通过测试而修改断言**。

## 3. 打包

```bash
npm run package && shasum -a 256 devin-fusion-byok-*.vsix
```

产出 `devin-fusion-byok-<version>.vsix`，记下字节数与 sha256，第 6 步要用。`npm run package` 按 `name-version` 命名，与 `releaseInfo()` 的严格相等校验天然一致。

## 4. 提交、推送、打 tag

```bash
git add -A && git commit
git push origin main
git tag v<version> && git push origin v<version>
```

`origin` 是本 fork，**永不向 `upstream` 推送**。tag 必须是 `v<major>.<minor>.<patch>` 三段纯数字。

推送前按 `.devin/rules/platform-and-network.md` 与 `~/.devin/rules/github-proxy.md` 确认通道：本仓库 `origin` 是 SSH，`HTTPS_PROXY` 前缀不能代替 SSH 代理；第 5 步 gh 的 API 使用 HTTPS。

## 5. 建 Release

```bash
HTTPS_PROXY=http://127.0.0.1:7897 gh release create v<version> \
  devin-fusion-byok-<version>.vsix \
  --repo TendernessCJS/devin-fusion-byok \
  --title "v<version>" --notes "<更新说明>"
```

三条容易漏的：

- 资产文件名**必须原样**保留 `devin-fusion-byok-<version>.vsix`。改名会让 `releaseInfo()` 的严格相等校验失败，一键安装退化为「打开发布页面」。
- 必须点 **Publish**，不能只 Save draft——draft 与 prerelease 一律不被接受。
- Release body 就是面板显示的更新说明（`releaseInfo()` 取前 6000 字符），要写清这版做了什么。

**这一步刻意保留人工确认**：`permissions.allow` 未放行 `gh release create`，因为它是对外生效操作。同理 `git push`、`git tag` 与安装 vsix 也未放行。不要为了省一次确认而把它们加进 allow。

代理前缀会改变权限匹配的命令形态，现有 `permissions.allow` 同时保留带与不带前缀的只读 gh 命令。按网络规则决定实际选路，不为命中 allow 而移除必要代理或扩大授权；权限匹配不能代替代理验证。

另外 **`gh release view` / `gh release list` 必须带 `--repo TendernessCJS/devin-fusion-byok`**：本仓库多 remote 且 gh 优先取名为
  `upstream` 的那个，裸跑会列出**上游** Release（实测 `gh release list` 返回上游的 v0.3.42/40/39…，本 fork 的 v0.3.48 不在其中）。
  第 5 步的 `create` 已带 `--repo`，`view`/`list` 容易漏。第 6 步的读回路验收不经 gh（走插件 `releaseInfo()`），不受影响。

## 6. 验收：读回路，不只看网页

网页显示正常 ≠ 插件能用。**用已安装副本的代码**跑一遍真实回路。

**走插件自带的代理路径**：下面向 `requestBytes` 显式传入 `compileProxyPolicy` 快照，只验证安装副本的传输与发布契约；面板实际取源于 Devin 用户级 `http.proxy`/`http.noProxy`。该片段不能代替宿主取源验收，也不证明终端环境已配置代理。

```bash
EXT="$HOME/.devin/extensions/local.devin-fusion-byok-<version>" \
node -e "
const m=require(process.env.EXT+'/src/update.cjs'), p=require(process.env.EXT+'/src/network/proxy-policy.cjs'), c=require('node:crypto'), fs=require('fs');
const address = process.env.VERIFY_PROXY || 'http://127.0.0.1:7897';
const proxyPolicy = p.compileProxyPolicy({ httpProxy: address, httpsProxy: address, noProxy: ['localhost', '127.0.0.1', '::1'] });
(async()=>{
  const raw = await m.requestBytes('https://api.github.com/repos/'+m.REPOSITORY+'/releases/latest',{limit:1024*1024,proxyPolicy});
  const i = m.releaseInfo(JSON.parse(raw.toString()));
  const cur = require(process.env.EXT+'/package.json').version;
  console.log('installable:', i.installable, '| 远端:', i.version, '| 本地:', cur);
  console.log('资产名:', i.name, '| digest:', i.digest, '| size:', i.size);
  console.log('面板将显示:', m.compareVersions(i.version,cur)>0 ? '有新版本' : '已是最新');
  const b = await m.requestBytes(i.url,{limit:50*1024*1024,proxyPolicy});
  console.log('字节:', b.length===i.size ? '✓ '+b.length : '✗ '+b.length);
  console.log('sha256:', c.createHash('sha256').update(b).digest('hex')===i.digest ? '✓ 与 Release digest 一致' : '✗');
  const f='/tmp/verify-'+Date.now()+'.vsix'; fs.writeFileSync(f,b);
  try { await m.verifyPackage(f, i.version); console.log('verifyPackage: ✓ 包身份一致'); }
  finally { fs.rmSync(f,{force:true}); }
})().catch(e=>console.log('✗', e.message, e.cause&&(e.cause.code||'')));
"
```

四项全绿才算发布成功：`installable=true`、资产名严格匹配、sha256 与 Release digest 一致、`verifyPackage()` 通过。这四项正是「一键安装」在真机上会走的校验，预跑通过就等于一键安装可用。

**`$EXT` 要指向已安装的旧版本**（例如发布 0.3.44 时目录仍是 `...-0.3.43`）——这是对的：要验收的正是「旧版本能否读到并装上新版本」，用旧代码跑才符合真实场景。

## 7. 覆盖安装与生效

安装**必须由用户执行**（会重启扩展宿主，可能中断当前会话）：

```bash
/Applications/Devin.app/Contents/Resources/app/bin/devin-desktop \
  --install-extension devin-fusion-byok-<version>.vsix
```

随后用户执行 **Developer: Reload Window**。重载后核对：

- **运行中的 backend 来自新版本目录**（决定性判据）：`ps ax -o command= | grep -a runtime/backend.cjs` 的路径含 `local.devin-fusion-byok-<version>`。
  **不要拿「旧版本目录已删除」当判据**——重载窗口**不会**删除旧目录，新旧两个目录同时存在是**正常现象**，只要旧版本不再被加载即可（这与第 6 步
  「`$EXT` 指向已安装的旧版本」是同一事实的两面）。
  也不要拿 `.obsolete` 当判据：实测（2026-10-18，0.3.48→0.3.51 连续三轮升级后）该文件是 **0 字节空文件**、mtime 就是当次安装时刻，旧目录仍在磁盘上。
  唯一可靠的判据组合是 **`extensions.json` 里只剩新版一条** + **运行进程路径指向新版**。
- **备份目录绝不能留在 `~/.devin/extensions/` 下**（实测 2026-10-24 踩坑）：用 `cp -R … local.devin-fusion-byok-0.3.58.bak-<时间戳>` 做备份后重载，
  Devin 会把该目录当成版本更高的扩展加载，`extensions.json` 的 `location` 直接指向备份目录，**正式目录被忽略**——现象是「装完重载却像没生效」
  （本次表现为新加的 `upstream-retry` 从不触发）。判据用 sourceId 而不是文件比对：`/health` 的 `sourceId` 吻合才是真的在跑新代码，
  `node -e 'require("<扩展目录>/src/runtime/source-identity.cjs").runtimeIdentity("/tmp/x",true).sourceId'` 算出期望值再比。
  备份一律放 `~/.devin/extension-backups/`；已经误放过时，移出备份目录并把 `extensions.json` 的 `location` 改回正式目录，再重载。
- **旧扩展目录需手动清理**（每次升级留一个，约 950 KB）：注册表已不引用、无进程句柄，`rm -rf ~/.devin/extensions/local.devin-fusion-byok-<旧版本>` 安全。
  删除后复核：`/health` 的 pid 不变、`runtime.log` 继续 `chat-complete status:200`、`extensions.json` 仍只有新版。
- `runtime.log` 出现 `ready port 39842 version <version>`
- `settings.json` 的 `devin.acp.agentEnv.devin-cli.WINDSURF_API_SERVER_URL` 仍为 `http://127.0.0.1:39842`；模型偏好未被卸载钩子回滚
- 面板状态行显示「当前 <version> · 已是最新」；**若该版本尚未发布 Release**，则显示「当前 <version> · 高于最新正式版」——本地未发布版本属正常

## 本机网络与失败判定

- git/gh 与插件更新分别选路：命令行按 `~/.devin/rules/github-proxy.md` 和 `.devin/rules/platform-and-network.md`；插件按 `.devin/rules/release-contract.md`。不要跨层推断配置已生效。
- 当前插件使用用户级 `http.proxy`/`http.noProxy`，未配置时按实现回落环境读源；第 6 步显式策略片段不依赖 TUN 或 `NODE_USE_ENV_PROXY`。旧安装副本不支持 `proxyPolicy` 时先核对其真实接口，不能把参数被忽略后的直连或打开 TUN 当作新链路验收。
- “检查失败”只说明未取得有效结果，不等于代理失效或已是最新版；HTTP 403/429 先区分权限与 API 限流，不盲目重试、换出口或关闭证书校验。“高于最新正式版”也可能是本地尚未发布，不能单凭文案断言读错仓库。

## 验收时的两个坑

- 已安装副本的 `package.json` 与工作区**哈希必然不同**（VS Code 会注入 `__metadata` 字段），这不代表装错版本或装旧码。要确认装的是本 fork，应比对 `src/update.cjs` 里的 `REPOSITORY`。**验收一律走这个路径**：`src/update/updater.cjs` 是 0.3.58 起才有的实现文件，装的是更早版本时它不存在。
- `verifyPackage(file, version)` 第一参数是**文件路径**，不是 Buffer。传 Buffer 会让 `unzip` 崩溃并打印 `Assertion failed: (advance > 0)`，看起来像包损坏，其实是调用方传错类型。
