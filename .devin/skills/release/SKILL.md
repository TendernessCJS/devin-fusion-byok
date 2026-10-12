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
    - Exec(gh release list)
    - Exec(git status)
    - Exec(git log)
    - Exec(git diff)
    - Exec(git rev-parse)
    - Exec(git ls-remote)
    - Exec(shasum)
---

# 发布与自更新验收

覆盖「发一个新版本 → 让插件自更新真正可用 → 验收」全流程。发布契约的权威定义在 `src/update.cjs`（`releaseInfo()` / `verifyPackage()`）与 `AGENTS.md` 的「自更新（发布约束）」节；本 skill 只固化流程与验收方法，规则冲突时以那两处为准。

## 0. 先确认你在改什么

| 想做的事 | 去哪 |
| --- | --- |
| 发布一个已就绪的版本 | 走下面 1→7 |
| 改动发布契约（资产名 / tag / digest 规则） | 先改 `src/update.cjs` + `test/update.test.cjs` 并补测试，再发布 |
| 同步 upstream | 见 `AGENTS.md` 的「fork 同步与发布」，不是本 skill |

**不要改** `package.json` 的 `name`（`devin-fusion-byok`）与 `publisher`（`local`）：`verifyPackage()` 会校验包内身份，改了就拒绝安装自己的包。

## 1. 定版本号

版本自管递增：`patch +1`。唯一不变式是**严格大于本 fork 上次发布的版本**——`compareVersions(latest, current)` 要求严格大于，相等时面板不会提示更新。与 upstream 的版本号大小无关。

```bash
node -e "const v=require('./package.json').version; if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw Error('版本必须是三段纯数字: '+v); console.log('version OK:', v)"
```

三段纯数字是硬约束：`0.3.44-1`、`0.3.44+foo`、`0.3.44.1` 会让 `parseVersion()` 抛错，自更新彻底失效（表现为面板「检查更新失败」）。

## 2. 跑测试

```bash
npm test
```

基线是 **623 例 / 622 通过 / 1 失败**，唯一失败为 `test/native-models-sync.test.cjs:92`（已知的 undici 连接复用问题，见 `AGENTS.md`），**不要去修它，也不要改断言**。失败数多于 1 个时先查清再继续。

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

## 6. 验收：读回路，不只看网页

网页显示正常 ≠ 插件能用。**用已安装副本的代码**跑一遍真实回路。

**走插件自带的代理路径**：`requestBytes` 支持 `proxy` 参数（`src/proxy.cjs` 的 `parseProxy` 结果）。下面片段显式传 `http://127.0.0.1:7897`（与 `config.json` 的 `updateProxy` 等效），和面板「检查更新」走的是同一条代码路径，不依赖 TUN 与环境变量，结果可复现。

```bash
EXT="$HOME/.devin/extensions/local.devin-fusion-byok-<version>" \
node -e "
const m=require(process.env.EXT+'/src/update.cjs'), p=require(process.env.EXT+'/src/proxy.cjs'), c=require('node:crypto'), fs=require('fs');
const proxy = p.parseProxy(process.env.UPDATE_PROXY || 'http://127.0.0.1:7897');
(async()=>{
  const raw = await m.requestBytes('https://api.github.com/repos/'+m.REPOSITORY+'/releases/latest',{limit:1024*1024,proxy});
  const i = m.releaseInfo(JSON.parse(raw.toString()));
  const cur = require(process.env.EXT+'/package.json').version;
  console.log('installable:', i.installable, '| 远端:', i.version, '| 本地:', cur);
  console.log('资产名:', i.name, '| digest:', i.digest, '| size:', i.size);
  console.log('面板将显示:', m.compareVersions(i.version,cur)>0 ? '有新版本' : '已是最新');
  const b = await m.requestBytes(i.url,{limit:50*1024*1024,proxy});
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

- `~/.devin/extensions/` 下只剩新版本，旧版本已清理（`.obsolete` 为空）
- `runtime.log` 出现 `ready port 39842 version <version>`
- `settings.json` 的 `devin.acp.agentEnv` 仍含 `http://127.0.0.1:39842`；模型偏好未被卸载钩子回滚
- 面板显示「当前 <version> · 已是最新」

## 本机网络约束（会让验收假失败）

- GitHub 访问必须经代理 `http://127.0.0.1:7897`：直连 `api.github.com`、`github.com`、`objects.githubusercontent.com` 均被连接重置。
- **首选：插件自带代理**（`src/proxy.cjs`，随 0.3.43 之后版本一起分发）。`config.json` 设 `updateProxy` 后，面板「检查更新」与一键安装经 CONNECT 隧道走代理，不受 TUN 与环境变量影响；第 6 步验收片段显式传同一个代理地址，跑的是同一条路径。
- **备选：环境变量 / TUN**。验收已安装的旧版本（没有 `src/proxy.cjs`）或排查直连路径时才需要：
  - 验收片段改用 `HTTPS_PROXY=http://127.0.0.1:7897 NODE_USE_ENV_PROXY=1 NO_PROXY=localhost,127.0.0.1` 让全局 `fetch` 读环境变量（扩展宿主的 `fetch` 默认不读，缺了它就 ECONNRESET，看起来像「发布失败」）。
  - Devin 本体不读 shell 环境：TUN 模式，或以 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=localhost,127.0.0.1` 启动 Devin。
  - 判定 TUN 是否生效不能看开关，要看实际出口：`route get <api.github.com 的 IP>` 应为 `utun*`（开）或 `en0`（关）；开 TUN 时 DNS 会解析到 fake-IP 段 `198.18.x.x`。TUN 会被用户关掉或断开，验收前先确认。
- 面板文案对照：「检查失败」= 网络不通或 `updateProxy` 未配置/无效；「比最新正式版还新」= 仍在读旧的上游版本；「已是最新（当前 <刚发布的版本>）」= 完全正常。

## 验收时的两个坑

- 已安装副本的 `package.json` 与工作区**哈希必然不同**（VS Code 会注入 `__metadata` 字段），这不代表装错版本或装旧码。要确认装的是本 fork，应比对 `src/update.cjs` 里的 `REPOSITORY`。
- `verifyPackage(file, version)` 第一参数是**文件路径**，不是 Buffer。传 Buffer 会让 `unzip` 崩溃并打印 `Assertion failed: (advance > 0)`，看起来像包损坏，其实是调用方传错类型。
