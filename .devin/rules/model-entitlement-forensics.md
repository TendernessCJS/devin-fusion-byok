---
trigger: model_decision
description: "排查「picker 整族变窄 / Claude·GPT·Gemini 全消失 / mirror 加宽无效 / 怀疑账号被降级」时必读——账号准入层在 f7 之上，官方 List Models API 与缓存字节的取证判据"
---

# 账号准入层取证（model-entitlement-forensics）

## 结论先行：准入层在 f7 之上

服务端在 `GetUserStatus` / `GetCliModelConfigs` / `GetCliTeamSettings` 三处**各自**按账号准入（plan / billing model / 区域）
过滤，**早于** 用户侧白名单。所以「整族模型消失」的正确起手是查准入，不是查 `team_settings` f7：

- `model_configs` 缓存**本身就是准入 + f7 过滤后的集合**（桌面端不读 f7 这一层，见 `picker-visibility.md`）；
- `mirrorNativeAllowlist` 只能放宽 f7，**交集上限 = 服务端下发的原生集合**，造不出原本没有的条目。2026-11-17 实测：
  f7 放宽到 1162 条、`matrix` 229，picker 里 claude/gpt 仍是 0——没有可保的条目；
- `allowedKind=restricted` **不等于**「团队配了白名单」：它与「存储白名单为空」可以同时成立（见下）。

## 官方取证接口（唯一能直接读出 `allowed` 的地方）

```
GET https://server.codeium.com/api/v2alpha/models                     # 全量 + 每条 allowed
GET https://server.codeium.com/api/v2alpha/models?filter=allowlist    # 与 picker 一致的那份
GET https://server.codeium.com/api/v2alpha/models?org_id=<org id>     # 叠加该 org 的覆盖
Authorization: Bearer cog_...
```

- **实测（2026-11-17）**：文档写「需 service user key + `account.windsurf.admin`」，但**账号主人自建的 PAT 就能过**
  （HTTP 200，不需要 service user）。所以「个人 Pro 号没有 cog_ key」不成立，先试再说。
- 响应顶层三个键：`models[]`（`uid`/`name`/`allowed`/`pricing_dimensions`）、`allowed_model_uids[]`、`allowed_model_tags[]`；
  响应头带 `ETag`，改白名单要用它做 `If-Match`（`PUT` 同路径，`allowed_model_tags` 接受 `provider-anthropic` / `provider-openai`）。
- **对公网接口绝不能把 key 放进命令行参数**（`ps` 可见）：用 `read -rs KEY` + `curl --config <(printf 'header = "Authorization: Bearer %s"\n' "$KEY")`
  或 600 权限临时配置文件，输出只留 `HTTP %{http_code}` 与响应体摘要。

### 三态判定表（看到什么 → 结论）

| `allowed_model_uids` / `allowed_model_tags` | 全量里 frontier 条目 | 结论与处置 |
|---|---|---|
| 非空 | 存在但 `allowed:false` | 团队/组织白名单裁的 → 带 `If-Match` 的 `PUT` 可自助修 |
| **两者都为空** | 存在但大量 `allowed:false` | **准入层限制**（plan / billing / 区域）；页面的 `Reset settings` 是空操作，只能上报 |
| — | 全量里**根本没有**该家族 | 上游不发给这个账号，比上一行更窄；同样只能上报 |

2026-11-17 实测形态：全量 **1074** 条，`allowed:true` 仅 **47** 条，1011 条 claude/gpt/gemini 全 `allowed:false`，
两个白名单数组均为 `[]`，带 `org_id` 查询的结果与 `ETag` 完全一致（无 org 覆盖）。

## 无 API 时的本机判据（缓存字节）

`~/.cache/devin/cli/*.bin` 是 JSON 信封（`version` / `identity_digest` / `fetched_at_secs` / `payload`=base64 protobuf）：

1. 解出 payload，统计**字节数 + 家族命中数**（`b"claude"` / `b"gpt-"` / `b"gemini"`），比解析模型名快；
2. **同一安装前后对比即可排除客户端变量**：2026-11-17 同一份 3.13.4（`Info.plist` 与内置二进制 mtime 未动）在
   `01:58Z` 收到 913,664 B（claude 2601 / gpt 4544 次命中），`05:00Z` 只剩 58,299 B（仅 `fusion-sidekick-*`）——
   结论是「服务端改口径」，不是「升级导致」；
3. **不同 identity digest ≠ 不同账号**：文件名里的 digest 是凭据指纹。同一天两把凭据（桌面 accessToken 与 ACP 递给 CLI 的 key）
   的 `team_settings` 白名单**逐条完全一致** ⇒ 账号级；两份 payload 大小不同时先各自解码再比，别看字节数下结论；
4. `~/.cache/devin/cli/is_enterprise` 为 `0` 时，设置页仍可能显示「enterprise-only settings … currently applied」——
   那是**空壳标志位**，不构成企业身份证据。

## catalog 诊断字段（0.6.10 起在日志里）

`runtime.log` 的 `catalog` 事件带 `auth`（`sha256(authorization || x-api-key)` 前 12 位，无头为 `none`）、`native`、`families`、
`allowedCount`/`allowedKind`、mirror 开启时的 `mirror`。用法：

- **`auth` 先定性身份**：桌面 `accessToken`、ACP 递给 CLI 的 key、`credentials.toml` 的 `auth` 各不相同；
  **同一结果 + 不同 `auth` ⇒ 账号级**，不是某把凭据坏了（两跳落点差异见 `runtime-forensics.md`）；
- **`families` 缺哪个家族，就是准入层砍掉的那批**（2026-11-17 基线：`{glm:12, swe:12, kimi:9, deepseek:8, nemotron:6}`，
  claude/gpt/gemini 各 0）；
- `GetUserStatus` 47 条与 `GetCliModelConfigs` 69 条之差是 **22 = 14 条 fusion + 8 条内部 uid**
  （`adaptive`/`subagent-default`/`session-titler`/`memory-migration-default`/`smart-classifier`/`command-reviser`/
  `user-message-records`/`swe-check`），**不是**准入差异；反方向为 0。

## 已排除的路径（别再花时间）

- `app.devin.ai/org/<org **id**>/settings/desktop` → 404；要用 **slug**（`your-organization-3950de30` 这种），
  且 org 级覆盖未灰度到账号时页面本就不存在（`docs.devin.ai/enterprise/local/controls`）；
- `windsurf.com/team/cli-settings` → 只对 Windsurf 企业团队渲染，Pro 个人号没有；
- 页面上的 `Reset settings`：白名单为空时点完**条目集合完全不变**（实测 fresh fetch 后 69 条 → 69 条，0 增 0 减）；
- 「是不是我们把它写窄了」：`model_configs` 我们从不增删条目，且上游 payload 在同一天从 913 KB 收到 58 KB，
  与重写器无关（原地重写边界见 `native-observation-and-cli-cache.md`）。

## 上报要素

准入层限制只能官方解除。工单给这四样，别只写「模型没了」：全量计数与 `filter=allowlist` 计数；两个白名单数组为空；
前后两次 payload 字节数与时间戳（证明客户端未变）；Cloud 侧仍可用（证明权益未整体降级）。区域限制例外：
**不要建议用户用代理绕区**——那是供应商条款问题，不是技术问题。
