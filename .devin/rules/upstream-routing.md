---
description: backend 转发目标（upstream origin）与原生 apiServerUrl 的契约、校验与观测落点——排查「转发打到了哪里」、改 backend 转发目标或上游控制面时必读
trigger: model_decision
---

# 上游转发目标（upstream routing）

backend 转发非拦截 RPC 时，目标 origin **不是常量**，而是跟随原生 `codeium.apiServerUrl`：未设置即
`https://server.codeium.com`（`DEFAULT_UPSTREAM`）。

## 契约

- 宿主经 `POST /_runtime/upstream` 推送，body 只有 `{ origin }`：**只传 URL 不传凭据**。
- `/health` 用 `upstreamProtocol: 1` 声明能力位；旧 backend 无此字段，宿主跳过而不是报错。
- 推送前宿主校验：health 的 `service`/`rootId` 与 `rootIdentity(root)` 一致、`instanceId` 存在，控制文件
  `rootId`/`instanceId`/`sourceId` 三项与 health 一致，令牌为 64-hex。任一不符记 `identity`。
- origin 校验（`resolveUpstreamOrigin`）：只接受 `https:`；`http:` 仅限回环 host（`localhost`/`127.0.0.1`/`::1`）；
  拒 userinfo、query、hash、畸形 URL、backend 自身回环端口；保留路径前缀并去尾斜杠。
- **状态按 backend 实例隔离**（`startBackend()` 内的闭包变量）：放到模块级会让同进程两个实例共享一个推送值。
- 唯一写入点是 `activation/enable.cjs`：激活后触发一次 + 订阅上述四个键（`codeium.apiServerUrl`/`devin.portalUrl`/`windsurf.portalUrl`/`windsurf.serviceUrl`），每次触发跑收敛窗口并以代际取消旧窗口，同 `(origin, source)` 去重不发；别在别处重复写。

## 观测落点（最容易判错的一节）

| 事件 | 落点 | 说明 |
| --- | --- | --- |
| `upstream-push` | 扩展 **output channel「Devin Fusion BYOK」** | 宿主侧，成功 `{ok:true,custom,source}`、失败 `{ok:false,reason,source,code?,detail?}`；channel **不落盘** |
| `upstream-origin` | backend `runtime.log` | 只有 backend **真的收到**推送才写，`{custom}` |
| `upstream-push.json` | `<globalStorage>/upstream-push.json` | 宿主侧收据 `{at, ok, custom|reason, source, code?, detail?}`，事后可判 |

- **payload 一律不含 host/origin**（租户域名不得进日志），别为排障加。
- 去重命中时**不写日志也不写收据**——「没有新收据」不等于没触发，判活看触发侧的 generation 语义。
- 「`runtime.log` 里没有 `upstream-origin`」只说明推送**没到达 backend**，不说明没尝试过——看 `upstream-push.json`。
- `custom` = 「与默认上游不同」，不是「设成功了」：推默认值或 `null` 都记 `false`。
- `reason`：`unavailable`=连不上或 4 s 超时、`identity`=身份或控制文件不符、`unsupported`=旧 backend、
  `invalid`=origin 被拒（400）、`rejected`=其它非 2xx。连接层失败还会带 `code`（如 `ECONNREFUSED`、
  `UND_ERR_SOCKET`），**不含 host**。
- **连接层失败必须重试**：激活推送落在「新 backend 在同端口替换旧实例」的窗口里，此时连接池里的 keep-alive
  socket 已经死了（与 `native-models-sync` 同一陷阱）。`pushUpstream` 对 `isConnectionFailure` 重试 4 次、
  退避 100/250/500 ms；不要把它改回单次发送——2026-10-27 实测，单次发送在两次重载里都以 `unavailable` 失败。

## 原生设置的两个键（2026-10-27 产物核对）

- `codeium.apiServerUrl` / `codeium.inferenceApiServerUrl` **不被任何扩展 `package.json` 贡献**（原生贡献的 44 个键
  全在 `windsurf.*`/`devin.*` 下），所以没有设置界面——而且它们是**派生量**：配置 getter 对 `codeium.*`
  命名空间直接短路到登录响应/portal 派生/部署默认，**用户手写 settings.json 被静默忽略**（2026-10-27 11:04
  实测：手填 `inferenceApiServerUrl` 指向 stub，重载后 LS 参数仍是默认推理地址，stub 零请求）。
