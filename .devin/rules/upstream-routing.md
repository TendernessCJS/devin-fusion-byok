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
- 唯一写入点是 `activation/enable.cjs`：激活后推一次 + 订阅 `codeium.apiServerUrl` 变更，别在别处重复写。

## 观测落点（最容易判错的一节）

| 事件 | 落点 | 说明 |
| --- | --- | --- |
| `upstream-push` | 扩展 **output channel「Devin Fusion BYOK」** | 宿主侧，成功 `{ok:true,custom}`、失败 `{ok:false,reason}`；channel **不落盘** |
| `upstream-origin` | backend `runtime.log` | 只有 backend **真的收到**推送才写，`{custom}` |
| `upstream-push.json` | `<globalStorage>/upstream-push.json` | 宿主侧收据 `{at, ok, custom|reason}`，事后可判 |

- **payload 一律不含 host/origin**（租户域名不得进日志），别为排障加。
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
  全在 `windsurf.*`/`devin.*` 下），所以没有设置界面；写入途径只有三条：`windsurf.portalUrl` 派生
  （`${portal}/_route/api_server`，API 与推理同值）、登录响应回填（SecretStorage `windsurf_auth.apiServerUrl`）、
  手写 settings.json。
- 本机实测：`settings.json` 无任何 `codeium.*`，LS 拿到默认 `--api_server_url https://server.codeium.com` 与
  `--inference_api_server_url https://inference.codeium.com`，故推送 `null`、`custom:false`——SaaS 账号下该能力空跑。
- `codeium.inferenceApiServerUrl` **未接**：企业/EU 模式下它与 API 地址同值，只有手填成不同值才会分离。