- 真实取值链（`src/activation/effective-origin.cjs`，与原生同序）：① **LS 进程的 `--api_server_url`
  启动参数**（`source:'ls-arg'`，登录响应/portal/默认三者其一已被原生折算进去）；② portal 派生
  `devin.portalUrl`/`windsurf.portalUrl` → `${portal}/_route/api_server`（`source:'portal'`）；
  `windsurf.serviceUrl` 是遗留键、原生只在迁移时读一次，作末位兜底；③ 部署默认（`source:'default'`，
  推 `null` 复位）。`source` 枚举进日志与收据，origin 永不落盘。portal 由官方 `devin.setPortalUrl`
  命令写入（InputBox → `windsurf.portalUrl` + `devin.portalUrl`）。
- **LS 行匹配按可执行路径**，不是裸子串：正则 `/\/language_server_[A-Za-z0-9_]+(\s|$)/` 定位可执行位，
  只在其后查 flag——命令行中段提到二进制名的行（`ps | grep` 自匹配陷阱，2026-10-27 实测中招）必须忽略。
  候选按 pid 降序逐个过 `resolveUpstreamOrigin`，首个合法者胜。
- **收敛窗口** `resolveEffectiveOriginWhenAvailable`：激活比 LS 早约 1 秒（实测 11:19:07 推送 → 11:19:08
  LS 才启动），首解析常落在 `default`；故按 0/2/5/10s 追加最多 3 次重解析，拿到非 `default` 立即停，
  `shouldContinue`（宿主停用或更新的触发到达）为假即止。**去重**：同一代激活里 `(origin, source)`
  与上次成功推送相同 → 不发 POST、不记日志；origin 变了才推。
- 本机实测：`settings.json` 无任何 `codeium.*`，LS 拿到默认 `--api_server_url` 与
  `--inference_api_server_url`，故推送 `null`、`custom:false`——SaaS 账号下该能力空跑。
- `codeium.inferenceApiServerUrl` **已定案不接**（设计决定，不是待办）：它与 `apiServerUrl` 同为派生量——
  无贡献键、无 UI 入口、手写 settings 被 `getConfig` 短路静默忽略（见上面 11:04 实测）；LS 自带
  `--inference_api_server_url`，插件没有任何合法写入面。企业/EU 模式下它与 API 地址同值，只有部署
  派生不同值才会分离——届时若要跟随，来源应是 LS 的推理参数而非该设置键。
- **生产验证（收敛窗口已生效）**：2026-10-27 11:55 重载，LS 于 11:55:04 启动，持久收据最终为
  `{ok:true, custom:false, source:'ls-arg'}`（at=03:55:09.115Z）——激活首解析落 `default`（早期收据被
  覆盖），约 2s 后收敛到 `ls-arg`。窗口在生产链路生效，勿改回单次解析。

## 激活期推送的两种失败形态（2026-10-27 实证）

- **(a) 死 socket → 连接层抛错**：池里的 keep-alive socket 已死，`fetch` 抛 `ECONNRESET`/`UND_ERR_SOCKET` 等，
  走 `isConnectionFailure` 重试。
- **(b) 池里的活 socket 递回旧实例的 200 → `identity`**：socket 还活着但连着**旧 backend**，它应答的 `/health`
  instanceId 是旧的，磁盘上的 `runtime-control.json` 已被新实例改写。实证收据：
  `{"at":"2026-10-27T02:09:24.863Z","ok":false,"reason":"identity"}`，同一秒新 backend 已 `ready` 而旧实例
  0.8s 后才退出。**该次具体卡在哪个比对项仍未定论**——当时的收据没有粒度，下次复现看 `detail`。
- **实测推翻**：`connection: 'close'` **不能**关掉 undici 的连接复用（Node 24 实测同端口两连击仍复用），
  不要再用这个头做防复用手段。控制面传送层改为 `httpFetch`（`node:http` + `agent: false`），
  每次尝试独立 TCP 连接，把「旧实例回包」压缩成真时间窗竞态。
- identity 按 `detail` 分级（稳定枚举，可进日志与收据）：不可重试 `service`/`root`（真部署不符，1 次即失败）；
  可重试 `control`/`instance`/`source`/`token`/`post-instance`（竞态可疑，进同一 100/250/500ms 预算共 4 次）。
  `retriable` 只作内部控制流，绝不进日志或收据。
